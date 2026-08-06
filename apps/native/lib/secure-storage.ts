/**
 * Persist sensitive Lyra state. Prefer expo-secure-store for the private key;
 * bulk UI state uses AsyncStorage on native and localStorage on web.
 */
import type { StorageLike } from "@lyra-sync-app/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const PRIVATE_KEY_ITEM = "lyra.privateKey";
const STATE_PREFIX = "lyra.v1.";

/**
 * In-memory cache backed by AsyncStorage.
 * Core store expects sync getItem/setItem; we hydrate the cache before use
 * and write-through async.
 */
function createAsyncStorageBulk(): StorageLike & { hydrate: () => Promise<void> } {
  const cache = new Map<string, string>();
  let ready = false;
  let hydratePromise: Promise<void> | null = null;

  const doHydrate = async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const lyraKeys = keys.filter((k) => k.startsWith(STATE_PREFIX) || k === "lyra.v1.state");
      if (lyraKeys.length === 0) {
        const all = await AsyncStorage.multiGet(keys.filter((k) => k.startsWith("lyra.")));
        for (const [k, v] of all) {
          if (k && v != null) cache.set(k, v);
        }
      } else {
        const pairs = await AsyncStorage.multiGet(lyraKeys);
        for (const [k, v] of pairs) {
          if (k && v != null) cache.set(k, v);
        }
      }
      const state = await AsyncStorage.getItem("lyra.v1.state");
      if (state != null) cache.set("lyra.v1.state", state);
      const key = await AsyncStorage.getItem("lyra.v1.state.key");
      if (key != null) cache.set("lyra.v1.state.key", key);
    } catch (e) {
      console.warn("[lyra storage] hydrate failed", e);
    }
    ready = true;
  };

  return {
    hydrate: () => {
      if (hydratePromise) return hydratePromise;
      if (ready) return Promise.resolve();
      hydratePromise = doHydrate().finally(() => {
        // keep promise for dedupe
      });
      return hydratePromise;
    },
    getItem: (k) => {
      if (!ready) {
        console.warn("[lyra storage] getItem before hydrate", k);
      }
      return cache.get(k) ?? null;
    },
    setItem: (k, v) => {
      cache.set(k, v);
      // Write-through async but surface errors in log
      void AsyncStorage.setItem(k, v).catch((e) => {
        console.warn("[lyra storage] setItem failed", k, e instanceof Error ? e.message : String(e));
      });
    },
    removeItem: (k) => {
      cache.delete(k);
      void AsyncStorage.removeItem(k).catch((e) => {
        console.warn("[lyra storage] removeItem failed", k, e instanceof Error ? e.message : String(e));
      });
    },
  };
}

function memoryFallback(): StorageLike & {
  getPrivateKey: () => Promise<string | null>;
  setPrivateKey: (value: string) => Promise<void>;
  deletePrivateKey: () => Promise<void>;
  hydrate?: () => Promise<void>;
} {
  const map = new Map<string, string>();
  let privateKey: string | null = null;
  return {
    hydrate: async () => undefined,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    getPrivateKey: async () => privateKey,
    setPrivateKey: async (value) => {
      privateKey = value;
    },
    deletePrivateKey: async () => {
      privateKey = null;
    },
  };
}

export type SecureLyraStorage = StorageLike & {
  getPrivateKey: () => Promise<string | null>;
  setPrivateKey: (value: string) => Promise<void>;
  deletePrivateKey: () => Promise<void>;
  /** Load bulk cache from disk (native AsyncStorage). */
  hydrate?: () => Promise<void>;
};

/** Combined storage: SecureStore for private key, AsyncStorage/localStorage for the rest. */
export function createSecureLyraStorage(): SecureLyraStorage {
  const canUseWebLocal =
    Platform.OS === "web" &&
    typeof localStorage !== "undefined" &&
    typeof localStorage.getItem === "function";

  const bulk: StorageLike & { hydrate?: () => Promise<void> } = canUseWebLocal
    ? {
        getItem: (k) => localStorage.getItem(k),
        setItem: (k, v) => {
          localStorage.setItem(k, v);
        },
        removeItem: (k) => {
          localStorage.removeItem(k);
        },
      }
    : createAsyncStorageBulk();

  return {
    getItem: (k) => bulk.getItem(k),
    setItem: (k, v) => bulk.setItem(k, v),
    removeItem: (k) => bulk.removeItem?.(k),
    hydrate: bulk.hydrate,
    getPrivateKey: async () => {
      try {
        return await SecureStore.getItemAsync(PRIVATE_KEY_ITEM);
      } catch {
        return null;
      }
    },
    setPrivateKey: async (value: string) => {
      try {
        await SecureStore.setItemAsync(PRIVATE_KEY_ITEM, value);
      } catch {
        // ignore — key remains in bulk state via normal persist
      }
    },
    deletePrivateKey: async () => {
      try {
        await SecureStore.deleteItemAsync(PRIVATE_KEY_ITEM);
      } catch {
        // ignore
      }
    },
  };
}

/** Strip private key from bulk JSON and write it to SecureStore when hydrating/persisting. */
export async function migratePrivateKeyToSecureStore(
  storage: SecureLyraStorage,
  stateKey = "lyra.v1.state",
): Promise<void> {
  try {
    // hydrate is idempotent via promise dedupe; call once
    if (storage.hydrate) await storage.hydrate();
    const raw = storage.getItem(stateKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { privateKey?: string | null };
    if (parsed.privateKey) {
      await storage.setPrivateKey(parsed.privateKey);
      const { privateKey: _drop, ...rest } = parsed as Record<string, unknown>;
      storage.setItem(stateKey, JSON.stringify({ ...rest, privateKey: null }));
      // Also ensure async flush completes before next read
      await new Promise((r) => setTimeout(r, 0));
    }
  } catch (e) {
    console.warn("[lyra storage] migrate failed", e instanceof Error ? e.message : String(e));
  }
}
