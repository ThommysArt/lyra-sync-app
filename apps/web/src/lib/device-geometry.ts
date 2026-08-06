/**
 * Xcode-Simulator-style device geometry.
 *
 * The mirror window is sized tightly around a physical device bezel + screen,
 * then scaled down to fit the available display work area (like Simulator's
 * 100% / 75% / 50% scales). Real frame dimensions refine the size after the
 * first remote frames arrive.
 */

import type { PairedDevice } from "@lyra-sync-app/protocol";

/** Logical screen points for common device classes (portrait). */
export type DeviceScreenSpec = {
  id: string;
  label: string;
  /** Logical screen width (points / CSS px at 1×). */
  screenWidth: number;
  /** Logical screen height. */
  screenHeight: number;
  /** Metal bezel thickness around the glass (each side). */
  bezel: number;
  /** Extra vertical for home-indicator / chin feel (folded into bottom bezel). */
  chinExtra: number;
  /** Corner radius of the outer shell (visual only). */
  cornerRadius: number;
  kind: "phone" | "tablet" | "desktop";
  platform?: string;
};

/**
 * Profiles inspired by common devices / Xcode Simulator defaults.
 * Used until we know the live stream resolution.
 */
export const DEVICE_PROFILES: Record<string, DeviceScreenSpec> = {
  "iphone-15": {
    id: "iphone-15",
    label: "iPhone",
    screenWidth: 393,
    screenHeight: 852,
    bezel: 12,
    chinExtra: 0,
    cornerRadius: 52,
    kind: "phone",
    platform: "ios",
  },
  "iphone-se": {
    id: "iphone-se",
    label: "iPhone SE",
    screenWidth: 375,
    screenHeight: 667,
    bezel: 14,
    chinExtra: 8,
    cornerRadius: 28,
    kind: "phone",
    platform: "ios",
  },
  "pixel-6": {
    id: "pixel-6",
    label: "Pixel",
    screenWidth: 412,
    screenHeight: 915,
    bezel: 11,
    chinExtra: 0,
    cornerRadius: 40,
    kind: "phone",
    platform: "android",
  },
  "android-compact": {
    id: "android-compact",
    label: "Android",
    screenWidth: 360,
    screenHeight: 800,
    bezel: 11,
    chinExtra: 0,
    cornerRadius: 36,
    kind: "phone",
    platform: "android",
  },
  "ipad": {
    id: "ipad",
    label: "iPad",
    screenWidth: 820,
    screenHeight: 1180,
    bezel: 16,
    chinExtra: 0,
    cornerRadius: 24,
    kind: "tablet",
    platform: "ios",
  },
  "desktop-laptop": {
    id: "desktop-laptop",
    label: "Desktop",
    screenWidth: 1280,
    screenHeight: 800,
    bezel: 0,
    chinExtra: 0,
    cornerRadius: 12,
    kind: "desktop",
  },
  "desktop-wide": {
    id: "desktop-wide",
    label: "Desktop",
    screenWidth: 1440,
    screenHeight: 900,
    bezel: 0,
    chinExtra: 0,
    cornerRadius: 12,
    kind: "desktop",
  },
};

/** Title bar / traffic-light strip height inside the mirror window content. */
export const MIRROR_TITLEBAR_H = 36;
/** Floating control strip under the device (scale, stop). */
export const MIRROR_FOOTER_H = 40;
/** Horizontal breathing room around the bezel inside the window. */
export const MIRROR_PAD_X = 20;
/** Vertical breathing room (above device under titlebar, below before footer). */
export const MIRROR_PAD_Y = 16;
/** Desktop chrome bar drawn inside the "laptop" frame. */
export const DESKTOP_INNER_CHROME_H = 32;

export function isPhoneLike(device: Pick<PairedDevice, "type" | "platform">): boolean {
  return (
    device.type === "mobile" ||
    device.platform === "android" ||
    device.platform === "ios"
  );
}

