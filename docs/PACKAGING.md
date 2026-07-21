# Packaging & release notes

## CI & GitHub Releases

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | push / PR | Unit tests, Playwright e2e, Electron Linux package (artifact), Expo web export |
| [`.github/workflows/android-build.yml`](../.github/workflows/android-build.yml) | manual (`dev` / `preview`) or tag `v*` | **Android APK on GitHub Actions** (no EAS) → Actions artifact |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | tag `v*` or manual | Publish Linux **AppImage** to a GitHub Release |
| [`.github/workflows/eas-build.yml`](../.github/workflows/eas-build.yml) | manual | Optional EAS cloud build (needs paid EAS + `EXPO_TOKEN`) |

### Android APK via GitHub Actions (recommended without EAS)

```bash
# Trigger from CLI (needs gh auth)
pnpm run ci:android:preview
pnpm run ci:android:dev

# Or: GitHub → Actions → "Android Build" → Run workflow → profile preview|dev
```

Download the APK from the workflow run **Artifacts** (`lyra-android-preview` or `lyra-android-dev`).  
Release builds use the debug keystore checked into the Expo android project (fine for sideloading / internal testing).

No extra secrets required beyond default `GITHUB_TOKEN`.
### Tag a release

```bash
git tag v0.1.0
git push origin v0.1.0
# or: gh workflow run Release -f tag=v0.1.0 -f prerelease=true
```

---

## Mobile (Android)

Requires Android SDK (`ANDROID_HOME`). Profiles: **dev** (debug) and **preview** (release APK).

### Local (uses existing `apps/native/android`)

| Command | Output |
|---------|--------|
| `pnpm run build:dev` | Debug APK (`assembleDebug`) |
| `pnpm run build:preview` | Release APK (`assembleRelease`) |
| `pnpm run install:dev` | `adb install` debug APK |
| `pnpm run install:preview` | `adb install` release APK |

```bash
pnpm run build:preview
pnpm run install:preview
# apps/native/android/app/build/outputs/apk/release/app-release.apk
```
### EAS cloud (optional)

Only if you still use Expo Application Services:

```bash
pnpm run eas:dev
pnpm run eas:preview
```

Clipboard Accessibility plugin: `./plugins/with-clipboard-accessibility` — see `apps/native/plugins/README.md`.

---

## Desktop (Electron)

### Dev

```bash
pnpm run dev:web                 # UI :3001
pnpm --filter desktop dev        # shell + peer + multicast
```

### Local package (verified)

```bash
pnpm --filter web build
pnpm --filter desktop build:electron
pnpm --filter desktop pack       # → apps/desktop/release/linux-unpacked/lyra
```

Produced (example):

- `apps/desktop/release/linux-unpacked/lyra` — runnable binary
- `resources/web-dist/` — packaged web UI
- `resources/app.asar` — main process

Optional installers:

```bash
pnpm --filter desktop dist                 # platform defaults
pnpm --filter desktop exec electron-builder --linux AppImage
```

Environment:

| Variable | Purpose |
|----------|---------|
| `LYRA_PORT` | Peer listen port |
| `LYRA_TLS=1` | HTTPS self-signed (openssl) |
| `LYRA_NAME` | Device display name |
| `LYRA_WEB_URL` | Dev renderer URL |

First-time Electron download may need:

```bash
pnpm approve-builds   # if pnpm blocks postinstall scripts
cd node_modules/.pnpm/electron@*/node_modules/electron && node install.js
```

### Signing

Store-ready **code signing** (Apple Developer / Windows Authenticode) is not configured in-repo. Local `pack` produces an **unsigned** Linux build suitable for testing.

---

## Peer server (headless)

```bash
pnpm peer-server
LYRA_TLS=1 pnpm peer-server
LYRA_DISCOVERY=0 pnpm peer-server
```

---

## Security defaults

| Layer | Default |
|-------|---------|
| Identity | ECDSA P-256 |
| Post-pair payloads | AES-GCM seal (`authSecret`) |
| Transport | HTTP LAN; optional HTTPS via `LYRA_TLS` |
| Demo mesh | Dev only (`seedDemo`) |
| Large browser files | Streamed materialize ≤256 MiB; larger needs desktop path |
