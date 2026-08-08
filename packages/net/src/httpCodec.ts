/**
 * Shared HTTP/1.1 codec for React Native TCP client + server.
 */

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
    } catch {}
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

export type ParsedRequestRaw = {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBytes: Uint8Array;
  consumed: number;
};

export function parseHttpRequestRaw(
  raw: Uint8Array,
  maxBodyBytes: number = Number.POSITIVE_INFINITY,
): ParsedRequestRaw | null {
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
      return { method, path, headers, bodyBytes: new Uint8Array(0), consumed: -1 };
    }
    if (raw.byteLength < bodyStart + contentLength) return null;
    const bodyBytes = raw.subarray(bodyStart, bodyStart + contentLength);
    return { method, path, headers, bodyBytes, consumed: bodyStart + contentLength };
  }
  if (!expectsBody) {
    return { method, path, headers, bodyBytes: new Uint8Array(0), consumed: bodyStart };
  }
  if (raw.byteLength === bodyStart) return null;
  const bodyBytes = raw.subarray(bodyStart);
  if (bodyBytes.byteLength > maxBodyBytes) {
    return { method, path, headers, bodyBytes: new Uint8Array(0), consumed: -1 };
  }
  return { method, path, headers, bodyBytes, consumed: raw.byteLength };
}

export function parseHttpRequestBytes(
  raw: Uint8Array,
  maxBodyBytes: number = Number.POSITIVE_INFINITY,
): ParsedRequest | null {
  const rawParsed = parseHttpRequestRaw(raw, maxBodyBytes);
  if (!rawParsed) return null;
  if (rawParsed.consumed < 0) return { method: rawParsed.method, path: rawParsed.path, headers: rawParsed.headers, body: "", consumed: -1 };
  return {
    method: rawParsed.method,
    path: rawParsed.path,
    headers: rawParsed.headers,
    body: new TextDecoder().decode(rawParsed.bodyBytes),
    consumed: rawParsed.consumed,
  };
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
  return null;
}

export function buildHttpRequest(opts: {
  method: string;
  path: string;
  host: string;
  port: number;
  headers?: Record<string, string>;
  body?: string;
  keepAlive?: boolean;
}): string {
  const headers: Record<string, string> = {
    accept: "application/json",
    connection: opts.keepAlive === false ? "close" : "keep-alive",
    ...opts.headers,
  };
  if (opts.keepAlive !== undefined && !headers["connection"] && !headers["Connection"]) {
    headers["connection"] = opts.keepAlive ? "keep-alive" : "close";
  }
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

export function buildHttpRequestBinary(opts: {
  method: string;
  path: string;
  host: string;
  port: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
  keepAlive?: boolean;
}): Uint8Array {
  const headers: Record<string, string> = {
    connection: opts.keepAlive === false ? "close" : "keep-alive",
    ...opts.headers,
  };
  if (opts.body && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/octet-stream";
  }
  if (opts.body) {
    headers["content-length"] = String(opts.body.byteLength);
  }
  const lines = [`${opts.method.toUpperCase()} ${opts.path} HTTP/1.1`, `Host: ${opts.host}:${opts.port}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push("", "");
  const headerBytes = new TextEncoder().encode(lines.join("\r\n"));
  if (!opts.body || opts.body.byteLength === 0) return headerBytes;
  const out = new Uint8Array(headerBytes.byteLength + opts.body.byteLength);
  out.set(headerBytes, 0);
  out.set(opts.body, headerBytes.byteLength);
  return out;
}

export function parseHttpResponseBytesBinary(raw: Uint8Array): { status: number; headers: Record<string, string>; body: Uint8Array; consumed: number } | null {
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
    return { status, headers, body: raw.subarray(bodyStart, bodyStart + cl), consumed: bodyStart + cl };
  }
  return null;
}

export function statusLine(status: number): string {
  const map: Record<number, string> = { 200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 500: "Internal Server Error" };
  return map[status] ?? "OK";
}

export function buildHttpResponse(status: number, headers: Record<string, string> | undefined, body: string): string {
  const h = { ...(headers ?? {}) };
  const bodyBytes = new TextEncoder().encode(body);
  if (body && !h["content-length"] && !h["Content-Length"]) h["content-length"] = String(bodyBytes.byteLength);
  if (!h["connection"] && !h["Connection"]) h["connection"] = "keep-alive";
  const lines = [`HTTP/1.1 ${status} ${statusLine(status)}`];
  for (const [k, v] of Object.entries(h)) lines.push(`${k}: ${v}`);
  lines.push("", body);
  return lines.join("\r\n");
}
