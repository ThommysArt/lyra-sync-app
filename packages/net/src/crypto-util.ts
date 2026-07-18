/** Shared hex / hash helpers (Web Crypto when available). */

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^a-f0-9]/gi, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function randomHex(byteLength: number): string {
  const out = new Uint8Array(byteLength);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < byteLength; i++) {
      out[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(out);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const hash = await globalThis.crypto.subtle.digest(
      "SHA-256",
      data as BufferSource,
    );
    return bytesToHex(new Uint8Array(hash));
  }
  // Deterministic non-crypto fallback for environments without SubtleCrypto
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h1 = Math.imul(h1 ^ data[i]!, 0x01000193);
    h2 = Math.imul(h2 ^ data[data.length - 1 - i]!, 0x01000193);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  const c = data.length.toString(16).padStart(8, "0");
  return `${a}${b}${c}${a}${b}${c}${a}${b}`.slice(0, 64);
}
