// @ts-nocheck
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startPeerServer, type PeerServer } from "@lyra-sync-app/daemon";
import { startDiscovery, type DiscoveryHandle } from "@lyra-sync-app/discovery";
import type { DeviceIdentity } from "@lyra-sync-app/protocol";
import { getVariant, variantPort, variantAppId, variantUserDataSuffix } from "../scripts/variant.js";

const requireCjs = createRequire(import.meta.url);
let electron: {
  app: {
    getPath(name: string): string;
    whenReady(): Promise<void>;
    on(ev: string, cb: (...args: unknown[]) => void): void;
    quit(): void;
    getName(): string;
  };
  BrowserWindow: new (opts: unknown) => {
    loadURL(url: string): Promise<void>;
    loadFile(p: string): Promise<void>;
    webContents: { send(ch: string, data: unknown): void };
    on(ev: string, cb: (...args: unknown[]) => void): void;
    close(): void;
    isDestroyed(): boolean;
  };
  ipcMain: { handle(ch: string, fn: (ev: unknown, ...args: unknown[]) => unknown): void; on(ch: string, fn: (...args: unknown[]) => void): void };
  shell: { openExternal(url: string): Promise<void> };
} | null = null;

try {
  electron = requireCjs("electron") as typeof electron;
} catch {
  electron = null;
}

const variant = getVariant();
const port = variantPort(variant);
const appId = variantAppId(variant);
const userDataSuffix = variantUserDataSuffix(variant);

let peerServer: PeerServer | null = null;
let discovery: DiscoveryHandle | null = null;
let mainWindow: InstanceType<NonNullable<typeof electron>["BrowserWindow"]> | null = null;
let currentIdentity: DeviceIdentity = {
  id: `desktop-${os.hostname()}-${variant}`,
  name: os.hostname(),
  fingerprint: "00000000deadbeef",
  type: "desktop",
  platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
};
let trustedPeers: Array<{ deviceId: string; fingerprint: string; publicKey?: string; authSecret: string }> = [];
let pairingOffer: { codeHash: string; token: string; expiresAt: number } | null = null;

function getLanHost(): string | null {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) if (info.family === "IPv4" && !info.internal) return info.address;
  }
  return null;
}

