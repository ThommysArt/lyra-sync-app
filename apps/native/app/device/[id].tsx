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
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { IosSwitch } from "@/components/ui/ios-switch";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function DeviceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const device = useLyraSelector((s) => s.devices.find((d) => d.id === id));
  const screenSession = useLyraSelector((s) => (id ? s.screenSessions[id] : undefined));
  const [path, setPath] = useState("/");
  const [nickname, setNickname] = useState(device?.nickname ?? "");
  const [lanHost, setLanHost] = useState(device?.host ?? "");
  const [tsHost, setTsHost] = useState(device?.tailscaleHost ?? "");
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const cacheKey = `${id}::${path}`;
  const entries = useLyraSelector((s) => s.remoteFsCache[cacheKey] ?? []);

  useEffect(() => {
    if (!id) return;
    void store.fetchRemoteFiles(id, path);
  }, [id, path, store]);
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#e5e5e5" : "#333333";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#202020" : "#FFFFFF";
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
        <View style={{ backgroundColor: card, borderRadius: 14, padding: 16 }}>
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
              borderRadius: 8,
              borderWidth: 1,
              color: ink,
              fontFamily: fonts.medium,
              marginTop: 14,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
            value={nickname}
          />
          <Text style={{ color: muted, fontFamily: fonts.semiBold, fontSize: 12, marginTop: 16 }}>
            LAN host / IP
          </Text>
          <TextInput
            onChangeText={setLanHost}
            placeholder="192.168.1.42"
            placeholderTextColor={muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
              borderRadius: 8,
              borderWidth: 1,
              color: ink,
              fontFamily: fonts.medium,
              marginTop: 6,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
            value={lanHost}
          />
          <Text style={{ color: muted, fontFamily: fonts.semiBold, fontSize: 12, marginTop: 12 }}>
            Tailscale IP / MagicDNS
          </Text>
          <TextInput
            onChangeText={setTsHost}
            placeholder="100.83.145.32"
            placeholderTextColor={muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
              borderRadius: 8,
              borderWidth: 1,
              color: ink,
              fontFamily: fonts.medium,
              marginTop: 6,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
            value={tsHost}
          />
          <Pressable
            onPress={() => {
              store.updateDeviceAddress(device.id, {
                host: lanHost.trim() || null,
                tailscaleHost: tsHost.trim() || null,
              });
              const probe = tsHost.trim() || lanHost.trim();
              if (probe) void store.probePeerAddress({ host: probe, port: device.port });
            }}
            style={{
              alignSelf: "flex-start",
              backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
              borderRadius: 8,
              marginTop: 10,
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>
              Save addresses
            </Text>
          </Pressable>

          <Pressable
            onPress={() => store.renameDevice(device.id, nickname)}
            style={{
              alignSelf: "flex-start",
              backgroundColor: accent,
              borderRadius: 8,
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

        <View style={{ backgroundColor: card, borderRadius: 14, padding: 16, gap: 12 }}>
          <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>Screen mirror</Text>
          <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12 }}>
            Xcode-style cast preview. Demo frames always work; live share when peers support it.
          </Text>
          <View
            style={{
              alignSelf: "center",
              backgroundColor: "#0a0a0a",
              borderColor: "#3f3f46",
              borderRadius: 36,
              borderWidth: 10,
              height: 360,
              overflow: "hidden",
              width: 180,
            }}
          >
            {screenSession?.lastFrameDataUrl ? (
              <Image
                source={{ uri: screenSession.lastFrameDataUrl }}
                style={{ height: "100%", width: "100%" }}
                resizeMode="cover"
              />
            ) : (
              <View style={{ alignItems: "center", flex: 1, justifyContent: "center", padding: 16 }}>
                <Text style={{ color: "#71717a", fontFamily: fonts.medium, fontSize: 12, textAlign: "center" }}>
                  Start mirror to cast
                </Text>
              </View>
            )}
          </View>
          {screenSession &&
          (screenSession.status === "active" || screenSession.status === "requesting") ? (
            <Pressable
              disabled={mirrorBusy}
              onPress={() => {
                setMirrorBusy(true);
                void store.stopScreenMirror(device.id).finally(() => setMirrorBusy(false));
              }}
              style={{
                alignItems: "center",
                backgroundColor: "#dc2626",
                borderRadius: 8,
                paddingVertical: 10,
              }}
            >
              <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                Stop mirror
              </Text>
            </Pressable>
          ) : (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                disabled={mirrorBusy}
                onPress={() => {
                  setMirrorBusy(true);
                  void store
                    .startScreenMirror(device.id, { mode: "auto" })
                    .finally(() => setMirrorBusy(false));
                }}
                style={{
                  alignItems: "center",
                  backgroundColor: accent,
                  borderRadius: 8,
                  flex: 1,
                  paddingVertical: 10,
                }}
              >
                <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                  Start mirror
                </Text>
              </Pressable>
              <Pressable
                disabled={mirrorBusy}
                onPress={() => {
                  setMirrorBusy(true);
                  void store
                    .startScreenMirror(device.id, { mode: "demo" })
                    .finally(() => setMirrorBusy(false));
                }}
                style={{
                  alignItems: "center",
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 8,
                  flex: 1,
                  paddingVertical: 10,
                }}
              >
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>
                  Preview
                </Text>
              </Pressable>
            </View>
          )}
          {screenSession?.status === "active" ? (
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 11, textAlign: "center" }}>
              {screenSession.mode} · {screenSession.fps ?? "—"} fps · {screenSession.frameCount} frames
            </Text>
          ) : null}
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
              borderRadius: 8,
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
                  const prepared = await Promise.all(
                    result.assets.map(async (a) => {
                      let bytes: Uint8Array | undefined;
                      try {
                        if (a.uri && (a.size ?? 0) <= 32 * 1024 * 1024) {
                          const res = await fetch(a.uri);
                          bytes = new Uint8Array(await res.arrayBuffer());
                        }
                      } catch {
                        bytes = undefined;
                      }
                      return {
                        name: a.name,
                        size: a.size ?? bytes?.byteLength ?? 1024,
                        mimeType: a.mimeType ?? undefined,
                        bytes,
                      };
                    }),
                  );
                  store.startFileTransfer([device.id], prepared);
                } catch {
                  // cancelled
                }
              })();
            }}
            style={{
              backgroundColor: accent,
              borderRadius: 8,
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

        <View style={{ backgroundColor: card, borderRadius: 14, padding: 16 }}>
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
            borderRadius: 8,
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
      <IosSwitch accent={accent} value={value} onValueChange={onValueChange} />
    </View>
  );
}
