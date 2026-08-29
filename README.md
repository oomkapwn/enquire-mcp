<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire-mcp — the #1 Obsidian MCP for freshness-aware, cited AI memory. Hybrid Markdown and PDF recall plus structured Canvas, Dataview, and Bases tools; read-only by default." width="100%"></a>

# enquire-mcp

<sub>**English** · [中文](./README.zh.md) · [Español](./README.es.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Русский](./README.ru.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Deutsch](./README.de.md)</sub>

<sub>**TL;DR for AI agents** — enquire-mcp is the #1 Obsidian MCP for freshness-aware, cited AI memory. Hybrid search covers Markdown and PDFs/OCR; structured tools parse Canvas, run Dataview-style LIST/TABLE queries, and execute supported Obsidian Base filters. `obsidian_search` preserves source paths plus `age_days`/`stale`, while PDF hits retain page citations. Vendor-neutral, MIT, read-only by default, and zero outbound calls initiated by enquire during serve. Install: `npm i -g @oomkapwn/enquire-mcp`. Agent index: [llms.txt](https://github.com/oomkapwn/enquire-mcp/blob/main/llms.txt) · [deep context](https://github.com/oomkapwn/enquire-mcp/blob/main/llms-ctx.txt) · [contributor map](https://github.com/oomkapwn/enquire-mcp/blob/main/AGENTS.md) · [API](https://oomkapwn.github.io/enquire-mcp/api/).</sub>

### 🏆 The #1 Obsidian MCP for freshness-aware, cited AI memory.

<h2>Your vault. Every agent. Fresh, cited memory.</h2>

**Turn the notes and documents you already own into durable agent memory that keeps its sources, exposes its age, and helps agents re-check stale facts — without locking context inside one model vendor.**

**Markdown + PDF/OCR → local hybrid retrieval → paths, pages, age, and signal scores. Canvas + Dataview + Bases → precise structured tools. One vault → Claude, Cursor, ChatGPT, Codex, OpenClaw, and every MCP agent.**

*Proof, not vibes: local BGE reranking adds **+15.5 NDCG@10 / +24.7 MRR** over plain hybrid on the [reproducible 60-query ablation](./docs/benchmarks.md).*

