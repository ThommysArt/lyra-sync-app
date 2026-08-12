/**
 * Multi-chunk file transfer over HTTP — v4 binary data plane.
 * Control plane: JSON envelopes (offer/accept/complete) via /lyra/message (sealed)
 * Data plane: raw octet-stream POST /lyra/transfer/:id/chunk?offset=&eof= (binary)
 */
import type { TransferFile } from "@lyra-sync-app/protocol";

import { createEnvelope } from "./envelope";
import { sendEnvelope, type PeerUrl, peerBaseUrl } from "./peer-client";
import { getHttpTransport } from "./http-transport";
import { checksumBytes } from "./integrity";
import { bytesToHex } from "./crypto-util";
import { BINARY_CHUNK_HEADER_EOF, BINARY_CHUNK_HEADER_OFFSET, binaryChunkPath } from "./transfer/binaryProtocol";

export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB
export const MIN_CHUNK_SIZE = 256 * 1024;
export const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
export const DEFAULT_WINDOW_SIZE = 8;

function hasSubtleSync(): boolean {
  try {
    return typeof globalThis.crypto?.subtle?.importKey === "function";
  } catch { return false; }
}

function isReactNative(): boolean {
  try {
    const g = globalThis as unknown as { navigator?: { product?: string; userAgent?: string }; Platform?: { OS?: string } };
    if (g.navigator?.product === "ReactNative") return true;
    if (typeof g.navigator?.userAgent === "string" && /Android|iPhone|iPad|ReactNative/i.test(g.navigator.userAgent)) return true;
    // Expo / RN global
    if ((globalThis as unknown as { expo?: unknown }).expo) return true;
    if (typeof (globalThis as unknown as { Platform?: { OS?: string } }).Platform?.OS === "string") {
      const os = (globalThis as unknown as { Platform: { OS: string } }).Platform.OS;
      if (os === "android" || os === "ios") return true;
    }
  } catch {}
  return false;
}

