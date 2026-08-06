import { createLyraStore, createMemoryStorage, type StorageLike } from "@lyra-sync-app/core";
import { NodeHttpTransport } from "@lyra-sync-app/transport";

function getWebStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return {
        getItem: (k: string) => window.localStorage.getItem(k),
        setItem: (k: string, v: string) => window.localStorage.setItem(k, v),
        removeItem: (k: string) => window.localStorage.removeItem(k),
      };
    }
  } catch {
    // ignore
  }
  return createMemoryStorage();
}

export const lyraStore = createLyraStore({
  transport: new NodeHttpTransport(),
  storage: getWebStorage(),
  seedDemo: false,
});

if (typeof window !== "undefined") {
  void lyraStore.hydrate();
}
