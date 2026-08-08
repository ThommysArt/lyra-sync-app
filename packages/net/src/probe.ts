import { LYRA_DEFAULT_PORT, type ConnectionType } from "@lyra-sync-app/protocol";

import { fetchPeerInfo, type PeerUrl } from "./peer-client";

export type ProbeResult =
  | {
      ok: true;
      host: string;
      port: number;
      online: true;
      latencyMs: number;
      deviceId: string;
      name: string;
      fingerprint: string;
      platform: string;
      connectionHint: ConnectionType;
    }
  | {
      ok: false;
      host: string;
      port: number;
      online: false;
      error: string;
      latencyMs: number;
    };

/** Detect common Tailscale IP / MagicDNS shapes. */
export function isLikelyTailscaleHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h.endsWith(".ts.net") || h.endsWith(".tailscale.net")) return true;
  // CGNAT 100.64.0.0/10
  const m = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const second = Number(m[1]);
    return second >= 64 && second <= 127;
  }
  return false;
}

/**
 * Probe a peer HTTP endpoint (/lyra/info).
 * Works from browser (CORS-enabled servers) and Node.
 *
 * Uses transport-level timeoutMs (starts after native socket slot is acquired)
 * so concurrent discovery scans do not abort probes that are only queued.
 */
export async function probePeer(
  endpoint: PeerUrl,
  opts?: { timeoutMs?: number; preferTailscale?: boolean; lane?: number },
): Promise<ProbeResult> {
  const host = endpoint.host.trim();
  const port = endpoint.port ?? LYRA_DEFAULT_PORT;
  const timeoutMs = opts?.timeoutMs ?? 2500;
  const started = Date.now();

  try {
    const info = await fetchPeerInfo(
      { host, port, protocol: endpoint.protocol ?? "http" },
      { timeoutMs, lane: opts?.lane },
    );
    const latencyMs = Date.now() - started;
    if (!info.ok) {
      return { ok: false, host, port, online: false, error: info.error, latencyMs };
    }
    const tailscale = isLikelyTailscaleHost(host) || Boolean(opts?.preferTailscale);
    return {
      ok: true,
      host,
      port,
      online: true,
      latencyMs,
      deviceId: info.identity.id,
      name: info.identity.name,
      fingerprint: info.identity.fingerprint,
      platform: info.identity.platform,
      connectionHint: tailscale ? "tailscale" : "local",
    };
  } catch (e) {
    return {
      ok: false,
      host,
      port,
      online: false,
      error: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - started,
    };
  }
}

/** Probe many endpoints with a concurrency limit. */
export async function probePeers(
  endpoints: PeerUrl[],
  opts?: { timeoutMs?: number; concurrency?: number; preferTailscale?: boolean },
): Promise<ProbeResult[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const results: ProbeResult[] = new Array(endpoints.length);
  let next = 0;

  async function worker() {
    while (next < endpoints.length) {
      const i = next++;
      const ep = endpoints[i]!;
      results[i] = await probePeer(ep, opts);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, endpoints.length) }, () => worker()));
  return results;
}

/**
 * Live Tailscale probing: for hosts that look like Tailscale (100.x / *.ts.net)
 * or when settings force Tailscale mode, probe HTTP info endpoint.
 */
export async function probeTailscalePeers(
  hosts: { host: string; port?: number; name?: string }[],
  opts?: { timeoutMs?: number },
): Promise<ProbeResult[]> {
  const endpoints = hosts
    .filter((h) => isLikelyTailscaleHost(h.host) || h.host.includes("."))
    .map((h) => ({ host: h.host, port: h.port ?? LYRA_DEFAULT_PORT }));
  return probePeers(endpoints, { ...opts, preferTailscale: true });
}

export type PairingOfferMatch = {
  host: string;
  port: number;
  /** Prefer LAN IP advertised by the peer when present */
  reachHost: string;
  identity: {
    id: string;
    name: string;
    type: string;
    platform: string;
    fingerprint: string;
    publicKey: string;
  };
  pairing: {
    codeHash: string;
    token: string;
    expiresAt: number;
  };
};

/** Expand private IPv4 hosts into the same /24 (for code-based LAN pairing). */
export function expandLanCandidates(
  seeds: { host: string; port?: number }[],
  defaultPort: number = LYRA_DEFAULT_PORT,
): PeerUrl[] {
  const out = new Map<string, PeerUrl>();
  const add = (host: string, port: number) => {
    const key = `${host}:${port}`;
    if (!out.has(key)) out.set(key, { host, port });
  };

  for (const seed of seeds) {
    const host = seed.host.trim();
    const port = seed.port ?? defaultPort;
    if (!host) continue;
    add(host, port);

    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    // Only expand common private ranges
    const privateRange =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      // Loopback /8 — expand only when testing same-host peers (127.x)
      a === 127;
    if (!privateRange) continue;
    // Don't explode 127.0.0.0/8 into 16M hosts — only scan 127.0.0.1 and the seed
    if (a === 127) {
      add("127.0.0.1", port);
      continue;
    }
    // Tailscale CGNAT is 100.64/10 — a single /24 expansion almost never covers
    // other tailnet peers (different 100.x.y). Only probe the seed itself;
    // pair / manual add / MagicDNS scan supplies the rest.
    if (a === 100 && b >= 64 && b <= 127) {
      continue;
    }
    for (let d = 1; d <= 254; d++) {
      add(`${a}.${b}.${c}.${d}`, port);
    }
  }
  return [...out.values()];
}

