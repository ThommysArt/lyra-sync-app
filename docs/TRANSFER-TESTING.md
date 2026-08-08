# Transfer Interop Testing — Native ↔ Node (>20 MB fix)

This doc covers how to validate the 20 MB+ crash fix across **native (Android)** and **node (desktop)** peers.

## 1) Why 20 MB crashed before

| Root | Symptom | Fix |
|------|---------|-----|
| `peer-server.native.ts` re-concatenated `chunks: Uint8Array[]` on every TCP packet (`concatBytes(chunks)` per `data` event) → ~33 MB churn per 1 MB request × 20 concurrent chunks → GC OOM on low heap devices | App killed silently after 20 MB (Android LMK, no JS logs) | Doubling `Uint8Array` buffer (`buf`+`len`+`cap`) with `ensureCap` — O(n) copies, no array churn |
| `tcp-http-client.ts` same pattern on response path + `String.fromCharCode(...payload)` with 32k spread + `binary+=` string concat | Same, plus corruption risk | Same doubling buffer, avoid string conversion for binary |
| `peer-ops.ts` `readFileSlice` fell back to `File.bytes()` / `fetch(arrayBuffer)` / `readAsStringAsync(base64)` for whole file on each 1 MB chunk. For 20 MB file with 8 window → 8×20 MB = 160 MB heap + 2× base64 expansion | OOM after 2–3 chunks, no log | Gate whole-file fallbacks to **<5 MB** only; for large files skip to `normalize` copy + `slice`/`open(readBytes)` streaming; cache `normalizedUri` per file index (not per chunk invocation) |
| `download-location.ts` `writeToDownloadLocation` used `uint8ToBase64(bytes)` → 27 MB string + 2-byte per char JS overhead = >60 MB for 20 MB file | OOM on receive | Prefer `expo-file-system` `File` / `FileHandle` `writeBytes` / `append:true` for any `>256 KB` — no base64 |
| SAF `saveReceivedTransferFromDisk` did per-chunk `writeAsStringAsync(dest, b64)` which overwrites file each time (only last chunk kept) + same OOM | File truncated + crash | Use `FileHandle` `open("wa")` `writeBytes` streaming for both SAF and `file://`; fallback to chunked append via `File.write(…, {append:true})` |
| `transfer-wire.ts` used 1 MB chunk + window 8 on mobile → 8 MB in-flight via bridge, `TransactionTooLargeException` | Android Binder 1 MB limit crash | Mobile detection `isReactNative()` → `512 KB` chunk + `window 3` |
| No persistent logs | Crash left no trace | `packages/net/src/logger.ts` now also appends to `Paths.cache/lyra-debug.log` (2 MB rotate) when `navigator.product === "ReactNative"` |

## 2) Automated interop harness (loopback, no device)

Runs entirely on host, mimicking native memory pressure with mobile-tuned chunk/window and streaming via `File`-like handles.

```bash
# Quick (2× 25 MB cases, ~15s)
pnpm exec tsx scripts/test-native-interop.mjs --quick

# Full (25, 50, 80 MB, ~60–90s)
pnpm exec tsx scripts/test-native-interop.mjs

# Existing bench (node↔node pure, includes 317 MB real APK if present)
pnpm exec tsx scripts/transfer-bench.ts

# Unit suite (auth, integrity, peer-http-core, discovery)
pnpm test
pnpm --filter @lyra-sync-app/core test
```

**Expected:** All cases `PASS`, avg speed `>400 KB/s` on loopback (full bench `>5 MB/s`). `progress` logs show chunk 512 KB window 3 for mobile cases.

**What it proves:**

- Doubling buffer fix + mobile `512KB/3` works for 20+ MB.
- `readFileSlice` streaming via `File.open/readBytes` + `slice` handles 30–80 MB without loading whole file.
- Node disk factory (`transfer-disk.ts` `appendDiskChunk` + `finalizeDiskTransfer` re-hash) handles 30 MB.
- Native `createNativeDiskTransfer` path is exercised via `peer-http-core` handle (pendingChunks map caps at 256).

## 3) Real device test: Android (native) ↔ Desktop (node)

### Prereqs

- Android Studio + one AVD or USB device, API 30+
- `adb` on PATH, `pnpm`, `lyra` dev build (`apps/native/package.json:build:dev`)

### A. Start a desktop peer (node) on host

In terminal 1:

```bash
pnpm run peer-server:desktop
# → Lyra peer server listening on http://127.0.0.1:53317
# note fingerprint / port
```

Leave it running. It now has a real OS disk backing and `GET /lyra/info` + binary chunk endpoint.

### B. Build & install dev APK to emulator/device

```bash
pnpm run build:dev
pnpm run install:dev   # or: adb install apps/native/dist/lyra-0.4.0-dev.apk
adb logcat -c
adb logcat -s "lyra" "Lyra" "ReactNativeJS" "AndroidRuntime" "*:S" > /tmp/lyra-logcat.txt &
```

Install via Android Studio: **Run → Select Device → app.lyra.sync.dev**. Ensure `VITE_LYRA_SEED_DEMO=0` (no demo mesh).

On device, open Lyra → **Settings → Enable "Discovery" + "Tailscale" (if testing tailnet)** → note LAN IP shown (e.g., `192.168.1.152`).

### C. Pair

