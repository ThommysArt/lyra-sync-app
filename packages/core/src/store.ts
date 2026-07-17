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
import { AppSettingsSchema } from "@lyra-sync-app/protocol";

import {
  createDemoClipboardHistory,
  createDemoPairedDevices,
  createDemoTransfers,
  listDemoFiles,
} from "./demo";
import { createDeviceIdentity, generateId, generatePairingCode } from "./identity";

export type IncomingPairingRequest = {
  id: string;
  payload: PairingPayload;
  receivedAt: number;
};

export type ActivePairingSession = {
  code: string;
  token: string;
  expiresAt: number;
  payload: PairingPayload;
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
  submitPairingCode: (code: string) => { ok: true; device: PairedDevice } | { ok: false; error: string };
  confirmIncomingPair: (requestId: string) => void;
  rejectIncomingPair: (requestId: string) => void;
  /** Demo helper: simulate an incoming pair request */
  simulateIncomingPair: () => void;
  unpairDevice: (deviceId: string) => void;
  renameDevice: (deviceId: string, nickname: string) => void;
  updateDeviceSettings: (
    deviceId: string,
    patch: Partial<Pick<PairedDevice, "autoAcceptTransfers" | "autoAcceptClipboard" | "showInMainList">>,
  ) => void;
  selectDevice: (deviceId: string | null) => void;
  pushClipboardText: (text: string, targetDeviceIds?: string[]) => void;
  pinClipboardItem: (id: string, pinned?: boolean) => void;
  clearClipboardHistory: () => void;
  removeClipboardItem: (id: string) => void;
  resendClipboardItem: (id: string, targetDeviceIds: string[]) => void;
  setLocalClipboardText: (text: string) => void;
  startFileTransfer: (
    deviceIds: string[],
    files: { name: string; size: number; mimeType?: string }[],
    options?: { direction?: "sent" | "received"; forceConflict?: boolean },
  ) => void;
  setTransferStatus: (id: string, status: TransferStatus) => void;
  /** Resolve a transfer waiting on rename / overwrite / skip */
  resolveTransferConflict: (id: string, action: ConflictAction) => void;
  /** Demo: receive a file that already exists locally */
  simulateIncomingConflict: () => void;
  clearTransferHistory: () => void;
  listRemoteFiles: (deviceId: string, path: string) => FileEntry[];
  sendUrl: (url: string, deviceIds: string[]) => void;
  /** Apply a pairing payload from a scanned QR (demo handshake) */
  applyPairingPayload: (
    payload: PairingPayload | string,
  ) => { ok: true; device: PairedDevice } | { ok: false; error: string };
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

function simulateTransferProgress(
  store: LyraStore,
  set: (fn: (s: LyraState) => LyraState) => void,
  transferId: string,
) {
  const initial = store.getState().transfers.find((t) => t.id === transferId);
  let progress =
    initial && initial.totalBytes > 0 ? initial.transferredBytes / initial.totalBytes : 0;
  const tick = () => {
    const current = store.getState().transfers.find((t) => t.id === transferId);
    if (!current || current.status !== "transferring") return;
    progress += 0.12 + Math.random() * 0.15;
    if (progress >= 1) {
      store.setTransferStatus(transferId, "completed");
      return;
    }
    set((st) => ({
      ...st,
      transfers: st.transfers.map((t) =>
        t.id === transferId
          ? {
              ...t,
              transferredBytes: Math.floor(t.totalBytes * progress),
              updatedAt: Date.now(),
              status: "transferring" as const,
            }
          : t,
      ),
    }));
    setTimeout(tick, 400);
  };
  setTimeout(tick, 300);
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
      const payload: PairingPayload = {
        version: 1,
        deviceId: s.identity.id,
        name: s.identity.name,
        type: s.identity.type,
        platform: s.identity.platform,
        fingerprint: s.identity.fingerprint,
        publicKey: s.identity.publicKey,
        token,
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

      // Demo pairing: any valid-format code pairs a synthetic device.
      // If there's an active session with matching code on "another" logical peer, accept self-loop is ignored.
      if (s.activePairing && s.activePairing.code === normalized) {
        return { ok: false as const, error: "Enter this code on the other device" };
      }

      const now = Date.now();
      const device: PairedDevice = {
        id: generateId("dev"),
        name: `Paired Device ${normalized.slice(0, 3)}`,
        type: "mobile",
        platform: "android",
        fingerprint: generateId("fp").replace("fp_", ""),
        publicKey: generateId("pub"),
        pairedAt: now,
        lastSeenAt: now,
        online: true,
        connectionType: "local",
        autoAcceptTransfers: s.settings.autoAcceptTransfers,
        autoAcceptClipboard: s.settings.autoAcceptClipboard,
        showInMainList: true,
        status: {
          deviceId: "pending",
          batteryLevel: 88,
          isCharging: false,
          networkType: "wifi",
          networkName: "Local Network",
          freeStorageBytes: 64 * 1024 ** 3,
          updatedAt: now,
        },
      };
      device.status = { ...device.status!, deviceId: device.id };

      set((st) => ({
        ...st,
        devices: [device, ...st.devices.filter((d) => d.id !== device.id)],
        activePairing: null,
      }));
      persist();
      notify(set, `Paired with ${device.name}`, "success");
      return { ok: true as const, device };
    },
    confirmIncomingPair: (requestId) => {
      const s = getState();
      const req = s.incomingPairRequests.find((r) => r.id === requestId);
      if (!req) return;
      const p = req.payload;
      const now = Date.now();
      const device: PairedDevice = {
        id: p.deviceId,
        name: p.name,
        type: p.type,
        platform: p.platform,
        fingerprint: p.fingerprint,
        publicKey: p.publicKey,
        pairedAt: now,
        lastSeenAt: now,
        online: true,
        connectionType: "local",
        autoAcceptTransfers: s.settings.autoAcceptTransfers,
        autoAcceptClipboard: s.settings.autoAcceptClipboard,
        showInMainList: true,
      };
      set((st) => ({
        ...st,
        devices: [device, ...st.devices.filter((d) => d.id !== device.id)],
        incomingPairRequests: st.incomingPairRequests.filter((r) => r.id !== requestId),
      }));
      persist();
      notify(set, `Paired with ${device.name}`, "success");
    },
    rejectIncomingPair: (requestId) => {
      set((s) => ({
        ...s,
        incomingPairRequests: s.incomingPairRequests.filter((r) => r.id !== requestId),
      }));
    },
    simulateIncomingPair: () => {
      const s = getState();
      if (!s.identity) return;
      const request: IncomingPairingRequest = {
        id: generateId("inpair"),
        receivedAt: Date.now(),
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
      notify(set, "Incoming pairing request", "info");
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
        clipboardHistory: [item, ...st.clipboardHistory].slice(0, st.settings.clipboardHistoryLimit),
      }));
      persist();
      const count = targets.length;
      notify(
        set,
        count > 0 ? `Clipboard sent to ${count} device${count === 1 ? "" : "s"}` : "Saved to clipboard history",
        "success",
      );
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
      if (!item?.text) return;
      store.pushClipboardText(item.text, targetDeviceIds);
    },
    setLocalClipboardText: (text) => {
      set((s) => ({ ...s, localClipboardText: text }));
    },
    startFileTransfer: (deviceIds, files, options) => {
      const s = getState();
      if (!s.identity || files.length === 0 || deviceIds.length === 0) return;
      const direction = options?.direction ?? "sent";
      const forceConflict = options?.forceConflict ?? false;
      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
      const now = Date.now();
      const newTransfers: Transfer[] = deviceIds.map((deviceId) => {
        const device = s.devices.find((d) => d.id === deviceId);
        const status: TransferStatus = forceConflict ? "conflict" : "transferring";
        return {
          id: generateId("tx"),
          direction,
          deviceId,
          deviceName: device?.nickname || device?.name || "Device",
          files: files.map((f) => ({
            name: f.name,
            size: f.size,
            mimeType: f.mimeType,
          })),
          totalBytes,
          transferredBytes: 0,
          status,
          createdAt: now,
          updatedAt: now,
          conflictFileName: forceConflict ? files[0]?.name : undefined,
        };
      });
      set((st) => ({ ...st, transfers: [...newTransfers, ...st.transfers] }));
      persist();
      if (forceConflict) {
        notify(set, "File conflict — choose rename, overwrite, or skip", "info");
        return;
      }
      notify(
        set,
        direction === "sent"
          ? `Sending to ${deviceIds.length} device(s)…`
          : `Receiving from ${deviceIds.length} device(s)…`,
        "info",
      );

      // Simulate progress for demo
      for (const tx of newTransfers) {
        simulateTransferProgress(store, set, tx.id);
      }
    },
    setTransferStatus: (id, status) => {
      const prev = getState().transfers.find((t) => t.id === id);
      set((s) => ({
        ...s,
        transfers: s.transfers.map((t) => {
          if (t.id !== id) return t;
          const now = Date.now();
          const completed = status === "completed";
          return {
            ...t,
            status,
            updatedAt: now,
            transferredBytes: completed ? t.totalBytes : t.transferredBytes,
            completedAt: completed ? now : t.completedAt,
            durationMs: completed ? now - t.createdAt : t.durationMs,
            averageSpeedBps: completed
              ? t.totalBytes / Math.max(0.001, (now - t.createdAt) / 1000)
              : t.averageSpeedBps,
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

      if (action === "skip") {
        set((st) => ({
          ...st,
          transfers: st.transfers.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status: "cancelled" as const,
                  conflictResolved: action,
                  updatedAt: Date.now(),
                }
              : t,
          ),
        }));
        persist();
        notify(set, `Skipped ${tx.conflictFileName ?? "file"}`, "info");
        return;
      }

      const renamedFiles =
        action === "rename"
          ? tx.files.map((f, i) =>
              i === 0 || f.name === tx.conflictFileName
                ? { ...f, name: renameWithSuffix(f.name) }
                : f,
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
                updatedAt: Date.now(),
              }
            : t,
        ),
      }));
      persist();
      notify(
        set,
        action === "rename"
          ? `Renamed and continuing transfer`
          : `Overwriting ${tx.conflictFileName ?? "file"}…`,
        "info",
      );
      simulateTransferProgress(store, set, id);
    },
    simulateIncomingConflict: () => {
      const s = getState();
      const peer = s.devices.find((d) => d.online) ?? s.devices[0];
      if (!peer) {
        notify(set, "Pair a device first to simulate a conflict", "error");
        return;
      }
      store.startFileTransfer(
        [peer.id],
        [{ name: "report.pdf", size: 2_400_000, mimeType: "application/pdf" }],
        { direction: "received", forceConflict: true },
      );
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
    listRemoteFiles: (_deviceId, path) => listDemoFiles(path),
    sendUrl: (url, deviceIds) => {
      if (!url.trim() || deviceIds.length === 0) return;
      notify(
        set,
        `URL sent to ${deviceIds.length} device${deviceIds.length === 1 ? "" : "s"}`,
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

      const now = Date.now();
      const device: PairedDevice = {
        id: payload.deviceId,
        name: payload.name || "Scanned device",
        type: payload.type ?? "desktop",
        platform: payload.platform ?? "unknown",
        fingerprint: payload.fingerprint,
        publicKey: payload.publicKey || generateId("pub"),
        pairedAt: now,
        lastSeenAt: now,
        online: true,
        connectionType: "local",
        autoAcceptTransfers: s.settings.autoAcceptTransfers,
        autoAcceptClipboard: s.settings.autoAcceptClipboard,
        showInMainList: true,
      };

      set((st) => ({
        ...st,
        devices: [device, ...st.devices.filter((d) => d.id !== device.id)],
        activePairing: null,
      }));
      persist();
      notify(set, `Paired with ${device.name}`, "success");
      return { ok: true as const, device };
    },
    dismissToast: () => {
      set((s) => ({ ...s, toast: null }));
    },
  };

  return store;
}
