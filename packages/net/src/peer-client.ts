import {
  AuthChallengePayloadSchema,
  AuthOkPayloadSchema,
  DiscoverAnnouncePayloadSchema,
  HelloPayloadSchema,
  LYRA_DEFAULT_PORT,
  LYRA_PROTOCOL_VERSION,
  type DeviceIdentity,
  type DeviceStatus,
  type Envelope,
} from "@lyra-sync-app/protocol";

import {
  createAuthResponseWithSharedSecret,
  createFirstContactAuthResponse,
} from "./auth";
import { createEnvelope, parseEnvelope } from "./envelope";

export type PeerUrl = {
  host: string;
  port?: number;
  protocol?: "http" | "https";
};

export function peerBaseUrl(endpoint: PeerUrl): string {
  const protocol = endpoint.protocol ?? "http";
  const port = endpoint.port ?? LYRA_DEFAULT_PORT;
  const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[")
    ? `[${endpoint.host}]`
    : endpoint.host;
  return `${protocol}://${host}:${port}`;
}

async function postJson<T = unknown>(
  url: string,
  body: unknown,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...init?.headers,
      },
      body: JSON.stringify(body),
      signal: init?.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err =
        data && typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : `HTTP ${res.status}`;
      return { ok: false, error: err, status: res.status };
    }
    return { ok: true, data: data as T, status: res.status };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      status: 0,
    };
  }
}

async function getJson<T = unknown>(
  url: string,
  init?: { signal?: AbortSignal },
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: init?.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    }
    return { ok: true, data: data as T, status: res.status };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      status: 0,
    };
  }
}

/** GET /lyra/info — unauthenticated peer hello. */
export async function fetchPeerInfo(
  endpoint: PeerUrl,
  opts?: { signal?: AbortSignal },
): Promise<
  | {
      ok: true;
      identity: DeviceIdentity;
      status?: DeviceStatus;
      host?: string;
      port?: number;
      protocolVersion: number;
    }
  | { ok: false; error: string }
> {
  const base = peerBaseUrl(endpoint);
  const res = await getJson<{
    identity?: DeviceIdentity;
    status?: DeviceStatus;
    host?: string;
    port?: number;
    protocolVersion?: number;
  }>(`${base}/lyra/info`, opts);
  if (!res.ok) return { ok: false, error: res.error };
  if (!res.data?.identity) return { ok: false, error: "Missing identity" };
  return {
    ok: true,
    identity: res.data.identity,
    status: res.data.status,
    host: res.data.host,
    port: res.data.port,
    protocolVersion: res.data.protocolVersion ?? LYRA_PROTOCOL_VERSION,
  };
}

/** POST /lyra/message — send a protocol envelope. */
export async function sendEnvelope(
  endpoint: PeerUrl,
  envelope: Envelope,
  opts?: { sessionToken?: string; signal?: AbortSignal },
): Promise<{ ok: true; envelope?: Envelope } | { ok: false; error: string }> {
  const base = peerBaseUrl(endpoint);
  const res = await postJson(`${base}/lyra/message`, envelope, {
    headers: opts?.sessionToken ? { authorization: `Bearer ${opts.sessionToken}` } : undefined,
    signal: opts?.signal,
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.data && typeof res.data === "object" && res.data !== null && "type" in res.data) {
    const parsed = parseEnvelope(res.data);
    if (parsed.ok) return { ok: true, envelope: parsed.envelope };
  }
  return { ok: true };
}

/** Full auth handshake against a peer server. */
export async function authenticateWithPeer(input: {
  endpoint: PeerUrl;
  identity: DeviceIdentity;
  privateKey: string;
  sharedSecret?: string;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; sessionToken: string; peerFingerprint: string; peerDeviceId: string }
  | { ok: false; error: string }
> {
  const base = peerBaseUrl(input.endpoint);
  const challengeRes = await postJson(`${base}/lyra/auth/challenge`, {
    deviceId: input.identity.id,
    fingerprint: input.identity.fingerprint,
  }, { signal: input.signal });
  if (!challengeRes.ok) return { ok: false, error: challengeRes.error };

  const challengeParsed = AuthChallengePayloadSchema.safeParse(challengeRes.data);
  if (!challengeParsed.success) return { ok: false, error: "Invalid challenge" };

  const response = input.sharedSecret
    ? await createAuthResponseWithSharedSecret({
        challenge: challengeParsed.data,
        identity: input.identity,
        sharedSecret: input.sharedSecret,
      })
    : await createFirstContactAuthResponse({
        challenge: challengeParsed.data,
        identity: input.identity,
      });

  const authRes = await postJson(`${base}/lyra/auth/response`, response, {
    signal: input.signal,
  });
  if (!authRes.ok) return { ok: false, error: authRes.error };

  const okParsed = AuthOkPayloadSchema.safeParse(authRes.data);
  if (!okParsed.success) return { ok: false, error: "Invalid auth ok" };

  return {
    ok: true,
    sessionToken: okParsed.data.sessionToken,
    peerFingerprint: challengeParsed.data.serverFingerprint,
    peerDeviceId: okParsed.data.deviceId,
  };
}

/** Build a hello envelope for local announce. */
export function buildHelloEnvelope(
  identity: DeviceIdentity,
  opts?: { status?: DeviceStatus; host?: string; port?: number; toDeviceId?: string },
): Envelope {
  return createEnvelope({
    type: "hello",
    fromDeviceId: identity.id,
    toDeviceId: opts?.toDeviceId,
    payload: HelloPayloadSchema.parse({
      identity,
      status: opts?.status,
      host: opts?.host,
      port: opts?.port,
    }),
  });
}

export function buildDiscoverAnnounce(
  identity: DeviceIdentity,
  host: string,
  port: number = LYRA_DEFAULT_PORT,
) {
  return DiscoverAnnouncePayloadSchema.parse({
    identity: {
      id: identity.id,
      name: identity.name,
      type: identity.type,
      platform: identity.platform,
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey,
    },
    host,
    port,
    protocolVersion: LYRA_PROTOCOL_VERSION,
  });
}
