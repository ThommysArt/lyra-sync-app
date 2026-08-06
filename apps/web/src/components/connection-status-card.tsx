import { formatRelativeTime } from "@lyra-sync-app/core";
import { CheckCircle2, CloudOff, Radio, RefreshCw, Scan } from "lucide-react";

import { useLyraSelector } from "@/lib/lyra";

export function ConnectionStatusCard({ deviceId }: { deviceId: string }) {
  const device = useLyraSelector((s) => s.devices.find((d) => d.id === deviceId));
  const discovery = useLyraSelector((s) => s.discoveryStatus);

  if (!device) return null;

  const isScanning = discovery.isScanning;
  const isReconnecting = discovery.phase === "reconnecting";

  let phase: "online" | "reconnecting" | "scanning" | "offline" = "offline";
  let label = "Offline";
  let sublabel = `Last seen ${formatRelativeTime(device.lastSeenAt)}`;
  let color = "text-muted-foreground";
  let bg = "bg-muted";
  let Icon = CloudOff;

  if (device.online) {
    phase = "online";
    label = "Connected";
    sublabel = `Online · ${device.connectionType} · ${formatRelativeTime(device.lastSeenAt)}`;
    color = "text-green-600";
    bg = "bg-green-500/10";
    Icon = CheckCircle2;
  } else if (isReconnecting) {
    phase = "reconnecting";
    label = "Reconnecting…";
    sublabel = "Checking trust and reachability";
    color = "text-amber-600";
    bg = "bg-amber-500/10";
    Icon = RefreshCw;
  } else if (isScanning) {
    phase = "scanning";
    label = "Looking for peers…";
    sublabel = discovery.lastScannedAt ? `Last scan ${formatRelativeTime(discovery.lastScannedAt)}` : "Scanning LAN and Tailscale";
    color = "text-blue-600";
    bg = "bg-blue-500/10";
    Icon = Scan;
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className={`flex size-10 items-center justify-center rounded-full ${bg}`}>
          <Icon className={`size-5 ${color} ${phase === "scanning" ? "animate-spin" : phase === "reconnecting" ? "animate-spin" : phase === "online" ? "animate-pulse" : ""}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{label}</p>
          <p className="truncate text-xs text-muted-foreground">{sublabel}</p>
        </div>
        <span className={`size-2.5 rounded-full ${phase === "online" ? "bg-green-500" : phase === "offline" ? "bg-muted-foreground/30" : phase === "reconnecting" ? "bg-amber-500" : "bg-blue-500"} ${phase !== "offline" ? "animate-pulse" : ""}`} />
      </div>
      {phase === "scanning" && (
        <p className="mt-3 text-xs text-muted-foreground">Searching 192.168.x and Tailscale 100.x — keep Wi-Fi on</p>
      )}
      {phase === "reconnecting" && (
        <p className="mt-3 text-xs text-muted-foreground">
          Verifying pairing trust — recent pairs are kept for 60s even if the peer is briefly unreachable
        </p>
      )}
      {phase === "offline" && discovery.lastResult && (
        <p className="mt-3 text-xs text-muted-foreground">
          Last discovery: {discovery.lastResult.online} online · {discovery.lastResult.nearby} nearby
        </p>
      )}
    </div>
  );
}

export function GlobalDiscoveryStatusCard() {
  const discovery = useLyraSelector((s) => s.discoveryStatus);
  const peerServer = useLyraSelector((s) => s.peerServer);

  let label = "Idle";
  let sublabel = "Discovery ready";
  let color = "text-muted-foreground";
  let bg = "bg-muted";
  let Icon = Radio;

  if (!peerServer.running) {
    label = "Peer server offline";
    sublabel = peerServer.lastError ?? "Start the app to announce on LAN";
    color = "text-red-600";
    bg = "bg-red-500/10";
    Icon = CloudOff;
  } else if (discovery.phase === "scanning") {
    label = "Looking for peers…";
    sublabel = "Announcing via multicast and scanning /24";
    color = "text-blue-600";
    bg = "bg-blue-500/10";
    Icon = Scan;
  } else if (discovery.phase === "reconnecting") {
    label = "Reconnecting…";
    sublabel = "Verifying paired devices";
    color = "text-amber-600";
    bg = "bg-amber-500/10";
    Icon = RefreshCw;
  } else if (discovery.phase === "offline") {
    label = "Discovery off";
    sublabel = "Enable in Settings";
    Icon = CloudOff;
  } else {
    label = "Idle";
    sublabel = discovery.lastScannedAt
      ? `Last scan ${formatRelativeTime(discovery.lastScannedAt)} · ${discovery.lastResult?.online ?? 0} online`
      : "Tap Refresh to scan";
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-3.5">
      <div className={`flex size-9 items-center justify-center rounded-full ${bg}`}>
        <Icon className={`size-4 ${color} ${discovery.isScanning ? "animate-spin" : ""}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {label} {discovery.isScanning ? "· scanning" : ""}
        </p>
        <p className="truncate text-xs text-muted-foreground">{sublabel}</p>
      </div>
      <span className={`size-2 rounded-full ${discovery.isScanning ? "bg-blue-500 animate-pulse" : "bg-muted-foreground/30"}`} />
    </div>
  );
}
