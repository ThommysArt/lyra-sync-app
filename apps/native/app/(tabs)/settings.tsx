import { formatFingerprint } from "@lyra-sync-app/core";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useState } from "react";

import { ScreenHeader, useTabBottomPadding } from "@/components/ui/screen-header";
import { IosSwitch } from "@/components/ui/ios-switch";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function SettingsScreen() {
  const store = useLyraStore();
  const { isDark, toggleTheme } = useAppTheme();
  const bottomPad = useTabBottomPadding();
  const identity = useLyraSelector((s) => s.identity);
  const settings = useLyraSelector((s) => s.settings);
  const devices = useLyraSelector((s) =>
    s.devices.filter((d) => d.authSecret || d.id.startsWith("demo_")),
  );
  const peerServer = useLyraSelector((s) => s.peerServer);
  const lastProbeSummary = useLyraSelector((s) => s.lastProbeSummary);
  const hasTopBanners = useLyraSelector(
    (s) =>
      s.incomingPairRequests.length > 0 || s.transfers.some((t) => t.status === "conflict"),
  );
  const [name, setName] = useState(identity?.name ?? "");
  const [probeBusy, setProbeBusy] = useState(false);
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#141A26" : "#FFFFFF";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <ScreenHeader
          title="Settings"
          subtitle="Identity and defaults"
          skipTopInset={hasTopBanners}
        />

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
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 8 }}>
              Platform · {identity?.platform ?? "—"} · id {identity?.id?.slice(0, 10) ?? "—"}
            </Text>
          </View>

          <View style={{ backgroundColor: card, borderRadius: 24, padding: 16 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>Network</Text>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 13, marginTop: 6 }}>
              {peerServer.running
                ? `Peer server on :${peerServer.port ?? "—"}`
                : "Peer server idle"}
              {" · "}
              {peerServer.discoveryActive ? "Discovery on" : "Discovery off"}
            </Text>
            <View
              style={{
                alignSelf: "flex-start",
                backgroundColor: isDark ? "rgba(122,162,255,0.18)" : "rgba(47,107,255,0.12)",
                borderRadius: 999,
                marginTop: 10,
                paddingHorizontal: 10,
                paddingVertical: 4,
              }}
            >
              <Text style={{ color: accent, fontFamily: fonts.medium, fontSize: 12 }}>
                {peerServer.running ? "Desktop / Node" : "Browser / Expo web"}
              </Text>
            </View>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 10 }}>
              {peerServer.running
                ? "Listening for peers on your LAN."
                : "No listen socket here — probe peers via HTTP /lyra/info, or run desktop / peer-server on :" +
                  String(settings.peerListenPort)}
            </Text>
            {lastProbeSummary ? (
              <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 8 }}>
                {lastProbeSummary}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              <Pressable
                disabled={probeBusy}
                onPress={() => {
                  setProbeBusy(true);
                  void Promise.resolve(store.refreshDiscovery()).finally(() => setProbeBusy(false));
                }}
                style={{
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 999,
                  opacity: probeBusy ? 0.6 : 1,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>
                  Refresh discovery
                </Text>
              </Pressable>
              <Pressable
                disabled={probeBusy || !settings.tailscaleEnabled}
                onPress={() => {
                  setProbeBusy(true);
                  void store.probeTailscalePeers().finally(() => setProbeBusy(false));
                }}
                style={{
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 999,
                  opacity: probeBusy || !settings.tailscaleEnabled ? 0.45 : 1,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>
                  Probe Tailscale
                </Text>
              </Pressable>
            </View>
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
              label="Auto-monitor clipboard"
              value={settings.autoMonitorClipboard}
              onValueChange={(v) => store.updateSettings({ autoMonitorClipboard: v })}
              ink={ink}
              accent={accent}
            />
            <Text
              style={{
                color: muted,
                fontFamily: fonts.regular,
                fontSize: 11,
                marginHorizontal: 16,
                marginBottom: 8,
              }}
            >
              Foreground only. Android background capture needs a future Accessibility Service;
              iOS blocks auto-detect of copy events — use manual Send.
            </Text>
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
            />
            <Row
              label="Verify transfer integrity"
              value={settings.verifyTransferIntegrity}
              onValueChange={(v) => store.updateSettings({ verifyTransferIntegrity: v })}
              ink={ink}
              accent={accent}
              last
            />
          </View>

          <View style={{ backgroundColor: card, borderRadius: 24, padding: 16 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>
              Peer listen port
            </Text>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 4 }}>
              Preferred port for desktop / Node peer server
            </Text>
            <TextInput
              keyboardType="number-pad"
              onChangeText={(t) => {
                const n = Number.parseInt(t, 10);
                if (Number.isFinite(n) && n > 0) {
                  store.updateSettings({ peerListenPort: n });
                }
              }}
              style={{
                borderBottomColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
                borderBottomWidth: 1,
                color: ink,
                fontFamily: fonts.semiBold,
                fontSize: 16,
                marginTop: 8,
                paddingVertical: 8,
              }}
              value={String(settings.peerListenPort)}
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
                    {d.authSecret ? " · trusted" : ""}
                    {d.host ? ` · ${d.host}` : ""}
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
      <IosSwitch accent={accent} value={value} onValueChange={onValueChange} />
    </View>
  );
}