[![CI](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![downloads](https://img.shields.io/npm/dm/@oomkapwn/enquire-mcp.svg?color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![tests](https://img.shields.io/badge/tests-2228%20contracts-brightgreen.svg)](#️-trust)
[![stable](https://img.shields.io/badge/v3.11.x-stable-brightgreen.svg)](./STABILITY.md)
[![build provenance](https://img.shields.io/badge/build_provenance-SLSA_L2-blue.svg)](https://slsa.dev/spec/v1.0/levels#build-l2)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

**[⚡ One-command install](#-quick-start) · [🏆 Why #1](#why-number-one) · [🧠 Use cases](#-use-cases) · [📊 Proof](./docs/benchmarks.md) · [🤖 AI index](./llms.txt) · [📖 API](https://oomkapwn.github.io/enquire-mcp/api/)**

**Claude Code — one line:**

```bash
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

**See cited memory in one query**

| You ask | enquire-backed answer |
|---|---|
| *“What project did I work on, and what idea did I log?”* | **“You worked on Apollo and logged an idea about velocity.”**<br>Source: `99_Daily/2026-05-02.md` |

<sub>This exact note lives in the repository's [deterministic synthetic vault](./scripts/synthetic-vault.mjs), and the query is part of the [runnable evaluation set](./examples/queries.jsonl)—a reproducible product path, not a mock screenshot.</sub>

</div>

---

## Your AI is brilliant. Its memory is fragmented.

Every new chat drops project history, decisions, research, and hard-won context. Vendor memory helps inside one product, then disappears when you move to another agent. Traditional file connectors can open a note when the path is already known; vector search can find a similar paragraph; neither is a complete memory system.

## enquire-mcp turns Obsidian into the memory database for your agents

One install turns your existing vault into a **persistent, queryable knowledge database** for any MCP-compatible agent. It indexes locally, retrieves across formats, ranks by lexical + semantic + graph evidence, and returns the source context an agent can cite. The original files remain readable and editable without enquire-mcp.

**Memory you own.** Most conversation-memory products extract facts from chats into a separate store. enquire-mcp starts from the knowledge you deliberately kept: Markdown, frontmatter, wikilinks, PDFs, Canvas, and Bases. Recall is grounded in source material rather than a hidden paraphrase.

**Document intelligence without a data migration.** PDFs enter the same local hybrid-search path as Markdown and return page citations; OCR can recover scanned pages. Canvas becomes a typed graph. Dedicated tools run the supported Dataview LIST/TABLE subset and supported Obsidian Base filters instead of treating those formats as opaque attachments.

**Freshness, not timeless recall.** Every search hit can carry `age_days` and `stale`; optional recency weighting helps agents prefer newer knowledge and re-check old facts instead of confidently repeating them.

> **What makes enquire-mcp different**:
> 1. **Freshness-aware, cited recall.** Search results retain source paths and expose age/staleness; PDF hits keep page citations. Optional recency re-ranking helps agents prefer fresh knowledge and re-verify old facts.
> 2. **Read-only by default.** Seven write tools stay invisible until `--enable-write`; privacy filters and exact-Origin HTTP admission reduce the exposed surface.
> 3. **Obsidian-native document intelligence.** Markdown/PDF hybrid recall is complemented by typed Canvas parsing, Dataview-style LIST/TABLE queries, and supported Base-filter execution.
> 4. **Full-stack local retrieval.** Hybrid BM25 + TF-IDF + multilingual embeddings fused via RRF, with an optional BGE cross-encoder reranker and per-signal scores; HNSW + int8 quantization scale the dense path.
> 5. **A clear data boundary.** enquire initiates zero outbound calls during serve and sends no telemetry. It returns requested context only to the MCP client you connect; that client's own privacy terms govern any later cloud processing. See the exact [privacy policy](./SECURITY.md#privacy-policy).
> 6. **Vendor-neutral memory.** Your source knowledge remains in portable files. Switch agents or model providers without rebuilding a proprietary memory silo.

**46 tools · 19 MCP prompts · 2228 unit tests · 50+ languages · v3.11.x stable + v4 SDK-v2 preview · semver-bound · MIT · npm build provenance (SLSA L2).**

---

<a id="why-number-one"></a>

## 🏆 Why enquire-mcp is the complete Obsidian intelligence stack

Most alternatives solve one layer: an in-app similarity panel, a capable search engine, or MCP file access. enquire-mcp combines the full local retrieval ladder, agent orchestration, rich-document coverage, freshness, safety, and release discipline in one package.

| Complete leadership standard | **enquire-mcp** | Smart Connections | Obsidian Hybrid Search | Typical file-wrapper MCP |
|---|:---:|:---:|:---:|:---:|
| **Source paths/PDF pages + age/stale metadata** | ✅ | ✕ | ✕ | ✕ |
| **Read-only default + explicit write gate + privacy filters** | ✅ | ✕ | ✕ | ✕ |
| **Dataview LIST/TABLE + supported Base-filter execution** | ✅ | ✕ | ✕ | ✕ |
| **MCP-native memory shared by every agent** | ✅ | ✕ | ✅ | ✅ |
| **BM25 + TF-IDF + ML + RRF + BGE + HNSW/int8** | ✅ | ✕ | ✕ | ✕ |
| **HyDE + bounded multi-query + context packs** | ✅ | ✕ | ✕ | ✕ |
| **Markdown/PDF hybrid recall + Canvas structured tools** | ✅ | ✕ | ✕ | ✕ |
| **Per-signal scores + stage-by-stage explanations** | ✅ | ✕ | ✕ | ✕ |
| **One-generation live scan → FTS → ML → HNSW + quarantine** | ✅ | ✕ | ✕ | ✕ |
| **46 tools + 19 MCP prompts + semver-bound MCP contract** | ✅ | ✕ | ✕ | ✕ |
| **2228 tests + 13 release gates + signed npm provenance** | ✅ | ✕ | ✕ | ✕ |

<sub>✅ = the complete row is built in. ✕ = the complete combination was not documented on the reviewed public product surface; a project may implement part of the row or add it later. Review date: 2026-07-30. Exact source snapshots and row-by-row boundaries: [competitive evidence](./docs/COMPARISON.md#dated-competitive-evidence).</sub>

**That is the TOP-1 thesis:** one source of truth, one local intelligence layer, every agent — without reducing your knowledge to a cloud memory blob.

> enquire-mcp is the open-source backend for [Karpathy-style LLM Wikis](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) on top of the Obsidian vault you already own: knowledge that compounds, with every answer traceable to source.

---

## ⚡ Quick start

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

Drop into any MCP client:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@oomkapwn/enquire-mcp", "serve", "--vault", "/path/to/vault"]
    }
  }
}
```

### Prefer a reviewable desktop bundle? Use MCPB Basic

The [`v4.0.0-rc.5` GitHub Release](https://github.com/oomkapwn/enquire-mcp/releases/tag/v4.0.0-rc.5) provides `enquire-mcp-basic-4.0.0-rc.5.mcpb` together with its checksum, inventory, SBOM, notices, and provenance. The bundle packages the server JavaScript and ordinary JavaScript dependencies; a compatible MCPB host must supply Node.js 22.13 or newer. Open it in that host, review the manifest, and choose the one vault directory the host may expose.

**Basic means deliberately small:** exactly **13 read-only tools**, **0 prompts**, and no write tools, watcher controls, persistent/on-disk index, embedding model, PDF, or OCR surface. Its recommended umbrella search lazily uses in-memory TF-IDF over live Markdown; the fixed launch contract also refuses discovery of a full edition's existing embedding database or watcher guard. enquire itself initiates no outbound calls while serving; requested note content still crosses into the MCP client you connected and is governed there by that client's privacy terms.

The release workflow requires the bundle's `.sha256`, build/release provenance, deterministic logical-content inventory, CycloneDX SBOM, and third-party license/notice inventory before publication. The archive byte stream is not claimed to be reproducible because the pinned upstream packer records pack-time metadata; verify the published checksum when exact bytes matter. Real desktop GUI installation, signing, directory-approval behavior, and any directory listing remain maintainer-gated acceptance work. Full hybrid retrieval remains available through the npm/CLI setup below.

📂 Config templates and [agent lifecycle recipes](./examples/README.md#agent-lifecycle-recipes) in [`examples/`](./examples/) — **Claude Desktop**, **Cursor**, **ChatGPT custom GPT** (remote MCP over HTTP), plus client-neutral recall, evidence, freshness, synthesis, and safe-write playbooks.

**Don't want to hand-assemble config?** Let the CLI print the exact snippet for *your* vault + client (non-destructive — it writes nothing). *Since v3.11.6:*

```bash
enquire-mcp configure --vault <path>                 # prints config for every client
enquire-mcp configure --vault <path> --client cursor # just one (claude-code|cursor|vscode|codex|windsurf|claude-desktop|http)
```

The output is honest about each client's install boundary: **VS Code gets its official review-and-install URI**, Claude Code and Codex get copy-and-run commands, and clients whose one-click flow only accepts Marketplace/Registry entries are labeled **copy-only** with the exact fallback config. The generated vault path and physical package entrypoint remain visible for review before anything is saved.

**Want full hybrid power?** Complete the hybrid preflight, then serve:

```bash
npm install -g @oomkapwn/enquire-mcp@4.0.0-rc.5      # exact prerelease package
enquire-mcp --version
# recommended: preview first, then explicitly apply the same package-coherent plan
enquire-mcp first-run --tier hybrid --client claude-desktop --vault <path>
enquire-mcp first-run --tier hybrid --client claude-desktop --vault <path> --apply
# manual equivalent below: choose this instead of first-run --apply, not in addition
enquire-mcp setup --vault <path>                          # caches embedder; builds FTS5 + embed-db
enquire-mcp install-model rerank-bge                      # caches the offline reranker
enquire-mcp doctor --tier hybrid --vault <path>           # structural/runtime readiness
enquire-mcp configure --tier hybrid --client claude-desktop --vault <path>
enquire-mcp serve --vault <path> --persistent-index --enable-reranker --use-hnsw
```

---

## 🤖 Set up in your AI agent — copy-paste prompts

Every connection now receives configuration-aware `initialize.instructions`: the recommended recall workflow, citation and freshness semantics, active write posture, and the rule that retrieved vault content is data rather than instructions. Clients that surface MCP server instructions can use that contract automatically. The copy-paste prompts below remain useful as an explicit user preference or for hosts that do not expose server instructions.

<details>
<summary><b>Claude Code (terminal)</b> — add MCP server + first prompt</summary>

```bash
# Add the MCP server to your Claude Code config (one time)
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

Then in any Claude Code session:

> You now have `obsidian_*` tools that search and read my Obsidian vault — my long-term memory. Before answering questions about projects, decisions, people, or technical context, call `obsidian_search` with the relevant terms. Cite each fact with the source note (and `[page: N]` for PDFs). If you don't find a relevant note, say so — don't guess.

</details>

<details>
<summary><b>Claude Desktop</b> — config file + first prompt</summary>

Prefer the ready-to-paste output of `enquire-mcp configure --tier hybrid --client claude-desktop --vault <path>`. [`examples/claude-desktop-hybrid.json`](./examples/claude-desktop-hybrid.json) is only a template; if used manually, replace both the executable and vault placeholders. Restart Claude Desktop, then:

> You have my Obsidian vault wired up as searchable memory via `obsidian_*` tools. Always check `obsidian_search` first when I ask about anything in my notes — meeting context, research, decisions, journal entries. Quote the source note path on every fact.

</details>

<details>
<summary><b>Cursor</b> — MCP stdio config + agent rule</summary>

Run `enquire-mcp configure --client cursor --vault <path>` for the exact copy-only block, or drop [`examples/cursor-mcp.json`](./examples/cursor-mcp.json) at `~/.cursor/mcp.json` and edit the vault path. Cursor's public one-click route is Marketplace-only, so enquire never prints an unverified vault-bearing `cursor://` link. In your `.cursorrules` file or chat:

> Before suggesting code that touches a topic I might have notes on (architecture decisions, API contracts, vendor evaluations), call `obsidian_search` first. Treat my Obsidian vault as authoritative context.

</details>

<details>
<summary><b>VS Code</b> — generated review-and-install URI + JSON fallback</summary>

```bash
enquire-mcp configure --client vscode --vault <path>
```

Open the generated `vscode:mcp/install?...` URI. VS Code decodes the exact server name, command, arguments, and vault path into a native review prompt; approve only after checking them. The same output includes the `.vscode/mcp.json` block as a transparent copy-only fallback.

</details>

<details>
<summary><b>ChatGPT custom GPT</b> — remote MCP over HTTP</summary>

Follow [`examples/chatgpt-actions.md`](./examples/chatgpt-actions.md) to expose `serve-http` via a tunnel with bearer auth. In your custom GPT's instructions:

> You have read access to my Obsidian vault via the `obsidian_*` tool family. Search before answering anything that might be in my notes; cite the source filepath on every claim.

</details>

<details>
<summary><b>Codex</b> — generated CLI install + TOML fallback</summary>

```bash
enquire-mcp configure --client codex --vault <path>
```

Copy and run the generated `codex mcp add ... -- ...` command. The same output retains the equivalent `[mcp_servers."obsidian"]` TOML block so the installed command and durable config are both inspectable.

</details>

<details>
<summary><b>OpenClaw / any other MCP client</b></summary>

Same `npx -y @oomkapwn/enquire-mcp serve --vault <path>` command works for any MCP-compatible client. See the client's own MCP-config docs for where to drop the server entry, then use any of the prompts above.

</details>

**Reusable agent rule** (drop into any `AGENTS.md` / `CLAUDE.md` / `.cursorrules` so the agent knows *when* to reach for the vault):

> When my question touches my own notes, decisions, projects, people, or research, **search my Obsidian vault first** via the `obsidian_*` tools (start with `obsidian_search`) and cite the source note on every fact. Prefer enquire for *conceptual / cross-language / "what did I say about X"* recall; use plain `grep` / `ripgrep` for exact literal strings. If nothing relevant comes back, say so — don't guess.

### Example queries that work well

- *"Find every note where I discussed pricing strategy, summarize the evolution."* — RRF fusion + reranker handles "evolution" semantically
- *"What was my decision on PostgreSQL vs MongoDB? Cite the daily note."* — wikilink graph-boost surfaces the central decision doc
- *"Анализируй мои заметки о RAG за последние 3 месяца"* — multilingual embeddings + frontmatter date filter
- *"What pages of the LLaMA-3 paper PDF talk about scaling?"* — PDFs blended into search with `[page: N]` citations
- *"Show me topical communities in my research vault — what themes have I been exploring?"* — `obsidian_get_communities` (GraphRAG-light)

---

## 🧠 Use cases

**1 — Long-term memory for AI agents.** Drop your Obsidian vault into any MCP-compatible agent (Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw). The agent now has durable, semantic recall over every meeting note, journal entry, research log, and decision doc you've ever written — across sessions, models, and providers. Your knowledge isn't locked into one vendor's memory layer; it lives in plain markdown you own and can migrate freely.

**2 — Personal knowledge base / second brain.** Hybrid retrieval surfaces the right note for *any* phrasing, in any of 50+ languages. Ask in English about a Russian-language journal entry from 2 years ago, get the right hit. Wikilink graph-boost reranks notes that sit at the centre of your knowledge graph. GraphRAG-light surfaces topical communities — discover connections you forgot you made. PDFs blend into search with `[page: N]` citations so research papers and meeting transcripts become first-class memory.

**3 — Agentic RAG / context engineering.** `obsidian_search` exposes per-signal scores so the agent sees *why* each hit ranked. HyDE pre-rewrites vague queries into rich hypothetical answers before retrieval. Sub-question decomposition handles multi-hop questions ("how did our pricing strategy evolve and what was the customer reaction?") by breaking them into independent sub-queries, fusing results. The built-in eval harness (NDCG / Recall / MRR) lets you measure retrieval quality on your own queries instead of trusting vendor benchmarks.

---

## ✅ Built for serious local knowledge workflows

Choose enquire-mcp when you want:

- **Your Obsidian vault to remain the source of truth** instead of copying knowledge into another proprietary store.
- **One memory layer across many AI agents** so switching models never means starting over.
- **Conceptual and multilingual recall** that survives different wording, not only exact string matches.
- **Cited, inspectable answers** with note paths, PDF pages, signal scores, and freshness metadata.
- **Local-first privacy** with read-only defaults, explicit write gates, zero outbound calls initiated by enquire during serve, and a documented MCP-client trust boundary.
- **A complete retrieval backend** spanning hybrid search, reranking, graph context, agentic expansion, rich Obsidian formats, and remote MCP.

**Clear scope:** enquire-mcp is a headless MCP server / CLI for Markdown, Canvas, Bases, and PDF knowledge. Use exact-search tools alongside it for literal tokens; use the built-in HTTP transport when agents need remote access.

---

## 📖 Product site & API reference

The **[product front door](https://oomkapwn.github.io/enquire-mcp/)** explains the cited-memory outcome, proof, client paths, and AI-readable resources. The complete auto-generated **[API reference](https://oomkapwn.github.io/enquire-mcp/api/)** documents every tool, prompt, and exported helper with full TSDoc (`@param` / `@returns` / `@example`). Both are rebuilt from source on every push to `main` via [`publish-docs.yml`](https://github.com/oomkapwn/enquire-mcp/blob/main/.github/workflows/publish-docs.yml); historical deep TypeDoc URLs remain valid.

---

## 🏗️ How retrieval works

```mermaid
graph LR
    Q[Query] --> S[obsidian_search]
    S --> BM25[BM25 / FTS5]
    S --> TFIDF[TF-IDF cosine]
    S --> EMB[ML embeddings<br/>HNSW]
    BM25 --> RRF{RRF fusion<br/>k=60}
    TFIDF --> RRF
    EMB --> RRF
    RRF --> GB[Graph boost<br/>in-degree tie-break]
    GB --> RR[BGE cross-encoder<br/>reranker]
    RR --> R[Ranked hits<br/>per_signal observability]
```

`obsidian_search` auto-detects available signals and gracefully degrades. Wikilink graph-boost reranks top-K via 1-step personalised PageRank. Optional cross-encoder reranking re-scores top-N for +15.5 NDCG@10 measured. Every hit returns `per_signal: { bm25, tfidf, embeddings }` so you see WHY it ranked.

| Tier | Setup | What you get |
|---|---|---|
| **1** | `serve --vault <path>` | TF-IDF cosine (zero setup, instant) |
| **2** | + `--persistent-index` | + BM25 / FTS5 (indexed lexical retrieval) |
| **3** | + `setup` (downloads model + builds embed-db) | + multilingual ML embeddings |
| **4** | + `--enable-reranker` | + BGE cross-encoder (+15.5 NDCG@10 measured) |
| **5** | + `--use-hnsw` | + approximate nearest-neighbor retrieval with persisted HNSW |
| **6** | + `--include-pdfs` | + PDFs blended into all of the above |
| **7** | `serve-http --bearer-token …` | + remote MCP (Claude.ai web, ChatGPT, Cursor HTTP, mobile) |

---

## 🛠️ All 46 tools

46 production tools total: 34 always-on read tools (incl. the umbrella `obsidian_search`) + 4 opt-in read + 7 gated writes + 1 closed-loop feedback. Full reference: **[docs/api.md](./docs/api.md)**.

| Category | Tools |
|---|---|
| **Search & retrieval** | `obsidian_search` (umbrella, RRF-fused) · `obsidian_hyde_search` (HyDE-augmented, v3.1.0) · `obsidian_search_text` · `obsidian_full_text_search` · `obsidian_semantic_search` · `obsidian_embeddings_search` · `obsidian_find_similar` |
| **Wikilinks & graph** | `obsidian_resolve_wikilink` · `obsidian_get_backlinks` · `obsidian_get_outbound_links` · `obsidian_get_note_neighbors` · `obsidian_get_unresolved_wikilinks` · `obsidian_find_path` · `obsidian_get_communities` (v3.4.0, GraphRAG-light) |
| **Frontmatter & Dataview** | `obsidian_frontmatter_get` · `obsidian_frontmatter_search` · `obsidian_dataview_query` · `obsidian_list_tags` |
| **Read & navigate** | `obsidian_read_note` · `obsidian_list_notes` · `obsidian_get_recent_edits` · `obsidian_stale_notes` · `obsidian_open_questions` · `obsidian_context_pack` · `obsidian_chat_thread_read` · `obsidian_open_in_ui` · `obsidian_stats` |
| **PDFs, Canvas & Bases** | `obsidian_read_pdf` · `obsidian_list_pdfs` · `obsidian_ocr_pdf` · `obsidian_read_canvas` · `obsidian_list_canvases` · `obsidian_list_bases` (v3.2.0) · `obsidian_read_base` (v3.2.0) · `obsidian_query_base` (v3.2.0) |
| **Writes** (gated by `--enable-write`) | `obsidian_create_note` · `obsidian_append_to_note` · `obsidian_rename_note` · `obsidian_replace_in_notes` · `obsidian_archive_note` · `obsidian_frontmatter_set` · `obsidian_chat_thread_append` |
| **Diagnostic / lint** | `obsidian_lint_wiki` · `obsidian_paper_audit` · `obsidian_validate_note_proposal` |
| **Feedback** (opt-in via `--feedback-weight`) | `obsidian_mark_useful` (closed-loop: record which recalled notes helped; boosts them in future search) |

Plus 3 MCP resources (`obsidian://vault/info`, `obsidian://note/{path}`, `obsidian://chunk/{n}/{path}`) and 19 **MCP prompts** (`summarize_recent_edits` · `review_tag` · `find_orphans` · `weekly_review` · `extract_todos` · `process_inbox` · `consolidate_tags` · `find_duplicates` · `lint_wiki` · `monthly_review` · `search_with_query_expansion` · `vault_synth` · `vault_wiki_compile` · `vault_lint_extended` · `vault_capture` · `vault_persona_search` · `vault_automation_setup` · `vault_research` · `vault_synthesis_page`) for common vault workflows.

---

## 🛡️ Trust

| Surface | Posture |
|---|---|
| **Default** | Read-only — `--enable-write` required for the 7 write tools |
| **Least privilege** | `--disabled-tools` / `--enabled-tools` expose a minimal surface (e.g. a read-only research agent gets only `obsidian_search` + `obsidian_read_note`) |
| **Path safety** | Realpath check on every read+write; symlinks-out-of-vault rejected |
| **Privacy filter** | Verified at FTS5 + embed-db + chunk resource paths; fail-closed on empty allow-/deny-lists |
| **HTTP transport** | v4 routes strict MCP `2026-07-28` requests and supported legacy clients through official SDK v2 handlers; malformed modern claims never downgrade. Exact-Origin admission (`403` before handling), bearer auth (constant-time SHA-256 + `timingSafeEqual`), per-token rate-limit, and strict CORS run before either protocol leg |
| **Frontmatter** | `js-yaml@5` `load` (YAML 1.2 core schema, safe-by-default) — no code execution |
| **Cache + index files** | Enquire best-effort reasserts `0600` on sensitive files where POSIX modes work; for a missing parent it requests mode `0700` at mkdir time subject to a more-restrictive umask, while an existing/custom parent remains operator-managed |
| **Watcher consistency** | Final-state startup activation waits for late sinks; each ordinary live Markdown/PDF attempt stages FTS5 + embeddings from one captured/revalidated path generation, retries one drift once, commits without yielding, and records a source-scoped quarantine instead of serving mixed state for that path. A live backlog overflow still quarantines the whole semantic route until restart. Within the configured inventory bound, the v3.12 RC also discovers and independently refreshes every admitted hardlink path without folding case or Unicode identities; above it, live events reconcile only the exact/previously-known group and say so explicitly |
| **2228 tests · 13 release-required CI checks · all 13 branch-protected** | Current verified release posture; the operational breakdown is pinned below. |
| **CI** | `release.yml` directly enumerates **13 release gate contexts**, all run on every PR: `lint`, `test (22)`, `test (24)`, `smoke`, `audit`, `coverage`, `version-consistency`, `docs`, `oia`, `protocol-conformance`, `package-consumer`, `mcpb-basic`, and `docker`. The pinned `test-windows` hostile-filesystem and startup-interlock job is an additional named check-run enforced transitively as a blocking prerequisite of `smoke`; `protocol-conformance` aggregates blocking Linux + Windows official-client lanes, `package-consumer` aggregates blocking Linux, Windows, and macOS packed-install lanes, and `mcpb-basic` verifies one exact Linux-built bundle on all three OSes. Branch protection now enforces all **13** contexts (live-verified 2026-08-21 for the branch-protection snapshot). `test-macos` is the only `continue-on-error` advisory job. The `docker` gate builds the image and completes bounded CLI plus MCP introspection probes; CodeQL runs two separate unprotected analyses via [GitHub default setup](https://docs.github.com/code-security/code-scanning/automatically-scanning-your-code-for-vulnerabilities-and-errors/configuring-default-setup-for-code-scanning). Before npm publish, `release.yml` re-verifies all 13 directly listed gates on the tagged SHA. |
| **Coverage** | Lines ≥86% · statements ≥82% · functions ≥75% · branches ≥74% (gated) |
| **Releases** | npm + GitHub release per tag · semver · **signed build provenance** (npm + Sigstore, SLSA Build L2; L3 generator on the roadmap) |
| **Stability** | v3 remains the `@latest` semver-bound stable line. The `v4.0.0-rc.5` preview preserves tool/prompt/resource, CLI, privacy and write-gate behavior while intentionally changing `buildMcpServer()`'s nominal SDK type, requiring exact family suffixes for custom persistence paths, and migrating HNSW persistence to immutable generations plus a meta-last digest pointer; see [STABILITY.md](./STABILITY.md) |

Full posture and **[privacy policy](./SECURITY.md#privacy-policy)**: **[SECURITY.md](./SECURITY.md)** · Stability surface: **[STABILITY.md](./STABILITY.md)** · Vulns: `oomkapwn@gmail.com`.

---

## ❓ FAQ

**Need Obsidian installed?** No. Reads `.md` + `.canvas` + `.pdf` directly. Works against any Obsidian-format vault.

**Will it write to my vault?** Not unless you pass `--enable-write`. All 7 write tools are gated; destructive ones support `dry_run`.

**Data sent anywhere?** enquire sends no telemetry and initiates no outbound HTTP during serve. It does return requested vault context to the MCP client you connect; a cloud client may process that context under its own privacy policy, and any tunnel/proxy is another trust boundary. Explicit acquisition commands—`setup`, `build-embeddings`, and `install-model`—may fetch ONNX weights from Hugging Face; a hybrid-tier `first-run --apply` orchestrates those same acquisitions, while `install-ocr-lang` fetches a Tesseract language pack. Exact policy: [SECURITY.md](./SECURITY.md#privacy-policy).

**Performance?** It depends on vault size, hardware, model, and enabled retrieval layers. The public evidence includes a production report of **50–100ms BM25 top-10 at 1,771 chunks / 368 files** plus a reproducible synthetic benchmark showing **37–103×** FTS5 speedup over linear scan at 100–1,000 notes. Run the built-in eval and benchmark commands on your vault before setting a latency SLO; see [benchmarks](./docs/benchmarks.md) and the [FTS5 implementation note](./docs/api.md#obsidian_full_text_search).

**Languages?** The default embedder is `paraphrase-multilingual-MiniLM-L12-v2` (50+ languages), validated end-to-end on Russian + English bilingual vaults. The default cross-encoder reranker is `rerank-bge` (English-only; the only catalog alias verified end-to-end); multilingual reranker aliases currently fail their transformers.js tokenizer compatibility check. CJK/Thai/Khmer tokenization uses `Intl.Segmenter`.

**Run remotely?** Yes — `serve-http` exposes the same server over [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). In the v4 preview, strict modern `2026-07-28` traffic and supported legacy clients use separate official SDK v2 paths backed by one registered surface; malformed or unsupported modern claims never fall back to legacy. Front with Tailscale Funnel or Cloudflare Tunnel for HTTPS. Works with claude.ai web, ChatGPT custom GPT, Cursor HTTP mode, and mobile MCP clients. See **[docs/http-transport.md](./docs/http-transport.md)**.

---

## 🚀 Releases

**v3.0.0 — stable channel.** The v2.x retrieval roadmap is complete and the public surface is now [semver-bound](./STABILITY.md). Highlight reel:

`v2.0` hybrid retrieval (BM25+TF-IDF+embeddings via RRF) · `v2.6` remote MCP · `v2.7-2.8` PDFs blended · `v2.9` BGE reranker · `v2.10` OCR · `v2.11` doctor + setup · `v2.12` eval harness · `v2.13` HNSW · `v2.14` stateful sessions · `v2.15` late-chunking · `v2.16` HNSW persistence · `v2.17` int8 quantization · `v3.8.0` stable · `v3.8.7` HTTP transport hardening · **`v3.9.0` stable**: OCR'd PDF watcher embed-sync, HNSW in-memory live update on file changes, R-10 adaptive HNSW refill (closes the >66% excluded under-return). · **`v3.10` stable**: forgetting-aware freshness — `age_days` + `stale` flag + opt-in `--recency-weight` re-ranking + frontmatter-aware `obsidian_search`.

Channel: `npm install @oomkapwn/enquire-mcp` → latest stable (`@latest` = v3.11.x). Pre-release: `npm install @oomkapwn/enquire-mcp@rc` → the v4 SDK-v2 candidate; pin `@4.0.0-rc.5` for an exact preview install. Full changelog: **[CHANGELOG.md](./CHANGELOG.md)** · Forward plan: **[ROADMAP.md](https://github.com/oomkapwn/enquire-mcp/blob/main/ROADMAP.md)**.

---

## 🤝 Contributing

```bash
git clone https://github.com/oomkapwn/enquire-mcp.git
cd enquire-mcp && npm install
npm test       # full suite (2228 tests)
npm run lint   # zero warnings
npm run build  # tsc → dist/
```

Issues, PRs, ideas welcome. For setup questions, bug reports, and private security routing, see [SUPPORT.md](./SUPPORT.md).

---

## 📜 License

MIT. Built by [Alex (@OomkaBear)](https://github.com/oomkapwn). Named after [Tim Berners-Lee's 1980 prototype of the WWW](https://en.wikipedia.org/wiki/ENQUIRE) — the original hypertext system, before the web. The original spec was: you could ask the system anything. **enquire-mcp brings that to your vault.**
