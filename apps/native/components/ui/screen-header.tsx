import type { ReactNode } from "react";
import { Text, View } from "react-native";

import { fonts } from "@/lib/constants";
import { useAppTheme } from "@/contexts/app-theme-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Top chrome for tab screens.
 * When `skipTopInset` is true, the parent already applied safe-area (e.g. banners).
 */
export function ScreenHeader({
  title,
  subtitle,
  right,
  skipTopInset = false,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  skipTopInset?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { isDark } = useAppTheme();

  return (
    <View
      style={{
        paddingBottom: 12,
        paddingHorizontal: 20,
        paddingTop: skipTopInset ? 12 : Math.max(insets.top + 8, 20),
      }}
    >
      <View style={{ alignItems: "flex-start", flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              color: isDark ? "#F5F7FF" : "#0B1220",
              fontFamily: fonts.bold,
              fontSize: 28,
              letterSpacing: -0.4,
            }}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={{
                color: isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)",
                fontFamily: fonts.medium,
                fontSize: 14,
                marginTop: 4,
              }}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
    </View>
  );
}

export function useTabBottomPadding() {
  const insets = useSafeAreaInsets();
  return Math.max(insets.bottom, 10) + 8 + 66 + 24;
}
