# HTTP transport (remote MCP) — `enquire-mcp serve-http`

> Available since v2.6.0. [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) — the protocol Claude.ai web, ChatGPT, Cursor's HTTP mode, and most mobile MCP clients use to talk to a remote server. **v4 serves modern MCP `2026-07-28` and supported legacy 2025-era clients from the same tool/prompt/resource factory.** Modern HTTP is per-request; `--stateful` preserves sticky sessions and SSE/DELETE lifecycle for legacy clients that require them. See [Operational notes](#operational-notes) for the stateful-mode flag matrix.

The default `serve` subcommand runs over **stdio** — fast, secure, but local-only. `serve-http` runs the same server (same tools, same vault, same indexes) over **HTTP**, so an agent can reach it from a browser tab, a phone, or another machine.

## TL;DR

```bash
# 1. Generate a bearer token (one-time, store in a password manager)
mkdir -p ~/.enquire
enquire-mcp gen-token > ~/.enquire/token   # base64url, 43 chars

# 2. Start the HTTP server (binds 127.0.0.1:3000 by default).
#    Use --bearer-token-env so the token never lands in `ps`, shell history,
#    or systemd's journal — pass the env-var NAME, not the value.
ENQUIRE_BEARER_TOKEN="$(cat ~/.enquire/token)" \
enquire-mcp serve-http \
  --vault ~/Obsidian/MyVault \
  --bearer-token-env ENQUIRE_BEARER_TOKEN \
  --persistent-index

# 3. Verify it's up
curl http://127.0.0.1:3000/health
# → ok

# 4. Configure your client (claude.ai, ChatGPT, Cursor, etc.) with:
#    URL:           http://127.0.0.1:3000/mcp   (or your tunnel URL)
#    Auth header:   Authorization: Bearer <your-token>
```

> `--bearer-token <token>` works too and is fine for quick local one-offs,
> but the value shows up in `ps auxww` while the server is running and gets
> persisted in shell history. Prefer `--bearer-token-env` for systemd units,
> Docker containers, and anything multi-user.

## Protocol-era routing in v4

| Incoming traffic | Route | Session behavior |
|---|---|---|
| Modern `2026-07-28` request | Strict official SDK v2 handler | Fresh server per request; no legacy session allocation or `Mcp-Session-Id` requirement. |
| Supported legacy POST, default mode | Official v2 legacy Node transport | Stateless, fresh server/transport for the request. |
| Supported legacy traffic with `--stateful` | Existing session registry over the official v2 legacy Node transport | `initialize` allocates a bounded sticky session; follow-up POST/GET/DELETE retain the established lifecycle. |
| Malformed or unsupported modern claim | Strict modern error ladder | Never downgraded to legacy, even when `--stateful` is enabled. |

Admission stays outside both protocol legs: exact Origin policy, bearer auth, rate limiting, a bounded body, and `application/json` validation run before era routing. Every POST body is parsed once and forwarded to the selected SDK path. A modern request carrying a legacy session id cannot bind to that session.

## When to use HTTP vs stdio

| Use case | Transport |
|---|---|
| Claude Code / Cursor / Codex on the same machine as your vault | **stdio** (`serve`) — faster, no network setup |
| Claude.ai web (browser) reaching your local vault | **HTTP** + tunnel |
| ChatGPT custom GPT with MCP integration | **HTTP** + public tunnel |
| Phone agents (Claude mobile, Khoj mobile) | **HTTP** + tunnel |
| Shared vault for a small team | **HTTP** on a small VM (one process, multiple bearer tokens via reverse proxy) |
| Long-lived background agent that wakes up daily | **HTTP** + cron + tunnel |

## All flags

