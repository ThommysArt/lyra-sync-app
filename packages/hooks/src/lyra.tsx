import {
  createLyraStore,
  type LyraState,
  type LyraStore,
  type StorageLike,
} from "@lyra-sync-app/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { shallowEqual } from "./shallow-equal";

// Share StoreContext across HMR / duplicate module copies (vite deps cache + monorepo)
// so useLyraStore never sees a null context when the provider comes from a different bundle copy.
const GLOBAL_CTX_KEY = Symbol.for("lyra.StoreContext");
function getStoreContext() {
  const g = globalThis as unknown as Record<symbol, ReturnType<typeof createContext<LyraStore | null>> | undefined>;
  if (!g[GLOBAL_CTX_KEY]) {
    g[GLOBAL_CTX_KEY] = createContext<LyraStore | null>(null);
  }
  return g[GLOBAL_CTX_KEY]!;
}
const StoreContext = getStoreContext();

export type LyraProviderProps = {
  children: ReactNode;
  storage?: StorageLike | null;
  seedDemo?: boolean;
  platformHint?: "web" | "native" | "android" | "ios";
  /** Optional loading UI while hydrate() runs */
  fallback?: ReactNode;
  /**
   * Called once after the store is created (e.g. attach desktop peer-status bridge).
   * Return a cleanup function if needed.
   */
  onStoreReady?: (store: LyraStore) => void | (() => void);
};

export function LyraProvider({
  children,
  storage = null,
  seedDemo = true,
  platformHint = "web",
  fallback = null,
  onStoreReady,
}: LyraProviderProps) {
  const store = useMemo(
    () =>
      createLyraStore({
        storage,
        seedDemo,
        platformHint,
      }),
    [storage, seedDemo, platformHint],
  );

  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void store
      .hydrate()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((err) => {
        // Never leave the shell stuck on the splash forever if hydrate throws.
        console.error("[lyra] store.hydrate failed", err);
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    if (!ready || !onStoreReady) return;
    return onStoreReady(store);
  }, [ready, store, onStoreReady]);

  // Always provide StoreContext even while hydrating so that HMR or
  // early mounts (e.g. route lazy chunks) don't see a null context and
  // throw "useLyraStore must be used within LyraProvider". We render
  // `fallback` until hydrate completes, then children.
  return (
    <StoreContext.Provider value={store}>
      {ready ? children : (fallback ?? null)}
    </StoreContext.Provider>
  );
}

export function useLyraStore(): LyraStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useLyraStore must be used within LyraProvider");
  return store;
}

/**
 * Subscribe to a slice of Lyra state.
 * Snapshots are cached with shallow equality so `.filter()` / `.map()` selectors are safe.
 */
export function useLyraSelector<T>(selector: (state: LyraState) => T): T {
  const store = useLyraStore();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const cacheRef = useRef<{ value: T } | null>(null);

  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(store.getState());
    const prev = cacheRef.current;
    if (prev && shallowEqual(prev.value, next)) {
      return prev.value;
    }
    cacheRef.current = { value: next };
    return next;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useLyraState(): LyraState {
  const store = useLyraStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export { shallowEqual };
