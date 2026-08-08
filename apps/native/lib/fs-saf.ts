/**
 * Phone file serving (SAF + app sandbox).
 * Mirrors packages/net/src/node/fs-browse.ts but for Android/iOS sandbox.
 * Exposes Downloads/Lyra, Documents/Lyra, DCIM/Camera via expo-file-system.
 */
import { Platform } from "react-native";
import * as FS from "expo-file-system/legacy";
import { documentDirectory } from "expo-file-system/legacy";

export type FsEntry = { name: string; path: string; isDirectory: boolean; size?: number; modifiedAt?: number };

async function ensureDir(path: string): Promise<void> {
  try {
    const info = await FS.getInfoAsync(path);
    if (!info.exists) await FS.makeDirectoryAsync(path, { intermediates: true });
  } catch {}
}

function guessRoot(): { docs: string | null; downloads: string | null; dcim: string | null } {
  const docs = documentDirectory ? `${documentDirectory.replace(/\/?$/, "/")}` : null;
  const downloads = Platform.OS === "android" ? "file:///storage/emulated/0/Download/Lyra" : docs ? `${docs}Lyra` : null;
  const dcim = Platform.OS === "android" ? "file:///storage/emulated/0/DCIM" : null;
  return { docs, downloads, dcim };
}

export async function listPhoneFiles(requestedPath: string): Promise<FsEntry[]> {
  const clean = requestedPath.replace(/^\/+/, "").replace(/\/+$/, "") || "/";
  if (clean === "/" || clean === "") {
    const { docs, downloads, dcim } = guessRoot();
    const entries: FsEntry[] = [];
    entries.push({ name: "Downloads", path: "/Downloads", isDirectory: true });
    entries.push({ name: "Documents", path: "/Documents", isDirectory: true });
    if (dcim) entries.push({ name: "Photos", path: "/Photos", isDirectory: true });
    entries.push({ name: "Screenshots", path: "/Screenshots", isDirectory: true });
    return entries;
  }
  const seg = clean.split("/")[0] ?? "";
  let base: string | null = null;
  const { docs, downloads, dcim } = guessRoot();
  if (seg === "Downloads") base = downloads;
  else if (seg === "Documents") base = docs ? `${docs.replace(/\/?$/, "/")}Lyra` : null;
  else if (seg === "Photos" || seg === "Screenshots") base = dcim ?? downloads;
  else base = docs ? `${docs.replace(/\/?$/, "/")}${clean}` : null;
  if (!base) return [];
  const sub = clean.split("/").slice(1).join("/");
  const target = sub ? `${base.replace(/\/?$/, "/")}${sub}` : base;
  try {
    const info = await FS.getInfoAsync(target);
    if (!info.exists) return [];
    if (!info.isDirectory) {
      const name = target.split("/").pop() ?? "file";
      return [{ name, path: requestedPath, isDirectory: false, size: (info as { size?: number }).size }];
    }
    const names = await FS.readDirectoryAsync(target);
    const out: FsEntry[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const childPath = `${target.replace(/\/?$/, "/")}${name}`;
      try {
        const ci = await FS.getInfoAsync(childPath);
        out.push({
          name,
          path: `${requestedPath.replace(/\/?$/, "")}/${name}`,
          isDirectory: Boolean((ci as { isDirectory?: boolean }).isDirectory),
          size: (ci as { size?: number }).size,
          modifiedAt: (ci as { modificationTime?: number }).modificationTime ? (ci as { modificationTime: number }).modificationTime * 1000 : undefined,
        });
      } catch {
        out.push({ name, path: `${requestedPath.replace(/\/?$/, "")}/${name}`, isDirectory: false });
      }
    }
    out.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    return out;
  } catch {
    return [];
  }
}

export async function readPhoneFileChunk(path: string, offset: number, maxBytes: number): Promise<{ dataBase64: string; eof: boolean; size: number } | { error: string }> {
  const seg = path.replace(/^\/+/, "").split("/")[0] ?? "";
  const { docs, downloads, dcim } = guessRoot();
  let base: string | null = null;
  if (seg === "Downloads") base = downloads;
  else if (seg === "Documents") base = docs ? `${docs.replace(/\/?$/, "/")}Lyra` : null;
  else if (seg === "Photos" || seg === "Screenshots") base = dcim ?? downloads;
  else base = docs ? `${docs.replace(/\/?$/, "/")}${path.replace(/^\/+/, "")}` : null;
  if (!base) return { error: "Not found" };
  const sub = path.replace(/^\/+/, "").split("/").slice(1).join("/");
  const target = seg === "Downloads" || seg === "Documents" || seg === "Photos" || seg === "Screenshots"
    ? sub ? `${base.replace(/\/?$/, "/")}${sub}` : base
    : base;
  try {
    const info = await FS.getInfoAsync(target);
    if (!info.exists || (info as { isDirectory?: boolean }).isDirectory) return { error: "Not a file" };
    const size = (info as { size?: number }).size ?? 0;
    // Try slice-capable reads to avoid OOM
    try {
      const mod = await import("expo-file-system");
      const FileCls = (mod as unknown as { File?: new (uri: string) => { slice?: (s: number, e: number) => { arrayBuffer?: () => Promise<ArrayBuffer> } } }).File;
      if (FileCls) {
        const f = new FileCls(target);
        const sliced = (f as unknown as { slice?: (s: number, e: number) => unknown }).slice?.(offset, offset + maxBytes) as { arrayBuffer?: () => Promise<ArrayBuffer> } | undefined;
        if (sliced?.arrayBuffer) {
          const ab = await sliced.arrayBuffer();
          const slice = new Uint8Array(ab);
          const eof = offset + slice.byteLength >= size;
          let outB64 = "";
          if (slice.byteLength > 0) {
            if ((globalThis as any).Buffer) outB64 = (globalThis as any).Buffer.from(slice).toString("base64");
            else {
              let binary = "";
              const chunk = 0x8000;
              for (let i = 0; i < slice.length; i += chunk) binary += String.fromCharCode(...slice.subarray(i, i + chunk));
              outB64 = btoa(binary);
            }
          }
          return { dataBase64: outB64, eof, size };
        }
      }
    } catch {}
    try {
      const { readAsStringAsync, EncodingType } = FS;
      // @ts-expect-error position/length are newer options
      const b64 = await readAsStringAsync(target, { encoding: EncodingType.Base64, position: offset, length: maxBytes });
      if (typeof b64 === "string" && b64.length > 0) {
        const approxSliceBytes = Math.ceil(b64.length * 0.75);
        if (approxSliceBytes <= maxBytes + 16) {
          const eof = offset + approxSliceBytes >= size;
          return { dataBase64: b64, eof, size };
        }
        if (approxSliceBytes < size) {
          const eof = offset + approxSliceBytes >= size;
          return { dataBase64: b64, eof, size };
        }
      }
    } catch {}
    const { readAsStringAsync, EncodingType } = FS;
    const b64 = await readAsStringAsync(target, { encoding: EncodingType.Base64 });
    const buf = (globalThis as any).Buffer ? (globalThis as any).Buffer.from(b64, "base64") as Uint8Array : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const slice = buf.subarray(offset, offset + maxBytes);
    const eof = offset + slice.byteLength >= buf.byteLength;
    let outB64 = "";
    if (slice.byteLength > 0) {
      if ((globalThis as any).Buffer) outB64 = (globalThis as any).Buffer.from(slice).toString("base64");
      else {
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < slice.length; i += chunk) binary += String.fromCharCode(...slice.subarray(i, i + chunk));
        outB64 = btoa(binary);
      }
    }
    return { dataBase64: outB64, eof, size };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
