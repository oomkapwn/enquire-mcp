# Examples

Drop-in configs and recipes for connecting `enquire-mcp` to common MCP clients.

| File | Use case |
|---|---|
| [`claude-desktop.json`](./claude-desktop.json) | Tier-1 Claude Desktop config (TF-IDF only, zero setup) |
| [`claude-desktop-hybrid.json`](./claude-desktop-hybrid.json) | Full hybrid stack — BM25 + TF-IDF + ML embeddings + reranker + HNSW |
| [`cursor-mcp.json`](./cursor-mcp.json) | Cursor MCP stdio config |
| [`chatgpt-actions.md`](./chatgpt-actions.md) | ChatGPT custom GPT — remote MCP over HTTP with bearer auth + tunnel |
| [`tweetclaw-openclaw.md`](./tweetclaw-openclaw.md) | OpenClaw recipe for capturing public X/Twitter signals with TweetClaw, storing reviewed notes in an Obsidian vault, then retrieving them with enquire |
| [`queries.jsonl`](./queries.jsonl) | Sample query set for the eval harness (`enquire-mcp eval --queries examples/queries.jsonl`) |

## Workflow

1. **Edit the absolute path** in the JSON config to point at your vault and (for Claude Desktop / Cursor) drop the file at the client's MCP config location.
2. **Restart the client** so it picks up the new server.
3. (Optional, hybrid only) Run `enquire-mcp setup --vault <path>` once to download the embedding model and build the FTS5 + embed-db indexes.
4. (Optional) Run `enquire-mcp doctor --vault <path>` to confirm everything is wired up — color-coded ✓/⚠/✗ output.

## Recommended starting config

Most users want the hybrid stack — it's strictly better than TF-IDF alone (better paraphrase / synonym / cross-language matching) at the cost of one `setup` command and ~120 MB of disk for the embedding model. Start with [`claude-desktop-hybrid.json`](./claude-desktop-hybrid.json) unless you specifically want the zero-setup tier.

## Eval harness

The [`queries.jsonl`](./queries.jsonl) file is a tiny synthetic example for the `enquire-mcp eval` retrieval-quality benchmark. Replace the paths with real notes from your vault, then:

```bash
enquire-mcp eval --vault ~/Vault --queries examples/queries.jsonl --persistent-index --reranker
```

Output: a pretty table with NDCG@K, Recall@K, MRR, and per-query latency. Pass `--matrix` to A/B-test (graph_boost ± reranker) side by side.
