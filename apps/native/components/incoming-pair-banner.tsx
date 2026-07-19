import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export function IncomingPairBanner() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const requests = useLyraSelector((s) => s.incomingPairRequests);
  const accent = isDark ? ACCENT_DARK : ACCENT;
  const [busyId, setBusyId] = useState<string | null>(null);

  if (requests.length === 0) return null;
  const req = requests[0]!;
  const busy = busyId === req.id;

  return (
    <View
      style={{
        backgroundColor: isDark ? "rgba(122,162,255,0.18)" : "rgba(47,107,255,0.12)",
        borderBottomColor: isDark ? "rgba(122,162,255,0.35)" : "rgba(47,107,255,0.25)",
        borderBottomWidth: 1,
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      <View>
        <Text style={{ color: isDark ? "#e5e5e5" : "#333333", fontFamily: fonts.semiBold, fontSize: 14 }}>
          Pairing request from {req.payload.name}
        </Text>
        <Text
          style={{
            color: isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)",
            fontFamily: fonts.medium,
            fontSize: 12,
            marginTop: 2,
          }}
        >
          {req.payload.platform} · fingerprint {req.payload.fingerprint.slice(0, 8)}…
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable
          disabled={busy}
          onPress={() => {
            setBusyId(req.id);
            store.rejectIncomingPair(req.id);
            setBusyId(null);
          }}
          style={{
            backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
            borderRadius: 8,
            opacity: busy ? 0.6 : 1,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          <Text
            style={{
              color: isDark ? "#e5e5e5" : "#333333",
              fontFamily: fonts.medium,
              fontSize: 13,
            }}
          >
            Decline
          </Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => {
            setBusyId(req.id);
            void Promise.resolve(store.confirmIncomingPair(req.id)).finally(() => {
              setBusyId(null);
            });
          }}
          style={{
            alignItems: "center",
            backgroundColor: accent,
            borderRadius: 8,
            flexDirection: "row",
            gap: 6,
            opacity: busy ? 0.85 : 1,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          {busy ? <ActivityIndicator color="#fff" size="small" /> : null}
          <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
            {busy ? "Pairing…" : "Accept"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
