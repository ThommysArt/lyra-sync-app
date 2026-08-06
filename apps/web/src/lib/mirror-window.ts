/**
 * Open / resize the Xcode-Simulator-style mirror window.
 * The window is tightly sized around the device bezel and reflows when
 * live frame dimensions are known.
 */

import type { PairedDevice } from "@lyra-sync-app/protocol";

import {
  computeSimulatorLayout,
  getAvailableDisplaySize,
  isPhoneLike,
  type SimulatorLayout,
} from "./device-geometry";
import { getDesktopApi, isDesktopShell } from "./desktop-bridge";

export { isPhoneLike as isPhoneDevice };

export function layoutForDevice(
  device: PairedDevice,
  frame?: { width?: number | null; height?: number | null },
  preferredScale?: number,
): SimulatorLayout {
  const display = getAvailableDisplaySize();
  return computeSimulatorLayout({
    device,
    frameWidth: frame?.width,
    frameHeight: frame?.height,
    maxOuterWidth: display.width,
    maxOuterHeight: display.height,
    preferredScale,
  });
}

function mirrorUrl(deviceId: string): string {
  const hashPath = `#/mirror/${encodeURIComponent(deviceId)}`;
  const useHash =
    typeof window !== "undefined" &&
    (window.location.protocol === "file:" || window.location.hash.startsWith("#/"));
  const pathUrl = `${window.location.origin}${window.location.pathname.replace(/\/$/, "")}/mirror/${encodeURIComponent(deviceId)}${window.location.search}`;
  const hashUrl = `${window.location.origin}${window.location.pathname}${window.location.search}${hashPath}`;
  return useHash ? hashUrl : pathUrl;
}

export async function openMirrorViewerWindow(
  device: PairedDevice,
  opts?: {
    frameWidth?: number | null;
    frameHeight?: number | null;
    preferredScale?: number;
  },
): Promise<{
  ok: boolean;
  error?: string;
  method: "electron" | "popup" | "none";
  layout: SimulatorLayout;
}> {
  const layout = layoutForDevice(
    device,
    { width: opts?.frameWidth, height: opts?.frameHeight },
    opts?.preferredScale,
  );
  const title = device.nickname || device.name || "Device";
  const url = mirrorUrl(device.id);
  const isPhone = isPhoneLike(device);

  const api = getDesktopApi();
  if (isDesktopShell() && api?.openMirrorWindow) {
    const res = await api.openMirrorWindow({
      deviceId: device.id,
      title: `${title} — Lyra`,
      url,
      width: layout.windowWidth,
      height: layout.windowHeight,
      minWidth: isPhone ? 240 : 400,
      minHeight: isPhone ? 400 : 280,
      // Lock to shell aspect so resize keeps the phone silhouette (Simulator-like)
      aspectRatio: layout.shellAspect,
      isPhone,
      resizable: true,
      backgroundColor: "#1c1c1e",
    });
    return { ok: res.ok, error: res.error, method: "electron", layout };
  }

  try {
    const features = [
      `width=${layout.windowWidth}`,
      `height=${layout.windowHeight}`,
      "menubar=no",
      "toolbar=no",
      "location=no",
      "status=no",
      "resizable=yes",
      "scrollbars=no",
    ].join(",");
    const popup = window.open(url, `lyra-mirror-${device.id}`, features);
    if (!popup) {
      return {
        ok: false,
        error: "Popup blocked — allow popups for Lyra or use the desktop app",
        method: "popup",
        layout,
      };
    }
    try {
      popup.focus();
    } catch {
      // ignore
    }
    return { ok: true, method: "popup", layout };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to open mirror window",
      method: "popup",
      layout,
    };
  }
}

/** Re-size an already-open mirror window when frame dimensions become known. */
export async function resizeMirrorViewerWindow(
  device: PairedDevice,
  frame?: { width?: number | null; height?: number | null },
  preferredScale?: number,
): Promise<SimulatorLayout> {
  const layout = layoutForDevice(device, frame, preferredScale);
  const api = getDesktopApi();
  if (api?.resizeMirrorWindow) {
    await api.resizeMirrorWindow({
      deviceId: device.id,
      width: layout.windowWidth,
      height: layout.windowHeight,
      aspectRatio: layout.shellAspect,
    });
  }
  return layout;
}

export async function closeMirrorViewerWindow(deviceId: string): Promise<void> {
  const api = getDesktopApi();
  if (api?.closeMirrorWindow) {
    await api.closeMirrorWindow(deviceId);
  }
}
