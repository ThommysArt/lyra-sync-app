import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { networkInterfaces } from "node:os";

import {
  AuthResponsePayloadSchema,
  LYRA_DEFAULT_PORT,
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
} from "../auth";
import { parseEnvelope } from "../envelope";
import {
  handlePeerEnvelope,
  PUBLIC_MESSAGE_TYPES,
  type MessageHandlerContext,
  type TransferReceiveState,
} from "../message-handlers";
import { isSealedPayload, openEnvelopePayload, sealEnvelopePayload } from "../peer-client";
import type { AuthChallengePayload } from "@lyra-sync-app/protocol";
import {
  appendDiskChunk,
  cleanupDiskTransfer,
  createDiskTransferState,
  finalizeDiskTransfer,
} from "./transfer-disk";
import { tryCreateSelfSignedTls } from "./tls-certs";

export type PeerServerOptions = {
  identity: DeviceIdentity;
  /** Optional status payload returned from /lyra/info */
  getStatus?: () => DeviceStatus | undefined;
  /**
   * Active pairing offer advertised on /lyra/info (code hash only — never raw code).
   */
  getPairingOffer?: () =>
    | {
        codeHash: string;
        token: string;
        expiresAt: number;
      }
    | undefined
    | null;
  port?: number;
  host?: string;
  /**
   * Enable HTTPS with self-signed cert (when openssl available) or explicit key/cert.
   * true = try self-signed; {key,cert} = use provided PEM; false/undefined = HTTP.
   */
  tls?: boolean | { key: string; cert: string };
  /**
   * Lookup trusted peer auth material. Return sharedSecret when paired.
   * For first-contact identity-binding, return {}.
   * Return `null` to reject first-contact when only paired peers are allowed.
   */
  resolvePeerAuth?: (input: {
    deviceId: string;
    fingerprint: string;
    publicKey: string;
  }) =>
    | { sharedSecret?: string; expectedFingerprint?: string; expectedDeviceId?: string }
    | null
    | undefined;
  /**
   * When true (default), unpaired first-contact identity-binding proofs are accepted.
   * Set false to require a known paired fingerprint via resolvePeerAuth.
   */
  allowFirstContactAuth?: boolean;
  /** Require Bearer session for non-public message types (default true). */
  requireAuthForMessages?: boolean;
  /** Encrypt reply payloads with session.sharedSecret when present (default true). */
  sealReplies?: boolean;
  /** Built-in handlers for clipboard / fs / transfer / pair (merged with onEnvelope). */
  handlers?: Omit<MessageHandlerContext, "identity" | "transfers" | "revokeDeviceSessions">;
  /** Handle protocol envelopes (runs after built-in handlers when provided as override). */
  onEnvelope?: (
    envelope: Envelope,
    session: AuthSession | null,
  ) => Promise<Envelope | Record<string, unknown> | void> | Envelope | Record<string, unknown> | void;
  /**
   * CORS: true = allow any origin (LAN default), false = no CORS headers,
   * string[] = allowlist. Prefer allowlist in production desktop builds.
   */
  cors?: boolean | string[];
};

export type PeerPairDecision =
  | { accepted: true; host?: string; port?: number }
  | { accepted: false; reason?: string };

