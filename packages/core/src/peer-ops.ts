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
  // Always include loopback for same-host testing (2 Electron instances on one laptop)
  // — ensures 127.0.0.1:53317/53319/53321 candidates are probed even when device.host is LAN.
  push("127.0.0.1");
  push("localhost");

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
        53319,
        53321,
        53329,
        53337,
        53339,
        ...(opts?.extraPorts ?? []),
      ].filter((p) => typeof p === "number" && p > 0 && p <= 65535),
    ),
  ].slice(0, 8);
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

  const { probePeer } = await import("@lyra-sync-app/net");
  const seen = new Set<string>();
  const deduped: PeerUrl[] = [];
  for (const ep of candidates) {
    const key = `${ep.host}:${ep.port ?? LYRA_DEFAULT_PORT}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ep);
  }

  // Fast path: try lastReachableHost first with 400ms timeout — avoids 1.5s delay for repeated sends
  if (input.device.lastReachableHost && input.device.lastReachablePort) {
    for (const proto of ["http", "https"] as const) {
      try {
        const fast = await probePeer(
          { host: input.device.lastReachableHost, port: input.device.lastReachablePort, protocol: proto },
          { timeoutMs: 400, preferTailscale: isLikelyTailscaleHost(input.device.lastReachableHost), lane: 1 },
        );
        if (fast.ok) {
          const fastEndpoint: PeerUrl = { host: fast.host, port: fast.port, protocol: proto };
          const sess = await getOrCreatePeerSession({
            endpoint: fastEndpoint,
            identity: input.identity,
            privateKey: input.privateKey,
            sharedSecret: input.device.authSecret,
            peerDeviceId: input.device.id,
          });
          if (sess.ok) {
            console.info(`[lyra ensureSession] fast-path hit ${fast.host}:${fast.port} (${proto}) in <400ms for ${input.device.id.slice(0,8)}`);
            return { ok: true, sessionToken: sess.sessionToken, endpoint: fastEndpoint };
          }
        }
      } catch {}
    }
  }

  // Parallel probe — was sequential and took 2.5s × N (up to 20s). Now race 8 at a time.
  const probeConcurrency = 8;
  const reachable: PeerUrl[] = [];
  let probeIdx = 0;
  const probeErrors: string[] = [];
  async function probeWorker() {
    while (true) {
      const i = probeIdx++;
      if (i >= deduped.length) return;
      if (reachable.length >= 2) return;
      const endpoint = deduped[i]!;
      // Try http first, then https fallback for TLS peers
      const tryProbe = async (proto: "http" | "https") => {
        try {
          const probe = await probePeer(
            { host: endpoint.host, port: endpoint.port, protocol: proto },
            {
              timeoutMs: 1500,
              preferTailscale: isLikelyTailscaleHost(endpoint.host),
              lane: 1,
            },
          );
          if (probe.ok) {
            reachable.push({
              host: probe.host,
              port: probe.port,
              protocol: proto,
            });
            return true;
          }
          if (proto === "http" && /wrong version|EPROTO|certificate|self signed|SSL/i.test(probe.error)) {
            return false;
          }
          probeErrors.push(`${endpoint.host}:${endpoint.port ?? LYRA_DEFAULT_PORT} → ${probe.error}`);
          return true; // don't retry https if http error was not TLS-related
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (proto === "http" && /wrong version|EPROTO|certificate|self signed|SSL/i.test(msg)) return false;
          probeErrors.push(`${endpoint.host}:${endpoint.port ?? LYRA_DEFAULT_PORT} → ${msg}`);
          return true;
        }
      };
      const httpDone = await tryProbe("http");
      if (!httpDone) {
        await tryProbe("https");
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(probeConcurrency, deduped.length) }, () => probeWorker()));

  if (reachable.length > 0) {
    console.info(`[lyra ensureSession] probe found ${reachable.length} reachable endpoint(s) out of ${deduped.length} candidates for ${input.device.id.slice(0, 8)}:`, reachable.map((r) => `${r.host}:${r.port}`).join(", "));
  } else {
    console.warn(`[lyra ensureSession] no reachable probe for ${input.device.id.slice(0, 8)} — tried ${deduped.length} candidates: ${probeErrors.slice(0, 3).join("; ")} — will try direct auth anyway`);
  }

  let lastError = reachable.length === 0 ? `Peer unreachable (tried ${deduped.length} endpoint(s): ${probeErrors.slice(0, 3).join("; ")})` : "Auth failed";
  const orderedTry = reachable.length > 0 ? [...reachable, ...deduped.filter((c) => !reachable.some((r) => r.host === c.host && r.port === c.port))] : deduped;

  // Try auth in order, but with shorter timeouts and clearer errors
  for (const endpoint of orderedTry.slice(0, 8)) {
    const started = Date.now();
    const session = await getOrCreatePeerSession({
      endpoint,
      identity: input.identity,
      privateKey: input.privateKey,
      sharedSecret: input.device.authSecret,
      peerDeviceId: input.device.id,
    });
    if (session.ok) {
      const ms = Date.now() - started;
      console.info(`[lyra ensureSession] auth ok ${endpoint.host}:${endpoint.port} in ${ms}ms for ${input.device.id.slice(0, 8)}`);
      return { ok: true, sessionToken: session.sessionToken, endpoint };
    }
    lastError = session.error;
    console.warn(`[lyra ensureSession] auth failed ${endpoint.host}:${endpoint.port} (${session.error}) for ${input.device.id.slice(0, 8)}`);
    if (/timed out|Timeout|Aborted/i.test(session.error)) continue;
  }
  const attempted = orderedTry.slice(0, 8).map((e) => `${e.host}:${e.port}`).join(", ");
  return { ok: false, error: `${lastError} — tried endpoints: ${attempted}` };
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
          // Persistent cache for normalized URIs per file index (avoid copying 20MB file per chunk)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const normCache = (readSlice as unknown as { _normCache?: Map<number, string> })._normCache ?? new Map<number, string>();
          (readSlice as unknown as { _normCache?: Map<number, string> })._normCache = normCache;
          // Verify file still exists (catches cache eviction) — fast path via modern File API (dynamic import to avoid bundling in desktop)
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const loadFSProbe = new Function('return import("expo-file-system")') as () => Promise<any>;
            const FSNext = await loadFSProbe() as unknown as { File?: new (uri: string) => { exists: boolean; info: () => { exists: boolean; size?: number } | null; size?: number } };
            if (FSNext.File) {
              try {
                const probeU = normCache.get(idx) ?? f.uri!;
                const probe = new FSNext.File(probeU);
                // Prefer info() if available
                const info = (probe as unknown as { info?: () => { exists: boolean; size?: number } }).info?.() ?? null;
                if (info && !info.exists) throw new Error(`File not found at ${probeU.slice(0, 60)} (evicted from cache). Re-pick file.`);
                // Also check size for EOF
                const sz = (info?.size ?? (probe as unknown as { size?: number }).size) as number | undefined;
                if (typeof sz === "number" && offset >= sz) return new Uint8Array(0);
              } catch {}
            }
          } catch {}
          let lastErr: unknown = null;
          // For DocumentPicker files, ensure we have a stable copy in cache that File API can read reliably.
          // Some Android content:// or file:// URIs from DocumentPicker are not directly accessible via File.slice on all OS versions.
          // We try to normalize the uri by copying to a temp File if needed (once per file).
          let normalizedUri = normCache.get(idx) ?? f.uri!;
          let didNormalize = normCache.has(idx);
          const tryNormalizeUri = async (): Promise<string> => {
            if (didNormalize) return normalizedUri;
            didNormalize = true;
            try {
              const modN = await (new Function('return import("expo-file-system")') as () => Promise<any>)();
              const FileClsN = modN.File;
              const PathsN = modN.Paths;
              if (FileClsN && PathsN?.cache) {
                const src = new FileClsN(f.uri!);
                if (!src.exists) {
                  console.warn(`[lyra transfer] normalize: src not exists ${f.uri?.slice(0,60)}`);
                  return normalizedUri;
                }
                // If file is already in cache and readable via File.info, keep original
                try {
                  const info = src.info();
                  if (info.exists && info.size === f.size) return normalizedUri;
                } catch {}
                // Copy to a temp file with proper name in cache for reliable reading
                try {
                  const safeName = f.name.replace(/[^\w.\-]/g, "_") || `tmp_${Date.now()}`;
                  const dest = new FileClsN(PathsN.cache, `lyra-send-${Date.now()}-${safeName}`);
                  // Ensure parent exists
                  try { dest.create({ overwrite: true }); } catch {}
                  await src.copy(dest);
                  if (dest.exists) {
                    console.info(`[lyra transfer] normalized ${f.name} ${f.uri?.slice(0,50)} -> ${dest.uri.slice(0,50)}`);
                    normalizedUri = dest.uri;
                    normCache.set(idx, normalizedUri);
                    // Update original file entry so future chunks use normalized path directly
                    f.uri = normalizedUri;
                    return normalizedUri;
                  }
                } catch (e) {
                  console.warn(`[lyra transfer] normalize copy failed ${f.name}`, e instanceof Error ? e.message : String(e));
                }
              }
            } catch {}
            return normalizedUri;
          };
          for (let attempt = 0; attempt < 3; attempt++) {
            const uriToUse = attempt === 0 ? normalizedUri : await tryNormalizeUri();
            // 1) Modern File API — open/readBytes streaming (best for large files, no OOM)
            try {
              const loadFS = new Function('return import("expo-file-system")') as () => Promise<any>;
              const mod = await loadFS() as unknown as {
                File?: new (uri: string) => {
                  slice: (start: number, end: number) => { arrayBuffer: () => Promise<ArrayBuffer> };
                  open?: (mode?: string) => { readBytes: (len: number) => Uint8Array; close: () => void; offset?: number | null };
                  exists: boolean;
                  info: () => { exists: boolean; size?: number };
                  bytes: () => Promise<Uint8Array>;
                };
                FileMode?: { ReadOnly: string };
              };
              const FileCls = mod.File;
              if (FileCls) {
                const fileObj = new FileCls(uriToUse);
                if (!fileObj.exists) {
                  lastErr = new Error(`File not found at ${uriToUse.slice(0, 60)} (not in cache). Re-pick with copyToCacheDirectory:true.`);
                  console.warn(`[lyra transfer] File not exists ${f.name} uri=${uriToUse.slice(0,80)} attempt ${attempt+1}`);
                } else {
                  // Try open/readBytes first (true streaming, works for 300MB without OOM)
                  try {
                    const handle = (fileObj as unknown as { open?: (mode?: unknown) => { readBytes: (len: number) => Uint8Array; close: () => void; offset?: number | null } }).open?.(mod.FileMode?.ReadOnly ?? "r");
                    if (handle) {
                      try {
                        if (typeof handle.offset === "number") handle.offset = offset;
                        const bytes = handle.readBytes(len);
                        if (bytes.byteLength > 0) {
                          if (uriToUse !== f.uri) {
                            f.uri = uriToUse;
                            normCache.set(idx, uriToUse);
                          }
                          return bytes;
                        }
                        if (bytes.byteLength === 0 && len > 0) lastErr = new Error("readBytes returned 0 bytes");
                      } finally {
                        try { handle.close(); } catch {}
                      }
                    }
                  } catch (e) {
                    lastErr = e;
                    console.warn(`[lyra transfer] File.open/readBytes failed ${f.name} @${offset}:${len} attempt ${attempt + 1} uri=${uriToUse.slice(0,40)}`, e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack?.slice(0,200) : "");
                  }
                  // Try slice (Blob) as second
                  try {
                    const sliced = fileObj.slice(offset, offset + len) as unknown as { arrayBuffer: () => Promise<ArrayBuffer> };
                    if (sliced?.arrayBuffer) {
                      const ab = await sliced.arrayBuffer();
                      if (ab.byteLength > 0) {
                        if (uriToUse !== f.uri) {
                          f.uri = uriToUse;
                          normCache.set(idx, uriToUse);
                        }
                        return new Uint8Array(ab);
                      }
                      if (ab.byteLength === 0 && len > 0) lastErr = new Error("slice returned 0 bytes");
                    }
                  } catch (e) {
                    lastErr = e;
                    console.warn(`[lyra transfer] File.slice failed ${f.name} @${offset}:${len} attempt ${attempt + 1} uri=${uriToUse.slice(0,40)}`, e instanceof Error ? e.message : String(e));
                  }
                  // Try bytes() ONLY for small files <5MB (otherwise OOM when loading whole 20MB+ file per chunk)
                  if ((f.size ?? 0) < 5 * 1024 * 1024) {
                    try {
                      const all = await fileObj.bytes() as Uint8Array;
                      if (all.byteLength > offset) {
                        if (uriToUse !== f.uri) {
                          f.uri = uriToUse;
                          normCache.set(idx, uriToUse);
                        }
                        return all.subarray(offset, Math.min(all.byteLength, offset + len));
                      }
                    } catch (e) {
                      lastErr = e;
                      console.warn(`[lyra transfer] File.bytes fallback failed ${f.name} @${offset}:${len} attempt ${attempt+1}`, e instanceof Error ? e.message : String(e));
                    }
                  } else if (attempt === 0) {
                    lastErr = new Error("File.bytes skipped for large file (>5MB) — will try normalize copy instead of loading whole file");
                    console.warn(`[lyra transfer] skip File.bytes for large file ${f.name} size=${f.size} attempt ${attempt+1} — trying normalize`);
                  }
                }
              }
            } catch (e) {
              lastErr = e;
              console.warn(`[lyra transfer] File API overall failed ${f.name} attempt ${attempt+1}`, e instanceof Error ? e.message : String(e));
            }
            // 2) Fallback: fetch (works for file:// on Android via React Native fetch) — ONLY for small files <5MB to avoid OOM
            if ((f.size ?? 0) < 5 * 1024 * 1024) {
              try {
                const res = await fetch(uriToUse);
                if (res.ok) {
                  const ab = await res.arrayBuffer();
                  const full = new Uint8Array(ab);
                  if (full.byteLength >= offset + len || full.byteLength > 0) {
                    if (uriToUse !== f.uri) f.uri = uriToUse;
                    console.info(`[lyra transfer] fetch fallback succeeded ${f.name} @${offset}:${len} attempt ${attempt+1} bytes=${full.byteLength}`);
                    return full.subarray(offset, Math.min(full.byteLength, offset + len));
                  }
                } else {
                  lastErr = new Error(`fetch ${uriToUse.slice(0,60)} failed ${res.status}`);
                }
              } catch (e) {
                lastErr = e;
                console.warn(`[lyra transfer] fetch fallback failed ${f.name} @${offset}:${len} attempt ${attempt+1} uri=${uriToUse.slice(0,40)}`, e instanceof Error ? e.message : String(e));
              }
            } else if (attempt === 0) {
              console.warn(`[lyra transfer] skip fetch fallback for large file ${f.name} size=${f.size} — will try normalize`);
            }
            // 3) Last resort: legacy readAsStringAsync without position (read whole file as base64) — ONLY for <5MB
            if ((f.size ?? 0) < 5 * 1024 * 1024) {
              try {
                const loadLegacy = new Function('return import("expo-file-system/legacy")') as () => Promise<any>;
                const FS = await loadLegacy() as { readAsStringAsync: (uri: string, opts: unknown) => Promise<string>; EncodingType: { Base64: string }; getInfoAsync: (uri: string) => Promise<{ exists: boolean; size?: number }> };
                const info = await FS.getInfoAsync(uriToUse).catch(() => ({ exists: false }));
                if (!info.exists) {
                  lastErr = new Error(`legacy getInfo not exists ${uriToUse.slice(0,50)}`);
                } else {
                  const b64 = await FS.readAsStringAsync(uriToUse, { encoding: FS.EncodingType.Base64 });
                  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                  if (bin.byteLength > offset) {
                    if (uriToUse !== f.uri) f.uri = uriToUse;
                    console.info(`[lyra transfer] legacy whole-file fallback succeeded ${f.name} bytes=${bin.byteLength}`);
                    return bin.subarray(offset, Math.min(bin.byteLength, offset + len));
                  }
                }
              } catch (e) {
                lastErr = e;
                console.warn(`[lyra transfer] legacy fallback failed ${f.name} attempt ${attempt+1}`, e instanceof Error ? e.message : String(e));
              }
            } else if (attempt === 0) {
              console.warn(`[lyra transfer] skip legacy fallback for large file ${f.name} — will try normalize copy`);
            }
            if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          }
          console.error(`[lyra transfer] Unable to read chunk at ${offset} len ${len} for ${f.name} (uri ${f.uri?.slice(0, 60)}) after 3 attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, {
            transferId: input.transferId,
            file: f.name,
            uri: f.uri?.slice(0, 80),
            size: f.size,
            error: lastErr instanceof Error ? lastErr.message : String(lastErr),
          });
          throw new Error(`Unable to read chunk at ${offset} len ${len} for ${f.name} after 3 attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}. Try re-picking file with copyToCacheDirectory:true and ensure file is not evicted.`);
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
    // Unlimited size via streaming — no 550MB cap. Only guard is available disk.
  }
  const prepared = input.files.map((f) => ({
    name: f.name,
    size: f.size || f.bytes?.byteLength || 0,
    mimeType: f.mimeType,
    checksum: f.checksum,
    bytes: f.bytes, // may be undefined when streaming
  }));

  // Try primary endpoint, then fallback to alternative candidates on network/404 errors
  const trySend = async (ep: typeof session.endpoint, token: string) => {
    return sendFilesOverWire({
      endpoint: ep,
      sessionToken: token,
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
  };

  let sent = await trySend(session.endpoint, session.sessionToken);
  if (!sent.ok && /not found|unknown transfer|failed to fetch|network request failed|timed out|timeout|econnrefused|fetch failed/i.test((sent as { error: string }).error)) {
    // Retry with fresh ensureSession to get alternative host:port (e.g., Tailscale vs LAN)
    console.warn(`[lyra transfer] primary endpoint ${session.endpoint.host}:${session.endpoint.port} failed (${(sent as { error: string }).error}) — trying alternative candidates`);
    const altSession = await ensureSession(input);
    if (altSession.ok && (altSession.endpoint.host !== session.endpoint.host || altSession.endpoint.port !== session.endpoint.port)) {
      const retry = await trySend(altSession.endpoint, altSession.sessionToken);
      if (retry.ok) {
        console.info(`[lyra transfer] retry via ${altSession.endpoint.host}:${altSession.endpoint.port} succeeded`);
        return { ok: true, checksums: retry.checksums, endpoint: altSession.endpoint };
      }
      console.warn(`[lyra transfer] retry also failed: ${(retry as { error: string }).error}`);
      const origErr = (sent as { error: string }).error;
      const retryErr = (retry as { error: string }).error;
      return { ok: false, error: `${origErr} (retry via ${altSession.endpoint.host}:${altSession.endpoint.port} also failed: ${retryErr})`, endpoint: session.endpoint };
    }
  }
  if (!sent.ok) return { ok: false, error: (sent as { error: string }).error, endpoint: session.endpoint };
  return { ok: true, checksums: (sent as { ok: true; checksums: string[] }).checksums, endpoint: session.endpoint };
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
