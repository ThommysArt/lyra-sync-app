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
  createAuthResponse,
  createAuthResponseWithSharedSecret,
  createFirstContactAuthResponse,
  isEcdsaPrivateKey,
} from "./auth";
import { createEnvelope, parseEnvelope } from "./envelope";
import { isSealedString, openSealedJson, sealJson } from "./seal";

/** Marker object for AES-GCM sealed payloads (post-pairing encryption default). */
export const SEALED_PAYLOAD_KEY = "__lyra_sealed";

export function isSealedPayload(payload: unknown): payload is { [SEALED_PAYLOAD_KEY]: string } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    SEALED_PAYLOAD_KEY in payload &&
    typeof (payload as Record<string, unknown>)[SEALED_PAYLOAD_KEY] === "string"
  );
}

export async function sealEnvelopePayload(
  sharedSecret: string,
  payload: unknown,
): Promise<{ [typeof SEALED_PAYLOAD_KEY]: string }> {
  const sealed = await sealJson(sharedSecret, payload);
  return { [SEALED_PAYLOAD_KEY]: sealed };
}

export async function openEnvelopePayload(
  sharedSecret: string,
  payload: unknown,
): Promise<unknown> {
  if (isSealedPayload(payload)) {
    return openSealedJson(sharedSecret, payload[SEALED_PAYLOAD_KEY]);
  }
  if (isSealedString(payload)) {
    return openSealedJson(sharedSecret, payload);
  }
  return payload;
}

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

export type PeerPairingOffer = {
  codeHash: string;
  token: string;
  expiresAt: number;
};

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
      pairing?: PeerPairingOffer;
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
    pairing?: PeerPairingOffer;
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
    pairing: res.data.pairing,
  };
}

