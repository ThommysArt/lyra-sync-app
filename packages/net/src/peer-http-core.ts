/**
 * Platform-agnostic Lyra peer HTTP request handler.
 * Used by Node peer-server and React Native TCP peer server.
 */
import {
  AuthResponsePayloadSchema,
  LYRA_PROTOCOL_VERSION,
  type DeviceIdentity,
  type DeviceStatus,
  type Envelope,
} from "@lyra-sync-app/protocol";

import {
  createAuthChallenge,
  toAuthOkPayload,
  verifyAuthResponse,
  type AuthSession,
} from "./auth";
import { parseEnvelope } from "./envelope";
import {
  handlePeerEnvelope,
  PUBLIC_MESSAGE_TYPES,
  type MessageHandlerContext,
  type TransferReceiveState,
} from "./message-handlers";
import { isSealedPayload, openEnvelopePayload, sealEnvelopePayload } from "./peer-client";
import type { AuthChallengePayload } from "@lyra-sync-app/protocol";

export type PeerHttpRequest = {
  method: string;
  /** Path only, e.g. /lyra/info */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
  /** Remote peer IPv4/IPv6 when known (for pair_request host fill-in) */
  remoteAddress?: string | null;
};

export type PeerHttpResponse = {
  status: number;
  headers?: Record<string, string>;
  body: string;
};

export type PeerHttpCoreOptions = {
  getIdentity: () => DeviceIdentity;
  getStatus?: () => DeviceStatus | undefined;
  getPairingOffer?: () =>
    | {
        codeHash: string;
        token: string;
        expiresAt: number;
      }
    | undefined
    | null;
  /** Bound listen port advertised on /lyra/info */
  getPort: () => number;
  /** Optional non-loopback host advertised on /lyra/info */
  getLanHost?: () => string | null;
  protocol?: "http" | "https";
  tlsFingerprint?: string;
  resolvePeerAuth?: (input: {
    deviceId: string;
    fingerprint: string;
    publicKey: string;
  }) =>
    | { sharedSecret?: string; expectedFingerprint?: string; expectedDeviceId?: string }
    | null
    | undefined;
  allowFirstContactAuth?: boolean;
  requireAuthForMessages?: boolean;
  sealReplies?: boolean;
  handlers?: Omit<MessageHandlerContext, "identity" | "transfers" | "revokeDeviceSessions">;
  onEnvelope?: (
    envelope: Envelope,
    session: AuthSession | null,
  ) => Promise<Envelope | Record<string, unknown> | void> | Envelope | Record<string, unknown> | void;
  /** When true (default), emit CORS headers for LAN browser clients */
  cors?: boolean;
};

export type PeerHttpCore = {
  handle: (req: PeerHttpRequest) => Promise<PeerHttpResponse>;
  getSessions: () => Map<string, AuthSession>;
  revokeDevice: (deviceId: string) => number;
  resolvePairRequest: (
    key: { deviceId?: string; token?: string },
    decision: PeerPairDecision,
  ) => boolean;
  /** Pending pair waiters (for diagnostics) */
  pendingPairCount: () => number;
};

export type PeerPairDecision =
  | { accepted: true; host?: string; port?: number }
  | { accepted: false; reason?: string };

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return undefined;
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  // Node fallback
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(text, "utf8");
  }
  return text.length;
}

function jsonResponse(
  status: number,
  body: unknown,
  cors: boolean,
): PeerHttpResponse {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (cors) {
    headers["access-control-allow-origin"] = "*";
    headers["access-control-allow-headers"] = "content-type, authorization";
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
  }
  const text = status === 204 ? "" : JSON.stringify(body);
  if (text) {
    headers["content-length"] = String(utf8ByteLength(text));
  }
  return { status, headers, body: text };
}

async function maybeSealReply(
  reply: Envelope | Record<string, unknown>,
  session: AuthSession | null,
  sealReplies: boolean,
): Promise<Envelope | Record<string, unknown>> {
  if (!sealReplies || !session?.sharedSecret) return reply;
  if (!("type" in reply) || typeof reply.type !== "string") return reply;
  const env = reply as Envelope;
  if (env.payload === undefined) return reply;
  try {
    const sealed = await sealEnvelopePayload(session.sharedSecret, env.payload);
    return { ...env, payload: sealed };
  } catch {
    return reply;
  }
}

