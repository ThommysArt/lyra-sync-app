export const STORAGE_KEY = "lyra.v2.state" as const;
export const SECURE_KEY = "lyra.v2.key" as const;

export interface StorageLike {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

export function createLocalStorageAdapter(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
      removeItem: (k) => localStorage.removeItem(k),
    };
  } catch {
    return null;
  }
}

/**
 * createSecureStorageAdapter — scaffold: wraps StorageLike and isolates authSecret/privateKey
 * to a separate key (secure). For Electron safeStorage / expo-secure-store this would be
 * replaced with encrypted adapter; here we just split keys.
 */
export function createSecureStorageAdapter(
  bulk: StorageLike,
  secure: StorageLike = bulk,
): { bulk: StorageLike; secure: StorageLike } {
  return { bulk, secure };
}
