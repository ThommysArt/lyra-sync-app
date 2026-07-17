# T3 Code collaborative browser — agent guide

How agents (Grok, Codex, Claude) drive the **in-app preview browser** in T3 Code via MCP.

This is **not** a normal OAuth MCP like Vercel. Auth is a **per-agent-session bearer token** minted by the T3 Code desktop server and injected into the agent process. If that token is missing or expired, every `preview_*` call fails with **Auth required**.

---

## Architecture (what actually happens)

```
┌────────────────────┐     issues Bearer (idle 30m / max 8h)
│  T3 Code desktop   │ ─────────────────────────────────────┐
│  server :3773/mcp  │                                      │
│  PreviewAutomation │◄── preview_* ops ──┐                 │
└─────────┬──────────┘                    │                 │
          │ WebSocket                     │                 │
          ▼                               │                 │
┌────────────────────┐           ┌────────┴────────┐        │
│  Preview panel     │           │  Agent (Grok)   │◄───────┘
│  (collaborative    │           │  MCP client     │  Authorization: Bearer <token>
│   Chromium tab)    │           │  t3-code tools  │  url: http://127.0.0.1:3773/mcp
└────────────────────┘           └─────────────────┘
```

| Piece | Role |
|--------|------|
| **T3 Code server** (`http://127.0.0.1:3773/mcp`) | Streamable HTTP MCP. Requires `Authorization: Bearer <token>`. Returns `401 invalid_mcp_credential` without it. |
| **McpSessionRegistry** | Mints token at agent **session start**, hashes it, revokes on session stop. **Idle timeout 30 minutes** (no successful MCP request). **Max lifetime 8 hours**. |
| **GrokAdapter / CodexAdapter** | On `startSession`, reads the minted session and injects MCP config (Grok: ACP `mcpServers` + `Authorization` header; Codex: `T3_MCP_BEARER_TOKEN` + toml config). |
| **Preview panel** | Must be open/available so automation has a host. Prefer `preview_open` first. |
| **Tool cache** | Grok may list `t3-code` tools from disk cache even when the live handshake fails. **Listing tools ≠ authenticated.** |

Source of truth in the T3 Code tree (if you have it checked out):

- `apps/server/src/mcp/McpHttpServer.ts` — Bearer middleware
- `apps/server/src/mcp/McpSessionRegistry.ts` — issue / resolve / idle timeout
- `apps/server/src/provider/Layers/GrokAdapter.ts` — injects `mcpServers` into Grok ACP
- `apps/server/src/provider/Layers/CodexAdapter.ts` — injects env + `mcp_servers.t3-code.*`
- `apps/server/src/provider/Layers/ProviderService.ts` — `prepareMcpSession` only on **startSession**

---

## Correct agent workflow

### 1. Preconditions (human / environment)

1. **T3 Code desktop app is running** (not only the web marketing site).
2. You opened this project **from T3 Code** so the agent is spawned as a child (`grok agent stdio` under the T3 server).  
   - Standalone `grok` in a terminal **does not** get the injected bearer. `grok mcp list` will not show `t3-code`.
3. Dev servers use **fixed ports** when possible:
   - Web: `http://localhost:3001`
   - Expo web: `http://localhost:8081`
4. Before a long coding session, if you will need the browser later, either call a preview tool early or plan a **fresh agent thread** for UI work (see token lifetime).

### 2. Agent call order (reliable)

Always use tools via Grok’s MCP meta-tools: **`search_tool` first**, then **`use_tool`** with the qualified name `t3-code__preview_*`.

```
1) search_tool  query: "t3-code preview"
2) use_tool     t3-code__preview_open
                  { show: true }
3) use_tool     t3-code__preview_navigate
                  preferred for local apps:
                  { target: { kind: "environment-port", port: 3001, path: "/" } }
                  or absolute:
                  { url: "http://localhost:3001/" }
4) use_tool     t3-code__preview_wait_for
                  { text: "Devices", timeoutMs: 15000 }
5) use_tool     t3-code__preview_snapshot
                  {}   → screenshot + semantic tree + console diagnostics
6) interact     preview_click / preview_type / preview_press / preview_evaluate
7) optional     preview_status anytime to check URL / loading / viewport
```

**Navigation rules:**

| Goal | Arguments |
|------|-----------|
| Public site | `{ "url": "https://example.com" }` |
| Dev server in this environment | `{ "target": { "kind": "environment-port", "port": 3001, "path": "/" } }` |
| Explicit local URL | `{ "url": "http://localhost:3001/" }` |

Prefer **`environment-port`** for app servers: T3 rewrites loopback correctly for remote environments. For a pure local desktop session, either form works.

**Do not** invent Playwright-only APIs. Prefer locators from the last **snapshot** (`role=…`, `text=…`).

### 3. Keep the credential alive

- The bearer is created **once per agent session start**, not on every chat turn.
- **Idle timeout: 30 minutes** without a successful authenticated MCP request → next call fails with Auth required.
- **Mitigation:** call `preview_status` or `preview_snapshot` occasionally during long sessions, **or** open a **new agent chat/thread** before UI verification work.

