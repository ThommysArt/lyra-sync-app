/**
 * LAN discovery — LocalSend-inspired design:
 *
 * 1. UDP multicast on 224.0.0.167 (Android-friendly /24 range)
 * 2. One socket membership **per IPv4 interface** (critical on Linux)
 * 3. Announce burst (100ms / 500ms / 2s) so late joiners catch us
 * 4. Reply to announcements so both sides learn each other (not one-way only)
 * 5. Advertise real LAN IP + HTTP peer port in the payload
 *
 * Browsers cannot bind multicast — desktop/Electron hosts this.
 */
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

import {
  DiscoverAnnouncePayloadSchema,
  LYRA_DEFAULT_PORT,
  LYRA_PROTOCOL_VERSION,
  type DeviceIdentity,
  type DiscoverAnnouncePayload,
} from "@lyra-sync-app/protocol";

/** LocalSend default multicast group (224.0.0.0/24 works on more Android devices). */
export const LYRA_MULTICAST_ADDRESS = "224.0.0.167";
/**
 * UDP discovery port. LocalSend uses the same port as HTTP (53317).
 * We keep a dedicated discovery port to avoid clashing with the HTTP peer server
 * binding — both sides must agree on this constant.
 */
export const LYRA_MULTICAST_PORT = 53318;

export type DiscoveryHandle = {
  stop: () => Promise<void>;
  /** Fire an announce burst (call when user taps Refresh discovery). */
  announce: () => void;
  /** Local non-loopback IPv4 addresses currently used for membership. */
  localAddresses: () => string[];
};

export type DiscoveryOptions = {
  identity: DeviceIdentity;
  /** HTTP peer port advertised in announces */
  peerPort?: number;
  /** Multicast port (default 53318) */
  multicastPort?: number;
  multicastAddress?: string;
  /** Periodic re-announce interval (default 5s like continuous presence) */
  announceIntervalMs?: number;
  onPeer?: (announce: DiscoverAnnouncePayload, rinfo: { address: string; port: number }) => void;
  /** Optional single host override (otherwise per-interface address is used) */
  advertiseHost?: string;
  /**
   * Active pairing offer to embed in announces (code hash only).
   * Called on every announce so joiners can match short codes from multicast.
   */
  getPairingOffer?: () =>
    | { codeHash: string; token: string; expiresAt: number }
    | null
    | undefined;
  /** Log diagnostic lines (Electron main / CLI) */
  onLog?: (line: string) => void;
};

type IPv4Iface = { name: string; address: string };

