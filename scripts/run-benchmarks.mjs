#!/usr/bin/env node
// Retrieval-quality benchmark for enquire-mcp (v3.6.0-rc.4).
//
// Builds a deterministic synthetic vault, runs an ablation study across
// (FS-grep baseline / BM25 only / TF-IDF only / embeddings only / hybrid /
// hybrid+reranker / hybrid+HyDE), and reports MRR / NDCG@10 / Recall@10.
//
// Outputs:
//   1. A markdown table on stdout
//   2. `bench/benchmarks.json` for downstream rendering / diff
//
// Reproduce:
//   npm run build && npm run bench:retrieval
//
// Determinism contract:
//   - Vault content is a fixed string per relPath (no Date.now / random in body)
//   - mtimes are set to a fixed value via utimes so FTS5/embedding source_state
//     is identical across runs
//   - Query set lives in tests/fixtures/benchmark-queries.jsonl (versioned)
//   - The vault is built in a per-run tmpdir then torn down at the end
//
// Limitations:
//   - HyDE is approximated by a deterministic "hypothetical answer" string
//     (real HyDE needs an LLM). We label this clearly in the output.
//   - Embeddings / reranker stacks require model downloads (~25-120 MB).
//     If the optional deps or network are unavailable, those rows show
//     "skipped" with the reason.
//   - The vault is small (~55 notes). Public-vault numbers will differ;
//     we welcome reproduction with public BEIR/TREC corpora as future work.

import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// ─── Load enquire-mcp build artifacts ────────────────────────────────────────
const distDir = path.join(projectRoot, "dist");
if (!existsSync(path.join(distDir, "tools", "index.js"))) {
  process.stderr.write("dist/ not found — run `npm run build` first.\n");
  process.exit(1);
}

const { searchHybrid, semanticSearch, embeddingsSearch } = await import(path.join(distDir, "tools", "index.js"));
const { FtsIndex } = await import(path.join(distDir, "fts5.js"));
const { Vault } = await import(path.join(distDir, "vault.js"));
const { reciprocalRankFusion } = await import(path.join(distDir, "rrf.js"));
const { ndcgAtK, recallAtK, reciprocalRank, readQueriesJsonl } = await import(path.join(distDir, "eval.js"));
const { syncFtsIndex, syncEmbedDb } = await import(path.join(distDir, "server.js"));

// ─── Synthetic vault — deterministic content ─────────────────────────────────

