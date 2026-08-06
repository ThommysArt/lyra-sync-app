# Lyra v2 — Architecture Plan

**Branch:** `feat/lyra-v2` off `df07d3d` (initial scaffold)  
**Status:** Draft — replaces all v1 code (store, net, protocol, desktop)  
**Priorities:** File sharing (large, resumable, >2 GB) + Clipboard sync. Tailscale required. Screen mirror dropped/deprecated for v2.  
**Stacks:** Electron (desktop), Expo prebuild (mobile, dev builds only), Vite+TanStack Router (web embedded in Electron), pnpm+Turbo.

---

## 0. Why v1 failed (evidence)

| Failure | Where | Impact |
|---|---|---|
| God Store | `packages/core/src/store.ts:109` 3000 LOC, pairing+discovery+transfers+clipboard+mirror | Untestable, circular `core↔net` (`313678c`) |
| Transport split-brain | `packages/net/src/peer-client.ts:623` chunked long-poll + `globalThis` tcp-socket singleton + timeout vs slot-queue bug `AGENT-PROGRESS.md:42` + cleartext only on debug manifest `AGENT-PROGRESS.md:138` | Mobile cannot reach desktop, pair times out at 15s |
| Server-everywhere | `apps/desktop/electron/main.ts:404` 1600 LOC main process owns peer server+discovery+scrcpy+mirror+downloads | Mobile fakes server via `react-native-tcp-socket`, fails on Expo Go/background |
| Brute-force discovery | `store.ts:2137` expands `192.168.x.0/24 × 4 ports × 1.8s` → ~25s scan, battery killer, still misses variant ports `53319/53321` | Refresh finds 0 peers |
| 3-phase pairing | multicast offer → seed probe → full /24 scan + 120s chunked long-poll | Fragile, needs manual IP fallback |
| In-memory transfers | `state.chunks` Buffer.concat whole file `main.ts:568` | OOM on >2 GB |
| Demo pollution | `seedDemo` persisted to `localStorage` | Empty-state testing broken |

**Lessons from OSS:** LocalSend (single UDP multicast `239.255.255.250:53317` + single HTTP `53317`), Sefirah (Windows server + Android foreground `ClipboardService`, WebSocket status), Blip (WebRTC offer in QR). v2 copies patterns, not code.

---

## 1. Principles

1. **Desktop = Server, Mobile = Client** — desktop daemon is canonical peer server + discovery + FS + clipboard monitor. Mobile is HTTP client; optional lightweight server only in `APP_VARIANT=development` debug.
2. **Protocol is transport-agnostic** — Zod schemas only in `packages/protocol`. IO lives in `packages/transport` + `packages/daemon`.
3. **No God object** — slices/machines: `identity`, `pairing`, `discovery`, `transfer`, `clipboard`. Side-effects via ports, not store.
4. **Streaming > buffering** — files streamed to `os.tmpdir()`/`expo-file-system` cache, chunked, checksummed, resumable.
5. **Multicast first, scan last** — no /24 walk unless user explicitly taps Scan LAN.
6. **Sealed by default when paired** — AES-GCM `seal.ts` on `/lyra/message` when `authSecret` exists; `authSecret` in `safeStorage`/`SecureStore`, never `localStorage` bulk.
7. **Honest degradation** — if Expo Go cannot host server, UI says so; don't fake.

---

## 2. Monorepo layout (target)

```
apps/
  desktop/         Electron shell — thin, delegates to daemon
  mobile/          Expo ~57, prebuild android, HeroUI
  web/             Vite — embedded in Electron (resources/web-dist), standalone only for pair preview
packages/
  protocol/        Zod schemas — DeviceIdentity, PairedDevice, Envelope, messages — NO logic
  transport/       PeerTransport interface + NodeHttpTransport + NativeTcpTransport (single tcp-socket impl)
  discovery/       Node-only: UDP multicast + mDNS + Tailscale status parser
  core/            Pure slices/machines + crypto helpers (hashPairingCode, deriveMutualAuthSecret)
  daemon/          Node daemon: peer HTTP server, FS, clipboard poll, discovery bridge
  hooks/           Shared React hooks (useLyra) wrapping core slices
  ui/              shadcn/ui primitives
  config/ env/     Existing
```

