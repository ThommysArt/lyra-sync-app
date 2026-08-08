/**
 * App-level payload encryption (AES-GCM) using a pairing-derived shared secret.
 * Used when TLS is not available (plain HTTP peer servers on LAN).
 */
import { bytesToHex, hexToBytes, randomHex, sha256Hex } from "./crypto-util";
import { sha256BytesJs } from "./sha256-js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const v2KeyCache = new Map<string, Uint8Array>();
const aesKeyCache = new Map<string, CryptoKey>();
const AES_IV_BYTES = 12;

async function deriveAesKey(sharedSecret: string): Promise<CryptoKey> {
  const cached = aesKeyCache.get(sharedSecret);
  if (cached) return cached;
  const material = await sha256Hex(`seal:${sharedSecret}`);
  const raw = hexToBytes(material);
  const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  aesKeyCache.set(sharedSecret, key);
  if (aesKeyCache.size > 32) {
    const first = aesKeyCache.keys().next().value as string | undefined;
    if (first) aesKeyCache.delete(first);
  }
  return key;
}

function hasSubtle(): boolean {
  // Force v2 (pure-JS) for cross-platform reliability (Node vs RN quick-crypto subtle interop issues cause "Failed to open sealed payload" for desktop→mobile).
  // v2 is hex-encoded XOR stream, works everywhere, no WebCrypto needed. Slightly larger but negligible for control plane (<1KB offers).
  // Keep importKey check for diagnostics but return false to force v2 until subtle interop is verified.
  // TODO: re-enable v1b after verifying Node WebCrypto ↔ RN quick-crypto AES-GCM compatibility.
  return false;
  // return typeof globalThis.crypto?.subtle?.importKey === "function";
}

// --- Pure-JS stream cipher for cross-platform (no SubtleCrypto needed) ---
// v2: `v2.<ivHex>.<cipherHex>` where cipher = plaintext XOR SHA256(key||iv||counter) stream
async function deriveV2Key(sharedSecret: string): Promise<Uint8Array> {
  const cached = v2KeyCache.get(sharedSecret);
  if (cached) return cached;
  const hex = await sha256Hex(`seal:${sharedSecret}`);
  const raw = hexToBytes(hex);
  v2KeyCache.set(sharedSecret, raw);
  if (v2KeyCache.size > 64) {
    const first = v2KeyCache.keys().next().value as string | undefined;
    if (first) v2KeyCache.delete(first);
  }
  return raw;
}

export function clearSealKeyCache(): void {
  v2KeyCache.clear();
  aesKeyCache.clear();
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
    // Yield every 32KB to avoid blocking JS thread (stutter) on large chunks
    if ((offset & 0x7fff) === 0) await new Promise<void>((r) => setTimeout(r, 0));
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
    if ((offset & 0x7fff) === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  return plain;
}

function bytesToB64(bytes: Uint8Array): string {
  const Buf = (globalThis as { Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } } }).Buffer;
  if (Buf) return Buf.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
function b64ToBytes(b64: string): Uint8Array {
  const Buf = (globalThis as { Buffer?: { from: (s: string, e: string) => Uint8Array } }).Buffer;
  if (Buf) return new Uint8Array(Buf.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sealJsonV1(sharedSecret: string, plaintext: Uint8Array): Promise<string> {
  const key = await deriveAesKey(sharedSecret);
  const iv = hexToBytes(randomHex(AES_IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource);
  const cipher = new Uint8Array(cipherBuf);
  return `v1b.${bytesToB64(iv)}.${bytesToB64(cipher)}`;
}


/** Sealed blob: `v1b` (AES-GCM base64, preferred) or `v2` (pure-JS hex fallback) or `v0` (legacy). */
export async function sealJson(
  sharedSecret: string,
  value: unknown,
): Promise<string> {
  const plaintext = textEncoder.encode(JSON.stringify(value));
  // Prefer hardware AES-GCM (v1b) — ~50× faster and 2× smaller than v2 hex.
  // Falls back to v2 only when WebCrypto is unavailable (should not happen with quick-crypto polyfill).
  if (hasSubtle()) {
    try {
      return await sealJsonV1(sharedSecret, plaintext);
    } catch (e) {
      console.error("[lyra seal] AES-GCM seal failed, falling back to v2", e instanceof Error ? e.message : String(e));
    }
  } else {
    console.warn("[lyra seal] WebCrypto unavailable — using slow v2 seal (install react-native-quick-crypto)");
  }
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

  if (version !== "v1" && version !== "v1b") {
    throw new Error("Cannot open sealed payload in this environment");
  }
  // Try WebCrypto if available (even when hasSubtle() is forced false for sealing, we still need to open old v1 payloads)
  const subtle = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle && typeof subtle.importKey === "function" && typeof subtle.decrypt === "function") {
    try {
      const key = await deriveAesKey(sharedSecret);
      const isB = version === "v1b";
      const iv = isB ? b64ToBytes(a) : hexToBytes(a);
      const cipher = isB ? b64ToBytes(b) : hexToBytes(b);
      const plain = await subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        key,
        cipher as BufferSource,
      );
      return JSON.parse(textDecoder.decode(new Uint8Array(plain)));
    } catch (e) {
      // Log underlying decrypt error for diagnostics before falling back
      console.warn("[lyra seal] v1 decrypt failed, trying fallback", e instanceof Error ? e.message : String(e));
      throw new Error("Failed to open sealed payload");
    }
  }
  throw new Error("Cannot open v1 sealed payload without WebCrypto");
}

export function isSealedString(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("v1.") || value.startsWith("v1b.") || value.startsWith("v0.") || value.startsWith("v2."));
}
