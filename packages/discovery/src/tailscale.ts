import { spawn } from "node:child_process";

export type TailscalePeer = {
  id: string;
  hostName: string;
  dnsName: string;
  tailscaleIPs: string[];
  online?: boolean;
};

export type TailscaleStatus = {
  Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] };
  Peer?: Record<string, TailscalePeer>;
  peers?: Record<string, TailscalePeer>;
};

function parseStatusJson(raw: string): TailscaleStatus {
  try {
    return JSON.parse(raw) as TailscaleStatus;
  } catch {
    return {};
  }
}

/**
 * fetchTailscaleStatus — spawns `tailscale status --json` and parses.
 * Timeout 2500ms by default. Returns null on failure.
 */
export async function fetchTailscaleStatus(
  opts?: { timeoutMs?: number; command?: string },
): Promise<TailscaleStatus | null> {
  const timeoutMs = opts?.timeoutMs ?? 2500;
  const command = opts?.command ?? "tailscale";
  return new Promise((resolve) => {
    const child = spawn(command, ["status", "--json"], { timeout: timeoutMs });
    let out = "";
    let errOut = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve(null);
    }, timeoutMs + 200);
    child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { errOut += d.toString("utf8"); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out) {
        void errOut;
        resolve(null);
        return;
      }
      resolve(parseStatusJson(out));
    });
  });
}

export type ProbeTarget = { host: string; port: number; peerId?: string; dnsName?: string };

export async function scanTailscalePeers(opts?: { defaultPort?: number }): Promise<ProbeTarget[]> {
  const status = await fetchTailscaleStatus();
  return tailscalePeersToProbeTargets(status, opts?.defaultPort ?? 53317);
}

export function tailscalePeersToProbeTargets(
  status: TailscaleStatus | null,
  defaultPort: number,
): ProbeTarget[] {
  if (!status) return [];
  const peers = status.Peer ?? status.peers ?? {};
  const targets: ProbeTarget[] = [];
  for (const [id, p] of Object.entries(peers)) {
    const ip = p.tailscaleIPs?.[0] ?? p.dnsName?.replace(/\.+$/, "") ?? null;
    const host = p.dnsName && p.dnsName.length > 0 ? p.dnsName.replace(/\.$/, "") : ip;
    if (!host) continue;
    // filter offline peers if explicit
    if (p.online === false) continue;
    targets.push({ host, port: defaultPort, peerId: id, dnsName: p.dnsName });
  }
  // include self as target for diagnostics? not needed
  return targets;
}
