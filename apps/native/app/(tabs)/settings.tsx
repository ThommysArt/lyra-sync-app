import { formatFingerprint } from "@lyra-sync-app/core";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useState } from "react";

import { ScreenHeader, useTabBottomPadding } from "@/components/ui/screen-header";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function SettingsScreen() {
  const store = useLyraStore();
  const { isDark, toggleTheme } = useAppTheme();
  const bottomPad = useTabBottomPadding();
  const identity = useLyraSelector((s) => s.identity);
  const settings = useLyraSelector((s) => s.settings);
  const devices = useLyraSelector((s) => s.devices);
  const [name, setName] = useState(identity?.name ?? "");
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#141A26" : "#FFFFFF";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <ScreenHeader title="Settings" subtitle="Identity and defaults" />

        <View style={{ gap: 16, paddingHorizontal: 16 }}>
          <View style={{ backgroundColor: card, borderRadius: 24, padding: 16 }}>
            <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 12 }}>This device</Text>
            <TextInput
              onChangeText={setName}
              style={{
                borderBottomColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
                borderBottomWidth: 1,
                color: ink,
                fontFamily: fonts.semiBold,
                fontSize: 18,
                marginTop: 8,
                paddingVertical: 8,
              }}
              value={name}
            />
            <Pressable
              onPress={() => store.setDeviceName(name)}
              style={{
                alignSelf: "flex-start",
                backgroundColor: accent,
                borderRadius: 999,
                marginTop: 12,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>Save name</Text>
            </Pressable>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 14 }}>
              Fingerprint
            </Text>
            <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13, marginTop: 4 }}>
              {identity ? formatFingerprint(identity.fingerprint) : "—"}
            </Text>
          </View>

          <View style={{ backgroundColor: card, borderRadius: 24, overflow: "hidden" }}>
            <Row
              label="Dark mode"
              value={isDark}
              onValueChange={() => toggleTheme()}
              ink={ink}
              accent={accent}
            />
            <Row
              label="Clipboard sync"
              value={settings.clipboardSyncEnabled}
              onValueChange={(v) => store.updateSettings({ clipboardSyncEnabled: v })}
              ink={ink}
              accent={accent}
            />
            <Row
              label="Auto-accept transfers"
              value={settings.autoAcceptTransfers}
              onValueChange={(v) => store.updateSettings({ autoAcceptTransfers: v })}
              ink={ink}
              accent={accent}
            />
            <Row
              label="Auto-accept clipboard"
              value={settings.autoAcceptClipboard}
              onValueChange={(v) => store.updateSettings({ autoAcceptClipboard: v })}
              ink={ink}
              accent={accent}
            />
            <Row
              label="Network discovery"
              value={settings.discoveryEnabled}
              onValueChange={(v) => store.updateSettings({ discoveryEnabled: v })}
              ink={ink}
              accent={accent}
            />
            <Row
              label="Tailscale"
              value={settings.tailscaleEnabled}
              onValueChange={(v) => store.updateSettings({ tailscaleEnabled: v })}
              ink={ink}
              accent={accent}
              last
            />
          </View>

          <View style={{ backgroundColor: card, borderRadius: 24, padding: 16 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>
              Paired devices ({devices.length})
            </Text>
            {devices.map((d) => (
              <View
                key={d.id}
                style={{
                  borderTopColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderTopWidth: 1,
                  flexDirection: "row",
                  justifyContent: "space-between",
                  marginTop: 12,
                  paddingTop: 12,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 14 }}>
                    {d.nickname || d.name}
                  </Text>
                  <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12 }}>
                    {d.online ? "Online" : "Offline"}
                  </Text>
                </View>
                <Pressable onPress={() => store.unpairDevice(d.id)}>
                  <Text style={{ color: "#FF453A", fontFamily: fonts.medium, fontSize: 13 }}>
                    Unpair
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function Row({
  label,
  value,
  onValueChange,
  ink,
  accent,
  last,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  ink: string;
  accent: string;
  last?: boolean;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        borderBottomColor: "rgba(127,127,127,0.12)",
        borderBottomWidth: last ? 0 : 1,
        flexDirection: "row",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <Text style={{ color: ink, flex: 1, fontFamily: fonts.medium, fontSize: 15 }}>{label}</Text>
      <Switch
        trackColor={{ false: "#767577", true: accent }}
        thumbColor="#fff"
        value={value}
        onValueChange={onValueChange}
      />
    </View>
  );
}
