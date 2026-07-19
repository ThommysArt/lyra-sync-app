# Lyra Desktop (Electron)

Hosts the **local HTTP(S) peer server** and **UDP multicast discovery**, and loads the web UI.

## Prerequisites

```bash
# Terminal 1 — web UI
pnpm run dev:web   # http://localhost:3001

# Terminal 2 — desktop shell
pnpm --filter desktop dev
```

## Single-PC pairing test (no phone / Android)

### Automated (fastest)

```bash
pnpm test:pair
```

Spins up two peer servers on localhost, runs the real **show code → enter code → accept** path, and exits. No UI.

### Two desktop windows on this machine

```bash
# Terminal 1 — shared web UI
pnpm run dev:web

# Terminal 2
pnpm run dev:pair-a   # Computer A · port 53317

# Terminal 3
pnpm run dev:pair-b   # Computer B · port 53319
```

Then in **A**: Pair → Show code. In **B**: Enter code → Start pairing. Accept on **A**.

Uses `LYRA_ALLOW_MULTI=1` + separate `userData` so both windows keep their own identity.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `LYRA_WEB_URL` | `http://localhost:3001` | Renderer URL |
| `LYRA_PORT` | `53317` | Peer HTTP(S) listen port |
| `LYRA_NAME` | `Lyra Desktop` | Device display name |
| `LYRA_TLS` | unset | Set `1` to enable HTTPS with self-signed cert (requires `openssl` on PATH) |
| `LYRA_ALLOW_MULTI` | unset | `1` = allow second Electron window (pairing tests) |
| `LYRA_INSTANCE` | unset | Isolates `userData` (`a` / `b`) so two windows don’t share state |

## IPC bridge (`window.lyraDesktop`)

- `getPeerStatus()` — running / port / discovery
- `restartNetworking()` — restart peer server + multicast
- `syncTrustedPeers(peers)` — push paired `authSecret`s into main process
- `setPairingOffer({ code, token, expiresAt })` — advertise code hash on `/lyra/info`
- `scanTailscale()` — MagicDNS / `tailscale status --json` peers
- `quit()` — app.quit (Mod+Q)
- Events: `onPeerStatus`, `onDiscoveredPeer`, `onPairRequest`, `onUnpaired`, `onClipboardPush`, `onTailscalePeers`

The web app detects `window.lyraDesktop` and updates Settings → Network accordingly.

## Packaging

```bash
# Prepare dist-electron/
pnpm --filter desktop build:electron

# Optional: install electron-builder (devDependency) then:
pnpm --filter desktop pack   # unpacked dir under release/
pnpm --filter desktop dist   # platform installers
```

First-time Electron install may need:

```bash
pnpm approve-builds
```

Packaged builds still expect a built web UI (`apps/web` dist) or `LYRA_WEB_URL` for development.

## Security notes

- Private key is held in memory; `safeStorage` encrypt is prepared for future cold persistence.
- When `LYRA_TLS=1`, peer server uses HTTPS self-signed certs; clients must trust the fingerprint or use app-level AES-GCM seal (default after pairing).