/** Common Lyra peer ports across variants + EADDRINUSE fallbacks. */
export const LYRA_SCAN_PORTS = [
  LYRA_DEFAULT_PORT, // 53317 desktop dev
  LYRA_DEFAULT_PORT + 2, // 53319 native dev / desktop dev+2
  LYRA_DEFAULT_PORT + 4, // 53321 multi-instance
  53327, // desktop preview
  53329, // native preview
  53337, // desktop production
  53339, // native production
] as const;

/**
 * HTTP subnet scan (LocalSend HttpScanDiscovery).
 * Probes /lyra/info on every host in the same /24 as each seed address.
 * Used as a reliable fallback when UDP multicast is blocked or flaky.
 *
 * Strategy (mobile-friendly):
 * 1. Full /24 on a small set of "expand" ports (primary + default) — finds LAN peers fast
 * 2. Exact seed hosts + .1 gateway of each /24 on the full port matrix — catches
 *    multi-instance desktops (53319/53321) and variants without exploding the scan
 *
 * Timeout is transport-level (starts after native socket slot acquisition).
 */
export async function scanLanForPeers(input: {
  /** Seed IPs (local addresses or known peers) — each expands to /24 */
  seedHosts: string[];
  /** Primary port (also used when `ports` is omitted) */
  port?: number;
  /** Optional multi-port scan for exact seeds / gateways (capped). */
  ports?: number[];
  /**
   * Ports used for full /24 expansion. Defaults to primary + default only so
   * mobile TCP scans finish in a reasonable time. Extra variant ports are still
   * tried on exact seed IPs and gateways.
   */
  expandPorts?: number[];
  timeoutMs?: number;
  concurrency?: number;
  localDeviceId?: string;
  /**
   * Do not open TCP to these host:port pairs (own peer server).
   * Scanning ourselves floods the native TCP server and races write/destroy
   * (Android: IllegalArgumentException No socket with id).
   */
  skipEndpoints?: Array<{ host: string; port?: number }>;
}): Promise<
  Array<{
    host: string;
    port: number;
    identity: {
      id: string;
      name: string;
      type: string;
      platform: string;
      fingerprint: string;
      publicKey: string;
    };
  }>
