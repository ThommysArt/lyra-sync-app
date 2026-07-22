/**
 * React Native peer HTTP server (TCP + minimal HTTP/1.1).
 * Each mobile device hosts its own /lyra/* endpoints so desktops can pair,
 * push clipboard, and transfer files to the phone.
 *
 * Requires a dev client / release build (not Expo Go) — needs native TCP sockets.
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

/** Parse one or more HTTP requests from a TCP buffer (single request expected). */
function parseHttpRequest(raw: string): {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
} | null {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const head = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd + 4);
  const lines = head.split("\r\n");
  const requestLine = lines[0];
  if (!requestLine) return null;
  const parts = requestLine.split(" ");
  const method = parts[0] ?? "GET";
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
  if (contentLength > 0 && body.length < contentLength) {
    // Incomplete body — caller should wait for more data
    return null;
  }
  return {
    method,
    path,
    headers,
    body: contentLength > 0 ? body.slice(0, contentLength) : body,
  };
}

function buildHttpResponse(status: number, headers: Record<string, string> | undefined, body: string): string {
  const h = { ...(headers ?? {}) };
  if (body && !h["content-length"] && !h["Content-Length"]) {
    h["content-length"] = String(new TextEncoder().encode(body).byteLength);
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

  type Server = ReturnType<TcpSocketModule["createServer"]>;
  let server: Server | null = null;
  let listenError: Error | null = null;

  for (const tryPort of candidates) {
    listenError = null;
    const result = await new Promise<{ server: Server; port: number } | { error: Error }>(
      (resolve) => {
        let settled = false;
        const srv = TcpSocket.createServer((socket) => {
          let buf = "";
          socket.on("data", (data) => {
            buf += typeof data === "string" ? data : data.toString("utf8");
            const parsed = parseHttpRequest(buf);
            if (!parsed) {
              // Wait for more data (up to ~2MB safety)
              if (buf.length > 2_000_000) {
                try {
                  socket.write(
                    buildHttpResponse(400, { "content-type": "application/json" }, '{"error":"Request too large"}'),
                  );
                } catch {
                  // ignore
                }
                socket.destroy();
              }
              return;
            }
            buf = "";
            const remote =
              // @ts-expect-error address() exists on RN TCP sockets
              typeof socket.address === "function"
                ? // remote address via internal fields when available
                  (socket as { remoteAddress?: string }).remoteAddress
                : (socket as { remoteAddress?: string }).remoteAddress;

            void core
              .handle({
                method: parsed.method,
                path: parsed.path,
                headers: parsed.headers,
                body: parsed.body,
                remoteAddress: remote ?? null,
              })
              .then((res) => {
                const payload = buildHttpResponse(res.status, res.headers, res.body);
                try {
                  socket.write(payload, "utf8", () => {
                    socket.destroy();
                  });
                } catch {
                  socket.destroy();
                }
              })
              .catch((err) => {
                console.warn("[lyra peer] request error", err);
                try {
                  socket.write(
                    buildHttpResponse(
                      500,
                      { "content-type": "application/json" },
                      JSON.stringify({ error: "Internal error" }),
                    ),
                  );
                } catch {
                  // ignore
                }
                socket.destroy();
              });
          });
          socket.on("error", () => {
            try {
              socket.destroy();
            } catch {
              // ignore
            }
          });
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
          // @ts-expect-error address() return shape varies
          const addr = srv.address?.() as { port?: number } | string | null;
          const actual =
            addr && typeof addr === "object" && typeof addr.port === "number"
              ? addr.port
              : tryPort === 0
                ? preferred
                : tryPort;
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
  store.setPeerServerStatus({
    running: true,
    port: peer.port,
    url: peer.url,
    lanHost: peer.lanHost,
    discoveryActive: true, // HTTP /24 scan is the mobile discovery path
    lastError: null,
  });
  if (peer.lanHost) store.setLocalLanHint(peer.lanHost);
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

  // Initial discovery scan once peer is up
  if (store.getState().settings.discoveryEnabled) {
    void store.refreshDiscovery();
  }

  return () => {
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
