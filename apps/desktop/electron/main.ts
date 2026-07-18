/**
 * Lyra desktop shell (Electron).
 * Hosts the local HTTP peer server + UDP multicast discovery, and loads the web UI.
 */
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeviceIdentity } from "@lyra-sync-app/core";
import { startDiscovery, startPeerServer } from "@lyra-sync-app/net/node";
import type { DeviceIdentity } from "@lyra-sync-app/protocol";
import { LYRA_DEFAULT_PORT } from "@lyra-sync-app/protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB_DEV_URL = process.env.LYRA_WEB_URL ?? "http://localhost:3001";
const PEER_PORT = Number(process.env.LYRA_PORT ?? LYRA_DEFAULT_PORT);

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
    platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    type: "desktop",
  });
  if (!created.ok) throw created.error;
  identity = created.identity;
  privateKey = created.privateKey;
  status.identity = identity;

  // Prefer OS secure storage for private key when available
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const enc = safeStorage.encryptString(privateKey);
      // Persist path reserved for future; key held in memory for session
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
      onEnvelope: async (envelope) => {
        // Forward interesting events to renderer later
        mainWindow?.webContents.send("lyra:envelope", {
          type: envelope.type,
          fromDeviceId: envelope.fromDeviceId,
        });
        if (envelope.type === "ping") {
          return {
            id: `env_pong_${Date.now()}`,
            type: "pong",
            fromDeviceId: identity!.id,
            toDeviceId: envelope.fromDeviceId,
            timestamp: Date.now(),
            payload: { ok: true },
          };
        }
        return { ok: true };
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
    void mainWindow.loadFile(path.join(__dirname, "../../web/dist/index.html"));
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
