# Open-source references (LocalSend / Sefirah)

Lyra’s product spec draws **design philosophy** from LocalSend and Sefirah. This note records what we actually studied and borrowed vs reinvented.

## Clone locations

```bash
# Optional local references (not a monorepo dependency)
git clone --depth 1 https://github.com/localsend/localsend.git ~/Works/examples/localsend
# Sefirah org/name may vary — prefer upstream used by product research
```

## LocalSend

| Pattern | LocalSend | Lyra |
|---------|-----------|------|
| LAN discovery | UDP multicast + HTTP /24 scan | `packages/net/src/node/discovery.ts` + `scanLanForPeers` |
| Multicast group | `224.0.0.167` (Android-friendly) | Same `224.0.0.167` |
| Multicast / HTTP ports | Same port `53317` for both | HTTP `53317`, UDP discovery `53318` |
| Per-interface join | `joinMulticast(group, interface)` each NIC | `addMembership(group, ifaceAddr)` each IPv4 |
| Announce + reply | Announcer triggers UDP/TCP reply so both see each other | `announce: true` → peer replies with `discover_response` |
| Announce burst | 100ms / 500ms / 2s | Same burst on start + Refresh |
| HTTP subnet scan | Concurrent /24 probe (50) | `scanLanForPeers` on Refresh discovery |
| Fixed peer HTTP port | Yes | `53317` default |
| Trust after first pin/pair | Session / pin model | Dual-confirm + mutual `authSecret` |
| Chunked file transfer | HTTP multipart / API | Custom Zod envelopes `transfer_offer` / `transfer_chunk` |
| API surface | `/api/localsend/v2/...` | **Not copied** — `/lyra/info`, `/lyra/auth/*`, `/lyra/message` |

**What we did not take:** Dart source, REST path layout, HTTPS-as-only transport, UI assets.

## Sefirah

| Pattern | Sefirah | Lyra |
|---------|---------|------|
| Device linking before clipboard | Explicit trust | Pairing + `authSecret` before sealed clipboard |
| Storage access | Browse + pull | Smart folders + `fs_list` (real OS on desktop peer) |
| Lightweight device status | Status channel | Protocol `status` type (periodic still light) |

**What we did not take:** C# / Android source trees as dependencies. No Sefirah code is vendored.

## Policy

- Prefer reading examples under `~/Works/examples` when designing protocol changes.
- Keep Lyra’s TypeScript + Zod protocol as the single source of truth.
- Document any future intentional API alignment here.

**Last updated:** 2026-07-19
