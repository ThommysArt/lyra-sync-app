import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
import type { AuthChallengePayload } from "@lyra-sync-app/protocol";

export type PeerServerOptions = {
  identity: DeviceIdentity;
  /** Optional status payload returned from /lyra/info */
  getStatus?: () => DeviceStatus | undefined;
  port?: number;
  host?: string;
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
  /** Built-in handlers for clipboard / fs / transfer / pair (merged with onEnvelope). */
  handlers?: Omit<MessageHandlerContext, "identity" | "transfers">;
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
  server: Server;
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
  getSessions: () => Map<string, AuthSession>;
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

  const handlerCtx: MessageHandlerContext = {
    identity: options.identity,
    transfers,
    ...options.handlers,
  };

  const server = createServer(async (req, res) => {
    const cors = options.cors;
    if (req.method === "OPTIONS") {
      sendJson(res, req, 204, {}, cors);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    try {
      if (req.method === "GET" && url.pathname === "/lyra/info") {
        const lan = getLocalIPv4();
        sendJson(
          res,
          req,
          200,
          {
            identity: options.identity,
            status: options.getStatus?.(),
            host: lan ?? undefined,
            port,
            protocolVersion: LYRA_PROTOCOL_VERSION,
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
        });

        if (!verified.ok) {
          sendJson(res, req, 401, { error: verified.error }, cors);
          return;
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

        const msgType = parsed.envelope.type;
        if (requireAuth && !PUBLIC_MESSAGE_TYPES.has(msgType) && !session) {
          sendJson(res, req, 401, { error: "Auth required" }, cors);
          return;
        }

        // Custom handler first (Electron / CLI can override)
        if (options.onEnvelope) {
          const reply = await options.onEnvelope(parsed.envelope, session);
          if (reply) {
            sendJson(res, req, 200, reply, cors);
            return;
          }
        }

        // Built-in protocol handlers (clipboard, transfer chunks, fs, pair, ping…)
        const builtin = await handlePeerEnvelope(parsed.envelope, session, handlerCtx);
        sendJson(res, req, 200, builtin, cors);
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
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : port;

  return {
    server,
    port: boundPort,
    host,
    url: `http://127.0.0.1:${boundPort}`,
    getSessions: () => sessions,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
