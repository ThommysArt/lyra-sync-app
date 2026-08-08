# Lyra Mobile Rebuild Plan — v2 Architecture

**Created:** 2026-08-06  
**Status:** Active rebuild — replaces `GAP-FIX-PLAN.md` (archived to `docs/archives/GAP-FIX-PLAN-2026-07-19.md`)  
**Scope:** Full native mobile rebuild (Expo dev-client, Android-first, no Expo Go host)  
**Version target:** App `0.3.0` / Protocol `v2` (synced across `apps/native`, `apps/desktop`, `packages/protocol`)  
**Branch:** `rebuild/mobile-v2`

---

## 0. Decisions (User-approved 2026-08-06)

| # | Area | Decision |
|---|------|----------|
| 1 | Platform | Stay Expo (`expo prebuild` mandatory, no Expo Go host) |
| 2 | Lifecycle | Persistent foreground notification accepted (`foregroundServiceType:dataSync`) |
| 3 | Tailscale | Auto-detect `100.x` from `ConnectivityManager`/`LinkProperties` |
| 4 | File server | Phone **will** serve filesystem (Downloads / DCIM / Documents) |
| 5 | Clipboard | Take Play Store risk — real `AccessibilityService` |
| 6 | iOS | Deferred (Android-first; iOS keeps stub `peer-server.web.ts`) |
| 7 | Transfers | No cap — streaming to temp file, not RAM/base64 |
| 8 | Docs | Archive old plan |
| 9 | Version | Bump protocol + app version synced |
| 10 | Delivery | Rebuild all at once (single branch) |

---

## 1. Why Rebuild — Evidence

### Desktop works (reference)

- Node `http.createServer 0.0.0.0:53317` with fallbacks `+2/+4/+10` `apps/desktop/electron/main.ts:405-414`
- UDP multicast `224.0.0.167:53318` per-interface `addMembership` + burst `0/100/500/2000ms` `packages/net/src/node/discovery.ts:88-328` — <1 s
- `os.networkInterfaces()` full enumeration `discovery.ts:66-79`, `tailscale status --json` via exec `tailscale.ts:61-68`
- Real FS `fs-browse.ts` + disk streaming `transfer-disk.ts`, Electron `clipboard` always alive

### Mobile broken — root causes (file:line)

