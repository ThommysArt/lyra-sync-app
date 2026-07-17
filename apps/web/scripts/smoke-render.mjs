/**
 * Headless smoke: mount store + selector-heavy UI and fail if unstable.
 */
import { Window } from "happy-dom";
import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

const window = new Window({ url: "http://localhost:3001/" });
const { document } = window;
globalThis.window = window;
globalThis.document = document;
Object.defineProperty(globalThis, "navigator", {
  value: window.navigator,
  configurable: true,
});
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createLyraStore } = await import("../../../packages/core/src/index.ts");
const { useSyncExternalStore, useCallback, createContext, useContext } =
  await import("react");

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const k of aKeys) if (!Object.is(a[k], b[k])) return false;
  return true;
}

const StoreContext = createContext(null);

function useLyraSelector(selector) {
  const store = useContext(StoreContext);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef(null);
  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(store.getState());
    const prev = cacheRef.current;
    if (prev && shallowEqual(prev.value, next)) return prev.value;
    cacheRef.current = { value: next };
    return next;
  }, [store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

let commitCount = 0;

function DeviceList() {
  commitCount += 1;
  const devices = useLyraSelector((s) =>
    s.devices
      .filter((d) => d.showInMainList)
      .sort((a, b) => Number(b.online) - Number(a.online)),
  );
  const onlineIds = useLyraSelector((s) =>
    s.devices.filter((d) => d.online).map((d) => d.id),
  );
  const history = useLyraSelector((s) =>
    [...s.clipboardHistory].sort((a, b) => b.createdAt - a.createdAt),
  );

  // One-shot effect — must not setState every paint
  useEffect(() => {
    // intentional empty deps
  }, []);

  return createElement(
    "div",
    { "data-testid": "list" },
    `devices=${devices.length} online=${onlineIds.length} clips=${history.length}`,
  );
}

function App({ store }) {
  return createElement(
    StoreContext.Provider,
    { value: store },
    createElement(DeviceList),
  );
}

const store = createLyraStore({ storage: null, seedDemo: true, platformHint: "web" });
await store.hydrate();

const rootEl = document.createElement("div");
document.body.appendChild(rootEl);

let error = null;
window.addEventListener("error", (e) => {
  error = e.error || e.message;
});

const root = createRoot(rootEl);
root.render(createElement(App, { store }));

await new Promise((r) => setTimeout(r, 100));
const commitsAfterMount = commitCount;

store.pushClipboardText("smoke");
await new Promise((r) => setTimeout(r, 50));

const online = store.getState().devices.filter((d) => d.online).map((d) => d.id);
if (online[0]) {
  store.startFileTransfer([online[0]], [{ name: "a.txt", size: 10 }]);
}
await new Promise((r) => setTimeout(r, 600));

const text = rootEl.textContent || "";
console.log("DOM:", text);
console.log("commits after mount:", commitsAfterMount);
console.log("commits total:", commitCount);
console.log("error:", error);

if (error && String(error).includes("Maximum update depth")) {
  console.error("FAIL: maximum update depth");
  process.exit(1);
}
// mount should be 1–2 commits; total with store updates still small
if (commitsAfterMount > 5) {
  console.error("FAIL: unstable on mount", commitsAfterMount);
  process.exit(1);
}
if (commitCount > 40) {
  console.error("FAIL: too many commits after store churn", commitCount);
  process.exit(1);
}
if (!text.includes("devices=3")) {
  console.error("FAIL: unexpected DOM", text);
  process.exit(1);
}
console.log("PASS");
process.exit(0);
