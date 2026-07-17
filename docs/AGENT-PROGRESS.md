# Lyra — Agent Progress Report

**Last updated:** 2026-07-17 (evening)  
**Status:** MVP UI + demo mesh; **max update depth fixed** on web and Expo web

---

## Current goal

Ship a usable Lyra MVP per `docs/Lyra-Product-Spec.md` with:

- Web (desktop foundation) + Expo native
- shadcn **base-luma** + blue theme (fully rounded)
- Chrona-style floating tab bar on mobile
- Shared protocol + domain store
- Demo mesh until real P2P lands

---

## Done

### Design system
- [x] `packages/ui` → **base-luma**
- [x] Blue brand CSS in `packages/ui/src/styles/globals.css`
- [x] Components reinstalled + `IconPlaceholder` shim
- [x] Expo blue theme + Manrope (`apps/native/global.css`)

### Domain
- [x] `packages/protocol` — Zod schemas
- [x] `packages/core` — identity, store, demo peers, formatters
- [x] Pairing code + simulate incoming; simulated transfers

### Web (`apps/web`)
- [x] Shell, Devices, Clipboard, Transfers, Settings, Device detail + remote FS
- [x] Pairing dialog
- [x] Vite production build OK
- [x] **Fixed max update depth** (`useLyraSelector` snapshot cache + shallowEqual)
- [x] Playwright verified: home, clipboard, transfers, settings — no pageErrors

### Native (`apps/native`)
- [x] Floating glass tab bar (Lyra blue)
- [x] Tabs + pair + device detail
- [x] Same selector fix as web
- [x] Expo web Playwright verified after Metro `--clear` — Devices list renders, no max-depth

### Docs / tooling
- [x] README
- [x] This progress doc
- [x] `apps/web/scripts/smoke-render.mjs` — happy-dom selector stability smoke

---

## Bug fixed: Maximum update depth (web + mobile)

### Symptom
```
Maximum update depth exceeded
The result of getSnapshot should be cached to avoid an infinite loop
```

### Root cause
`useLyraSelector` used `useSyncExternalStore` with selectors that returned **new arrays every call** (`.filter()`, `.map()`, `.sort()`). React compared snapshots with `Object.is` → infinite re-renders.

### Fix
Cache selector results with **shallow equality** in:

- `apps/web/src/lib/lyra.tsx`
- `apps/native/lib/lyra.tsx`

Also: `ToastListener` dismiss via `queueMicrotask` + last-id guard.

### Verify
```bash
# Headless selector smoke
cd apps/web && pnpm exec tsx scripts/smoke-render.mjs

# Playwright (requires browsers in ~/.cache/ms-playwright)
# Web :3001 and Expo :8081 should show UI without max-depth pageErrors
```

**Note:** Expo in `CI=true` disables Metro reload — restart with `--clear` after store hook changes.

---

## Left to do

### P0 — Polish / remaining UX bugs
- [ ] Re-test with t3-code browser when MCP handshake works in agent session
- [ ] Incoming pairing banner on **native** (web only today)
- [ ] Dialog/Sheet close icons + any Base UI edge cases
- [ ] Real QR library (replace placeholder grid)
- [ ] Filter noisy console (PWA/service worker in dev if any)

### P1 — Product completeness (demo backend OK)
- [ ] File picker (web File API / Expo DocumentPicker)
- [ ] System clipboard read/write
- [ ] Mobile QR scan
- [ ] Conflict handling UI (rename / overwrite / skip)
- [ ] Keyboard shortcuts (spec §5.10)
- [ ] Drag-and-drop (spec §5.9)

### P2 — Real networking
- [ ] Local HTTP(S) peer server
- [ ] UDP multicast discovery
- [ ] Auth via fingerprints / keys
- [ ] Tailscale + manual IP
- [ ] Resumable transfers + integrity
- [ ] Electron desktop shell

### P3 — Packaging / quality
- [ ] EAS builds; secure-store private keys
- [ ] Shared React hooks package (DRY `useLyraSelector`)
- [ ] Unit + Playwright CI
- [ ] Optional Effect.ts for net pipelines

---

## Architecture

```
apps/web      → TanStack Router → @lyra-sync-app/core
apps/native   → Expo Router    → @lyra-sync-app/core
packages/core → store, identity, demo FS
packages/protocol → Zod (message/device schemas)
packages/ui   → shadcn base-luma + blue tokens
```

Demo peers are seeded; **no real P2P transport yet**.

---

## How to run

```bash
pnpm install
pnpm run dev:web   # http://localhost:3001
cd apps/native && CI=true pnpm exec expo start --web --port 8081 --clear
```

---

## Agent handoff notes

1. Do **not** set shadcn `baseColor: blue` for CLI installs — registry 404; blue is CSS-only.
2. Keep web + native `useLyraSelector` in sync (or extract shared package).
3. After changing native store hooks: **restart Expo with `--clear`** if `CI=true`.
4. Update this file when closing milestones.
