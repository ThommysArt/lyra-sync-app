# Spec vs Implementation Discrepancy Report

**Spec:** [`Lyra-Product-Spec.md`](./Lyra-Product-Spec.md) (v1.0 MVP, Draft, 2026-07-17)  
**Codebase:** monorepo as of **2026-07-19**  
**Companion progress notes:** [`AGENT-PROGRESS.md`](./AGENT-PROGRESS.md)  
**UI artifacts:** [`verification-artifacts/`](./verification-artifacts/) (`ui-crawl.json` + PNG screenshots)

---

## Verification method (this revision)

| Surface | How verified | Result |
|---------|----------------|--------|
| **Desktop / web UI** (`apps/web` → **:3001**) | T3 Code MCP `preview_open` → `preview_navigate` `{ kind: "environment-port", port: 3001 }` → `preview_status` | **Loaded.** Title `Lyra — Private device network`, viewport ~1001×897, `loading: false`. Subsequent `preview_snapshot` / `preview_evaluate` / `preview_click` / further navigates **timed out** (preview automation stuck after initial load). |
| **Mobile Expo web** (`apps/native` → **:8081**) | Attempted T3 navigate to port 8081 after automation hang | **Not completed via T3** (same automation timeouts). |
| **Both apps (full route crawl)** | Headless Playwright against live servers (screenshots + DOM text dump) | **Completed.** Routes: web `/`, `/clipboard`, `/transfers`, `/settings`, device detail, pair dialog; native `/`, `/clipboard`, `/transfers`, `/settings`, `/pair`. **No pageerror / console errors** in crawl. |
| **Static code review** | `packages/{core,net,protocol}`, app routes | Primary source for “real wire” vs demo behavior. |
| **Stability smoke** | `apps/web` happy-dom selector smoke | **PASS** (`commits after mount: 1`). |

**Servers at verification time:** both listeners up (`200` on `:3001` and `:8081`).

**How to re-run UI crawl evidence**

```bash
# ensure servers
pnpm run dev:web   # :3001
cd apps/native && CI=true pnpm exec expo start --web --port 8081 --clear

# headless DOM + screenshots → docs/verification-artifacts/
cd apps/web && node --input-type=module <<'EOF'
# (see last crawl script in session; or re-use docs/verification-artifacts/ui-crawl.json)
EOF
```

---

## Executive summary

Lyra is a **strong UI shell + domain model + partial Node/Electron networking foundation**, not a finished MVP against the product success criteria.

| Layer | Spec intent | Reality (code + UI) |
|--------|-------------|---------------------|
| UI (web / Expo web) | Full product surfaces | **Present and usable** — demo peers, status chips, pairing dialog, remote FS shell, transfers with progress, settings network card (web). |
| Domain store | Real device network state | In-memory store with **demo mesh seeding** (3 fake peers by default). |
| Protocol | Shared Zod wire protocol | Schemas rich; few types fully exercised end-to-end. |
| Networking | P2P client+server on every device | Node/Electron HTTP + UDP only; **browser/Expo show peer server idle / discovery off**. |
| Crypto / trust | Key pairs, dual-confirm pairing | Pseudo-keys; pairing UX claims dual confirm; **QR/code paths do not complete mutual trust**. |
| Transfers / FS / clipboard over wire | Real peer payloads | Simulated progress / toast / **demo FS**; no multi-chunk bytes. |

**Bottom line:** You can walk almost every MVP *screen*, but most cross-device behaviors do **not** move data or establish mutual trust between real peers.

---

## Severity legend

- **Blocker** — Required for v1 success criteria; cannot claim the feature works.
- **Major** — Spec feature partial or demo-only.
- **Minor** — Spec detail incomplete; non-blocking for a UI demo.
- **Aligned** — Matches intent (or correctly out of scope).
- **Observed in UI** — Confirmed via browser crawl / T3 status this revision.

---

## Browser-verified UI findings

### Desktop web (`http://127.0.0.1:3001`)

**Shell**

- Branding: **Lyra**, subtitle **“2 online · private network”**.
- Nav: **Devices / Clipboard / Transfers / Settings** (+ Dark mode).
- This device label: **My Computer** (web platform identity).
- TanStack Router **devtools** present in DOM (dev-only noise, not product).

**Devices (`/`)** — *Observed*

