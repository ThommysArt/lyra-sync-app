import { useEffect, useRef } from "react";
import { Animated, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppTheme } from "@/contexts/app-theme-context";
import { fonts } from "@/lib/constants";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

/**
 * Surfaces store.toast as a transient banner (sonner equivalent for native).
 */
export function ToastListener() {
  const store = useLyraStore();
  const t = useLyraSelector((s) => s.toast);
  const { isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const lastId = useRef<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const visible = useRef(t);

  useEffect(() => {
    if (!t || t.id === lastId.current) return;
    lastId.current = t.id;
    visible.current = t;
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(2800),
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      store.dismissToast();
    });
  }, [t, store, opacity]);

  if (!t) return null;

  const bg =
    t.tone === "error"
      ? isDark
        ? "#3F1D1D"
        : "#FEE2E2"
      : t.tone === "success"
        ? isDark
          ? "#14352A"
          : "#D1FAE5"
        : isDark
          ? "#1E293B"
          : "#E2E8F0";
  const fg =
    t.tone === "error"
      ? isDark
        ? "#FECACA"
        : "#991B1B"
      : t.tone === "success"
        ? isDark
          ? "#A7F3D0"
          : "#065F46"
        : isDark
          ? "#F1F5F9"
          : "#0F172A";

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        left: 16,
        opacity,
        position: "absolute",
        right: 16,
        top: insets.top + 8,
        zIndex: 1000,
      }}
    >
      <View
        style={{
          backgroundColor: bg,
          borderRadius: 10,
          paddingHorizontal: 16,
          paddingVertical: 12,
          shadowColor: "#000",
          shadowOpacity: 0.15,
          shadowRadius: 12,
        }}
      >
        <Text style={{ color: fg, fontFamily: fonts.semiBold, fontSize: 14 }}>{t.message}</Text>
      </View>
    </Animated.View>
  );
}
