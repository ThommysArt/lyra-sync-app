// @ts-nocheck
/**
 * ConnectionManager — one persistent TCP per paired device.
 * Handles discovery -> connect, heartbeat, reconnect, send.
 */

import type { DeviceIdentity, Envelope } from "@lyra-sync-app/protocol";
import { LYRA_DEFAULT_PORT } from "@lyra-sync-app/protocol";
import { createManagedConnection, type LyraSocket, type ManagedConnection } from "./connection";
import type { AuthSession } from "../auth";
import type { TransferReceiveState } from "../message-handlers";

export type ConnectionFactory = (host: string, port: number) => LyraSocket | Promise<LyraSocket>;

export type ManagerOptions = {
  getIdentity: () => DeviceIdentity;
  getPrivateKey: () => string;
  getSharedSecret: (deviceId: string, fingerprint: string) => string | undefined;
  resolvePeerAuth: (p: { deviceId: string; fingerprint: string; publicKey: string }) =>
    | { sharedSecret?: string; expectedFingerprint?: string; expectedDeviceId?: string }
    | null
    | undefined;
  getPeerCore?: () => {
    handleEnvelope: (envelope: Envelope, session: AuthSession | null) => Promise<unknown>;
    handleBinaryChunk: (header: { transferId: string; offset: number; eof: boolean }, data: Uint8Array, session: AuthSession | null) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  createSocket: ConnectionFactory;
  onLog?: (level: "log"|"warn"|"error", msg: string, data?: unknown) => void;
  onPeerOnline?: (deviceId: string, online: boolean) => void;
  onEnvelope?: (deviceId: string, envelope: Envelope) => void;
};

function isLikelyTailscaleHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h.endsWith(".ts.net") || h.endsWith(".tailscale.net")) return true;
  const m = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const n = Number(m[1]);
    return n >= 64 && n <= 127;
  }
  return false;
}

export function deviceEndpointCandidatesTCP(
  device: {
    host?: string | null;
    port?: number | null;
    tailscaleHost?: string | null;
    preferredAddress?: string | null;
    lastReachableHost?: string | null;
    lastReachablePort?: number | null;
  },
): { host: string; port: number }[] {
  const port = device.port ?? LYRA_DEFAULT_PORT;
  const pref = device.preferredAddress ?? "auto";
  const hostField = device.host?.trim() || null;
  const tsField = device.tailscaleHost?.trim() || null;
  const lanHost = hostField && !isLikelyTailscaleHost(hostField) ? hostField : null;
  const tsHost = tsField || (hostField && isLikelyTailscaleHost(hostField) ? hostField : null);

  const ordered: string[] = [];
  const push = (h: string | null | undefined) => {
    const v = h?.trim();
    if (v && !ordered.includes(v)) ordered.push(v);
  };
  push(device.lastReachableHost);
  if (pref === "tailscale") {
    push(tsHost); push(lanHost); push(hostField);
  } else if (pref === "lan") {
    push(lanHost); push(hostField); push(tsHost);
  } else if (tsHost) {
    push(tsHost); push(lanHost); push(hostField);
  } else {
    push(lanHost); push(hostField);
  }
  // local loopback for same-host testing
  push("127.0.0.1");

  const lastPort = device.lastReachablePort;
  const ports = [...new Set([lastPort, port, LYRA_DEFAULT_PORT, port+2, port+4].filter((p): p is number => typeof p === "number" && p > 0))].slice(0,4);

  const out: { host: string; port: number }[] = [];
  if (device.lastReachableHost && device.lastReachablePort) {
    out.push({ host: device.lastReachableHost, port: device.lastReachablePort });
  }
  for (const h of ordered) {
    for (const p of ports) {
      if (out.some(e => e.host===h && e.port===p)) continue;
      out.push({ host: h, port: p });
    }
  }
  return out.slice(0,8);
}

export type ManagerPeer = {
  deviceId: string;
  device: {
    id: string;
    host?: string | null;
    port?: number | null;
    tailscaleHost?: string | null;
    preferredAddress?: string | null;
    lastReachableHost?: string | null;
    lastReachablePort?: number | null;
    fingerprint?: string;
  };
  connection: ManagedConnection | null;
  online: boolean;
  lastSeenAt: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  desired: boolean; // should we keep trying?
};

