// @ts-nocheck
import { createConnection, type Socket } from "node:net";
import type { LyraSocket } from "./connection";

export function createNodeTcpSocket(host: string, port: number): Promise<LyraSocket> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ host, port }, () => {
      resolve(toLyraSocket(socket));
    });
    socket.once("error", (err) => {
      reject(err);
    });
    // timeout 5s
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`TCP connect timeout ${host}:${port}`));
    });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
  });
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
