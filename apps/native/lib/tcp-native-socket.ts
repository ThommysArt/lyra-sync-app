import type { LyraSocket } from "@lyra-sync-app/net";
import { Platform } from "react-native";
import Constants from "expo-constants";

function isExpoGo(): boolean {
  if (Constants.appOwnership === "expo") return true;
  const env = (Constants as { executionEnvironment?: string }).executionEnvironment;
  return env === "storeClient";
}

function loadTcpApi(): any | null {
  if (isExpoGo()) return null;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-tcp-socket") as any;
    const api = mod?.default ?? mod;
    if (api?.Socket || typeof api?.createConnection === "function") return api;
    return null;
  } catch {
    return null;
  }
}

export function createNativeTcpSocket(host: string, port: number): Promise<LyraSocket> {
  return new Promise((resolve, reject) => {
    const api = loadTcpApi();
    if (!api) return reject(new Error("TCP not available"));

    const SocketCtor = api.Socket;
    const createConnection = api.createConnection;

    let socket: any = null;
    let settled = false;

    const finishErr = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
      try { socket?.destroy(); } catch {}
    };
    const finishOk = () => {
      if (settled) return;
      settled = true;
      resolve(toLyraSocket(socket));
    };

    try {
      const opts: Record<string, unknown> = {
        host,
        port,
        reuseAddress: true,
        noDelay: true,
        keepAlive: true,
      };

      if (SocketCtor) {
        socket = new SocketCtor();
        socket.once("connect", finishOk);
        socket.once("error", finishErr);
        socket.connect(opts);
        // timeout
        setTimeout(() => {
          if (!settled) finishErr(new Error(`TCP connect timeout ${host}:${port}`));
        }, 5000);
      } else if (createConnection) {
        socket = createConnection(opts, finishOk);
        socket.once("error", finishErr);
        setTimeout(() => {
          if (!settled) finishErr(new Error(`TCP connect timeout ${host}:${port}`));
        }, 5000);
      } else {
        reject(new Error("No socket ctor"));
      }
    } catch (e) {
      finishErr(e);
    }
  });
}

function toLyraSocket(socket: any): LyraSocket {
  return {
    on: (ev: string, cb: (...a: any[]) => void) => {
      try { socket.on(ev, cb); } catch {}
    },
    once: (ev: string, cb: (...a: any[]) => void) => {
      try { socket.once(ev, cb); } catch {}
    },
    write: (data: Uint8Array | string, _enc?: string, cb?: () => void) => {
      try {
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
