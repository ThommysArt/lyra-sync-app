/**
 * Preload bridge — CommonJS so Electron can load it without ESM friction.
 * Exposes a minimal lyraDesktop API to the web renderer.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyraDesktop", {
  getPeerStatus: () => ipcRenderer.invoke("lyra:get-peer-status"),
  getIdentity: () => ipcRenderer.invoke("lyra:get-identity"),
  restartNetworking: () => ipcRenderer.invoke("lyra:restart-networking"),
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
});
