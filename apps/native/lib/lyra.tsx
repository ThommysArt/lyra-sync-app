import { LyraProvider as BaseLyraProvider, useLyraSelector, useLyraState, useLyraStore } from "@lyra-sync-app/hooks";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { ActivityIndicator, View } from "react-native";

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

  useEffect(() => {
    void migratePrivateKeyToSecureStore(storage);
  }, [storage]);

  return (
    <BaseLyraProvider
      storage={storage}
      // Seed demo mesh only when explicitly requested or __DEV__
      seedDemo={
        typeof __DEV__ !== "undefined"
          ? __DEV__
          : process.env.EXPO_PUBLIC_LYRA_SEED_DEMO === "1"
      }
      platformHint="native"
      fallback={
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
      }
    >
      {children}
    </BaseLyraProvider>
  );
}
