# Lyra — Agent Progress Report

**Last updated:** 2026-07-18 (P2 networking + P3 packaging)  
**Status:** MVP UI + demo mesh; **P0–P3 foundations landed** (real peer HTTP/auth/discovery in Node/Electron; browser still demo-mesh + HTTP probe)

---

## Current goal

Ship a usable Lyra MVP per `docs/Lyra-Product-Spec.md` with:

- Web (desktop foundation) + Expo native + Electron shell
- shadcn **base-luma** + blue theme (fully rounded)
- Chrona-style floating tab bar on mobile
- Shared protocol + domain store + net transport
- Demo mesh until peers are online; real sockets in desktop/Node

---

## Done

### Design system
- [x] `packages/ui` → **base-luma**
- [x] Blue brand CSS in `packages/ui/src/styles/globals.css`
- [x] Components reinstalled + `IconPlaceholder` shim
- [x] Expo blue theme + Manrope (`apps/native/global.css`)
- [x] Dialog/Sheet close buttons use lucide `XIcon` directly

### Domain
- [x] `packages/protocol` — Zod schemas (+ `conflict` transfer status, `ConflictAction`, auth + resume fields)
- [x] `packages/core` — identity, store, demo peers, formatters, live probe hooks
- [x] Pairing code + simulate incoming; simulated transfers
- [x] Conflict resolve: rename / overwrite / skip
- [x] `applyPairingPayload` for QR scan handshake (demo)
- [x] File transfer options: direction + forceConflict + resume offset + integrity

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
- [x] Settings **Network** card (peer server status, Tailscale probe, integrity)
- [x] Transfers **Demo resume** + integrity labels
- [x] Playwright e2e smoke specs

### Native (`apps/native`)
- [x] Floating glass tab bar (Lyra blue)
- [x] Tabs + pair + device detail
- [x] **Incoming pairing banner** + conflict banner (tabs layout)
- [x] Real QR display (`react-native-qrcode-svg`)
- [x] QR payload paste / apply scan path
- [x] **Live camera QR scan** (`expo-camera` CameraView + barcodeTypes `qr`)
- [x] `expo-clipboard` read/write
- [x] `expo-document-picker` send files
- [x] Same selector fix as web (via shared hooks)
- [x] `eas.json` + app identity for EAS builds
- [x] Secure-store helpers for private key migration

### Networking (P2)
- [x] Protocol: `discover_announce` / `discover_response`, `PeerEndpoint`, device `host`/`port`
- [x] Manual peer add by host/IP + port (store + Devices UI web/native)
- [x] Discovery refresh (HTTP probe when host set; demo mesh fallback)
- [x] **Local HTTP peer server** (`packages/net` Node `/lyra/*`)
- [x] **UDP multicast discovery** (Node/Electron; group `224.0.0.167:53318`)
- [x] **Auth via fingerprints / challenge-response** on wire
- [x] **Live Tailscale probing** (`probeTailscalePeers`, 100.x / `*.ts.net`)
- [x] **Resumable transfers + integrity** (resume offsets, checksum verify flags)
- [x] **Electron desktop shell** (`apps/desktop`) hosting peer server + discovery

### Packaging / quality (P3)
- [x] EAS build profiles; secure-store private key helpers
- [x] Shared React hooks package `@lyra-sync-app/hooks` (DRY `useLyraSelector`)
- [x] Unit tests (`net`, `core`) + Playwright CI (`.github/workflows/ci.yml`)
- [ ] Optional Effect.ts for net pipelines — **deferred** (not required for MVP)

### Docs / tooling
- [x] README
- [x] This progress doc
- [x] `apps/web/scripts/smoke-render.mjs` — happy-dom selector stability smoke
- [x] `docs/T3-CODE-BROWSER.md`

---

## Architecture

```
apps/web      → TanStack Router → @lyra-sync-app/hooks → core
apps/native   → Expo Router    → @lyra-sync-app/hooks → core
apps/desktop  → Electron main  → @lyra-sync-app/net/node (HTTP + UDP)
packages/core → store, identity, demo FS, probe integration
packages/net  → auth, integrity, peer client/server, discovery
packages/protocol → Zod (message/device schemas)
packages/hooks → shared LyraProvider + useLyraSelector
packages/ui   → shadcn base-luma + blue tokens
```

Browser: demo mesh + HTTP probe of known hosts.  
Desktop/Node: real listen socket + multicast announce.

---

## How to run

```bash
pnpm install
pnpm run dev:web   # http://localhost:3001
pnpm peer-server   # optional: Node peer on :53317
pnpm run dev:desktop  # Electron (needs electron postinstall approved)
cd apps/native && CI=true pnpm exec expo start --web --port 8081 --clear
pnpm test          # unit
pnpm test:e2e      # Playwright (installs browser on first run)
```

---

## Left to do / follow-ups

- [ ] Approve Electron binary install (`pnpm approve-builds`) for full desktop runs
- [ ] Wire real multi-chunk file bytes over HTTP (protocol + resume offsets are ready)
- [ ] Pairing handshake that derives and stores `authSecret` on both devices
- [ ] Native UI parity for Network card / Demo resume
- [ ] Replace placeholder EAS `projectId` with a real Expo project
- [ ] Optional: Effect.ts pipelines

---

## Browser verification (T3 preview, 2026-07-18 P2/P3)

Web on `http://localhost:3001` via `preview_open` → `environment-port` 3001.

| Flow | Result |
|------|--------|
| Devices shell (4 peers, manual Tailscale node, search) | PASS — no max-update-depth |
| Settings → Network card | PASS — Peer server idle, Discovery off, Browser badge, listen port 53317 |
| Settings → Verify transfer integrity + peer listen port | PASS |
| Transfers → Demo resume | PASS — `movie.mp4` + “Resumable from …” |
| Unit tests `pnpm test` | PASS (net 9 + core 4) |

---

---

## Agent handoff notes

1. Do **not** set shadcn `baseColor: blue` for CLI installs — registry 404; blue is CSS-only.
2. Shared hooks live in `packages/hooks` — prefer that over editing app-local copies.
3. After changing native store hooks: **restart Expo with `--clear`** if `CI=true`.
4. Update this file when closing milestones.
5. Keyboard shortcuts live in `apps/web/src/components/keyboard-shortcuts.tsx`.
6. Conflict demo: Transfers → “Demo multi-file” / “Demo batch”; resume: “Demo resume”.
7. Peer server CLI: `pnpm peer-server` (`LYRA_PORT`, `LYRA_DISCOVERY=0` to silence multicast).
8. Live QR scan needs a physical device or simulator with a camera; Expo web keeps paste-only.
9. Clipboard auto-monitor needs a focused/secure context; browsers may prompt for clipboard permission once.
10. Electron ignored build scripts until approved in this environment — code is present under `apps/desktop`.
