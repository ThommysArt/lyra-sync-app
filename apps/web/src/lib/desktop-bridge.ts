/** Optional Electron preload bridge. Absent in pure browser / PWA. */

export type DesktopPeerStatus = {
  running: boolean;
  port: number | null;
  url: string | null;
  discoveryActive: boolean;
  lastError: string | null;
  updatedAt: number;
};

export type LyraDesktopApi = {
  getPeerStatus: () => Promise<DesktopPeerStatus>;
  getIdentity: () => Promise<unknown>;
  restartNetworking: () => Promise<DesktopPeerStatus>;
  onPeerStatus: (handler: (status: DesktopPeerStatus) => void) => () => void;
  onDiscoveredPeer: (handler: (peer: unknown) => void) => () => void;
  onEnvelope: (handler: (envelope: unknown) => void) => () => void;
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
