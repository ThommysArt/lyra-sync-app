import {
  applyChunkProgress,
  canResumeTransfer,
  deriveMutualAuthSecret,
  expandLanCandidates,
  findPeerByPairingCode,
  isLikelyTailscaleHost,
  probePeer,
  scanLanForPeers,
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
  ScreenSession,
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
import {
  createDeviceIdentity,
  generateId,
  generatePairingCode,
  hashPairingCode,
} from "./identity";
import {
  applyReachableEndpoint,
  deviceEndpointCandidates,
  isLivePeer,
  resolveDeviceHost,
  wireListRemoteFiles,
  wireOpenUrl,
  wirePushClipboard,
  wireRequestScreenShare,
  wireSendFiles,
  wireReadRemoteFile,
  wireSendPairRequest,
  wireStopScreenShare,
  wireTrustHandshake,
  wireUnpairNotify,
  wireVerifyPairTrust,
} from "./peer-ops";
import {
  base64ToDataUrl,
  dataUrlToBase64,
  generateDemoScreenFrame,
} from "./screen-frames";

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

/** Joiner is waiting for the code-hosting device to Accept. */
export type OutboundPairing = {
  code: string;
  token: string;
  hostName: string;
  host: string;
  port: number;
  startedAt: number;
  status: "waiting" | "completed" | "failed";
  error?: string;
};

/** Runtime status of the local HTTP peer server (Electron / Node). */
export type PeerServerStatus = {
  running: boolean;
  port: number | null;
  url: string | null;
  /** Non-loopback LAN IP when known (for pairing candidates / QR) */
  lanHost?: string | null;
  discoveryActive: boolean;
  lastError: string | null;
  updatedAt: number;
};

export type PairDecisionResolver = (payload: {
  deviceId?: string;
  token?: string;
  accepted: boolean;
  reason?: string;
}) => Promise<{ ok: boolean; matched?: boolean; error?: string } | void>;

export type LyraState = {
  ready: boolean;
  identity: DeviceIdentity | null;
  privateKey: string | null;
  devices: PairedDevice[];
  clipboardHistory: ClipboardItem[];
  transfers: Transfer[];
  settings: AppSettings;
  activePairing: ActivePairingSession | null;
  /** Joiner-side: waiting for host Accept after entering a code */
  outboundPairing: OutboundPairing | null;
  /**
   * Pairing offers heard via multicast (code hash → host). Cleared when expired.
   * Speeds up code entry without full /24 HTTP scan.
   */
  lanPairingOffers: Array<{
    codeHash: string;
    token: string;
    expiresAt: number;
    host: string;
    port: number;
    deviceId: string;
    name: string;
    fingerprint: string;
    publicKey: string;
    type?: PairedDevice["type"];
    platform?: PairedDevice["platform"];
    seenAt: number;
  }>;
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
  /**
   * Optional local LAN IP hint (native Network API / desktop shell) used to
   * expand /24 candidates when looking up a pairing code.
   */
  localLanHint: string | null;
  /** Active screen-mirror sessions keyed by deviceId (viewer side) or sessionId. */
  screenSessions: Record<string, ScreenSession>;
  /**
   * Discovered Tailscale peers from desktop `scanTailscale` / MagicDNS
   * (not necessarily added as devices yet).
   */
  tailscalePeerHints: Array<{
    host: string;
    port?: number;
    name?: string;
    online?: boolean;
    tailscaleIp?: string;
  }>;
  /** Local Tailscale status summary when available. */
  tailscaleStatus: {
    ok: boolean;
    backendState?: string;
    selfHost?: string;
    selfIp?: string;
    error?: string;
    updatedAt: number;
  } | null;
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
   * Enter a pairing code from another device on the same network.
   * Finds the host advertising that code, sends pair_request, and waits for
   * the host user to Accept. Both devices are paired when accept succeeds.
   *
   * @param code Short code from the other device
   * @param opts.host Optional host/IP when LAN scan fails (Expo Go / AP isolation)
   */
  submitPairingCode: (
    code: string,
    opts?: { host?: string; port?: number },
  ) => Promise<
    | { ok: true; pending: true; waitingForHost: true; deviceName: string }
    | { ok: true; device: PairedDevice }
    | { ok: false; error: string }
  >;
  /** Accept a pending pair request (host side — device that shared the code). */
  confirmIncomingPair: (requestId: string) => void | Promise<void>;
  rejectIncomingPair: (requestId: string) => void;
  /** Demo helper: simulate an incoming pair request */
  simulateIncomingPair: () => void;
  /** Enqueue a wire-originated pair_request (desktop peer server → store). */
  enqueuePairRequest: (payload: PairingPayload, source?: IncomingPairingRequest["source"]) => void;
  /**
   * Desktop bridge installs this so Accept/Decline unblocks the joiner's long-poll.
   */
  setPairDecisionResolver: (resolver: PairDecisionResolver | null) => void;
  /**
   * Desktop bridge installs this to fire a UDP multicast announce burst
   * (LocalSend-style) when the user taps Refresh discovery.
   */
  setDiscoveryAnnouncer: (fn: (() => void) | null) => void;
  /** Remove local trust. Set silent to skip remote notify (already revoked by peer). */
  unpairDevice: (deviceId: string, opts?: { silent?: boolean }) => void;
  /**
   * Manually add a peer by host/IP (and optional port). Used when multicast
   * discovery cannot see the device (different subnet, Tailscale, etc.).
   * Host may include `:port` (e.g. `100.x.x.x:53319`).
   */
  addManualPeer: (input: {
    host: string;
    port?: number;
    name?: string;
    /** When true / auto-detected, mark connectionType as tailscale. */
    asTailscale?: boolean;
  }) => { ok: true; device: PairedDevice } | { ok: false; error: string };
  /**
   * Re-verify paired peers still trust us (detect remote unpair).
   * Skips unreachable peers. Called on startup and discovery refresh.
   */
  recheckPairedTrust: () => Promise<{ revoked: number; checked: number }>;
  /**
   * Update reachability addresses for a known device (LAN + optional Tailscale IP).
   */
  updateDeviceAddress: (
    deviceId: string,
    patch: {
      host?: string | null;
      port?: number | null;
      tailscaleHost?: string | null;
      preferredAddress?: PairedDevice["preferredAddress"];
      adbSerial?: string | null;
    },
  ) => { ok: true } | { ok: false; error: string };
  /** Start viewing a device screen (demo, P2P, or scrcpy-assisted). */
  startScreenMirror: (
    deviceId: string,
    opts?: { mode?: "auto" | "demo" | "p2p" | "scrcpy" },
  ) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  stopScreenMirror: (deviceId: string) => Promise<void>;
  /** Ingest a frame from the wire (viewer) or local capture. */
  ingestScreenFrame: (
    deviceId: string,
    frame: {
      sessionId: string;
      seq: number;
      width: number;
      height: number;
      mimeType: "image/jpeg" | "image/webp" | "image/png";
      dataBase64?: string;
      dataUrl?: string;
      capturedAt: number;
    },
  ) => void;
  /**
   * Replace screen session map (multi-window BroadcastChannel sync).
   * Used so a dedicated mirror popup sees demo/P2P frames from the main window.
   */
  applyScreenSessions: (sessions: Record<string, ScreenSession>) => void;
  /** Record Tailscale discovery status for Settings UI. */
  setTailscaleStatus: (status: NonNullable<LyraState["tailscaleStatus"]>) => void;
  /**
   * Establish mutual authSecret for a manual/probed peer (dual-confirm path on remote).
   * Local side stores secret immediately after probe identity exchange; remote still must confirm.
   */
  trustDevice: (deviceId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Ingest Tailscale peer hints from desktop (MagicDNS / status --json). */
  ingestTailscalePeers: (
    peers: { host: string; port?: number; name?: string; online?: boolean }[],
  ) => number;
  /**
   * Ingest a LAN multicast discovery announce as a *nearby* (untrusted) peer.
   * Does not pair — user must Pair / trust explicitly.
   */
  ingestDiscoveredPeer: (announce: {
    identity: {
      id: string;
      name: string;
      type?: PairedDevice["type"];
      platform?: PairedDevice["platform"];
      fingerprint: string;
      publicKey?: string;
    };
    host: string;
    port: number;
    /** Active pairing offer from multicast (code hash only) */
    pairing?: { codeHash: string; token: string; expiresAt: number };
  }) => void;
  /**
   * Record a completed inbound wire transfer (desktop peer server → UI).
   */
  recordReceivedTransfer: (input: {
    transferId: string;
    deviceId?: string;
    deviceName?: string;
    files: { name: string; size: number }[];
    receivedBytes: number;
    savedPaths?: string[];
  }) => void;
  /** Apply a remote device status payload (from status envelope / probe). */
  applyRemoteStatus: (deviceId: string, status: NonNullable<PairedDevice["status"]>) => void;
  /** Download remote file bytes when peer has real FS */
  downloadRemoteFile: (
    deviceId: string,
    path: string,
  ) => Promise<{ ok: true; bytes: Uint8Array; size: number } | { ok: false; error: string }>;
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
  /** Seed LAN /24 scan when looking up pairing codes (native IP / desktop LAN). */
  setLocalLanHint: (host: string | null) => void;
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
      relativePath?: string;
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
   * When host/port are present, sends pair_request and waits for host Accept
   * (same as code entry). Otherwise queues a local confirm for offline/demo.
   */
  applyPairingPayload: (
    payload: PairingPayload | string,
  ) => Promise<
    | { ok: true; pending: true; waitingForHost: true; deviceName: string }
    | { ok: true; pending: true; requestId: string; deviceName: string }
    | { ok: true; device: PairedDevice }
    | { ok: false; error: string }
  >;
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
    outboundPairing: null,
    lanPairingOffers: [],
    incomingPairRequests: [],
    selectedDeviceId: null,
    localClipboardText: "",
    toast: null,
    localLanHint: null,
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
    screenSessions: {},
    tailscalePeerHints: [],
    tailscaleStatus: null,
  };
}

/** Timers for demo / local frame generators (module scope so stop can clear). */
const screenFrameTimers = new Map<string, ReturnType<typeof setInterval>>();

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
    /** When true (default false for host long-poll path), also notify remote via pair_request */
    notifyRemote?: boolean;
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
  const host = input.payload.host?.trim() || undefined;
  const tsHost =
    (input.payload as { tailscaleHost?: string }).tailscaleHost?.trim() ||
    (host && isLikelyTailscaleHost(host) ? host : undefined);
  const lanHost = host && !isLikelyTailscaleHost(host) ? host : undefined;
  const port = input.payload.port && input.payload.port > 0 ? input.payload.port : LYRA_DEFAULT_PORT;
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
    connectionType: tsHost && lanHost ? "both" : tsHost ? "tailscale" : "local",
    autoAcceptTransfers: s.settings.autoAcceptTransfers,
    autoAcceptClipboard: s.settings.autoAcceptClipboard,
    showInMainList: true,
    host: lanHost || host,
    port,
    tailscaleHost: tsHost,
    preferredAddress: tsHost && !lanHost ? "tailscale" : "auto",
    // Connection that just completed pairing is the best first try for callback
    lastReachableHost: host,
    lastReachablePort: port,
    authSecret,
  };

  set((st) => ({
    ...st,
    // Drop nearby/manual duplicates for same id, fingerprint, or host:port
    devices: [
      device,
      ...st.devices.filter((d) => {
        if (d.id === device.id) return false;
        if (d.fingerprint && d.fingerprint === device.fingerprint) return false;
        if (
          device.host &&
          d.host === device.host &&
          (d.port ?? LYRA_DEFAULT_PORT) === (device.port ?? LYRA_DEFAULT_PORT) &&
          !d.authSecret
        ) {
          return false;
        }
        return true;
      }),
    ],
    activePairing: null,
    outboundPairing: null,
    // Ensure no stuck banners for this peer
    incomingPairRequests: st.incomingPairRequests.filter(
      (r) => r.payload.deviceId !== device.id && r.payload.fingerprint !== device.fingerprint,
    ),
  }));
  persist();

  // Optional legacy notify (prefer long-poll pair_confirm on the host path)
  if (input.notifyRemote && device.host && s.identity) {
    const peerStatus = getState().peerServer;
    let localHost: string | undefined;
    if (peerStatus.url) {
      try {
        localHost = new URL(peerStatus.url).hostname;
      } catch {
        localHost = undefined;
      }
    }
    if (
      !localHost ||
      localHost === "127.0.0.1" ||
      localHost === "0.0.0.0" ||
      localHost === "localhost" ||
      localHost === "[::1]"
    ) {
      localHost = undefined;
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

/** Local IPv4 advertised by our peer server, if any. */
function localLanHostFromState(s: LyraState): string | undefined {
  if (s.peerServer.lanHost) {
    const h = s.peerServer.lanHost;
    if (h && h !== "127.0.0.1" && h !== "localhost" && h !== "0.0.0.0") return h;
  }
  if (s.peerServer.url) {
    try {
      const h = new URL(s.peerServer.url).hostname;
      if (h && h !== "127.0.0.1" && h !== "localhost" && h !== "0.0.0.0" && h !== "[::1]") {
        return h;
      }
    } catch {
      // ignore
    }
  }
  // Mobile / browser LAN hint from expo-network or desktop bridge
  if (s.localLanHint) {
    const h = s.localLanHint.trim();
    if (h && h !== "127.0.0.1" && h !== "localhost" && h !== "0.0.0.0") return h;
  }
  return undefined;
}

function collectPairingCandidates(s: LyraState): { host: string; port?: number }[] {
  const port = s.settings.peerListenPort ?? LYRA_DEFAULT_PORT;
  const seeds: { host: string; port?: number }[] = [];
  for (const d of s.devices) {
    if (d.host) seeds.push({ host: d.host, port: d.port ?? port });
  }
  seeds.push({ host: "127.0.0.1", port });
  seeds.push({ host: "localhost", port });

  // Prefer LAN IP from peer server / native hint for /24 expansion
  const lan = localLanHostFromState(s) ?? s.localLanHint ?? undefined;
  if (lan) seeds.push({ host: lan, port });

  return seeds;
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

/**
 * Parse "host", "host:port", or "[ipv6]:port" into parts.
 * Does not treat bare IPv6 as host:port (no brackets + multiple colons).
 */
export function parseHostPortInput(
  raw: string,
  defaultPort: number = LYRA_DEFAULT_PORT,
): { host: string; port: number } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Host or IP is required" };

  // [ipv6]:port
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracket) {
    const host = bracket[1]!;
    const port = bracket[2] ? Number(bracket[2]) : defaultPort;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return { error: "Invalid port" };
    }
    return { host, port };
  }

  // host:port where host has no colons (IPv4 / hostname)
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && !trimmed.includes("://")) {
    const maybePort = trimmed.slice(colon + 1);
    if (/^\d{1,5}$/.test(maybePort)) {
      const port = Number(maybePort);
      if (port > 0 && port <= 65535) {
        return { host: trimmed.slice(0, colon), port };
      }
      return { error: "Invalid port" };
    }
  }

  return { host: trimmed, port: defaultPort };
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
  const isTs =
    result.connectionHint === "tailscale" || isLikelyTailscaleHost(result.host);
  const withEndpoint = applyReachableEndpoint(d, {
    host: result.host,
    port: result.port,
    protocol: "http",
  });
  return {
    ...withEndpoint,
    online: true,
    lastSeenAt: now,
    lastProbeLatencyMs: result.latencyMs,
    connectionType: isTs
      ? d.host && !isLikelyTailscaleHost(d.host)
        ? "both"
        : withEndpoint.connectionType
      : withEndpoint.connectionType,
    // Prefer live identity fields when probing a real peer
    name: d.nickname ? d.name : result.name || d.name,
    fingerprint: result.fingerprint || d.fingerprint,
    platform: (result.platform as PairedDevice["platform"]) || d.platform,
  };
}

