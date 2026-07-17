import { createLyraStore, type LyraState, type LyraStore } from "@lyra-sync-app/core";
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

const StoreContext = createContext<LyraStore | null>(null);

/** Shallow compare so selectors that return new arrays/objects don't infinite-loop useSyncExternalStore. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!Object.is(aObj[key], bObj[key])) return false;
  }
  return true;
}

export function LyraProvider({ children }: { children: ReactNode }) {
  const store = useMemo(
    () =>
      createLyraStore({
        storage: typeof localStorage !== "undefined" ? localStorage : null,
        seedDemo: true,
        platformHint: "web",
      }),
    [],
  );

  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void store.hydrate().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  if (!ready) {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="size-10 animate-pulse rounded-full bg-primary/20" />
          <p className="text-sm text-muted-foreground">Starting Lyra…</p>
        </div>
      </div>
    );
  }

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
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
