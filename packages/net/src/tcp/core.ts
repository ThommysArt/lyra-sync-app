// @ts-nocheck
/**
 * Lyra TCP peer core — replaces peer-http-core for persistent TCP.
 * No HTTP. Envelope handling + binary chunk handling share same transfers map.
 */

import {
  LYRA_PROTOCOL_VERSION,
  type DeviceIdentity,
  type DeviceStatus,
  type Envelope,
} from "@lyra-sync-app/protocol";
import { AuthResponsePayloadSchema } from "@lyra-sync-app/protocol";
import {
  createAuthChallenge,
  toAuthOkPayload,
  verifyAuthResponse,
  type AuthSession,
  type AuthChallengePayload,
} from "../auth";
import { parseEnvelope } from "../envelope";
import {
  handlePeerEnvelope,
  PUBLIC_MESSAGE_TYPES,
  type MessageHandlerContext,
  type TransferReceiveState,
} from "../message-handlers";
import { isSealedPayload, openEnvelopePayload, sealEnvelopePayload } from "../peer-client";
import type { AuthChallengePayload as ProtoAuthChallengePayload } from "@lyra-sync-app/protocol";

export type TcpPeerCoreOptions = {
  getIdentity: () => DeviceIdentity;
  getStatus?: () => DeviceStatus | undefined;
  getPairingOffer?: () =>
    | { codeHash: string; token: string; expiresAt: number }
    | undefined
    | null;
  getPort: () => number;
  getLanHost?: () => string | null;
  protocol?: "tcp";
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
};

export type TcpPeerCore = {
  handleEnvelope: (
    envelope: Envelope,
    session: AuthSession | null,
    remoteAddress?: string | null,
  ) => Promise<Envelope | Record<string, unknown>>;
  handleBinaryChunk: (
    header: { transferId: string; offset: number; eof: boolean },
    data: Uint8Array,
    session: AuthSession | null,
  ) => Promise<{ ok: true; receivedBytes: number } | { ok: false; error: string }>;
  getSessions: () => Map<string, AuthSession>;
  revokeDevice: (deviceId: string) => number;
  resolvePairRequest: (
    key: { deviceId?: string; token?: string },
    decision: { accepted: true; host?: string; port?: number } | { accepted: false; reason?: string },
  ) => boolean;
  pendingPairCount: () => number;
  getTransfers: () => Map<string, TransferReceiveState>;
  pauseTransfer: (transferId: string) => boolean;
  resumeTransfer: (transferId: string, offset?: number) => boolean;
  cancelTransfer: (transferId: string) => boolean;
};

function maybeSealReply(
  reply: Envelope | Record<string, unknown>,
  session: AuthSession | null,
  sealReplies: boolean,
): Promise<Envelope | Record<string, unknown>> {
  if (!sealReplies || !session?.sharedSecret) return Promise.resolve(reply);
  if (!("type" in reply) || typeof (reply as any).type !== "string") return Promise.resolve(reply);
  const env = reply as Envelope;
  if (env.payload === undefined) return Promise.resolve(reply);
  return sealEnvelopePayload(session.sharedSecret, env.payload)
    .then((sealed) => ({ ...env, payload: sealed }))
    .catch(() => reply);
}

