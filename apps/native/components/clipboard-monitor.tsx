import * as Clipboard from "expo-clipboard";
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { useLyraSelector, useLyraStore } from "@/lib/lyra";

const POLL_MS = 2500;

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

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [enabled, syncEnabled, store]);

  return null;
}
