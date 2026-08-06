export type DiscoveredPeer = {
  identity: {
    id: string;
    name: string;
    type?: string;
    platform?: string;
    fingerprint: string;
    publicKey?: string;
  };
  host: string;
  port: number;
  pairing?: {
    codeHash: string;
    token: string;
    expiresAt: number;
  };
};
