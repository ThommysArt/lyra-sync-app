/**
 * Sync screenSessions across BrowserWindows / popups on the same origin.
 * Demo frames and P2P state live in the window that started the mirror;
 * the dedicated mirror window mirrors them via BroadcastChannel.
 */

import type { LyraStore } from "@lyra-sync-app/core";
import type { ScreenSession } from "@lyra-sync-app/protocol";

const CHANNEL = "lyra-screen-sessions";

export function installScreenSessionSync(store: LyraStore): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;

  const bc = new BroadcastChannel(CHANNEL);
  let applying = false;
  let lastJson = "";

  const unsub = store.subscribe(() => {
    if (applying) return;
    const sessions = store.getState().screenSessions;
    const json = JSON.stringify(sessions);
    if (json === lastJson) return;
    lastJson = json;
    try {
      bc.postMessage({ type: "sessions", sessions } satisfies {
        type: "sessions";
        sessions: Record<string, ScreenSession>;
      });
    } catch {
      // channel closed
    }
  });

  bc.onmessage = (ev: MessageEvent) => {
    const data = ev.data as
      | { type: "sessions"; sessions: Record<string, ScreenSession> }
      | undefined;
    if (!data || data.type !== "sessions" || !data.sessions) return;
    const json = JSON.stringify(data.sessions);
    if (json === lastJson) return;
    applying = true;
    lastJson = json;
    try {
      store.applyScreenSessions(data.sessions);
    } finally {
      applying = false;
    }
  };

  return () => {
    unsub();
    try {
      bc.close();
    } catch {
      // ignore
    }
  };
}
