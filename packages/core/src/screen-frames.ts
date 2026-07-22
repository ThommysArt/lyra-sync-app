/**
 * High-quality synthetic screen frames for demo / offline mirror testing.
 * Renders an Xcode-Simulator-style home screen into a JPEG data URL.
 */

export type DemoFrameOptions = {
  platform?: "android" | "ios" | "macos" | "windows" | "linux" | "web" | "unknown";
  width?: number;
  height?: number;
  /** Animation phase in ms (Date.now() or test clock). */
  now?: number;
  deviceName?: string;
  battery?: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** Build a data-URL JPEG of a polished phone/desktop home screen. */
export function generateDemoScreenFrame(opts: DemoFrameOptions = {}): {
  dataUrl: string;
  width: number;
  height: number;
  mimeType: "image/jpeg";
} {
  const platform = opts.platform ?? "android";
  const isPhone = platform === "android" || platform === "ios";
  const width = opts.width ?? (isPhone ? 390 : 960);
  const height = opts.height ?? (isPhone ? 844 : 600);
  const now = opts.now ?? Date.now();
  const name = opts.deviceName ?? (isPhone ? "Lyra Phone" : "Lyra Desktop");
  const battery = clamp(opts.battery ?? 72, 0, 100);

  // Prefer Canvas in browser/Electron; Node tests use SVG→minimal JPEG fallback.
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      paintDemoFrame(ctx, {
        width,
        height,
        platform,
        now,
        name,
        battery,
        isPhone,
      });
      const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
      return { dataUrl, width, height, mimeType: "image/jpeg" };
    }
  }

  // Node / headless: SVG data URL (browsers still render it in <img>)
  const svg = buildDemoSvg({ width, height, platform, now, name, battery, isPhone });
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return { dataUrl, width, height, mimeType: "image/jpeg" };
}

/** Extract base64 body from a data URL (for wire transport). */
export function dataUrlToBase64(dataUrl: string): { mimeType: string; dataBase64: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  return { mimeType: m[1]!, dataBase64: m[2]! };
}

export function base64ToDataUrl(mimeType: string, dataBase64: string): string {
  return `data:${mimeType};base64,${dataBase64}`;
}

type PaintInput = {
  width: number;
  height: number;
  platform: string;
  now: number;
  name: string;
  battery: number;
  isPhone: boolean;
};

