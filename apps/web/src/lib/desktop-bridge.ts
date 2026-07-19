/** Optional Electron preload bridge. Absent in pure browser / PWA. */

export type DesktopPeerStatus = {
  running: boolean;
  port: number | null;
  url: string | null;
  discoveryActive: boolean;
  lastError: string | null;
  updatedAt: number;
};

export type TrustedPeerSync = {
  deviceId: string;
  fingerprint: string;
  publicKey?: string;
  authSecret: string;
};

export type LyraDesktopApi = {
  getPeerStatus: () => Promise<DesktopPeerStatus>;
  getIdentity: () => Promise<unknown>;
  restartNetworking: () => Promise<DesktopPeerStatus>;
  syncTrustedPeers?: (peers: TrustedPeerSync[]) => Promise<{ count: number }>;
  setPairingOffer?: (
    offer: { code: string; token: string; expiresAt: number } | null,
  ) => Promise<{ ok: boolean; codeHash?: string }>;
  revokeDevice?: (deviceId: string) => Promise<{ revokedSessions: number }>;
  quit?: () => Promise<void>;
  scanTailscale?: () => Promise<
    | { ok: true; peers: { host: string; port?: number; name?: string }[]; backendState?: string }
    | { ok: false; error: string; peers: [] }
  >;
  onPeerStatus: (handler: (status: DesktopPeerStatus) => void) => () => void;
  onDiscoveredPeer: (handler: (peer: unknown) => void) => () => void;
  onEnvelope: (handler: (envelope: unknown) => void) => () => void;
  onPairRequest?: (handler: (payload: unknown) => void) => () => void;
  onUnpaired?: (handler: (data: { deviceId: string }) => void) => () => void;
  onClipboardPush?: (handler: (item: unknown) => void) => () => void;
  onTailscalePeers?: (
    handler: (peers: { host: string; port?: number; name?: string; online?: boolean }[]) => void,
  ) => () => void;
};

declare global {
  interface Window {
    lyraDesktop?: LyraDesktopApi;
  }
}

export function getDesktopApi(): LyraDesktopApi | null {
  if (typeof window === "undefined") return null;
  return window.lyraDesktop ?? null;
}

export function isDesktopShell(): boolean {
  return getDesktopApi() !== null;
}
