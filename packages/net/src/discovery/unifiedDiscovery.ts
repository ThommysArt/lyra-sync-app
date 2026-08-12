/**
 * Unified Discovery Service — combines all discovery planes into one API
 *
 * Planes:
 * 1. UDP Multicast (224.0.0.167:53318) — LAN presence, per-interface membership
 * 2. HTTP /24 scan — fallback when multicast blocked (AP isolation, VPN)
 * 3. Tailscale MagicDNS / 100.x probing — cross-network
 * 4. mDNS (future) — DNS-SD _lyra._tcp
 *
 * Both Node (desktop) and React Native share this interface. Node hosts
 * the multicast socket; native hosts Java MulticastLock via with-lyra-discovery plugin.
 * The service deduplicates and merges results, emits a single onPeer stream.
 */

import type { DiscoverAnnouncePayload } from "@lyra-sync-app/protocol";

import { scanLanForPeers } from "../probe";
import type { DeviceIdentity } from "@lyra-sync-app/protocol";

export type DiscoveredPeer = {
  identity: DiscoverAnnouncePayload["identity"];
  host: string;
  port: number;
  protocolVersion: number;
  source: "multicast" | "scan" | "tailscale" | "manual";
  lastSeenAt: number;
  pairing?: { codeHash: string; token: string; expiresAt: number };
};

export type DiscoveryManagerOptions = {
  identity: DeviceIdentity;
  port: number;
  onPeer: (peer: DiscoveredPeer) => void;
  /** Seed hosts for HTTP scan (e.g., local LAN IPs, known peers) */
  getScanSeeds: () => string[];
  /** Whether Tailscale probing is enabled */
  tailscaleEnabled?: boolean;
  /** Optional Tailscale peer hosts to probe */
  getTailscaleHosts?: () => string[];
  /** Interval for periodic multicast announce (ms) */
  announceIntervalMs?: number;
  /** Whether to run HTTP scan automatically after multicast burst */
  autoScan?: boolean;
};

export class UnifiedDiscoveryManager {
  private readonly onPeer: (p: DiscoveredPeer) => void;
  private readonly identity: DeviceIdentity;
  private readonly port: number;
  private readonly getScanSeeds: () => string[];
  private seen = new Map<string, DiscoveredPeer>();
  private multicastHandle: { stop: () => Promise<void>; announce: () => void; localAddresses: () => string[] } | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private opts: DiscoveryManagerOptions) {
    this.onPeer = opts.onPeer;
    this.identity = opts.identity;
    this.port = opts.port;
    this.getScanSeeds = opts.getScanSeeds;
  }

  async start(): Promise<void> {
    if (this.closed) return;
    // Try multicast where available (Node only — native has its own Java side)
    try {
      const { startDiscovery } = await import("../node/discovery.js");
      this.multicastHandle = await startDiscovery({
        identity: this.identity,
        peerPort: this.port,
        announceIntervalMs: this.opts.announceIntervalMs ?? 5_000,
        onPeer: (announce, _rinfo) => {
          const peer: DiscoveredPeer = {
            identity: announce.identity,
            host: announce.host,
            port: announce.port,
            protocolVersion: announce.protocolVersion,
            source: "multicast",
            lastSeenAt: Date.now(),
            pairing: announce.pairing,
          };
          this.ingest(peer);
        },
      });
    } catch {
      // Not a Node environment or multicast unavailable (e.g., browser, Expo Go)
      this.multicastHandle = null;
    }

    // Periodic HTTP scan as fallback (every 30s when autoScan)
    if (this.opts.autoScan !== false) {
      // Initial scan after 2s
      setTimeout(() => void this.runScan(), 2_000);
      this.scanTimer = setInterval(() => void this.runScan(), 30_000);
    }
  }

  private ingest(peer: DiscoveredPeer): void {
    const key = `${peer.identity.id}:${peer.host}:${peer.port}`;
    const existing = this.seen.get(key);
    if (existing && Date.now() - existing.lastSeenAt < 1_000) return; // dedup burst
    this.seen.set(key, peer);
    // GC old entries
    if (this.seen.size > 200) {
      const cutoff = Date.now() - 60_000;
      for (const [k, v] of this.seen) if (v.lastSeenAt < cutoff) this.seen.delete(k);
    }
    this.onPeer(peer);
  }

  async runScan(): Promise<DiscoveredPeer[]> {
    const seeds = this.getScanSeeds().filter(Boolean);
    if (seeds.length === 0) return [];
    try {
      const found = await scanLanForPeers({
        seedHosts: seeds,
        port: this.port,
        timeoutMs: 600,
        concurrency: 40,
        localDeviceId: this.identity.id,
      });
      const peers: DiscoveredPeer[] = found.map((f) => ({
        identity: f.identity as DiscoveredPeer["identity"],
        host: f.host,
        port: f.port,
        protocolVersion: 4,
        source: "scan" as const,
        lastSeenAt: Date.now(),
      }));
      for (const p of peers) this.ingest(p);
      return peers;
    } catch {
      return [];
    }
  }

  announce(): void {
    this.multicastHandle?.announce();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    if (this.multicastHandle) {
      await this.multicastHandle.stop();
      this.multicastHandle = null;
    }
    this.seen.clear();
  }

  getSeen(): DiscoveredPeer[] {
    return [...this.seen.values()];
  }
}
