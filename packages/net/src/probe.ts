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
 */
export async function probePeer(
  endpoint: PeerUrl,
  opts?: { timeoutMs?: number; preferTailscale?: boolean },
): Promise<ProbeResult> {
  const host = endpoint.host.trim();
  const port = endpoint.port ?? LYRA_DEFAULT_PORT;
  const timeoutMs = opts?.timeoutMs ?? 2500;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const info = await fetchPeerInfo(
      { host, port, protocol: endpoint.protocol ?? "http" },
      { signal: controller.signal },
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
  } finally {
    clearTimeout(timer);
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
