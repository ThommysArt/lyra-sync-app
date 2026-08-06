/**
 * Minimal HTTP/1.1 client over react-native-tcp-socket.
 *
 * Why not RN fetch?
 * - POST to cleartext LAN/Tailscale peers often fails with "Network request failed"
 *   even when GET works on some Android builds.
 *
 * Safety:
 * - Handlers attached before connect
 * - Never write/destroy after settle (avoids IllegalArgumentException: No socket with id)
 * - Global concurrency limit so discovery scans don't flood the native module
 * - Request timeout starts AFTER a slot is acquired (queue wait must not burn the budget)
 * - Pair long-polls must use a long timeoutMs (or only AbortSignal) — never a 15s hard kill
 */
import type { HttpTransport } from "@lyra-sync-app/net";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { buildHttpRequest, concatBytes, indexOfHeaderEnd, toUint8Array } from "@lyra-sync-app/net";
import { Lane, withPrioritySlot } from "@lyra-sync-app/net";

type TcpApi = {
  Socket?: new () => {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    once: (event: string, cb: (...args: unknown[]) => void) => void;
    connect: (opts: Record<string, unknown>, cb?: () => void) => unknown;
    write: (data: string, encoding?: string) => void;
    destroy: () => void;
    destroyed?: boolean;
  };
  createConnection?: (
    opts: Record<string, unknown>,
    cb?: () => void,
  ) => {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    once: (event: string, cb: (...args: unknown[]) => void) => void;
    write: (data: string, encoding?: string) => void;
    destroy: () => void;
    destroyed?: boolean;
  };
};

function isExpoGo(): boolean {
  if (Constants.appOwnership === "expo") return true;
  const env = (Constants as { executionEnvironment?: string }).executionEnvironment;
  return env === "storeClient";
}