### 4. Ports left busy by previous agents

Previous sessions often leave Vite/Expo running:

```bash
# See who holds the ports
ss -tlnp | grep -E ':3001|:8081'

# Free them (only the listeners you own)
fuser -k 3001/tcp 2>/dev/null || true
fuser -k 8081/tcp 2>/dev/null || true

# Restart Lyra web on the canonical port
pnpm run dev:web    # apps/web vite → :3001
```

If 3001 is taken, Vite may silently bind **3002**. Agents should check the terminal log and navigate to the actual port (or free 3001 first).

---

## Failure modes and fixes

| Symptom | Cause | Fix |
|---------|--------|-----|
| `Auth required` / `invalid_mcp_credential` / handshake failed on initialize | Missing or **expired** provider-scoped Bearer | **Start a new agent chat/thread** in T3 Code (restarts Grok → new `prepareMcpSession`). Do not keep hammering tools in a multi-hour session without MCP use. |
| Tools listed, but every call fails auth | Grok **tool schema cache** still shows `t3-code`; live HTTP auth is dead | Same as above — new session. Confirm with curl (below). |
| `grok mcp list` has no `t3-code` | Agent not launched under T3 Code, or injection failed | Run the agent from T3 Code for this workspace. Do not hand-add a static `t3-code` entry without a live bearer (it will 401). |
| Navigate works but snapshot/actions fail | Preview host not connected / panel closed | `preview_open` with `show: true`, then retry. |
| Wrong app / empty page | Dev server on another port | Check terminal for “Local: http://localhost:…”, free 3001, restart, use `environment-port`. |
| Vercel MCP `auth required` | Separate OAuth issue | `/mcps` → authenticate Vercel. Unrelated to t3-code browser. |

### Sanity checks (shell)

```bash
# MCP endpoint is up but rejects unauthenticated traffic (expected 401)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3773/mcp \
  -H 'Content-Type: application/json' -d '{}'
# → 401 with body: invalid_mcp_credential

# Agent process should be child of t3code server when injection is correct
ps -o pid,ppid,cmd -C grok | head
# e.g. "grok agent stdio" PPID = t3code .../bin.mjs
```

You **cannot** mint a valid Bearer from outside the T3 server. Tokens are random, stored only as hashes, and only issued at session start.

---

## What agents should not do

1. **Do not** add a permanent `[mcp_servers.t3-code]` in `~/.grok/config.toml` with a pasted token — tokens die in ≤30m idle / 8h max, and secrets end up in config.
2. **Do not** treat “13 tools available” as proof of auth.
3. **Do not** use `localhost` URLs in remote/cloud environments without `environment-port` (loopback is the agent’s machine, not the user’s).
4. **Do not** leave multiple Vite/Expo instances on random ports; kill and restart on 3001/8081.

---

## Recommended Lyra verification script (agent checklist)

After implementing UI:

1. Free ports 3001 (and 8081 if testing Expo).
2. `pnpm run dev:web` → confirm log says `http://localhost:3001/`.
3. If the agent session is **>25 minutes old** and browser has not been used yet → **ask the human to start a new chat**, or expect Auth required.
4. In a **fresh** session, within the first minutes:
   - `preview_open`
   - `preview_navigate` → `environment-port` 3001
   - `preview_wait_for` → text `Devices` or `Lyra`
   - `preview_snapshot` → confirm no “Maximum update depth”, devices list visible
5. Exercise: Pair dialog, Transfers → Demo conflict, Settings shortcuts list.

---

## Quick reference — tool names

| Tool | Purpose |
|------|---------|
| `t3-code__preview_open` | Show preview panel / init tab |
| `t3-code__preview_navigate` | Go to URL or environment port |
| `t3-code__preview_status` | URL, title, loading, viewport |
| `t3-code__preview_snapshot` | Screenshot + a11y/semantic tree + diagnostics |
| `t3-code__preview_click` | Click by locator/selector/coords |
| `t3-code__preview_type` | Type into input |
| `t3-code__preview_press` | Key + modifiers |
| `t3-code__preview_scroll` | Scroll page or container |
| `t3-code__preview_evaluate` | Run JS in page |
| `t3-code__preview_wait_for` | Wait for locator/text/URL |
| `t3-code__preview_resize` | Viewport preset/freeform |
| `t3-code__preview_recording_*` | Optional session recording |

Human shortcut: **Mod+Shift+J** toggles the preview panel in T3 Code desktop (`preview.toggle`).

---

## Summary

- **Right way:** Agent runs **inside T3 Code** → server injects **Bearer** → call **`preview_open` → `preview_navigate` (`environment-port`) → `preview_snapshot`**.
- **Most common failure:** Long-lived agent process, MCP idle **30m**, then **Auth required**. Fix: **new agent thread**, then use the browser early.
- **Ports:** Keep web on **3001**; kill stragglers before claiming “the app is broken.”
