import { Toaster } from "@lyra-sync-app/ui/components/sonner";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { AppShell } from "@/components/app-shell";
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
    links: [{ rel: "icon", href: "/favicon.ico" }],
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
          <AppShell>
            <Outlet />
          </AppShell>
          <Toaster richColors position="bottom-right" />
        </LyraProvider>
      </ThemeProvider>
      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-left" /> : null}
    </>
  );
}
