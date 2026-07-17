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

import { Button } from "@lyra-sync-app/ui/components/button";
import { cn } from "@/lib/utils";
import { useLyraSelector } from "@/lib/lyra";
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
    (s) => s.devices.filter((d) => d.online && d.showInMainList).length,
  );
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex h-svh bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border/80 bg-sidebar px-3 py-4 md:flex">
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

        <nav className="flex flex-1 flex-col gap-1">
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

        <div className="mt-auto space-y-2 px-1">
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
    </div>
  );
}