export function isTabletLike(device: Pick<PairedDevice, "type" | "platform" | "name" | "nickname">): boolean {
  const n = `${device.nickname ?? ""} ${device.name ?? ""}`.toLowerCase();
  return n.includes("ipad") || n.includes("tablet");
}

/** Pick a profile from platform / name heuristics. */
export function resolveDeviceProfile(
  device: Pick<PairedDevice, "type" | "platform" | "name" | "nickname">,
): DeviceScreenSpec {
  const name = `${device.nickname ?? ""} ${device.name ?? ""}`.toLowerCase();
  if (device.platform === "ios" || name.includes("iphone")) {
    if (name.includes("se") || name.includes("mini")) return DEVICE_PROFILES["iphone-se"]!;
    return DEVICE_PROFILES["iphone-15"]!;
  }
  if (isTabletLike(device) || name.includes("ipad")) return DEVICE_PROFILES["ipad"]!;
  if (device.platform === "android" || device.type === "mobile") {
    if (name.includes("pixel")) return DEVICE_PROFILES["pixel-6"]!;
    return DEVICE_PROFILES["android-compact"]!;
  }
  return DEVICE_PROFILES["desktop-laptop"]!;
}

/**
 * Override screen size from a live frame while keeping bezel chrome from the profile.
 * Portrait phones: if the frame is landscape, rotate to portrait for the bezel.
 */
export function screenFromFrame(
  profile: DeviceScreenSpec,
  frameW?: number | null,
  frameH?: number | null,
): { screenWidth: number; screenHeight: number } {
  if (!frameW || !frameH || frameW < 2 || frameH < 2) {
    return { screenWidth: profile.screenWidth, screenHeight: profile.screenHeight };
  }
  let w = frameW;
  let h = frameH;
  // Prefer portrait for phone bezels when the stream is landscape-ish
  if (profile.kind === "phone" && w > h) {
    [w, h] = [h, w];
  }
  // Desktop frames: keep native aspect (usually landscape)
  if (profile.kind === "desktop" && h > w) {
    [w, h] = [h, w];
  }
  return { screenWidth: w, screenHeight: h };
}

export type SimulatorLayout = {
  profile: DeviceScreenSpec;
  /** CSS pixel size of the glass (content). */
  screenWidth: number;
  screenHeight: number;
  /** Outer device shell including bezel. */
  deviceWidth: number;
  deviceHeight: number;
  /** Full BrowserWindow / popup outer size. */
  windowWidth: number;
  windowHeight: number;
  /** Display scale applied (1 = 100%). */
  scale: number;
  /** Content aspect (width/height of shell) for Electron setAspectRatio. */
  shellAspect: number;
  /** Window aspect including titlebar/footer. */
  windowAspect: number;
  kind: DeviceScreenSpec["kind"];
  bezel: number;
  cornerRadius: number;
};

export type LayoutOptions = {
  device: Pick<PairedDevice, "type" | "platform" | "name" | "nickname">;
  /** Live stream dimensions when known. */
  frameWidth?: number | null;
  frameHeight?: number | null;
  /**
   * Available work area for the window (display minus docks/taskbars).
   * Defaults to a conservative laptop-sized area when unknown.
   */
  maxOuterWidth?: number;
  maxOuterHeight?: number;
  /** Preferred scale 0–1; will step down to fit. */
  preferredScale?: number;
  /** Include titlebar + footer chrome in window size (default true). */
  withChrome?: boolean;
};

/**
 * Xcode-style discrete scales — never use awkward 0.63×, pick the next that fits.
 */
const SCALE_STEPS = [1, 0.75, 0.66, 0.5, 0.4, 0.33] as const;

