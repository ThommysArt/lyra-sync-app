# Lyra TCP Migration Plan — Persistent Raw TCP (No HTTP)

**Created:** 2026-08-08  
**Status:** Active — replaces `MOBILE-REBUILD-PLAN.md` and `SPEC-VS-IMPLEMENTATION.md` (archived)  
**Scope:** Full rewrite of peer transport: HTTP request/response → persistent raw TCP  
**Backward compat:** NONE. Protocol bump `v2 → v3`. All peers must update. Old HTTP code deleted.  
**Targets:** `apps/desktop` (Electron/Node) + `apps/native` (Android). Web/Expo Go explicitly out of scope.  
**Branch:** `rebuild/tcp-migration`

---

## 0. Why this migration exists

Multiple PRs tried to fix HTTP and all failed in the same three ways:

* **Randomly unreachable** — mobile→desktop "connect peer" even on same Wi-Fi, works after reboot then breaks.
* **Unpair out of nowhere** — both sides drop trust without user action.
* **File freeze mid-way** — progress stops, never resumes.

Root cause is not a bug in one file. Request/response HTTP with brute-force `/24` scanning, short-lived auth sessions, and no heartbeat cannot support clipboard + streaming on devices that sleep, change IP, and must push. Patching HTTP (priority lanes, sticky host, TCP fallback for `fetch`) only moved the failure.

Decision approved: Tailscale set aside for now, fix LAN first. Foreground service will be **mandatory**, not optional. Web/Expo Go not supported going forward.

---

## 1. Goals / Non-goals

### Goals
* One persistent, authenticated TCP connection per paired device. Auto-reconnect with backoff.
* Instant presence via heartbeat, not polling.
* Clipboard, pair, fs, and file streaming multiplexed on same connection with backpressure; file never starves control.
* File resume from `receivedBytes` after any disconnect, disk-streamed, no RAM/OOM.
* No `/24` brute-force scan. Discovery = UDP multicast + last-known host + targeted probe.
* Foreground service + WifiLock/MulticastLock enforced via onboarding (decline = not paired).
* Delete all HTTP transport code.

### Non-goals
* Tailscale/MagicDNS (deferred, will reuse same TCP reconnect path later)
* Web browser as peer (no server)
* Expo Go
* Backward compat with v1/v2 HTTP peers

---

## 2. Architecture — before vs after

**Before (HTTP):**
```
probe GET /lyra/info (scan /24, 500 probes, 50 concurrency)
  → POST /lyra/auth/challenge → POST /lyra/auth/response (per op, cached 50min)
  → POST /lyra/message {envelope} (per clipboard/pair/fs)
  → POST /lyra/transfer/:id/chunk?offset (per 512K-1M file chunk, new TCP each time)
```
State is per-request. No heartbeat. Online = last successful probe.

**After (persistent TCP):**
```
1. UDP multicast announce (224.0.0.167:53318) → discover host:port
2. TCP connect host:port → HELLO → AUTH (once per connection)
3. Keep socket open. All envelopes as framed JSON on same socket.
   heartbeat ping/pong 15s / timeout 45s
   binary chunks as framed binary on same socket (no base64)
4. Disconnect → exponential reconnect (1s/2s/5s/10s/30s cap) → resume file at receivedBytes
```
State is per-connection. Online = socket open + recent pong.

---

## 3. Wire format

### 3.1 Framing
Every frame on TCP:
```
[4 bytes: big-endian uint32 payload_len][1 byte: type][payload_len-1 bytes: payload]
```
* `payload_len` includes the 1 byte type.
* Max frame 4 MiB + header (enforced). Larger files split into many frames.
* Reader buffers until 4 bytes available → reads len → waits for full frame → dispatches. Handles TCP segmentation and coalescing.

### 3.2 Frame types
* `0x01 = JSON` — `payload = utf8 JSON`. Used for all control: `hello`, `auth_challenge`, `auth_response`, `auth_ok`, `envelope` (all existing envelope types: `pair_request`, `pair_confirm`, `pair_reject`, `clipboard_push`, `open_url`, `fs_list`, `fs_read`, `transfer_offer`, `transfer_accept`, `transfer_complete`, `transfer_pause`, `transfer_resume`, `ping`, `pong`), `error`.
* `0x02 = BINARY_CHUNK` — `payload = 4 bytes header_len (BE) + header_json + raw_bytes`
  * `header_json = utf8 JSON { transferId: string, offset: number, eof: boolean }`
  * `raw_bytes = file bytes for this chunk (0..1M)`

