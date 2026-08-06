# Lyra v2

Privacy-first, peer-to-peer device network — **file sharing + clipboard sync** over LAN and Tailscale. No accounts, no cloud.

> **Branch:** `feat/lyra-v2` — reboot from `df07d3d`. See `docs/ARCHITECTURE-v2.md` for full plan.

## Architecture (v2)

- **Desktop = Server** — Electron daemon owns HTTP peer server + UDP multicast discovery + FS + clipboard monitor.
- **Mobile = Client** — Expo prebuild (dev builds), `NativeTcpTransport` + `expo-secure-store`. No multicast walk unless user taps Scan LAN.
- **Protocol** `packages/protocol` — Zod schemas only, `lyra/2` envelope + AES-GCM seal when paired.
- **Transport** `packages/transport` — `PeerTransport` interface (`NodeHttpTransport`, `NativeTcpTransport`).
- **Discovery** `packages/discovery` — Node dgram `239.255.255.250:53317` + bonjour `_lyra._tcp` + `tailscale status --json` relay.
- **Daemon** `packages/daemon` — `startPeerServer` (`/lyra/info`, `/lyra/pair` 60s long-poll, `/lyra/message` sealed, `/lyra/file/chunk` streaming to `os.tmpdir()` for >2 GB resumes).
- **Core** `packages/core` — sliced store (`identity`, `pairing`, `discovery`, `transfers`, `clipboard`) — pure, no IO.
- **Web** `apps/web` — Vite+TanStack embedded in Electron `resources/web-dist`.

## Project Structure

```
apps/
  desktop/   Electron shell (thin, delegates to daemon) — variants dev/preview/prod (53317/53327/53337)
  web/       Vite frontend (embedded)
  native/    Expo mobile (prebuild android)
packages/
  protocol/  Zod schemas, envelope
  transport/ PeerTransport
  discovery/ multicast + tailscale
  daemon/    peer HTTP server, FS, seal
  core/      sliced store + identity
  hooks/     useLyra
  ui/        shadcn/ui
docs/
  ARCHITECTURE-v2.md  Full reboot plan
```

## Getting Started

```bash
pnpm install
pnpm run check-types   # 9/9 packages should pass
pnpm run dev           # turbo dev (web + native)
pnpm run dev:desktop            # Lyra Dev (53317)
pnpm run dev:desktop:preview    # Lyra Preview side-by-side (53327)
# two local desktops for pairing test:
pnpm run dev:pair-a & pnpm run dev:pair-b
```

## Variants

`LYRA_VARIANT=development|preview|production` → `appId app.lyra.desktop{.dev,.preview}`, `userData lyra-desktop{-dev,-preview}`, port `53317/53327/53337`. Mobile `APP_VARIANT` similarly.

## iOS Note (recommendation)

Receive-only clipboard, manual Send. No background poll (system restriction, Spec §5.3). Labeled in UI.

## Screen Mirror

Deprecated in v2 — stabilize file/clipboard first.

## Deployment

`pnpm run build` — turbo build. Desktop packaging via `electron-builder` (AppImage/dmg/nsis) when re-enabled in P6.

## Legacy

Old God-store/net on `feature/screen-mirror-tailscale` — stashed as `pre-v2 stash`.