- **Code path**: Desktop shows code (via `store.startPairingSession()` exposed in dev menu) or `peer-server:desktop` log shows pairing offer. On phone: **Devices → Pair → Enter code** (with `host:port` if auto-scan fails, e.g., `192.168.1.50:53317`). Accept on desktop.
- **Manual**: On phone **Devices → Add peer by address** → `192.168.1.50:53317` → **Pair**.

Verify `adb logcat` shows:

```
[lyra trust] probe ok · <desktop name> @ 192.168.1.50:53317
[lyra trust] sending pair_request → 192.168.1.50:53317 (wait for Accept)
```

And `lyra-debug.log` exists:

```bash
adb shell run-as app.lyra.sync.dev cat cache/lyra-debug.log | tail -n 100
```

### D. Transfer 25–100 MB file

On **desktop** or **phone** as sender:

- Pick a real file >20 MB: e.g., copy a video or generate one:

```bash
# On host, create a 30 MB fixture
dd if=/dev/urandom of=/tmp/big30.bin bs=1M count=30
# Expose via desktop “Send file” picker or via CLI
```

- In **Lyra app** on sender: **Device detail → Upload files** → pick the 30 MB file. On the receiver you should see:

  - Progress bar increments by ~512 KB steps (mobile sender) / 1 MB (desktop sender).
  - No stall at 20 MB.
  - `adb logcat`:

```
[lyra peer] appendChunk <id> offset=20971520 len=524288 ok via handle
[lyra transfer] progress 25.0 MB/30.0 MB 2.3 MB/s ETA 2.1s
```

- After complete: Check downloaded file:

```bash
# Phone side (native receiver: file:// Downloads/Lyra or content://)
adb shell run-as app.lyra.sync.dev ls -lh cache/lyra-tx-*.bin  # should be gone (moved)
adb shell run-as app.lyra.sync.dev ls -lh ../Lyra/ 2>/dev/null || echo "check Downloads/Lyra"
adb shell ls -lh /storage/emulated/0/Download/Lyra/ | tail
```

Desktop side: look in OS temp or log:

```
[transfer_complete] <id> · 31457280 bytes · 1 file(s) · disk /tmp/lyra-tx-... .bin
```

### E. Verify integrity & speed

- Compare SHA-256 side by side:

```bash
sha256sum /tmp/big30.bin
# On device (via adb shell run-as, if app can expose hash in debug screen)
adb shell run-as app.lyra.sync.dev cat cache/lyra-debug.log | grep checksum
# Or pull downloaded file:
adb pull /storage/emulated/0/Download/Lyra/big30.bin /tmp/pulled.bin
sha256sum /tmp/pulled.bin
# Must match
```

- Expected: `>2 MB/s` on Wi-Fi 5, `~500 KB/s` min on tailnet. The log line `avgSpeed` is checked by bench.

### F. Stress: concurrent + both directions

1. While one 30 MB transfer is in flight, start a second 5 MB transfer the other direction (phone→desktop). Both should succeed — window 3 ensures bridge not saturated.
2. Pause one (desktop UI → **Transfers → Pause**) then **Resume** — verifies `transfer_pause` / `transfer_resume` + `resumeOffset` persisted.
3. For native→node large: On phone, use **Files → Share** to Lyra with 80 MB video — tests `readFileSlice` normalize path (`content://` → `file://` cache copy once, not per chunk).

### G. Collect logs if crash still occurs

If the app disappears without toast:

```bash
# Force full logcat (not filtered)
adb logcat > /tmp/full-logcat.txt &
# Wait for crash, then:
adb logcat -d | grep -A 20 -i "fatal\|exception\|oom\|throw\|lyra"

# Pull persistent debug log (survives restart, in cache)
adb shell run-as app.lyra.sync.dev cat cache/lyra-debug.log > /tmp/lyra-debug.log
cat /tmp/lyra-debug.log | tail -n 200

# Tombstone (native crash)
adb shell ls -lt /data/tombstones | head
adb shell cat /data/tombstones/tombstone_00 | head -n 200

# Memory pressure
adb shell dumpsys meminfo app.lyra.sync.dev | head -n 40
```

Paste `lyra-debug.log` + `full-logcat.txt` excerpt in issue — the new `logger.ts` now logs every binary chunk with `transferId slice offset/len` so we can pinpoint which chunk triggered `gap` or `Disk append failed` or `TransactionTooLarge`.

## 4) What to expect after fix

- **25 MB** single-file transfer completes in ~3–6 s on Wi-Fi (512 KB window 3) without pause; file appears in `Downloads/Lyra` Move (zero copy) — not base64.
- **100 MB** transfers complete without ANR (no 150 KB/s fallback path).
- **Logcat** shows no `No socket with id N` + no `HTTP headers too large` + no `Request too large` for 20 MB (chunks are 512 KB, capped 4 MiB).
- **Persistent log** `lyra-debug.log` contains `appendChunk … ok via handle` for each 512 KB chunk, and final `transfer_complete`.

## 5) Rollback / feature flags

- `adaptiveChunkSize` fallback: pass `preferred` in `wireSendFiles({chunkSize: 256*1024})` to force smaller.
- Disable mobile tuning: `globalThis.__LYRA_FORCE_DESKTOP_CHUNK=1` (not yet, but patch `isReactNative` to return false).

## 6) CI

- `test-native-interop.mjs` is intended for `pnpm test` pre-merge; it skips 80 MB on `CI=true`.
- `transfer-bench.ts` guards `avgSpeed > 800 KB/s` — will fail CI if window regression.
