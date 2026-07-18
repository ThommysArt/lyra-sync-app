import { LyraProvider as BaseLyraProvider, useLyraSelector, useLyraState, useLyraStore } from "@lyra-sync-app/hooks";
import type { ReactNode } from "react";
import { useCallback } from "react";

import { getDesktopApi } from "./desktop-bridge";

export { useLyraSelector, useLyraState, useLyraStore };

export function LyraProvider({ children }: { children: ReactNode }) {
  const onStoreReady = useCallback((store: import("@lyra-sync-app/core").LyraStore) => {
    const api = getDesktopApi();
    if (!api) return;
    void api.getPeerStatus().then((status) => {
      store.setPeerServerStatus(status);
    });
    return api.onPeerStatus((status) => {
      store.setPeerServerStatus(status);
    });
  }, []);

  return (
    <BaseLyraProvider
      storage={typeof localStorage !== "undefined" ? localStorage : null}
      seedDemo
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
