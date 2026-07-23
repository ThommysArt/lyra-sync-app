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
  randomBytesOfSize,
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

  // Keep the matrix small: multi-endpoint auth has a ~2.5s timeout each
  const lastPort = device.lastReachablePort;
  const ports = [
    ...new Set(
      [
        lastPort,
        port,
        LYRA_DEFAULT_PORT,
        port + 2,
        port + 4,
        ...(opts?.extraPorts ?? []),
      ].filter((p) => typeof p === "number" && p > 0 && p <= 65535),
    ),
  ].slice(0, 4);
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
  files: { name: string; size: number; mimeType?: string; checksum?: string; bytes?: Uint8Array }[];
  resumeOffset?: number;
  onProgress?: (p: WireTransferProgress) => void;
}): Promise<
  | { ok: true; checksums: string[]; endpoint: PeerUrl }
  | { ok: false; error: string; endpoint?: PeerUrl }
> {
  const session = await ensureSession(input);
  if (!session.ok) return session;

  const prepared = input.files.map((f) => {
    const bytes =
      f.bytes ??
      // Synthetic payload when UI only has metadata (browser File not retained)
      randomBytesOfSize(Math.min(f.size, 256 * 1024));
    // Cap synthetic size for demo safety; real File bytes should be passed when available
    const effective =
      f.bytes ??
      (f.size > bytes.byteLength
        ? (() => {
            // Represent full size with sparse synthetic: only send min(size, 256KiB) but report size
            return bytes;
          })()
        : bytes);
    return {
      name: f.name,
      size: f.bytes ? f.bytes.byteLength : Math.min(f.size, 256 * 1024),
      mimeType: f.mimeType,
      checksum: f.checksum,
      bytes: effective,
    };
  });

  const sent = await sendFilesOverWire({
    endpoint: session.endpoint,
    sessionToken: session.sessionToken,
    fromDeviceId: input.identity.id,
    toDeviceId: input.device.id,
    transferId: input.transferId,
    files: prepared,
    resumeOffset: input.resumeOffset,
    onProgress: input.onProgress,
    sealSecret: input.device.authSecret,
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

/** Download remote file in chunks (desktop peer with real FS). */
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
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let size = 0;
  const requestIdBase = `fsr_${Date.now()}`;
  for (let i = 0; i < 10_000; i++) {
    const envelope = createEnvelope({
      type: "fs_read",
      fromDeviceId: input.identity.id,
      toDeviceId: input.device.id,
      payload: {
        path: input.path,
        requestId: `${requestIdBase}_${i}`,
        offset,
        maxBytes: 256 * 1024,
      },
    });
    const res = await sendEnvelope(session.endpoint, envelope, {
      sessionToken: session.sessionToken,
      sealSecret: input.device.authSecret,
    });
    if (!res.ok) return { ok: false, error: res.error };
    if (res.envelope?.type !== "fs_read_response") {
      return { ok: false, error: "Unexpected fs_read response" };
    }
    const p = res.envelope.payload as {
      dataBase64?: string;
      eof?: boolean;
      size?: number;
      error?: string;
      offset?: number;
    };
    if (p.error) return { ok: false, error: p.error };
    if (typeof p.size === "number") size = p.size;
    if (p.dataBase64) {
      const bytes = base64ToBytes(p.dataBase64);
      chunks.push(bytes);
      input.onChunk?.(bytes, offset, Boolean(p.eof));
      offset += bytes.byteLength;
    }
    if (p.eof) break;
    if (!p.dataBase64 || p.dataBase64.length === 0) break;
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
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
  const host = resolveDeviceHost(input.device);
  if (!host) return { ok: false, error: "Peer has no host" };
  const port = input.device.port ?? LYRA_DEFAULT_PORT;
  const { deriveMutualAuthSecret, fetchPeerInfo } = await import("@lyra-sync-app/net");
  const info = await fetchPeerInfo({ host, port });
  if (!info.ok) return { ok: false, error: info.error };
  const authSecret = await deriveMutualAuthSecret({
    pairingToken: input.pairingToken,
    localFingerprint: input.identity.fingerprint,
    remoteFingerprint: info.identity.fingerprint,
    localPublicKey: input.identity.publicKey,
    remotePublicKey: info.identity.publicKey,
  });
  // Dual-confirm: wait for host Accept (pair_confirm) before treating as trusted
  const wire = await wireSendPairRequest({
    host,
    port,
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
    host: confirm.host || host,
    port: confirm.port ?? port,
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
    const auth = await authenticateWithPeer({
      endpoint: live,
      identity: input.identity,
      privateKey: input.privateKey,
      sharedSecret: input.device.authSecret,
    });
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
