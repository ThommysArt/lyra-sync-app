import type { PeerEndpoint } from "@lyra-sync-app/protocol";

export type { PeerEndpoint };

export type ProbeResult = {
  ok: boolean;
  host: string;
  port: number;
  online: boolean;
  name?: string;
  fingerprint?: string;
  platform?: string;
  connectionHint?: string;
  error?: string;
  latencyMs?: number;
};

export interface HttpTransport {
  getInfo(endpoint: PeerEndpoint): Promise<ProbeResult>;
}
