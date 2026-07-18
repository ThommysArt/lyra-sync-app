# Lyra Desktop (Electron)

Hosts the **local HTTP peer server** and **UDP multicast discovery**, and loads the web UI.

## Prerequisites

```bash
# Terminal 1 — web UI
pnpm run dev:web   # http://localhost:3001

# Terminal 2 — desktop shell
pnpm --filter desktop dev
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `LYRA_WEB_URL` | `http://localhost:3001` | Renderer URL |
| `LYRA_PORT` | `53317` | Peer HTTP listen port |
| `LYRA_NAME` | `Lyra Desktop` | Device display name |

## IPC bridge (`window.lyraDesktop`)

- `getPeerStatus()` — running / port / discovery
- `restartNetworking()` — restart peer server + multicast
- `onPeerStatus(cb)` / `onDiscoveredPeer(cb)` — live events

The web app detects `window.lyraDesktop` and updates Settings → Network accordingly.
