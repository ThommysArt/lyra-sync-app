/**
 * Screen mirror panel — Sefirah/scrcpy-inspired, Xcode-bezel presentation.
 */

import type { PairedDevice, ScreenSession } from "@lyra-sync-app/protocol";
import { MonitorPlay, Smartphone, Square, Wifi } from "lucide-react";
import { useState } from "react";

import { Badge } from "@lyra-sync-app/ui/components/badge";
import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lyra-sync-app/ui/components/card";
import { DeviceFrame } from "@/components/device-frame";
import { getDesktopApi, isDesktopShell } from "@/lib/desktop-bridge";
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
  const active = session && (session.status === "active" || session.status === "requesting");
  const isPhone = device.type === "mobile" || device.platform === "android" || device.platform === "ios";
  const desktop = isDesktopShell();

  const start = async (mode?: "auto" | "demo" | "p2p" | "scrcpy") => {
    setBusy(true);
    try {
      const res = await store.startScreenMirror(device.id, { mode });
      if (!res.ok) return;

      // Scrcpy path: ask desktop shell to launch external high-quality mirror
      if ((mode === "scrcpy" || mode === "auto") && desktop && device.platform === "android") {
        const api = getDesktopApi();
        const host =
          device.adbSerial ||
          device.tailscaleHost ||
          device.host;
        if (api && "startScrcpy" in api && typeof (api as { startScrcpy?: unknown }).startScrcpy === "function") {
          const startScrcpy = (
            api as {
              startScrcpy: (opts: {
                deviceId: string;
                serial?: string;
                extraArgs?: string;
              }) => Promise<{ ok: boolean; error?: string }>;
            }
          ).startScrcpy;
          const scrcpyRes = await startScrcpy({
            deviceId: device.id,
            serial: host ? (host.includes(":") ? host : `${host}:5555`) : undefined,
            extraArgs: store.getState().settings.scrcpyExtraArgs,
          });
          if (!scrcpyRes.ok && scrcpyRes.error) {
            // Keep in-app demo bezel; surface reason
            console.info("[lyra] scrcpy:", scrcpyRes.error);
          }
        }
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
      if (api && "stopScrcpy" in api) {
        void (
          api as { stopScrcpy?: (deviceId: string) => Promise<unknown> }
        ).stopScrcpy?.(device.id);
      }
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
            Xcode-style device cast. Demo preview always works; live P2P or scrcpy when the peer
            supports it.
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
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <DeviceFrame
            variant={isPhone ? "phone" : "desktop"}
            platform={device.platform}
            frameSrc={session?.lastFrameDataUrl}
            live={Boolean(active && session?.status === "active")}
            caption={
              active
                ? `${session?.width ?? "—"}×${session?.height ?? "—"} · ${session?.fps?.toFixed?.(1) ?? session?.fps ?? "—"} fps · ${session?.frameCount ?? 0} frames`
                : device.nickname || device.name
            }
            placeholder={
              <div className="flex flex-col items-center gap-2 px-4">
                {isPhone ? (
                  <Smartphone className="size-8 text-zinc-600" />
                ) : (
                  <MonitorPlay className="size-8 text-zinc-600" />
                )}
                <p className="text-xs text-zinc-500">Start mirror to cast this device</p>
              </div>
            }
            maxHeight={isPhone ? 560 : 360}
          />

          <div className="flex w-full min-w-0 flex-1 flex-col gap-2 sm:max-w-xs">
            {!active ? (
              <>
                <Button disabled={busy || !device.online} onClick={() => void start("auto")}>
                  <MonitorPlay className="size-4" />
                  Start mirror
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void start("demo")}
                >
                  Preview in bezel
                </Button>
                {(device.platform === "android" || device.type === "mobile") && desktop ? (
                  <Button
                    variant="outline"
                    disabled={busy || !device.online}
                    onClick={() => void start("scrcpy")}
                    title="Requires scrcpy + ADB (wireless TCP/IP or USB). Uses Tailscale IP when set."
                  >
                    <Wifi className="size-4" />
                    Scrcpy (high quality)
                  </Button>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  For Android over Tailscale, set the device Tailscale IP (100.x) below and enable
                  wireless debugging / ADB TCP 5555. Scrcpy path mirrors Sefirah.
                </p>
              </>
            ) : (
              <>
                <Button variant="destructive" disabled={busy} onClick={() => void stop()}>
                  <Square className="size-4" />
                  Stop mirror
                </Button>
                {session?.error ? (
                  <p className="text-xs text-destructive">{session.error}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Mode <strong>{session?.mode}</strong>
                    {session?.mode === "demo"
                      ? " — synthetic high-quality preview (offline-safe)."
                      : session?.mode === "scrcpy"
                        ? " — external scrcpy window when the binary is available."
                        : " — live frames over the Lyra peer protocol."}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