- Copy: *“Your trusted local network — no accounts, no cloud. Drag files onto a device to send.”*
- Actions: **Refresh discovery**, **Pair device**, **Send clipboard**.
- **Add device by address** (Host / IP, Port, Nickname, **Add peer**) — matches manual discovery path.
- Demo mesh peers rendered:
  - **Thommy's MacBook** — macOS · Local · Home-5G · **72%** · 128 GB free · Seen 30s
  - **Pixel 9** — Android · **Local + Tailscale** · 41% · 42 GB free
  - **Office PC** — Windows · Tailscale · Ethernet · offline-ish “Seen 1d”
- Per-device: **Send clipboard**, **Send files**, **Open**.
- **Open URL** field present on Devices (*“Open URL on other devices…”* in source; crawl shows Open control near search row).

**Pair dialog** — *Observed*

- Title: *“Pair a device”*
- Description still claims: *“Both devices must confirm.”*
- Tabs: **Show code** / **Enter code**
- Default: **Generate pairing code** (session starts on open in code; UI may show generate until session active).

**Clipboard (`/clipboard`)** — *Observed*

- **Read system**, **Clear unpinned**, **Send to all online**, **Save to history**.
- Auto-monitor card: **Off** by default (manual path).
- History items are **text only** (pinned shadcn URL, meeting notes, pairing URI). No image items.

**Transfers (`/transfers`)** — *Observed*

- **Send files**, **Demo multi-file**, **Demo batch**, **Demo resume**, **Clear history**.
- Active demo transfer: `design-spec.pdf, screenshots` → Pixel 9, **Transferring 53%**, speed shown as **—** (no live ETA/speed).
- History: completed zip with duration + average speed.

**Settings (`/settings`)** — *Observed*

- Fingerprint display, platform **web**, identity ID present.
- Defaults: clipboard sync, auto-monitor, auto-accept transfers/clipboard, network discovery, Tailscale, **verify transfer integrity**, history limit, peer listen port.
- **Network** card:
  - **Peer server idle**
  - **Discovery off**
  - **Browser** badge
  - Copy: *“Browser mode — run desktop shell or peer-server on :53317”*
  - Explains browser probes `/lyra/info` only.
- **Keyboard shortcuts** cheat sheet present (Mod+K, Mod+,, Mod+E, Mod+Shift+V/C/T/P; **no Quit**).
- Paired devices list with Manage / Unpair (3 demo devices).

**Device detail (`/devices/demo_macbook`)** — *Observed*

- Nickname, fingerprint, per-device auto-accept + show-in-list.
- **Send clipboard**, **Upload files**, **Unpair**.
- **Remote files** root: **Photos, Documents, Downloads, Desktop, Screenshots** (smart folders).
- Note that PDF download may trigger conflict UI (demo).

Screenshots: `docs/verification-artifacts/web_*.png`

### Mobile Expo web (`http://127.0.0.1:8081`)

**Shell**

- Floating tab bar: **Devices / Clipboard / Transfers / Settings** (Chrona-style intent).
- Title **Lyra**.

**Devices** — *Observed*

- **Add by address** + **Add peer** (host-focused; simpler than web).
- **Send clipboard to all online**.
- Same three demo peers with battery / connection labels.
- Per device: **Clipboard**, **Send file** (singular).

**Clipboard** — *Observed*

- Read system, Send to online.
- History with **Copy / Pin / Unpin / Resend / Delete** — still text-only.

**Transfers** — *Observed*

- **Multi**, **Batch**, **Send** (demo conflict helpers; **no “Demo resume” label** like web).
- Same transferring / completed demo rows; pause/cancel on active.

**Settings** — *Observed*

- Identity **My Phone**, fingerprint, dark mode + core toggles (clipboard sync, auto-monitor, auto-accepts, discovery, Tailscale).
- **Paired devices (3)** with Unpair.
- **Missing vs web:** Network / peer server status card, integrity toggle surface, peer listen port, keyboard cheat sheet, Open URL, full Tailscale probe controls.

**Pair (`/pair`)** — *Observed*

- Copy claims dual confirm.
- **Tap to generate** QR/code (`------` until generated).
- **Camera scan (native only)** — Expo web explicitly: *cannot use device camera*; paste QR JSON fallback + **Apply pasted QR**.
- **Enter code**, **Simulate incoming request**.

