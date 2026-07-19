/**
 * App-level payload encryption (AES-GCM) using a pairing-derived shared secret.
 * Used when TLS is not available (plain HTTP peer servers on LAN).
 */
import { bytesToHex, hexToBytes, randomHex, sha256Hex } from "./crypto-util";

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

/** Sealed blob: `v1.<ivHex>.<cipherHex>` */
export async function sealJson(
  sharedSecret: string,
  value: unknown,
): Promise<string> {
  const plaintext = textEncoder.encode(JSON.stringify(value));
  if (!hasSubtle()) {
    // Deterministic fallback for test envs without SubtleCrypto (not secure)
    const mac = await sha256Hex(`fallback-seal:${sharedSecret}:${bytesToHex(plaintext)}`);
    return `v0.${mac}.${bytesToHex(plaintext)}`;
  }
  const key = await deriveAesKey(sharedSecret);
  const iv = hexToBytes(randomHex(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return `v1.${bytesToHex(iv)}.${bytesToHex(new Uint8Array(cipher))}`;
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

  if (version !== "v1" || !hasSubtle()) {
    throw new Error("Cannot open sealed payload in this environment");
  }

  const key = await deriveAesKey(sharedSecret);
  const iv = hexToBytes(a);
  const cipher = hexToBytes(b);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    cipher as BufferSource,
  );
  return JSON.parse(textDecoder.decode(new Uint8Array(plain)));
}

export function isSealedString(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("v1.") || value.startsWith("v0."));
}