const VAULT_NOTES = {
  "INDEX.md": `---
title: INDEX
tags: [hub, index]
---

# Vault index

This is the top-level hub for the vault. Major sections:

- [[Reference/INDEX]] — knowledge base on retrieval, IR, and Obsidian
- [[Projects/RAG-bot]] — active project: build a RAG bot over this vault
- [[Projects/Search-quality]] — active project: improve search quality
- [[Projects/Vault-redesign]] — restructuring the vault
- [[Projects/MCP-server]] — building an MCP server
- [[Daily/2026-05-15]] — today's daily note

Use full-text search or hybrid search to find anything.
`,

  "Reference/INDEX.md": `---
title: Reference INDEX
tags: [hub, reference]
---

# Reference INDEX

Curated knowledge-base notes. Topics:

- Retrieval: [[BM25]], [[TF-IDF]], [[Embeddings]], [[RRF]], [[Reranker]], [[HyDE]]
- Data structures: [[HNSW]], [[FTS5]], [[SQLite]], [[Cosine]]
- ML stack: [[Transformers]], [[ONNX]], [[Tokenization]], [[Chunking]]
- Benchmarks: [[MTEB]], [[BEIR]]
- Obsidian: [[Obsidian]], [[Wikilinks]], [[Backlinks]], [[Bases]], [[Dataview]], [[Canvas]], [[Markdown]]
- Graph theory: [[Graph]], [[Louvain]], [[PageRank]]
- Misc: [[LLM]], [[MCP]], [[Cache]], [[RAG]]
`,

  "Reference/RAG.md": `---
title: RAG
tags: [reference, retrieval]
---

# RAG — Retrieval Augmented Generation

RAG (Retrieval Augmented Generation) is a pattern for grounding LLM output
in a knowledge base. Workflow:

1. Encode the user query.
2. Retrieve top-K relevant passages from the knowledge base.
3. Concatenate retrieved passages with the query as LLM context.
4. Generate the answer conditioned on retrieved context.

The retrieval step is where retrieval-augmented generation lives or dies.
Hybrid retrieval (lexical + dense) consistently outperforms either alone.

See also: [[Reranker]], [[Embeddings]], [[RRF]]. The marker obscure-marker-XYZZY
is included once for the rare-token benchmark case.
`,

  "Reference/HNSW.md": `---
title: HNSW
tags: [reference, vector-index]
---

# HNSW — Hierarchical Navigable Small World

HNSW is an approximate nearest neighbor (ANN) algorithm for high-dimensional
vector indexes. Sub-10ms top-K at any practical scale. Hierarchical layers
of small-world graphs let the search walk down from coarse to fine.

Use cases: backing a hybrid retrieval stack, k-NN over [[Embeddings]],
production-grade vector database.

See also: [[Cosine]], [[Embeddings]].
`,

  "Reference/BM25.md": `---
title: BM25
tags: [reference, retrieval]
---

# BM25 — Best Match 25

BM25 is a lexical bag-of-words ranking function used by [[FTS5]] (SQLite),
Lucene, and most classical search engines. Probabilistic relevance framework;
combines term frequency, inverse document frequency, and document length
normalization.

Strengths: exact-keyword recall, rare-token discrimination, fast.
Weaknesses: vocabulary mismatch, no semantic understanding.

Hybrid retrieval pairs BM25 with [[Embeddings]] via [[RRF]] to cover both.
`,

  "Reference/TF-IDF.md": `---
title: TF-IDF
tags: [reference, retrieval]
---

# TF-IDF — Term Frequency × Inverse Document Frequency

TF-IDF is the classical lexical-semantic IR scoring: weight each term by how
often it appears in the doc (TF) times how rare it is across the corpus (IDF).
Documents and queries are scored as the [[Cosine]] similarity of their TF-IDF
vectors.

Zero native deps, runs on every platform. Pure-JS implementation in enquire-mcp.
Bridges between exact-keyword BM25 and dense [[Embeddings]] retrieval.
`,

  "Reference/Embeddings.md": `---
title: Embeddings
tags: [reference, ml]
---

# Embeddings — Dense Vector Representations

Vector embeddings map text to a dense float vector via a learned encoder
(BERT, MiniLM, BGE, jina-embeddings). Semantically related texts produce
nearby vectors under [[Cosine]] similarity.

Multilingual MiniLM ~120MB; BGE-small-en ~33MB. Models run locally via
[[ONNX]] + transformers.js. MTEB and [[BEIR]] are the standard benchmarks
for English embedding quality.

Pairs naturally with [[HNSW]] for fast k-NN at scale.
`,

  "Reference/Reranker.md": `---
title: Reranker
tags: [reference, ml]
---

# Reranker — Cross-Encoder for Re-Ranking

A cross-encoder reranker takes (query, candidate) pairs and outputs a relevance
score by attending across both jointly. Higher accuracy than bi-encoder cosine
because the model sees query-document term interactions directly.

Workflow: hybrid retrieve top-N (~50) → rerank → keep top-K. Adds 30-50ms per
query but typically +5-10 NDCG@10 over [[RRF]] alone. BGE-reranker-base is the
canonical English model; mxbai-rerank-xsmall is a 25MB multilingual option.
`,

  "Reference/RRF.md": `---
title: RRF
tags: [reference, retrieval]
---

# RRF — Reciprocal Rank Fusion

Reciprocal Rank Fusion (Cormack et al, 2009) combines multiple ranked lists
without per-ranker score normalization. Each doc's final score is the sum of
1/(k + rank) across rankers, with k=60 by convention.

Beats every score-normalization scheme on TREC. Why it works: ranks are stable
across rankers in a way that raw scores aren't, and RRF is robust to outliers.

enquire-mcp uses RRF to fuse [[BM25]] + [[TF-IDF]] + [[Embeddings]] into a
single hybrid retrieval signal. The default search tool returns RRF-fused hits.
`,

  "Reference/HyDE.md": `---
title: HyDE
tags: [reference, retrieval]
---

# HyDE — Hypothetical Document Embeddings

HyDE (Gao et al, 2023) augments dense retrieval by asking the LLM to generate
a hypothetical answer to the user query, then embedding that synthetic answer
and using IT as the retrieval seed instead of the raw query.

Why it works: queries are usually under-specified; answers are usually full
sentences with rich context. Embeddings retrieved against an answer-shaped
vector beat raw-query retrieval by +2-5 NDCG@10 on under-specified queries.

enquire-mcp supports HyDE via the hypothetical_answer parameter to
obsidian_embeddings_search.
`,

  "Reference/Obsidian.md": `---
title: Obsidian
tags: [reference, app]
---

# Obsidian — Note-Taking App

Obsidian is a popular markdown-first note-taking application with a strong
plugin ecosystem. Notes live as plain markdown files on disk; the app adds
[[Wikilinks]], [[Backlinks]], canvas boards, [[Dataview]] queries, [[Bases]],
and a graph view.

enquire-mcp is an MCP server that exposes an Obsidian vault to LLM agents:
hybrid retrieval, full-text search, wikilink graph traversal, canvas reading,
PDF + OCR. Works without Obsidian running — pure filesystem.
`,

  "Reference/Markdown.md": `---
title: Markdown
tags: [reference, format]
---

# Markdown — Lightweight Markup Language

Markdown is a plain-text markup language created by John Gruber in 2004.
Headers, lists, emphasis, code fences, links, images — all in plain text.
CommonMark is the standardized dialect; [[Obsidian]] extends it with
[[Wikilinks]], embeds, and callouts.

Markdown files are the canonical content unit in an Obsidian vault.
`,

  "Reference/Wikilinks.md": `---
title: Wikilinks
tags: [reference, obsidian]
---

# Wikilinks — Internal Links

Wikilinks are Obsidian's internal-link syntax: \`[[Note name]]\` resolves to a
note in the vault. Optional alias: \`[[Note name|display text]]\`. Optional
heading: \`[[Note name#Section]]\`.

The wikilink graph is the differentiating Obsidian primitive: every note can
be a node, every wikilink is an edge. Backlinks are computed by reverse-
traversing this graph. See also [[Backlinks]].
`,

  "Reference/Backlinks.md": `---
title: Backlinks
tags: [reference, obsidian]
---

# Backlinks — Reverse References

A backlink to note X is any other note that contains a wikilink targeting X.
Backlinks let you ask "what notes reference this one?" without having to
maintain a TOC by hand.

In enquire-mcp, obsidian_get_backlinks computes these on-demand by scanning
the parsed [[Wikilinks]] cache. The wikilink graph is also used for graph-
boost reranking after [[RRF]] fusion.
`,

  "Reference/FTS5.md": `---
title: FTS5
tags: [reference, sqlite]
---

# FTS5 — SQLite Full-Text Search

FTS5 is SQLite's built-in full-text search virtual table. Supports [[BM25]]
ranking, tokenization (unicode61, trigram, porter), and column-level boosting.

enquire-mcp uses FTS5 as the lexical retrieval backbone when the user opts
into the persistent index. Pairs with [[TF-IDF]] (in-memory) and [[Embeddings]]
(SQLite vector blobs) for hybrid retrieval.

See also: [[SQLite]].
`,

  "Reference/Cosine.md": `---
title: Cosine
tags: [reference, math]
---

# Cosine Similarity

Cosine similarity measures the angle between two vectors: cos(θ) = (a · b) / (|a| × |b|).
Values in [-1, +1]; 1 means identical direction, -1 means opposite.

When vectors are L2-normalized (||v|| = 1), cosine reduces to plain dot
product — which is why every dense [[Embeddings]] pipeline normalizes at
extraction time. Pairs with [[HNSW]] for fast k-NN.
`,

  "Reference/ONNX.md": `---
title: ONNX
tags: [reference, ml]
---

# ONNX — Open Neural Network Exchange

ONNX is a portable model format for running deep-learning models outside
their original training framework. ONNX Runtime is the canonical inference
engine; works on CPU, GPU, mobile, and WebAssembly.

[[Transformers]].js uses ONNX Runtime to run BERT-class models locally
without PyTorch or TensorFlow. enquire-mcp's [[Embeddings]] layer depends on
this stack via the @huggingface/transformers optional dependency.
`,

  "Reference/Transformers.md": `---
title: Transformers
tags: [reference, ml]
---

# Transformers — Self-Attention Architecture

The Transformer architecture (Vaswani et al, 2017) is the foundation of modern
NLP. Self-attention, multi-head attention, positional encodings — all the
core ingredients.

Encoder-only variants (BERT, RoBERTa, MiniLM, BGE) are used for [[Embeddings]]
and [[Reranker]] cross-encoders. Decoder-only variants ([[LLM]]) generate text.

Hugging Face's transformers library is the de facto standard; transformers.js
is the JS port that runs [[ONNX]]-converted models in Node.
`,

  "Reference/MTEB.md": `---
title: MTEB
tags: [reference, benchmark]
---

# MTEB — Massive Text Embedding Benchmark

MTEB is the standard benchmark for [[Embeddings]] quality: 56 datasets across
classification, clustering, pair classification, retrieval, reranking, STS,
and summarization. The MTEB leaderboard at HuggingFace is the canonical place
to compare embedders.

BGE, gte, nomic, e5, mxbai — all measured on MTEB. Retrieval task uses NDCG@10
as the headline metric, matching the IR convention.
`,

  "Reference/BEIR.md": `---
title: BEIR
tags: [reference, benchmark]
---

# BEIR — Benchmark for Information Retrieval

BEIR is a heterogeneous IR benchmark suite: 18 datasets across web search,
biomedical, news, scientific, finance. Single zero-shot evaluation protocol.
NDCG@10 is the headline metric.

Strong embedders dominate BEIR but [[BM25]] still wins specific datasets
(TREC-COVID, BioASQ). Hybrid + reranking via [[RRF]] + [[Reranker]] is the
production winning recipe.
`,

  "Reference/LLM.md": `---
title: LLM
tags: [reference, ml]
---

# LLM — Large Language Models

Large Language Models (GPT-4, Claude, Llama, Mistral) are generative
[[Transformers]] models trained on internet-scale text. Capabilities: question
answering, code generation, summarization, planning, agentic loops.

LLMs power the "generation" half of [[RAG]]. They also drive sub-question
decomposition: the agent breaks a complex query into sub-queries, retrieves
for each, and synthesizes the union. Used together with hybrid retrieval +
reranking for the best agentic RAG quality.
`,

  "Reference/Tokenization.md": `---
title: Tokenization
tags: [reference, ml]
---

# Tokenization — Text to Tokens

Tokenization splits raw text into the units the model actually consumes.
Word-level is too coarse (out-of-vocabulary), char-level is too granular,
subword (BPE, WordPiece, Unigram, SentencePiece) is the modern sweet spot.

Different models use different tokenizers — query embedding and document
embedding MUST use the same one. enquire-mcp delegates this to the embedder
([[Embeddings]]) loaded from HuggingFace.
`,

  "Reference/Chunking.md": `---
title: Chunking
tags: [reference, retrieval]
---

# Chunking — Splitting Documents for Indexing

Chunking splits long documents into bounded passages so the retriever can
work paragraph-by-paragraph. Strategies:

- Fixed-size character or token window
- Paragraph-first (\\n\\n → \\n → hardcut)
- Recursive splitter with overlap
- Semantic chunking based on embedding distance

enquire-mcp uses paragraph-first with ~4KB max chunks, plus optional late-
chunking style context (doc title + heading breadcrumb + neighbor tails)
for +2-5 NDCG@10 on the [[Embeddings]] side. See [[Chunking]] for details.
`,

  "Reference/Graph.md": `---
title: Graph
tags: [reference, math]
---

# Graph — Nodes and Edges

A graph is a set of nodes connected by edges. In Obsidian, every note is a
node and every wikilink is a directed edge. Graph algorithms — [[PageRank]],
[[Louvain]] community detection, shortest path — let you reason about the
structure of your knowledge.

Wikilink graphs tend to be sparse and small-world (high clustering, low
diameter), which is why community detection finds meaningful clusters.
`,

  "Reference/Louvain.md": `---
title: Louvain
tags: [reference, algorithm]
---

# Louvain — Modularity Community Detection

The Louvain algorithm (Blondel et al, 2008) is a fast greedy method for
finding communities in a [[Graph]] by maximizing modularity. Two phases
iterated until convergence: local moves of nodes to neighbor communities,
then merging communities into super-nodes.

Used by enquire-mcp's GraphRAG-light feature to group wikilink-connected
notes into clusters for cluster-aware retrieval. Works hand-in-hand with
[[PageRank]] for community-level summaries.
`,

  "Reference/PageRank.md": `---
title: PageRank
tags: [reference, algorithm]
---

# PageRank — Node Ranking by In-Degree

PageRank (Brin & Page, 1998) ranks [[Graph]] nodes by recursively distributing
"score" from each node to its out-neighbors. Original use: ranking web pages.
Modern use: ranking notes by how central they are in the wikilink graph.

In enquire-mcp, a 1-step personalized PageRank seeded by the top-K [[RRF]]
candidates produces a small graph-boost score that breaks ties in favor of
notes other top hits link to.
`,

  "Reference/Cache.md": `---
title: Cache
tags: [reference, systems]
---

# Cache — Cached Lookups

Caches trade memory for speed: store the result of an expensive lookup and
reuse on subsequent calls. LRU (least-recently-used) eviction is the classic
strategy; FIFO and LFU are alternatives.

enquire-mcp caches parsed notes keyed by (path, mtime) — re-reading a file
that hasn't changed is a constant-time map lookup. Also persistent-cache
mode writes the cache to disk so a cold restart skips the parse pass entirely.
`,

  "Reference/SQLite.md": `---
title: SQLite
tags: [reference, database]
---

# SQLite — Embedded SQL Database

SQLite is a serverless, zero-config, single-file SQL database. The most-
deployed database in the world (every iOS device, every Android device, every
browser). [[FTS5]] is SQLite's full-text search extension.

enquire-mcp uses SQLite via better-sqlite3 for FTS5 BM25, for the persistent
embed.db ([[Embeddings]] BLOBs), and for the parse cache.
`,

  "Reference/Bases.md": `---
title: Bases
tags: [reference, obsidian]
---

# Bases — Obsidian Database Plugin

Obsidian Bases (\`.base\` files) are a database/spreadsheet abstraction over
markdown notes. Each base is a YAML query spec that materializes as a table
or board view: filter, sort, group, formula columns.

enquire-mcp ships a standalone .base query executor — read and evaluate
Bases without Obsidian running. The formula DSL is partial in v3.6 (literal,
property, comparison); full formula support is deferred to v3.7.
`,

  "Reference/Dataview.md": `---
title: Dataview
tags: [reference, obsidian]
---

# Dataview — Obsidian Query Plugin

Dataview is the predecessor to [[Bases]] for inline queries inside markdown
notes. DQL syntax (TABLE / LIST / TASK ... FROM ... WHERE ... SORT) and
JavaScript inline queries.

enquire-mcp parses inline Dataview blocks and surfaces them as structured
data alongside frontmatter. Limited DQL evaluation; full Dataview JS API is
out of scope (would require an Obsidian runtime).
`,

  "Reference/Canvas.md": `---
title: Canvas
tags: [reference, obsidian]
---

# Canvas — Visual Boards

Obsidian Canvas is the visual whiteboard feature: place text cards, file
cards, image cards, and link cards on an infinite plane; draw edges between
them. Canvas files are JSON (\`.canvas\` extension).

enquire-mcp can list canvases and read their structure (nodes + edges) so an
LLM agent can reason about a visual board the same way it reads a note.
`,

  "Reference/MCP.md": `---
title: MCP
tags: [reference, protocol]
---

# MCP — Model Context Protocol

The Model Context Protocol (MCP) is Anthropic's open standard for connecting
LLM agents to external tools and data sources. JSON-RPC 2.0 over stdio or
HTTP. Three surfaces: tools (callable functions), resources (readable URIs),
prompts (reusable templates).

enquire-mcp implements an MCP server exposing an Obsidian vault: 44 tools,
19 prompts, resource templates for notes / chunks / canvases. Works with
Claude Desktop, Claude Code, Cursor, ChatGPT custom GPTs, and any MCP client.
`,

  "Projects/RAG-bot.md": `---
title: RAG bot
tags: [project, rag]
---

# Project: RAG bot

Building a RAG bot over my personal Obsidian vault. Goals:

- Hybrid retrieval over markdown notes (current: BM25 + [[Embeddings]] + RRF)
- Cross-encoder [[Reranker]] for top-K precision
- Sub-question decomposition for compound queries
- HyDE for under-specified queries

Stack: enquire-mcp v3.6, Claude Code, local multilingual MiniLM, BGE reranker.
See [[Reference/RAG]] for the underlying concepts.
`,

  "Projects/Search-quality.md": `---
title: Search quality
tags: [project, retrieval]
---

# Project: Improve search quality

Tuning hybrid retrieval over the vault. Measurement-first approach:

1. Build a ground-truth query set with known-relevant notes.
2. Run \`enquire-mcp eval\` to measure NDCG / Recall / MRR on each config.
3. Iterate: graph_boost on/off, reranker top-N, embedder choice, HyDE.

Current baseline: hybrid via [[RRF]] alone. Target: +5-10 NDCG@10 from
[[Reranker]] + GraphRAG-light cluster reranking ([[Louvain]] + [[PageRank]]).
`,

  "Projects/Vault-redesign.md": `---
title: Vault redesign
tags: [project, organization]
---

# Project: Vault redesign

Reorganizing the vault from a flat structure into themed folders:

- \`Reference/\` — durable knowledge-base notes
- \`Projects/\` — active work-in-progress
- \`Daily/\` — daily journal entries
- \`Inbox/\` — captured raw notes pending triage

Move history is preserved via wikilinks (broken-link detection catches stale
references). Inspired by the PARA method but customized for an LLM-friendly
search pattern.
`,

  "Projects/Obsidian-plugin.md": `---
title: Obsidian plugin
tags: [project, obsidian]
---

# Project: Obsidian plugin

Building a community plugin for [[Obsidian]] that talks to enquire-mcp via
HTTP. Goals:

- Live sync of edited notes back to the FTS5 + embed indices
- In-app retrieval preview alongside the regular Search pane
- Inline citations from hybrid retrieval

Status: spike done, awaiting v3.6 stable to lock the MCP API.
`,

  "Projects/MCP-server.md": `---
title: MCP server
tags: [project, mcp]
---

# Project: MCP server (enquire-mcp)

Maintaining enquire-mcp, the [[Reference/MCP]] server for [[Obsidian]] vaults.
Current sprint: v3.6.0 — top-1 by retrieval quality and reliability.

RC sequence:
- rc.1: tools.ts (4252 lines) split into domain modules
- rc.2: index.ts (3665 lines) split into cli/server/registry/prompts
- rc.3: Full TSDoc on 44 tools + 19 prompts + helpers
- rc.4: TypeDoc + GH Pages + public benchmarks (this doc)
- v3.6.0 stable: promote rc.4 to npm latest

See [[Projects/Search-quality]] for the retrieval-quality side.
`,

  "Projects/Embeddings-pipeline.md": `---
title: Embeddings pipeline
tags: [project, ml]
---

# Project: Embeddings pipeline

Cold-build + incremental sync for the persistent [[Reference/Embeddings]]
index. Per-note steps:

1. Read + parse the markdown body.
2. [[Reference/Chunking]] into ~4KB paragraphs.
3. Prepend doc title + heading breadcrumb (late-chunking style).
4. Batch-embed via [[Reference/ONNX]] / transformers.js.
5. Upsert into the SQLite embed.db (Float32 or int8-quantized).

Incremental sync uses mtime tracking — only changed files re-embed. Cold-
build on a 1k-note vault is ~60s on M1; warm sync is sub-second.
`,

  "Daily/2026-01-15.md": `---
title: 2026-01-15
tags: [daily]
date: 2026-01-15
---

# 2026-01-15

Started thinking about better search over my vault. Tried plain grep — works
for exact terms but misses synonyms. Considering a hybrid approach with
[[Reference/BM25]] + [[Reference/Embeddings]].

Backlog: try [[Reference/RRF]] fusion across both.
`,

  "Daily/2026-02-01.md": `---
title: 2026-02-01
tags: [daily]
date: 2026-02-01
---

# 2026-02-01

Set up enquire-mcp on my vault. First run of \`obsidian_search\`. Hybrid
retrieval works out of the box; the BM25 + TF-IDF + embeddings fusion
surfaces notes I'd forgotten about.

Followup: read [[Reference/MTEB]] and pick a better embedder.
`,

  "Daily/2026-03-10.md": `---
title: 2026-03-10
tags: [daily]
date: 2026-03-10
---

# 2026-03-10

Enabled the [[Reference/Reranker]] for the daily search. NDCG@10 on my
private eval set went from 0.71 → 0.79. Latency penalty is ~40ms, acceptable.

Reading about [[Reference/HyDE]] today; might help under-specified queries.
`,

  "Daily/2026-04-05.md": `---
title: 2026-04-05
tags: [daily]
date: 2026-04-05
---

# 2026-04-05

Daily standup notes:
- Pushed [[Projects/Search-quality]] iteration: graph-boost added
- Reviewed wikilink graph density; might try [[Reference/Louvain]] clustering
- Outstanding: HyDE integration in [[Projects/RAG-bot]]
`,

  "Daily/2026-05-15.md": `---
title: 2026-05-15
tags: [daily]
date: 2026-05-15
---

# 2026-05-15

Today's tasks (during the v3.6.0-rc.4 sprint):
- Ship TypeDoc-generated API reference to GH Pages
- Author this benchmarks page (we're inside it now)
- Compare hybrid + reranker against the FS-grep baseline

Working on [[Projects/MCP-server]]. Reference: [[Reference/MCP]].
`,

  "Inbox/recipe-pasta.md": `---
title: Pasta carbonara recipe
tags: [recipe, food]
---

# Carbonara

Classic Roman recipe. Ingredients:

- 200g guanciale or pancetta
- 100g pecorino romano, finely grated
- 4 egg yolks + 1 whole egg
- 400g spaghetti or rigatoni
- Black pepper, salt

Render the pancetta. Toss hot pasta with the pecorino + egg mixture off
heat. The residual heat cooks the eggs into a silky sauce.

No cream. Ever.
`,

  "Inbox/recipe-bread.md": `---
title: Sourdough bread recipe
tags: [recipe, food, baking]
---

# Sourdough loaf

Long-fermented home loaf. Ingredients:

- 500g bread flour
- 350g water (70% hydration)
- 100g active sourdough starter
- 10g salt

Autolyse 30 min, mix in starter and salt, fold every 30 min for 3 hours,
cold-retard overnight, bake covered at 250°C for 20 min then uncovered for
20 min. Open crumb, blistered crust.
`,

  "Inbox/garden-notes.md": `---
title: Garden notes
tags: [garden, hobby]
---

# Garden notes

Spring planting plan. Vegetables and plants:

- Tomatoes (San Marzano, Cherokee Purple)
- Basil, parsley, cilantro
- Lettuce mix, arugula
- Snap peas, pole beans
- Cucumbers, zucchini

Companion-planting basil with tomatoes is the classic combo. Garden bed is
4x8 feet, raised, full sun. Irrigation via drip line on a 6am timer.
`,

  "Inbox/travel-tokyo.md": `---
title: Tokyo trip plan
tags: [travel]
---

# Tokyo trip itinerary

Planned itinerary for a 7-day trip to Tokyo, Japan:

- Day 1: Arrival, Shibuya
- Day 2: Asakusa, Senso-ji, Sumida river cruise
- Day 3: Tsukiji outer market, Ginza
- Day 4: Day trip to Kamakura
- Day 5: Akihabara, Shinjuku Gyoen
- Day 6: TeamLab Planets, Odaiba
- Day 7: Last shopping, departure

Tokyo metro pass + Suica card. Reservations for sushi at Tsukiji.
`,

  "Inbox/movie-list.md": `---
title: Movie watchlist
tags: [movies, hobby]
---

# Movie watchlist

Cinema queue, sorted roughly by interest:

- Past Lives (2023) — Celine Song
- The Zone of Interest (2023) — Jonathan Glazer
- Anatomy of a Fall (2023) — Justine Triet
- Killers of the Flower Moon (2023) — Scorsese
- Poor Things (2023) — Lanthimos

Pre-2023 catch-up: rewatch In the Mood for Love. Director recommendations
welcome.
`
};