export function createPeerHttpCore(options: PeerHttpCoreOptions): PeerHttpCore {
  const challenges = new Map<string, AuthChallengePayload>();
  const sessions = new Map<string, AuthSession>();
  const transfers = new Map<string, TransferReceiveState>();
  const requireAuth = options.requireAuthForMessages !== false;
  const allowFirstContact = options.allowFirstContactAuth !== false;
  const sealReplies = options.sealReplies !== false;
  const cors = options.cors !== false;
  const protocol = options.protocol ?? "http";

  type PendingPair = {
    deviceId: string;
    token: string;
    resolve: (decision: PeerPairDecision) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pendingPairs = new Map<string, PendingPair>();
  const pairKey = (deviceId: string, token: string) => `${token}::${deviceId}`;

  const waitForPairDecision: MessageHandlerContext["waitForPairDecision"] = (payload) => {
    const key = pairKey(payload.deviceId, payload.token);
    const existing = pendingPairs.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve({ accepted: false, reason: "superseded" });
      pendingPairs.delete(key);
    }
    return new Promise<PeerPairDecision>((resolve) => {
      const timer = setTimeout(() => {
        pendingPairs.delete(key);
        resolve({ accepted: false, reason: "timeout" });
      }, 120_000);
      pendingPairs.set(key, {
        deviceId: payload.deviceId,
        token: payload.token,
        resolve: (decision) => {
          clearTimeout(timer);
          pendingPairs.delete(key);
          resolve(decision);
        },
        timer,
      });
    });
  };

  const resolvePairRequest = (
    key: { deviceId?: string; token?: string },
    decision: PeerPairDecision,
  ): boolean => {
    let matched = false;
    for (const [k, pending] of pendingPairs) {
      const byDevice = key.deviceId && pending.deviceId === key.deviceId;
      const byToken = key.token && pending.token === key.token;
      if (byDevice || byToken || (key.deviceId && key.token && k === pairKey(key.deviceId, key.token))) {
        pending.resolve(decision);
        matched = true;
        if (key.deviceId && key.token) break;
      }
    }
    return matched;
  };

  const handlerCtx: MessageHandlerContext = {
    get identity() {
      return options.getIdentity();
    },
    transfers,
    waitForPairDecision,
    revokeDeviceSessions: (deviceId: string) => {
      let n = 0;
      for (const [token, s] of sessions) {
        if (s.deviceId === deviceId) {
          sessions.delete(token);
          n++;
        }
      }
      return n;
    },
    ...options.handlers,
  };
  if (!handlerCtx.waitForPairDecision) {
    handlerCtx.waitForPairDecision = waitForPairDecision;
  }

  const handle = async (req: PeerHttpRequest): Promise<PeerHttpResponse> => {
    const method = (req.method || "GET").toUpperCase();
    const path = req.path.split("?")[0] || "/";

    if (method === "OPTIONS") {
      return jsonResponse(204, {}, cors);
    }

    try {
      if (method === "GET" && path === "/lyra/info") {
        const lan = options.getLanHost?.() ?? null;
        const pairingOffer = options.getPairingOffer?.() ?? undefined;
        const pairing =
          pairingOffer && pairingOffer.expiresAt > Date.now()
            ? {
                codeHash: pairingOffer.codeHash,
                token: pairingOffer.token,
                expiresAt: pairingOffer.expiresAt,
              }
            : undefined;
        return jsonResponse(
          200,
          {
            identity: options.getIdentity(),
            status: options.getStatus?.(),
            host: lan ?? undefined,
            port: options.getPort(),
            protocol,
            protocolVersion: LYRA_PROTOCOL_VERSION,
            tlsFingerprint: options.tlsFingerprint,
            pairing,
          },
          cors,
        );
      }

      if (method === "GET" && path === "/lyra/health") {
        return jsonResponse(200, { ok: true, deviceId: options.getIdentity().id }, cors);
      }

      if (method === "POST" && path === "/lyra/auth/challenge") {
        const challenge = await createAuthChallenge(options.getIdentity());
        challenges.set(challenge.challengeId, challenge);
        for (const [id, c] of challenges) {
          if (c.expiresAt < Date.now()) challenges.delete(id);
        }
        return jsonResponse(200, challenge, cors);
      }

      if (method === "POST" && path === "/lyra/auth/response") {
        let body: unknown;
        try {
          body = JSON.parse(req.body || "");
        } catch {
          return jsonResponse(400, { error: "Invalid JSON" }, cors);
        }
        const responseParsed = AuthResponsePayloadSchema.safeParse(body);
        if (!responseParsed.success) {
          return jsonResponse(400, { error: "Invalid auth response" }, cors);
        }
        const response = responseParsed.data;
        const challenge = challenges.get(response.challengeId);
        if (!challenge) {
          return jsonResponse(400, { error: "Unknown or expired challenge" }, cors);
        }
        challenges.delete(response.challengeId);

        const authHints = options.resolvePeerAuth?.({
          deviceId: response.deviceId,
          fingerprint: response.fingerprint,
          publicKey: response.publicKey,
        });

        if (authHints === null && !allowFirstContact) {
          return jsonResponse(401, { error: "Unknown peer" }, cors);
        }

        const hints = authHints ?? {};
        const hasShared = Boolean(hints.sharedSecret);
        const hasExpectedFp = Boolean(hints.expectedFingerprint);

        if (!allowFirstContact && !hasShared && !hasExpectedFp) {
          return jsonResponse(401, { error: "Pairing required" }, cors);
        }

        const verified = await verifyAuthResponse({
          challenge,
          response,
          expectedFingerprint: hints.expectedFingerprint,
          expectedDeviceId: hints.expectedDeviceId,
          sharedSecret: hints.sharedSecret,
          allowIdentityBinding: allowFirstContact && !hasShared,
        });

        if (!verified.ok) {
          return jsonResponse(401, { error: verified.error }, cors);
        }

        if (hints.sharedSecret && !verified.session.sharedSecret) {
          verified.session.sharedSecret = hints.sharedSecret;
        }

        sessions.set(verified.session.sessionToken, verified.session);
        return jsonResponse(200, toAuthOkPayload(verified.session), cors);
      }

      if (method === "POST" && path === "/lyra/message") {
        let body: unknown;
        try {
          body = JSON.parse(req.body || "");
        } catch {
          return jsonResponse(400, { error: "Invalid JSON" }, cors);
        }
        const parsed = parseEnvelope(body);
        if (!parsed.ok) {
          return jsonResponse(400, { error: parsed.error }, cors);
        }

        const authHeader = headerValue(req.headers, "authorization");
        let session: AuthSession | null = null;
        if (authHeader?.startsWith("Bearer ")) {
          const token = authHeader.slice(7);
          const s = sessions.get(token);
          if (s && s.expiresAt > Date.now()) session = s;
        }

        let envelope = parsed.envelope;

        if (isSealedPayload(envelope.payload)) {
          if (!session?.sharedSecret) {
            return jsonResponse(
              401,
              {
                error:
                  "Sealed payload requires a paired session (shared secret). Re-pair this device.",
              },
              cors,
            );
          }
          try {
            const opened = await openEnvelopePayload(session.sharedSecret, envelope.payload);
            envelope = { ...envelope, payload: opened };
          } catch {
            return jsonResponse(400, { error: "Failed to open sealed payload" }, cors);
          }
        }

        if (envelope.type === "pair_request" && envelope.payload && typeof envelope.payload === "object") {
          // TCP source is ground truth for callback. Joiner-advertised hosts are often
          // wrong on multi-homed desktops (docker/virbr) — that caused mobile→desktop
          // timeouts after a successful laptop→phone pair.
          const p = envelope.payload as {
            host?: string;
            port?: number;
            tailscaleHost?: string;
          };
          const remote = req.remoteAddress
            ?.replace(/^::ffff:/, "")
            .replace(/%.*$/, "")
            .trim();
          if (remote && remote !== "127.0.0.1" && remote !== "::1" && remote !== "0.0.0.0") {
            const isTs = (h: string) =>
              /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h.endsWith(".ts.net");
            const advertised = p.host?.trim();
            let host = remote;
            let tailscaleHost = p.tailscaleHost?.trim();
            if (advertised && advertised !== remote) {
              if (isTs(advertised) && !isTs(remote)) {
                host = remote;
                tailscaleHost = advertised;
              } else if (isTs(remote) && !isTs(advertised)) {
                host = advertised;
                tailscaleHost = remote;
              }
            }
            envelope = {
              ...envelope,
              payload: {
                ...p,
                host,
                ...(tailscaleHost ? { tailscaleHost } : {}),
              },
            };
          }
        }

        const msgType = envelope.type;
        if (requireAuth && !PUBLIC_MESSAGE_TYPES.has(msgType) && !session) {
          return jsonResponse(401, { error: "Auth required" }, cors);
        }

        if (options.onEnvelope) {
          const reply = await options.onEnvelope(envelope, session);
          if (reply) {
            const out = await maybeSealReply(reply, session, sealReplies);
            return jsonResponse(200, out, cors);
          }
        }

        const builtin = await handlePeerEnvelope(envelope, session, handlerCtx);
        const out = await maybeSealReply(builtin, session, sealReplies);
        return jsonResponse(200, out, cors);
      }

      return jsonResponse(404, { error: "Not found" }, cors);
    } catch (e) {
      return jsonResponse(500, { error: e instanceof Error ? e.message : String(e) }, cors);
    }
  };

  return {
    handle,
    getSessions: () => sessions,
    revokeDevice: (deviceId: string) => {
      let n = 0;
      for (const [token, s] of sessions) {
        if (s.deviceId === deviceId) {
          sessions.delete(token);
          n++;
        }
      }
      return n;
    },
    resolvePairRequest,
    pendingPairCount: () => pendingPairs.size,
  };
}
