/**
 * Xcode Simulator–style mirror window.
 *
 * This route is the entire window: dark void, tightly-sized device bezel,
 * floating title + stop. No app sidebar. Window outer size is computed from
 * device geometry and refined when live frames report real dimensions.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SimulatorDevice } from "@/components/simulator-device";
import {
  computeSimulatorLayout,
  formatScale,
  getAvailableDisplaySize,
  type SimulatorLayout,
} from "@/lib/device-geometry";
import { getDesktopApi, isDesktopShell } from "@/lib/desktop-bridge";
import { resizeMirrorViewerWindow } from "@/lib/mirror-window";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/mirror/$deviceId")({
  component: MirrorSimulatorPage,
});

function MirrorSimulatorPage() {
  const { deviceId } = Route.useParams();
  const store = useLyraStore();
  const device = useLyraSelector((s) => s.devices.find((d) => d.id === deviceId));
  const session = useLyraSelector((s) => s.screenSessions[deviceId]);
  const desktop = isDesktopShell();
  const [preferredScale, setPreferredScale] = useState(1);
  const lastResizeKey = useRef("");

  const display = useMemo(() => getAvailableDisplaySize(), []);

  const layout: SimulatorLayout = useMemo(() => {
    if (!device) {
      return computeSimulatorLayout({
        device: { type: "mobile", platform: "android", name: "Device" },
        maxOuterWidth: display.width,
        maxOuterHeight: display.height,
        preferredScale,
      });
    }
    return computeSimulatorLayout({
      device,
      frameWidth: session?.width,
      frameHeight: session?.height,
      maxOuterWidth: display.width,
      maxOuterHeight: display.height,
      preferredScale,
    });
  }, [device, session?.width, session?.height, display.width, display.height, preferredScale]);

  const active =
    session && (session.status === "active" || session.status === "requesting");
  const title = device ? device.nickname || device.name : "Mirror";

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    if (!desktop) return;
    document.documentElement.classList.add("lyra-electron");
    document.body.style.overflow = "hidden";
    document.body.style.background = "#1c1c1e";
    return () => {
      document.documentElement.classList.remove("lyra-electron");
      document.body.style.overflow = "";
      document.body.style.background = "";
    };
  }, [desktop]);

  // Keep the OS window sized to the bezel (Simulator does this per device / scale)
  useEffect(() => {
    if (!device) return;
    const key = `${layout.windowWidth}x${layout.windowHeight}@${layout.scale}`;
    if (key === lastResizeKey.current) return;
    lastResizeKey.current = key;
    void resizeMirrorViewerWindow(
      device,
      { width: session?.width, height: session?.height },
      preferredScale,
    );
  }, [device, layout.windowWidth, layout.windowHeight, layout.scale, session?.width, session?.height, preferredScale]);

  const stop = async () => {
    await store.stopScreenMirror(deviceId);
    const api = getDesktopApi();
    if (api?.stopScrcpy) void api.stopScrcpy(deviceId);
    if (api?.closeMirrorWindow) void api.closeMirrorWindow(deviceId);
    else if (window.opener) window.close();
  };

  const cycleScale = () => {
    // Match Simulator-ish steps
    const steps = [1, 0.75, 0.5, 0.33];
    const i = steps.findIndex((s) => Math.abs(s - preferredScale) < 0.02);
    setPreferredScale(steps[(i + 1) % steps.length]!);
  };

  if (!device) {
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-3 bg-[#1c1c1e] p-6 text-center text-zinc-300">
        <p className="text-sm">Device not found in this session.</p>
        <Link to="/" className="text-sm text-sky-400 underline">
          Back to Lyra
        </Link>
      </div>
    );
  }

  const statusLine = (() => {
    if (!session || session.status === "ended") return "Idle";
    if (session.status === "requesting") return "Connecting…";
    if (session.error) return session.error;
    const dim =
      session.width && session.height ? `${session.width}×${session.height}` : "—";
    const fps =
      typeof session.fps === "number"
        ? `${(session.fps as number).toFixed?.(1) ?? session.fps} fps`
        : "";
    return [dim, fps, session.mode, formatScale(layout.scale)].filter(Boolean).join(" · ");
  })();

  return (
    <div
      className="flex h-svh flex-col select-none bg-[#1c1c1e] text-zinc-100"
      data-desktop={desktop ? "true" : undefined}
      style={{
        // Fill exactly; OS window is pre-sized to layout
        width: "100%",
        height: "100%",
      }}
    >
      {/* Slim drag titlebar — like Simulator's title */}
      <header
        className="flex h-9 shrink-0 items-center gap-2 px-3"
        style={
          desktop
            ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
            : undefined
        }
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-2"
          style={
            desktop
              ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
              : undefined
          }
        >
          {/* Space for macOS traffic lights */}
          {desktop ? <span className="w-14 shrink-0" aria-hidden /> : null}
          <p className="truncate text-[13px] font-medium tracking-tight text-zinc-200">
            {title}
          </p>
          {active && session?.status === "active" ? (
            <span className="rounded-full bg-red-500/90 px-1.5 py-px text-[9px] font-bold text-white">
              LIVE
            </span>
          ) : null}
        </div>
        <div
          className="flex items-center gap-1"
          style={
            desktop
              ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
              : undefined
          }
        >
          <button
            type="button"
            onClick={cycleScale}
            title="Cycle scale (100% → 75% → 50% → 33%)"
            className="rounded-md px-2 py-1 text-[11px] font-medium text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            {formatScale(layout.scale)}
          </button>
          {active ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="inline-flex items-center gap-1 rounded-md bg-red-600/90 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-500"
            >
              <Square className="size-3" />
              Stop
            </button>
          ) : null}
          <button
            type="button"
            title="Close"
            className="rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            onClick={() => {
              const api = getDesktopApi();
              if (api?.closeMirrorWindow) void api.closeMirrorWindow(deviceId);
              else window.close();
            }}
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      {/* Device stage — centered, exact pixel layout */}
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2">
        <SimulatorDevice
          layout={layout}
          platform={device.platform}
          frameSrc={session?.lastFrameDataUrl}
          live={Boolean(active && session?.status === "active")}
          deviceName={title}
          placeholder={
            <div className="flex flex-col items-center gap-2 px-4">
              <div className="size-8 animate-pulse rounded-full bg-white/10" />
              <p className="text-[11px] text-zinc-500">
                {session?.status === "requesting"
                  ? "Connecting…"
                  : session?.error
                    ? session.error
                    : "Waiting for screen…"}
              </p>
            </div>
          }
        />
      </main>

      <footer className="flex h-10 shrink-0 items-center justify-center px-3 pb-1">
        <p className="truncate text-center text-[10px] text-zinc-500">{statusLine}</p>
      </footer>
    </div>
  );
}
