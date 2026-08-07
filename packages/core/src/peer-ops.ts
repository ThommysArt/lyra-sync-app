/**
 * Outbound peer operations used by the domain store (browser + Node).
 */
import {
  authenticateWithPeer,
  getOrCreatePeerSession,
  isLikelyTailscaleHost,
  listRemoteFs,
  openUrlOnPeer,
  pushClipboardToPeer,
  requestScreenShare,
  sendFilesOverWire,
  sendPairRequest,
  sendScreenFrame,
  stopScreenShare,
  type PeerUrl,
  type WireTransferProgress,
} from "@lyra-sync-app/net";

export { isLikelyTailscaleHost };
import type {
  ClipboardItem,
  DeviceIdentity,
  FileEntry,
  PairedDevice,
  PairingPayload,
  ScreenShareAcceptPayload,
} from "@lyra-sync-app/protocol";
import { LYRA_DEFAULT_PORT } from "@lyra-sync-app/protocol";

/** Pick LAN vs Tailscale host based on preferredAddress / availability. */
export function resolveDeviceHost(
  device: Pick<PairedDevice, "host" | "tailscaleHost" | "preferredAddress">,
): string | null {
  const pref = device.preferredAddress ?? "auto";
  const lan = device.host?.trim() || null;
  const ts = device.tailscaleHost?.trim() || null;
  if (pref === "tailscale") return ts || lan;
  if (pref === "lan") return lan || ts;
  // auto: prefer Tailscale when both are set (LAN often goes stale off-network)
  if (lan && ts) {
    if (isLikelyTailscaleHost(lan) && !isLikelyTailscaleHost(ts)) return lan;
    return ts || lan;
  }
  return lan || ts;
}

export function deviceEndpoint(
  device: Pick<PairedDevice, "host" | "port" | "tailscaleHost" | "preferredAddress">,
): PeerUrl | null {
  const host = resolveDeviceHost(device);
  if (!host) return null;
  return {
    host,
    port: device.port ?? LYRA_DEFAULT_PORT,
    protocol: "http",
  };
}

export function isLivePeer(device: PairedDevice): boolean {
  return Boolean(resolveDeviceHost(device)) && !device.id.startsWith("demo_");
}

/**
 * Build candidate endpoints (preferred + alternate LAN/Tailscale host, port fallbacks).
 * Exported so discovery can re-probe the same matrix used for clipboard/transfers.
 */
export function deviceEndpointCandidates(
  device: Pick<
    PairedDevice,
    | "host"
    | "port"
    | "tailscaleHost"
    | "preferredAddress"
    | "lastReachableHost"
    | "lastReachablePort"
  >,
  opts?: { extraPorts?: number[] },
): PeerUrl[] {
  const port = device.port ?? LYRA_DEFAULT_PORT;
  const pref = device.preferredAddress ?? "auto";
  const hostField = device.host?.trim() || null;
  const tsField = device.tailscaleHost?.trim() || null;
  // Split: non-TS host field is LAN; Tailscale is explicit field or TS-shaped host
  const lanHost = hostField && !isLikelyTailscaleHost(hostField) ? hostField : null;
  const tsHost =
    tsField || (hostField && isLikelyTailscaleHost(hostField) ? hostField : null);

  const ordered: string[] = [];
  const push = (h: string | null | undefined) => {
    const v = h?.trim();
    if (v && !ordered.includes(v)) ordered.push(v);
  };
  // Always try last known-good host first
  push(device.lastReachableHost);
  if (pref === "tailscale") {
    push(tsHost);
    push(lanHost);
    push(hostField);
  } else if (pref === "lan") {
    push(lanHost);
    push(hostField);
    push(tsHost);
  } else if (tsHost) {
    // auto: Tailscale first when present (LAN IPs go stale off-network)
    push(tsHost);
    push(lanHost);
    push(hostField);
  } else {
    push(lanHost);
    push(hostField);
  }

  // Keep the matrix small but cover variants + multi-instance offsets
  // (desktop often binds 53319/53321 when 53317 is taken by LocalSend etc.)
  const lastPort = device.lastReachablePort;
  const ports = [
    ...new Set(
      [
        lastPort,
        port,
        LYRA_DEFAULT_PORT,
        port + 2,
        port + 4,
        LYRA_DEFAULT_PORT + 2,
        LYRA_DEFAULT_PORT + 4,
        53327,
        53337,
        ...(opts?.extraPorts ?? []),
      ].filter((p) => typeof p === "number" && p > 0 && p <= 65535),
    ),
  ].slice(0, 6);
  const out: PeerUrl[] = [];
  // Prefer sticky host:port combo first
  if (device.lastReachableHost && device.lastReachablePort) {
    out.push({
      host: device.lastReachableHost,
      port: device.lastReachablePort,
      protocol: "http",
    });
  }
  for (const host of ordered) {
    for (const p of ports) {
      if (
        out.some((e) => e.host === host && e.port === p)
      ) {
        continue;
      }
      out.push({ host, port: p, protocol: "http" });
    }
  }
  return out;
}

