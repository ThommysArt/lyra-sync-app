/**
 * Shared HTTP/1.1 codec for React Native TCP client + server.
 * Extracted from duplicated parsers in
 *   apps/native/lib/peer-server.native.ts:115-235
 *   apps/native/lib/tcp-http-client.ts:86-110
 *
 * Single source of truth for header search, concat, request/response building
 * and incremental parsing. Byte-safe (UTF-8 multi-byte handled via Uint8Array).
 */

/** Locate \r\n\r\n, returns offset of first \r or -1. */
export function indexOfHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i < buf.byteLength - 3; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export function toUint8Array(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof data === "object" && ArrayBuffer.isView(data as ArrayBufferView)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (data && typeof data === "object" && "length" in (data as object)) {
    try {
      return Uint8Array.from(data as ArrayLike<number>);
    } catch {
      // fall through
    }
  }
  return new TextEncoder().encode(String(data ?? ""));
}

export type ParsedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  consumed: number;
};

export type ParsedResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  consumed: number;
};

/**
 * Parse one HTTP request from raw bytes. Returns null if incomplete.
 * When Content-Length exceeds `maxBodyBytes`, consumed = -1 signals
 * caller to reject with 413.
 */
export function parseHttpRequestBytes(
  raw: Uint8Array,
  maxBodyBytes: number = Number.POSITIVE_INFINITY,
): ParsedRequest | null {
  const headerEnd = indexOfHeaderEnd(raw);
  if (headerEnd < 0) {
    if (raw.byteLength > 64 * 1024) return null;
    return null;
  }
  const head = new TextDecoder().decode(raw.subarray(0, headerEnd));
  const lines = head.split("\r\n");
  const requestLine = lines[0];
  if (!requestLine) return null;
  const parts = requestLine.split(" ");
  const method = parts[0] ?? "GET";
  const path = parts[1] ?? "/";
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon > 0) {
      const k = line.slice(0, colon).trim().toLowerCase();
      const v = line.slice(colon + 1).trim();
      headers[k] = v;
    }
  }
  const clRaw = headers["content-length"];
  const contentLength = clRaw ? Number.parseInt(clRaw, 10) : Number.NaN;
  const bodyStart = headerEnd + 4;
  const expectsBody = method.toUpperCase() === "POST" || method.toUpperCase() === "PUT" || method.toUpperCase() === "PATCH";

  if (Number.isFinite(contentLength) && contentLength >= 0) {
    if (contentLength > maxBodyBytes) {
      return { method, path, headers, body: "", consumed: -1 };
    }
    if (raw.byteLength < bodyStart + contentLength) return null;
    const bodyBytes = raw.subarray(bodyStart, bodyStart + contentLength);
    return { method, path, headers, body: new TextDecoder().decode(bodyBytes), consumed: bodyStart + contentLength };
  }
  if (!expectsBody) {
    return { method, path, headers, body: "", consumed: bodyStart };
  }
  if (raw.byteLength === bodyStart) return null;
  const bodyBytes = raw.subarray(bodyStart);
  // For POST without CL, treat buffered trailing as body (caller may also handle 'end' fallback)
  if (bodyBytes.byteLength > maxBodyBytes) {
    return { method, path, headers, body: "", consumed: -1 };
  }
  return { method, path, headers, body: new TextDecoder().decode(bodyBytes), consumed: raw.byteLength };
}

export function parseHttpResponseBytes(raw: Uint8Array): ParsedResponse | null {
  const headerEnd = indexOfHeaderEnd(raw);
  if (headerEnd < 0) {
    if (raw.byteLength > 256 * 1024) return null;
    return null;
  }
  const head = new TextDecoder().decode(raw.subarray(0, headerEnd));
  const lines = head.split("\r\n");
  const statusMatch = /^HTTP\/\d\.\d\s+(\d+)/.exec(lines[0] ?? "");
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  const cl = Number.parseInt(headers["content-length"] ?? "", 10);
  const bodyStart = headerEnd + 4;
  if (Number.isFinite(cl) && cl >= 0) {
    if (raw.byteLength < bodyStart + cl) return null;
    const bodyBytes = raw.subarray(bodyStart, bodyStart + cl);
    return { status, headers, body: new TextDecoder().decode(bodyBytes), consumed: bodyStart + cl };
  }
  // No CL — caller should buffer until 'close' then return trailing bytes
  return null;
}

export function buildHttpRequest(opts: {
  method: string;
  path: string;
  host: string;
  port: number;
  headers?: Record<string, string>;
  body?: string;
}): string {
  const headers: Record<string, string> = {
    accept: "application/json",
    connection: "close",
    ...opts.headers,
  };
  if (opts.body && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }
  if (opts.body) {
    headers["content-length"] = String(new TextEncoder().encode(opts.body).byteLength);
  }
  const lines = [`${opts.method.toUpperCase()} ${opts.path} HTTP/1.1`, `Host: ${opts.host}:${opts.port}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push("", opts.body ?? "");
  return lines.join("\r\n");
}

export function statusLine(status: number): string {
  const map: Record<number, string> = { 200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 500: "Internal Server Error" };
  return map[status] ?? "OK";
}

export function buildHttpResponse(status: number, headers: Record<string, string> | undefined, body: string): string {
  const h = { ...(headers ?? {}) };
  const bodyBytes = new TextEncoder().encode(body);
  if (body && !h["content-length"] && !h["Content-Length"]) h["content-length"] = String(bodyBytes.byteLength);
  if (!h["connection"] && !h["Connection"]) h["connection"] = "close";
  const lines = [`HTTP/1.1 ${status} ${statusLine(status)}`];
  for (const [k, v] of Object.entries(h)) lines.push(`${k}: ${v}`);
  lines.push("", body);
  return lines.join("\r\n");
}