export function createConnectionManager(options: ManagerOptions) {
  const peers = new Map<string, ManagerPeer>();
  // Pending request-response for envelopes (e.g., fs_list -> fs_list_response, transfer_offer -> transfer_accept)
  const pendingRequests = new Map<string, { resolve: (env: Envelope) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; match: (env: Envelope) => boolean }>();
  const log = (level: "log"|"warn"|"error", msg: string, data?: unknown) => {
    const line = `[lyra mgr] ${msg}`;
    if (level === "error") console.error(line, data ?? "");
    else if (level === "warn") console.warn(line, data ?? "");
    else console.log(line, data ?? "");
    options.onLog?.(level, msg, data);
  };

  function getOrCreatePeer(deviceId: string, device?: ManagerPeer["device"]): ManagerPeer {
    let p = peers.get(deviceId);
    if (!p) {
      p = {
        deviceId,
        device: device ?? { id: deviceId },
        connection: null,
        online: false,
        lastSeenAt: 0,
        reconnectAttempt: 0,
        reconnectTimer: null,
        desired: false,
      };
      peers.set(deviceId, p);
    } else if (device) {
      p.device = { ...p.device, ...device };
    }
    return p;
  }

  function setOnline(peer: ManagerPeer, online: boolean) {
    if (peer.online !== online) {
      peer.online = online;
      peer.lastSeenAt = Date.now();
      options.onPeerOnline?.(peer.deviceId, online);
      log("log", `${peer.deviceId.slice(0,6)} → ${online ? "online" : "offline"}`);
    } else if (online) {
      peer.lastSeenAt = Date.now();
    }
  }

  function scheduleReconnect(peer: ManagerPeer) {
    if (!peer.desired) return;
    if (peer.reconnectTimer) return;
    const attempt = peer.reconnectAttempt;
    const delays = [1000, 2000, 5000, 10000, 30000];
    const delay = delays[Math.min(attempt, delays.length - 1)]! + Math.floor(Math.random()*500);
    peer.reconnectAttempt = Math.min(attempt + 1, delays.length - 1);
    log("log", `reconnect ${peer.deviceId.slice(0,6)} in ${delay}ms (attempt ${attempt+1})`);
    peer.reconnectTimer = setTimeout(() => {
      peer.reconnectTimer = null;
      void connectPeer(peer.deviceId);
    }, delay);
  }

  async function connectPeer(deviceId: string): Promise<ManagedConnection | null> {
    const peer = peers.get(deviceId);
    if (!peer) return null;
    if (peer.connection && peer.connection.state === "authenticated") {
      return peer.connection;
    }
    // If there's a connecting/connected but not yet authenticated connection, wait for it instead of creating a new one
    if (peer.connection && (peer.connection.state === "connected" || peer.connection.state === "connecting")) {
      const existing = peer.connection;
      const start = Date.now();
      while (Date.now() - start < 8000) {
        if (existing.state === "authenticated") return existing;
        if (existing.state === "closed" || existing.state === "disconnected") break;
        await new Promise(r => setTimeout(r, 80));
      }
      // If still not authenticated, drop it and try new
      if (existing.state !== "authenticated") {
        try { existing.close("stale connecting"); } catch {}
        if (peer.connection === existing) peer.connection = null;
      } else {
        return existing;
      }
    }

    const candidates = deviceEndpointCandidatesTCP(peer.device);
    if (candidates.length === 0) {
      log("warn", `no candidates for ${deviceId.slice(0,6)}`);
      scheduleReconnect(peer);
      return null;
    }

    // try candidates sequentially with short handshake timeout
    for (const ep of candidates) {
      // create new connection per attempt (so hello/fingerprint state clean)
      const conn = createManagedConnection({
        deviceId,
        role: "client",
        getIdentity: options.getIdentity,
        getPrivateKey: options.getPrivateKey,
        getSharedSecret: options.getSharedSecret,
        resolvePeerAuth: options.resolvePeerAuth,
        allowFirstContact: false,
        getPeerCore: options.getPeerCore,
        onAuthenticated: (session, peerIdentity) => {
          setOnline(peer, true);
          peer.reconnectAttempt = 0;
          // update lastReachable
          peer.device.lastReachableHost = ep.host;
          peer.device.lastReachablePort = ep.port;
          log("log", `authenticated ${deviceId.slice(0,6)} via ${ep.host}:${ep.port} as ${peerIdentity.name ?? peerIdentity.id.slice(0,6)}`);
        },
        onEnvelope: (envelope) => {
          peer.lastSeenAt = Date.now();
          // Check pending requests first
          for (const [key, pending] of pendingRequests) {
            try {
              if (pending.match(envelope)) {
                clearTimeout(pending.timer);
                pendingRequests.delete(key);
                pending.resolve(envelope);
                return;
              }
            } catch {}
          }
          options.onEnvelope?.(deviceId, envelope);
        },
        onClose: (reason) => {
          log("log", `connection closed ${deviceId.slice(0,6)}: ${reason}`);
          if (peer.connection === conn) {
            peer.connection = null;
            setOnline(peer, false);
            scheduleReconnect(peer);
          }
        },
        onLog: options.onLog,
        onBinaryAck: () => {
          peer.lastSeenAt = Date.now();
        },
      }, options.createSocket);

      peer.connection = conn;

      try {
        log("log", `connecting ${deviceId.slice(0,6)} → ${ep.host}:${ep.port}`);
        await conn.connect(ep.host, ep.port);
        // success
        return conn;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("warn", `connect ${ep.host}:${ep.port} failed: ${msg}`);
        try { conn.close("connect failed"); } catch {}
        if (peer.connection === conn) peer.connection = null;
        // try next candidate immediately, don't backoff yet
        continue;
      }
    }

    // all candidates failed
    peer.connection = null;
    scheduleReconnect(peer);
    return null;
  }

  async function ensureConnected(deviceId: string): Promise<ManagedConnection> {
    const peer = peers.get(deviceId);
    if (!peer) throw new Error(`Unknown peer ${deviceId}`);
    if (peer.connection && peer.connection.state === "authenticated") return peer.connection;
    // If there's a connecting connection from upsert, wait for it
    if (peer.connection && (peer.connection.state === "connected" || peer.connection.state === "connecting")) {
      const existing = peer.connection;
      const start = Date.now();
      while (Date.now() - start < 10000) {
        if (existing.state === "authenticated") return existing;
        if (existing.state === "closed" || existing.state === "disconnected") break;
        await new Promise(r => setTimeout(r, 80));
      }
    }
    // try connect
    const conn = await connectPeer(deviceId);
    if (!conn || conn.state !== "authenticated") {
      throw new Error(`Peer ${deviceId.slice(0,6)} unreachable (tried ${deviceEndpointCandidatesTCP(peer.device).map(e=>`${e.host}:${e.port}`).join(", ")})`);
    }
    return conn;
  }

  return {
    /** Register or update a paired device we should keep connected to */
    upsertPeer: (device: ManagerPeer["device"]) => {
      const p = getOrCreatePeer(device.id, device);
      p.desired = true;
      p.device = { ...p.device, ...device };
      // Do not auto-connect in background; let ensureConnected handle it to avoid race
      // Background reconnect is handled via scheduleReconnect on close
      return p;
    },
    /** Remove peer (unpair) */
    removePeer: (deviceId: string) => {
      const p = peers.get(deviceId);
      if (!p) return;
      p.desired = false;
      if (p.reconnectTimer) clearTimeout(p.reconnectTimer);
      p.reconnectTimer = null;
      try { p.connection?.close("removed"); } catch {}
      peers.delete(deviceId);
      log("log", `removed peer ${deviceId.slice(0,6)}`);
    },
    /** Update device address (host/port changed) */
    updatePeer: (device: ManagerPeer["device"]) => {
      const p = getOrCreatePeer(device.id, device);
      p.device = { ...p.device, ...device };
    },
    /** Ensure we have an authenticated connection, or throw */
    ensureConnected,
    /** Send JSON envelope over persistent connection */
    sendEnvelope: async (deviceId: string, envelope: Envelope): Promise<void> => {
      const conn = await ensureConnected(deviceId);
      await conn.sendEnvelope(envelope);
    },
    /** Send binary chunk */
    sendBinaryChunk: async (deviceId: string, header: { transferId: string; offset: number; eof: boolean }, data: Uint8Array): Promise<void> => {
      const conn = await ensureConnected(deviceId);
      await conn.sendBinaryChunk(header, data);
    },
    /** Disconnect all */
    closeAll: () => {
      for (const p of peers.values()) {
        p.desired = false;
        if (p.reconnectTimer) clearTimeout(p.reconnectTimer);
        try { p.connection?.close("manager close"); } catch {}
      }
      peers.clear();
    },
    /** Snapshot for store online status */
    getPeerState: (deviceId: string) => {
      const p = peers.get(deviceId);
      if (!p) return null;
      return { online: p.online, lastSeenAt: p.lastSeenAt, state: p.connection?.state ?? "disconnected", remote: p.connection?.remoteLabel() ?? null };
    },
    /** Request-response: send envelope and wait for a matching reply */
    requestEnvelope: async (deviceId: string, envelope: Envelope, opts?: { timeoutMs?: number; match?: (reply: Envelope) => boolean; expectType?: string }): Promise<Envelope> => {
      const mgr = peers.get(deviceId);
      const conn = mgr?.connection ?? await ensureConnected(deviceId);
      const key = `${deviceId}::${envelope.id}::${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      return new Promise<Envelope>((resolve, reject) => {
        const timeoutMs = opts?.timeoutMs ?? 8000;
        const timer = setTimeout(() => {
          pendingRequests.delete(key);
          reject(new Error(`Request timeout waiting for reply to ${envelope.type} (${envelope.id.slice(0,6)})`));
        }, timeoutMs);
        const match = opts?.match ?? ((reply: Envelope) => {
          if (opts?.expectType && reply.type !== opts.expectType) return false;
          // For transfer, match by transferId in payload
          const origId = (envelope.payload as any)?.transferId ?? (envelope.payload as any)?.id ?? (envelope.payload as any)?.requestId;
          const replyId = (reply.payload as any)?.transferId ?? (reply.payload as any)?.requestId ?? (reply.payload as any)?.id;
          if (origId && replyId) return origId === replyId;
          // fallback: any reply to same toDeviceId
          return reply.fromDeviceId === deviceId || reply.toDeviceId === envelope.fromDeviceId;
        });
        pendingRequests.set(key, { resolve, reject, timer, match });
        conn.sendEnvelope(envelope).catch((e) => {
          clearTimeout(timer);
          pendingRequests.delete(key);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
    },
    /** For server side: attach an incoming socket (already accepted) */
    attachServerSocket: (deviceIdHint: string, socket: LyraSocket, remoteAddress?: string) => {
      // server doesn't know deviceId until hello — use hint or temp
      const tempId = deviceIdHint || `incoming_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      const conn = createManagedConnection({
        deviceId: tempId,
        role: "server",
        getIdentity: options.getIdentity,
        getPrivateKey: options.getPrivateKey,
        getSharedSecret: options.getSharedSecret,
        resolvePeerAuth: options.resolvePeerAuth,
        allowFirstContact: true,
        getPeerCore: options.getPeerCore,
        onAuthenticated: (session, peerIdentity) => {
          // re-key by real deviceId
          const realId = session.deviceId || peerIdentity.id;
          log("log", `server authenticated incoming ${tempId} → ${realId.slice(0,6)}`);
          // move to real peer entry? For now just log; manager peers are client-side.
          // Server connections are ephemeral and not tracked in peers map beyond this conn.
          // But we update peers map if this incoming is from a known paired device
          const known = peers.get(realId);
          if (known) {
            setOnline(known, true);
            known.lastSeenAt = Date.now();
          }
        },
        onEnvelope: (envelope) => {
          // server envelopes are handled via getPeerCore already, but this is fallback
          options.onEnvelope?.(tempId, envelope);
        },
        onClose: () => {
          log("log", `server connection ${tempId} closed`);
        },
        onLog: options.onLog,
      });
      conn.attachSocket(socket, remoteAddress);
      return conn;
    },
    /** Expose peers for debugging */
    _peers: peers,
  };
}

export type ConnectionManager = ReturnType<typeof createConnectionManager>;

// Global singleton for peer-ops/store to use without explicit injection (Metro dedupe safe via globalThis)
const GLOBAL_KEY = "__lyra_tcp_manager_v1__";
type GlobalBag = typeof globalThis & { [GLOBAL_KEY]?: ConnectionManager | null };

function readGlobal(): ConnectionManager | null | undefined {
  try { return (globalThis as GlobalBag)[GLOBAL_KEY]; } catch { return undefined; }
}
function writeGlobal(m: ConnectionManager | null) {
  try { (globalThis as GlobalBag)[GLOBAL_KEY] = m; } catch {}
}

let localManager: ConnectionManager | null = null;

export function setConnectionManager(mgr: ConnectionManager | null) {
  localManager = mgr;
  writeGlobal(mgr);
}
export function getConnectionManager(): ConnectionManager | null {
  if (localManager) return localManager;
  const g = readGlobal();
  if (g) return g;
  return null;
}
export function hasConnectionManager(): boolean {
  return Boolean(localManager || readGlobal());
}
