# ChatGPT custom GPT — using enquire over remote MCP

ChatGPT custom GPT actions speak HTTP, not stdio. Use `enquire-mcp serve-http` with `--stateful` (required for ChatGPT) and a bearer token, then expose the local server through a TLS tunnel (Tailscale Funnel or Cloudflare Tunnel).

## 1. Generate a bearer token

```bash
enquire-mcp gen-token > ~/.config/enquire/token
chmod 600 ~/.config/enquire/token
```

## 2. Start the HTTP server (stateful mode)

```bash
enquire-mcp serve-http \
  --vault "/path/to/Obsidian Vault" \
  --port 3030 \
  --bearer-token-env ENQUIRE_TOKEN \
  --stateful \
  --persistent-index \
  --cors-origin https://chat.openai.com \
  --cors-origin https://chatgpt.com
```

> **v3.7.6 audit fix + v3.8.0 update**: Pre-v3.7.6 this example showed `--enable-reranker`, `--use-hnsw`, and `--include-pdfs`. As of v3.8.0 (R-3 closure, rc.1 `addAdvancedRetrievalOptions` helper), `serve-http` now accepts the same 8 advanced retrieval flags as `serve`. The example above is the minimal config; for the full hybrid stack add `--enable-reranker --use-hnsw --include-pdfs` (same as `serve`). See [`docs/http-transport.md`](../docs/http-transport.md) for the full supported flag matrix.

Set the env var first: `export ENQUIRE_TOKEN=$(cat ~/.config/enquire/token)`.

## 3. Expose via TLS tunnel

### Tailscale Funnel (free, requires Tailscale)

```bash
tailscale funnel --bg 3030
# Prints: https://your-machine.tailnet.ts.net/
```

### Cloudflare Tunnel (free, requires Cloudflare account)

```bash
cloudflared tunnel --url http://127.0.0.1:3030
# Prints: https://random-name.trycloudflare.com
```

## 4. Wire into ChatGPT custom GPT actions

In the GPT builder → "Add actions":

1. **Schema:** import the OpenAPI 3.0 spec at `https://your-tunnel-host/.well-known/openapi.json` if the gateway serves one, OR hand-author a minimal spec for the `/mcp` endpoint (see [docs/http-transport.md](../docs/http-transport.md)).
2. **Authentication:** Bearer Token, paste the value of `~/.config/enquire/token`.
3. **Privacy policy URL:** point at any URL you control (e.g. your GitHub README); ChatGPT requires it for actions.

## 5. Test

In the GPT preview, ask: *"Search my vault for notes about prompt engineering. Use the enquire action."*

The GPT should call `obsidian_search` over MCP and return ranked hits with `per_signal` observability.

## Why `--stateful` matters

ChatGPT custom GPTs treat the MCP server as a long-lived session — they expect to reuse `Mcp-Session-Id` across calls and may issue `GET /mcp` for server-initiated notifications. Stateless mode (the default for security reasons) returns a fresh session per request, which ChatGPT misinterprets as connection failures.

Side benefit: stateful mode opens up server-push patterns (notifications, sampling, elicitations) that other clients can use too.

## Privacy / safety

- The bearer token is the only auth — treat it like an SSH key. Rotate with `enquire-mcp gen-token` and restart the server.
- `--cors-origin` allowlist is enforced; never use `--cors-origin '*'` with a credentialed token.
- Pair with `--exclude-glob` and/or `--read-paths` to keep private folders out of search results — ChatGPT will see only what those filters allow.
- Default `--host 127.0.0.1` keeps the server bound locally; the tunnel is what makes it reachable. If you bind to `0.0.0.0` you skip the tunnel — but then *anyone* on your network can hit it. Pick one trust boundary.
