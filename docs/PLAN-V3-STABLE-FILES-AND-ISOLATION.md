# Plan V3 — Stable Android Files, Platform Isolation, Device-Lab Testing

Status: Plan — no code changes yet
Goals as requested plus reminders of gaps still open

## 1. Goals you listed

1. **Stable Android file management** — pick, copy, hold, stream without per-chunk reopen or mid-transfer eviction.
2. **Isolate web vs native code** — web never sees native deps at build time, native never sees web shims.
3. **Test lab that matches your experience** — Android Studio AVD + physical Pixel 6, large videos, real `content://` URIs, background/foreground, same Wi-Fi.

## 2. What you may have missed — reminders

- **Receiver keep-alive for desktop → mobile**: phone HTTP server must stay listening when app is backgrounded. Current foreground service starts but is not proven to survive Doze. Needs AVD test with app backgrounded.
- **Candidate probing parity**: desktop must find phone on its variant port (`53319` vs `53327` etc.) even when `lastReachableHost` is stale. `LyraConnectionManager` exists but is not yet wired into `wireSendFiles` / `ensureSession`.
- **Web alias is a workaround, not isolation**: `apps/web/src/stubs/*` hides the coupling but the shared `peer-ops` still contains native branches that Vite has to parse. True isolation removes the branches.
- **Large-file fallback was disabled**: `>5 MB` had no recovery beyond the new File API. A chunked legacy fallback is needed.
- **Preview vs dev parity**: both share the same JS bug, so switching build type alone would not fix the 1.5 MB failure. The fix must land in the JS bundle used by both.

## 3. Stable Android file handling (what will change)

**Picker always requests a stable copy:**
- `DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false })` and `ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos','images'], copyToCacheDirectory: true })` for every entry point (`index`, `transfers`, `device/[id]`). Remove any `false` default.
- If a `content://` still arrives (third-party picker, share intent), do not trust it for chunked reads.

**One-time copy + held handle:**
- On send start, in the native reader only, if URI scheme is `content://`, immediately `File.copy` to `Paths.cache/lyra-send-<transferId>-<safeName>` or open via `ContentResolver` and stream to that temp file. Persist `FLAG_GRANT_READ_URI_PERMISSION` via `ContentResolver.takePersistableUriPermission` where available.
- Open one `FileHandle` (`File.open('r')` or `readAsStringAsync` with handle) and keep it for the whole transfer. Serve chunks by `readBytes(len)` / `slice(offset, offset+len)` on that handle. Close only on `transfer_complete` / `cancel`. No per-chunk `new File()` and no per-chunk `exists` probe.
- Do not re-verify `exists` per chunk. If a read returns 0 bytes before EOF, treat as eviction and once try to re-copy from original URI, then fail with actionable message.

**Fallbacks ordered for native:**
1. Held `FileHandle.readBytes` (true streaming, OOM-safe to 300 MB)
2. `File.slice(offset, len).arrayBuffer` on the cached `file://`
3. Legacy `readAsStringAsync({position, length, encoding: Base64})` chunked (not whole-file) — now enabled for all sizes

Web reader stays separate and only uses `File.slice`.

**Cleanup:** delete temp cached copy on `transfer_complete` / `failed` / app background eviction via `AppState` or `File.delete` in `finally`.

## 4. Platform isolation (how)

Keep a tiny common interface, no platform imports in it:

```
packages/fs/
  index.ts              — export interface FileReader { open(uri): Promise<Handle>; read(offset,len): Promise<Uint8Array>; close(): Promise<void>; }
  reader.web.ts         — uses browser File
  reader.native.ts      — uses expo-file-system File/FileHandle/ContentResolver
  reader.android.ts     — optional extra for SAF on Android 11+ if needed
```

Metro resolves `reader.native.ts` for `native`, Vite resolves `reader.web.ts` for `web` (via `package.json` `react-native` field or explicit `resolve.alias` removed — no stubs needed). `core/peer-ops` and `net/logger` will import from `packages/fs` instead of directly importing `expo-file-system`. No `new Function('return import(...)')` dance.

Delete `apps/web/src/stubs/*` after split. `vite.config.ts` returns to only `undici` external. No `expo-*` alias.

## 5. Test lab that matches your Pixel 6 on Wi-Fi

**Environment:**
- Android Studio AVD `Pixel_6_API_36` (already installed system image) plus your physical Pixel 6 via Wi-Fi ADB (`adb connect 192.168.1.132:5555` or USB).
- Both devices on `192.168.1.0/24`, same as your `192.168.1.152` desktop. No emulator loopback.

**New automated suite (runs on emulator, not just Node):**
- `maestro` or `detox` flow: launch app, grant media permissions, tap Send, pick a real video from gallery (20, 40, 64 MB) with `copyToCacheDirectory` true and false variants, send to desktop peer `My Computer`, assert `Completed` and `verified` on both sides, check `adb logcat | grep lyra` for `binary chunk` progression.
- Background test: start transfer, press home, assert phone server still answers `GET /lyra/info` from desktop via `probePeer`.
- Network test: desktop `scanLanForPeers` from `192.168.1.152` must find phone at `192.168.1.132:53319` with variant port matrix, and `wireSendFiles` desktop→mobile must complete without `Failed to fetch`. Run with phone screen off.
- File-eviction test: mock `File` to return null on third read to force legacy chunked fallback path.

**Existing Node benches remain** for speed regression, but are labeled `loopback` not `device`.

## 6. Verification checklist

- `pnpm --filter web exec vite build` and `vite dev` on `3001` with no `expo-file-system` in graph (`grep -r expo-file-system apps/web/dist` empty)
- `pnpm --filter native exec tsc` for both web and native entry points
- Emulator: `maestro test suite` 3 large videos each direction `mobile→desktop` and `desktop→mobile` all `Completed`, avg >3 MB/s on Wi-Fi (not loopback)
- Physical Pixel 6: same manual test you did, plus `adb logcat` shows no `Cannot read property 'File' of null`

## 7. Risks

- `expo-file-system` File API `open/readBytes` is still relatively new; if emulator shows it still drops the handle, fallback to legacy chunked read must be proven.
- Persisting `content://` permission requires `Intent.FLAG_GRANT_READ_URI_PERMISSION` — not all pickers set it. The one-time cache copy is the safer default.
- Foreground service on Android 14+ requires `FOREGROUND_SERVICE_DATA_SYNC` and notification — already added via plugin, but needs emulator background test.

## 8. Next step when you approve

Implement `packages/fs` split, remove stubs, wire native reader into `core/peer-ops`, wire `LyraConnectionManager` into store, rebuild dev APK (`pnpm run build:dev`) and install on AVD + Pixel 6, then run the new device lab suite.
