# Lyra — Agent Progress Report

**Last updated:** 2026-07-24 (mobile→desktop pair long-poll + TCP transport)  
**Status:** Dev/preview/prod side-by-side · mobile outbound pair path fixed · unit green  
**Plan:** [`docs/GAP-FIX-PLAN.md`](./GAP-FIX-PLAN.md) · **Packaging:** [`docs/PACKAGING.md`](./PACKAGING.md)

---

## 2026-07-24 — Phone cannot discover/pair (desktop sees phone)

### Symptoms
- Desktop Pair A: discovery + Tailscale scan **see the phone**
- Phone: discovery/Tailscale find **nothing** (no error toast)
- Manual LAN/Tailscale add then Pair → **“Timed out waiting for accept”** even though host never showed a banner

### Root causes
1. **Pair long-poll killed at ~15s** — native TCP transport used a hard 15s timeout whenever `AbortSignal` was set. `sendPairRequest` waits up to 120s for Accept, so the socket was destroyed long before the host could accept. Errors were **mislabeled** as “waiting for accept”.
2. **TCP module default export** — Metro may expose `react-native-tcp-socket` as `{ default: { Socket, … } }`; bare `.Socket` lookup could fall through / fail, leaving **fetch** for cleartext (unreliable on Android).
3. **Transport not shared across Metro copies** of `@lyra-sync-app/net` — fixed via `globalThis` singleton.
4. **Trust used a single host** — now probes full LAN/Tailscale/port candidate matrix.

### Fixes
- Long-poll `timeoutMs = waitMs + 10s`; safety net 180s when only signal
- Resolve Socket/createConnection via `mod.default ?? mod`
- Prefer `interface: "wifi"` for private LAN IPs on Android (Tailscale default route)
- Honest errors: early timeout = “could not reach peer”; late = “waiting for accept”
- Request logging on desktop Node peer server + native peer server + pair_request banners
- Discovery toast includes seeds/ports when 0 peers found

### Rebuild
```bash
pnpm run build:dev && pnpm run install:dev
# restart pair-a desktop so main-process logging is live
```

### Trace
- Phone logcat: `[lyra tcp]`, `[lyra trust]`, `[lyra pair]`, `[lyra discover]`
- Desktop terminal: `[lyra peer] POST /lyra/message … pair_request`, `[lyra] pair_request UI ←`

---

## 2026-07-24 — Mobile discovery still broken (root cause + fix)

### Why Refresh / Scan Tailscale still found 0 devices
1. **Timeout burned while waiting for a TCP slot** — native transport caps concurrent sockets (`MAX_IN_FLIGHT ≈ 8`), but LAN scan fired AbortController at t=0 with concurrency 40. Most `/lyra/info` probes aborted *before* they ever connected, so almost the entire /24 was skipped.
2. **Tailscale-only local IP killed LAN expansion** — `expo-network` often returns the Tailscale `100.x` address. That seed is exact-only (no /24 expand) and is also self-skipped → **zero scan candidates** when no paired peers exist yet. Common home LAN guesses only ran when `seeds.size === 0`, which was false.
3. **Port matrix missed multi-instance desktops** — LocalSend holds `53317`; Lyra Dev often binds `53319`/`53321`. Scan only tried 3 ports and full /24 missed `+4`.

### Fixes
- Transport-level `timeoutMs` starts **after** a socket slot is acquired; queue wait no longer aborts probes
- Native TCP slot wait respects AbortSignal without consuming the request budget
- `scanLanForPeers`: exact seeds + gateways get full port matrix; /24 uses expand ports including `53317/19/21/27`
- `refreshDiscovery`: if no private LAN seed, always add `192.168.1.1` / `192.168.0.1` / `10.0.0.1` for /24 walk
- Pairing code join uses multi-port candidates; endpoint matrix includes variant + steal ports
- Live verified: seed `192.168.1.50` finds desktop `192.168.1.152:53321` (~8s)

### Rebuild required (mobile)
```bash
pnpm run build:dev && pnpm run install:dev
```

---

## 2026-07-23 — Mobile discovery / clipboard / transfer wire path

