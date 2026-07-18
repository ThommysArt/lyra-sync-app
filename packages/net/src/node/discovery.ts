import { createSocket, type Socket } from "node:dgram";

import {
  DiscoverAnnouncePayloadSchema,
  LYRA_DEFAULT_PORT,
  LYRA_PROTOCOL_VERSION,
  type DeviceIdentity,
  type DiscoverAnnouncePayload,
} from "@lyra-sync-app/protocol";

/** LocalSend-inspired multicast group / port for LAN discovery. */
export const LYRA_MULTICAST_ADDRESS = "224.0.0.167";
export const LYRA_MULTICAST_PORT = 53318;

export type DiscoveryHandle = {
  stop: () => Promise<void>;
  announce: () => void;
};

export type DiscoveryOptions = {
  identity: DeviceIdentity;
  /** HTTP peer port advertised in announces */
  peerPort?: number;
  /** Multicast port (default 53318) */
  multicastPort?: number;
  multicastAddress?: string;
  announceIntervalMs?: number;
  onPeer?: (announce: DiscoverAnnouncePayload, rinfo: { address: string; port: number }) => void;
  /** Optional host override advertised to peers */
  advertiseHost?: string;
};

/**
 * UDP multicast discovery (Node / Electron only).
 * Browsers cannot bind multicast sockets — desktop shell hosts this.
 */
export async function startDiscovery(options: DiscoveryOptions): Promise<DiscoveryHandle> {
  const multicastPort = options.multicastPort ?? LYRA_MULTICAST_PORT;
  const multicastAddress = options.multicastAddress ?? LYRA_MULTICAST_ADDRESS;
  const peerPort = options.peerPort ?? LYRA_DEFAULT_PORT;
  const intervalMs = options.announceIntervalMs ?? 5_000;

  const socket: Socket = createSocket({ type: "udp4", reuseAddr: true });

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(multicastPort, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
        socket.addMembership(multicastAddress);
      } catch {
        // membership may fail on some interfaces; announce still works as broadcast-ish
      }
      resolve();
    });
  });

  const buildPayload = (): DiscoverAnnouncePayload =>
    DiscoverAnnouncePayloadSchema.parse({
      identity: {
        id: options.identity.id,
        name: options.identity.name,
        type: options.identity.type,
        platform: options.identity.platform,
        fingerprint: options.identity.fingerprint,
        publicKey: options.identity.publicKey,
      },
      host: options.advertiseHost ?? "0.0.0.0",
      port: peerPort,
      protocolVersion: LYRA_PROTOCOL_VERSION,
    });

  const announce = () => {
    const payload = buildPayload();
    const buf = Buffer.from(
      JSON.stringify({
        type: "discover_announce",
        payload,
        timestamp: Date.now(),
      }),
      "utf8",
    );
    socket.send(buf, 0, buf.length, multicastPort, multicastAddress);
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
      // Prefer sender address when advertised host is placeholder
      const host =
        announceParsed.data.host === "0.0.0.0" || announceParsed.data.host === "::"
          ? rinfo.address
          : announceParsed.data.host;
      options.onPeer?.({ ...announceParsed.data, host }, rinfo);
    } catch {
      // ignore malformed
    }
  });

  announce();
  const timer = setInterval(announce, intervalMs);

  return {
    announce,
    stop: async () => {
      clearInterval(timer);
      await new Promise<void>((resolve) => {
        try {
          socket.dropMembership(multicastAddress);
        } catch {
          // ignore
        }
        socket.close(() => resolve());
      });
    },
  };
}
