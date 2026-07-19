import { Link, useRouterState } from "@tanstack/react-router";
import {
  ClipboardList,
  HardDrive,
  History,
  LayoutGrid,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import { cn } from "@/lib/utils";
import { getDesktopApi, isDesktopShell } from "@/lib/desktop-bridge";
import { useLyraSelector } from "@/lib/lyra";
import { ClipboardMonitor } from "@/components/clipboard-monitor";
import { ConflictBanner } from "@/components/conflict-banner";
import { IncomingPairBanner } from "@/components/incoming-pair-banner";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { ToastListener } from "@/components/toast-listener";

const nav = [
  { to: "/", label: "Devices", icon: LayoutGrid },
  { to: "/clipboard", label: "Clipboard", icon: ClipboardList },
  { to: "/transfers", label: "Transfers", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const identity = useLyraSelector((s) => s.identity);
  const onlineCount = useLyraSelector(
    (s) => s.devices.filter((d) => d.online && d.authSecret && d.showInMainList).length,
  );
  const { theme, setTheme } = useTheme();
  const desktop = isDesktopShell();
  const [shellPlatform, setShellPlatform] = useState<string | null>(null);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api?.getShellInfo) return;
    void api.getShellInfo().then((info) => setShellPlatform(info.platform));
  }, []);

  const isMacDesktop = desktop && shellPlatform === "darwin";
  const isWinDesktop = desktop && shellPlatform === "win32";
  // Hidden title bar leaves a drag strip; pad sidebar brand under traffic lights / overlay.
  const desktopChrome = desktop && (isMacDesktop || isWinDesktop || shellPlatform === "linux");

  return (
    <div
      className={cn(
        "flex h-svh bg-background text-foreground",
        desktop && "lyra-desktop-shell",
      )}
      data-desktop={desktop ? "true" : undefined}
      data-platform={shellPlatform ?? undefined}
    >
      <aside
        className={cn(
          "hidden w-60 shrink-0 flex-col border-r border-border/80 bg-sidebar px-3 md:flex",
          desktopChrome ? "pt-0" : "py-4",
        )}
      >
        {/* Electron drag region — merges chrome with sidebar like T3 Code */}
        {desktopChrome ? (
          <div
            className="lyra-titlebar-drag shrink-0"
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            aria-hidden
          >
            <div
              className={cn(
                "flex items-end px-2 pb-3",
                isMacDesktop ? "h-12 pl-16" : "h-11",
              )}
            >
              <div
                className="flex min-w-0 items-center gap-2.5"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <div className="flex size-8 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
                  <HardDrive className="size-3.5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold tracking-tight">Lyra</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {onlineCount} online · private network
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-6 flex items-center gap-2.5 px-2">
            <div className="flex size-9 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <HardDrive className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight">Lyra</p>
              <p className="truncate text-xs text-muted-foreground">
                {onlineCount} online · private network
              </p>
            </div>
          </div>
        )}

        <nav
          className="flex flex-1 flex-col gap-1"
          style={desktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        >
          {nav.map(({ to, label, icon: Icon }) => {
            const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "flex items-center gap-2.5 rounded-full px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div
          className="mt-auto space-y-2 px-1 pb-4"
          style={desktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        >
          <div className="rounded-3xl border border-border/70 bg-card/60 px-3 py-3">
            <p className="text-xs text-muted-foreground">This device</p>
            <p className="truncate text-sm font-medium">{identity?.name ?? "—"}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start rounded-full"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top drag strip for content area on desktop (Windows overlay / Linux frame) */}
        {desktopChrome ? (
          <div
            className="lyra-titlebar-drag hidden h-3 shrink-0 md:block"
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            aria-hidden
          />
        ) : null}

        <header className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <HardDrive className="size-3.5" />
            </div>
            <span className="font-semibold">Lyra</span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </header>

        <IncomingPairBanner />
        <ConflictBanner />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>

        <nav className="flex border-t border-border/70 bg-background/95 px-2 py-2 backdrop-blur md:hidden">
          {nav.map(({ to, label, icon: Icon }) => {
            const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "flex flex-1 flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 text-[10px] font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className="size-5" />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
      <ToastListener />
      <KeyboardShortcuts />
      <ClipboardMonitor />
    </div>
  );
}
