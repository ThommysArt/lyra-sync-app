/**
 * Android multicast discovery for React Native (LocalSend-style).
 * Uses native LyraDiscovery module (MulticastSocket 224.0.0.167:53318) to
 * announce and listen, mirroring packages/net/src/node/discovery.ts
 * but for Android's NetworkInterface + MulticastLock setup.
 *
 * Falls back to no-op when native module unavailable (Expo Go / iOS).
 */
import { LYRA_DEFAULT_PORT, LYRA_PROTOCOL_VERSION } from "@lyra-sync-app/protocol";
import { DiscoverAnnouncePayloadSchema } from "@lyra-sync-app/protocol";
import type { LyraStore } from "@lyra-sync-app/core";
import { NativeEventEmitter, NativeModules } from "react-native";

const MULTICAST_GROUP = "224.0.0.167";
const MULTICAST_PORT = 53318;

type NativeDiscovery = {
  start: (port?: number) => Promise<boolean>;
  announce: (json: string, port?: number) => Promise<boolean>;
  stop: () => Promise<boolean>;
  addListener?: (event: string, cb: (data: unknown) => void) => { remove: () => void };
};

function getNative(): NativeDiscovery | null {
  try {
    // expo-modules
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expo = require("expo-modules-core") as { NativeModulesProxy?: Record<string, NativeDiscovery> };
    const m = expo.NativeModulesProxy?.["LyraDiscovery"];
    if (m) return m;
  } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require("react-native") as { NativeModules: Record<string, NativeDiscovery> };
    const m = RN.NativeModules["LyraDiscovery"];
    if (m) return m;
  } catch {}
  return null;
}

export type NativeDiscoveryHandle = {
  announce: () => void;
  stop: () => Promise<void>;
};

