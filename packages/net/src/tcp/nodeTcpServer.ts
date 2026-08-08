// @ts-nocheck
import { createServer, type Socket, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import {
  LYRA_DEFAULT_PORT,
  LYRA_PROTOCOL_VERSION,
  type DeviceIdentity,
  type DeviceStatus,
  type Envelope,
} from "@lyra-sync-app/protocol";
import { createTcpPeerCore, type TcpPeerCoreOptions, type TcpPeerCore } from "./core";
import { createManagedConnection, type LyraSocket } from "./connection";
import type { AuthSession } from "../auth";
import type { TransferReceiveState } from "../message-handlers";

export type TcpPeerServerOptions = {
  identity: DeviceIdentity;
  getStatus?: () => DeviceStatus | undefined;
  getPairingOffer?: () =>
    | { codeHash: string; token: string; expiresAt: number }
    | undefined
    | null;
  port?: number;
  host?: string;
  resolvePeerAuth?: TcpPeerCoreOptions["resolvePeerAuth"];
  allowFirstContactAuth?: boolean;
  requireAuthForMessages?: boolean;
  sealReplies?: boolean;
  handlers?: TcpPeerCoreOptions["handlers"];
  onEnvelope?: TcpPeerCoreOptions["onEnvelope"];
};

export type TcpPeerServer = {
  server: Server;
  port: number;
  host: string;
  url: string;
  protocol: "tcp";
  close: () => Promise<void>;
  getSessions: () => Map<string, AuthSession>;
  revokeDevice: (deviceId: string) => number;
  resolvePairRequest: (
    key: { deviceId?: string; token?: string },
    decision: { accepted: true; host?: string; port?: number } | { accepted: false; reason?: string },
  ) => boolean;
  setIdentity: (identity: DeviceIdentity) => void;
  getIdentity: () => DeviceIdentity;
  getLanHost: () => string | null;
  getTransfers: () => Map<string, TransferReceiveState>;
  pauseTransfer: (transferId: string) => boolean;
  resumeTransfer: (transferId: string, offset?: number) => boolean;
  cancelTransfer: (transferId: string) => boolean;
  core: TcpPeerCore;
};

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

function toLyraSocket(socket: Socket): LyraSocket {
  return {
    on: socket.on.bind(socket) as any,
    once: socket.once.bind(socket) as any,
    write: (data: Uint8Array | string, _enc?: string, cb?: () => void) => {
      const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(data as string, "utf8");
      socket.write(buf, cb as any);
    },
    destroy: () => socket.destroy(),
    get destroyed() { return socket.destroyed; },
    get remoteAddress() { return socket.remoteAddress ?? undefined; },
    removeAllListeners: socket.removeAllListeners.bind(socket),
  };
}

export async function startTcpPeerServer(options: TcpPeerServerOptions): Promise<TcpPeerServer> {
  const requestedPort = options.port ?? LYRA_DEFAULT_PORT;
  const host = options.host ?? "0.0.0.0";
  let boundPort = requestedPort;
  let currentIdentity: DeviceIdentity = options.identity;
  let pairingOffer = options.getPairingOffer?.() ?? null;

  // Keep pairingOffer fresh via getter wrapping
  const getPairingOfferWrapped = () => {
    const offer = options.getPairingOffer?.() ?? null;
    if (offer && offer.expiresAt < Date.now()) return null;
    return offer;
  };

  const core = createTcpPeerCore({
    getIdentity: () => currentIdentity,
    getStatus: options.getStatus,
    getPairingOffer: getPairingOfferWrapped,
    getPort: () => boundPort,
    getLanHost: () => getLocalIPv4(),
    protocol: "tcp",
    resolvePeerAuth: options.resolvePeerAuth,
    allowFirstContactAuth: options.allowFirstContactAuth,
    requireAuthForMessages: options.requireAuthForMessages,
    sealReplies: options.sealReplies,
    handlers: options.handlers,
    onEnvelope: options.onEnvelope,
  });

  const serverConnections = new Set<ReturnType<typeof createManagedConnection>>();

  const server: Server = createServer((socket: Socket) => {
    const remote = socket.remoteAddress?.replace(/^::ffff:/, "") ?? "?";
    console.log(`[lyra tcp] incoming ← ${remote}`);

    const lyraSocket = toLyraSocket(socket);

    const conn = createManagedConnection(
      {
        deviceId: `incoming_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        role: "server",
        getIdentity: () => currentIdentity,
        getPrivateKey: () => (currentIdentity as any)._privateKey ?? "", // not needed for server verify
        getSharedSecret: undefined,
        resolvePeerAuth: options.resolvePeerAuth,
        allowFirstContactAuth: options.allowFirstContactAuth ?? true,
        getPeerCore: () => ({
          handleEnvelope: (env, session) => core.handleEnvelope(env, session, remote),
          handleBinaryChunk: (hdr, data, session) => core.handleBinaryChunk(hdr, data, session),
        }),
        onClose: () => {
          serverConnections.delete(conn as any);
        },
        onLog: (lvl, msg, data) => {
          const line = `[lyra tcp server] ${msg}`;
          if (lvl === "error") console.error(line, data ?? "");
          else if (lvl === "warn") console.warn(line, data ?? "");
          else console.log(line, data ?? "");
        },
      },
    );

    // Attach socket (server role will handle hello/auth)
    (conn as any).attachSocket(lyraSocket, remote);
    serverConnections.add(conn as any);

    socket.on("error", (err) => {
      console.warn(`[lyra tcp] socket error ${remote}:`, err.message);
    });
  });

  server.on("error", (err) => {
    console.error("[lyra tcp] server error", err);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const addr = server.address();
  boundPort = addr && typeof addr === "object" ? (addr as any).port : requestedPort;
  console.info(`[lyra tcp] listening on ${host}:${boundPort}${getLocalIPv4() ? ` (LAN ${getLocalIPv4()})` : ""}`);

  return {
    server,
    port: boundPort,
    host,
    protocol: "tcp",
    url: `tcp://${getLocalIPv4() ?? "127.0.0.1"}:${boundPort}`,
    core,
    getSessions: () => core.getSessions(),
    revokeDevice: (deviceId) => core.revokeDevice(deviceId),
    resolvePairRequest: (key, decision) => core.resolvePairRequest(key, decision),
    setIdentity: (next) => { currentIdentity = next; },
    getIdentity: () => currentIdentity,
    getLanHost: () => getLocalIPv4(),
    getTransfers: () => core.getTransfers(),
    pauseTransfer: (id) => core.pauseTransfer(id),
    resumeTransfer: (id, off) => core.resumeTransfer(id, off),
    cancelTransfer: (id) => core.cancelTransfer(id),
    close: () =>
      new Promise((resolve, reject) => {
        for (const c of serverConnections) {
          try { (c as any).close("server closing"); } catch {}
        }
        serverConnections.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
