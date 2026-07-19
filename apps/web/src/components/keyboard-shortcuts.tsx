import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useLyraStore } from "@/lib/lyra";
import { readSystemClipboard } from "@/lib/clipboard";
import { getDesktopApi } from "@/lib/desktop-bridge";

/**
 * In-app keyboard shortcuts (spec §5.10).
 * Uses mod = Ctrl on Windows/Linux, Meta on macOS.
 */
export function KeyboardShortcuts() {
  const store = useLyraStore();
  const navigate = useNavigate();

  useEffect(() => {
    const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // Quit desktop shell — Ctrl/Cmd+Q
      if (isMod(e) && e.key.toLowerCase() === "q") {
        const api = getDesktopApi();
        if (api?.quit) {
          e.preventDefault();
          void api.quit();
        }
        return;
      }

      // Focus search / device list — Ctrl/Cmd+K
      if (isMod(e) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        void navigate({ to: "/" });
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLInputElement>(
            'input[placeholder*="Search devices"]',
          );
          el?.focus();
        });
        return;
      }

      // Open settings — Ctrl/Cmd+,
      if (isMod(e) && e.key === ",") {
        e.preventDefault();
        void navigate({ to: "/settings" });
        return;
      }

      // Send clipboard to online devices — Ctrl/Cmd+Shift+V
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        const online = store
          .getState()
          .devices.filter((d) => d.online && d.showInMainList)
          .map((d) => d.id);
        void readSystemClipboard().then((text) => {
          const payload = text || store.getState().localClipboardText || "Shared via Lyra";
          store.pushClipboardText(payload, online);
        });
        return;
      }

      // Open transfers — Ctrl/Cmd+Shift+T
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void navigate({ to: "/transfers" });
        return;
      }

      // Open clipboard history — Ctrl/Cmd+Shift+C
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === "c" && !inField) {
        e.preventDefault();
        void navigate({ to: "/clipboard" });
        return;
      }

      // Pause / resume active transfers — Ctrl/Cmd+Shift+P
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        const active = store
          .getState()
          .transfers.filter((t) => t.status === "transferring" || t.status === "paused");
        for (const t of active) {
          store.setTransferStatus(
            t.id,
            t.status === "transferring" ? "paused" : "transferring",
          );
        }
        return;
      }

      // Open first selected / first online device explorer — Ctrl/Cmd+E
      if (isMod(e) && e.key.toLowerCase() === "e" && !inField) {
        e.preventDefault();
        const state = store.getState();
        const id =
          state.selectedDeviceId ??
          state.devices.find((d) => d.online && d.showInMainList)?.id;
        if (id) void navigate({ to: "/devices/$deviceId", params: { deviceId: id } });
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, store]);

  return null;
}
