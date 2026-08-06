import type { DeviceIdentity } from "@lyra-sync-app/protocol";
import type { DiscoveredPeer } from "./types.js";

export type DiscoveryOptions = {
  identity: DeviceIdentity;
  peerPort: number;
  advertiseHost?: string;
  getPairingOffer: () => { codeHash: string; token: string; expiresAt: number } | null;
  onPeer: (peer: DiscoveredPeer) => void;
  onLog?: (msg: string) => void;
};

export type DiscoveryHandle = {
  stop: () => Promise<void> | void;
  announce: () => void;
  localAddresses: string[];
};

const MULTICAST_ADDR = "239.255.255.250";
const MULTICAST_PORT = 53317;

function _getLocalAddresses(): string[] {
  try {
    const nodeOs = eval("require")("os") as typeof import("node:os");
    const ifaces = nodeOs.networkInterfaces();
    const addrs: string[] = [];
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const info of list) if (info.family === "IPv4" && !info.internal) addrs.push(info.address);
    }
    return addrs;
  } catch {
    return [];
  }
}
void _getLocalAddresses;

/**
 * createMulticastAnnouncer — stub for future full implementation.
 */
export function createMulticastAnnouncer(_opts: DiscoveryOptions): { announce: () => void } {
  return { announce: () => {} };
}

/**
 * startDiscovery — Node-only discovery via UDP multicast + optional bonjour.
 * Falls back to stub that logs and simulates if dgram is unavailable (e.g. web).
 */
export function startDiscovery(opts: DiscoveryOptions): DiscoveryHandle {
  const log = opts.onLog ?? (() => {});
  const localAddresses = (() => {
    try {
      const nodeOs = eval("require")("os") as typeof import("node:os");
      const ifaces = nodeOs.networkInterfaces();
      const addrs: string[] = [];
      for (const list of Object.values(ifaces)) {
        if (!list) continue;
        for (const info of list) if (info.family === "IPv4" && !info.internal) addrs.push(info.address);
      }
      return addrs;
    } catch {
      return [];
    }
  })();

  let socket: import("node:dgram").Socket | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let bonjour: unknown = null;
  let service: unknown = null;

  function announce(): void {
    const offer = opts.getPairingOffer();
    const payload = JSON.stringify({
      v: 2,
      id: opts.identity.id,
      name: opts.identity.name,
      fingerprint: opts.identity.fingerprint,
      publicKey: opts.identity.publicKey,
      port: opts.peerPort,
      host: opts.advertiseHost,
      pairing: offer ?? undefined,
    });
    if (socket) {
      try {
        const buf = Buffer.from(payload, "utf8");
        socket.send(buf, MULTICAST_PORT, MULTICAST_ADDR, (err) => {
          if (err) log(`multicast announce error: ${String(err)}`);
          else log(`multicast announce sent ${buf.length}B`);
        });
      } catch (err) {
        log(`announce failed: ${String(err)}`);
      }
    } else {
      log(`[stub] announce ${payload.slice(0, 120)}`);
    }
  }

  // try to bind dgram
  try {
    const dgram = eval("require")("node:dgram") as typeof import("node:dgram");
    socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    socket.on("error", (err) => log(`multicast error: ${String(err)}`));
    socket.on("message", (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString("utf8")) as Record<string, unknown>;
        if (typeof data["id"] !== "string" || typeof data["fingerprint"] !== "string") return;
        if (data["id"] === opts.identity.id) return; // self
        const peer: DiscoveredPeer = {
          identity: {
            id: data["id"] as string,
            name: (data["name"] as string) ?? "Unknown",
            fingerprint: data["fingerprint"] as string,
            publicKey: typeof data["publicKey"] === "string" ? (data["publicKey"] as string) : undefined,
            type: typeof data["type"] === "string" ? (data["type"] as string) : undefined,
            platform: typeof data["platform"] === "string" ? (data["platform"] as string) : undefined,
          },
          host: (data["host"] as string) ?? rinfo.address,
          port: typeof data["port"] === "number" ? (data["port"] as number) : MULTICAST_PORT,
          pairing: (data["pairing"] as DiscoveredPeer["pairing"]) ?? undefined,
        };
        opts.onPeer(peer);
      } catch {
        // ignore malformed
      }
    });

    socket.bind(MULTICAST_PORT, () => {
      try {
        socket?.addMembership(MULTICAST_ADDR);
        socket?.setMulticastTTL(2);
        socket?.setMulticastLoopback(true);
        log(`multicast listening on ${MULTICAST_ADDR}:${MULTICAST_PORT}`);
        announce();
        interval = setInterval(announce, 30_000);
      } catch (err) {
        log(`multicast bind setup failed: ${String(err)}`);
      }
    });
  } catch (err) {
    log(`dgram unavailable, stub discovery: ${String(err)}`);
    // simulate stub announce burst
    announce();
    interval = setInterval(announce, 30_000);
  }

  // bonjour if available
  try {
    const Bonjour = eval("require")("bonjour-service") as unknown as { Bonjour: new () => { publish: (o: unknown) => unknown; unpublishAll: (cb?: () => void) => void; destroy: () => void } };
    const instance = new Bonjour.Bonjour();
    bonjour = instance;
    service = instance.publish({
      name: `Lyra ${opts.identity.name}`,
      type: "_lyra._tcp",
      port: opts.peerPort,
      txt: { id: opts.identity.id, fp: opts.identity.fingerprint },
    } as unknown as never);
    log(`bonjour published _lyra._tcp :${opts.peerPort}`);
  } catch {
    log("bonjour-service not available, skipping mDNS");
  }

  return {
    stop: () => {
      if (interval) clearInterval(interval);
      interval = null;
      try {
        socket?.close();
      } catch {}
      socket = null;
      try {
        (service as { stop?: () => void } | null)?.stop?.();
        (bonjour as { destroy?: () => void } | null)?.destroy?.();
        (bonjour as { unpublishAll?: (cb?: () => void) => void } | null)?.unpublishAll?.();
      } catch {}
    },
    announce,
    localAddresses,
  };
}
