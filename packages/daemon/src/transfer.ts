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
  fd?: fs.FileHandle | null;
};

export async function createTransferState(offer: Transfer): Promise<TransferState> {
  const tmpDir = path.join(os.tmpdir(), `lyra-${offer.transferId}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, "data.bin");
  // ensure file exists and truncate
  const fd = await fs.open(tmpPath, "w");
  // pre-truncate if totalBytes known? leave sparse
  // keep handle open for streaming writes
  const state: TransferState = {
    transferId: offer.transferId,
    files: offer.files,
    totalBytes: offer.totalBytes,
    receivedBytes: 0,
    tmpDir,
    tmpPath,
    fd,
  };
  return state;
}

export async function appendChunk(state: TransferState, offset: number, bytes: Uint8Array): Promise<void> {
  if (!state.fd) {
    state.fd = await fs.open(state.tmpPath, "r+");
  }
  const buf = Buffer.from(bytes);
  await state.fd.write(buf, 0, buf.length, offset);
  const end = offset + bytes.length;
  if (end > state.receivedBytes) state.receivedBytes = end;
}

function dedupPath(basePath: string): string {
  // sync check done async in verifyAndFinalize; this is helper for generation
  return basePath;
}

async function uniqueDestPath(destDir: string, fileName: string): Promise<string> {
  let candidate = path.join(destDir, fileName);
  try {
    await fs.access(candidate);
  } catch {
    return candidate;
  }
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
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

export async function verifyAndFinalize(
  state: TransferState,
  downloadDir: string,
): Promise<{ savedPaths: string[]; ok: boolean }> {
  try {
    if (state.fd) {
      await state.fd.close();
      state.fd = null;
    }
  } catch {
    // ignore
  }

  void dedupPath;

  // ensure download dir
  await fs.mkdir(downloadDir, { recursive: true });

  // compute sha256 of tmp file
  const hash = createHash("sha256");
  const fd = await fs.open(state.tmpPath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (true) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await fd.close();
  }
  const digest = hash.digest("hex");

  // verify against first file checksum if present
  if (state.files[0]?.checksum) {
    const expected = state.files[0].checksum.toLowerCase();
    if (expected !== digest.toLowerCase()) {
      return { savedPaths: [], ok: false };
    }
  }

  // For scaffold, we have single blob representing all files concatenated?
  // We'll handle simple case: if single file, move tmp to dest.
  // If multiple files, we treat tmp as concatenated and split not implemented — just save as first file.
  const savedPaths: string[] = [];
  if (state.files.length === 1 && state.files[0]) {
    const f = state.files[0];
    const dest = await uniqueDestPath(downloadDir, f.name);
    await fs.rename(state.tmpPath, dest);
    savedPaths.push(dest);
  } else {
    // multi-file stub: save whole blob as transferId.bin
    const fallback = state.files[0]?.name ?? `${state.transferId}.bin`;
    const dest = await uniqueDestPath(downloadDir, fallback);
    await fs.rename(state.tmpPath, dest);
    savedPaths.push(dest);
  }

  // cleanup tmpDir if empty (rename already moved file, remove dir)
  try {
    await fs.rmdir(state.tmpDir);
  } catch {
    // ignore
  }

  return { savedPaths, ok: true };
}
