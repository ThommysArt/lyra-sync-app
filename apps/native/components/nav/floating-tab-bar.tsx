import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import type { ComponentProps, JSX } from "react";
import { useEffect, useState } from "react";
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ProgressiveBlurEdge } from "@/components/nav/progressive-blur-edge";
import { ACCENT, ACCENT_DARK, fonts, PAGE_BG } from "@/lib/constants";
import { useAppTheme } from "@/contexts/app-theme-context";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

type TabRoute = {
  key: string;
  name: string;
  params?: object;
};

// Loose typing to avoid @react-navigation version skew with expo-router
export type FloatingTabBarProps = {
  state: {
    index: number;
    routes: TabRoute[];
  };
  descriptors: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigation: any;
};

const TAB_BAR_HEIGHT = 62;
const TAB_ICON = 22;
const TAB_LABEL = 10;
/** Compact pill — 4 tabs */
const TAB_BAR_WIDTH = 312;

const tabMeta: Record<
  string,
  { label: string; icon: IoniconName; activeIcon: IoniconName }
> = {
  index: { activeIcon: "phone-portrait", icon: "phone-portrait-outline", label: "Devices" },
  clipboard: { activeIcon: "clipboard", icon: "clipboard-outline", label: "Clipboard" },
  transfers: { activeIcon: "swap-horizontal", icon: "swap-horizontal-outline", label: "Transfers" },
  settings: { activeIcon: "settings", icon: "settings-outline", label: "Settings" },
};

function GlassTabItem({
  routeName,
  focused,
  onPress,
  onLongPress,
  isDark,
}: {
  routeName: string;
  focused: boolean;
  onPress: () => void;
  onLongPress: () => void;
  isDark: boolean;
}): JSX.Element {
  const progress = useSharedValue(focused ? 1 : 0);
  const pressed = useSharedValue(0);
  const meta = tabMeta[routeName] ?? tabMeta.index!;
  const accent = isDark ? ACCENT_DARK : ACCENT;

  useEffect(() => {
    progress.value = withSpring(focused ? 1 : 0, {
      damping: 18,
      mass: 0.8,
      stiffness: 210,
    });
  }, [focused, progress]);

  const itemStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.05 }],
  }));

  const labelStyle = useAnimatedStyle(() => ({
    opacity: 0.72 + progress.value * 0.28,
  }));

  const inactiveIcon = isDark ? "rgba(255,255,255,0.72)" : "rgba(0,0,0,0.42)";
  const inactiveLabel = isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.42)";

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={focused ? { selected: true } : {}}
      onLongPress={onLongPress}
      onPress={onPress}
      onPressIn={() => {
        pressed.value = withTiming(1, { duration: 90 });
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, { damping: 14, stiffness: 260 });
      }}
      style={styles.itemPressable}
    >
      <Animated.View style={[styles.item, itemStyle]}>
        <Ionicons
          color={focused ? accent : inactiveIcon}
          name={focused ? meta.activeIcon : meta.icon}
          size={TAB_ICON}
        />
        <Animated.Text
          adjustsFontSizeToFit
          numberOfLines={1}
          style={[
            styles.label,
            { color: focused ? accent : inactiveLabel },
            labelStyle,
            focused && styles.activeLabel,
          ]}
        >
          {meta.label}
        </Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

