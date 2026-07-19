import {
  connectionLabel,
  formatBytes,
  formatFingerprint,
  formatRelativeTime,
  platformLabel,
} from "@lyra-sync-app/core";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";

import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function DeviceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const device = useLyraSelector((s) => s.devices.find((d) => d.id === id));
  const [path, setPath] = useState("/");
  const [nickname, setNickname] = useState(device?.nickname ?? "");
  const cacheKey = `${id}::${path}`;
  const entries = useLyraSelector((s) => s.remoteFsCache[cacheKey] ?? []);

  useEffect(() => {
    if (!id) return;
    void store.fetchRemoteFiles(id, path);
  }, [id, path, store]);
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#141A26" : "#FFFFFF";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  if (!device) {
    return (
      <View style={{ backgroundColor: bg, flex: 1, padding: 20 }}>
        <Text style={{ color: muted }}>Device not found</Text>
      </View>
    );
  }

  const parentPath = path === "/" ? null : path.split("/").slice(0, -1).join("/") || "/";

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <Stack.Screen
        options={{
          title: device.nickname || device.name,
          headerStyle: { backgroundColor: bg },
          headerTintColor: ink,
          headerShadowVisible: false,
        }}
      />
      <ScrollView contentContainerStyle={{ gap: 16, padding: 16, paddingBottom: 40 }}>
        <View style={{ backgroundColor: card, borderRadius: 24, padding: 16 }}>
          <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 18 }}>
            {device.nickname || device.name}
          </Text>
          <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, marginTop: 4 }}>
            {platformLabel(device.platform)} · {connectionLabel(device.connectionType)} ·{" "}
            {device.online ? "Online" : "Offline"}
          </Text>
          <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 8 }}>
            Seen {formatRelativeTime(device.lastSeenAt)}
          </Text>
          <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 4 }}>
            {formatFingerprint(device.fingerprint)}
          </Text>

          <TextInput
            onChangeText={setNickname}
            placeholder="Nickname"
            placeholderTextColor={muted}
            style={{
              borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
              borderRadius: 999,
              borderWidth: 1,
              color: ink,
              fontFamily: fonts.medium,
              marginTop: 14,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
            value={nickname}
          />
          <Pressable
            onPress={() => store.renameDevice(device.id, nickname)}
            style={{
              alignSelf: "flex-start",
              backgroundColor: accent,
              borderRadius: 999,
              marginTop: 10,
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
              Save nickname
            </Text>
          </Pressable>

          <Toggle
            label="Auto-accept transfers"
            value={device.autoAcceptTransfers}
            onValueChange={(v) => store.updateDeviceSettings(device.id, { autoAcceptTransfers: v })}
            ink={ink}
            accent={accent}
          />
          <Toggle
            label="Auto-accept clipboard"
            value={device.autoAcceptClipboard}
            onValueChange={(v) => store.updateDeviceSettings(device.id, { autoAcceptClipboard: v })}
            ink={ink}
            accent={accent}
          />
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Pressable
            disabled={!device.online}
            onPress={() => {
              void (async () => {
                let text = "";
                try {
                  text = (await Clipboard.getStringAsync()) || "";
                } catch {
                  // ignore
                }
                store.pushClipboardText(text || "Shared from device detail", [device.id]);
              })();
            }}
            style={{
              backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
              borderRadius: 999,
              opacity: device.online ? 1 : 0.45,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>Send clipboard</Text>
          </Pressable>
          <Pressable
            disabled={!device.online}
            onPress={() => {
              void (async () => {
                try {
                  const result = await DocumentPicker.getDocumentAsync({
                    multiple: true,
                    copyToCacheDirectory: true,
                  });
                  if (result.canceled || !result.assets?.length) return;
                  store.startFileTransfer(
                    [device.id],
                    result.assets.map((a) => ({
                      name: a.name,
                      size: a.size ?? 1024,
                      mimeType: a.mimeType ?? undefined,
                    })),
                  );
                } catch {
                  // cancelled
                }
              })();
            }}
            style={{
              backgroundColor: accent,
              borderRadius: 999,
              opacity: device.online ? 1 : 0.45,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
              Upload files
            </Text>
          </Pressable>
        </View>

        <View style={{ backgroundColor: card, borderRadius: 24, padding: 16 }}>
          <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>Remote files</Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            {parentPath !== null && (
              <Pressable onPress={() => setPath(parentPath)}>
                <Text style={{ color: accent, fontFamily: fonts.medium }}>Up</Text>
              </Pressable>
            )}
            <Text style={{ color: muted, flex: 1, fontFamily: fonts.regular, fontSize: 12 }}>
              {path}
            </Text>
          </View>
          {!device.online ? (
            <Text style={{ color: muted, marginTop: 16, textAlign: "center" }}>Device offline</Text>
          ) : (
            <View style={{ marginTop: 10 }}>
              {entries.map((entry) => (
                <Pressable
                  key={entry.path}
                  onPress={() => {
                    if (entry.isDirectory) setPath(entry.path);
                  }}
                  style={{
                    borderTopColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
                    borderTopWidth: 1,
                    flexDirection: "row",
                    justifyContent: "space-between",
                    paddingVertical: 12,
                  }}
                >
                  <Text style={{ color: ink, flex: 1, fontFamily: fonts.medium, fontSize: 14 }}>
                    {entry.isDirectory ? "📁 " : "📄 "}
                    {entry.name}
                  </Text>
                  {!entry.isDirectory && entry.size != null ? (
                    <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12 }}>
                      {formatBytes(entry.size)}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          )}
        </View>

        <Pressable
          onPress={() => store.unpairDevice(device.id)}
          style={{
            alignItems: "center",
            backgroundColor: "rgba(255,69,58,0.12)",
            borderRadius: 999,
            paddingVertical: 14,
          }}
        >
          <Text style={{ color: "#FF453A", fontFamily: fonts.semiBold }}>Unpair device</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Toggle({
  label,
  value,
  onValueChange,
  ink,
  accent,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  ink: string;
  accent: string;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        flexDirection: "row",
        justifyContent: "space-between",
        marginTop: 14,
      }}
    >
      <Text style={{ color: ink, flex: 1, fontFamily: fonts.medium, fontSize: 14 }}>{label}</Text>
      <Switch
        trackColor={{ false: "#767577", true: accent }}
        value={value}
        onValueChange={onValueChange}
      />
    </View>
  );
}
