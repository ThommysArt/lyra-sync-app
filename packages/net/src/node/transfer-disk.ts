/**
 * Disk-backed transfer receive buffers — avoid holding multi-GB in RAM.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { open, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export type DiskTransferState = {
  transferId: string;
  totalBytes: number;
  receivedBytes: number;
  files: { name: string; size: number }[];
  filePath: string;
  stream: WriteStream;
  paused: boolean;
  checksums?: (string | undefined)[];
  chunks: Uint8Array[];
};

export async function createDiskTransferState(input: {
  transferId: string;
  totalBytes: number;
  files: { name: string; size: number }[];
  resumeOffset?: number;
  checksums?: (string | undefined)[];
}): Promise<DiskTransferState> {
  const filePath = join(
    tmpdir(),
    `lyra-tx-${input.transferId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomBytes(4).toString("hex")}.bin`,
  );
  const stream = createWriteStream(filePath, {
    flags: input.resumeOffset && input.resumeOffset > 0 ? "a" : "w",
  });
  await new Promise<void>((resolve, reject) => {
    stream.once("open", () => resolve());
    stream.once("error", reject);
  });
  return {
    transferId: input.transferId,
    totalBytes: input.totalBytes,
    receivedBytes: input.resumeOffset ?? 0,
    files: input.files,
    filePath,
    stream,
    paused: false,
    checksums: input.checksums,
    chunks: [],
  };
}

export function appendDiskChunk(
  state: DiskTransferState,
  bytes: Uint8Array,
  absoluteOffset: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (absoluteOffset !== state.receivedBytes) {
      if (absoluteOffset < state.receivedBytes) {
        resolve();
        return;
      }
      reject(new Error(`Chunk offset gap: expected ${state.receivedBytes}, got ${absoluteOffset}`));
      return;
    }
    const buf = Buffer.isBuffer(bytes) ? (bytes as Buffer) : Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    const canWriteMore = state.stream.write(buf, (err) => {
      if (err) reject(err);
      else {
        state.receivedBytes += bytes.byteLength;
        resolve();
      }
    });
    if (!canWriteMore) {
      state.stream.once("drain", () => {});
    }
  });
}

export async function finalizeDiskTransfer(
  state: DiskTransferState,
): Promise<{ filePath: string; sha256?: string; size: number }> {
  await new Promise<void>((resolve, reject) => {
    if (state.stream.writableEnded || state.stream.destroyed) resolve();
    else state.stream.end(() => resolve());
    state.stream.once("error", reject);
  });
  const st = await stat(state.filePath);
  const fh = await open(state.filePath, "r");
  const hash = createHash("sha256");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let pos = 0;
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return { filePath: state.filePath, sha256: hash.digest("hex"), size: st.size };
  } finally {
    await fh.close();
  }
}

export async function cleanupDiskTransfer(state: DiskTransferState): Promise<void> {
  try {
    state.stream.destroy();
  } catch {}
  try {
    await unlink(state.filePath);
  } catch {}
}
