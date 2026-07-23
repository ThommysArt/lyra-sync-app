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
 */
import type { HttpTransport } from "@lyra-sync-app/net";
import { Platform } from "react-native";
import Constants from "expo-constants";

type TcpSocketModule = typeof import("react-native-tcp-socket");

function isExpoGo(): boolean {
  if (Constants.appOwnership === "expo") return true;
  const env = (Constants as { executionEnvironment?: string }).executionEnvironment;
  return env === "storeClient";
}

function loadTcp(): TcpSocketModule | null {
  if (isExpoGo()) return null;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("react-native-tcp-socket") as TcpSocketModule;
  } catch {
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

/** Limit concurrent native sockets — RN tcp-socket crashes under scan floods. */
const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const waitQueue: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => {
      waitQueue.push(resolve);
    });
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const next = waitQueue.shift();
    if (next) next();
  }
}

/**
 * Create an HttpTransport backed by react-native-tcp-socket, or null if unavailable.
 */
export function createTcpHttpTransport(): HttpTransport | null {
  const TcpSocket = loadTcp();
  if (!TcpSocket) return null;

  // Socket constructor is on the module default export
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SocketCtor = (TcpSocket as any).Socket as (new () => any) | undefined;
  if (!SocketCtor && typeof TcpSocket.createConnection !== "function") {
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
          // No Content-Length — wait for close
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

          // Construct socket, attach listeners, THEN connect (avoids missed events)
          if (SocketCtor) {
            socket = new SocketCtor();
          } else {
            // Fallback: createConnection (listeners may race on very fast connect)
            socket = TcpSocket.createConnection({ host, port, reuseAddress: true }, writeRequest);
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

          socket.on("error", (err: Error) => {
            finishErr(err ?? new Error("TCP error"));
          });

          socket.on("close", () => {
            if (settled) return;
            const raw = concat(chunks);
            const headerEnd = indexOfHeaderEnd(raw);
            if (headerEnd < 0) {
              finishErr(new Error("Connection closed before HTTP response"));
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
            socket.connect({ host, port, reuseAddress: true });
          }

          const timeoutMs = init?.signal ? 20_000 : 10_000;
          hardTimer = setTimeout(() => {
            if (!settled) finishErr(new Error("TCP HTTP request timed out"));
          }, timeoutMs);
        } catch (e) {
          finishErr(e);
        }
      });
    });

  return transport;
}

/** Install TCP transport for peer-client (no-op when Expo Go / unavailable). */
export function installNativePeerHttpTransport(): () => void {
  const transport = createTcpHttpTransport();
  if (!transport) {
    console.info("[lyra] TCP HTTP transport unavailable — using fetch");
    return () => undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setHttpTransport } = require("@lyra-sync-app/net") as typeof import("@lyra-sync-app/net");
    setHttpTransport(transport);
    console.info("[lyra] peer HTTP uses react-native-tcp-socket transport");
    return () => {
      setHttpTransport(null);
    };
  } catch {
    void import("@lyra-sync-app/net").then(({ setHttpTransport }) => {
      setHttpTransport(transport);
      console.info("[lyra] peer HTTP uses react-native-tcp-socket transport (async)");
    });
    return () => {
      void import("@lyra-sync-app/net").then(({ setHttpTransport }) => {
        setHttpTransport(null);
      });
    };
  }
}