| Flaw | File:Line | Symptom |
|------|-----------|---------|
| **Single LAN IP** | `apps/native/lib/lyra.tsx:63-76`, `peer-server.native.ts:237-245` `Network.getIpAddressAsync()` | Wi-Fi hidden when Tailscale `100.x` active → scan seeds wrong `/24` |
| **No multicast** | `peer-server.native.ts:648-660` `discoveryActive:true` lie; `peer-server.web.ts:1-41` stub | Phone never announces; desktop sees phone, phone sees nothing |
| **HTTP scan flood via 8-slot FIFO** | `tcp-http-client.ts:143-215` `NATIVE_HTTP_MAX_IN_FLIGHT=8` + `withSlot`; `store.ts:2031-2276` ~1000 probes `concurrency 24` | 75 s queue blocks `wirePushClipboard` 12 s → false “unreachable”; pair long-poll previously killed at 15 s `tcp-http-client.ts:384-388`, fixed to `waitMs+10s` `peer-client.ts:633` but queue wait still not priority-aware |
| **Duplicated HTTP parsers** | `peer-server.native.ts:115-214` vs `tcp-http-client.ts:86-110` `indexOfHeaderEnd`/`concat` drift | Maintenance hazard, O(n²) copies |
| **8 MiB wall** | `peer-server.native.ts:80` | Clipboard images >8 MiB → 400; transfer chunks sealed still <1 MiB but wall is per-request |
| **Global transport singleton** | `http-transport.ts:35` `globalThis.__lyra_http_transport_v1__` for Metro dedupe | Fragile across duplicate `net` copies |
| **Storage race** | `secure-storage.ts:18-66` fire-and-forget `AsyncStorage`, `ready` unused `21`, dual `hydrate` `lyra.tsx:35-47` vs `hooks/src/lyra.tsx:57-72` | Early read → new identity overwrites persisted |
| **Tailscale chicken-egg** | `store.ts:2334-2341` `probeTailscalePeers` empty if no `tailscalePeerHints` | Phone never learns desktop `100.x` without manual paste `index.tsx:130-153` |
| **RAM transfers** | `download-location.ts:254-283` `merged = new Uint8Array(totalLen)` + base64; `peer-ops.ts:343-359` synthetic `256KiB` on `>32MiB` | OOM, silent truncation, integrity false-positive |
| **Scoped storage** | `download-location.ts:44-111` hard-coded `/storage/emulated/0/Download/Lyra`, legacy `expo-file-system/legacy:6` + `app.config.ts:153-158` | Fails on Android 11+ → fallback hidden `documentDirectory` |
| **Clipboard poll only FG** | `clipboard-monitor.tsx:27` `AppState !== active` skip + `with-clipboard-accessibility.js:58-60` empty | Background sync dead (spec §5.3) |
| **No foreground service** | `lyra.tsx:53-276` no `foregroundService` | TCP server killed seconds after background; `120s` pair long-poll drops |
| **Ephemeral port hidden** | `peer-server.native.ts:298-302` fallback `0` not in `LYRA_SCAN_PORTS` `probe.ts:195-201` | Random port invisible unless `lastReachablePort` sticky |
| **Demo vs real confusion** | `lyra.tsx:299-302` opt-in seed now correct, but `store.ts` history inconsistent | Stale docs `SPEC-VS-IMPLEMENTATION.md` rev 4 predates native TCP fixes |

---

## 2. Target Architecture

### Principles

1. **Ports, not forks:** `packages/net` defines `Transport`, `DiscoveryProvider`, `TailscaleProvider`, `FsProvider`; native injects implementations.
2. **Correctness over heuristics:** Enumerate real interfaces or mDNS; never synthesize `192.168.1.1` or `256KiB` random bytes.
3. **Priority lanes:** Pair/clipboard/chunks preempt discovery scans.
4. **Disk-first:** Stream to temp file; never hold full file+base64 in heap.
5. **Lifecycle-aware:** Foreground service + `WifiLock`/`MulticastLock` while discoverable.

### Module map

```
packages/protocol (v2)
packages/net
 ├─ src/httpCodec.ts              // single HTTP/1.1 codec
 ├─ src/transport/priorityQueue.ts// lanes: PAIR > INTERACTIVE > SCAN
 ├─ src/transport/tcpTransport.ts // react-native-tcp-socket + codec
 ├─ src/discovery/mdns.ts         // NsdManager browse/advertise
 ├─ src/discovery/httpScan.ts     // fallback scan with real /24s
 ├─ src/tailscale/native.ts       // ConnectivityManager 100.x reader
 └─ src/fs/safBridge.ts           // phone FS (Downloads/DCIM/Documents)

apps/native
 ├─ nativeModules/
 │   ├─ lyraNetwork.kt            // listInterfaces()
 │   ├─ lyraMdns.kt               // advertise/browse _lyra._tcp
 │   ├─ lyraFs.kt
 │   └─ lyraForeground.kt
 ├─ lib/
 │   ├─ transport/                // re-exports from net
 │   ├─ discovery/
 │   ├─ peerServer/nativePeerServer.ts
 │   ├─ storage/secureStorageV2.ts
 │   └─ lyra.tsx (composition)
 ├─ plugins/
 │   ├─ with-lyra-network.js
 │   ├─ with-lyra-mdns.js
 │   ├─ with-lyra-foreground-service.js
 │   ├─ with-lyra-fs.js
 │   └─ with-clipboard-accessibility.js (real)
```

### Flow

