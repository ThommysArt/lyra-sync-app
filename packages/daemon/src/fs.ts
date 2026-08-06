import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { FileEntry } from "@lyra-sync-app/protocol";

const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".rar": "application/x-rar-compressed",
  ".7z": "application/x-7z-compressed",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pages": "application/vnd.apple.pages",
  ".key": "application/vnd.apple.keynote",
  ".numbers": "application/vnd.apple.numbers",
  ".psd": "image/vnd.adobe.photoshop",
  ".ai": "application/postscript",
  ".sketch": "application/x-sketch",
  ".fig": "application/x-figma",
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
  // root / home variants: "", "/", "~", "home", "~/"
  const lower = trimmed.toLowerCase();
  if (trimmed === "" || trimmed === "/" || trimmed === "~" || lower === "home" || lower === "/home" || trimmed === "~/") return home;
  if (trimmed.startsWith("~/")) {
    const rest = trimmed.slice(2);
    return rest ? path.join(home, rest) : home;
  }
  // bare smart folder names without slash: "documents", "downloads", etc (case-insensitive)
  const bareSmart: Record<string, string> = {
    documents: path.join(home, "Documents"),
    downloads: path.join(home, "Downloads"),
    desktop: path.join(home, "Desktop"),
    pictures: path.join(home, "Pictures"),
    music: path.join(home, "Music"),
    videos: path.join(home, "Videos"),
    home: home,
  };
  const bareLower = lower.replace(/^\/+/, "");
  if (bareSmart[bareLower] && !trimmed.includes("/") && !trimmed.includes(path.sep)) {
    return bareSmart[bareLower] as string;
  }
  // slash-prefixed smart roots: /Documents etc (case-insensitive)
  const smartRoots: Record<string, string> = {
    "/documents": path.join(home, "Documents"),
    "/downloads": path.join(home, "Downloads"),
    "/desktop": path.join(home, "Desktop"),
    "/pictures": path.join(home, "Pictures"),
    "/music": path.join(home, "Music"),
    "/videos": path.join(home, "Videos"),
    "/home": home,
  };
  for (const [key, mapped] of Object.entries(smartRoots)) {
    if (lower === key) return mapped;
    if (lower.startsWith(key + "/")) {
      // preserve original suffix casing
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
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  const isRootRequest = trimmed === "" || trimmed === "/" || trimmed === "~" || lower === "home" || lower === "/home";
  const resolved = resolveSmartPath(input);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    // if resolved is homedir but smart merge requested, bubble? For root we still merge smart even if readdir fails? Return smart only
    if (isRootRequest) {
      entries = [];
    } else {
      throw err;
    }
  }
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
    // dedup case-insensitive by name and by path
    const existingNames = new Set(out.filter((e) => e.isDirectory).map((e) => e.name.toLowerCase()));
    const existingPaths = new Set(out.map((e) => path.normalize(e.path).toLowerCase()));
    for (const folder of smart) {
      const norm = path.normalize(folder.path).toLowerCase();
      if (existingNames.has(folder.name.toLowerCase()) || existingPaths.has(norm)) continue;
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

/** demo fallback for offline remote browse — used by core/store when transport offline */
export function listDemoFiles(dirPath: string): FileEntry[] {
  const base = dirPath && dirPath !== "/" ? dirPath.replace(/\/$/, "") : "/Demo";
  const now = Date.now();
  return [
    { name: "README.md", path: `${base}/README.md`, isDirectory: false, size: 1024, modifiedAt: now, mimeType: "text/markdown" } as FileEntry & { mimeType?: string },
    { name: "photo.jpg", path: `${base}/photo.jpg`, isDirectory: false, size: 2_048_000, modifiedAt: now, mimeType: "image/jpeg" } as FileEntry & { mimeType?: string },
    { name: "archive.zip", path: `${base}/archive.zip`, isDirectory: false, size: 5_000_000, modifiedAt: now, mimeType: "application/zip" } as FileEntry & { mimeType?: string },
    { name: "Projects", path: `${base}/Projects`, isDirectory: true, modifiedAt: now } as FileEntry,
  ];
}
