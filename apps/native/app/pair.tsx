import { formatFingerprint } from "@lyra-sync-app/core";
import { Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Network from "expo-network";
import QRCode from "react-native-qrcode-svg";

import { QrScanner } from "@/components/qr-scanner";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function PairScreen() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const identity = useLyraSelector((s) => s.identity);
  const active = useLyraSelector((s) => s.activePairing);
  const outbound = useLyraSelector((s) => s.outboundPairing);
  const peerRunning = useLyraSelector((s) => s.peerServer.running);
  const lanHint = useLyraSelector((s) => s.localLanHint);
  const [code, setCode] = useState("");
  const [hostHint, setHostHint] = useState("");
  const [qrPaste, setQrPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [pasteBusy, setPasteBusy] = useState(false);
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const accent = isDark ? ACCENT_DARK : ACCENT;
  const card = isDark ? "#141A26" : "#fff";

  // Expo Go / native: refresh LAN IP for /24 scan before pairing
  useEffect(() => {
    void Network.getIpAddressAsync()
      .then((ip) => {
        if (ip && ip !== "0.0.0.0") store.setLocalLanHint(ip);
      })
      .catch(() => undefined);
  }, [store]);

  const qrValue = useMemo(
    () => (active ? JSON.stringify(active.payload) : ""),
    [active],
  );

  const canHostCode = peerRunning;
  const isExpoGo =
    // @ts-expect-error Constants may exist in Expo
    typeof globalThis !== "undefined" &&
    // heuristic: Expo Go has no peer server and runs on native
    !peerRunning &&
    (Platform.OS === "ios" || Platform.OS === "android");

  const applyScannedPayload = useCallback(
    async (data: string) => {
      const result = await store.applyPairingPayload(data.trim());
      if (!result.ok) {
        // store already notifies; return for scanner haptics
        return { ok: false as const, error: result.error };
      }
      if ("device" in result) {
        return { ok: true as const, deviceName: result.device.name };
      }
      if ("pending" in result && result.pending) {
        return {
          ok: true as const,
          deviceName: "deviceName" in result ? result.deviceName : "device",
        };
      }
      return { ok: true as const, deviceName: "device" };
    },
    [store],
  );

  const onSubmitCode = () => {
    if (busy || code.trim().length < 4) return;
    setBusy(true);
    void store
      .submitPairingCode(code, hostHint.trim() ? { host: hostHint.trim() } : undefined)
      .then((result) => {
        if (result.ok) {
          setCode("");
          if ("device" in result) {
            // success toast via store
          }
        }
        // errors already toast via store.notify
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <Stack.Screen options={{ title: "Pair device", headerShadowVisible: false }} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 14, marginBottom: 12 }}>
          <Text style={{ fontFamily: fonts.semiBold, color: ink }}>Desktop shows the code.</Text>{" "}
          This phone enters it. Same Wi‑Fi required.
        </Text>

        {isExpoGo ? (
          <View
            style={{
              backgroundColor: isDark ? "rgba(251,191,36,0.12)" : "rgba(245,158,11,0.12)",
              borderRadius: 16,
              marginBottom: 16,
              padding: 12,
            }}
          >
            <Text style={{ color: isDark ? "#FCD34D" : "#B45309", fontFamily: fonts.semiBold, fontSize: 13 }}>
              Expo Go limitation
            </Text>
            <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 12, marginTop: 4 }}>
              Expo Go cannot host a pairing code (no peer server / multicast). Use{" "}
              <Text style={{ fontFamily: fonts.semiBold }}>Enter code</Text> with the code from the
              desktop app. Prefer scanning the desktop QR when possible.
            </Text>
          </View>
        ) : null}

        {outbound?.status === "waiting" ? (
          <View
            style={{
              backgroundColor: isDark ? "rgba(122,162,255,0.15)" : "rgba(47,107,255,0.1)",
              borderRadius: 16,
              marginBottom: 16,
              padding: 12,
            }}
          >
            <Text style={{ color: accent, fontFamily: fonts.semiBold, fontSize: 14 }}>
              Waiting for {outbound.hostName} to accept…
            </Text>
          </View>
        ) : null}

        {lanHint ? (
          <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 11, marginBottom: 12 }}>
            This device LAN IP: {lanHint}
          </Text>
        ) : null}

        {/* Enter code — primary path on mobile */}
        <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>Enter desktop code</Text>
        <TextInput
          autoCapitalize="characters"
          editable={!busy}
          onChangeText={(t) => setCode(t.toUpperCase())}
          placeholder="ABC123"
          placeholderTextColor={muted}
          style={{
            backgroundColor: card,
            borderRadius: 999,
            color: ink,
            fontFamily: fonts.semiBold,
            fontSize: 20,
            letterSpacing: 4,
            marginTop: 10,
            opacity: busy ? 0.7 : 1,
            paddingHorizontal: 18,
            paddingVertical: 14,
            textAlign: "center",
          }}
          value={code}
        />
        <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 12, marginTop: 14 }}>
          Desktop IP (optional — if scan fails)
        </Text>
        <TextInput
          autoCapitalize="none"
          editable={!busy}
          keyboardType="numbers-and-punctuation"
          onChangeText={setHostHint}
          placeholder="192.168.1.152"
          placeholderTextColor={muted}
          style={{
            backgroundColor: card,
            borderRadius: 999,
            color: ink,
            fontFamily: fonts.medium,
            fontSize: 15,
            marginTop: 8,
            paddingHorizontal: 18,
            paddingVertical: 12,
          }}
          value={hostHint}
        />
        <Pressable
          disabled={busy || code.trim().length < 4}
          onPress={onSubmitCode}
          style={{
            alignItems: "center",
            backgroundColor: accent,
            borderRadius: 999,
            flexDirection: "row",
            gap: 8,
            justifyContent: "center",
            marginTop: 14,
            opacity: busy || code.trim().length < 4 ? 0.65 : 1,
            paddingVertical: 14,
          }}
        >
          {busy ? <ActivityIndicator color="#fff" /> : null}
          <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 16 }}>
            {busy ? "Searching network…" : "Start pairing"}
          </Text>
        </Pressable>

        <QrScanner
          isDark={isDark}
          accent={accent}
          ink={ink}
          muted={muted}
          card={card}
          onScanned={applyScannedPayload}
        />

        {/* Host code — only useful with peer server (not Expo Go) */}
        <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16, marginTop: 28 }}>
          Your QR & code
        </Text>
        {!canHostCode ? (
          <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, marginTop: 8 }}>
            Hosting a code needs the desktop peer server. On this phone, enter a desktop code instead.
          </Text>
        ) : null}
        <Pressable
          disabled={!canHostCode}
          onPress={() => store.startPairingSession()}
          style={{
            alignItems: "center",
            backgroundColor: card,
            borderRadius: 24,
            marginTop: 10,
            opacity: canHostCode ? 1 : 0.55,
            padding: 24,
          }}
        >
          {active && qrValue ? (
            <View
              style={{
                backgroundColor: "#fff",
                borderRadius: 16,
                marginBottom: 16,
                padding: 12,
              }}
            >
              <QRCode value={qrValue} size={180} backgroundColor="#ffffff" color="#0B1220" />
            </View>
          ) : null}
          <Text
            style={{
              color: accent,
              fontFamily: fonts.bold,
              fontSize: 36,
              letterSpacing: 8,
            }}
          >
            {active?.code ?? "------"}
          </Text>
          <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, marginTop: 8 }}>
            {canHostCode ? `Tap to ${active ? "refresh" : "generate"}` : "Unavailable on Expo Go"}
          </Text>
          {identity ? (
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 11, marginTop: 6 }}>
              {formatFingerprint(identity.fingerprint)}
            </Text>
          ) : null}
        </Pressable>

        <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16, marginTop: 28 }}>
          Paste QR payload
        </Text>
        <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, marginTop: 6 }}>
          Fallback when the camera is unavailable — paste the JSON from the desktop QR.
        </Text>
        <TextInput
          editable={!pasteBusy}
          multiline
          onChangeText={setQrPaste}
          placeholder='{"version":1,"deviceId":"..."}'
          placeholderTextColor={muted}
          style={{
            backgroundColor: card,
            borderRadius: 20,
            color: ink,
            fontFamily: fonts.regular,
            fontSize: 13,
            marginTop: 10,
            minHeight: 88,
            paddingHorizontal: 14,
            paddingVertical: 12,
            textAlignVertical: "top",
          }}
          value={qrPaste}
        />
        <Pressable
          disabled={pasteBusy || !qrPaste.trim()}
          onPress={() => {
            setPasteBusy(true);
            void store.applyPairingPayload(qrPaste.trim()).then((result) => {
              if (result.ok) setQrPaste("");
              setPasteBusy(false);
            });
          }}
          style={{
            alignItems: "center",
            backgroundColor: isDark ? "rgba(122,162,255,0.2)" : "rgba(47,107,255,0.12)",
            borderRadius: 999,
            flexDirection: "row",
            gap: 8,
            justifyContent: "center",
            marginTop: 12,
            opacity: pasteBusy || !qrPaste.trim() ? 0.6 : 1,
            paddingVertical: 14,
          }}
        >
          {pasteBusy ? <ActivityIndicator color={accent} /> : null}
          <Text style={{ color: accent, fontFamily: fonts.semiBold, fontSize: 15 }}>
            {pasteBusy ? "Pairing…" : "Apply pasted QR"}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
