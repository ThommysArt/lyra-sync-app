import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { getDesktopApi, type DesktopWindowState } from "@/lib/desktop-bridge";

/**
 * Custom min / max / close for frameless Electron shells (Win + Linux).
 * macOS uses system traffic lights inset into the sidebar.
 */
export function WindowControls({ className }: { className?: string }) {
  const api = getDesktopApi();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!api?.windowGetState) return;
    void api.windowGetState().then((s) => setMaximized(s.maximized));
    const unsub = api.onWindowState?.((s: DesktopWindowState) => {
      setMaximized(s.maximized);
    });
    return () => unsub?.();
  }, [api]);

  if (!api?.windowMinimize || !api.windowClose) return null;

  return (
    <div
      className={cn("lyra-window-controls flex h-full items-stretch", className)}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label="Minimize"
        className="flex w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => void api.windowMinimize?.()}
      >
        <Minus className="size-3" strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        className="flex w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => void api.windowMaximizeToggle?.()}
      >
        {maximized ? (
          <span className="relative inline-block size-2.5">
            <span className="absolute bottom-0 left-0 size-1.5 border border-current" />
            <span className="absolute right-0 top-0 size-1.5 border border-current bg-background" />
          </span>
        ) : (
          <Square className="size-2.5" strokeWidth={2} />
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        className="flex w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-white"
        onClick={() => void api.windowClose?.()}
      >
        <X className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
