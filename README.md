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

## Testing guide (for agents)

Use this after UI/store changes. Product context: [`docs/Lyra-Product-Spec.md`](docs/Lyra-Product-Spec.md). Progress / last verification notes: [`docs/AGENT-PROGRESS.md`](docs/AGENT-PROGRESS.md).

### 1. Headless smoke (no browser)

```bash
cd apps/web && pnpm exec tsx scripts/smoke-render.mjs
```

Expect **selector stability PASS**. Catches the classic `useSyncExternalStore` infinite re-render (`Maximum update depth exceeded` / “getSnapshot should be cached”).

Also useful after larger edits:

```bash
pnpm run check-types
pnpm run check
```

### 2. Dev servers (fixed ports)

| App | Command | Port |
|-----|---------|------|
| Web | `pnpm run dev:web` | **3001** |
| Expo web | `cd apps/native && CI=true pnpm exec expo start --web --port 8081 --clear` | **8081** |

```bash
# Free stragglers from previous agent sessions
fuser -k 3001/tcp 2>/dev/null || true
fuser -k 8081/tcp 2>/dev/null || true

# Confirm listeners
ss -tlnp | grep -E ':3001|:8081' || true
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/
```

If Vite binds **3002**, something still owns 3001 — free it and restart. For Expo, wait until the log shows `Web Bundled` (cold Metro can take ~60s).

### 3. T3 Code collaborative browser

Agents launched **from T3 Code** should drive the in-app preview via MCP — not ad-hoc Playwright.

Full auth model, failures, and tool list: **[`docs/T3-CODE-BROWSER.md`](docs/T3-CODE-BROWSER.md)**.

**Critical**

- `t3-code` uses a **session Bearer** (idle **30 minutes**). Long chats without MCP use fail with `Auth required` → human must **start a new agent thread**.
- Listing tools ≠ authenticated. Use `search_tool` → `use_tool` with qualified names `t3-code__preview_*`.
- Prefer **`environment-port`** for local apps (not raw `localhost` in remote environments).

**Call order**

```
1. search_tool            query: "t3-code preview"
2. t3-code__preview_open  { show: true }
3. t3-code__preview_navigate
     { target: { kind: "environment-port", port: 3001, path: "/" } }
   # Expo: port 8081; cold start may need readiness: "domContentLoaded"
   # or a second attempt after Metro finishes bundling
4. t3-code__preview_wait_for  { text: "Devices", timeoutMs: 15000 }
5. t3-code__preview_snapshot  {}   # tree + console diagnostics
6. interact: click / type / press / evaluate
```

Human shortcut: **Mod+Shift+J** toggles the preview panel.

### 4. Web checklist (`:3001`)

Verify no “Maximum update depth” in console (Vite HMR debug only is fine).

| Step | What to do | Pass criteria |
|------|------------|---------------|
| Shell | Land on Devices | 3 demo peers, search, bottom nav (Devices / Clipboard / Transfers / Settings) |
| Pair | **Pair device** → Generate pairing code | Code + fingerprint + QR (`role=img` “Pairing QR code”); Enter code tab has input + **Simulate incoming request** |
| Transfers | Open Transfers | Active progress + history rows |
| Conflict | **Demo conflict** | Banner + row actions: Skip / Rename / Overwrite; resolve one path |
| Settings | Open Settings | Device name, fingerprint, defaults toggles, paired list, **Keyboard shortcuts** cheat sheet |
| Clipboard | Open Clipboard | History items; Read system / Send to all (or equivalent) |
| Shortcut | Ctrl/Cmd+K | Focuses “Search devices…” (often routes to `/`) |

**Web automation tips**

- Prefer snapshot locators: `role=button[name='…']`, `role=link[name='…']`.
- Duplicate labels (e.g. two **Rename** buttons) need a more specific CSS selector.
- Conflict demo also: download a conflicting PDF from remote FS, or Transfers → **Demo conflict**.

### 5. Expo web checklist (`:8081`)

| Step | What to do | Pass criteria |
|------|------------|---------------|
| Shell | Devices + floating tab bar | Demo peers, battery/status, **Send clipboard to all online**, pair control in header |
| Pair | Open pair screen → **Tap to generate** | Pairing code + fingerprint; paste-QR path still present |
| Incoming | **Simulate incoming request** → Accept | New device (e.g. Incoming Laptop) appears in list |
| Transfers | Tab → **Conflict** → Rename/Skip/Overwrite | Banner + row; rename ends as completed (`report (1).pdf`-style name) |
| Settings | Tab Settings | Fingerprint, Dark mode, defaults, paired / Unpair |
| Clipboard | Tab Clipboard | History + Read system / Send to online + per-item actions |
| Stability | Snapshot console | No max-update-depth; RN may WARN on deprecated `shadow*` / `pointerEvents` |

**Expo automation tips**

- RN `Pressable`s often render as plain **`div`s** — `role=button` may miss; use coordinates, exact-text `evaluate` click, or snapshot selectors.
- Expo Router keeps inactive tabs mounted: `document.body.innerText` can include **all** tab screens. Trust **URL** + on-screen controls.
- After store/hook changes with `CI=true`, restart Expo with **`--clear`**.

### 6. What not to treat as product bugs

- TanStack Router devtools footer on web.
- Expo/Metro cold bundle duration and first navigate timeout.
- Font “slow network” interventions in the preview browser.
- Demo mesh seeds in **dev only** (disable with `VITE_LYRA_SEED_DEMO=0`). Real wire needs desktop/peer-server + pairing trust.

### 7. After verification

Update [`docs/AGENT-PROGRESS.md`](docs/AGENT-PROGRESS.md) with date, ports tested, and pass/fail notes so the next agent does not re-discover broken auth or port collisions.

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
  T3-CODE-BROWSER.md   # T3 preview MCP auth + tools
  AGENT-PROGRESS.md    # status, handoff, last browser results
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

**Networking:** Electron desktop and `pnpm peer-server` host HTTP(S) peer servers + UDP multicast + real FS. Browser/Expo are clients (probe `/lyra/info`, send sealed messages when paired). Optional `LYRA_TLS=1` for HTTPS. See `docs/GAP-FIX-PLAN.md` and `docs/PACKAGING.md`.

## Theme

- **Web:** `packages/ui` uses **base-luma** geometry (`rounded-4xl` buttons) with a **blue** brand in `globals.css`
- **Native:** matching blue accent (`#2F6BFF` / `#7AA2FF`), Manrope, floating liquid-glass tab bar from Chrona

## Scripts

- `pnpm run dev` — all apps
- `pnpm run dev:web` / `pnpm run dev:native`
- `pnpm run build` — turbo build
- `pnpm run check` — Biome
- `pnpm run check-types` — TypeScript across packages
