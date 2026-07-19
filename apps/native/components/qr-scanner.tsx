import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useCallback, useRef, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";

import { ACCENT, ACCENT_DARK, fonts } from "@/lib/constants";

type QrScannerProps = {
  isDark: boolean;
  accent: string;
  ink: string;
  muted: string;
  card: string;
  onScanned: (data: string) => { ok: boolean; error?: string; deviceName?: string };
};

/**
 * Live camera QR scanner for pairing.
 * Native (iOS/Android): CameraView + barcode scan.
 * Web: camera barcode support is limited; show guidance + no live feed.
 */
export function QrScanner({ isDark, accent, ink, muted, card, onScanned }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [active, setActive] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [successName, setSuccessName] = useState<string | null>(null);
  const lockRef = useRef(false);

  const isNative = Platform.OS === "ios" || Platform.OS === "android";

  const handleBarcode = useCallback(
    (result: BarcodeScanningResult) => {
      if (lockRef.current || !result?.data) return;
      lockRef.current = true;
      setLocked(true);
      setLastError(null);
      setSuccessName(null);

      const outcome = onScanned(result.data);
      if (outcome.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        let name = outcome.deviceName;
        if (!name) {
          try {
            name = (JSON.parse(result.data) as { name?: string }).name;
          } catch {
            name = undefined;
          }
        }
        setSuccessName(name ?? "device");
        setActive(false);
        // Allow rescan after a short cooldown
        setTimeout(() => {
          lockRef.current = false;
          setLocked(false);
        }, 1500);
      } else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        setLastError(outcome.error ?? "Could not pair from this QR");
        // Brief cooldown so the same frame doesn't spam
        setTimeout(() => {
          lockRef.current = false;
          setLocked(false);
        }, 1200);
      }
    },
    [onScanned],
  );

  const startScan = useCallback(async () => {
    setLastError(null);
    setSuccessName(null);
    lockRef.current = false;
    setLocked(false);

    if (!isNative) {
      setLastError("Live camera scan needs an iOS or Android build. Paste the QR payload below.");
      return;
    }

    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setLastError("Camera permission is required to scan pairing QR codes.");
        return;
      }
    }
    setActive(true);
  }, [isNative, permission?.granted, requestPermission]);

  const stopScan = useCallback(() => {
    setActive(false);
    lockRef.current = false;
    setLocked(false);
  }, []);

  return (
    <View>
      <Text style={{ color: ink, fontFamily: fonts.semiBold, fontSize: 16, marginTop: 28 }}>
        Scan QR with camera
      </Text>
      <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, marginTop: 6 }}>
        Point your camera at the desktop pairing QR. Both devices stay paired until you unpair.
      </Text>

      {active && isNative && permission?.granted ? (
        <View
          style={{
            backgroundColor: "#000",
            borderRadius: 24,
            marginTop: 12,
            overflow: "hidden",
          }}
        >
          <CameraView
            style={{ height: 280, width: "100%" }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={locked ? undefined : handleBarcode}
          />
          {/* Viewfinder frame */}
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 48,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <View
              style={{
                width: 200,
                height: 200,
                borderRadius: 20,
                borderWidth: 2,
                borderColor: locked ? "rgba(122,162,255,0.9)" : "rgba(255,255,255,0.85)",
              }}
            />
            <Text
              style={{
                color: "rgba(255,255,255,0.9)",
                fontFamily: fonts.medium,
                fontSize: 13,
                marginTop: 12,
              }}
            >
              {locked ? "Processing…" : "Align QR inside the frame"}
            </Text>
          </View>
          <Pressable
            onPress={stopScan}
            style={{
              alignItems: "center",
              backgroundColor: "rgba(0,0,0,0.55)",
              paddingVertical: 14,
            }}
          >
            <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 15 }}>Close camera</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => {
            void startScan();
          }}
          style={{
            alignItems: "center",
            backgroundColor: accent,
            borderRadius: 999,
            marginTop: 12,
            paddingVertical: 14,
          }}
        >
          <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 16 }}>
            {isNative ? "Open camera scanner" : "Camera scan (native only)"}
          </Text>
        </Pressable>
      )}

      {permission && !permission.granted && permission.canAskAgain === false && isNative ? (
        <Pressable
          onPress={() => {
            void Linking.openSettings();
          }}
          style={{ alignItems: "center", marginTop: 10, padding: 8 }}
        >
          <Text style={{ color: isDark ? ACCENT_DARK : ACCENT, fontFamily: fonts.medium, fontSize: 13 }}>
            Open settings to allow camera
          </Text>
        </Pressable>
      ) : null}

      {successName ? (
        <View
          style={{
            backgroundColor: isDark ? "rgba(122,162,255,0.18)" : "rgba(47,107,255,0.12)",
            borderRadius: 16,
            marginTop: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
          }}
        >
          <Text style={{ color: accent, fontFamily: fonts.semiBold, fontSize: 14 }}>
            Confirm pairing with {successName}
          </Text>
          <Text
            style={{
              color: muted,
              fontFamily: fonts.medium,
              fontSize: 12,
              marginTop: 4,
            }}
          >
            Tap Accept on the banner above to finish. The other device must accept once too.
          </Text>
        </View>
      ) : null}

      {lastError ? (
        <Text style={{ color: "#FF453A", fontFamily: fonts.medium, fontSize: 13, marginTop: 10 }}>
          {lastError}
        </Text>
      ) : null}

      {!isNative ? (
        <Text style={{ color: muted, fontFamily: fonts.regular, fontSize: 12, marginTop: 8 }}>
          Expo web cannot use the device camera for QR pairing. Use the paste field below, or run on a
          phone/simulator with a camera.
        </Text>
      ) : null}

      {/* Subtle card chrome when idle so section doesn't feel empty after close */}
      {!active && isNative ? (
        <View
          style={{
            alignItems: "center",
            backgroundColor: card,
            borderRadius: 20,
            marginTop: 12,
            padding: 16,
          }}
        >
          <Text style={{ color: muted, fontFamily: fonts.medium, fontSize: 13, textAlign: "center" }}>
            Camera stays off until you open the scanner. Permission is requested only when scanning.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
