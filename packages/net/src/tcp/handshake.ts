// @ts-nocheck
/**
 * Lyra TCP handshake — hello + auth_challenge/response over framed JSON.
 * Reuses existing crypto in auth.ts.
 */

import {
  LYRA_PROTOCOL_VERSION,
  type DeviceIdentity,
} from "@lyra-sync-app/protocol";
import {
  createAuthChallenge,
  createAuthResponse,
  createAuthResponseWithSharedSecret,
  createFirstContactAuthResponse,
  isEcdsaPrivateKey,
  toAuthOkPayload,
  verifyAuthResponse,
  type AuthChallengePayload,
  type AuthSession,
} from "../auth";

export type HelloPayload = {
  type: "hello";
  identity: DeviceIdentity;
  protocolVersion: number;
};

export type AuthChallengeFrame = {
  type: "auth_challenge";
  challenge: AuthChallengePayload;
};

export type AuthResponseFrame = {
  type: "auth_response";
  response: {
    challengeId: string;
    deviceId: string;
    fingerprint: string;
    publicKey: string;
    proof: string;
    timestamp: number;
  };
};

export type AuthOkFrame = {
  type: "auth_ok";
  sessionToken: string;
  deviceId: string;
  fingerprint: string;
};

export type AuthErrorFrame = {
  type: "auth_error";
  error: string;
};

export type HelloErrorFrame = {
  type: "hello_error";
  error: string;
};

export function createHelloFrame(identity: DeviceIdentity): HelloPayload {
  return { type: "hello", identity, protocolVersion: LYRA_PROTOCOL_VERSION };
}

export function validateHello(
  msg: unknown,
  expectedVersion?: number,
): { ok: true; identity: DeviceIdentity } | { ok: false; error: string } {
  if (!msg || typeof msg !== "object") return { ok: false, error: "Invalid hello" };
  const m = msg as Record<string, unknown>;
  if (m.type !== "hello") return { ok: false, error: "Not hello" };
  if (typeof m.protocolVersion === "number" && m.protocolVersion !== LYRA_PROTOCOL_VERSION) {
    return { ok: false, error: `Protocol mismatch (peer ${m.protocolVersion} vs ${LYRA_PROTOCOL_VERSION}) — update Lyra on both devices` };
  }
  const id = m.identity as DeviceIdentity | undefined;
  if (!id || typeof id.id !== "string" || typeof id.fingerprint !== "string") {
    return { ok: false, error: "Missing identity" };
  }
  return { ok: true, identity: id };
}

// Server side: issue challenge
export async function serverCreateChallenge(serverIdentity: DeviceIdentity): Promise<AuthChallengeFrame> {
  const challenge = await createAuthChallenge(serverIdentity);
  return { type: "auth_challenge", challenge };
}

// Client side: create response
export async function clientCreateAuthResponse(input: {
  challenge: AuthChallengePayload;
  identity: DeviceIdentity;
  privateKey: string;
  sharedSecret?: string;
}): Promise<AuthResponseFrame> {
  const response = input.sharedSecret
    ? await createAuthResponseWithSharedSecret({
        challenge: input.challenge,
        identity: input.identity,
        sharedSecret: input.sharedSecret,
      })
    : isEcdsaPrivateKey(input.privateKey)
      ? await createAuthResponse({
          challenge: input.challenge,
          identity: input.identity,
          privateKey: input.privateKey,
        })
      : await createFirstContactAuthResponse({
          challenge: input.challenge,
          identity: input.identity,
          privateKey: input.privateKey,
        });
  return { type: "auth_response", response };
}

// Server verifies and creates session
export async function serverVerifyResponse(input: {
  challenge: AuthChallengePayload;
  response: AuthResponseFrame["response"];
  serverIdentity: DeviceIdentity;
  resolvePeerAuth?: (p: { deviceId: string; fingerprint: string; publicKey: string }) =>
    | { sharedSecret?: string; expectedFingerprint?: string; expectedDeviceId?: string }
    | null
    | undefined;
  allowFirstContact?: boolean;
}): Promise<{ ok: true; session: AuthSession } | { ok: false; error: string }> {
  const hints = input.resolvePeerAuth?.({
    deviceId: input.response.deviceId,
    fingerprint: input.response.fingerprint,
    publicKey: input.response.publicKey,
  });

  if (hints === null && !input.allowFirstContact) {
    return { ok: false, error: "Unknown peer" };
  }

  const hasShared = Boolean(hints?.sharedSecret);
  const hasExpectedFp = Boolean(hints?.expectedFingerprint);
  if (!input.allowFirstContact && !hasShared && !hasExpectedFp) {
    return { ok: false, error: "Pairing required" };
  }

  const verified = await verifyAuthResponse({
    challenge: input.challenge,
    response: input.response as any,
    expectedFingerprint: hints?.expectedFingerprint,
    expectedDeviceId: hints?.expectedDeviceId,
    sharedSecret: hints?.sharedSecret,
    allowIdentityBinding: (input.allowFirstContact ?? true) && !hasShared,
  });

  if (!verified.ok) return { ok: false, error: verified.error };

  if (hints?.sharedSecret && !verified.session.sharedSecret) {
    verified.session.sharedSecret = hints.sharedSecret;
  }

  return { ok: true, session: verified.session };
}

export function authOkToFrame(session: AuthSession): AuthOkFrame {
  const payload = toAuthOkPayload(session);
  return { type: "auth_ok", sessionToken: payload.sessionToken, deviceId: payload.deviceId, fingerprint: "" };
}