// Stable epoch for mtimes (2026-05-15T00:00:00Z, in seconds).
const STABLE_MTIME_S = 1778803200;

async function buildSyntheticVault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bench-vault-"));
  for (const [relPath, content] of Object.entries(VAULT_NOTES)) {
    const abs = path.join(root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    await fs.utimes(abs, STABLE_MTIME_S, STABLE_MTIME_S);
  }
  return root;
}

// ─── Metrics helper ──────────────────────────────────────────────────────────

function scoreOne(retrievedPaths, relevantSet, k = 10) {
  return {
    ndcg: ndcgAtK(retrievedPaths, relevantSet, k),
    recall: recallAtK(retrievedPaths, relevantSet, k),
    mrr: reciprocalRank(retrievedPaths, relevantSet, k)
  };
}

function aggregate(perQuery, label) {
  const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    label,
    n: perQuery.length,
    mean_ndcg: mean(perQuery.map((p) => p.ndcg)),
    mean_recall: mean(perQuery.map((p) => p.recall)),
    mean_mrr: mean(perQuery.map((p) => p.mrr)),
    mean_latency_ms: mean(perQuery.map((p) => p.latency_ms)),
    per_query: perQuery
  };
}

// Per-category breakdown — slice the per_query array by query.category and
// report mean NDCG@10 per slice. Helps the doc reader see WHICH query types
// benefit from each stack rather than just the headline aggregate.
function byCategory(row, queries) {
  if (!row.per_query) return {};
  const cats = {};
  const byId = new Map(queries.map((q) => [q.id, q]));
  for (const pq of row.per_query) {
    const cat = byId.get(pq.id)?.category ?? "unknown";
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(pq.ndcg);
  }
  const out = {};
  for (const [cat, ndcgs] of Object.entries(cats)) {
    out[cat] = ndcgs.length === 0 ? 0 : ndcgs.reduce((a, b) => a + b, 0) / ndcgs.length;
  }
  return out;
}

