# Lyra — Agent Progress Report

**Last updated:** 2026-07-22 (screen mirror + Tailscale addresses)  
**Status:** Screen mirror (demo bezel + scrcpy path) · Tailscale IP first-class UI · unit/e2e green  
**Plan:** [`docs/GAP-FIX-PLAN.md`](./GAP-FIX-PLAN.md) · **Packaging:** [`docs/PACKAGING.md`](./PACKAGING.md)

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
