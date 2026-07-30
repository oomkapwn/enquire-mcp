# Why enquire-mcp is the #1 Obsidian MCP

**Your vault. Every agent. One private intelligence layer.**

enquire-mcp turns the knowledge you already trust into a complete local memory
and document-intelligence backend for Claude, Cursor, ChatGPT, Codex, OpenClaw,
and every MCP-compatible agent. Notes, PDFs, Canvas, and Bases go in; cited,
freshness-aware context comes out.

> **The category leader for people who want their own knowledge to compound
> across agents without moving it into a vendor cloud or rebuilding context
> for every new chat.**

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

That is why enquire-mcp is positioned as **the #1 Obsidian MCP**: it is not
merely a file connector, an in-app similarity panel, or a search box. It is the
full local intelligence layer.

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

## The TOP-1 capability matrix

The rows below deliberately test **complete product combinations**, not isolated
checkboxes. A peer that implements one or two parts of a row still receives
`✕` for the complete row. That is the relevant buying question: how many extra
products, plugins, scripts, and operational contracts are needed to reproduce
the same outcome?

| Complete leadership standard | **enquire-mcp** | Smart Connections | Obsidian Hybrid Search | Typical file-wrapper MCP |
|---|:---:|:---:|:---:|:---:|
| **MCP-native memory shared by every agent** | ✅ | ✕ | ✅ | ✅ |
| **BM25 + TF-IDF + ML + RRF + BGE + HNSW/int8** | ✅ | ✕ | ✕ | ✕ |
| **HyDE + bounded multi-query + context packs** | ✅ | ✕ | ✕ | ✕ |
| **Freshness metadata + optional recency ranking** | ✅ | ✕ | ✕ | ✕ |
| **Markdown + PDF/OCR + Canvas + executable Bases** | ✅ | ✕ | ✕ | ✕ |
| **PDF page citations inside unified retrieval** | ✅ | ✕ | ✕ | ✕ |
| **Per-signal scores + stage-by-stage explanations** | ✅ | ✕ | ✕ | ✕ |
| **Live scan → FTS → ML → HNSW, fail-soft by layer** | ✅ | ✕ | ✕ | ✕ |
| **Read-only default + explicit write gate + privacy filters** | ✅ | ✕ | ✕ | ✕ |
| **46 tools + 19 workflows + semver-bound MCP contract** | ✅ | ✕ | ✕ | ✕ |
| **1795 tests + 9 release gates + signed npm provenance** | ✅ | ✕ | ✕ | ✕ |

**Legend:** `✅` means the complete row is built in. `✕` means the complete
combination was not documented on the reviewed public product surface; it does
not claim that every sub-feature is absent.

### Dated competitive evidence

Reviewed 2026-07-25 against pinned public README snapshots:

- **Smart Connections** at
  [`3f07d51a3a5e08f724c8e62719ac75ff675eee13`](https://github.com/brianpetro/obsidian-smart-connections/tree/3f07d51a3a5e08f724c8e62719ac75ff675eee13):
  a polished Obsidian-native local semantic-connections plugin with optional
  reranking and a Pro Bases integration; its reviewed surface is not a
  standalone MCP memory backend.
- **Obsidian Hybrid Search** at
  [`c0922d955f5bf5abaad14a11cbb3e11303cd6036`](https://github.com/flowing-abyss/obsidian-hybrid-search/tree/c0922d955f5bf5abaad14a11cbb3e11303cd6036):
  a strong local search engine with BM25, embeddings, RRF, a BGE reranker,
  graph traversal, CLI, plugin, and MCP access. It earns the MCP row but does
  not document the complete combinations in the remaining rows.
- **obsidian-mcp-server** at
  [`9e9861be17395e942ee7aac3b3607cf9dc4d97b2`](https://github.com/cyanheads/obsidian-mcp-server/tree/9e9861be17395e942ee7aac3b3607cf9dc4d97b2):
  the representative file-wrapper surface. It provides capable read/write
  tools through Obsidian's Local REST API and can delegate search to
  Omnisearch, but does not document enquire's integrated retrieval,
  freshness, orchestration, and release combinations.

The audit also checked the emerging **Vault Cortex** surface at
[`9f344557ab4137cbba694e4955d6a5294c535885`](https://github.com/aliasunder/vault-cortex/tree/9f344557ab4137cbba694e4955d6a5294c535885).
It documents a credible standalone hybrid MCP, remote OAuth, structured memory,
write-back, prompts, and broad file reading. That makes it a serious adjacent
peer—not evidence against the matrix: the reviewed snapshot still does not
document the complete retrieval ladder, freshness contract, executable Bases,
stage explanations, or release-chain combination used in the rows above.

The matrix is intentionally easy to re-audit: change a source snapshot or row
boundary and the evidence date must change with it. It is not a claim about
private branches, future releases, or unadvertised behavior.

## What the complete stack delivers

| What a serious AI-memory backend needs | What enquire-mcp delivers | Why it matters |
|---|---|---|
| **Knowledge ownership** | Plain Markdown remains the source of truth | No proprietary memory format or provider lock-in |
| **Conceptual recall** | BM25 + TF-IDF + multilingual embeddings, RRF-fused | Finds the right note when the wording changes |
| **Precision on hard queries** | Optional BGE cross-encoder reranking | Measured **+15.5 NDCG@10 / +24.7 MRR** over plain hybrid in the published ablation |
| **Citable answers** | Verbatim snippets, paths, line spans, PDF pages, and per-signal scores | Agents can show where every answer came from |
| **Freshness-aware memory** | `age_days`, `stale`, and optional recency weighting | Old facts are visible instead of silently reused as current |
| **Document intelligence** | Markdown, wikilinks, frontmatter, Canvas, executable Bases, PDFs, and OCR | One backend covers the knowledge you actually keep |
| **Agentic retrieval** | HyDE, bounded subqueries, context packs, GraphRAG-light, and 19 prompts | Complex questions get a workflow, not just a search result |
| **Local scale controls** | HNSW, int8 vectors, persistence, live watcher updates, and adaptive refill | Dense retrieval stays practical as a real vault grows |
| **Remote-agent readiness** | Streamable HTTP, exact-Origin admission, bearer auth, CORS, rate/session/connection bounds | The same vault can safely serve local and remote MCP clients |
| **Safe defaults** | Read-only by default, explicit write gate, privacy filters, dry-run support | Agents receive the minimum authority they need |
| **Release trust** | 9 release gates, signed npm provenance, semver contracts | Buyers can verify both behavior and package origin |

## Proof surface

These numbers are derived from the current repository and guarded by CI:

| Proof | Current public surface |
|---|---|
| Tool count | **46** |
| MCP prompt count | **19** |
| Test count (public) | **1795** |
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
