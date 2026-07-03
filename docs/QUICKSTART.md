# Quickstart — enquire-mcp in 5 minutes

From `npm install` to a working **long-term memory layer for your AI agents**, backed by your Obsidian vault, inside Claude Desktop (or any MCP client). One happy path. Concrete commands, expected output, troubleshooting at the bottom.

> **What "memory layer" means here.** Unlike vendor-specific chat memory (Claude Memory, ChatGPT Memory, Cursor memory) that locks your knowledge into one provider's cloud, enquire-mcp turns any directory of `.md` files into queryable, semantically-searchable memory accessible from every MCP-compatible agent. The knowledge is yours, in plain markdown, portable forever.

## What you'll get

- **Hybrid search** across every `.md` in your vault — BM25 + TF-IDF fused via Reciprocal Rank Fusion (Cormack et al, 2009), so keyword hits *and* related-term hits both surface.
- **Top-K ranked notes with snippets** — each result returns the matching note path, a ~120-char snippet around the hit, and per-signal scores so you see why it ranked.
- **No Obsidian app required** — any directory with `.md` files works. Obsidian doesn't even need to be installed.
- **Works in every MCP client** — Claude Desktop, Claude Code, Cursor, ChatGPT custom GPT, Codex, OpenClaw, mobile MCP clients. One server, one config snippet per client.

## Prerequisites

- **Node 22.13+ required** (since v3.7.13 the `engines.node` floor matches the CI matrix — `pdfjs-dist@6+` requires `>=22.13.0` and CI tests Node 22 + 24). On Node 20 the install will reject with `unsupported engine`; if you need Node 20 for non-PDF use cases, pin to v3.7.12 or earlier.
- **An Obsidian vault folder** — any directory containing `.md` files. If you don't have one, `mkdir ~/TestVault && echo "# Hello" > ~/TestVault/note.md` is enough to follow this guide.
- **An MCP client** — one of: Claude Desktop, Claude Code, Cursor, ChatGPT custom GPT (with remote MCP), Codex, OpenClaw, or any other MCP-compatible client.

## Step 1 — Install (15 seconds)

```bash
npm install -g @oomkapwn/enquire-mcp
```

Verify the install:

```bash
enquire-mcp --version
```

Expected output: your installed version string (matching the newest `@latest` release in the [CHANGELOG](../CHANGELOG.md)).

## Step 2 — Smoke test (30 seconds)

Before touching any client config, confirm the server can read your vault. `enquire-mcp doctor` is a read-only health check — verifies the vault path, optional deps (better-sqlite3, transformers.js, pdfjs, tesseract, canvas), the embedding-model cache, and the FTS5 / embed-db state. Color-coded output. Exits 0 when everything is ready for hybrid retrieval, 1 when something critical is missing.

```bash
enquire-mcp doctor --vault /absolute/path/to/your/vault
```

Expected output: a checklist where the vault path is `OK` and at least one search tier is green. Optional deps may show `WARN` if you haven't run `setup` yet — that's fine for the basic happy path; you'll still get TF-IDF search out of the box.

If you want machine-readable output (for CI or scripts), append `--json`. If `doctor` exits 0, you're ready to wire it in.

## Step 3 — Wire into Claude Desktop (60 seconds)

Open Claude Desktop's config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Add the `enquire` block under `mcpServers`. If the file is empty or missing, paste the whole snippet:

```json
{
  "mcpServers": {
    "enquire": {
      "command": "enquire-mcp",
      "args": ["serve", "--vault", "/absolute/path/to/your/vault"]
    }
  }
}
```

What each piece does:

| Field | Meaning |
|---|---|
| `"enquire"` | Display name for the MCP server inside Claude Desktop. Rename freely. |
| `"command": "enquire-mcp"` | The CLI installed in Step 1. Claude Desktop spawns this as a child process. |
| `"args": ["serve", ...]` | `serve` is the default subcommand — starts the MCP server over stdio. |
| `"--vault", "/abs/path"` | Required. Absolute path to the directory containing your `.md` files. |

Notes:

- The vault path **must be absolute** — `~/MyVault` won't work; use `/Users/you/MyVault` (or run `realpath ~/MyVault` to get the absolute form).
- If Claude Desktop can't find `enquire-mcp` on its `PATH`, replace `"command": "enquire-mcp"` with `"command": "npx"` and `"args": ["-y", "@oomkapwn/enquire-mcp@latest", "serve", "--vault", "/absolute/path/to/your/vault"]`. The `npx` form is also what [`examples/claude-desktop.json`](../examples/claude-desktop.json) ships with.

Save the file.

## Step 4 — First search (60 seconds)

