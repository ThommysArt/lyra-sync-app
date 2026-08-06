/**
 * Manual smoke for screen mirror + Tailscale address APIs.
 * Run: pnpm --filter @lyra-sync-app/core exec tsx scripts/smoke-screen-mirror.mjs
 */
import { createLyraStore } from "../src/store.ts";

const mem = new Map();
const storage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};

const store = createLyraStore({ storage, seedDemo: true, platformHint: "web" });
await store.hydrate();
store.updateSettings({ tailscaleEnabled: true });

const ts = store.addManualPeer({
  host: "100.83.145.32",
  name: "pixel-6",
  asTailscale: true,
});
console.log("tailscale add", ts.ok, ts.ok ? ts.device.connectionType : ts.error);

const pixel = store.getState().devices.find((d) => d.id === "demo_pixel");
if (!pixel) throw new Error("demo_pixel missing");
const m = await store.startScreenMirror(pixel.id, { mode: "demo" });
console.log("mirror start", m);
await new Promise((r) => setTimeout(r, 500));
const s = store.getState().screenSessions[pixel.id];
console.log("session", {
  status: s?.status,
  mode: s?.mode,
  frames: s?.frameCount,
  fps: s?.fps,
  hasFrame: Boolean(s?.lastFrameDataUrl),
});
if (!s?.lastFrameDataUrl) throw new Error("expected frame data URL");
await store.stopScreenMirror(pixel.id);
console.log("stopped", store.getState().screenSessions[pixel.id]?.status);
console.log("SMOKE_OK");