Screenshots: `docs/verification-artifacts/native_*.png`

### Cross-surface UI parity (browser-confirmed)

| Capability | Web | Expo web |
|------------|-----|----------|
| Demo device list + status | Yes | Yes |
| Manual peer add | Host+port+name | Host-centric |
| Pairing QR/code UX | Dialog | Full screen |
| Camera QR scan | N/A (display) | **Disabled on Expo web** |
| Clipboard history text | Yes | Yes |
| Clipboard images | No | No |
| Transfer demos / progress | Yes (+ Demo resume) | Yes (Multi/Batch; no Demo resume label) |
| Open URL UI | Yes | **No** |
| Remote FS + smart folders | Yes | Device detail route exists (code); not re-crawled in same depth |
| Network / peer server status | **Yes (idle browser)** | **No** |
| Integrity setting | Yes | **No dedicated row** |
| Keyboard shortcuts sheet | Yes | N/A |
| Console errors in crawl | None | None |

---

## 1. Overview & pillars (§1)

| Spec pillar | Status | Notes |
|-------------|--------|-------|
| Trusted device network | **Major** | UI list + unpair work locally; cryptographic mutual trust incomplete. |
| Clipboard continuity | **Major** | Local text history + system helpers; no real peer push. |
| File access & transfer | **Blocker** | Progress/conflict/resume UI; **no real file bytes on wire**. |
| Local-first & private | **Mostly aligned** | No accounts/cloud; copy emphasizes private network. |

---

## 2. Goals & non-goals (§2)

### Goals (v1)

| Goal | Status | Gap |
|------|--------|-----|
| Permanent trusted device network | **Major** | Local list only; no mutual `authSecret` handshake. |
| Clipboard sync (text + images) | **Major** | Text local/manual; **images missing**. |
| Resumable file/folder transfers | **Blocker** | Resume UI/demo; **no folders**; no real bytes. |
| Browse remote FS + smart shortcuts | **Major** | Smart folders **shown in UI**; data is `listDemoFiles`. |
| Multi-device send | **Partial** | Store fans out; UX often “all online” / first N. |
| LAN + optional Tailscale | **Major** | Multicast Node/Electron; browser **Discovery off**; Tailscale = address heuristics + probe. |
| Cryptographic pairing & trust | **Blocker** | Dual-confirm claimed in UI; not enforced for QR/code happy paths. |

### Non-goals (correctly absent)

Accounts/cloud backend, continuous folder sync, full remote desktop, SMS/call mirroring, OS network mounts, screen mirroring — **aligned** (not built).

---

## 3. Target platforms (§3)

| Platform | Spec | Implementation | Gap |
|----------|------|----------------|-----|
| Win / macOS / Linux | Electron + Vite + TanStack | `apps/desktop` + `apps/web` | Shell exists; packaging incomplete; Electron binary may need approve-builds. |
| Android | Expo + HeroUI | `apps/native` | UI present; **no peer listen server** on device. |
| iOS | Medium | Same Expo app | Same limits; camera path needs real device. |
| Pure browser | Not a ship target | Primary web surface + PWA assets | **Extra.** Cannot host multicast/server; Settings honestly shows Browser mode. |

Stack choices (shadcn desktop, HeroUI native) match the spec.

---

## 4. Core concepts (§4)

### 4.1 Device identity

| Requirement | Status | Gap |
|-------------|--------|-----|
| Real crypto key pair | **Major** | Random hex “privateKey” + SHA-derived “publicKey” (not asymmetric). |
| Editable name | **Aligned** | Settings Save observed. |
| Type / platform / fingerprint | **Aligned** | Web shows platform **web**; native seeds as phone. |
| Private key never leaves device | **Major** | Web may persist key in bulk `localStorage`; native SecureStore helpers exist. |

### 4.2 Trusted network

Pairing permanence is local list membership. Auto-accept toggles **visible** (settings + device detail) but no real wire path honors them.

### 4.3 Discovery

| Mode | Status | UI evidence |
|------|--------|-------------|
| UDP multicast | Node/Electron only | Settings: **Discovery off** in browser |
| HTTP `/lyra/info` | Probe path exists | Network card explains browser probe |
| Tailscale | Manual 100.x / `*.ts.net` + probe button | Toggle + **Probe Tailscale peers** on web |
| Manual add | **UI aligned** | Web + native “Add by address” |

