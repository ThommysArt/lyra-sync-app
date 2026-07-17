import { Stack } from "expo-router";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function PairScreen() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const active = useLyraSelector((s) => s.activePairing);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  return (
    <View style={{ backgroundColor: bg, flex: 1, padding: 20 }}>
      <Stack.Screen options={{ title: "Pair device", headerShadowVisible: false }} />
      <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 14, marginBottom: 20 }}>
        Scan a QR on desktop or enter a pairing code. Both sides confirm trust.
      </Text>

      <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16 }}>Your code</Text>
      <Pressable
        onPress={() => store.startPairingSession()}
        style={{
          alignItems: "center",
          backgroundColor: isDark ? "#141A26" : "#fff",
          borderRadius: 24,
          marginTop: 10,
          padding: 24,
        }}
      >
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
      </Pressable>

      <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16, marginTop: 28 }}>
        Enter code
      </Text>
      <TextInput
        autoCapitalize="characters"
        onChangeText={(t) => setCode(t.toUpperCase())}
        placeholder="ABC123"
        placeholderTextColor={muted}
        style={{
          backgroundColor: isDark ? "#141A26" : "#fff",
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
          const result = store.submitPairingCode(code);
          if (!result.ok) setError(result.error);
          else setError(null);
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

      <Pressable
        onPress={() => store.simulateIncomingPair()}
        style={{ alignItems: "center", marginTop: 16, padding: 12 }}
      >
        <Text style={{ color: accent, fontFamily: fonts.medium, fontSize: 14 }}>
          Simulate incoming request
        </Text>
      </Pressable>
    </View>
  );
}