// ─── Stack runners ───────────────────────────────────────────────────────────

// FS grep baseline — emulate the kind of retrieval a fs-only Obsidian MCP
// server would do. For each query: split on whitespace, regex-grep each
// markdown file's body, rank by occurrence count. This is what filesystem-
// MCP servers (and `grep` users) actually deliver.
async function runFsGrepBaseline(vault, queries) {
  const entries = await vault.listMarkdown();
  const fileBodies = new Map();
  for (const e of entries) {
    const buf = await fs.readFile(e.absPath, "utf8");
    // Strip YAML frontmatter to match how a competitor MCP would treat the
    // user-visible content.
    const body = buf.replace(/^---\n[\s\S]*?\n---\n/, "");
    fileBodies.set(e.relPath, body.toLowerCase());
  }
  const perQuery = [];
  for (const q of queries) {
    const tokens = q.query.toLowerCase().split(/\s+/).filter(Boolean);
    const t0 = performance.now();
    const scored = [];
    for (const [relPath, body] of fileBodies) {
      let count = 0;
      for (const t of tokens) {
        const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        const matches = body.match(re);
        if (matches) count += matches.length;
      }
      if (count > 0) scored.push({ relPath, count });
    }
    scored.sort((a, b) => b.count - a.count);
    const retrieved = scored.slice(0, 10).map((s) => s.relPath);
    const latency = performance.now() - t0;
    const m = scoreOne(retrieved, new Set(q.relevant), 10);
    perQuery.push({ id: q.id, ...m, latency_ms: latency });
  }
  return aggregate(perQuery, "FS-grep baseline");
}