**Fully quit Claude Desktop** (Cmd-Q on macOS — closing the window isn't enough) and reopen it.

In a new conversation, ask:

> Search my vault for everything about RAG

What Claude does under the hood:

1. It calls the `obsidian_search` MCP tool with your query.
2. The server fuses every available ranker — BM25 (if `--persistent-index` is on), TF-IDF cosine (always on), and ML embeddings (if you've built them via `setup`) — using Reciprocal Rank Fusion with `k=60`.
3. A wikilink graph-boost reranks the top-K via 1-step personalised PageRank (so notes linked from your most relevant hits rise).
4. Each returned hit carries `path`, `title`, `score`, `snippet`, and a `per_signal` block showing which ranker contributed at what rank — observability built into the response shape.

You'll see Claude's tool-call indicator fire, then a list of matching notes with paths, snippets, and a short synthesis. The raw tool response shape looks roughly like:

```json
{
  "query": "RAG",
  "method": "rrf",
  "k": 60,
  "signals_used": ["tfidf"],
  "total_candidates": 12,
  "matches": [
    {
      "path": "02_Notes/RAG-architecture.md",
      "title": "RAG architecture",
      "score": 0.0328,
      "snippet": "…retrieval-augmented generation (RAG) fuses dense and sparse…",
      "per_signal": { "tfidf": { "rank": 1, "score": 0.41 } }
    }
  ]
}
```

If the tool call doesn't fire, see **Troubleshooting** below.

Want to test from the terminal instead? Once you've built the FTS5 index via `setup`, the `eval` subcommand will run a full retrieval benchmark against a JSONL of known-relevant queries (see [`examples/queries.jsonl`](../examples/queries.jsonl) for the format).

## What's next

You now have working TF-IDF search. To unlock the full hybrid stack:

- **One-command full setup** — `enquire-mcp setup --vault /absolute/path/to/your/vault` downloads the multilingual embedding model (~120 MB, one-time), builds the FTS5 BM25 index, and builds the embedding index. Idempotent.
- **PDF search** — add `--include-pdfs` to your Claude Desktop args. PDFs get blended into `obsidian_search` results with `[page: N]` citation markers.
- **Cross-encoder reranking** — add `--enable-reranker`. Measured +15.5 NDCG@10 / +24.7 MRR (60-query ablation).
- **Sub-10ms top-K at scale** — add `--use-hnsw`. HNSW vector index, persisted to disk so cold starts stay ~50ms.
- **Harder questions** — try `obsidian_hyde_search` (HyDE retrieval, Gao et al 2023) when the literal query phrasing doesn't match how the notes are written.
- **Full 45-tool surface** — see [`docs/api.md`](./api.md) for every read/write tool, MCP resource, and prompt.

The drop-in hybrid config is in [`examples/claude-desktop-hybrid.json`](../examples/claude-desktop-hybrid.json).

## Troubleshooting

**Claude doesn't show the tools.** Fully quit Claude Desktop (Cmd-Q, not just close-window) and reopen. The MCP server is loaded once at startup; closing the window keeps the old config in memory. After reopening, look for the tools icon in the input bar — it should list `obsidian_search` and friends.

**Search returns 0 results.** Confirm three things: (1) `--vault` is an **absolute** path (run `realpath` if unsure); (2) the directory actually contains `.md` files (`find /path/to/vault -name "*.md" | head` should print at least one); (3) `enquire-mcp doctor --vault /path/to/vault` exits 0. If you have privacy globs configured elsewhere, also check that `--exclude-glob` / `--read-paths` aren't accidentally hiding everything.

**`enquire-mcp: command not found`.** The npm global bin directory isn't on your `PATH`. Run `npm config get prefix` to find it, then add `<prefix>/bin` to your `PATH` — or switch to the `npx` form of the Claude Desktop config (see Step 3): `"command": "npx"`, `"args": ["-y", "@oomkapwn/enquire-mcp@latest", "serve", "--vault", "/abs/path"]`.

**`ENOENT` or `unsupported engine` on install.** You're on Node < 22.13. Run `node --version` to confirm, then upgrade (e.g. via `nvm install 22 && nvm use 22`). enquire-mcp's CI matrix tests Node 22 + 24, and since v3.7.13 the `engines.node` floor matches that matrix (`>=22.13.0` — `pdfjs-dist@6+` is the lowest common denominator). For non-PDF Node 20 users, pin to v3.7.12.

**`Error: vault path does not exist`.** Either the path is wrong, or you used `~` instead of the absolute form. MCP clients don't expand `~` — use `/Users/you/MyVault` on macOS/Linux or `C:\Users\you\MyVault` on Windows. Paths containing spaces are fine as long as the JSON string itself is well-formed; no shell escaping needed inside `claude_desktop_config.json`.

**Server starts but the first embedding-search call hangs.** You haven't run `enquire-mcp setup` yet — the multilingual embedding model needs to download once (~120 MB from HuggingFace). The umbrella `obsidian_search` will fall back to TF-IDF gracefully if embeddings aren't available, but `obsidian_embeddings_search` and `obsidian_hyde_search` require the model. Run `enquire-mcp setup --vault /abs/path` and it'll prep everything in one shot.

## Help and links

- **Not sure if enquire-mcp is right for you?** See [`docs/COMPARISON.md`](./COMPARISON.md) — honest side-by-side against the main Obsidian MCP alternatives (cyanheads, MarkusPfundstein, StevenStavrakis, FS-only servers) with a 30-second decision tree.
- **Issues / bug reports:** [github.com/oomkapwn/enquire-mcp/issues](https://github.com/oomkapwn/enquire-mcp/issues)
- **Security disclosures:** `oomkapwn@gmail.com`
- **Full tool reference:** [`docs/api.md`](./api.md)
- **Remote MCP over HTTP:** [`docs/http-transport.md`](./http-transport.md)