### Why it was broken
- **Discovery only probed `device.host`** — stale LAN IPs marked peers offline even when Tailscale still worked; mobile “Refresh” / “Scan Tailscale” reported 0 while desktop (UDP + HTTP) still saw the phone.
- **Optimistic clipboard toast** claimed “sent (wire)” before the POST finished.
- **Native HTTP peer server** compared `Content-Length` (bytes) to UTF-8 **string** length and could hang on non-ASCII / multi-chunk bodies → desktop `Failed to fetch` into the phone.
- **Android cleartext** lived only on the debug manifest; release/preview and post-prebuild main manifests blocked LAN/Tailscale HTTP.

### Fixes
- Multi-endpoint probe matrix (LAN + Tailscale + port fallbacks) on discovery and `ensureSession`
- Remember the host:port that actually answered after clipboard/transfer
- Byte-safe native TCP HTTP parser + larger body limit + flush-before-close
- `usesCleartextTraffic` + `network_security_config` on **main** + Expo config plugin
- Honest clipboard success/failure toasts

### Rebuild required (mobile)
```bash
pnpm run build:dev && pnpm run install:dev
# or preview/release via EAS
```

### 2026-07-23 follow-up — clipboard / transfer wire still broken after discovery fix
- RN `fetch` POST to cleartext LAN/Tailscale peers often fails while GET works → **TCP HTTP client** via `react-native-tcp-socket` for all peer ops on native
- `ensureSession` now **probe-first**, sticky `lastReachableHost/Port`
- Trust recheck no longer **unpairs** when POST auth fails with network errors after GET succeeded
- Native server body parsing hardened (Content-Length / missing CL)

---

## 2026-07-22 — Screen mirror: separate windows + real capture

### Why it was broken
- Desktop **accepted** P2P `screen_share_request` but never captured or sent frames
- `lyra:screen-frame` was never exposed on preload / wired into the store
- Mirrors only rendered inline (no dedicated window)

### What works now
- **Dedicated mirror window** (Electron `BrowserWindow` or browser popup) with phone/desktop sizing + aspect ratio
- **Route** `/mirror/$deviceId` (no sidebar chrome)
- **BroadcastChannel** sync so demo/P2P frames appear in the mirror window
- **Desktop as source:** permission dialog → `getDisplayMedia` via Electron `setDisplayMediaRequestHandler` + `desktopCapturer` → JPEG frames over peer protocol
- **Android / scrcpy:** ADB preflight (`lyra:check-adb`), checklist UI, scrcpy window sized ~400×860
- Incoming frames + scrcpy exit errors surface in the session UI

### Permissions workflow
| Role | What is requested |
|------|-------------------|
| Desktop source | In-app “Share your screen?” → system display picker (Electron grants display-capture) |
| Desktop viewer of Android | Wireless debugging + `adb connect` + `scrcpy` on PATH |
| Demo | No permissions — synthetic bezel frames |

---

## 2026-07-22 — App variants + versioned APKs / desktop

### Mobile
- `app.config.ts` + `APP_VARIANT` → distinct package IDs (`app.lyra.sync.dev` / `.preview` / prod)
- Version owned by `apps/native/package.json` → **0.2.3** (`versionCode` 2003)
- Builds emit `apps/native/dist/lyra-0.2.3-dev.apk` (etc.); install scripts pick them up

### Desktop (Electron)
- `LYRA_VARIANT` → Lyra Dev / Preview / Prod · separate `userData` + appId + peer ports (53317 / 53327 / 53337)
- Version **0.2.3** · artifacts `release/Lyra-0.2.3-{dev|preview|prod}.AppImage`
- Scripts: `dev:desktop`, `dev:desktop:preview`, `dist:desktop:dev`, …

```bash
pnpm run build:dev && pnpm run install:dev
pnpm run dev:desktop            # Lyra Dev
pnpm run dev:desktop:preview    # side-by-side Preview
```

---

## 2026-07-22 — Native peer server + CLEARTEXT / discovery UX