// BM25 only — directly query the FTS5 index, no fusion, no TF-IDF, no embeddings.
async function runBm25Only(vault, ftsIndex, queries) {
  const perQuery = [];
  for (const q of queries) {
    const t0 = performance.now();
    let retrieved = [];
    try {
      const hits = ftsIndex.search(q.query, { limit: 50 });
      const filtered = hits.filter((h) => !vault.isExcluded(h.rel_path));
      // Collapse multi-chunk hits to one per note (best rank wins).
      const seen = new Set();
      const collapsed = [];
      for (const h of filtered) {
        if (!seen.has(h.rel_path)) {
          seen.add(h.rel_path);
          collapsed.push(h);
        }
      }
      retrieved = collapsed.slice(0, 10).map((h) => h.rel_path);
    } catch {
      retrieved = [];
    }
    const latency = performance.now() - t0;
    const m = scoreOne(retrieved, new Set(q.relevant), 10);
    perQuery.push({ id: q.id, ...m, latency_ms: latency });
  }
  return aggregate(perQuery, "BM25 only");
}

// TF-IDF only — call semanticSearch (pure-JS TF-IDF) and use its ranking.
async function runTfidfOnly(vault, queries) {
  const perQuery = [];
  for (const q of queries) {
    const t0 = performance.now();
    let retrieved = [];
    try {
      const r = await semanticSearch(vault, { query: q.query, limit: 10, min_score: 0.0 });
      retrieved = r.matches.map((m) => m.path);
    } catch {
      retrieved = [];
    }
    const latency = performance.now() - t0;
    const m = scoreOne(retrieved, new Set(q.relevant), 10);
    perQuery.push({ id: q.id, ...m, latency_ms: latency });
  }
  return aggregate(perQuery, "TF-IDF only");
}

// Embeddings only — query the .embed.db cosine k-NN (no BM25, no TF-IDF, no fusion).
// We must pass the same model alias used at build time, otherwise the embed.db
// meta-table contamination guard would drop tables and rebuild on first open.
async function runEmbeddingsOnly(vault, embedFile, queries, modelAlias) {
  const perQuery = [];
  for (const q of queries) {
    const t0 = performance.now();
    let retrieved = [];
    try {
      const r = await embeddingsSearch(
        vault,
        { query: q.query, limit: 50, min_score: 0, model: modelAlias },
        embedFile
      );
      // Collapse chunk-level to note-level (best chunk per note).
      const seen = new Set();
      const collapsed = [];
      for (const h of r.matches) {
        if (!seen.has(h.path)) {
          seen.add(h.path);
          collapsed.push(h);
        }
      }
      retrieved = collapsed.slice(0, 10).map((h) => h.path);
    } catch {
      retrieved = [];
    }
    const latency = performance.now() - t0;
    const m = scoreOne(retrieved, new Set(q.relevant), 10);
    perQuery.push({ id: q.id, ...m, latency_ms: latency });
  }
  return aggregate(perQuery, "Embeddings only");
}

// Hybrid — full searchHybrid with optional reranker, with HNSW disabled
// (deterministic O(n) brute-force cosine). We pass embedding_model to keep
// the embed.db's model meta consistent across calls.
async function runHybrid(
  vault,
  ftsIndex,
  embedFile,
  queries,
  { reranker, rerankerOverride, graphBoost = true, label, embeddingModel } = {}
) {
  const perQuery = [];
  for (const q of queries) {
    const t0 = performance.now();
    let retrieved = [];
    try {
      const r = await searchHybrid(
        vault,
        {
          query: q.query,
          limit: 10,
          graph_boost: graphBoost,
          ...(embeddingModel ? { embedding_model: embeddingModel } : {})
        },
        {
          ftsIndex,
          embedFile,
          ...(reranker ? { reranker } : {}),
          ...(rerankerOverride ? { rerankerOverride } : {})
        }
      );
      retrieved = r.matches.map((m) => m.path);
    } catch {
      retrieved = [];
    }
    const latency = performance.now() - t0;
    const m = scoreOne(retrieved, new Set(q.relevant), 10);
    perQuery.push({ id: q.id, ...m, latency_ms: latency });
  }
  return aggregate(perQuery, label);
}

