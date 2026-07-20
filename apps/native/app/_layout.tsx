// Must be first — enables gesture handler native module before any screens mount.
import "react-native-gesture-handler";

import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { ClipboardMonitor } from "@/components/clipboard-monitor";
import { ToastListener } from "@/components/toast-listener";
import { AppThemeProvider, useAppTheme } from "@/contexts/app-theme-context";
import { ACCENT, fonts, PAGE_BG } from "@/lib/constants";
import { LyraProvider } from "@/lib/lyra";

import "@/global.css";

void SplashScreen.preventAutoHideAsync();

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

/** Prevent a single render throw from taking down the whole native shell. */
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[lyra] root render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <View
          style={{
            alignItems: "center",
            backgroundColor: PAGE_BG.dark,
            flex: 1,
            justifyContent: "center",
            padding: 24,
          }}
        >
          <Text
            style={{
              color: "#F8FAFC",
              fontFamily: fonts.bold,
              fontSize: 18,
              marginBottom: 8,
              textAlign: "center",
            }}
          >
            Lyra hit a problem
          </Text>
          <Text
            style={{
              color: "rgba(248,250,252,0.7)",
              fontFamily: fonts.regular,
              fontSize: 14,
              textAlign: "center",
            }}
          >
            {this.state.error.message}
          </Text>
          <Text
            onPress={() => this.setState({ error: null })}
            style={{
              color: ACCENT,
              fontFamily: fonts.semiBold,
              fontSize: 15,
              marginTop: 20,
            }}
          >
            Try again
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

function RootNavigator() {
  const { isDark } = useAppTheme();

  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "transparent" } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="device/[id]"
          options={{
            headerShown: true,
            title: "Device",
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="pair"
          options={{
            presentation: "modal",
            headerShown: true,
            title: "Pair device",
          }}
        />
      </Stack>
      <StatusBar style={isDark ? "light" : "dark"} />
    </>
  );
}

export default function Layout() {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <RootErrorBoundary>
        <KeyboardProvider>
          <AppThemeProvider>
            <HeroUINativeProvider>
              <LyraProvider>
                <RootNavigator />
                <ClipboardMonitor />
                <ToastListener />
              </LyraProvider>
            </HeroUINativeProvider>
          </AppThemeProvider>
        </KeyboardProvider>
      </RootErrorBoundary>
    </GestureHandlerRootView>
  );
}
