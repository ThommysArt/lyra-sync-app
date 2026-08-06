/**
 * Xcode-Simulator-style device chrome for screen mirrors.
 * Phone / tablet / desktop outlines with the live frame clipped inside.
 */

import { cn } from "@/lib/utils";

export type DeviceFrameVariant = "phone" | "tablet" | "desktop";

export type DeviceFrameProps = {
  variant?: DeviceFrameVariant;
  /** Platform hint for subtle chrome differences (notch vs punch-hole). */
  platform?: string;
  /** Latest frame as data URL or remote URL. */
  frameSrc?: string | null;
  /** Optional overlay when no frame yet. */
  placeholder?: React.ReactNode;
  className?: string;
  /** Max height of the entire chrome (CSS). */
  maxHeight?: number | string;
  /** Show LIVE badge */
  live?: boolean;
  /** Soft label under the device */
  caption?: string;
  children?: React.ReactNode;
};

function resolveVariant(
  variant: DeviceFrameVariant | undefined,
  platform?: string,
): DeviceFrameVariant {
  if (variant) return variant;
  if (platform === "android" || platform === "ios") return "phone";
  if (platform === "web") return "desktop";
  return "desktop";
}

export function DeviceFrame({
  variant,
  platform,
  frameSrc,
  placeholder,
  className,
  maxHeight = 640,
  live = false,
  caption,
  children,
}: DeviceFrameProps) {
  const kind = resolveVariant(variant, platform);
  const isIos = platform === "ios";

  if (kind === "desktop") {
    return (
      <div className={cn("flex flex-col items-center gap-3", className)}>
        <div
          className="relative w-full max-w-3xl overflow-hidden rounded-xl border border-border/80 bg-zinc-900 shadow-2xl shadow-black/40"
          style={{ maxHeight }}
        >
          {/* Window chrome */}
          <div className="flex h-8 items-center gap-1.5 border-b border-white/10 bg-zinc-800 px-3">
            <span className="size-2.5 rounded-full bg-red-400/90" />
            <span className="size-2.5 rounded-full bg-amber-400/90" />
            <span className="size-2.5 rounded-full bg-emerald-400/90" />
            <span className="ml-3 truncate text-[11px] text-zinc-400">
              {caption ?? "Screen share"}
            </span>
            {live ? (
              <span className="ml-auto rounded-full bg-red-500/90 px-2 py-0.5 text-[10px] font-semibold text-white">
                LIVE
              </span>
            ) : null}
          </div>
          <div className="relative aspect-video bg-black">
            {frameSrc ? (
              <img
                src={frameSrc}
                alt="Remote screen"
                className="absolute inset-0 size-full object-contain"
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
                {placeholder ?? "No frame"}
              </div>
            )}
            {children}
          </div>
        </div>
        {caption && kind === "desktop" ? null : null}
      </div>
    );
  }

  // Phone / tablet — premium SVG bezel
  const isTablet = kind === "tablet";
  const aspect = isTablet ? 3 / 4 : 9 / 19.5;

  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div
        className="relative"
        style={{
          width: "min(100%, 320px)",
          maxHeight,
        }}
      >
        {/* Outer metal ring */}
        <div
          className={cn(
            "relative mx-auto overflow-hidden bg-gradient-to-b from-zinc-700 via-zinc-900 to-black p-[10px] shadow-2xl shadow-black/50",
            isTablet ? "rounded-[2rem]" : "rounded-[2.75rem]",
          )}
          style={{
            boxShadow:
              "0 25px 50px -12px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.12)",
          }}
        >
          {/* Side buttons (phone) */}
          {!isTablet ? (
            <>
              <div className="absolute -left-[3px] top-[18%] h-8 w-[3px] rounded-l-sm bg-zinc-600" />
              <div className="absolute -left-[3px] top-[28%] h-12 w-[3px] rounded-l-sm bg-zinc-600" />
              <div className="absolute -left-[3px] top-[40%] h-12 w-[3px] rounded-l-sm bg-zinc-600" />
              <div className="absolute -right-[3px] top-[32%] h-16 w-[3px] rounded-r-sm bg-zinc-600" />
            </>
          ) : null}

          {/* Inner screen bezel */}
          <div
            className={cn(
              "relative overflow-hidden bg-black",
              isTablet ? "rounded-[1.5rem]" : "rounded-[2.15rem]",
            )}
            style={{ aspectRatio: `${aspect}` }}
          >
            {/* Status island / punch-hole */}
            {isIos ? (
              <div className="pointer-events-none absolute left-1/2 top-2 z-20 h-[22px] w-[96px] -translate-x-1/2 rounded-full bg-black" />
            ) : (
              <div className="pointer-events-none absolute left-1/2 top-2.5 z-20 size-2.5 -translate-x-1/2 rounded-full bg-zinc-900 ring-1 ring-zinc-700" />
            )}

            {live ? (
              <span className="absolute right-3 top-3 z-20 rounded-full bg-red-500/95 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white shadow">
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
                    <div className="size-10 animate-pulse rounded-full bg-primary/20" />
                    <p className="text-xs text-zinc-400">Waiting for frames…</p>
                  </>
                )}
              </div>
            )}
            {children}

            {/* Home indicator */}
            {!isTablet ? (
              <div className="pointer-events-none absolute bottom-2 left-1/2 z-20 h-1 w-28 -translate-x-1/2 rounded-full bg-white/35" />
            ) : null}
          </div>
        </div>
      </div>
      {caption ? (
        <p className="text-center text-xs text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  );
}