// Hybrid + reranker — wraps runHybrid with a reranker config. If model load
// fails (no network / no transformers dep), the agg will reflect the
// non-reranker result because searchHybrid catches reranker errors and falls
// back to RRF order. We surface that fact by checking signal_errors.
async function runHybridReranked(vault, ftsIndex, embedFile, queries, rerankerAlias, embeddingModel, rerankerOverride) {
  return runHybrid(vault, ftsIndex, embedFile, queries, {
    reranker: { alias: rerankerAlias, topN: 50 },
    rerankerOverride,
    graphBoost: true,
    embeddingModel,
    label: `Hybrid + reranker (${rerankerAlias})`
  });
}

// Hybrid + reranker + HyDE — same as above but the embeddings arm uses a
// hand-constructed "hypothetical answer" string. Real HyDE generates this
// via an LLM; for reproducibility we use a deterministic mapping. Documented
// clearly as a limitation in the output.
async function runHybridRerankedHyde(
  vault,
  ftsIndex,
  embedFile,
  queries,
  rerankerAlias,
  hydeMap,
  embeddingModel,
  rerankerOverride
) {
  // True HyDE replaces ONLY the embeddings-arm seed with a hypothetical
  // answer text generated by an LLM (Gao et al, 2023). searchHybrid in
  // src/tools/search.ts doesn't expose HyDE directly — the surface is via
  // embeddingsSearch (which accepts `hypothetical_answer`). We replicate
  // searchHybrid's BM25 + TF-IDF + embeddings RRF fusion + graph-boost +
  // cross-encoder reranking here so we can substitute the embeddings arm's
  // seed without touching `src/`. The hand-authored hypothetical answers
  // are deterministic — see `HYDE_ANSWERS` below.
  //
  // We score ONLY the queries that have a hypothetical answer authored
  // (otherwise this row is identical to `Hybrid + reranker` and contributes
  // no signal). Queries without an answer are skipped; the row label
  // includes the actual N.
  const perQuery = [];
  for (const q of queries) {
    const ha = hydeMap.get(q.id);
    if (!ha) continue;
    const t0 = performance.now();
    let retrieved = [];
    try {
      // Run embeddings-arm separately with HyDE seed, then merge with the
      // BM25 + TF-IDF arms via RRF. This is the closest faithful HyDE
      // simulation given the public searchHybrid surface.
      const [bm25Hits, tfidfRes, embRes] = await Promise.all([
        Promise.resolve(ftsIndex.search(q.query, { limit: 50 }).filter((h) => !vault.isExcluded(h.rel_path))),
        semanticSearch(vault, { query: q.query, limit: 50, min_score: 0 }),
        embeddingsSearch(
          vault,
          { query: q.query, hypothetical_answer: ha, limit: 50, min_score: 0, model: embeddingModel },
          embedFile
        )
      ]);
      // Collapse to note-level and build RRF inputs.
      const bm25Ranked = [];
      const seenBm = new Set();
      let bmRank = 1;
      for (const h of bm25Hits) {
        if (!seenBm.has(h.rel_path)) {
          seenBm.add(h.rel_path);
          bm25Ranked.push({ id: h.rel_path, rank: bmRank++, score: h.score });
        }
      }
      const tfidfRanked = tfidfRes.matches.map((m, i) => ({ id: m.path, rank: i + 1, score: m.score }));
      const embedSeen = new Set();
      const embedRanked = [];
      let embRank = 1;
      for (const h of embRes.matches) {
        if (!embedSeen.has(h.path)) {
          embedSeen.add(h.path);
          embedRanked.push({ id: h.path, rank: embRank++, score: h.score });
        }
      }
      const fused = reciprocalRankFusion(
        { bm25: bm25Ranked, tfidf: tfidfRanked, embeddings: embedRanked },
        { topK: 50 }
      );
      // Wikilink graph-boost — mirror src/tools/search.ts:searchHybrid (v2.3.0).
      // Count how many other top-K hits link to each candidate; α=0.005 boost.
      if (fused.length > 1) {
        const candidatePaths = new Set();
        for (const f of fused) candidatePaths.add(f.id.includes("#") ? f.id.split("#")[0] : f.id);
        const outLinks = new Map();
        for (const cp of candidatePaths) {
          try {
            const note = await vault.readNote(vault.resolveInside(cp));
            const targets = new Set();
            for (const wl of note.parsed.wikilinks) {
              if (!wl.target) continue;
              targets.add(wl.target);
              targets.add(wl.target.replace(/\.md$/i, ""));
            }
            outLinks.set(cp, targets);
          } catch {
            // unreadable notes get no outlinks
          }
        }
        const ALPHA = 0.005;
        for (const f of fused) {
          const fPath = f.id.includes("#") ? f.id.split("#")[0] : f.id;
          const fBasename = path.basename(fPath).replace(/\.md$/i, "");
          let inDegree = 0;
          for (const [other, targets] of outLinks) {
            if (other === fPath) continue;
            if (targets.has(fPath) || targets.has(fPath.replace(/\.md$/i, "")) || targets.has(fBasename)) {
              inDegree += 1;
            }
          }
          if (inDegree > 0) f.score += ALPHA * inDegree;
        }
        fused.sort((a, b) => b.score - a.score);
      }
      // Apply reranker if available.
      let topK = fused.slice(0, 10).map((f) => f.id);
      if (rerankerOverride) {
        try {
          const top50 = fused.slice(0, 50);
          // Fetch snippets — use TF-IDF snippets since they're always populated.
          const tfidfMap = new Map(tfidfRes.matches.map((m) => [m.path, m.snippet]));
          const bm25Map = new Map(bm25Hits.map((h) => [h.rel_path, h.snippet]));
          const embMap = new Map(embRes.matches.map((m) => [m.path, m.snippet]));
          const passages = top50.map((f) => {
            const snippet = bm25Map.get(f.id) ?? embMap.get(f.id) ?? tfidfMap.get(f.id) ?? "";
            return snippet.replace(/[«»]/g, "").slice(0, 600);
          });
          const scores = await rerankerOverride.score(q.query, passages);
          const reorder = top50
            .map((f, i) => ({ id: f.id, score: scores[i] ?? -Infinity }))
            .sort((a, b) => b.score - a.score);
          topK = reorder.slice(0, 10).map((r) => r.id);
        } catch {
          // Reranker failed; fall back to RRF order.
        }
      }
      retrieved = topK;
    } catch {
      retrieved = [];
    }
    const latency = performance.now() - t0;
    const m = scoreOne(retrieved, new Set(q.relevant), 10);
    perQuery.push({ id: q.id, ...m, latency_ms: latency });
  }
  return aggregate(perQuery, `Hybrid + reranker + HyDE-sim (${rerankerAlias}, HyDE subset)`);
}

