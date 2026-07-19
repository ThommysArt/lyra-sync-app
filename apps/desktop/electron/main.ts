/**
 * Lyra desktop shell (Electron).
 * Hosts the local HTTP peer server + UDP multicast discovery, and loads the web UI.
 */
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeviceIdentity, hashPairingCode } from "@lyra-sync-app/core";
import {
  deleteOsPath,
  fetchTailscaleStatus,
  listOsFiles,
  readOsFileChunk,
  renameOsPath,
  startDiscovery,
  startPeerServer,
  tailscalePeersToProbeTargets,
} from "@lyra-sync-app/net/node";
import type { DeviceIdentity } from "@lyra-sync-app/protocol";
import { LYRA_DEFAULT_PORT } from "@lyra-sync-app/protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB_DEV_URL = process.env.LYRA_WEB_URL ?? "http://localhost:3001";
const PEER_PORT = Number(process.env.LYRA_PORT ?? LYRA_DEFAULT_PORT);
const USE_TLS = process.env.LYRA_TLS === "1" || process.env.LYRA_TLS === "true";

type TrustedPeer = {
  deviceId: string;
  fingerprint: string;
  publicKey?: string;
  authSecret: string;
};

type RuntimeStatus = {
  running: boolean;
  port: number | null;
  url: string | null;
  discoveryActive: boolean;
  lastError: string | null;
  identity: DeviceIdentity | null;
};

let mainWindow: BrowserWindow | null = null;
let peer: Awaited<ReturnType<typeof startPeerServer>> | null = null;
let discovery: Awaited<ReturnType<typeof startDiscovery>> | null = null;
let identity: DeviceIdentity | null = null;
let privateKey: string | null = null;

/** Trusted peers synced from renderer after pairing */
const trustedPeers = new Map<string, TrustedPeer>();

/** Active pairing session advertised on /lyra/info (code hash only) */
let pairingOffer: { codeHash: string; token: string; expiresAt: number } | null = null;

const status: RuntimeStatus = {
  running: false,
  port: null,
  url: null,
  discoveryActive: false,
  lastError: null,
  identity: null,
};

function broadcastStatus() {
  mainWindow?.webContents.send("lyra:peer-status", {
    running: status.running,
    port: status.port,
    url: status.url,
    discoveryActive: status.discoveryActive,
    lastError: status.lastError,
    updatedAt: Date.now(),
  });
}

async function ensureIdentity() {
  if (identity && privateKey) return;
  const created = await createDeviceIdentity({
    name: process.env.LYRA_NAME ?? "Lyra Desktop",
    platform:
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux",
    type: "desktop",
  });
  if (!created.ok) throw created.error;
  identity = created.identity;
  privateKey = created.privateKey;
  status.identity = identity;

  if (safeStorage.isEncryptionAvailable()) {
    try {
      // Persist encrypted private key for future cold start (session still holds plain key)
      const enc = safeStorage.encryptString(privateKey);
      // Reserved path: app.getPath('userData')/lyra-key.bin — write when packaging lands
      void enc;
    } catch {
      // keep in memory only
    }
  }
}

async function startNetworking() {
  await ensureIdentity();
  if (!identity) return;

  try {
    peer = await startPeerServer({
      identity,
      port: PEER_PORT,
      tls: USE_TLS,
      // Prefer paired shared secrets; allow first-contact only when no trust map hit
      allowFirstContactAuth: true,
      resolvePeerAuth: ({ deviceId, fingerprint }) => {
        const byId = trustedPeers.get(deviceId);
        if (byId) {
          return {
            sharedSecret: byId.authSecret,
            expectedFingerprint: byId.fingerprint,
            expectedDeviceId: byId.deviceId,
          };
        }
        for (const t of trustedPeers.values()) {
          if (t.fingerprint === fingerprint) {
            return {
              sharedSecret: t.authSecret,
              expectedFingerprint: t.fingerprint,
              expectedDeviceId: t.deviceId,
            };
          }
        }
        // First contact allowed for pairing handshake
        return {};
      },
      getPairingOffer: () => {
        if (!pairingOffer || pairingOffer.expiresAt < Date.now()) return null;
        return pairingOffer;
      },
      onEnvelope: async (envelope) => {
        mainWindow?.webContents.send("lyra:envelope", {
          type: envelope.type,
          fromDeviceId: envelope.fromDeviceId,
        });
        return undefined;
      },
      handlers: {
        onOpenUrl: (url) => {
          void shell.openExternal(url);
          return true;
        },
        onClipboardPush: (item) => {
          mainWindow?.webContents.send("lyra:clipboard-push", item);
        },
        onPairRequest: (payload) => {
          mainWindow?.webContents.send("lyra:pair-request", payload);
        },
        onUnpair: (deviceId) => {
          trustedPeers.delete(deviceId);
          mainWindow?.webContents.send("lyra:unpaired", { deviceId });
        },
        onFsList: async (fsPath) => {
          try {
            return await listOsFiles(fsPath);
          } catch (e) {
            console.warn("[fs_list]", e instanceof Error ? e.message : e);
            return [];
          }
        },
        onFsRead: (fsPath, offset, maxBytes) => readOsFileChunk(fsPath, offset, maxBytes),
        onFsDelete: (fsPath) => deleteOsPath(fsPath),
        onFsRename: (fsPath, newName) => renameOsPath(fsPath, newName),
        onTransferComplete: (state) => {
          mainWindow?.webContents.send("lyra:transfer-complete", {
            transferId: state.transferId,
            receivedBytes: state.receivedBytes,
            files: state.files,
            diskPath: state.diskPath,
          });
        },
      },
    });

    status.running = true;
    status.port = peer.port;
    status.url = peer.url;
    status.lastError = null;

    discovery = await startDiscovery({
      identity,
      peerPort: peer.port,
      onPeer: (announce) => {
        mainWindow?.webContents.send("lyra:discovered-peer", announce);
      },
    });
    status.discoveryActive = true;
    broadcastStatus();

    // Best-effort Tailscale MagicDNS peer discovery
    void fetchTailscaleStatus({ timeoutMs: 2500 }).then((ts) => {
      if (!ts.ok) return;
      const targets = tailscalePeersToProbeTargets(ts.peers, peer?.port ?? PEER_PORT);
      mainWindow?.webContents.send("lyra:tailscale-peers", targets);
    });
  } catch (e) {
    status.running = false;
    status.lastError = e instanceof Error ? e.message : String(e);
    broadcastStatus();
  }
}

