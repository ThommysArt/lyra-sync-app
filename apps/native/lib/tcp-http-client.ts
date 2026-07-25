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

function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof data === "object" && ArrayBuffer.isView(data as ArrayBufferView)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (data && typeof data === "object" && "length" in (data as object)) {
    try {
      return Uint8Array.from(data as ArrayLike<number>);
    } catch {
      // fall through
    }
  }
  return new TextEncoder().encode(String(data ?? ""));
}

function indexOfHeaderEnd(buf: Uint8Array): number {
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

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
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

/** RFC1918 / CGNAT private — prefer Wi‑Fi interface when Tailscale VPN is up. */
function isPrivateLanIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isTailscaleIPv4(host: string): boolean {
  const m = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(host.trim());
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** Limit concurrent native sockets — RN tcp-socket crashes under scan floods. */
export const NATIVE_HTTP_MAX_IN_FLIGHT = 8;
let inFlight = 0;
type Waiter = {
  resolve: () => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};
const waitQueue: Waiter[] = [];

let logCounter = 0;
function logTcp(line: string, extra?: Record<string, unknown>) {
  // Cap spam: always log errors/warns from callers; here only every Nth success path via debug
  if (extra) {
    console.info(`[lyra tcp] ${line}`, extra);
  } else {
    console.info(`[lyra tcp] ${line}`);
  }
}

function detachWaiter(waiter: Waiter) {
  const i = waitQueue.indexOf(waiter);
  if (i >= 0) waitQueue.splice(i, 1);
  if (waiter.signal && waiter.onAbort) {
    try {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    } catch {
      // ignore
    }
  }
}

async function withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new Error("Aborted");
  }

  if (inFlight >= NATIVE_HTTP_MAX_IN_FLIGHT) {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        detachWaiter(waiter);
        reject(new Error("Aborted"));
      };
      waitQueue.push(waiter);
      if (signal) {
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  if (signal?.aborted) {
    throw new Error("Aborted");
  }

  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const next = waitQueue.shift();
    if (next) {
      if (next.signal && next.onAbort) {
        try {
          next.signal.removeEventListener("abort", next.onAbort);
        } catch {
          // ignore
        }
      }
      next.resolve();
    }
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

  const transport: HttpTransport = (url, init) =>
    withSlot(() => {
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
          const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}:${port}`];
          for (const [k, v] of Object.entries(headers)) {
            lines.push(`${k}: ${v}`);
          }
          lines.push("", body);
          const payload = lines.join("\r\n");
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
          void isPrivateLanIPv4; // retained for future multi-homed routing experiments
          void isTailscaleIPv4;

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
    }, init?.signal);

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