// ─── HyDE hypothetical answers (deterministic, no LLM) ───────────────────────
// Real HyDE generates these via an LLM. For reproducibility we pre-author them
// by hand. The aim is to look like a plausible LLM-generated synthetic answer:
// a 1-2 sentence statement that paraphrases the topic in declarative form.
const HYDE_ANSWERS = new Map([
  [
    "q01",
    "Retrieval augmented generation is a pattern where an LLM retrieves passages from a knowledge base and uses them as context before answering."
  ],
  [
    "q02",
    "HNSW is a hierarchical navigable small world graph index for fast approximate nearest neighbor search on dense vectors."
  ],
  [
    "q03",
    "BM25 is a probabilistic lexical ranking function that combines term frequency, inverse document frequency, and document length normalization."
  ],
  [
    "q04",
    "TF-IDF weights terms by their frequency and rarity, and ranks documents using cosine similarity over TF-IDF vectors."
  ],
  [
    "q05",
    "Cross-encoder rerankers score query-passage pairs jointly using attention, achieving higher accuracy than bi-encoder cosine ranking."
  ],
  [
    "q06",
    "Reciprocal rank fusion combines multiple ranked lists by summing 1/(k+rank) per document across rankers; it beats score normalization on TREC."
  ],
  [
    "q07",
    "HyDE uses an LLM to generate a hypothetical answer to the query, embeds the answer, and retrieves against that synthetic vector."
  ],
  [
    "q33",
    "Hybrid retrieval combines lexical signals like BM25 with dense embeddings and fuses them via reciprocal rank fusion."
  ],
  [
    "q34",
    "Approximate nearest neighbor search finds the closest vectors in a high-dimensional space without scanning every candidate, typically via HNSW or IVF indexes."
  ],
  [
    "q35",
    "Information retrieval is measured by NDCG, recall, MRR, and precision at K on benchmarks like BEIR and MTEB."
  ],
  ["q36", "Semantic search uses dense embeddings to find conceptually related content even when no keywords match."],
  [
    "q37",
    "After initial retrieval, a cross-encoder reranker scores the top candidates and re-orders them for higher top-K precision."
  ],
  [
    "q38",
    "Documents are chunked into paragraph-sized passages before indexing so the retriever can return precise spans."
  ],
  ["q39", "Louvain community detection groups graph nodes into modular clusters by maximizing modularity."],
  [
    "q40",
    "Wikilinks create bidirectional connections between notes; backlinks let you see what links to a given note."
  ],
  [
    "q41",
    "Hybrid search combines BM25 lexical retrieval with embedding-based dense retrieval and fuses them with RRF."
  ],
  ["q42", "Reranking with a cross-encoder typically adds 5 to 10 NDCG points on standard retrieval benchmarks."],
  [
    "q43",
    "Local vector databases run ONNX-converted embedding models and store vectors in SQLite or a dedicated HNSW index."
  ],
  [
    "q47",
    "Effective chunking for embeddings uses paragraph boundaries with overlap and optional context augmentation."
  ],
  ["q48", "Reciprocal rank fusion combines rankers by summing 1/(k+rank) per document across all rankers."],
  [
    "q50",
    "Sub-question decomposition splits a complex query into smaller retrievable sub-queries handled by an agentic loop."
  ],
  ["q57", "Reference index notes are hub pages that link out to the curated knowledge base."],
  ["q58", "Daily standup notes capture the day's progress and outstanding tasks for ongoing projects."],
  [
    "q59",
    "BGE multilingual embedding models are produced by BAAI; mxbai-rerank-xsmall is a 25 MB multilingual cross-encoder reranker."
  ],
  [
    "q60",
    "To improve retrieval quality on a personal vault, run hybrid retrieval with a reranker and tune graph-boost and chunk overlap."
  ]
]);

// ─── Render ──────────────────────────────────────────────────────────────────

function fmt(x) {
  return x.toFixed(4);
}

