# enquire-mcp vs. other Obsidian MCP servers

**enquire-mcp positions itself as a long-term memory layer for AI agents, built on an Obsidian vault** — open-source, MCP-native, vendor-neutral, with the strongest retrieval stack in the open-source Obsidian-MCP space (BM25 + TF-IDF + ML embeddings, RRF-fused, BGE cross-encoder reranked, HNSW + int8 quantized). Distinct from conversation-memory layers (mem0, Zep, Supermemory, Memobase), which *extract* facts from chat logs into a separate opaque store: enquire-mcp is **grounded** in the markdown you already wrote — recall is verbatim, cited, and editable in any text editor, never a lossy summary of a past conversation. (Equally distinct from multi-tenant *fleet*-memory platforms that store agent traffic server-side: enquire is single-user and local-first — one vault you own, with zero cloud calls during serve.) It is also **freshness-aware** (v3.10): every hit reports the note's age and an opt-in recency-weighting can prefer fresher knowledge — directly addressing the stale-fact-reuse gap (Memora benchmark, arXiv:2604.20006) that opaque memory stores leave unsolved. The alternatives below take different trade-offs — some are agent-first, some are Obsidian-plugin-first, some optimize for local-REST-API integration over hybrid retrieval. This document is a side-by-side feature matrix plus an honest "when to pick which" guide, written by the enquire-mcp maintainer. It is intentionally fair-not-sales: each alternative has scenarios where it is the better pick, and those scenarios are called out below. Numbers and feature claims for enquire-mcp are accurate as of v3.8.x stable (initial snapshot 2026-05-15 for v3.7.0; refreshed to v3.8.x in v3.8.2 docs patch); claims about the four alternatives are based on their public READMEs as of the same dates — please verify against their current state before deciding.

## Servers compared

| Short name      | Package / repo                                | Backend           |
|-----------------|-----------------------------------------------|-------------------|
| **enquire**     | `@oomkapwn/enquire-mcp` (oomkapwn/enquire-mcp) | Filesystem + ML   |
| **cyanheads**   | `cyanheads/obsidian-mcp-server`               | Local REST API    |
| **markus**      | `MarkusPfundstein/mcp-obsidian`               | Local REST API    |
| **stevens**     | `StevenStavrakis/obsidian-mcp`                | Filesystem        |
| **fs-only**     | `mcpvault` / similar minimal FS servers       | Filesystem        |

"Local REST API" servers talk to the **Obsidian Local REST API community plugin** running inside a live Obsidian desktop app. "Filesystem" servers read `.md` files directly from disk and do not need Obsidian to be running.

---

## TL;DR — feature matrix

