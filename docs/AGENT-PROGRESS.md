# Lyra — Agent Progress Report

**Last updated:** 2026-07-18 (P1 done + P2 discovery foundation)  
**Status:** MVP UI + demo mesh; P0/P1 done; P2 foundation (manual peers + discovery refresh) started

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
- [x] Dialog/Sheet close buttons use lucide `XIcon` directly

### Domain
- [x] `packages/protocol` — Zod schemas (+ `conflict` transfer status, `ConflictAction`)
- [x] `packages/core` — identity, store, demo peers, formatters
- [x] Pairing code + simulate incoming; simulated transfers
- [x] Conflict resolve: rename / overwrite / skip
- [x] `applyPairingPayload` for QR scan handshake (demo)
- [x] File transfer options: direction + forceConflict

### Web (`apps/web`)
- [x] Shell, Devices, Clipboard, Transfers, Settings, Device detail + remote FS
- [x] Pairing dialog with **real QR** (`qrcode.react`)
- [x] Incoming pair banner + **conflict banner**
- [x] File picker (File API) on devices / transfers / remote upload
- [x] System clipboard read/write helpers
- [x] Drag-and-drop onto device cards + remote file explorer
- [x] Keyboard shortcuts (spec §5.10) + Settings cheat sheet
- [x] PWA service worker disabled in dev (less console noise)
- [x] Vite production build OK
- [x] **Fixed max update depth** (`useLyraSelector` snapshot cache + shallowEqual)
- [x] happy-dom smoke: selector stability PASS

### Native (`apps/native`)
- [x] Floating glass tab bar (Lyra blue)
- [x] Tabs + pair + device detail
- [x] **Incoming pairing banner** + conflict banner (tabs layout)
- [x] Real QR display (`react-native-qrcode-svg`)
- [x] QR payload paste / apply scan path
- [x] **Live camera QR scan** (`expo-camera` CameraView + barcodeTypes `qr`)
- [x] `expo-clipboard` read/write
- [x] `expo-document-picker` send files
- [x] Same selector fix as web

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

# Web dev
pnpm run dev:web   # http://localhost:3001 (or next free port)
```

**Note:** Expo in `CI=true` disables Metro reload — restart with `--clear` after store hook changes.

---

## Left to do

### P0 — residual
- [x] Re-test UI in a **fresh** T3 agent thread (2026-07-17) — see “Browser verification” below
- [x] Live camera QR scan on device (`expo-camera` CameraView) — paste path remains as fallback

### P1 — residual polish
- [x] Optional: auto-monitor system clipboard (desktop + foreground native) vs manual “Read system”
- [x] Richer multi-file conflict batch UI (banner list, Skip/Rename/Overwrite all, multi-file demo)

### P2 — Real networking
- [x] Protocol: `discover_announce` / `discover_response`, `PeerEndpoint`, device `host`/`port`
- [x] Manual peer add by host/IP + port (store + Devices UI web/native)
- [x] Discovery refresh stub (brings known peers online; respects Settings toggle)
- [ ] Local HTTP(S) peer server (real sockets)
- [ ] UDP multicast discovery (real LAN announce)
- [ ] Auth via fingerprints / keys on wire
- [ ] Live Tailscale probing (manual IP path exists)
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

## Browser verification (T3 preview, 2026-07-17)

Web on `http://localhost:3001` via `preview_open` → `environment-port` 3001. Viewport was narrow (~477×897) — mobile shell OK.

| Flow | Result |
|------|--------|
| Devices shell (3 demo peers, search, nav) | PASS — no max-update-depth; console only Vite HMR debug |
| Pair dialog → Generate code + QR | PASS — code `X5LEXH`, fingerprint, `role=img` “Pairing QR code” |
| Pair → Enter code tab | PASS — input, Pair device, Simulate incoming request |
| Transfers list + progress | PASS — active + completed sessions |
| Demo conflict → banner Skip/Rename/Overwrite | PASS — top banner + row actions; Rename via banner selector |
| Settings identity / defaults / paired / shortcuts cheat sheet | PASS — Mod+K… listed; 3 paired devices |
| Clipboard history + actions | PASS |
| Keyboard: Ctrl+K | PASS — routes to `/` and focuses “Search devices…” |

### Expo web (`:8081`, same session)

Started with `cd apps/native && CI=true pnpm exec expo start --web --port 8081 --clear`. First cold navigate timed out at 60s (Metro bundled ~60s / 2359 modules); after bundle, `preview_status` showed `http://127.0.0.1:8081/` title `Lyra`. Prefer `readiness: "domContentLoaded"` or retry after log shows `Web Bundled`.

