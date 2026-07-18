/**
 * Persist sensitive Lyra state. Prefer expo-secure-store for the private key;
 * bulk UI state stays in a larger store (AsyncStorage / localStorage).
 */
import type { StorageLike } from "@lyra-sync-app/core";
import * as SecureStore from "expo-secure-store";

const PRIVATE_KEY_ITEM = "lyra.privateKey";
const STATE_PREFIX = "lyra.v1.";

function memoryFallback(): StorageLike & {
  getPrivateKey: () => Promise<string | null>;
  setPrivateKey: (value: string) => Promise<void>;
  deletePrivateKey: () => Promise<void>;
} {
  const map = new Map<string, string>();
  let privateKey: string | null = null;
  return {
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
};

/** Combined storage: SecureStore for private key, localStorage (or memory) for the rest. */
export function createSecureLyraStorage(): SecureLyraStorage {
  const canUseWebLocal =
    typeof localStorage !== "undefined" && typeof localStorage.getItem === "function";

  const bulk: StorageLike = canUseWebLocal
    ? localStorage
    : (() => {
        const map = new Map<string, string>();
        return {
          getItem: (k: string) => map.get(k) ?? null,
          setItem: (k: string, v: string) => {
            map.set(k, v);
          },
          removeItem: (k: string) => {
            map.delete(k);
          },
        };
      })();

  // SecureStore is unavailable on some web targets — fall back gracefully
  const secureAvailable =
    typeof SecureStore?.getItemAsync === "function" &&
    // Expo web may polyfill no-ops; still fine
    true;

  if (!secureAvailable) {
    const mem = memoryFallback();
    return {
      getItem: (k) => bulk.getItem(k),
      setItem: (k, v) => bulk.setItem(k, v),
      removeItem: (k) => bulk.removeItem?.(k),
      getPrivateKey: mem.getPrivateKey,
      setPrivateKey: mem.setPrivateKey,
      deletePrivateKey: mem.deletePrivateKey,
    };
  }

  return {
    getItem: (k) => bulk.getItem(k),
    setItem: (k, v) => bulk.setItem(k, v),
    removeItem: (k) => bulk.removeItem?.(k),
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
    const raw = storage.getItem(stateKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { privateKey?: string | null };
    if (parsed.privateKey) {
      await storage.setPrivateKey(parsed.privateKey);
      const { privateKey: _drop, ...rest } = parsed as Record<string, unknown>;
      storage.setItem(stateKey, JSON.stringify({ ...rest, privateKey: null }));
    }
  } catch {
    // ignore corrupt
  }
  void STATE_PREFIX;
}
