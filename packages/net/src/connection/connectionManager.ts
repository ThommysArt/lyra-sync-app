/**
 * Lyra Connection Manager — new unified architecture v2
 *
 * Responsibilities:
 * - Maintain persistent, pooled connections to paired peers (sticky endpoint)
 * - Health-check with exponential backoff, circuit-breaker
 * - Session token caching with automatic re-auth
 * - Transparent failover across LAN / Tailscale / port candidates
 * - Keep-alive via periodic probe + WebSocket-style heartbeat (HTTP GET /lyra/health)
 *
 * Used by both Node (desktop) and React Native (mobile) via the same interface.
 * The underlying transport is pluggable (fetch/undici vs TCP-socket) but the
 * manager is transport-agnostic.
 */

import {
  LYRA_DEFAULT_PORT,
  type PairedDevice,
  type DeviceIdentity,
} from "@lyra-sync-app/protocol";
import {
  getOrCreatePeerSession,
  type PeerUrl,
} from "../peer-client";
import { probePeer } from "../probe";
import { isLikelyTailscaleHost } from "../probe";

// Local candidate logic (mirrors core/peer-ops to avoid cycle)
function localEndpointCandidates(device: PairedDevice): PeerUrl[] {
  const port = device.port ?? LYRA_DEFAULT_PORT;
  const hostField = device.host?.trim() || null;
  const tsField = device.tailscaleHost?.trim() || null;
  const lanHost = hostField && !isLikelyTailscaleHost(hostField) ? hostField : null;
  const tsHost = tsField || (hostField && isLikelyTailscaleHost(hostField) ? hostField : null);
  const ordered: string[] = [];
  const push = (h: string | null | undefined) => {
    const v = h?.trim();
    if (v && !ordered.includes(v)) ordered.push(v);
  };
  push(device.lastReachableHost);
  const pref = device.preferredAddress ?? "auto";
  if (pref === "tailscale") { push(tsHost); push(lanHost); push(hostField); }
  else if (pref === "lan") { push(lanHost); push(hostField); push(tsHost); }
  else if (tsHost) { push(tsHost); push(lanHost); push(hostField); }
  else { push(lanHost); push(hostField); }
  push("127.0.0.1"); push("localhost");
  const lastPort = device.lastReachablePort;
  const ports = [...new Set([lastPort, port, LYRA_DEFAULT_PORT, port+2, port+4, LYRA_DEFAULT_PORT+2, LYRA_DEFAULT_PORT+4, 53327, 53319, 53321, 53329, 53337, 53339].filter((p): p is number => typeof p === "number" && p>0 && p<=65535))].slice(0,8);
  const out: PeerUrl[] = [];
  if (device.lastReachableHost && device.lastReachablePort) out.push({ host: device.lastReachableHost, port: device.lastReachablePort, protocol: "http" });
  for (const host of ordered) for (const p of ports) if (!out.some(e=>e.host===host && e.port===p)) out.push({ host, port: p, protocol: "http" });
  return out;
}

// Re-export for external use
export type ConnectionState = {
  deviceId: string;
  endpoint: PeerUrl | null;
  sessionToken: string | null;
  lastProbeAt: number;
  lastSuccessAt: number;
  consecutiveFailures: number;
  backoffUntil: number;
  latencyMs: number | null;
  online: boolean;
};

export type ConnectionManagerOptions = {
  identity: DeviceIdentity;
  privateKey: string;
  /** Called to resolve auth secret for a device */
  resolveAuthSecret: (deviceId: string) => string | undefined;
  /** Callback when a device goes online/offline */
  onStatusChange?: (deviceId: string, online: boolean, endpoint: PeerUrl | null) => void;
  /** Health check interval ms (default 15s) */
  healthCheckIntervalMs?: number;
  /** Probe timeout ms (default 1200) */
  probeTimeoutMs?: number;
};

const DEFAULT_HEALTH_INTERVAL = 15_000;
const DEFAULT_PROBE_TIMEOUT = 1_200;
const MAX_BACKOFF = 60_000;

