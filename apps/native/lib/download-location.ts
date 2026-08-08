/**
 * Download folder selection for received files (native).
 * Default: public Downloads/Lyra on Android (created if needed),
 * App Documents/Lyra on iOS.
 */
import { Platform } from "react-native";
import {
  documentDirectory,
  StorageAccessFramework,
  makeDirectoryAsync,
  getInfoAsync,
  EncodingType,
  writeAsStringAsync,
} from "expo-file-system/legacy";

export type DownloadLocationResult =
  | { ok: true; path: string; label: string }
  | { ok: false; cancelled?: boolean; error?: string };

const LYRA_SUBDIR = "Lyra";

/** Human-friendly path for settings display */
export function formatDownloadLabel(path: string | undefined | null): string {
  if (!path) return defaultDownloadLabel();
  if (path.startsWith("content://")) {
    // SAF URI — show a shortened content URI
    const parts = path.split("%3A");
    const last = parts[parts.length - 1] ?? path;
    try {
      return decodeURIComponent(last.replace(/\//g, " › "));
    } catch {
      return "Chosen folder (Android)";
    }
  }
  if (/Download\/Lyra|Downloads\/Lyra/i.test(path)) return "Downloads/Lyra";
  if (path.includes("Documents") && path.includes("Lyra")) return "Documents/Lyra";
  if (path.includes("Documents")) return "App Documents";
  return path;
}

/**
 * Preferred default path candidates (Android public Download/Lyra, then app Documents/Lyra).
 */
function androidPublicLyraCandidates(): string[] {
  return [
    "file:///storage/emulated/0/Download/Lyra",
    "file:///storage/emulated/0/Downloads/Lyra",
    "file:///sdcard/Download/Lyra",
  ];
}

export function defaultDownloadPath(): string | undefined {
  if (Platform.OS === "android") {
    return androidPublicLyraCandidates()[0];
  }
  if (documentDirectory) {
    return `${documentDirectory.replace(/\/?$/, "/")}${LYRA_SUBDIR}`;
  }
  return undefined;
}

export function defaultDownloadLabel(): string {
  if (Platform.OS === "ios") return "Documents/Lyra";
  if (Platform.OS === "android") return "Downloads/Lyra";
  return "Documents/Lyra";
}

/**
 * Ensure the default Downloads/Lyra (or Documents/Lyra) folder exists.
 * Returns the path to use for writes.
 */
export async function ensureDefaultDownloadDir(): Promise<{
  path: string;
  label: string;
} | null> {
  if (Platform.OS === "android") {
    for (const candidate of androidPublicLyraCandidates()) {
      try {
        const info = await getInfoAsync(candidate);
        if (!info.exists) {
          await makeDirectoryAsync(candidate, { intermediates: true });
        }
        // Verify writable with a no-op info re-check
        const again = await getInfoAsync(candidate);
        if (again.exists) {
          return { path: candidate, label: "Downloads/Lyra" };
        }
      } catch {
        // try next candidate
      }
    }
  }

  // iOS / fallback: app sandbox Documents/Lyra
  if (documentDirectory) {
    const path = `${documentDirectory.replace(/\/?$/, "/")}${LYRA_SUBDIR}`;
    try {
      const info = await getInfoAsync(path);
      if (!info.exists) {
        await makeDirectoryAsync(path, { intermediates: true });
      }
      return {
        path,
        label: Platform.OS === "ios" ? "Documents/Lyra" : formatDownloadLabel(path),
      };
    } catch {
      return { path: documentDirectory, label: "App Documents" };
    }
  }
  return null;
}

/**
 * Open the platform folder picker when available.
 */
export async function pickDownloadDirectory(): Promise<DownloadLocationResult> {
  if (Platform.OS === "android") {
    try {
      const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permissions.granted) {
        return { ok: false, cancelled: true };
      }
      const uri = permissions.directoryUri;
      return {
        ok: true,
        path: uri,
        label: formatDownloadLabel(uri),
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Could not open folder picker",
      };
    }
  }

  if (Platform.OS === "ios") {
    const ensured = await ensureDefaultDownloadDir();
    if (!ensured) {
      return {
        ok: false,
        error: "App Documents folder is unavailable on this build",
      };
    }
    return {
      ok: true,
      path: ensured.path,
      label: ensured.label,
    };
  }

  // Expo web / unknown
  const ensured = await ensureDefaultDownloadDir();
  if (ensured) {
    return { ok: true, path: ensured.path, label: ensured.label };
  }
  return {
    ok: false,
    error: "Folder picking needs a native iOS/Android build",
  };
}

/**
 * Write bytes into the configured download location.
 * Supports file:// paths (including Downloads/Lyra) and Android SAF content:// trees.
 */
export async function writeToDownloadLocation(
  downloadDirectory: string | undefined,
  fileName: string,
  bytes: Uint8Array,
): Promise<{ ok: true; uri: string } | { ok: false; error: string }> {
  const safeName = fileName.replace(/[^\w.\- ()[\]]+/g, "_") || "file.bin";

  let base = downloadDirectory;
  if (!base) {
    const ensured = await ensureDefaultDownloadDir();
    base = ensured?.path;
  }
  if (!base) {
    return { ok: false, error: "No download directory available" };
  }

  // Prefer modern File API for large files to avoid base64 OOM (20MB+)
  // Try File API first (supports both file:// and content:// via handle)
  if (bytes.byteLength > 256 * 1024) {
    try {
      const { File, Directory } = await import("expo-file-system");
      if (base.startsWith("content://")) {
        const mime = guessMime(safeName);
        const fileUri = await StorageAccessFramework.createFileAsync(base, safeName, mime);
        const file = new File(fileUri);
        // Try streaming via FileHandle Append (no base64 copy)
        try {
          const h = (file as unknown as { open: (mode: string) => { writeBytes: (b: Uint8Array) => void; close: () => void } }).open("wa");
          h.writeBytes(bytes);
          h.close();
          return { ok: true, uri: fileUri };
        } catch (e) {
          // Fallback to File.write if handle not supported for SAF
          try {
            (file as unknown as { write: (b: Uint8Array) => void }).write(bytes);
            return { ok: true, uri: fileUri };
          } catch {}
          // Final fallback to base64 (still may OOM for >20MB, but try)
          const b64 = uint8ToBase64(bytes);
          await writeAsStringAsync(fileUri, b64, { encoding: EncodingType.Base64 });
          return { ok: true, uri: fileUri };
        }
      } else {
        const dir = base.replace(/\/?$/, "");
        try {
          const d = new Directory(dir);
          if (!d.exists) d.create({ intermediates: true });
        } catch {}
        let dest = `${dir}/${safeName}`;
        try {
          let n = 1;
          const { File: FileCls } = await import("expo-file-system");
          while (true) {
            try {
              const test = new FileCls(dest);
              if (!test.exists) break;
              const dot = safeName.lastIndexOf(".");
              const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
              const ext = dot > 0 ? safeName.slice(dot) : "";
              dest = `${dir}/${stem} (${n})${ext}`;
              n++;
              if (n > 200) break;
            } catch { break; }
          }
        } catch {}
        const destFile = new (await import("expo-file-system")).File(dest);
        try {
          destFile.create({ overwrite: false } as unknown as never);
        } catch {}
        // Try FileHandle then File.write for efficiency
        try {
          const h = (destFile as unknown as { open: (mode: string) => { writeBytes: (b: Uint8Array) => void; close: () => void } }).open("w");
          h.writeBytes(bytes);
          h.close();
          return { ok: true, uri: destFile.uri };
        } catch {
          try {
            (destFile as unknown as { write: (b: Uint8Array) => void }).write(bytes);
            return { ok: true, uri: destFile.uri };
          } catch {}
        }
        // Fallback to legacy base64 if File API fails
        await writeAsStringAsync(dest, uint8ToBase64(bytes), { encoding: EncodingType.Base64 });
        return { ok: true, uri: dest };
      }
    } catch (e) {
      console.warn(`[lyra download] File API write failed for ${safeName} size=${bytes.byteLength}, falling back to base64`, e instanceof Error ? e.message : String(e));
      // Fall through to legacy below
    }
  }
  try {
    if (bytes.byteLength > 5 * 1024 * 1024) {
      // Large file: File API already attempted above and failed — don't try base64 (would OOM)
      throw new Error(`File API write failed for large file ${safeName} size=${bytes.byteLength} — base64 fallback disabled to avoid OOM`);
    }
    if (base.startsWith("content://")) {
      // Android SAF tree — small files fallback via base64
      const mime = guessMime(safeName);
      const fileUri = await StorageAccessFramework.createFileAsync(base, safeName, mime);
      const b64 = uint8ToBase64(bytes);
      await writeAsStringAsync(fileUri, b64, { encoding: EncodingType.Base64 });
      return { ok: true, uri: fileUri };
    }

    // Ensure directory exists for file:// paths
    const dir = base.replace(/\/?$/, "");
    try {
      const info = await getInfoAsync(dir);
      if (!info.exists) {
        await makeDirectoryAsync(dir, { intermediates: true });
      }
    } catch {
      // best-effort
    }

    let dest = `${dir}/${safeName}`;
    // Avoid overwrite: append counter
    try {
      let n = 1;
      while ((await getInfoAsync(dest)).exists) {
        const dot = safeName.lastIndexOf(".");
        const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
        const ext = dot > 0 ? safeName.slice(dot) : "";
        dest = `${dir}/${stem} (${n})${ext}`;
        n++;
        if (n > 200) break;
      }
    } catch {
      // ignore
    }

    await writeAsStringAsync(dest, uint8ToBase64(bytes), {
      encoding: EncodingType.Base64,
    });
    return { ok: true, uri: dest };
  } catch (e) {
    // If public Download failed (permissions), fall back to app Documents/Lyra
    if (base.includes("/Download") || base.includes("/Downloads")) {
      const fallback = await ensureDefaultDownloadDir();
      if (fallback && fallback.path !== base) {
        return writeToDownloadLocation(fallback.path, fileName, bytes);
      }
      // Force app documents
      if (documentDirectory) {
        const appLyra = `${documentDirectory.replace(/\/?$/, "/")}${LYRA_SUBDIR}`;
        try {
          await makeDirectoryAsync(appLyra, { intermediates: true });
          return writeToDownloadLocation(appLyra, fileName, bytes);
        } catch {
          // fall through
        }
      }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Persist all received transfer files into the download location.
 * V2 streaming: prefer File API temp file when available to avoid holding
 * entire multi-file concat in JS heap for large transfers.
 */
export async function saveReceivedTransferFiles(
  downloadDirectory: string | undefined,
  files: { name: string; size: number }[],
  chunks: Uint8Array[],
): Promise<{ savedPaths: string[]; errors: string[] }> {
  // Fast path for small totals: keep in-memory merge
  const totalLen = chunks.reduce((a, c) => a + c.byteLength, 0);
  // For >64 MiB, stream to temp file to reduce heap pressure
  const USE_TEMP_FILE = totalLen > 64 * 1024 * 1024;
  let tempPath: string | null = null;
  let tempFileBytes: Uint8Array | null = null;

  if (USE_TEMP_FILE) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const FS = await import("expo-file-system");
      const Paths = (FS as unknown as { Paths?: { cache?: { uri: string } } }).Paths;
      const cacheUri = Paths?.cache?.uri ?? (FS as unknown as { cacheDirectory?: string }).cacheDirectory;
      if (cacheUri) {
        const tmp = `${cacheUri.replace(/\/?$/, "/")}lyra-tx-${Date.now()}.bin`;
        // Write chunks sequentially via legacy base64 append (still streaming)
        // Use File API if available (expo-file-system/next)
        try {
          const { File } = FS as unknown as { File?: new (uri: string) => { write: (data: Uint8Array) => Promise<void>; uri: string } };
          if (File) {
            const f = new File(tmp);
            // @ts-expect-error File.write may vary
            if (typeof f.write === "function") {
              for (const c of chunks) await f.write(c);
              tempPath = tmp;
            }
          }
        } catch {}
        if (!tempPath) {
          // Fallback: create via legacy and append base64
          const { writeAsStringAsync, EncodingType } = FS as unknown as { writeAsStringAsync: typeof import("expo-file-system/legacy").writeAsStringAsync; EncodingType: typeof import("expo-file-system/legacy").EncodingType };
          let first = true;
          for (const c of chunks) {
            const b64 = uint8ToBase64(c);
            if (first) {
              await writeAsStringAsync(tmp, b64, { encoding: EncodingType.Base64 });
              first = false;
            } else {
              // legacy has no append; re-read + concat is still heavy — skip temp path fallback
              throw new Error("no append");
            }
          }
          tempPath = tmp;
        }
      }
    } catch {
      // fall back to memory
    }
  }

  if (!USE_TEMP_FILE || !tempPath) {
    const merged = new Uint8Array(totalLen);
    let o = 0;
    for (const c of chunks) merged.set(c, o), (o += c.byteLength);
    tempFileBytes = merged;
  }

  const savedPaths: string[] = [];
  const errors: string[] = [];
  let offset = 0;

  // Helper to get slice for file index
  async function getFileBytes(fileIdx: number): Promise<Uint8Array | null> {
    const file = files[fileIdx]!;
    const want = file.size || 0;
    if (tempFileBytes) {
      if (files.length === 1) return tempFileBytes;
      return tempFileBytes.subarray(offset, offset + want);
    }
    if (tempPath) {
      // Read slice from temp file
      try {
        const FS = await import("expo-file-system/legacy");
        const { readAsStringAsync, EncodingType } = FS;
        // Read entire temp as base64 then slice — still heavy but we already streamed
        const b64 = await readAsStringAsync(tempPath, { encoding: EncodingType.Base64 });
        const all = base64ToBytes(b64);
        if (files.length === 1) return all;
        return all.subarray(offset, offset + want);
      } catch {
        return null;
      }
    }
    return null;
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const bytes = await getFileBytes(i);
    if (!bytes) {
      errors.push(`${file.name}: failed to extract bytes`);
      offset += file.size || 0;
      continue;
    }
    const res = await writeToDownloadLocation(downloadDirectory, file.name, bytes);
    if (res.ok) savedPaths.push(res.uri);
    else errors.push(`${file.name}: ${res.error}`);
    offset += file.size || bytes.byteLength;
  }

  // Cleanup temp
  if (tempPath) {
    try {
      const FS = await import("expo-file-system/legacy");
      const { deleteAsync } = FS as unknown as { deleteAsync: (uri: string) => Promise<void> };
      if (deleteAsync) await deleteAsync(tempPath);
    } catch {}
  }

  return { savedPaths, errors };
}

export async function saveReceivedTransferFromDisk(
  downloadDirectory: string | undefined,
  files: { name: string; size: number }[],
  diskPath: string,
  totalBytes: number,
): Promise<{ savedPaths: string[]; errors: string[] }> {
  const savedPaths: string[] = [];
  const errors: string[] = [];
  // Single file: move temp file directly to download (zero copy)
  if (files.length === 1) {
    const file = files[0]!;
    try {
      const { File, Directory, Paths } = await import("expo-file-system");
      const tmpFile = new File(diskPath);
      // Ensure destination dir exists
      let base = downloadDirectory;
      if (!base) {
        const ensured = await ensureDefaultDownloadDir();
        base = ensured?.path;
      }
      if (!base) throw new Error("No download dir");
      let destUri: string;
      if (base.startsWith("content://")) {
        // SAF: copy via streaming FileHandles (avoids base64 OOM and overwrite bug)
        const CHUNK = 4 * 1024 * 1024;
        let offset = 0;
        const { StorageAccessFramework } = await import("expo-file-system/legacy");
        const mime = guessMime(file.name);
        const destFileUri = await StorageAccessFramework.createFileAsync(base, file.name.replace(/[^\w.\- ()[\]]+/g, "_"), mime);
        const destFile = new File(destFileUri);
        // Try streaming via FileHandles (both source and dest)
        let srcHandle: { readBytes: (len: number) => Uint8Array; close: () => void; offset?: number | null } | null = null;
        let destHandle: { writeBytes: (b: Uint8Array) => void; close: () => void } | null = null;
        try {
          try {
            srcHandle = (tmpFile as unknown as { open: (m: string) => typeof srcHandle }).open("r");
          } catch {}
          try {
            destHandle = (destFile as unknown as { open: (m: string) => typeof destHandle }).open("wa");
          } catch {}
          if (srcHandle && destHandle) {
            while (offset < file.size) {
              const len = Math.min(CHUNK, file.size - offset);
              // Ensure src offset correct
              try {
                if (typeof (srcHandle as unknown as { offset: number }).offset === "number") (srcHandle as unknown as { offset: number }).offset = offset;
              } catch {}
              const chunk = srcHandle.readBytes(len);
              if (chunk.byteLength === 0) break;
              destHandle.writeBytes(chunk);
              offset += chunk.byteLength;
            }
          } else if (srcHandle) {
            // Dest handle failed (SAF may not support wa) — fallback to File.write append per chunk
            while (offset < file.size) {
              const len = Math.min(CHUNK, file.size - offset);
              try {
                if (typeof (srcHandle as unknown as { offset: number }).offset === "number") (srcHandle as unknown as { offset: number }).offset = offset;
              } catch {}
              const chunk = srcHandle.readBytes(len);
              if (chunk.byteLength === 0) break;
              try {
                (destFile as unknown as { write: (b: Uint8Array, o?: unknown) => void }).write(chunk, { append: true });
              } catch {
                const b64 = uint8ToBase64(chunk);
                const { writeAsStringAsync, EncodingType } = await import("expo-file-system/legacy");
                await writeAsStringAsync(destFileUri, b64, { encoding: EncodingType.Base64 });
              }
              offset += chunk.byteLength;
            }
          } else {
            throw new Error("no src handle");
          }
        } catch (e) {
          console.warn(`[lyra download] SAF streaming failed for ${file.name}, falling back to legacy`, e instanceof Error ? e.message : String(e));
          // Fallback: try File bytes then write (may OOM for 300MB but try)
          try {
            const bytes = await tmpFile.bytes();
            const res = await writeToDownloadLocation(base, file.name, bytes);
            if (res.ok) savedPaths.push(res.uri);
            else errors.push(`${file.name}: ${res.error}`);
          } catch (e2) {
            errors.push(`${file.name}: ${e2 instanceof Error ? e2.message : String(e2)}`);
          }
          try { srcHandle?.close(); } catch {}
          try { destHandle?.close(); } catch {}
          try { tmpFile.delete(); } catch {}
          return { savedPaths, errors };
        } finally {
          try { srcHandle?.close(); } catch {}
          try { destHandle?.close(); } catch {}
        }
        savedPaths.push(destFileUri);
        try { tmpFile.delete(); } catch {}
        return { savedPaths, errors };
      } else {
        // file:// — move or copy
        const safeName = file.name.replace(/[^\w.\- ()[\]]+/g, "_") || "file.bin";
        let dir = base.replace(/\/?$/, "");
        try {
          const d = new Directory(dir);
          if (!d.exists) d.create({ intermediates: true });
        } catch {}
        let dest = `${dir}/${safeName}`;
        let n = 1;
        while (true) {
          try {
            const test = new File(dest);
            if (!test.exists) break;
            const dot = safeName.lastIndexOf(".");
            const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
            const ext = dot > 0 ? safeName.slice(dot) : "";
            dest = `${dir}/${stem} (${n})${ext}`;
            n++;
            if (n > 200) break;
          } catch { break; }
        }
        const destFile = new File(dest);
        try {
          // Try atomic move
          tmpFile.move(destFile);
          savedPaths.push(destFile.uri);
        } catch {
          // Fallback streaming copy via handles (avoid loading whole 20MB+ into RAM)
          try {
            const CHUNK = 4 * 1024 * 1024;
            destFile.create({ overwrite: true });
            let srcH: { readBytes: (len: number) => Uint8Array; close: () => void; offset?: number | null } | null = null;
            let destH: { writeBytes: (b: Uint8Array) => void; close: () => void } | null = null;
            try {
              srcH = (tmpFile as unknown as { open: (m: string) => typeof srcH }).open("r");
            } catch {}
            try {
              destH = (destFile as unknown as { open: (m: string) => typeof destH }).open("w");
            } catch {}
            if (srcH && destH) {
              let off = 0;
              while (off < file.size) {
                const len = Math.min(CHUNK, file.size - off);
                try { if (typeof (srcH as unknown as { offset: number }).offset === "number") (srcH as unknown as { offset: number }).offset = off; } catch {}
                const chunk = srcH.readBytes(len);
                if (chunk.byteLength === 0) break;
                destH.writeBytes(chunk);
                off += chunk.byteLength;
              }
            } else {
              // Last resort: try whole-file via bytes (may OOM for >50MB but try)
              const data = await tmpFile.bytes();
              destFile.write(data);
            }
            try { srcH?.close(); } catch {}
            try { destH?.close(); } catch {}
            savedPaths.push(destFile.uri);
            try { tmpFile.delete(); } catch {}
          } catch (e) {
            errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return { savedPaths, errors };
      }
    } catch (e) {
      errors.push(`${files[0]!.name}: ${e instanceof Error ? e.message : String(e)}`);
      return { savedPaths, errors };
    }
  }
  // Multi-file: split concatenated temp via streaming (unlimited size)
  let offset = 0;
  for (const file of files) {
    try {
      // For large files (>64MiB), stream in 4MiB chunks to avoid OOM
      if (file.size > 64 * 1024 * 1024) {
        const { File, Directory } = await import("expo-file-system");
        const tmpFile = new File(diskPath);
        let base = downloadDirectory;
        if (!base) {
          const ensured = await ensureDefaultDownloadDir();
          base = ensured?.path;
        }
        if (!base) throw new Error("No download dir");
        if (base.startsWith("content://")) {
          // SAF: streaming via FileHandles (fix overwrite bug where each writeAsStringAsync overwrote previous chunk)
          const CHUNK = 4 * 1024 * 1024;
          const { StorageAccessFramework } = await import("expo-file-system/legacy");
          const mime = guessMime(file.name);
          const destUri = await StorageAccessFramework.createFileAsync(base, file.name.replace(/[^\w.\- ()[\]]+/g, "_"), mime);
          const destFile = new File(destUri);
          let written = 0;
          let fileOffset = offset;
          let srcH: { readBytes: (len: number) => Uint8Array; close: () => void; offset?: number | null } | null = null;
          let destH: { writeBytes: (b: Uint8Array) => void; close: () => void } | null = null;
          try {
            try { srcH = (tmpFile as unknown as { open: (m: string) => typeof srcH }).open("r"); } catch {}
            try { destH = (destFile as unknown as { open: (m: string) => typeof destH }).open("wa"); } catch {}
            if (srcH && destH) {
              while (written < file.size) {
                const len = Math.min(CHUNK, file.size - written);
                try { if (typeof (srcH as unknown as { offset: number }).offset === "number") (srcH as unknown as { offset: number }).offset = fileOffset; } catch {}
                const chunk = srcH.readBytes(len);
                if (chunk.byteLength === 0) break;
                destH.writeBytes(chunk);
                written += chunk.byteLength;
                fileOffset += chunk.byteLength;
              }
            } else {
              // Fallback per-chunk File.write append or slice+base64
              while (written < file.size) {
                const len = Math.min(CHUNK, file.size - written);
                let chunk: Uint8Array;
                if (srcH) {
                  try { if (typeof (srcH as unknown as { offset: number }).offset === "number") (srcH as unknown as { offset: number }).offset = fileOffset; } catch {}
                  chunk = srcH.readBytes(len);
                } else {
                  const sliceBlob = tmpFile.slice(fileOffset, fileOffset + len);
                  const buf = await sliceBlob.arrayBuffer();
                  chunk = new Uint8Array(buf);
                }
                if (chunk.byteLength === 0) break;
                try {
                  (destFile as unknown as { write: (b: Uint8Array, o?: unknown) => void }).write(chunk, { append: true });
                } catch {
                  const b64 = uint8ToBase64(chunk);
                  const { writeAsStringAsync, EncodingType } = await import("expo-file-system/legacy");
                  await writeAsStringAsync(destUri, b64, { encoding: EncodingType.Base64 });
                }
                written += chunk.byteLength;
                fileOffset += chunk.byteLength;
              }
            }
          } finally {
            try { srcH?.close(); } catch {}
            try { destH?.close(); } catch {}
          }
          savedPaths.push(destUri);
        } else {
          // file:// streaming via File API
          const safeName = file.name.replace(/[^\w.\- ()[\]]+/g, "_") || "file.bin";
          let dir = base.replace(/\/?$/, "");
          try {
            const d = new Directory(dir);
            if (!d.exists) d.create({ intermediates: true });
          } catch {}
          let dest = `${dir}/${safeName}`;
          let n = 1;
          while (true) {
            try {
              const test = new File(dest);
              if (!test.exists) break;
              const dot = safeName.lastIndexOf(".");
              const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
              const ext = dot > 0 ? safeName.slice(dot) : "";
              dest = `${dir}/${stem} (${n})${ext}`;
              n++;
              if (n > 200) break;
            } catch { break; }
          }
          const destFile = new File(dest);
          destFile.create({ overwrite: true });
          const CHUNK = 4 * 1024 * 1024;
          let fileOffset = offset;
          let remaining = file.size;
          // Use File open/readBytes for source if available, else slice
          let srcHandle: { readBytes: (len: number) => Uint8Array; close: () => void } | null = null;
          try {
            const fh = (tmpFile as unknown as { open?: (mode: string) => { readBytes: (len: number) => Uint8Array; close: () => void } }).open?.("r");
            if (fh) srcHandle = fh;
          } catch {}
          try {
            while (remaining > 0) {
              const len = Math.min(CHUNK, remaining);
              let chunk: Uint8Array;
              if (srcHandle) {
                try {
                  if (typeof (srcHandle as unknown as { offset?: number }).offset === "number") (srcHandle as unknown as { offset: number }).offset = fileOffset;
                } catch {}
                chunk = srcHandle.readBytes(len);
              } else {
                const sliceBlob = tmpFile.slice(fileOffset, fileOffset + len);
                const buf = await sliceBlob.arrayBuffer();
                chunk = new Uint8Array(buf);
              }
              if (chunk.byteLength === 0) break;
              // Write chunk via File API append
              try {
                (destFile as unknown as { write: (data: Uint8Array, opts?: unknown) => void }).write(chunk, { append: true });
              } catch {
                // Fallback to base64 legacy for this chunk
                const b64 = uint8ToBase64(chunk);
                const { writeAsStringAsync, EncodingType } = await import("expo-file-system/legacy");
                await writeAsStringAsync(dest, b64, { encoding: EncodingType.Base64 });
              }
              remaining -= chunk.byteLength;
              fileOffset += chunk.byteLength;
            }
          } finally {
            try { srcHandle?.close(); } catch {}
          }
          savedPaths.push(destFile.uri);
        }
      } else {
        const { File } = await import("expo-file-system");
        const tmpFile = new File(diskPath);
        const sliceBlob = tmpFile.slice(offset, offset + file.size);
        const buf = await sliceBlob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const res = await writeToDownloadLocation(downloadDirectory, file.name, bytes);
        if (res.ok) savedPaths.push(res.uri);
        else errors.push(`${file.name}: ${res.error}`);
      }
    } catch (e) {
      errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    offset += file.size;
  }
  try {
    const { File } = await import("expo-file-system");
    new File(diskPath).delete();
  } catch {}
  return { savedPaths, errors };
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof globalThis.Buffer !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).Buffer.from(b64, "base64") as Uint8Array;
  }
  const bin = typeof atob === "function" ? atob(b64) : "";
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function uint8ToBase64(bytes: Uint8Array): string {
  const Buf = (
    globalThis as {
      Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } };
    }
  ).Buffer;
  if (Buf) return Buf.from(bytes).toString("base64");

  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === "function") return btoa(binary);

  // RN without btoa/Buffer (unlikely)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    const bitmap = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += chars[(bitmap >> 18) & 63];
    out += chars[(bitmap >> 12) & 63];
    out += b === undefined ? "=" : chars[(bitmap >> 6) & 63];
    out += c === undefined ? "=" : chars[bitmap & 63];
  }
  return out;
}
