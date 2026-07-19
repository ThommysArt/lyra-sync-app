# Lyra — Agent Progress Report

**Last updated:** 2026-07-19 (spec-gap closeout)  
**Status:** MVP UI + domain store + **real wire paths** for pairing trust, clipboard, multi-chunk transfers, open URL, and fs_list; browser/Expo still cannot host a listen socket

---

## Current goal

Ship a usable Lyra MVP per `docs/Lyra-Product-Spec.md` with:

- Web (desktop foundation) + Expo native + Electron shell
- Dual-confirm pairing with mutual `authSecret`
- Real HTTP peer payloads when a peer has `host` + trust
- UI parity across web and Expo web

---

## Done (2026-07-19 closeout vs SPEC-VS-IMPLEMENTATION)

### Trust
- [x] Dual-confirm for QR scan / code entry / simulate (pending banner → confirm)
- [x] Mutual `authSecret` via `deriveMutualAuthSecret` (order-independent)
- [x] `authSecret` stored on `PairedDevice` after confirm
- [x] `/lyra/message` requires Bearer session for non-public types

### Transport
- [x] App-level AES-GCM seal helpers (`packages/net/src/seal.ts`) for payload encryption
- [x] CORS reflects request origin (allowlist option supported)
- [x] First-contact + shared-secret auth both accepted when appropriate

### Payloads (live peer with host)
- [x] `clipboard_push` / ack over HTTP
- [x] Multi-chunk `transfer_chunk` + offer/accept/complete (`sendFilesOverWire`)
- [x] `open_url` + ack
- [x] `fs_list` / response with demo tree on Node peer-server CLI
- [x] Store routes to wire when `isLivePeer` + `authSecret`; else simulates

### Domain / UX
- [x] Clipboard **images** (history + push + web “Add image”)
- [x] Mid-transfer **speed + ETA**
- [x] Transfer **Re-send** history action
- [x] Remote FS cache + `fetchRemoteFiles`
- [x] Clipboard retention days setting (schema)

### UI parity (native)
- [x] Network card (peer server / discovery / browser badge / probe)
- [x] Verify transfer integrity toggle
- [x] Peer listen port
- [x] Open URL on Devices
- [x] Demo Resume button on Transfers
- [x] Re-send on transfer rows

### Tests
- [x] Unit: net 10 + core 6
- [x] Integration: mutual secret, auth-required clipboard, 120KB multi-chunk wire transfer, dual-confirm authSecret

### Browser verification (T3 MCP, 2026-07-19)

| Surface | Result |
|---------|--------|
| Web `:3001` Devices | PASS — peers, Open URL, Pair dialog dual-confirm copy |
| Web Settings | PASS — Network, integrity, Mod+Q cheat sheet |
| Web Transfers | PASS — Demo resume, Re-send, speed labels |
| Web Clipboard | PASS — Add image |
| Expo `:8081` Devices | PASS — Open URL card |
| Expo Settings | PASS — Network card, integrity, listen port |
| Expo Transfers | PASS — Multi/Batch/**Resume**/Send, Re-send |
| Expo Pair | PASS — dual-confirm copy |

---

## Architecture

```
apps/web      → TanStack Router → hooks → core (demo + HTTP probe + wire client)
apps/native   → Expo Router    → hooks → core
apps/desktop  → Electron main  → net/node (HTTP + UDP) + built-in handlers
packages/core → store, identity, demo, peer-ops
packages/net  → auth, seal, transfer-wire, message-handlers, peer-client/server
packages/protocol → Zod (incl. transfer_chunk, open_url_ack)
```

---

## How to run

```bash
pnpm install
pnpm run dev:web   # http://localhost:3001
pnpm peer-server   # optional: Node peer on :53317
pnpm run dev:desktop
cd apps/native && CI=true pnpm exec expo start --web --port 8081 --clear
pnpm test
pnpm exec tsx packages/core/scripts/integration-net.mjs
```

---

## Still open / known limits

- [ ] True asymmetric key pairs (still hash-derived public from private hex)
- [ ] Full TLS peer servers (app-level seal helpers exist; HTTP remains default)
- [ ] Mobile as listen server (Expo/browser cannot bind UDP/HTTP server)
- [ ] Real OS filesystem browse on desktop (peer CLI returns demo tree; Electron hooks ready)
- [ ] Folder picker multi-file with relative paths end-to-end
- [ ] Production `seedDemo: false` wiring in release builds (API exists)
- [ ] Approve Electron binary (`pnpm approve-builds`) in this environment
- [ ] Real Expo EAS `projectId`

---

## Agent handoff notes

1. Pairing is **dual-confirm**: scan/code → banner → Confirm stores `authSecret`.
2. Wire paths need `device.host` + `device.authSecret` (demo peers stay simulated).
3. Peer CLI: `pnpm peer-server` logs envelopes and serves demo FS listings.
4. Integration: `pnpm exec tsx packages/core/scripts/integration-net.mjs`.
5. Update `docs/SPEC-VS-IMPLEMENTATION.md` after major milestones.