Root: `pnpm-workspace.yaml` adds `packages/daemon`, `turbo.json` adds `daemon#build` dependency.

---

## 3. Protocol v2 (packages/protocol)

**Version:** `lyra/2` envelope `type, fromDeviceId, toDeviceId, id, createdAt, payload` + optional `seal: { v:1, nonce, ciphertext }` when `authSecret` present. Keep `version:1` PairingPayload wire-compatible for migration.

**Schemas kept:** `DeviceIdentity`, `PairedDevice` (authSecret optional, stored separately), `ClipboardItem`, `Transfer`, `FileEntry`, `PairingPayload`, `AppSettings` (+ `downloadDirectory`, `peerListenPort` default `53317`).

**New/changed:**
- `/lyra/info` GET unauth: `{ id,name,type,platform,fingerprint,publicKey,port, pairingOffer?: { codeHash,token,expiresAt } }`
- `/lyra/pair` POST `{ payload: PairingPayload, code }` → long-poll 60s single request, server holds `pendingPairs Map<token, {resolve,expiresAt}>`, resolves on `lyra:resolve-pair-request` IPC. Response `pair_confirm { identity, token, host, port }` or `pair_reject`.
- `/lyra/message` POST sealed envelope — types: `clipboard_push`, `transfer_offer|chunk|pause|resume|complete`, `fs_list|fs_read`, `open_url`, `status`, `unpair`.
- `/lyra/file/chunk` POST binary stream alternative for >64 KiB chunks (avoid base64 bloat).

**Crypto:** Day 1 `deriveMutualAuthSecret(token, fpA, fpB)` → `authSecret` hex; seal = AES-GCM with `authSecret`. Day 2 add ECDSA P-256 sign/verify (keep shared-secret fast path).

---

## 4. Transport (packages/transport)

```ts
interface PeerTransport {
  info(endpoint: PeerEndpoint): Promise<ProbeResult>
  send(endpoint: PeerEndpoint, env: Envelope, opts?: { signal?, timeoutMs?, sessionToken? }): Promise<{ ok:true, envelope?:Envelope }|{ ok:false, error:string }>
}
class NodeHttpTransport implements PeerTransport // fetch/undici
class NativeTcpTransport implements PeerTransport // react-native-tcp-socket single impl, timeout after slot acquired
```

- No `globalThis` singleton; transport injected via `createLyraCore({ transport })`.
- `lastReachableHost/Port` sticky cache inside transport, not store.
- Cleartext allowed via `network_security_config.xml` only on `apps/mobile/android/app/src/main/AndroidManifest.xml` main (not debug-only).

---

## 5. Discovery (packages/discovery)

- **Node (daemon):** `startDiscovery({ identity, peerPort, advertiseHost, getPairingOffer, onPeer })` → UDP multicast `239.255.255.250:53317` + `bonjour-service` `_lyra._tcp`. Announce burst on `pairingOffer` set/clear + every 30s + on `Refresh`.
- **Mobile/Web:** does NOT scan /24 by default. `refreshDiscovery()` asks daemon via `GET /lyra/peers` (daemon already has multicast peers) OR probes `host` from QR/code + known `devices[*].host/tailscaleHost`. Explicit `Scan LAN` button does bounded single /24 walk (wifi IP from `expo-network`, max 1 subnet, `concurrency 8`, `timeout 1200ms`).
- **Tailscale:** daemon runs `tailscale status --json` (timeout 2500ms), maps to `tailscalePeersToProbeTargets(peers, peerPort)` and exposes via `lyra:tailscale-peers` IPC + `tailscale_peers_response` envelope for mobile relay. Mobile never shells `tailscale`.

---

## 6. Pairing

