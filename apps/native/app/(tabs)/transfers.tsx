import {
  formatBytes,
  formatEta,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
} from "@lyra-sync-app/core";
import * as DocumentPicker from "expo-document-picker";
import { Pressable, ScrollView, Text, View } from "react-native";

import { FilePreview } from "@/components/file-preview";
import { ScreenHeader, useTabBottomPadding } from "@/components/ui/screen-header";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, CARD_BG, fonts, INK, MUTED, PAGE_BG, RADIUS } from "@/lib/constants";
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
  const ink = isDark ? INK.dark : INK.light;
  const muted = isDark ? MUTED.dark : MUTED.light;
  const card = isDark ? CARD_BG.dark : CARD_BG.light;
  const accent = isDark ? ACCENT_DARK : ACCENT;

  const pickAndSend = async () => {
    const target =
      onlineIds.find((id) => {
        const d = store.getState().devices.find((x) => x.id === id);
        return d?.authSecret || d?.id.startsWith("demo_");
      }) ?? onlineIds[0];
    if (!target) return;
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
      store.startFileTransfer([target], prepared);
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
            <Pressable
              onPress={() => void pickAndSend()}
              style={{
                backgroundColor: accent,
                borderRadius: RADIUS.md,
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>Send</Text>
            </Pressable>
          }
        />

        <View style={{ gap: 10, paddingHorizontal: 16 }}>
          {transfers.map((tx) => {
            const pct = formatPercent(tx.transferredBytes, tx.totalBytes);
            return (
              <View
                key={tx.id}
                style={{
                  backgroundColor: card,
                  borderRadius: RADIUS.xl,
                  padding: 12,
                }}
              >
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <FilePreview files={tx.files} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      numberOfLines={2}
                      style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 15 }}
                    >
                      {tx.files.map((f) => f.name).join(", ")}
                    </Text>
                    <Text
                      style={{
                        color: muted,
                        fontFamily: fonts.medium,
                        fontSize: 12,
                        marginTop: 4,
                      }}
                    >
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
                  </View>
                </View>

                {tx.status === "conflict" && (
                  <View style={{ gap: 8, marginTop: 10 }}>
                    {(tx.conflictFileNames?.length ?? 0) > 1 && (
                      <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 12 }}>
                        {tx.conflictFileNames!.join(" · ")}
                      </Text>
                    )}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
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
                  </View>
                )}

                {(tx.status === "transferring" || tx.status === "paused") && (
                  <View style={{ marginTop: 10 }}>
                    <View
                      style={{
                        backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                        borderRadius: 4,
                        height: 6,
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
                      {tx.currentSpeedBps
                        ? ` · ${formatSpeed(tx.currentSpeedBps)} · ETA ${formatEta(tx.etaSeconds)}`
                        : ""}
                      {tx.overWire ? " · wire" : ""}
                    </Text>
                  </View>
                )}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {tx.status === "transferring" && (
                    <Chip
                      label="Pause"
                      onPress={() => store.setTransferStatus(tx.id, "paused")}
                      ink={ink}
                    />
                  )}
                  {tx.status === "paused" && (
                    <Chip label="Resume" onPress={() => store.resumeTransfer(tx.id)} ink={ink} />
                  )}
                  {(tx.status === "transferring" || tx.status === "paused") && (
                    <Chip
                      label="Cancel"
                      onPress={() => store.setTransferStatus(tx.id, "cancelled")}
                      ink={ink}
                    />
                  )}
                  {(tx.status === "completed" || tx.status === "cancelled") && (
                    <Chip label="Re-send" onPress={() => store.resendTransfer(tx.id)} ink={ink} />
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
        borderRadius: RADIUS.md,
        paddingHorizontal: 12,
        paddingVertical: 7,
      }}
    >
      <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}
