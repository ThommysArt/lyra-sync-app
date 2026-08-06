import { AppSettingsSchema, type DeviceIdentity, type LyraEnvelope, type PairedDevice, type PeerEndpoint } from "@lyra-sync-app/protocol";
import { createDeviceIdentity, generateId } from "./identity.js";
import { STORAGE_KEY, type StorageLike, createMemoryStorage } from "./storage.js";
import type { DiscoveredPeer, LyraState, ProbeTarget } from "./slices/types.js";

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
  // discovery — pure state updates, no IO (P3 adds transport)
  refreshDiscovery: () => Promise<void>;
  ingestDiscoveredPeer: (peer: DiscoveredPeer) => void;
  ingestTailscaleHints: (hints: ProbeTarget[]) => void;
  ingestTailscalePeers: (hints: ProbeTarget[]) => void;
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
  void opts.transport; // injected for future slices (P3 will use)
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

  // bind slice actions to state for consumers that read getState().discovery
  state = {
    ...state,
    discovery: {
      ...state.discovery,
      refreshDiscovery,
      ingestDiscoveredPeer,
      ingestTailscaleHints,
      ingestTailscalePeers,
    },
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
    ingestDiscoveredPeer,
    ingestTailscaleHints,
    ingestTailscalePeers,
    pushClipboard,
  };
}