| Flag | Default | Purpose |
|---|---|---|
| `--vault <path>` | (required) | Vault root — same semantics as `serve`. |
| `--bearer-token <token>` | (required, ≥16 chars) | Token clients must present in the `Authorization: Bearer …` header. Generate with `enquire-mcp gen-token`. |
| `--bearer-token-env <name>` | — | Read the token from this env var instead of the flag. Cleaner for systemd / `.env` files / shared shells where flags are visible in `ps`. Either flag is required. |
| `--port <n>` | `3000` | TCP port. Pass `0` for kernel-assigned (useful in tests). |
| `--host <host>` | `127.0.0.1` | Bind host. **Keep on `127.0.0.1`** unless you've thought hard about exposing the server directly — `0.0.0.0` is opt-in because remote-MCP must front a tunnel. |
| `--mcp-path <path>` | `/mcp` | URL path for the MCP endpoint. |
| `--rate-limit <n>` | `120` | Max requests per minute per bearer token. `0` disables. Sliding 60-second window, in-memory (single process). |
| `--cors-origin <origin...>` | (empty) | Exact browser Origin allowlist. Repeatable. A request without `Origin` (the ordinary native MCP path) is accepted. Every present value must exactly match a configured HTTP(S) origin such as `https://claude.ai` or gets `403` before any route/auth/body/MCP handling. Wildcard `*`, opaque `null`, paths, queries and malformed origins are rejected at startup. An admitted origin receives `Access-Control-Allow-Credentials: true`; list every browser origin explicitly. |
| `--health-path <path>` | `/health` | Unauthenticated probe path that returns `ok`. Useful for tunnel/uptime monitors. |
| `--enable-write` | off | Same as `serve` — gates the write tools. |
| `--persistent-index`, `--watch`, `--exclude-glob`, `--read-paths`, `--disabled-tools`, `--enabled-tools`, `--diagnostic-search-tools`, `--max-file-bytes`, `--cache-size`, `--persistent-cache`, `--cache-file` | — | Identical semantics to `serve`. |

Health probe and OPTIONS preflight are unauthenticated. Everything else under `--mcp-path` requires a valid Bearer.

## Security model

This is the **opinionated** part of the design. Read it before exposing the endpoint.

### Threat model

We assume:
- The bearer token is a long random secret you treat like a password.
- The transport between client and server is encrypted (HTTPS) — **we don't terminate TLS ourselves**, you put a reverse proxy or tunnel in front.
- The host running `enquire-mcp` is your machine (or a small VM you own). We don't sandbox the server itself.

We protect against:
- **Unauthenticated read.** Wrong/missing token → 401, fail-closed.
- **Token timing leaks.** Bearer compare hashes both sides with SHA-256 first, then `crypto.timingSafeEqual` on equal-length buffers. No length oracle.
- **Token logging.** Logs use the SHA-256 prefix as the rate-limit key — the raw token never appears in stderr or rate-limit state.
- **Rate-limit abuse.** Default 120 req/min per token; tunable via `--rate-limit`.
- **DNS rebinding / Origin spoofing.** Every present Origin must exactly match `--cors-origin` or receives `403` before OPTIONS, health, auth, rate limiting, body parsing, session allocation, or MCP dispatch. Missing Origin remains valid for native clients. Browser CORS response headers are applied only after that admission decision.
- **Body bombs.** Per-request body cap is derived from `--max-file-bytes` (default 5 MiB) as `max(4 MiB, max-file-bytes × 6 + 64 KiB)` (~30.06 MiB at the default) — worst-case JSON `\u00xx` expansion plus a 64 KiB envelope. Overflow returns `413 Request body too large` before JSON.parse; malformed bodies still get `400 Parse error`. v3.7.12 made derivation explicit; a later escape-budget correction replaced the old ×1.5 / 7.5 MB formula. Pre-3.7.12 the cap was a hardcoded 4 MB which was BELOW the 5 MB file cap.
- **Protocol confusion.** POSTs require an unambiguous `application/json` media type before parsing. The official SDK v2 classifier owns the modern/legacy decision; every non-legacy outcome stays on the strict modern path, so a malformed or unsupported modern request cannot gain legacy behavior through fallback.
- **Shutdown integrity.** Modern and legacy-stateless requests share an aggregate persistent-write tracker; legacy stateful sessions retain their per-session tracker. Shutdown closes admission, gives ordinary exchanges a bounded grace, rolls back cancellation-safe batch mutations, waits for atomic/finish-only writes, and only then closes the shared vault/index resources.

We do **not** protect against:
- TLS downgrade — that's the tunnel's job. Always front with HTTPS.
- A compromised client. Treat the token like a password.
- Denial of service from a single token — a malicious client can fire rate-limit-budget requests forever; we just answer 429 once it's over budget. Use the tunnel's WAF for upstream DoS protection.
- Sophisticated cross-tenant attacks across multiple tokens — this is a single-tenant tool. A small team should run one process per user (e.g. systemd template unit) and not share tokens.
- Bypassing the privacy filter (`--exclude-glob`, `--read-paths`) via crafted requests — the same audit-tested filter applies on every search/read path; there are no HTTP-specific shortcuts.

### Bearer token generation

