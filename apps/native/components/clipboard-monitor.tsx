import * as Clipboard from "expo-clipboard";
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus, NativeEventEmitter, NativeModules } from "react-native";

import { useLyraSelector, useLyraStore } from "@/lib/lyra";

const POLL_MS = 1500;

/**
 * Foreground clipboard poller for native. OS restrictions prevent true
 * background monitoring; this covers in-app capture when the setting is on.
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
    let appState: AppStateStatus = AppState.currentState;

    const tick = async () => {
      if (cancelled || appState !== "active") return;
      try {
        const text = await Clipboard.getStringAsync();
        const trimmed = text.trim();
        if (!trimmed || trimmed === lastSeenRef.current) return;
        lastSeenRef.current = trimmed;
        store.ingestSystemClipboardText(trimmed, {
          sync: syncEnabled,
          silent: true,
        });
      } catch {
        // permission / platform limits
      }
    };

    void Clipboard.getStringAsync()
      .then((text) => {
        if (cancelled) return;
        lastSeenRef.current = text.trim();
        if (lastSeenRef.current) store.setLocalClipboardText(lastSeenRef.current);
      })
      .catch(() => {
        // ignore
      });

    timer = setInterval(() => {
      void tick();
    }, POLL_MS);

    const sub = AppState.addEventListener("change", (next) => {
      appState = next;
      if (next === "active") void tick();
    });

    // Background AccessibilityService bridge (if installed)
    let nativeSub: { remove: () => void } | null = null;
    try {
      const mod = (NativeModules as unknown as Record<string, unknown>)["LyraClipboard"] as unknown as { addListener?: unknown } | undefined;
      if (mod) {
        const emitter = new NativeEventEmitter(mod as unknown as object);
        nativeSub = emitter.addListener("onClipboardChanged", (data: unknown) => {
          const d = data as { text?: string } | string;
          const t = typeof d === "string" ? d : (d as { text?: string })?.text;
          if (typeof t === "string" && t.trim() && t.trim() !== lastSeenRef.current) {
            const trimmed = t.trim();
            lastSeenRef.current = trimmed;
            store.ingestSystemClipboardText(trimmed, { sync: syncEnabled, silent: true });
          }
        });
        // Also poll last clipboard on resume via module
        void (async () => {
          try {
            const last = await (mod as unknown as { getLastClipboard?: () => Promise<string | null> }).getLastClipboard?.();
            if (typeof last === "string" && last.trim() && last.trim() !== lastSeenRef.current) {
              lastSeenRef.current = last.trim();
              store.ingestSystemClipboardText(last.trim(), { sync: syncEnabled, silent: true });
            }
          } catch {}
        })();
      }
    } catch {}

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      sub.remove();
      try { nativeSub?.remove(); } catch {}
    };
  }, [enabled, syncEnabled, store]);

  return null;
}