function renderTable(rows) {
  const lines = [];
  lines.push("| Stack | MRR | NDCG@10 | Recall@10 | mean latency |");
  lines.push("|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${fmt(r.mean_mrr)} | ${fmt(r.mean_ndcg)} | ${fmt(r.mean_recall)} | ${r.mean_latency_ms.toFixed(1)}ms |`
    );
  }
  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const queriesFile = path.join(projectRoot, "tests", "fixtures", "benchmark-queries.jsonl");
  const queries = await readQueriesJsonl(queriesFile);
  process.stderr.write(`bench: loaded ${queries.length} queries from ${queriesFile}\n`);

  // readQueriesJsonl strips the `category` field (which is not part of the
  // canonical EvalQuery interface). Re-read the raw file so we can group
  // results by category for the published breakdown without modifying src/.
  const rawJsonl = await fs.readFile(queriesFile, "utf8");
  for (const line of rawJsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const target = queries.find((q) => q.id === parsed.id);
      if (target && typeof parsed.category === "string") target.category = parsed.category;
    } catch {
      // ignore — readQueriesJsonl would have already errored on real malformed lines
    }
  }

  process.stderr.write("bench: building synthetic vault...\n");
  const vaultRoot = await buildSyntheticVault();
  process.stderr.write(`bench: vault root = ${vaultRoot}\n`);

  const tmpIndexDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bench-idx-"));
  const ftsFile = path.join(tmpIndexDir, "fts5.db");
  const embedFile = path.join(tmpIndexDir, "embed.db");

  const vault = new Vault(vaultRoot);
  await vault.ensureExists();

  // Build FTS5 index.
  process.stderr.write("bench: building FTS5 index...\n");
  const ftsIndex = new FtsIndex({ file: ftsFile, vaultRoot: vault.root });
  await ftsIndex.open();
  const ftsReport = await syncFtsIndex(vault, ftsIndex);
  process.stderr.write(
    `bench: FTS5 indexed ${ftsReport.added + ftsReport.unchanged} files, ${ftsReport.total_chunks} chunks\n`
  );

  // Build the embed.db if we can. Pick the smallest model (bge, ~33MB).
  // Failure here = embedding-dependent stacks are reported as skipped.
  const EMBEDDER_ALIAS = "bge";
  let embedReady = false;
  let embedSkipReason = null;
  process.stderr.write(`bench: building embeddings (model=${EMBEDDER_ALIAS})...\n`);
  const embedderStart = performance.now();
  try {
    const { loadEmbedder, resolveModel } = await import(path.join(distDir, "embeddings.js"));
    const { EmbedDb } = await import(path.join(distDir, "embed-db.js"));
    const modelMeta = resolveModel(EMBEDDER_ALIAS);
    const db = new EmbedDb({ file: embedFile, vaultRoot: vault.root, modelAlias: modelMeta.alias, dim: modelMeta.dim });
    await db.open();
    try {
      const embedder = await loadEmbedder(EMBEDDER_ALIAS);
      const r = await syncEmbedDb(vault, db, embedder);
      process.stderr.write(
        `bench: embeddings built (${r.total_chunks} chunks, ${(performance.now() - embedderStart).toFixed(0)}ms)\n`
      );
      embedReady = true;
    } finally {
      db.close();
    }
  } catch (err) {
    embedSkipReason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`bench: embeddings skipped — ${embedSkipReason}\n`);
  }

  // ─── Run all stacks ────────────────────────────────────────────────────
  const rows = [];
  const meta = {
    queries_count: queries.length,
    vault_notes: Object.keys(VAULT_NOTES).length,
    k: 10,
    embedder: EMBEDDER_ALIAS,
    embed_ready: embedReady,
    embed_skip_reason: embedSkipReason,
    node_version: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu_model: os.cpus()[0]?.model ?? "unknown",
    timestamp: `${new Date().toISOString().slice(0, 19)}Z`
  };

  process.stderr.write("bench: running FS-grep baseline...\n");
  rows.push(await runFsGrepBaseline(vault, queries));

  process.stderr.write("bench: running BM25-only...\n");
  rows.push(await runBm25Only(vault, ftsIndex, queries));

  process.stderr.write("bench: running TF-IDF-only...\n");
  rows.push(await runTfidfOnly(vault, queries));

  if (embedReady) {
    process.stderr.write("bench: running Embeddings-only...\n");
    rows.push(await runEmbeddingsOnly(vault, embedFile, queries, EMBEDDER_ALIAS));
  } else {
    rows.push({
      label: "Embeddings only",
      n: 0,
      mean_ndcg: 0,
      mean_recall: 0,
      mean_mrr: 0,
      mean_latency_ms: 0,
      skipped: true,
      reason: embedSkipReason
    });
  }

  process.stderr.write("bench: running Hybrid (BM25+TF-IDF+embeddings, RRF, graph-boost)...\n");
  rows.push(
    await runHybrid(vault, ftsIndex, embedFile, queries, {
      graphBoost: true,
      embeddingModel: EMBEDDER_ALIAS,
      label: "Hybrid (BM25+TF-IDF+embeddings, RRF)"
    })
  );

  process.stderr.write("bench: running Hybrid + BGE reranker...\n");
  // rerank-bge — BGE-reranker-base (~280 MB quantized English cross-encoder).
  // We prefer it over rerank-multilingual (mxbai-xsmall) because the mxbai
  // model is currently gated on HuggingFace and download returns 401.
  // BGE-base is the canonical English reranker; numbers below are for it.
  //
  // We load the q8 (int8-quantized) ONNX variant directly via transformers.js
  // so the on-disk download is ~280 MB instead of the full fp32 (~1.1 GB).
  // enquire-mcp's loadReranker() in src/embeddings.ts uses fp32 by default;
  // for the bench we override via the pipeline `dtype: 'q8'` option. This
  // matches the quantization mode a typical production deployment would
  // use after `npm i hnswlib-node` + `enquire-mcp install-model`.
  const RERANKER_ALIAS = "rerank-bge";
  const RERANKER_HFID = "Xenova/bge-reranker-base";
  let rerankerReady = false;
  let rerankerSkipReason = null;
  let bgeReranker = null;
  try {
    // Load tokenizer + model directly. The high-level `text-classification`
    // pipeline returns sigmoid(score)=1.0 for every input on this model
    // (single-label head; the pipeline applies softmax over a 1-class output
    // → always 1). We invoke the model directly and read the raw logit so
    // scores actually rank passages by relevance. Sigmoid the logit at the
    // end to get a comparable [0, 1] score matching the convention in
    // src/embeddings.ts:loadReranker.
    const tf = await import("@huggingface/transformers");
    const tokenizer = await tf.AutoTokenizer.from_pretrained(RERANKER_HFID);
    const model = await tf.AutoModelForSequenceClassification.from_pretrained(RERANKER_HFID, {
      dtype: "q8"
    });
    const sigmoid = (x) => 1 / (1 + Math.exp(-x));
    bgeReranker = {
      async score(query, passages) {
        if (passages.length === 0) return [];
        const out = [];
        for (const passage of passages) {
          const inputs = tokenizer(query, { text_pair: passage, padding: true, truncation: true });
          const { logits } = await model(inputs);
          const raw = logits.data[0];
          out.push(typeof raw === "number" ? sigmoid(raw) : -Infinity);
        }
        return out;
      }
    };
    rerankerReady = true;
  } catch (err) {
    rerankerSkipReason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`bench: reranker skipped — ${rerankerSkipReason}\n`);
  }
  meta.reranker_alias = RERANKER_ALIAS;
  meta.reranker_hfid = RERANKER_HFID;
  meta.reranker_dtype = "q8";
  meta.reranker_ready = rerankerReady;
  meta.reranker_skip_reason = rerankerSkipReason;

  if (rerankerReady && embedReady) {
    rows.push(
      await runHybridReranked(vault, ftsIndex, embedFile, queries, RERANKER_ALIAS, EMBEDDER_ALIAS, bgeReranker)
    );
  } else {
    rows.push({
      label: `Hybrid + reranker (${RERANKER_ALIAS})`,
      n: 0,
      mean_ndcg: 0,
      mean_recall: 0,
      mean_mrr: 0,
      mean_latency_ms: 0,
      skipped: true,
      reason: rerankerSkipReason ?? embedSkipReason
    });
  }

  process.stderr.write("bench: running Hybrid + reranker (HyDE subset)...\n");
  // Apples-to-apples: same 25-query subset that HyDE-sim runs on, but with
  // HyDE off. This shows the marginal HyDE-only contribution (vs. baseline).
  const hydeSubset = queries.filter((q) => HYDE_ANSWERS.has(q.id));
  meta.hyde_subset_count = hydeSubset.length;
  if (rerankerReady && embedReady) {
    const baselineSubset = await runHybridReranked(
      vault,
      ftsIndex,
      embedFile,
      hydeSubset,
      RERANKER_ALIAS,
      EMBEDDER_ALIAS,
      bgeReranker
    );
    baselineSubset.label = `Hybrid + reranker (HyDE subset, n=${hydeSubset.length})`;
    rows.push(baselineSubset);
  } else {
    rows.push({
      label: "Hybrid + reranker (HyDE subset)",
      n: 0,
      mean_ndcg: 0,
      mean_recall: 0,
      mean_mrr: 0,
      mean_latency_ms: 0,
      skipped: true,
      reason: rerankerSkipReason ?? embedSkipReason
    });
  }

  process.stderr.write("bench: running Hybrid + reranker + HyDE-sim...\n");
  if (rerankerReady && embedReady) {
    rows.push(
      await runHybridRerankedHyde(
        vault,
        ftsIndex,
        embedFile,
        queries,
        RERANKER_ALIAS,
        HYDE_ANSWERS,
        EMBEDDER_ALIAS,
        bgeReranker
      )
    );
  } else {
    rows.push({
      label: "Hybrid + reranker + HyDE-sim",
      n: 0,
      mean_ndcg: 0,
      mean_recall: 0,
      mean_mrr: 0,
      mean_latency_ms: 0,
      skipped: true,
      reason: rerankerSkipReason ?? embedSkipReason
    });
  }

  // Render + write.
  process.stderr.write("\n");
  process.stdout.write(`${renderTable(rows)}\n`);

  // Compute per-category NDCG breakdowns and strip per_query before write so
  // the JSON stays bounded (per_query alone would balloon to a few thousand
  // rows for a 60-query × 8-stack run).
  const rowsForJson = rows.map((r) => {
    const cats = byCategory(r, queries);
    const { per_query, ...rest } = r;
    return { ...rest, ndcg_by_category: cats };
  });

  // Write JSON for downstream consumption.
  const outDir = path.join(projectRoot, "bench");
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "benchmarks.json");
  await fs.writeFile(outFile, JSON.stringify({ meta, rows: rowsForJson }, null, 2));
  process.stderr.write(`bench: wrote ${outFile}\n`);

  // Cleanup.
  ftsIndex.close();
  await fs.rm(vaultRoot, { recursive: true, force: true });
  await fs.rm(tmpIndexDir, { recursive: true, force: true });
}

main().catch((err) => {
  process.stderr.write(`bench failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
