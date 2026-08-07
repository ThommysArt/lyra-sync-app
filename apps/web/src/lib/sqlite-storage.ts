/**
 * SQLite-backed StorageLike for Electron desktop.
 * Replaces Chromium localStorage — data lives in main process lyra.db via IPC.
 * Falls back to localStorage only for migration, then removes legacy keys.
 */
import type { StorageLike } from "@lyra-sync-app/core";
import { getDesktopApi } from "./desktop-bridge";

type DesktopKvApi = {
  kvGet: (key: string) => Promise<string | null>;
  kvSet: (key: string, value: string) => Promise<{ ok: boolean; error?: string }>;
  kvRemove: (key: string) => Promise<{ ok: boolean }>;
  kvGetAll: () => Promise<Record<string, string>>;
  kvKeys: () => Promise<string[]>;
};

function getKvApi(): DesktopKvApi | null {
  const api = getDesktopApi() as unknown as DesktopKvApi | null;
  if (!api || typeof api.kvGet !== "function") return null;
  return api;
}

const LEGACY_PREFIXES = ["lyra.v1.", "lyra."];

export function createSqliteLyraStorage(): StorageLike & { hydrate?: () => Promise<void>; flush?: () => Promise<void> } {
  const kv = getKvApi();
  if (!kv) {
    // Pure web fallback — should not be used in Electron, but keep for browser
    console.warn("[lyra sqlite] kv API unavailable, falling back to localStorage (should not happen in Electron)");
    return {
      getItem: (k) => {
        try { return localStorage.getItem(k); } catch { return null; }
      },
      setItem: (k, v) => {
        try { localStorage.setItem(k, v); } catch {}
      },
      removeItem: (k) => {
        try { localStorage.removeItem(k); } catch {}
      },
      hydrate: async () => undefined,
      flush: async () => undefined,
    };
  }

  // In-memory cache synced via hydrate + writes
  const cache = new Map<string, string | null>();
  let hydrated = false;
  let hydratePromise: Promise<void> | null = null;

  const doHydrate = async () => {
    try {
      // Pull all lyra keys from SQLite
      const all = await kv.kvGetAll().catch(() => ({} as Record<string, string>));
      const keys = Object.keys(all);
      if (keys.length === 0) {
        // Empty SQLite — migrate from localStorage once
        try {
          const legacyKeys: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && LEGACY_PREFIXES.some((p) => k.startsWith(p))) legacyKeys.push(k);
          }
          if (legacyKeys.length > 0) {
            console.log(`[lyra sqlite] migrating ${legacyKeys.length} keys from localStorage to SQLite`);
            for (const k of legacyKeys) {
              const v = localStorage.getItem(k);
              if (v != null) {
                await kv.kvSet(k, v).catch((e) => console.error("[lyra sqlite] migrate set failed", k, e));
                cache.set(k, v);
              }
            }
            // Also check isolated key
            const isolated = localStorage.getItem("lyra.v1.state.key");
            if (isolated != null && !cache.has("lyra.v1.state.key")) {
              await kv.kvSet("lyra.v1.state.key", isolated);
              cache.set("lyra.v1.state.key", isolated);
            }
            console.log("[lyra sqlite] migration complete, removing legacy localStorage keys");
            for (const k of legacyKeys) {
              try { localStorage.removeItem(k); } catch {}
            }
            try { localStorage.removeItem("lyra.v1.state.key"); } catch {}
          }
        } catch (e) {
          console.warn("[lyra sqlite] migration check failed", e);
        }
      } else {
        for (const [k, v] of Object.entries(all)) {
          cache.set(k, v);
        }
        // Ensure critical keys are cached even if kvGetAll missed due to filter
        for (const k of ["lyra.v1.state", "lyra.v1.state.key"]) {
          if (!cache.has(k)) {
            try {
              const v = await kv.kvGet(k);
              if (v != null) cache.set(k, v);
            } catch {}
          }
        }
        console.log(`[lyra sqlite] hydrated ${keys.length} keys from SQLite`);
      }
      hydrated = true;
    } catch (e) {
      console.error("[lyra sqlite] hydrate failed", e instanceof Error ? e.message : String(e));
      hydrated = true;
    }
  };

  // Track pending writes so flush() can await them
  const pendingWrites = new Map<string, Promise<unknown>>();
  return {
    hydrate: () => {
      if (hydratePromise) return hydratePromise;
      if (hydrated) return Promise.resolve();
      hydratePromise = doHydrate();
      return hydratePromise;
    },
    flush: async () => {
      // Wait for all pending IPC writes to complete
      const pending = [...pendingWrites.values()];
      if (pending.length > 0) {
        console.log(`[lyra sqlite] flush waiting for ${pending.length} pending writes`);
        await Promise.all(pending.map((p) => p.catch(() => {})));
        console.log(`[lyra sqlite] flush complete`);
      }
    },
    getItem: (key) => {
      if (!hydrated) {
        console.warn("[lyra sqlite] getItem before hydrate", key);
      }
      if (cache.has(key)) {
        const v = cache.get(key);
        return v ?? null;
      }
      return null;
    },
    setItem: (key, value) => {
      cache.set(key, value);
      console.log(`[lyra sqlite] setItem ${key} (${value.length} chars)`);
      const p = kv.kvSet(key, value).then((res) => {
        if (res && typeof res === "object" && "ok" in res && !(res as { ok: boolean }).ok) {
          console.error(`[lyra sqlite] kvSet failed for ${key}:`, (res as { error?: string }).error);
        } else {
          console.log(`[lyra sqlite] kvSet ok for ${key}`);
        }
        pendingWrites.delete(key);
        return res;
      }).catch((e) => {
        console.error("[lyra sqlite] kvSet failed", key, e instanceof Error ? e.message : String(e));
        pendingWrites.delete(key);
        throw e;
      });
      pendingWrites.set(key, p);
      return p as unknown as void;
    },
    removeItem: (key) => {
      cache.delete(key);
      console.log(`[lyra sqlite] removeItem ${key}`);
      const p = kv.kvRemove(key).catch((e) => {
        console.error("[lyra sqlite] kvRemove failed", key, e);
        throw e;
      });
      // Don't track remove in pendingWrites for simplicity
      return p as unknown as void;
    },
  };
}
