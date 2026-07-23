/**
 * React Native peer HTTP server (TCP + minimal HTTP/1.1).
 * Each mobile device hosts its own /lyra/* endpoints so desktops can pair,
 * push clipboard, and transfer files to the phone.
 *
 * Requires a dev client / release build (not Expo Go) — needs native TCP sockets.
 *
 * Implementation notes:
 * - Request buffers are kept as raw bytes until Content-Length is satisfied
 *   (UTF-8 string length ≠ byte length for multi-byte clipboard/filenames).
 * - Listens on 0.0.0.0 so LAN + Tailscale clients can reach the phone.
 */
import {
  createPeerHttpCore,
  type PeerHttpCore,
  type PeerHttpCoreOptions,
  type PeerPairDecision,
} from "@lyra-sync-app/net";
import { hashPairingCode, type LyraStore } from "@lyra-sync-app/core";
import { LYRA_DEFAULT_PORT, type DeviceIdentity } from "@lyra-sync-app/protocol";
import { Platform } from "react-native";
import * as Network from "expo-network";
import Constants from "expo-constants";

type TcpSocketModule = typeof import("react-native-tcp-socket");

export type NativePeerHandle = {
  port: number;
  url: string;
  lanHost: string | null;
  core: PeerHttpCore;
  stop: () => Promise<void>;
  setIdentity: (identity: DeviceIdentity) => void;
  setPairingOffer: (
    offer: { code: string; token: string; expiresAt: number } | null,
  ) => Promise<void>;
  resolvePairRequest: (
    key: { deviceId?: string; token?: string },
    decision: PeerPairDecision,
  ) => boolean;
  /** Refresh advertised LAN/Tailscale host (Wi‑Fi / VPN changes). */
  refreshLanHost: () => Promise<string | null>;
};

