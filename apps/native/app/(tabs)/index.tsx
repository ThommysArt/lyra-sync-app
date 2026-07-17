import {
  connectionLabel,
  formatRelativeTime,
  platformLabel,
} from "@lyra-sync-app/core";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ScreenHeader, useTabBottomPadding } from "@/components/ui/screen-header";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function DevicesScreen() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const bottomPad = useTabBottomPadding();
  const devices = useLyraSelector((s) =>
    s.devices.filter((d) => d.showInMainList).sort((a, b) => Number(b.online) - Number(a.online)),
  );
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#141A26" : "#FFFFFF";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <ScreenHeader
          title="Devices"
          subtitle="Your trusted private network"
          right={
            <Pressable
              onPress={() => router.push("/pair")}
              style={{
                alignItems: "center",
                backgroundColor: accent,
                borderRadius: 999,
                height: 40,
                justifyContent: "center",
                width: 40,
              }}
            >
              <Ionicons color="#fff" name="link" size={20} />
            </Pressable>
          }
        />

        <View style={{ gap: 12, paddingHorizontal: 16 }}>
          <Pressable
            onPress={() => {
              const online = devices.filter((d) => d.online).map((d) => d.id);
              store.pushClipboardText("Hello from Lyra mobile", online);
            }}
            style={{
              alignItems: "center",
              backgroundColor: isDark ? "rgba(122,162,255,0.15)" : "rgba(47,107,255,0.1)",
              borderRadius: 20,
              flexDirection: "row",
              gap: 10,
              paddingHorizontal: 16,
              paddingVertical: 14,
            }}
          >
            <Ionicons color={accent} name="clipboard-outline" size={20} />
            <Text style={{ color: accent, flex: 1, fontFamily: fonts.semiBold, fontSize: 15 }}>
              Send clipboard to all online
            </Text>
            <Ionicons color={accent} name="chevron-forward" size={18} />
          </Pressable>

          {devices.map((device) => {
            const name = device.nickname || device.name;
            return (
              <Pressable
                key={device.id}
                onPress={() => router.push(`/device/${device.id}`)}
                style={{
                  backgroundColor: card,
                  borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
                  borderRadius: 24,
                  borderWidth: 1,
                  padding: 16,
                }}
              >
                <View style={{ alignItems: "center", flexDirection: "row", gap: 12 }}>
                  <View
                    style={{
                      alignItems: "center",
                      backgroundColor: device.online
                        ? isDark
                          ? "rgba(122,162,255,0.18)"
                          : "rgba(47,107,255,0.12)"
                        : isDark
                          ? "rgba(255,255,255,0.06)"
                          : "rgba(0,0,0,0.05)",
                      borderRadius: 16,
                      height: 48,
                      justifyContent: "center",
                      width: 48,
                    }}
                  >
                    <Ionicons
                      color={device.online ? accent : muted}
                      name={device.type === "mobile" ? "phone-portrait-outline" : "laptop-outline"}
                      size={22}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
                      <Text
                        numberOfLines={1}
                        style={{ color: ink, flexShrink: 1, fontFamily: fonts.semiBold, fontSize: 16 }}
                      >
                        {name}
                      </Text>
                      <View
                        style={{
                          backgroundColor: device.online ? "#34C759" : muted,
                          borderRadius: 99,
                          height: 8,
                          width: 8,
                        }}
                      />
                    </View>
                    <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, marginTop: 2 }}>
                      {platformLabel(device.platform)} · {connectionLabel(device.connectionType)}
                    </Text>
                    <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 4 }}>
                      Seen {formatRelativeTime(device.lastSeenAt)}
                      {device.status?.batteryLevel != null
                        ? ` · ${device.status.batteryLevel}% battery`
                        : ""}
                    </Text>
                  </View>
                  <Ionicons color={muted} name="chevron-forward" size={18} />
                </View>

                <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
                  <Pressable
                    disabled={!device.online}
                    onPress={() => store.pushClipboardText("Shared from mobile", [device.id])}
                    style={{
                      backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                      borderRadius: 999,
                      opacity: device.online ? 1 : 0.45,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                    }}
                  >
                    <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>Clipboard</Text>
                  </Pressable>
                  <Pressable
                    disabled={!device.online}
                    onPress={() =>
                      store.startFileTransfer(
                        [device.id],
                        [{ name: "from-phone.jpg", size: 2_400_000, mimeType: "image/jpeg" }],
                      )
                    }
                    style={{
                      backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                      borderRadius: 999,
                      opacity: device.online ? 1 : 0.45,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                    }}
                  >
                    <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>Send file</Text>
                  </Pressable>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
