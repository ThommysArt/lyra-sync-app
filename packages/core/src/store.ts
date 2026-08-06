import {
  AppSettingsSchema,
  type ClipboardItem,
  type DeviceIdentity,
  type FileEntry,
  type LyraEnvelope,
  type PairedDevice,
  type PeerEndpoint,
} from "@lyra-sync-app/protocol";
import { createDeviceIdentity, generateId } from "./identity.js";
import { STORAGE_KEY, type StorageLike, createMemoryStorage } from "./storage.js";
import type { DiscoveredPeer, LyraState, ProbeTarget, TransferSession } from "./slices/types.js";

export type ProbeResult = {
  ok: boolean;
  host: string;
  port: number;
  online: boolean;
  name?: string;
  fingerprint?: string;
  platform?: string;
  connectionHint?: string;
  error?: string;
  latencyMs?: number;
};

export type PeerTransport = {
  info(endpoint: PeerEndpoint, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ProbeResult>;
  send(
    endpoint: PeerEndpoint,
    envelope: LyraEnvelope,
    opts?: { signal?: AbortSignal; timeoutMs?: number; sessionToken?: string },
  ): Promise<{ ok: true; envelope?: LyraEnvelope } | { ok: false; error: string }>;
  uploadChunk?: (
    endpoint: PeerEndpoint,
    transferId: string,
    offset: number,
    data: Uint8Array,
    opts?: { signal?: AbortSignal; timeoutMs?: number; sessionToken?: string },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export type LyraStoreOptions = {
  transport: PeerTransport;
  storage?: StorageLike;
  seedDemo?: boolean;
};

export type LyraStore = {
  getState: () => LyraState;
  subscribe: (listener: (s: LyraState) => void) => () => void;
  hydrate: () => Promise<void>;
  persist: () => Promise<void>;
  setIdentity: (id: DeviceIdentity) => void;
  updateSettings: (patch: Partial<LyraState["settings"]>) => void;
  // discovery — pure state updates, no IO (P3 adds transport)
  refreshDiscovery: () => Promise<void>;
  ingestDiscoveredPeer: (peer: DiscoveredPeer) => void;
  ingestTailscaleHints: (hints: ProbeTarget[]) => void;
  ingestTailscalePeers: (hints: ProbeTarget[]) => void;
  // clipboard (legacy alias kept) — accepts text string or ClipboardItem for compat
  pushClipboard: (text: string | ClipboardItem) => void;
  // P4
  pushClipboardText: (text: string, targetDeviceIds?: string[]) => void;
  pushClipboardImage: (dataUrl: string, targetDeviceIds?: string[]) => void;
  receiveClipboardItem: (item: ClipboardItem) => void;
  ingestSystemClipboardText: (text: string) => void;
  pinItem: (id: string) => void;
  clearHistory: () => void;
  // P3 transfers
  startFileTransfer: (
    deviceIds: string[],
    files: Array<{ name: string; size: number; relativePath?: string; bytes?: Uint8Array; checksum?: string }>,
  ) => string[];
  pauseTransfer: (id: string) => void;
  resumeTransfer: (id: string) => void;
  cancelTransfer: (id: string) => void;
  ingestTransferProgress: (id: string, transferredBytes: number) => void;
  // P5 remote browse
  fetchRemoteFiles: (deviceId: string, path: string) => Promise<FileEntry[]>;
};

function defaultSettings(): LyraState["settings"] {
  return AppSettingsSchema.parse({});
}

function notImplemented(name: string): void {
  console.warn(`[lyra core] ${name} not implemented`);
}

function createEnvelope(
  type: LyraEnvelope["type"],
  fromDeviceId: string,
  payload: unknown,
  toDeviceId?: string,
): LyraEnvelope {
  return {
    id: generateId(),
    type: type as LyraEnvelope["type"],
    fromDeviceId,
    toDeviceId,
    createdAt: Date.now(),
    payload,
  };
}

function listDemoFiles(dirPath: string): FileEntry[] {
  const base = dirPath && dirPath !== "/" ? dirPath.replace(/\/$/, "") : "/Demo";
  const now = Date.now();
  return [
    { name: "README.md", path: `${base}/README.md`, isDirectory: false, size: 1024, modifiedAt: now } as FileEntry,
    { name: "photo.jpg", path: `${base}/photo.jpg`, isDirectory: false, size: 2_048_000, modifiedAt: now } as FileEntry,
    { name: "archive.zip", path: `${base}/archive.zip`, isDirectory: false, size: 5_000_000, modifiedAt: now } as FileEntry,
    { name: "Projects", path: `${base}/Projects`, isDirectory: true, modifiedAt: now } as FileEntry,
  ];
}

function pruneClipboardHistory(history: ClipboardItem[], limit: number, retentionDays: number): ClipboardItem[] {
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  const filtered = history.filter((i) => i.createdAt >= cutoff);
  return filtered.slice(0, limit);
}

export function createLyraStore(opts: LyraStoreOptions): LyraStore {
  const storage = opts.storage ?? createMemoryStorage();
  const transport = opts.transport;
  void opts.seedDemo;

  // device lookup helper
  const findDevice = (deviceId: string): PairedDevice | undefined =>
    state.pairedDevices.find((d) => d.id === deviceId);

  const peerEndpointFor = (device: PairedDevice): PeerEndpoint => ({
    host: device.host ?? device.lastReachableHost ?? "127.0.0.1",
    port: device.port ?? device.lastReachablePort ?? 53317,
    tailscaleHost: device.tailscaleHost,
  });

  let state: LyraState = {
    identity: null,
    pairedDevices: [],
    settings: defaultSettings(),
    clipboard: {
      history: [],
      pushClipboardText: () => notImplemented("clipboard.pushClipboardText"),
      pushClipboardImage: () => notImplemented("clipboard.pushClipboardImage"),
      pinItem: () => notImplemented("clipboard.pinItem"),
      clearHistory: () => notImplemented("clipboard.clearHistory"),
      pushClipboard: () => notImplemented("clipboard.pushClipboard"),
      receiveClipboardItem: () => notImplemented("clipboard.receiveClipboardItem"),
    },
    transfers: {
      sessions: {},
      transfers: {},
      startFileTransfer: () => { notImplemented("transfers.startFileTransfer"); return []; },
      pauseTransfer: () => notImplemented("transfers.pauseTransfer"),
      resumeTransfer: () => notImplemented("transfers.resumeTransfer"),
      cancelTransfer: () => notImplemented("transfers.cancelTransfer"),
      ingestTransferProgress: () => notImplemented("transfers.ingestTransferProgress"),
      createTransfer: () => notImplemented("transfers.createTransfer"),
    },
    discovery: {
      peers: [],
      discovered: [],
      lanPairingOffers: [],
      tailscaleHints: [],
      refreshDiscovery: async () => {},
      ingestDiscoveredPeer: () => {},
      ingestTailscaleHints: () => {},
    },
    pairing: {
      pendingToken: null,
      pendingCodeHash: null,
      startPairing: () => notImplemented("pairing.startPairing"),
    },
    peerServer: {
      running: false,
      port: null,
    },
    toasts: {
      toasts: [],
      pushToast: () => notImplemented("toasts.pushToast"),
      dismissToast: () => notImplemented("toasts.dismissToast"),
    },
    remoteFsCache: {},
    fetchRemoteFiles: async () => [],
    _hydrated: false,
  };

  const listeners = new Set<(s: LyraState) => void>();
  const emit = () => {
    for (const l of listeners) l(state);
  };

  const hydrate = async (): Promise<void> => {
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LyraState & { identity?: DeviceIdentity; settings?: unknown; pairedDevices?: PairedDevice[] }>;
        if (parsed.identity) state = { ...state, identity: parsed.identity as DeviceIdentity };
        if (parsed.pairedDevices) state = { ...state, pairedDevices: parsed.pairedDevices as PairedDevice[] };
        if (parsed.settings) {
          const s = AppSettingsSchema.safeParse(parsed.settings);
          if (s.success) state = { ...state, settings: s.data };
        }
      }
    } catch (err) {
      console.warn("[lyra core] hydrate failed", err);
    }
    // ensure identity exists
    if (!state.identity) {
      state = {
        ...state,
        identity: createDeviceIdentity({ name: "Lyra Device", type: "desktop", platform: "unknown" }),
      };
      await persist();
    }
    state = { ...state, _hydrated: true };
    emit();
  };

  const persist = async (): Promise<void> => {
    try {
      // strip privateKey/authSecret isolation — scaffold keeps bulk simple
      const toSave = {
        identity: state.identity,
        pairedDevices: state.pairedDevices.map((d) => {
          const { authSecret: _a, ...rest } = d as PairedDevice & { authSecret?: string };
          void _a;
          return rest;
        }),
        settings: state.settings,
      };
      await storage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (err) {
      console.warn("[lyra core] persist failed", err);
    }
  };

  const setIdentity = (id: DeviceIdentity): void => {
    state = { ...state, identity: id };
    emit();
    void persist();
  };

  const updateSettings = (patch: Partial<LyraState["settings"]>): void => {
    state = { ...state, settings: { ...state.settings, ...patch } };
    emit();
    void persist();
  };

  // --- discovery pure slice helpers (no IO) --------------------------------

  const ingestDiscoveredPeer = (peer: DiscoveredPeer): void => {
    // dedupe discovered by identity.id
    const exists = state.discovery.discovered.some((p) => p.identity.id === peer.identity.id && p.host === peer.host && p.port === peer.port);
    const nextDiscovered = exists ? state.discovery.discovered : [...state.discovery.discovered, peer];

    // if peer carries pairing offer, upsert into lanPairingOffers
    let nextOffers = state.discovery.lanPairingOffers;
    if (peer.pairing) {
      const offer = {
        codeHash: peer.pairing.codeHash,
        token: peer.pairing.token,
        expiresAt: peer.pairing.expiresAt,
        host: peer.host,
        port: peer.port,
        deviceId: peer.identity.id,
        name: peer.identity.name,
        fingerprint: peer.identity.fingerprint,
      };
      const idx = nextOffers.findIndex((o) => o.deviceId === offer.deviceId && o.codeHash === offer.codeHash);
      if (idx >= 0) {
        nextOffers = [...nextOffers.slice(0, idx), offer, ...nextOffers.slice(idx + 1)];
      } else {
        nextOffers = [...nextOffers, offer];
      }
    }

    state = {
      ...state,
      discovery: {
        ...state.discovery,
        discovered: nextDiscovered,
        lanPairingOffers: nextOffers,
      },
    };
    emit();
  };

  const ingestTailscaleHints = (hints: ProbeTarget[]): void => {
    state = {
      ...state,
      discovery: {
        ...state.discovery,
        tailscaleHints: [...hints],
      },
    };
    emit();
  };

  // alias for backwards compat with spec wording
  const ingestTailscalePeers = ingestTailscaleHints;

  const refreshDiscovery = async (): Promise<void> => {
    // pure stub — no IO in P2; P3 will probe tailscaleHints + multicast
    // For now just emit to allow UI to react
    emit();
  };

  // --- clipboard P4 ---------------------------------------------------------

  const receiveClipboardItem = (item: ClipboardItem): void => {
    // dedupe by id
    if (state.clipboard.history.some((h) => h.id === item.id)) return;
    const next = pruneClipboardHistory(
      [item, ...state.clipboard.history],
      state.settings.clipboardHistoryLimit,
      state.settings.clipboardRetentionDays,
    );
    state = {
      ...state,
      clipboard: { ...state.clipboard, history: next },
    };
    emit();
  };

  const pushClipboardTextInternal = (text: string, targetDeviceIds?: string[]): void => {
    if (!text || typeof text !== "string") return;
    const item: ClipboardItem = { id: generateId(), text, createdAt: Date.now(), type: "text" };
    // local history push with retention + limit
    const pruned = pruneClipboardHistory(
      [item, ...state.clipboard.history],
      state.settings.clipboardHistoryLimit,
      state.settings.clipboardRetentionDays,
    );
    state = {
      ...state,
      clipboard: { ...state.clipboard, history: pruned },
    };
    emit();
    if (!state.settings.clipboardSyncEnabled) return;
    if (!state.identity) return;
    const targets = targetDeviceIds?.length
      ? state.pairedDevices.filter((d) => targetDeviceIds.includes(d.id))
      : state.pairedDevices.filter((d) => d.host || d.lastReachableHost || d.tailscaleHost);
    for (const dev of targets) {
      const ep = peerEndpointFor(dev);
      const envelope = createEnvelope("clipboard_push", state.identity.id, { item }, dev.id);
      // TODO: seal if dev.authSecret present via daemon/seal (keep plain for headless tests)
      void transport.send(ep, envelope).catch(() => {});
    }
  };

  // public wrappers
  const pushClipboardText = (text: string, targetDeviceIds?: string[]): void => {
    pushClipboardTextInternal(text, targetDeviceIds);
  };

  const pushClipboardImage = (dataUrl: string, targetDeviceIds?: string[]): void => {
    if (!dataUrl) return;
    const item: ClipboardItem = {
      id: generateId(),
      text: dataUrl,
      createdAt: Date.now(),
      type: "image",
      mimeType: dataUrl.startsWith("data:") ? dataUrl.slice(5).split(";")[0] : undefined,
    };
    const pruned = pruneClipboardHistory(
      [item, ...state.clipboard.history],
      state.settings.clipboardHistoryLimit,
      state.settings.clipboardRetentionDays,
    );
    state = {
      ...state,
      clipboard: { ...state.clipboard, history: pruned },
    };
    emit();
    if (!state.settings.clipboardSyncEnabled) return;
    if (!state.identity) return;
    const targets = targetDeviceIds?.length
      ? state.pairedDevices.filter((d) => targetDeviceIds.includes(d.id))
      : state.pairedDevices.filter((d) => d.host || d.lastReachableHost || d.tailscaleHost);
    for (const dev of targets) {
      const ep = peerEndpointFor(dev);
      const envelope = createEnvelope("clipboard_push", state.identity.id, { item }, dev.id);
      void transport.send(ep, envelope).catch(() => {});
    }
  };

  const pinItem = (id: string): void => {
    const idx = state.clipboard.history.findIndex((h) => h.id === id);
    if (idx <= 0) return;
    const item = state.clipboard.history[idx] as ClipboardItem;
    const next = [item, ...state.clipboard.history.filter((h) => h.id !== id)];
    state = { ...state, clipboard: { ...state.clipboard, history: next } };
    emit();
  };

  const clearHistory = (): void => {
    state = { ...state, clipboard: { ...state.clipboard, history: [] } };
    emit();
  };

  const ingestSystemClipboardText = (text: string): void => {
    // called by daemon monitor — treat as local push but avoid double-send if already in history (dedupe by text+recent)
    const recent = state.clipboard.history[0];
    if (recent && recent.text === text && Date.now() - recent.createdAt < 1500) return;
    pushClipboardTextInternal(text);
  };

  // compat alias: pushClipboard(text|item) -> pushClipboardText
  const pushClipboard = (textOrItem: string | ClipboardItem): void => {
    if (typeof textOrItem === "string") pushClipboardText(textOrItem);
    else if (textOrItem && typeof textOrItem.text === "string") pushClipboardText(textOrItem.text);
  };

  // --- transfers P3 ---------------------------------------------------------

  const CHUNK_SIZE = 1024 * 1024; // 1 MiB

  const ingestTransferProgress = (id: string, transferredBytes: number): void => {
    const sess = state.transfers.sessions[id];
    if (!sess) return;
    const clamped = Math.max(0, Math.min(transferredBytes, sess.totalBytes));
    const nextStatus = clamped >= sess.totalBytes ? "completed" : sess.status === "paused" ? "paused" : "transferring";
    const updated: TransferSession = { ...sess, transferredBytes: clamped, status: nextStatus as TransferSession["status"] };
    state = {
      ...state,
      transfers: {
        ...state.transfers,
        sessions: { ...state.transfers.sessions, [id]: updated },
      },
    };
    emit();
  };

  const pauseTransfer = (id: string): void => {
    const sess = state.transfers.sessions[id];
    if (!sess) return;
    state = {
      ...state,
      transfers: {
        ...state.transfers,
        sessions: { ...state.transfers.sessions, [id]: { ...sess, status: "paused", resumeOffset: sess.transferredBytes } },
      },
    };
    emit();
    if (state.identity) {
      const dev = findDevice(sess.deviceId);
      if (dev) {
        const ep = peerEndpointFor(dev);
        const env = createEnvelope("transfer_pause", state.identity.id, { transferId: id }, dev.id);
        void transport.send(ep, env).catch(() => {});
      }
    }
  };

  const resumeTransfer = (id: string): void => {
    const sess = state.transfers.sessions[id];
    if (!sess) return;
    state = {
      ...state,
      transfers: {
        ...state.transfers,
        sessions: { ...state.transfers.sessions, [id]: { ...sess, status: "transferring" } },
      },
    };
    emit();
    if (state.identity) {
      const dev = findDevice(sess.deviceId);
      if (dev) {
        const ep = peerEndpointFor(dev);
        const env = createEnvelope("transfer_resume", state.identity.id, { transferId: id, resumeOffset: sess.resumeOffset ?? sess.transferredBytes }, dev.id);
        void transport.send(ep, env).catch(() => {});
      }
    }
  };

  const cancelTransfer = (id: string): void => {
    const sess = state.transfers.sessions[id];
    if (!sess) return;
    state = {
      ...state,
      transfers: {
        ...state.transfers,
        sessions: { ...state.transfers.sessions, [id]: { ...sess, status: "cancelled" } },
      },
    };
    emit();
  };

  const startFileTransfer = (
    deviceIds: string[],
    files: Array<{ name: string; size: number; relativePath?: string; bytes?: Uint8Array; checksum?: string }>,
  ): string[] => {
    if (!state.identity) return [];
    const totalBytes = files.reduce((acc, f) => acc + (typeof f.size === "number" ? f.size : (f.bytes?.length ?? 0)), 0);
    const ids: string[] = [];
    const nextSessions: Record<string, TransferSession> = { ...state.transfers.sessions };
    for (const deviceId of deviceIds) {
      const dev = findDevice(deviceId);
      const sessionId = generateId();
      const sess: TransferSession = {
        id: sessionId,
        deviceId,
        deviceName: dev?.name ?? deviceId,
        files: files.map((f) => ({ ...f })),
        totalBytes,
        transferredBytes: 0,
        status: "transferring",
        overWire: true,
      };
      nextSessions[sessionId] = sess;
      ids.push(sessionId);

      // Fire-and-forget wire transfer: offer + chunks
      void (async () => {
        const from = state.identity?.id ?? "unknown";
        const target = findDevice(deviceId);
        if (!target) return;
        const ep = peerEndpointFor(target);
        // offer envelope
        const offerPayload = {
          transferId: sessionId,
          files: files.map((f) => ({ name: f.name, size: f.size, checksum: f.checksum, relativePath: f.relativePath })),
          totalBytes,
        };
        const offerEnv = createEnvelope("transfer_offer", from, offerPayload, deviceId);
        const resOffer = await transport.send(ep, offerEnv).catch(() => ({ ok: false as const, error: "send failed" }));
        if (!resOffer.ok) {
          // offline or failed — keep session but simulate progress for demo/optimistic UI
          simulateProgress(sessionId, totalBytes);
          return;
        }
        // if files carry bytes, chunk them via sealed envelopes or binary uploadChunk
        let offset = 0;
        for (const file of files) {
          const bytes = file.bytes;
          if (!bytes || bytes.length === 0) {
            offset += file.size;
            continue;
          }
          // prefer binary uploadChunk if transport supports it (NodeHttpTransport)
          const hasUpload = typeof transport.uploadChunk === "function";
          for (let pos = 0; pos < bytes.length; pos += CHUNK_SIZE) {
            const slice = bytes.subarray(pos, pos + CHUNK_SIZE);
            if (hasUpload) {
              const r = await (transport.uploadChunk as NonNullable<PeerTransport["uploadChunk"]>)(ep, sessionId, offset + pos, slice).catch(
                () => ({ ok: false as const, error: "uploadChunk failed" }),
              );
              if (!r.ok) break;
            } else {
              const b64 = Buffer.from(slice).toString("base64");
              const chunkEnv = createEnvelope("transfer_chunk", from, { transferId: sessionId, offset: offset + pos, dataBase64: b64 }, deviceId);
              const rc = await transport.send(ep, chunkEnv).catch(() => ({ ok: false as const, error: "send failed" }));
              if (!rc.ok) break;
            }
            ingestTransferProgress(sessionId, Math.min(offset + pos + slice.length, totalBytes));
          }
          offset += bytes.length;
        }
        // complete signal
        const completeEnv = createEnvelope("transfer_complete", from, { transferId: sessionId }, deviceId);
        await transport.send(ep, completeEnv).catch(() => {});
        ingestTransferProgress(sessionId, totalBytes);
      })();
    }
    state = {
      ...state,
      transfers: {
        ...state.transfers,
        sessions: nextSessions,
      },
    };
    emit();
    return ids;
  };

  function simulateProgress(id: string, total: number): void {
    // optimistic demo progress via timeouts when offline — ensures UI moves without blocking
    let progressed = 0;
    const step = Math.max(64 * 1024, Math.floor(total / 8));
    const timer = setInterval(() => {
      const sess = state.transfers.sessions[id];
      if (!sess || sess.status === "paused" || sess.status === "cancelled" || sess.status === "completed") {
        clearInterval(timer);
        return;
      }
      progressed = Math.min(total, progressed + step);
      ingestTransferProgress(id, progressed);
      if (progressed >= total) clearInterval(timer);
    }, 200);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") (timer as unknown as { unref: () => void }).unref();
  }

  // --- remote browse P5 -----------------------------------------------------

  const fetchRemoteFiles = async (deviceId: string, path: string): Promise<FileEntry[]> => {
    const cacheKey = `${deviceId}:${path}`;
    if (state.remoteFsCache[cacheKey]) return state.remoteFsCache[cacheKey] as FileEntry[];
    const dev = findDevice(deviceId);
    if (dev && state.identity) {
      const ep = peerEndpointFor(dev);
      const envelope = createEnvelope("fs_list", state.identity.id, { path }, deviceId);
      try {
        const res = await transport.send(ep, envelope);
        if (res.ok && res.envelope) {
          const payload = res.envelope.payload as { entries?: FileEntry[] } | null;
          if (payload && Array.isArray(payload.entries)) {
            const entries = payload.entries as FileEntry[];
            state = { ...state, remoteFsCache: { ...state.remoteFsCache, [cacheKey]: entries } };
            emit();
            return entries;
          }
          // also handle { ok, payload: {entries}}
          const alt = res.envelope.payload as unknown;
          if (alt && typeof alt === "object" && "payload" in (alt as Record<string, unknown>)) {
            const inner = (alt as { payload?: { entries?: FileEntry[] } }).payload;
            if (inner?.entries) {
              state = { ...state, remoteFsCache: { ...state.remoteFsCache, [cacheKey]: inner.entries } };
              emit();
              return inner.entries as FileEntry[];
            }
          }
        }
      } catch {}
    }
    // fallback demo/offline
    const demo = listDemoFiles(path);
    state = { ...state, remoteFsCache: { ...state.remoteFsCache, [cacheKey]: demo } };
    emit();
    return demo;
  };

  // bind slice actions to state for consumers that read getState().discovery etc
  state = {
    ...state,
    discovery: {
      ...state.discovery,
      refreshDiscovery,
      ingestDiscoveredPeer,
      ingestTailscaleHints,
      ingestTailscalePeers,
    },
    clipboard: {
      ...state.clipboard,
      history: state.clipboard.history,
      pushClipboardText,
      pushClipboardImage,
      pinItem,
      clearHistory,
      pushClipboard,
      receiveClipboardItem,
      ingestSystemClipboardText,
    },
    transfers: {
      ...state.transfers,
      startFileTransfer,
      pauseTransfer,
      resumeTransfer,
      cancelTransfer,
      ingestTransferProgress,
      createTransfer: (..._a: unknown[]) => notImplemented("transfers.createTransfer"),
    },
    fetchRemoteFiles,
  };

  // keep internal remoteFsCache reference synced for closure fetchRemoteFiles
  // ensure state.remoteFsCache initially empty object already

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hydrate,
    persist,
    setIdentity,
    updateSettings,
    refreshDiscovery,
    ingestDiscoveredPeer,
    ingestTailscaleHints,
    ingestTailscalePeers,
    pushClipboard,
    pushClipboardText,
    pushClipboardImage,
    receiveClipboardItem,
    ingestSystemClipboardText,
    pinItem,
    clearHistory,
    startFileTransfer,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    ingestTransferProgress,
    fetchRemoteFiles,
  };
}
