# Lyra — Agent Progress Report

**Last updated:** 2026-07-19 (CI + packaging closeout)  
**Status:** CI workflows complete · Electron AppImage built · EAS Android preview submitted  
**Plan:** [`docs/GAP-FIX-PLAN.md`](./GAP-FIX-PLAN.md) · **Packaging:** [`docs/PACKAGING.md`](./PACKAGING.md)

---

## Packaging / CI results (this session)

### EAS
- [x] Logged in as `thommysart24`
- [x] Project **@thommysart24/lyra** (`5440becf-0777-4d91-be3b-88ad7f271d5f`)
- [x] Android keystore created on Expo servers
- [x] **Preview Android build submitted** (cloud):  
  https://expo.dev/accounts/thommysart24/projects/lyra/builds/6ae1d211-3d01-493b-8bf5-8c487a3485fa

### Electron
- [x] Local AppImage: `apps/desktop/release/Lyra-0.1.0.AppImage` (~112 MiB)
- [x] Unpacked binary: `apps/desktop/release/linux-unpacked/lyra` (~192 MiB)
- [x] Web UI bundled under `resources/web-dist`

### CI / GitHub
- [x] Fixed pnpm version clash in Actions (`packageManager` only)
- [x] CI jobs: unit, Playwright e2e, Electron Linux package (artifact), Expo web export
- [x] Release workflow: tag `v*` → AppImage GitHub Release (+ optional EAS if `EXPO_TOKEN`)
- [x] Manual `EAS Build` workflow (`workflow_dispatch`)
- [ ] Repo secret `EXPO_TOKEN` — create at expo.dev access tokens, then `gh secret set EXPO_TOKEN`

### Tests
- [x] Unit core/net green (local)

---

## How to run packaged desktop

```bash
# AppImage
./apps/desktop/release/Lyra-0.1.0.AppImage
# Or unpacked:
./apps/desktop/release/linux-unpacked/lyra
# Peer server defaults to :53317
```

Convenience scripts:

```bash
pnpm run pack:desktop          # web build + electron --dir
pnpm run dist:desktop          # web build + electron installers
pnpm run eas:android:preview   # EAS cloud preview APK (needs eas login)
```

---

## Still environment-bound

| Item | Status |
|------|--------|
| GitHub `EXPO_TOKEN` secret | Not set — required for Actions-triggered EAS |
| Code-signed Windows/macOS installers | Needs certs |
| Full Accessibility Service Kotlin | Manifest plugin ready; body after `expo prebuild` |
| Multi‑GB pure browser transfers | Cap 256 MiB materialize; use desktop for huge files |

---

## Agent handoff

1. EAS build: https://expo.dev/accounts/thommysart24/projects/lyra/builds/6ae1d211-3d01-493b-8bf5-8c487a3485fa  
2. Electron: `apps/desktop/release/Lyra-0.1.0.AppImage`  
3. Set `EXPO_TOKEN` for CI-driven mobile builds  
4. Tag release when ready: `git tag v0.1.0 && git push origin v0.1.0`  
