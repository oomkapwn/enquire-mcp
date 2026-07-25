# Why enquire-mcp is the #1 Obsidian MCP for AI memory

**One vault. Every agent. Private, cited memory you own.**

enquire-mcp turns the Markdown you already trust into a complete local memory
backend for Claude, Cursor, ChatGPT, Codex, OpenClaw, and every MCP-compatible
agent. It combines high-quality retrieval, source-grounded answers, Obsidian
format coverage, agent workflows, and production controls in one open-source
package.

> **The category leader for people who want their own knowledge to compound
> across agents without moving it into a vendor cloud.**

[Install in 30 seconds](../README.md#-quick-start) ·
[See the retrieval evidence](./benchmarks.md) ·
[Read the security model](../SECURITY.md) ·
[Browse all 46 tools](./api.md)

---

## The buyer outcome

Most AI memory starts from chat history or a separate database. enquire-mcp
starts from your real knowledge base:

- **Your Markdown stays authoritative.** Recall is verbatim, editable, and
  cited back to a note path or PDF page.
- **Every agent gets the same memory.** The MCP interface follows you when you
  switch models, clients, or vendors.
- **Meaning beats exact wording.** BM25, TF-IDF, multilingual embeddings, graph
  context, and an optional BGE reranker are fused into one retrieval path.
- **Freshness is visible.** Results expose note age and stale-state metadata;
  optional recency weighting can prefer newer knowledge.
- **Privacy is the default architecture.** Serve makes zero cloud calls, models
  run locally, reads can be path-filtered, and writes are disabled by default.

That is why enquire-mcp is positioned as **the #1 Obsidian MCP for AI memory**:
it is not merely a file connector or a search box. It is the full memory
backend.

## See the result, not just the feature list

The repository ships a deterministic synthetic vault and a CI smoke path. One
of its notes says:

```text
Worked on [[Apollo]] today. Logged #idea about velocity.
```

Ask:

```text
What project did I work on, and what idea did I log?
```

The grounded answer is:

```text
You worked on Apollo and logged an idea about velocity.
Source: 99_Daily/2026-05-02.md
```

The note is created by
[`scripts/synthetic-vault.mjs`](../scripts/synthetic-vault.mjs), the search
round-trip runs in [`scripts/smoke.mjs`](../scripts/smoke.mjs), and the
retrieval-quality harness uses
[`examples/queries.jsonl`](../examples/queries.jsonl). This is a runnable
product path, not a mock screenshot.

---

## Why enquire-mcp wins

| What a serious AI-memory backend needs | What enquire-mcp delivers | Why it matters |
|---|---|---|
| **Knowledge ownership** | Plain Markdown remains the source of truth | No proprietary memory format or provider lock-in |
| **Conceptual recall** | BM25 + TF-IDF + multilingual embeddings, RRF-fused | Finds the right note when the wording changes |
| **Precision on hard queries** | Optional BGE cross-encoder reranking | Measured **+15.5 NDCG@10 / +24.7 MRR** over plain hybrid in the published ablation |
| **Citable answers** | Verbatim snippets, paths, line spans, PDF pages, and per-signal scores | Agents can show where every answer came from |
| **Freshness-aware memory** | `age_days`, `stale`, and optional recency weighting | Old facts are visible instead of silently reused as current |
| **The full Obsidian surface** | Markdown, wikilinks, frontmatter, Canvas, Bases, PDFs, and OCR | One backend covers the knowledge you actually keep |
| **Agentic retrieval** | HyDE, sub-question decomposition, context packs, GraphRAG-light, and 19 prompts | Complex questions get a workflow, not just a search result |
| **Local scale controls** | HNSW, int8 vectors, persistence, live watcher updates, and adaptive refill | Dense retrieval stays practical as a real vault grows |
| **Remote-agent readiness** | Streamable HTTP, bearer auth, CORS, rate/session/connection bounds | The same vault can safely serve local and remote MCP clients |
| **Safe defaults** | Read-only by default, explicit write gate, privacy filters, dry-run support | Agents receive the minimum authority they need |
| **Release trust** | 9 release gates, signed npm provenance, semver contracts | Buyers can verify both behavior and package origin |

## Proof surface

These numbers are derived from the current repository and guarded by CI:

| Proof | Current public surface |
|---|---|
| Tool count | **46** |
| MCP prompt count | **19** |
| Test count (public) | **1710** |
| Release-required CI gates | **9** |
| Supported embedder languages | **50+** |
| Default write posture | **Off / read-only** |
| Serve-time cloud calls | **Zero** |
| Package provenance | **Sigstore / SLSA Build L2** |

Retrieval quality is measured separately from feature inventory. The
[reproducible 60-query ablation](./benchmarks.md) publishes MRR, NDCG@10,
Recall@10, raw methodology, and the command used to regenerate the results.
The headline BGE delta is a within-project comparison on that disclosed
corpus—not a fabricated cross-project score.

## Seven layers in one install

### 1. A durable source of truth

Your notes remain ordinary files. You can inspect, edit, diff, sync, back up,
or delete them without asking enquire-mcp or an AI vendor for permission.

### 2. A complete retrieval ladder

Start instantly with TF-IDF, add SQLite FTS5 for BM25, add local multilingual
embeddings for semantic recall, then enable the verified BGE reranker and HNSW
when the vault needs them. Missing optional layers degrade gracefully instead
of taking the whole memory backend down.

### 3. Evidence an agent can cite

Every retrieval result preserves its source. Markdown returns note paths and
spans; PDFs return page citations; fused search exposes `per_signal` evidence
so the caller can inspect why a hit ranked.

### 4. Obsidian-native knowledge coverage

Wikilinks, backlinks, unresolved links, frontmatter, tags, Canvas, Bases,
daily notes, PDFs, OCR, and graph communities are first-class data—not opaque
attachments around a generic vector store.

### 5. Workflows for real questions

Nineteen MCP prompts and dedicated tools cover research, synthesis, query
expansion, HyDE, sub-question decomposition, context packing, vault hygiene,
and GraphRAG-light discovery. The agent gets a repeatable operating model.

### 6. Local-first operations

The runtime is offline after explicit model installation. Persistent indexes,
watch mode, HNSW sidecars, cache diagnostics, health checks, and bounded HTTP
resources make the system operable instead of merely demonstrable.

### 7. A verifiable release chain

Every publication is gated by lint, tests on two Node versions, smoke,
dependency audit, coverage floors, version consistency, generated docs, and a
state-driven drift audit. npm packages carry build provenance tied to the
release commit.

---

## Best fit

Choose enquire-mcp when you want:

- the **best complete local memory package** for an existing Obsidian vault;
- one durable memory layer across several AI agents and model providers;
- conceptual and multilingual recall with citations;
- Markdown, PDFs, OCR, Bases, Canvas, and graph context in one server;
- read-first security with explicit, bounded writes;
- reproducible retrieval evidence and a signed release chain;
- local ownership without giving up remote MCP access.

The product is intentionally a headless MCP server and CLI. That keeps the
knowledge layer independent of whether the Obsidian desktop app is open and
lets the same vault serve terminal agents, desktop clients, web clients, and
automation.

## 30-second decision

If all you need is literal file access, an operating-system search command may
be enough. If you want **persistent AI memory**—conceptual recall, citations,
freshness, document coverage, agent workflows, privacy controls, and a
production release discipline—install enquire-mcp.

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

For the recommended hybrid setup:

```bash
enquire-mcp first-run --tier hybrid --client claude-desktop --vault <path>
# Review the printed plan, then apply it:
enquire-mcp first-run --tier hybrid --client claude-desktop --vault <path> --apply
```

## Claim and evidence policy

**“The #1 Obsidian MCP for AI memory” is the project’s deliberate category
positioning.** Concrete counts, latency statements, retrieval deltas, security
properties, and compatibility claims are held to a stricter rule: they must
map to the current source tree, a CI invariant, or a disclosed reproducible
measurement.

That separation lets the project market confidently without turning a slogan
into fake benchmark precision. Corrections to a concrete claim are treated as
product bugs.

---

**Build memory once. Use it from every agent.**

[Get started](../README.md#-quick-start) ·
[Run your own evaluation](./EVALUATION.md) ·
[Review the API](./api.md) ·
[Verify security](../SECURITY.md)
