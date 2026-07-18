import {
  connectionLabel,
  formatRelativeTime,
  platformLabel,
} from "@lyra-sync-app/core";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { ScreenHeader, useTabBottomPadding } from "@/components/ui/screen-header";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function DevicesScreen() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const bottomPad = useTabBottomPadding();
  const hasTopBanners = useLyraSelector(
    (s) =>
      s.incomingPairRequests.length > 0 || s.transfers.some((t) => t.status === "conflict"),
  );
  const devices = useLyraSelector((s) =>
    s.devices.filter((d) => d.showInMainList).sort((a, b) => Number(b.online) - Number(a.online)),
  );
  const discoveryEnabled = useLyraSelector((s) => s.settings.discoveryEnabled);
  const [manualHost, setManualHost] = useState("");
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#141A26" : "#FFFFFF";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  const sendClipboard = async (targetIds: string[]) => {
    let text = "";
    try {
      text = (await Clipboard.getStringAsync()) || "";
    } catch {
      // ignore
    }
    if (!text) text = store.getState().localClipboardText || "Hello from Lyra mobile";
    store.setLocalClipboardText(text);
    store.pushClipboardText(text, targetIds);
  };

  const pickAndSend = async (deviceId: string) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      store.startFileTransfer(
        [deviceId],
        result.assets.map((a) => ({
          name: a.name,
          size: a.size ?? 1024,
          mimeType: a.mimeType ?? undefined,
        })),
      );
    } catch {
      // user cancelled or picker unavailable
    }
  };

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <ScreenHeader
          title="Devices"
          subtitle="Your trusted private network"
          skipTopInset={hasTopBanners}
          right={
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                disabled={!discoveryEnabled}
                onPress={() => store.refreshDiscovery()}
                style={{
                  alignItems: "center",
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 999,
                  height: 40,
                  justifyContent: "center",
                  opacity: discoveryEnabled ? 1 : 0.45,
                  width: 40,
                }}
              >
                <Ionicons color={ink} name="radio-outline" size={20} />
              </Pressable>
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
            </View>
          }
        />

        <View style={{ gap: 12, paddingHorizontal: 16 }}>
          <View style={{ backgroundColor: card, borderRadius: 22, gap: 10, padding: 14 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 14 }}>
              Add by address
            </Text>
            <TextInput
              onChangeText={setManualHost}
              placeholder="IP or hostname"
              placeholderTextColor={muted}
              style={{
                backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                borderRadius: 14,
                color: ink,
                fontFamily: fonts.regular,
                fontSize: 15,
                paddingHorizontal: 12,
                paddingVertical: 10,
              }}
              value={manualHost}
            />
            <Pressable
              disabled={!manualHost.trim()}
              onPress={() => {
                const host = manualHost.trim();
                const result = store.addManualPeer({ host });
                if (result.ok) {
                  setManualHost("");
                  // Live HTTP probe when a peer server is reachable (same as web)
                  void store.probePeerAddress({ host });
                }
              }}
              style={{
                alignItems: "center",
                alignSelf: "flex-start",
                backgroundColor: accent,
                borderRadius: 999,
                opacity: manualHost.trim() ? 1 : 0.5,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                Add peer
              </Text>
            </Pressable>
          </View>

          <Pressable
            onPress={() => {
              const online = devices.filter((d) => d.online).map((d) => d.id);
              void sendClipboard(online);
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
                        style={{
                          color: ink,
                          flexShrink: 1,
                          fontFamily: fonts.semiBold,
                          fontSize: 16,
                        }}
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
                    <Text
                      style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, marginTop: 2 }}
                    >
                      {platformLabel(device.platform)} · {connectionLabel(device.connectionType)}
                    </Text>
                    <Text
                      style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 4 }}
                    >
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
                    onPress={() => void sendClipboard([device.id])}
                    style={{
                      backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                      borderRadius: 999,
                      opacity: device.online ? 1 : 0.45,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                    }}
                  >
                    <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>
                      Clipboard
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={!device.online}
                    onPress={() => void pickAndSend(device.id)}
                    style={{
                      backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                      borderRadius: 999,
                      opacity: device.online ? 1 : 0.45,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                    }}
                  >
                    <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>
                      Send file
                    </Text>
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