/** Merge a reachable endpoint back onto a device record (LAN vs Tailscale). */
export function applyReachableEndpoint(
  device: PairedDevice,
  endpoint: PeerUrl,
): PairedDevice {
  const host = endpoint.host.trim();
  const port = endpoint.port ?? device.port ?? LYRA_DEFAULT_PORT;
  if (!host) return device;
  const isTs = isLikelyTailscaleHost(host);
  const sticky = {
    lastReachableHost: host,
    lastReachablePort: port,
    online: true as const,
    lastSeenAt: Date.now(),
    port,
  };
  if (isTs) {
    return {
      ...device,
      ...sticky,
      tailscaleHost: host,
      // Keep a distinct LAN host when we already have one
      host:
        device.host && !isLikelyTailscaleHost(device.host) ? device.host : device.host || host,
      connectionType:
        device.host && !isLikelyTailscaleHost(device.host)
          ? "both"
          : device.connectionType === "local"
            ? "both"
            : "tailscale",
      preferredAddress:
        device.preferredAddress === "lan" ? "lan" : device.preferredAddress ?? "auto",
    };
  }
  return {
    ...device,
    ...sticky,
    host,
    connectionType:
      device.tailscaleHost || device.connectionType === "tailscale"
        ? "both"
        : device.connectionType === "manual"
          ? "manual"
          : "local",
  };
}

