import { formatRelativeTime } from "@lyra-sync-app/core";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { ScreenHeader, useTabBottomPadding } from "@/components/ui/screen-header";
import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export default function ClipboardScreen() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const bottomPad = useTabBottomPadding();
  const history = useLyraSelector((s) =>
    [...s.clipboardHistory].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.createdAt - a.createdAt;
    }),
  );
  const onlineIds = useLyraSelector((s) => s.devices.filter((d) => d.online).map((d) => d.id));
  const hasTopBanners = useLyraSelector(
    (s) =>
      s.incomingPairRequests.length > 0 || s.transfers.some((t) => t.status === "conflict"),
  );
  const [draft, setDraft] = useState("");
  const bg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const ink = isDark ? "#e5e5e5" : "#333333";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";
  const card = isDark ? "#202020" : "#FFFFFF";
  const accent = isDark ? ACCENT_DARK : ACCENT;

  const importSystem = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) {
        setDraft(text);
        store.setLocalClipboardText(text);
      }
    } catch {
      // ignore
    }
  };

  const sendDraft = async (targets: string[]) => {
    if (!draft.trim()) return;
    store.pushClipboardText(draft, targets);
    try {
      await Clipboard.setStringAsync(draft.trim());
    } catch {
      // ignore
    }
    setDraft("");
  };

  return (
    <View style={{ backgroundColor: bg, flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <ScreenHeader
          title="Clipboard"
          subtitle="History stays on this device"
          skipTopInset={hasTopBanners}
          right={
            <Pressable
              onPress={() => void importSystem()}
              style={{
                backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>Read system</Text>
            </Pressable>
          }
        />

        <View style={{ gap: 12, paddingHorizontal: 16 }}>
          <View style={{ backgroundColor: card, borderRadius: 14, padding: 14 }}>
            <TextInput
              multiline
              onChangeText={setDraft}
              placeholder="Type or paste to send…"
              placeholderTextColor={muted}
              style={{
                color: ink,
                fontFamily: fonts.regular,
                fontSize: 15,
                minHeight: 88,
                textAlignVertical: "top",
              }}
              value={draft}
            />
            <Pressable
              disabled={!draft.trim()}
              onPress={() => void sendDraft(onlineIds)}
              style={{
                alignItems: "center",
                alignSelf: "flex-start",
                backgroundColor: accent,
                borderRadius: 8,
                flexDirection: "row",
                gap: 6,
                marginTop: 10,
                opacity: draft.trim() ? 1 : 0.5,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <Ionicons color="#fff" name="send" size={16} />
              <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 14 }}>
                Send to online
              </Text>
            </Pressable>
          </View>

          {history.map((item) => {
            const status = item.deliveryStatus;
            const statusLabel =
              status === "sending"
                ? "Sending…"
                : status === "sent"
                  ? `Sent${item.deliveredTo?.length ? ` · ${item.deliveredTo.length}` : ""}`
                  : status === "failed"
                    ? "Failed — resend"
                    : status === "local"
                      ? "Local only"
                      : null;
            const statusColor =
              status === "sent"
                ? "#34C759"
                : status === "failed"
                  ? "#ef4444"
                  : status === "sending"
                    ? accent
                    : muted;
            return (
              <View key={item.id} style={{ backgroundColor: card, borderRadius: 12, padding: 14 }}>
                <Text style={{ color: ink, fontFamily: fonts.regular, fontSize: 15 }}>
                  {item.text || "[Image]"}
                </Text>
                <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 12, marginTop: 8 }}>
                  {item.sourceDeviceName} · {formatRelativeTime(item.createdAt)}
                  {item.pinned ? " · Pinned" : ""}
                </Text>
                {statusLabel ? (
                  <Text
                    style={{
                      color: statusColor,
                      fontFamily: fonts.semiBold,
                      fontSize: 12,
                      marginTop: 6,
                    }}
                  >
                    {statusLabel}
                    {item.deliveryError && status === "failed" ? ` · ${item.deliveryError}` : ""}
                  </Text>
                ) : null}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  <Action
                    label="Copy"
                    onPress={() => {
                      if (item.text) void Clipboard.setStringAsync(item.text);
                    }}
                    ink={ink}
                  />
                  <Action
                    label={item.pinned ? "Unpin" : "Pin"}
                    onPress={() => store.pinClipboardItem(item.id, !item.pinned)}
                    ink={ink}
                  />
                  <Action
                    label="Resend"
                    onPress={() => store.resendClipboardItem(item.id, onlineIds)}
                    ink={ink}
                  />
                  <Action
                    label="Delete"
                    onPress={() => store.removeClipboardItem(item.id)}
                    ink={ink}
                  />
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function Action({ label, onPress, ink }: { label: string; onPress: () => void; ink: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: "rgba(127,127,127,0.12)",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
      }}
    >
      <Text style={{ color: ink, fontFamily: fonts.medium, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}