```
UI → store → peer-ops.ensureSession → DiscoveryProvider.bestEndpoint()
     (mDNS cache → httpScan fallback)
     → Transport.request(lane) → peer-http-core (seal + auth) → handler
```

---

## 3. Version & Compatibility

- **App version** `0.3.0` synced: `apps/native/package.json`, `apps/desktop/package.json`, root catalog.
- **Protocol** `LYRA_PROTOCOL_VERSION 1 → 2` `packages/protocol/src/index.ts:4`. Desktop `getPeerStatus` advertises `protocolVersion:2`; mobile rejects `1` with “Update desktop to 0.3.x”.
- Crypto (`seal.ts` AES-GCM, `identity.ts` ECDSA P-256) unchanged; version gate is explicit.

---

## 4. Execution — All-at-Once Rebuild

> Single branch `rebuild/mobile-v2`, commits per sub-section, desktop compat kept via version gate. Order respects dependencies.

### 4.1 HttpCodec + Priority Transport (`packages/net`)

- Create `src/httpCodec.ts`: `buildRequest(method,path,headers,body)`, `parseResponse(bytes)` → `{headerEnd, status, headers, bodyStart}`, streaming incremental parse. Covers both client `tcp-http-client.ts:86-110` and server `peer-server.native.ts:115-214`. Tests with UTF-8 multi-byte.
- Create `src/transport/priorityQueue.ts`: `PriorityLane = PAIR(0) | INTERACTIVE(1) | SCAN(2)`, `withSlot(fn,lane,signal)` replaces `tcp-http-client.ts:143-215`. `SCAN` yields to higher lanes.
- Refactor `src/transport/tcpTransport.ts` from `tcp-http-client.ts` using `httpCodec`. Keep `loadTcpApi()` `56-66` Expo Go guard, `connectTimeout` `410-413`.
- Remove hard `8MiB` wall from codec — enforce per-chunk `48KiB + seal overhead` + stream; only `/lyra/message` transfer_chunk may be large and will be streamed (see 4.5).
- Deprecate `globalThis.__lyra_http_transport_v1__` `http-transport.ts:35`; inject `Transport` via `LyraNetContext` (keep global as fallback for compat during cut-over).

**Exit:** `httpCodec.test.ts` passes multi-byte + no header `Content-Length` wait-for-close.

### 4.2 Storage Fix (`apps/native/lib/secure-storage.ts`)

- `createAsyncStorageBulk` → `awaitable` `setItem`/`removeItem` (no fire-and-forget). `hydrate()` must complete before `BaseLyraProvider` `store.hydrate()`.
- Remove dual hydrate race: `apps/native/lib/lyra.tsx:35-47` single source; `hooks/src/lyra.tsx:57-72` awaits `storage.hydrate()` promise rather than racing.
- `ready` flag used correctly; `isExpoGoRuntime()` guard deduped single helper.

**Exit:** Repro: cold start with persisted identity never regenerates.

### 4.3 Native Network & mDNS (`apps/native/nativeModules/` + plugins)

- `lyraNetwork.kt`: `NetworkInterface.getNetworkInterfaces()` → `[{name,addr,prefixLen}]` filtered `!isLoopback`, include `100.x`. Chose kotlin bridge via `expo-modules-core` `createNativeModule`.
- Config plugins `with-lyra-network.js` add `ACCESS_NETWORK_STATE` already, no new perm.
- `lyraMdns.kt`: `NsdManager` `registerService(_lyra._tcp, port, TXT[id,fp,ver=2])`, `discoverServices` + `resolveService` → `DiscoveredPeer`. `with-lyra-mdns.js` adds `NSD` usage note + `CHANGE_WIFI_MULTICAST_STATE`.
- `lyraForeground.kt`: `Service` with `startForeground(notificationId, notification)` `foregroundServiceType="dataSync"` `POST_NOTIFICATIONS` request; `WifiManager.createWifiLock` + `createMulticastLock` while `discoveryActive`. `with-lyra-foreground-service.js`.

