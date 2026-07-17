import { formatBytes, formatPercent, formatRelativeTime } from "@lyra-sync-app/core";
import * as DocumentPicker from "expo-document-picker";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ScreenHeader, useTabBottomPadding } from "@/components/ui/screen-header";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function TransfersScreen() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const bottomPad = useTabBottomPadding();
  const transfers = useLyraSelector((s) =>
    [...s.transfers].sort((a, b) => b.createdAt - a.createdAt),
  );
  const onlineIds = useLyraSelector((s) => s.devices.filter((d) => d.online).map((d) => d.id));
  const hasTopBanners = useLyraSelector(
    (s) =>
      s.incomingPairRequests.length > 0 || s.transfers.some((t) => t.status === "conflict"),
  );
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#141A26" : "#FFFFFF";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  const pickAndSend = async () => {
    if (!onlineIds[0]) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      store.startFileTransfer(
        [onlineIds[0]],
        result.assets.map((a) => ({
          name: a.name,
          size: a.size ?? 1024,
          mimeType: a.mimeType ?? undefined,
        })),
      );
    } catch {
      // cancelled
    }
  };

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <ScreenHeader
          title="Transfers"
          subtitle="Pause, resume, and history"
          skipTopInset={hasTopBanners}
          right={
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                onPress={() => store.simulateIncomingConflict()}
                style={{
                  backgroundColor: isDark ? "rgba(255,196,0,0.18)" : "rgba(255,196,0,0.25)",
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>
                  Conflict
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void pickAndSend()}
                style={{
                  backgroundColor: accent,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                  Send
                </Text>
              </Pressable>
            </View>
          }
        />

        <View style={{ gap: 12, paddingHorizontal: 16 }}>
          {transfers.map((tx) => {
            const pct = formatPercent(tx.transferredBytes, tx.totalBytes);
            return (
              <View key={tx.id} style={{ backgroundColor: card, borderRadius: 22, padding: 14 }}>
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 15 }}>
                  {tx.files.map((f) => f.name).join(", ")}
                </Text>
                <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 12, marginTop: 4 }}>
                  {tx.direction === "sent" ? "To" : "From"} {tx.deviceName} ·{" "}
                  {formatBytes(tx.totalBytes)} · {formatRelativeTime(tx.createdAt)}
                </Text>
                <Text
                  style={{
                    color: accent,
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    marginTop: 6,
                    textTransform: "capitalize",
                  }}
                >
                  {tx.status}
                </Text>

                {tx.status === "conflict" && (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                    <Chip
                      label="Skip"
                      onPress={() => store.resolveTransferConflict(tx.id, "skip")}
                      ink={ink}
                    />
                    <Chip
                      label="Rename"
                      onPress={() => store.resolveTransferConflict(tx.id, "rename")}
                      ink={ink}
                    />
                    <Chip
                      label="Overwrite"
                      onPress={() => store.resolveTransferConflict(tx.id, "overwrite")}
                      ink={ink}
                    />
                  </View>
                )}

                {(tx.status === "transferring" || tx.status === "paused") && (
                  <View style={{ marginTop: 10 }}>
                    <View
                      style={{
                        backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                        borderRadius: 99,
                        height: 8,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          backgroundColor: accent,
                          height: "100%",
                          width: `${pct}%`,
                        }}
                      />
                    </View>
                    <Text
                      style={{ color: muted, fontFamily: fonts.regular, fontSize: 11, marginTop: 4 }}
                    >
                      {pct}% · {formatBytes(tx.transferredBytes)}
                    </Text>
                  </View>
                )}
                <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                  {tx.status === "transferring" && (
                    <Chip
                      label="Pause"
                      onPress={() => store.setTransferStatus(tx.id, "paused")}
                      ink={ink}
                    />
                  )}
                  {tx.status === "paused" && (
                    <Chip
                      label="Resume"
                      onPress={() => store.setTransferStatus(tx.id, "transferring")}
                      ink={ink}
                    />
                  )}
                  {(tx.status === "transferring" || tx.status === "paused") && (
                    <Chip
                      label="Cancel"
                      onPress={() => store.setTransferStatus(tx.id, "cancelled")}
                      ink={ink}
                    />
                  )}
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function Chip({ label, onPress, ink }: { label: string; onPress: () => void; ink: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: "rgba(127,127,127,0.12)",
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 7,
      }}
    >
      <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}
