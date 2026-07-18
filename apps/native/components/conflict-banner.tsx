import type { ConflictAction, Transfer } from "@lyra-sync-app/protocol";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, ACCENT_DARK, fonts } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

function namesFor(tx: Transfer): string[] {
  if (tx.conflictFileNames && tx.conflictFileNames.length > 0) {
    return tx.conflictFileNames;
  }
  if (tx.conflictFileName) return [tx.conflictFileName];
  return tx.files.map((f) => f.name);
}

export function ConflictBanner() {
  const store = useLyraStore();
  const { isDark } = useAppTheme();
  const conflicts = useLyraSelector((s) => s.transfers.filter((t) => t.status === "conflict"));
  const accent = isDark ? ACCENT_DARK : ACCENT;
  const [expanded, setExpanded] = useState(true);

  if (conflicts.length === 0) return null;

  const totalFiles = conflicts.reduce((acc, tx) => acc + namesFor(tx).length, 0);
  const multiSession = conflicts.length > 1;
  const multiFile = totalFiles > 1;
  const ink = isDark ? "#F5F7FF" : "#0B1220";
  const muted = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)";

  const resolveOne = (id: string, action: ConflictAction) => {
    store.resolveTransferConflict(id, action);
  };

  const resolveAll = (action: ConflictAction) => {
    store.resolveAllTransferConflicts(action);
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
        <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 14 }}>
          {multiFile
            ? `${totalFiles} files already exist`
            : `“${namesFor(conflicts[0]!)[0] ?? "file"}” already exists`}
        </Text>
        <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 12, marginTop: 2 }}>
          {multiSession
            ? `${conflicts.length} sessions need a decision`
            : `From ${conflicts[0]!.deviceName} · rename, overwrite, or skip`}
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(multiSession || multiFile) && (
          <>
            <Chip label="Skip all" onPress={() => resolveAll("skip")} isDark={isDark} />
            <Chip label="Rename all" onPress={() => resolveAll("rename")} isDark={isDark} />
            <Pressable
              onPress={() => resolveAll("overwrite")}
              style={{
                backgroundColor: accent,
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                Overwrite all
              </Text>
            </Pressable>
            <Chip
              label={expanded ? "Hide" : "Details"}
              onPress={() => setExpanded((v) => !v)}
              isDark={isDark}
            />
          </>
        )}
        {!multiSession && !multiFile && (
          <>
            <Chip
              label="Skip"
              onPress={() => resolveOne(conflicts[0]!.id, "skip")}
              isDark={isDark}
            />
            <Chip
              label="Rename"
              onPress={() => resolveOne(conflicts[0]!.id, "rename")}
              isDark={isDark}
            />
            <Pressable
              onPress={() => resolveOne(conflicts[0]!.id, "overwrite")}
              style={{
                backgroundColor: accent,
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 13 }}>
                Overwrite
              </Text>
            </Pressable>
          </>
        )}
      </View>

      {expanded && (multiSession || multiFile) && (
        <View style={{ gap: 8 }}>
          {conflicts.map((tx) => {
            const names = namesFor(tx);
            return (
              <View
                key={tx.id}
                style={{
                  backgroundColor: isDark ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.55)",
                  borderRadius: 16,
                  gap: 8,
                  padding: 12,
                }}
              >
                <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 13 }}>
                  {names.length <= 2
                    ? names.join(", ")
                    : `${names.slice(0, 2).join(", ")} +${names.length - 2}`}
                </Text>
                <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 11 }}>
                  From {tx.deviceName} · {names.length} file{names.length === 1 ? "" : "s"}
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <Chip label="Skip" onPress={() => resolveOne(tx.id, "skip")} isDark={isDark} />
                  <Chip
                    label="Rename"
                    onPress={() => resolveOne(tx.id, "rename")}
                    isDark={isDark}
                  />
                  <Pressable
                    onPress={() => resolveOne(tx.id, "overwrite")}
                    style={{
                      backgroundColor: accent,
                      borderRadius: 999,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                    }}
                  >
                    <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 12 }}>
                      Overwrite
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      )}
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
