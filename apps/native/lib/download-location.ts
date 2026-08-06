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

  try {
    if (base.startsWith("content://")) {
      // Android SAF tree
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
