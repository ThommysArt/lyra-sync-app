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
import { useEffect, useMemo, useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import { cn } from "@/lib/utils";
import { getDesktopApi, isDesktopShell } from "@/lib/desktop-bridge";
import { useLyraSelector } from "@/lib/lyra";
import { ClipboardMonitor } from "@/components/clipboard-monitor";
import { ConflictBanner } from "@/components/conflict-banner";
import { IncomingPairBanner } from "@/components/incoming-pair-banner";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { ToastListener } from "@/components/toast-listener";
import { WindowControls } from "@/components/window-controls";

const nav = [
  { to: "/", label: "Devices", icon: LayoutGrid, title: "Devices" },
  { to: "/clipboard", label: "Clipboard", icon: ClipboardList, title: "Clipboard" },
  { to: "/transfers", label: "Transfers", icon: History, title: "Transfers" },
  { to: "/settings", label: "Settings", icon: Settings, title: "Settings" },
] as const;

function pageTitleFromPath(pathname: string): string {
  if (pathname.startsWith("/devices/")) return "Device";
  if (pathname.startsWith("/clipboard")) return "Clipboard";
  if (pathname.startsWith("/transfers")) return "Transfers";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Devices";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const identity = useLyraSelector((s) => s.identity);
  const onlineCount = useLyraSelector(
    (s) => s.devices.filter((d) => d.online && d.authSecret && d.showInMainList).length,
  );
  const { theme, setTheme } = useTheme();
  const desktop = isDesktopShell();
  const [shellPlatform, setShellPlatform] = useState<string | null>(null);
  const [usesTrafficLights, setUsesTrafficLights] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    document.documentElement.classList.add("lyra-electron");
    return () => document.documentElement.classList.remove("lyra-electron");
  }, [desktop]);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api?.getShellInfo) return;
    void api.getShellInfo().then((info) => {
      setShellPlatform(info.platform);
      setUsesTrafficLights(Boolean(info.usesSystemTrafficLights));
    });
  }, []);

  const isMacDesktop = desktop && (shellPlatform === "darwin" || usesTrafficLights);
  const desktopChrome = desktop;
  const showCustomWindowControls = desktopChrome && !isMacDesktop;
  const pageTitle = useMemo(() => pageTitleFromPath(pathname), [pathname]);

  return (
    <div
      className={cn(
        "flex h-svh bg-background text-foreground",
        desktop && "lyra-desktop-shell",
        desktopChrome && "lyra-custom-chrome",
      )}
      data-desktop={desktop ? "true" : undefined}
      data-platform={shellPlatform ?? undefined}
    >
      <aside
        className={cn(
          "hidden w-56 shrink-0 flex-col border-r border-border bg-sidebar px-2 md:flex",
          desktopChrome ? "pt-0" : "py-3",
        )}
      >
        {/* Titlebar / brand — drag region */}
        {desktopChrome ? (
          <div
            className="lyra-titlebar-drag shrink-0 select-none"
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            onDoubleClick={() => {
              if (!isMacDesktop) void getDesktopApi()?.windowMaximizeToggle?.();
            }}
          >
            <div
              className={cn(
                "flex h-10 items-center gap-2 px-2",
                isMacDesktop ? "pl-[72px]" : "",
              )}
            >
              <div
                className="flex min-w-0 flex-1 items-center gap-2"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
                  <HardDrive className="size-3.5" />
                </div>
                <p className="truncate text-sm font-semibold tracking-tight">Lyra</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-3 flex items-center gap-2 px-2 py-1">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
              <HardDrive className="size-3.5" />
            </div>
            <p className="truncate text-sm font-semibold tracking-tight">Lyra</p>
          </div>
        )}

        <nav
          className="flex flex-1 flex-col gap-0.5 px-0.5"
          style={desktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        >
          {nav.map(({ to, label, icon: Icon }) => {
            const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
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
          className="mt-auto space-y-1.5 px-0.5 pb-3"
          style={desktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        >
          <div className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-2">
            <p className="text-[11px] text-muted-foreground">This device</p>
            <p className="truncate text-sm font-medium">{identity?.name ?? "—"}</p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {onlineCount} online · private network
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start rounded-md"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Desktop content title bar: page title + drag + window controls */}
        {desktopChrome ? (
          <div
            className={cn(
              "lyra-titlebar-drag relative hidden h-10 shrink-0 items-center border-b border-border md:flex",
            )}
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            onDoubleClick={() => {
              if (!isMacDesktop) void getDesktopApi()?.windowMaximizeToggle?.();
            }}
          >
            <div
              className="flex min-w-0 flex-1 items-center px-4"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <h1 className="truncate text-sm font-semibold tracking-tight">{pageTitle}</h1>
            </div>
            {showCustomWindowControls ? (
              <div className="flex h-full items-stretch">
                <WindowControls />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Web (non-desktop) top page title on md+ — optional strip for parity */}
        {!desktopChrome ? (
          <div className="hidden h-10 shrink-0 items-center border-b border-border px-4 md:flex">
            <h1 className="truncate text-sm font-semibold tracking-tight">{pageTitle}</h1>
          </div>
        ) : null}

        <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <HardDrive className="size-3.5" />
            </div>
            <span className="text-sm font-semibold">{pageTitle}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            {showCustomWindowControls ? <WindowControls /> : null}
          </div>
        </header>

        <IncomingPairBanner />
        <ConflictBanner />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>

        <nav className="flex border-t border-border bg-background/95 px-1.5 py-1.5 backdrop-blur md:hidden">
          {nav.map(({ to, label, icon: Icon }) => {
            const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "flex flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[10px] font-medium",
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
