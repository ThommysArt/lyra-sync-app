import { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useAppTheme } from "@/contexts/app-theme-context";
import { fonts } from "@/lib/constants";
import { useLyraSelector } from "@/lib/lyra";
import { formatRelativeTime } from "@lyra-sync-app/core";

type Props = {
  deviceId: string;
};

export function ConnectionStatusCard({ deviceId }: Props) {
  const { isDark } = useAppTheme();
  const device = useLyraSelector((s) => s.devices.find((d) => d.id === deviceId));
  const discovery = useLyraSelector((s) => s.discoveryStatus);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (device?.online) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.3, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else if (discovery.isScanning || discovery.phase === "reconnecting") {
      const loop = Animated.loop(
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.linear, useNativeDriver: true })
      );
      loop.start();
      return () => loop.stop();
    }
  }, [device?.online, discovery.isScanning, discovery.phase, pulse]);

  if (!device) return null;

  const isScanning = discovery.isScanning;
  const isReconnecting = discovery.phase === "reconnecting";
  const isOnline = device.online;

  let phase: "online" | "reconnecting" | "scanning" | "offline" = "offline";
  let label = "Offline";
  let sublabel = `Last seen ${formatRelativeTime(device.lastSeenAt)}`;
  let color = isDark ? "#71717a" : "#a1a1aa";
  let bg = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
  let icon: keyof typeof Ionicons.glyphMap = "cloud-offline-outline";

  if (isOnline) {
    phase = "online";
    label = "Connected";
    sublabel = `Online · ${device.connectionType} · ${formatRelativeTime(device.lastSeenAt)}`;
    color = "#22c55e";
    bg = "rgba(34,197,94,0.12)";
    icon = "checkmark-circle-outline";
  } else if (isReconnecting) {
    phase = "reconnecting";
    label = "Reconnecting…";
    sublabel = "Checking trust and reachability";
    color = "#f59e0b";
    bg = "rgba(245,158,11,0.12)";
    icon = "sync-outline";
  } else if (isScanning) {
    phase = "scanning";
    label = "Looking for peers…";
    sublabel = discovery.lastScannedAt
      ? `Last scan ${formatRelativeTime(discovery.lastScannedAt)}`
      : "Scanning LAN and Tailscale";
    color = "#3b82f6";
    bg = "rgba(59,130,246,0.12)";
    icon = "scan-outline";
  } else {
    phase = "offline";
    label = "Offline";
    sublabel = `Last seen ${formatRelativeTime(device.lastSeenAt)}`;
    color = isDark ? "#71717a" : "#a1a1aa";
    bg = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
    icon = "cloud-offline-outline";
  }

  return (
    <View
      style={{
        backgroundColor: isDark ? "#202020" : "#FFFFFF",
        borderRadius: 14,
        padding: 16,
        borderWidth: 1,
        borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Animated.View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: bg,
            alignItems: "center",
            justifyContent: "center",
            transform: [{ scale: pulse }],
          }}
        >
          <Ionicons name={icon} size={22} color={color} style={isReconnecting || isScanning ? { transform: [{ rotate: "0deg" }] } : undefined} />
        </Animated.View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: isDark ? "#e5e5e5" : "#18181b", fontFamily: fonts.semiBold, fontSize: 14 }}>
            {label}
          </Text>
          <Text style={{ color: isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)", fontFamily: fonts.regular, fontSize: 12, marginTop: 2 }}>
            {sublabel}
          </Text>
        </View>
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: color,
            opacity: phase === "online" ? 1 : phase === "offline" ? 0.4 : 0.9,
          }}
        />
      </View>

      {/* Phase-specific helper */}
      {phase === "scanning" && (
        <Text style={{ color: isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)", fontFamily: fonts.regular, fontSize: 11, marginTop: 10 }}>
          Searching 192.168.x and Tailscale 100.x — keep Wi-Fi on
        </Text>
      )}
      {phase === "reconnecting" && (
        <Text style={{ color: isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)", fontFamily: fonts.regular, fontSize: 11, marginTop: 10 }}>
          Verifying pairing trust — recent pairs are kept for 60s even if the peer is briefly unreachable
        </Text>
      )}
      {phase === "offline" && discovery.lastResult && (
        <Text style={{ color: isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)", fontFamily: fonts.regular, fontSize: 11, marginTop: 10 }}>
          Last discovery: {discovery.lastResult.online} online · {discovery.lastResult.nearby} nearby
        </Text>
      )}
    </View>
  );
}

export function GlobalDiscoveryStatusCard() {
  const { isDark } = useAppTheme();
  const discovery = useLyraSelector((s) => s.discoveryStatus);
  const peerServer = useLyraSelector((s) => s.peerServer);

  const phase = discovery.phase;
  const isScanning = discovery.isScanning;

  let label = "Idle";
  let sublabel = "Discovery ready";
  let color = isDark ? "#71717a" : "#a1a1aa";
  let icon: keyof typeof Ionicons.glyphMap = "power-outline";
  let bg = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";

  if (!peerServer.running) {
    label = "Peer server offline";
    sublabel = peerServer.lastError ?? "Start the app to announce on LAN";
    color = "#ef4444";
    bg = "rgba(239,68,68,0.12)";
    icon = "warning-outline";
  } else if (phase === "scanning") {
    label = "Looking for peers…";
    sublabel = "Announcing via multicast and scanning /24";
    color = "#3b82f6";
    bg = "rgba(59,130,246,0.12)";
    icon = "scan-outline";
  } else if (phase === "reconnecting") {
    label = "Reconnecting…";
    sublabel = "Verifying paired devices";
    color = "#f59e0b";
    bg = "rgba(245,158,11,0.12)";
    icon = "sync-outline";
  } else if (phase === "offline") {
    label = "Discovery off";
    sublabel = "Enable in Settings";
    color = isDark ? "#71717a" : "#a1a1aa";
    bg = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
    icon = "cloud-offline-outline";
  } else {
    label = "Idle";
    sublabel = discovery.lastScannedAt
      ? `Last scan ${formatRelativeTime(discovery.lastScannedAt)} · ${discovery.lastResult?.online ?? 0} online`
      : "Tap Refresh to scan";
    color = isDark ? "#71717a" : "#a1a1aa";
    bg = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
    icon = "checkmark-circle-outline";
  }

  return (
    <View
      style={{
        backgroundColor: isDark ? "#202020" : "#FFFFFF",
        borderRadius: 14,
        padding: 14,
        borderWidth: 1,
        borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: isDark ? "#e5e5e5" : "#18181b", fontFamily: fonts.semiBold, fontSize: 13 }}>
          {label} {isScanning ? "· scanning" : ""}
        </Text>
        <Text style={{ color: isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.5)", fontFamily: fonts.regular, fontSize: 11, marginTop: 2 }}>
          {sublabel}
        </Text>
      </View>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity: isScanning ? 0.9 : 0.5 }} />
    </View>
  );
}
