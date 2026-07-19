import { formatFingerprint } from "@lyra-sync-app/core";
import { Stack } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
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
  const [code, setCode] = useState("");
  const [qrPaste, setQrPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const accent = isDark ? ACCENT_DARK : ACCENT;
  const card = isDark ? "#141A26" : "#fff";

  const qrValue = useMemo(
    () => (active ? JSON.stringify(active.payload) : ""),
    [active],
  );

  const applyScannedPayload = useCallback(
    (data: string) => {
      const result = store.applyPairingPayload(data.trim());
      if (!result.ok) {
        return { ok: false as const, error: result.error };
      }
      if ("pending" in result && result.pending) {
        return { ok: true as const, deviceName: result.deviceName };
      }
      if ("device" in result) {
        return { ok: true as const, deviceName: result.device.name };
      }
      return { ok: true as const, deviceName: "device" };
    },
    [store],
  );

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <Stack.Screen options={{ title: "Pair device", headerShadowVisible: false }} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 14, marginBottom: 20 }}>
          Scan a QR on desktop, show your QR, or enter a pairing code. Both sides confirm trust.
        </Text>

        <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>Your QR & code</Text>
        <Pressable
          onPress={() => store.startPairingSession()}
          style={{
            alignItems: "center",
            backgroundColor: card,
            borderRadius: 24,
            marginTop: 10,
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
            Tap to {active ? "refresh" : "generate"}
          </Text>
          {identity ? (
            <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 11, marginTop: 6 }}>
              {formatFingerprint(identity.fingerprint)}
            </Text>
          ) : null}
        </Pressable>

        <QrScanner
          isDark={isDark}
          accent={accent}
          ink={ink}
          muted={muted}
          card={card}
          onScanned={applyScannedPayload}
        />

        <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16, marginTop: 28 }}>
          Enter code
        </Text>
        <TextInput
          autoCapitalize="characters"
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
            paddingHorizontal: 18,
            paddingVertical: 14,
            textAlign: "center",
          }}
          value={code}
        />
        {error ? (
          <Text style={{ color: "#FF453A", fontFamily: fonts.medium, fontSize: 13, marginTop: 8 }}>
            {error}
          </Text>
        ) : null}
        <Pressable
          onPress={() => {
            void store.submitPairingCode(code).then((result) => {
              if (!result.ok) setError(result.error);
              else setError(null);
            });
          }}
          style={{
            alignItems: "center",
            backgroundColor: accent,
            borderRadius: 999,
            marginTop: 14,
            paddingVertical: 14,
          }}
        >
          <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 16 }}>Pair</Text>
        </Pressable>

        <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16, marginTop: 28 }}>
          Paste QR payload
        </Text>
        <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, marginTop: 6 }}>
          Fallback when the camera is unavailable — paste the JSON encoded in the desktop QR.
        </Text>
        <TextInput
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
        {scanError ? (
          <Text style={{ color: "#FF453A", fontFamily: fonts.medium, fontSize: 13, marginTop: 8 }}>
            {scanError}
          </Text>
        ) : null}
        <Pressable
          onPress={() => {
            const result = store.applyPairingPayload(qrPaste.trim());
            if (!result.ok) setScanError(result.error);
            else {
              setScanError(null);
              setQrPaste("");
            }
          }}
          style={{
            alignItems: "center",
            backgroundColor: isDark ? "rgba(122,162,255,0.2)" : "rgba(47,107,255,0.12)",
            borderRadius: 999,
            marginTop: 12,
            paddingVertical: 14,
          }}
        >
          <Text style={{ color: accent, fontFamily: fonts.semiBold, fontSize: 15 }}>
            Apply pasted QR
          </Text>
        </Pressable>

        <Pressable
          onPress={() => store.simulateIncomingPair()}
          style={{ alignItems: "center", marginTop: 20, padding: 12 }}
        >
          <Text style={{ color: accent, fontFamily: fonts.medium, fontSize: 14 }}>
            Simulate incoming request
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
