/**
 * Native file reader — stable Android handling.
 * - Picks always return file:// via copyToCacheDirectory:true, but we defensively copy content:// once
 * - Holds one FileHandle per file for the whole transfer (no per-chunk reopen)
 * - Never loads whole file for large videos (chunked read only)
 */

// @ts-ignore — expo-file-system is native-only, not available in web/node type check but provided at runtime on device
import { File, Paths } from "expo-file-system";
// @ts-ignore
import * as FileSystemLegacy from "expo-file-system/legacy";

type NativeFile = {
  name: string;
  size: number;
  bytes?: Uint8Array;
  uri?: string;
  file?: unknown;
};

type HeldHandle = {
  file: File;
  handle: { readBytes: (len: number) => Uint8Array; close: () => void; offset?: number | null };
  cachedUri: string;
};

// One handle per fileIndex, kept for entire transfer
const handleCache = new Map<number, HeldHandle>();
const stableUriCache = new Map<number, string>();

function safeName(name: string): string {
  return name.replace(/[^\w.\-]/g, "_") || `tmp_${Date.now()}`;
}

async function ensureStableUri(fileIndex: number, originalUri: string, fileName: string): Promise<string> {
  const cached = stableUriCache.get(fileIndex);
  if (cached) return cached;

  // If already file:// and in cache, keep it
  if (originalUri.startsWith("file://") && originalUri.includes("/cache/")) {
    stableUriCache.set(fileIndex, originalUri);
    return originalUri;
  }

  // content:// or file:// outside cache — copy once to cache
  if (originalUri.startsWith("content://") || originalUri.startsWith("file://")) {
    try {
      const src = new File(originalUri);
      // Quick check: if file:// already, verify it exists
      if (originalUri.startsWith("file://")) {
        try {
          if (src.exists) {
            // If size matches hint later, we will keep it; for now assume stable
          } else {
            // Not exists, will need copy anyway
          }
        } catch {}
      }
      const dest = new File(Paths.cache, `lyra-send-${Date.now()}-${fileIndex}-${safeName(fileName)}`);
      try { dest.create({ overwrite: true }); } catch {}
      await src.copy(dest);
      if (dest.exists) {
        const uri = dest.uri;
        stableUriCache.set(fileIndex, uri);
        return uri;
      }
    } catch (e) {
      console.warn(`[lyra fileReader] normalize copy failed ${fileName}`, e instanceof Error ? e.message : String(e));
    }
  }
  // Fallback: return original (caller will try direct read)
  stableUriCache.set(fileIndex, originalUri);
  return originalUri;
}

async function getHeldHandle(fileIndex: number, stableUri: string): Promise<HeldHandle | null> {
  const existing = handleCache.get(fileIndex);
  if (existing && existing.cachedUri === stableUri) return existing;
  // Close old if different uri
  if (existing) {
    try { existing.handle.close(); } catch {}
    handleCache.delete(fileIndex);
  }
  try {
    const file = new File(stableUri);
    if (!file.exists) return null;
    const handle = (file as unknown as { open: (mode: string) => HeldHandle["handle"] }).open("r");
    if (!handle) return null;
    const held: HeldHandle = { file, handle, cachedUri: stableUri };
    handleCache.set(fileIndex, held);
    return held;
  } catch {
    return null;
  }
}

export function createReadSlice(files: NativeFile[]) {
  // Clear caches for new transfer batch
  handleCache.clear();
  stableUriCache.clear();

  return async (fileIndex: number, offset: number, length: number): Promise<Uint8Array> => {
    const f = files[fileIndex];
    if (!f) throw new Error(`No file at index ${fileIndex}`);
    if (f.bytes) {
      return f.bytes.subarray(offset, Math.min(f.bytes.byteLength, offset + length));
    }

    let uri = f.uri;
    if (!uri && f.file) {
      // Should not happen on native, but handle
      throw new Error(`No uri for ${f.name} — file object not supported on native`);
    }
    if (!uri) throw new Error(`No uri for ${f.name}`);

    // Ensure stable cached copy once
    const stableUri = await ensureStableUri(fileIndex, uri, f.name);
    // Update original so future calls use stable
    if (stableUri !== uri) {
      f.uri = stableUri;
      uri = stableUri;
    }

    let lastErr: unknown = null;

    // 1) Held handle readBytes (true streaming)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const held = await getHeldHandle(fileIndex, stableUri);
        if (held) {
          try {
            if (typeof held.handle.offset === "number") held.handle.offset = offset;
            const bytes = held.handle.readBytes(length);
            if (bytes.byteLength > 0) return bytes;
            if (bytes.byteLength === 0 && length > 0) lastErr = new Error("readBytes returned 0 bytes");
          } catch (e) {
            lastErr = e;
            // Close broken handle, will retry with new handle
            try { held.handle.close(); } catch {}
            handleCache.delete(fileIndex);
            continue;
          }
        }
      } catch (e) {
        lastErr = e;
      }
      break;
    }

    // 2) File.slice fallback on stable file
    try {
      const file = new File(stableUri);
      if (file.exists) {
        const sliced = file.slice(offset, offset + length) as unknown as { arrayBuffer: () => Promise<ArrayBuffer> };
        if (sliced?.arrayBuffer) {
          const ab = await sliced.arrayBuffer();
          if (ab.byteLength > 0) return new Uint8Array(ab);
          if (ab.byteLength === 0 && length > 0) lastErr = new Error("slice returned 0 bytes");
        }
      }
    } catch (e) {
      lastErr = e;
    }

    // 3) Legacy chunked read with position/length (works for content:// via FileSystem)
    try {
      const b64 = await FileSystemLegacy.readAsStringAsync(stableUri, {
        encoding: FileSystemLegacy.EncodingType.Base64,
        position: offset,
        length,
      });
      if (b64) {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        if (bin.byteLength > 0) return bin.subarray(0, Math.min(bin.byteLength, length));
      }
    } catch (e) {
      lastErr = e;
    }

    // 4) Last resort: try original uri with legacy (in case stable copy was bad)
    if (stableUri !== f.uri && f.uri) {
      try {
        const b64 = await FileSystemLegacy.readAsStringAsync(f.uri, {
          encoding: FileSystemLegacy.EncodingType.Base64,
          position: offset,
          length,
        });
        if (b64) {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          if (bin.byteLength > 0) return bin;
        }
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(`Unable to read chunk at ${offset} len ${length} for ${f.name} after all native methods: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  };
}

export function closeAllHandles(): void {
  for (const h of handleCache.values()) {
    try { h.handle.close(); } catch {}
  }
  handleCache.clear();
  stableUriCache.clear();
}

export async function copyToStableCache(uri: string): Promise<string> {
  // Exposed for picker code to pre-warm cache
  if (uri.startsWith("file://") && uri.includes("/cache/")) return uri;
  return ensureStableUri(-1, uri, "tmp");
}
