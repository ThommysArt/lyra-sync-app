import { Tabs } from "expo-router";
import type { JSX } from "react";

import { FloatingTabBar } from "@/components/nav/floating-tab-bar";

export default function TabsLayout(): JSX.Element {
  return (
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
  );
}