### 4.4 Pairing

| Requirement | Status | Evidence |
|-------------|--------|----------|
| QR payload | **Partial** | Web dialog + native pair screen |
| Code entry | **Partial** | Synthetic pair on code submit |
| Dual confirm | **Blocker** | UI text claims it; scanner/`submitPairingCode` pair immediately; only **incoming banner** path is accept/reject |
| Store peer keys + auth secret | **Major** | Keys stored; **`authSecret` not derived** |
| Unpair | **UI aligned** | Local only |

---

## 5. Feature specifications (§5)

### 5.1 Paired devices management

| Spec | Status | UI |
|------|--------|-----|
| List name/type/last seen/online/connection | **Mostly aligned** | Devices + Settings |
| Nickname | **Aligned** | Device detail |
| Unpair | **Aligned** | Local |
| Per-device auto-accept + show in list | **Aligned** | Device detail toggles |

Spec location “Settings → Paired Devices” is split across Devices + Settings + detail.

### 5.2 Device status

Battery, network name, free storage **displayed for demo peers**. **No live periodic status protocol** into the store for real devices.

### 5.3–5.4 Clipboard

| Spec | Status | UI |
|------|--------|-----|
| Text history, pin, clear, resend | **Local aligned** | Web + native |
| Images | **Missing** | No image entries in crawl |
| Auto push / receive write | **Major** | Monitor toggle off by default; no wire |
| Android Accessibility auto | **Missing** | — |
| History limit configurable | **Aligned** | Web settings (default 40) |
| Time-based retention | **Missing** | Count only |

### 5.5–5.6 File transfer & history

| Spec | Status | UI |
|------|--------|-----|
| Progress / pause / cancel | **UI aligned** | Observed transferring 53% |
| Resume | **Demo** | Web **Demo resume**; simulation only |
| Conflicts rename/overwrite/skip | **Demo UI** | Demo multi/batch |
| Speed + ETA | **Partial** | Avg after complete; mid-transfer speed **—**; **no ETA** |
| Integrity | **Major** | Setting + demo always OK |
| Folders | **Missing** | File picker only |
| Real multi-chunk transfer | **Blocker** | Not on wire |
| History search / re-send | **Missing** | Flat list, no re-send |

### 5.7 Remote browse

| Spec | Status | UI |
|------|--------|-----|
| Smart folders | **Demo aligned** | Photos/Documents/Downloads/Desktop/Screenshots at `/` |
| Navigate / multi-select / upload-download buttons | **UI** | Device detail |
| Real FS / preview / delete-rename | **Missing** | Demo tree only |

### 5.8 Open URL

Web field + `sendUrl` toast only — **no open-on-receiver**. Native UI **missing**.

### 5.9 Drag and drop

Web drop zones on cards / remote explorer (simulated). **Drag-out download** missing.

### 5.10 Keyboard shortcuts

Web cheat sheet matches most required actions. **Quit** missing. OS-global shortcuts not implemented (in-app only).

### 5.11 Pairing UX

Desktop show / mobile scan-or-code structure **matches**. Expo web correctly degrades camera. Dual-confirm claim **overstates** implementation.

---

## 6. Security model (§6)

| Requirement | Status |
|-------------|--------|
| Post-pairing auth via fingerprints | Partial challenge-response; weak first-contact fallback; pairing omits `authSecret` |
| Encryption default (HTTPS / app-level) | **Blocker** — plain HTTP peer server |
| Dual confirmation | Incomplete |
| Unpair invalidates trust | Local only |
| No external core servers | **Aligned** |

Also: peer server CORS `*`; web private key storage quality.

---

## 7. Architecture principles (§7)

| Principle | Status |
|-----------|--------|
| Every device client + server | **Major** — true for Node/Electron; false for browser & Expo |
| No central coordinator | **Aligned** |
| Shared Zod protocol | Schemas **aligned**; runtime incomplete |
| Local HTTP(S) servers | HTTP only; not on mobile |
| Hybrid discovery | Partial |
| Graceful degradation | Partial — often degrades to **demo**, not real manual path |

