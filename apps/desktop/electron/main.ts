/**
 * Lyra desktop shell (Electron).
 * Hosts the local HTTP peer server + UDP multicast discovery, and loads the web UI.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
} from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

/** User-selected download directory (empty = system Downloads) */
let downloadDirectory: string | null = null;

function resolveDownloadDir(): string {
  if (downloadDirectory && existsSync(downloadDirectory)) return downloadDirectory;
  try {
    return app.getPath("downloads");
  } catch {
    return app.getPath("userData");
  }
}

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
        onTransferComplete: async (state) => {
          const destDir = resolveDownloadDir();
          try {
            mkdirSync(destDir, { recursive: true });
          } catch {
            // continue with best-effort write
          }
          const savedPaths: string[] = [];
          try {
            // Prefer disk-backed path; fall back to in-memory chunks
            let blob: Buffer | null = null;
            if (state.diskPath && existsSync(state.diskPath)) {
              blob = await readFile(state.diskPath);
            } else if (state.chunks?.length) {
              blob = Buffer.concat(state.chunks.map((c) => Buffer.from(c)));
            }
            if (blob && state.files.length > 0) {
              let offset = 0;
              for (const file of state.files) {
                const size = Math.min(file.size, Math.max(0, blob.length - offset));
                const safeName = path.basename(file.name).replace(/[^\w.\- ()[\]]+/g, "_") || "file";
                let dest = path.join(destDir, safeName);
                // Avoid overwrite: append counter
                let n = 1;
                while (existsSync(dest)) {
                  const ext = path.extname(safeName);
                  const base = path.basename(safeName, ext);
                  dest = path.join(destDir, `${base} (${n})${ext}`);
                  n++;
                }
                writeFileSync(dest, blob.subarray(offset, offset + size));
                savedPaths.push(dest);
                offset += size;
              }
            }
          } catch (e) {
            console.warn("[transfer] save failed", e instanceof Error ? e.message : e);
          }
          mainWindow?.webContents.send("lyra:transfer-complete", {
            transferId: state.transferId,
            receivedBytes: state.receivedBytes,
            files: state.files,
            diskPath: state.diskPath,
            savedPaths,
            downloadDir: destDir,
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

function resolvePackagedWebIndex(): string | null {
  const packagedWeb = path.join(process.resourcesPath, "web-dist", "index.html");
  if (existsSync(packagedWeb)) return packagedWeb;
  const devRelativeWeb = path.join(__dirname, "../../web/dist/index.html");
  if (existsSync(devRelativeWeb)) return devRelativeWeb;
  return null;
}

function installApplicationMenu() {
  // T3-style: no classic File/Edit/View chrome. Keep a minimal macOS app menu only.
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "Window",
          submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

function createWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Lyra",
    show: false,
    backgroundColor: "#0B0F17",
    // Merge window chrome with the app shell (sidebar drag region in renderer).
    autoHideMenuBar: true,
    titleBarStyle: isMac || isWin ? "hidden" : "default",
    ...(isMac
      ? {
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    ...(isWin
      ? {
          titleBarOverlay: {
            color: "#0B0F17",
            symbolColor: "#F5F7FF",
            height: 44,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Fallback if ready-to-show never fires (some Linux WMs)
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 2500);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[lyra] did-fail-load", { code, desc, url });
    void mainWindow?.webContents.executeJavaScript(
      `document.body.innerHTML = ${JSON.stringify(
        `<pre style="padding:24px;font:14px/1.4 ui-monospace,monospace;color:#f8fafc;background:#0B0F17">Lyra failed to load UI\n${desc} (${code})\n${url}</pre>`,
      )}`,
    );
    mainWindow?.show();
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    void mainWindow.loadURL(WEB_DEV_URL);
  } else {
    // Packaged: web UI is copied to resources/web-dist via electron-builder extraResources.
    // index.html must use relative asset paths (vite base: "./").
    const indexHtml = resolvePackagedWebIndex();
    if (!indexHtml) {
      console.error("[lyra] packaged web UI not found under resources/web-dist");
      void mainWindow.loadURL(
        `data:text/html,${encodeURIComponent(
          "<h1>Lyra</h1><p>Packaged web UI missing (resources/web-dist/index.html).</p>",
        )}`,
      );
    } else {
      console.log("[lyra] loading packaged UI", indexHtml);
      void mainWindow.loadFile(indexHtml);
    }
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Avoid stacking zombie instances when launched repeatedly from Gear Lever
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

app.whenReady().then(async () => {
  installApplicationMenu();

  ipcMain.handle("lyra:get-peer-status", () => ({
    running: status.running,
    port: status.port,
    url: status.url,
    discoveryActive: status.discoveryActive,
    lastError: status.lastError,
    updatedAt: Date.now(),
  }));

  ipcMain.handle("lyra:get-identity", () => status.identity);

  ipcMain.handle("lyra:get-shell-info", () => ({
    platform: process.platform,
    isDesktop: true,
    downloadDirectory: resolveDownloadDir(),
  }));

  ipcMain.handle("lyra:get-download-directory", () => resolveDownloadDir());

  ipcMain.handle("lyra:set-download-directory", (_e, dir: string | null) => {
    if (!dir) {
      downloadDirectory = null;
      return { ok: true as const, path: resolveDownloadDir() };
    }
    const trimmed = String(dir).trim();
    if (!trimmed) {
      downloadDirectory = null;
      return { ok: true as const, path: resolveDownloadDir() };
    }
    try {
      mkdirSync(trimmed, { recursive: true });
      downloadDirectory = trimmed;
      return { ok: true as const, path: downloadDirectory };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        path: resolveDownloadDir(),
      };
    }
  });

  ipcMain.handle("lyra:choose-download-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose download folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: resolveDownloadDir(),
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false as const, cancelled: true as const, path: resolveDownloadDir() };
    }
    downloadDirectory = result.filePaths[0];
    return { ok: true as const, path: downloadDirectory };
  });

  ipcMain.handle("lyra:open-path", async (_e, targetPath: string) => {
    if (!targetPath) return { ok: false as const };
    const err = await shell.openPath(targetPath);
    return { ok: !err, error: err || undefined };
  });

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

  // Show the window first so a peer-port conflict can't leave users with no UI.
  createWindow();
  void startNetworking().catch((e) => {
    console.error("[lyra] networking failed", e);
    status.lastError = e instanceof Error ? e.message : String(e);
    broadcastStatus();
  });

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
