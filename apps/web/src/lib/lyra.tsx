import { LyraProvider as BaseLyraProvider, useLyraSelector, useLyraState, useLyraStore } from "@lyra-sync-app/hooks";
import type { ReactNode } from "react";
import { useCallback } from "react";

import { getDesktopApi } from "./desktop-bridge";

export { useLyraSelector, useLyraState, useLyraStore };

function shouldSeedDemo(): boolean {
  try {
    // Vite only statically replaces *direct* import.meta.env.* access.
    // Assigning import.meta to a variable leaves env.DEV undefined at runtime.
    const flag = import.meta.env.VITE_LYRA_SEED_DEMO as string | undefined;
    if (flag === "1" || flag === "true") return true;
    if (flag === "0" || flag === "false") return false;
    return Boolean(import.meta.env.DEV);
  } catch {
    return true;
  }
}

export function LyraProvider({ children }: { children: ReactNode }) {
  const onStoreReady = useCallback((store: import("@lyra-sync-app/core").LyraStore) => {
    const api = getDesktopApi();
    if (!api) return;

    void api.getPeerStatus().then((status) => {
      store.setPeerServerStatus(status);
    });

    const unsubStatus = api.onPeerStatus((status) => {
      store.setPeerServerStatus(status);
    });

    // Sync trusted peers whenever devices change (pair / unpair)
    const syncTrust = () => {
      if (!api.syncTrustedPeers) return;
      const peers = store
        .getState()
        .devices.filter((d) => d.authSecret)
        .map((d) => ({
          deviceId: d.id,
          fingerprint: d.fingerprint,
          publicKey: d.publicKey,
          authSecret: d.authSecret!,
        }));
      void api.syncTrustedPeers(peers);
    };
    syncTrust();
    const unsubStore = store.subscribe(syncTrust);

    // Advertise active pairing code hash on desktop peer /lyra/info
    let lastOfferKey = "";
    const syncPairingOffer = () => {
      if (!api.setPairingOffer) return;
      const active = store.getState().activePairing;
      const key = active ? `${active.code}:${active.token}:${active.expiresAt}` : "";
      if (key === lastOfferKey) return;
      lastOfferKey = key;
      if (!active) {
        void api.setPairingOffer(null);
        return;
      }
      void api.setPairingOffer({
        code: active.code,
        token: active.token,
        expiresAt: active.expiresAt,
      });
    };
    const unsubPair = store.subscribe(syncPairingOffer);
    syncPairingOffer();

    // Sync download directory preference to Electron shell
    let lastDl = store.getState().settings.downloadDirectory ?? "";
    const syncDownloadDir = () => {
      if (!api.setDownloadDirectory) return;
      const dir = store.getState().settings.downloadDirectory ?? "";
      if (dir === lastDl) return;
      lastDl = dir;
      void api.setDownloadDirectory(dir || null);
    };
    const unsubDl = store.subscribe(syncDownloadDir);
    // Load shell default into settings if empty
    if (api.getDownloadDirectory && !store.getState().settings.downloadDirectory) {
      void api.getDownloadDirectory().then((path) => {
        if (path && !store.getState().settings.downloadDirectory) {
          // Keep display path in settings without forcing custom override until user sets it
          // (empty string means system default — we only surface path in UI via shell info)
        }
      });
    }

    // Wire pair_request from Electron main
    const unsubPairReq = api.onPairRequest?.((payload) => {
      store.enqueuePairRequest(payload as import("@lyra-sync-app/protocol").PairingPayload, "wire");
    });

    const unsubUnpair = api.onUnpaired?.(({ deviceId }) => {
      // Remote revoked us — drop local trust without re-notifying
      const still = store.getState().devices.find((d) => d.id === deviceId);
      if (still) store.unpairDevice(deviceId, { silent: true });
    });

    const unsubClip = api.onClipboardPush?.((item) => {
      store.receiveClipboardItem(item as import("@lyra-sync-app/protocol").ClipboardItem);
    });

    const unsubTs = api.onTailscalePeers?.((peers) => {
      store.ingestTailscalePeers(peers);
    });

    // LAN multicast discovery → nearby (untrusted) devices
    const unsubDisc = api.onDiscoveredPeer?.((peer) => {
      const announce = peer as {
        identity?: {
          id: string;
          name: string;
          type?: import("@lyra-sync-app/protocol").PairedDevice["type"];
          platform?: import("@lyra-sync-app/protocol").PairedDevice["platform"];
          fingerprint: string;
          publicKey?: string;
        };
        host?: string;
        port?: number;
      };
      if (!announce?.identity?.id || !announce.host) return;
      store.ingestDiscoveredPeer({
        identity: announce.identity,
        host: announce.host,
        port: announce.port ?? store.getState().settings.peerListenPort ?? 53317,
      });
    });

    const unsubTx = api.onTransferComplete?.((data) => {
      store.recordReceivedTransfer({
        transferId: data.transferId,
        files: data.files,
        receivedBytes: data.receivedBytes,
        savedPaths: data.savedPaths,
        deviceName: "Peer",
      });
    });

    return () => {
      unsubStatus();
      unsubStore();
      unsubPair();
      unsubDl();
      unsubPairReq?.();
      unsubUnpair?.();
      unsubClip?.();
      unsubTs?.();
      unsubDisc?.();
      unsubTx?.();
    };
  }, []);

  return (
    <BaseLyraProvider
      storage={typeof localStorage !== "undefined" ? localStorage : null}
      seedDemo={shouldSeedDemo()}
      platformHint="web"
      onStoreReady={onStoreReady}
      fallback={
        <div className="flex h-svh items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-3">
            <div className="size-10 animate-pulse rounded-full bg-primary/20" />
            <p className="text-sm text-muted-foreground">Starting Lyra…</p>
          </div>
        </div>
      }
    >
      {children}
    </BaseLyraProvider>
  );
}
