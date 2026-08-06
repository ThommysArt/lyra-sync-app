# Lyra Gap Fix Plan

**Created:** 2026-07-19  
**Basis:** Product spec `Lyra-Product-Spec.md` + discrepancy audit (2026-07-19)  
**Companion:** `AGENT-PROGRESS.md`, `SPEC-VS-IMPLEMENTATION.md`  
**Reference clones (optional):** `~/Works/examples/localsend`, `~/Works/examples/sefirah`

This document is the **progressive implementation plan** to close every known gap between the product specification and the current monorepo. Work proceeds **phase by phase**; each phase is shippable and testable before the next starts.

---

## 0. Severity legend

| Tag | Meaning |
|-----|---------|
| **BLOCKER** | v1 success criteria or security default |
| **MAJOR** | Spec feature incomplete / demo-only |
| **MINOR** | Polish, docs, edge cases |
| **DOCS** | Documentation honesty / agent handoff |

---

## 1. Inventory of gaps (complete backlog)

### Security & trust

| ID | Severity | Gap | Spec § |
|----|----------|-----|--------|
| S1 | BLOCKER | No transport encryption default (plain HTTP; `seal.ts` unused) | §6 |
| S2 | BLOCKER | Identity is hash-derived pseudo-keys, not asymmetric key pairs | §4.1, §6 |
| S3 | MAJOR | First-contact auth accepts weak identity-binding proofs by default | §6 |
| S4 | MAJOR | Electron peer server does not `resolvePeerAuth` from paired list | §6 |
| S5 | MAJOR | Unpair is local-only — does not invalidate remote trust/sessions | §4.2, §6 |
| S6 | MAJOR | Web private key stored in clear `localStorage` bulk JSON | §4.1 |
| S7 | MINOR | Electron `safeStorage` encrypts then discards ciphertext | §4.1 |
| S8 | MAJOR | Integrity verification often soft-succeeds without comparing bytes | §5.5 |

### Pairing & discovery

| ID | Severity | Gap | Spec § |
|----|----------|-----|--------|
| P1 | BLOCKER | Pairing **code** path invents a synthetic peer instead of resolving a real device | §4.4 |
| P2 | MAJOR | Dual-confirm is one-sided when wire/host unavailable | §4.4, §5.11 |
| P3 | MAJOR | Manual “Add peer” does not establish trust (`authSecret`) | §4.3 |
| P4 | MAJOR | Multicast discovery only on Node/Electron; browser Discovery off | §4.3 |
| P5 | MAJOR | Tailscale is heuristics + probe only (no MagicDNS enumeration) | §4.3 |
| P6 | MINOR | QR payload omits host when peer server idle (browser) | §4.4 |

### Features (payloads / UX)

| ID | Severity | Gap | Spec § |
|----|----------|-----|--------|
| F1 | BLOCKER | Remote FS is demo tree; no real OS filesystem on desktop | §5.7, §9 |
| F2 | MAJOR | Folder / multi-file relative paths not end-to-end | §5.5 |
| F3 | MAJOR | Wire `transfer_pause` / `transfer_resume` are no-ops | §5.5 |
| F4 | MAJOR | Browser file send often uses synthetic ≤256 KiB payload | §5.5 |
| F5 | MAJOR | Live device status not periodically shared over protocol | §5.2 |
| F6 | MAJOR | Transfer history search/filter missing | §5.6 |
| F7 | MINOR | Clipboard retention-days has schema but weak Settings UX | §5.4 |
| F8 | MINOR | OS-global keyboard shortcuts missing; Mod+Q not bound | §5.10 |
| F9 | MINOR | Drag-out download from remote explorer missing | §5.9 |
| F10 | MINOR | Remote delete/rename/preview missing | §5.7 |
| F11 | MAJOR | Android Accessibility clipboard auto-monitor missing | §5.3 |
| F12 | MINOR | iOS clipboard limits not called out in UI | §5.3 |

### Platforms & product readiness

