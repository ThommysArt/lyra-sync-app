# Lyra

Privacy-first, cross-platform device network: clipboard sync, file transfer, remote browse, and pairing — no accounts or cloud required.

Built from the product spec in [`docs/Lyra-Product-Spec.md`](docs/Lyra-Product-Spec.md).

## Stack

| Surface | Tech |
|--------|------|
| Desktop / web | Vite + TanStack Router + **shadcn `base-luma`** (blue theme, fully rounded) |
| Mobile | Expo + HeroUI Native + Uniwind + Chrona-style **floating tab bar** |
| Shared domain | `packages/protocol` (Zod schemas) + `packages/core` (store, identity, demo mesh) |

## Getting started

```bash
pnpm install
pnpm run dev:web      # http://localhost:3001  (canonical — free the port if Vite jumps to 3002)
pnpm run dev:native  # Expo (use `pnpm web` in apps/native for Expo web → :8081)
```

### Free stuck ports (common after agent sessions)

```bash
fuser -k 3001/tcp 2>/dev/null || true
fuser -k 8081/tcp 2>/dev/null || true
```

### Agent browser (T3 Code)

Agents should drive the **T3 Code collaborative preview**, not ad-hoc Playwright, when working from the T3 desktop app. Full procedure, auth model, and failure fixes:

→ **[`docs/T3-CODE-BROWSER.md`](docs/T3-CODE-BROWSER.md)**

**Critical:** `t3-code` MCP uses a **session Bearer** (30m idle timeout). Long chats without browser use fail with `Auth required` until you **start a new agent thread**.

## Project layout

```
apps/
  web/           # Desktop UI (TanStack Router)
  native/        # Expo mobile (floating tab bar)
packages/
  protocol/      # Shared Zod protocol / device / transfer schemas
  core/          # Identity, pairing, clipboard, transfers, remote FS demo
  ui/            # shadcn base-luma components + blue tokens
  env/ config/   # Env validation + TS base config
docs/
  Lyra-Product-Spec.md
```

## Features (MVP UI + demo mesh)

- Device list with online status, battery, network, connection type
- Pairing: QR placeholder + pairing code + confirm/reject incoming
- Clipboard history (pin, resend, clear) + send to all online
- Transfers with progress, pause / resume / cancel, history
- Remote file browser with smart folder shortcuts
- Open URL on other devices
- Per-device settings (auto-accept, nickname, unpair)
- Local-only persistence (`localStorage` on web)

Real UDP multicast / local HTTP servers are not wired yet — the core store and Zod protocol are structured so networking can plug in without rewriting the UI.

## Theme

- **Web:** `packages/ui` uses **base-luma** geometry (`rounded-4xl` buttons) with a **blue** brand in `globals.css`
- **Native:** matching blue accent (`#2F6BFF` / `#7AA2FF`), Manrope, floating liquid-glass tab bar from Chrona

## Scripts

- `pnpm run dev` — all apps
- `pnpm run dev:web` / `pnpm run dev:native`
- `pnpm run build` — turbo build
- `pnpm run check` — Biome
- `pnpm run check-types` — TypeScript across packages