No base64. No HTTP headers. No Content-Length ambiguity.

### 3.3 Handshake (per connection)
```
client → server: JSON {type:"hello", identity, protocolVersion:3}
server → client: JSON {type:"hello", identity, protocolVersion:3}
server → client: JSON {type:"auth_challenge", challenge}
client → server: JSON {type:"auth_response", response}
server → client: JSON {type:"auth_ok", sessionToken, deviceId, fingerprint}
-- OR server → client: JSON {type:"auth_error", error } → close --
```
* For unpaired first-contact, `auth_response` uses `allowFirstContact` path (same as current `createFirstContactAuthResponse`). Paired peers must use `sharedSecret`.
* After `auth_ok`, connection is authenticated. All later `envelope` frames require it (except `ping/pong/hello/auth`).
* `sharedSecret` stays `deriveMutualAuthSecret(token, fpA, fpB)` as today; sealing of envelope payloads continues unchanged (`sealEnvelopePayload`).

Existing `handlePeerEnvelope` stays pure function — transport just calls it with `envelope` and `session`.

---

## 4. Connection manager

**Single socket per peer.** Key = `deviceId`.

* `ConnectionManager` (in `packages/net`) owns `Map<deviceId, ManagedConnection>`.
* `ManagedConnection` state: `disconnected | connecting | connected | authenticated`
* **Connect:** resolve `host/port` via `deviceEndpointCandidates` (lastReachableHost first, then host, then last 3 ports, no /24 flood). Single TCP `connect()`, timeout 5s.
* **Reconnect:** on `close`/`error`/`heartbeat timeout`, backoff 1s → 2s → 5s → 10s → 30s cap, jitter 20%. Reset to 1s on success. Give up only on explicit unpair.
* **Heartbeat:** after `auth_ok`, send `{type:"ping", ts}` every 15s. Expect `pong` within 10s. Miss 3 → close and reconnect. This replaces `probePeer` polling for online status.
* **Multiplex:** one writer queue per connection. `sendEnvelope` enqueues JSON frame; file sender enqueues `BINARY_CHUNK` frames. Writer drains sequentially, respects `socket.write` backpressure (`drain` event). No priority queue hack — file chunks are throttled to 3-8 concurrency in sender, but on wire they are sequential on one socket; control frames can interleave between chunks (writer checks control queue first each loop).
* **Store integration:** `store.refreshDiscovery` no longer scans /24. It just triggers `announce` burst and updates `online` from `ConnectionManager` snapshot (`online = authenticated`). `ensureSession` deleted — callers do `connectionManager.send(deviceId, envelope)` which auto-connects if needed.

---

## 5. Discovery (no flood)

Keep `packages/net/src/node/discovery.ts` UDP multicast (`224.0.0.167:53318`) exactly as today — it already does per-interface membership + burst `0/100/500/2000ms` and reply. This is the primary discover.

**Changes:**
* Mobile: keep `NsdManager` alternative only if UDP proves blocked on test devices; otherwise reuse same UDP socket via native `DatagramSocket` (simpler than adding mDNS). Fallback path = targeted TCP probe, not /24 scan.
* Remove `scanLanForPeers` / `probePeers` bulk scan and `LYRA_SCAN_PORTS` expansion. Delete `probe.ts` `scanLanForPeers`, `findPeerByPairingCode` /24 expansion, and `expandLanCandidates`. Replace with:
  * `announce` burst on app start, on network change, on user Refresh.
  * `probeDevice(device)` → try `deviceEndpointCandidates(device)` sequentially (max 8 candidates, 1.5s each), not 500 hosts.
  * For code pairing `submitPairingCode`, look up `codeHash` only in `recentAnnounces` cache (multicast cache), plus try `lastReachableHost` if announce missed. No /24 walk.
* `ConnectionManager` also updates `lastReachableHost/Port` on successful connect (same as today `applyReachableEndpoint`).

Result: no 75s scan queue that previously starved clipboard/pair.

---

## 6. Security

* Pairing: same dual-confirm flow. `pair_request` is now an `envelope` over authenticated-or-not connection (first-contact allowed). Server holds `waitForPairDecision` 120s as today, but over persistent socket not HTTP long-poll (no slot to hold).
* After pair, `authSecret` derived same way `deriveMutualAuthSecret`. Stored in `devices[].authSecret`. All later connections must auth with it; `resolvePeerAuth` same as today.
* Encryption: keep app-level `seal` (AES-GCM) for envelope payloads. No TLS for local link (same as before). Optional TLS later same as before, not part of this migration.
* Sessions in-memory only (`sessionToken` per connection). No 50-min cache map needed across HTTP requests. Close = session dies.