/** True when running inside Expo Go (no custom native modules). */
export function isExpoGoRuntime(): boolean {
  // appOwnership === "expo" → Expo Go; "standalone" / null → store or dev client
  const ownership = Constants.appOwnership;
  if (ownership === "expo") return true;
  // executionEnvironment is more precise on newer Expo
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

function statusLine(status: number): string {
  const map: Record<number, string> = {
    200: "OK",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    404: "Not Found",
    500: "Internal Server Error",
  };
  return map[status] ?? "OK";
}

const MAX_REQUEST_BYTES = 8 * 1024 * 1024; // 8 MiB (sealed transfer chunks)

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function toUint8Array(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function indexOfHeaderEnd(buf: Uint8Array): number {
  // Look for \r\n\r\n
  for (let i = 0; i < buf.byteLength - 3; i++) {
    if (
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

/** Parse one HTTP request from a raw byte buffer. Returns null if incomplete. */
function parseHttpRequestBytes(raw: Uint8Array): {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  consumed: number;
} | null {
  const headerEnd = indexOfHeaderEnd(raw);
  if (headerEnd < 0) {
    if (raw.byteLength > 64 * 1024) return null; // headers too large / garbage
    return null;
  }
  const headBytes = raw.subarray(0, headerEnd);
  const head = new TextDecoder().decode(headBytes);
  const lines = head.split("\r\n");
  const requestLine = lines[0];
  if (!requestLine) return null;
  const parts = requestLine.split(" ");
  const method = parts[0] ?? "GET";
  // Strip query string for routing; peer-http-core also splits on ?
  const path = parts[1] ?? "/";
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon > 0) {
      const k = line.slice(0, colon).trim().toLowerCase();
      const v = line.slice(colon + 1).trim();
      headers[k] = v;
    }
  }
  const contentLength = Number.parseInt(headers["content-length"] ?? "0", 10);
  const bodyStart = headerEnd + 4;
  const bodyLen = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  if (bodyLen > MAX_REQUEST_BYTES) {
    // Signal oversized — caller should 400
    return {
      method,
      path,
      headers,
      body: "",
      consumed: -1,
    };
  }
  if (raw.byteLength < bodyStart + bodyLen) {
    return null; // wait for more bytes
  }
  const bodyBytes = raw.subarray(bodyStart, bodyStart + bodyLen);
  const body = new TextDecoder().decode(bodyBytes);
  return {
    method,
    path,
    headers,
    body,
    consumed: bodyStart + bodyLen,
  };
}

function buildHttpResponse(
  status: number,
  headers: Record<string, string> | undefined,
  body: string,
): string {
  const h = { ...(headers ?? {}) };
  const bodyBytes = new TextEncoder().encode(body);
  if (body && !h["content-length"] && !h["Content-Length"]) {
    h["content-length"] = String(bodyBytes.byteLength);
  }
  if (!h["connection"] && !h["Connection"]) {
    h["connection"] = "close";
  }
  const lines = [`HTTP/1.1 ${status} ${statusLine(status)}`];
  for (const [k, v] of Object.entries(h)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("", body);
  return lines.join("\r\n");
}

async function pickLanHost(): Promise<string | null> {
  try {
    const ip = await Network.getIpAddressAsync();
    if (ip && ip !== "0.0.0.0" && ip !== "127.0.0.1") return ip;
  } catch {
    // ignore
  }
  return null;
}

export type StartNativePeerOptions = {
  identity: DeviceIdentity;
  port?: number;
  /** Prefer this host when advertising (e.g. Tailscale 100.x) */
  advertiseHost?: string | null;
  resolvePeerAuth?: PeerHttpCoreOptions["resolvePeerAuth"];
  handlers?: PeerHttpCoreOptions["handlers"];
  onEnvelope?: PeerHttpCoreOptions["onEnvelope"];
  /** Ports to try after preferred (EADDRINUSE / multi-instance on same device rare but possible) */
  fallbackPorts?: number[];
};

/**
 * Start listening for Lyra peer HTTP on the device.
 * Returns null when Expo Go or TCP module is unavailable.
 */
export async function startNativePeerServer(
  options: StartNativePeerOptions,
): Promise<NativePeerHandle | null> {
  const TcpSocket = loadTcpSocket();
  if (!TcpSocket) {
    console.info(
      "[lyra peer] skipping native peer server (Expo Go or non-native runtime)",
    );
    return null;
  }

  let currentIdentity = options.identity;
  let pairingOffer: {
    codeHash: string;
    token: string;
    expiresAt: number;
  } | null = null;
  let lanHost = options.advertiseHost?.trim() || (await pickLanHost());
  let boundPort = options.port ?? LYRA_DEFAULT_PORT;

  const core = createPeerHttpCore({
    getIdentity: () => currentIdentity,
    getPort: () => boundPort,
    getLanHost: () => lanHost,
    getPairingOffer: () => {
      if (!pairingOffer || pairingOffer.expiresAt < Date.now()) return null;
      return pairingOffer;
    },
    allowFirstContactAuth: true,
    resolvePeerAuth: options.resolvePeerAuth,
    handlers: options.handlers,
    onEnvelope: options.onEnvelope,
    cors: true,
  });

  const preferred = options.port ?? LYRA_DEFAULT_PORT;
  const candidates = [
    preferred,
    ...(options.fallbackPorts ?? [preferred + 2, preferred + 4, preferred + 10, 0]),
  ];

  // react-native-tcp-socket types are incomplete across versions — keep loose here
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyServer = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnySocket = any;
  let server: AnyServer | null = null;
  let listenError: Error | null = null;

  for (const tryPort of candidates) {
    listenError = null;
    const result = await new Promise<{ server: AnyServer; port: number } | { error: Error }>(
      (resolve) => {
        let settled = false;
        const srv = TcpSocket.createServer((socket: AnySocket) => {
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          let handling = false;
          // Once true, never touch the native socket again (write/destroy).
          // react-native-tcp-socket crashes the app if write() hits a removed id:
          // java.lang.IllegalArgumentException: No socket with id N
          let done = false;

          const isLive = () => {
            if (done) return false;
            try {
              if (socket?.destroyed) return false;
            } catch {
              return false;
            }
            return true;
          };

          /**
           * Close without writing. Safe to call many times.
           * Prefer destroy over end() — end() also races getTcpClient on Android.
           */
          const safeClose = () => {
            if (done) return;
            done = true;
            try {
              clearTimeout(idleTimer);
            } catch {
              // ignore
            }
            try {
              if (socket && !socket.destroyed) {
                socket.destroy();
              }
            } catch {
              // Native may already have dropped the id — never rethrow
            }
          };

          /**
           * Write one HTTP response then close. Never write twice.
           * Uses write+destroy (not end) so we fully own the lifecycle flag
           * before the native bridge is invoked.
           */
          const respond = (payload: string) => {
            if (done || !isLive()) return;
            done = true;
            try {
              clearTimeout(idleTimer);
            } catch {
              // ignore
            }
            try {
              // Guard again: destroy() may race from error/close listeners
              if (socket.destroyed) return;
              socket.write(payload, "utf8", () => {
                try {
                  if (!socket.destroyed) socket.destroy();
                } catch {
                  // ignore
                }
              });
            } catch {
              try {
                if (!socket.destroyed) socket.destroy();
              } catch {
                // ignore
              }
            }
          };

          const tryHandle = () => {
            if (handling || done) return;
            const buf = concatBytes(chunks);
            const parsed = parseHttpRequestBytes(buf);
            if (!parsed) {
              if (totalBytes > MAX_REQUEST_BYTES) {
                respond(
                  buildHttpResponse(
                    400,
                    { "content-type": "application/json" },
                    '{"error":"Request too large"}',
                  ),
                );
              }
              return;
            }
            if (parsed.consumed < 0) {
              respond(
                buildHttpResponse(
                  400,
                  { "content-type": "application/json" },
                  '{"error":"Request too large"}',
                ),
              );
              return;
            }

            handling = true;
            chunks.length = 0;
            totalBytes = 0;

            const remote =
              (socket as { remoteAddress?: string }).remoteAddress ?? null;

            void core
              .handle({
                method: parsed.method,
                path: parsed.path,
                headers: parsed.headers,
                body: parsed.body,
                remoteAddress: remote,
              })
              .then((res) => {
                if (done || !isLive()) return;
                respond(buildHttpResponse(res.status, res.headers, res.body));
              })
              .catch((err) => {
                console.warn("[lyra peer] request error", err);
                if (done || !isLive()) return;
                respond(
                  buildHttpResponse(
                    500,
                    { "content-type": "application/json" },
                    JSON.stringify({ error: "Internal error" }),
                  ),
                );
              });
          };

          // Avoid library auto-end() on peer FIN racing our write (known crash).
          try {
            socket.allowHalfOpen = true;
          } catch {
            // ignore
          }

          socket.on("data", (data: string | Uint8Array | ArrayBuffer) => {
            if (done || handling) return;
            try {
              const bytes = toUint8Array(data);
              chunks.push(bytes);
              totalBytes += bytes.byteLength;
              if (totalBytes > MAX_REQUEST_BYTES) {
                respond(
                  buildHttpResponse(
                    400,
                    { "content-type": "application/json" },
                    '{"error":"Request too large"}',
                  ),
                );
                return;
              }
              tryHandle();
            } catch (e) {
              console.warn("[lyra peer] data handler error", e);
              safeClose();
            }
          });

          socket.on("error", () => {
            // Peer reset / aborted probe — just drop; never write afterwards
            safeClose();
          });

          socket.on("close", () => {
            done = true;
            try {
              clearTimeout(idleTimer);
            } catch {
              // ignore
            }
          });

          socket.on("end", () => {
            // Peer half-closed. If we haven't responded, abandon (client gone).
            if (!handling) safeClose();
          });

          // Idle timeout for half-open / stalled clients
          const idleTimer = setTimeout(() => {
            if (!handling) safeClose();
          }, 15_000);
        });

        srv.on("error", (err: Error) => {
          if (settled) return;
          settled = true;
          try {
            srv.close();
          } catch {
            // ignore
          }
          resolve({ error: err });
        });

        // Host 0.0.0.0 so LAN + Tailscale clients can reach us
        srv.listen({ port: tryPort, host: "0.0.0.0", reuseAddress: true }, () => {
          if (settled) return;
          settled = true;
          let actual = tryPort === 0 ? preferred : tryPort;
          try {
            const addr = srv.address?.() as { port?: number } | string | null | undefined;
            if (addr && typeof addr === "object" && typeof addr.port === "number") {
              actual = addr.port;
            }
          } catch {
            // keep fallback
          }
          resolve({ server: srv, port: actual });
        });
      },
    );

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
    throw new Error(
      listenError?.message ||
        `Could not bind peer server (tried ${candidates.join(", ")})`,
    );
  }

  // Refresh LAN IP once more after bind
  lanHost = options.advertiseHost?.trim() || (await pickLanHost()) || lanHost;

  console.info(
    `[lyra peer] native peer server listening on 0.0.0.0:${boundPort}` +
      (lanHost ? ` (LAN ${lanHost})` : ""),
  );

  const refreshLanHost = async () => {
    const next = options.advertiseHost?.trim() || (await pickLanHost());
    if (next) lanHost = next;
    return lanHost;
  };

  return {
    port: boundPort,
    url: lanHost ? `http://${lanHost}:${boundPort}` : `http://127.0.0.1:${boundPort}`,
    lanHost,
    core,
    setIdentity: (identity) => {
      currentIdentity = identity;
    },
    setPairingOffer: async (offer) => {
      if (!offer) {
        pairingOffer = null;
        return;
      }
      const codeHash = await hashPairingCode(offer.code);
      pairingOffer = {
        codeHash,
        token: offer.token,
        expiresAt: offer.expiresAt,
      };
    },
    resolvePairRequest: (key, decision) => core.resolvePairRequest(key, decision),
    refreshLanHost,
    stop: () =>
      new Promise((resolve) => {
        try {
          server?.close(() => resolve());
        } catch {
          resolve();
        }
        // Ensure resolve even if close never fires
        setTimeout(() => resolve(), 500);
      }),
  };
}

/**
 * Wire native peer server into a Lyra store (status, pairing offer, accept/decline).
 * Returns a cleanup function.
 */
export function attachNativePeerToStore(
  store: LyraStore,
  peer: NativePeerHandle,
): () => void {
  const syncStatus = () => {
    store.setPeerServerStatus({
      running: true,
      port: peer.port,
      url: peer.lanHost
        ? `http://${peer.lanHost}:${peer.port}`
        : peer.url,
      lanHost: peer.lanHost,
      discoveryActive: true, // HTTP /24 scan is the mobile discovery path
      lastError: null,
    });
    if (peer.lanHost) store.setLocalLanHint(peer.lanHost);
  };
  syncStatus();

  // Keep settings in sync when we fell back to an alternate port (EADDRINUSE)
  if (peer.port && peer.port !== store.getState().settings.peerListenPort) {
    store.updateSettings({ peerListenPort: peer.port });
  }

  // Identity changes
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

  // Pairing offer advertisement
  let lastOfferKey = "";
  const syncOffer = () => {
    const active = store.getState().activePairing;
    const key = active ? `${active.code}:${active.token}:${active.expiresAt}` : "";
    if (key === lastOfferKey) return;
    lastOfferKey = key;
    void peer.setPairingOffer(
      active
        ? { code: active.code, token: active.token, expiresAt: active.expiresAt }
        : null,
    );
  };
  syncOffer();

  // Accept/Decline on phone → resolve long-poll for joiners
  store.setPairDecisionResolver?.((payload) => {
    const ok = peer.resolvePairRequest(
      { deviceId: payload.deviceId, token: payload.token },
      payload.accepted
        ? {
            accepted: true,
            host: peer.lanHost ?? undefined,
            port: peer.port,
          }
        : { accepted: false, reason: payload.reason ?? "declined" },
    );
    return Promise.resolve(
      ok
        ? { ok: true as const }
        : { ok: false as const, error: "No pending pair request" },
    );
  });

  const unsub = store.subscribe(() => {
    syncIdentity();
    syncOffer();
  });

  // Refresh advertised IP periodically (Wi‑Fi ↔ Tailscale interface changes)
  const ipTimer = setInterval(() => {
    void peer.refreshLanHost().then((host) => {
      if (host) {
        store.setLocalLanHint(host);
        syncStatus();
      }
    });
  }, 20_000);

  // Initial discovery once peer is fully up — slight delay so the listen
  // socket is ready and we don't self-scan during bind races.
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  if (store.getState().settings.discoveryEnabled) {
    discoveryTimer = setTimeout(() => {
      void store.refreshDiscovery();
    }, 800);
  }

  return () => {
    if (discoveryTimer) clearTimeout(discoveryTimer);
    clearInterval(ipTimer);
    unsub();
    store.setPairDecisionResolver?.(null);
    store.setPeerServerStatus({
      running: false,
      port: null,
      url: null,
      lanHost: null,
      discoveryActive: false,
      lastError: null,
    });
  };
}
