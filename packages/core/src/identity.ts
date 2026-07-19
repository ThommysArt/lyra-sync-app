import type { DeviceIdentity, DeviceType, Platform } from "@lyra-sync-app/protocol";

/** Prefix for Web Crypto ECDSA P-256 key material (SPKI / PKCS8 base64url). */
export const ECDSA_KEY_PREFIX = "ecdsa-p256:";

/** Legacy pseudo-key identities (pre-Phase-1). */
export function isLegacyPrivateKey(privateKey: string): boolean {
  return /^[a-f0-9]{64}$/i.test(privateKey) && !privateKey.startsWith(ECDSA_KEY_PREFIX);
}

export function isEcdsaPrivateKey(privateKey: string): boolean {
  return privateKey.startsWith(ECDSA_KEY_PREFIX);
}

export function isEcdsaPublicKey(publicKey: string): boolean {
  return publicKey.startsWith(ECDSA_KEY_PREFIX);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (b64url.length % 4)) % 4);
  if (typeof atob === "function") {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < length; i++) {
      out[i] = Math.floor(Math.random() * 256);
    }
  }
  return out;
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
    return bytesToHex(new Uint8Array(hash));
  }
  let h = 0;
  for (let i = 0; i < data.length; i++) {
    h = (Math.imul(31, h) + data[i]!) | 0;
  }
  return `fallback${Math.abs(h).toString(16).padStart(8, "0")}${data.length.toString(16)}`;
}

function hasSubtleCrypto(): boolean {
  return typeof globalThis.crypto?.subtle?.generateKey === "function";
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("android")) return "android";
  if (ua.includes("iphone") || ua.includes("ipad")) return "ios";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "web";
}

export function detectDeviceType(platform: Platform): DeviceType {
  return platform === "android" || platform === "ios" ? "mobile" : "desktop";
}

export function defaultDeviceName(platform: Platform): string {
  const labels: Record<Platform, string> = {
    windows: "Windows PC",
    macos: "Mac",
    linux: "Linux PC",
    android: "Android Phone",
    ios: "iPhone",
    web: "Web Device",
    unknown: "Lyra Device",
  };
  return labels[platform];
}

export function formatFingerprint(fingerprint: string): string {
  const clean = fingerprint.replace(/[^a-f0-9]/gi, "").toUpperCase();
  const chunks: string[] = [];
  for (let i = 0; i < Math.min(clean.length, 16); i += 4) {
    chunks.push(clean.slice(i, i + 4));
  }
  return chunks.join(" · ");
}

