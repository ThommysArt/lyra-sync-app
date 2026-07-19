/**
 * Real OS filesystem listing for desktop peer servers (smart folders + browse).
 * Spec §5.7 — inspired by Sefirah-style storage access patterns.
 */
import { homedir, platform } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import { open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { FileEntry } from "@lyra-sync-app/protocol";

export type SmartFolderKey =
  | "photos"
  | "documents"
  | "downloads"
  | "desktop"
  | "screenshots";

function home(): string {
  return homedir();
}

/** Map smart-folder names / paths to absolute directories (platform-aware). */
export function resolveSmartFolder(key: SmartFolderKey | string): string | null {
  const h = home();
  const p = platform();
  const map: Record<string, string> = {
    photos:
      p === "darwin"
        ? join(h, "Pictures")
        : p === "win32"
          ? join(h, "Pictures")
          : join(h, "Pictures"),
    documents: join(h, "Documents"),
    downloads: join(h, "Downloads"),
    desktop: join(h, "Desktop"),
    screenshots:
      p === "darwin"
        ? join(h, "Pictures", "Screenshots")
        : p === "win32"
          ? join(h, "Pictures", "Screenshots")
          : join(h, "Pictures", "Screenshots"),
  };
  const lower = key.replace(/^\//, "").toLowerCase();
  if (map[lower]) return map[lower]!;
  // Accept full smart paths like /Documents
  for (const [k, v] of Object.entries(map)) {
    if (lower === k || lower === k.charAt(0).toUpperCase() + k.slice(1)) return v;
    if (key === `/${k.charAt(0).toUpperCase()}${k.slice(1)}`) return v;
    if (key === `/${k}`) return v;
  }
  // Common capitalized names
  const cap: Record<string, string> = {
    Photos: map.photos!,
    Documents: map.documents!,
    Downloads: map.downloads!,
    Desktop: map.desktop!,
    Screenshots: map.screenshots!,
    Pictures: map.photos!,
  };
  const base = key.replace(/^\//, "").split(/[/\\]/)[0] ?? "";
  if (cap[base]) {
    const rest = key.replace(/^\//, "").split(/[/\\]/).slice(1);
    return rest.length ? join(cap[base]!, ...rest) : cap[base]!;
  }
  return null;
}

/** Ensure path stays under home (or allowed roots) — path traversal guard. */
export function assertSafePath(absPath: string, roots?: string[]): string {
  const resolved = resolve(normalize(absPath));
  const allowed = roots ?? [home()];
  const ok = allowed.some((root) => {
    const r = resolve(root);
    return resolved === r || resolved.startsWith(r + sep);
  });
  if (!ok) {
    throw new Error("Path not allowed");
  }
  return resolved;
}

/** Virtual path → absolute. `/` is smart-folder root; other paths map via smart or home-relative. */
export function virtualToAbsolute(virtualPath: string): string {
  if (virtualPath === "/" || virtualPath === "" || virtualPath === ".") {
    return home();
  }
  const smart = resolveSmartFolder(virtualPath);
  if (smart) return assertSafePath(smart);

  // Absolute OS path only if under home
  if (virtualPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(virtualPath)) {
    return assertSafePath(virtualPath);
  }
  return assertSafePath(join(home(), virtualPath));
}

/** List directory at virtual path; root returns smart folders. */
export async function listOsFiles(virtualPath: string): Promise<FileEntry[]> {
  if (virtualPath === "/" || virtualPath === "") {
    const now = Date.now();
    return [
      { name: "Photos", path: "/Photos", isDirectory: true, modifiedAt: now },
      { name: "Documents", path: "/Documents", isDirectory: true, modifiedAt: now },
      { name: "Downloads", path: "/Downloads", isDirectory: true, modifiedAt: now },
      { name: "Desktop", path: "/Desktop", isDirectory: true, modifiedAt: now },
      { name: "Screenshots", path: "/Screenshots", isDirectory: true, modifiedAt: now },
    ];
  }

  const abs = virtualToAbsolute(virtualPath);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot list ${virtualPath}: ${msg}`);
  }

  const out: FileEntry[] = [];
  for (const ent of entries) {
    // Skip hidden by default
    if (ent.name.startsWith(".")) continue;
    const childAbs = join(abs, ent.name);
    const childVirtual = `${virtualPath.replace(/\/$/, "")}/${ent.name}`;
    let size: number | undefined;
    let modifiedAt: number | undefined;
    try {
      const st = await stat(childAbs);
      size = ent.isDirectory() ? undefined : st.size;
      modifiedAt = st.mtimeMs;
    } catch {
      // ignore stat errors
    }
    out.push({
      name: ent.name,
      path: childVirtual,
      isDirectory: ent.isDirectory(),
      size,
      modifiedAt,
    });
  }
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Read a slice of a file under home (for remote download). */
export async function readOsFileChunk(
  virtualPath: string,
  offset: number,
  maxBytes: number,
): Promise<{ data: Uint8Array; eof: boolean; size: number }> {
  const abs = virtualToAbsolute(virtualPath);
  const st = await stat(abs);
  if (st.isDirectory()) throw new Error("Path is a directory");
  const size = st.size;
  if (offset >= size) {
    return { data: new Uint8Array(0), eof: true, size };
  }
  const len = Math.min(maxBytes, size - offset);
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    const data = new Uint8Array(buf.subarray(0, bytesRead));
    return { data, eof: offset + bytesRead >= size, size };
  } finally {
    await fh.close();
  }
}

export async function deleteOsPath(virtualPath: string): Promise<void> {
  const abs = virtualToAbsolute(virtualPath);
  // Never delete home root or smart folder roots as a whole without being a file inside
  if (abs === home()) throw new Error("Refusing to delete home directory");
  const st = await stat(abs);
  if (st.isDirectory()) throw new Error("Directory delete not supported in v1 (files only)");
  await unlink(abs);
}

export async function renameOsPath(
  virtualPath: string,
  newName: string,
): Promise<string> {
  const abs = virtualToAbsolute(virtualPath);
  if (abs === home()) throw new Error("Refusing to rename home directory");
  const safeName = basename(newName);
  if (!safeName || safeName === "." || safeName === ".." || safeName.includes("/") || safeName.includes("\\")) {
    throw new Error("Invalid new name");
  }
  const dest = join(dirname(abs), safeName);
  assertSafePath(dest);
  await rename(abs, dest);
  // Return virtual path with new name
  const parent = virtualPath.replace(/\/[^/]+\/?$/, "") || "/";
  return parent === "/" ? `/${safeName}` : `${parent}/${safeName}`;
}
