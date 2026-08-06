/**
 * Xcode-Simulator device chrome — sized in absolute pixels from geometry layout.
 * Used only in the dedicated mirror window (not the device-detail thumbnail).
 */

import { cn } from "@/lib/utils";
import type { SimulatorLayout } from "@/lib/device-geometry";
import { DESKTOP_INNER_CHROME_H } from "@/lib/device-geometry";

export function SimulatorDevice({
  layout,
  platform,
  frameSrc,
  live,
  deviceName,
  placeholder,
  className,
}: {
  layout: SimulatorLayout;
  platform?: string;
  frameSrc?: string | null;
  live?: boolean;
  deviceName?: string;
  placeholder?: React.ReactNode;
  className?: string;
}) {
  const isIos = platform === "ios";
  const isPhone = layout.kind === "phone";
  const isTablet = layout.kind === "tablet";
  const isDesktop = layout.kind === "desktop";

  if (isDesktop) {
    const chromeH = Math.max(28, layout.deviceHeight - layout.screenHeight);
    return (
      <div
        className={cn("relative flex flex-col overflow-hidden bg-zinc-900 shadow-2xl", className)}
        style={{
          width: layout.deviceWidth,
          height: layout.deviceHeight,
          borderRadius: layout.cornerRadius,
          boxShadow:
            "0 25px 60px -12px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06)",
        }}
      >
        <div
          className="flex shrink-0 items-center gap-1.5 border-b border-white/10 bg-zinc-800 px-3"
          style={{ height: chromeH || DESKTOP_INNER_CHROME_H }}
        >
          <span className="size-2.5 rounded-full bg-red-400/90" />
          <span className="size-2.5 rounded-full bg-amber-400/90" />
          <span className="size-2.5 rounded-full bg-emerald-400/90" />
          <span className="ml-2 truncate text-[11px] text-zinc-400">
            {deviceName ?? "Desktop"}
          </span>
          {live ? (
            <span className="ml-auto rounded-full bg-red-500/90 px-2 py-0.5 text-[9px] font-bold text-white">
              LIVE
            </span>
          ) : null}
        </div>
        <div
          className="relative min-h-0 flex-1 bg-black"
          style={{
            width: layout.screenWidth,
            height: layout.screenHeight,
          }}
        >
          {frameSrc ? (
            <img
              src={frameSrc}
              alt="Remote screen"
              className="absolute inset-0 size-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
              {placeholder ?? "Waiting…"}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Phone / tablet shell
  const outerRadius = isTablet
    ? Math.max(20, layout.cornerRadius)
    : Math.max(28, layout.cornerRadius);

  return (
    <div
      className={cn("relative", className)}
      style={{
        width: layout.deviceWidth,
        height: layout.deviceHeight,
      }}
    >
      {/* Outer metal shell */}
      <div
        className="relative size-full overflow-hidden bg-gradient-to-b from-zinc-600 via-zinc-900 to-black"
        style={{
          borderRadius: outerRadius,
          padding: layout.bezel,
          boxShadow:
            "0 30px 60px -15px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 1px rgba(0,0,0,0.5)",
        }}
      >
        {/* Side buttons */}
        {isPhone ? (
          <>
            <div
              className="absolute -left-[3px] rounded-l-sm bg-zinc-500"
              style={{ top: "16%", height: "5%", width: 3 }}
            />
            <div
              className="absolute -left-[3px] rounded-l-sm bg-zinc-500"
              style={{ top: "24%", height: "8%", width: 3 }}
            />
            <div
              className="absolute -left-[3px] rounded-l-sm bg-zinc-500"
              style={{ top: "34%", height: "8%", width: 3 }}
            />
            <div
              className="absolute -right-[3px] rounded-r-sm bg-zinc-500"
              style={{ top: "28%", height: "12%", width: 3 }}
            />
          </>
        ) : null}

        {/* Glass */}
        <div
          className="relative overflow-hidden bg-black"
          style={{
            width: layout.screenWidth,
            height: layout.screenHeight,
            borderRadius: Math.max(12, outerRadius - layout.bezel),
          }}
        >
          {isIos ? (
            <div
              className="pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 rounded-full bg-black"
              style={{
                top: Math.max(6, Math.round(layout.screenHeight * 0.012)),
                height: Math.max(18, Math.round(layout.screenWidth * 0.055)),
                width: Math.max(70, Math.round(layout.screenWidth * 0.28)),
              }}
            />
          ) : (
            <div
              className="pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 rounded-full bg-zinc-900 ring-1 ring-zinc-700"
              style={{
                top: Math.max(8, Math.round(layout.screenHeight * 0.014)),
                width: Math.max(8, Math.round(layout.screenWidth * 0.025)),
                height: Math.max(8, Math.round(layout.screenWidth * 0.025)),
              }}
            />
          )}

          {live ? (
            <span className="absolute right-2.5 top-2.5 z-20 rounded-full bg-red-500/95 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white shadow">
              LIVE
            </span>
          ) : null}

          {frameSrc ? (
            <img
              src={frameSrc}
              alt="Remote screen"
              className="absolute inset-0 size-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-b from-zinc-900 to-black px-6 text-center">
              {placeholder ?? (
                <>
                  <div className="size-8 animate-pulse rounded-full bg-white/10" />
                  <p className="text-[11px] text-zinc-500">Waiting for screen…</p>
                </>
              )}
            </div>
          )}

          {isPhone ? (
            <div
              className="pointer-events-none absolute bottom-1.5 left-1/2 z-20 -translate-x-1/2 rounded-full bg-white/35"
              style={{
                height: 4,
                width: Math.max(80, Math.round(layout.screenWidth * 0.32)),
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
