import { LyraProvider as BaseLyraProvider, useLyraSelector, useLyraState, useLyraStore } from "@lyra-sync-app/hooks";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import * as Network from "expo-network";

import { ACCENT, PAGE_BG } from "@/lib/constants";
import { useAppTheme } from "@/contexts/app-theme-context";
import {
  createSecureLyraStorage,
  migratePrivateKeyToSecureStore,
} from "@/lib/secure-storage";
import {
  attachNativePeerToStore,
  isExpoGoRuntime,
  startNativePeerServer,
  type NativePeerHandle,
} from "@/lib/peer-server";

export { useLyraSelector, useLyraState, useLyraStore };

export function LyraProvider({ children }: { children: ReactNode }) {
  const { isDark } = useAppTheme();
  const storage = useMemo(() => createSecureLyraStorage(), []);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (storage.hydrate) await storage.hydrate();
        await migratePrivateKeyToSecureStore(storage);
      } catch (err) {
        console.warn("[lyra] storage hydrate failed", err);
      }
      if (!cancelled) setStorageReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  /**
   * Seed /24 LAN scan for pairing-code lookup, then start this device's peer
   * HTTP server so other peers (desktop) can reach the phone.
   */
  const onStoreReady = useCallback((store: import("@lyra-sync-app/core").LyraStore) => {
    let cancelled = false;
    let detachPeer: (() => void) | null = null;
    let peerHandle: NativePeerHandle | null = null;

    void Network.getIpAddressAsync()
      .then((ip) => {
        if (ip && ip !== "0.0.0.0") store.setLocalLanHint(ip);
      })
      .catch(() => {
        // ignore — pairing still works with manual/discovered hosts
      });

    const startPeer = async () => {
      // Wait for identity hydrate
      const waitIdentity = async () => {
        for (let i = 0; i < 40; i++) {
          if (cancelled) return null;
          const id = store.getState().identity;
          if (id) return id;
          await new Promise((r) => setTimeout(r, 100));
        }
        return store.getState().identity;
      };

      const identity = await waitIdentity();
      if (!identity || cancelled) return;

      if (isExpoGoRuntime()) {
        store.setPeerServerStatus({
          running: false,
          port: null,
          url: null,
          lanHost: store.getState().localLanHint,
          discoveryActive: false,
          lastError:
            "Expo Go cannot host a peer server. Install a dev/preview build to pair as host and receive pushes.",
        });
        return;
      }

      // Expo web in browser — no TCP listen
      if (Platform.OS === "web") {
        store.setPeerServerStatus({
          running: false,
          port: null,
          url: null,
          lanHost: store.getState().localLanHint,
          discoveryActive: false,
          lastError: null,
        });
        return;
      }

      try {
        const preferred = store.getState().settings.peerListenPort ?? 53317;
        const peer = await startNativePeerServer({
          identity,
          port: preferred,
          advertiseHost: store.getState().localLanHint,
          resolvePeerAuth: ({ deviceId, fingerprint }) => {
            const devices = store.getState().devices;
            const byId = devices.find((d) => d.id === deviceId && d.authSecret);
            if (byId?.authSecret) {
              return {
                sharedSecret: byId.authSecret,
                expectedFingerprint: byId.fingerprint,
                expectedDeviceId: byId.id,
              };
            }
            const byFp = devices.find((d) => d.fingerprint === fingerprint && d.authSecret);
            if (byFp?.authSecret) {
              return {
                sharedSecret: byFp.authSecret,
                expectedFingerprint: byFp.fingerprint,
                expectedDeviceId: byFp.id,
              };
            }
            // First contact for pairing
            return {};
          },
          handlers: {
            onPairRequest: (payload) => {
              store.enqueuePairRequest(payload, "wire");
            },
            onClipboardPush: (item) => {
              store.receiveClipboardItem(item as import("@lyra-sync-app/protocol").ClipboardItem);
            },
            onUnpair: (deviceId) => {
              const still = store.getState().devices.find((d) => d.id === deviceId);
              if (still) store.unpairDevice(deviceId, { silent: true });
            },
            onOpenUrl: async (url) => {
              try {
                const Linking = await import("expo-linking");
                await Linking.openURL(url);
                return true;
              } catch {
                return false;
              }
            },
            onTransferComplete: (state) => {
              store.recordReceivedTransfer({
                transferId: state.transferId,
                files: state.files,
                receivedBytes: state.receivedBytes,
                deviceName: "Peer",
              });
            },
          },
        });

        if (cancelled) {
          await peer?.stop();
          return;
        }

        if (!peer) {
          store.setPeerServerStatus({
            running: false,
            port: null,
            url: null,
            lanHost: store.getState().localLanHint,
            discoveryActive: false,
            lastError:
              "Peer server unavailable on this runtime. Use a native dev/preview build (not Expo Go web).",
          });
          return;
        }

        peerHandle = peer;
        detachPeer = attachNativePeerToStore(store, peer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[lyra] native peer server failed", msg);
        store.setPeerServerStatus({
          running: false,
          port: null,
          url: null,
          lanHost: store.getState().localLanHint,
          discoveryActive: false,
          lastError: msg,
        });
      }
    };

    void startPeer();

    return () => {
      cancelled = true;
      detachPeer?.();
      detachPeer = null;
      void peerHandle?.stop();
      peerHandle = null;
    };
  }, []);

  const fallback = (
    <View
      style={{
        alignItems: "center",
        backgroundColor: isDark ? PAGE_BG.dark : PAGE_BG.light,
        flex: 1,
        justifyContent: "center",
      }}
    >
      <ActivityIndicator color={ACCENT} size="large" />
    </View>
  );

  if (!storageReady) {
    return fallback;
  }

  return (
    <BaseLyraProvider
      storage={storage}
      // Opt-in dummy mesh only (never default in dev)
      seedDemo={
        process.env.EXPO_PUBLIC_LYRA_SEED_DEMO === "1" ||
        process.env.EXPO_PUBLIC_LYRA_SEED_DEMO === "true"
      }
      platformHint={Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "native"}
      onStoreReady={onStoreReady}
      fallback={fallback}
    >
      {children}
    </BaseLyraProvider>
  );
}