- **QR:** `lyra://pair?v=2&id=&fp=&pk=&tok=&host=&port=&tsHost=` or JSON. Contains only identity+token+best host; mobile POSTs to whichever host answers. Server long-polls 60s; host Accept resolves to `pair_confirm`.
- **Code:** 6-char, `hashPairingCode(code)` advertised on `/info` + multicast `pairingOffer`. Lookup order: (1) multicast offer cache, (2) manual `host:port` if user typed, (3) known peers, (4) single /24 walk only if wifi hint exists. No 4-subnet fantasy expansion.
- **Dual-confirm:** joiner waits for `pair_confirm`; host Accept creates `PairedDevice { authSecret: deriveMutualAuthSecret(...) }` on both sides, syncs to daemon `trustedPeers Map` via `lyra:sync-trusted-peers`.
- **Storage:** `authSecret` in `Electron safeStorage` (`userData/lyra-secrets.json` encrypted) + `expo-secure-store` on mobile; `STORAGE_KEY` bulk omits `privateKey` (isolated `.key` slot).

---

## 7. File transfer — must handle >2 GB

**Desktop daemon (`packages/daemon/src/fs.ts` + `transfer.ts`):**
- Offer: `{ transferId, files:[{name,size,checksum,relativePath}], totalBytes }`
- Accept → server creates `TransferState { transferId, files, expectedBytes, receivedBytes, tmpPath, fd }` streaming to `mkdtemp(os.tmpdir()/lyra-*)` via `fs.createWriteStream`. Chunks appended, not held in RAM. `transfer_chunk { offset, dataBase64 }` or binary `POST /lyra/file/chunk`.
- Pause: server rejects chunks with `paused:true`, client stops. Resume: client sends `transfer_resume { offset }`, server seeks `fd` offset.
- Complete: `sha256(tmpPath)` vs per-file checksum, compare, then atomically `rename(tmpPath, downloadDir/safeName)` with dedup `(1)` suffix `main.ts:556` pattern. Report `savedPaths` via `lyra:transfer-complete`.
- Integrity: `verifyTransferIntegrity` setting gates checksum verify; fail → `status=failed, error=checksum mismatch`.

**Mobile:**
- Pick via `expo-document-picker` / `expo-file-system` `FileSystem.getInfoAsync` + `readAsStringAsync` chunked base64. Folders via `expo-document-picker` directory request or multi-file `relativePath` preservation.
- Large send: read file in 1 MiB slices, POST each chunk, track `resumeOffset`.

**UI:** `Transfer` slice holds `transferredBytes/totalBytes/currentSpeedBps/etaSeconds/status`, but bytes live on daemon. `overWire:true` only when daemon confirms.

---

## 8. Clipboard sync

- **Desktop poll:** `setInterval 800ms` only when `autoMonitorClipboard:true` + window focused OR daemon clipboard watcher (`clipboard.readText` diff). Push via `wirePushClipboard` sealed to each `online && autoAcceptClipboard` peer. Receive writes `clipboard.writeText` + `receiveClipboardItem`.
- **Android:** `expo-clipboard` + optional `AccessibilityService` (`apps/mobile/plugins/with-android-accessibility.js`) for foreground poll; background via `expo-task-manager`/`WorkManager` 15min if enabled. Manual `Read system` button always available. Write via `Clipboard.setStringAsync`.
- **iOS:** receive-only; UI badge “iOS cannot monitor automatically — use Send Clipboard”.
- **History:** `clipboardHistoryLimit` + `clipboardRetentionDays` slice, `deliveryStatus` per target, retry on `failed`.

---

## 9. Remote browse

- Daemon `listOsFiles(path)` maps `/`, `~/Documents`, `~/Downloads`, `~/Desktop`, `~/Pictures` → real `fs.readdir` with `stat`. Mobile `fetchRemoteFiles(deviceId, path)` → `fs_list` envelope; fallback to demo when offline.
- `fs_read` streams file chunk via `readOsFileChunk(path, offset, maxBytes)` (64 KiB default) for preview/download.
- No in-app mount; upload via transfer into remote path.

---

## 10. App shells

