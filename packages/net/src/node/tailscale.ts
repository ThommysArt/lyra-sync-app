/**
 * Optional Tailscale discovery helpers (spec §4.3).
 * Uses the local Tailscale HTTP API when the daemon is running.
 * Never requires cloud; fails soft when Tailscale is absent.
 */

export type TailscalePeerHint = {
  host: string;
  /** Prefer MagicDNS name when present */
  dnsName?: string;
  online?: boolean;
  /** Tailscale IP (100.x) */
  tailscaleIp?: string;
  os?: string;
};

export type TailscaleStatusResult =
  | { ok: true; self?: TailscalePeerHint; peers: TailscalePeerHint[]; backendState?: string }
  | { ok: false; error: string };

/**
 * Query local Tailscale status.
 * Tries:
 * 1. `http://100.100.100.100/status` (Linux / some builds)
 * 2. `http://localhost:2100/localapi/v0/status` with Unix socket not available from pure fetch —
 *    we try HTTP ports only; Electron can later shell out to `tailscale status --json`.
 */
export async function fetchTailscaleStatus(opts?: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<TailscaleStatusResult> {
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = opts?.signal ?? controller.signal;

  const urls = [
    "http://100.100.100.100/status",
    // Some platforms expose localapi over loopback when TS_LOCAL_ADDR is set
    process.env.TS_LOCAL_API_URL
      ? `${process.env.TS_LOCAL_API_URL.replace(/\/$/, "")}/localapi/v0/status`
      : null,
  ].filter(Boolean) as string[];

  try {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          signal,
          headers: { accept: "application/json" },
        });
        if (!res.ok) continue;
        const data = (await res.json()) as Record<string, unknown>;
        return parseTailscaleStatusJson(data);
      } catch {
        // try next
      }
    }

    // Shell-out fallback (Node / Electron only)
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });
      const data = JSON.parse(stdout) as Record<string, unknown>;
      return parseTailscaleStatusJson(data);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Tailscale not available",
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseTailscaleStatusJson(data: Record<string, unknown>): TailscaleStatusResult {
  const peers: TailscalePeerHint[] = [];
  let self: TailscalePeerHint | undefined;

  const selfNode = data.Self as Record<string, unknown> | undefined;
  if (selfNode) {
    self = nodeToHint(selfNode);
  }

  const peerMap = data.Peer as Record<string, Record<string, unknown>> | undefined;
  if (peerMap && typeof peerMap === "object") {
    for (const node of Object.values(peerMap)) {
      peers.push(nodeToHint(node));
    }
  }

  // Alternate shape: { Peer: [...] }
  if (Array.isArray(data.Peer)) {
    for (const node of data.Peer as Record<string, unknown>[]) {
      peers.push(nodeToHint(node));
    }
  }

  return {
    ok: true,
    self,
    peers: peers.filter((p) => p.host),
    backendState: typeof data.BackendState === "string" ? data.BackendState : undefined,
  };
}

function nodeToHint(node: Record<string, unknown>): TailscalePeerHint {
  const dnsName =
    (typeof node.DNSName === "string" && node.DNSName.replace(/\.$/, "")) ||
    (typeof node.HostName === "string" ? node.HostName : undefined);
  const ips = Array.isArray(node.TailscaleIPs)
    ? (node.TailscaleIPs as string[])
    : Array.isArray(node.Addrs)
      ? (node.Addrs as string[])
      : [];
  const tailscaleIp = ips.find((ip) => ip.startsWith("100.")) ?? ips[0];
  const host = dnsName || tailscaleIp || "";
  return {
    host,
    dnsName,
    tailscaleIp,
    online: typeof node.Online === "boolean" ? node.Online : undefined,
    os: typeof node.OS === "string" ? node.OS : undefined,
  };
}

/** Map Tailscale peers to Lyra manual probe targets (port default 53317). */
export function tailscalePeersToProbeTargets(
  peers: TailscalePeerHint[],
  port = 53317,
): { host: string; port: number; name?: string }[] {
  return peers
    .filter((p) => p.host && p.online !== false)
    .map((p) => ({
      host: p.host,
      port,
      name: p.dnsName || p.host,
    }));
}