function isMobileLowRam(): boolean {
  // React Native bridge is sensitive to large bridge payloads; patch later to use smaller chunks
  if (isReactNative()) return true;
  const ram = estimateAvailableRam();
  if (ram !== undefined && ram < 1024 * 1024 * 1024) return true;
  return false;
}
// Keep helper referenced to avoid unused error (used via adaptiveWindowSize branching)
void isMobileLowRam;
export function adaptiveChunkSize(opts: {
  totalBytes: number;
  availableRamHint?: number;
  rttMsHint?: number;
  preferred?: number;
}): number {
  if (opts.preferred && opts.preferred >= MIN_CHUNK_SIZE && opts.preferred <= MAX_CHUNK_SIZE) {
    return opts.preferred;
  }
  // Mobile / RN: keep bridge payloads small to avoid TransactionTooLarge and JS heap OOM
  if (isReactNative()) {
    if (opts.availableRamHint && opts.availableRamHint < 400 * 1024 * 1024) return 256 * 1024;
    if (opts.rttMsHint && opts.rttMsHint > 120) return 256 * 1024;
    if (opts.totalBytes >= 50 * 1024 * 1024) return 512 * 1024;
    return 512 * 1024;
  }
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

export function adaptiveWindowSize(_opts: { totalBytes?: number; chunkSize?: number }): number {
  if (isReactNative()) {
    // v2: 4 concurrent chunks × 512 KiB = 2 MiB in-flight; at 30 ms RTT → 66 MB/s theoretical,
    // comfortably above 3 MB/s SLA even on congested Wi-Fi. Previously 3 was too conservative.
    return 4;
  }
  return hasSubtleSync() ? 8 : 4;
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
  readFileSlice?: (fileIndex: number, offset: number, length: number) => Promise<Uint8Array>;
  onProgress?: (p: WireTransferProgress) => void;
  signal?: AbortSignal;
  sealSecret?: string;
};

async function postBinaryChunk(input: {
  endpoint: PeerUrl;
  sessionToken: string;
  transferId: string;
  offset: number;
  data: Uint8Array;
  eof: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: true; receivedBytes: number } | { ok: false; error: string; paused?: boolean; notFound?: boolean }> {
  const base = peerBaseUrl(input.endpoint);
  const path = `${binaryChunkPath(input.transferId)}?offset=${input.offset}&eof=${input.eof ? "1" : "0"}`;
  const url = `${base}${path}`;
  const http = getHttpTransport();
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.sessionToken}`,
    "content-type": "application/octet-stream",
    [BINARY_CHUNK_HEADER_OFFSET]: String(input.offset),
    [BINARY_CHUNK_HEADER_EOF]: input.eof ? "1" : "0",
  };
  // Adaptive timeout: 5s + chunkSize/ (128KB/s min) => ~13s for 1MiB on slow
  const timeoutMs = input.timeoutMs ?? Math.max(5000, Math.min(30000, Math.ceil(input.data.byteLength / (128 * 1024) * 1000) + 5000));
  try {
    const res = await http(url, {
      method: "POST",
      headers,
      body: input.data,
      signal: input.signal,
      timeoutMs,
      lane: 1,
    });
    const text = await res.text();
    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      let notFound = false;
      try {
        const j = JSON.parse(text);
        if (j.error) err = j.error;
        if (j.paused) return { ok: false, error: "Transfer paused by peer", paused: true };
        if (/not found|unknown transfer/i.test(j.error ?? "")) notFound = true;
      } catch {}
      if (res.status === 404) notFound = true;
      return { ok: false, error: err, notFound };
    }
    let received = input.offset + input.data.byteLength;
    try {
      const j = JSON.parse(text);
      if (typeof j.receivedBytes === "number") received = j.receivedBytes;
      if (j.paused) return { ok: false, error: "Transfer paused by peer", paused: true };
    } catch {}
    return { ok: true, receivedBytes: received };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/paused/i.test(msg)) return { ok: false, error: msg, paused: true };
    // Network-level failure is not notFound, but we mark it for retry
    const notFound = /not found|unknown transfer/i.test(msg);
    return { ok: false, error: msg, notFound };
  }
}

async function postLegacyChunk(input: {
  endpoint: PeerUrl;
  sessionToken: string;
  fromDeviceId: string;
  toDeviceId: string;
  transferId: string;
  fileIndex: number;
  offset: number;
  data: Uint8Array;
  eof: boolean;
  checksum?: string;
  sealSecret?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; error: string; paused?: boolean }> {
  const envelope = createEnvelope({
    type: "transfer_chunk",
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    payload: {
      transferId: input.transferId,
      fileIndex: input.fileIndex,
      offset: input.offset,
      dataBase64: bytesToBase64(input.data),
      eof: input.eof,
      checksum: input.checksum,
    },
  });
  const res = await sendEnvelope(input.endpoint, envelope, {
    sessionToken: input.sessionToken,
    signal: input.signal,
    sealSecret: input.sealSecret,
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.envelope?.type === "transfer_pause") return { ok: false, error: "Transfer paused by peer", paused: true };
  return { ok: true };
}

/**
 * Offer + stream file bytes as binary chunks; pipelined with retries and backpressure.
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
  const defaultWindow = adaptiveWindowSize({ totalBytes, chunkSize });
  const windowSize = Math.max(1, Math.min(16, input.windowSize ?? defaultWindow));
  console.info(`[lyra transfer] start ${input.transferId.slice(0,8)} total=${(totalBytes/1024/1024).toFixed(1)}MB chunk=${(chunkSize/1024).toFixed(0)}KB window=${windowSize} mobile=${isReactNative()} resume=${resumeOffset}`);

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
  // Server may return corrected resumeOffset
  const serverResume = (offerRes.envelope?.payload as { resumeOffset?: number } | undefined)?.resumeOffset;
  const effectiveResume = typeof serverResume === "number" ? Math.min(totalBytes, Math.max(0, serverResume)) : resumeOffset;

  const fileSizes = input.files.map((f) => f.size || f.bytes?.byteLength || 0);
  let sessionCursor = 0;
  const fileStarts: number[] = [];
  for (const s of fileSizes) {
    fileStarts.push(sessionCursor);
    sessionCursor += s;
  }

  const getSlice = async (fileIndex: number, localOffset: number, len: number): Promise<Uint8Array> => {
    if (input.readFileSlice) {
      return input.readFileSlice(fileIndex, localOffset, len);
    }
    const file = input.files[fileIndex]!;
    if (!file.bytes) throw new Error(`Missing bytes for file ${file.name} and no readFileSlice`);
    return file.bytes.subarray(localOffset, Math.min(file.bytes.byteLength, localOffset + len));
  };

  let sentContiguous = effectiveResume;
  const startedAt = Date.now();
  let lastReport = startedAt;

  const report = (nowAcked: number, isEof: boolean) => {
    const now = Date.now();
    if (now - lastReport > 80 || isEof) {
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      const progressed = Math.max(0, nowAcked - effectiveResume);
      const currentSpeedBps = progressed / elapsed;
      const remaining = totalBytes - nowAcked;
      const etaSeconds = currentSpeedBps > 0 ? remaining / currentSpeedBps : 0;
      input.onProgress?.({ transferredBytes: nowAcked, totalBytes, currentSpeedBps, etaSeconds });
      lastReport = now;
    }
  };

  let binaryFallback = false;
  if (windowSize <= 1) {
    let offset = effectiveResume;
    while (offset < totalBytes) {
      if (input.signal?.aborted) return { ok: false, error: "Aborted" };
      let fileIndex = 0;
      for (let i = 0; i < fileStarts.length; i++) {
        const start = fileStarts[i]!;
        const end = start + fileSizes[i]!;
        if (offset < end) { fileIndex = i; break; }
        fileIndex = i;
      }
      const fileStart = fileStarts[fileIndex]!;
      const localOffset = offset - fileStart;
      const remainingInFile = fileSizes[fileIndex]! - localOffset;
      const want = Math.min(chunkSize, remainingInFile);
      let slice: Uint8Array;
      try {
        slice = await getSlice(fileIndex, localOffset, want);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      const nextOffset = offset + slice.byteLength;
      const eof = nextOffset >= totalBytes;
      let attempt = 0;
      let chunkOk = false;
      let lastErr = "";
      while (attempt < 3) {
        if (input.signal?.aborted) return { ok: false, error: "Aborted" };
        if (binaryFallback) {
          const legacyRes = await postLegacyChunk({
            endpoint: input.endpoint,
            sessionToken: input.sessionToken,
            fromDeviceId: input.fromDeviceId,
            toDeviceId: input.toDeviceId,
            transferId: input.transferId,
            fileIndex,
            offset,
            data: slice,
            eof,
            checksum: eof ? input.files[fileIndex]?.checksum : undefined,
            sealSecret: input.sealSecret,
            signal: input.signal,
          });
          if (legacyRes.ok) {
            offset = nextOffset;
            chunkOk = true;
            break;
          }
          if (legacyRes.paused) return { ok: false, error: "Transfer paused by peer" };
          lastErr = legacyRes.error;
          attempt++;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }
        const res = await postBinaryChunk({
          endpoint: input.endpoint,
          sessionToken: input.sessionToken,
          transferId: input.transferId,
          offset,
          data: slice,
          eof,
          signal: input.signal,
        });
        if (res.ok) {
          offset = res.receivedBytes;
          if (offset < nextOffset) offset = nextOffset;
          chunkOk = true;
          break;
        }
        if (res.paused) return { ok: false, error: "Transfer paused by peer" };
        if (res.notFound) {
          console.warn(`[lyra transfer] binary chunk not found for ${input.transferId.slice(0,8)} at offset ${offset} — falling back to legacy base64`);
          binaryFallback = true;
          // retry as legacy without consuming attempt
          continue;
        }
        lastErr = res.error;
        attempt++;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
      if (!chunkOk) return { ok: false, error: lastErr || "Chunk failed" };
      sentContiguous = offset;
      report(sentContiguous, eof);
    }
  } else {
    type ChunkDesc = { offset: number; fileIndex: number; localOffset: number; len: number; eof: boolean };
    const chunks: ChunkDesc[] = [];
    for (let off = effectiveResume; off < totalBytes; ) {
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
      if (chunks.length > 500_000) break; // safety for unlimited size, but 4MiB chunks -> 2.5M for 10TiB still huge, but we cap
    }

    let failed: string | null = null;
    let paused = false;
    let nextIdx = 0;
    let ackedContiguous = effectiveResume;
    const ackedSet = new Set<number>(); // offsets that have been acked
    const pendingAcks = new Map<number, number>(); // offset -> end

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
        let attempt = 0;
        let success = false;
        while (attempt < 3) {
          if (failed || paused) return;
          if (input.signal?.aborted) { failed = "Aborted"; return; }
          if (binaryFallback) {
            const legacyRes = await postLegacyChunk({
              endpoint: input.endpoint,
              sessionToken: input.sessionToken,
              fromDeviceId: input.fromDeviceId,
              toDeviceId: input.toDeviceId,
              transferId: input.transferId,
              fileIndex: c.fileIndex,
              offset: c.offset,
              data: slice,
              eof: c.eof,
              checksum: c.eof ? input.files[c.fileIndex]?.checksum : undefined,
              sealSecret: input.sealSecret,
              signal: input.signal,
            });
            if (legacyRes.ok) {
              pendingAcks.set(c.offset, c.offset + slice.byteLength);
              ackedSet.add(c.offset);
              while (ackedSet.has(ackedContiguous)) {
                const end = pendingAcks.get(ackedContiguous);
                if (end === undefined) break;
                ackedContiguous = end;
              }
              report(ackedContiguous, c.eof);
              success = true;
              break;
            }
            if (legacyRes.paused) { paused = true; return; }
            attempt++;
            if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
            else failed = legacyRes.error;
            continue;
          }
          const res = await postBinaryChunk({
            endpoint: input.endpoint,
            sessionToken: input.sessionToken,
            transferId: input.transferId,
            offset: c.offset,
            data: slice,
            eof: c.eof,
            signal: input.signal,
          });
          if (res.ok) {
            pendingAcks.set(c.offset, c.offset + slice.byteLength);
            ackedSet.add(c.offset);
            while (ackedSet.has(ackedContiguous)) {
              const end = pendingAcks.get(ackedContiguous);
              if (end === undefined) break;
              ackedContiguous = end;
            }
            report(ackedContiguous, c.eof);
            success = true;
            break;
          }
          if (res.paused) { paused = true; return; }
          if (res.notFound) {
            if (!binaryFallback) console.warn(`[lyra transfer] binary not supported for ${input.transferId.slice(0,8)} — falling back to legacy`);
            binaryFallback = true;
            continue;
          }
          attempt++;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
          else failed = res.error;
        }
        if (!success && !failed) failed = "Chunk failed after retries";
        if (failed) return;
      }
    }

    const workers = Array.from({ length: Math.min(windowSize, chunks.length) }, () => worker());
    await Promise.all(workers);
    if (failed) return { ok: false, error: failed };
    if (paused) return { ok: false, error: "Transfer paused by peer" };
    if (input.signal?.aborted) return { ok: false, error: "Aborted" };
    sentContiguous = ackedContiguous;
  }

  const complete = createEnvelope({
    type: "transfer_complete",
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    payload: { transferId: input.transferId, totalBytes },
  });
  const completeRes = await sendEnvelope(input.endpoint, complete, {
    sessionToken: input.sessionToken,
    signal: input.signal,
    sealSecret: input.sealSecret,
  });
  if (!completeRes.ok) {
    if (completeRes.error) {
      return { ok: false, error: completeRes.error };
    }
  } else if (completeRes.envelope && completeRes.envelope.payload && typeof completeRes.envelope.payload === "object" && "ok" in (completeRes.envelope.payload as Record<string, unknown>)) {
    const payload = completeRes.envelope.payload as { ok?: boolean; error?: string };
    if (payload.ok === false) {
      return { ok: false, error: payload.error ?? "Integrity check failed" };
    }
  }

  const checksums: string[] = [];
  for (let i = 0; i < input.files.length; i++) {
    const f = input.files[i]!;
    if (f.checksum) { checksums.push(f.checksum); continue; }
    if (f.bytes) {
      if (f.bytes.byteLength > 10 * 1024 * 1024) checksums.push("");
      else checksums.push(await checksumBytes(f.bytes));
    } else if (input.readFileSlice) {
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