**Desktop (`apps/desktop` Electron):**
- `electron/main.ts` split → `src/daemon/*` + `src/shell/window.ts`. Main only: `app.whenReady` → `ensureIdentity()` → `startPeerServer` (port candidates `53317,53319,53321,53327,53337,0`) + `startDiscovery` + IPC handlers (`lyra:get-peer-status`, `lyra:resolve-pair-request`, `lyra:sync-trusted-peers`, `lyra:set-pairing-offer`, `lyra:scan-tailscale`, `lyra:set-download-directory`, `lyra:open-path`, window chrome `lyra:window-*`).
- Variant support kept: `LYRA_VARIANT=development|preview|production` → `appId app.lyra.desktop{.dev,.preview}` + `userData lyra-desktop{-dev,-preview}` + `port 53317/53327/53337` + `productName Lyra{ Dev, Preview}`.
- Packaging: `electron-builder` AppImage/dmg/nsis, `extraResources web-dist`, `icon.png` 512.

**Mobile (`apps/mobile`):**
- Expo prebuild only (`expo prebuild --platform android`). Config plugin sets `usesCleartextTraffic` + `network_security_config.xml`, `ACCESS_NETWORK_STATE`, `INTERNET`.
- `lib/transport.ts` provides `NativeTcpTransport`; `lib/lyra.tsx` only creates `createLyraCore({ transport, storage: SecureStoreAdapter })` and subscribes.
- Variants via `APP_VARIANT` → `app.config.ts` `appId app.lyra.sync{.dev,.preview}` + `versionCode`.

**Web (`apps/web`):**
- Vite + TanStack Router, shadcn/ui. Embedded in Electron (`resources/web-dist`); standalone Vite only for dev preview (no peer server, shows “Discovery off”).

---

## 11. Core slices (packages/core)

```ts
createLyraCore(opts: { transport: PeerTransport, storage: StorageLike, seedDemo?: boolean })
→ { identitySlice, pairingSlice, discoverySlice, transferSlice, clipboardSlice, settingsSlice }
```

- No IO in reducers; side-effects via `transport` and `daemon` IPC.
- Persist: `STORAGE_KEY lyra.v2.state` + isolated `lyra.v2.key` for `privateKey`. `stripDemoMesh` when `seedDemo=false`.

---

## 12. Phased roadmap

| Phase | Goal | Deliverables | Exit |
|---|---|---|---|
| P0 | Scaffold | `protocol`, `transport`, `discovery`, `daemon` stubs, `turbo.json`, `ARCHITECTURE-v2.md` | `pnpm check-types` green, branch pushed |
| P1 | Daemon peer server | `/info`, `/pair` long-poll, `/message` seal, trustedPeers map | Two daemons pair via `tsx scripts/pair-local.mjs` |
| P2 | Discovery | Multicast announce, Refresh, Tailscale status relay | Phone sees desktop in <2s on LAN |
| P3 | File transfer (large) | Streaming tmp, pause/resume, checksum, >2 GB test | Transfer 2 GB phone→desktop resume OK |
| P4 | Clipboard | Poll + push sealed, history, Android service opt-in | Desktop copy → phone <1s |
| P5 | Remote browse | Real FS smart folders, download | Browse Photos/Documents on desktop from phone |
| P6 | Packaging | Electron AppImage, Android APK variants, CI | `pnpm dist:desktop:dev` + `pnpm build:dev` green |

---

## 13. Decisions (per user answers)

- Base `df07d3d` ✓, keep Electron + Expo prebuild ✓, keep variants ✓, Tailscale must-have ✓, large files >2 GB streaming ✓, screen mirror deprecated ✓, iOS recommendation: **receive-only manual path, no background monitor, labeled in UI** (system restriction per Spec §5.3).

---

## 14. Risks + mitigations

- **Android tcp-socket fragility** → single `NativeTcpTransport` with slot-aware timeout + Prefer wifi IP (`expo-network` `interface:wifi`).
- **OTA large file ANR** → chunk to disk, `expo-file-system` cache, WorkManager for background.
- **Tailscale MagicDNS flake** → probe `tailscaleHost` + `host` both via `deviceEndpointCandidates`, sticky `lastReachableHost`.

---

*End — next: scaffold P0 stubs and commit.*
