import type { DeviceIdentity, DeviceType, Platform } from "@lyra-sync-app/protocol";

// -- helpers ---------------------------------------------------------------

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof (crypto as { randomUUID?: () => string }).randomUUID === "function") {
    return (crypto as { randomUUID: () => string }).randomUUID();
  }
  // fallback
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generatePairingCode(length = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O,0,I,1
  let code = "";
  const arr = new Uint32Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < length; i++) arr[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = 0; i < length; i++) code += chars[(arr[i] as number) % chars.length];
  return code;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  // Web Crypto path
  try {
    if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
      const data = new TextEncoder().encode(input);
      const hash = await crypto.subtle.digest("SHA-256", data);
      return toHex(hash);
    }
  } catch {}
  // Node fallback
  try {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(input, "utf8").digest("hex");
  } catch {}
  // ultra fallback (not cryptographically secure, just scaffold)
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(8, "0");
}

// sync version for scaffold where async not desired
function sha256HexSync(input: string): string {
  try {
    const { createHash } = eval("require")("node:crypto") as typeof import("node:crypto");
    return createHash("sha256").update(input, "utf8").digest("hex");
  } catch {
    let h = 0;
    for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16).padStart(8, "0");
  }
}

export function hashPairingCode(code: string): string {
  // normalize + hash — sync for announcer
  return sha256HexSync(code.trim().toUpperCase());
}

export async function hashPairingCodeAsync(code: string): Promise<string> {
  return sha256Hex(code.trim().toUpperCase());
}

/**
 * deriveMutualAuthSecret — scaffold: SHA256(token + fpA + fpB) hex.
 * Day 1 simple shared secret; Day 2 will add ECDSA.
 */
export async function deriveMutualAuthSecret(
  token: string,
  fpA: string,
  fpB: string,
): Promise<string> {
  const sorted = [fpA, fpB].sort().join("|");
  return sha256Hex(`${token}|${sorted}`);
}

export function deriveMutualAuthSecretSync(token: string, fpA: string, fpB: string): string {
  const sorted = [fpA, fpB].sort().join("|");
  return sha256HexSync(`${token}|${sorted}`);
}

export function createDeviceIdentity(opts: {
  id?: string;
  name: string;
  type?: DeviceType;
  platform?: Platform;
  fingerprint?: string;
  publicKey?: string;
  model?: string;
  osVersion?: string;
}): DeviceIdentity {
  const id = opts.id ?? generateId();
  const fingerprint = opts.fingerprint ?? sha256HexSync(id).slice(0, 16);
  return {
    id,
    name: opts.name,
    type: opts.type,
    platform: opts.platform,
    fingerprint,
    publicKey: opts.publicKey,
    model: opts.model,
    osVersion: opts.osVersion,
  };
}
