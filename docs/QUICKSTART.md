# Quickstart — enquire-mcp in 5 minutes

From `npm install` to a working **long-term memory layer for your AI agents**, backed by your Obsidian vault, inside Claude Desktop (or any MCP client). One happy path. Concrete commands, expected output, troubleshooting at the bottom.

> **What "memory layer" means here.** Unlike vendor-specific chat memory (Claude Memory, ChatGPT Memory, Cursor memory) that locks your knowledge into one provider's cloud, enquire-mcp turns any directory of `.md` files into queryable, semantically-searchable memory accessible from every MCP-compatible agent. The knowledge is yours, in plain markdown, portable forever.

## What you'll get

- **Hybrid search** across every `.md` in your vault — BM25 + TF-IDF fused via Reciprocal Rank Fusion (Cormack et al, 2009), so keyword hits *and* related-term hits both surface.
- **Top-K ranked notes with snippets** — each result returns the matching note path, a ~120-char snippet around the hit, and per-signal scores so you see why it ranked.
- **No Obsidian app required** — any directory with `.md` files works. Obsidian doesn't even need to be installed.
- **Works in every MCP client** — Claude Desktop, Claude Code, Cursor, ChatGPT custom GPT, Codex, OpenClaw, mobile MCP clients. One server, one config snippet per client.

## Prerequisites

- **Node 22.13+ required** (since v3.12.0-rc.22 the required `test (22)` and `smoke` jobs run on the literal `engines.node` floor, exactly 22.13.0, with strict engine checks; `test (24)` retains the newer-major control). On Node 20 npm reports `EBADENGINE` / an unsupported engine and the runtime is unsupported; if you must stay on Node 20, pin to v3.7.12 or earlier.
- **An Obsidian vault folder** — any directory containing `.md` files. If you don't have one, `mkdir ~/TestVault && echo "# Hello" > ~/TestVault/note.md` is enough to follow this guide.
- **An MCP client** — one of: Claude Desktop, Claude Code, Cursor, ChatGPT custom GPT (with remote MCP), Codex, OpenClaw, or any other MCP-compatible client.

## Step 1 — Choose a channel and install

For the stable zero-setup server shown in Step 3, install `@latest`:

```bash
npm install -g @oomkapwn/enquire-mcp
```

This source guide also documents the `v4.0.0-rc.1` preview. It keeps the v3 tool/prompt/resource and CLI surface while moving to the official MCP SDK v2: modern `2026-07-28` and supported legacy clients share one registration factory, with strict no-downgrade routing and remote protocol/package gates. It also includes the tier-aware source-preserving doctor, preview-first `first-run`, verified client-specific install actions, explicit q8 local embedding weights, and the literal Node 22.13.0 runtime floor. npm `@latest` remains stable v3; to exercise v4, install this exact prerelease globally and keep preparation plus generated runtime on this one installation:

```bash
npm install -g @oomkapwn/enquire-mcp@4.0.0-rc.1
enquire-mcp --version
```

Expected output: the newest `@latest` version for the stable path, or exactly `4.0.0-rc.1` after selecting the preview. The [CHANGELOG](../CHANGELOG.md) identifies the exact contents of each channel.

For a client-specific install action, run `enquire-mcp configure --client <name> --vault /absolute/path`. The preview prints a native review URI only where the client officially accepts an arbitrary local definition (VS Code), a copy-and-run command where the client exposes one (Claude Code and Codex), and an explicit **copy-only** label where public one-click routes are limited to Marketplace/Registry entries. Every mode includes the exact generated config as the fallback.

## Step 2 — Smoke test (30 seconds)

With `v3.12.0-rc.2+`, preview one package-coherent basic-tier activation before touching indexes or model caches:

```bash
enquire-mcp first-run --tier basic --client claude-desktop --vault /absolute/path/to/your/vault
```

Default `first-run` is non-destructive: it validates the vault through `configure`, prints the physically pinned client snippet, and lists the exact remaining command without running it. For basic, explicit `--apply` runs only the read-only doctor check; for hybrid tiers it is the consent boundary before indexes/model-cache state may be created:

```bash
enquire-mcp first-run --tier basic --client claude-desktop --vault /absolute/path/to/your/vault --apply
```

Expected output: the generated config followed by a `READY for basic` checklist with the vault path and watcher-startup interlock both `OK`. Optional hybrid/PDF/OCR capabilities may show `WARN`; they do not block the basic live-scan tier. The underlying `doctor --tier basic` reads vault/index/cache state but does not write SQLite contents/schema or create SQLite sidecars (ordinary reads may update OS access-time metadata). A stranded interlock is required-fail because every server start would refuse it; stop all enquire processes, clear it through strict recovery, and rebuild with the same model, quantization, late-chunk, privacy and PDF settings before retrying. A READY verdict covers structural/runtime prerequisites only: it does not certify index freshness, complete PDF coverage, watcher delivery, OCR language packs, or model artifact integrity/inference loadability.

For machine-readable diagnostics, run `enquire-mcp doctor --tier basic --vault /absolute/path/to/your/vault --json`; each check includes `required`, and active/large/unstable SQLite sources report `unverified` rather than “missing.” If you stay on the current stable channel, skip this preview-only step and continue with the zero-setup config in Step 3.

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