```
Browser web UI ──► core store (demo mesh + HTTP probe)     [peer server idle]
Electron main  ──► HTTP :53317 + UDP multicast ── IPC ──► renderer
Expo native    ──► core store (demo mesh); no listen server
```

---

## 8. Success criteria for v1 (§9)

| Criterion | Verdict |
|-----------|---------|
| Pair desktop + mobile in &lt;2 min (QR/code) | **Fail as real product** (UI demo under 2 min) |
| Clipboard text appears on other device | **Fail** |
| Multi-device files + pause/resume + history | **Fail for real files** (UI demo OK) |
| Browse Photos/Documents + download/open | **Fail for real FS** (demo folders visible) |
| Home Wi‑Fi + Tailscale | **Partial** probe story only |
| No account / external service | **Pass** |

---

## 9. Cross-cutting themes

1. **Demo mesh is first-class** — three seeded peers always shape the UI; production empty-state is under-tested.
2. **Protocol ≠ product path** — message types exist; store simulates outcomes.
3. **Browser honesty** — Settings Network card correctly labels browser limitations (good product copy; architecture still incomplete for mobile).
4. **Web ahead of native** on Network/integrity/Open URL/Demo resume.
5. **T3 preview automation flaky this session** — title/status proved load; interactive snapshot failed; Playwright filled the gap.

---

## 10. Condensed feature matrix

| Spec § | Feature | Schema/UI | Domain | Real wire | Overall |
|--------|---------|-----------|--------|-----------|---------|
| 4.1 | Identity | Yes | Pseudo-crypto | N/A | Major |
| 4.4 | Pairing | Yes (verified) | Demo/synthetic | No mutual | Blocker |
| 5.1 | Device mgmt | Yes | Local | No revoke | Major |
| 5.2 | Live status | Demo UI | Demo | No | Major |
| 5.3 | Clipboard text | Yes | Local | No | Major |
| 5.3 | Clipboard images | Schema | No | No | Missing |
| 5.5 | File transfer | Yes | Simulated | No bytes | Blocker |
| 5.5 | Folders | No | No | No | Missing |
| 5.7 | Remote browse | Demo UI verified | Demo FS | No | Blocker |
| 5.8 | Open URL | Web only | Toast | No | Major |
| 6 | TLS | Schema enum | HTTP | No | Blocker |
| 7 | Mobile as server | Spec yes | No | No | Major |

---

## 11. Recommended planning order

1. **Trust:** dual-confirm pairing → derive/store `authSecret` → require on `/lyra/message`.  
2. **Transport:** TLS or app-level encryption; tighten CORS/auth.  
3. **Payloads:** clipboard_push, transfer chunks + resume, real `fs_list` (desktop first).  
4. **Platforms:** Electron as canonical peer; define mobile participation model.  
5. **Demo gate:** disable `seedDemo` in production builds for real success-criteria tests.  
6. **UI parity:** native Network card, integrity, Open URL, Demo resume.

---

## 12. Artifact index

| File | Description |
|------|-------------|
| `docs/verification-artifacts/ui-crawl.json` | Full text dump of crawled routes (2026-07-19) |
| `docs/verification-artifacts/web_*.png` | Web Devices, Clipboard, Transfers, Settings, pair dialog, device detail |
| `docs/verification-artifacts/native_*.png` | Expo web Devices, Clipboard, Transfers, Settings, Pair |
| `docs/Lyra-Product-Spec.md` | Product contract |
| `docs/AGENT-PROGRESS.md` | Implementation progress / runbook |

### Code anchors

- Domain: `packages/core/src/store.ts`, `identity.ts`, `demo.ts`
- Protocol: `packages/protocol/src/schemas.ts`, `messages.ts`
- Net: `packages/net/src/{auth,peer-client,probe,integrity}.ts`, `node/{peer-server,discovery}.ts`
- Web: `apps/web/src/routes/*`, `components/*`
- Native: `apps/native/app/**`
- Desktop: `apps/desktop/electron/main.ts`

---

## 13. Changelog of this document

| Date | Change |
|------|--------|
| 2026-07-19 | Initial detailed code-vs-spec report (chat). |
| 2026-07-19 | **Rev 2:** T3 MCP load verification of web `:3001`; Playwright crawl of web + Expo web; screenshots; UI parity table; saved as `docs/SPEC-VS-IMPLEMENTATION.md`. |

---

**End of report**
