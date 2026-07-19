import type {
  AuthChallengePayload,
  AuthOkPayload,
  AuthResponsePayload,
  DeviceIdentity,
} from "@lyra-sync-app/protocol";

import { randomHex, sha256Hex } from "./crypto-util";

const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_MS = 60 * 60_000;

const ECDSA_KEY_PREFIX = "ecdsa-p256:";

export type AuthSession = {
  sessionToken: string;
  deviceId: string;
  fingerprint: string;
  publicKey?: string;
  /** Pairing-derived shared secret when auth used shared-secret proof */
  sharedSecret?: string;
  expiresAt: number;
};

export function isEcdsaPublicKey(publicKey: string): boolean {
  return publicKey.startsWith(ECDSA_KEY_PREFIX);
}

export function isEcdsaPrivateKey(privateKey: string): boolean {
  return privateKey.startsWith(ECDSA_KEY_PREFIX);
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

async function importEcdsaPrivateKey(privateKey: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(privateKey.slice(ECDSA_KEY_PREFIX.length));
  return crypto.subtle.importKey(
    "pkcs8",
    raw as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function importEcdsaPublicKey(publicKey: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(publicKey.slice(ECDSA_KEY_PREFIX.length));
  return crypto.subtle.importKey(
    "spki",
    raw as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/** Sign challenge nonce with ECDSA private key (or legacy sha256). */
export async function signAuthNonce(privateKey: string, nonce: string): Promise<string> {
  if (isEcdsaPrivateKey(privateKey) && typeof crypto?.subtle?.sign === "function") {
    const key = await importEcdsaPrivateKey(privateKey);
    const data = new TextEncoder().encode(nonce);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource),
    );
    return `${ECDSA_KEY_PREFIX}sig:${bytesToBase64Url(sig)}`;
  }
  return sha256Hex(`${nonce}:${privateKey}`);
}

export async function verifyEcdsaAuthProof(
  publicKey: string,
  nonce: string,
  proof: string,
): Promise<boolean> {
  if (!isEcdsaPublicKey(publicKey) || !proof.startsWith(`${ECDSA_KEY_PREFIX}sig:`)) {
    return false;
  }
  if (typeof crypto?.subtle?.verify !== "function") return false;
  try {
    const key = await importEcdsaPublicKey(publicKey);
    const sig = base64UrlToBytes(proof.slice(`${ECDSA_KEY_PREFIX}sig:`.length));
    const data = new TextEncoder().encode(nonce);
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

/**
 * Create an auth challenge for an incoming peer.
 */
export async function createAuthChallenge(
  serverIdentity: Pick<DeviceIdentity, "fingerprint">,
): Promise<AuthChallengePayload> {
  return {
    challengeId: randomHex(8),
    nonce: randomHex(16),
    serverFingerprint: serverIdentity.fingerprint,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };
}

/** Client-side: sign a challenge with local private key material (ECDSA preferred). */
export async function createAuthResponse(input: {
  challenge: AuthChallengePayload;
  identity: Pick<DeviceIdentity, "id" | "fingerprint" | "publicKey">;
  privateKey: string;
}): Promise<AuthResponsePayload> {
  const proof = await signAuthNonce(input.privateKey, input.challenge.nonce);
  return {
    challengeId: input.challenge.challengeId,
    deviceId: input.identity.id,
    fingerprint: input.identity.fingerprint,
    publicKey: input.identity.publicKey,
    proof,
  };
}

/**
 * Server-side: verify auth response.
 * Prefer: shared secret proof (post-pairing) OR ECDSA signature over nonce.
 * Legacy first-contact identity-binding still accepted when no stronger material provided.
 */
export async function verifyAuthResponse(input: {
  challenge: AuthChallengePayload;
  response: AuthResponsePayload;
  expectedFingerprint?: string;
  expectedDeviceId?: string;
  /** If provided, recompute expected proof (only for self/test loops) */
  privateKeyForVerify?: string;
  /** Paired-device shared secret established at pairing time */
  sharedSecret?: string;
  /**
   * When true (default), accept weak identity-binding proof for first contact.
   * Production peer servers should set false once resolvePeerAuth is configured.
   */
  allowIdentityBinding?: boolean;
}): Promise<{ ok: true; session: AuthSession } | { ok: false; error: string }> {
  const { challenge, response } = input;

  if (response.challengeId !== challenge.challengeId) {
    return { ok: false, error: "Challenge id mismatch" };
  }
  if (challenge.expiresAt < Date.now()) {
    return { ok: false, error: "Challenge expired" };
  }
  if (input.expectedFingerprint && response.fingerprint !== input.expectedFingerprint) {
    return { ok: false, error: "Fingerprint mismatch" };
  }
  if (input.expectedDeviceId && response.deviceId !== input.expectedDeviceId) {
    return { ok: false, error: "Device id mismatch" };
  }

  let proofOk = false;
  let usedSharedSecret = false;

  if (input.sharedSecret) {
    const expected = await sha256Hex(`${challenge.nonce}:${input.sharedSecret}`);
    if (response.proof === expected) {
      proofOk = true;
      usedSharedSecret = true;
    }
  }

  if (!proofOk && input.privateKeyForVerify) {
    const expected = await signAuthNonce(input.privateKeyForVerify, challenge.nonce);
    if (response.proof === expected) proofOk = true;
  }

  if (!proofOk && isEcdsaPublicKey(response.publicKey)) {
    proofOk = await verifyEcdsaAuthProof(
      response.publicKey,
      challenge.nonce,
      response.proof,
    );
  }

  // Weak first-contact / migration (only if allowed)
  const allowBinding = input.allowIdentityBinding !== false;
  if (!proofOk && allowBinding && !input.sharedSecret) {
    const binding = await sha256Hex(
      `${challenge.nonce}:${response.publicKey}:${response.fingerprint}`,
    );
    if (response.proof === binding) proofOk = true;
  }

  if (!proofOk) {
    return { ok: false, error: "Invalid proof" };
  }

  const sessionToken = randomHex(24);
  const session: AuthSession = {
    sessionToken,
    deviceId: response.deviceId,
    fingerprint: response.fingerprint,
    publicKey: response.publicKey,
    sharedSecret: usedSharedSecret ? input.sharedSecret : undefined,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  return { ok: true, session };
}

/** Prefer this when both sides share a pairing-derived secret. */
export async function createSharedSecretProof(
  nonce: string,
  sharedSecret: string,
): Promise<string> {
  return sha256Hex(`${nonce}:${sharedSecret}`);
}

/**
 * Derive a **mutual** auth secret both peers can recompute after dual-confirm pairing.
 * Order-independent: fingerprints and public keys are sorted before hashing.
 */
export async function deriveMutualAuthSecret(input: {
  pairingToken: string;
  localFingerprint: string;
  remoteFingerprint: string;
  localPublicKey: string;
  remotePublicKey: string;
}): Promise<string> {
  const fps = [input.localFingerprint, input.remoteFingerprint].sort();
  const pubs = [input.localPublicKey, input.remotePublicKey].sort();
  return sha256Hex(
    `pair-mutual:${input.pairingToken}:${fps[0]}:${fps[1]}:${pubs[0]}:${pubs[1]}`,
  );
}

/**
 * @deprecated Prefer {@link deriveMutualAuthSecret}.
 */
export async function derivePairingSharedSecret(input: {
  pairingToken: string;
  localPrivateKey: string;
  remotePublicKey: string;
  localFingerprint?: string;
  remoteFingerprint?: string;
  localPublicKey?: string;
}): Promise<string> {
  if (
    input.localFingerprint &&
    input.remoteFingerprint &&
    input.localPublicKey
  ) {
    return deriveMutualAuthSecret({
      pairingToken: input.pairingToken,
      localFingerprint: input.localFingerprint,
      remoteFingerprint: input.remoteFingerprint,
      localPublicKey: input.localPublicKey,
      remotePublicKey: input.remotePublicKey,
    });
  }
  return sha256Hex(
    `pair:${input.pairingToken}:${input.localPrivateKey}:${input.remotePublicKey}`,
  );
}

/** Client proof when using shared secret (preferred after pairing). */
export async function createAuthResponseWithSharedSecret(input: {
  challenge: AuthChallengePayload;
  identity: Pick<DeviceIdentity, "id" | "fingerprint" | "publicKey">;
  sharedSecret: string;
}): Promise<AuthResponsePayload> {
  const proof = await createSharedSecretProof(input.challenge.nonce, input.sharedSecret);
  return {
    challengeId: input.challenge.challengeId,
    deviceId: input.identity.id,
    fingerprint: input.identity.fingerprint,
    publicKey: input.identity.publicKey,
    proof,
  };
}

/** Identity-binding proof used for first-contact / unpaired hello (weak). */
export async function createIdentityBindingProof(
  nonce: string,
  publicKey: string,
  fingerprint: string,
): Promise<string> {
  return sha256Hex(`${nonce}:${publicKey}:${fingerprint}`);
}

export async function createFirstContactAuthResponse(input: {
  challenge: AuthChallengePayload;
  identity: Pick<DeviceIdentity, "id" | "fingerprint" | "publicKey">;
  /** Prefer ECDSA signature when private key is available */
  privateKey?: string;
}): Promise<AuthResponsePayload> {
  if (input.privateKey && isEcdsaPrivateKey(input.privateKey)) {
    return createAuthResponse({
      challenge: input.challenge,
      identity: input.identity,
      privateKey: input.privateKey,
    });
  }
  const proof = await createIdentityBindingProof(
    input.challenge.nonce,
    input.identity.publicKey,
    input.identity.fingerprint,
  );
  return {
    challengeId: input.challenge.challengeId,
    deviceId: input.identity.id,
    fingerprint: input.identity.fingerprint,
    publicKey: input.identity.publicKey,
    proof,
  };
}

export function toAuthOkPayload(session: AuthSession): AuthOkPayload {
  return {
    sessionToken: session.sessionToken,
    deviceId: session.deviceId,
    fingerprint: session.fingerprint,
    expiresAt: session.expiresAt,
  };
}

export function isSessionValid(session: AuthSession | null | undefined): boolean {
  return Boolean(session && session.expiresAt > Date.now() && session.sessionToken);
}