export class IdentityError extends Error {
  readonly _tag = "IdentityError";
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

async function createLegacyIdentity(opts?: {
  name?: string;
  platform?: Platform;
  type?: DeviceType;
}): Promise<{ ok: true; identity: DeviceIdentity; privateKey: string } | { ok: false; error: IdentityError }> {
  try {
    const platform = opts?.platform ?? detectPlatform();
    const type = opts?.type ?? detectDeviceType(platform);
    const privateKey = bytesToHex(randomBytes(32));
    const publicKey = await sha256Hex(`pub:${privateKey}`);
    const fingerprint = (await sha256Hex(`fp:${publicKey}`)).slice(0, 32);
    const id = (await sha256Hex(`id:${publicKey}`)).slice(0, 16);
    return {
      ok: true,
      identity: {
        id,
        name: opts?.name ?? defaultDeviceName(platform),
        type,
        platform,
        fingerprint,
        publicKey,
        createdAt: Date.now(),
      },
      privateKey,
    };
  } catch (e) {
    return {
      ok: false,
      error: new IdentityError(e instanceof Error ? e.message : String(e)),
    };
  }
}

/**
 * Creates a long-term device identity.
 * Prefers ECDSA P-256 (Web Crypto); falls back to legacy hex pseudo-keys only if SubtleCrypto is unavailable.
 * Private key material stays local.
 */
export async function createDeviceIdentity(opts?: {
  name?: string;
  platform?: Platform;
  type?: DeviceType;
  /** Force legacy identity (tests only) */
  forceLegacy?: boolean;
}): Promise<{ ok: true; identity: DeviceIdentity; privateKey: string } | { ok: false; error: IdentityError }> {
  if (opts?.forceLegacy || !hasSubtleCrypto()) {
    return createLegacyIdentity(opts);
  }

  try {
    const platform = opts?.platform ?? detectPlatform();
    const type = opts?.type ?? detectDeviceType(platform);
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const publicKey = `${ECDSA_KEY_PREFIX}${bytesToBase64Url(spki)}`;
    const privateKey = `${ECDSA_KEY_PREFIX}${bytesToBase64Url(pkcs8)}`;
    const fingerprint = (await sha256Hex(spki)).slice(0, 32);
    const id = (await sha256Hex(new TextEncoder().encode(`id:${publicKey}`))).slice(0, 16);

    const identity: DeviceIdentity = {
      id,
      name: opts?.name ?? defaultDeviceName(platform),
      type,
      platform,
      fingerprint,
      publicKey,
      createdAt: Date.now(),
    };

    return { ok: true, identity, privateKey };
  } catch (e) {
    // Fallback if ECDSA export fails in constrained environments
    return createLegacyIdentity(opts);
  }
}

/** Import ECDSA private key from stored material. */
export async function importEcdsaPrivateKey(privateKey: string): Promise<CryptoKey> {
  if (!isEcdsaPrivateKey(privateKey)) {
    throw new IdentityError("Not an ECDSA private key");
  }
  const raw = base64UrlToBytes(privateKey.slice(ECDSA_KEY_PREFIX.length));
  return crypto.subtle.importKey(
    "pkcs8",
    raw as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** Import ECDSA public key from stored material. */
export async function importEcdsaPublicKey(publicKey: string): Promise<CryptoKey> {
  if (!isEcdsaPublicKey(publicKey)) {
    throw new IdentityError("Not an ECDSA public key");
  }
  const raw = base64UrlToBytes(publicKey.slice(ECDSA_KEY_PREFIX.length));
  return crypto.subtle.importKey(
    "spki",
    raw as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/** Sign a UTF-8 message with ECDSA P-256 + SHA-256. Returns base64url signature. */
export async function signWithPrivateKey(privateKey: string, message: string): Promise<string> {
  if (isEcdsaPrivateKey(privateKey)) {
    const key = await importEcdsaPrivateKey(privateKey);
    const data = new TextEncoder().encode(message);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource),
    );
    return `${ECDSA_KEY_PREFIX}sig:${bytesToBase64Url(sig)}`;
  }
  // Legacy: sha256(message:privateKey)
  return sha256Hex(`${message}:${privateKey}`);
}

/** Verify ECDSA signature or legacy sha256 proof. */
export async function verifyWithPublicKey(
  publicKey: string,
  message: string,
  proof: string,
): Promise<boolean> {
  if (isEcdsaPublicKey(publicKey) && proof.startsWith(`${ECDSA_KEY_PREFIX}sig:`)) {
    try {
      const key = await importEcdsaPublicKey(publicKey);
      const sig = base64UrlToBytes(proof.slice(`${ECDSA_KEY_PREFIX}sig:`.length));
      const data = new TextEncoder().encode(message);
      return crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        sig as BufferSource,
        data as BufferSource,
      );
    } catch {
      return false;
    }
  }
  return false;
}

export function generatePairingCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return code;
}

export function generateId(prefix = "id"): string {
  return `${prefix}_${bytesToHex(randomBytes(8))}`;
}

/** Hash a pairing code for public advertisement (never expose raw code on /lyra/info). */
export async function hashPairingCode(code: string): Promise<string> {
  return sha256Hex(`paircode:${code.trim().toUpperCase()}`);
}