- **Give your agent a repeatable operating loop** — use the
  [agent lifecycle recipes](../examples/README.md#agent-lifecycle-recipes) for
  first recall, evidence follow-up, stale-fact revalidation, weekly synthesis,
  research capture, and exact-confirmation safe writes.
- **Prepare hybrid (`v3.12.0-rc.2+`)** — first preview `enquire-mcp first-run --tier hybrid --client claude-desktop --vault /absolute/path/to/your/vault`; inspect its generated config and planned effects, then repeat with `--apply`. It runs the same physical package's idempotent `setup`, verified `rerank-bge` acquisition, and tier-aware `doctor`, stopping at the first failure with an exact resume command. The manual equivalent remains `setup` → `install-model rerank-bge` → `doctor --tier hybrid` → `configure`; use it when you need to drive individual steps.

The physical pin deliberately prioritizes exact package/cache coherence over automatic upgrades. Re-run `configure` after moving or upgrading Node/enquire-mcp, changing installation method, or clearing an npx cache; a config whose pinned executable was removed cannot update itself.
- **PDF search** — add `--include-pdfs` to setup, verify with `doctor --tier hybrid-live`, and generate the client config with `configure --tier hybrid-live`. PDFs get blended into `obsidian_search` results with `[page: N]` citation markers.
- **Cross-encoder reranking** — pre-cache `rerank-bge`, then add `--enable-reranker`. Measured +15.5 NDCG@10 / +24.7 MRR (60-query ablation).
- **Approximate nearest-neighbor retrieval** — add `--use-hnsw`. The HNSW index persists to disk to avoid an unchanged-corpus rebuild; benchmark latency and recall on your own vault.
- **Harder questions** — try `obsidian_hyde_search` (HyDE retrieval, Gao et al 2023) when the literal query phrasing doesn't match how the notes are written.
- **Full 46-tool surface** — see [`docs/api.md`](./api.md) for every read/write tool, MCP resource, and prompt.

The hybrid JSON in [`examples/claude-desktop-hybrid.json`](../examples/claude-desktop-hybrid.json) is an illustrative absolute-executable template. Prefer the physically pinned output from `configure`.

## Troubleshooting

**Claude doesn't show the tools.** Fully quit Claude Desktop (Cmd-Q, not just close-window) and reopen. The MCP server is loaded once at startup; closing the window keeps the old config in memory. After reopening, look for the tools icon in the input bar — it should list `obsidian_search` and friends.

**Search returns 0 results.** Confirm three things: (1) `--vault` is an **absolute** path (run `realpath` if unsure); (2) the directory actually contains `.md` files (`find /path/to/vault -name "*.md" | head` should print at least one); (3) for the preview path, the `doctor --tier basic` command printed by the same `configure` invocation exits 0. If you have privacy globs configured elsewhere, also check that `--exclude-glob` / `--read-paths` aren't accidentally hiding everything.

**`enquire-mcp: command not found`.** The npm global bin directory isn't on your `PATH`. Run `npm config get prefix` to find it, then add `<prefix>/bin` to your `PATH` — or switch to the `npx` form of the Claude Desktop config (see Step 3): `"command": "npx"`, `"args": ["-y", "@oomkapwn/enquire-mcp@latest", "serve", "--vault", "/abs/path"]`.

**`ENOENT` or `unsupported engine` on install.** You're on Node < 22.13. Run `node --version` to confirm, then upgrade (e.g. via `nvm install 22 && nvm use 22`). enquire-mcp's required `test (22)` and `smoke` jobs run at exactly 22.13.0, matching `engines.node >=22.13.0`; `test (24)` is the newer-major control. For non-PDF Node 20 users, pin to v3.7.12.

**`Error: vault path does not exist`.** Either the path is wrong, or you used `~` instead of the absolute form. MCP clients don't expand `~` — use `/Users/you/MyVault` on macOS/Linux or `C:\Users\you\MyVault` on Windows. Paths containing spaces are fine as long as the JSON string itself is well-formed; no shell escaping needed inside `claude_desktop_config.json`.

**Embedding or reranker reports a cache miss.** Runtime commands (`serve`, `serve-http`, `query`, and `eval`) never download ML models implicitly; a missing cache fails closed and `obsidian_search` preserves its non-ML/RRF fallback order. Regenerate the config with the same installed executable that runs `setup`, `install-model`, and `doctor`; `configure` pins its real Node + entry paths. A global, project, or npx install can have a different package-local cache even when the package version matches.

After vault content changes, rerun `setup` or use `--watch`; a doctor READY result verifies structure/runtime prerequisites, not index freshness or corpus completeness.

## Help and links

- **Want proof before adoption?** Run the built-in eval harness on your own vault, inspect the published [`benchmarks`](./benchmarks.md), and verify the enforced local-first guarantees in [`SECURITY.md`](../SECURITY.md).
- **Issues / bug reports:** [github.com/oomkapwn/enquire-mcp/issues](https://github.com/oomkapwn/enquire-mcp/issues)
- **Security disclosures:** `oomkapwn@gmail.com`
- **Full tool reference:** [`docs/api.md`](./api.md)
- **Remote MCP over HTTP:** [`docs/http-transport.md`](./http-transport.md)
