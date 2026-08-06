import type { LyraEnvelope, PeerEndpoint } from "@lyra-sync-app/protocol";
import type { ProbeResult } from "./types.js";

export const LYRA_DEFAULT_TIMEOUT = 2500 as const;

export interface PeerTransport {
  info(
    endpoint: PeerEndpoint,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ProbeResult>;
  send(
    endpoint: PeerEndpoint,
    envelope: LyraEnvelope,
    opts?: { signal?: AbortSignal; timeoutMs?: number; sessionToken?: string },
  ): Promise<{ ok: true; envelope?: LyraEnvelope } | { ok: false; error: string }>;
}