function backoffForFailures(n: number): number {
  if (n <= 1) return 2_000;
  if (n === 2) return 5_000;
  if (n === 3) return 12_000;
  if (n === 4) return 25_000;
  return MAX_BACKOFF;
}

/**
 * Unified connection manager. One instance per local device.
 */
export class LyraConnectionManager {
  private readonly identity: DeviceIdentity;
  private readonly privateKey: string;
  private readonly resolveAuthSecret: (id: string) => string | undefined;
  private readonly onStatusChange?: (id: string, online: boolean, endpoint: PeerUrl | null) => void;
  private readonly healthInterval: number;
  private readonly probeTimeout: number;

  private readonly connections = new Map<string, ConnectionState>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private closed = false;

  constructor(opts: ConnectionManagerOptions) {
    this.identity = opts.identity;
    this.privateKey = opts.privateKey;
    this.resolveAuthSecret = opts.resolveAuthSecret;
    this.onStatusChange = opts.onStatusChange;
    this.healthInterval = opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL;
    this.probeTimeout = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT;
  }

  /** Register a paired device for tracking */
  track(device: PairedDevice): void {
    if (this.closed) return;
    const existing = this.connections.get(device.id);
    if (existing) {
      // Update endpoint if device record changed
      return;
    }
    const state: ConnectionState = {
      deviceId: device.id,
      endpoint: device.lastReachableHost
        ? {
            host: device.lastReachableHost,
            port: device.lastReachablePort ?? device.port ?? LYRA_DEFAULT_PORT,
            protocol: "http",
          }
        : null,
      sessionToken: null,
      lastProbeAt: 0,
      lastSuccessAt: 0,
      consecutiveFailures: 0,
      backoffUntil: 0,
      latencyMs: device.lastProbeLatencyMs ?? null,
      online: device.online ?? false,
    };
    this.connections.set(device.id, state);
    // Start health monitor
    const timer = setInterval(() => {
      void this.healthCheck(device.id, device);
    }, this.healthInterval);
    // Allow process to exit even if timer alive (tests)
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref?.();
    }
    this.timers.set(device.id, timer);
  }

  untrack(deviceId: string): void {
    const t = this.timers.get(deviceId);
    if (t) clearInterval(t);
    this.timers.delete(deviceId);
    this.connections.delete(deviceId);
  }

  getState(deviceId: string): ConnectionState | undefined {
    return this.connections.get(deviceId);
  }

  /** Ensure we have a live session + endpoint for the device. Reuses cached when healthy. */
  async ensureConnection(
    device: PairedDevice,
  ): Promise<{ ok: true; endpoint: PeerUrl; sessionToken: string } | { ok: false; error: string }> {
    const state = this.connections.get(device.id);
    // Fast path: valid cached session and endpoint still healthy (probed recently)
    if (state?.endpoint && state.sessionToken && state.online && Date.now() < state.backoffUntil - 1) {
      // backoffUntil is future only when failing; if online, try cached first with short timeout
      const quickProbe = await probePeer(state.endpoint, {
        timeoutMs: 350,
        preferTailscale: isLikelyTailscaleHost(state.endpoint.host),
        lane: 1,
      });
      if (quickProbe.ok) {
        state.lastSuccessAt = Date.now();
        state.latencyMs = quickProbe.latencyMs;
        // Validate session still good by trying getOrCreate (cached)
        const secret = this.resolveAuthSecret(device.id);
        const sess = await getOrCreatePeerSession({
          endpoint: state.endpoint,
          identity: this.identity,
          privateKey: this.privateKey,
          sharedSecret: secret,
          peerDeviceId: device.id,
        });
        if (sess.ok) {
          state.sessionToken = sess.sessionToken;
          return { ok: true, endpoint: state.endpoint, sessionToken: sess.sessionToken };
        }
      }
    }

    // Full failover: try candidate matrix via local helper
    const candidates = localEndpointCandidates(device);

    // Dedupe
    const seen = new Set<string>();
    const deduped: PeerUrl[] = [];
    for (const c of candidates) {
      const k = `${c.host}:${c.port}`;
      if (!seen.has(k)) {
        seen.add(k);
        deduped.push(c);
      }
    }

    // Probe phase (parallel 8)
    const reachable: PeerUrl[] = [];
    let idx = 0;
    const concurrency = 8;
    async function worker() {
      while (idx < deduped.length) {
        const i = idx++;
        if (reachable.length >= 2) return; // early exit
        const ep = deduped[i]!;
        try {
          const res = await probePeer(ep, {
            timeoutMs: 900,
            preferTailscale: isLikelyTailscaleHost(ep.host),
            lane: 1,
          });
          if (res.ok) {
            reachable.push({ host: res.host, port: res.port, protocol: "http" });
          }
        } catch {}
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, deduped.length) }, () => worker()));

    const toTry = reachable.length > 0 ? [...reachable, ...deduped.filter((d) => !reachable.some((r) => r.host === d.host && r.port === d.port))] : deduped;

    let lastError = "Peer unreachable";
    for (const ep of toTry.slice(0, 6)) {
      const secret = this.resolveAuthSecret(device.id);
      const sess = await getOrCreatePeerSession({
        endpoint: ep,
        identity: this.identity,
        privateKey: this.privateKey,
        sharedSecret: secret,
        peerDeviceId: device.id,
      });
      if (sess.ok) {
        // Update state
        let st = this.connections.get(device.id);
        if (!st) {
          st = {
            deviceId: device.id,
            endpoint: ep,
            sessionToken: sess.sessionToken,
            lastProbeAt: Date.now(),
            lastSuccessAt: Date.now(),
            consecutiveFailures: 0,
            backoffUntil: 0,
            latencyMs: null,
            online: true,
          };
          this.connections.set(device.id, st);
        } else {
          st.endpoint = ep;
          st.sessionToken = sess.sessionToken;
          st.online = true;
          st.consecutiveFailures = 0;
          st.backoffUntil = 0;
          st.lastSuccessAt = Date.now();
        }
        this.onStatusChange?.(device.id, true, ep);
        return { ok: true, endpoint: ep, sessionToken: sess.sessionToken };
      }
      lastError = sess.error;
    }
    // Mark failure + backoff
    const st = this.connections.get(device.id);
    if (st) {
      st.consecutiveFailures += 1;
      st.backoffUntil = Date.now() + backoffForFailures(st.consecutiveFailures);
      st.online = false;
      this.onStatusChange?.(device.id, false, st.endpoint);
    }
    return { ok: false, error: lastError };
  }

  private async healthCheck(deviceId: string, device: PairedDevice): Promise<void> {
    if (this.closed) return;
    const state = this.connections.get(deviceId);
    if (!state) return;
    if (Date.now() < state.backoffUntil) return; // circuit breaker

    const ep = state.endpoint ?? (device.host ? { host: device.host, port: device.port ?? LYRA_DEFAULT_PORT, protocol: "http" as const } : null);
    if (!ep) return;

    try {
      const res = await probePeer(ep, {
        timeoutMs: this.probeTimeout,
        preferTailscale: isLikelyTailscaleHost(ep.host),
        lane: 1,
      });
      state.lastProbeAt = Date.now();
      if (res.ok) {
        const wasOffline = !state.online;
        state.online = true;
        state.consecutiveFailures = 0;
        state.backoffUntil = 0;
        state.latencyMs = res.latencyMs;
        state.lastSuccessAt = Date.now();
        if (wasOffline) this.onStatusChange?.(deviceId, true, ep);
      } else {
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= 3) {
          state.online = false;
          state.backoffUntil = Date.now() + backoffForFailures(state.consecutiveFailures);
          this.onStatusChange?.(deviceId, false, ep);
        }
      }
    } catch {
      state.consecutiveFailures += 1;
    }
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.connections.clear();
  }

  /** For debugging / tests */
  getAllStates(): Map<string, ConnectionState> {
    return new Map(this.connections);
  }
}
