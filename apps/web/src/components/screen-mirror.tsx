/**
 * Device-detail controls for screen mirror.
 * The real experience is the separate Simulator-style window — this card only
 * starts/stops and shows a small status thumbnail.
 */

import type { PairedDevice, ScreenSession } from "@lyra-sync-app/protocol";
import { ExternalLink, MonitorPlay, Smartphone, Square, Wifi } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@lyra-sync-app/ui/components/badge";
import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lyra-sync-app/ui/components/card";
import { AndroidMirrorSetupHints } from "@/components/screen-share-host";
import { getDesktopApi, isDesktopShell } from "@/lib/desktop-bridge";
import { formatScale, resolveDeviceProfile } from "@/lib/device-geometry";
import { closeMirrorViewerWindow, layoutForDevice, openMirrorViewerWindow } from "@/lib/mirror-window";
import { useLyraStore } from "@/lib/lyra";

export function ScreenMirrorPanel({
  device,
  session,
}: {
  device: PairedDevice;
  session?: ScreenSession;
}) {
  const store = useLyraStore();
  const [busy, setBusy] = useState(false);
  const [lastAdbHint, setLastAdbHint] = useState<string | null>(null);
  const active = session && (session.status === "active" || session.status === "requesting");
  const desktop = isDesktopShell();
  const showAndroidHints =
    device.platform === "android" || (device.type === "mobile" && device.platform !== "ios");
  const profile = resolveDeviceProfile(device);
  const previewLayout = layoutForDevice(device, {
    width: session?.width,
    height: session?.height,
  });

  const openWindow = async () => {
    const res = await openMirrorViewerWindow(device, {
      frameWidth: session?.width,
      frameHeight: session?.height,
    });
    if (!res.ok && res.error) {
      toast.message("Mirror window", { description: res.error });
    }
  };

  const start = async (mode?: "auto" | "demo" | "p2p" | "scrcpy") => {
    setBusy(true);
    setLastAdbHint(null);
    try {
      if (
        desktop &&
        (mode === "scrcpy" || mode === "auto") &&
        (device.platform === "android" || device.type === "mobile")
      ) {
        const api = getDesktopApi();
        const host = device.adbSerial || device.tailscaleHost || device.host;
        if (api?.checkAdb) {
          const serial = host
            ? host.includes(":")
              ? host
              : `${host}:5555`
            : undefined;
          const adb = await api.checkAdb({ serial });
          if (!adb.ok) {
            setLastAdbHint(adb.hint ?? adb.error ?? "ADB not ready");
            if (mode === "scrcpy") {
              toast.error(adb.error ?? "ADB not ready", { description: adb.hint });
            } else {
              toast.message("Live Android mirror needs ADB", {
                description: adb.hint ?? adb.error,
              });
            }
          }
        }
      }

      const res = await store.startScreenMirror(device.id, { mode });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }

      if ((mode === "scrcpy" || mode === "auto") && desktop && device.platform === "android") {
        const api = getDesktopApi();
        const host = device.adbSerial || device.tailscaleHost || device.host;
        if (api?.startScrcpy) {
          const scrcpyRes = await api.startScrcpy({
            deviceId: device.id,
            serial: host ? (host.includes(":") ? host : `${host}:5555`) : undefined,
            extraArgs: store.getState().settings.scrcpyExtraArgs,
            scrcpyPath: store.getState().settings.scrcpyPath,
          });
          if (!scrcpyRes.ok && scrcpyRes.error) {
            toast.message("scrcpy", { description: scrcpyRes.error });
          }
        }
      }

      // Primary UX: open the Simulator-style window — that *is* the mirror
      const opened = await openMirrorViewerWindow(device, {
        frameWidth: session?.width ?? previewLayout.screenWidth / previewLayout.scale,
        frameHeight: session?.height ?? previewLayout.screenHeight / previewLayout.scale,
      });
      if (!opened.ok) {
        toast.message("Could not open mirror window", { description: opened.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await store.stopScreenMirror(device.id);
      const api = getDesktopApi();
      if (api?.stopScrcpy) void api.stopScrcpy(device.id);
      await closeMirrorViewerWindow(device.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="rounded-xl">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Screen mirror</CardTitle>
          <CardDescription>
            Opens a separate Simulator-style window sized to this device (
            {profile.label}
            {" · "}
            {profile.screenWidth}×{profile.screenHeight}
            {" at "}
            {formatScale(previewLayout.scale)}
            ). Just the bezel and live screen — like Xcode&apos;s iPhone simulator.
          </CardDescription>
        </div>
        {active ? (
          <Badge variant="default" className="gap-1">
            <span className="size-1.5 animate-pulse rounded-full bg-red-200" />
            {session?.mode ?? "live"}
          </Badge>
        ) : (
          <Badge variant="secondary">Idle</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {/* Small status thumb only — the real mirror is the other window */}
          <div
            className="relative mx-auto shrink-0 overflow-hidden rounded-[1.25rem] border border-border/80 bg-zinc-950 shadow-inner sm:mx-0"
            style={{
              width: 96,
              height: Math.round(96 * (profile.screenHeight / profile.screenWidth)),
              maxHeight: 180,
            }}
          >
            {session?.lastFrameDataUrl ? (
              <img
                src={session.lastFrameDataUrl}
                alt=""
                className="size-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-1 text-zinc-600">
                <Smartphone className="size-5" />
                <span className="text-[9px]">Window</span>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {!active ? (
              <>
                <Button disabled={busy || !device.online} onClick={() => void start("auto")}>
                  <MonitorPlay className="size-4" />
                  Open mirror window
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => void start("demo")}>
                  Preview (demo frames)
                </Button>
                {(device.platform === "android" || device.type === "mobile") && desktop ? (
                  <Button
                    variant="outline"
                    disabled={busy || !device.online}
                    onClick={() => void start("scrcpy")}
                    title="Requires scrcpy + ADB"
                  >
                    <Wifi className="size-4" />
                    Scrcpy (native window)
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <Button variant="destructive" disabled={busy} onClick={() => void stop()}>
                  <Square className="size-4" />
                  Stop mirror
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => void openWindow()}>
                  <ExternalLink className="size-4" />
                  Focus mirror window
                </Button>
                {session?.error ? (
                  <p className="text-xs text-destructive">{session.error}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Mode <strong>{session?.mode}</strong>
                    {session?.width && session?.height
                      ? ` · stream ${session.width}×${session.height}`
                      : null}
                    {" · window "}
                    {previewLayout.windowWidth}×{previewLayout.windowHeight}px
                  </p>
                )}
              </>
            )}

            {showAndroidHints ? (
              <AndroidMirrorSetupHints
                hasHost={Boolean(device.host)}
                hasTailscale={Boolean(device.tailscaleHost)}
                hasAdbSerial={Boolean(device.adbSerial)}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                Desktop sources get a system screen/window picker when a peer starts a live mirror.
              </p>
            )}
            {lastAdbHint ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">{lastAdbHint}</p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