---

## 7. File transfer over persistent TCP

* Offer/accept same envelopes: `transfer_offer {id, files, totalBytes, resumeOffset}` → `transfer_accept {resumeOffset}`.
* Sender then sends `BINARY_CHUNK` frames sequentially (or 1 at a time per connection — no window needed because one socket gives ordering). Receiver writes to disk via `createDiskTransfer` (desktop `transfer-disk.ts`, native `File` as today) at `offset`; validates `offset === receivedBytes`, otherwise buffers in `pendingChunks` Map max 256 (same as today) or NACKs.
* Progress: receiver calls `onTransferChunk` throttled 80ms same as today. Sender tracks `ackedContiguous` via `transfer_chunk_ack` envelope from receiver (receiver sends JSON envelope ack after each chunk). Sender's `onProgress` same as today.
* Complete: sender sends `transfer_complete`, receiver finalizes disk + integrity check + `MediaStore` / `Downloads/Lyra` save, same as today.
* Resume: on reconnect, sender re-sends `transfer_offer` with `resumeOffset = receiver.receivedBytes` (queried via `transfer_accept`). Sender starts chunks from there. No random bytes, no synthetic truncation.
* No base64, no `Uint8Array → fetch` fallback, no per-chunk HTTP.

---

## 8. Foreground service & onboarding (mandatory)

Current service is opt-in and starts late (`lyra.tsx` after 1.2s). New:

* Service starts **immediately** when `peerServer` binds, not after discovery. `WifiLock` + `MulticastLock` held while `running`.
* On first launch, show blocking onboarding screen: "Lyra needs to stay connected in background" → request `POST_NOTIFICATIONS` → start `LyraForegroundService` (`dataSync`) → request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` via `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. User cannot dismiss without confirming; "Not now" just shows warning that pairing/transfers will break in background.
* App kill (swipe) → service `START_STICKY`, auto-restart. Re-bind on `AppState` active.
* Periodic `refreshLanHost` 20s stays, but no longer tied to HTTP server.

---

## 9. Migration steps (no compat)

### Phase 0 — Plan & archive (this doc)
* Archive `MOBILE-REBUILD-PLAN.md` → `archives/MOBILE-REBUILD-PLAN-2026-08-06.md`
* Archive `SPEC-VS-IMPLEMENTATION.md` → `archives/SPEC-VS-IMPLEMENTATION-2026-07-19.md`
* Update `AGENT-PROGRESS.md` to point here.

### Phase 1 — Protocol + codec
* Bump `LYRA_PROTOCOL_VERSION 2 → 3` in `packages/protocol/src/index.ts`.
* Create `packages/net/src/tcp/frame.ts` — `encodeFrame(type,payload)` / `FrameDecoder` (buffer + state machine). Unit tests with segmentation, coalescing, max size.
* Create `packages/net/src/tcp/authHandshake.ts` — extract challenge/response from current `auth.ts` to be callable over frames.
* Delete `httpCodec.ts` after migration (or keep for reference one commit then delete).

### Phase 2 — Connection manager
* Create `packages/net/src/tcp/connection.ts` (`ManagedConnection`) + `connectionManager.ts`.
* Heartbeat, reconnect, writer queue with backpressure.
* Unit test: heartbeat timeout, reconnect backoff, control interleaving.

### Phase 3 — Peer servers
* Rewrite `packages/net/src/node/peer-server.ts` to `tcp-peer-server.ts` — `net.createServer` on `0.0.0.0:port`, on `connection` attach `FrameDecoder`, handshake, then route frames to `createPeerHttpCore` (renamed `createPeerCore`) handlers. Delete HTTP `readBody`/`sendJson` helpers.
* Rewrite `apps/native/lib/peer-server.native.ts` similarly using `react-native-tcp-socket` server, same frame decoder, same core. Keep `safeClose`/`done` guards.
* Delete `tcp-http-client.ts` `fetchAsTransport` + `withPrioritySlot` + `http-transport.ts` `fetchAsTransport`. Keep only TCP framing.

### Phase 4 — Discovery
* Strip `probe.ts` scan functions, keep `isLikelyTailscaleHost` helper for later but not used in LAN path.
* Simplify `store.refreshDiscovery` to announce + connect known peers via `connectionManager`.
* Update `submitPairingCode` to use multicast cache + direct probe, no /24.
* Delete `NATIVE_HTTP_MAX_IN_FLIGHT`, `Lane`, `priorityQueue.ts` (no longer needed).

