/**
 * Preload bridge — CommonJS so Electron can load it without ESM friction.
 * Exposes a minimal lyraDesktop API to the web renderer.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyraDesktop", {
  getPeerStatus: () => ipcRenderer.invoke("lyra:get-peer-status"),
  getIdentity: () => ipcRenderer.invoke("lyra:get-identity"),
  setIdentity: (payload) => ipcRenderer.invoke("lyra:set-identity", payload),
  getShellInfo: () => ipcRenderer.invoke("lyra:get-shell-info"),
  getDownloadDirectory: () => ipcRenderer.invoke("lyra:get-download-directory"),
  setDownloadDirectory: (dir) => ipcRenderer.invoke("lyra:set-download-directory", dir),
  chooseDownloadDirectory: () => ipcRenderer.invoke("lyra:choose-download-directory"),
  openPath: (targetPath) => ipcRenderer.invoke("lyra:open-path", targetPath),
  restartNetworking: () => ipcRenderer.invoke("lyra:restart-networking"),
  syncTrustedPeers: (peers) => ipcRenderer.invoke("lyra:sync-trusted-peers", peers),
  setPairingOffer: (offer) => ipcRenderer.invoke("lyra:set-pairing-offer", offer),
  resolvePairRequest: (payload) => ipcRenderer.invoke("lyra:resolve-pair-request", payload),
  announceDiscovery: () => ipcRenderer.invoke("lyra:announce-discovery"),
  revokeDevice: (deviceId) => ipcRenderer.invoke("lyra:revoke-device", deviceId),
  quit: () => ipcRenderer.invoke("lyra:quit"),
  scanTailscale: () => ipcRenderer.invoke("lyra:scan-tailscale"),
  // Custom window chrome (frameless shell)
  windowMinimize: () => ipcRenderer.invoke("lyra:window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("lyra:window-maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("lyra:window-close"),
  windowGetState: () => ipcRenderer.invoke("lyra:window-get-state"),
  onWindowState: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("lyra:window-state", listener);
    return () => ipcRenderer.removeListener("lyra:window-state", listener);
  },
  onPeerStatus: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on("lyra:peer-status", listener);
    return () => ipcRenderer.removeListener("lyra:peer-status", listener);
  },
  onDiscoveredPeer: (handler) => {
    const listener = (_event, peer) => handler(peer);
    ipcRenderer.on("lyra:discovered-peer", listener);
    return () => ipcRenderer.removeListener("lyra:discovered-peer", listener);
  },
  onEnvelope: (handler) => {
    const listener = (_event, envelope) => handler(envelope);
    ipcRenderer.on("lyra:envelope", listener);
    return () => ipcRenderer.removeListener("lyra:envelope", listener);
  },
  onPairRequest: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("lyra:pair-request", listener);
    return () => ipcRenderer.removeListener("lyra:pair-request", listener);
  },
  onUnpaired: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("lyra:unpaired", listener);
    return () => ipcRenderer.removeListener("lyra:unpaired", listener);
  },
  onClipboardPush: (handler) => {
    const listener = (_event, item) => handler(item);
    ipcRenderer.on("lyra:clipboard-push", listener);
    return () => ipcRenderer.removeListener("lyra:clipboard-push", listener);
  },
  onTailscalePeers: (handler) => {
    const listener = (_event, peers) => handler(peers);
    ipcRenderer.on("lyra:tailscale-peers", listener);
    return () => ipcRenderer.removeListener("lyra:tailscale-peers", listener);
  },
  onTransferComplete: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("lyra:transfer-complete", listener);
    return () => ipcRenderer.removeListener("lyra:transfer-complete", listener);
  },
});
