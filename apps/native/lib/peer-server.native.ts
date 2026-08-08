/**
 * React Native peer TCP server — persistent raw TCP, no HTTP.
 * Single socket per paired device, heartbeat, disk streaming.
 * Requires dev client / release build (not Expo Go).
 */

import { hashPairingCode, type LyraStore } from "@lyra-sync-app/core";
import {
  createTcpPeerCore,
  type TcpPeerCore,
  createManagedConnection,
  type LyraSocket,
  FrameDecoder,
} from "@lyra-sync-app/net";
import type { DeviceIdentity } from "@lyra-sync-app/protocol";
import { LYRA_DEFAULT_PORT } from "@lyra-sync-app/protocol";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";

type TcpSocketModule = typeof import("react-native-tcp-socket");

export type NativePeerHandle = {
  port: number;
  url: string;
  lanHost: string | null;
  core: TcpPeerCore;
  stop: () => Promise<void>;
  setIdentity: (identity: DeviceIdentity) => void;
  setPairingOffer: (offer: { code: string; token: string; expiresAt: number } | null) => Promise<void>;
  resolvePairRequest: (key: { deviceId?: string; token?: string }, decision: { accepted: true; host?: string; port?: number } | { accepted: false; reason?: string }) => boolean;
  pauseTransfer: (transferId: string) => boolean;
  resumeTransfer: (transferId: string, offset?: number) => boolean;
  cancelTransfer: (transferId: string) => boolean;
  refreshLanHost: () => Promise<string | null>;
};

export function isExpoGoRuntime(): boolean {
  const ownership = Constants.appOwnership;
  if (ownership === "expo") return true;
  const env = (Constants as { executionEnvironment?: string }).executionEnvironment;
  if (env === "storeClient") return true;
  return false;
}

function loadTcpSocket(): TcpSocketModule | null {
  if (isExpoGoRuntime()) return null;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("react-native-tcp-socket") as TcpSocketModule;
  } catch (e) {
    console.warn("[lyra peer] react-native-tcp-socket unavailable", e);
    return null;
  }
}

async function pickLanHost(): Promise<string | null> {
  try {
    const ip = await Network.getIpAddressAsync();
    if (ip && ip !== "0.0.0.0" && ip !== "127.0.0.1") return ip;
  } catch {}
  return null;
}

function createNativeDiskTransfer() {
  return async (input: { transferId: string; totalBytes: number; files: { name: string; size: number }[]; resumeOffset?: number; checksums?: (string | undefined)[] }) => {
    const safeId = input.transferId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const tmpFile = new File(Paths.cache, `lyra-tx-${safeId}-${Date.now()}.bin`);
    try { tmpFile.create({ overwrite: true }); } catch {}
    let received = input.resumeOffset ?? 0;
    if (received === 0) {
      try { tmpFile.write(new Uint8Array(0)); } catch {}
    } else {
      try {
        const existing = tmpFile.info().size ?? 0;
        if (existing !== received) received = existing;
      } catch {}
    }
    let handle: import("expo-file-system").FileHandle | null = null;
    const ensureHandle = () => {
      if (handle) return handle;
      try {
        const h = (tmpFile as unknown as { open: (mode: string) => import("expo-file-system").FileHandle }).open("wa");
        handle = h as unknown as import("expo-file-system").FileHandle;
      } catch { handle = null; }
      return handle;
    };
    const state: import("@lyra-sync-app/net").TransferReceiveState = {
      transferId: input.transferId,
      totalBytes: input.totalBytes,
      receivedBytes: received,
      files: input.files,
      chunks: [],
      paused: false,
      checksums: input.checksums,
      diskPath: tmpFile.uri,
      pendingChunks: new Map(),
      appendChunk: async (bytes: Uint8Array, offset: number) => {
        if (offset !== received) {
          if (offset < received) return;
          throw new Error(`gap ${received} vs ${offset}`);
        }
        const h = ensureHandle();
        if (h) {
          try {
            (h as unknown as { writeBytes: (b: Uint8Array) => void }).writeBytes(bytes);
          } catch {
            const writer = tmpFile as unknown as { write: (data: Uint8Array, opts?: unknown) => void };
            writer.write(bytes, { append: true });
          }
        } else {
          const writer = tmpFile as unknown as { write: (data: Uint8Array, opts?: unknown) => void };
          writer.write(bytes, { append: true });
        }
        received += bytes.byteLength;
        (state as { receivedBytes: number }).receivedBytes = received;
      },
      finalizeDisk: async () => {
        try { handle?.close(); } catch {}
        handle = null;
        let size = received;
        try { size = tmpFile.info().size ?? received; } catch {}
        return { filePath: tmpFile.uri, size, sha256: undefined };
      },
      cleanupDisk: async () => {
        try { handle?.close(); } catch {}
        handle = null;
        try { tmpFile.delete(); } catch {}
      },
    };
    return state;
  };
}