export async function ensureSession(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
}): Promise<{ ok: true; sessionToken: string; endpoint: PeerUrl } | { ok: false; error: string }> {
  const candidates = deviceEndpointCandidates(input.device);
  if (candidates.length === 0) return { ok: false, error: "Peer has no host" };

  // Probe-first: only run auth against endpoints that answer GET /lyra/info.
  // Avoids burning timeouts on dead Tailscale/LAN addresses and surfaces
  // real auth errors instead of "Failed to fetch".
  const { probePeer } = await import("@lyra-sync-app/net");
  const reachable: PeerUrl[] = [];
  const seen = new Set<string>();
  for (const endpoint of candidates) {
    const key = `${endpoint.host}:${endpoint.port ?? LYRA_DEFAULT_PORT}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const probe = await probePeer(
      { host: endpoint.host, port: endpoint.port, protocol: "http" },
      {
        timeoutMs: 1200,
        preferTailscale: isLikelyTailscaleHost(endpoint.host),
      },
    );
    if (probe.ok) {
      reachable.push({
        host: probe.host,
        port: probe.port,
        protocol: "http",
      });
      // Two live endpoints is enough — auth the best one first
      if (reachable.length >= 2) break;
    }
  }

  const tryList = reachable.length > 0 ? reachable : candidates.slice(0, 4);
  let lastError = reachable.length === 0 ? "Peer unreachable (probe failed)" : "Auth failed";
  for (const endpoint of tryList) {
    const session = await getOrCreatePeerSession({
      endpoint,
      identity: input.identity,
      privateKey: input.privateKey,
      sharedSecret: input.device.authSecret,
      peerDeviceId: input.device.id,
    });
    if (session.ok) {
      return { ok: true, sessionToken: session.sessionToken, endpoint };
    }
    lastError = session.error;
  }
  return { ok: false, error: lastError };
}

export async function wirePushClipboard(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  item: ClipboardItem;
}): Promise<
  { ok: true; endpoint: PeerUrl } | { ok: false; error: string; endpoint?: PeerUrl }
> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  const pushed = await pushClipboardToPeer({
    endpoint: session.endpoint,
    sessionToken: session.sessionToken,
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    item: {
      id: input.item.id,
      type: input.item.type,
      text: input.item.text,
      imageData: input.item.imageData,
      sourceDeviceId: input.item.sourceDeviceId,
      sourceDeviceName: input.item.sourceDeviceName,
      createdAt: input.item.createdAt,
    },
    sealSecret: input.device.authSecret,
  });
  if (!pushed.ok) return { ok: false, error: pushed.error, endpoint: session.endpoint };
  return { ok: true, endpoint: session.endpoint };
}

export async function wireOpenUrl(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  url: string;
}): Promise<{ ok: true; opened?: boolean } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  return openUrlOnPeer({
    endpoint: session.endpoint,
    sessionToken: session.sessionToken,
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    url: input.url,
    sealSecret: input.device.authSecret,
  });
}

export async function wireListRemoteFiles(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  path: string;
  requestId: string;
}): Promise<{ ok: true; entries: FileEntry[] } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  const res = await listRemoteFs({
    endpoint: session.endpoint,
    sessionToken: session.sessionToken,
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    path: input.path,
    requestId: input.requestId,
    sealSecret: input.device.authSecret,
  });
  if (!res.ok) return res;
  if (res.error) return { ok: false, error: res.error };
  return { ok: true, entries: res.entries };
}

export async function wireSendFiles(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  transferId: string;
  files: { name: string; size: number; mimeType?: string; checksum?: string; bytes?: Uint8Array; uri?: string; file?: unknown }[];
  resumeOffset?: number;
  onProgress?: (p: WireTransferProgress) => void;
  signal?: AbortSignal;
  readFileSlice?: (fileIndex: number, offset: number, length: number) => Promise<Uint8Array>;
}): Promise<
  | { ok: true; checksums: string[]; endpoint: PeerUrl }
  | { ok: false; error: string; endpoint?: PeerUrl }
> {
  const session = await ensureSession(input);
  if (!session.ok) return session;

  // Build streaming reader if not provided but file/uri present
  let readSlice = input.readFileSlice;
  if (!readSlice) {
    const needsStreaming = input.files.some((f) => !f.bytes && (f.uri || f.file));
    if (needsStreaming) {
      readSlice = async (idx, offset, len) => {
        const f = input.files[idx]!;
        if (f.bytes) return f.bytes.subarray(offset, offset + len);
        if (f.file) {
          const fileObj = f.file as unknown as { slice: (s: number, e: number) => Blob & { arrayBuffer(): Promise<ArrayBuffer> } };
          const slice = fileObj.slice(offset, offset + len);
          const buf = await slice.arrayBuffer();
          return new Uint8Array(buf);
        }
        if (f.uri) {
          try {
            // Try modern File API first (efficient slice, works for file:// cache URIs)
            try {
              const loadFS = new Function('return import("expo-file-system")') as () => Promise<unknown>;
              const mod = (await loadFS()) as unknown as { File?: new (uri: string) => { slice?: (s: number, e: number) => { arrayBuffer?: () => Promise<ArrayBuffer> } } };
              const FileCls = mod.File;
              if (FileCls) {
                const fileObj = new FileCls(f.uri!);
                const sliced = (fileObj as unknown as { slice?: (s: number, e: number) => unknown }).slice?.(offset, offset + len) as { arrayBuffer?: () => Promise<ArrayBuffer> } | undefined;
                if (sliced?.arrayBuffer) {
                  const ab = await sliced.arrayBuffer();
                  if (ab.byteLength > 0) return new Uint8Array(ab);
                }
              }
            } catch {}
            // Fallback: legacy readAsStringAsync with position/length (supports file:// and content://)
            try {
              const loadLegacy = new Function('return import("expo-file-system/legacy")') as () => Promise<unknown>;
              const FS = (await loadLegacy()) as unknown as { readAsStringAsync: (uri: string, opts: unknown) => Promise<string>; EncodingType: { Base64: string } };
              const { readAsStringAsync, EncodingType } = FS;
              const b64 = await (readAsStringAsync as unknown as (uri: string, opts: { encoding: string; position: number; length: number }) => Promise<string>)(f.uri!, { encoding: EncodingType.Base64, position: offset, length: len });
              const approx = Math.ceil(b64.length * 0.75);
              if (approx <= len + 16 && approx > 0) {
                const Buf = (globalThis as { Buffer?: { from: (s: string, e: string) => Uint8Array } }).Buffer;
                return Buf ? new Uint8Array(Buf.from(b64, "base64")) : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
              }
            } catch {}
            // Last resort: fetch whole file only for small files (<20MB) to avoid OOM
            if ((f.size ?? 0) < 20 * 1024 * 1024) {
              const res = await fetch(f.uri!);
              if (!res.ok) throw new Error(`fetch ${f.uri} failed ${res.status}`);
              const ab = await res.arrayBuffer();
              const full = new Uint8Array(ab);
              return full.subarray(offset, offset + len);
            }
            throw new Error(`Unable to read chunk at ${offset} len ${len} for ${f.name} (uri ${f.uri?.slice(0, 40)}). Ensure file is in cache (copyToCacheDirectory:true) and expo-file-system is linked.`);
          } catch (e) {
            throw e instanceof Error ? e : new Error(String(e));
          }
        }
        throw new Error(`No bytes or uri for ${f.name}`);
      };
    }
  }

  for (const f of input.files) {
    if (!f.bytes && !f.uri && !f.file && !readSlice) {
      return { ok: false, error: `Missing bytes for "${f.name}" — file picker failed to read. Please retry with system picker.` };
    }
    if (f.bytes && f.bytes.byteLength === 0 && f.size > 0) {
      return { ok: false, error: `Empty bytes for "${f.name}"` };
    }
    if (!f.bytes && f.size > 550 * 1024 * 1024) {
      return { ok: false, error: `File too large (>550MB) for streaming` };
    }
  }
  const prepared = input.files.map((f) => ({
    name: f.name,
    size: f.size || f.bytes?.byteLength || 0,
    mimeType: f.mimeType,
    checksum: f.checksum,
    bytes: f.bytes, // may be undefined when streaming
  }));

  const sent = await sendFilesOverWire({
    endpoint: session.endpoint,
    sessionToken: session.sessionToken,
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    transferId: input.transferId,
    files: prepared as unknown as { name: string; size: number; mimeType?: string; bytes: Uint8Array; checksum?: string }[],
    resumeOffset: input.resumeOffset,
    onProgress: input.onProgress,
    signal: input.signal,
    sealSecret: input.device.authSecret,
    readFileSlice: readSlice,
  });
  if (!sent.ok) return { ok: false, error: sent.error, endpoint: session.endpoint };
  return { ok: true, checksums: sent.checksums, endpoint: session.endpoint };
}

/** Notify a peer that we unpaired them (best-effort). */
export async function wireUnpairNotify(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!resolveDeviceHost(input.device) || !input.device.authSecret) {
    return { ok: false, error: "No live trusted peer" };
  }
  const session = await ensureSession(input);
  if (!session.ok) return session;
  const { createEnvelope, sendEnvelope } = await import("@lyra-sync-app/net");
  const envelope = createEnvelope({
    type: "pair_reject",
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    payload: {
      reason: "unpaired",
      deviceId: input.identity.id,
      fingerprint: input.identity.fingerprint,
    },
  });
  const res = await sendEnvelope(session.endpoint, envelope, {
    sessionToken: session.sessionToken,
    sealSecret: input.device.authSecret,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

export async function wireRequestScreenShare(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  sessionId: string;
  maxEdge?: number;
  fps?: number;
  quality?: number;
}): Promise<
  | { ok: true; accept: ScreenShareAcceptPayload }
  | { ok: false; error: string }
> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  return requestScreenShare({
    endpoint: session.endpoint,
    sessionToken: session.sessionToken,
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    sessionId: input.sessionId,
    maxEdge: input.maxEdge,
    fps: input.fps,
    quality: input.quality,
    sealSecret: input.device.authSecret,
  });
}

export async function wireStopScreenShare(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  sessionId: string;
  reason?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  return stopScreenShare({
    endpoint: session.endpoint,
    sessionToken: session.sessionToken,
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    sessionId: input.sessionId,
    reason: input.reason,
    sealSecret: input.device.authSecret,
  });
}

export async function wireSendScreenFrame(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  frame: {
    sessionId: string;
    seq: number;
    width: number;
    height: number;
    mimeType: "image/jpeg" | "image/webp" | "image/png";
    dataBase64: string;
    capturedAt: number;
  };
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  return sendScreenFrame({
    endpoint: session.endpoint,
    sessionToken: session.sessionToken,
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    frame: input.frame,
    sealSecret: input.device.authSecret,
  });
}

/** Download remote file in chunks (desktop peer with real FS). Pipelined. */
export async function wireReadRemoteFile(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  path: string;
  onChunk?: (chunk: Uint8Array, offset: number, eof: boolean) => void;
}): Promise<{ ok: true; bytes: Uint8Array; size: number } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  const { createEnvelope, sendEnvelope, base64ToBytes } = await import("@lyra-sync-app/net");
  const endpoint = session.endpoint as PeerUrl;
  const sessionToken = session.sessionToken as string;
  const PULL_CHUNK = 1024 * 1024;
  const PULL_WINDOW = 8;
  const requestIdBase = `fsr_${Date.now()}`;
  let size = 0;
  const firstEnv = createEnvelope({
    type: "fs_read",
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    payload: { path: input.path, requestId: `${requestIdBase}_0`, offset: 0, maxBytes: PULL_CHUNK },
  });
  const firstRes = await sendEnvelope(endpoint, firstEnv, { sessionToken, sealSecret: input.device.authSecret });
  if (!firstRes.ok) return { ok: false, error: firstRes.error };
  if (firstRes.envelope?.type !== "fs_read_response") return { ok: false, error: "Unexpected fs_read response" };
  const fp = firstRes.envelope.payload as { dataBase64?: string; eof?: boolean; size?: number; error?: string };
  if (fp.error) return { ok: false, error: fp.error };
  if (typeof fp.size === "number") size = fp.size;
  const firstBytes = fp.dataBase64 ? base64ToBytes(fp.dataBase64) : new Uint8Array(0);
  input.onChunk?.(firstBytes, 0, Boolean(fp.eof));
  if (fp.eof || firstBytes.byteLength === 0) return { ok: true, bytes: firstBytes, size: size || firstBytes.byteLength };
  if (!size || size <= firstBytes.byteLength) {
    const chunks: Uint8Array[] = [firstBytes];
    let offset = firstBytes.byteLength;
    for (let i = 1; i < 10_000; i++) {
      const env = createEnvelope({ type: "fs_read", fromDeviceId: input.identity.id, toDeviceId: input.device.id, payload: { path: input.path, requestId: `${requestIdBase}_${i}`, offset, maxBytes: PULL_CHUNK } });
      const res = await sendEnvelope(endpoint, env, { sessionToken, sealSecret: input.device.authSecret });
      if (!res.ok) return { ok: false, error: res.error };
      const p = res.envelope?.payload as { dataBase64?: string; eof?: boolean; size?: number; error?: string } | undefined;
      if (!p || p.error) return { ok: false, error: p?.error ?? "Unexpected fs_read response" };
      if (typeof p.size === "number") size = p.size;
      const b = p.dataBase64 ? base64ToBytes(p.dataBase64) : new Uint8Array(0);
      chunks.push(b);
      input.onChunk?.(b, offset, Boolean(p.eof));
      offset += b.byteLength;
      if (p.eof || b.byteLength === 0) break;
    }
    const total = chunks.reduce((a, c) => a + c.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) out.set(c, o), (o += c.byteLength);
    return { ok: true, bytes: out, size: size || total };
  }
  const totalChunks = Math.ceil(size / PULL_CHUNK);
  const result: Uint8Array[] = new Array(totalChunks);
  result[0] = firstBytes;
  let failed: string | null = null;
  const offsets: number[] = [];
  for (let idx = 1; idx < totalChunks; idx++) offsets.push(idx * PULL_CHUNK);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= offsets.length) return;
      const offset = offsets[idx]!;
      const chunkIdx = Math.floor(offset / PULL_CHUNK);
      const env = createEnvelope({ type: "fs_read", fromDeviceId: input.identity.id, toDeviceId: input.device.id, payload: { path: input.path, requestId: `${requestIdBase}_${chunkIdx}`, offset, maxBytes: PULL_CHUNK } });
      const res = await sendEnvelope(endpoint, env, { sessionToken, sealSecret: input.device.authSecret });
      if (!res.ok) { failed = res.error; return; }
      if (res.envelope?.type !== "fs_read_response") { failed = "Unexpected fs_read response"; return; }
      const p = res.envelope.payload as { dataBase64?: string; eof?: boolean; size?: number; error?: string };
      if (p.error) { failed = p.error; return; }
      const b = p.dataBase64 ? base64ToBytes(p.dataBase64) : new Uint8Array(0);
      result[chunkIdx] = b;
      input.onChunk?.(b, offset, Boolean(p.eof));
      if (failed) return;
    }
  }
  const workers = Array.from({ length: Math.min(PULL_WINDOW, offsets.length) }, () => worker());
  await Promise.all(workers);
  if (failed) return { ok: false, error: failed };
  for (let i = 0; i < result.length; i++) if (!result[i]) return { ok: false, error: "Missing chunk in pipelined pull" };
  const total = result.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of result) out.set(c!, o), (o += c.byteLength);
  return { ok: true, bytes: out, size: size || total };
}

/** Promote a manual/probed peer to dual-confirm pairing (trust). */
export async function wireTrustHandshake(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  pairingToken: string;
  /** Our advertised reachability so the host can call us back. */
  localHost?: string;
  localPort?: number;
}): Promise<
  | {
      ok: true;
      authSecret: string;
      remote: DeviceIdentity;
      host?: string;
      port?: number;
    }
  | { ok: false; error: string }
> {
  const { deriveMutualAuthSecret, fetchPeerInfo } = await import("@lyra-sync-app/net");
  // Try every LAN/Tailscale/port candidate — single stale host must not block Pair
  const candidates = deviceEndpointCandidates(input.device);
  if (candidates.length === 0) return { ok: false, error: "Peer has no host" };

  let liveHost = "";
  let livePort: number = LYRA_DEFAULT_PORT;
  let info: Awaited<ReturnType<typeof fetchPeerInfo>> | null = null;
  const probeErrors: string[] = [];
  for (const ep of candidates) {
    const h = ep.host.trim();
    const p = ep.port ?? LYRA_DEFAULT_PORT;
    console.info(`[lyra trust] probing ${h}:${p} before pair_request`);
    const r = await fetchPeerInfo({ host: h, port: p }, { timeoutMs: 4_000 });
    if (r.ok) {
      info = r;
      liveHost = h;
      livePort = p;
      console.info(`[lyra trust] probe ok · ${r.identity.name} @ ${h}:${p}`);
      break;
    }
    probeErrors.push(`${h}:${p} → ${r.error}`);
    console.warn(`[lyra trust] probe failed ${h}:${p}`, r.error);
  }
  if (!info || !info.ok) {
    return {
      ok: false,
      error: `Peer unreachable (tried ${candidates.length} endpoint(s)): ${probeErrors.slice(0, 3).join("; ")}`,
    };
  }
  const authSecret = await deriveMutualAuthSecret({
    pairingToken: input.pairingToken,
    localFingerprint: input.identity.fingerprint,
    remoteFingerprint: info.identity.fingerprint,
    localPublicKey: input.identity.publicKey,
    remotePublicKey: info.identity.publicKey,
  });
  // Dual-confirm: wait for host Accept (pair_confirm) before treating as trusted
  console.info(`[lyra trust] sending pair_request → ${liveHost}:${livePort} (wait for Accept)`);
  const wire = await wireSendPairRequest({
    host: liveHost,
    port: livePort,
    identity: input.identity,
    payload: {
      version: 1,
      deviceId: input.identity.id,
      name: input.identity.name,
      type: input.identity.type,
      platform: input.identity.platform,
      fingerprint: input.identity.fingerprint,
      publicKey: input.identity.publicKey,
      token: input.pairingToken,
      host: input.localHost,
      port: input.localPort,
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
    waitForConfirmMs: 120_000,
  });
  if (!wire.ok) return { ok: false, error: wire.error };
  const env = wire.envelope;
  if (!env || env.type === "pair_reject") {
    const reason =
      env && env.type === "pair_reject"
        ? String((env.payload as { reason?: string })?.reason ?? "rejected")
        : "Pairing declined or timed out";
    return { ok: false, error: reason };
  }
  if (env.type !== "pair_confirm") {
    return { ok: false, error: `Unexpected pairing reply: ${env.type}` };
  }
  const confirm = env.payload as {
    identity?: DeviceIdentity;
    host?: string;
    port?: number;
    publicKey?: string;
  };
  const remote = confirm.identity ?? info.identity;
  return {
    ok: true,
    authSecret,
    remote: {
      ...remote,
      publicKey: confirm.publicKey || remote.publicKey,
    },
    host: confirm.host || liveHost,
    port: confirm.port ?? livePort,
  };
}

/**
 * Verify that a paired peer still recognizes our shared secret.
 * Used after unpair on the other side (startup + discovery refresh).
 */
export async function wireVerifyPairTrust(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
}): Promise<
  | { ok: true; stillTrusted: true }
  | { ok: true; stillTrusted: false; reason: string }
  | { ok: false; error: string; unreachable?: boolean }
> {
  if (!input.device.authSecret) {
    return { ok: false, error: "No live trusted peer", unreachable: true };
  }
  const { authenticateWithPeer, clearPeerSessionFor, probePeer } = await import(
    "@lyra-sync-app/net"
  );
  // Try every LAN/Tailscale candidate — a single stale host must not unpair us.
  const candidates = deviceEndpointCandidates(input.device);
  if (candidates.length === 0) {
    return { ok: false, error: "No live trusted peer", unreachable: true };
  }

  let sawReachable = false;
  let lastAuthError = "Trust rejected";
  for (const endpoint of candidates) {
    const probe = await probePeer(
      { host: endpoint.host, port: endpoint.port, protocol: "http" },
      { timeoutMs: 1200, preferTailscale: isLikelyTailscaleHost(endpoint.host) },
    );
    if (!probe.ok) continue;
    sawReachable = true;
    const live: PeerUrl = { host: probe.host, port: probe.port, protocol: "http" };
    clearPeerSessionFor(live, input.device.id);
    let auth = await authenticateWithPeer({
      endpoint: live,
      identity: input.identity,
      privateKey: input.privateKey,
      sharedSecret: input.device.authSecret,
    });
    // Retry once on 401 shortly after pairing — desktop's trustedPeers may still be syncing (IPC race)
    if (
      !auth.ok &&
      /Invalid proof|401/i.test(auth.error) &&
      // Only retry if we haven't yet tried the next candidate; this handles the sync race without masking real revokes
      !/Fingerprint|Device id/.test(auth.error)
    ) {
      await new Promise((r) => setTimeout(r, 700));
      clearPeerSessionFor(live, input.device.id);
      const retry = await authenticateWithPeer({
        endpoint: live,
        identity: input.identity,
        privateKey: input.privateKey,
        sharedSecret: input.device.authSecret,
      });
      if (retry.ok) auth = retry;
      else lastAuthError = retry.error || lastAuthError;
    }
    if (auth.ok) {
      if (
        auth.peerDeviceId &&
        auth.peerDeviceId !== input.device.id &&
        auth.peerFingerprint &&
        auth.peerFingerprint !== input.device.fingerprint
      ) {
        return {
          ok: true,
          stillTrusted: false,
          reason: "Peer identity changed",
        };
      }
      return { ok: true, stillTrusted: true };
    }
    lastAuthError = auth.error || lastAuthError;
    // Network-ish auth failures on a reachable host: try next candidate, don't unpair yet
    if (
      /Failed to fetch|Network request failed|timed out|Timeout|ECONNREFUSED|unreachable|Aborted/i.test(
        auth.error,
      )
    ) {
      continue;
    }
    // Explicit crypto/auth rejection — peer is online but does not trust us
    if (
      /Invalid proof|Fingerprint|Device id|Unauthorized|pairing|Unknown peer|401/i.test(
        auth.error,
      )
    ) {
      return {
        ok: true,
        stillTrusted: false,
        reason: auth.error || "Trust rejected",
      };
    }
  }

  if (!sawReachable) {
    return { ok: false, error: "Peer unreachable", unreachable: true };
  }
  // Reachable but could not complete auth on any path — keep pair (transient)
  return { ok: false, error: lastAuthError, unreachable: true };
}

export async function wireSendPairRequest(input: {
  host: string;
  port?: number;
  identity: DeviceIdentity;
  payload: PairingPayload;
  code?: string;
  /** Wait for host Accept (long-poll). Default 120s when omitted from sendPairRequest. */
  waitForConfirmMs?: number;
}): Promise<
  | { ok: true; envelope?: import("@lyra-sync-app/protocol").Envelope }
  | { ok: false; error: string }
> {
  const res = await sendPairRequest({
    endpoint: { host: input.host, port: input.port ?? LYRA_DEFAULT_PORT },
    fromIdentity: input.identity,
    token: input.payload.token,
    code: input.code,
    host: input.payload.host,
    port: input.payload.port,
    waitForConfirmMs: input.waitForConfirmMs,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, envelope: res.envelope };
}

export async function wirePauseTransfer(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  transferId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  const { createEnvelope, sendEnvelope } = await import("@lyra-sync-app/net");
  const envelope = createEnvelope({
    type: "transfer_pause",
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    payload: { transferId: input.transferId },
  });
  const res = await sendEnvelope(session.endpoint, envelope, {
    sessionToken: session.sessionToken,
    sealSecret: input.device.authSecret,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

export async function wireResumeTransfer(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  transferId: string;
  offset?: number;
}): Promise<{ ok: true; resumeOffset?: number } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  const { createEnvelope, sendEnvelope } = await import("@lyra-sync-app/net");
  const envelope = createEnvelope({
    type: "transfer_resume",
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    payload: { transferId: input.transferId, offset: input.offset ?? 0 },
  });
  const res = await sendEnvelope(session.endpoint, envelope, {
    sessionToken: session.sessionToken,
    sealSecret: input.device.authSecret,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const off = (res.envelope?.payload as { resumeOffset?: number } | undefined)?.resumeOffset;
  return { ok: true, resumeOffset: off };
}

export async function wireCancelTransfer(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  transferId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  const { createEnvelope, sendEnvelope } = await import("@lyra-sync-app/net");
  const envelope = createEnvelope({
    type: "transfer_cancel",
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    payload: { transferId: input.transferId },
  });
  const res = await sendEnvelope(session.endpoint, envelope, {
    sessionToken: session.sessionToken,
    sealSecret: input.device.authSecret,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

export async function probeAuth(input: {
  host: string;
  port?: number;
  identity: DeviceIdentity;
  privateKey: string;
  sharedSecret?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return authenticateWithPeer({
    endpoint: { host: input.host, port: input.port ?? LYRA_DEFAULT_PORT },
    identity: input.identity,
    privateKey: input.privateKey,
    sharedSecret: input.sharedSecret,
  });
}
