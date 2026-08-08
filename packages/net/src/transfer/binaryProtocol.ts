/**
 * Binary transfer protocol v4 — raw octet-stream over HTTP.
 * Control plane stays JSON envelopes (offer/accept/complete), data plane is binary.
 */

export const BINARY_CHUNK_HEADER_OFFSET = "x-lyra-offset";
export const BINARY_CHUNK_HEADER_EOF = "x-lyra-eof";
export const BINARY_CHUNK_HEADER_TRANSFER_ID = "x-lyra-transfer-id";
export const BINARY_CHUNK_HEADER_FILE_INDEX = "x-lyra-file-index";
export const BINARY_MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 4MiB
export const BINARY_DEFAULT_CHUNK_BYTES = 1 * 1024 * 1024; // 1MiB

export function binaryChunkPath(transferId: string): string {
  return `/lyra/transfer/${encodeURIComponent(transferId)}/chunk`;
}

export function parseBinaryChunkHeaders(headers: Record<string, string>): { offset: number; eof: boolean; transferId?: string } | { error: string } {
  const offsetRaw = headers[BINARY_CHUNK_HEADER_OFFSET] ?? headers["x-lyra-offset".toLowerCase()];
  const eofRaw = headers[BINARY_CHUNK_HEADER_EOF] ?? headers["x-lyra-eof".toLowerCase()];
  const tid = headers[BINARY_CHUNK_HEADER_TRANSFER_ID] ?? headers["x-lyra-transfer-id".toLowerCase()];
  if (offsetRaw === undefined) return { error: "Missing X-Lyra-Offset" };
  const offset = Number.parseInt(String(offsetRaw), 10);
  if (!Number.isFinite(offset) || offset < 0) return { error: "Invalid offset" };
  const eof = String(eofRaw).toLowerCase() === "1" || String(eofRaw).toLowerCase() === "true";
  return { offset, eof, transferId: tid ? String(tid) : undefined };
}
