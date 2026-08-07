import { LyraProvider as BaseLyraProvider, useLyraSelector, useLyraState, useLyraStore } from "@lyra-sync-app/hooks";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, AppState, Platform, View } from "react-native";
import * as Network from "expo-network";
import { getLanHosts } from "@/lib/network";
import { startNativeDiscovery, type NativeDiscoveryHandle } from "@/lib/discovery-native";

import { ACCENT, PAGE_BG } from "@/lib/constants";
import { useAppTheme } from "@/contexts/app-theme-context";
import {
  nativeDefaultPortFromEnv,
  nativePreferredPortFromEnv,
  nativeVariantDefaultPort,
  resolveNativeVariant,
} from "@/lib/native-variant";
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
import { installNativePeerHttpTransport } from "@/lib/tcp-http-client";

export { useLyraSelector, useLyraState, useLyraStore };

export function LyraProvider({ children }: { children: ReactNode }) {
  const { isDark } = useAppTheme();
  const storage = useMemo(() => createSecureLyraStorage(), []);
  const [storageReady, setStorageReady] = useState(false);

  // Peer ops use TCP sockets (not RN fetch) for reliable cleartext POST on LAN/Tailscale
  useEffect(() => {
    return installNativePeerHttpTransport();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (storage.hydrate) await storage.hydrate();
        await migratePrivateKeyToSecureStore(storage);
        // Ensure any pending writes from migration are flushed (SQLite is sync)
        if (storage.flush) await storage.flush();
      } catch (err) {
        console.warn("[lyra] storage hydrate failed", err);
      }
      if (!cancelled) setStorageReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  // Flush pending AsyncStorage writes when app goes to background (durability for reload)
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" || next === "inactive") {
        void storage.flush?.().catch(() => {});
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {}
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
    let discoveryHandle: NativeDiscoveryHandle | null = null;

    // Recheck mutual trust shortly after startup (detect remote unpair)
    const trustTimer = setTimeout(() => {
      if (!cancelled) void store.recheckPairedTrust();
    }, 2000);

    const refreshLocalIp = async () => {
      try {
        const info = await getLanHosts();
        // Prefer first LAN IP; store primary for advertising. Also store all via hint side-effect.
        const primary = info.primaryIp;
        if (primary) {
          store.setLocalLanHint(primary);
          // Also expose tailscale separately via side stored value if needed (store keeps hint as primary)
          // For multi-host discovery, refreshDiscovery now reads all via getLanHosts fallback inside store
          // when localLanHint is tailscale — but we now set correct LAN primary so scan is correct.
        } else if (info.lanIps.length > 0) {
          store.setLocalLanHint(info.lanIps[0]!);
        }
        // If we have tailscale IP, trigger tailscale probe path
        if (info.tailscaleIp) {
          // Seed hint for probeTailscalePeers without waiting for desktop push
          // (store treats tailscalePeerHints separately; we keep localLanHint as LAN to avoid scan bias)
        }
      } catch {
        // Fallback to legacy single IP
        try {
          const ip = await Network.getIpAddressAsync();
          if (ip && ip !== "0.0.0.0" && ip !== "127.0.0.1") store.setLocalLanHint(ip);
        } catch {}
      }
    };
    void refreshLocalIp();
    // Re-check IP when network changes (Wi‑Fi ↔ Tailscale / Wi‑Fi toggle)
    let netDiscoverTimer: ReturnType<typeof setTimeout> | null = null;
    const netSub = Network.addNetworkStateListener?.((state) => {
      void refreshLocalIp();
      // Kick discovery when we gain connectivity so devices reappear
      if (state?.isConnected && store.getState().settings.discoveryEnabled) {
        if (netDiscoverTimer) clearTimeout(netDiscoverTimer);
        netDiscoverTimer = setTimeout(() => {
          netDiscoverTimer = null;
          void store.refreshDiscovery();
        }, 1500);
      }
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

      // Reset ephemeral random port (e.g. 44119 from fallback to 0) back to variant default + migrate dev/preview defaults
      try {
        const variant = resolveNativeVariant();
        const variantDefault = nativeVariantDefaultPort(variant);
        const currentPort = store.getState().settings.peerListenPort ?? variantDefault;
        const knownPorts = new Set([53317, 53319, 53321, 53327, 53329, 53337, 53339]);
        if (currentPort > 40000 && !knownPorts.has(currentPort)) {
          console.info(`[lyra] resetting ephemeral peerListenPort ${currentPort} → ${variantDefault}`);
          store.updateSettings({ peerListenPort: variantDefault });
        }
        // Migrate stale defaults so `pnpm dev` desktop (53317) and mobile (53319) don't collide
        if (variant === "development" && currentPort === 53317 && !nativePreferredPortFromEnv()) {
          console.info("[lyra] migrating dev peer port 53317 → 53319 (desktop/mobile separation)");
          store.updateSettings({ peerListenPort: 53319 });
        }
        if (variant === "preview" && currentPort === 53327 && !nativePreferredPortFromEnv()) {
          console.info("[lyra] migrating preview peer port 53327 → 53329");
          store.updateSettings({ peerListenPort: 53329 });
        }
      } catch {}
      try {
        const envPort = nativePreferredPortFromEnv();
        const variantDefault = nativeDefaultPortFromEnv();
        const stored = store.getState().settings.peerListenPort;
        const preferred = envPort ?? stored ?? variantDefault;
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
            // Phone file serving — expose Downloads/Documents/Photos via SAF
            onFsList: async (fsPath: string) => {
              try {
                const { listPhoneFiles } = await import("@/lib/fs-saf");
                const entries = await listPhoneFiles(fsPath);
                return entries.map((e) => ({ name: e.name, path: e.path, isDirectory: e.isDirectory, size: e.size, modifiedAt: e.modifiedAt }));
              } catch (e) {
                console.warn("[lyra] fs list failed", e);
                return [];
              }
            },
            onFsRead: async (fsPath: string, offset: number, maxBytes: number) => {
              try {
                const { readPhoneFileChunk } = await import("@/lib/fs-saf");
                const res = await readPhoneFileChunk(fsPath, offset ?? 0, maxBytes ?? 256 * 1024);
                if ("error" in res) throw new Error(res.error);
                // message-handlers expects {data:Uint8Array, eof, size}
                const data = res.dataBase64 ? (() => {
                  try { return Uint8Array.from(atob(res.dataBase64), (c) => c.charCodeAt(0)); } catch { return new Uint8Array(); }
                })() : new Uint8Array();
                // Need to decode base64 already done; return Uint8Array form
                // But our readPhoneFileChunk returns base64; handlers expects Uint8Array — convert via transfer-wire helper
                const { base64ToBytes } = await import("@lyra-sync-app/net");
                return { data: base64ToBytes(res.dataBase64), eof: res.eof, size: res.size };
              } catch (e) {
                throw e instanceof Error ? e : new Error(String(e));
              }
            },
            onPairRequest: (payload) => {
              store.enqueuePairRequest(payload, "wire");
            },
            onClipboardPush: (item) => {
              store.receiveClipboardItem(item as import("@lyra-sync-app/protocol").ClipboardItem);
              // Mirror into OS clipboard when auto-accept is on
              const auto =
                store.getState().settings.autoAcceptClipboard ||
                store.getState().settings.clipboardSyncEnabled;
              if (auto && item.type === "text" && item.text) {
                void import("expo-clipboard").then((Clipboard) =>
                  Clipboard.setStringAsync(item.text!).catch(() => undefined),
                );
              }
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
            onTransferOffer: (state, fromDeviceId, fromDeviceName) => {
              store.handleIncomingTransferOffer({
                transferId: state.transferId,
                files: state.files,
                totalBytes: state.totalBytes,
                fromDeviceId,
                fromDeviceName,
                resumeOffset: state.receivedBytes,
              });
            },
            onTransferChunk: (state) => {
              store.updateIncomingTransferProgress(state.transferId, state.receivedBytes, state.totalBytes);
            },
            onTransferPaused: (transferId) => {
              store.handleTransferPaused(transferId);
            },
            onTransferResumed: (transferId, _from, resumeOffset) => {
              store.handleTransferResumed(transferId, resumeOffset);
            },
            onTransferCancelled: (transferId) => {
              store.handleTransferCancelled(transferId);
            },
            onTransferComplete: (state) => {
              void (async () => {
                let savedPaths: string[] | undefined;
                try {
                  const { saveReceivedTransferFiles, ensureDefaultDownloadDir } =
                    await import("@/lib/download-location");
                  const dir =
                    store.getState().settings.downloadDirectory ||
                    (await ensureDefaultDownloadDir())?.path;
                  if (state.chunks?.length && state.files?.length) {
                    const { savedPaths: paths, errors } = await saveReceivedTransferFiles(
                      dir,
                      state.files,
                      state.chunks,
                    );
                    if (paths.length) savedPaths = paths;
                    if (errors.length) {
                      console.warn("[lyra] save transfer errors", errors);
                    }
                  } else if (state.diskPath) {
                    // Disk-backed transfer: file already saved to temp, record it
                    savedPaths = [state.diskPath];
                  }
                } catch (e) {
                  console.warn(
                    "[lyra] save transfer failed",
                    e instanceof Error ? e.message : e,
                  );
                }
                store.recordReceivedTransfer({
                  transferId: state.transferId,
                  files: state.files,
                  receivedBytes: state.receivedBytes,
                  deviceName: "Peer",
                  savedPaths,
                });
              })();
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
        store.setTransferControl({
          pause: (id) => peer.pauseTransfer(id),
          resume: (id, offset) => peer.resumeTransfer(id, offset),
          cancel: (id) => peer.cancelTransfer(id),
        });
        detachPeer = attachNativePeerToStore(store, peer);
        // Native multicast discovery (LocalSend-style) — instant LAN discovery without HTTP scan
        try {
          discoveryHandle = await startNativeDiscovery(store);
          if (discoveryHandle) {
            console.info("[lyra] native discovery started");
          }
        } catch (e) {
          console.warn("[lyra] native discovery failed", e);
        }
        // Foreground service: keep peer reachable in background (user accepted persistent notification)
        try {
          // Dynamically import expo module to avoid crash when not prebuilt
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const mod = require("expo-modules-core") as { NativeModulesProxy?: Record<string, { start?: () => Promise<boolean> }> };
          const fg = mod.NativeModulesProxy?.["LyraForeground"];
          if (fg?.start) {
            void fg.start().catch(() => {});
          } else {
            // Fallback via NativeModules
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const RN = require("react-native") as { NativeModules?: Record<string, { start?: () => Promise<boolean> }> };
            void RN.NativeModules?.["LyraForeground"]?.start?.().catch(() => {});
          }
        } catch {}
        // Background clipboard via AccessibilityService (if enabled)
        try {
          const { NativeModules, NativeEventEmitter } = require("react-native") as {
            NativeModules: Record<string, unknown>;
            NativeEventEmitter: new (m: unknown) => { addListener: (e: string, cb: (d: unknown) => void) => { remove: () => void } };
          };
          const mod = (NativeModules as Record<string, { addListener?: unknown }>)["LyraClipboard"];
          if (mod) {
            // Poll last clipboard via module when AppState becomes active
            const check = async () => {
              try {
                const res = await (mod as unknown as { getLastClipboard?: () => Promise<string | null> }).getLastClipboard?.();
                if (typeof res === "string" && res.trim()) {
                  const text = res.trim();
                  // Avoid feedback loop: only ingest if different from last system clipboard
                  store.ingestSystemClipboardText(text, { sync: Boolean(store.getState().settings.clipboardSyncEnabled) });
                }
              } catch {}
            };
            const sub = AppState.addEventListener("change", (s) => {
              if (s === "active") void check();
            });
            // also listen to native event if emitted
            try {
              const em = new NativeEventEmitter(mod as unknown as object);
              const evSub = em.addListener("onClipboardChanged", (data: unknown) => {
                const d = data as { text?: string } | string;
                const t = typeof d === "string" ? d : d?.text;
                if (typeof t === "string" && t.trim()) store.ingestSystemClipboardText(t.trim(), { sync: true });
              });
              // cleanup on peer stop via closure
              const prevDetach = detachPeer;
              detachPeer = () => {
                try { evSub.remove(); } catch {}
                try { sub.remove(); } catch {}
                prevDetach?.();
              };
            } catch {}
          }
        } catch {}
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
      clearTimeout(trustTimer);
      if (netDiscoverTimer) clearTimeout(netDiscoverTimer);
      try {
        netSub?.remove?.();
      } catch {
        // ignore
      }
      detachPeer?.();
      detachPeer = null;
      store.setTransferControl(null);
      void peerHandle?.stop();
      peerHandle = null;
      void discoveryHandle?.stop();
      discoveryHandle = null;
      // Stop foreground service
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("expo-modules-core") as { NativeModulesProxy?: Record<string, { stop?: () => Promise<boolean> }> };
        void mod.NativeModulesProxy?.["LyraForeground"]?.stop?.().catch(() => {});
      } catch {}
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const RN = require("react-native") as { NativeModules?: Record<string, { stop?: () => Promise<boolean> }> };
        void RN.NativeModules?.["LyraForeground"]?.stop?.().catch(() => {});
      } catch {}
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
