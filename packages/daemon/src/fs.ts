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

function toFileEntry(fullPath: string, name: string, stat: { isDirectory(): boolean; size: number; mtimeMs: number }): FileEntry & { mimeType?: string } {
  return {
    name,
    path: fullPath,
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? undefined : stat.size,
    modifiedAt: stat.mtimeMs,
    mimeType: stat.isDirectory() ? undefined : getMimeType(name),
  } as FileEntry & { mimeType?: string };
}

export async function statOsPath(targetPath: string): Promise<{ exists: boolean; isDirectory: boolean; size?: number; modifiedAt?: number }> {
  try {
    const s = await fs.stat(targetPath);
    return { exists: true, isDirectory: s.isDirectory(), size: s.size, modifiedAt: s.mtimeMs };
  } catch {
    return { exists: false, isDirectory: false };
  }
}

export async function listOsFiles(dirPath: string): Promise<FileEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      out.push(toFileEntry(fullPath, entry.name, stat) as FileEntry);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

export async function readOsFileChunk(filePath: string, offset: number, maxBytes: number): Promise<Uint8Array> {
  const fd = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buf, 0, maxBytes, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fd.close();
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
