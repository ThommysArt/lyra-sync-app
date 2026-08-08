// @ts-nocheck
/**
 * Lyra persistent TCP framing.
 * No HTTP. Every TCP stream is a sequence of frames:
 *   [4 bytes BE payload_len][1 byte type][payload]
 * payload_len includes the type byte.
 *
 * Type 0x01 = JSON (utf8 JSON string)
 * Type 0x02 = BINARY_CHUNK (4 bytes header_len BE + header_json utf8 + raw bytes)
 */

export const FRAME_JSON = 0x01 as const;
export const FRAME_BINARY = 0x02 as const;

export type FrameType = typeof FRAME_JSON | typeof FRAME_BINARY;

/** Max JSON frame (sealed envelope, hello, etc.) - 2 MiB */
export const MAX_JSON_FRAME_BYTES = 2 * 1024 * 1024;
/** Max binary chunk frame - 4 MiB payload + header */
export const MAX_BINARY_FRAME_BYTES = 4 * 1024 * 1024 + 64 * 1024;
/** Max total frame incl header */
export const MAX_FRAME_BYTES = MAX_BINARY_FRAME_BYTES + 16;

export type DecodedJsonFrame = { type: typeof FRAME_JSON; payload: unknown };
export type DecodedBinaryFrame = {
  type: typeof FRAME_BINARY;
  header: { transferId: string; offset: number; eof: boolean };
  data: Uint8Array;
};
export type DecodedFrame = DecodedJsonFrame | DecodedBinaryFrame;

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function encodeJsonFrame(obj: unknown): Uint8Array {
  const json = JSON.stringify(obj);
  const body = utf8Encode(json);
  if (body.byteLength + 1 > MAX_JSON_FRAME_BYTES) {
    throw new Error(`JSON frame too large: ${body.byteLength} bytes`);
  }
  const payloadLen = 1 + body.byteLength;
  const out = new Uint8Array(4 + payloadLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, payloadLen, false); // BE
  out[4] = FRAME_JSON;
  out.set(body, 5);
  return out;
}

export function encodeBinaryChunkFrame(
  header: { transferId: string; offset: number; eof: boolean },
  data: Uint8Array,
): Uint8Array {
  if (data.byteLength > MAX_BINARY_FRAME_BYTES) {
    throw new Error(`Binary chunk too large: ${data.byteLength}`);
  }
  const headerJson = JSON.stringify(header);
  const headerBytes = utf8Encode(headerJson);
  const headerLen = headerBytes.byteLength;
  // payload = type(1) + headerLen(4) + headerBytes + data
  const payloadLen = 1 + 4 + headerLen + data.byteLength;
  if (payloadLen > MAX_FRAME_BYTES) throw new Error("Frame too large");
  const out = new Uint8Array(4 + payloadLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, payloadLen, false);
  out[4] = FRAME_BINARY;
  view.setUint32(5, headerLen, false);
  out.set(headerBytes, 9);
  out.set(data, 9 + headerLen);
  return out;
}

/** Incremental decoder — handles TCP segmentation and coalescing */
export class FrameDecoder {
  private buf = new Uint8Array(32 * 1024);
  private len = 0;
  private cap = this.buf.byteLength;

  private ensureCap(needed: number) {
    if (needed <= this.cap) return;
    let newCap = Math.max(this.cap * 2, needed);
    newCap = Math.min(newCap, MAX_FRAME_BYTES + 65536);
    if (newCap < needed) newCap = needed;
    const nb = new Uint8Array(newCap);
    nb.set(this.buf.subarray(0, this.len), 0);
    this.buf = nb;
    this.cap = newCap;
  }

  /** Push new bytes, return any complete frames decoded */
  push(chunk: Uint8Array): DecodedFrame[] {
    const out: DecodedFrame[] = [];
    // append
    if (chunk.byteLength > 0) {
      this.ensureCap(this.len + chunk.byteLength);
      this.buf.set(chunk, this.len);
      this.len += chunk.byteLength;
    }

    while (true) {
      if (this.len < 4) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.len);
      const payloadLen = view.getUint32(0, false);
      if (payloadLen < 1 || payloadLen > MAX_FRAME_BYTES) {
        throw new Error(`Invalid frame length: ${payloadLen}`);
      }
      const total = 4 + payloadLen;
      if (this.len < total) break; // need more

      const type = this.buf[4] as FrameType;
      if (type === FRAME_JSON) {
        const body = this.buf.subarray(5, total);
        const json = JSON.parse(utf8Decode(body));
        out.push({ type: FRAME_JSON, payload: json });
      } else if (type === FRAME_BINARY) {
        if (payloadLen < 1 + 4) throw new Error("Binary frame too short");
        const headerLen = new DataView(this.buf.buffer, this.buf.byteOffset + 5, 4).getUint32(0, false);
        if (headerLen > MAX_JSON_FRAME_BYTES) throw new Error("Binary header too large");
        const headerStart = 9;
        const headerEnd = headerStart + headerLen;
        if (payloadLen < 1 + 4 + headerLen) throw new Error("Binary header truncated");
        const headerBytes = this.buf.subarray(headerStart, headerEnd);
        const header = JSON.parse(utf8Decode(headerBytes)) as {
          transferId: string;
          offset: number;
          eof: boolean;
        };
        if (
          typeof header.transferId !== "string" ||
          typeof header.offset !== "number" ||
          typeof header.eof !== "boolean"
        ) {
          throw new Error("Invalid binary chunk header");
        }
        const dataStart = headerEnd;
        const data = this.buf.subarray(dataStart, total);
        // copy data out so next buffer compact doesn't alias it
        const dataCopy = new Uint8Array(data.byteLength);
        dataCopy.set(data, 0);
        out.push({ type: FRAME_BINARY, header, data: dataCopy });
      } else {
        throw new Error(`Unknown frame type: 0x${type.toString(16)}`);
      }

      // compact: move remaining to front
      const remaining = this.len - total;
      if (remaining > 0) {
        this.buf.copyWithin(0, total, this.len);
      }
      this.len = remaining;
    }

    return out;
  }

  /** How many bytes currently buffered (for diagnostics) */
  bufferedBytes(): number {
    return this.len;
  }
  reset() {
    this.len = 0;
  }
}
