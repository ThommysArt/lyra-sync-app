/**
 * Lyra network helpers — multi-interface aware.
 * Replaces single `Network.getIpAddressAsync()` which hides Wi-Fi when Tailscale VPN is up.
 *
 * Tries native LyraNetwork module first (enumerates all NetworkInterface IPv4),
 * falls back to expo-network single IP + common LAN seeds.
 */
import * as Network from "expo-network";
import { Platform } from "react-native";

type LanHostInfo = {
  lanIps: string[];
  tailscaleIp: string | null;
  primaryIp: string | null;
};

function isTailscaleIPv4(ip: string): boolean {
  const m = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(ip.trim());
  if (!m) return false;
  const s = Number(m[1]);
  return s >= 64 && s <= 127;
}
function isPrivateLanIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Try to load native module (injected by with-lyra-network plugin).
 * Uses expo-modules-core or React Native NativeModules.
 */
async function tryNativeList(): Promise<string[] | null> {
  // Try detailed first for subnet-aware scans (LocalSend-style prefixLength)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-modules-core") as { NativeModulesProxy?: Record<string, unknown> };
    const proxy = (mod as unknown as { NativeModulesProxy?: Record<string, { listLanHosts?: () => Promise<string[]>; listLanHostsDetailed?: () => Promise<{host:string;prefixLength:number}[]> }> }).NativeModulesProxy;
    const m = proxy?.["LyraNetwork"] as { listLanHosts?: () => Promise<string[]>; listLanHostsDetailed?: () => Promise<{host:string;prefixLength:number}[]> } | undefined;
    if (m?.listLanHostsDetailed) {
      try {
        const detailed = await m.listLanHostsDetailed();
        if (Array.isArray(detailed) && detailed.length > 0) {
          // Prefer detailed but return hosts for simple callers
          const hosts = detailed.map((d) => d.host).filter(Boolean) as string[];
          if (hosts.length > 0) return hosts;
        }
      } catch {}
    }
    if (m?.listLanHosts) {
      const res = await m.listLanHosts();
      if (Array.isArray(res) && res.length > 0) return res as string[];
    }
  } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require("react-native") as { NativeModules?: Record<string, unknown> };
    const m = (RN.NativeModules as Record<string, { listLanHosts?: () => Promise<string[]>; listLanHostsDetailed?: () => Promise<{host:string;prefixLength:number}[]> }>)?.["LyraNetwork"];
    if (m?.listLanHostsDetailed) {
      try {
        const detailed = await m.listLanHostsDetailed();
        if (Array.isArray(detailed) && detailed.length > 0) {
          const hosts = detailed.map((d) => d.host).filter(Boolean) as string[];
          if (hosts.length > 0) return hosts;
        }
      } catch {}
    }
    if (m?.listLanHosts) {
      const res = await m.listLanHosts();
      if (Array.isArray(res) && res.length > 0) return res as string[];
    }
  } catch {}
  return null;
}

export async function getLanHosts(): Promise<LanHostInfo> {
  // Prefer native enumeration
  const native = await tryNativeList();
  if (native && native.length > 0) {
    const lanIps = native.filter((ip) => isPrivateLanIPv4(ip) || ip === "127.0.0.1");
    const tailscaleIp = native.find((ip) => isTailscaleIPv4(ip)) ?? null;
    // Prefer first non-tailscale private IP as primary
    const primaryIp = lanIps.find((ip) => isPrivateLanIPv4(ip) && !isTailscaleIPv4(ip)) ?? tailscaleIp ?? native[0] ?? null;
    return { lanIps: native, tailscaleIp, primaryIp };
  }

  // Fallback: expo-network single
  try {
    const ip = await Network.getIpAddressAsync();
    if (ip && ip !== "0.0.0.0" && ip !== "127.0.0.1") {
      if (isTailscaleIPv4(ip)) {
        // When main is Tailscale, still return it but flag tailscaleIp
        return { lanIps: [ip], tailscaleIp: ip, primaryIp: ip };
      }
      return { lanIps: [ip], tailscaleIp: null, primaryIp: ip };
    }
  } catch {}
  return { lanIps: [], tailscaleIp: null, primaryIp: null };
}

export function classifyHosts(hosts: string[]): { lan: string[]; tailscale: string | null } {
  const lan: string[] = [];
  let tailscale: string | null = null;
  for (const h of hosts) {
    if (isTailscaleIPv4(h)) {
      if (!tailscale) tailscale = h;
    } else if (isPrivateLanIPv4(h)) {
      lan.push(h);
    }
  }
  return { lan, tailscale };
}
