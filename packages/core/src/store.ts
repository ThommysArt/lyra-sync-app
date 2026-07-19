import {
  applyChunkProgress,
  canResumeTransfer,
  deriveMutualAuthSecret,
  isLikelyTailscaleHost,
  probePeer,
  probePeers,
  type ProbeResult,
} from "@lyra-sync-app/net";
import type {
  AppSettings,
  ClipboardItem,
  ConflictAction,
  DeviceIdentity,
  FileEntry,
  PairedDevice,
  PairingPayload,
  Transfer,
  TransferStatus,
} from "@lyra-sync-app/protocol";
import { AppSettingsSchema, LYRA_DEFAULT_PORT } from "@lyra-sync-app/protocol";

import {
  createDemoClipboardHistory,
  createDemoPairedDevices,
  createDemoTransfers,
  listDemoFiles,
} from "./demo";
import { createDeviceIdentity, generateId, generatePairingCode } from "./identity";
import {
  isLivePeer,
  wireListRemoteFiles,
  wireOpenUrl,
  wirePushClipboard,
  wireSendFiles,
  wireSendPairRequest,
} from "./peer-ops";

export type IncomingPairingRequest = {
  id: string;
  payload: PairingPayload;
  receivedAt: number;
  /** Where the pending pair originated */
  source: "scan" | "code" | "wire" | "simulate";
  /** Optional pairing code (code entry path) */
  code?: string;
};

export type ActivePairingSession = {
  code: string;
  token: string;
  expiresAt: number;
  payload: PairingPayload;
};

/** Runtime status of the local HTTP peer server (Electron / Node). */
export type PeerServerStatus = {
  running: boolean;
  port: number | null;
  url: string | null;
  discoveryActive: boolean;
  lastError: string | null;
  updatedAt: number;
};

export type LyraState = {
  ready: boolean;
  identity: DeviceIdentity | null;
  privateKey: string | null;
  devices: PairedDevice[];
  clipboardHistory: ClipboardItem[];
  transfers: Transfer[];
  settings: AppSettings;
  activePairing: ActivePairingSession | null;
  incomingPairRequests: IncomingPairingRequest[];
  selectedDeviceId: string | null;
  /** Local system clipboard mirror (text) */
  localClipboardText: string;
  toast: { id: string; message: string; tone: "info" | "success" | "error" } | null;
  /** Local peer server / discovery runtime (set by desktop shell) */
  peerServer: PeerServerStatus;
  /** Last network probe summary for UI */
  lastProbeSummary: string | null;
  /** Cached remote FS listings keyed by `${deviceId}::${path}` */
  remoteFsCache: Record<string, FileEntry[]>;
};

export type LyraStore = {
  getState: () => LyraState;
  subscribe: (listener: () => void) => () => void;
  hydrate: (storage?: StorageLike) => Promise<void>;
  persist: () => void;
  setDeviceName: (name: string) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  startPairingSession: () => ActivePairingSession;
  cancelPairingSession: () => void;
  /**
   * Enter a pairing code from another device.
   * Dual-confirm: queues a pending request — call confirmIncomingPair to finish.
   */
  submitPairingCode: (
    code: string,
  ) =>
    | { ok: true; pending: true; requestId: string }
    | { ok: true; device: PairedDevice }
    | { ok: false; error: string };
  /** Accept a pending dual-confirm pair (scan / code / wire / simulate). */
  confirmIncomingPair: (requestId: string) => void | Promise<void>;
  rejectIncomingPair: (requestId: string) => void;
  /** Demo helper: simulate an incoming pair request */
  simulateIncomingPair: () => void;
  /** Enqueue a wire-originated pair_request (desktop peer server → store). */
  enqueuePairRequest: (payload: PairingPayload, source?: IncomingPairingRequest["source"]) => void;
  unpairDevice: (deviceId: string) => void;
  /**
   * Manually add a peer by host/IP (and optional port). Used when multicast
   * discovery cannot see the device (different subnet, Tailscale, etc.).
   */
  addManualPeer: (input: {
    host: string;
    port?: number;
    name?: string;
  }) => { ok: true; device: PairedDevice } | { ok: false; error: string };
  /**
   * Re-probe known peers (real HTTP /lyra/info when host is set) and refresh
   * online / lastSeen. Falls back to demo mesh for seeded peers without hosts.
   */
  refreshDiscovery: () => void | Promise<void>;
  /** Probe a single host:port (manual + Tailscale path). */
  probePeerAddress: (input: {
    host: string;
    port?: number;
  }) => Promise<ProbeResult>;
  /** Live-probe peers that look like Tailscale (100.x / *.ts.net) or have tailscale connection. */
  probeTailscalePeers: () => Promise<ProbeResult[]>;
  /** Desktop shell reports local HTTP peer server state */
  setPeerServerStatus: (patch: Partial<PeerServerStatus>) => void;
  /** Resume a paused/partial transfer from last acknowledged offset */
  resumeTransfer: (id: string) => void;
  renameDevice: (deviceId: string, nickname: string) => void;
  updateDeviceSettings: (
    deviceId: string,
    patch: Partial<Pick<PairedDevice, "autoAcceptTransfers" | "autoAcceptClipboard" | "showInMainList">>,
  ) => void;
  selectDevice: (deviceId: string | null) => void;
  pushClipboardText: (text: string, targetDeviceIds?: string[]) => void;
  /** Push an image (data URL / base64) to history and online peers */
  pushClipboardImage: (
    imageData: string,
    targetDeviceIds?: string[],
    options?: { mimeType?: string },
  ) => void;
  pinClipboardItem: (id: string, pinned?: boolean) => void;
  clearClipboardHistory: () => void;
  removeClipboardItem: (id: string) => void;
  resendClipboardItem: (id: string, targetDeviceIds: string[]) => void;
  /** Ingest a clipboard item received over the wire */
  receiveClipboardItem: (item: ClipboardItem) => void;
  setLocalClipboardText: (text: string) => void;
  /**
   * Called by the desktop clipboard monitor when system clipboard text changes.
   * Updates the local mirror and optionally syncs to online devices / history.
   */
  ingestSystemClipboardText: (
    text: string,
    options?: { sync?: boolean; silent?: boolean },
  ) => void;
  startFileTransfer: (
    deviceIds: string[],
    files: {
      name: string;
      size: number;
      mimeType?: string;
      checksum?: string;
      /** Optional raw bytes for real wire transfer */
      bytes?: Uint8Array;
    }[],
    options?: {
      direction?: "sent" | "received";
      forceConflict?: boolean;
      /** Start partially transferred (demo resume) */
      initialOffset?: number;
      verifyIntegrity?: boolean;
      /** Force local simulation even if peer has a host */
      forceSimulate?: boolean;
    },
  ) => void;
  /** Re-send a completed transfer's files to the same or new devices */
  resendTransfer: (transferId: string, targetDeviceIds?: string[]) => void;
  setTransferStatus: (id: string, status: TransferStatus) => void;
  /** Resolve a transfer waiting on rename / overwrite / skip */
  resolveTransferConflict: (id: string, action: ConflictAction) => void;
  /** Apply the same conflict action to every transfer currently in `conflict` */
  resolveAllTransferConflicts: (action: ConflictAction) => void;
  /** Demo: receive file(s) that already exist locally */
  simulateIncomingConflict: (options?: { multiFile?: boolean; batch?: boolean }) => void;
  clearTransferHistory: () => void;
  listRemoteFiles: (deviceId: string, path: string) => FileEntry[];
  /** Live fs_list against a reachable peer (falls back to demo FS). */
  fetchRemoteFiles: (deviceId: string, path: string) => Promise<FileEntry[]>;
  sendUrl: (url: string, deviceIds: string[]) => void;
  /**
   * Apply a pairing payload from a scanned QR.
   * Dual-confirm: queues pending request — does not pair until confirmIncomingPair.
   */
  applyPairingPayload: (
    payload: PairingPayload | string,
  ) =>
    | { ok: true; pending: true; requestId: string; deviceName: string }
    | { ok: true; device: PairedDevice }
    | { ok: false; error: string };
  dismissToast: () => void;
};

