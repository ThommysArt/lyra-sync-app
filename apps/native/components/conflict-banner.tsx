import type { ConflictAction } from "@lyra-sync-app/protocol";
import { Pressable, Text, View } from "react-native";

import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export function ConflictBanner() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const conflicts = useLyraSelector((s) => s.transfers.filter((t) => t.status === "conflict"));
  const accent = isDark ? ACCENT_DARK : ACCENT;

  if (conflicts.length === 0) return null;
  const tx = conflicts[0]!;
  const name = tx.conflictFileName ?? tx.files[0]?.name ?? "file";

  const resolve = (action: ConflictAction) => {
    store.resolveTransferConflict(tx.id, action);
  };

  return (
    <View
      style={{
        backgroundColor: isDark ? "rgba(255,196,0,0.14)" : "rgba(255,196,0,0.18)",
        borderBottomColor: isDark ? "rgba(255,196,0,0.35)" : "rgba(200,140,0,0.35)",
        borderBottomWidth: 1,
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      <View>
        <Text style={{ color: isDark ? "#F5F7FF" : "#0B1220", fontFamily: fonts.semiBold, fontSize: 14 }}>
          “{name}” already exists
        </Text>
        <Text
          style={{
            color: isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)",
            fontFamily: fonts.medium,
            fontSize: 12,
            marginTop: 2,
          }}
        >
          From {tx.deviceName} · rename, overwrite, or skip
        </Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Chip label="Skip" onPress={() => resolve("skip")} isDark={isDark} />
        <Chip label="Rename" onPress={() => resolve("rename")} isDark={isDark} />
        <Pressable
          onPress={() => resolve("overwrite")}
          style={{
            backgroundColor: accent,
            borderRadius: 999,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>Overwrite</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Chip({
  label,
  onPress,
  isDark,
}: {
  label: string;
  onPress: () => void;
  isDark: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
      }}
    >
      <Text
        style={{
          color: isDark ? "#F5F7FF" : "#0B1220",
          fontFamily: fonts.medium,
          fontSize: 13,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