async function createWindow(): Promise<void> {
  if (!electron) {
    console.log("[desktop] electron not available, skipping window creation");
    return;
  }
  const { BrowserWindow } = electron;
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env["LYRA_WEB_URL"];
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    const indexHtml = path.join(process.cwd(), "resources", "web-dist", "index.html");
    const fallback = path.join(process.cwd(), "..", "web", "dist", "index.html");
    try {
      await mainWindow.loadFile(indexHtml);
    } catch {
      await mainWindow.loadFile(fallback);
    }
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupIpc(): void {
  if (!electron) return;
  const { ipcMain, shell } = electron;

  ipcMain.handle("lyra:get-peer-status", () => {
    return {
      running: !!peerServer,
      port: peerServer?.port ?? port,
      protocol: peerServer?.protocol ?? "http",
      lanHost: getLanHost(),
      variant,
      appId,
    };
  });

  ipcMain.handle("lyra:get-identity", () => currentIdentity);

  ipcMain.handle("lyra:set-identity", (_ev: unknown, next: DeviceIdentity) => {
    currentIdentity = next;
    peerServer?.setIdentity(next);
    discovery?.announce();
    return currentIdentity;
  });

  ipcMain.handle("lyra:resolve-pair-request", (_ev: unknown, match: string | { token: string }, decision: boolean) => {
    return peerServer?.resolvePairRequest(match, decision) ?? false;
  });

  ipcMain.handle("lyra:sync-trusted-peers", (_ev: unknown, peers: typeof trustedPeers) => {
    if (Array.isArray(peers)) trustedPeers = peers;
    peerServer?.syncTrustedPeers(trustedPeers);
    return trustedPeers.length;
  });

  ipcMain.handle("lyra:set-pairing-offer", (_ev: unknown, offer: typeof pairingOffer) => {
    pairingOffer = offer;
    discovery?.announce();
    return true;
  });

  ipcMain.handle("lyra:scan-tailscale", async () => {
    try {
      const { scanTailscalePeers } = await import("@lyra-sync-app/discovery");
      const peers = await scanTailscalePeers();
      return peers;
    } catch {
      return [];
    }
  });

  ipcMain.handle("lyra:get-shell-info", () => {
    return {
      variant,
      port,
      appId,
      userDataSuffix,
      platform: process.platform,
      arch: process.arch,
      version: process.env["npm_package_version"] ?? "0.1.0",
    };
  });

  ipcMain.handle("lyra:window-minimize", () => {
    // stub: no window control in scaffold
    return true;
  });

  ipcMain.handle("lyra:window-maximize", () => true);
  ipcMain.handle("lyra:window-close", () => {
    mainWindow?.close();
    return true;
  });

  ipcMain.handle("lyra:quit", () => {
    electron?.app.quit();
    return true;
  });

  ipcMain.handle("lyra:open-url", (_ev: unknown, url: string) => {
    if (typeof url === "string") void shell.openExternal(url);
    return true;
  });
}

async function startDaemon(): Promise<void> {
  peerServer = await startPeerServer({
    identity: currentIdentity,
    port,
    tls: false,
    downloadDir: path.join(os.homedir(), "Downloads"),
    onLog: (msg: string) => console.log(`[peer] ${msg}`),
    onEnvelope: (env) => {
      mainWindow?.webContents.send("lyra:envelope", env);
    },
    resolvePeerAuth: (deviceId: string) => {
      const t = trustedPeers.find((p) => p.deviceId === deviceId);
      return t?.authSecret ?? null;
    },
    getPairingOffer: () => pairingOffer,
    handlers: {
      onClipboardPush: (envelope, payload) => {
        mainWindow?.webContents.send("lyra:clipboard-push", { envelope, payload });
      },
      onTransferOffer: (envelope, payload) => {
        mainWindow?.webContents.send("lyra:transfer-offer", { envelope, payload });
      },
      onFsList: async (_p: string) => {
        // stub fs list — return empty
        return [];
      },
      onOpenUrl: (u: string) => {
        mainWindow?.webContents.send("lyra:open-url", u);
      },
      onPairRequest: (payload) => {
        mainWindow?.webContents.send("lyra:pair-request", payload);
      },
    },
  });

  discovery = startDiscovery({
    identity: currentIdentity,
    peerPort: peerServer.port,
    advertiseHost: getLanHost() ?? undefined,
    getPairingOffer: () => pairingOffer,
    onPeer: (peer) => {
      mainWindow?.webContents.send("lyra:discovered-peer", peer);
    },
    onLog: (msg) => console.log(`[discovery] ${msg}`),
  });
}

async function main(): Promise<void> {
  if (electron) {
    // tweak userData path per variant
    try {
      const base = electron.app.getPath("userData");
      if (userDataSuffix) {
        const { app } = electron;
        void app;
        void base;
        // electron.app.setPath not typed in stub; guard
        try {
          const realApp = requireCjs("electron").app as { setPath(n: string, p: string): void };
          realApp.setPath("userData", `${base}${userDataSuffix}`);
        } catch {}
      }
    } catch {}

    await electron.app.whenReady();
    setupIpc();
    await startDaemon();
    await createWindow();

    electron.app.on("window-all-closed", () => {
      if (process.platform !== "darwin") electron?.app.quit();
    });
    electron.app.on("activate", () => {
      if (!mainWindow) void createWindow();
    });
  } else {
    // headless mode (check-types)
    await startDaemon();
    console.log("[desktop] running headless (no electron)");
  }
}

void main();

process.on("SIGINT", async () => {
  await peerServer?.close();
  await discovery?.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await peerServer?.close();
  await discovery?.stop();
  process.exit(0);
});