> {
  const primaryPort = input.port ?? LYRA_DEFAULT_PORT;
  const allPorts = [
    ...new Set(
      (input.ports?.length ? input.ports : [...LYRA_SCAN_PORTS, primaryPort])
        .map((p) => Number(p))
        .filter((p) => p > 0 && p <= 65535),
    ),
  ].slice(0, 6);
  if (allPorts.length === 0) allPorts.push(primaryPort);

  const expandPorts = [
    ...new Set(
      (input.expandPorts?.length
        ? input.expandPorts
        : [primaryPort, LYRA_DEFAULT_PORT]
      )
        .map((p) => Number(p))
        .filter((p) => p > 0 && p <= 65535),
    ),
  ].slice(0, 3);
  if (expandPorts.length === 0) expandPorts.push(primaryPort);

  const seeds = input.seedHosts.map((h) => h.trim()).filter(Boolean);
  if (seeds.length === 0) return [];

  const skip = new Set<string>();
  for (const ep of input.skipEndpoints ?? []) {
    const h = ep.host?.trim();
    if (!h) continue;
    const p = ep.port && ep.port > 0 ? ep.port : primaryPort;
    skip.add(`${h}:${p}`);
    // Also skip all scan ports on our own host
    for (const sp of allPorts) skip.add(`${h}:${sp}`);
    for (const sp of expandPorts) skip.add(`${h}:${sp}`);
  }

  const candidates: PeerUrl[] = [];
  const seenEp = new Set<string>();
  const addEp = (host: string, port: number) => {
    const h = host.trim();
    if (!h) return;
    const key = `${h}:${port}`;
    if (seenEp.has(key) || skip.has(key)) return;
    seenEp.add(key);
    candidates.push({ host: h, port });
  };

  // Exact seeds + full port matrix first (high value: known peers / our IP / TS)
  for (const seed of seeds) {
    for (const p of allPorts) addEp(seed, p);
  }

  // Expand private /24s for LAN discovery
  const hostCandidates = expandLanCandidates(
    seeds.map((host) => ({ host, port: primaryPort })),
    primaryPort,
  );
  const slash24Gateways = new Set<string>();
  for (const ep of hostCandidates) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ep.host);
    if (m) {
      slash24Gateways.add(`${m[1]}.${m[2]}.${m[3]}.1`);
    }
    // Full /24 only on expandPorts (not every variant)
    for (const p of expandPorts) addEp(ep.host, p);
  }
  // Gateway + all ports: multi-instance desktops often share the LAN with us
  for (const gw of slash24Gateways) {
    for (const p of allPorts) addEp(gw, p);
  }

  const concurrency = Math.max(1, input.concurrency ?? 50);
  const timeoutMs = input.timeoutMs ?? 500;
  const found: Array<{
    host: string;
    port: number;
    identity: {
      id: string;
      name: string;
      type: string;
      platform: string;
      fingerprint: string;
      publicKey: string;
    };
  }> = [];
  const seen = new Set<string>();
  let next = 0;

  async function worker() {
    while (next < candidates.length) {
      const i = next++;
      const ep = candidates[i]!;
      const host = ep.host.trim();
      const p = ep.port ?? primaryPort;
      try {
        // Transport-level timeout only — must not start before socket slot is free
        // (native TCP is concurrency-limited; lane SCAN yields to interactive).
        const info = await fetchPeerInfo(
          { host, port: p, protocol: "http" },
          { timeoutMs, lane: 2 },
        );
        if (!info.ok) continue;
        if (input.localDeviceId && info.identity.id === input.localDeviceId) continue;
        if (seen.has(info.identity.id)) continue;
        seen.add(info.identity.id);
        // Prefer the address we actually connected to (not a possibly-stale advert)
        found.push({
          host,
          port: info.port && info.port > 0 && info.port === p ? info.port : p,
          identity: {
            id: info.identity.id,
            name: info.identity.name,
            type: info.identity.type,
            platform: info.identity.platform,
            fingerprint: info.identity.fingerprint,
            publicKey: info.identity.publicKey,
          },
        });
      } catch {
        // miss
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, candidates.length)) }, () => worker()),
  );
  // Single summary log for mobile (and desktop) — replaces per-probe spam
  {
    const seenHosts = [...new Set(candidates.map((c) => c.host))];
    const portsSummary = [...new Set(candidates.map((c) => c.port).filter((p): p is number => typeof p === "number"))].sort((a,b)=>a-b).join("/");
    const scannedSubnets = [...new Set(seenHosts.map((h) => h.replace(/\.\d+$/, ".*")))].slice(0,3).join(", ");
    console.info(`[lyra discover] scan found ${found.length} device(s) out of ${candidates.length} tested — attempted ${seenHosts.length} hosts (${scannedSubnets}) on ports ${portsSummary} — seeds: ${seeds.join(", ").slice(0,120)}`);
    if (found.length > 0) {
      console.info(`[lyra discover] found: ${found.map((f) => `${f.identity.name} ${f.host}:${f.port}`).join(", ")}`);
    }
  }
  return found;
}

/**
 * Find a peer advertising a matching pairing code hash on /lyra/info.
 * Used when joining with a short code on the same network.
 */
export async function findPeerByPairingCode(input: {
  codeHash: string;
  candidates: PeerUrl[];
  timeoutMs?: number;
  concurrency?: number;
  /** Skip our own device id when known */
  localDeviceId?: string;
}): Promise<PairingOfferMatch | null> {
  const timeoutMs = input.timeoutMs ?? 900;
  const concurrency = Math.max(1, input.concurrency ?? 32);
  const targets = input.candidates;
  let next = 0;
  let found: PairingOfferMatch | null = null;

  async function worker() {
    while (next < targets.length && !found) {
      const i = next++;
      const ep = targets[i]!;
      const host = ep.host.trim();
      const port = ep.port ?? LYRA_DEFAULT_PORT;
      if (!host) continue;
      try {
        const info = await fetchPeerInfo(
          { host, port, protocol: ep.protocol ?? "http" },
          { timeoutMs, lane: 2 },
        );
        if (!info.ok || !info.pairing) continue;
        if (info.pairing.codeHash !== input.codeHash) continue;
        if (info.pairing.expiresAt < Date.now()) continue;
        if (input.localDeviceId && info.identity.id === input.localDeviceId) continue;
        // Prefer the host:port we successfully probed. Advertised LAN host can be
        // wrong when the server is loopback-bound; advertised port 0 is invalid.
        const advertisedPort = info.port && info.port > 0 ? info.port : port;
        const reachHost = host;
        found = {
          host,
          port: advertisedPort,
          reachHost,
          identity: {
            id: info.identity.id,
            name: info.identity.name,
            type: info.identity.type,
            platform: info.identity.platform,
            fingerprint: info.identity.fingerprint,
            publicKey: info.identity.publicKey,
          },
          pairing: {
            codeHash: info.pairing.codeHash,
            token: info.pairing.token,
            expiresAt: info.pairing.expiresAt,
          },
        };
        return;
      } catch {
        // try next
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, () => worker()),
  );
  return found;
}