```bash
# Recommended:
enquire-mcp gen-token
# → t7Q1nLkYQrfbXrI9w1Tj2kZ4u_FZCgC5RT8HNqkR1PA

# Equivalent ad-hoc:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# Save it once:
mkdir -p ~/.enquire
enquire-mcp gen-token > ~/.enquire/token
chmod 600 ~/.enquire/token
```

Tokens are 32 random bytes encoded as base64url (43 chars, no padding, URL/header-safe). 256 bits is sufficient — far beyond brute-force at any rate limit.

### Reading from env (recommended for systemd)

```bash
# .env or systemd EnvironmentFile=
ENQUIRE_TOKEN=t7Q1nLkYQrfbXrI9w1Tj2kZ4u_FZCgC5RT8HNqkR1PA
```

```bash
enquire-mcp serve-http --vault ~/Obsidian --bearer-token-env ENQUIRE_TOKEN
```

The token doesn't appear in `ps aux`, shell history, or arg-trace logs.

## Deployment recipes

### Recipe 1 — Tailscale Funnel (zero-config, recommended)

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) gives you a public HTTPS URL routed through Tailscale's MagicDNS, with TLS handled for you. Free for personal use.

```bash
# One-time setup:
tailscale up
tailscale funnel 3000

# Run enquire-mcp on localhost:3000
enquire-mcp serve-http \
  --vault ~/Obsidian \
  --bearer-token-env ENQUIRE_TOKEN \
  --port 3000 \
  --cors-origin https://claude.ai
```

Tailscale Funnel proxies `https://<machine>.<tailnet>.ts.net/` → `localhost:3000`. Configure your client with:

- URL: `https://<machine>.<tailnet>.ts.net/mcp`
- Authorization: `Bearer <your-token>`

You **don't** need to bind to `0.0.0.0` — Funnel reaches localhost via Tailscale's userspace.

### Recipe 2 — Cloudflare Tunnel (no Tailscale account)

```bash
# One-time:
brew install cloudflared
cloudflared tunnel login        # opens browser, auths to your zone
cloudflared tunnel create enquire
# → outputs a UUID; save it as ~/.cloudflared/<uuid>.json

# Route a hostname:
cloudflared tunnel route dns enquire vault.yourdomain.com

# Run the tunnel + the server (in two terminals or two systemd units):
cloudflared tunnel run --url http://localhost:3000 enquire
enquire-mcp serve-http \
  --vault ~/Obsidian \
  --bearer-token-env ENQUIRE_TOKEN \
  --cors-origin https://claude.ai https://chatgpt.com
```

Client hits `https://vault.yourdomain.com/mcp` — Cloudflare terminates TLS, validates the host, forwards to your machine over the tunnel.

### Recipe 3 — ngrok (quick demo / dev)

```bash
ngrok http 3000

# In another terminal:
enquire-mcp serve-http --vault ~/Obsidian --bearer-token-env ENQUIRE_TOKEN
```

ngrok prints `https://abc123.ngrok-free.app` — your endpoint is `https://abc123.ngrok-free.app/mcp`. Free tier rotates the URL on every restart; paid plans get a static domain.

### Recipe 4 — direct LAN (no tunnel — local network only)

```bash
# DANGEROUS without TLS — only on a trusted private network you control.
enquire-mcp serve-http \
  --vault ~/Obsidian \
  --bearer-token-env ENQUIRE_TOKEN \
  --host 0.0.0.0 \
  --port 3000
```

Then on another machine on the same LAN: `http://<your-ip>:3000/mcp`. The bearer token is sent in plaintext — only acceptable on a private network behind a real firewall. **Don't do this on coffee-shop WiFi or any network you don't fully control.**

### Recipe 5 — systemd service (production)

`/etc/systemd/system/enquire.service`:

```ini
[Unit]
Description=enquire-mcp HTTP transport
After=network-online.target

[Service]
Type=simple
User=enquire
EnvironmentFile=/etc/enquire/env
ExecStart=/usr/local/bin/enquire-mcp serve-http \
  --vault /home/enquire/vault \
  --bearer-token-env ENQUIRE_TOKEN \
  --persistent-index \
  --watch \
  --port 3000 \
  --rate-limit 240
Restart=on-failure
RestartSec=5
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/enquire/.cache/enquire

[Install]
WantedBy=multi-user.target
```

`/etc/enquire/env` (mode 600, owner `enquire`):

```
ENQUIRE_TOKEN=<your-token>
```

Pair with a Cloudflare tunnel (Recipe 2) or nginx + Let's Encrypt for TLS termination.

## Client configuration

### Claude.ai web (Pro/Team/Enterprise)