| Flow | Result |
|------|--------|
| Devices shell + floating tab bar | PASS — 3 seeded peers, Send clipboard to all, pair icon |
| Pair screen → generate code/QR | PASS — code `TWDD2G`, fingerprint `EC86 · 98E1 · 55D2 · 7D49` |
| Simulate incoming + Accept | PASS — “Incoming Laptop” appears in device list (4 paired) |
| Transfers → Conflict → Rename | PASS — banner Skip/Rename/Overwrite; resolved as `report (1).pdf` Completed |
| Settings identity / toggles / paired | PASS — fingerprint, Dark mode, defaults, Unpair list |
| Clipboard history | PASS — Read system, Send to online, Copy/Pin/Resend/Delete |
| Max update depth | PASS — none |
| Console | WARN only: deprecated `shadow*`, `pointerEvents`; font “slow network” interventions; no errors |

**Expo automation notes:** RN `Pressable`s are often plain `div`s (use coords / `evaluate` click on exact text). Expo Router keeps inactive tabs mounted — `document.body.innerText` concatenates all tab screens; use URL + on-screen controls.

Remaining gaps after P0/P1: **P2 real networking** and **P3 packaging/quality**.

---

## P1 residual polish (2026-07-18)

### Clipboard auto-monitor
- Settings: `autoMonitorClipboard` (default off) on web + native.
- Web: `ClipboardMonitor` polls system clipboard (~1.5s) while the tab is focused/visible; seeds baseline on enable so existing clipboard isn’t re-pushed.
- Native: foreground poll (~2.5s) via `expo-clipboard` + `AppState` (no true background OS clipboard hooks).
- Store: `ingestSystemClipboardText` updates local mirror; when clipboard sync is on, appends history and targets online auto-accept peers.
- Clipboard page (web): monitor card with status copy + switch; “Read system” remains.

### Multi-file / batch conflicts
- Transfer schema: `conflictFileNames[]` alongside legacy `conflictFileName`.
- Store: multi-file forceConflict, `resolveAllTransferConflicts`, `simulateIncomingConflict({ multiFile, batch })`.
- Web + native banners: file/session counts, **Skip/Rename/Overwrite all**, expandable per-session actions.
- Transfers demos: **Demo multi-file** and **Demo batch**.

### Verify
```bash
pnpm run dev:web   # :3001
# Settings → enable Auto-monitor system clipboard
# Transfers → Demo multi-file / Demo batch → banner batch actions
cd apps/web && pnpm exec tsx scripts/smoke-render.mjs
```

### Browser verification (T3 preview, 2026-07-18)

| Flow | Result |
|------|--------|
| Devices shell | PASS |
| Clipboard auto-monitor toggle + “Watching…” copy | PASS |
| Settings “Auto-monitor system clipboard” row | PASS |
| Transfers → Demo multi-file → Rename all | PASS — conflict banner cleared, transfer resumed |
| Transfers → Demo batch → Skip all | PASS — 3 sessions cancelled; “5 files already exist” banner |
| Devices → Add peer `100.64.0.12` / Tailscale Node | PASS — Manual badge + host shown |
| Refresh discovery | PASS — 4 online (Office PC brought online) |
| happy-dom smoke | PASS |

---

## P2 foundation (2026-07-18)

- Protocol discover message types + peer endpoint schema
- `addManualPeer` / `refreshDiscovery` on the core store
- Devices: “Add device by address” + “Refresh discovery” (web); native address form + radio refresh

Still demo-mesh under the hood — no real HTTP listener or multicast yet.

---

## Live camera QR scan (2026-07-18)

### What landed
- `expo-camera@~57.0.1` + plugin in `apps/native/app.json` (camera permission, barcode scanner enabled, no mic).
- `apps/native/components/qr-scanner.tsx` — permission request, `CameraView` with `barcodeTypes: ["qr"]`, scan lock/cooldown, haptics, success banner, Settings deep-link when permission permanently denied.
- Pair screen: **Scan QR with camera** section above enter-code / paste fallback.
- Web / Expo web: open-camera CTA explains native-only; paste path unchanged.

### Install note
Root `pnpm.overrides` maps `zxing-wasm` → `apps/native/vendor/zxing-wasm-stub` so installs skip the ~13 MB web WASM (native scanning does not need it). See `apps/native/vendor/README.md`.

### Verify
```bash
# Device / simulator (camera required for live path)
cd apps/native && pnpm exec expo start --clear
# Pair → Open camera scanner → scan desktop QR JSON
# Web: paste path still works; live camera is native-only
```

---

## Agent handoff notes

1. Do **not** set shadcn `baseColor: blue` for CLI installs — registry 404; blue is CSS-only.
2. Keep web + native `useLyraSelector` in sync (or extract shared package).
3. After changing native store hooks: **restart Expo with `--clear`** if `CI=true`.
4. Update this file when closing milestones.
5. Keyboard shortcuts live in `apps/web/src/components/keyboard-shortcuts.tsx`.
6. Conflict demo: Transfers → “Demo multi-file” / “Demo batch”, or download a PDF from remote FS.
7. Next planned work: **P2 real networking** (local HTTP peer server, discovery, auth), then **P3 packaging**.
8. Live QR scan needs a physical device or simulator with a camera; Expo web keeps paste-only.
9. Clipboard auto-monitor needs a focused/secure context; browsers may prompt for clipboard permission once.
