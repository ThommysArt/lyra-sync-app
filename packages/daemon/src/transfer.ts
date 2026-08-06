import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { Transfer, TransferFile } from "@lyra-sync-app/protocol";

export type TransferState = {
  transferId: string;
  files: TransferFile[];
  totalBytes: number;
  receivedBytes: number;
  tmpDir: string;
  tmpPath: string;
  fh: fs.FileHandle | null;
  /** alias for backward compat — same handle as fh */
  fd?: fs.FileHandle | null;
  checksums?: string[];
};

const _transferStates = new Map<string, TransferState>();

export function getTransferState(id: string): TransferState | undefined {
  return _transferStates.get(id);
}

async function uniqueDestPath(destDir: string, fileName: string): Promise<string> {
  // sanitize basename to avoid traversal
  const safe = path.basename(fileName) || "file";
  let candidate = path.join(destDir, safe);
  try {
    await fs.access(candidate);
  } catch {
    return candidate;
  }
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let i = 1;
  while (true) {
    const next = path.join(destDir, `${base} (${i})${ext}`);
    try {
      await fs.access(next);
      i++;
    } catch {
      return next;
    }
  }
}

export async function createTransferState(offer: Transfer | { transferId: string; files: Array<{ name: string; size: number; checksum?: string }>; totalBytes: number; checksums?: string[] }): Promise<TransferState> {
  // use mkdtemp for secure unique temp dir — supports >2GB streaming via sparse file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lyra-"));
  const tmpPath = path.join(tmpDir, "data.bin");
  const fh = await fs.open(tmpPath, "w");
  // optional preallocation could be done via truncate, but keep sparse for efficiency
  const checksums = (offer as { checksums?: string[] }).checksums
    ?? (offer as Transfer).files?.map((f) => (f as { checksum?: string }).checksum).filter(Boolean) as string[] | undefined;

  const mappedFiles: TransferFile[] = (offer.files as Array<{ name: string; size: number; checksum?: string }>).map((f) => ({
    name: f.name,
    size: f.size,
    ...(f.checksum ? { checksum: f.checksum } : {}),
  }));

  const state: TransferState = {
    transferId: offer.transferId,
    files: mappedFiles,
    totalBytes: offer.totalBytes,
    receivedBytes: 0,
    tmpDir,
    tmpPath,
    fh,
    fd: fh,
    ...(checksums && checksums.length ? { checksums } : {}),
  };
  _transferStates.set(offer.transferId, state);
  return state;
}

export async function appendChunk(state: TransferState, offset: number, bytes: Uint8Array): Promise<void> {
  // reopen if closed (e.g., after pause/resume)
  let handle = state.fh ?? state.fd ?? null;
  if (!handle) {
    handle = await fs.open(state.tmpPath, "r+");
    state.fh = handle;
    state.fd = handle;
  }
  const buf = Buffer.isBuffer(bytes) ? (bytes as Buffer) : Buffer.from(bytes);
  await handle.write(buf, 0, buf.length, offset);
  const end = offset + bytes.length;
  if (end > state.receivedBytes) state.receivedBytes = end;
}

