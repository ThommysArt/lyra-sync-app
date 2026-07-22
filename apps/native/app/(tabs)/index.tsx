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
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

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
    s.devices
      .filter((d) => d.authSecret || (d.showInMainList && d.id.startsWith("demo_")))
      .sort((a, b) => Number(b.online) - Number(a.online)),
  );
  const nearby = useLyraSelector((s) =>
    s.devices
      .filter((d) => !d.authSecret && !d.id.startsWith("demo_") && Boolean(d.host))
      .sort((a, b) => Number(b.online) - Number(a.online)),
  );
  const discoveryEnabled = useLyraSelector((s) => s.settings.discoveryEnabled);
  const tailscaleEnabled = useLyraSelector((s) => s.settings.tailscaleEnabled);
  const tailscaleHints = useLyraSelector((s) => s.tailscalePeerHints);
  const [openUrl, setOpenUrl] = useState("");
  const [trustBusy, setTrustBusy] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("53317");
  const [manualName, setManualName] = useState("");
  const [manualAsTs, setManualAsTs] = useState(true);
  const [manualError, setManualError] = useState<string | null>(null);
  const onlineIds = useLyraSelector((s) =>
    s.devices.filter((d) => d.online && (d.authSecret || d.id.startsWith("demo_"))).map((d) => d.id),
  );
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#e5e5e5" : "#333333";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#202020" : "#FFFFFF";
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
      const prepared = await Promise.all(
        result.assets.map(async (a) => {
          let bytes: Uint8Array | undefined;
          try {
            if (a.uri && (a.size ?? 0) <= 32 * 1024 * 1024) {
              const res = await fetch(a.uri);
              const buf = await res.arrayBuffer();
              bytes = new Uint8Array(buf);
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
      store.startFileTransfer([deviceId], prepared);
    } catch {
      // user cancelled or picker unavailable
    }
  };

  const scanTailscale = async () => {
    if (!tailscaleEnabled) return;
    setScanBusy(true);
    try {
      // Mobile cannot run `tailscale status` locally; probe known + hint peers
      // and refresh discovery so LAN/Tailscale hosts with Lyra respond.
      await store.refreshDiscovery();
      await store.probeTailscalePeers();
    } finally {
      setScanBusy(false);
    }
  };

  const submitDetails = () => {
    const host = manualHost.trim();
    const port = Number(manualPort) || 53317;
    if (!host) {
      setManualError("Host or IP is required");
      return;
    }
    const result = store.addManualPeer({
      host,
      port,
      name: manualName.trim() || undefined,
      asTailscale: manualAsTs,
    });
    if (!result.ok) {
      setManualError(result.error);
      return;
    }
    setManualError(null);
    setManualHost("");
    setManualName("");
    setManualPort("53317");
    setDetailsOpen(false);
    void store.probePeerAddress({ host: result.device.host!, port: result.device.port });
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
                onPress={() => void store.refreshDiscovery()}
                style={{
                  alignItems: "center",
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 8,
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
                  borderRadius: 8,
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
          {/* Tailscale: scan-first */}
          <View style={{ backgroundColor: card, borderRadius: 12, gap: 10, padding: 14 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 14 }}>
              Tailscale
            </Text>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12 }}>
              Multicast does not cross tailnets. Scan for peers that already have a Lyra address,
              or enter host + port manually.
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Pressable
                disabled={!tailscaleEnabled || scanBusy}
                onPress={() => void scanTailscale()}
                style={{
                  alignItems: "center",
                  backgroundColor: accent,
                  borderRadius: 8,
                  flexDirection: "row",
                  gap: 6,
                  opacity: !tailscaleEnabled || scanBusy ? 0.5 : 1,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <Ionicons color="#fff" name="radar-outline" size={16} />
                <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                  {scanBusy ? "Scanning…" : "Scan Tailscale"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setManualAsTs(true);
                  setManualError(null);
                  setDetailsOpen(true);
                }}
                style={{
                  alignItems: "center",
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 8,
                  flexDirection: "row",
                  gap: 6,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <Ionicons color={ink} name="create-outline" size={16} />
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>
                  Enter details
                </Text>
              </Pressable>
            </View>
            {!tailscaleEnabled ? (
              <Text style={{ color: "#d97706", fontFamily: fonts.regular, fontSize: 11 }}>
                Enable Tailscale in Settings to scan and probe 100.x peers.
              </Text>
            ) : null}
            {tailscaleHints.length > 0 ? (
              <View style={{ gap: 6, marginTop: 4 }}>
                <Text style={{ color: muted, fontFamily: fonts.semiBold, fontSize: 12 }}>
                  Discovered on your tailnet
                </Text>
                {tailscaleHints.slice(0, 8).map((h) => (
                  <View
                    key={`${h.host}:${h.port ?? 53317}`}
                    style={{
                      alignItems: "center",
                      borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                      borderRadius: 10,
                      borderWidth: 1,
                      flexDirection: "row",
                      justifyContent: "space-between",
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}
                      >
                        {h.name || h.host}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={{ color: muted, fontFamily: fonts.regular, fontSize: 11 }}
                      >
                        {h.host}:{h.port ?? 53317}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => {
                        const result = store.addManualPeer({
                          host: h.host,
                          port: h.port ?? 53317,
                          name: h.name,
                          asTailscale: true,
                        });
                        if (result.ok) {
                          void store.probePeerAddress({
                            host: h.host,
                            port: h.port ?? 53317,
                          });
                        }
                      }}
                      style={{
                        backgroundColor: isDark
                          ? "rgba(122,162,255,0.2)"
                          : "rgba(47,107,255,0.12)",
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                      }}
                    >
                      <Text style={{ color: accent, fontFamily: fonts.semiBold, fontSize: 12 }}>
                        Add
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </View>

          {/* LAN find (secondary) */}
          <Pressable
            onPress={() => {
              setManualAsTs(false);
              setManualError(null);
              setDetailsOpen(true);
            }}
            style={{
              alignItems: "center",
              backgroundColor: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
              borderRadius: 12,
              flexDirection: "row",
              gap: 10,
              paddingHorizontal: 14,
              paddingVertical: 12,
            }}
          >
            <Ionicons color={muted} name="add-circle-outline" size={20} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>
                Add peer by address
              </Text>
              <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 11 }}>
                LAN IP or host · port · optional nickname
              </Text>
            </View>
            <Ionicons color={muted} name="chevron-forward" size={18} />
          </Pressable>

          {nearby.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: muted, fontFamily: fonts.semiBold, fontSize: 13 }}>
                Nearby — not paired
              </Text>
              {nearby.map((device) => (
                <View
                  key={device.id}
                  style={{
                    backgroundColor: card,
                    borderColor: isDark ? "rgba(122,162,255,0.25)" : "rgba(47,107,255,0.2)",
                    borderRadius: 12,
                    borderStyle: "dashed",
                    borderWidth: 1,
                    padding: 14,
                  }}
                >
                  <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 15 }}>
                    {device.nickname || device.name}
                  </Text>
                  <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 2 }}>
                    {device.host}
                    {device.port ? `:${device.port}` : ""} · {device.online ? "online" : "offline"}
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                    <Pressable
                      disabled={!device.host || trustBusy === device.id}
                      onPress={() => {
                        setTrustBusy(device.id);
                        void store.trustDevice(device.id).finally(() => setTrustBusy(null));
                      }}
                      style={{
                        backgroundColor: accent,
                        borderRadius: 8,
                        opacity: trustBusy === device.id ? 0.7 : 1,
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                      }}
                    >
                      <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                        {trustBusy === device.id ? "Pairing…" : "Pair"}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => store.unpairDevice(device.id)}
                      style={{
                        backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                        borderRadius: 8,
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                      }}
                    >
                      <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>
                        Dismiss
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <Pressable
            onPress={() => {
              void sendClipboard(onlineIds);
            }}
            style={{
              alignItems: "center",
              backgroundColor: isDark ? "rgba(122,162,255,0.15)" : "rgba(47,107,255,0.1)",
              borderRadius: 12,
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

          <View style={{ backgroundColor: card, borderRadius: 12, gap: 10, padding: 14 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 14 }}>
              Open URL on devices
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setOpenUrl}
              placeholder="https://…"
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
              value={openUrl}
            />
            <Pressable
              disabled={!openUrl.trim() || onlineIds.length === 0}
              onPress={() => {
                store.sendUrl(openUrl.trim(), onlineIds);
                setOpenUrl("");
              }}
              style={{
                alignItems: "center",
                alignSelf: "flex-start",
                backgroundColor: accent,
                borderRadius: 8,
                opacity: openUrl.trim() && onlineIds.length > 0 ? 1 : 0.5,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>Open</Text>
            </Pressable>
          </View>

          {devices.map((device) => {
            const name = device.nickname || device.name;
            return (
              <Pressable
                key={device.id}
                onPress={() => router.push(`/device/${device.id}`)}
                style={{
                  backgroundColor: card,
                  borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
                  borderRadius: 14,
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
                      borderRadius: 10,
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
                      borderRadius: 8,
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
                      borderRadius: 8,
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

      <Modal
        animationType="slide"
        transparent
        visible={detailsOpen}
        onRequestClose={() => setDetailsOpen(false)}
      >
        <Pressable
          onPress={() => setDetailsOpen(false)}
          style={{
            backgroundColor: "rgba(0,0,0,0.45)",
            flex: 1,
            justifyContent: "flex-end",
          }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: card,
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              gap: 12,
              padding: 20,
              paddingBottom: 32,
            }}
          >
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 17 }}>
              {manualAsTs ? "Add Tailscale peer" : "Add peer by address"}
            </Text>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12 }}>
              Host may include port (e.g. 100.83.145.32:53319). Not trusted until you Pair.
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setManualHost}
              placeholder={manualAsTs ? "100.x.x.x or MagicDNS" : "192.168.1.42"}
              placeholderTextColor={muted}
              style={{
                backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                borderRadius: 12,
                color: ink,
                fontFamily: fonts.regular,
                fontSize: 15,
                paddingHorizontal: 12,
                paddingVertical: 10,
              }}
              value={manualHost}
            />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
                onChangeText={setManualPort}
                placeholder="Port"
                placeholderTextColor={muted}
                style={{
                  backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                  borderRadius: 12,
                  color: ink,
                  flex: 1,
                  fontFamily: fonts.regular,
                  fontSize: 15,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
                value={manualPort}
              />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setManualName}
                placeholder="Nickname (optional)"
                placeholderTextColor={muted}
                style={{
                  backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                  borderRadius: 12,
                  color: ink,
                  flex: 2,
                  fontFamily: fonts.regular,
                  fontSize: 15,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
                value={manualName}
              />
            </View>
            <Pressable
              onPress={() => setManualAsTs((v) => !v)}
              style={{ alignItems: "center", flexDirection: "row", gap: 8 }}
            >
              <View
                style={{
                  alignItems: "center",
                  backgroundColor: manualAsTs ? accent : isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 6,
                  height: 22,
                  justifyContent: "center",
                  width: 22,
                }}
              >
                {manualAsTs ? <Ionicons color="#fff" name="checkmark" size={14} /> : null}
              </View>
              <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>
                Mark as Tailscale address
              </Text>
            </Pressable>
            {manualError ? (
              <Text style={{ color: "#ef4444", fontFamily: fonts.regular, fontSize: 12 }}>
                {manualError}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
              <Pressable
                onPress={() => setDetailsOpen(false)}
                style={{
                  alignItems: "center",
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 10,
                  flex: 1,
                  paddingVertical: 12,
                }}
              >
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 14 }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submitDetails}
                style={{
                  alignItems: "center",
                  backgroundColor: accent,
                  borderRadius: 10,
                  flex: 1,
                  paddingVertical: 12,
                }}
              >
                <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 14 }}>
                  Add peer
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