function loadTcpApi(): TcpApi | null {
  if (isExpoGo()) return null;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-tcp-socket") as TcpApi & { default?: TcpApi };
    // Metro may expose either the default export or the module namespace
    const api = (mod?.default ?? mod) as TcpApi;
    if (api?.Socket || typeof api?.createConnection === "function") return api;
    console.warn("[lyra tcp] react-native-tcp-socket loaded but Socket/createConnection missing", {
      keys: Object.keys(mod ?? {}),
    });
    return null;
  } catch (e) {
    console.warn(
      "[lyra tcp] react-native-tcp-socket unavailable",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

function parseUrl(url: string): { host: string; port: number; path: string } {
  const u = new URL(url);
  if (u.protocol !== "http:") {
    throw new Error(`tcp-http only supports http:// (got ${u.protocol})`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = u.port ? Number(u.port) : 80;
  const path = `${u.pathname || "/"}${u.search || ""}`;
  return { host, port, path };
}

// Re-export for compat + keep deprecated helpers referenced
export const NATIVE_HTTP_MAX_IN_FLIGHT = 8;
const toBytes = toUint8Array;
const concat = concatBytes;
// Retained for future multi-homed routing experiments — now housed in httpCodec
void indexOfHeaderEnd;

let logCounter = 0;
function logTcp(line: string, extra?: Record<string, unknown>) {
  if (extra) {
    console.info(`[lyra tcp] ${line}`, extra);
  } else {
    console.info(`[lyra tcp] ${line}`);
  }
}

/**
 * Create an HttpTransport backed by react-native-tcp-socket, or null if unavailable.
 */
export function createTcpHttpTransport(): HttpTransport | null {
  const TcpSocket = loadTcpApi();
  if (!TcpSocket) return null;

  const SocketCtor = TcpSocket.Socket;
  const createConnection = TcpSocket.createConnection;
  if (!SocketCtor && typeof createConnection !== "function") {
    return null;
  }

  const transport: HttpTransport = (url, init) => {
    const laneRaw = typeof init?.lane === "number" ? init.lane : Lane.INTERACTIVE;
    const lane = laneRaw === 0 ? Lane.PAIR : laneRaw === 2 ? Lane.SCAN : Lane.INTERACTIVE;
    return withPrioritySlot(
      () => {
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ?? "";
        const headers: Record<string, string> = {
          accept: "application/json",
          connection: "close",
          ...(init?.headers ?? {}),
        };
        if (body && !headers["content-type"] && !headers["Content-Type"]) {
          headers["content-type"] = "application/json";
        }
        if (body) {
          headers["content-length"] = String(new TextEncoder().encode(body).byteLength);
        }

      const { host, port, path } = parseUrl(url);
      const reqId = ++logCounter;
      const started = Date.now();
      const isLongPoll = (init?.timeoutMs ?? 0) > 30_000 || (init?.signal && !init?.timeoutMs);

      return new Promise((resolve, reject) => {
        let settled = false;
        let wrote = false;
        const chunks: Uint8Array[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let socket: any = null;
        let hardTimer: ReturnType<typeof setTimeout> | undefined;

        const safeDestroy = () => {
          if (!socket) return;
          const s = socket;
          socket = null;
          try {
            if (!s.destroyed) s.destroy();
          } catch {
            // Native may already have dropped the id — must never throw
          }
        };

        const finishErr = (err: unknown) => {
          if (settled) return;
          settled = true;
          if (hardTimer) clearTimeout(hardTimer);
          if (init?.signal) {
            try {
              init.signal.removeEventListener("abort", onAbort);
            } catch {
              // ignore
            }
          }
          safeDestroy();
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[lyra tcp] #${reqId} ${method} ${host}:${port}${path} FAIL ${Date.now() - started}ms · ${msg}`,
          );
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        const finishOk = (status: number, responseBody: string) => {
          if (settled) return;
          settled = true;
          if (hardTimer) clearTimeout(hardTimer);
          if (init?.signal) {
            try {
              init.signal.removeEventListener("abort", onAbort);
            } catch {
              // ignore
            }
          }
          safeDestroy();
          const ms = Date.now() - started;
          if (isLongPoll || status >= 400 || ms > 2000) {
            logTcp(`#${reqId} ${method} ${host}:${port}${path} → ${status} ${ms}ms`, {
              bodyBytes: responseBody.length,
            });
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => responseBody,
          });
        };

        const onAbort = () => finishErr(new Error("Aborted"));

        const tryParse = () => {
          if (settled) return;
          const raw = concat(chunks);
          const headerEnd = indexOfHeaderEnd(raw);
          if (headerEnd < 0) {
            if (raw.byteLength > 256 * 1024) {
              finishErr(new Error("HTTP headers too large"));
            }
            return;
          }
          const head = new TextDecoder().decode(raw.subarray(0, headerEnd));
          const headLines = head.split("\r\n");
          const statusMatch = /^HTTP\/\d\.\d\s+(\d+)/.exec(headLines[0] ?? "");
          const status = statusMatch ? Number(statusMatch[1]) : 0;
          const respHeaders: Record<string, string> = {};
          for (let i = 1; i < headLines.length; i++) {
            const line = headLines[i]!;
            const colon = line.indexOf(":");
            if (colon > 0) {
              respHeaders[line.slice(0, colon).trim().toLowerCase()] = line
                .slice(colon + 1)
                .trim();
            }
          }
          const contentLength = Number.parseInt(respHeaders["content-length"] ?? "", 10);
          const bodyStart = headerEnd + 4;
          if (Number.isFinite(contentLength) && contentLength >= 0) {
            if (raw.byteLength < bodyStart + contentLength) return;
            const bodyBytes = raw.subarray(bodyStart, bodyStart + contentLength);
            finishOk(status, new TextDecoder().decode(bodyBytes));
            return;
          }
          // No Content-Length — wait for close (long-poll pair_confirm uses CL usually)
        };

        const writeRequest = () => {
          if (settled || wrote || !socket || socket.destroyed) return;
          wrote = true;
          const payload = buildHttpRequest({ method, path, host, port, headers, body });
          try {
            if (socket.destroyed) {
              finishErr(new Error("Socket closed before write"));
              return;
            }
            socket.write(payload, "utf8");
          } catch (e) {
            finishErr(e);
          }
        };

        try {
          if (init?.signal?.aborted) {
            finishErr(new Error("Aborted"));
            return;
          }
          if (init?.signal) {
            init.signal.addEventListener("abort", onAbort, { once: true });
          }

          // Timeout starts AFTER slot acquisition.
          // - Explicit timeoutMs always wins (scans, probes, pair long-poll).
          // - If only AbortSignal is set (pair wait), use a generous safety net so we
          //   do NOT kill a 120s accept long-poll at 15s (previous bug).
          // - Otherwise short default for opportunistic GETs.
          const timeoutMs =
            typeof init?.timeoutMs === "number" && init.timeoutMs > 0
              ? init.timeoutMs
              : init?.signal
                ? 180_000
                : 12_000;
          hardTimer = setTimeout(() => {
            if (!settled) {
              finishErr(
                new Error(
                  `TCP HTTP request timed out after ${timeoutMs}ms (${method} ${host}:${port}${path})`,
                ),
              );
            }
          }, timeoutMs);

          // NOTE: Do NOT set `interface: "wifi"`. On Android, selectNetwork() can throw
          // "Interface wifi unreachable" *before* the socket is registered in the native
          // map; the JS error handler then calls destroy() → crash:
          // IllegalArgumentException: No socket with id N
          const connectOpts: Record<string, unknown> = {
            host,
            port,
            reuseAddress: true,
            // Fail connect faster than full request budget when possible
            connectTimeout: Math.min(
              Math.max(timeoutMs, 1),
              isLongPoll ? 15_000 : Math.min(timeoutMs, 8_000),
            ),
          };

          if (SocketCtor) {
            socket = new SocketCtor();
          } else if (createConnection) {
            socket = createConnection(connectOpts, writeRequest);
          } else {
            finishErr(new Error("No TCP socket constructor"));
            return;
          }

          socket.on("data", (data: unknown) => {
            if (settled) return;
            try {
              chunks.push(toBytes(data));
              tryParse();
            } catch (e) {
              finishErr(e);
            }
          });

          socket.on("error", (err: unknown) => {
            finishErr(err instanceof Error ? err : new Error(String(err ?? "TCP error")));
          });

          socket.on("close", () => {
            if (settled) return;
            const raw = concat(chunks);
            const headerEnd = indexOfHeaderEnd(raw);
            if (headerEnd < 0) {
              finishErr(
                new Error(
                  `Connection closed before HTTP response (${method} ${host}:${port}${path})`,
                ),
              );
              return;
            }
            const head = new TextDecoder().decode(raw.subarray(0, headerEnd));
            const statusMatch = /^HTTP\/\d\.\d\s+(\d+)/.exec(head.split("\r\n")[0] ?? "");
            const status = statusMatch ? Number(statusMatch[1]) : 0;
            const bodyBytes = raw.subarray(headerEnd + 4);
            finishOk(status, new TextDecoder().decode(bodyBytes));
          });

          if (SocketCtor) {
            socket.once("connect", writeRequest);
            socket.connect(connectOpts);
          }
        } catch (e) {
          finishErr(e);
        }
      });
      },
      lane,
      init?.signal,
    );
  };

  return transport;
}

/** Install TCP transport for peer-client (no-op when Expo Go / unavailable). */
export function installNativePeerHttpTransport(): () => void {
  const transport = createTcpHttpTransport();
  if (!transport) {
    console.warn(
      "[lyra] TCP HTTP transport UNAVAILABLE — peer ops use fetch (cleartext LAN/Tailscale often fails on Android)",
    );
    return () => undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("@lyra-sync-app/net") as typeof import("@lyra-sync-app/net");
    net.setHttpTransport(transport);
    console.info(
      `[lyra] peer HTTP transport = react-native-tcp-socket (max ${NATIVE_HTTP_MAX_IN_FLIGHT} concurrent)`,
    );
    return () => {
      net.setHttpTransport(null);
    };
  } catch (e) {
    console.warn("[lyra] setHttpTransport sync failed, trying async", e);
    void import("@lyra-sync-app/net").then(({ setHttpTransport }) => {
      setHttpTransport(transport);
      console.info("[lyra] peer HTTP transport = react-native-tcp-socket (async install)");
    });
    return () => {
      void import("@lyra-sync-app/net").then(({ setHttpTransport }) => {
        setHttpTransport(null);
      });
    };
  }
}
