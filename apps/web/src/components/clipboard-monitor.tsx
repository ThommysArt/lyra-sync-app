import { useEffect, useRef } from "react";

import { readSystemClipboard } from "@/lib/clipboard";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

const POLL_MS = 1500;

/**
 * Desktop/web clipboard watcher. When `autoMonitorClipboard` is on and the
 * document is visible, polls the system clipboard and ingests new text.
 *
 * Browsers require a focused secure context and may prompt for permission
 * once; failures are silent so the manual “Read system” path still works.
 */
export function ClipboardMonitor() {
  const store = useLyraStore();
  const enabled = useLyraSelector((s) => s.settings.autoMonitorClipboard);
  const syncEnabled = useLyraSelector((s) => s.settings.clipboardSyncEnabled);
  const lastSeenRef = useRef<string>("");

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      // Skip while the user is typing in an input — reading is fine, but we
      // avoid racing with intentional local edits of the draft field.
      const active = document.activeElement;
      const tag = active?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || (active as HTMLElement | null)?.isContentEditable) {
        return;
      }

      const text = await readSystemClipboard();
      if (cancelled || !text) return;
      const trimmed = text.trim();
      if (!trimmed || trimmed === lastSeenRef.current) return;
      lastSeenRef.current = trimmed;
      store.ingestSystemClipboardText(trimmed, {
        sync: syncEnabled,
        silent: true,
      });
    };

    // Seed baseline so enabling monitor doesn't immediately re-push current clipboard
    void readSystemClipboard().then((text) => {
      if (cancelled) return;
      lastSeenRef.current = text.trim();
      store.setLocalClipboardText(lastSeenRef.current);
    });

    timer = setInterval(() => {
      void tick();
    }, POLL_MS);

    const onFocus = () => {
      void tick();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, syncEnabled, store]);

  return null;
}
