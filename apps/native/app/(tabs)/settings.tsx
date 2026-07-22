import { formatFingerprint } from "@lyra-sync-app/core";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useEffect, useState } from "react";

import { ScreenHeader, useTabBottomPadding } from "@/components/ui/screen-header";
import { IosSwitch } from "@/components/ui/ios-switch";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import {
  defaultDownloadLabel,
  defaultDownloadPath,
  ensureDefaultDownloadDir,
  formatDownloadLabel,
  pickDownloadDirectory,
} from "@/lib/download-location";
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
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadLabel, setDownloadLabel] = useState(
    settings.downloadDirectory
      ? formatDownloadLabel(settings.downloadDirectory)
      : defaultDownloadLabel(),
  );
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#e5e5e5" : "#333333";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#202020" : "#FFFFFF";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  // Create Downloads/Lyra (or Documents/Lyra) once and seed settings when empty
  useEffect(() => {
    let cancelled = false;
    void ensureDefaultDownloadDir().then((ensured) => {
      if (cancelled || !ensured) return;
      if (!store.getState().settings.downloadDirectory) {
        store.updateSettings({ downloadDirectory: ensured.path });
        setDownloadLabel(ensured.label);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    if (settings.downloadDirectory) {
      setDownloadLabel(formatDownloadLabel(settings.downloadDirectory));
      return;
    }
    const def = defaultDownloadPath();
    setDownloadLabel(def ? formatDownloadLabel(def) : defaultDownloadLabel());
  }, [settings.downloadDirectory]);

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <ScreenHeader
          title="Settings"
          subtitle="Identity and defaults"
          skipTopInset={hasTopBanners}
        />

        <View style={{ gap: 16, paddingHorizontal: 16 }}>
          <View style={{ backgroundColor: card, borderRadius: 14, padding: 16 }}>
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
                borderRadius: 8,
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

          <View style={{ backgroundColor: card, borderRadius: 14, padding: 16 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>Network</Text>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 13, marginTop: 6 }}>
              {peerServer.running
                ? `Peer server on :${peerServer.port ?? "—"}`
                : "Peer server idle"}
              {" · "}
              {peerServer.running || peerServer.discoveryActive
                ? "Discovery on"
                : settings.discoveryEnabled
                  ? "Discovery ready (HTTP probe)"
                  : "Discovery off"}
            </Text>
            <View
              style={{
                alignSelf: "flex-start",
                backgroundColor: isDark ? "rgba(122,162,255,0.18)" : "rgba(47,107,255,0.12)",
                borderRadius: 8,
                marginTop: 10,
                paddingHorizontal: 10,
                paddingVertical: 4,
              }}
            >
              <Text style={{ color: accent, fontFamily: fonts.medium, fontSize: 12 }}>
                {peerServer.running
                  ? Platform.OS === "web"
                    ? "Desktop / Node"
                    : "This device (mobile)"
                  : Platform.OS === "web"
                    ? "Browser / Expo web"
                    : "Mobile · client only"}
              </Text>
            </View>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 10 }}>
              {peerServer.running
                ? peerServer.lanHost
                  ? `Listening at ${peerServer.lanHost}:${peerServer.port ?? "—"} — other devices can pair and push here.`
                  : "Listening for peers on your LAN / Tailscale."
                : Platform.OS === "web"
                  ? "No listen socket here — probe peers via HTTP /lyra/info, or run desktop / peer-server on :" +
                    String(settings.peerListenPort)
                  : peerServer.lastError
                    ? peerServer.lastError
                    : "Peer server not running. Use a native dev/preview build (not Expo Go) so this phone can host a code and receive pushes."}
            </Text>
            {peerServer.url ? (
              <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 11, marginTop: 6 }}>
                {peerServer.url}
              </Text>
            ) : null}
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
                  borderRadius: 8,
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
                  borderRadius: 8,
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

          <View style={{ backgroundColor: card, borderRadius: 14, overflow: "hidden" }}>
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

          <View style={{ backgroundColor: card, borderRadius: 14, padding: 16 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>
              Download location
            </Text>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 4 }}>
              Where received files are saved on this device.
              {Platform.OS === "android"
                ? " Browse opens the system folder picker."
                : Platform.OS === "ios"
                  ? " iOS apps save into the app Documents sandbox (share out from Transfers)."
                  : ""}
            </Text>
            <Text
              style={{
                color: ink,
                fontFamily: fonts.medium,
                fontSize: 13,
                marginTop: 10,
              }}
              numberOfLines={3}
            >
              {downloadLabel}
            </Text>
            {downloadError ? (
              <Text style={{ color: "#FF453A", fontFamily: fonts.medium, fontSize: 12, marginTop: 6 }}>
                {downloadError}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              <Pressable
                disabled={downloadBusy}
                onPress={() => {
                  setDownloadBusy(true);
                  setDownloadError(null);
                  void pickDownloadDirectory()
                    .then((res) => {
                      if (res.ok) {
                        store.updateSettings({ downloadDirectory: res.path });
                        setDownloadLabel(res.label);
                      } else if (!res.cancelled) {
                        setDownloadError(res.error ?? "Could not pick folder");
                      }
                    })
                    .finally(() => setDownloadBusy(false));
                }}
                style={{
                  backgroundColor: accent,
                  borderRadius: 8,
                  opacity: downloadBusy ? 0.7 : 1,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                  {downloadBusy
                    ? "…"
                    : Platform.OS === "android"
                      ? "Browse folder"
                      : Platform.OS === "ios"
                        ? "Use App Documents"
                        : "Choose folder"}
                </Text>
              </Pressable>
              <Pressable
                disabled={downloadBusy || !settings.downloadDirectory}
                onPress={() => {
                  store.updateSettings({ downloadDirectory: undefined });
                  const def = defaultDownloadPath();
                  setDownloadLabel(def ? formatDownloadLabel(def) : defaultDownloadLabel());
                  setDownloadError(null);
                }}
                style={{
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  borderRadius: 8,
                  opacity: settings.downloadDirectory ? 1 : 0.45,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>Reset</Text>
              </Pressable>
            </View>
          </View>

          <View style={{ backgroundColor: card, borderRadius: 14, padding: 16 }}>
            <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>
              Peer listen port
            </Text>
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 4 }}>
              Preferred listen port for this device&apos;s peer server (default 53317). Restart the
              app after changing.
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

          <View style={{ backgroundColor: card, borderRadius: 14, padding: 16 }}>
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
