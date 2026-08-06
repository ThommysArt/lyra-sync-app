import type { AppSettings, ClipboardItem, DeviceIdentity, FileEntry, PairedDevice, Transfer } from "@lyra-sync-app/protocol";

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

export type TransferSession = {
  id: string;
  deviceId: string;
  deviceName: string;
  files: Array<{ name: string; size: number; relativePath?: string; bytes?: Uint8Array; checksum?: string; mimeType?: string }>;
  totalBytes: number;
  transferredBytes: number;
  status: "pending" | "offered" | "in_progress" | "transferring" | "paused" | "completed" | "failed" | "cancelled";
  overWire?: boolean;
  resumeOffset?: number;
};

export type TransferSlice = {
  /** canonical sessions map — new P3 */
  sessions: Record<string, TransferSession>;
  /** legacy alias kept for compat — mirror of sessions as Transfer objects */
  transfers: Record<string, Transfer>;
  startFileTransfer: (
    deviceIds: string[],
    files: Array<{ name: string; size: number; relativePath?: string; bytes?: Uint8Array; checksum?: string }>,
  ) => string[];
  pauseTransfer: (id: string) => void;
  resumeTransfer: (id: string) => void;
  cancelTransfer: (id: string) => void;
  ingestTransferProgress: (id: string, transferredBytes: number) => void;
  /** stub for legacy createTransfer */
  createTransfer: (..._args: unknown[]) => void;
};

export type ClipboardSlice = {
  history: ClipboardItem[];
  pushClipboardText: (text: string, targetDeviceIds?: string[]) => void;
  pushClipboardImage: (dataUrl: string, targetDeviceIds?: string[]) => void;
  pinItem: (id: string) => void;
  clearHistory: () => void;
  /** compat alias — accepts either item or plain text */
  pushClipboard: (item: ClipboardItem | string) => void;
  /** ingest incoming from transport */
  receiveClipboardItem: (item: ClipboardItem) => void;
  ingestSystemClipboardText?: (text: string) => void;
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

export type RemoteFsSlice = {
  remoteFsCache: Record<string, FileEntry[]>;
  fetchRemoteFiles: (deviceId: string, path: string) => Promise<FileEntry[]>;
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
  remoteFsCache: Record<string, FileEntry[]>;
  /** direct action for remote browse (mirrors remoteFsSlice for ergonomics) */
  fetchRemoteFiles: (deviceId: string, path: string) => Promise<FileEntry[]>;
  // legacy aliases for migration
  _hydrated: boolean;
};