function pickScale(
  unscaledOuterW: number,
  unscaledOuterH: number,
  maxW: number,
  maxH: number,
  preferred = 1,
): number {
  const steps = SCALE_STEPS.filter((s) => s <= preferred + 0.001);
  for (const s of steps) {
    if (unscaledOuterW * s <= maxW && unscaledOuterH * s <= maxH) return s;
  }
  // Force-fit smaller than 33%
  const fit = Math.min(maxW / unscaledOuterW, maxH / unscaledOuterH, preferred);
  return Math.max(0.2, Math.floor(fit * 100) / 100);
}

/**
 * Compute full simulator layout: screen → bezel shell → window chrome → scale-to-fit.
 */
export function computeSimulatorLayout(opts: LayoutOptions): SimulatorLayout {
  const profile = resolveDeviceProfile(opts.device);
  const { screenWidth: rawW, screenHeight: rawH } = screenFromFrame(
    profile,
    opts.frameWidth,
    opts.frameHeight,
  );

  // At 1×: shell = screen + bezel on all sides (+ chin)
  // Desktop adds an inner titlebar chrome above the video area.
  const bezel = profile.bezel;
  const chin = profile.chinExtra;
  const desktopChrome = profile.kind === "desktop" ? DESKTOP_INNER_CHROME_H : 0;
  const shellW1 = rawW + bezel * 2;
  const shellH1 = rawH + bezel * 2 + chin + desktopChrome;

  const withChrome = opts.withChrome !== false;
  const chromeH = withChrome ? MIRROR_TITLEBAR_H + MIRROR_FOOTER_H : 0;
  const padX = withChrome ? MIRROR_PAD_X : 8;
  const padY = withChrome ? MIRROR_PAD_Y : 8;

  // Unscaled outer window
  const outerW1 = shellW1 + padX * 2;
  const outerH1 = shellH1 + chromeH + padY * 2;

  // Work area — leave margin for OS chrome / multi-monitor quirks
  const maxW = Math.max(320, (opts.maxOuterWidth ?? 1280) - 48);
  const maxH = Math.max(480, (opts.maxOuterHeight ?? 800) - 64);

  const scale = pickScale(outerW1, outerH1, maxW, maxH, opts.preferredScale ?? 1);

  const screenWidth = Math.round(rawW * scale);
  const screenHeight = Math.round(rawH * scale);
  const scaledBezel =
    profile.kind === "desktop" ? 0 : Math.max(8, Math.round(bezel * scale));
  const scaledChin = Math.round(chin * scale);
  const scaledDesktopChrome =
    profile.kind === "desktop" ? Math.round(DESKTOP_INNER_CHROME_H * Math.min(1, scale + 0.15)) : 0;
  const deviceWidth = screenWidth + scaledBezel * 2;
  const deviceHeight =
    screenHeight + scaledBezel * 2 + scaledChin + scaledDesktopChrome;

  const windowWidth = Math.round(deviceWidth + padX * 2);
  const windowHeight = Math.round(deviceHeight + chromeH + padY * 2);

  return {
    profile,
    screenWidth,
    screenHeight,
    deviceWidth,
    deviceHeight,
    windowWidth: Math.max(260, windowWidth),
    windowHeight: Math.max(420, windowHeight),
    scale,
    shellAspect: deviceWidth / deviceHeight,
    windowAspect: windowWidth / windowHeight,
    kind: profile.kind,
    bezel: scaledBezel,
    cornerRadius: Math.round(profile.cornerRadius * scale),
  };
}

/** Browser/Electron available display size. */
export function getAvailableDisplaySize(): { width: number; height: number } {
  if (typeof window === "undefined") {
    return { width: 1280, height: 800 };
  }
  // screen.avail* excludes taskbar; visualViewport is closer to usable area in some WMs
  const w = window.screen?.availWidth ?? window.innerWidth ?? 1280;
  const h = window.screen?.availHeight ?? window.innerHeight ?? 800;
  return { width: w, height: h };
}

/** Human label for scale, e.g. "75%". */
export function formatScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
