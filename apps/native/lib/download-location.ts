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
 */
export async function saveReceivedTransferFiles(
  downloadDirectory: string | undefined,
  files: { name: string; size: number }[],
  chunks: Uint8Array[],
): Promise<{ savedPaths: string[]; errors: string[] }> {
  const totalLen = chunks.reduce((a, c) => a + c.byteLength, 0);
  const merged = new Uint8Array(totalLen);
  let o = 0;
  for (const c of chunks) {
    merged.set(c, o);
    o += c.byteLength;
  }

  const savedPaths: string[] = [];
  const errors: string[] = [];
  let offset = 0;
  for (const file of files) {
    const size =
      files.length === 1
        ? merged.byteLength
        : Math.min(file.size || 0, Math.max(0, merged.byteLength - offset));
    const slice =
      files.length === 1
        ? merged
        : merged.subarray(offset, offset + (size || Math.max(0, merged.byteLength - offset)));
    const effective =
      slice.byteLength > 0
        ? slice
        : merged.subarray(offset);
    const res = await writeToDownloadLocation(downloadDirectory, file.name, effective);
    if (res.ok) savedPaths.push(res.uri);
    else errors.push(`${file.name}: ${res.error}`);
    offset += file.size || effective.byteLength;
  }
  return { savedPaths, errors };
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