export type StartNativePeerOptions = {
  identity: DeviceIdentity;
  port?: number;
  advertiseHost?: string | null;
  resolvePeerAuth?: (p: { deviceId: string; fingerprint: string; publicKey: string }) => { sharedSecret?: string; expectedFingerprint?: string; expectedDeviceId?: string } | null | undefined;
  handlers?: import("@lyra-sync-app/net").TcpPeerCoreOptions["handlers"];
  onEnvelope?: import("@lyra-sync-app/net").TcpPeerCoreOptions["onEnvelope"];
  fallbackPorts?: number[];
};

function toLyraSocketNative(socket: any): LyraSocket {
  return {
    on: (ev: string, cb: (...a: any[]) => void) => {
      try { socket.on(ev, cb); } catch {}
    },
    once: (ev: string, cb: (...a: any[]) => void) => {
      try { socket.once(ev, cb); } catch {}
    },
    write: (data: Uint8Array | string, _enc?: string, cb?: () => void) => {
      try {
        // RN socket expects string; for Uint8Array we convert to string via latin1
        let payload: string;
        if (data instanceof Uint8Array) {
          let binary = "";
          const chunk = 0x8000;
          for (let i = 0; i < data.byteLength; i += chunk) {
            binary += String.fromCharCode(...data.subarray(i, i + chunk));
          }
          payload = binary;
        } else {
          payload = data as string;
        }
        socket.write(payload, "utf8", cb);
      } catch (e) {
        if (cb) cb();
        throw e;
      }
    },
    destroy: () => {
      try { socket.destroy(); } catch {}
      try { socket.removeAllListeners?.(); } catch {}
    },
    get destroyed() {
      try { return !!socket.destroyed; } catch { return true; }
    },
    get remoteAddress() {
      try { return socket.remoteAddress ?? socket._remoteAddress ?? undefined; } catch { return undefined; }
    },
    removeAllListeners: () => {
      try { socket.removeAllListeners?.(); } catch {}
    },
  };
}

