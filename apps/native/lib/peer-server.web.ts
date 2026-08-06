/**
 * Web stub — Expo web cannot bind a TCP peer server.
 */
import type { LyraStore } from "@lyra-sync-app/core";
import type { DeviceIdentity } from "@lyra-sync-app/protocol";

export type NativePeerHandle = {
  port: number;
  url: string;
  lanHost: string | null;
  core: unknown;
  stop: () => Promise<void>;
  setIdentity: (identity: DeviceIdentity) => void;
  setPairingOffer: (
    offer: { code: string; token: string; expiresAt: number } | null,
  ) => Promise<void>;
  resolvePairRequest: (
    key: { deviceId?: string; token?: string },
    decision: { accepted: true; host?: string; port?: number } | { accepted: false; reason?: string },
  ) => boolean;
  refreshLanHost: () => Promise<string | null>;
};

export function isExpoGoRuntime(): boolean {
  return false;
}

export async function startNativePeerServer(_options: {
  identity: DeviceIdentity;
  port?: number;
  advertiseHost?: string | null;
}): Promise<NativePeerHandle | null> {
  return null;
}

export function attachNativePeerToStore(
  _store: LyraStore,
  _peer: NativePeerHandle,
): () => void {
  return () => undefined;
}
