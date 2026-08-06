import { createLyraStore } from "@lyra-sync-app/core";
import { NativeTcpTransport } from "@lyra-sync-app/transport";
import { createSecureStorage } from "./secure-store";

export const nativeLyraStore = createLyraStore({
  transport: new NativeTcpTransport(),
  storage: createSecureStorage(),
  seedDemo: false,
});

// hydrate lazily — don't block import
void nativeLyraStore.hydrate();