/** Probe every LAN/Tailscale/port candidate until one answers /lyra/info. */
async function probeDeviceCandidates(
  device: PairedDevice,
  opts?: { timeoutMs?: number },
): Promise<ProbeResult> {
  const candidates = deviceEndpointCandidates(device);
  if (candidates.length === 0) {
    return {
      ok: false,
      host: device.host || device.tailscaleHost || "",
      port: device.port ?? LYRA_DEFAULT_PORT,
      online: false,
      error: "No host",
      latencyMs: 0,
    };
  }
  let last: ProbeResult | null = null;
  for (const ep of candidates) {
    const r = await probePeer(
      { host: ep.host, port: ep.port, protocol: ep.protocol },
      {
        timeoutMs: opts?.timeoutMs ?? 1600,
        preferTailscale: isLikelyTailscaleHost(ep.host),
      },
    );
    last = r;
    if (r.ok) return r;
  }
  return last!;
}

function defaultSeedDemo(explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  // Demo mesh is opt-in only — real pairing / transfers need empty state to test.
  try {
    const env =
      typeof process !== "undefined"
        ? (process.env as Record<string, string | undefined>)
        : undefined;
    if (env?.LYRA_SEED_DEMO === "1" || env?.LYRA_SEED_DEMO === "true") return true;
    if (env?.VITE_LYRA_SEED_DEMO === "1" || env?.VITE_LYRA_SEED_DEMO === "true") return true;
    if (env?.EXPO_PUBLIC_LYRA_SEED_DEMO === "1" || env?.EXPO_PUBLIC_LYRA_SEED_DEMO === "true") {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/** Drop persisted demo_* mesh so real testing is not polluted after turning seed off. */
function stripDemoMesh(input: {
  devices: PairedDevice[];
  clipboardHistory: ClipboardItem[];
  transfers: Transfer[];
}): {
  devices: PairedDevice[];
  clipboardHistory: ClipboardItem[];
  transfers: Transfer[];
} {
  const isDemoId = (id: string | undefined) => Boolean(id?.startsWith("demo_"));
  return {
    devices: input.devices.filter((d) => !isDemoId(d.id)),
    clipboardHistory: input.clipboardHistory.filter((c) => !isDemoId(c.sourceDeviceId)),
    transfers: input.transfers.filter((t) => !isDemoId(t.deviceId) && !isDemoId(t.id)),
  };
}

export function createLyraStore(options?: {
  storage?: StorageLike | null;
  seedDemo?: boolean;
  platformHint?: "web" | "native" | "android" | "ios";
}): LyraStore {
  let state = createInitialState();
  const listeners = new Set<() => void>();
  const storage = options?.storage ?? null;
  const seedDemo = defaultSeedDemo(options?.seedDemo);
  /** Installed by desktop bridge to unblock joiner long-poll on Accept/Decline */
  let pairDecisionResolver: PairDecisionResolver | null = null;
  /** Installed by desktop bridge to fire UDP announce burst */
  let discoveryAnnouncer: (() => void) | null = null;

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
    // Prefer isolating private key under a separate storage key when possible
    // so bulk device/clipboard dumps are less sensitive (web localStorage).
    try {
      if (state.privateKey && typeof storage.setItem === "function") {
        storage.setItem(`${STORAGE_KEY}.key`, state.privateKey);
      }
    } catch {
      // ignore
    }
    const payload = {
      identity: state.identity,
      // Keep privateKey in bulk only as migration fallback; prefer `.key` slot
      privateKey: null as string | null,
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
          const parsed = JSON.parse(raw) as Partial<typeof state> & { privateKey?: string | null };
          if (parsed.identity) identity = parsed.identity;
          if (parsed.privateKey) privateKey = parsed.privateKey;
          if (parsed.devices) devices = parsed.devices;
          if (parsed.clipboardHistory) clipboardHistory = parsed.clipboardHistory;
          if (parsed.transfers) transfers = parsed.transfers;
          if (parsed.settings) settings = AppSettingsSchema.parse(parsed.settings);
        }
        // Isolated key slot (preferred)
        const isolated = storage.getItem(`${STORAGE_KEY}.key`);
        if (isolated) privateKey = isolated;
      } catch {
        // corrupt storage — re-seed
      }
    }

    if (!identity || !privateKey) {
      const hint = options?.platformHint;
      const isMobile =
        hint === "native" || hint === "android" || hint === "ios";
      const platform =
        hint === "ios"
          ? "ios"
          : hint === "android" || hint === "native"
            ? "android"
            : "web";
      const created = await createDeviceIdentity({
        name: isMobile ? "My Phone" : "My Computer",
        platform,
        type: isMobile ? "mobile" : "desktop",
      });
      if (!created.ok) {
        throw created.error;
      }
      identity = created.identity;
      privateKey = created.privateKey;
    }

    if (seedDemo) {
      if (devices.length === 0) devices = createDemoPairedDevices(identity);
      if (clipboardHistory.length === 0) {
        clipboardHistory = createDemoClipboardHistory(identity);
      }
      if (transfers.length === 0) transfers = createDemoTransfers();
    } else {
      // Remove any previously persisted dummy mesh
      const cleaned = stripDemoMesh({ devices, clipboardHistory, transfers });
      devices = cleaned.devices;
      clipboardHistory = cleaned.clipboardHistory;
      transfers = cleaned.transfers;
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
      const host = localLanHostFromState(s);
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
    setPairDecisionResolver: (resolver) => {
      pairDecisionResolver = resolver;
    },
    setDiscoveryAnnouncer: (fn) => {
      discoveryAnnouncer = fn;
    },
    submitPairingCode: async (code, opts) => {
      const s0 = getState();
      if (!s0.identity) return { ok: false as const, error: "Not ready" };
      const normalized = code.trim().toUpperCase();
      if (normalized.length < 4) return { ok: false as const, error: "Code too short" };

      // Self-loop: entering our own displayed code
      if (s0.activePairing && s0.activePairing.code === normalized) {
        return {
          ok: false as const,
          error: "That's this device's code — enter it on the *other* device",
        };
      }

      const codeHash = await hashPairingCode(normalized);
      const port = opts?.port && opts.port > 0 ? opts.port : s0.settings.peerListenPort ?? LYRA_DEFAULT_PORT;
      const manualHost = opts?.host?.trim();

      console.info("[lyra pair] looking up code", {
        code: normalized,
        codeHash: codeHash.slice(0, 12),
        manualHost: manualHost || null,
        lanHint: s0.localLanHint,
        knownDevices: s0.devices.filter((d) => d.host).map((d) => `${d.host}:${d.port ?? port}`),
        multicastOffers: s0.lanPairingOffers.length,
      });

      // 0) Multicast-cached offers (instant when desktop is announcing with active code)
      const now = Date.now();
      const fromMcast = s0.lanPairingOffers.find(
        (o) => o.codeHash === codeHash && o.expiresAt > now,
      );
      let match: Awaited<ReturnType<typeof findPeerByPairingCode>> = null;
      if (fromMcast) {
        console.info("[lyra pair] matched multicast offer", fromMcast.host, fromMcast.port);
        match = {
          host: fromMcast.host,
          port: fromMcast.port,
          reachHost: fromMcast.host,
          identity: {
            id: fromMcast.deviceId,
            name: fromMcast.name,
            type: fromMcast.type ?? "desktop",
            platform: fromMcast.platform ?? "unknown",
            fingerprint: fromMcast.fingerprint,
            publicKey: fromMcast.publicKey,
          },
          pairing: {
            codeHash: fromMcast.codeHash,
            token: fromMcast.token,
            expiresAt: fromMcast.expiresAt,
          },
        };
      }

      // 1) Optional manual host (Expo Go / scan failure fallback)
      if (!match && manualHost) {
        match = await findPeerByPairingCode({
          codeHash,
          candidates: [{ host: manualHost, port }],
          localDeviceId: s0.identity.id,
          timeoutMs: 2500,
          concurrency: 1,
        });
        console.info("[lyra pair] manual host probe", manualHost, match ? "HIT" : "MISS");
      }

      // 2) Known peers + localhost
      if (!match) {
        const seeds = collectPairingCandidates(s0);
        if (manualHost) seeds.unshift({ host: manualHost, port });
        match = await findPeerByPairingCode({
          codeHash,
          candidates: seeds.map((c) => ({ host: c.host, port: c.port ?? port })),
          localDeviceId: s0.identity.id,
          timeoutMs: 900,
          concurrency: 16,
        });
        console.info("[lyra pair] seed probe", seeds.length, "candidates", match ? "HIT" : "MISS");
      }

      // 3) Full /24 HTTP scan (LocalSend-style)
      if (!match) {
        const seeds = collectPairingCandidates(s0);
        if (manualHost) seeds.unshift({ host: manualHost, port });
        if (s0.localLanHint) seeds.unshift({ host: s0.localLanHint, port });
        const expanded = expandLanCandidates(seeds, port);
        console.info("[lyra pair] LAN /24 scan", expanded.length, "hosts");
        match = await findPeerByPairingCode({
          codeHash,
          candidates: expanded,
          localDeviceId: s0.identity.id,
          timeoutMs: 700,
          concurrency: 48,
        });
        console.info("[lyra pair] LAN scan", match ? "HIT" : "MISS");
      }

      if (!match) {
        const hint = s0.localLanHint ? ` Your IP looks like ${s0.localLanHint}.` : "";
        const msg =
          "No device found with that code." +
          " The other device must be showing its code with its peer server running" +
          " (desktop app, native preview build, or `pnpm peer-server`)." +
          " Expo Go cannot host a code. Try Refresh discovery, or enter the host’s LAN / Tailscale IP below." +
          hint;
        notify(set, msg, "error");
        return { ok: false as const, error: msg };
      }

      const hostName = match.identity.name || "device";
      set((st) => ({
        ...st,
        outboundPairing: {
          code: normalized,
          token: match!.pairing.token,
          hostName,
          host: match!.reachHost,
          port: match!.port,
          startedAt: Date.now(),
          status: "waiting",
        },
      }));
      notify(set, `Waiting for ${hostName} to accept…`, "info");

      // Build our callback address so host can reach us later if needed
      const localHost = localLanHostFromState(getState());
      const localPort = getState().peerServer.port ?? getState().settings.peerListenPort;

      const wire = await wireSendPairRequest({
        host: match.reachHost,
        port: match.port,
        identity: s0.identity,
        payload: {
          version: 1,
          deviceId: s0.identity.id,
          name: s0.identity.name,
          type: s0.identity.type,
          platform: s0.identity.platform,
          fingerprint: s0.identity.fingerprint,
          publicKey: s0.identity.publicKey,
          token: match.pairing.token,
          host: localHost,
          port: localPort,
          expiresAt: match.pairing.expiresAt,
        },
        code: normalized,
        waitForConfirmMs: 120_000,
      });

      if (!wire.ok) {
        set((st) => ({
          ...st,
          outboundPairing: st.outboundPairing
            ? { ...st.outboundPairing, status: "failed", error: wire.error }
            : null,
        }));
        notify(set, wire.error, "error");
        return { ok: false as const, error: wire.error };
      }

      // Host accepted → pair_confirm envelope
      const env = wire.envelope;
      if (!env || env.type === "pair_reject") {
        const reason =
          env && env.type === "pair_reject"
            ? String((env.payload as { reason?: string })?.reason ?? "rejected")
            : "Pairing declined or timed out";
        set((st) => ({
          ...st,
          outboundPairing: st.outboundPairing
            ? { ...st.outboundPairing, status: "failed", error: reason }
            : null,
        }));
        notify(set, `Pairing declined: ${reason}`, "error");
        return { ok: false as const, error: reason };
      }

      if (env.type !== "pair_confirm") {
        set((st) => ({ ...st, outboundPairing: null }));
        return { ok: false as const, error: "Unexpected response from host" };
      }

      const confirm = env.payload as {
        identity?: DeviceIdentity;
        token?: string;
        publicKey?: string;
        host?: string;
        port?: number;
      };
      const remoteId = confirm.identity ?? {
        id: match.identity.id,
        name: match.identity.name,
        type: match.identity.type as DeviceIdentity["type"],
        platform: match.identity.platform as DeviceIdentity["platform"],
        fingerprint: match.identity.fingerprint,
        publicKey: match.identity.publicKey,
        createdAt: Date.now(),
      };

      try {
        const device = await finalizePairDevice(set, getState, persist, {
          payload: {
            version: 1,
            deviceId: remoteId.id,
            name: remoteId.name,
            type: remoteId.type,
            platform: remoteId.platform,
            fingerprint: remoteId.fingerprint,
            publicKey: confirm.publicKey || remoteId.publicKey,
            token: confirm.token || match.pairing.token,
            host: confirm.host || match.reachHost,
            port: confirm.port || match.port,
            expiresAt: match.pairing.expiresAt,
          },
          source: "code",
          code: normalized,
          notifyRemote: false,
        });
        if (!device) {
          return { ok: false as const, error: "Could not complete pairing" };
        }
        notify(set, `Paired with ${device.name}`, "success");
        return { ok: true as const, device };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        notify(set, `Pairing failed: ${msg}`, "error");
        return { ok: false as const, error: msg };
      }
    },
    confirmIncomingPair: async (requestId) => {
      const s = getState();
      const req = s.incomingPairRequests.find((r) => r.id === requestId);
      if (!req) return;

      // Always dismiss the banner first so it never sticks if finalize fails.
      set((st) => ({
        ...st,
        incomingPairRequests: st.incomingPairRequests.filter(
          (r) => r.id !== requestId && r.payload.deviceId !== req.payload.deviceId,
        ),
      }));

      try {
        // Prefer session token when wire request used host offer token
        const token =
          (s.activePairing &&
            (req.payload.token === s.activePairing.token ||
              (req.code && req.code === s.activePairing.code))
            ? s.activePairing.token
            : req.payload.token) || req.payload.token;

        const device = await finalizePairDevice(set, getState, persist, {
          payload: { ...req.payload, token },
          source: req.source,
          code: req.code,
          // Joiner is blocked on long-poll; resolve it instead of sending another request
          notifyRemote: false,
        });

        // Unblock joiner's pair_request HTTP call with pair_confirm
        if (pairDecisionResolver) {
          await pairDecisionResolver({
            deviceId: req.payload.deviceId,
            token,
            accepted: true,
          });
        }

        if (device) {
          notify(set, `Paired with ${device.name}`, "success");
          // Immediately verify we can call the peer back (mobile→desktop path)
          if (device.host || device.tailscaleHost) {
            void store.probePeerAddress({
              host: device.lastReachableHost || device.host || device.tailscaleHost!,
              port: device.lastReachablePort || device.port,
            }).then((result) => {
              if (result.ok) {
                set((st) => ({
                  ...st,
                  devices: st.devices.map((d) =>
                    d.id === device!.id
                      ? applyReachableEndpoint(d, {
                          host: result.host,
                          port: result.port,
                          protocol: "http",
                        })
                      : d,
                  ),
                }));
                persist();
              } else {
                notify(
                  set,
                  `Paired, but cannot reach ${device.name} yet (${result.error}). Check its address in device details.`,
                  "info",
                );
              }
            });
          }
        } else {
          notify(set, "Could not complete pairing — try again", "error");
        }
      } catch (e) {
        // Still try to reject the long-poll so joiner does not hang
        if (pairDecisionResolver) {
          void pairDecisionResolver({
            deviceId: req.payload.deviceId,
            token: req.payload.token,
            accepted: false,
            reason: "error",
          });
        }
        notify(
          set,
          `Pairing failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
    rejectIncomingPair: (requestId) => {
      const s = getState();
      const req = s.incomingPairRequests.find((r) => r.id === requestId);
      set((st) => ({
        ...st,
        incomingPairRequests: st.incomingPairRequests.filter((r) => r.id !== requestId),
      }));
      if (req && pairDecisionResolver) {
        void pairDecisionResolver({
          deviceId: req.payload.deviceId,
          token: req.payload.token,
          accepted: false,
          reason: "rejected",
        });
      }
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

      // Already trusted: update reachability quietly — do not re-prompt (banner loop fix).
      const already = s.devices.find(
        (d) =>
          d.authSecret &&
          (d.id === payload.deviceId || d.fingerprint === payload.fingerprint),
      );
      if (already) {
        set((st) => ({
          ...st,
          devices: st.devices.map((d) =>
            d.id === already.id
              ? {
                  ...d,
                  host: payload.host ?? d.host,
                  port: payload.port ?? d.port,
                  lastSeenAt: Date.now(),
                  online: true,
                  name: d.nickname ? d.name : payload.name || d.name,
                }
              : d,
          ),
          // Clear any stale pending prompt for this peer
          incomingPairRequests: st.incomingPairRequests.filter(
            (r) => r.payload.deviceId !== payload.deviceId,
          ),
        }));
        persist();
        return;
      }

      const existing = s.incomingPairRequests.find((r) => r.payload.deviceId === payload.deviceId);
      if (existing) {
        // Refresh payload (host/port) without stacking banners
        set((st) => ({
          ...st,
          incomingPairRequests: st.incomingPairRequests.map((r) =>
            r.payload.deviceId === payload.deviceId
              ? { ...r, payload: { ...r.payload, ...payload }, receivedAt: Date.now() }
              : r,
          ),
        }));
        return;
      }

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
    unpairDevice: (deviceId, opts) => {
      const s = getState();
      const device = s.devices.find((d) => d.id === deviceId);
      // Best-effort remote revoke (does not block local unpair)
      if (
        !opts?.silent &&
        device &&
        s.identity &&
        s.privateKey &&
        isLivePeer(device) &&
        device.authSecret
      ) {
        void wireUnpairNotify({
          device,
          identity: s.identity,
          privateKey: s.privateKey,
        });
      }
      // Drop cached auth sessions so we do not reuse stale tokens
      if (device) {
        void import("@lyra-sync-app/net").then(({ clearPeerSessionFor, clearPeerSessionCache }) => {
          const ep = {
            host: resolveDeviceHost(device) || device.host || "127.0.0.1",
            port: device.port ?? LYRA_DEFAULT_PORT,
          };
          try {
            clearPeerSessionFor(ep, device.id);
          } catch {
            clearPeerSessionCache();
          }
        });
      }
      set((st) => ({
        ...st,
        devices: st.devices.filter((d) => d.id !== deviceId),
        selectedDeviceId: st.selectedDeviceId === deviceId ? null : st.selectedDeviceId,
      }));
      persist();
      if (!opts?.silent) {
        notify(set, "Device unpaired", "info");
      }
    },
    recheckPairedTrust: async () => {
      const s = getState();
      if (!s.identity || !s.privateKey) return { revoked: 0, checked: 0 };
      const paired = s.devices.filter((d) => d.authSecret && isLivePeer(d));
      let revoked = 0;
      let checked = 0;
      for (const device of paired) {
        checked++;
        try {
          const res = await wireVerifyPairTrust({
            device,
            identity: s.identity!,
            privateKey: s.privateKey!,
          });
          if (!res.ok) {
            // Unreachable — keep local pair
            continue;
          }
          if (!res.stillTrusted) {
            revoked++;
            const name = device.nickname || device.name;
            store.unpairDevice(device.id, { silent: true });
            notify(
              set,
              `${name} is no longer paired (removed on the other device)`,
              "info",
            );
          }
        } catch {
          // ignore individual failures
        }
      }
      return { revoked, checked };
    },
    addManualPeer: (input) => {
      const s = getState();
      if (!s.identity) return { ok: false as const, error: "Not ready" };
      const defaultPort =
        input.port && input.port > 0
          ? input.port
          : (s.settings.peerListenPort ?? LYRA_DEFAULT_PORT);
      const parsed = parseHostPortInput(input.host, defaultPort);
      if ("error" in parsed) return { ok: false as const, error: parsed.error };
      const { host, port } = parsed;

      // Basic host validation: hostname, IPv4, or IPv6-ish
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(host) && !host.includes(":")) {
        return { ok: false as const, error: "Invalid host" };
      }

      const existing = s.devices.find(
        (d) =>
          (d.host === host || d.tailscaleHost === host) &&
          (d.port ?? LYRA_DEFAULT_PORT) === port,
      );
      if (existing) {
        return { ok: false as const, error: "A peer with that address already exists" };
      }

      const now = Date.now();
      const name = (input.name?.trim() || `Peer ${host}`).slice(0, 64);
      const isTs = Boolean(input.asTailscale) || isLikelyTailscaleHost(host);
      // Nearby / address-only — not trusted until Pair completes.
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
        connectionType: isTs ? "tailscale" : "manual",
        autoAcceptTransfers: s.settings.autoAcceptTransfers,
        autoAcceptClipboard: s.settings.autoAcceptClipboard,
        showInMainList: false,
        host,
        port,
        tailscaleHost: isTs ? host : undefined,
        preferredAddress: isTs ? "tailscale" : "auto",
        status: {
          deviceId: "",
          batteryLevel: null,
          isCharging: null,
          networkType: isTs ? "tailscale" : "unknown",
          networkName: isTs ? "Tailscale" : null,
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
      notify(
        set,
        isTs
          ? `Tailscale peer saved (${host}:${port}) — Pair to trust ${name}`
          : `Nearby peer saved (${host}:${port}) — tap Pair to trust ${name}`,
        "info",
      );
      return { ok: true as const, device };
    },
    updateDeviceAddress: (deviceId, patch) => {
      const s = getState();
      const device = s.devices.find((d) => d.id === deviceId);
      if (!device) return { ok: false as const, error: "Device not found" };

      const nextHost =
        patch.host === null ? undefined : patch.host !== undefined ? patch.host.trim() : device.host;
      const nextTs =
        patch.tailscaleHost === null
          ? undefined
          : patch.tailscaleHost !== undefined
            ? patch.tailscaleHost.trim()
            : device.tailscaleHost;
      const nextPort =
        patch.port === null
          ? undefined
          : patch.port !== undefined
            ? patch.port
            : device.port;

      if (nextHost && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(nextHost) && !nextHost.includes(":")) {
        return { ok: false as const, error: "Invalid host" };
      }
      if (
        nextTs &&
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(nextTs) &&
        !nextTs.includes(":")
      ) {
        return { ok: false as const, error: "Invalid Tailscale host" };
      }
      if (nextTs && !isLikelyTailscaleHost(nextTs) && !nextTs.includes(".")) {
        // Soft warning path: still allow MagicDNS short names
      }

      let connectionType = device.connectionType;
      const hasLan = Boolean(nextHost && !isLikelyTailscaleHost(nextHost));
      const hasTs = Boolean(nextTs || (nextHost && isLikelyTailscaleHost(nextHost)));
      if (hasLan && hasTs) connectionType = "both";
      else if (hasTs) connectionType = "tailscale";
      else if (hasLan) connectionType = connectionType === "manual" ? "manual" : "local";

      set((st) => ({
        ...st,
        devices: st.devices.map((d) =>
          d.id === deviceId
            ? {
                ...d,
                host: nextHost || undefined,
                port: nextPort,
                tailscaleHost: nextTs || undefined,
                preferredAddress: patch.preferredAddress ?? d.preferredAddress ?? "auto",
                adbSerial:
                  patch.adbSerial === null
                    ? undefined
                    : patch.adbSerial !== undefined
                      ? patch.adbSerial.trim() || undefined
                      : d.adbSerial,
                connectionType,
              }
            : d,
        ),
      }));
      persist();
      notify(set, "Device addresses updated", "success");
      return { ok: true as const };
    },
    startScreenMirror: async (deviceId, opts) => {
      const s = getState();
      const device = s.devices.find((d) => d.id === deviceId);
      if (!device) return { ok: false as const, error: "Device not found" };

      // Stop any existing session for this device first
      await store.stopScreenMirror(deviceId);

      const sessionId = generateId("scr");
      const now = Date.now();
      const want = opts?.mode ?? "auto";
      const isDemo = device.id.startsWith("demo_") || want === "demo";
      const fps = s.settings.screenShareFps ?? 12;
      const maxEdge = s.settings.screenShareMaxEdge ?? 720;

      let mode: ScreenSession["mode"] = "demo";
      if (!isDemo && want === "scrcpy") mode = "scrcpy";
      else if (!isDemo && want === "p2p") mode = "p2p";
      else if (!isDemo && isLivePeer(device) && device.authSecret) mode = "p2p";
      else if (!isDemo && (device.platform === "android" || device.type === "mobile")) {
        // Prefer scrcpy path when no trusted P2P stream available
        mode = want === "auto" ? "scrcpy" : "demo";
      } else if (isDemo) mode = "demo";
      else mode = "demo";

      const session: ScreenSession = {
        sessionId,
        deviceId,
        role: "viewer",
        status: "requesting",
        mode,
        fps,
        frameCount: 0,
        startedAt: now,
        updatedAt: now,
      };
      set((st) => ({
        ...st,
        screenSessions: { ...st.screenSessions, [deviceId]: session },
      }));

      if (mode === "demo" || isDemo) {
        const isPhone = device.type === "mobile" || device.platform === "android" || device.platform === "ios";
        const w = isPhone ? Math.min(maxEdge, 390) : Math.min(maxEdge, 960);
        const h = isPhone ? Math.round(w * (844 / 390)) : Math.round(w * (600 / 960));
        const pushFrame = () => {
          const cur = getState().screenSessions[deviceId];
          if (!cur || cur.sessionId !== sessionId || cur.status === "ended") return;
          const frame = generateDemoScreenFrame({
            platform: device.platform as "android",
            width: w,
            height: h,
            now: Date.now(),
            deviceName: device.nickname || device.name,
            battery: device.status?.batteryLevel ?? 72,
          });
          const b64 = dataUrlToBase64(frame.dataUrl);
          store.ingestScreenFrame(deviceId, {
            sessionId,
            seq: (cur.frameCount ?? 0) + 1,
            width: frame.width,
            height: frame.height,
            mimeType: "image/jpeg",
            dataUrl: frame.dataUrl,
            dataBase64: b64?.dataBase64,
            capturedAt: Date.now(),
          });
        };
        set((st) => ({
          ...st,
          screenSessions: {
            ...st.screenSessions,
            [deviceId]: {
              ...session,
              status: "active",
              mode: "demo",
              width: w,
              height: h,
              updatedAt: Date.now(),
            },
          },
        }));
        pushFrame();
        const timer = setInterval(pushFrame, Math.max(80, Math.round(1000 / fps)));
        screenFrameTimers.set(deviceId, timer);
        notify(set, `Mirroring ${device.nickname || device.name} (preview)`, "success");
        return { ok: true as const, sessionId };
      }

      if (mode === "scrcpy") {
        // Desktop shell launches scrcpy; UI shows framed status + last demo still until external opens
        set((st) => ({
          ...st,
          screenSessions: {
            ...st.screenSessions,
            [deviceId]: {
              ...session,
              status: "active",
              mode: "scrcpy",
              updatedAt: Date.now(),
            },
          },
        }));
        // Provide a soft preview frame so the bezel isn't empty
        const frame = generateDemoScreenFrame({
          platform: "android",
          width: 390,
          height: 844,
          deviceName: device.nickname || device.name,
          battery: device.status?.batteryLevel ?? 80,
        });
        store.ingestScreenFrame(deviceId, {
          sessionId,
          seq: 1,
          width: 390,
          height: 844,
          mimeType: "image/jpeg",
          dataUrl: frame.dataUrl,
          capturedAt: Date.now(),
        });
        notify(
          set,
          "Scrcpy mirror — desktop will launch external viewer when available",
          "info",
        );
        return { ok: true as const, sessionId };
      }

      // P2P path
      if (!s.identity || !s.privateKey) {
        set((st) => ({
          ...st,
          screenSessions: {
            ...st.screenSessions,
            [deviceId]: {
              ...session,
              status: "error",
              error: "Not ready",
              updatedAt: Date.now(),
            },
          },
        }));
        return { ok: false as const, error: "Not ready" };
      }
      if (!device.authSecret) {
        // Fall back to demo for untrusted peers
        return store.startScreenMirror(deviceId, { mode: "demo" });
      }

      const res = await wireRequestScreenShare({
        device,
        identity: s.identity,
        privateKey: s.privateKey,
        sessionId,
        maxEdge,
        fps,
      });
      if (!res.ok) {
        // Graceful fallback to high-quality demo bezel so the feature always demos well
        notify(set, `Live share unavailable (${res.error}) — showing preview`, "info");
        return store.startScreenMirror(deviceId, { mode: "demo" });
      }
      set((st) => ({
        ...st,
        screenSessions: {
          ...st.screenSessions,
          [deviceId]: {
            ...session,
            status: "active",
            mode: res.accept.mode === "demo" ? "demo" : "p2p",
            width: res.accept.width,
            height: res.accept.height,
            fps: res.accept.fps ?? fps,
            updatedAt: Date.now(),
          },
        },
      }));
      notify(set, `Screen share active with ${device.nickname || device.name}`, "success");
      return { ok: true as const, sessionId };
    },
    stopScreenMirror: async (deviceId) => {
      const timer = screenFrameTimers.get(deviceId);
      if (timer) {
        clearInterval(timer);
        screenFrameTimers.delete(deviceId);
      }
      const s = getState();
      const session = s.screenSessions[deviceId];
      if (!session) return;

      if (
        session.mode === "p2p" &&
        s.identity &&
        s.privateKey &&
        session.status === "active"
      ) {
        const device = s.devices.find((d) => d.id === deviceId);
        if (device && isLivePeer(device) && device.authSecret) {
          void wireStopScreenShare({
            device,
            identity: s.identity,
            privateKey: s.privateKey,
            sessionId: session.sessionId,
            reason: "viewer_stopped",
          });
        }
      }

      set((st) => {
        const next = { ...st.screenSessions };
        const cur = next[deviceId];
        if (cur) {
          next[deviceId] = {
            ...cur,
            status: "ended",
            updatedAt: Date.now(),
            lastFrameDataUrl: undefined,
          };
        }
        return { ...st, screenSessions: next };
      });
    },
    ingestScreenFrame: (deviceId, frame) => {
      const dataUrl =
        frame.dataUrl ??
        (frame.dataBase64
          ? base64ToDataUrl(frame.mimeType, frame.dataBase64)
          : undefined);
      if (!dataUrl) return;
      const now = Date.now();
      set((st) => {
        let key = deviceId;
        let cur = st.screenSessions[deviceId];
        if (!cur || cur.sessionId !== frame.sessionId) {
          const found = Object.entries(st.screenSessions).find(
            ([, s]) => s.sessionId === frame.sessionId,
          );
          if (found) {
            key = found[0];
            cur = found[1];
          } else {
            // First frame may arrive in a mirror window before session state syncs
            cur = {
              sessionId: frame.sessionId,
              deviceId,
              role: "viewer",
              status: "active",
              mode: "p2p",
              fps: 0,
              frameCount: 0,
              startedAt: now,
              updatedAt: now,
            };
          }
        }
        const elapsed = Math.max(1, now - cur.startedAt);
        const frameCount = (cur.frameCount ?? 0) + 1;
        const fps = frameCount / (elapsed / 1000);
        return {
          ...st,
          screenSessions: {
            ...st.screenSessions,
            [key]: {
              ...cur,
              status: "active",
              lastFrameDataUrl: dataUrl,
              lastFrameAt: now,
              width: frame.width,
              height: frame.height,
              frameCount,
              fps: Math.round(fps * 10) / 10,
              updatedAt: now,
            },
          },
        };
      });
    },
    applyScreenSessions: (sessions) => {
      set((st) => ({ ...st, screenSessions: { ...sessions } }));
    },
    setTailscaleStatus: (status) => {
      set((st) => ({ ...st, tailscaleStatus: status }));
    },
    refreshDiscovery: async () => {
      const s0 = getState();
      if (!s0.settings.discoveryEnabled) {
        notify(set, "Network discovery is disabled in Settings", "info");
        return;
      }
      const now = Date.now();
      const port = s0.settings.peerListenPort ?? LYRA_DEFAULT_PORT;

      // 1) LocalSend-style: fire UDP announce burst so peers reply
      try {
        discoveryAnnouncer?.();
      } catch {
        // ignore
      }

      // 2) Re-probe known devices across LAN + Tailscale + port fallbacks.
      //    Previously only d.host:port was tried — stale LAN IPs marked everyone offline
      //    even when Tailscale still worked (common mobile/desktop asymmetry).
      const probeTargets = s0.devices.filter(
        (d) => Boolean(d.host || d.tailscaleHost) && !d.id.startsWith("demo_"),
      );
      if (probeTargets.length > 0) {
        const concurrency = 6;
        let cursor = 0;
        const results = new Map<string, ProbeResult>();

        async function worker() {
          while (cursor < probeTargets.length) {
            const i = cursor++;
            const device = probeTargets[i]!;
            const result = await probeDeviceCandidates(device, { timeoutMs: 1400 });
            results.set(device.id, result);
          }
        }

        await Promise.all(
          Array.from(
            { length: Math.min(concurrency, probeTargets.length) },
            () => worker(),
          ),
        );

        set((st) => ({
          ...st,
          devices: st.devices.map((d) => {
            const result = results.get(d.id);
            if (!result) return d;
            return applyProbeToDevice(d, result, now);
          }),
        }));
      }

      // 3) LocalSend HttpScanDiscovery: walk local /24 for /lyra/info
      //    Known devices are already multi-endpoint probed above — only expand
      //    a few seed /24s so mobile does not walk thousands of hosts.
      //    Note: Tailscale CGNAT is /10 — expanding only a /24 of our 100.x IP
      //    will miss peers on other 100.x.y segments (common). For 100.x seeds we
      //    do NOT expand; we only probe exact known hosts (paired / hints).
      const seeds = new Set<string>();
      const exactOnly = new Set<string>(); // never expand these to /24
      const lan = localLanHostFromState(getState()) ?? getState().localLanHint;
      const slash24Seen = new Set<string>();
      const considerSeed = (raw: string | null | undefined, expand: boolean) => {
        const h = raw?.trim();
        if (!h) return;
        if (!expand || isLikelyTailscaleHost(h)) {
          exactOnly.add(h);
          seeds.add(h);
          return;
        }
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
        if (m) {
          const key = `${m[1]}.${m[2]}.${m[3]}`;
          if (slash24Seen.has(key)) return;
          if (slash24Seen.size >= 3) return;
          slash24Seen.add(key);
        }
        seeds.add(h);
      };
      // Prefer Wi‑Fi-looking seeds for /24 expansion when possible
      considerSeed(lan, true);
      for (const d of getState().devices) {
        considerSeed(d.host, true);
        considerSeed(d.tailscaleHost, false);
        considerSeed(d.lastReachableHost, !isLikelyTailscaleHost(d.lastReachableHost ?? ""));
      }
      for (const h of getState().tailscalePeerHints) {
        considerSeed(h.host, false);
      }
      // Common home/lab prefixes when we have no local IP yet (browser)
      if (seeds.size === 0) {
        for (const guess of ["192.168.0.1", "192.168.1.1", "10.0.0.1"]) seeds.add(guess);
      }

      // Multi-port scan: settings port + default + one common variant offset
      const scanPorts = [
        ...new Set(
          [port, LYRA_DEFAULT_PORT, port + 2, 53327].filter((p) => p > 0 && p <= 65535),
        ),
      ].slice(0, 3);

      let scannedNew = 0;
      try {
        // Never HTTP-probe our own peer server — aborted self-scans race native
        // TCP write/destroy and crash Android (No socket with id).
        const skipEndpoints: Array<{ host: string; port?: number }> = [];
        const ownHost = localLanHostFromState(getState()) ?? getState().localLanHint;
        const ownPort = getState().peerServer.port ?? port;
        if (ownHost) skipEndpoints.push({ host: ownHost, port: ownPort ?? port });
        skipEndpoints.push({ host: "127.0.0.1", port: ownPort ?? port });
        skipEndpoints.push({ host: "localhost", port: ownPort ?? port });

        const found = await scanLanForPeers({
          seedHosts: [...seeds],
          ports: scanPorts,
          port,
          timeoutMs: 700,
          concurrency: 40,
          localDeviceId: s0.identity?.id,
          skipEndpoints,
        });
        for (const peer of found) {
          const before = getState().devices.length;
          // ingestDiscoveredPeer is defined on the same store object (called at runtime)
          // eslint-disable-next-line @typescript-eslint/no-use-before-define
          (store as LyraStore).ingestDiscoveredPeer({
            identity: {
              id: peer.identity.id,
              name: peer.identity.name,
              type: peer.identity.type as PairedDevice["type"],
              platform: peer.identity.platform as PairedDevice["platform"],
              fingerprint: peer.identity.fingerprint,
              publicKey: peer.identity.publicKey,
            },
            host: peer.host,
            port: peer.port,
          });
          if (getState().devices.length > before) scannedNew++;
          else {
            // Refresh existing — preserve distinct LAN vs Tailscale addresses
            set((st) => ({
              ...st,
              devices: st.devices.map((d) => {
                const match =
                  d.id === peer.identity.id ||
                  d.fingerprint === peer.identity.fingerprint ||
                  (d.host === peer.host && (d.port ?? port) === peer.port) ||
                  d.tailscaleHost === peer.host;
                if (!match) return d;
                return applyProbeToDevice(
                  {
                    ...d,
                    name: d.nickname ? d.name : peer.identity.name || d.name,
                    fingerprint: peer.identity.fingerprint || d.fingerprint,
                    publicKey: peer.identity.publicKey || d.publicKey,
                    platform:
                      (peer.identity.platform as PairedDevice["platform"]) || d.platform,
                  },
                  {
                    ok: true,
                    host: peer.host,
                    port: peer.port,
                    online: true,
                    latencyMs: 0,
                    deviceId: peer.identity.id,
                    name: peer.identity.name,
                    fingerprint: peer.identity.fingerprint,
                    platform: peer.identity.platform,
                    connectionHint: isLikelyTailscaleHost(peer.host)
                      ? "tailscale"
                      : "local",
                  },
                  Date.now(),
                );
              }),
            }));
          }
        }
      } catch {
        // scan best-effort
      }

      persist();
      // Re-check mutual trust for paired peers (detect remote unpair)
      try {
        await store.recheckPairedTrust();
      } catch {
        // best-effort
      }
      const online = getState().devices.filter((d) => d.online).length;
      const nearby = getState().devices.filter((d) => !d.authSecret).length;
      set((st) => ({
        ...st,
        lastProbeSummary: `LAN scan · ${online} online · ${nearby} nearby · +${scannedNew} new`,
      }));
      notify(
        set,
        scannedNew > 0
          ? `Found ${scannedNew} nearby device(s) — Pair to trust`
          : `Discovery refreshed · ${online} online · ${nearby} nearby`,
        scannedNew > 0 ? "success" : "info",
      );
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
      // Desktop shell may inject MagicDNS peers via ingestTailscalePeers before this runs
      const candidates = s.devices.filter((d) => {
        const host = resolveDeviceHost(d);
        return (
          Boolean(d.tailscaleHost) ||
          (host && isLikelyTailscaleHost(host)) ||
          d.connectionType === "tailscale" ||
          d.connectionType === "both"
        );
      });
      // Also probe raw hints not yet saved as devices
      const hintTargets = s.tailscalePeerHints.filter(
        (h) =>
          h.host &&
          !candidates.some(
            (d) => d.host === h.host || d.tailscaleHost === h.host,
          ),
      );
      if (candidates.length === 0 && hintTargets.length === 0) {
        notify(
          set,
          "No Tailscale peers — add a 100.x / *.ts.net address, or Scan Tailscale",
          "info",
        );
        return [];
      }
      const basePort = s.settings.peerListenPort ?? LYRA_DEFAULT_PORT;
      // Prefer stored port, then common fallbacks (EADDRINUSE port steal on multi-instance)
      const portFallbacks = (preferred?: number) => {
        const set = new Set<number>([
          preferred && preferred > 0 ? preferred : basePort,
          basePort,
          basePort + 2,
          basePort + 4,
          basePort + 10,
          LYRA_DEFAULT_PORT,
        ]);
        return [...set];
      };

      type Target = { host: string; ports: number[]; deviceId: string | null };
      const probeList: Target[] = [
        ...candidates.map((d) => ({
          host: d.tailscaleHost || resolveDeviceHost(d) || d.host!,
          ports: portFallbacks(d.port),
          deviceId: d.id as string | null,
        })),
        ...hintTargets.map((h) => ({
          host: h.host,
          ports: portFallbacks(h.port),
          deviceId: null as string | null,
        })),
      ];

      const results: ProbeResult[] = [];
      const now = Date.now();
      for (const target of probeList) {
        let best: ProbeResult | null = null;
        for (const port of target.ports) {
          const r = await probePeer(
            { host: target.host, port },
            { timeoutMs: 1800, preferTailscale: true },
          );
          if (r.ok) {
            best = r;
            break;
          }
          best = r;
        }
        results.push(best!);
        // Promote working port onto the device / hint
        if (best?.ok) {
          if (target.deviceId) {
            set((st) => ({
              ...st,
              devices: st.devices.map((d) =>
                d.id === target.deviceId
                  ? applyProbeToDevice(
                      {
                        ...d,
                        port: best!.port,
                        tailscaleHost: d.tailscaleHost || target.host,
                      },
                      best!,
                      now,
                    )
                  : d,
              ),
            }));
          } else {
            // Auto-add reachable Tailscale peers as nearby
            const exists = getState().devices.some(
              (d) =>
                (d.host === best!.host || d.tailscaleHost === best!.host) &&
                (d.port ?? LYRA_DEFAULT_PORT) === best!.port,
            );
            if (!exists) {
              store.addManualPeer({
                host: best.host,
                port: best.port,
                name: best.name,
                asTailscale: true,
              });
              // Re-apply online/identity from probe
              set((st) => ({
                ...st,
                devices: st.devices.map((d) =>
                  d.host === best!.host && (d.port ?? LYRA_DEFAULT_PORT) === best!.port
                    ? applyProbeToDevice(d, best!, now)
                    : d,
                ),
              }));
            }
          }
        } else if (target.deviceId) {
          set((st) => ({
            ...st,
            devices: st.devices.map((d) =>
              d.id === target.deviceId ? applyProbeToDevice(d, best!, now) : d,
            ),
          }));
        }
      }

      set((st) => ({
        ...st,
        lastProbeSummary: `Tailscale probe · ${results.filter((r) => r.ok).length}/${results.length} up`,
      }));
      persist();
      const up = results.filter((r) => r.ok).length;
      notify(set, `Tailscale probe: ${up}/${results.length} reachable`, up > 0 ? "success" : "info");
      return results;
    },
    ingestTailscalePeers: (peers) => {
      const s = getState();
      if (!s.identity) return 0;
      let added = 0;
      const port = s.settings.peerListenPort ?? LYRA_DEFAULT_PORT;
      const now = Date.now();
      // Always surface hints in UI even when already device-mapped
      set((st) => ({
        ...st,
        tailscalePeerHints: peers
          .filter((p) => p.host?.trim())
          .map((p) => ({
            host: p.host!.trim(),
            port: p.port ?? port,
            name: p.name,
            online: p.online,
            tailscaleIp: isLikelyTailscaleHost(p.host!.trim()) ? p.host!.trim() : undefined,
          })),
      }));
      for (const p of peers) {
        const host = p.host?.trim();
        if (!host) continue;
        const exists = s.devices.some(
          (d) =>
            (d.host === host || d.tailscaleHost === host) &&
            (d.port ?? port) === (p.port ?? port),
        );
        if (exists) {
          // Refresh reachability for existing nearby/trusted entries
          set((st) => ({
            ...st,
            devices: st.devices.map((d) =>
              d.host === host || d.tailscaleHost === host
                ? {
                    ...d,
                    online: p.online !== false,
                    lastSeenAt: now,
                    tailscaleHost: d.tailscaleHost || (isLikelyTailscaleHost(host) ? host : d.tailscaleHost),
                    host: d.host || host,
                    connectionType:
                      d.connectionType === "local" || d.connectionType === "manual"
                        ? "both"
                        : d.connectionType === "tailscale"
                          ? "tailscale"
                          : d.connectionType,
                  }
                : d,
            ),
          }));
          continue;
        }
        // Nearby only — not trusted until Pair
        const device: PairedDevice = {
          id: generateId("ts"),
          name: (p.name || host).slice(0, 64),
          type: "desktop",
          platform: "unknown",
          fingerprint: generateId("fp").replace("fp_", "").slice(0, 32),
          publicKey: generateId("pub"),
          pairedAt: now,
          lastSeenAt: now,
          online: p.online !== false,
          connectionType: "tailscale",
          autoAcceptTransfers: s.settings.autoAcceptTransfers,
          autoAcceptClipboard: s.settings.autoAcceptClipboard,
          showInMainList: false,
          host,
          tailscaleHost: isLikelyTailscaleHost(host) ? host : undefined,
          preferredAddress: "tailscale",
          port: p.port ?? port,
        };
        set((st) => ({ ...st, devices: [device, ...st.devices] }));
        added++;
      }
      if (added > 0) {
        persist();
        notify(set, `Found ${added} Tailscale peer(s) nearby — Pair to trust`, "info");
      }
      return added;
    },
    ingestDiscoveredPeer: (announce) => {
      const s = getState();
      if (!s.identity) return;
      if (!s.settings.discoveryEnabled) return;
      if (announce.identity.id === s.identity.id) return;
      const host = announce.host?.trim();
      if (!host) return;
      const port = announce.port || s.settings.peerListenPort || LYRA_DEFAULT_PORT;
      const now = Date.now();

      // Cache multicast pairing offers for fast code lookup
      if (
        announce.pairing &&
        announce.pairing.expiresAt > now &&
        announce.pairing.codeHash &&
        announce.pairing.token
      ) {
        const offer = {
          codeHash: announce.pairing.codeHash,
          token: announce.pairing.token,
          expiresAt: announce.pairing.expiresAt,
          host,
          port,
          deviceId: announce.identity.id,
          name: announce.identity.name || host,
          fingerprint: announce.identity.fingerprint,
          publicKey: announce.identity.publicKey || announce.identity.fingerprint,
          type: announce.identity.type,
          platform: announce.identity.platform,
          seenAt: now,
        };
        set((st) => ({
          ...st,
          lanPairingOffers: [
            offer,
            ...st.lanPairingOffers.filter(
              (o) =>
                o.deviceId !== offer.deviceId &&
                o.codeHash !== offer.codeHash &&
                o.expiresAt > now,
            ),
          ].slice(0, 20),
        }));
        console.info(
          "[lyra pair] cached multicast pairing offer from",
          offer.name,
          offer.host,
          offer.codeHash.slice(0, 12),
        );
      }

      // Update existing trusted peer reachability
      const trusted = s.devices.find(
        (d) =>
          d.authSecret &&
          (d.id === announce.identity.id || d.fingerprint === announce.identity.fingerprint),
      );
      if (trusted) {
        set((st) => ({
          ...st,
          devices: st.devices.map((d) =>
            d.id === trusted.id
              ? {
                  ...applyReachableEndpoint(
                    {
                      ...d,
                      name: d.nickname ? d.name : announce.identity.name || d.name,
                    },
                    { host, port, protocol: "http" },
                  ),
                  online: true,
                  lastSeenAt: now,
                }
              : d,
          ),
        }));
        return;
      }

      // Match existing nearby by device id / host
      const existing = s.devices.find(
        (d) =>
          d.id === announce.identity.id ||
          d.fingerprint === announce.identity.fingerprint ||
          (d.host === host && (d.port ?? LYRA_DEFAULT_PORT) === port) ||
          d.tailscaleHost === host,
      );
      if (existing) {
        set((st) => ({
          ...st,
          devices: st.devices.map((d) =>
            d.id === existing.id
              ? {
                  ...applyReachableEndpoint(
                    {
                      ...d,
                      // Prefer real peer identity id once discovered (unless already trusted under another id)
                      id: d.authSecret ? d.id : announce.identity.id,
                      name: announce.identity.name || d.name,
                      type: announce.identity.type ?? d.type,
                      platform: announce.identity.platform ?? d.platform,
                      fingerprint: announce.identity.fingerprint || d.fingerprint,
                      publicKey: announce.identity.publicKey || d.publicKey,
                      showInMainList: d.authSecret ? d.showInMainList : false,
                    },
                    { host, port, protocol: "http" },
                  ),
                  online: true,
                  lastSeenAt: now,
                }
              : d,
          ),
        }));
        return;
      }

      const isTs = isLikelyTailscaleHost(host);
      const device: PairedDevice = {
        id: announce.identity.id,
        name: announce.identity.name || host,
        type: announce.identity.type ?? "desktop",
        platform: announce.identity.platform ?? "unknown",
        fingerprint: announce.identity.fingerprint,
        publicKey: announce.identity.publicKey || generateId("pub"),
        pairedAt: now,
        lastSeenAt: now,
        online: true,
        connectionType: isTs ? "tailscale" : "local",
        autoAcceptTransfers: s.settings.autoAcceptTransfers,
        autoAcceptClipboard: s.settings.autoAcceptClipboard,
        showInMainList: false,
        host,
        port,
        tailscaleHost: isTs ? host : undefined,
        preferredAddress: isTs ? "tailscale" : "auto",
      };
      set((st) => ({ ...st, devices: [device, ...st.devices] }));
      // Quiet ingest — no toast spam on every announce
    },
    recordReceivedTransfer: (input) => {
      const now = Date.now();
      const totalBytes =
        input.receivedBytes || input.files.reduce((a, f) => a + (f.size || 0), 0);
      const tx: Transfer = {
        id: input.transferId || generateId("tx"),
        direction: "received",
        deviceId: input.deviceId || "unknown",
        deviceName: input.deviceName || "Peer",
        files: input.files.map((f) => ({ name: f.name, size: f.size })),
        totalBytes,
        transferredBytes: totalBytes,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        overWire: true,
      };
      set((st) => ({
        ...st,
        transfers: [tx, ...st.transfers.filter((t) => t.id !== tx.id)],
      }));
      persist();
      const where =
        input.savedPaths?.[0] != null
          ? ` → ${input.savedPaths.length === 1 ? input.savedPaths[0] : `${input.savedPaths.length} files`}`
          : "";
      notify(set, `Received ${input.files.map((f) => f.name).join(", ")}${where}`, "success");
    },
    trustDevice: async (deviceId) => {
      const s = getState();
      const device = s.devices.find((d) => d.id === deviceId);
      if (!device || !s.identity || !s.privateKey) {
        return { ok: false as const, error: "Device not ready" };
      }
      if (!resolveDeviceHost(device)) {
        return { ok: false as const, error: "Device has no host" };
      }
      if (device.authSecret) {
        notify(set, "Already trusted", "info");
        return { ok: true as const };
      }
      const token = generateId("tok");
      const localHost = localLanHostFromState(s) ?? s.localLanHint ?? undefined;
      const localPort = s.peerServer.port ?? s.settings.peerListenPort;
      notify(set, `Waiting for ${device.name} to accept pairing…`, "info");
      const res = await wireTrustHandshake({
        device,
        identity: s.identity,
        privateKey: s.privateKey,
        pairingToken: token,
        localHost: localHost ?? undefined,
        localPort: localPort ?? undefined,
      });
      if (!res.ok) {
        notify(set, `Trust failed: ${res.error}`, "error");
        return res;
      }
      const remote = res.remote;
      const reachHost = res.host || resolveDeviceHost(device) || device.host;
      const reachPort = res.port ?? device.port ?? s.settings.peerListenPort ?? LYRA_DEFAULT_PORT;
      const isTs =
        Boolean(device.tailscaleHost) ||
        device.connectionType === "tailscale" ||
        (reachHost ? isLikelyTailscaleHost(reachHost) : false);
      set((st) => ({
        ...st,
        devices: st.devices
          .filter((d) => {
            // Drop duplicate nearby entries that match the real remote id
            if (d.id === deviceId) return true;
            if (d.id === remote.id) return false;
            if (d.fingerprint === remote.fingerprint) return false;
            return true;
          })
          .map((d) =>
            d.id === deviceId
              ? {
                  ...d,
                  // Promote manual_* id to the peer's real identity id
                  id: remote.id,
                  authSecret: res.authSecret,
                  fingerprint: remote.fingerprint || d.fingerprint,
                  publicKey: remote.publicKey || d.publicKey,
                  name: d.nickname ? d.name : remote.name || d.name,
                  type: remote.type || d.type,
                  platform: (remote.platform as PairedDevice["platform"]) || d.platform,
                  host: isTs && device.tailscaleHost ? device.host || reachHost : reachHost,
                  port: reachPort,
                  tailscaleHost:
                    device.tailscaleHost ||
                    (isTs && reachHost ? reachHost : d.tailscaleHost),
                  preferredAddress: isTs ? "tailscale" : d.preferredAddress ?? "auto",
                  connectionType: isTs
                    ? device.host && device.tailscaleHost
                      ? "both"
                      : "tailscale"
                    : d.connectionType === "manual"
                      ? "local"
                      : d.connectionType,
                  online: true,
                  lastSeenAt: Date.now(),
                  showInMainList: true,
                  status: d.status
                    ? { ...d.status, deviceId: remote.id }
                    : d.status,
                }
              : d,
          ),
      }));
      persist();
      notify(set, `Paired with ${remote.name || device.name}`, "success");
      return { ok: true as const };
    },
    applyRemoteStatus: (deviceId, status) => {
      set((s) => ({
        ...s,
        devices: s.devices.map((d) =>
          d.id === deviceId
            ? {
                ...d,
                status: { ...status, deviceId },
                lastSeenAt: status.updatedAt || Date.now(),
                online: true,
              }
            : d,
        ),
      }));
    },
    downloadRemoteFile: async (deviceId, path) => {
      const s = getState();
      const device = s.devices.find((d) => d.id === deviceId);
      if (!device || !s.identity || !s.privateKey) {
        return { ok: false as const, error: "Not ready" };
      }
      if (!isLivePeer(device) || !device.authSecret) {
        return { ok: false as const, error: "Peer not trusted / no host" };
      }
      return wireReadRemoteFile({
        device,
        identity: s.identity,
        privateKey: s.privateKey,
        path,
      });
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
    setLocalLanHint: (host) => {
      const cleaned = host?.trim() || null;
      set((s) => ({ ...s, localLanHint: cleaned }));
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
      const live = s.devices.filter((d) => targets.includes(d.id) && isLivePeer(d) && d.authSecret);
      const item: ClipboardItem = {
        id: generateId("clip"),
        type: "text",
        text: text.trim(),
        sourceDeviceId: s.identity.id,
        sourceDeviceName: s.identity.name,
        createdAt: Date.now(),
        pinned: false,
        deliveryStatus: live.length > 0 ? "sending" : targets.length > 0 ? "failed" : "local",
        deliveryError:
          live.length === 0 && targets.length > 0
            ? "No reachable paired peer"
            : undefined,
        deliveredTo: [],
      };
      set((st) => ({
        ...st,
        localClipboardText: text.trim(),
        clipboardHistory: trimClipboardHistory([item, ...st.clipboardHistory], st.settings),
      }));
      persist();

      if (live.length === 0) {
        notify(
          set,
          targets.length > 0
            ? "Saved to history — no reachable paired peer (check host/Tailscale)"
            : "Saved to clipboard history",
          targets.length > 0 ? "info" : "success",
        );
        return;
      }

      notify(
        set,
        `Sending clipboard to ${live.length} device${live.length === 1 ? "" : "s"}…`,
        "info",
      );

      void (async () => {
        let okCount = 0;
        const deliveredTo: string[] = [];
        let lastError: string | undefined;
        for (const device of live) {
          // Use freshest device record (host may update mid-flight)
          const current =
            getState().devices.find((d) => d.id === device.id) ?? device;
          const res = await wirePushClipboard({
            device: current,
            identity: s.identity!,
            privateKey: s.privateKey!,
            item,
          });
          if (res.ok) {
            okCount++;
            deliveredTo.push(device.id);
            if (res.endpoint) {
              set((st) => ({
                ...st,
                devices: st.devices.map((d) =>
                  d.id === device.id ? applyReachableEndpoint(d, res.endpoint!) : d,
                ),
              }));
            }
          } else {
            lastError = res.error;
            notify(
              set,
              `Clipboard to ${device.nickname || device.name} failed: ${res.error}`,
              "error",
            );
          }
        }
        set((st) => ({
          ...st,
          clipboardHistory: st.clipboardHistory.map((c) =>
            c.id === item.id
              ? {
                  ...c,
                  deliveryStatus: okCount > 0 ? ("sent" as const) : ("failed" as const),
                  deliveryError: okCount > 0 ? undefined : lastError,
                  deliveredTo,
                }
              : c,
          ),
        }));
        persist();
        if (okCount > 0) {
          notify(
            set,
            `Clipboard sent to ${okCount} device${okCount === 1 ? "" : "s"} (wire)`,
            "success",
          );
        } else if (live.length > 0) {
          notify(set, "Clipboard could not reach any peer", "error");
        }
      })();
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
      if (live.length === 0) {
        notify(
          set,
          targets.length > 0
            ? "Image saved — no reachable paired peer"
            : "Image saved to history",
          targets.length > 0 ? "info" : "success",
        );
        return;
      }
      notify(set, `Sending image to ${live.length} device(s)…`, "info");
      void (async () => {
        let okCount = 0;
        for (const device of live) {
          const res = await wirePushClipboard({
            device,
            identity: s.identity!,
            privateKey: s.privateKey!,
            item,
          });
          if (res.ok) {
            okCount++;
            if (res.endpoint) {
              set((st) => ({
                ...st,
                devices: st.devices.map((d) =>
                  d.id === device.id ? applyReachableEndpoint(d, res.endpoint!) : d,
                ),
              }));
            }
          } else {
            notify(set, `Image to ${device.nickname || device.name} failed: ${res.error}`, "error");
          }
        }
        persist();
        if (okCount > 0) {
          notify(set, `Image clipboard sent to ${okCount} device(s)`, "success");
        }
      })();
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
            relativePath: f.relativePath,
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
          if (!device.authSecret) {
            set((st) => ({
              ...st,
              transfers: st.transfers.map((t) =>
                t.id === tx.id
                  ? {
                      ...t,
                      status: "failed" as const,
                      error: "Device is not paired (no shared secret)",
                      updatedAt: Date.now(),
                    }
                  : t,
              ),
            }));
            persist();
            notify(set, "Pair the device before transferring files", "error");
            continue;
          }
          if (files.some((f) => !f.bytes || f.bytes.byteLength === 0)) {
            set((st) => ({
              ...st,
              transfers: st.transfers.map((t) =>
                t.id === tx.id
                  ? {
                      ...t,
                      status: "failed" as const,
                      error: "Could not read file bytes for wire transfer",
                      updatedAt: Date.now(),
                    }
                  : t,
              ),
            }));
            persist();
            notify(set, "Transfer failed: file contents could not be read", "error");
            continue;
          }
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
            if (res.endpoint) {
              set((st) => ({
                ...st,
                devices: st.devices.map((d) =>
                  d.id === device.id ? applyReachableEndpoint(d, res.endpoint!) : d,
                ),
              }));
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
    applyPairingPayload: async (raw) => {
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

      // Live host: same path as code entry — request + wait for host Accept
      if (payload.host && payload.token) {
        const hostName = payload.name || "device";
        set((st) => ({
          ...st,
          outboundPairing: {
            code: "",
            token: payload.token,
            hostName,
            host: payload.host!,
            port: payload.port ?? LYRA_DEFAULT_PORT,
            startedAt: Date.now(),
            status: "waiting",
          },
        }));
        notify(set, `Waiting for ${hostName} to accept…`, "info");

        const localHost = localLanHostFromState(getState());
        const localPort = getState().peerServer.port ?? getState().settings.peerListenPort;
        const wire = await wireSendPairRequest({
          host: payload.host,
          port: payload.port,
          identity: s.identity,
          payload: {
            version: 1,
            deviceId: s.identity.id,
            name: s.identity.name,
            type: s.identity.type,
            platform: s.identity.platform,
            fingerprint: s.identity.fingerprint,
            publicKey: s.identity.publicKey,
            token: payload.token,
            host: localHost,
            port: localPort,
            expiresAt: payload.expiresAt,
          },
          waitForConfirmMs: 120_000,
        });

        if (!wire.ok) {
          set((st) => ({ ...st, outboundPairing: null }));
          notify(set, wire.error, "error");
          return { ok: false as const, error: wire.error };
        }

        const env = wire.envelope;
        if (!env || env.type === "pair_reject") {
          const reason =
            env && env.type === "pair_reject"
              ? String((env.payload as { reason?: string })?.reason ?? "rejected")
              : "Pairing declined";
          set((st) => ({ ...st, outboundPairing: null }));
          notify(set, `Pairing declined: ${reason}`, "error");
          return { ok: false as const, error: reason };
        }

        if (env.type === "pair_confirm") {
          const confirm = env.payload as {
            identity?: DeviceIdentity;
            token?: string;
            publicKey?: string;
            host?: string;
            port?: number;
          };
          const remote = confirm.identity ?? {
            id: payload.deviceId,
            name: payload.name,
            type: payload.type,
            platform: payload.platform,
            fingerprint: payload.fingerprint,
            publicKey: payload.publicKey,
            createdAt: Date.now(),
          };
          const device = await finalizePairDevice(set, getState, persist, {
            payload: {
              version: 1,
              deviceId: remote.id,
              name: remote.name,
              type: remote.type,
              platform: remote.platform,
              fingerprint: remote.fingerprint,
              publicKey: confirm.publicKey || remote.publicKey,
              token: confirm.token || payload.token,
              host: confirm.host || payload.host,
              port: confirm.port || payload.port,
              expiresAt: payload.expiresAt,
            },
            source: "scan",
            notifyRemote: false,
          });
          if (!device) return { ok: false as const, error: "Could not complete pairing" };
          notify(set, `Paired with ${device.name}`, "success");
          return { ok: true as const, device };
        }
      }

      // Offline / no host in QR: queue for local confirm (demo / air-gapped)
      const requestId = generateId("inpair");
      const request: IncomingPairingRequest = {
        id: requestId,
        receivedAt: Date.now(),
        source: "scan",
        payload,
      };
      set((st) => ({
        ...st,
        incomingPairRequests: [
          request,
          ...st.incomingPairRequests.filter((r) => r.payload.deviceId !== payload.deviceId),
        ],
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
