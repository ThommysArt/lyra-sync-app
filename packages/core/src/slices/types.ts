import type { AppSettings, ClipboardItem, DeviceIdentity, PairedDevice, Transfer } from "@lyra-sync-app/protocol";

// Local discovery peer types — keep in sync with @lyra-sync-app/discovery
export type DiscoveredPeer = {
  identity: {
    id: string;
    name: string;
    type?: string;
    platform?: string;
    fingerprint: string;
    publicKey?: string;
  };
  host: string;
  port: number;
  pairing?: {
    codeHash: string;
    token: string;
    expiresAt: number;
  };
};

export type ProbeTarget = {
  host: string;
  port: number;
  peerId?: string;
  dnsName?: string;
};

export type LanPairingOffer = {
  codeHash: string;
  token: string;
  expiresAt: number;
  host: string;
  port: number;
  deviceId: string;
  name: string;
  fingerprint: string;
};

export type IdentitySlice = {
  identity: DeviceIdentity | null;
  setIdentity: (id: DeviceIdentity) => void;
};

export type PairingSlice = {
  pendingToken: string | null;
  pendingCodeHash: string | null;
  // stubs — not implemented
  startPairing: (code?: string) => void;
};

export type DiscoverySlice = {
  peers: PairedDevice[];
  discovered: DiscoveredPeer[];
  lanPairingOffers: LanPairingOffer[];
  tailscaleHints: ProbeTarget[];
  refreshDiscovery: () => Promise<void>;
  ingestDiscoveredPeer: (peer: DiscoveredPeer) => void;
  ingestTailscaleHints: (hints: ProbeTarget[]) => void;
  /** alias for ingestTailscaleHints — kept for store compat */
  ingestTailscalePeers?: (hints: ProbeTarget[]) => void;
};

export type TransferSlice = {
  transfers: Record<string, Transfer>;
  createTransfer: (..._args: unknown[]) => void;
};

export type ClipboardSlice = {
  history: ClipboardItem[];
  pushClipboard: (item: ClipboardItem) => void;
};

export type SettingsSlice = {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
};

export type PeerServerSlice = {
  running: boolean;
  port: number | null;
};

export type Toast = { id: string; title: string; message?: string; variant?: "default" | "success" | "error" };
export type ToastSlice = {
  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
};

export type LyraState = {
  identity: DeviceIdentity | null;
  pairedDevices: PairedDevice[];
  settings: AppSettings;
  clipboard: ClipboardSlice;
  transfers: TransferSlice;
  discovery: DiscoverySlice;
  pairing: PairingSlice;
  peerServer: PeerServerSlice;
  toasts: ToastSlice;

  // legacy aliases for migration
  _hydrated: boolean;
};
