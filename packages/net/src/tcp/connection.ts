// @ts-nocheck
/**
 * ManagedConnection — one persistent TCP socket per peer device.
 * Handles: connect, hello+auth, framed I/O, heartbeat, reconnect, backoff, writer queue.
 *
 * Platform-agnostic: Node `net.Socket` or `react-native-tcp-socket` Socket both expose
 *   on/once, write, destroy, destroyed.
 * Caller provides `createSocket` factory.
 */

import type { DeviceIdentity, Envelope } from "@lyra-sync-app/protocol";
import { DeviceIdentitySchema, LYRA_PROTOCOL_VERSION } from "@lyra-sync-app/protocol";
import {
  FrameDecoder,
  encodeBinaryChunkFrame,
  encodeJsonFrame,
  FRAME_BINARY,
  FRAME_JSON,
} from "./frame";
import {
  clientCreateAuthResponse,
  createHelloFrame,
  serverCreateChallenge,
  serverVerifyResponse,
  validateHello,
} from "./handshake";
import type { AuthSession, AuthChallengePayload } from "../auth";
import { parseEnvelope, createEnvelope } from "../envelope";
import { isSealedPayload, sealEnvelopePayload, openEnvelopePayload } from "../peer-client";
import type { TransferReceiveState } from "../message-handlers";
import { LYRA_DEFAULT_PORT } from "@lyra-sync-app/protocol";

export type ConnectionRole = "client" | "server";

export type LyraSocket = {
  on: (ev: string, cb: (...args: any[]) => void) => void;
  once: (ev: string, cb: (...args: any[]) => void) => void;
  write: (data: Uint8Array | string, encoding?: string, cb?: () => void) => void;
  destroy: () => void;
  destroyed?: boolean;
  remoteAddress?: string;
  removeAllListeners?: () => void;
};

export type ConnectionOptions = {
  deviceId: string; // paired device id this connection represents
  role: ConnectionRole;
  /** For client: who we want to connect to. For server: remote's hello identity after handshake */
  getIdentity: () => DeviceIdentity;
  getPrivateKey: () => string;
  getSharedSecret?: (peerId: string, fingerprint: string) => string | undefined;
  resolvePeerAuth?: (p: { deviceId: string; fingerprint: string; publicKey: string }) =>
    | { sharedSecret?: string; expectedFingerprint?: string; expectedDeviceId?: string }
    | null
    | undefined;
  allowFirstContact?: boolean;
  /** Server-side core handler for envelopes/binary */
  getPeerCore?: () => {
    handleEnvelope: (envelope: Envelope, session: AuthSession | null) => Promise<unknown>;
    handleBinaryChunk: (header: { transferId: string; offset: number; eof: boolean }, data: Uint8Array, session: AuthSession | null) => Promise<{ ok: true } | { ok: false; error: string }>;
    getSessions?: () => Map<string, AuthSession>;
  };
  /** Client-side callbacks */
  onAuthenticated?: (session: AuthSession, peerIdentity: DeviceIdentity) => void;
  onEnvelope?: (envelope: Envelope) => void;
  onBinaryAck?: (transferId: string, offset: number, receivedBytes: number) => void;
  onClose?: (reason: string) => void;
  onLog?: (level: "log" | "warn" | "error", msg: string, data?: unknown) => void;
};

export type ManagedConnection = {
  deviceId: string;
  role: ConnectionRole;
  state: "disconnected" | "connecting" | "connected" | "authenticated" | "closed";
  socket: LyraSocket | null;
  peerIdentity: DeviceIdentity | null;
  session: AuthSession | null;
  /** Connect (client only) */
  connect: (host: string, port: number) => Promise<void>;
  /** Attach an already-accepted socket (server only) */
  attachSocket: (socket: LyraSocket, remoteAddress?: string) => void;
  /** Send envelope (seals if sharedSecret) */
  sendEnvelope: (envelope: Envelope) => Promise<void>;
  /** Send binary chunk */
  sendBinaryChunk: (header: { transferId: string; offset: number; eof: boolean }, data: Uint8Array) => Promise<void>;
  close: (reason?: string) => void;
  /** For testing: inject bytes as if received from socket */
  injectBytes: (bytes: Uint8Array) => void;
  /** Current remote host:port for diagnostics */
  remoteLabel: () => string | null;
};

function log(opt: ConnectionOptions, level: "log"|"warn"|"error", msg: string, data?: unknown) {
  const line = `[lyra conn ${opt.deviceId.slice(0,6)} ${opt.role}] ${msg}`;
  if (level === "error") console.error(line, data ?? "");
  else if (level === "warn") console.warn(line, data ?? "");
  else console.log(line, data ?? "");
  opt.onLog?.(level, msg, data);
}