| ID | Severity | Gap | Spec § |
|----|----------|-----|--------|
| A1 | MAJOR | Mobile/Expo cannot host listen server (receive unsolicited) | §7 |
| A2 | MAJOR | `seedDemo` defaults **true** in web + native (hides empty-state) | §9 |
| A3 | MAJOR | Electron packaging / approve-builds incomplete | §3 |
| A4 | MINOR | EAS `projectId` placeholder | §3 |
| A5 | DOCS | README still claims networking “not wired” in places | — |
| A6 | DOCS | `SPEC-VS-IMPLEMENTATION.md` partially stale | — |

### Open-source inspiration debt

| ID | Severity | Gap |
|----|----------|-----|
| O1 | DOCS | LocalSend: only multicast inspiration; no protocol study notes |
| O2 | DOCS | Sefirah: zero code references; patterns not documented |

---

## 2. Design principles for the fix

1. **Preserve the shared Zod protocol** — extend schemas rather than rewrite.  
2. **Desktop (Electron / Node peer-server) is the canonical server**; mobile remains primarily a client with optional manual/push participation.  
3. **Encryption by default:** when `authSecret` exists, payloads on `/lyra/message` use app-level AES-GCM seal (`seal.ts`). Prefer HTTPS later; seal works on plain HTTP LAN.  
4. **Asymmetric identity:** Web Crypto ECDSA P-256 (broad support) for sign/verify proofs; keep hex/JWK export portable across web, Node, React Native.  
5. **Demo mesh is opt-in** in production builds (`seedDemo` from env / `import.meta.env.DEV`).  
6. **Honest degradation:** if a path is simulated, label it in UI; never claim “wire” without `overWire`.  
7. **Reference, don’t fork:** LocalSend / Sefirah inform design; Lyra keeps its own protocol.

---

## 3. Progressive phases

### Phase 0 — Plan & references (this doc)

**Deliverables**

- [x] This plan in `docs/GAP-FIX-PLAN.md`
- [ ] Optional shallow clones under `~/Works/examples/{localsend,sefirah}`
- [ ] Short notes file `docs/REFERENCES.md` (what we borrowed)

**Exit:** Plan accepted by agent as source of truth for sequencing.

---

### Phase 1 — Cryptographic foundation (S1, S2, S3, S6)

**Goal:** Spec-grade identity + encrypted post-pair transport + safer key storage.

| Step | Work | Files (expected) |
|------|------|------------------|
| 1.1 | ECDSA P-256 identity generation (Web Crypto + Node subtle) | `packages/core/src/identity.ts` |
| 1.2 | Auth: sign nonce with private key; verify with peer public key; keep shared-secret path | `packages/net/src/auth.ts`, tests |
| 1.3 | Wire seal: encrypt envelope payload when `session.sharedSecret` / device `authSecret` present | `peer-client.ts`, `peer-server.ts`, `envelope.ts` or `seal.ts` |
| 1.4 | Default `allowFirstContactAuth: false` when resolver provided; first-contact only for `pair_request` public types | `peer-server.ts` |
| 1.5 | Web: do not put private key in plain bulk state when possible; prefer isolated key + clear-on-export | store persist + web storage adapter |
| 1.6 | Migration path for existing pseudo-key identities (regenerate or dual-accept) | identity + store hydrate |

**Tests**

- Unit: generate identity → sign → verify  
- Integration: sealed clipboard push fails without secret; succeeds with secret  
- Integration: first-contact cannot open `clipboard_push` without pairing when configured  

**Browser check**

- Settings fingerprint still displays  
- Pair flow still generates QR/code  

**Exit:** Integration suite green; no plain clipboard_push body readable without seal when secret set (assert sealed form `v1.`).

---

### Phase 2 — Trust wiring (S4, S5, P1–P3)

**Goal:** Real dual-confirm pairing, Electron auth registry, unpair revoke, code path resolves real peers.

| Step | Work |
|------|------|
| 2.1 | Electron: maintain in-memory map of trusted peers (`fingerprint → authSecret`); pass `resolvePeerAuth` |
| 2.2 | Renderer → main IPC: sync paired devices / secrets on pair/unpair |
| 2.3 | Code pairing: host with active session advertises code hash via `/lyra/info` or discover payload; joiner probes + match code, then dual-confirm |
| 2.4 | QR path: always include best-effort LAN IP in payload when desktop peer running |
| 2.5 | `unpairDevice`: send `pair_reject` / new `unpair` message; peer drops secret + sessions |
| 2.6 | Manual add peer: after successful probe + optional short confirm, offer “Pair / trust” that runs dual-confirm handshake |

