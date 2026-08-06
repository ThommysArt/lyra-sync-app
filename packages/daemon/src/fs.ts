import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { FileEntry } from "@lyra-sync-app/protocol";

const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain",
  ".json": "application/json",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".html": "text/html",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

function getMimeType(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_MAP[ext];
}

function toFileEntry(fullPath: string, name: string, stat: { isDirectory(): boolean; size: number; mtimeMs: number }): FileEntry {
  return {
    name,
    path: fullPath,
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? undefined : stat.size,
    modifiedAt: stat.mtimeMs,
    ...(stat.isDirectory() ? {} : { mimeType: getMimeType(name) }),
  } as FileEntry & { mimeType?: string };
}

export function resolveSmartPath(p: string): string {
  const home = os.homedir();
  const trimmed = (p ?? "").trim();
  if (trimmed === "" || trimmed === "/" || trimmed === "~") return home;
  if (trimmed === "~/" || trimmed.startsWith("~/")) {
    const rest = trimmed.slice(2);
    return rest ? path.join(home, rest) : home;
  }
  const smartRoots: Record<string, string> = {
    "/Documents": path.join(home, "Documents"),
    "/Downloads": path.join(home, "Downloads"),
    "/Desktop": path.join(home, "Desktop"),
    "/Pictures": path.join(home, "Pictures"),
    "/Music": path.join(home, "Music"),
    "/Videos": path.join(home, "Videos"),
  };
  if (smartRoots[trimmed]) return smartRoots[trimmed] as string;
  for (const [key, mapped] of Object.entries(smartRoots)) {
    if (trimmed === key + "/" || trimmed.startsWith(key + "/")) {
      const suffix = trimmed.slice(key.length + 1);
      return suffix ? path.join(mapped, suffix) : mapped;
    }
  }
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(trimmed);
}

export async function statOsPath(targetPath: string): Promise<{ exists: boolean; isDirectory: boolean; size?: number; modifiedAt?: number }> {
  const resolved = resolveSmartPath(targetPath);
  try {
    const s = await fs.stat(resolved);
    return { exists: true, isDirectory: s.isDirectory(), size: s.size, modifiedAt: s.mtimeMs };
  } catch {
    return { exists: false, isDirectory: false };
  }
}

export async function listOsFiles(dirPath: string): Promise<FileEntry[]> {
  const input = dirPath ?? "";
  const isRootRequest = input.trim() === "" || input.trim() === "/" || input.trim() === "~";
  const resolved = resolveSmartPath(input);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const entry of entries) {
    const fullPath = path.join(resolved, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      out.push(toFileEntry(fullPath, entry.name, stat) as FileEntry);
    } catch {
      // skip unreadable
    }
  }
  if (isRootRequest) {
    const smart = getSmartFolders();
    const existingNames = new Set(out.filter((e) => e.isDirectory).map((e) => e.name.toLowerCase()));
    for (const folder of smart) {
      if (!existingNames.has(folder.name.toLowerCase())) {
        try {
          const stat = await fs.stat(folder.path);
          out.push(toFileEntry(folder.path, folder.name, stat) as FileEntry);
        } catch {
          out.push({
            name: folder.name,
            path: folder.path,
            isDirectory: true,
            modifiedAt: Date.now(),
          } as FileEntry);
        }
      }
    }
  }
  return out;
}

export async function readOsFileChunk(filePath: string, offset: number, maxBytes: number): Promise<Uint8Array> {
  const resolved = resolveSmartPath(filePath);
  const len = Math.max(0, Math.floor(maxBytes));
  if (len === 0) return new Uint8Array(0);
  const safeOffset = Math.max(0, Math.floor(offset));
  const fh = await fs.open(resolved, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, safeOffset);
    if (bytesRead === len) return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead));
  } finally {
    await fh.close();
  }
}

export type SmartFolderId = "documents" | "downloads" | "desktop" | "pictures";

export function getSmartFolderPath(id: SmartFolderId): string {
  const home = os.homedir();
  switch (id) {
    case "documents":
      return path.join(home, "Documents");
    case "downloads":
      return path.join(home, "Downloads");
    case "desktop":
      return path.join(home, "Desktop");
    case "pictures":
      return path.join(home, "Pictures");
    default:
      return home;
  }
}

export function getSmartFolders(): Array<{ id: SmartFolderId; name: string; path: string; icon?: string }> {
  return [
    { id: "documents", name: "Documents", path: getSmartFolderPath("documents"), icon: "folder" },
    { id: "downloads", name: "Downloads", path: getSmartFolderPath("downloads"), icon: "download" },
    { id: "desktop", name: "Desktop", path: getSmartFolderPath("desktop"), icon: "monitor" },
    { id: "pictures", name: "Pictures", path: getSmartFolderPath("pictures"), icon: "image" },
  ];
}

export { getMimeType };
