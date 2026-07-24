# Examples

Config templates and recipes for connecting `enquire-mcp` to common MCP clients. Prefer `enquire-mcp configure` for a ready-to-paste config pinned to the physical package copy you are running.

| File | Use case |
|---|---|
| [`claude-desktop.json`](./claude-desktop.json) | `basic` Claude Desktop config (TF-IDF only, zero setup) |
| [`claude-desktop-hybrid.json`](./claude-desktop-hybrid.json) | `hybrid-live` stack — BM25 + TF-IDF + ML embeddings + reranker + HNSW + PDFs/watch |
| [`cursor-mcp.json`](./cursor-mcp.json) | Cursor MCP stdio config |
| [`chatgpt-actions.md`](./chatgpt-actions.md) | ChatGPT custom GPT — remote MCP over HTTP with bearer auth + tunnel |
| [`tweetclaw-openclaw.md`](./tweetclaw-openclaw.md) | OpenClaw recipe for capturing public X/Twitter signals with TweetClaw, storing reviewed notes in an Obsidian vault, then retrieving them with enquire |
| [`queries.jsonl`](./queries.jsonl) | Golden set for the repo's SYNTHETIC quick-start vault (CI-pinned; format reference for writing your own set) |

## Workflow

1. **Prefer `enquire-mcp configure`** for generated configs. If you use a committed JSON template manually, replace every placeholder before putting it at the client's MCP config location; the hybrid template has absolute executable and vault paths, while the basic template has a vault path.
2. The `basic` config runs current `@latest` and needs no preflight. For the v3.12 `hybrid-live` preview, prefer `enquire-mcp first-run --tier hybrid-live --client claude-desktop --vault <path>`: default mode is non-destructive and prints the pinned config + plan; append `--apply` only after review. The committed hybrid JSON is therefore a template, not a literal drop-in: replace `/ABSOLUTE/PATH/TO/enquire-mcp` and use that same selected executable for `setup`, `install-model`, `doctor`, and runtime. An exact npx package spec alone is insufficient because npm may resolve it from different physical installations in different working directories. The pin is intentionally exact rather than self-updating: regenerate it after a Node/package move or upgrade, installation-method change, or npx-cache cleanup.
3. **Restart the client** so it picks up the new server.

## Recommended starting config

Most users want the hybrid stack — it improves paraphrase / synonym / cross-language matching at the cost of building two indexes and caching roughly 230 MB of default embedder + reranker weights. Start with [`claude-desktop-hybrid.json`](./claude-desktop-hybrid.json) unless you specifically want the zero-setup `basic` tier. Doctor READY is structural/runtime-only; rerun setup after content changes or keep `--watch` enabled.

## Eval harness

The [`queries.jsonl`](./queries.jsonl) file is a tiny synthetic example for the `enquire-mcp eval` retrieval-quality benchmark. Replace the paths with real notes from your vault, then:

```bash
# the committed set targets the repo synthetic vault; for YOUR vault write your own JSONL in the same format
enquire-mcp eval --vault ~/Vault --queries my-queries.jsonl --persistent-index --reranker
```

Output: a pretty table with NDCG@K, Recall@K, MRR, and per-query latency. Pass `--matrix` to A/B-test (graph_boost ± reranker) side by side.
