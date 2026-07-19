# Agent notes — Lyra

## Dev servers

| App | Command | Port |
|-----|---------|------|
| Web | `pnpm run dev:web` | **3001** |
| Desktop | `pnpm run dev:web` (terminal 1) + `pnpm run dev:desktop` (terminal 2) | UI on **3001** via Electron |
| Expo web | `cd apps/native && CI=true pnpm exec expo start --web --port 8081 --clear` | **8081** |

If Vite prints another port, something is still bound to 3001 — free it:

```bash
fuser -k 3001/tcp 2>/dev/null || true
fuser -k 8081/tcp 2>/dev/null || true
```

### Desktop / Electron notes

- Dev launcher auto-adds `--no-sandbox` on Linux when `chrome-sandbox` is not root/setuid (common with pnpm-installed Electron).
- It also clears `ELECTRON_RUN_AS_NODE` so the binary does not fall back to plain Node.
- Demo mesh is **off by default**. Opt in with `VITE_LYRA_SEED_DEMO=1` (web/e2e) or `EXPO_PUBLIC_LYRA_SEED_DEMO=1` (native).

## T3 Code browser (required for UI verification in T3)

Read **`docs/T3-CODE-BROWSER.md`** before using `preview_*` tools.

Short version:

1. Agent must be launched **from T3 Code** (parent injects MCP Bearer to `http://127.0.0.1:3773/mcp`).
2. Order: `preview_open` → `preview_navigate` with `{ target: { kind: "environment-port", port: 3001 } }` → `preview_snapshot`.
3. Bearer **idle-expires after 30 minutes**. If tools fail with **Auth required**, stop retrying — **open a new agent chat** so T3 mints a new credential.
4. Tool schemas in the cache can list `t3-code` even when live auth is dead.

## Product docs

- Spec: `docs/Lyra-Product-Spec.md`
- Progress / todos: `docs/AGENT-PROGRESS.md`