/** Liquid-glass floating tab bar — Chrona structure, Lyra blue theme. */
export function FloatingTabBar({
  state,
  navigation,
}: FloatingTabBarProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const { isDark } = useAppTheme();
  const pageBg = isDark ? PAGE_BG.dark : PAGE_BG.light;
  const activeIndex = useSharedValue(state.index);
  const itemsWidth = useSharedValue(0);
  const [chromeHeight, setChromeHeight] = useState(0);

  const bottomPad = Math.max(10, insets.bottom + 8);

  useEffect(() => {
    activeIndex.value = withSpring(state.index, {
      damping: 22,
      mass: 0.8,
      stiffness: 240,
    });
  }, [state.index, activeIndex]);

  const indicatorStyle = useAnimatedStyle(() => {
    const count = Math.max(state.routes.length, 1);
    const gap = 2;
    const itemWidth = Math.max(0, (itemsWidth.value - gap * (count - 1)) / count);

    return {
      opacity: itemsWidth.value > 0 ? 1 : 0,
      transform: [{ translateX: activeIndex.value * (itemWidth + gap) }],
      width: itemWidth,
    };
  });

  const handleChromeLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    setChromeHeight((prev) => (prev === next ? prev : next));
  };

  const fadeHeight = Math.max(Math.round(chromeHeight * 1.9), 120);

  return (
    <ProgressiveBlurEdge backgroundColor={pageBg} edge="bottom" fadeHeight={fadeHeight}>
      <View
        onLayout={handleChromeLayout}
        pointerEvents="box-none"
        style={[styles.chrome, { paddingBottom: bottomPad }]}
      >
        <View style={[styles.shell, isDark ? styles.shellDark : styles.shellLight]}>
          {/*
            Android blur is experimental and has crashed some devices when forced.
            Prefer translucent fill on Android; keep real blur on iOS.
          */}
          {Platform.OS === "ios" ? (
            <BlurView
              blurReductionFactor={isDark ? 2 : 4}
              intensity={isDark ? 90 : 48}
              style={StyleSheet.absoluteFill}
              tint={isDark ? "dark" : "systemUltraThinMaterialLight"}
            />
          ) : (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: isDark
                    ? "rgba(20, 24, 34, 0.92)"
                    : "rgba(255, 255, 255, 0.94)",
                },
              ]}
            />
          )}
          <View
            pointerEvents="none"
            style={[styles.innerGlow, !isDark && styles.innerGlowLight]}
          />
          <View
            onLayout={(event) => {
              itemsWidth.value = event.nativeEvent.layout.width;
            }}
            style={styles.items}
          >
            <Animated.View
              pointerEvents="none"
              style={[
                styles.activePill,
                isDark ? styles.activePillDark : styles.activePillLight,
                indicatorStyle,
              ]}
            />
            {state.routes.map((route, index) => {
              const focused = state.index === index;
              return (
                <GlassTabItem
                  focused={focused}
                  isDark={isDark}
                  key={route.key}
                  onLongPress={() => {
                    navigation.emit({
                      target: route.key,
                      type: "tabLongPress",
                    });
                  }}
                  onPress={() => {
                    const event = navigation.emit({
                      canPreventDefault: true,
                      target: route.key,
                      type: "tabPress",
                    });
                    if (!(focused || event.defaultPrevented)) {
                      void Haptics.selectionAsync();
                      navigation.navigate(route.name, route.params);
                    }
                  }}
                  routeName={route.name}
                />
              );
            })}
          </View>
        </View>
      </View>
    </ProgressiveBlurEdge>
  );
}

const styles = StyleSheet.create({
  activeLabel: {
    fontFamily: fonts.bold,
  },
  activePill: {
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
  },
  activePillDark: {
    backgroundColor: "rgba(122, 162, 255, 0.22)",
    borderColor: "rgba(122, 162, 255, 0.28)",
  },
  activePillLight: {
    backgroundColor: "rgba(47, 107, 255, 0.12)",
    borderColor: "rgba(47, 107, 255, 0.16)",
  },
  chrome: {
    alignItems: "center",
    backgroundColor: "transparent",
    paddingHorizontal: 24,
    width: "100%",
  },
  innerGlow: {
    backgroundColor: "rgba(255,255,255,0.055)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  innerGlowLight: {
    backgroundColor: "rgba(255,255,255,0.55)",
  },
  item: {
    alignItems: "center",
    borderRadius: 28,
    flex: 1,
    gap: 3,
    justifyContent: "center",
    minWidth: 0,
    overflow: "hidden",
  },
  itemPressable: {
    flex: 1,
  },
  items: {
    flex: 1,
    flexDirection: "row",
    gap: 2,
    position: "relative",
  },
  label: {
    fontFamily: fonts.semiBold,
    fontSize: TAB_LABEL,
    letterSpacing: 0,
    maxWidth: "92%",
  },
  shell: {
    alignSelf: "center",
    borderRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 12,
    height: TAB_BAR_HEIGHT,
    overflow: "hidden",
    paddingHorizontal: 4,
    paddingVertical: 3,
    shadowColor: "#000000",
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 18,
    width: TAB_BAR_WIDTH,
  },
  shellDark: {
    backgroundColor: "rgba(20, 24, 34, 0.48)",
    borderColor: "rgba(255, 255, 255, 0.16)",
  },
  shellLight: {
    backgroundColor: "rgba(255, 255, 255, 0.92)",
    borderColor: "rgba(0, 0, 0, 0.05)",
    shadowOpacity: 0.08,
  },
});
