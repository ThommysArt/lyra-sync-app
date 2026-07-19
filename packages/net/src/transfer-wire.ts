/**
 * Multi-chunk file transfer over HTTP envelopes.
 */
import type { TransferFile } from "@lyra-sync-app/protocol";

import { createEnvelope } from "./envelope";
import { sendEnvelope, type PeerUrl } from "./peer-client";
import { checksumBytes } from "./integrity";
import { bytesToHex } from "./crypto-util";

const DEFAULT_CHUNK_SIZE = 48 * 1024; // ~48 KiB base64-friendly

export function bytesToBase64(bytes: Uint8Array): string {
  // Prefer Node Buffer when present (runtime check only)
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
  files: { name: string; size: number; mimeType?: string; bytes: Uint8Array; checksum?: string }[];
  /** Session byte offset already acknowledged (resume) */
  resumeOffset?: number;
  chunkSize?: number;
  onProgress?: (p: WireTransferProgress) => void;
  signal?: AbortSignal;
};

/**
 * Offer + stream file bytes as transfer_chunk messages; waits for transfer_chunk_ack.
 */
export async function sendFilesOverWire(
  input: SendFilesOverWireInput,
): Promise<{ ok: true; checksums: string[] } | { ok: false; error: string }> {
  const totalBytes = input.files.reduce((a, f) => a + f.bytes.byteLength, 0);
  const resumeOffset = Math.min(totalBytes, Math.max(0, input.resumeOffset ?? 0));
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const offerFiles: TransferFile[] = input.files.map((f) => ({
    name: f.name,
    size: f.bytes.byteLength,
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
  });
  if (!offerRes.ok) return { ok: false, error: offerRes.error };

  // Build concatenated view for session-offset addressing
  const parts = input.files.map((f) => f.bytes);
  let sessionCursor = 0;
  const fileStarts: number[] = [];
  for (const p of parts) {
    fileStarts.push(sessionCursor);
    sessionCursor += p.byteLength;
  }

  let sent = resumeOffset;
  const startedAt = Date.now();
  let lastReport = startedAt;

  while (sent < totalBytes) {
    if (input.signal?.aborted) return { ok: false, error: "Aborted" };

    // Locate file index for `sent`
    let fileIndex = 0;
    for (let i = 0; i < fileStarts.length; i++) {
      const start = fileStarts[i]!;
      const end = start + parts[i]!.byteLength;
      if (sent < end) {
        fileIndex = i;
        break;
      }
      fileIndex = i;
    }
    const fileStart = fileStarts[fileIndex]!;
    const fileBytes = parts[fileIndex]!;
    const localOffset = sent - fileStart;
    const slice = fileBytes.subarray(localOffset, Math.min(fileBytes.byteLength, localOffset + chunkSize));
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
    });
    if (!chunkRes.ok) return { ok: false, error: chunkRes.error };

    sent = nextOffset;
    const now = Date.now();
    if (now - lastReport > 80 || eof) {
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      const progressed = Math.max(0, sent - resumeOffset);
      const currentSpeedBps = progressed / elapsed;
      const remaining = totalBytes - sent;
      const etaSeconds = currentSpeedBps > 0 ? remaining / currentSpeedBps : 0;
      input.onProgress?.({
        transferredBytes: sent,
        totalBytes,
        currentSpeedBps,
        etaSeconds,
      });
      lastReport = now;
    }
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
  });

  const checksums: string[] = [];
  for (const f of input.files) {
    checksums.push(f.checksum ?? (await checksumBytes(f.bytes)));
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
    // Fill in chunks for large sizes
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
