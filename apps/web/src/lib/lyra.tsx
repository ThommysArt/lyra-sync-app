import { LyraProvider as BaseLyraProvider, useLyraSelector, useLyraState, useLyraStore } from "@lyra-sync-app/hooks";
import type { ReactNode } from "react";
import { useCallback } from "react";

import { getDesktopApi } from "./desktop-bridge";

export { useLyraSelector, useLyraState, useLyraStore };

function shouldSeedDemo(): boolean {
  try {
    // Opt-in only — never auto-seed in DEV so real pairing/transfers can be tested.
    // CI e2e sets VITE_LYRA_SEED_DEMO=1 when dummy mesh is required.
    const flag = import.meta.env.VITE_LYRA_SEED_DEMO as string | undefined;
    return flag === "1" || flag === "true";
  } catch {
    return false;
  }
}

export function LyraProvider({ children }: { children: ReactNode }) {
  const onStoreReady = useCallback((store: import("@lyra-sync-app/core").LyraStore) => {
    const api = getDesktopApi();
    if (!api) return;

    let didInitialScan = false;
    const onPeerStatus = (status: {
      running: boolean;
      lanHost?: string | null;
      [key: string]: unknown;
    }) => {
      store.setPeerServerStatus(status as Parameters<typeof store.setPeerServerStatus>[0]);
      if (status.lanHost) store.setLocalLanHint(status.lanHost);
      // Once peer server is up: HTTP /24 scan + UDP announce (LocalSend-style)
      if (!didInitialScan && status.running && store.getState().settings.discoveryEnabled) {
        didInitialScan = true;
        void store.refreshDiscovery();
      }
    };

    void api.getPeerStatus().then(onPeerStatus);

    const unsubStatus = api.onPeerStatus(onPeerStatus);

    // Align peer-server identity with renderer store (critical for pairing)
    const pushIdentity = () => {
      if (!api.setIdentity) return;
      const s = store.getState();
      if (!s.identity) return;
      void api.setIdentity({ identity: s.identity, privateKey: s.privateKey });
    };
    pushIdentity();

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

    // Advertise active pairing code hash on desktop peer /lyra/info
    let lastOfferKey = "";
    let lastIdentityKey = "";
    const syncPairingAndIdentity = () => {
      const s = store.getState();
      const idKey = s.identity
        ? `${s.identity.id}:${s.identity.fingerprint}:${s.identity.name}`
        : "";
      if (idKey && idKey !== lastIdentityKey) {
        lastIdentityKey = idKey;
        pushIdentity();
      }

      if (!api.setPairingOffer) return;
      const active = s.activePairing;
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
    const unsubStore = store.subscribe(() => {
      syncTrust();
      syncPairingAndIdentity();
    });
    syncPairingAndIdentity();

    // Wire host Accept/Decline → peer-server long-poll resolution
    store.setPairDecisionResolver?.((payload) => {
      if (!api.resolvePairRequest) {
        return Promise.resolve({ ok: false as const, error: "Desktop bridge missing resolvePairRequest" });
      }
      return api.resolvePairRequest(payload);
    });

    // LocalSend-style: Refresh discovery fires UDP announce so peers reply
    store.setDiscoveryAnnouncer?.(() => {
      void api.announceDiscovery?.();
    });

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

    // LAN multicast discovery → nearby (untrusted) devices + pairing offers
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
        pairing?: { codeHash: string; token: string; expiresAt: number };
      };
      if (!announce?.identity?.id || !announce.host) return;
      store.ingestDiscoveredPeer({
        identity: announce.identity,
        host: announce.host,
        port: announce.port ?? store.getState().settings.peerListenPort ?? 53317,
        pairing: announce.pairing,
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
      unsubDl();
      unsubPairReq?.();
      unsubUnpair?.();
      unsubClip?.();
      unsubTs?.();
      unsubDisc?.();
      unsubTx?.();
      store.setPairDecisionResolver?.(null);
      store.setDiscoveryAnnouncer?.(null);
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
