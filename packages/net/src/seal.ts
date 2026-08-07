/**
 * App-level payload encryption (AES-GCM) using a pairing-derived shared secret.
 * Used when TLS is not available (plain HTTP peer servers on LAN).
 */
import { bytesToHex, hexToBytes, randomHex, sha256Hex } from "./crypto-util";
import { sha256BytesJs } from "./sha256-js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function deriveAesKey(sharedSecret: string): Promise<CryptoKey> {
  const material = await sha256Hex(`seal:${sharedSecret}`);
  const raw = hexToBytes(material);
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function hasSubtle(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === "function";
}

// --- Pure-JS stream cipher for cross-platform (no SubtleCrypto needed) ---
// v2: `v2.<ivHex>.<cipherHex>` where cipher = plaintext XOR SHA256(key||iv||counter) stream
async function deriveV2Key(sharedSecret: string): Promise<Uint8Array> {
  // 32-byte key from sha256("seal:<secret>") — same derivation as AES key material
  const hex = await sha256Hex(`seal:${sharedSecret}`);
  return hexToBytes(hex);
}

function u32BE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

async function sealJsonV2(sharedSecret: string, plaintext: Uint8Array): Promise<string> {
  const key = await deriveV2Key(sharedSecret);
  const iv = hexToBytes(randomHex(12));
  const out = new Uint8Array(plaintext.length);
  for (let offset = 0; offset < plaintext.length; offset += 32) {
    const counter = Math.floor(offset / 32);
    const block = sha256BytesJs(concatBytes(key, iv, u32BE(counter)));
    for (let j = 0; j < 32 && offset + j < plaintext.length; j++) {
      out[offset + j] = plaintext[offset + j]! ^ block[j]!;
    }
  }
  return `v2.${bytesToHex(iv)}.${bytesToHex(out)}`;
}

async function openJsonV2(sharedSecret: string, ivHex: string, cipherHex: string): Promise<Uint8Array> {
  const key = await deriveV2Key(sharedSecret);
  const iv = hexToBytes(ivHex);
  const cipher = hexToBytes(cipherHex);
  const plain = new Uint8Array(cipher.length);
  for (let offset = 0; offset < cipher.length; offset += 32) {
    const counter = Math.floor(offset / 32);
    const block = sha256BytesJs(concatBytes(key, iv, u32BE(counter)));
    for (let j = 0; j < 32 && offset + j < cipher.length; j++) {
      plain[offset + j] = cipher[offset + j]! ^ block[j]!;
    }
  }
  return plain;
}

/** Sealed blob: `v1.<ivHex>.<cipherHex>` (AES-GCM) or `v2` (pure-JS) or `v0` (legacy) */
export async function sealJson(
  sharedSecret: string,
  value: unknown,
): Promise<string> {
  const plaintext = textEncoder.encode(JSON.stringify(value));
  // Use pure-JS v2 for cross-platform consistency (works without WebCrypto).
  // v1 (AES-GCM) is still understood for backward compat, but new payloads use v2
  // so mobile (no SubtleCrypto) can interoperate with desktop.
  return sealJsonV2(sharedSecret, plaintext);
}

export async function openSealedJson(
  sharedSecret: string,
  sealed: string,
): Promise<unknown> {
  const parts = sealed.split(".");
  if (parts.length !== 3) throw new Error("Invalid sealed payload");
  const [version, a, b] = parts as [string, string, string];

  if (version === "v0") {
    const plaintext = hexToBytes(b);
    return JSON.parse(textDecoder.decode(plaintext));
  }

  if (version === "v2") {
    const plain = await openJsonV2(sharedSecret, a, b);
    return JSON.parse(textDecoder.decode(plain));
  }

  if (version !== "v1") {
    throw new Error("Cannot open sealed payload in this environment");
  }
  // v1 — try WebCrypto first, then pure-JS fallback for RN that received v1
  if (hasSubtle()) {
    try {
      const key = await deriveAesKey(sharedSecret);
      const iv = hexToBytes(a);
      const cipher = hexToBytes(b);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        key,
        cipher as BufferSource,
      );
      return JSON.parse(textDecoder.decode(new Uint8Array(plain)));
    } catch {
      // fall through to try handling as v2-style? No, v1 cipher is AES-GCM, not XOR
      // If decrypt fails, throw
      throw new Error("Failed to open sealed payload");
    }
  }
  // No subtle but received v1 — cannot decrypt AES-GCM without pure JS AES-GCM.
  // For now, throw with hint; caller may retry with v2.
  throw new Error("Cannot open v1 sealed payload without WebCrypto");
}

export function isSealedString(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("v1.") || value.startsWith("v0.") || value.startsWith("v2."));
}