### Phase 5 — Peer-ops & store
* Delete `ensureSession` → `ensureConnection`. All `wire*` functions (`wirePushClipboard`, `wireSendFiles`, etc.) become `manager.sendEnvelope(deviceId, envelope)` + binary chunk path via `manager.sendBinary`.
* Port `transfer-wire.ts` to use `manager` frames instead of `postBinaryChunk` HTTP.
* Update `peer-ops.readFileSlice` streaming stays, just calls new chunk sender.
* Remove `sessionCache` Map in `peer-client.ts`.

### Phase 6 — Cleanup
* Delete `http-transport.ts`, `httpCodec.ts`, `peer-client.ts` HTTP exports, `probe.ts` scan, `transport/priorityQueue.ts`.
* Remove `usesCleartextTraffic` + network_security_config HTTP cleartext flags (still needed for UDP? keep minimal).
* Update `AGENT-PROGRESS.md`, `PACKAGING.md` for new port, service.

### Phase 7 — Verify
* `pnpm --filter @lyra-sync-app/net test` (frame, handshake, manager)
* `pnpm --filter @lyra-sync-app/core test`
* `pnpm run check-types`
* Manual: 2 Android + 1 desktop on same Wi-Fi, kill/reopen, 15 min background, 300 MB file both directions, clipboard both ways, pair via code.

---

## 10. Files to delete / archive

Delete after Phase 6:
```
packages/net/src/httpCodec.ts
packages/net/src/http-transport.ts
packages/net/src/transport/priorityQueue.ts
packages/net/src/probe.ts (or keep isLikelyTailscaleHost helper elsewhere)
apps/native/lib/tcp-http-client.ts
packages/net/src/peer-client.ts (HTTP exports)
```

Archive today:
```
docs/MOBILE-REBUILD-PLAN.md → docs/archives/MOBILE-REBUILD-PLAN-2026-08-06.md
docs/SPEC-VS-IMPLEMENTATION.md → docs/archives/SPEC-VS-IMPLEMENTATION-2026-07-19.md
```

---

## 11. Risks & mitigations

* **Splitting a file across many TCP frames still needs disk, not RAM** — mitigated: disk streaming already done, keep it.
* **OEM kill despite foreground service** — onboarding mandates battery exemption; document known OEM steps (Xiaomi/Samsung) in settings.
* **UDP blocked by AP isolation** — fallback direct probe of lastReachableHost still works if user manually added peer; no silent /24 scan storm.
* **No compat → all test devices must update at once** — acceptable per user. Tag `v0.3.0` before bump for rollback.

---

## 12. Execution log

| Date | Step | Notes |
|------|------|-------|
| 2026-08-08 | Plan | Created this plan, archiving old docs, starting Phase 1 |
| 2026-08-08 | Phase 1 | Bump protocol v4→5, create `packages/net/src/tcp/frame.ts` (4-byte len + type + payload, JSON + BINARY_CHUNK), `handshake.ts`, `connection.ts` (hello/auth, heartbeat, writer queue), `manager.ts` (single socket per peer, reconnect, request-response) |
| 2026-08-08 | Phase 2 | Implement `nodeTcpServer.ts` (Node `net`) + `nodeSocket.ts`, rewrite `packages/net/src/node/peer-server.ts` to TCP, update `apps/desktop/electron/main.ts` + `cli.ts` |
| 2026-08-08 | Phase 3 | Rewrite `apps/native/lib/peer-server.native.ts` to TCP (`react-native-tcp-socket` + `createTcpPeerCore`), add `tcp-native-socket.ts`, enforce foreground service as mandatory in `lyra.tsx` |
| 2026-08-08 | Phase 4 | Patch `packages/core/src/store.ts` `refreshDiscovery` — TCP path uses `ConnectionManager` heartbeat + `upsertPeer` (no `/24` flood), fallback to HTTP scan only when manager absent |
| 2026-08-08 | Phase 5 | Patch `packages/core/src/peer-ops.ts` — `wirePushClipboard`/`wireOpenUrl` via TCP manager, `wireSendFiles` TCP fast path for bytes (512K chunks via `sendBinaryChunk` + `requestEnvelope` for offer/complete), fallback to HTTP for complex `uri/file` |
| 2026-08-08 | Verify | `pnpm run check-types` 7/7 pass, `pnpm --filter net test` 17/17 pass, `pnpm --filter core test` 16/16 pass, manual TCP handshake verified via `test-manager.ts` (ping/pong) |

---

**End of plan**