/** POST /lyra/message — send a protocol envelope. Seals payload when sealSecret is set. */
export async function sendEnvelope(
  endpoint: PeerUrl,
  envelope: Envelope,
  opts?: {
    sessionToken?: string;
    signal?: AbortSignal;
    /** When set, encrypt payload with AES-GCM (post-pairing default). */
    sealSecret?: string;
  },
): Promise<{ ok: true; envelope?: Envelope } | { ok: false; error: string }> {
  const base = peerBaseUrl(endpoint);
  let outbound: Envelope = envelope;
  if (opts?.sealSecret && envelope.payload !== undefined) {
    try {
      const sealed = await sealEnvelopePayload(opts.sealSecret, envelope.payload);
      outbound = { ...envelope, payload: sealed };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Failed to seal payload",
      };
    }
  }
  const res = await postJson(`${base}/lyra/message`, outbound, {
    headers: opts?.sessionToken ? { authorization: `Bearer ${opts.sessionToken}` } : undefined,
    signal: opts?.signal,
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.data && typeof res.data === "object" && res.data !== null && "type" in res.data) {
    const parsed = parseEnvelope(res.data);
    if (!parsed.ok) return { ok: true };
    let env = parsed.envelope;
    // Open sealed replies when we have the secret
    if (opts?.sealSecret && isSealedPayload(env.payload)) {
      try {
        const opened = await openEnvelopePayload(opts.sealSecret, env.payload);
        env = { ...env, payload: opened };
      } catch {
        // leave sealed if open fails
      }
    }
    return { ok: true, envelope: env };
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
    : isEcdsaPrivateKey(input.privateKey)
      ? await createAuthResponse({
          challenge: challengeParsed.data,
          identity: input.identity,
          privateKey: input.privateKey,
        })
      : await createFirstContactAuthResponse({
          challenge: challengeParsed.data,
          identity: input.identity,
          privateKey: input.privateKey,
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

/** Push clipboard item to a peer (requires session). */
export async function pushClipboardToPeer(input: {
  endpoint: PeerUrl;
  sessionToken: string;
  fromDeviceId: string;
  toDeviceId: string;
  item: {
    id: string;
    type: "text" | "image";
    text?: string;
    imageData?: string;
    sourceDeviceId: string;
    sourceDeviceName: string;
    createdAt: number;
  };
  signal?: AbortSignal;
  /** Pairing secret — seals clipboard payload when set (encryption default). */
  sealSecret?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const envelope = createEnvelope({
    type: "clipboard_push",
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    payload: input.item,
  });
  const res = await sendEnvelope(input.endpoint, envelope, {
    sessionToken: input.sessionToken,
    signal: input.signal,
    sealSecret: input.sealSecret,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/** Ask peer to open a URL. */
export async function openUrlOnPeer(input: {
  endpoint: PeerUrl;
  sessionToken: string;
  fromDeviceId: string;
  toDeviceId: string;
  url: string;
  title?: string;
  signal?: AbortSignal;
  sealSecret?: string;
}): Promise<{ ok: true; opened?: boolean } | { ok: false; error: string }> {
  const envelope = createEnvelope({
    type: "open_url",
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    payload: { url: input.url, title: input.title },
  });
  const res = await sendEnvelope(input.endpoint, envelope, {
    sessionToken: input.sessionToken,
    signal: input.signal,
    sealSecret: input.sealSecret,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const payload = res.envelope?.payload as { opened?: boolean } | undefined;
  return { ok: true, opened: payload?.opened };
}

/** List remote filesystem via peer. */
export async function listRemoteFs(input: {
  endpoint: PeerUrl;
  sessionToken: string;
  fromDeviceId: string;
  toDeviceId: string;
  path: string;
  requestId: string;
  signal?: AbortSignal;
  sealSecret?: string;
}): Promise<
  | { ok: true; path: string; entries: import("@lyra-sync-app/protocol").FileEntry[]; error?: string }
  | { ok: false; error: string }
> {
  const envelope = createEnvelope({
    type: "fs_list",
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    payload: { path: input.path, requestId: input.requestId },
  });
  const res = await sendEnvelope(input.endpoint, envelope, {
    sessionToken: input.sessionToken,
    signal: input.signal,
    sealSecret: input.sealSecret,
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.envelope?.type === "fs_list_response") {
    const p = res.envelope.payload as {
      path: string;
      entries: import("@lyra-sync-app/protocol").FileEntry[];
      error?: string;
    };
    return { ok: true, path: p.path, entries: p.entries ?? [], error: p.error };
  }
  return { ok: false, error: "No fs_list_response" };
}

/** Send pair_request to a reachable host (after local dual-confirm). */
export async function sendPairRequest(input: {
  endpoint: PeerUrl;
  fromIdentity: DeviceIdentity;
  token: string;
  code?: string;
  host?: string;
  port?: number;
  sessionToken?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; envelope?: Envelope } | { ok: false; error: string }> {
  const envelope = createEnvelope({
    type: "pair_request",
    fromDeviceId: input.fromIdentity.id,
    payload: {
      version: 1 as const,
      deviceId: input.fromIdentity.id,
      name: input.fromIdentity.name,
      type: input.fromIdentity.type,
      platform: input.fromIdentity.platform,
      fingerprint: input.fromIdentity.fingerprint,
      publicKey: input.fromIdentity.publicKey,
      token: input.token,
      host: input.host,
      port: input.port,
      expiresAt: Date.now() + 5 * 60 * 1000,
      code: input.code,
    },
  });
  return sendEnvelope(input.endpoint, envelope, {
    sessionToken: input.sessionToken,
    signal: input.signal,
  });
}

/** Cache of session tokens per peer endpoint key. */
const sessionCache = new Map<string, { token: string; expiresAt: number }>();

export function peerSessionCacheKey(endpoint: PeerUrl, deviceId: string): string {
  return `${peerBaseUrl(endpoint)}::${deviceId}`;
}

export async function getOrCreatePeerSession(input: {
  endpoint: PeerUrl;
  identity: DeviceIdentity;
  privateKey: string;
  sharedSecret?: string;
  peerDeviceId?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; sessionToken: string } | { ok: false; error: string }> {
  const key = peerSessionCacheKey(input.endpoint, input.peerDeviceId ?? "unknown");
  const cached = sessionCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return { ok: true, sessionToken: cached.token };
  }
  const auth = await authenticateWithPeer({
    endpoint: input.endpoint,
    identity: input.identity,
    privateKey: input.privateKey,
    sharedSecret: input.sharedSecret,
    signal: input.signal,
  });
  if (!auth.ok) return auth;
  sessionCache.set(key, {
    token: auth.sessionToken,
    expiresAt: Date.now() + 50 * 60_000,
  });
  return { ok: true, sessionToken: auth.sessionToken };
}

export function clearPeerSessionCache(): void {
  sessionCache.clear();
}