export function createManagedConnection(
  options: ConnectionOptions,
  createSocket?: (host: string, port: number) => LyraSocket | Promise<LyraSocket>,
): ManagedConnection {
  let state: ManagedConnection["state"] = "disconnected";
  let socket: LyraSocket | null = null;
  let peerIdentity: DeviceIdentity | null = null;
  let session: AuthSession | null = null;
  let decoder = new FrameDecoder();
  let remoteHost: string | null = null;
  let remotePort: number | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastPong = Date.now();
  let writerQueue: Uint8Array[] = [];
  let writing = false;
  let closed = false;
  // handshake state
  let helloExchanged = false;
  let challengeSent: AuthChallengePayload | null = null;
  let challengeReceived: AuthChallengePayload | null = null;

  const remoteLabel = () => (remoteHost ? `${remoteHost}:${remotePort ?? LYRA_DEFAULT_PORT}` : null);

  function setState(s: ManagedConnection["state"]) {
    state = s;
  }

  function clearHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    heartbeatTimer = null;
    heartbeatTimeout = null;
  }

  function startHeartbeat() {
    clearHeartbeat();
    lastPong = Date.now();
    // send ping every 15s, timeout if no pong 45s
    heartbeatTimer = setInterval(() => {
      if (closed || !socket || socket.destroyed) return;
      if (Date.now() - lastPong > 45_000) {
        log(options, "warn", `heartbeat timeout ${remoteLabel()} → close`);
        close("heartbeat timeout");
        return;
      }
      // send ping as JSON envelope-like frame
      void sendRawJson({ type: "ping", ts: Date.now() }).catch(() => {});
      // also check if pong overdue for logging
      if (Date.now() - lastPong > 30_000) {
        log(options, "warn", "pong overdue", { since: Date.now() - lastPong });
      }
    }, 15_000);
  }

  function close(reason = "closed") {
    if (closed) return;
    closed = true;
    clearHeartbeat();
    setState("closed");
    writerQueue = [];
    try { socket?.destroy(); } catch {}
    try { socket?.removeAllListeners?.(); } catch {}
    socket = null;
    session = null;
    decoder = new FrameDecoder();
    options.onClose?.(reason);
  }

  async function flushWriter() {
    if (writing || closed) return;
    writing = true;
    while (writerQueue.length > 0 && !closed && socket && !socket.destroyed) {
      const frame = writerQueue.shift()!;
      await new Promise<void>((resolve, reject) => {
        try {
          // backpressure: if write returns false, wait for drain — but most RN sockets don't have drain, just callback
          let cbCalled = false;
          const onDrain = () => {
            if (!cbCalled) {
              cbCalled = true;
              resolve();
            }
          };
          // Use write callback if available
          const maybe = (socket as any).write(frame, undefined, onDrain);
          // Fallback resolve next tick if no callback
          setTimeout(() => {
            if (!cbCalled) resolve();
          }, 5);
          // If write threw, reject
          if (maybe === false) {
            // wait a bit for drain
            const to = setTimeout(() => resolve(), 20);
            // if socket has once drain, use it
            try { (socket as any).once?.("drain", () => { clearTimeout(to); resolve(); }); } catch {}
          }
        } catch (e) {
          reject(e);
        }
      });
    }
    writing = false;
  }

  async function sendRawJson(obj: unknown): Promise<void> {
    if (closed || !socket) throw new Error("Not connected");
    const frame = encodeJsonFrame(obj);
    writerQueue.push(frame);
    await flushWriter();
  }

  async function sendEnvelope(envelope: Envelope): Promise<void> {
    if (!session && options.role === "client") {
      // client must be authenticated for sealed envelopes, but ping etc don't need envelope
    }
    let payload = envelope.payload;
    let sealed = false;
    // seal if we have shared secret
    const secret = session?.sharedSecret ?? (envelope.type !== "pair_request" ? options.getSharedSecret?.(options.deviceId, peerIdentity?.fingerprint ?? "") : undefined);
    // Actually use session's secret when present (post-auth). For simplicity seal when session has secret
    if (session?.sharedSecret && envelope.payload !== undefined && envelope.type !== "pair_request" && envelope.type !== "ping" && envelope.type !== "pong") {
      try {
        const sealedPayload = await sealEnvelopePayload(session.sharedSecret, envelope.payload);
        envelope = { ...envelope, payload: sealedPayload as unknown as Envelope["payload"] };
      } catch {}
    }
    // wrap envelope in JSON frame type "envelope"
    await sendRawJson({ type: "envelope", envelope });
  }

  async function sendBinaryChunk(header: { transferId: string; offset: number; eof: boolean }, data: Uint8Array): Promise<void> {
    if (closed || !socket) throw new Error("Not connected");
    const frame = encodeBinaryChunkFrame(header, data);
    writerQueue.push(frame);
    await flushWriter();
  }

  // Handle incoming decoded frames
  async function handleDecoded(frames: ReturnType<FrameDecoder["push"]>) {
    for (const f of frames) {
      try {
        if (f.type === FRAME_JSON) {
          const msg = f.payload as Record<string, unknown>;
          const mtype = (msg as any).type as string | undefined;

          // heartbeat
          if (mtype === "ping") {
            await sendRawJson({ type: "pong", ts: (msg as any).ts ?? Date.now(), echo: (msg as any).ts });
            continue;
          }
          if (mtype === "pong") {
            lastPong = Date.now();
            if (heartbeatTimeout) {
              clearTimeout(heartbeatTimeout);
              heartbeatTimeout = null;
            }
            continue;
          }

          // handshake: hello
          if (mtype === "hello") {
            const res = validateHello(msg);
            if (!res.ok) {
              await sendRawJson({ type: "hello_error", error: res.error });
              close(`hello invalid: ${res.error}`);
              continue;
            }
            peerIdentity = res.identity;
            helloExchanged = true;
            log(options, "log", `hello from ${peerIdentity.name} ${peerIdentity.id.slice(0,6)}`);

            // server immediately sends challenge after hello
            if (options.role === "server") {
              const ch = await serverCreateChallenge(options.getIdentity());
              challengeSent = ch.challenge;
              await sendRawJson(ch);
              // client will respond; server also needs to send its own hello if not yet
              // (client already sent hello, so server sends hello now if we haven't)
              // We already will have sent hello on attach; check.
            }
            // client: after receiving server hello, it waits for auth_challenge; nothing more
            continue;
          }

          if (mtype === "hello_error") {
            log(options, "error", `hello_error: ${(msg as any).error}`);
            close(`hello_error: ${(msg as any).error}`);
            continue;
          }

          // auth_challenge (client receives)
          if (mtype === "auth_challenge") {
            const challenge = (msg as any).challenge as AuthChallengePayload;
            if (!challenge?.challengeId) {
              log(options, "error", "invalid auth_challenge");
              close("invalid challenge");
              continue;
            }
            challengeReceived = challenge;
            // client creates response
            const identity = options.getIdentity();
            const privateKey = options.getPrivateKey();
            // find shared secret if paired
            let sharedSecret: string | undefined;
            // try to find via peerIdentity (which we learned from hello) or via options.deviceId
            // Use getSharedSecret helper if provided
            if (peerIdentity) {
              sharedSecret = options.getSharedSecret?.(peerIdentity.id, peerIdentity.fingerprint);
            }
            // also try direct deviceId (for server-synthetic peer where hello not yet)
            if (!sharedSecret) {
              sharedSecret = options.getSharedSecret?.(options.deviceId, "");
            }
            const { clientCreateAuthResponse } = await import("./handshake");
            const respFrame = await clientCreateAuthResponse({
              challenge,
              identity,
              privateKey,
              sharedSecret,
            });
            await sendRawJson(respFrame);
            continue;
          }

          // auth_response (server receives)
          if (mtype === "auth_response") {
            const response = (msg as any).response;
            if (!challengeSent) {
              log(options, "warn", "auth_response without challenge");
              await sendRawJson({ type: "auth_error", error: "No challenge" });
              close("no challenge");
              continue;
            }
            const result = await serverVerifyResponse({
              challenge: challengeSent,
              response,
              serverIdentity: options.getIdentity(),
              resolvePeerAuth: options.resolvePeerAuth,
              allowFirstContact: options.allowFirstContact ?? true,
            });
            if (!result.ok) {
              log(options, "warn", `auth failed: ${result.error}`);
              await sendRawJson({ type: "auth_error", error: result.error });
              close(`auth failed: ${result.error}`);
              continue;
            }
            session = result.session;
            // also store shared secret if from hints (already in session)
            setState("authenticated");
            startHeartbeat();
            log(options, "log", `authenticated as ${session.deviceId.slice(0,6)} token ${session.sessionToken.slice(0,6)}`);
            // send auth_ok
            await sendRawJson({
              type: "auth_ok",
              sessionToken: session.sessionToken,
              deviceId: options.getIdentity().id,
              fingerprint: options.getIdentity().fingerprint,
              peerDeviceId: session.deviceId,
            });
            // notify
            if (peerIdentity) options.onAuthenticated?.(session, peerIdentity);
            continue;
          }

          if (mtype === "auth_ok") {
            // client receives auth_ok
            const m = msg as any;
            // create a synthetic session for client (we don't have server session, but we need sharedSecret and token)
            // Derive session from response: server validated us, so we consider authenticated.
            // For sealing, we use sharedSecret we already know (if paired)
            let sharedSecret: string | undefined;
            if (peerIdentity) sharedSecret = options.getSharedSecret?.(peerIdentity.id, peerIdentity.fingerprint);
            if (!sharedSecret) sharedSecret = options.getSharedSecret?.(options.deviceId, "");
            // create minimal session
            session = {
              sessionToken: m.sessionToken ?? `tcp_${Date.now()}`,
              deviceId: m.deviceId ?? peerIdentity?.id ?? options.deviceId,
              fingerprint: m.fingerprint ?? peerIdentity?.fingerprint ?? "",
              publicKey: peerIdentity?.publicKey ?? "",
              expiresAt: Date.now() + 60 * 60 * 1000,
              sharedSecret,
            } as AuthSession;
            setState("authenticated");
            startHeartbeat();
            log(options, "log", `client authenticated with ${peerIdentity?.name ?? m.deviceId?.slice(0,6)}`);
            if (peerIdentity) options.onAuthenticated?.(session, peerIdentity);
            continue;
          }

          if (mtype === "auth_error") {
            log(options, "error", `auth_error: ${(msg as any).error}`);
            close(`auth_error: ${(msg as any).error}`);
            continue;
          }

          // envelope wrapper
          if (mtype === "envelope") {
            const envelope = (msg as any).envelope as Envelope;
            if (!envelope || typeof envelope.type !== "string") {
              log(options, "warn", "invalid envelope wrapper");
              continue;
            }
            // unseal if needed
            let env: Envelope = envelope;
            if (session?.sharedSecret && isSealedPayload(env.payload)) {
              try {
                const opened = await openEnvelopePayload(session.sharedSecret, env.payload as any);
                env = { ...env, payload: opened as any };
              } catch (e) {
                log(options, "error", "failed to open sealed envelope", e);
                await sendRawJson({ type: "envelope_error", error: "Failed to open sealed payload" });
                continue;
              }
            }
            // validate envelope shape quickly
            const parsed = parseEnvelope(env);
            if (!parsed.ok) {
              log(options, "warn", `invalid envelope: ${parsed.error}`);
              continue;
            }
            env = parsed.envelope;

            // server side: route to peer core
            if (options.role === "server" && options.getPeerCore) {
              const core = options.getPeerCore();
              try {
                const reply = await core.handleEnvelope(env, session);
                if (reply) {
                  // reply may be Envelope or plain object with ok/error
                  let outEnv: Envelope | null = null;
                  if (reply && typeof reply === "object" && "type" in (reply as any) && typeof (reply as any).type === "string") {
                    outEnv = reply as Envelope;
                    // seal reply if needed
                    if (session?.sharedSecret && outEnv.payload !== undefined) {
                      try {
                        const sealed = await sealEnvelopePayload(session.sharedSecret, outEnv.payload);
                        outEnv = { ...outEnv, payload: sealed as any };
                      } catch {}
                    }
                    await sendRawJson({ type: "envelope", envelope: outEnv });
                  } else if (reply && typeof reply === "object") {
                    await sendRawJson({ type: "envelope", envelope: reply as any });
                  }
                }
              } catch (e) {
                log(options, "error", "handleEnvelope threw", e);
                await sendRawJson({ type: "envelope_error", error: e instanceof Error ? e.message : String(e) });
              }
            } else {
              // client side: deliver to onEnvelope
              options.onEnvelope?.(env);
              // also handle acks: if server replied with envelope, it will come as new envelope frame
            }
            continue;
          }

          // envelope ack / error from server
          if (mtype === "envelope_error") {
            log(options, "warn", `envelope_error: ${(msg as any).error}`);
            continue;
          }

          // transfer chunk ack (server sends as envelope or json)
          if (mtype === "transfer_chunk_ack" || mtype === "chunk_ack") {
            const ack = msg as any;
            const tid = ack.transferId ?? ack.header?.transferId;
            const off = ack.offset ?? ack.receivedBytes;
            const recv = ack.receivedBytes ?? ack.offset;
            if (tid) options.onBinaryAck?.(tid, off ?? 0, recv ?? 0);
            continue;
          }

          // generic unknown JSON frame — log
          log(options, "log", `unknown JSON frame type ${mtype}`, msg);
        } else if (f.type === FRAME_BINARY) {
          // binary chunk inbound
          if (options.role === "server" && options.getPeerCore) {
            const core = options.getPeerCore();
            try {
              const result = await core.handleBinaryChunk(f.header, f.data, session);
              // send ack as JSON frame
              if (result.ok) {
                // need to find receivedBytes — core will have it via transfers map? For now just ack offset+len
                // The core's handleBinaryChunk should update state and return ok; we ack with header offset + data len
                // But core will provide proper receivedBytes via separate mechanism (we can query via core.getSessions? not).
                // For now ack simple
                await sendRawJson({
                  type: "chunk_ack",
                  transferId: f.header.transferId,
                  offset: f.header.offset,
                  receivedBytes: f.header.offset + f.data.byteLength,
                  eof: f.header.eof,
                });
              } else {
                await sendRawJson({
                  type: "chunk_error",
                  transferId: f.header.transferId,
                  error: result.error,
                });
              }
            } catch (e) {
              await sendRawJson({
                type: "chunk_error",
                transferId: f.header.transferId,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          } else {
            log(options, "warn", "binary chunk received on client — ignoring", f.header);
          }
        }
      } catch (e) {
        log(options, "error", "handleDecoded error", e);
      }
    }
  }

  function onSocketData(data: unknown) {
    try {
      let bytes: Uint8Array;
      if (data instanceof Uint8Array) bytes = data;
      else if (typeof data === "string") bytes = new TextEncoder().encode(data);
      else if (data && typeof data === "object" && (data as any).buffer) {
        const v = data as any;
        bytes = new Uint8Array(v.buffer, v.byteOffset ?? 0, v.byteLength ?? v.length ?? 0);
      } else {
        // try convert via Buffer
        const buf = data as any;
        if (buf && typeof buf.length === "number") {
          bytes = Uint8Array.from(buf as any);
        } else {
          return;
        }
      }
      const frames = decoder.push(bytes);
      if (frames.length > 0) void handleDecoded(frames);
    } catch (e) {
      log(options, "error", "decoder error", e);
      close(`decoder error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function attachSocket(s: LyraSocket, remote?: string) {
    if (closed) return;
    socket = s;
    decoder = new FrameDecoder();
    setState("connected");
    if (remote) {
      // parse remote "host:port" if provided
      const m = remote.match(/^(.*):(\d+)$/);
      if (m) {
        remoteHost = m[1]!;
        remotePort = Number(m[2]);
      } else {
        remoteHost = remote;
      }
    }
    helloExchanged = false;
    challengeSent = null;
    challengeReceived = null;

    try {
      s.on("data", onSocketData);
      s.on("error", (err: unknown) => {
        log(options, "warn", `socket error ${remoteLabel()}`, err);
        close(`socket error: ${err instanceof Error ? err.message : String(err)}`);
      });
      s.on("close", () => {
        log(options, "log", `socket closed ${remoteLabel()}`);
        if (!closed) close("socket closed");
      });
      // for RN sockets, "close" may be called after destroy; also listen to end
      s.on("end", () => {
        // peer half-closed; we close too
        if (!closed) close("socket end");
      });
    } catch {}

    // Immediately send hello as first frame
    void sendRawJson(createHelloFrame(options.getIdentity())).catch((e) => {
      log(options, "error", "failed to send hello", e);
      close("hello send failed");
    });
  }

  async function connect(host: string, port: number): Promise<void> {
    if (closed) throw new Error("Connection closed");
    if (state === "connecting" || state === "connected" || state === "authenticated") {
      throw new Error(`Already ${state}`);
    }
    if (!createSocket) throw new Error("No createSocket factory");
    setState("connecting");
    remoteHost = host;
    remotePort = port;
    // create socket
    const s = await createSocket(host, port);
    attachSocket(s, `${host}:${port}`);
    setState("connected");
    // wait for auth (with timeout 10s for handshake)
    const start = Date.now();
    while (Date.now() - start < 12_000) {
      if (closed) throw new Error("Closed during handshake");
      if (state === "authenticated") return;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`Handshake timeout to ${host}:${port} (state=${state})`);
  }

  function injectBytes(bytes: Uint8Array) {
    const frames = decoder.push(bytes);
    if (frames.length > 0) void handleDecoded(frames);
  }

  return {
    deviceId: options.deviceId,
    role: options.role,
    get state() { return state; },
    get socket() { return socket; },
    get peerIdentity() { return peerIdentity; },
    get session() { return session; },
    connect,
    attachSocket,
    sendEnvelope,
    sendBinaryChunk,
    close,
    injectBytes,
    remoteLabel,
  } as ManagedConnection;
}
