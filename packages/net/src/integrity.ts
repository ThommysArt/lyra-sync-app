import type { Transfer, TransferFile } from "@lyra-sync-app/protocol";

import { sha256Hex } from "./crypto-util";

export type ResumeState = {
  transferId: string;
  /** Per-file acknowledged byte offsets */
  fileOffsets: number[];
  /** Total acknowledged bytes across all files */
  totalOffset: number;
};

/** SHA-256 of string/bytes content (file body in memory). */
export async function checksumBytes(data: string | Uint8Array): Promise<string> {
  return sha256Hex(data);
}

/** Compare two hex digests case-insensitively. */
export function checksumsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Build resume state from a transfer that may have been interrupted.
 * Uses per-file transferredBytes when present, else proportional session offset.
 */
export function getResumeState(transfer: Transfer): ResumeState {
  const fileOffsets = transfer.files.map((f) => {
    if (typeof f.transferredBytes === "number") {
      return Math.min(f.size, Math.max(0, f.transferredBytes));
    }
    return 0;
  });

  let totalOffset = fileOffsets.reduce((a, b) => a + b, 0);

  // If only session-level progress is known, distribute into first incomplete file
  if (totalOffset === 0 && transfer.transferredBytes > 0) {
    let remaining = transfer.transferredBytes;
    for (let i = 0; i < transfer.files.length; i++) {
      const file = transfer.files[i]!;
      const take = Math.min(file.size, remaining);
      fileOffsets[i] = take;
      remaining -= take;
      if (remaining <= 0) break;
    }
    totalOffset = transfer.transferredBytes;
  }

  if (typeof transfer.resumeOffset === "number" && transfer.resumeOffset > totalOffset) {
    totalOffset = transfer.resumeOffset;
  }

  return {
    transferId: transfer.id,
    fileOffsets,
    totalOffset: Math.min(transfer.totalBytes, totalOffset),
  };
}

/** Apply an acknowledged chunk to transfer progress fields (pure). */
export function applyChunkProgress(
  transfer: Transfer,
  receivedBytes: number,
): Pick<Transfer, "transferredBytes" | "resumeOffset" | "files" | "updatedAt"> {
  const resume = getResumeState(transfer);
  const nextTotal = Math.min(transfer.totalBytes, Math.max(resume.totalOffset, receivedBytes));
  let remaining = nextTotal;
  const files: TransferFile[] = transfer.files.map((f) => {
    const take = Math.min(f.size, remaining);
    remaining -= take;
    return { ...f, transferredBytes: take };
  });
  return {
    transferredBytes: nextTotal,
    resumeOffset: nextTotal,
    files,
    updatedAt: Date.now(),
  };
}

/**
 * Verify all files that declare a checksum. Files without checksum are skipped.
 * Returns ok=true when every declared checksum is present and matches (or none declared).
 */
export async function verifyTransferIntegrity(
  transfer: Transfer,
  /** Map of file name → actual content checksum */
  actualChecksums: Record<string, string>,
): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  for (const file of transfer.files) {
    if (!file.checksum) continue;
    const actual = actualChecksums[file.name];
    if (!checksumsMatch(file.checksum, actual)) {
      failed.push(file.name);
    }
  }
  return { ok: failed.length === 0, failed };
}

/** Whether a paused/partial transfer can be resumed. */
export function canResumeTransfer(transfer: Transfer): boolean {
  return (
    (transfer.status === "paused" ||
      transfer.status === "partial" ||
      transfer.status === "failed") &&
    transfer.transferredBytes > 0 &&
    transfer.transferredBytes < transfer.totalBytes
  );
}

/** Next byte offset the sender should start from. */
export function nextSendOffset(transfer: Transfer): number {
  return getResumeState(transfer).totalOffset;
}
