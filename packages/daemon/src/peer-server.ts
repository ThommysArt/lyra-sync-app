import * as http from "node:http";
import * as os from "node:os";
import type { DeviceIdentity, LyraEnvelope } from "@lyra-sync-app/protocol";
import type { DaemonConfig } from "./types.js";
import { unsealPayload } from "./seal.js";
import { appendChunk, createTransferState, type TransferState } from "./transfer.js";
import type { FileEntry, Transfer } from "@lyra-sync-app/protocol";

type PeerServerHandlers = {
  onClipboardPush?: (envelope: LyraEnvelope, payload: unknown) => void | Promise<void>;
  onTransferOffer?: (envelope: LyraEnvelope, payload: unknown) => void | Promise<void>;
  onFsList?: (path: string) => Promise<FileEntry[]>;
  onOpenUrl?: (url: string) => void | Promise<void>;
  onPairRequest?: (payload: unknown) => void | Promise<void>;
};

type PeerServerOptions = DaemonConfig & {
  handlers?: PeerServerHandlers;
};

export type PeerServer = {
  port: number;
  url: string;
  protocol: string;
  getLanHost(): string | null;
  close(): Promise<void>;
  setIdentity(id: DeviceIdentity): void;
  revokeDevice(deviceId: string): number;
  resolvePairRequest(match: string | { token: string }, decision: boolean): boolean;
};

function getLanHost(): string | null {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return null;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-lyra-token",
  });
  res.end(body);
}

function parseBody(req: http.IncomingMessage): Promise<{ raw: Buffer; json: unknown | null }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) return resolve({ raw, json: null });
      const ct = req.headers["content-type"] ?? "";
      if (typeof ct === "string" && ct.includes("application/json")) {
        try {
          const json = JSON.parse(raw.toString("utf8")) as unknown;
          resolve({ raw, json });
        } catch {
          resolve({ raw, json: null });
        }
      } else {
        resolve({ raw, json: null });
      }
    });
    req.on("error", () => resolve({ raw: Buffer.alloc(0), json: null }));
  });
}

