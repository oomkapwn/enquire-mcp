# enquire-mcp vs. other Obsidian MCP servers

**enquire-mcp is a long-term memory layer for AI agents, built on an Obsidian vault** — open-source, MCP-native and vendor-neutral. Its local retrieval stack combines BM25, TF-IDF and multilingual embeddings through RRF, then optionally applies a BGE cross-encoder; HNSW and int8 quantization keep the dense path practical as a vault grows. The source of truth remains the markdown you already wrote: results are verbatim, cited and editable in any text editor. The server is also freshness-aware: every hit reports note age and an opt-in recency weight can prefer newer knowledge.

That is one design, not an automatic winner. `obsidian-hybrid-search` now offers a similarly modern hybrid core plus a native Obsidian plugin and stronger public benchmark evidence; `cyanheads` exposes much more of a running Obsidian and now has a full HTTP/auth deployment surface; `mcpvault` is a smaller filesystem-first option with no model lifecycle; `basic-memory` is a two-way human/AI knowledge base with optional cloud sync. This maintainer-written comparison therefore focuses on **which workflow each project fits**, not feature-count scoring.

enquire-mcp claims are CI-pinned to the current tree. External claims were re-verified on **2026-07-24** against the commit-permalinks in [Evidence boundary](#evidence-boundary); `Not documented` means only that the capability was absent from those pinned public sources, not that it is impossible or will remain absent.

## Servers compared

| Short name    | Package / repo                                      | Primary shape                              |
|---------------|-----------------------------------------------------|--------------------------------------------|
| **enquire**   | `@oomkapwn/enquire-mcp` / `oomkapwn/enquire-mcp`    | Filesystem + local retrieval engine        |
| **OHS**       | `flowing-abyss/obsidian-hybrid-search`              | Filesystem + local/remote retrieval engine |
| **cyanheads** | `cyanheads/obsidian-mcp-server`                     | Live Obsidian via Local REST API           |
| **markus**    | `MarkusPfundstein/mcp-obsidian`                     | Thin Local REST API wrapper                |
| **mcpvault**  | `@bitbonsai/mcpvault` / `bitbonsai/mcpvault`        | Filesystem CRUD + lexical search           |

"Local REST API" servers talk to the **Obsidian Local REST API community plugin** running inside a live Obsidian desktop app. "Filesystem" servers read `.md` files directly from disk and do not need Obsidian to be running.

---

## TL;DR — feature matrix

The rows are grouped by buyer-visible outcomes: deployment, retrieval, document coverage, agent workflow and operational trust. A checkmark means the pinned source documents the capability; `Not documented` is deliberately narrower than `No`.

| Capability | enquire | OHS | cyanheads | markus | mcpvault |
|---|---|---|---|---|---|
| Primary backend | Filesystem + SQLite/HNSW | Filesystem + SQLite/`sqlite-vec` | Local REST API | Local REST API | Filesystem |
| Obsidian desktop must run | **No** | **No** (plugin optional) | **Yes** | **Yes** | **No** |
| Lexical retrieval | FTS5 BM25 + TF-IDF | FTS5 BM25 + fuzzy title/alias | Text/JSONLogic; optional Omnisearch BM25 | REST text search | Multi-word + BM25 rerank |
| Dense embeddings | Local multilingual | Local multilingual or OpenAI-compatible | Not documented | Not documented | Not documented |
| Multi-signal fusion | BM25 + TF-IDF + dense, RRF | BM25 + fuzzy + dense, RRF | Not documented | Not documented | Not documented |
| Cross-encoder reranker (BGE verified end-to-end) | Yes | Yes (`bge-reranker-v2-m3`) | Not documented | Not documented | Not documented |
| Dense index | HNSW, int8 vectors | `sqlite-vec` | n/a | n/a | n/a |
| Incremental watch/re-index | Yes | Yes | Obsidian/plugin owns state | Obsidian/plugin owns state | No index watcher documented |
| PDF retrieval | Text + page chunks | Not documented | Optional via Omnisearch + Text Extractor | Not documented | Not documented |
| OCR for scans/images | Tesseract | Not documented | Optional via Omnisearch + Text Extractor | Not documented | Not documented |
| Standalone `.base` query execution | Yes | Not documented | Not documented | Not documented | Not documented |
| Wikilink graph retrieval | Paths, neighbors, Louvain communities | Links/backlinks + BFS traversal | Outgoing links on read | Not documented | Wiki-link resolver |
| HyDE + sub-question workflows | Tools + MCP prompts | Not documented | Not documented | Not documented | Not documented |
| Streamable HTTP | Stateful + stateless | Shared long-lived service | Stateless | Not documented | Not documented |
| HTTP deployment controls | Bearer auth, CORS, rate/session/connection bounds | Host allowlist; app auth not documented | JWT/OAuth via framework | n/a | n/a |
| Live Obsidian commands / active file | No | Separate plugin UI; MCP tools are search/read/reindex/status | Opt-in command palette, active-file read, open-in-UI | Not documented | Not documented |
| Default inference path | Local after explicit model install; serve fails closed offline | Local by default; remote embeddings opt-in | n/a | n/a | n/a |
| Freshness-aware retrieval | Age/stale metadata + optional recency rerank | Not documented | Not documented | Not documented | Not documented |
| Public retrieval evidence | Reproducible synthetic 60-query ablation | Evergreen-notes + LongMemEval-S result JSON and reproduction | Not documented | Not documented | Not documented |
| Signed npm provenance documented | SLSA Build L2 | Not documented | Not documented | n/a (PyPI) | Not documented |
| Tool count | 46 | 4 | 14 | 7 | 16 in source† |
| MCP prompt count | 19 | 0 documented | 0 (empty registry) | 0 documented | 0 documented |
| License | MIT | MIT | Apache-2.0 | MIT | MIT |

Notes on the matrix:

- **Feature presence is not retrieval quality.** OHS and enquire both fuse lexical and dense signals and both offer a BGE reranker. Their published numbers use different corpora/protocols, so this document does not rank one above the other until an apples-to-apples run exists.
- **cyanheads changed category since the old snapshot.** Its current README documents a 14-entry tool table, three resources, Streamable HTTP, JWT/OAuth, active-file reads, command execution and optional Omnisearch/Text Extractor integration. The previous `Partial`/`No PDF` characterization was stale.
- **† mcpvault has an upstream count drift.** Its pinned README says 14 methods, while the pinned `createServer.ts` registers 16. The table reports the source inventory and does not treat the discrepancy as a product defect.
- **Counts describe review surface, not quality.** enquire-mcp's own tool/prompt counts are derived from the current manifests and CI-pinned. Alternative counts are point-in-time source inventories.
- **License is a deployment constraint, not a ranking.** The four direct alternatives shown here use permissive licenses; the adjacent `basic-memory` project discussed below is AGPL-3.0.

## Evidence boundary

External claims above were checked on 2026-07-24 against these immutable snapshots:

- **OHS:** [`README.md` at `c0922d9`](https://github.com/flowing-abyss/obsidian-hybrid-search/blob/c0922d955f5bf5abaad14a11cbb3e11303cd6036/README.md), including its linked [LongMemEval-S result JSON](https://github.com/flowing-abyss/obsidian-hybrid-search/blob/c0922d955f5bf5abaad14a11cbb3e11303cd6036/eval/results/longmemeval-s-no-rerank.json).
- **cyanheads:** [`README.md` at `9e9861b`](https://github.com/cyanheads/obsidian-mcp-server/blob/9e9861be17395e942ee7aac3b3607cf9dc4d97b2/README.md) and its empty [MCP prompt registry](https://github.com/cyanheads/obsidian-mcp-server/blob/9e9861be17395e942ee7aac3b3607cf9dc4d97b2/src/mcp-server/prompts/definitions/index.ts).
- **markus:** [`README.md` at `32285e9`](https://github.com/MarkusPfundstein/mcp-obsidian/blob/32285e9ac07049a8a23ea7d7903603a3e48a1bf7/README.md).
- **mcpvault:** [`README.md` at `313983b`](https://github.com/bitbonsai/mcpvault/blob/313983bffcfb8e2e6b6c4c9f977cf0bffdc9e8c6/README.md) plus the authoritative [`createServer.ts` tool inventory](https://github.com/bitbonsai/mcpvault/blob/313983bffcfb8e2e6b6c4c9f977cf0bffdc9e8c6/src/createServer.ts).
- **basic-memory (adjacent):** [`README.md` at `5d444f0`](https://github.com/basicmachines-co/basic-memory/blob/5d444f0974476645f904c1446998c0a938a6e7f7/README.md).

Moving project pages remain useful for discovery, but the permalinks above define what this snapshot actually claims.

---

## When to pick something other than enquire-mcp

This is the most important section. enquire-mcp is not the right server for every Obsidian + MCP workflow. Five cases where one of the alternatives is the better fit:

### Pick `flowing-abyss/obsidian-hybrid-search` if…

**Headline:** you want a focused search product whose CLI, MCP server and native Obsidian plugin share one retrieval engine.

Specific scenarios:

- **You want hybrid retrieval without a broad vault-automation surface.** OHS exposes a compact search/read/reindex/status MCP interface while still combining BM25, fuzzy title/alias matching and dense retrieval with RRF.

- **You want a native Obsidian search UI as well as MCP.** The companion plugin provides previews, similar notes, link discovery and graph views inside Obsidian. enquire-mcp is intentionally headless.

- **Published external retrieval evidence matters today.** OHS publishes inspectable Evergreen Notes and LongMemEval-S results, raw JSON and reproduction instructions. enquire-mcp publishes a reproducible internal ablation, but its apples-to-apples LongMemEval-S run remains pending.

- **You want to choose between local and OpenAI-compatible embeddings.** OHS defaults to a local multilingual model but also documents OpenRouter, Ollama, LM Studio and OpenAI-compatible endpoints. enquire-mcp keeps cloud embedding APIs outside its current product boundary.

- **Native `.gitignore` handling is important.** OHS respects root and nested `.gitignore` files by default. enquire-mcp uses explicit exclude globs instead.

Concrete example: "Use the same hybrid engine in an Obsidian search modal, a shell script and a four-tool MCP connector, then reproduce its public LongMemEval-S result." OHS is the cleaner fit.

### Pick `cyanheads/obsidian-mcp-server` if…

**Headline:** you want your agent to drive a live Obsidian, not just read its files.

Specific scenarios:

- **You need to invoke Obsidian commands from your agent** — palette commands, hotkeys, "Toggle Live Preview", "Open Graph View", any registered command id. enquire-mcp doesn't have this and probably won't; talking to a live Obsidian process is exactly what the Local REST API plugin is for.

- **Your agent needs to address the active note or open a result in the UI.** `obsidian_get_note` can target the active file and `obsidian_open_in_ui` can open a vault path. The pinned source does not document cursor/selection control, so this comparison does not claim it.

- **You want per-section / per-heading edits that respect Obsidian's parser** — cyanheads exposes section-level write operations that delegate to the REST plugin, which uses Obsidian's own parser. enquire-mcp's writes are text-level and don't reach into Obsidian's runtime AST.

- **You already run Obsidian as a daemon on the same machine as your agent** and the "needs Obsidian running" constraint is free for you. In that case the REST-backed model gives you more in-app surface area for roughly the same operational cost.

- **Your existing plugin stack already supplies search and extraction.** cyanheads can expose Omnisearch BM25 and, through Text Extractor, PDF/OCR coverage. That avoids a second model/index lifecycle while retaining the in-app plugin workflow.

- **You prefer framework-provided HTTP auth.** Its current deployment surface documents stateless Streamable HTTP plus JWT or OAuth, whereas enquire-mcp deliberately uses a simpler bearer-token boundary.

Concrete example: "Run a Templater command, read the now-active note and open the edited result in Obsidian." That's cyanheads territory, not enquire-mcp territory.

### Pick `MarkusPfundstein/mcp-obsidian` if…

**Headline:** you want a thin, auditable wrapper over the Local REST API plugin and nothing more.

Specific scenarios:

- **You want the smallest, most-auditable REST-backed MCP server** — markus is a more minimal subset of the Local REST API surface than cyanheads. Fewer tools, less to break, less to read before trusting.

- **You're already a power user of the Local REST API plugin** and you just want a thin MCP wrapper around the endpoints you already script against. markus is closer to a 1:1 mapping; cyanheads is closer to a curated agent-facing API.

- **You don't need MCP prompts, hybrid retrieval or PDF support** and prefer a deliberately small endpoint mapping.

- **You want a minimal Python implementation** — markus is written in Python, which is a different deployment story than the Node-based servers in this matrix. If your existing agent stack is Python, this may be the lowest-friction integration.

Concrete example: "Append a timestamped log line to today's daily note via the REST plugin's PATCH endpoint." Either markus or cyanheads will do that; markus does it with less code in the path.

### Pick `bitbonsai/mcpvault` if…

**Headline:** you want direct filesystem CRUD and lexical search without a model or vector-index lifecycle.

Specific scenarios:

- **You want useful vault operations with a small dependency footprint.** mcpvault covers reads, safe writes, patches, moves, metadata, tags, wiki-link resolution and BM25-reranked text search without ONNX, SQLite native bindings or OCR dependencies.

- **You do not want a background index.** Its lexical search walks the filesystem at query time; there is no embedding install, vector database or watcher-owned index to operate.

- **Your retrieval needs are lexical and your workflow is write-heavy.** For a modest vault where filenames, exact terms and tags are sufficient, a dense model and reranker add cost without necessarily adding value.

- **You already own retrieval elsewhere.** If an agent framework or external RAG service chooses the note, mcpvault can remain the filesystem adapter that fetches or updates it.

Concrete example: "Search exact project terms, patch frontmatter and move notes safely, with no model downloads or persistent index." mcpvault is the simpler fit.

### Pick `basic-memory` (basicmachines-co) if…

**Headline:** you want humans and agents to co-author a structured memory knowledge base, with optional cross-device cloud sync.

`basic-memory` is an adjacent category peer rather than an Obsidian-specific server. Its current product is local-first Markdown plus a knowledge graph, hybrid full-text/vector search, MCP tools, host-specific memory plugins and an optional hosted/team sync layer:

- **The write-back loop is the product.** Basic Memory is designed for humans and agents to create, edit and relate the same Markdown notes. Its Claude Code integration adds session briefings, pre-compaction checkpoints and explicit capture commands.

- **You need sync, mobile or team access.** The optional cloud product adds hosted storage, snapshots, mobile/web access and bidirectional local sync. enquire-mcp is single-user and leaves sync/backup to the vault owner.

- **You want a prescribed memory schema.** Observations and typed relations create a consistent agent-authored knowledge graph; schema infer/validate/diff tools help keep it coherent.

Choose enquire-mcp instead when an existing general-purpose Obsidian vault is already the source of truth and the hard problem is broad retrieval across Markdown, Bases and PDFs under a read-first, air-gap-safe runtime. The projects can also compose: Basic Memory can own deliberate conversational capture while enquire-mcp retrieves across the larger vault.

Concrete example: "Checkpoint every coding session into linked Markdown, sync it to my phone and let teammates continue the thread" is Basic Memory's grain; "search three years of mixed research notes and PDFs and cite the originals" is enquire-mcp's.

---

## When enquire-mcp **is** the right pick

Conversely, the scenarios where the trade-offs land in enquire-mcp's favor:

### 1. Large vault where retrieval quality is the bottleneck

**Symptom:** you ask the agent a conceptual question, and it gets a note that happens to contain one of your keywords but isn't actually the right note.

If a large or vocabulary-diverse vault has outgrown exact search, enquire's **BM25 + TF-IDF + dense embeddings → RRF → cross-encoder reranker** stack provides three independently inspectable signals, then a learned final pass. The BGE reranker measured +15.5 NDCG@10 / +24.7 MRR over plain hybrid in the project's 60-query ablation.

OHS is a credible direct alternative here: it also fuses lexical, fuzzy and dense retrieval and offers a BGE reranker. enquire's differentiators are the additional TF-IDF signal, HNSW/int8 path, broader document types and agentic retrieval surface — **not a claim of superior search quality**. The two projects need the pending shared-protocol benchmark before either can make that claim.

What enquire-mcp gives you, specifically:

- BM25 over an FTS5 inverted index (fast, lexical).
- TF-IDF over note bodies (also lexical, but different ranking surface).
- Dense multilingual embeddings via ONNX (semantic, 50+ languages).
- Reciprocal Rank Fusion across all three (Cormack et al, 2009).
- Optional BGE cross-encoder reranking on top (`rerank-bge`, the verified default — measured +15.5 NDCG@10 / +24.7 MRR; other catalog aliases are experimental).

### 2. You don't want Obsidian running as a daemon

If your agent runs on a server, CI worker or laptop where Obsidian should not stay open, the REST-backed servers are off the table. enquire-mcp, OHS and mcpvault all work directly from the filesystem; among the pinned sources, enquire alone documents **standalone `.base` query execution**, so the Bases DSL remains usable without Obsidian.

Why this matters in practice: if you've already invested in `.base` files as a structured-data layer on top of your vault, switching to a "no Obsidian needed" server usually means losing those queries. enquire-mcp re-implements the Bases query DSL natively.

### 3. Remote MCP / Streamable HTTP

If you want to host the MCP server somewhere other than the client machine — VPS, home server or another trusted box — enquire-mcp's Streamable HTTP transport includes:

- Bearer-token auth with optional rotation.
- Per-IP and per-session rate limiting.
- CORS allowlist (no wildcard origin by default).
- Connection caps + idle-timeout for stateful sessions.
- Health and readiness endpoints for behind-a-load-balancer deployment.

OHS also offers a shared long-lived Streamable HTTP service with Host-header protection, and cyanheads offers stateless HTTP with JWT/OAuth. Pick enquire when its stateful sessions, bearer-token simplicity and explicit rate/connection limits match the deployment; pick cyanheads when framework OAuth plus live-Obsidian operations matter; pick OHS for a focused shared search service. A remote cyanheads deployment also has a second upstream boundary — the Local REST API plugin — to secure.

### 4. PDFs and scanned documents in the vault

If your vault has research papers, scanned receipts, or screenshots of articles, enquire-mcp blends PDF chunks into the same hybrid-search hit list as markdown notes — with `[page: N]` markers for citation (v2.8+) — and runs Tesseract OCR on image-only / scanned PDFs via `obsidian_ocr_pdf` (v2.10+).

Among the pinned sources, enquire is the only server with a direct, first-party PDF indexing and Tesseract OCR path. cyanheads can expose PDF/OCR search indirectly when Omnisearch and Text Extractor are both installed; OHS, markus and mcpvault do not document PDF extraction. If a vault is document-heavy and should not depend on a running Obsidian plugin chain, this can be decisive.

### 5. Agentic retrieval workflows

If you're building an agent that does multi-hop research over a vault — sub-question decomposition, HyDE-style synthetic-answer retrieval (Gao et al, 2023), GraphRAG-style community-aware retrieval, "synthesize a wiki page from N notes" loops — enquire-mcp ships these as named MCP prompts and dedicated tools:

- `obsidian_hyde_search` — HyDE-augmented retrieval (agent supplies a synthetic answer, server embeds it).
- `vault_research` — sub-question decomposition prompt.
- `vault_synthesis_page` — Karpathy-style LLM-Wiki synthesis loop.
- Louvain community detection over the wikilink graph for GraphRAG-light context windows.

The alternatives expose tools but not curated agent-facing prompts. If your client supports MCP prompts (Claude Desktop, Claude Code, others), you can wire these workflows in without a custom orchestrator.

### 6. Supply-chain hygiene matters

enquire-mcp publishes **signed build provenance** with every release — npm artifacts carry a Sigstore-signed provenance attestation (via `npm publish --provenance` + GitHub OIDC), verifiable with `npm audit signatures` against the GitHub Actions build. This is **SLSA Build Level 2** (hosted builder + signed, non-forgeable-by-author provenance). Isolated-builder **Level 3** (via the `slsa-github-generator` reusable workflow) is on the roadmap. If your org's MCP install path requires verifying that the binary you got from npm was built from the commit it claims, that's available out of the box.

The alternatives' pinned public sources do not document equivalent signed package provenance. That is not proof that no artifact or workflow has it; it is a narrower statement about what a buyer can verify from the reviewed release documentation.

---

## Things enquire-mcp does **not** do (and probably won't)

Stated explicitly so the comparison is honest:

- **No live-Obsidian integration.** No palette commands, no hotkeys, no active-editor read/write, no plugin interop. This is a deliberate split — if you need that, run cyanheads alongside enquire (they don't conflict; one talks to disk, the other to the REST plugin).

- **No OpenAI-compatible embedding backend.** Embeddings are installed explicitly, then computed locally via ONNX; runtime paths fail closed offline. If you want OpenAI, OpenRouter, Ollama or LM Studio embeddings behind one compatible API, OHS already supports that choice.

- **No collaborative / multi-user write.** Writes are single-user, opt-in (`--enable-write`), and assume the human is the only writer. We're not building real-time CRDT sync.

- **No hosted sync, mobile app or team workspace.** enquire is a local single-user server. Basic Memory's cloud product is the clearer fit when cross-device sync and shared workspaces are requirements.

- **No Dataview parity.** enquire-mcp's `obsidian_dataview_query` supports a subset of Dataview's DQL. If you have a vault built around heavy Dataview JS, enquire will not run those queries verbatim. Use a REST-backed server in parallel for those.

- **No graph view rendering.** enquire-mcp can compute communities over the wikilink graph (Louvain) and expose them as data, but it does not render a graph view image. If you want a screenshot of the graph, that's an Obsidian-side operation.

---

## Picking guide — a 30-second decision tree

If you only have 30 seconds, walk this top to bottom and stop at the first match:

1. **Do you need Obsidian commands, the active note or open-in-UI?** → cyanheads.
2. **Do you want a thin Python wrapper while Obsidian is already running?** → markus.
3. **Do you want one focused hybrid engine across an Obsidian plugin, CLI and MCP — or public LongMemEval evidence today?** → OHS.
4. **Do you want model-free filesystem CRUD + lexical/BM25 search?** → mcpvault.
5. **Is two-way agent-authored memory plus sync/mobile/team access the core workflow?** → Basic Memory.
6. **Do you need read-first retrieval across Markdown + Bases + PDFs, agentic prompts, freshness controls or the documented stateful HTTP guardrails?** → enquire-mcp.

This is a rough heuristic, not a verdict. The "when to pick X" sections above are the actual decision surface.

---

## A note on benchmarks

enquire-mcp ships a reproducible 60-query ablation at [`docs/benchmarks.md`](./benchmarks.md), covering six full-set stack configurations plus two HyDE-subset rows on a deterministic synthetic vault. `npm run bench:retrieval` reproduces it; the measured headline is `rerank-bge` at **+24.7 MRR / +15.5 NDCG@10** over plain hybrid.

OHS now publishes stronger **external-dataset** evidence: an Evergreen Notes benchmark and a 470-query LongMemEval-S run, both with raw result JSON and reproduction instructions. Those numbers are not directly comparable to enquire's synthetic ablation because the corpora, relevance judgments, model choices and scope protocol differ. Until enquire's maintainer-gated OHS-protocol run is published, the honest conclusion is:

- choose OHS if public LongMemEval-S evidence is a gating requirement today;
- use enquire's ablation to inspect the marginal value of its own retrieval stages;
- for a product decision, run both on the same representative vault and golden set.

---

## Disclaimer

This document's enquire-mcp counts and own-product claims are CI-pinned where the repository can enforce them. Alternative claims are a dated, evidence-linked snapshot — not a live conformance test — and will drift. Before making a decision:

1. Compare the pinned [Evidence boundary](#evidence-boundary) with each project's current README and release notes.
2. Run each candidate against a sample of your own vault for an hour. Retrieval quality, in particular, is vault-specific and unreliable to compare from feature lists alone.
3. Check open issues for known bugs in the version you'd be installing.

Corrections to this document are welcome — open an issue or PR on [`oomkapwn/enquire-mcp`](https://github.com/oomkapwn/enquire-mcp). Specifically: if a row above understates an alternative's capabilities, that's a bug in this doc and we'd like to fix it.

— enquire-mcp maintainer
