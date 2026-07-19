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
  const port = options.port ?? LYRA_DEFAULT_PORT;
  const host = options.host ?? "0.0.0.0";
  const challenges = new Map<string, AuthChallengePayload>();
  const sessions = new Map<string, AuthSession>();
  const transfers = new Map<string, TransferReceiveState>();
  const requireAuth = options.requireAuthForMessages !== false;
  const allowFirstContact = options.allowFirstContactAuth !== false;
  const sealReplies = options.sealReplies !== false;

  const handlerCtx: MessageHandlerContext = {
    identity: options.identity,
    transfers,
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
    if (req.method === "OPTIONS") {
      sendJson(res, req, 204, {}, cors);
      return;
    }

    const protocol = tlsMaterial ? "https" : "http";
    const url = new URL(req.url ?? "/", `${protocol}://${req.headers.host ?? "localhost"}`);

    try {
      if (req.method === "GET" && url.pathname === "/lyra/info") {
        const lan = getLocalIPv4();
        const pairingOffer = options.getPairingOffer?.() ?? undefined;
        sendJson(
          res,
          req,
          200,
          {
            identity: options.identity,
            status: options.getStatus?.(),
            host: lan ?? undefined,
            port,
            protocol: protocol,
            protocolVersion: LYRA_PROTOCOL_VERSION,
            tlsFingerprint: tlsMaterial?.fingerprintSha256,
            pairing:
              pairingOffer && pairingOffer.expiresAt > Date.now()
                ? {
                    codeHash: pairingOffer.codeHash,
                    token: pairingOffer.token,
                    expiresAt: pairingOffer.expiresAt,
                  }
                : undefined,
          },
          cors,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/lyra/health") {
        sendJson(res, req, 200, { ok: true, deviceId: options.identity.id }, cors);
        return;
      }

      if (req.method === "POST" && url.pathname === "/lyra/auth/challenge") {
        const challenge = await createAuthChallenge(options.identity);
        challenges.set(challenge.challengeId, challenge);
        // GC expired
        for (const [id, c] of challenges) {
          if (c.expiresAt < Date.now()) challenges.delete(id);
        }
        sendJson(res, req, 200, challenge, cors);
        return;
      }

      if (req.method === "POST" && url.pathname === "/lyra/auth/response") {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, req, 400, { error: "Invalid JSON" }, cors);
          return;
        }
        const responseParsed = AuthResponsePayloadSchema.safeParse(body);
        if (!responseParsed.success) {
          sendJson(res, req, 400, { error: "Invalid auth response" }, cors);
          return;
        }
        const response = responseParsed.data;
        const challenge = challenges.get(response.challengeId);
        if (!challenge) {
          sendJson(res, req, 400, { error: "Unknown or expired challenge" }, cors);
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
          sendJson(res, req, 401, { error: "Unknown peer" }, cors);
          return;
        }

        const hints = authHints ?? {};
        const hasShared = Boolean(hints.sharedSecret);
        const hasExpectedFp = Boolean(hints.expectedFingerprint);

        // When first-contact is disabled, require known fingerprint or shared secret
        if (!allowFirstContact && !hasShared && !hasExpectedFp) {
          sendJson(res, req, 401, { error: "Pairing required" }, cors);
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
          sendJson(res, req, 401, { error: verified.error }, cors);
          return;
        }

        // Attach shared secret from registry even if proof was ECDSA
        if (hints.sharedSecret && !verified.session.sharedSecret) {
          verified.session.sharedSecret = hints.sharedSecret;
        }

        sessions.set(verified.session.sessionToken, verified.session);
        sendJson(res, req, 200, toAuthOkPayload(verified.session), cors);
        return;
      }

      if (req.method === "POST" && url.pathname === "/lyra/message") {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, req, 400, { error: "Invalid JSON" }, cors);
          return;
        }
        const parsed = parseEnvelope(body);
        if (!parsed.ok) {
          sendJson(res, req, 400, { error: parsed.error }, cors);
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
            sendJson(res, req, 400, { error: "Failed to open sealed payload" }, cors);
            return;
          }
        }

        // For pair_request, fill missing host from the TCP peer so mutual pairing can call back
        if (envelope.type === "pair_request" && envelope.payload && typeof envelope.payload === "object") {
          const p = envelope.payload as { host?: string };
          if (!p.host || p.host === "127.0.0.1" || p.host === "0.0.0.0" || p.host === "localhost") {
            const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "");
            if (remote && remote !== "127.0.0.1" && remote !== "::1") {
              envelope = {
                ...envelope,
                payload: { ...p, host: remote },
              };
            }
          }
        }

        const msgType = envelope.type;
        if (requireAuth && !PUBLIC_MESSAGE_TYPES.has(msgType) && !session) {
          sendJson(res, req, 401, { error: "Auth required" }, cors);
          return;
        }

        // Custom handler first (Electron / CLI can override)
        if (options.onEnvelope) {
          const reply = await options.onEnvelope(envelope, session);
          if (reply) {
            const out = await maybeSealReply(reply, session, sealReplies);
            sendJson(res, req, 200, out, cors);
            return;
          }
        }

        // Built-in protocol handlers (clipboard, transfer chunks, fs, pair, ping…)
        const builtin = await handlePeerEnvelope(envelope, session, handlerCtx);
        const out = await maybeSealReply(builtin, session, sealReplies);
        sendJson(res, req, 200, out, cors);
        return;
      }

      sendJson(res, req, 404, { error: "Not found" }, cors);
    } catch (e) {
      sendJson(
        res,
        req,
        500,
        { error: e instanceof Error ? e.message : String(e) },
        cors,
      );
    }
  };

  const server: HttpServer | HttpsServer = tlsMaterial
    ? createHttpsServer({ key: tlsMaterial.key, cert: tlsMaterial.cert }, requestListener)
    : createServer(requestListener);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : port;
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
    close: () =>
      new Promise((resolve, reject) => {
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
