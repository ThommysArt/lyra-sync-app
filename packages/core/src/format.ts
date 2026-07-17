export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatSpeed(bps: number | undefined): string {
  if (!bps || !Number.isFinite(bps)) return "—";
  return `${formatBytes(bps)}/s`;
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatPercent(transferred: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((transferred / total) * 100));
}

export function platformLabel(platform: string): string {
  const map: Record<string, string> = {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
    android: "Android",
    ios: "iOS",
    web: "Web",
    unknown: "Unknown",
  };
  return map[platform] ?? platform;
}

export function connectionLabel(type: string): string {
  const map: Record<string, string> = {
    local: "Local",
    tailscale: "Tailscale",
    both: "Local + Tailscale",
    manual: "Manual",
  };
  return map[type] ?? type;
}
