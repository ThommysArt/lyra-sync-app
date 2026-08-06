import * as SecureStore from "expo-secure-store";
import { createMemoryStorage, type StorageLike } from "@lyra-sync-app/core";

/**
 * createSecureStorage — expo-secure-store adapter for authSecret/privateKey
 * Falls back to AsyncStorage if available, otherwise in-memory.
 */
export function createSecureStorage(): StorageLike {
  const mem = createMemoryStorage();

  // lazy async storage loader
  let asyncStorage: StorageLike | null = null;
  let asyncStorageTried = false;

  async function getAsyncStorage(): Promise<StorageLike | null> {
    if (asyncStorageTried) return asyncStorage;
    asyncStorageTried = true;
    try {
      // dynamic import so bundler doesn't fail if not installed — tsc ignore because package optional
      // @ts-ignore - optional dep
      const mod = await import("@react-native-async-storage/async-storage" as string).catch(() => null);
      const def = (mod as unknown as { default?: StorageLike })?.default ?? null;
      if (def && typeof def.getItem === "function" && typeof def.setItem === "function") {
        asyncStorage = def;
        return asyncStorage;
      }
    } catch {
      // ignore
    }
    return null;
  }

  return {
    getItem: async (key: string) => {
      try {
        const v = await SecureStore.getItemAsync(key);
        if (v !== null) return v;
      } catch {
        // ignore — fallback
      }
      const asyncStore = await getAsyncStorage();
      if (asyncStore) {
        try {
          return await asyncStore.getItem(key);
        } catch {
          // ignore
        }
      }
      return mem.getItem(key) as string | null;
    },
    setItem: async (key: string, value: string) => {
      try {
        await SecureStore.setItemAsync(key, value);
        return;
      } catch {
        // fallback
      }
      const asyncStore = await getAsyncStorage();
      if (asyncStore) {
        try {
          await asyncStore.setItem(key, value);
          return;
        } catch {
          // ignore
        }
      }
      await mem.setItem(key, value);
    },
    removeItem: async (key: string) => {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // ignore
      }
      const asyncStore = await getAsyncStorage();
      if (asyncStore) {
        try {
          await asyncStore.removeItem(key);
        } catch {
          // ignore
        }
      }
      await mem.removeItem(key);
    },
  };
}
