import type { DeviceIdentity, DeviceType, Platform } from "@lyra-sync-app/protocol";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
    return bytesToHex(new Uint8Array(hash));
  }
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return `fallback${Math.abs(h).toString(16).padStart(8, "0")}${input.length.toString(16)}`;
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

/**
 * Creates a long-term device identity. Private key material stays local.
 * Returns a Result-style object for easy testing without throwing.
 */
export async function createDeviceIdentity(opts?: {
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
    return {
      ok: false,
      error: new IdentityError(e instanceof Error ? e.message : String(e)),
    };
  }
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
