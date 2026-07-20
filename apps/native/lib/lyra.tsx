import { LyraProvider as BaseLyraProvider, useLyraSelector, useLyraState, useLyraStore } from "@lyra-sync-app/hooks";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import * as Network from "expo-network";

import { ACCENT, PAGE_BG } from "@/lib/constants";
import { useAppTheme } from "@/contexts/app-theme-context";
import {
  createSecureLyraStorage,
  migratePrivateKeyToSecureStore,
} from "@/lib/secure-storage";

export { useLyraSelector, useLyraState, useLyraStore };

export function LyraProvider({ children }: { children: ReactNode }) {
  const { isDark } = useAppTheme();
  const storage = useMemo(() => createSecureLyraStorage(), []);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (storage.hydrate) await storage.hydrate();
        await migratePrivateKeyToSecureStore(storage);
      } catch (err) {
        console.warn("[lyra] storage hydrate failed", err);
      }
      if (!cancelled) setStorageReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  /** Seed /24 LAN scan for pairing-code lookup when possible */
  const onStoreReady = useCallback((store: import("@lyra-sync-app/core").LyraStore) => {
    void Network.getIpAddressAsync()
      .then((ip) => {
        if (ip && ip !== "0.0.0.0") store.setLocalLanHint(ip);
      })
      .catch(() => {
        // ignore — pairing still works with manual/discovered hosts
      });
  }, []);

  const fallback = (
    <View
      style={{
        alignItems: "center",
        backgroundColor: isDark ? PAGE_BG.dark : PAGE_BG.light,
        flex: 1,
        justifyContent: "center",
      }}
    >
      <ActivityIndicator color={ACCENT} size="large" />
    </View>
  );

  if (!storageReady) {
    return fallback;
  }

  return (
    <BaseLyraProvider
      storage={storage}
      // Opt-in dummy mesh only (never default in dev)
      seedDemo={
        process.env.EXPO_PUBLIC_LYRA_SEED_DEMO === "1" ||
        process.env.EXPO_PUBLIC_LYRA_SEED_DEMO === "true"
      }
      platformHint="native"
      onStoreReady={onStoreReady}
      fallback={fallback}
    >
      {children}
    </BaseLyraProvider>
  );
}
