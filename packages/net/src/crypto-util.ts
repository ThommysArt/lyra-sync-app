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

import { sha256HexJs } from "./sha256-js";

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    try {
      const hash = await globalThis.crypto.subtle.digest(
        "SHA-256",
        data as BufferSource,
      );
      return bytesToHex(new Uint8Array(hash));
    } catch {
      // fall through to JS
    }
  }
  // Pure JS fallback — correct SHA-256 for RN / environments without WebCrypto
  return sha256HexJs(data);
}
