# Packaging & release notes

## CI & GitHub Releases

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | push / PR | Unit tests, Playwright e2e, Electron Linux package (artifact), Expo web export |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | tag `v*` or manual | Publish Linux **AppImage** to a GitHub Release; optional EAS Android preview if `EXPO_TOKEN` is set |
| [`.github/workflows/eas-build.yml`](../.github/workflows/eas-build.yml) | manual | Kick off an EAS cloud build (`development` / `preview` / `production`) |

### Required secrets

| Secret | Used by | How to set |
|--------|---------|------------|
| `EXPO_TOKEN` | `eas-build.yml`, optional job in `release.yml` | Create at [expo.dev/settings/access-tokens](https://expo.dev/settings/access-tokens), then `gh secret set EXPO_TOKEN` |

`GITHUB_TOKEN` is provided automatically for release uploads.

### Tag a release

```bash
git tag v0.1.0
git push origin v0.1.0
# or: gh workflow run Release -f tag=v0.1.0 -f prerelease=true
```

---

## EAS (mobile)

**Linked project**

| Field | Value |
|-------|--------|
| Account | `thommysart24` |
| Project | [@thommysart24/lyra](https://expo.dev/accounts/thommysart24/projects/lyra) |
| Project ID | `5440becf-0777-4d91-be3b-88ad7f271d5f` |
| Config | `apps/native/app.json` → `extra.eas.projectId` |

```bash
cd apps/native
eas build --profile development --platform android
eas build --profile preview --platform android
eas build --profile production --platform android
# or iOS after Apple credentials are configured
eas build --profile development --platform ios
```

Clipboard Accessibility plugin (manifest scaffold):

```json
"./plugins/with-clipboard-accessibility"
```

See `apps/native/plugins/README.md` for Kotlin service work remaining after `expo prebuild`.

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
