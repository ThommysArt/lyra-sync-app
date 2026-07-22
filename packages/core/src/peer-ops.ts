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
  // auto: prefer Tailscale when the only host is TS-shaped, else LAN first
  if (lan && ts) {
    if (isLikelyTailscaleHost(lan) && !isLikelyTailscaleHost(ts)) return lan;
    return lan;
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

export async function ensureSession(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
}): Promise<{ ok: true; sessionToken: string; endpoint: PeerUrl } | { ok: false; error: string }> {
  const endpoint = deviceEndpoint(input.device);
  if (!endpoint) return { ok: false, error: "Peer has no host" };
  const session = await getOrCreatePeerSession({
    endpoint,
    identity: input.identity,
    privateKey: input.privateKey,
    sharedSecret: input.device.authSecret,
    peerDeviceId: input.device.id,
  });
  if (!session.ok) return session;
  return { ok: true, sessionToken: session.sessionToken, endpoint };
}

export async function wirePushClipboard(input: {
  device: PairedDevice;
  identity: DeviceIdentity;
  privateKey: string;
  item: ClipboardItem;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await ensureSession(input);
  if (!session.ok) return session;
  return pushClipboardToPeer({
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
}): Promise<{ ok: true; checksums: string[] } | { ok: false; error: string }> {
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

  return sendFilesOverWire({
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
}): Promise<{ ok: true; authSecret: string } | { ok: false; error: string }> {
  if (!input.device.host) return { ok: false, error: "Peer has no host" };
  const { deriveMutualAuthSecret, fetchPeerInfo } = await import("@lyra-sync-app/net");
  const info = await fetchPeerInfo({
    host: input.device.host,
    port: input.device.port,
  });
  if (!info.ok) return { ok: false, error: info.error };
  const authSecret = await deriveMutualAuthSecret({
    pairingToken: input.pairingToken,
    localFingerprint: input.identity.fingerprint,
    remoteFingerprint: info.identity.fingerprint,
    localPublicKey: input.identity.publicKey,
    remotePublicKey: info.identity.publicKey,
  });
  // Send pair_request so remote can dual-confirm
  await wireSendPairRequest({
    host: input.device.host,
    port: input.device.port,
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
      host: undefined,
      port: undefined,
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
  });
  return { ok: true, authSecret };
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
