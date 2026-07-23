import { Toaster } from "@lyra-sync-app/ui/components/sonner";
import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
  useRouterState,
} from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { ScreenShareHost } from "@/components/screen-share-host";
import { ThemeProvider } from "@/components/theme-provider";
import { LyraProvider } from "@/lib/lyra";

import "../index.css";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      { title: "Lyra — Private device network" },
      {
        name: "description",
        content:
          "Privacy-first clipboard sync, file transfer, and remote browse across your devices.",
      },
    ],
    links: [{ rel: "icon", href: "./favicon.ico", sizes: "48x48" }],
  }),
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        storageKey="lyra-ui-theme"
      >
        <LyraProvider>
          <ShellOrMirror />
          <ScreenShareHost />
          <Toaster richColors position="bottom-right" />
        </LyraProvider>
      </ThemeProvider>
    </>
  );
}

/** Mirror windows skip the sidebar chrome for a clean device cast. */
function ShellOrMirror() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isMirror = pathname.startsWith("/mirror/");
  if (isMirror) {
    return <Outlet />;
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
