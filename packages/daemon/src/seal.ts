import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { LyraSeal } from "@lyra-sync-app/protocol";

function deriveKey(secret: string): Buffer {
  // secret is hex or raw — derive 32-byte key via SHA-256
  return createHash("sha256").update(secret, "utf8").digest();
}

function toBase64(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString("base64");
}

function fromBase64(s: string): Buffer {
  return Buffer.from(s, "base64");
}

async function subtleSeal(keyBytes: Buffer, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const g = globalThis as unknown as { crypto?: { subtle?: { importKey: (...a: unknown[]) => Promise<unknown>; encrypt: (...a: unknown[]) => Promise<ArrayBuffer> } } };
  const subtle = g.crypto?.subtle;
  if (!subtle) throw new Error("subtle unavailable");
  const key = (await (subtle as unknown as { importKey: (...a: unknown[]) => Promise<unknown> }).importKey("raw", keyBytes as unknown as never, { name: "AES-GCM" }, false, ["encrypt"])) as unknown;
  const ct = (await (subtle as unknown as { encrypt: (...a: unknown[]) => Promise<ArrayBuffer> }).encrypt({ name: "AES-GCM", iv: nonce as unknown as never }, key as unknown as never, plaintext as unknown as never)) as ArrayBuffer;
  return new Uint8Array(ct);
}

async function subtleUnseal(keyBytes: Buffer, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const g = globalThis as unknown as { crypto?: { subtle?: { importKey: (...a: unknown[]) => Promise<unknown>; decrypt: (...a: unknown[]) => Promise<ArrayBuffer> } } };
  const subtle = g.crypto?.subtle;
  if (!subtle) throw new Error("subtle unavailable");
  const key = (await (subtle as unknown as { importKey: (...a: unknown[]) => Promise<unknown> }).importKey("raw", keyBytes as unknown as never, { name: "AES-GCM" }, false, ["decrypt"])) as unknown;
  const pt = (await (subtle as unknown as { decrypt: (...a: unknown[]) => Promise<ArrayBuffer> }).decrypt({ name: "AES-GCM", iv: nonce as unknown as never }, key as unknown as never, ciphertext as unknown as never)) as ArrayBuffer;
  return new Uint8Array(pt);
}

export async function sealPayload(payload: unknown, secret: string): Promise<LyraSeal> {
  const key = deriveKey(secret);
  const nonce = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");

  let ciphertext: Buffer;
  try {
    const g = globalThis as unknown as { crypto?: { subtle?: unknown } };
    const subtle = g.crypto?.subtle;
    if (subtle) {
      const ct = await subtleSeal(key, nonce, plaintext);
      ciphertext = Buffer.from(ct);
    } else {
      throw new Error("no subtle");
    }
  } catch {
    // Node fallback
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    ciphertext = Buffer.concat([enc, tag]);
  }

  return { v: 1, nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

export async function sealEnvelope(envelope: import("@lyra-sync-app/protocol").LyraEnvelope, secret: string): Promise<import("@lyra-sync-app/protocol").LyraEnvelope> {
  const seal = await sealPayload(envelope.payload, secret);
  return { ...envelope, seal };
}

export async function unsealEnvelope(envelope: import("@lyra-sync-app/protocol").LyraEnvelope, secret: string): Promise<import("@lyra-sync-app/protocol").LyraEnvelope> {
  if (!envelope.seal) return envelope;
  const payload = await unsealPayload(envelope.seal, secret);
  return { ...envelope, payload };
}

export async function unsealPayload(seal: LyraSeal, secret: string): Promise<unknown> {
  const key = deriveKey(secret);
  const nonce = fromBase64(seal.nonce);
  const ciphertext = fromBase64(seal.ciphertext);

  let plaintext: Buffer;
  try {
    const g = globalThis as unknown as { crypto?: { subtle?: unknown } };
    const subtle = g.crypto?.subtle;
    if (subtle) {
      const pt = await subtleUnseal(key, nonce, ciphertext);
      plaintext = Buffer.from(pt);
    } else {
      throw new Error("no subtle");
    }
  } catch {
    // Node fallback: last 16 bytes are tag
    if (ciphertext.length < 16) throw new Error("ciphertext too short");
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const enc = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(enc), decipher.final()]);
  }

  const json = plaintext.toString("utf8");
  return JSON.parse(json) as unknown;
}