function paintDemoFrame(
  ctx: CanvasRenderingContext2D,
  p: PaintInput,
) {
  const { width, height, now, name, battery, isPhone, platform } = p;
  const t = (now % 12_000) / 12_000;

  // Wallpaper gradient
  const g = ctx.createLinearGradient(0, 0, width, height);
  if (platform === "ios") {
    g.addColorStop(0, "#1a1a2e");
    g.addColorStop(0.5, "#16213e");
    g.addColorStop(1, "#0f3460");
  } else if (platform === "android") {
    g.addColorStop(0, "#0b132b");
    g.addColorStop(0.45, "#1c2541");
    g.addColorStop(1, "#3a506b");
  } else {
    g.addColorStop(0, "#111827");
    g.addColorStop(1, "#1f2937");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // Soft orbs
  for (let i = 0; i < 3; i++) {
    const ox = width * (0.2 + 0.3 * i + 0.05 * Math.sin(t * Math.PI * 2 + i));
    const oy = height * (0.25 + 0.15 * Math.cos(t * Math.PI * 2 + i * 1.3));
    const r = Math.min(width, height) * (0.18 + 0.04 * i);
    const og = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
    og.addColorStop(0, `rgba(99, 102, 241, ${0.35 - i * 0.08})`);
    og.addColorStop(1, "rgba(99, 102, 241, 0)");
    ctx.fillStyle = og;
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Status bar
  const pad = isPhone ? 18 : 16;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `600 ${isPhone ? 13 : 12}px system-ui, sans-serif`;
  const hours = new Date(now).getHours().toString().padStart(2, "0");
  const mins = new Date(now).getMinutes().toString().padStart(2, "0");
  ctx.fillText(`${hours}:${mins}`, pad, isPhone ? 36 : 28);

  // Battery pill
  const battW = 28;
  const battH = 12;
  const bx = width - pad - battW - 4;
  const by = isPhone ? 26 : 18;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx, by, battW, battH);
  ctx.fillStyle = battery > 20 ? "#4ade80" : "#f87171";
  ctx.fillRect(bx + 2, by + 2, ((battW - 4) * battery) / 100, battH - 4);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(bx + battW, by + 3, 2, battH - 6);

  // Clock center
  const clockY = isPhone ? height * 0.22 : height * 0.18;
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = `300 ${isPhone ? 64 : 42}px system-ui, sans-serif`;
  ctx.fillText(`${hours}:${mins}`, width / 2, clockY);
  ctx.font = `500 ${isPhone ? 15 : 13}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fillText(name, width / 2, clockY + (isPhone ? 28 : 22));
  ctx.textAlign = "left";

  // App grid
  const cols = isPhone ? 4 : 6;
  const rows = isPhone ? 4 : 3;
  const icon = isPhone ? 58 : 52;
  const gapX = isPhone ? 22 : 28;
  const gapY = isPhone ? 28 : 24;
  const gridW = cols * icon + (cols - 1) * gapX;
  const startX = (width - gridW) / 2;
  const startY = isPhone ? height * 0.38 : height * 0.36;
  const labels = isPhone
    ? ["Phone", "Messages", "Camera", "Photos", "Music", "Maps", "Lyra", "Settings", "Files", "Mail", "Notes", "Browser", "Clock", "Weather", "Store", "More"]
    : ["Finder", "Browser", "Terminal", "Code", "Lyra", "Mail", "Music", "Photos", "Docs", "Slack", "Settings", "Store"];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= labels.length) break;
      const x = startX + c * (icon + gapX);
      const y = startY + r * (icon + gapY + 14);
      const bounce = Math.sin(t * Math.PI * 2 + i * 0.4) * 2;
      roundRect(ctx, x, y + bounce, icon, icon, 14);
      const ig = ctx.createLinearGradient(x, y, x + icon, y + icon);
      const hues: [string, string][] = [
        ["#6366f1", "#8b5cf6"],
        ["#06b6d4", "#3b82f6"],
        ["#f43f5e", "#f97316"],
        ["#22c55e", "#14b8a6"],
        ["#eab308", "#f59e0b"],
        ["#a855f7", "#ec4899"],
      ];
      const pair = hues[i % hues.length] ?? hues[0]!;
      ig.addColorStop(0, pair[0]);
      ig.addColorStop(1, pair[1]);
      ctx.fillStyle = ig;
      ctx.fill();
      // glyph
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = `600 ${isPhone ? 18 : 16}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(labels[i]!.slice(0, 1), x + icon / 2, y + bounce + icon / 2 + 6);
      ctx.font = `500 ${isPhone ? 10 : 10}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(labels[i]!, x + icon / 2, y + bounce + icon + 14);
      ctx.textAlign = "left";
    }
  }

  // Dock
  if (isPhone) {
    const dockH = 72;
    const dockY = height - dockH - 28;
    const dockPad = 24;
    roundRect(ctx, dockPad, dockY, width - dockPad * 2, dockH, 28);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fill();
    const dockIcons = 4;
    const di = 48;
    const dw = dockIcons * di + (dockIcons - 1) * 18;
    const dx0 = (width - dw) / 2;
    for (let i = 0; i < dockIcons; i++) {
      const x = dx0 + i * (di + 18);
      const y = dockY + (dockH - di) / 2;
      roundRect(ctx, x, y, di, di, 12);
      ctx.fillStyle = i === 0 ? "#6366f1" : "rgba(255,255,255,0.22)";
      ctx.fill();
    }
    // Home indicator
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    roundRect(ctx, width / 2 - 54, height - 14, 108, 5, 3);
    ctx.fill();
  } else {
    // Desktop taskbar
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, height - 40, width, 40);
    ctx.fillStyle = "#6366f1";
    roundRect(ctx, 10, height - 32, 24, 24, 6);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "500 12px system-ui, sans-serif";
    ctx.fillText("Lyra · Screen share preview", 44, height - 16);
  }

  // Live badge
  ctx.fillStyle = "rgba(239,68,68,0.9)";
  roundRect(ctx, pad, isPhone ? 48 : 40, 52, 18, 9);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "700 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("LIVE", pad + 26, isPhone ? 61 : 53);
  ctx.textAlign = "left";
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function buildDemoSvg(p: PaintInput): string {
  const { width, height, name, battery, isPhone } = p;
  const hours = new Date(p.now).getHours().toString().padStart(2, "0");
  const mins = new Date(p.now).getMinutes().toString().padStart(2, "0");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b132b"/>
      <stop offset="100%" stop-color="#3a506b"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <text x="24" y="40" fill="#fff" font-family="system-ui" font-size="14" font-weight="600">${hours}:${mins}</text>
  <text x="${width - 24}" y="40" fill="#fff" font-family="system-ui" font-size="12" text-anchor="end">${battery}%</text>
  <text x="${width / 2}" y="${isPhone ? height * 0.28 : height * 0.35}" fill="#fff" font-family="system-ui" font-size="${isPhone ? 56 : 36}" font-weight="300" text-anchor="middle">${hours}:${mins}</text>
  <text x="${width / 2}" y="${isPhone ? height * 0.34 : height * 0.42}" fill="rgba(255,255,255,0.75)" font-family="system-ui" font-size="14" text-anchor="middle">${escapeXml(name)}</text>
  <rect x="${width / 2 - 40}" y="52" width="52" height="18" rx="9" fill="#ef4444"/>
  <text x="${width / 2 - 14}" y="65" fill="#fff" font-family="system-ui" font-size="10" font-weight="700">LIVE</text>
  <text x="${width / 2}" y="${height - 48}" fill="rgba(255,255,255,0.55)" font-family="system-ui" font-size="12" text-anchor="middle">Lyra screen mirror</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
