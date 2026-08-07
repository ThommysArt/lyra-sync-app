/**
 * Multi-chunk file transfer over HTTP envelopes — streaming, large chunks, pipelined.
 */
import type { TransferFile } from "@lyra-sync-app/protocol";

import { createEnvelope } from "./envelope";
import { sendEnvelope, type PeerUrl } from "./peer-client";
import { checksumBytes } from "./integrity";
import { bytesToHex } from "./crypto-util";

export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB (was 48 KiB)
export const MIN_CHUNK_SIZE = 256 * 1024;
export const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
export const DEFAULT_WINDOW_SIZE = 8;

function hasSubtleSync(): boolean {
  try {
    return typeof globalThis.crypto?.subtle?.importKey === "function";
  } catch { return false; }
}
export function adaptiveChunkSize(opts: {
  totalBytes: number;
  availableRamHint?: number;
  rttMsHint?: number;
  preferred?: number;
}): number {
  if (opts.preferred && opts.preferred >= MIN_CHUNK_SIZE && opts.preferred <= MAX_CHUNK_SIZE) {
    return opts.preferred;
  }
  // With AES-GCM (v1b) crypto is fast — use larger chunks for LAN throughput.
  // Keep smaller chunks only when RAM is critically low or RTT is high.
  if (opts.availableRamHint && opts.availableRamHint < 400 * 1024 * 1024) return 512 * 1024;
  if (opts.rttMsHint && opts.rttMsHint > 120) return 512 * 1024;
  if (opts.totalBytes >= 100 * 1024 * 1024) return 2 * 1024 * 1024;
  if (opts.totalBytes >= 20 * 1024 * 1024) return 1 * 1024 * 1024;
  if (opts.totalBytes >= 5 * 1024 * 1024) return 1 * 1024 * 1024;
  if (opts.totalBytes >= 1024 * 1024) return 1 * 1024 * 1024;
  return hasSubtleSync() ? 1 * 1024 * 1024 : 512 * 1024;
}

