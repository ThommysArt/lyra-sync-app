/** Optional Electron preload bridge. Absent in pure browser / PWA. */

export type DesktopPeerStatus = {
  running: boolean;
  port: number | null;
  url: string | null;
  lanHost?: string | null;
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

export type DesktopShellInfo = {
  platform: NodeJS.Platform | string;
  isDesktop: true;
  downloadDirectory: string;
  customChrome?: boolean;
  usesSystemTrafficLights?: boolean;
};

export type DesktopWindowState = {
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
};

export type TransferCompleteEvent = {
  transferId: string;
  receivedBytes: number;
  files: { name: string; size: number }[];
  diskPath?: string;
  savedPaths?: string[];
  downloadDir?: string;
};

export type LyraDesktopApi = {
  getPeerStatus: () => Promise<DesktopPeerStatus>;
  getIdentity: () => Promise<unknown>;
  /** Push renderer identity into the peer server so /lyra/info matches the UI */
  setIdentity?: (payload: {
    identity: unknown;
    privateKey?: string | null;
  }) => Promise<{ ok: boolean; identity?: unknown; error?: string }>;
  getShellInfo?: () => Promise<DesktopShellInfo>;
  getDownloadDirectory?: () => Promise<string>;
  setDownloadDirectory?: (
    dir: string | null,
  ) => Promise<{ ok: boolean; path: string; error?: string }>;
  chooseDownloadDirectory?: () => Promise<
    | { ok: true; path: string }
    | { ok: false; cancelled?: boolean; path: string }
  >;
  openPath?: (targetPath: string) => Promise<{ ok: boolean; error?: string }>;
  restartNetworking: () => Promise<DesktopPeerStatus>;
  syncTrustedPeers?: (peers: TrustedPeerSync[]) => Promise<{ count: number }>;
  setPairingOffer?: (
    offer: { code: string; token: string; expiresAt: number } | null,
  ) => Promise<{ ok: boolean; codeHash?: string }>;
  /** Accept/decline a waiting pair_request on the peer server (long-poll) */
  resolvePairRequest?: (payload: {
    deviceId?: string;
    token?: string;
    accepted: boolean;
    reason?: string;
  }) => Promise<{ ok: boolean; matched?: boolean; error?: string }>;
  /** Fire UDP multicast announce burst (LocalSend-style refresh) */
  announceDiscovery?: () => Promise<{
    ok: boolean;
    addresses?: string[];
    error?: string;
  }>;
  revokeDevice?: (deviceId: string) => Promise<{ revokedSessions: number }>;
  quit?: () => Promise<void>;
  scanTailscale?: () => Promise<
    | {
        ok: true;
        peers: { host: string; port?: number; name?: string }[];
        backendState?: string;
        self?: { host?: string; tailscaleIp?: string };
      }
    | { ok: false; error: string; peers: [] }
  >;
  /** Launch scrcpy for an Android device (Sefirah-style). */
  startScrcpy?: (opts: {
    deviceId: string;
    serial?: string;
    scrcpyPath?: string;
    extraArgs?: string;
  }) => Promise<{ ok: boolean; error?: string; pid?: number }>;
  stopScrcpy?: (deviceId: string) => Promise<{ ok: boolean }>;
  /** Preflight ADB / wireless-debug readiness for scrcpy. */
  checkAdb?: (opts?: {
    serial?: string;
  }) => Promise<{
    ok: boolean;
    adbPath?: string | null;
    scrcpyPath?: string | null;
    devices?: string[];
    error?: string;
    hint?: string;
  }>;
  /** Dedicated Xcode-Simulator-style mirror BrowserWindow. */
  openMirrorWindow?: (opts: {
    deviceId: string;
    title: string;
    url: string;
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
    aspectRatio?: number;
    isPhone?: boolean;
    resizable?: boolean;
    backgroundColor?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Refit an open mirror window when frame size / scale changes. */
  resizeMirrorWindow?: (opts: {
    deviceId: string;
    width: number;
    height: number;
    aspectRatio?: number;
  }) => Promise<{ ok: boolean; error?: string }>;
  closeMirrorWindow?: (deviceId: string) => Promise<{ ok: boolean }>;
  /** Host decision for an incoming screen_share_request. */
  respondScreenShare?: (payload: {
    sessionId: string;
    accepted: boolean;
    reason?: string;
    width?: number;
    height?: number;
    fps?: number;
    mode?: "p2p" | "demo" | "scrcpy" | "unavailable";
    mimeType?: "image/jpeg" | "image/webp" | "image/png";
  }) => Promise<{ ok: boolean }>;
  windowMinimize?: () => Promise<void>;
  windowMaximizeToggle?: () => Promise<{ maximized: boolean }>;
  windowClose?: () => Promise<void>;
  windowGetState?: () => Promise<DesktopWindowState>;
  onWindowState?: (handler: (state: DesktopWindowState) => void) => () => void;
  onPeerStatus: (handler: (status: DesktopPeerStatus) => void) => () => void;
  onDiscoveredPeer: (handler: (peer: unknown) => void) => () => void;
  onEnvelope: (handler: (envelope: unknown) => void) => () => void;
  onPairRequest?: (handler: (payload: unknown) => void) => () => void;
  onUnpaired?: (handler: (data: { deviceId: string }) => void) => () => void;
  onClipboardPush?: (handler: (item: unknown) => void) => () => void;
  onTailscalePeers?: (
    handler: (peers: { host: string; port?: number; name?: string; online?: boolean }[]) => void,
  ) => () => void;
  onTransferComplete?: (handler: (data: TransferCompleteEvent) => void) => () => void;
  /** Incoming peer request to capture *this* desktop's screen. */
  onScreenShareRequest?: (
    handler: (payload: {
      request: {
        sessionId: string;
        maxEdge?: number;
        fps?: number;
        quality?: number;
      };
      fromDeviceId: string;
    }) => void,
  ) => () => void;
  /** Wire frames while we are the viewer. */
  onScreenFrame?: (
    handler: (payload: {
      frame: {
        sessionId: string;
        seq: number;
        width: number;
        height: number;
        mimeType: "image/jpeg" | "image/webp" | "image/png";
        dataBase64: string;
        capturedAt: number;
      };
      fromDeviceId: string;
    }) => void,
  ) => () => void;
  onScreenShareStop?: (
    handler: (payload: { sessionId: string; fromDeviceId?: string; reason?: string }) => void,
  ) => () => void;
  onScrcpyExit?: (
    handler: (payload: { deviceId: string; code: number | null; stderr?: string }) => void,
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
