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
  nativeImage,
  safeStorage,
  shell,
  type NativeImage,
} from "electron";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Dev / CI Linux often lacks a setuid chrome-sandbox. Honor flag set by scripts/dev.ts.
if (
  process.env.ELECTRON_DISABLE_SANDBOX === "1" ||
  process.argv.includes("--no-sandbox")
) {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-setuid-sandbox");
}

// package.json name is the monorepo filter ("desktop"); show "Lyra" in the OS
// taskbar / dock / about menu instead.
app.setName("Lyra");
if (process.platform === "win32") {
  app.setAppUserModelId("app.lyra.desktop");
}
// Chromium on Linux looks up Icon= from the .desktop file named by CHROME_DESKTOP
// (must match StartupWMClass / our lyra.desktop entry).
if (process.platform === "linux") {
  process.env.CHROME_DESKTOP = "lyra.desktop";
}

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
  /** Non-loopback LAN IPv4 for pairing QR / candidates */
  lanHost: string | null;
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
  lanHost: null,
  discoveryActive: false,
  lastError: null,
  identity: null,
};

function broadcastStatus() {
  mainWindow?.webContents.send("lyra:peer-status", {
    running: status.running,
    port: status.port,
    url: status.url,
    lanHost: status.lanHost,
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

/**
 * Align peer-server identity with the renderer store so /lyra/info and
 * pair_confirm match what the UI thinks this device is.
 */
function adoptRendererIdentity(next: DeviceIdentity, nextPrivateKey?: string | null) {
  identity = next;
  if (nextPrivateKey) privateKey = nextPrivateKey;
  status.identity = identity;
  peer?.setIdentity(next);
  // Re-bind discovery announces with the same identity
  if (discovery && peer) {
    void discovery.stop().then(async () => {
      if (!identity || !peer) return;
      discovery = await startDiscovery({
        identity,
        peerPort: peer.port,
        advertiseHost: status.lanHost ?? peer.getLanHost() ?? undefined,
        getPairingOffer: () => {
          if (!pairingOffer || pairingOffer.expiresAt < Date.now()) return null;
          return pairingOffer;
        },
        onLog: (line) => console.log(line),
        onPeer: (announce) => {
          console.log(
            "[lyra] discovered peer",
            announce.identity?.name,
            announce.host,
            announce.port,
            announce.pairing ? `(pairing offer)` : "",
          );
          mainWindow?.webContents.send("lyra:discovered-peer", announce);
        },
      });
      status.discoveryActive = true;
      broadcastStatus();
    });
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
    status.lanHost = peer.getLanHost() ?? null;
    // Prefer a non-loopback URL in status for pairing candidates
    if (status.lanHost) {
      status.url = `${peer.protocol}://${status.lanHost}:${peer.port}`;
    }
    status.lastError = null;

    discovery = await startDiscovery({
      identity,
      peerPort: peer.port,
      advertiseHost: status.lanHost ?? undefined,
      getPairingOffer: () => {
        if (!pairingOffer || pairingOffer.expiresAt < Date.now()) return null;
        return pairingOffer;
      },
      onLog: (line) => console.log(line),
      onPeer: (announce) => {
        console.log(
          "[lyra] discovered peer",
          announce.identity?.name,
          announce.host,
          announce.port,
          announce.pairing ? `(pairing offer)` : "",
        );
        mainWindow?.webContents.send("lyra:discovered-peer", announce);
      },
    });
    status.discoveryActive = true;
    console.log(
      "[lyra] discovery active",
      discovery.localAddresses(),
      "multicast → peers on same LAN",
    );
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
  status.lanHost = null;
  broadcastStatus();
}

function resolvePackagedWebIndex(): string | null {
  const packagedWeb = path.join(process.resourcesPath, "web-dist", "index.html");
  if (existsSync(packagedWeb)) return packagedWeb;
  const devRelativeWeb = path.join(__dirname, "../../web/dist/index.html");
  if (existsSync(devRelativeWeb)) return devRelativeWeb;
  return null;
}

/** Prefer unpackaged icon path — Linux/Windows taskbars often fail on asar icons. */
function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath, "icon.png"),
    path.join(app.getAppPath(), "resources", "icon.png"),
    path.join(__dirname, "..", "resources", "icon.png"),
    path.join(__dirname, "..", "..", "resources", "icon.png"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Load the rounded app icon. Chromium may replace the window icon with the
 * page favicon after load — re-apply via applyWindowIcon() when that happens.
 */
function loadAppIconImage(): NativeImage | undefined {
  const iconPath = resolveAppIconPath();
  if (!iconPath) return undefined;
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn("[lyra] app icon failed to load:", iconPath);
    return undefined;
  }
  return image;
}

function applyWindowIcon(win: BrowserWindow, image: NativeImage | undefined) {
  if (!image || image.isEmpty()) return;
  win.setIcon(image);
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(image);
  }
}

/**
 * GNOME/KDE ignore BrowserWindow icons for dock tiles when a .desktop file
 * matches StartupWMClass. Gearlever/AppImage installs often ship a stale square
 * icon — refresh XDG icon theme + desktop entry so the dock shows rounded Lyra.
 */
function installLinuxDesktopIntegration(iconPath: string | undefined) {
  if (process.platform !== "linux" || !iconPath || !existsSync(iconPath)) return;

  try {
    const home = os.homedir();
    const iconDir = path.join(home, ".local", "share", "icons", "hicolor", "512x512", "apps");
    const appDir = path.join(home, ".local", "share", "applications");
    mkdirSync(iconDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    const destIcon = path.join(iconDir, "lyra.png");
    copyFileSync(iconPath, destIcon);

    // Gearlever stores a flat path icon — overwrite so WM_CLASS=Lyra picks rounded art.
    const gearleverIcon = path.join(home, "AppImages", ".icons", "lyra");
    try {
      mkdirSync(path.dirname(gearleverIcon), { recursive: true });
      copyFileSync(iconPath, gearleverIcon);
    } catch {
      // optional path
    }

    const execPath = app.isPackaged
      ? process.env.APPIMAGE || process.execPath
      : process.execPath;
    // Prefer existing Gearlever AppImage if present for the launcher entry.
    const appImageGuess = path.join(home, "AppImages", "lyra.appimage");
    const launchExec = existsSync(appImageGuess)
      ? `env DESKTOPINTEGRATION=1 "${appImageGuess}" --no-sandbox %U`
      : app.isPackaged
        ? `"${execPath}" %U`
        : `"${process.execPath}" "${app.getAppPath()}" %U`;

    const desktop = `[Desktop Entry]
Type=Application
Name=Lyra
Comment=Privacy-first device network — clipboard, files, and remote browse
Icon=lyra
Exec=${launchExec}
Terminal=false
Categories=Network;
StartupWMClass=Lyra
StartupNotify=true
`;
    writeFileSync(path.join(appDir, "lyra.desktop"), desktop, "utf8");
    process.env.CHROME_DESKTOP = "lyra.desktop";
    console.log("[lyra] installed Linux desktop icon →", destIcon);
  } catch (err) {
    console.warn("[lyra] Linux desktop integration failed", err);
  }
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

  // Fully custom chrome (T3-style):
  // - macOS: keep the frame for traffic lights, hide the title bar (hiddenInset)
  // - Win/Linux: frameless; renderer draws min/max/close and drag regions
  const appIcon = loadAppIconImage();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Lyra",
    show: false,
    backgroundColor: "#0B0F17",
    autoHideMenuBar: true,
    transparent: false,
    hasShadow: true,
    ...(appIcon ? { icon: appIcon } : {}),
    ...(isMac
      ? {
          frame: true,
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 16 },
        }
      : {
          frame: false,
        }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep a short title if any WM still surfaces it
  mainWindow.setTitle("Lyra");
  applyWindowIcon(mainWindow, appIcon);
  mainWindow.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    mainWindow?.setTitle("Lyra");
  });
  // Dev loads the Vite UI — Chromium swaps the taskbar icon to the page favicon
  // (square logo.png). Force our rounded app icon back on every favicon update.
  mainWindow.webContents.on("page-favicon-updated", () => {
    if (mainWindow) applyWindowIcon(mainWindow, appIcon);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    if (mainWindow) applyWindowIcon(mainWindow, appIcon);
  });

  const broadcastWindowState = () => {
    if (!mainWindow) return;
    mainWindow.webContents.send("lyra:window-state", {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
      focused: mainWindow.isFocused(),
    });
  };
  mainWindow.on("maximize", broadcastWindowState);
  mainWindow.on("unmaximize", broadcastWindowState);
  mainWindow.on("enter-full-screen", broadcastWindowState);
  mainWindow.on("leave-full-screen", broadcastWindowState);
  mainWindow.on("focus", broadcastWindowState);
  mainWindow.on("blur", broadcastWindowState);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
    broadcastWindowState();
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
    // Hash "#" anchors the SPA at Devices (/) — see apps/web/src/main.tsx hash history.
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
      void mainWindow.loadFile(indexHtml, { hash: "/" });
    }
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Allow two Electron windows on one PC for local pairing tests:
//   LYRA_ALLOW_MULTI=1 LYRA_INSTANCE=a LYRA_PORT=53317 pnpm run dev:desktop
//   LYRA_ALLOW_MULTI=1 LYRA_INSTANCE=b LYRA_PORT=53319 pnpm run dev:desktop
const allowMulti =
  process.env.LYRA_ALLOW_MULTI === "1" || process.env.LYRA_ALLOW_MULTI === "true";
const instanceId = (process.env.LYRA_INSTANCE ?? "").trim();

// Isolate storage/session so two instances don't share localStorage identity
if (instanceId) {
  const base = app.getPath("userData");
  app.setPath("userData", path.join(base, `instance-${instanceId}`));
}

const gotLock = allowMulti ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else if (!allowMulti) {
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
  if (allowMulti || instanceId) {
    console.log(
      `[lyra] multi-instance mode instance=${instanceId || "default"} port=${PEER_PORT} name=${process.env.LYRA_NAME ?? "Lyra Desktop"}`,
    );
  }

  // Dock icon early (macOS); Linux XDG + window icon re-apply after create/load.
  const iconPath = resolveAppIconPath();
  const dockIcon = loadAppIconImage();
  if (dockIcon && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(dockIcon);
  }
  installLinuxDesktopIntegration(iconPath);

  installApplicationMenu();

  ipcMain.handle("lyra:get-peer-status", () => ({
    running: status.running,
    port: status.port,
    url: status.url,
    lanHost: status.lanHost,
    discoveryActive: status.discoveryActive,
    lastError: status.lastError,
    updatedAt: Date.now(),
  }));

  ipcMain.handle("lyra:get-identity", () => status.identity);

  /** Renderer is source of truth for device identity after hydrate */
  ipcMain.handle(
    "lyra:set-identity",
    (
      _e,
      payload: { identity: DeviceIdentity; privateKey?: string | null },
    ) => {
      if (!payload?.identity?.id || !payload.identity.fingerprint) {
        return { ok: false as const, error: "Invalid identity" };
      }
      adoptRendererIdentity(payload.identity, payload.privateKey);
      return { ok: true as const, identity: status.identity };
    },
  );

  /**
   * Host user Accept/Decline for an in-flight pair_request (long-poll).
   * Joiner's HTTP request unblocks with pair_confirm / pair_reject.
   */
  ipcMain.handle(
    "lyra:resolve-pair-request",
    (
      _e,
      payload: {
        deviceId?: string;
        token?: string;
        accepted: boolean;
        reason?: string;
      },
    ) => {
      if (!peer) return { ok: false as const, error: "Peer server not running" };
      const lan = peer.getLanHost?.() ?? undefined;
      const decision = payload.accepted
        ? {
            accepted: true as const,
            host: lan,
            port: peer.port,
          }
        : {
            accepted: false as const,
            reason: payload.reason ?? "rejected",
          };
      const matched = peer.resolvePairRequest(
        { deviceId: payload.deviceId, token: payload.token },
        decision,
      );
      return { ok: matched, matched };
    },
  );

  ipcMain.handle("lyra:get-shell-info", () => ({
    platform: process.platform,
    isDesktop: true,
    downloadDirectory: resolveDownloadDir(),
    customChrome: true,
    usesSystemTrafficLights: process.platform === "darwin",
  }));

  ipcMain.handle("lyra:window-minimize", () => {
    mainWindow?.minimize();
  });

  ipcMain.handle("lyra:window-maximize-toggle", () => {
    if (!mainWindow) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle("lyra:window-close", () => {
    mainWindow?.close();
  });

  ipcMain.handle("lyra:window-get-state", () => ({
    maximized: mainWindow?.isMaximized() ?? false,
    fullscreen: mainWindow?.isFullScreen() ?? false,
    focused: mainWindow?.isFocused() ?? false,
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
      lanHost: status.lanHost,
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
        console.log("[lyra] pairing offer cleared");
        // Re-announce so peers drop stale offer
        discovery?.announce();
        return { ok: true };
      }
      const codeHash = await hashPairingCode(offer.code);
      pairingOffer = {
        codeHash,
        token: offer.token,
        expiresAt: offer.expiresAt,
      };
      console.log(
        "[lyra] pairing offer active",
        `code=${offer.code}`,
        `hash=${codeHash.slice(0, 12)}…`,
        `until=${new Date(offer.expiresAt).toISOString()}`,
        `info=http://${status.lanHost ?? "127.0.0.1"}:${status.port ?? PEER_PORT}/lyra/info`,
      );
      // Burst announce so joiners see the offer over multicast immediately
      discovery?.announce();
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

  /** LocalSend-style: fire UDP multicast announce burst (user Refresh discovery). */
  ipcMain.handle("lyra:announce-discovery", () => {
    if (!discovery) return { ok: false as const, error: "Discovery not running" };
    discovery.announce();
    return {
      ok: true as const,
      addresses: discovery.localAddresses(),
    };
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