export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
};

const STORAGE_KEY = "lyra.v1.state";

const defaultSettings: AppSettings = AppSettingsSchema.parse({});

function createInitialState(): LyraState {
  return {
    ready: false,
    identity: null,
    privateKey: null,
    devices: [],
    clipboardHistory: [],
    transfers: [],
    settings: defaultSettings,
    activePairing: null,
    incomingPairRequests: [],
    selectedDeviceId: null,
    localClipboardText: "",
    toast: null,
    peerServer: {
      running: false,
      port: null,
      url: null,
      discoveryActive: false,
      lastError: null,
      updatedAt: Date.now(),
    },
    lastProbeSummary: null,
    remoteFsCache: {},
  };
}

function notify(
  set: (fn: (s: LyraState) => LyraState) => void,
  message: string,
  tone: "info" | "success" | "error" = "info",
) {
  set((s) => ({
    ...s,
    toast: { id: generateId("toast"), message, tone },
  }));
}

function renameWithSuffix(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (1)`;
  return `${name.slice(0, dot)} (1)${name.slice(dot)}`;
}

function conflictNameSet(tx: Transfer): Set<string> {
  if (tx.conflictFileNames && tx.conflictFileNames.length > 0) {
    return new Set(tx.conflictFileNames);
  }
  if (tx.conflictFileName) return new Set([tx.conflictFileName]);
  if (tx.files[0]?.name) return new Set([tx.files[0].name]);
  return new Set();
}

function simulateTransferProgress(
  store: LyraStore,
  set: (fn: (s: LyraState) => LyraState) => void,
  transferId: string,
) {
  const initial = store.getState().transfers.find((t) => t.id === transferId);
  let progress =
    initial && initial.totalBytes > 0 ? initial.transferredBytes / initial.totalBytes : 0;
  const startedAt = Date.now();
  const startBytes = initial?.transferredBytes ?? 0;
  const tick = () => {
    const current = store.getState().transfers.find((t) => t.id === transferId);
    if (!current || current.status !== "transferring") return;
    progress += 0.12 + Math.random() * 0.15;
    const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
    if (progress >= 1) {
      const verify =
        current.verifyIntegrity ?? store.getState().settings.verifyTransferIntegrity;
      const patch = applyChunkProgress(current, current.totalBytes);
      const durationMs = Date.now() - current.createdAt;
      set((st) => ({
        ...st,
        transfers: st.transfers.map((t) =>
          t.id === transferId
            ? {
                ...t,
                ...patch,
                transferredBytes: t.totalBytes,
                status: "completed" as const,
                completedAt: Date.now(),
                durationMs,
                averageSpeedBps: t.totalBytes / Math.max(0.001, durationMs / 1000),
                currentSpeedBps: undefined,
                etaSeconds: 0,
                // Demo integrity: checksums match when declared; unknown → ok
                integrityOk: verify ? true : undefined,
                updatedAt: Date.now(),
              }
            : t,
        ),
      }));
      store.persist();
      return;
    }
    const nextBytes = Math.floor(current.totalBytes * progress);
    const patch = applyChunkProgress(current, nextBytes);
    const progressed = Math.max(0, nextBytes - startBytes);
    const currentSpeedBps = progressed / elapsed;
    const remaining = Math.max(0, current.totalBytes - nextBytes);
    const etaSeconds = currentSpeedBps > 0 ? remaining / currentSpeedBps : 0;
    set((st) => ({
      ...st,
      transfers: st.transfers.map((t) =>
        t.id === transferId
          ? {
              ...t,
              ...patch,
              status: "transferring" as const,
              currentSpeedBps,
              etaSeconds,
            }
          : t,
      ),
    }));
    setTimeout(tick, 400);
  };
  setTimeout(tick, 300);
}

async function finalizePairDevice(
  set: (fn: (s: LyraState) => LyraState) => void,
  getState: () => LyraState,
  persist: () => void,
  input: {
    payload: PairingPayload;
    source: IncomingPairingRequest["source"];
    code?: string;
  },
): Promise<PairedDevice | null> {
  const s = getState();
  if (!s.identity || !s.privateKey) return null;

  const authSecret = await deriveMutualAuthSecret({
    pairingToken: input.payload.token,
    localFingerprint: s.identity.fingerprint,
    remoteFingerprint: input.payload.fingerprint,
    localPublicKey: s.identity.publicKey,
    remotePublicKey: input.payload.publicKey || input.payload.fingerprint,
  });

  const now = Date.now();
  const device: PairedDevice = {
    id: input.payload.deviceId,
    name: input.payload.name || "Paired device",
    type: input.payload.type ?? "desktop",
    platform: input.payload.platform ?? "unknown",
    fingerprint: input.payload.fingerprint,
    publicKey: input.payload.publicKey || generateId("pub"),
    pairedAt: now,
    lastSeenAt: now,
    online: true,
    connectionType: input.payload.host ? "manual" : "local",
    autoAcceptTransfers: s.settings.autoAcceptTransfers,
    autoAcceptClipboard: s.settings.autoAcceptClipboard,
    showInMainList: true,
    host: input.payload.host,
    port: input.payload.port,
    authSecret,
  };

  set((st) => ({
    ...st,
    devices: [device, ...st.devices.filter((d) => d.id !== device.id)],
    activePairing: null,
  }));
  persist();

  // Notify the remote host when we have an address (wire dual-confirm path)
  if (device.host && s.identity) {
    const peerStatus = getState().peerServer;
    let localHost: string | undefined;
    if (peerStatus.url) {
      try {
        localHost = new URL(peerStatus.url).hostname;
      } catch {
        localHost = undefined;
      }
    }
    void wireSendPairRequest({
      host: device.host,
      port: device.port,
      identity: s.identity,
      payload: {
        version: 1,
        deviceId: s.identity.id,
        name: s.identity.name,
        type: s.identity.type,
        platform: s.identity.platform,
        fingerprint: s.identity.fingerprint,
        publicKey: s.identity.publicKey,
        token: input.payload.token,
        host: localHost,
        port: peerStatus.port ?? getState().settings.peerListenPort,
        expiresAt: Date.now() + 5 * 60 * 1000,
      },
      code: input.code,
    });
  }

  return device;
}

function trimClipboardHistory(
  items: ClipboardItem[],
  settings: AppSettings,
): ClipboardItem[] {
  let next = items;
  if (settings.clipboardRetentionDays > 0) {
    const cutoff = Date.now() - settings.clipboardRetentionDays * 24 * 60 * 60 * 1000;
    next = next.filter((c) => c.pinned || c.createdAt >= cutoff);
  }
  return next.slice(0, settings.clipboardHistoryLimit);
}

function applyProbeToDevice(d: PairedDevice, result: ProbeResult, now: number): PairedDevice {
  if (!result.ok) {
    return {
      ...d,
      online: false,
      lastSeenAt: d.lastSeenAt,
      lastProbeLatencyMs: result.latencyMs,
    };
  }
  const connectionType =
    result.connectionHint === "tailscale"
      ? d.connectionType === "local"
        ? "both"
        : "tailscale"
      : d.connectionType === "tailscale"
        ? "both"
        : d.connectionType === "manual"
          ? "manual"
          : "local";
  return {
    ...d,
    online: true,
    lastSeenAt: now,
    lastProbeLatencyMs: result.latencyMs,
    host: result.host,
    port: result.port,
    connectionType,
    // Prefer live identity fields when probing a real peer
    name: d.nickname ? d.name : result.name || d.name,
    fingerprint: result.fingerprint || d.fingerprint,
    platform: (result.platform as PairedDevice["platform"]) || d.platform,
  };
}

export function createLyraStore(options?: {
  storage?: StorageLike | null;
  seedDemo?: boolean;
  platformHint?: "web" | "native";
}): LyraStore {
  let state = createInitialState();
  const listeners = new Set<() => void>();
  const storage = options?.storage ?? null;
  const seedDemo = options?.seedDemo ?? true;

  const emit = () => {
    for (const l of listeners) l();
  };

  const set = (fn: (s: LyraState) => LyraState) => {
    state = fn(state);
    emit();
  };

  const getState = () => state;

  const persist = () => {
    if (!storage || !state.identity) return;
    const payload = {
      identity: state.identity,
      privateKey: state.privateKey,
      devices: state.devices,
      clipboardHistory: state.clipboardHistory.slice(0, state.settings.clipboardHistoryLimit),
      transfers: state.transfers.slice(0, 100),
      settings: state.settings,
    };
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore quota errors
    }
  };

  const hydrate = async () => {
    let identity: DeviceIdentity | null = null;
    let privateKey: string | null = null;
    let devices: PairedDevice[] = [];
    let clipboardHistory: ClipboardItem[] = [];
    let transfers: Transfer[] = [];
    let settings: AppSettings = defaultSettings;

    if (storage) {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<typeof state>;
          if (parsed.identity) identity = parsed.identity;
          if (parsed.privateKey) privateKey = parsed.privateKey;
          if (parsed.devices) devices = parsed.devices;
          if (parsed.clipboardHistory) clipboardHistory = parsed.clipboardHistory;
          if (parsed.transfers) transfers = parsed.transfers;
          if (parsed.settings) settings = AppSettingsSchema.parse(parsed.settings);
        }
      } catch {
        // corrupt storage — re-seed
      }
    }

    if (!identity || !privateKey) {
      const created = await createDeviceIdentity({
        name: options?.platformHint === "native" ? "My Phone" : "My Computer",
        platform: options?.platformHint === "native" ? "android" : "web",
        type: options?.platformHint === "native" ? "mobile" : "desktop",
      });
      if (!created.ok) {
        throw created.error;
      }
      identity = created.identity;
      privateKey = created.privateKey;
    }

    if (seedDemo && devices.length === 0) {
      devices = createDemoPairedDevices(identity);
    }
    if (seedDemo && clipboardHistory.length === 0) {
      clipboardHistory = createDemoClipboardHistory(identity);
    }
    if (seedDemo && transfers.length === 0) {
      transfers = createDemoTransfers();
    }

    set((s) => ({
      ...s,
      ready: true,
      identity,
      privateKey,
      devices,
      clipboardHistory,
      transfers,
      settings,
    }));
    persist();
  };

  const store: LyraStore = {
    getState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hydrate,
    persist,
    setDeviceName: (name) => {
      set((s) =>
        s.identity
          ? { ...s, identity: { ...s.identity, name: name.trim() || s.identity.name } }
          : s,
      );
      persist();
    },
    updateSettings: (patch) => {
      set((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
      persist();
    },
    startPairingSession: () => {
      const s = getState();
      if (!s.identity) throw new Error("Identity not ready");
      const code = generatePairingCode(6);
      const token = generateId("pair");
      const expiresAt = Date.now() + 5 * 60 * 1000;
      let host: string | undefined;
      if (s.peerServer.url) {
        try {
          host = new URL(s.peerServer.url).hostname;
        } catch {
          host = undefined;
        }
      }
      const payload: PairingPayload = {
        version: 1,
        deviceId: s.identity.id,
        name: s.identity.name,
        type: s.identity.type,
        platform: s.identity.platform,
        fingerprint: s.identity.fingerprint,
        publicKey: s.identity.publicKey,
        token,
        host,
        port: s.peerServer.port ?? s.settings.peerListenPort,
        expiresAt,
      };
      const session: ActivePairingSession = { code, token, expiresAt, payload };
      set((st) => ({ ...st, activePairing: session }));
      return session;
    },
    cancelPairingSession: () => {
      set((s) => ({ ...s, activePairing: null }));
    },
    submitPairingCode: (code) => {
      const s = getState();
      if (!s.identity) return { ok: false as const, error: "Not ready" };
      const normalized = code.trim().toUpperCase();
      if (normalized.length < 4) return { ok: false as const, error: "Code too short" };

      // Self-loop: entering our own displayed code
      if (s.activePairing && s.activePairing.code === normalized) {
        return { ok: false as const, error: "Enter this code on the other device" };
      }

      // Dual-confirm: queue pending synthetic peer for user accept
      const requestId = generateId("inpair");
      const token = generateId("tok");
      const request: IncomingPairingRequest = {
        id: requestId,
        receivedAt: Date.now(),
        source: "code",
        code: normalized,
        payload: {
          version: 1,
          deviceId: generateId("dev"),
          name: `Device ${normalized.slice(0, 3)}`,
          type: "mobile",
          platform: "android",
          fingerprint: generateId("fp").replace("fp_", "").slice(0, 32),
          publicKey: generateId("pub"),
          token,
          expiresAt: Date.now() + 5 * 60 * 1000,
        },
      };
      set((st) => ({
        ...st,
        incomingPairRequests: [request, ...st.incomingPairRequests],
      }));
      notify(set, `Confirm pairing with ${request.payload.name}?`, "info");
      return { ok: true as const, pending: true as const, requestId };
    },
    confirmIncomingPair: async (requestId) => {
      const s = getState();
      const req = s.incomingPairRequests.find((r) => r.id === requestId);
      if (!req) return;

      set((st) => ({
        ...st,
        incomingPairRequests: st.incomingPairRequests.filter((r) => r.id !== requestId),
      }));

      const device = await finalizePairDevice(set, getState, persist, {
        payload: req.payload,
        source: req.source,
        code: req.code,
      });
      if (device) {
        notify(set, `Paired with ${device.name}`, "success");
      }
    },
    rejectIncomingPair: (requestId) => {
      set((s) => ({
        ...s,
        incomingPairRequests: s.incomingPairRequests.filter((r) => r.id !== requestId),
      }));
      notify(set, "Pairing rejected", "info");
    },
    simulateIncomingPair: () => {
      const s = getState();
      if (!s.identity) return;
      const request: IncomingPairingRequest = {
        id: generateId("inpair"),
        receivedAt: Date.now(),
        source: "simulate",
        payload: {
          version: 1,
          deviceId: generateId("dev"),
          name: "Incoming Laptop",
          type: "desktop",
          platform: "linux",
          fingerprint: generateId("fp").replace("fp_", ""),
          publicKey: generateId("pub"),
          token: generateId("tok"),
          expiresAt: Date.now() + 5 * 60 * 1000,
        },
      };
      set((st) => ({
        ...st,
        incomingPairRequests: [request, ...st.incomingPairRequests],
      }));
      notify(set, "Incoming pairing request — confirm to trust", "info");
    },
    enqueuePairRequest: (payload, source = "wire") => {
      const s = getState();
      if (!s.identity) return;
      if (payload.deviceId === s.identity.id) return;
      if (payload.expiresAt && payload.expiresAt < Date.now()) return;
      const existing = s.incomingPairRequests.find((r) => r.payload.deviceId === payload.deviceId);
      if (existing) return;
      // Auto-accept only when settings allow and not a first-time dual-confirm requirement
      // Spec: dual confirm always for pairing
      const request: IncomingPairingRequest = {
        id: generateId("inpair"),
        receivedAt: Date.now(),
        source,
        payload,
      };
      set((st) => ({
        ...st,
        incomingPairRequests: [request, ...st.incomingPairRequests],
      }));
      notify(set, `Pairing request from ${payload.name}`, "info");
    },
    unpairDevice: (deviceId) => {
      set((s) => ({
        ...s,
        devices: s.devices.filter((d) => d.id !== deviceId),
        selectedDeviceId: s.selectedDeviceId === deviceId ? null : s.selectedDeviceId,
      }));
      persist();
      notify(set, "Device unpaired", "info");
    },
    addManualPeer: (input) => {
      const s = getState();
      if (!s.identity) return { ok: false as const, error: "Not ready" };
      const host = input.host.trim();
      if (!host) return { ok: false as const, error: "Host or IP is required" };

      // Basic host validation: hostname, IPv4, or IPv6-ish
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(host) && !host.includes(":")) {
        return { ok: false as const, error: "Invalid host" };
      }

      const port = input.port && input.port > 0 ? input.port : 53317;
      const existing = s.devices.find(
        (d) => d.host === host && (d.port ?? 53317) === port,
      );
      if (existing) {
        return { ok: false as const, error: "A peer with that address already exists" };
      }

      const now = Date.now();
      const name = (input.name?.trim() || `Peer ${host}`).slice(0, 64);
      const device: PairedDevice = {
        id: generateId("manual"),
        name,
        type: "desktop",
        platform: "unknown",
        fingerprint: generateId("fp").replace("fp_", "").slice(0, 32),
        publicKey: generateId("pub"),
        pairedAt: now,
        lastSeenAt: now,
        online: true,
        connectionType: "manual",
        autoAcceptTransfers: s.settings.autoAcceptTransfers,
        autoAcceptClipboard: s.settings.autoAcceptClipboard,
        showInMainList: true,
        host,
        port,
        status: {
          deviceId: "",
          batteryLevel: null,
          isCharging: null,
          networkType: "unknown",
          networkName: null,
          freeStorageBytes: null,
          updatedAt: now,
        },
      };
      device.status = { ...device.status!, deviceId: device.id };

      set((st) => ({
        ...st,
        devices: [device, ...st.devices],
      }));
      persist();
      notify(set, `Added ${name} at ${host}:${port}`, "success");
      return { ok: true as const, device };
    },
    refreshDiscovery: async () => {
      const s = getState();
      if (!s.settings.discoveryEnabled) {
        notify(set, "Network discovery is disabled in Settings", "info");
        return;
      }
      const now = Date.now();

      // Real HTTP probes for devices that have a host (manual / Tailscale / discovered)
      const probeTargets = s.devices.filter((d) => Boolean(d.host));
      let probeResults: ProbeResult[] = [];
      if (probeTargets.length > 0) {
        probeResults = await probePeers(
          probeTargets.map((d) => ({
            host: d.host!,
            port: d.port ?? s.settings.peerListenPort ?? LYRA_DEFAULT_PORT,
          })),
          {
            timeoutMs: 2000,
            preferTailscale: s.settings.tailscaleEnabled,
          },
        );
      }

      const byHostPort = new Map<string, ProbeResult>();
      for (let i = 0; i < probeTargets.length; i++) {
        const d = probeTargets[i]!;
        const key = `${d.host}:${d.port ?? LYRA_DEFAULT_PORT}`;
        byHostPort.set(key, probeResults[i]!);
      }

      set((st) => ({
        ...st,
        devices: st.devices.map((d) => {
          if (d.host) {
            const key = `${d.host}:${d.port ?? LYRA_DEFAULT_PORT}`;
            const result = byHostPort.get(key);
            if (result) return applyProbeToDevice(d, result, now);
          }
          // Demo mesh fallback for seeded peers without live hosts
          if (d.connectionType === "manual") {
            return { ...d, online: true, lastSeenAt: now };
          }
          if (d.id.startsWith("demo_") || d.online) {
            return {
              ...d,
              online: true,
              lastSeenAt: now,
              status: d.status ? { ...d.status, updatedAt: now } : d.status,
            };
          }
          if (d.id === "demo_windows") {
            return {
              ...d,
              online: true,
              lastSeenAt: now,
              connectionType: d.connectionType === "tailscale" ? "both" : d.connectionType,
            };
          }
          return d;
        }),
        lastProbeSummary:
          probeTargets.length > 0
            ? `Probed ${probeTargets.length} endpoint(s) · ${probeResults.filter((r) => r.ok).length} up`
            : "Demo mesh refreshed (no live hosts)",
      }));
      persist();
      const online = getState().devices.filter((d) => d.online).length;
      notify(set, `Discovery refreshed · ${online} device(s) online`, "success");
    },
    probePeerAddress: async (input) => {
      const host = input.host.trim();
      const port = input.port && input.port > 0 ? input.port : getState().settings.peerListenPort;
      const result = await probePeer(
        { host, port },
        {
          timeoutMs: 2500,
          preferTailscale: getState().settings.tailscaleEnabled || isLikelyTailscaleHost(host),
        },
      );
      const now = Date.now();
      if (result.ok) {
        set((st) => ({
          ...st,
          devices: st.devices.map((d) => {
            if (d.host === host && (d.port ?? LYRA_DEFAULT_PORT) === port) {
              return applyProbeToDevice(d, result, now);
            }
            return d;
          }),
          lastProbeSummary: `Reachable ${result.name} · ${result.latencyMs}ms`,
        }));
        persist();
        notify(set, `Peer online: ${result.name} (${result.latencyMs}ms)`, "success");
      } else {
        set((st) => ({
          ...st,
          lastProbeSummary: `Unreachable ${host}:${port} · ${result.error}`,
        }));
        notify(set, `Peer unreachable: ${result.error}`, "error");
      }
      return result;
    },
    probeTailscalePeers: async () => {
      const s = getState();
      if (!s.settings.tailscaleEnabled) {
        notify(set, "Enable Tailscale support in Settings first", "info");
        return [];
      }
      const candidates = s.devices.filter(
        (d) =>
          (d.host && isLikelyTailscaleHost(d.host)) ||
          d.connectionType === "tailscale" ||
          d.connectionType === "both",
      );
      if (candidates.length === 0) {
        notify(set, "No Tailscale peers to probe — add a 100.x or *.ts.net address", "info");
        return [];
      }
      const results = await probePeers(
        candidates.map((d) => ({
          host: d.host!,
          port: d.port ?? s.settings.peerListenPort,
        })),
        { timeoutMs: 3000, preferTailscale: true },
      );
      const now = Date.now();
      set((st) => ({
        ...st,
        devices: st.devices.map((d) => {
          const idx = candidates.findIndex((c) => c.id === d.id);
          if (idx < 0) return d;
          return applyProbeToDevice(d, results[idx]!, now);
        }),
        lastProbeSummary: `Tailscale probe · ${results.filter((r) => r.ok).length}/${results.length} up`,
      }));
      persist();
      const up = results.filter((r) => r.ok).length;
      notify(set, `Tailscale probe: ${up}/${results.length} reachable`, up > 0 ? "success" : "info");
      return results;
    },
    setPeerServerStatus: (patch) => {
      set((s) => ({
        ...s,
        peerServer: {
          ...s.peerServer,
          ...patch,
          updatedAt: Date.now(),
        },
      }));
    },
    resumeTransfer: (id) => {
      const tx = getState().transfers.find((t) => t.id === id);
      if (!tx) return;
      if (!canResumeTransfer(tx) && tx.status !== "paused") {
        notify(set, "Transfer cannot be resumed", "error");
        return;
      }
      const offset = tx.transferredBytes;
      set((st) => ({
        ...st,
        transfers: st.transfers.map((t) =>
          t.id === id
            ? {
                ...t,
                status: "transferring" as const,
                resumeOffset: offset,
                updatedAt: Date.now(),
                error: undefined,
              }
            : t,
        ),
      }));
      persist();
      notify(
        set,
        offset > 0
          ? `Resuming from ${Math.round((offset / Math.max(1, tx.totalBytes)) * 100)}%…`
          : "Resuming transfer…",
        "info",
      );
      simulateTransferProgress(store, set, id);
    },
    renameDevice: (deviceId, nickname) => {
      set((s) => ({
        ...s,
        devices: s.devices.map((d) =>
          d.id === deviceId ? { ...d, nickname: nickname.trim() || undefined } : d,
        ),
      }));
      persist();
    },
    updateDeviceSettings: (deviceId, patch) => {
      set((s) => ({
        ...s,
        devices: s.devices.map((d) => (d.id === deviceId ? { ...d, ...patch } : d)),
      }));
      persist();
    },
    selectDevice: (deviceId) => {
      set((s) => ({ ...s, selectedDeviceId: deviceId }));
    },
    pushClipboardText: (text, targetDeviceIds) => {
      const s = getState();
      if (!s.identity || !text.trim()) return;
      const targets =
        targetDeviceIds ??
        s.devices.filter((d) => d.online && d.showInMainList).map((d) => d.id);
      const item: ClipboardItem = {
        id: generateId("clip"),
        type: "text",
        text: text.trim(),
        sourceDeviceId: s.identity.id,
        sourceDeviceName: s.identity.name,
        createdAt: Date.now(),
        pinned: false,
      };
      set((st) => ({
        ...st,
        localClipboardText: text.trim(),
        clipboardHistory: trimClipboardHistory([item, ...st.clipboardHistory], st.settings),
      }));
      persist();

      // Real wire push to live peers with host + auth
      const live = s.devices.filter((d) => targets.includes(d.id) && isLivePeer(d) && d.authSecret);
      for (const device of live) {
        void wirePushClipboard({
          device,
          identity: s.identity!,
          privateKey: s.privateKey!,
          item,
        }).then((res) => {
          if (!res.ok) {
            notify(set, `Clipboard to ${device.name} failed: ${res.error}`, "error");
          }
        });
      }

      const count = targets.length;
      notify(
        set,
        count > 0
          ? `Clipboard sent to ${count} device${count === 1 ? "" : "s"}${live.length ? " (wire)" : ""}`
          : "Saved to clipboard history",
        "success",
      );
    },
    pushClipboardImage: (imageData, targetDeviceIds, options) => {
      const s = getState();
      if (!s.identity || !imageData) return;
      const targets =
        targetDeviceIds ??
        s.devices.filter((d) => d.online && d.showInMainList).map((d) => d.id);
      const item: ClipboardItem = {
        id: generateId("clip"),
        type: "image",
        imageData,
        text: options?.mimeType ? `[image ${options.mimeType}]` : "[image]",
        sourceDeviceId: s.identity.id,
        sourceDeviceName: s.identity.name,
        createdAt: Date.now(),
        pinned: false,
      };
      set((st) => ({
        ...st,
        clipboardHistory: trimClipboardHistory([item, ...st.clipboardHistory], st.settings),
      }));
      persist();
      const live = s.devices.filter((d) => targets.includes(d.id) && isLivePeer(d) && d.authSecret);
      for (const device of live) {
        void wirePushClipboard({
          device,
          identity: s.identity!,
          privateKey: s.privateKey!,
          item,
        });
      }
      notify(
        set,
        targets.length > 0
          ? `Image clipboard sent to ${targets.length} device(s)`
          : "Image saved to history",
        "success",
      );
    },
    receiveClipboardItem: (item) => {
      const s = getState();
      if (!s.settings.clipboardSyncEnabled && !s.settings.autoAcceptClipboard) {
        // Still store but do not auto-write local clipboard
      }
      set((st) => ({
        ...st,
        localClipboardText: item.type === "text" ? (item.text ?? st.localClipboardText) : st.localClipboardText,
        clipboardHistory: trimClipboardHistory(
          [{ ...item, pinned: item.pinned ?? false }, ...st.clipboardHistory.filter((c) => c.id !== item.id)],
          st.settings,
        ),
      }));
      persist();
      notify(set, `Clipboard from ${item.sourceDeviceName}`, "info");
    },
    pinClipboardItem: (id, pinned = true) => {
      set((s) => ({
        ...s,
        clipboardHistory: s.clipboardHistory.map((c) =>
          c.id === id ? { ...c, pinned } : c,
        ),
      }));
      persist();
    },
    clearClipboardHistory: () => {
      set((s) => ({
        ...s,
        clipboardHistory: s.clipboardHistory.filter((c) => c.pinned),
      }));
      persist();
    },
    removeClipboardItem: (id) => {
      set((s) => ({
        ...s,
        clipboardHistory: s.clipboardHistory.filter((c) => c.id !== id),
      }));
      persist();
    },
    resendClipboardItem: (id, targetDeviceIds) => {
      const item = getState().clipboardHistory.find((c) => c.id === id);
      if (!item) return;
      if (item.type === "image" && item.imageData) {
        store.pushClipboardImage(item.imageData, targetDeviceIds);
        return;
      }
      if (item.text) store.pushClipboardText(item.text, targetDeviceIds);
    },
    setLocalClipboardText: (text) => {
      set((s) => ({ ...s, localClipboardText: text }));
    },
    ingestSystemClipboardText: (text, options) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const s = getState();
      if (trimmed === s.localClipboardText.trim()) return;

      const shouldSync =
        options?.sync ?? (s.settings.clipboardSyncEnabled && s.settings.autoMonitorClipboard);
      const silent = options?.silent ?? true;

      if (!shouldSync || !s.identity) {
        set((st) => ({ ...st, localClipboardText: trimmed }));
        return;
      }

      // Avoid duplicate consecutive history entries for the same text
      const newest = s.clipboardHistory[0];
      if (newest?.text?.trim() === trimmed) {
        set((st) => ({ ...st, localClipboardText: trimmed }));
        return;
      }

      const targets = s.devices
        .filter((d) => d.online && d.showInMainList && d.autoAcceptClipboard)
        .map((d) => d.id);
      const item: ClipboardItem = {
        id: generateId("clip"),
        type: "text",
        text: trimmed,
        sourceDeviceId: s.identity.id,
        sourceDeviceName: s.identity.name,
        createdAt: Date.now(),
        pinned: false,
      };
      set((st) => ({
        ...st,
        localClipboardText: trimmed,
        clipboardHistory: [item, ...st.clipboardHistory].slice(0, st.settings.clipboardHistoryLimit),
      }));
      persist();
      if (!silent) {
        notify(
          set,
          targets.length > 0
            ? `Clipboard synced to ${targets.length} device${targets.length === 1 ? "" : "s"}`
            : "Clipboard captured",
          "success",
        );
      }
    },
    startFileTransfer: (deviceIds, files, options) => {
      const s = getState();
      if (!s.identity || files.length === 0 || deviceIds.length === 0) return;
      const direction = options?.direction ?? "sent";
      const forceConflict = options?.forceConflict ?? false;
      const forceSimulate = options?.forceSimulate ?? false;
      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
      const now = Date.now();
      const conflictNames = forceConflict ? files.map((f) => f.name) : undefined;
      const initialOffset = Math.min(
        totalBytes,
        Math.max(0, options?.initialOffset ?? 0),
      );
      const verifyIntegrity =
        options?.verifyIntegrity ?? s.settings.verifyTransferIntegrity;
      const newTransfers: Transfer[] = deviceIds.map((deviceId) => {
        const device = s.devices.find((d) => d.id === deviceId);
        const overWire =
          !forceSimulate &&
          direction === "sent" &&
          !forceConflict &&
          device != null &&
          isLivePeer(device);
        const status: TransferStatus = forceConflict
          ? "conflict"
          : initialOffset > 0 && initialOffset < totalBytes
            ? "paused"
            : "transferring";
        const base: Transfer = {
          id: generateId("tx"),
          direction,
          deviceId,
          deviceName: device?.nickname || device?.name || "Device",
          files: files.map((f) => ({
            name: f.name,
            size: f.size,
            mimeType: f.mimeType,
            checksum: f.checksum,
          })),
          totalBytes,
          transferredBytes: initialOffset,
          resumeOffset: initialOffset > 0 ? initialOffset : undefined,
          status,
          createdAt: now,
          updatedAt: now,
          conflictFileName: conflictNames?.[0],
          conflictFileNames: conflictNames,
          verifyIntegrity,
          overWire: overWire || undefined,
        };
        if (initialOffset > 0) {
          return { ...base, ...applyChunkProgress(base, initialOffset), status };
        }
        return base;
      });
      set((st) => ({ ...st, transfers: [...newTransfers, ...st.transfers] }));
      persist();
      if (forceConflict) {
        const n = conflictNames?.length ?? 1;
        notify(
          set,
          n > 1
            ? `${n} file conflicts — choose rename, overwrite, or skip`
            : "File conflict — choose rename, overwrite, or skip",
          "info",
        );
        return;
      }
      if (initialOffset > 0 && initialOffset < totalBytes) {
        notify(
          set,
          `Transfer ready to resume from ${Math.round((initialOffset / totalBytes) * 100)}%`,
          "info",
        );
        return;
      }
      notify(
        set,
        direction === "sent"
          ? `Sending to ${deviceIds.length} device(s)…`
          : `Receiving from ${deviceIds.length} device(s)…`,
        "info",
      );

      for (const tx of newTransfers) {
        if (tx.status !== "transferring") continue;
        const device = getState().devices.find((d) => d.id === tx.deviceId);
        if (tx.overWire && device && s.identity && s.privateKey) {
          void wireSendFiles({
            device,
            identity: s.identity,
            privateKey: s.privateKey,
            transferId: tx.id,
            files,
            resumeOffset: tx.resumeOffset,
            onProgress: (p) => {
              set((st) => ({
                ...st,
                transfers: st.transfers.map((t) =>
                  t.id === tx.id
                    ? {
                        ...t,
                        ...applyChunkProgress(t, p.transferredBytes),
                        currentSpeedBps: p.currentSpeedBps,
                        etaSeconds: p.etaSeconds,
                        status: "transferring" as const,
                      }
                    : t,
                ),
              }));
            },
          }).then((res) => {
            if (!res.ok) {
              set((st) => ({
                ...st,
                transfers: st.transfers.map((t) =>
                  t.id === tx.id
                    ? {
                        ...t,
                        status: "failed" as const,
                        error: res.error,
                        updatedAt: Date.now(),
                      }
                    : t,
                ),
              }));
              persist();
              notify(set, `Transfer failed: ${res.error}`, "error");
              return;
            }
            const verify =
              tx.verifyIntegrity ?? getState().settings.verifyTransferIntegrity;
            set((st) => ({
              ...st,
              transfers: st.transfers.map((t) =>
                t.id === tx.id
                  ? {
                      ...t,
                      ...applyChunkProgress(t, t.totalBytes),
                      status: "completed" as const,
                      completedAt: Date.now(),
                      durationMs: Date.now() - t.createdAt,
                      averageSpeedBps:
                        t.totalBytes / Math.max(0.001, (Date.now() - t.createdAt) / 1000),
                      currentSpeedBps: undefined,
                      etaSeconds: 0,
                      integrityOk: verify ? true : undefined,
                      overWire: true,
                      updatedAt: Date.now(),
                    }
                  : t,
              ),
            }));
            persist();
            notify(set, "Transfer complete (wire)", "success");
          });
        } else {
          simulateTransferProgress(store, set, tx.id);
        }
      }
    },
    resendTransfer: (transferId, targetDeviceIds) => {
      const tx = getState().transfers.find((t) => t.id === transferId);
      if (!tx || tx.files.length === 0) return;
      const targets =
        targetDeviceIds ??
        (tx.deviceId ? [tx.deviceId] : getState().devices.filter((d) => d.online).map((d) => d.id));
      if (targets.length === 0) {
        notify(set, "No target devices for re-send", "error");
        return;
      }
      store.startFileTransfer(
        targets,
        tx.files.map((f) => ({
          name: f.name,
          size: f.size,
          mimeType: f.mimeType,
          checksum: f.checksum,
        })),
      );
    },
    setTransferStatus: (id, status) => {
      const prev = getState().transfers.find((t) => t.id === id);
      set((s) => ({
        ...s,
        transfers: s.transfers.map((t) => {
          if (t.id !== id) return t;
          const now = Date.now();
          const completed = status === "completed";
          const paused = status === "paused";
          return {
            ...t,
            status,
            updatedAt: now,
            transferredBytes: completed ? t.totalBytes : t.transferredBytes,
            resumeOffset: paused || completed ? t.transferredBytes : t.resumeOffset,
            completedAt: completed ? now : t.completedAt,
            durationMs: completed ? now - t.createdAt : t.durationMs,
            averageSpeedBps: completed
              ? t.totalBytes / Math.max(0.001, (now - t.createdAt) / 1000)
              : t.averageSpeedBps,
            integrityOk:
              completed && (t.verifyIntegrity ?? s.settings.verifyTransferIntegrity)
                ? true
                : t.integrityOk,
          };
        }),
      }));
      persist();
      // Resume simulation only when entering transferring from a non-active state
      if (status === "transferring" && prev && prev.status !== "transferring") {
        simulateTransferProgress(store, set, id);
      }
    },
    resolveTransferConflict: (id, action) => {
      const s = getState();
      const tx = s.transfers.find((t) => t.id === id);
      if (!tx || tx.status !== "conflict") return;

      const conflictNames = conflictNameSet(tx);

      if (action === "skip") {
        set((st) => ({
          ...st,
          transfers: st.transfers.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status: "cancelled" as const,
                  conflictResolved: action,
                  conflictFileName: undefined,
                  conflictFileNames: undefined,
                  updatedAt: Date.now(),
                }
              : t,
          ),
        }));
        persist();
        const label =
          conflictNames.size > 1
            ? `${conflictNames.size} files`
            : (tx.conflictFileName ?? "file");
        notify(set, `Skipped ${label}`, "info");
        return;
      }

      const renamedFiles =
        action === "rename"
          ? tx.files.map((f) =>
              conflictNames.has(f.name) ? { ...f, name: renameWithSuffix(f.name) } : f,
            )
          : tx.files;

      set((st) => ({
        ...st,
        transfers: st.transfers.map((t) =>
          t.id === id
            ? {
                ...t,
                files: renamedFiles,
                status: "transferring" as const,
                conflictResolved: action,
                conflictFileName: undefined,
                conflictFileNames: undefined,
                updatedAt: Date.now(),
              }
            : t,
        ),
      }));
      persist();
      notify(
        set,
        action === "rename"
          ? conflictNames.size > 1
            ? `Renamed ${conflictNames.size} files and continuing`
            : "Renamed and continuing transfer"
          : conflictNames.size > 1
            ? `Overwriting ${conflictNames.size} files…`
            : `Overwriting ${tx.conflictFileName ?? "file"}…`,
        "info",
      );
      simulateTransferProgress(store, set, id);
    },
    resolveAllTransferConflicts: (action) => {
      const conflicts = getState().transfers.filter((t) => t.status === "conflict");
      if (conflicts.length === 0) return;
      if (conflicts.length === 1) {
        store.resolveTransferConflict(conflicts[0]!.id, action);
        return;
      }

      const now = Date.now();
      const idsToResume =
        action === "skip" ? [] : conflicts.map((t) => t.id);

      set((st) => ({
        ...st,
        transfers: st.transfers.map((t) => {
          if (t.status !== "conflict") return t;
          if (action === "skip") {
            return {
              ...t,
              status: "cancelled" as const,
              conflictResolved: action,
              conflictFileName: undefined,
              conflictFileNames: undefined,
              updatedAt: now,
            };
          }
          const names = conflictNameSet(t);
          const files =
            action === "rename"
              ? t.files.map((f) =>
                  names.has(f.name) ? { ...f, name: renameWithSuffix(f.name) } : f,
                )
              : t.files;
          return {
            ...t,
            files,
            status: "transferring" as const,
            conflictResolved: action,
            conflictFileName: undefined,
            conflictFileNames: undefined,
            updatedAt: now,
          };
        }),
      }));
      persist();
      notify(
        set,
        `Applied “${action}” to ${conflicts.length} conflict sessions`,
        "success",
      );
      for (const id of idsToResume) {
        simulateTransferProgress(store, set, id);
      }
    },
    simulateIncomingConflict: (options) => {
      const s = getState();
      const peer = s.devices.find((d) => d.online) ?? s.devices[0];
      if (!peer) {
        notify(set, "Pair a device first to simulate a conflict", "error");
        return;
      }

      if (options?.batch) {
        // Several separate conflict sessions (batch UI)
        const batches: { name: string; size: number; mimeType: string }[][] = [
          [
            { name: "report.pdf", size: 2_400_000, mimeType: "application/pdf" },
            { name: "slides.pptx", size: 8_100_000, mimeType: "application/vnd.ms-powerpoint" },
          ],
          [{ name: "notes.md", size: 12_000, mimeType: "text/markdown" }],
          [
            { name: "photo.jpg", size: 3_200_000, mimeType: "image/jpeg" },
            { name: "export.zip", size: 15_000_000, mimeType: "application/zip" },
          ],
        ];
        for (const files of batches) {
          store.startFileTransfer([peer.id], files, {
            direction: "received",
            forceConflict: true,
          });
        }
        return;
      }

      const files = options?.multiFile
        ? [
            { name: "report.pdf", size: 2_400_000, mimeType: "application/pdf" },
            { name: "budget.xlsx", size: 540_000, mimeType: "application/vnd.ms-excel" },
            { name: "cover.png", size: 1_100_000, mimeType: "image/png" },
          ]
        : [{ name: "report.pdf", size: 2_400_000, mimeType: "application/pdf" }];

      store.startFileTransfer([peer.id], files, {
        direction: "received",
        forceConflict: true,
      });
    },
    clearTransferHistory: () => {
      set((s) => ({
        ...s,
        transfers: s.transfers.filter(
          (t) =>
            t.status === "transferring" ||
            t.status === "paused" ||
            t.status === "pending" ||
            t.status === "conflict",
        ),
      }));
      persist();
    },
    listRemoteFiles: (deviceId, path) => {
      const key = `${deviceId}::${path}`;
      const cached = getState().remoteFsCache[key];
      if (cached) return cached;
      return listDemoFiles(path);
    },
    fetchRemoteFiles: async (deviceId, path) => {
      const s = getState();
      const device = s.devices.find((d) => d.id === deviceId);
      if (!device || !s.identity || !s.privateKey) {
        const demo = listDemoFiles(path);
        set((st) => ({
          ...st,
          remoteFsCache: { ...st.remoteFsCache, [`${deviceId}::${path}`]: demo },
        }));
        return demo;
      }
      if (isLivePeer(device) && device.authSecret) {
        const res = await wireListRemoteFiles({
          device,
          identity: s.identity,
          privateKey: s.privateKey,
          path,
          requestId: generateId("fs"),
        });
        if (res.ok) {
          set((st) => ({
            ...st,
            remoteFsCache: { ...st.remoteFsCache, [`${deviceId}::${path}`]: res.entries },
          }));
          return res.entries;
        }
        notify(set, `Remote FS: ${res.error} — showing demo tree`, "info");
      }
      const demo = listDemoFiles(path);
      set((st) => ({
        ...st,
        remoteFsCache: { ...st.remoteFsCache, [`${deviceId}::${path}`]: demo },
      }));
      return demo;
    },
    sendUrl: (url, deviceIds) => {
      if (!url.trim() || deviceIds.length === 0) return;
      const s = getState();
      let parsed: string;
      try {
        parsed = new URL(url.trim()).toString();
      } catch {
        notify(set, "Invalid URL", "error");
        return;
      }
      const live = s.devices.filter(
        (d) => deviceIds.includes(d.id) && isLivePeer(d) && d.authSecret && s.identity && s.privateKey,
      );
      for (const device of live) {
        void wireOpenUrl({
          device,
          identity: s.identity!,
          privateKey: s.privateKey!,
          url: parsed,
        }).then((res) => {
          if (!res.ok) notify(set, `Open URL on ${device.name}: ${res.error}`, "error");
        });
      }
      // Open locally as receiver fallback for demo peers
      if (typeof globalThis.open === "function" && live.length === 0) {
        try {
          globalThis.open(parsed, "_blank", "noopener,noreferrer");
        } catch {
          // ignore
        }
      }
      notify(
        set,
        `URL sent to ${deviceIds.length} device${deviceIds.length === 1 ? "" : "s"}${live.length ? " (wire)" : ""}`,
        "success",
      );
    },
    applyPairingPayload: (raw) => {
      const s = getState();
      if (!s.identity) return { ok: false as const, error: "Not ready" };

      let payload: PairingPayload;
      try {
        payload = typeof raw === "string" ? (JSON.parse(raw) as PairingPayload) : raw;
      } catch {
        return { ok: false as const, error: "Invalid QR payload" };
      }

      if (!payload || payload.version !== 1 || !payload.deviceId || !payload.fingerprint) {
        return { ok: false as const, error: "Unrecognized pairing data" };
      }
      if (payload.deviceId === s.identity.id) {
        return { ok: false as const, error: "Cannot pair with this device" };
      }
      if (payload.expiresAt && payload.expiresAt < Date.now()) {
        return { ok: false as const, error: "Pairing code expired" };
      }

      // Dual-confirm: queue pending — user must accept
      const requestId = generateId("inpair");
      const request: IncomingPairingRequest = {
        id: requestId,
        receivedAt: Date.now(),
        source: "scan",
        payload,
      };
      set((st) => ({
        ...st,
        incomingPairRequests: [request, ...st.incomingPairRequests.filter((r) => r.payload.deviceId !== payload.deviceId)],
      }));
      notify(set, `Confirm pairing with ${payload.name || "device"}?`, "info");
      return {
        ok: true as const,
        pending: true as const,
        requestId,
        deviceName: payload.name || "device",
      };
    },
    dismissToast: () => {
      set((s) => ({ ...s, toast: null }));
    },
  };

  return store;
}