export async function startPeerServer(opts: PeerServerOptions): Promise<PeerServer> {
  let identity: DeviceIdentity = opts.identity;
  const downloadDir = opts.downloadDir ?? os.tmpdir();
  const log = opts.onLog ?? (() => {});
  const trusted = new Map<string, { fingerprint: string; authSecret: string }>();
  const pendingPairs = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  const transfers = new Map<string, TransferState>();

  // allow initial trusted seeding via no-op; revokeDevice will handle

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-lyra-token",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/lyra/info") {
        const offer = opts.getPairingOffer?.() ?? null;
        sendJson(res, 200, {
          v: 2,
          id: identity.id,
          name: identity.name,
          fingerprint: identity.fingerprint,
          publicKey: identity.publicKey,
          platform: identity.platform,
          type: identity.type,
          pairingOffer: offer,
          port: (server.address() as { port?: number } | null)?.port ?? opts.port,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/lyra/pair") {
        const { json } = await parseBody(req);
        const body = (json ?? {}) as Record<string, unknown>;
        const token = typeof body["token"] === "string" ? (body["token"] as string) : "";
        if (!token) {
          sendJson(res, 400, { ok: false, error: "missing token" });
          return;
        }
        // notify handler
        void opts.handlers?.onPairRequest?.(body);

        // long-poll 60s
        const decision = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            pendingPairs.delete(token);
            resolve(false);
          }, 60_000);
          pendingPairs.set(token, { resolve: (v) => { clearTimeout(timer); resolve(v); }, timer });
        });
        // if pending still exists, it was timeout; else resolved via resolvePairRequest
        pendingPairs.delete(token);
        if (decision) sendJson(res, 200, { ok: true, paired: true });
        else sendJson(res, 200, { ok: true, paired: false, status: "timeout_or_rejected" });
        return;
      }

      if (req.method === "POST" && pathname === "/lyra/message") {
        const { json } = await parseBody(req);
        const envelope = json as LyraEnvelope | null;
        if (!envelope || typeof (envelope as { type?: unknown }).type !== "string") {
          sendJson(res, 400, { ok: false, error: "invalid envelope" });
          return;
        }
        let payload: unknown = (envelope as { payload?: unknown }).payload;
        if (envelope.seal) {
          const secret = await opts.resolvePeerAuth?.(envelope.fromDeviceId, undefined) ?? null;
          const fallback = trusted.get(envelope.fromDeviceId)?.authSecret ?? null;
          const authSecret = secret ?? fallback;
          if (authSecret) {
            try {
              payload = await unsealPayload(envelope.seal, authSecret);
            } catch (err) {
              log(`unseal failed for ${envelope.fromDeviceId}: ${String(err)}`);
            }
          }
        }

        // route by type
        const type = envelope.type as string;
        if (type === "clipboard_push") {
          await opts.handlers?.onClipboardPush?.(envelope, payload);
        } else if (type === "transfer_offer") {
          await opts.handlers?.onTransferOffer?.(envelope, payload);
          // if transfer offer contains Transfer, create state
          const maybe = payload as Partial<Transfer> | null;
          if (maybe && typeof maybe["transferId"] === "string" && Array.isArray(maybe["files"])) {
            try {
              const state = await createTransferState(maybe as Transfer);
              void downloadDir;
              transfers.set(maybe["transferId"] as string, state);
            } catch (err) {
              log(`createTransferState failed: ${String(err)}`);
            }
          }
        } else if (type === "open_url") {
          const u = (payload as { url?: string } | null)?.url ?? (payload as string | null);
          if (typeof u === "string") await opts.handlers?.onOpenUrl?.(u);
        } else if (type === "fs_list") {
          const p = (payload as { path?: string } | null)?.path ?? "/";
          if (opts.handlers?.onFsList) {
            const list = await opts.handlers.onFsList(p);
            sendJson(res, 200, { ok: true, type: "fs_list_response", payload: { entries: list } });
            return;
          }
        }

        void opts.onEnvelope?.(envelope);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/lyra/file/chunk") {
        const transferId = url.searchParams.get("transferId") ?? (req.headers["x-transfer-id"] as string | undefined) ?? "";
        const offsetStr = url.searchParams.get("offset") ?? (req.headers["x-offset"] as string | undefined) ?? "0";
        const offset = Number.parseInt(offsetStr, 10) || 0;
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => resolve());
          req.on("error", reject);
        });
        const data = Buffer.concat(chunks);
        if (transferId) {
          let state = transfers.get(transferId);
          if (!state) {
            // create stub state if not exists
            const offer: Transfer = {
              transferId,
              files: [{ name: `${transferId}.bin`, size: data.length + offset }],
              totalBytes: data.length + offset,
              status: "in_progress",
            };
            state = await createTransferState(offer);
            transfers.set(transferId, state);
          }
          await appendChunk(state, offset, new Uint8Array(data));
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      log(`peer-server error ${pathname}: ${String(err)}`);
      if (!res.writableEnded) sendJson(res, 500, { ok: false, error: String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "0.0.0.0", () => resolve());
  });

  const addr = server.address() as { port: number } | null;
  const port = addr?.port ?? opts.port;
  const protocol = opts.tls ? "https" : "http";

  log(`peer server listening ${protocol}://0.0.0.0:${port}`);

  return {
    port,
    url: `${protocol}://0.0.0.0:${port}`,
    protocol,
    getLanHost,
    close: async () => {
      for (const { timer } of pendingPairs.values()) clearTimeout(timer);
      pendingPairs.clear();
      for (const s of transfers.values()) {
        try {
          await s.fd?.close();
        } catch {}
      }
      transfers.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    setIdentity: (id: DeviceIdentity) => {
      identity = id;
    },
    revokeDevice: (deviceId: string) => {
      if (trusted.delete(deviceId)) return 1;
      return 0;
    },
    resolvePairRequest: (match: string | { token: string }, decision: boolean) => {
      const token = typeof match === "string" ? match : match.token;
      const entry = pendingPairs.get(token);
      if (!entry) return false;
      pendingPairs.delete(token);
      clearTimeout(entry.timer);
      entry.resolve(decision);
      return true;
    },
  };
}