async function stopNetworking() {
  await discovery?.stop();
  discovery = null;
  status.discoveryActive = false;
  await peer?.close();
  peer = null;
  status.running = false;
  status.port = null;
  status.url = null;
  broadcastStatus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Lyra",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    void mainWindow.loadURL(WEB_DEV_URL);
  } else {
    // Packaged: web UI is copied to resources/web-dist via electron-builder extraResources
    const packagedWeb = path.join(process.resourcesPath, "web-dist", "index.html");
    const devRelativeWeb = path.join(__dirname, "../../web/dist/index.html");
    void mainWindow.loadFile(existsSync(packagedWeb) ? packagedWeb : devRelativeWeb);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  ipcMain.handle("lyra:get-peer-status", () => ({
    running: status.running,
    port: status.port,
    url: status.url,
    discoveryActive: status.discoveryActive,
    lastError: status.lastError,
    updatedAt: Date.now(),
  }));

  ipcMain.handle("lyra:get-identity", () => status.identity);

  ipcMain.handle("lyra:restart-networking", async () => {
    await stopNetworking();
    await startNetworking();
    return {
      running: status.running,
      port: status.port,
      url: status.url,
      discoveryActive: status.discoveryActive,
      lastError: status.lastError,
      updatedAt: Date.now(),
    };
  });

  /** Sync trusted peers from renderer store after pair/unpair */
  ipcMain.handle(
    "lyra:sync-trusted-peers",
    (
      _e,
      peers: Array<{
        deviceId: string;
        fingerprint: string;
        publicKey?: string;
        authSecret: string;
      }>,
    ) => {
      trustedPeers.clear();
      for (const p of peers) {
        if (p.authSecret) {
          trustedPeers.set(p.deviceId, {
            deviceId: p.deviceId,
            fingerprint: p.fingerprint,
            publicKey: p.publicKey,
            authSecret: p.authSecret,
          });
        }
      }
      return { count: trustedPeers.size };
    },
  );

  ipcMain.handle(
    "lyra:set-pairing-offer",
    async (
      _e,
      offer: { code: string; token: string; expiresAt: number } | null,
    ) => {
      if (!offer) {
        pairingOffer = null;
        return { ok: true };
      }
      const codeHash = await hashPairingCode(offer.code);
      pairingOffer = {
        codeHash,
        token: offer.token,
        expiresAt: offer.expiresAt,
      };
      return { ok: true, codeHash };
    },
  );

  ipcMain.handle("lyra:revoke-device", (_e, deviceId: string) => {
    trustedPeers.delete(deviceId);
    const n = peer?.revokeDevice(deviceId) ?? 0;
    return { revokedSessions: n };
  });

  ipcMain.handle("lyra:quit", () => {
    app.quit();
  });

  ipcMain.handle("lyra:scan-tailscale", async () => {
    const ts = await fetchTailscaleStatus({ timeoutMs: 3000 });
    if (!ts.ok) return { ok: false as const, error: ts.error, peers: [] };
    const peers = tailscalePeersToProbeTargets(ts.peers, peer?.port ?? PEER_PORT);
    mainWindow?.webContents.send("lyra:tailscale-peers", peers);
    return { ok: true as const, peers, backendState: ts.backendState };
  });

  await startNetworking();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void stopNetworking();
});