**Tests**

- Integration: two peers, code/token pair → both have same `authSecret`  
- Integration: unpair on A → B rejects subsequent authed messages  

**Browser check**

- Pair dialog dual-confirm copy still accurate  
- Simulate incoming still works  
- Manual peer shows untrusted until paired  

**Exit:** Code path no longer invents fake device ids when a real host is available.

---

### Phase 3 — Transfers & integrity (F2–F4, F3, S8)

**Goal:** Real bytes, folders where possible, pause/resume over wire, real checksum verify.

| Step | Work |
|------|------|
| 3.1 | Pass actual `File`/`Uint8Array` from web picker into `startFileTransfer` / `wireSendFiles` |
| 3.2 | Folder: retain `relativePath` from directory picker (web `webkitdirectory` or multi-file) |
| 3.3 | Server-side pause: track transfer state machine; reject chunks when paused; resume from offset |
| 3.4 | On `transfer_complete`, recompute checksums of received chunks vs offer |
| 3.5 | Cap / stream large files (avoid holding multi-GB in RAM on Node — chunk to temp file) |

**Tests**

- Integration: pause mid-transfer → resume → complete + integrity OK  
- Integration: wrong checksum fails  

**Browser check**

- Transfers page: real progress/speed when talking to `peer-server`  
- Demo resume still available for offline demo  

**Exit:** Wire transfer of multi-file session with integrity match.

---

### Phase 4 — Real remote filesystem (F1, F9, F10 partial)

**Goal:** Desktop can browse real smart folders and download/upload.

| Step | Work |
|------|------|
| 4.1 | Node/Electron `onFsList` maps `/`, smart folders → `os.homedir()` paths (Documents, Downloads, Desktop, Pictures, …) |
| 4.2 | `fs_read` / chunk download message or HTTP range for file content (minimal: base64 chunks) |
| 4.3 | Upload path: write received transfer into chosen remote directory |
| 4.4 | Optional: rename/delete with confirmation (can ship after list+download) |
| 4.5 | UI: badge “Live FS” vs “Demo FS” on device detail |

**Tests**

- Peer-server against temp dir fixture  
- Integration list home smart folders  

**Browser check**

- Device detail smart folders change when live peer trusted  
- Download produces blob/save  

**Exit:** Success criterion “browse Photos/Documents and download” works desktop↔desktop.

---

### Phase 5 — Product readiness & platform honesty (A1, A2, F5, F6–F8)

| Step | Work |
|------|------|
| 5.1 | `seedDemo`: default `import.meta.env.DEV` / `process.env.LYRA_SEED_DEMO`; document env |
| 5.2 | Empty-state UI when no devices (pair CTA) |
| 5.3 | Status: lightweight `status` envelope on interval when peer server running |
| 5.4 | Transfer history search input (client filter) |
| 5.5 | Clipboard retention days in Settings UI |
| 5.6 | Bind Mod+Q in Electron (app.quit); document non-global shortcuts |
| 5.7 | Mobile model note in Settings Network: “This device cannot accept unsolicited LAN connections; keep a desktop peer online” |
| 5.8 | README + SPEC-VS-IMPLEMENTATION rewrite to match reality |

**Browser check**

- With `seedDemo=false` (or prod build): empty Devices state  
- Search transfers filters rows  
- Settings retention days  

**Exit:** Docs honest; production-like seed; mobile limits labeled.

---

### Phase 6 — Stretch / post-MVP alignment

| Step | Work |
|------|------|
| 6.1 | Optional HTTPS self-signed peer server (Node `https`) |
| 6.2 | Android Accessibility clipboard service (native module / config plugin) |
| 6.3 | Tailscale MagicDNS list via local Tailscale API if present |
| 6.4 | Full Electron packaging (CI artifacts) |
| 6.5 | EAS project setup |
| 6.6 | Drag-out from remote explorer; richer previews |

---

## 4. Reference study plan (LocalSend / Sefirah)

### LocalSend (discovery + transfer)