export async function startNativeDiscovery(store: LyraStore): Promise<NativeDiscoveryHandle | null> {
  const native = getNative();
  if (!native) {
    console.info("[lyra discover] native LyraDiscovery unavailable (Expo Go / iOS)");
    return null;
  }

  const ok = await native.start(MULTICAST_PORT).catch(() => false);
  if (!ok) {
    console.warn("[lyra discover] native start failed");
    return null;
  }
  console.info(`[lyra discover] native listening on ${MULTICAST_GROUP}:${MULTICAST_PORT}`);

  let stopped = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  const recentReplies = new Map<string, number>();

  const buildPayload = (announce: boolean) => {
    const s = store.getState();
    const identity = s.identity;
    if (!identity) return null;
    const port = s.peerServer.port ?? s.settings.peerListenPort ?? LYRA_DEFAULT_PORT;
    // Prefer LAN host from network helper if available, else localLanHint
    const host = s.localLanHint || s.peerServer.lanHost || "0.0.0.0";
    const pairing = s.activePairing
      ? (() => {
          try {
            // activePairing is {code, token, payload} — we need hash; store keeps codeHash in lanPairingOffers?
            // Instead derive from activePairing: hashPairingCode is async, so we cache hash via store's announce logic
            // For now, if activePairing exists, try to use its payload's hash if available via peerServer pairingOffer
            // Simpler: if we have activePairing, we don't have hash yet — skip pairing field
            // The store's ingestDiscoveredPeer will handle pairing via HTTP info fallback
            return undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;

    // Try to include pairing offer hash if store has active pairing session
    let pairingOffer: { codeHash: string; token: string; expiresAt: number } | undefined;
    const active = (s as unknown as { activePairing?: { code: string; token: string; expiresAt: number; payload?: { codeHash?: string } } }).activePairing;
    if (active && active.token && active.expiresAt > Date.now()) {
      // We need codeHash — if not in payload, fallback to undefined (HTTP info will serve it)
      // But we can try to compute via hashPairingCode if code available
      // For now, leave undefined to avoid leaking code
    }
    // Also check if native peer server has pairingOffer (hashed) via store's lanPairingOffers? Not needed.

    const payload = {
      identity: {
        id: identity.id,
        name: identity.name,
        type: identity.type,
        platform: identity.platform,
        fingerprint: identity.fingerprint,
        publicKey: identity.publicKey,
      },
      host,
      port,
      protocolVersion: LYRA_PROTOCOL_VERSION,
      announce,
      pairing: pairingOffer,
    };
    const parsed = DiscoverAnnouncePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn("[lyra discover] payload invalid", parsed.error.message);
      return null;
    }
    return JSON.stringify({ type: announce ? "discover_announce" : "discover_response", payload: parsed.data, timestamp: Date.now() });
  };

  const sendAnnounce = async (announce: boolean) => {
    const json = buildPayload(announce);
    if (!json) return;
    try {
      await native.announce(json, MULTICAST_PORT);
    } catch (e) {
      console.warn("[lyra discover] announce failed", e);
    }
  };

  const burst = () => {
    void sendAnnounce(true);
    setTimeout(() => void sendAnnounce(true), 100);
    setTimeout(() => void sendAnnounce(true), 500);
    setTimeout(() => void sendAnnounce(true), 2000);
  };

  // Periodic announce every 5s (like Node)
  const interval = setInterval(() => {
    if (!stopped) void sendAnnounce(true);
  }, 5000);

  // Initial burst
  burst();

  // Provide announce for store's discoveryAnnouncer
  store.setDiscoveryAnnouncer(() => burst());

  // Listen for peers
  let sub: { remove: () => void } | null = null;
  try {
    const modForEvents = (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const expo = require("expo-modules-core") as { NativeModulesProxy?: Record<string, unknown> };
        return expo.NativeModulesProxy?.["LyraDiscovery"] as unknown;
      } catch {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const RN = require("react-native") as { NativeModules: Record<string, unknown> };
        return RN.NativeModules["LyraDiscovery"];
      }
    })();
    if (modForEvents) {
      const emitter = new NativeEventEmitter(modForEvents as unknown as object);
      sub = emitter.addListener("onPeerAnnounce", (data: unknown) => {
        try {
          const d = data as { json?: string; remoteAddress?: string };
          const raw = d?.json;
          if (!raw || typeof raw !== "string") return;
          const parsedOuter = JSON.parse(raw) as { type?: string; payload?: unknown; timestamp?: number };
          const payload = parsedOuter.payload;
          const res = DiscoverAnnouncePayloadSchema.safeParse(payload);
          if (!res.success) return;
          const announce = res.data;
          const remote = d.remoteAddress?.trim() || "";
          // Ignore self
          const selfId = store.getState().identity?.id;
          const selfFp = store.getState().identity?.fingerprint;
          if (announce.identity.id === selfId || announce.identity.fingerprint === selfFp) return;
          // Prefer remoteAddress when advertised host is loopback/0.0.0.0 (like Node does)
          const advertHost = announce.host?.trim() || remote;
          const host = advertHost === "0.0.0.0" || advertHost === "127.0.0.1" || advertHost === "::" ? remote || advertHost : advertHost;
          if (!host) return;
          const toIngest = { ...announce, host };
          store.ingestDiscoveredPeer(toIngest as unknown as Parameters<LyraStore["ingestDiscoveredPeer"]>[0]);

          // Reply to announcements (dual-visibility handshake) with jitter 50-150ms, deduped 2s
          if (announce.announce) {
            const key = `${announce.identity.id}:${announce.host}`;
            const now = Date.now();
            const last = recentReplies.get(key) ?? 0;
            if (now - last < 2000) return;
            recentReplies.set(key, now);
            const jitter = 50 + Math.random() * 100;
            setTimeout(() => void sendAnnounce(false), jitter);
          }
        } catch (e) {
          console.warn("[lyra discover] peer parse failed", e);
        }
      });
    }
  } catch (e) {
    console.warn("[lyra discover] native listener failed", e);
  }

  return {
    announce: burst,
    stop: async () => {
      stopped = true;
      if (announceTimer) clearTimeout(announceTimer);
      clearInterval(interval);
      try { sub?.remove(); } catch {}
      try { await native.stop(); } catch {}
    },
  };
}