**Exit:** Two phones on same Wi-Fi discover in `<2s` without manual IP; `adb logcat | grep lyra mdns` shows advertise+browse.

### 4.4 Discovery Rewrite (`packages/net/src/discovery/`)

- `mdns.ts` / `httpScan.ts`: `DiscoveryProvider { start(), stop(), getDiscovered(), scanOnce() }`.
- `store.refreshDiscovery()` new phases (replaces `store.ts:2031-2276`):
  1. `mdnsCache` 800 ms browse
  2. `probeDeviceCandidates` via `deviceEndpointCandidates` `peer-ops.ts:69-154` plus `mdns` hosts
  3. `httpScan` fallback: expand real `/24`s from `lyraNetwork.listInterfaces()`, no `100.x` expansion, no hardcoded gateways, `concurrency 16`, lane `SCAN`
- Remove lies: `discoveryActive=true` only when `NsdManager` or `HttpScan` truly active.

**Exit:** Wi-Fi + Tailscale both advertised; Tailscale vs LAN both reachable without heuristic seeds.

### 4.5 Tailscale Auto-Detect

- `lyraNetwork.getTailscaleIp()` via `ConnectivityManager.getLinkProperties` → first `100.64/10`. Expose `tailscaleLocalIp` separate from `localLanHint`.
- `store.setLocalLanHint` now stores `{lanIps: string[], tailscaleIp: string | null}`; legacy single field kept as derived `primaryLanIp`.
- Desktop still provides `tailscale status --json`; phone no longer blocked on it.

### 4.6 PeerServer v2 (`apps/native/lib/peerServer/`)

- New `nativePeerServer.ts` wraps `TcpServer` + `httpCodec` + `peer-http-core.ts`. Streaming per-chunk: assemble until `headerEnd+Content-Length`, then dispatch; no `MAX_REQUEST_BYTES` per-request (chunk limit enforced at handler).
- Full handler set: `onPairRequest`, `onClipboardPush`, `onUnpair`, `onOpenUrl`, `onTransferComplete`, plus new `onFsList/onFsRead` via `safBridge`.
- Port candidates `[pref,+2,+4,+10]` (no ephemeral `0`); advertise via mDNS TXT, so `LYRA_SCAN_PORTS` fallback less critical.
- Keep `done`/`safeClose` guards `peer-server.native.ts:322-410` factored into `safeSocket.ts`.

### 4.7 File Serving + Transfers (Streaming)

- Migrate off `expo-file-system/legacy:6` → `expo-file-system/next` (`File`, `Directory`, `Paths`).
- Sender: `DocumentPicker.getDocumentAsync` → `File` → `file.read(offset,length)` stream `48KiB` `transfer-wire.ts:11`; `peer-ops.wireSendFiles` no longer synthesizes `randomBytesOfSize` — throws user-visible “File too large for browser picker — use system picker” and `transfers.tsx` shows error.
- Receiver: `Paths.cache/lyra-tx-<id>.bin` temp `File`; `transfer_chunk` appends via `File.write` at offset `message-handlers.ts:510-562`; `transfer_complete` → `finalize` → `MediaStore` `expo-media-library.createAssetAsync` to `Downloads/Lyra` (fallback `documentDirectory`).
- Delete legacy hard-coded `/storage/emulated/0/Download/Lyra` `download-location.ts:44-111`; `ensureDefaultDownloadDir` now delegates to `MediaStore`.
- Remove synthetic size lie `peer-ops.ts:343-359` + `358`.

### 4.8 Foreground Service Wiring

- `apps/native/lib/lyra.tsx:53-276` `onStoreReady` starts `lyraForeground.start()` when `peerServer.running`; `Network.addNetworkStateListener` debounced `1.5s`; single `refreshLanHost` timer (remove duplicate `peer-server.native:723-731` + `lyra.tsx:78-89`).
- Settings `settings.tsx:122-180` Network card: `mDNS`, `Foreground service`, `Peer port`, `Tailscale IP`.