function estimateAvailableRam(): number | undefined {
  try {
    const nav = (globalThis as unknown as { navigator?: { deviceMemory?: number } }).navigator;
    if (nav?.deviceMemory) return nav.deviceMemory * 1024 * 1024 * 1024;
  } catch {}
  return undefined;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const Buf = (globalThis as { Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } } })
    .Buffer;
  if (Buf) {
    return Buf.from(bytes).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const Buf = (globalThis as {
    Buffer?: { from: (s: string, e: string) => Uint8Array };
  }).Buffer;
  if (Buf) {
    return new Uint8Array(Buf.from(b64, "base64"));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export type WireTransferProgress = {
  transferredBytes: number;
  totalBytes: number;
  currentSpeedBps: number;
  etaSeconds: number;
};

export type SendFilesOverWireInput = {
  endpoint: PeerUrl;
  sessionToken: string;
  fromDeviceId: string;
  toDeviceId: string;
  transferId: string;
  files: { name: string; size: number; mimeType?: string; bytes?: Uint8Array; checksum?: string }[];
  resumeOffset?: number;
  chunkSize?: number;
  windowSize?: number;
  rttMsHint?: number;
  /** Optional streaming reader: if provided, used instead of bytes subarray (avoids holding whole file) */
  readFileSlice?: (fileIndex: number, offset: number, length: number) => Promise<Uint8Array>;
  onProgress?: (p: WireTransferProgress) => void;
  signal?: AbortSignal;
  sealSecret?: string;
};

/**
 * Offer + stream file bytes as transfer_chunk messages; pipelined.
 */
export async function sendFilesOverWire(
  input: SendFilesOverWireInput,
): Promise<{ ok: true; checksums: string[] } | { ok: false; error: string }> {
  const totalBytes = input.files.reduce((a, f) => a + (f.size || f.bytes?.byteLength || 0), 0);
  const resumeOffset = Math.min(totalBytes, Math.max(0, input.resumeOffset ?? 0));
  const chunkSize = adaptiveChunkSize({
    totalBytes,
    availableRamHint: estimateAvailableRam(),
    rttMsHint: input.rttMsHint,
    preferred: input.chunkSize,
  });
  // LAN: larger window for throughput; AES-GCM is fast so we can pipeline more.
  const defaultWindow = hasSubtleSync() ? 12 : 8;
  const windowSize = Math.max(1, Math.min(16, input.windowSize ?? defaultWindow));

  const offerFiles: TransferFile[] = input.files.map((f) => ({
    name: f.name,
    size: f.size || f.bytes?.byteLength || 0,
    mimeType: f.mimeType,
    checksum: f.checksum,
  }));

  const offer = createEnvelope({
    type: "transfer_offer",
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    payload: {
      id: input.transferId,
      files: offerFiles,
      totalBytes,
      deviceId: input.fromDeviceId,
      deviceName: input.fromDeviceId,
      resumeOffset,
      checksums: input.files.map((f) => f.checksum).filter(Boolean),
    },
  });

  const offerRes = await sendEnvelope(input.endpoint, offer, {
    sessionToken: input.sessionToken,
    signal: input.signal,
    sealSecret: input.sealSecret,
  });
  if (!offerRes.ok) return { ok: false, error: offerRes.error };
  if (offerRes.envelope && offerRes.envelope.type !== "transfer_accept") {
    const reason =
      (offerRes.envelope.payload as { reason?: string; error?: string } | undefined)
        ?.reason ||
      (offerRes.envelope.payload as { error?: string } | undefined)?.error ||
      `Unexpected transfer offer reply: ${offerRes.envelope.type}`;
    return { ok: false, error: reason };
  }

  // Build concatenated view for session-offset addressing using sizes
  const fileSizes = input.files.map((f) => f.size || f.bytes?.byteLength || 0);
  let sessionCursor = 0;
  const fileStarts: number[] = [];
  for (const s of fileSizes) {
    fileStarts.push(sessionCursor);
    sessionCursor += s;
  }

  // Helper to get slice for a given file and offset
  const getSlice = async (fileIndex: number, localOffset: number, len: number): Promise<Uint8Array> => {
    if (input.readFileSlice) {
      return input.readFileSlice(fileIndex, localOffset, len);
    }
    const file = input.files[fileIndex]!;
    if (!file.bytes) throw new Error(`Missing bytes for file ${file.name} and no readFileSlice`);
    return file.bytes.subarray(localOffset, Math.min(file.bytes.byteLength, localOffset + len));
  };

  let sent = resumeOffset;
  const startedAt = Date.now();
  let lastReport = startedAt;

  const report = (nowAcked: number, isEof: boolean) => {
    const now = Date.now();
    if (now - lastReport > 80 || isEof) {
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      const progressed = Math.max(0, nowAcked - resumeOffset);
      const currentSpeedBps = progressed / elapsed;
      const remaining = totalBytes - nowAcked;
      const etaSeconds = currentSpeedBps > 0 ? remaining / currentSpeedBps : 0;
      input.onProgress?.({ transferredBytes: nowAcked, totalBytes, currentSpeedBps, etaSeconds });
      lastReport = now;
    }
  };

  if (windowSize <= 1) {
    while (sent < totalBytes) {
      if (input.signal?.aborted) return { ok: false, error: "Aborted" };
      let fileIndex = 0;
      for (let i = 0; i < fileStarts.length; i++) {
        const start = fileStarts[i]!;
        const end = start + fileSizes[i]!;
        if (sent < end) { fileIndex = i; break; }
        fileIndex = i;
      }
      const fileStart = fileStarts[fileIndex]!;
      const localOffset = sent - fileStart;
      const remainingInFile = fileSizes[fileIndex]! - localOffset;
      const want = Math.min(chunkSize, remainingInFile);
      const slice = await getSlice(fileIndex, localOffset, want);
      const nextOffset = sent + slice.byteLength;
      const eof = nextOffset >= totalBytes;
      const chunkEnv = createEnvelope({
        type: "transfer_chunk",
        fromDeviceId: input.fromDeviceId,
        toDeviceId: input.toDeviceId,
        payload: {
          transferId: input.transferId,
          fileIndex,
          offset: sent,
          dataBase64: bytesToBase64(slice),
          eof,
          checksum: eof ? input.files[fileIndex]?.checksum : undefined,
        },
      });
      const chunkRes = await sendEnvelope(input.endpoint, chunkEnv, {
        sessionToken: input.sessionToken,
        signal: input.signal,
        sealSecret: input.sealSecret,
      });
      if (!chunkRes.ok) return { ok: false, error: chunkRes.error };
      if (chunkRes.envelope?.type === "transfer_pause") return { ok: false, error: "Transfer paused by peer" };
      sent = nextOffset;
      report(sent, eof);
    }
  } else {
    type ChunkDesc = { offset: number; fileIndex: number; localOffset: number; len: number; eof: boolean };
    const chunks: ChunkDesc[] = [];
    for (let off = resumeOffset; off < totalBytes; ) {
      let fileIndex = 0;
      for (let i = 0; i < fileStarts.length; i++) {
        const start = fileStarts[i]!;
        const end = start + fileSizes[i]!;
        if (off < end) { fileIndex = i; break; }
        fileIndex = i;
      }
      const fileStart = fileStarts[fileIndex]!;
      const localOffset = off - fileStart;
      const remainingInFile = fileSizes[fileIndex]! - localOffset;
      const want = Math.min(chunkSize, remainingInFile);
      const nextOffset = off + want;
      chunks.push({ offset: off, fileIndex, localOffset, len: want, eof: nextOffset >= totalBytes });
      off = nextOffset;
      // Avoid allocating huge array for 300MB/1MB =300 entries fine
      if (chunks.length > 200_000) break;
    }

    let completed = 0;
    let highestAcked = resumeOffset;
    let failed: string | null = null;
    let paused = false;
    let nextIdx = 0;

    async function worker(): Promise<void> {
      while (true) {
        if (failed || paused) return;
        if (input.signal?.aborted) { failed = "Aborted"; return; }
        const idx = nextIdx++;
        if (idx >= chunks.length) return;
        const c = chunks[idx]!;
        let slice: Uint8Array;
        try {
          slice = await getSlice(c.fileIndex, c.localOffset, c.len);
        } catch (e) {
          failed = e instanceof Error ? e.message : String(e);
          return;
        }
        const chunkEnv = createEnvelope({
          type: "transfer_chunk",
          fromDeviceId: input.fromDeviceId,
          toDeviceId: input.toDeviceId,
          payload: {
            transferId: input.transferId,
            fileIndex: c.fileIndex,
            offset: c.offset,
            dataBase64: bytesToBase64(slice),
            eof: c.eof,
            checksum: c.eof ? input.files[c.fileIndex]?.checksum : undefined,
          },
        });
        const chunkRes = await sendEnvelope(input.endpoint, chunkEnv, {
          sessionToken: input.sessionToken,
          signal: input.signal,
          sealSecret: input.sealSecret,
        });
        if (!chunkRes.ok) { failed = chunkRes.error; return; }
        if (chunkRes.envelope?.type === "transfer_pause") { paused = true; return; }
        completed++;
        const acked = c.offset + slice.byteLength;
        if (acked > highestAcked) highestAcked = acked;
        report(highestAcked, c.eof);
      }
    }

    const workers = Array.from({ length: Math.min(windowSize, chunks.length) }, () => worker());
    await Promise.all(workers);
    if (failed) return { ok: false, error: failed };
    if (paused) return { ok: false, error: "Transfer paused by peer" };
    if (input.signal?.aborted) return { ok: false, error: "Aborted" };
    sent = totalBytes;
  }

  const complete = createEnvelope({
    type: "transfer_complete",
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    payload: { transferId: input.transferId, totalBytes },
  });
  await sendEnvelope(input.endpoint, complete, {
    sessionToken: input.sessionToken,
    signal: input.signal,
    sealSecret: input.sealSecret,
  });

  // Checksums: skip for large streaming files to avoid OOM (integrity optional)
  const checksums: string[] = [];
  for (let i = 0; i < input.files.length; i++) {
    const f = input.files[i]!;
    if (f.checksum) { checksums.push(f.checksum); continue; }
    if (f.bytes) {
      // For small in-memory files, compute
      if (f.bytes.byteLength > 10 * 1024 * 1024) checksums.push("");
      else checksums.push(await checksumBytes(f.bytes));
    } else if (input.readFileSlice) {
      // Large streaming file: skip checksum to avoid reading whole file again (would be 300MB re-read)
      checksums.push("");
    } else {
      checksums.push("");
    }
  }
  return { ok: true, checksums };
}

/** Encode text as UTF-8 bytes for wire transfer demos / clipboard-sized payloads. */
export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function randomBytesOfSize(size: number): Uint8Array {
  const out = new Uint8Array(size);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const max = 65536;
    for (let offset = 0; offset < size; offset += max) {
      globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(size, offset + max)));
    }
  } else {
    for (let i = 0; i < size; i++) out[i] = (i * 31 + 17) & 0xff;
  }
  return out;
}

export { bytesToHex };