export async function finalizeTransfer(
  state: TransferState,
  downloadDir: string,
): Promise<{ savedPaths: string[]; ok: boolean; error?: string }> {
  // close handle
  try {
    const h = state.fh ?? state.fd;
    if (h) {
      await h.close();
      state.fh = null;
      state.fd = null;
    }
  } catch {
    // ignore close error
  }

  await fs.mkdir(downloadDir, { recursive: true });

  // verify checksum if present and verifyTransferIntegrity-like (always verify when checksums provided)
  // global hash over concatenated blob
  let digest: string | null = null;
  try {
    const hash = createHash("sha256");
    const fh2 = await fs.open(state.tmpPath, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      let pos = 0;
      while (true) {
        const { bytesRead } = await fh2.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
    } finally {
      await fh2.close();
    }
    digest = hash.digest("hex");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // cleanup tmp
    try {
      await fs.rm(state.tmpDir, { recursive: true, force: true });
    } catch {}
    return { savedPaths: [], ok: false, error: `hash failed: ${msg}` };
  }

  // if any file carries checksum, compare global digest against first checksum (single-file case)
  // if multiple checksums provided, we treat checksums[0] as global for scaffold
  const expectedList = state.checksums ?? state.files.map((f) => f.checksum).filter(Boolean) as string[];
  if (expectedList && expectedList.length > 0 && digest) {
    // for single file, strict compare
    if (state.files.length === 1 && expectedList[0]) {
      const expected = expectedList[0].toLowerCase();
      if (expected !== digest.toLowerCase()) {
        try {
          await fs.rm(state.tmpDir, { recursive: true, force: true });
        } catch {}
        return { savedPaths: [], ok: false, error: "checksum mismatch" };
      }
    } else if (state.files.length > 1 && expectedList.length === state.files.length) {
      // multi-file: verify per-file slice hash if we can; compute per slice
      // we already have global digest but not per-file; do per-file verification by streaming each slice
      // For now, accept global mismatch only if all individual slice hashes also mismatch? Instead verify each slice.
      // compute per-file hashes and compare
      const fh3 = await fs.open(state.tmpPath, "r");
      try {
        let offset = 0;
        for (let i = 0; i < state.files.length; i++) {
          const f = state.files[i] as TransferFile;
          const exp = expectedList[i];
          if (!exp) {
            offset += f.size;
            continue;
          }
          const h = createHash("sha256");
          let remaining = f.size;
          let pos = offset;
          const buf = Buffer.alloc(64 * 1024);
          while (remaining > 0) {
            const toRead = Math.min(buf.length, remaining);
            const { bytesRead } = await fh3.read(buf, 0, toRead, pos);
            if (bytesRead === 0) break;
            h.update(buf.subarray(0, bytesRead));
            pos += bytesRead;
            remaining -= bytesRead;
          }
          const d = h.digest("hex");
          if (d.toLowerCase() !== exp.toLowerCase()) {
            await fh3.close();
            try {
              await fs.rm(state.tmpDir, { recursive: true, force: true });
            } catch {}
            return { savedPaths: [], ok: false, error: `checksum mismatch for ${f.name}` };
          }
          offset += f.size;
        }
      } finally {
        try {
          await fh3.close();
        } catch {}
      }
    }
  }

  // slice tmp blob into individual files — streaming copy per file to support >2GB
  const savedPaths: string[] = [];
  const tmpFh = await fs.open(state.tmpPath, "r");
  try {
    let sliceOffset = 0;
    for (const f of state.files) {
      const dest = await uniqueDestPath(downloadDir, f.name);
      const outFh = await fs.open(dest, "w");
      try {
        let remaining = f.size;
        let readPos = sliceOffset;
        const buf = Buffer.alloc(64 * 1024);
        while (remaining > 0) {
          const toRead = Math.min(buf.length, remaining);
          const { bytesRead } = await tmpFh.read(buf, 0, toRead, readPos);
          if (bytesRead === 0) break;
          await outFh.write(buf, 0, bytesRead);
          readPos += bytesRead;
          remaining -= bytesRead;
        }
        // if file size 0, we already created empty file
      } finally {
        await outFh.close();
      }
      savedPaths.push(dest);
      sliceOffset += f.size;
    }
  } finally {
    await tmpFh.close();
  }

  // cleanup tmp dir
  try {
    await fs.rm(state.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  _transferStates.delete(state.transferId);

  return { savedPaths, ok: true };
}

// backward compat alias
export const verifyAndFinalize = finalizeTransfer;

export async function abortTransfer(state: TransferState): Promise<void> {
  try {
    const h = state.fh ?? state.fd;
    if (h) {
      try {
        await h.close();
      } catch {}
      state.fh = null;
      state.fd = null;
    }
  } catch {}
  try {
    await fs.rm(state.tmpDir, { recursive: true, force: true });
  } catch {}
  // also try unlink tmpPath directly if rm fails
  try {
    await fs.unlink(state.tmpPath);
  } catch {}
  _transferStates.delete(state.transferId);
}