export type PeerServer = {
  server: HttpServer | HttpsServer;
  port: number;
  host: string;
  url: string;
  /** http or https */
  protocol: "http" | "https";
  /** SHA-256 fingerprint of TLS cert when HTTPS */
  tlsFingerprint?: string;
  close: () => Promise<void>;
  getSessions: () => Map<string, AuthSession>;
  revokeDevice: (deviceId: string) => number;
  /**
   * Resolve a waiting pair_request (host user Accept / Decline).
   * Keyed by joiner deviceId and/or pairing token.
   */
  resolvePairRequest: (
    key: { deviceId?: string; token?: string },
    decision: PeerPairDecision,
  ) => boolean;
  /** Update advertised identity without restarting the server. */
  setIdentity: (identity: DeviceIdentity) => void;
  getIdentity: () => DeviceIdentity;
  /** Local non-loopback IPv4 when available */
  getLanHost: () => string | null;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function applyCors(
  res: ServerResponse,
  req: IncomingMessage,
  cors: boolean | string[] | undefined,
) {
  if (cors === false) return;
  const origin = req.headers.origin;
  if (cors === true || cors === undefined) {
    // Reflect request origin when present (credentials-friendly LAN); else *
    res.setHeader("access-control-allow-origin", origin || "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (origin) res.setHeader("vary", "Origin");
    return;
  }
  if (Array.isArray(cors) && origin && cors.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("vary", "Origin");
  }
}

function sendJson(
  res: ServerResponse,
  req: IncomingMessage,
  status: number,
  body: unknown,
  cors: boolean | string[] | undefined = true,
) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  applyCors(res, req, cors);
  res.end(payload);
}

function getLocalIPv4(): string | null {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

export async function startPeerServer(options: PeerServerOptions): Promise<PeerServer> {
  const requestedPort = options.port ?? LYRA_DEFAULT_PORT;
  const host = options.host ?? "0.0.0.0";
  /** Updated after listen when port is 0 (ephemeral) */
  let boundPort = requestedPort;
  const challenges = new Map<string, AuthChallengePayload>();
  const sessions = new Map<string, AuthSession>();
  const transfers = new Map<string, TransferReceiveState>();
  const requireAuth = options.requireAuthForMessages !== false;
  const allowFirstContact = options.allowFirstContactAuth !== false;
  const sealReplies = options.sealReplies !== false;

  /** Mutable identity so renderer can sync after hydrate */
  let currentIdentity: DeviceIdentity = options.identity;

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
    // Replace any stale waiter for the same joiner/token
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
    // Match by exact key, or by deviceId / token alone
    let matched = false;
    for (const [k, pending] of pendingPairs) {
      const byDevice = key.deviceId && pending.deviceId === key.deviceId;
      const byToken = key.token && pending.token === key.token;
      if (byDevice || byToken || (key.deviceId && key.token && k === pairKey(key.deviceId, key.token))) {
        pending.resolve(decision);
        matched = true;
        // Only resolve one waiter per call when deviceId is unique; break after first if both set
        if (key.deviceId && key.token) break;
      }
    }
    return matched;
  };

  const handlerCtx: MessageHandlerContext = {
    get identity() {
      return currentIdentity;
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
    createDiskTransfer: async (input) => {
      const disk = await createDiskTransferState(input);
      const state: TransferReceiveState = {
        transferId: disk.transferId,
        totalBytes: disk.totalBytes,
        receivedBytes: disk.receivedBytes,
        files: disk.files,
        chunks: [],
        paused: false,
        checksums: disk.checksums,
        diskPath: disk.filePath,
        appendChunk: async (bytes, offset) => {
          await appendDiskChunk(disk, bytes, offset);
          state.receivedBytes = disk.receivedBytes;
        },
        finalizeDisk: async () => {
          const fin = await finalizeDiskTransfer(disk);
          return fin;
        },
        cleanupDisk: async () => {
          await cleanupDiskTransfer(disk);
        },
      };
      return state;
    },
    ...options.handlers,
  };

  // Ensure waitForPairDecision is not overwritten by handlers spread if they omit it
  if (!handlerCtx.waitForPairDecision) {
    handlerCtx.waitForPairDecision = waitForPairDecision;
  }

  let tlsMaterial: { key: string; cert: string; fingerprintSha256?: string } | null = null;
  if (options.tls === true) {
    const generated = tryCreateSelfSignedTls({
      commonName: options.identity.name || "lyra-peer.local",
    });
    if (generated) {
      tlsMaterial = generated;
    } else {
      console.warn(
        "[lyra peer] HTTPS requested but self-signed cert generation failed (install openssl). Falling back to HTTP + app-level seal.",
      );
    }
  } else if (options.tls && typeof options.tls === "object") {
    tlsMaterial = { key: options.tls.key, cert: options.tls.cert };
  }

  const requestListener = async (req: IncomingMessage, res: ServerResponse) => {
    const cors = options.cors;
    const started = Date.now();
    const remote =
      req.socket.remoteAddress?.replace(/^::ffff:/, "").replace(/%.*$/, "") ?? "?";
    if (req.method === "OPTIONS") {
      sendJson(res, req, 204, {}, cors);
      return;
    }

    const protocol = tlsMaterial ? "https" : "http";
    const url = new URL(req.url ?? "/", `${protocol}://${req.headers.host ?? "localhost"}`);
    const logDone = (status: number, note?: string) => {
      const path = url.pathname;
      // Always log pair/auth/message; sample /lyra/info probes (discovery floods)
      const interesting =
        path !== "/lyra/info" && path !== "/lyra/health"
          ? true
          : req.method !== "GET" || Boolean(note);
      if (interesting || Math.random() < 0.05) {
        console.log(
          `[lyra peer] ${req.method} ${path} ← ${remote} → ${status} ${Date.now() - started}ms` +
            (note ? ` · ${note}` : ""),
        );
      }
    };

    // Wrap sendJson for consistent access logging on early returns
    const respond = (status: number, body: unknown, note?: string) => {
      logDone(status, note);
      sendJson(res, req, status, body, cors);
    };

    try {
      if (req.method === "GET" && url.pathname === "/lyra/info") {
        const lan = getLocalIPv4();
        const pairingOffer = options.getPairingOffer?.() ?? undefined;
        const pairing =
          pairingOffer && pairingOffer.expiresAt > Date.now()
            ? {
                codeHash: pairingOffer.codeHash,
                token: pairingOffer.token,
                expiresAt: pairingOffer.expiresAt,
              }
            : undefined;
        if (pairing) {
          console.log(
            "[lyra peer] /lyra/info pairing offer",
            pairing.codeHash.slice(0, 12),
            "→",
            remote,
          );
        }
        respond(200, {
          identity: currentIdentity,
          status: options.getStatus?.(),
          host: lan ?? undefined,
          port: boundPort,
          protocol: protocol,
          protocolVersion: LYRA_PROTOCOL_VERSION,
          tlsFingerprint: tlsMaterial?.fingerprintSha256,
          pairing,
        }, pairing ? "offer" : undefined);
        return;
      }

      if (req.method === "GET" && url.pathname === "/lyra/health") {
        respond(200, { ok: true, deviceId: currentIdentity.id });
        return;
      }

      if (req.method === "POST" && url.pathname === "/lyra/auth/challenge") {
        const challenge = await createAuthChallenge(currentIdentity);
        challenges.set(challenge.challengeId, challenge);
        // GC expired
        for (const [id, c] of challenges) {
          if (c.expiresAt < Date.now()) challenges.delete(id);
        }
        respond(200, challenge, "auth challenge");
        return;
      }

      if (req.method === "POST" && url.pathname === "/lyra/auth/response") {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          respond(400, { error: "Invalid JSON" });
          return;
        }
        const responseParsed = AuthResponsePayloadSchema.safeParse(body);
        if (!responseParsed.success) {
          respond(400, { error: "Invalid auth response" });
          return;
        }
        const response = responseParsed.data;
        const challenge = challenges.get(response.challengeId);
        if (!challenge) {
          respond(400, { error: "Unknown or expired challenge" });
          return;
        }
        challenges.delete(response.challengeId);

        const authHints = options.resolvePeerAuth?.({
          deviceId: response.deviceId,
          fingerprint: response.fingerprint,
          publicKey: response.publicKey,
        });

        // Explicit reject from resolver
        if (authHints === null && !allowFirstContact) {
          respond(401, { error: "Unknown peer" });
          return;
        }

        const hints = authHints ?? {};
        const hasShared = Boolean(hints.sharedSecret);
        const hasExpectedFp = Boolean(hints.expectedFingerprint);

        // When first-contact is disabled, require known fingerprint or shared secret
        if (!allowFirstContact && !hasShared && !hasExpectedFp) {
          respond(401, { error: "Pairing required" });
          return;
        }

        const verified = await verifyAuthResponse({
          challenge,
          response,
          expectedFingerprint: hints.expectedFingerprint,
          expectedDeviceId: hints.expectedDeviceId,
          sharedSecret: hints.sharedSecret,
          // Allow ECDSA + shared secret always; identity-binding only if first-contact allowed
          allowIdentityBinding: allowFirstContact && !hasShared,
        });

        if (!verified.ok) {
          respond(401, { error: verified.error });
          return;
        }

        // Attach shared secret from registry even if proof was ECDSA
        if (hints.sharedSecret && !verified.session.sharedSecret) {
          verified.session.sharedSecret = hints.sharedSecret;
        }

        sessions.set(verified.session.sessionToken, verified.session);
        respond(200, toAuthOkPayload(verified.session), `auth ok ${response.deviceId}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/lyra/message") {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          respond(400, { error: "Invalid JSON" });
          return;
        }
        const parsed = parseEnvelope(body);
        if (!parsed.ok) {
          respond(400, { error: parsed.error });
          return;
        }

        const authHeader = req.headers.authorization;
        let session: AuthSession | null = null;
        if (authHeader?.startsWith("Bearer ")) {
          const token = authHeader.slice(7);
          const s = sessions.get(token);
          if (s && s.expiresAt > Date.now()) session = s;
        }

        let envelope = parsed.envelope;

        // Unseal AES-GCM payloads when session has shared secret (encryption default)
        if (session?.sharedSecret && isSealedPayload(envelope.payload)) {
          try {
            const opened = await openEnvelopePayload(session.sharedSecret, envelope.payload);
            envelope = { ...envelope, payload: opened };
          } catch {
            respond(400, { error: "Failed to open sealed payload" });
            return;
          }
        }

        // TCP source is ground truth for callback (multi-homed joiners advertise wrong hosts)
        if (envelope.type === "pair_request" && envelope.payload && typeof envelope.payload === "object") {
          const p = envelope.payload as { host?: string; tailscaleHost?: string; name?: string };
          const tcpRemote = req.socket.remoteAddress
            ?.replace(/^::ffff:/, "")
            .replace(/%.*$/, "")
            .trim();
          if (tcpRemote && tcpRemote !== "127.0.0.1" && tcpRemote !== "::1" && tcpRemote !== "0.0.0.0") {
            const advertised = p.host?.trim();
            const same = advertised === tcpRemote;
            const isTs = (h: string) =>
              /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h.endsWith(".ts.net");
            let host = tcpRemote;
            let tailscaleHost = p.tailscaleHost;
            if (advertised && !same) {
              if (isTs(advertised) && !isTs(tcpRemote)) tailscaleHost = advertised;
              else if (isTs(tcpRemote) && !isTs(advertised)) {
                host = advertised;
                tailscaleHost = tcpRemote;
              }
            }
            envelope = {
              ...envelope,
              payload: { ...p, host, ...(tailscaleHost ? { tailscaleHost } : {}) },
            };
          }
          console.log(
            `[lyra peer] pair_request from ${p.name ?? envelope.fromDeviceId} ← ${tcpRemote ?? remote} (long-poll until Accept)`,
          );
        }

        const msgType = envelope.type;
        if (requireAuth && !PUBLIC_MESSAGE_TYPES.has(msgType) && !session) {
          respond(401, { error: "Auth required" }, msgType);
          return;
        }

        // Custom handler first (Electron / CLI can override)
        if (options.onEnvelope) {
          const reply = await options.onEnvelope(envelope, session);
          if (reply) {
            const out = await maybeSealReply(reply, session, sealReplies);
            respond(200, out, msgType);
            return;
          }
        }

        // Built-in protocol handlers (clipboard, transfer chunks, fs, pair, ping…)
        // pair_request blocks here until host Accept/Decline
        const builtin = await handlePeerEnvelope(envelope, session, handlerCtx);
        const out = await maybeSealReply(builtin, session, sealReplies);
        const replyType =
          out && typeof out === "object" && out !== null && "type" in out
            ? String((out as { type: string }).type)
            : msgType;
        respond(200, out, replyType);
        return;
      }

      respond(404, { error: "Not found" });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.warn(`[lyra peer] request error ← ${remote}:`, err);
      respond(500, { error: err });
    }
  };

  const server: HttpServer | HttpsServer = tlsMaterial
    ? createHttpsServer({ key: tlsMaterial.key, cert: tlsMaterial.cert }, requestListener)
    : createServer(requestListener);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const address = server.address();
  boundPort = address && typeof address === "object" ? address.port : requestedPort;
  const protocol = tlsMaterial ? "https" : "http";

  return {
    server,
    port: boundPort,
    host,
    protocol,
    tlsFingerprint: tlsMaterial?.fingerprintSha256,
    url: `${protocol}://127.0.0.1:${boundPort}`,
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
    setIdentity: (next) => {
      currentIdentity = next;
    },
    getIdentity: () => currentIdentity,
    getLanHost: () => getLocalIPv4(),
    close: () =>
      new Promise((resolve, reject) => {
        for (const pending of pendingPairs.values()) {
          clearTimeout(pending.timer);
          pending.resolve({ accepted: false, reason: "server_closing" });
        }
        pendingPairs.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function maybeSealReply(
  reply: Envelope | Record<string, unknown>,
  session: AuthSession | null,
  sealReplies: boolean,
): Promise<Envelope | Record<string, unknown>> {
  if (!sealReplies || !session?.sharedSecret) return reply;
  if (!reply || typeof reply !== "object") return reply;
  if (!("payload" in reply) || !("type" in reply)) return reply;
  try {
    const sealed = await sealEnvelopePayload(session.sharedSecret, (reply as Envelope).payload);
    return { ...(reply as Envelope), payload: sealed };
  } catch {
    return reply;
  }
}
