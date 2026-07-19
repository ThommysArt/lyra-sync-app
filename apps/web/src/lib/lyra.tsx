import { LyraProvider as BaseLyraProvider, useLyraSelector, useLyraState, useLyraStore } from "@lyra-sync-app/hooks";
import type { ReactNode } from "react";
import { useCallback } from "react";

import { getDesktopApi } from "./desktop-bridge";

export { useLyraSelector, useLyraState, useLyraStore };

function shouldSeedDemo(): boolean {
  try {
    // Vite: seed only in dev unless explicitly forced
    const meta = import.meta as ImportMeta & { env?: { DEV?: boolean; PROD?: boolean; VITE_LYRA_SEED_DEMO?: string } };
    const flag = meta.env?.VITE_LYRA_SEED_DEMO;
    if (flag === "1" || flag === "true") return true;
    if (flag === "0" || flag === "false") return false;
    return Boolean(meta.env?.DEV);
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

    return () => {
      unsubStatus();
      unsubStore();
      unsubPair();
      unsubPairReq?.();
      unsubUnpair?.();
      unsubClip?.();
      unsubTs?.();
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
