import * as http from "node:http";
import * as os from "node:os";
import type { DeviceIdentity, LyraEnvelope } from "@lyra-sync-app/protocol";
import type { DaemonConfig, TrustedPeer } from "./types.js";
import { unsealPayload } from "./seal.js";
import { appendChunk, createTransferState, finalizeTransfer, type TransferState } from "./transfer.js";
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
  syncTrustedPeers(peers: TrustedPeer[]): void;
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

  // seed trusted peers from config
  if (Array.isArray(opts.trustedPeers)) {
    for (const p of opts.trustedPeers) {
      if (p.deviceId && p.authSecret) {
        trusted.set(p.deviceId, { fingerprint: p.fingerprint, authSecret: p.authSecret });
      }
    }
  }

  function syncTrustedPeers(peers: TrustedPeer[]): void {
    trusted.clear();
    for (const p of peers ?? []) {
      if (!p.deviceId || !p.authSecret) continue;
      trusted.set(p.deviceId, { fingerprint: p.fingerprint, authSecret: p.authSecret });
    }
    log(`trusted peers synced: ${trusted.size}`);
  }

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
        let trustedForSeal = false;
        if (envelope.seal) {
          // lookup authSecret via opts.resolvePeerAuth OR trusted map
          let authSecret: string | null = null;
          try {
            const viaResolve = await opts.resolvePeerAuth?.(envelope.fromDeviceId, undefined);
            if (typeof viaResolve === "string" && viaResolve) authSecret = viaResolve;
          } catch {}
          if (!authSecret) {
            const fallback = trusted.get(envelope.fromDeviceId)?.authSecret ?? null;
            if (fallback) authSecret = fallback;
          }
          trustedForSeal = !!authSecret;
          // if trusted entry exists but resolve didn't return, also consider trusted map directly
          if (!authSecret) {
            const t = trusted.get(envelope.fromDeviceId);
            if (t) {
              authSecret = t.authSecret;
              trustedForSeal = true;
            }
          }
          if (authSecret) {
            try {
              payload = await unsealPayload(envelope.seal, authSecret);
            } catch (err) {
              log(`unseal failed for ${envelope.fromDeviceId}: ${String(err)}`);
              if (trustedForSeal) {
                sendJson(res, 401, { ok: false, error: "unauthorized: seal verification failed" });
                return;
              }
            }
          } else {
            // no secret available but seal present — if peer is in trusted map, fail
            if (trusted.has(envelope.fromDeviceId)) {
              sendJson(res, 401, { ok: false, error: "unauthorized: missing auth secret" });
              return;
            }
          }
        }

        // route by type
        const type = envelope.type as string;
        if (type === "clipboard_push") {
          await opts.handlers?.onClipboardPush?.(envelope, payload);
        } else if (type === "transfer_offer") {
          await opts.handlers?.onTransferOffer?.(envelope, payload);
          const maybe = payload as Partial<Transfer> | null;
          if (maybe && typeof maybe["transferId"] === "string" && Array.isArray(maybe["files"])) {
            try {
              const state = await createTransferState(maybe as Transfer);
              transfers.set(maybe["transferId"] as string, state);
            } catch (err) {
              log(`createTransferState failed: ${String(err)}`);
            }
          }
        } else if (type === "transfer_chunk") {
          const p = payload as { transferId?: string; offset?: number; dataBase64?: string; data?: string } | null;
          const tid = p?.transferId ?? (envelope.payload as { transferId?: string } | null)?.transferId ?? "";
          const offset = typeof p?.offset === "number" ? p.offset : 0;
          const b64 = p?.dataBase64 ?? p?.data ?? "";
          if (tid && b64) {
            let state = transfers.get(tid);
            if (!state) {
              // stub if offer missed
              const offer: Transfer = {
                transferId: tid,
                files: [{ name: `${tid}.bin`, size: offset + Buffer.from(b64, "base64").length }],
                totalBytes: offset + Buffer.from(b64, "base64").length,
                status: "in_progress",
              };
              state = await createTransferState(offer);
              transfers.set(tid, state);
            }
            const bytes = new Uint8Array(Buffer.from(b64, "base64"));
            await appendChunk(state, offset, bytes);
          }
        } else if (type === "transfer_complete") {
          const p = payload as { transferId?: string; transfer_id?: string } | null;
          const tid = p?.transferId ?? p?.transfer_id ?? (envelope.payload as { transferId?: string } | null)?.transferId ?? "";
          if (tid) {
            const state = transfers.get(tid);
            if (state) {
              try {
                const result = await finalizeTransfer(state, downloadDir);
                transfers.delete(tid);
                // emit completion for daemon listeners
                void opts.onEnvelope?.({ ...envelope, payload: { ...((payload as object) ?? {}), savedPaths: result.savedPaths, ok: result.ok, error: result.error } } as LyraEnvelope);
                // also notify via lyra:transfer-complete concept — reuse onEnvelope with enriched payload
                log(`transfer complete ${tid} -> ${result.savedPaths.join(", ")} ok=${result.ok}`);
                sendJson(res, 200, { ok: result.ok, savedPaths: result.savedPaths, error: result.error });
                return;
              } catch (err) {
                log(`finalizeTransfer failed ${tid}: ${String(err)}`);
                sendJson(res, 500, { ok: false, error: String(err) });
                return;
              }
            }
          }
        } else if (type === "transfer_pause" || type === "transfer_resume") {
          // pause/resume are client-side signals; just forward
          void opts.onEnvelope?.(envelope);
          sendJson(res, 200, { ok: true });
          return;
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

  // port candidates loop for EADDRINUSE (like old main.ts:404)
  const portCandidates = [opts.port, opts.port + 2, opts.port + 4];
  let lastErr: unknown = null;
  let listeningPort: number | null = null;
  for (const candidate of portCandidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: unknown) => {
          server.removeListener("listening", onListen);
          reject(err);
        };
        const onListen = () => {
          server.removeListener("error", onErr);
          resolve();
        };
        server.once("error", onErr);
        server.once("listening", onListen);
        server.listen(candidate, "0.0.0.0");
      });
      listeningPort = candidate;
      break;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as { code?: string })?.code;
      if (code === "EADDRINUSE") {
        log(`port ${candidate} in use, trying next`);
        continue;
      }
      throw err;
    }
  }
  if (listeningPort === null) {
    throw lastErr ?? new Error(`failed to listen on ports ${portCandidates.join(", ")}`);
  }

  const addr = server.address() as { port: number } | null;
  const port = addr?.port ?? listeningPort ?? opts.port;
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
          await (s.fh ?? s.fd)?.close();
        } catch {}
        // best-effort cleanup tmpDir
        try {
          const { promises: fsp } = await import("node:fs");
          await fsp.rm(s.tmpDir, { recursive: true, force: true });
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
    syncTrustedPeers,
  };
}