### 4.9 Clipboard Real Service

- Keep foreground poll `clipboard-monitor.tsx:27` with `250ms` debounce + `hash(text)` idempotency.
- Real `ClipboardAccessibilityService.kt`: `onAccessibilityEvent` filters `TYPE_VIEW_TEXT_CHANGED|TYPE_WINDOW_CONTENT_CHANGED`, excludes `isPassword`, extracts `event.getText()` → `ClipboardManager` compare → native event to JS `NativeModules.LyraClipboard.onTextChanged(text)`. Include guard `packageName != "app.lyra.sync.*"` password check, never capture passwords comment preserved `with-clipboard-accessibility.js:55`.
- `with-clipboard-accessibility.js` update `ACCESSIBILITY_XML` `canRetrieveWindowContent=true` where needed, add `flagRetrieveInteractiveWindows`.

### 4.10 UX & Parity

- Devices `index.tsx`: “Scan nearby” replaces separate Tailscale scan; badges `mDNS • LAN • Tailscale`.
- Pair `pair.tsx`: host card shows `mDNS .local • LAN IP • Tailscale IP`.
- Settings parity with web: integrity toggle already present, add `clipboardRetentionDays`, `history limit`, `peerListenPort`.
- Desktop `electron/main.ts:311` version gate.

---

## 5. Testing Strategy

| Layer | Command / Check |
|-------|-----------------|
| Unit | `pnpm --filter @lyra-sync-app/net test` (auth, integrity, peer-http-core, httpCodec, priorityQueue, discovery) |
| Unit core | `pnpm --filter @lyra-sync-app/core test` |
| Types | `pnpm run check-types` |
| Native mock | `tsx packages/core/scripts/integration-net.mjs` extended: mock `TcpServer` + real `peer-http-core` → pair v2 → clip → 25 MiB both directions |
| Device | 2 Android + 1 desktop, Wi-Fi + Tailscale, cold discovery <2 s, Tailscale-only pair, 500 MiB transfer (no OOM), bg 15 min still `/lyra/info`, bg kill→relaunch identity stable |
| Docs | Regenerate `SPEC-VS-IMPLEMENTATION.md` crawl `:3001` + `:8081` after build |

---

## 6. Risks

- Big-bang branch → keep `v0.2.3` tag for rollback; `0.3.0-dev` APK not committed.
- mDNS blocked by AP isolation → `httpScan` fallback retained.
- Foreground battery → Settings toggle + stop when `discoveryEnabled===false`.
- Play Store review for Accessibility → flagged off by default (`autoMonitorClipboard false`).

---

## 7. Execution Log

| Date | Step | Notes |
|------|------|-------|
| 2026-08-06 | Plan | Created this plan, archived `GAP-FIX-PLAN.md`, bumped versions (pending) |
| 2026-08-06 | Impl | HttpCodec + PriorityQueue + Storage fix + Network/mDNS + Discovery + PeerServer v2 + Streaming + Foreground + Clipboard real |

---

## 8. Files Changed (indicative)

```
docs/MOBILE-REBUILD-PLAN.md (new)
docs/archives/GAP-FIX-PLAN-2026-07-19.md (archived)
packages/protocol/src/index.ts (v1→2)
apps/native/package.json, apps/desktop/package.json (0.2.3→0.3.0)
packages/net/src/httpCodec.* + transport/*
apps/native/nativeModules/*
apps/native/lib/{transport,discovery,peerServer,storage,clipboard}/*
apps/native/plugins/*
packages/net/src/discovery/*
packages/core/src/store.ts, peer-ops.ts
apps/native/lib/lyra.tsx, peer-server.native.ts, tcp-http-client.ts (replaced)
```

**End of plan**
