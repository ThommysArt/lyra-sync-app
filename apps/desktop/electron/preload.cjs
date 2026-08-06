const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyra", {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_ev, data) => listener(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  off: (channel, listener) => ipcRenderer.removeListener(channel, listener),
  getPeerStatus: () => ipcRenderer.invoke("lyra:get-peer-status"),
  getIdentity: () => ipcRenderer.invoke("lyra:get-identity"),
  setIdentity: (id) => ipcRenderer.invoke("lyra:set-identity", id),
  resolvePairRequest: (match, decision) => ipcRenderer.invoke("lyra:resolve-pair-request", match, decision),
  syncTrustedPeers: (peers) => ipcRenderer.invoke("lyra:sync-trusted-peers", peers),
  setPairingOffer: (offer) => ipcRenderer.invoke("lyra:set-pairing-offer", offer),
  scanTailscale: () => ipcRenderer.invoke("lyra:scan-tailscale"),
  getShellInfo: () => ipcRenderer.invoke("lyra:get-shell-info"),
  openUrl: (url) => ipcRenderer.invoke("lyra:open-url", url),
  windowMinimize: () => ipcRenderer.invoke("lyra:window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("lyra:window-maximize"),
  windowClose: () => ipcRenderer.invoke("lyra:window-close"),
  quit: () => ipcRenderer.invoke("lyra:quit"),
});
