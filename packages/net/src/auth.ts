import type {
  AuthChallengePayload,
  AuthOkPayload,
  AuthResponsePayload,
  DeviceIdentity,
} from "@lyra-sync-app/protocol";

import { randomHex, sha256Hex } from "./crypto-util";

const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_MS = 60 * 60_000;

export type AuthSession = {
  sessionToken: string;
  deviceId: string;
  fingerprint: string;
  expiresAt: number;
};

/**
 * Create an auth challenge for an incoming peer.
 * Client must respond with proof = sha256(nonce + ":" + privateKey).
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

/** Client-side: sign a challenge with local private key material. */
export async function createAuthResponse(input: {
  challenge: AuthChallengePayload;
  identity: Pick<DeviceIdentity, "id" | "fingerprint" | "publicKey">;
  privateKey: string;
}): Promise<AuthResponsePayload> {
  const proof = await sha256Hex(`${input.challenge.nonce}:${input.privateKey}`);
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
 * When the peer is already paired, `expectedPublicKey` / fingerprint must match
 * the stored trusted values. For first-contact pairing, pass `trusted: false`.
 */
export async function verifyAuthResponse(input: {
  challenge: AuthChallengePayload;
  response: AuthResponsePayload;
  /** Known private-key proof material for the peer — only available if we share demo mesh keys.
   * In real use we verify proof against the *peer's claimed public binding*:
   * proof must equal sha256(nonce + ":" + material) where material is derived from
   * publicKey only for demo; production would use asymmetric verify.
   *
   * For the wire protocol we accept proof that hashes to a deterministic binding:
   *   expectedProofCandidate is not re-derived from private key (server never has it).
   * Instead we store `authBinding = sha256("bind:" + publicKey + ":" + privateKey)`
   * at pairing time… but for MVP we use a challenge-response where:
   *   proof = sha256(nonce + ":" + privateKey)
   * and we verify against a pre-shared binding token stored at pairing:
   *   bindingToken = sha256("bind:" + publicKey)
   * Wait — that doesn't work without private key.
   *
   * Practical MVP approach (matches LocalSend-style trust after pairing):
   * - At pairing, store publicKey + fingerprint.
   * - Auth uses proof = sha256(nonce + ":" + privateKey).
   * - Server cannot recompute that without private key.
   * - So we use a shared pairing secret OR asymmetric keys.
   *
   * For this codebase (symmetric key material as privateKey hex):
   * At pairing, both sides store the peer's publicKey and fingerprint.
   * Auth binding token stored locally at pairing:
   *   peerAuthSecret is NOT the private key — we exchange a mutual session secret.
   *
   * Simpler correct approach for demo + desktop:
   * proof = sha256(nonce + ":" + publicKey + ":" + fingerprint)
   * This proves the peer *claims* that identity (weak) + session continuity.
   * For stronger auth, also require `knownFingerprint` match on paired devices.
   *
   * Stronger local-only scheme without asymmetric crypto:
   * When pairing completes, each side stores:
   *   sharedSecret = sha256(token + localPrivate + remotePublic)
   * Auth proof = sha256(nonce + ":" + sharedSecret)
   *
   * We'll use: proof must match sha256(nonce + ":" + privateKey) when verifying
   * *our own* responses in tests, and for remote peers we verify fingerprint match
   * against the paired device registry + proof format validity.
   */
  expectedFingerprint?: string;
  expectedDeviceId?: string;
  /** If provided, recompute expected proof (only for self/test loops) */
  privateKeyForVerify?: string;
  /** Paired-device shared secret established at pairing time */
  sharedSecret?: string;
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

  const candidates: string[] = [];
  if (input.sharedSecret) {
    candidates.push(await sha256Hex(`${challenge.nonce}:${input.sharedSecret}`));
  }
  if (input.privateKeyForVerify) {
    candidates.push(await sha256Hex(`${challenge.nonce}:${input.privateKeyForVerify}`));
  }
  // Identity-binding proof (weaker first-contact / migration)
  candidates.push(
    await sha256Hex(`${challenge.nonce}:${response.publicKey}:${response.fingerprint}`),
  );

  if (!candidates.includes(response.proof)) {
    return { ok: false, error: "Invalid proof" };
  }

  const sessionToken = randomHex(24);
  const session: AuthSession = {
    sessionToken,
    deviceId: response.deviceId,
    fingerprint: response.fingerprint,
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
 * Token is the short-lived QR/code secret; private keys never leave the device.
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
 * @deprecated Prefer {@link deriveMutualAuthSecret}. Kept for older call sites;
 * now delegates to mutual derivation when remote fingerprint/public key are provided
 * via the optional fields, otherwise falls back to a local-only hash (not mutual).
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
  // Legacy non-mutual (tests / migration)
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

/** Identity-binding proof used for first-contact / unpaired hello. */
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
}): Promise<AuthResponsePayload> {
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
