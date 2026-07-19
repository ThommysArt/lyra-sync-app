/**
 * Download folder selection for received files (native).
 * - Android: Storage Access Framework directory picker
 * - iOS: app Documents (sandbox); iOS has no general user folder picker
 * - Web / Expo web: falls back to documentDirectory when available
 */
import { Platform } from "react-native";
import {
  documentDirectory,
  StorageAccessFramework,
} from "expo-file-system/legacy";

export type DownloadLocationResult =
  | { ok: true; path: string; label: string }
  | { ok: false; cancelled?: boolean; error?: string };

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
  if (path.includes("Documents")) return "App Documents";
  return path;
}

export function defaultDownloadPath(): string | undefined {
  return documentDirectory ?? undefined;
}

export function defaultDownloadLabel(): string {
  if (Platform.OS === "ios") return "App Documents (iOS default)";
  if (Platform.OS === "android") return "App storage (tap Browse to choose)";
  return "App Documents";
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
    // iOS apps are sandboxed — user-visible downloads live in app Documents.
    // Files can still be shared out via the system share sheet when saving.
    const path = documentDirectory;
    if (!path) {
      return {
        ok: false,
        error: "App Documents folder is unavailable on this build",
      };
    }
    return {
      ok: true,
      path,
      label: "App Documents (iOS sandbox)",
    };
  }

  // Expo web / unknown
  const path = documentDirectory;
  if (path) {
    return { ok: true, path, label: formatDownloadLabel(path) };
  }
  return {
    ok: false,
    error: "Folder picking needs a native iOS/Android build",
  };
}

/**
 * Write bytes into the configured download location.
 * Supports file:// documentDirectory and Android SAF content:// trees.
 */
export async function writeToDownloadLocation(
  downloadDirectory: string | undefined,
  fileName: string,
  bytes: Uint8Array,
): Promise<{ ok: true; uri: string } | { ok: false; error: string }> {
  const safeName = fileName.replace(/[^\w.\- ()[\]]+/g, "_") || "file.bin";
  const base = downloadDirectory || documentDirectory;
  if (!base) {
    return { ok: false, error: "No download directory available" };
  }

  try {
    if (base.startsWith("content://")) {
      // Android SAF tree
      const mime = guessMime(safeName);
      const fileUri = await StorageAccessFramework.createFileAsync(base, safeName, mime);
      // writeAsStringAsync with base64
      const { EncodingType, writeAsStringAsync } = await import("expo-file-system/legacy");
      const b64 = uint8ToBase64(bytes);
      await writeAsStringAsync(fileUri, b64, { encoding: EncodingType.Base64 });
      return { ok: true, uri: fileUri };
    }

    const { writeAsStringAsync, EncodingType } = await import("expo-file-system/legacy");
    const dest = base.endsWith("/") ? `${base}${safeName}` : `${base}/${safeName}`;
    await writeAsStringAsync(dest, uint8ToBase64(bytes), {
      encoding: EncodingType.Base64,
    });
    return { ok: true, uri: dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