export async function startNativePeerServer(
  options: StartNativePeerOptions,
): Promise<NativePeerHandle | null> {
  const TcpSocket = loadTcpSocket();
  if (!TcpSocket) {
    console.info("[lyra peer] skipping native peer server (Expo Go or non-native runtime)");
    return null;
  }

  let currentIdentity = options.identity;
  let pairingOffer: { codeHash: string; token: string; expiresAt: number } | null = null;
  let lanHost = options.advertiseHost?.trim() || (await pickLanHost());
  let boundPort = options.port ?? LYRA_DEFAULT_PORT;

  const diskFactory = createNativeDiskTransfer();
  const mergedHandlers = {
    ...(options.handlers as Record<string, unknown>),
    createDiskTransfer: (options.handlers as { createDiskTransfer?: unknown })?.createDiskTransfer ?? diskFactory,
  } as import("@lyra-sync-app/net").TcpPeerCoreOptions["handlers"];

  const core = createTcpPeerCore({
    getIdentity: () => currentIdentity,
    getPort: () => boundPort,
    getLanHost: () => lanHost,
    getPairingOffer: () => {
      if (!pairingOffer || pairingOffer.expiresAt < Date.now()) return null;
      return pairingOffer;
    },
    allowFirstContactAuth: true,
    resolvePeerAuth: options.resolvePeerAuth,
    handlers: mergedHandlers,
    onEnvelope: options.onEnvelope,
  });

  const preferred = options.port ?? LYRA_DEFAULT_PORT;
  const candidates = [
    preferred,
    ...(options.fallbackPorts ?? [preferred + 2, preferred + 4, preferred + 10, 0]),
  ];

  type AnyServer = any;
  type AnySocket = any;
  let server: AnyServer | null = null;
  let listenError: Error | null = null;

  for (const tryPort of candidates) {
    listenError = null;
    const result = await new Promise<{ server: AnyServer; port: number } | { error: Error }>((resolve) => {
      let settled = false;
      let srv: AnyServer | null = null;
      try {
        // @ts-ignore - react-native-tcp-socket types vary across versions
        srv = (TcpSocket as any).createServer((socket: AnySocket) => {
          const remoteRaw = (socket as { remoteAddress?: string }).remoteAddress ?? (socket as { _remoteAddress?: string })._remoteAddress ?? "unknown";
          const remote = typeof remoteRaw === "string" ? remoteRaw.replace(/^::ffff:/, "").replace(/%.*$/, "") : "unknown";
          console.info(`[lyra peer] incoming TCP ← ${remote}`);

          try { (socket as any).allowHalfOpen = true; } catch {}

          const lyraSocket = toLyraSocketNative(socket);
          const conn = createManagedConnection(
            {
              deviceId: `incoming_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
              role: "server",
              getIdentity: () => currentIdentity,
              getPrivateKey: () => "",
              resolvePeerAuth: options.resolvePeerAuth,
              allowFirstContact: true,
              getPeerCore: () => ({
                handleEnvelope: (env, session) => core.handleEnvelope(env, session, remote),
                handleBinaryChunk: (hdr, data, session) => core.handleBinaryChunk(hdr, data, session),
              }),
              onClose: () => {
                console.info(`[lyra peer] server conn ${remote} closed`);
              },
            },
          );
          // attach
          (conn as any).attachSocket(lyraSocket, remote);
        });

        srv.on("error", (err: Error) => {
          if (settled) return;
          settled = true;
          try { srv.close(); } catch {}
          resolve({ error: err });
        });

        srv.listen({ port: tryPort, host: "0.0.0.0", reuseAddress: true }, () => {
          if (settled) return;
          settled = true;
          let actual = tryPort === 0 ? preferred : tryPort;
          try {
            const addr = srv.address?.() as { port?: number } | string | null | undefined;
            if (addr && typeof addr === "object" && typeof addr.port === "number") actual = addr.port;
          } catch {}
          resolve({ server: srv, port: actual });
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          resolve({ error: e instanceof Error ? e : new Error(String(e)) });
        }
      }
      // timeout
      setTimeout(() => {
        if (!settled) {
          settled = true;
          try { srv?.close(); } catch {}
          resolve({ error: new Error(`listen timeout ${tryPort}`) });
        }
      }, 5000);
    });

    if ("error" in result) {
      listenError = result.error;
      const msg = result.error.message || String(result.error);
      if (/EADDRINUSE|address already in use|already in use/i.test(msg)) {
        console.warn(`[lyra peer] port ${tryPort} in use, trying next…`);
        continue;
      }
      console.warn("[lyra peer] listen failed", msg);
      continue;
    }

    server = result.server;
    boundPort = result.port;
    break;
  }

  if (!server) {
    throw new Error(listenError?.message || `Could not bind peer server (tried ${candidates.join(", ")})`);
  }

  lanHost = options.advertiseHost?.trim() || (await pickLanHost()) || lanHost;
  console.info(`[lyra peer] native TCP server listening on 0.0.0.0:${boundPort}${lanHost ? ` (LAN ${lanHost})` : ""}`);

  const refreshLanHost = async () => {
    const next = options.advertiseHost?.trim() || (await pickLanHost());
    if (next) lanHost = next;
    return lanHost;
  };

  return {
    port: boundPort,
    url: lanHost ? `tcp://${lanHost}:${boundPort}` : `tcp://127.0.0.1:${boundPort}`,
    lanHost,
    core,
    setIdentity: (identity) => { currentIdentity = identity; },
    setPairingOffer: async (offer) => {
      if (!offer) { pairingOffer = null; return; }
      const codeHash = await hashPairingCode(offer.code);
      pairingOffer = { codeHash, token: offer.token, expiresAt: offer.expiresAt };
    },
    resolvePairRequest: (key, decision) => core.resolvePairRequest(key, decision),
    pauseTransfer: (id) => core.pauseTransfer(id),
    resumeTransfer: (id, off) => core.resumeTransfer(id, off),
    cancelTransfer: (id) => core.cancelTransfer(id),
    refreshLanHost,
    stop: () =>
      new Promise((resolve) => {
        try { server?.close(() => resolve()); } catch { resolve(); }
        setTimeout(() => resolve(), 500);
      }),
  };
}

export function attachNativePeerToStore(store: LyraStore, peer: NativePeerHandle): () => void {
  const syncStatus = () => {
    store.setPeerServerStatus({
      running: true,
      port: peer.port,
      url: peer.lanHost ? `tcp://${peer.lanHost}:${peer.port}` : peer.url,
      lanHost: peer.lanHost,
      discoveryActive: true,
      lastError: null,
    });
    if (peer.lanHost) store.setLocalLanHint(peer.lanHost);
  };
  syncStatus();

  if (peer.port && peer.port !== store.getState().settings.peerListenPort) {
    const preferred = store.getState().settings.peerListenPort ?? LYRA_DEFAULT_PORT;
    const known = new Set([53317, 53319, 53321, 53327, 53329, 53337, 53339, preferred, preferred + 2, preferred + 4, preferred + 10]);
    if (known.has(peer.port)) {
      store.updateSettings({ peerListenPort: peer.port });
    } else {
      console.warn(`[lyra peer] ephemeral port ${peer.port} not persisted (will retry ${preferred} next launch)`);
    }
  }

  let lastIdentityKey = "";
  const syncIdentity = () => {
    const id = store.getState().identity;
    if (!id) return;
    const key = `${id.id}:${id.fingerprint}:${id.name}`;
    if (key === lastIdentityKey) return;
    lastIdentityKey = key;
    peer.setIdentity(id);
  };
  syncIdentity();

  let lastOfferKey = "";
  const syncOffer = () => {
    const active = store.getState().activePairing;
    const key = active ? `${active.code}:${active.token}:${active.expiresAt}` : "";
    if (key === lastOfferKey) return;
    lastOfferKey = key;
    void peer.setPairingOffer(active ? { code: active.code, token: active.token, expiresAt: active.expiresAt } : null);
  };
  syncOffer();

  store.setPairDecisionResolver?.((payload) => {
    const ok = peer.resolvePairRequest({ deviceId: payload.deviceId, token: payload.token }, payload.accepted ? { accepted: true, host: peer.lanHost ?? undefined, port: peer.port } : { accepted: false, reason: payload.reason ?? "declined" });
    return Promise.resolve(ok ? { ok: true as const } : { ok: false as const, error: "No pending pair request" });
  });

  const unsub = store.subscribe(() => {
    syncIdentity();
    syncOffer();
  });

  const ipTimer = setInterval(() => {
    void peer.refreshLanHost().then((host) => {
      if (host) { store.setLocalLanHint(host); syncStatus(); }
    });
  }, 20_000);

  const discoveryTimer = setTimeout(() => {
    if (store.getState().settings.discoveryEnabled) void store.refreshDiscovery();
  }, 1200);

  return () => {
    clearTimeout(discoveryTimer);
    clearInterval(ipTimer);
    unsub();
    store.setPairDecisionResolver?.(null);
    store.setPeerServerStatus({ running: false, port: null, url: null, lanHost: null, discoveryActive: false, lastError: null });
  };
}
