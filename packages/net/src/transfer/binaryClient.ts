/**
 * Binary chunk sender — v4 data plane.
 * Sends raw bytes via POST /lyra/transfer/:id/chunk with single pooled fetch.
 */
import { peerBaseUrl, type PeerUrl } from "../peer-client";
import { BINARY_CHUNK_HEADER_EOF, BINARY_CHUNK_HEADER_OFFSET, binaryChunkPath } from "./binaryProtocol";

export type BinarySendProgress = {
  transferredBytes: number;
  totalBytes: number;
  currentSpeedBps: number;
  etaSeconds: number;
};

export async function postBinaryChunk(input: {
  endpoint: PeerUrl;
  sessionToken: string;
  transferId: string;
  offset: number;
  data: Uint8Array;
  eof: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: true; receivedBytes: number } | { ok: false; error: string }> {
  const base = peerBaseUrl(input.endpoint);
  const path = `${binaryChunkPath(input.transferId)}?offset=${input.offset}&eof=${input.eof ? "1" : "0"}`;
  const url = `${base}${path}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.sessionToken}`,
    "content-type": "application/octet-stream",
    [BINARY_CHUNK_HEADER_OFFSET]: String(input.offset),
    [BINARY_CHUNK_HEADER_EOF]: input.eof ? "1" : "0",
    "content-length": String(input.data.byteLength),
  };
  // getHttpTransport expects body as string, but for binary we need to extend to support Uint8Array
  // We will use fetch directly for binary to avoid base64 overhead and allow binary body.
  // Try transport with binary body via custom path: if transport supports binary, it will handle.
  // For now we bypass transport and use native fetch with binary body for Node
  try {
    // Use fetch directly - supports binary body
    const controller = input.timeoutMs ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (controller && input.timeoutMs) {
      if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (input.signal) input.signal.addEventListener("abort", () => controller.abort(), { once: true });
      timer = setTimeout(() => controller.abort(), input.timeoutMs);
    }
    const signal = controller?.signal ?? input.signal;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: input.data as unknown as BodyInit,
      signal,
      // @ts-ignore keepalive for Node undici
      keepalive: true,
    });
    if (timer) clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j.error) err = j.error;
      } catch {}
      return { ok: false, error: err };
    }
    let received = input.offset + input.data.byteLength;
    try {
      const j = JSON.parse(text);
      if (typeof j.receivedBytes === "number") received = j.receivedBytes;
    } catch {}
    return { ok: true, receivedBytes: received };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function getBinaryChunk(input: {
  endpoint: PeerUrl;
  sessionToken: string;
  transferId: string;
  offset: number;
  length: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: true; data: Uint8Array; eof: boolean } | { ok: false; error: string }> {
  const base = peerBaseUrl(input.endpoint);
  const path = `${binaryChunkPath(input.transferId)}?offset=${input.offset}&length=${input.length}`;
  const url = `${base}${path}`;
  try {
    const controller = input.timeoutMs ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (controller && input.timeoutMs) {
      if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (input.signal) input.signal.addEventListener("abort", () => controller.abort(), { once: true });
      timer = setTimeout(() => controller.abort(), input.timeoutMs);
    }
    const signal = controller?.signal ?? input.signal;
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${input.sessionToken}` },
      signal,
    });
    if (timer) clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text();
      let err = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j.error) err = j.error;
      } catch {}
      return { ok: false, error: err };
    }
    const eofHeader = res.headers.get(BINARY_CHUNK_HEADER_EOF) ?? res.headers.get(BINARY_CHUNK_HEADER_EOF.toLowerCase());
    const eof = eofHeader === "1" || eofHeader === "true";
    const buf = await res.arrayBuffer();
    return { ok: true, data: new Uint8Array(buf), eof };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