Settings → Integrations → Add custom MCP:
- **Name:** Obsidian Vault
- **URL:** `https://<your-tunnel>/mcp`
- **Auth:** Bearer
- **Token:** your token

### Cursor (HTTP mode)

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "enquire": {
      "url": "https://<your-tunnel>/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

### ChatGPT (custom GPT)

In the GPT Builder → Configure → Actions → Authentication → API key → "Bearer" → paste token. Schema URL points at `/mcp`. (ChatGPT's MCP support is rolling out — check OpenAI docs for the exact wiring.)

### Khoj mobile

Settings → MCP servers → Add. URL + bearer token.

### Manual (curl)

```bash
TOKEN="$(cat ~/.enquire/token)"
URL="http://127.0.0.1:3000/mcp"

# Initialize
curl -sX POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'

# tools/list
curl -sX POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## Operational notes

- **Stateless mode (default).** Every request creates a fresh `McpServer` instance over the **shared** vault + index handles. SQLite stays open; only the per-request server class is recreated. This means session-scoped state (e.g. a paginating cursor) doesn't carry across requests — each request is independent. Best choice when your client (claude.ai web, Cursor, Khoj) doesn't need persistent session state.
- **Stateful mode (v2.14.0, opt-in via `--stateful`).** Sessions are keyed by the `Mcp-Session-Id` response header. The first POST without that header is the `initialize` handshake; subsequent POSTs route to the same `McpServer` + `StreamableHTTPServerTransport`. `GET /mcp` opens a long-lived SSE stream. `DELETE /mcp` explicitly terminates a session (idempotent). It ordinarily drains active calls for up to five seconds; if a persistent write is still active, rollback-safe batches are cancelled and restored, atomic effects finish, and DELETE returns retryable **409** + `Retry-After` while retaining the session. Retry DELETE after the original tool call settles. Required for **ChatGPT custom GPT actions**. `--max-sessions <n>` (default 100) caps concurrency, returning 503 + `Retry-After` on overflow. `--session-idle-timeout-ms <n>` (default 30 min) evicts stale sessions on every request via a lazy sweep — no separate timer thread.
- **Cold start.** First request after server start does the FTS5 sync; subsequent requests hit the warm index. `--watch` keeps it warm across vault edits without reboots.
- **Rate limit is per-process.** If you run multiple processes (e.g. team-tier with one process per user behind a reverse proxy), each enforces its own bucket. For shared limits use the reverse proxy's rate-limit module.
- **Logs go to stderr.** The ready banner, skip-tool warnings, and transport errors all go to stderr — keep it captured by systemd / your tunnel.

## Why enquire's HTTP transport

Remote access keeps the same local-first retrieval engine and source-grounded
results while adding an explicit network trust boundary. Choose stateless mode
for independent requests or stateful mode when the client needs session reuse,
SSE, and explicit termination. Exact-Origin admission, bearer auth, CORS, rate/session/connection
bounds, readiness, and rollback-aware session shutdown are part of the same
server instead of an external compatibility layer.

See [`COMPARISON.md`](./COMPARISON.md) for the complete product case.

## Troubleshooting

**`enquire serve-http: --bearer-token is required and must be ≥16 chars.`**
You either forgot the token or it's too short. Generate one with `enquire-mcp gen-token`.

**`enquire fatal: --port must be an integer in [0, 65535]`**
You passed something that's not a non-negative integer. Use `0` for ephemeral, `3000` for default, or any port your firewall lets through.

**Client gets 401 with the right token**
Double-check there's no leading/trailing whitespace in your env var. `--bearer-token "$(cat token)"` includes a trailing newline — use `--bearer-token-env` and `printf` (no trailing `\n`) instead, or trim with `tr -d '\n'`.

**Browser client gets CORS errors**
Add the browser page's exact serialized origin with `--cors-origin https://claude.ai` (or whichever domain), without a trailing slash or path. Wildcard `*` is intentionally rejected: it cannot protect a local MCP endpoint from DNS rebinding.

**Browser request gets `403 Forbidden: Origin is not allowed`**
The request included an Origin that was not an exact `--cors-origin` entry. Compare scheme, hostname and optional port exactly; `https://example.com` and `https://example.com:8443` are different origins. Do not add a path, query, trailing slash, `null`, or `*`.

**Initialize succeeds but `tools/list` returns nothing**
You probably set `--enabled-tools` to a name that doesn't match. Check stderr — the warning `--enabled-tools "<name>" did not match any tool` lists every registered tool name.
