import type { DeviceIdentity, LyraEnvelope, LyraSeal } from "@lyra-sync-app/protocol";

export type { DeviceIdentity, LyraEnvelope, LyraSeal };
export type { FileEntry, TransferFile, Transfer } from "@lyra-sync-app/protocol";

export type TrustedPeer = {
  deviceId: string;
  fingerprint: string;
  publicKey?: string;
  authSecret: string;
};

export type PairingOffer = {
  codeHash: string;
  token: string;
  expiresAt: number;
};

export type DaemonConfig = {
  identity: DeviceIdentity;
  port: number;
  tls?: boolean;
  downloadDir?: string;
  trustedPeers?: TrustedPeer[];
  onEnvelope?: (envelope: LyraEnvelope) => void;
  onLog?: (msg: string) => void;
  resolvePeerAuth?: (deviceId: string, fingerprint?: string) => string | null | Promise<string | null>;
  getPairingOffer?: () => PairingOffer | null;
};