The four axes the external audit (#3, 2026-05) called out as decisive — **REST vs FS, Obsidian-required-or-not, retrieval quality, remote-MCP support** — are the first four rows.

| Capability                                    | enquire             | cyanheads        | markus           | stevens          | fs-only          |
|-----------------------------------------------|---------------------|------------------|------------------|------------------|------------------|
| Backend (REST plugin vs. raw FS)              | FS                  | REST             | REST             | FS               | FS               |
| Obsidian desktop app must be running          | **No**              | Yes              | Yes              | No               | No               |
| Retrieval — BM25                              | Yes (FTS5 + RRF)    | REST-side text   | REST-side text   | Basic            | Basic            |
| Retrieval — TF-IDF                            | Yes                 | No               | No               | No               | No               |
| Retrieval — dense ML embeddings               | Yes (multilingual)  | No               | No               | No               | No               |
| Retrieval — RRF fusion of all three           | **Yes**             | No               | No               | No               | No               |
| Cross-encoder reranker (BGE verified end-to-end) | **Yes**             | No               | No               | No               | No               |
| HNSW vector index                             | Yes                 | n/a              | n/a              | n/a              | n/a              |
| int8 vector quantization                      | Yes                 | n/a              | n/a              | n/a              | n/a              |
| PDF indexing                                  | Yes (text + chunks) | No               | No               | No               | No               |
| OCR for scanned PDFs / images (Tesseract)     | Yes                 | No               | No               | No               | No               |
| `.base` files (Bases query DSL)               | Yes (standalone)    | Via Obsidian     | No               | No               | No               |
| GraphRAG-light (Louvain communities)          | Yes                 | No               | No               | No               | No               |
| HyDE search primitive                         | Yes                 | No               | No               | No               | No               |
| Agentic retrieval prompts (`vault_research`)  | Yes (19 prompts)    | No (prompts n/a) | No (prompts n/a) | No               | No               |
| Stateful Streamable HTTP transport            | Yes                 | Partial          | No               | No               | No               |
| Bearer auth + rate-limit + CORS for HTTP      | Yes                 | Partial          | No               | No               | No               |
| Invoke Obsidian palette commands / hotkeys    | **No**              | **Yes**          | Limited          | No               | No               |
| Read open editor state, active note, etc.     | **No**              | **Yes**          | Limited          | No               | No               |
| Zero outbound network calls in serve mode     | **Yes** (default)   | Local-only (REST)| Local-only (REST)| Yes              | Yes              |
| Signed build provenance on releases (SLSA L2) | **Yes**             | No               | No               | No               | No               |
| Forgetting-aware freshness (`age_days` / recency re-rank) | Yes (v3.10)     | No               | No               | No               | No               |
| Test count (public)                           | **1490**             | (varies)         | (varies)         | (varies)         | (varies)         |
| Tool count                                    | 46                  | ~25              | ~8               | ~10              | 3–5              |
| MCP prompt count                              | 19                  | 0                | 0                | 0                | 0                |
| License                                       | MIT                 | Apache-2.0       | MIT              | MIT              | (varies)         |

Notes on the matrix:

- **"n/a" in retrieval-internal rows** (HNSW, int8) means the server doesn't do ranked retrieval at all — it delegates to either the REST plugin's text endpoint or to Obsidian's built-in search. Comparing "no HNSW" to "no retrieval engine" would be misleading.

- **"Partial" for cyanheads' HTTP transport** reflects that the REST-backed model is bounded by what the Local REST API plugin exposes; a stateful long-lived HTTP MCP session is harder to ship cleanly when every call has to round-trip through Obsidian.

- **"Limited" for markus on Obsidian-side operations:** it covers a smaller subset of REST endpoints than cyanheads.

- **Tool counts for alternatives** are approximate from public READMEs and may have shifted. enquire-mcp's 46-tool count is exact as of the current release and is verified by `tests/docs-consistency.test.ts` against `src/tool-manifest.ts` (machine-readable single source of truth, introduced v3.6.0-rc.2).

- **License row** is informational, not a recommendation. MIT and Apache-2.0 are both permissive; pick what your org's policy requires.

- **"Yes" in the audit-priority rows** (first four) is the only column where bolded "Yes" / "No" is used — the audit explicitly asked for those to stand out.

---

## When to pick something other than enquire-mcp

This is the most important section. enquire-mcp is not the right server for every Obsidian + MCP workflow. Five cases where one of the alternatives is the better fit:

### Pick `cyanheads/obsidian-mcp-server` if…

**Headline:** you want your agent to drive a live Obsidian, not just read its files.

Specific scenarios:

- **You need to invoke Obsidian commands from your agent** — palette commands, hotkeys, "Toggle Live Preview", "Open Graph View", any registered command id. enquire-mcp doesn't have this and probably won't; talking to a live Obsidian process is exactly what the Local REST API plugin is for.

- **Your agent needs to read or write the active editor state** — current cursor position, selection, the note that's open in the focused pane. enquire-mcp is a filesystem reader and doesn't know what Obsidian is showing on screen.

- **You want per-section / per-heading edits that respect Obsidian's parser** — cyanheads exposes section-level write operations that delegate to the REST plugin, which uses Obsidian's own parser. enquire-mcp's writes are text-level and don't reach into Obsidian's runtime AST.

- **You already run Obsidian as a daemon on the same machine as your agent** and the "needs Obsidian running" constraint is free for you. In that case the REST-backed model gives you more in-app surface area for roughly the same operational cost.

- **You don't need ML retrieval** — if your vault is small enough that BM25 over the REST plugin is fast enough and ranks well enough, every extra primitive enquire-mcp ships (HNSW, reranker, GraphRAG) is unused complexity for your use case.

Concrete example: "Run the 'Templater: Insert template' command on the active note, then move the cursor to the first `{{cursor}}` marker." That's cyanheads territory, not enquire-mcp territory.

### Pick `MarkusPfundstein/mcp-obsidian` if…

**Headline:** you want a thin, auditable wrapper over the Local REST API plugin and nothing more.

Specific scenarios:

- **You want the smallest, most-auditable REST-backed MCP server** — markus is a more minimal subset of the Local REST API surface than cyanheads. Fewer tools, less to break, less to read before trusting.

- **You're already a power user of the Local REST API plugin** and you just want a thin MCP wrapper around the endpoints you already script against. markus is closer to a 1:1 mapping; cyanheads is closer to a curated agent-facing API.

- **You don't need MCP prompts, hybrid retrieval, or PDF support** and you'd rather have a 500-line server than a 50-file one.

- **You want a minimal Python implementation** — markus is written in Python, which is a different deployment story than the Node-based servers in this matrix. If your existing agent stack is Python, this may be the lowest-friction integration.

Concrete example: "Append a timestamped log line to today's daily note via the REST plugin's PATCH endpoint." Either markus or cyanheads will do that; markus does it with less code in the path.

### Pick `StevenStavrakis/obsidian-mcp` (or another FS-based simpler server) if…

**Headline:** you want filesystem semantics without an ML stack.

Specific scenarios:

- **You want filesystem semantics like enquire but without the ML dependency footprint** — no `install-model`, no HNSW file, no embeddings cache, no Tesseract. Trade retrieval quality for setup simplicity.

- **You're on a constrained machine** where the embedding + reranker models (a few hundred MB total) are a real cost. The smaller FS servers run in tens of MB resident; enquire-mcp's resident memory with a loaded reranker can sit in the hundreds of MB.

- **You only need shallow operations** — list, read, write, simple text search — and you don't want a server that auto-builds an index in the background.

- **You want a smaller surface for security review** — fewer tools is fewer code paths to threat-model. enquire-mcp's 46 tools + 19 prompts + Streamable HTTP transport is a real review effort; a 10-tool FS server is much smaller.

- **You're prototyping** and you'd rather not commit to a specific retrieval architecture this early. Swapping a simple FS server out later is easier than swapping enquire-mcp out — there's just less to migrate.

Concrete example: "On a 200-note vault, give the model `list_notes`, `read_note`, `write_note`, and `search_substring`. Done." That's stevens, not enquire-mcp.

### Pick `mcpvault` / a minimal FS-only server if…

**Headline:** you want a 3-tool adapter, not a server.

Specific scenarios:

- **You truly just need "let the model `cat` markdown files"** and you'll do retrieval in the model with raw text. For very small vaults or for agentic workflows that already do their own RAG, anything more is wasted.

- **You're embedding the MCP server inside a larger system** that already has retrieval and just wants Obsidian as one more file source. A trivial FS adapter is the right shape.

- **Reviewability beats features** — fewer than 1k lines of TypeScript is a different category of trust than a 20k-line server with native deps.

- **You're stitching together your own retrieval pipeline** in the agent layer (LangChain / LlamaIndex / a custom orchestrator), and Obsidian is just the document store. Don't fight the layer above — let the agent do retrieval and let the MCP server be a dumb pipe.

Concrete example: "I already have a pgvector-backed RAG index over my whole digital footprint, and the Obsidian vault is one input. I just need the model to fetch a note by path when it's relevant." mcpvault-class server, not enquire-mcp.

### Pick `basic-memory` (basicmachines-co) if…

**Headline:** you want the AI to *write* a memory knowledge-base **from your conversations** — not recall the notes you already authored.

`basic-memory` is the closest project in spirit (local-first, markdown, MCP-native, viewable in Obsidian as a GUI, semantic search over a wikilinked knowledge graph), but it solves the **inverse** problem, which makes the choice clean:

- **Your "memory" IS the AI dialogue.** basic-memory captures observations from chat sessions into linked markdown so you can "continue the conversation later with full context." If write-from-chat is the primary loop, that's its sweet spot. enquire-mcp is read-first: it indexes the markdown **you wrote**, so it shines when you already have a vault to recall from — not when memory should be generated from chat. (This is the "grounded, not extracted" line made concrete: basic-memory's notes are readable, but they're *extracted from conversations*; enquire recalls the notes you authored.)

- **You want bi-directional human↔LLM capture as the core workflow.** That's basic-memory's first-class path; enquire-mcp's writes are an opt-in `--enable-write` minority surface behind a deliberately read-first design.

- **You don't need the heavy retrieval stack.** A conversation-derived store rarely needs RRF-fused BM25 + multilingual embeddings + a cross-encoder reranker + HNSW; enquire-mcp is more retrieval machinery than that workflow calls for.

Concrete example: "After every Claude session, distill what we decided into linked notes I can browse in Obsidian" is basic-memory's grain; "search the three years of research notes I've already written and cite the relevant ones" is enquire-mcp's. **They compose** — let basic-memory *write* conversation-derived notes and let enquire-mcp *retrieve* across your whole authored vault.

---

## When enquire-mcp **is** the right pick

Conversely, the scenarios where the trade-offs land in enquire-mcp's favor:

### 1. Large vault where retrieval quality is the bottleneck

**Symptom:** you ask the agent a conceptual question, and it gets a note that happens to contain one of your keywords but isn't actually the right note.

If you have 5k+ notes and you've already noticed that simple grep / BM25 search returns wrong-but-keyword-matching results, the **BM25 + TF-IDF + dense-embeddings → RRF → cross-encoder reranker** stack is exactly what closes that gap. Measured +15.5 NDCG@10 / +24.7 MRR over single-ranker baselines (BGE reranker, 60-query ablation). None of the other four servers in the matrix does multi-signal fusion or reranking.

What enquire-mcp gives you, specifically:

- BM25 over an FTS5 inverted index (fast, lexical).
- TF-IDF over note bodies (also lexical, but different ranking surface).
- Dense multilingual embeddings via ONNX (semantic, 50+ languages).
- Reciprocal Rank Fusion across all three (Cormack et al, 2009).
- Optional BGE cross-encoder reranking on top, 5 model sizes available.

### 2. You don't want Obsidian running as a daemon

If your agent runs on a server, a CI worker, a remote dev box, a phone, or just a laptop where you don't want Obsidian eating memory all day — REST-backed servers are off the table. enquire-mcp, stevens, and the FS-only servers all work without Obsidian, but only enquire-mcp ships **standalone `.base` execution**, so you don't lose the Bases query DSL just because Obsidian isn't running.

Why this matters in practice: if you've already invested in `.base` files as a structured-data layer on top of your vault, switching to a "no Obsidian needed" server usually means losing those queries. enquire-mcp re-implements the Bases query DSL natively.

### 3. Remote MCP / Streamable HTTP

If you want to host the MCP server somewhere other than the client machine — VPS, home server, "MCP-as-a-service" for a small team — enquire-mcp's Streamable HTTP transport is built for that. See `docs/http-transport.md` for the full deployment surface; the headline features are:

- Bearer-token auth with optional rotation.
- Per-IP and per-session rate limiting.
- CORS allowlist (no wildcard origin by default).
- Connection caps + idle-timeout for stateful sessions.
- Health and readiness endpoints for behind-a-load-balancer deployment.

REST-backed servers can in principle be exposed remotely too, but you're then publishing two protocols (MCP + the REST plugin) and the REST plugin was designed for localhost.

### 4. PDFs and scanned documents in the vault

If your vault has research papers, scanned receipts, or screenshots of articles, enquire-mcp blends PDF chunks into the same hybrid-search hit list as markdown notes — with `[page: N]` markers for citation (v2.8+) — and runs Tesseract OCR on image-only / scanned PDFs via `obsidian_ocr_pdf` (v2.10+).

None of the four alternatives indexes PDFs. If you're a researcher whose vault is half PDFs, this is decisive on its own.

### 5. Agentic retrieval workflows

If you're building an agent that does multi-hop research over a vault — sub-question decomposition, HyDE-style synthetic-answer retrieval (Gao et al, 2023), GraphRAG-style community-aware retrieval, "synthesize a wiki page from N notes" loops — enquire-mcp ships these as named MCP prompts and dedicated tools:

- `obsidian_hyde_search` — HyDE-augmented retrieval (agent supplies a synthetic answer, server embeds it).
- `vault_research` — sub-question decomposition prompt.
- `vault_synthesis_page` — Karpathy-style LLM-Wiki synthesis loop.
- Louvain community detection over the wikilink graph for GraphRAG-light context windows.

The alternatives expose tools but not curated agent-facing prompts. If your client supports MCP prompts (Claude Desktop, Claude Code, others), you can wire these workflows in without a custom orchestrator.

### 6. Supply-chain hygiene matters

enquire-mcp publishes **signed build provenance** with every release — npm artifacts carry a Sigstore-signed provenance attestation (via `npm publish --provenance` + GitHub OIDC), verifiable with `npm audit signatures` against the GitHub Actions build. This is **SLSA Build Level 2** (hosted builder + signed, non-forgeable-by-author provenance). Isolated-builder **Level 3** (via the `slsa-github-generator` reusable workflow) is on the roadmap. If your org's MCP install path requires verifying that the binary you got from npm was built from the commit it claims, that's available out of the box.

None of the four alternatives currently ships SLSA provenance. For some users this is a hard "no" on installing anything else; for most it's a "nice to have".

---

## Things enquire-mcp does **not** do (and probably won't)

Stated explicitly so the comparison is honest:

- **No live-Obsidian integration.** No palette commands, no hotkeys, no active-editor read/write, no plugin interop. This is a deliberate split — if you need that, run cyanheads alongside enquire (they don't conflict; one talks to disk, the other to the REST plugin).

- **No cloud embedding APIs by default.** Embeddings are computed locally via ONNX after a one-time `install-model` from HuggingFace. There is no "use OpenAI embeddings" mode and there isn't one planned, because the privacy guarantee in serve mode is "zero outbound calls". If you want hosted embeddings, you want a different server.

- **No collaborative / multi-user write.** Writes are single-user, opt-in (`--enable-write`), and assume the human is the only writer. We're not building real-time CRDT sync.

- **No mobile-Obsidian-plugin sidecar.** The REST plugin path is what makes mobile-Obsidian addressable from an agent today; enquire is desktop-class.

- **No Dataview parity.** enquire-mcp's `obsidian_dataview_query` supports a subset of Dataview's DQL. If you have a vault built around heavy Dataview JS, enquire will not run those queries verbatim. Use a REST-backed server in parallel for those.

- **No graph view rendering.** enquire-mcp can compute communities over the wikilink graph (Louvain) and expose them as data, but it does not render a graph view image. If you want a screenshot of the graph, that's an Obsidian-side operation.

---

## Picking guide — a 30-second decision tree

If you only have 30 seconds, walk this top to bottom and stop at the first match:

1. **Do you need your agent to invoke Obsidian commands or read the active editor?** → cyanheads.
2. **Is Obsidian guaranteed to be running on the same box anyway, and you want a thin REST wrapper?** → markus.
3. **Is your vault under ~500 notes and retrieval quality is "fine"?** → stevens or fs-only.
4. **Do you already have your own RAG layer and just need "give the model file access"?** → fs-only.
5. **Anything else** — large vault, retrieval quality matters, PDFs, remote MCP, agentic workflows, supply-chain requirements — **→ enquire-mcp.**

This is a rough heuristic, not a verdict. The "when to pick X" sections above are the actual decision surface.

---

## A note on benchmarks

As of v3.6.0-rc.4, **enquire-mcp ships public, reproducible end-to-end retrieval benchmarks** at [`docs/benchmarks.md`](./benchmarks.md): a 60-query ablation across 8 stack configurations (6 on the full 60-query set + 2 HyDE-subset rows at n=25) on a deterministic synthetic Obsidian vault. Reproducible with `npm run bench:retrieval` (4-decimal precision across runs). Headline: `rerank-bge` adds **+24.7 MRR / +15.5 NDCG@10** over plain hybrid. The other alternatives in this matrix do not (as of 2026-05-15) ship comparable public benchmarks. If retrieval quality is decisive, **run our `bench:retrieval` against your own vault**, then run any equivalent eval (or hand-eval) the alternatives provide.

---

## Disclaimer

This is a snapshot as of **2026-05-24** (v3.8.x stable; initial v3.7.0 snapshot from 2026-05-15). All five servers are actively developed (or in some cases archived) and the feature matrix will drift. Before making a decision:

1. Re-read each alternative's current `README.md` — features land between matrix updates.
2. Run each candidate against a sample of your own vault for an hour. Retrieval quality, in particular, is vault-specific and unreliable to compare from feature lists alone.
3. Check open issues for known bugs in the version you'd be installing.

Corrections to this document are welcome — open an issue or PR on [`oomkapwn/enquire-mcp`](https://github.com/oomkapwn/enquire-mcp). Specifically: if a row above understates an alternative's capabilities, that's a bug in this doc and we'd like to fix it.

— enquire-mcp maintainer, v3.8.x stable