### Root causes fixed
- **Release APK blocked cleartext HTTP** → Tailscale pair failed with `UnknownServiceException: CLEARTEXT…`. Main `AndroidManifest` lacked `usesCleartextTraffic` (only debug had it). Added manifest flag + `network_security_config.xml`.
- **Mobile never started a peer server** → Settings showed “Browser / Expo web” + “Discovery off”. Native now starts TCP peer server (`react-native-tcp-socket` + shared `peer-http-core`) on dev/preview builds.
- **False “Expo Go cannot host pairing code”** on every native build → `isExpoGo` was `!peerRunning && android/ios`. Now uses `Constants.appOwnership` / executionEnvironment.
- **Desktop port steal on multi-instance** → peer listen falls back through `LYRA_PORT+2…` when EADDRINUSE.

### Rebuild required
```bash
pnpm run build:dev     # or build:preview / EAS
pnpm run install:dev
```
Expo Go still cannot host a peer server (no native TCP module).

---

## 2026-07-22 — Screen mirror + Tailscale

### Screen sharing (Sefirah-inspired / Xcode-style bezel)
- Protocol: `screen_share_request|accept|reject|stop` + `screen_frame`
- Core store: `startScreenMirror` / `stopScreenMirror` / `ingestScreenFrame`
- High-quality demo frames inside phone/desktop chrome (`DeviceFrame`, `ScreenMirrorPanel`)
- Desktop: optional `scrcpy` spawn via IPC (`lyra:start-scrcpy`) using ADB serial or Tailscale `host:5555`
- Web + native device detail: mirror controls + live frame preview

### Tailscale
- Dedicated **Add by Tailscale IP** card on Devices (`100.x` / MagicDNS)
- Per-device **Connection addresses** (LAN + Tailscale + prefer path + ADB serial)
- `tailscalePeerHints` + `updateDeviceAddress` + `Scan Tailscale`
- Verified local tailnet present (`100.114…` / `pixel-6 100.83…`)

---

## Packaging / CI results (this session)

### EAS
- [x] Project **@thommysart24/lyra** (`5440becf-0777-4d91-be3b-88ad7f271d5f`)
- [x] Android keystore on Expo servers
- [x] Accessibility plugin now writes XML + Kotlin stub (fixes Gradle missing-resource fail)
- [x] Preview build re-submitted:  
  https://expo.dev/accounts/thommysart24/projects/lyra/builds/a1f65ecc-20e7-443a-9f53-d29c5d5941f9  
- Prior build `6ae1d211-…` errored (missing accessibility resources) — superseded

### Electron
- [x] Local AppImage: `apps/desktop/release/Lyra-0.1.0.AppImage` (~112 MiB)
- [x] GitHub prerelease: `v0.1.0-desktop` with AppImage asset
- [x] CI job uploads Linux package as Actions artifact

### CI / GitHub
- [x] CI green: unit · Playwright e2e · Electron package · Expo export
- [x] Workflows: `ci.yml`, `release.yml` (tag `v*`), `eas-build.yml` (manual)
- [x] Fixed: pnpm version clash, Electron sandbox check, demo seed via `import.meta.env`, e2e locators
- [ ] Repo secret `EXPO_TOKEN` for Actions-triggered EAS (`gh secret set EXPO_TOKEN`)

### Tests
- [x] Unit + e2e green (local and CI)

---

## How to run packaged desktop

```bash
./apps/desktop/release/Lyra-0.1.0.AppImage
# or: ./apps/desktop/release/linux-unpacked/lyra
```

```bash
pnpm run pack:desktop
pnpm run dist:desktop
pnpm run prebuild:native       # expo prebuild → apps/native/android
pnpm run build:dev             # local debug APK (needs ANDROID_HOME)
pnpm run build:preview         # local release APK
pnpm run ci:android:preview    # GitHub Actions APK artifact (no EAS)
```

---

## Still environment-bound

| Item | Status |
|------|--------|
| EAS cloud GraphQL flakiness | Retry; fingerprint skip helps |
| GitHub `EXPO_TOKEN` | Not set |
| Code-signed Win/mac installers | Needs certs |
| Accessibility clipboard extraction | Stub compiles; real capture still TODO |

---

## Agent handoff

1. EAS: https://expo.dev/accounts/thommysart24/projects/lyra/builds/a1f65ecc-20e7-443a-9f53-d29c5d5941f9  
2. Desktop release: `gh release view v0.1.0-desktop`  
3. Tag full release: `git tag v0.1.0 && git push origin v0.1.0`  
4. Optional: `gh secret set EXPO_TOKEN` for CI mobile builds  