function listIPv4Interfaces(): IPv4Iface[] {
  const out: IPv4Iface[] = [];
  const nets = networkInterfaces();
  for (const [name, entries] of Object.entries(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      const family = net.family as string | number;
      const isV4 = family === "IPv4" || family === 4;
      if (!isV4 || net.internal) continue;
      out.push({ name, address: net.address });
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * UDP multicast discovery (Node / Electron only).
 */
export async function startDiscovery(options: DiscoveryOptions): Promise<DiscoveryHandle> {
  const multicastPort = options.multicastPort ?? LYRA_MULTICAST_PORT;
  const multicastAddress = options.multicastAddress ?? LYRA_MULTICAST_ADDRESS;
  const peerPort = options.peerPort ?? LYRA_DEFAULT_PORT;
  const intervalMs = options.announceIntervalMs ?? 5_000;
  const log = (line: string) => {
    options.onLog?.(line);
  };

  let ifaces = listIPv4Interfaces();
  if (ifaces.length === 0) {
    // Still bind — loopback-only environments (CI) can use 127.0.0.1 for same-host tests
    ifaces = [{ name: "lo", address: "127.0.0.1" }];
    log("[discover] no non-loopback IPv4; using 127.0.0.1 for membership");
  }

  const socket: Socket = createSocket({ type: "udp4", reuseAddr: true });

  // Node may support SO_REUSEPORT on some platforms (helps multi-instance same host)
  try {
    // @ts-expect-error — not in all @types/node versions
    socket.setReusePort?.(true);
  } catch {
    // ignore
  }

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(multicastPort, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
        // Allow same-machine multi-instance testing
        socket.setMulticastLoopback(true);
      } catch (e) {
        log(`[discover] socket opts: ${e instanceof Error ? e.message : e}`);
      }

      // LocalSend pattern: join multicast group on **each** interface
      for (const iface of ifaces) {
        try {
          socket.addMembership(multicastAddress, iface.address);
          log(`[discover] joined ${multicastAddress} on ${iface.name} (${iface.address})`);
        } catch (e) {
          // Fallback: membership without interface (some platforms)
          try {
            socket.addMembership(multicastAddress);
            log(`[discover] joined ${multicastAddress} (default) after ${iface.address} failed`);
          } catch (e2) {
            log(
              `[discover] membership failed on ${iface.address}: ${e instanceof Error ? e.message : e}; ${e2 instanceof Error ? e2.message : e2}`,
            );
          }
        }
      }
      resolve();
    });
  });

  /** Track peers we recently replied to so we don't UDP-flood */
  const recentReplies = new Map<string, number>();

  const buildPayload = (opts: {
    announce: boolean;
    host: string;
  }): DiscoverAnnouncePayload => {
    const offer = options.getPairingOffer?.() ?? null;
    const pairing =
      offer && offer.expiresAt > Date.now()
        ? {
            codeHash: offer.codeHash,
            token: offer.token,
            expiresAt: offer.expiresAt,
          }
        : undefined;
    return DiscoverAnnouncePayloadSchema.parse({
      identity: {
        id: options.identity.id,
        name: options.identity.name,
        type: options.identity.type,
        platform: options.identity.platform,
        fingerprint: options.identity.fingerprint,
        publicKey: options.identity.publicKey,
      },
      host: opts.host,
      port: peerPort,
      protocolVersion: LYRA_PROTOCOL_VERSION,
      announce: opts.announce,
      pairing,
    });
  };

  /**
   * Send one datagram. Prefer sending via each interface (setMulticastInterface)
   * so multi-homed machines reach every LAN.
   */
  const sendRaw = (buf: Buffer) => {
    const targets = ifaces.length > 0 ? ifaces : [{ name: "any", address: "0.0.0.0" }];
    for (const iface of targets) {
      try {
        try {
          socket.setMulticastInterface(iface.address);
        } catch {
          // setMulticastInterface not always available / required
        }
        socket.send(buf, 0, buf.length, multicastPort, multicastAddress);
      } catch (e) {
        log(`[discover] send via ${iface.address} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  const sendAnnounce = (announceFlag: boolean) => {
    // Refresh interfaces in case Wi‑Fi changed
    const current = listIPv4Interfaces();
    if (current.length > 0) ifaces = current;

    const primaryHost =
      options.advertiseHost &&
      options.advertiseHost !== "0.0.0.0" &&
      options.advertiseHost !== "127.0.0.1"
        ? options.advertiseHost
        : (ifaces.find((i) => i.address !== "127.0.0.1")?.address ??
          ifaces[0]?.address ??
          "0.0.0.0");

    const payload = buildPayload({ announce: announceFlag, host: primaryHost });
    const buf = Buffer.from(
      JSON.stringify({
        type: announceFlag ? "discover_announce" : "discover_response",
        payload,
        timestamp: Date.now(),
      }),
      "utf8",
    );
    sendRaw(buf);
    log(
      `[discover] ${announceFlag ? "announce" : "reply"} as ${options.identity.name} @ ${primaryHost}:${peerPort}`,
    );
  };

  /** LocalSend-style burst so flaky networks still see us */
  let burstRunning = false;
  const announceBurst = () => {
    if (burstRunning) return;
    burstRunning = true;
    void (async () => {
      try {
        for (const wait of [0, 100, 500, 2000]) {
          if (wait) await sleep(wait);
          sendAnnounce(true);
        }
      } finally {
        burstRunning = false;
      }
    })();
  };

  socket.on("message", (msg, rinfo) => {
    try {
      const parsed = JSON.parse(msg.toString("utf8")) as {
        type?: string;
        payload?: unknown;
      };
      if (parsed.type !== "discover_announce" && parsed.type !== "discover_response") return;
      const announceParsed = DiscoverAnnouncePayloadSchema.safeParse(parsed.payload);
      if (!announceParsed.success) return;
      if (announceParsed.data.identity.id === options.identity.id) return;
      // Same fingerprint = us under another id (identity swap race) — ignore
      if (announceParsed.data.identity.fingerprint === options.identity.fingerprint) return;

      const host =
        !announceParsed.data.host ||
        announceParsed.data.host === "0.0.0.0" ||
        announceParsed.data.host === "::"
          ? rinfo.address
          : announceParsed.data.host;

      // Prefer UDP source IP when advertised host is loopback (useless to us)
      const reachHost =
        host === "127.0.0.1" || host === "localhost" ? rinfo.address : host;

      const peer: DiscoverAnnouncePayload = {
        ...announceParsed.data,
        host: reachHost,
      };

      log(
        `[discover] saw ${peer.identity.name} @ ${peer.host}:${peer.port} from ${rinfo.address} (${parsed.type})`,
      );
      options.onPeer?.(peer, rinfo);

      // LocalSend: if this was an announcement, reply so the other side sees us too.
      // (Periodic announces alone are one-way if multicast is asymmetric.)
      const isAnnouncement =
        parsed.type === "discover_announce" ||
        announceParsed.data.announce === true;
      if (isAnnouncement) {
        const key = peer.identity.id;
        const last = recentReplies.get(key) ?? 0;
        if (Date.now() - last > 2_000) {
          recentReplies.set(key, Date.now());
          // Small delay so we don't pile onto the same burst window
          void sleep(50 + Math.floor(Math.random() * 100)).then(() => sendAnnounce(false));
        }
      }
    } catch {
      // ignore malformed
    }
  });

  socket.on("error", (err) => {
    log(`[discover] socket error: ${err.message}`);
  });

  // Immediate presence + burst
  announceBurst();
  const timer = setInterval(() => sendAnnounce(true), intervalMs);

  return {
    announce: announceBurst,
    localAddresses: () => listIPv4Interfaces().map((i) => i.address),
    stop: async () => {
      clearInterval(timer);
      await new Promise<void>((resolve) => {
        for (const iface of ifaces) {
          try {
            socket.dropMembership(multicastAddress, iface.address);
          } catch {
            try {
              socket.dropMembership(multicastAddress);
            } catch {
              // ignore
            }
          }
        }
        socket.close(() => resolve());
      });
    },
  };
}

/** All non-loopback IPv4 addresses (for HTTP /24 scan seeds). */
export function listLocalIPv4Addresses(): string[] {
  return listIPv4Interfaces().map((i) => i.address);
}
