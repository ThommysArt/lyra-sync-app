import { Tabs } from "expo-router";
import type { JSX } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ConflictBanner } from "@/components/conflict-banner";
import { IncomingPairBanner } from "@/components/incoming-pair-banner";
import { FloatingTabBar } from "@/components/nav/floating-tab-bar";
import { useAppTheme } from "@/contexts/app-theme-context";
import { PAGE_BG } from "@/lib/constants";
import { useLyraSelector } from "@/lib/lyra";

export default function TabsLayout(): JSX.Element {
  const insets = useSafeAreaInsets();
  const { isDark } = useAppTheme();
  const hasPair = useLyraSelector((s) => s.incomingPairRequests.length > 0);
  const hasConflict = useLyraSelector((s) => s.transfers.some((t) => t.status === "conflict"));
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      {(hasPair || hasConflict) && (
        <View style={{ paddingTop: insets.top }}>
          <IncomingPairBanner />
          <ConflictBanner />
        </View>
      )}
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: "transparent" },
          tabBarStyle: {
            backgroundColor: "transparent",
            borderTopWidth: 0,
            elevation: 0,
            position: "absolute",
          },
        }}
        tabBar={(props) => <FloatingTabBar {...props} />}
      >
        <Tabs.Screen name="index" options={{ title: "Devices" }} />
        <Tabs.Screen name="clipboard" options={{ title: "Clipboard" }} />
        <Tabs.Screen name="transfers" options={{ title: "Transfers" }} />
        <Tabs.Screen name="settings" options={{ title: "Settings" }} />
      </Tabs>
    </View>
  );
}
