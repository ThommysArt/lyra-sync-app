import { AppSettingsSchema, type DeviceIdentity, type LyraEnvelope, type PairedDevice, type PeerEndpoint } from "@lyra-sync-app/protocol";
import { createDeviceIdentity, generateId } from "./identity.js";
import { STORAGE_KEY, type StorageLike, createMemoryStorage } from "./storage.js";
import type { LyraState } from "./slices/types.js";

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
  // stubs
  refreshDiscovery: () => void;
  pushClipboard: (text: string) => void;
};

function defaultSettings(): LyraState["settings"] {
  return AppSettingsSchema.parse({});
}

function notImplemented(name: string): void {
  console.warn(`[lyra core] ${name} not implemented`);
}

export function createLyraStore(opts: LyraStoreOptions): LyraStore {
  const storage = opts.storage ?? createMemoryStorage();
  void opts.transport; // injected for future slices
  void opts.seedDemo;

  let state: LyraState = {
    identity: null,
    pairedDevices: [],
    settings: defaultSettings(),
    clipboard: {
      history: [],
      pushClipboard: () => notImplemented("clipboard.pushClipboard"),
    },
    transfers: {
      transfers: {},
      createTransfer: () => notImplemented("transfers.createTransfer"),
    },
    discovery: {
      peers: [],
      discovered: [],
      refreshDiscovery: () => notImplemented("discovery.refreshDiscovery"),
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

  const refreshDiscovery = (): void => {
    notImplemented("refreshDiscovery");
  };

  const pushClipboard = (text: string): void => {
    const item = { id: generateId(), text, createdAt: Date.now() };
    state = {
      ...state,
      clipboard: {
        ...state.clipboard,
        history: [item, ...state.clipboard.history].slice(0, state.settings.clipboardHistoryLimit),
      },
    };
    emit();
  };

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
    pushClipboard,
  };
}