export function createTcpPeerCore(options: TcpPeerCoreOptions): TcpPeerCore {
  const challenges = new Map<string, AuthChallengePayload>();
  const sessions = new Map<string, AuthSession>();
  const transfers = new Map<string, TransferReceiveState>();
  const requireAuth = options.requireAuthForMessages !== false;
  const allowFirstContact = options.allowFirstContactAuth !== false;
  const sealReplies = options.sealReplies !== false;

  type PendingPair = {
    deviceId: string;
    token: string;
    resolve: (decision: { accepted: true; host?: string; port?: number } | { accepted: false; reason?: string }) => void;
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
    return new Promise((resolve) => {
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
    decision: { accepted: true; host?: string; port?: number } | { accepted: false; reason?: string },
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

  const handleEnvelope = async (
    envelope: Envelope,
    session: AuthSession | null,
    remoteAddress?: string | null,
  ): Promise<Envelope | Record<string, unknown>> => {
    // pair_request remote host fix — same logic as peer-http-core, but from TCP remoteAddress
    if (envelope.type === "pair_request" && envelope.payload && typeof envelope.payload === "object") {
      const p = envelope.payload as { host?: string; port?: number; tailscaleHost?: string; name?: string };
      const remote = remoteAddress?.replace(/^::ffff:/, "").replace(/%.*$/, "").trim();
      if (remote && remote !== "127.0.0.1" && remote !== "::1" && remote !== "0.0.0.0") {
        const isTs = (h: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h.endsWith(".ts.net");
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
          payload: { ...p, host, ...(tailscaleHost ? { tailscaleHost } : {}) },
        };
      }
      console.info(
        `[lyra core] pair_request from ${p.name ?? envelope.fromDeviceId} ← ${remote ?? "?"} (blocking until Accept)`,
      );
    }

    // sealed payload handling
    if (isSealedPayload(envelope.payload)) {
      if (!session?.sharedSecret) {
        return { ok: false, error: "Sealed payload requires a paired session (shared secret). Re-pair this device." };
      }
      try {
        const opened = await openEnvelopePayload(session.sharedSecret, envelope.payload as any);
        envelope = { ...envelope, payload: opened as any };
      } catch {
        return { ok: false, error: "Failed to open sealed payload" };
      }
    }

    const msgType = envelope.type;
    if (requireAuth && !PUBLIC_MESSAGE_TYPES.has(msgType) && !session) {
      return { ok: false, error: "Auth required" } as unknown as Envelope;
    }

    if (options.onEnvelope) {
      const reply = await options.onEnvelope(envelope, session);
      if (reply) {
        const out = await maybeSealReply(reply as Envelope, session, sealReplies);
        return out;
      }
    }

    const builtin = await handlePeerEnvelope(envelope, session, handlerCtx);
    const out = await maybeSealReply(builtin as Envelope, session, sealReplies);
    return out;
  };

  const handleBinaryChunk = async (
    header: { transferId: string; offset: number; eof: boolean },
    data: Uint8Array,
    session: AuthSession | null,
  ): Promise<{ ok: true; receivedBytes: number } | { ok: false; error: string }> => {
    if (requireAuth && !session) {
      return { ok: false, error: "Auth required" };
    }
    if (data.byteLength > 4 * 1024 * 1024 + 1024) return { ok: false, error: "Chunk too large" };
    let state = transfers.get(header.transferId);
    if (!state) return { ok: false, error: "Unknown transfer" };
    if (state.paused) return { ok: true, receivedBytes: state.receivedBytes };

    if (!state.pendingChunks) state.pendingChunks = new Map();
    const offset = header.offset;
    const eof = header.eof;

    if (state.appendChunk) {
      if (offset === state.receivedBytes) {
        try {
          await state.appendChunk(data, offset);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "Disk write failed" };
        }
        while (state.pendingChunks.has(state.receivedBytes)) {
          const next = state.pendingChunks.get(state.receivedBytes)!;
          state.pendingChunks.delete(state.receivedBytes);
          try {
            await state.appendChunk(next, state.receivedBytes);
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "Disk write failed" };
          }
        }
      } else if (offset > state.receivedBytes) {
        if (!state.pendingChunks.has(offset)) {
          state.pendingChunks.set(offset, data);
          if (state.pendingChunks.size > 256) return { ok: false, error: "Too many out-of-order" };
        }
        return { ok: true, receivedBytes: state.receivedBytes };
      } else {
        return { ok: true, receivedBytes: state.receivedBytes };
      }
    } else {
      const chunkEnd = offset + data.byteLength;
      if (offset === state.receivedBytes) {
        state.chunks.push(data);
        state.receivedBytes = chunkEnd;
        while (state.pendingChunks.has(state.receivedBytes)) {
          const next = state.pendingChunks.get(state.receivedBytes)!;
          state.pendingChunks.delete(state.receivedBytes);
          state.chunks.push(next);
          state.receivedBytes += next.byteLength;
        }
      } else if (offset > state.receivedBytes) {
        if (!state.pendingChunks.has(offset)) state.pendingChunks.set(offset, data);
        return { ok: true, receivedBytes: state.receivedBytes };
      } else {
        return { ok: true, receivedBytes: state.receivedBytes };
      }
    }

    const now = Date.now();
    const last = (state as unknown as { _lastChunkNotify?: number })._lastChunkNotify ?? 0;
    if (eof || now - last > 80) {
      (state as unknown as { _lastChunkNotify?: number })._lastChunkNotify = now;
      try {
        await handlerCtx.onTransferChunk?.(state, session?.deviceId ?? "unknown");
      } catch {}
    }
    return { ok: true, receivedBytes: state.receivedBytes };
  };

  return {
    handleEnvelope,
    handleBinaryChunk,
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
    getTransfers: () => transfers,
    pauseTransfer: (transferId: string) => {
      const s = transfers.get(transferId);
      if (!s) return false;
      s.paused = true;
      return true;
    },
    resumeTransfer: (transferId: string, offset?: number) => {
      const s = transfers.get(transferId);
      if (!s) return false;
      s.paused = false;
      if (typeof offset === "number") s.receivedBytes = offset;
      return true;
    },
    cancelTransfer: (transferId: string) => {
      const s = transfers.get(transferId);
      if (s) {
        void s.cleanupDisk?.();
        transfers.delete(transferId);
        return true;
      }
      return false;
    },
  };
}