| Pattern | How Lyra should use it |
|---------|------------------------|
| Multicast announce + HTTP info | Keep Lyra multicast; align announce fields (name, port, fingerprint) |
| Fixed listen port culture | Keep 53317 / 53318 (already LocalSend-adjacent) |
| Session + pin / token on first trust | Map to dual-confirm + `authSecret` |
| Chunked transfer + progress | Already have `transfer_chunk`; harden pause/resume |
| Do **not** copy Dart API paths | Keep `/lyra/*` |

### Sefirah (clipboard + device link + storage)

| Pattern | How Lyra should use it |
|---------|------------------------|
| Explicit device link before clipboard | Enforce `authSecret` before clipboard_push |
| Storage access as browse + pull | Phase 4 real FS smart folders |
| Lightweight status | Phase 5 status envelope |

Clone location: `~/Works/examples/localsend`, `~/Works/examples/sefirah` (shallow).

---

## 5. Testing strategy

| Layer | Command / method |
|-------|------------------|
| Unit | `pnpm test` (net + core) |
| Integration | `pnpm exec tsx packages/core/scripts/integration-net.mjs` |
| Web smoke | `cd apps/web && pnpm exec tsx scripts/smoke-render.mjs` |
| Types | `pnpm run check-types` |
| T3 browser | `preview_open` → env-port **3001** / **8081** → snapshot critical routes |
| Manual two-peer | `pnpm peer-server` + web add peer + pair |

### T3 checklist after each phase

1. Devices loads, no max-update-depth  
2. Pair dialog generates code/QR  
3. Settings Network honesty  
4. Transfers page usable  
5. (After Phase 4) Device detail live FS when peer online  
6. Expo web still shells correctly  

---

## 6. Definition of done (full plan)

All of the following:

- [x] S1–S8 addressed (encryption default via seal or TLS; real keys; unpair revoke; integrity)  
- [x] P1–P3 fixed (code path real; dual-confirm; manual trust path)  
- [x] F1 real desktop FS browse/download  
- [x] F2–F4 transfers real bytes / folders / pause-resume wire  
- [x] A2 seedDemo production-safe  
- [x] Docs (README, SPEC-VS-IMPLEMENTATION, AGENT-PROGRESS) updated  
- [x] Integration + unit tests green  
- [x] T3 browser smoke on web + Expo  

**Environment-bound leftovers** (not code-blocked): signed store builds, real EAS projectId from `eas init`, Android Accessibility Service package, multi‑GB browser pickers. See AGENT-PROGRESS + PACKAGING.

---

## 7. Execution log

| Date | Phase | Notes |
|------|-------|-------|
| 2026-07-19 | 0 | Plan created |
| 2026-07-19 | 1 | ECDSA P-256 identity; AES-GCM seal on wire when `authSecret`; session carries secret; unseal in peer-server |
| 2026-07-19 | 2 | Code pairing probes `/lyra/info` codeHash; Electron `resolvePeerAuth` + sync trusted peers; unpair notify + revoke sessions; pairing offer on info |
| 2026-07-19 | 3 | Real File bytes in picker; relativePath for folders; transfer_pause/resume state on server; integrity on single-file complete |
| 2026-07-19 | 4 | `listOsFiles` real smart folders for CLI + Electron |
| 2026-07-19 | 5 | seedDemo from DEV/env; transfer search; retention days UI; Mod+Q quit; Network honesty copy; docs |
| 2026-07-19 | 6 | HTTPS optional (`LYRA_TLS`); disk transfer receive; fs_read/delete/rename; Tailscale status; trustDevice; packaging scripts; private key isolation |
| 2026-07-19 | Tests | Unit + integration PASS (`ecdsa: true`, sealed clipboard, revoke) |
| 2026-07-19 | **DONE** | Code-achievable plan complete |

---

## 8. Agent instructions

1. Work **one phase at a time**; mark checklist items in this file as you finish.  
2. Prefer small commits of logical units (if user asks for commits).  
3. Do not re-introduce demo-only paths without `forceSimulate` or explicit UI labels.  
4. After Phase 1–2, always re-run integration-net.  
5. Use T3 browser for UI regressions; free ports 3001/8081 if needed.  
6. Update `AGENT-PROGRESS.md` at end of each phase.

---

**End of plan**
