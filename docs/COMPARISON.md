# Why enquire-mcp is the #1 Obsidian MCP

**Your vault. Every agent. Fresh, cited memory.**

enquire-mcp turns the knowledge you already trust into a freshness-aware,
cited memory and document-intelligence backend for Claude, Cursor, ChatGPT,
Codex, OpenClaw, and every MCP-compatible agent. Hybrid retrieval covers
Markdown and PDFs/OCR; structured tools parse Canvas, run Dataview-style
LIST/TABLE queries, and execute supported Obsidian Base filters.

> **The category leader for people who want their own knowledge to compound
> across agents without moving it into a vendor cloud or rebuilding context
> for every new chat.**

[Install with one command](../README.md#-quick-start) ·
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
- **Lexical evidence plus optional meaning.** BM25 and TF-IDF require token
  overlap; multilingual embeddings add paraphrase and cross-language recall.
  Graph context and an optional BGE reranker join them in one retrieval path.
- **Freshness is visible.** Results expose note age and stale-state metadata;
  optional recency weighting can prefer newer knowledge.
- **Privacy is the default architecture.** enquire initiates zero outbound
  calls during serve, models run locally, reads can be path-filtered, and
  writes are disabled by default. The connected MCP client remains a separate
  trust boundary.

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
| **Source paths + PDF pages + `age_days`/`stale` + recency ranking** | ✅ | ✕ | ✕ | ✕ |
| **Markdown/PDF hybrid + Canvas + Dataview LIST/TABLE + Base filters** | ✅ | ✕ | ✕ | ✕ |
| **Per-signal scores + stage-by-stage explanations** | ✅ | ✕ | ✕ | ✕ |
| **Available-signal fallback + quarantine on uncertain semantic state** | ✅ | ✕ | ✕ | ✕ |
| **Read-only default + explicit write gate + privacy filters** | ✅ | ✕ | ✕ | ✕ |
| **46 tools + 19 MCP prompts + semver-bound MCP contract** | ✅ | ✕ | ✕ | ✕ |
| **2246 tests + 13 release gates + signed npm provenance** | ✅ | ✕ | ✕ | ✕ |

**Legend:** `✅` means the complete row is built in. `✕` means the complete
combination was not documented on the reviewed public product surface; it does
not claim that every sub-feature is absent.

### Dated competitive evidence

Reviewed and repinned **2026-07-30** against public README snapshots:

- **Smart Connections** at
  [`55bd2d66a318596b91996a61405f4172d6d1f001`](https://github.com/brianpetro/obsidian-smart-connections/tree/55bd2d66a318596b91996a61405f4172d6d1f001):
  a polished Obsidian-native local semantic-connections plugin with optional
  reranking and a Pro Bases integration; its reviewed surface is not a
  standalone MCP memory backend.
- **Obsidian Hybrid Search** at
  [`5f97a11850eaf196c0dc5a537b781091e03ba13f`](https://github.com/flowing-abyss/obsidian-hybrid-search/tree/5f97a11850eaf196c0dc5a537b781091e03ba13f):
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
[`7681b59ca6eab49c531bc7ae388af007907c98a1`](https://github.com/aliasunder/vault-cortex/tree/7681b59ca6eab49c531bc7ae388af007907c98a1).
It documents a credible standalone hybrid MCP, remote OAuth, structured memory,
write-back, prompts, and broad file reading. That makes it a serious adjacent
peer—not evidence against the matrix: the reviewed snapshot still does not
document the complete retrieval ladder, freshness contract, supported
Base-filter execution, stage explanations, or release-chain combination used
in the rows above.

The matrix is intentionally easy to re-audit: change a source snapshot or row
boundary and the evidence date must change with it. It is not a claim about
private branches, future releases, or unadvertised behavior.

## What the complete stack delivers

| What a serious AI-memory backend needs | What enquire-mcp delivers | Why it matters |
|---|---|---|
| **Knowledge ownership** | Plain Markdown remains the source of truth | No proprietary memory format or provider lock-in |
| **Conceptual recall** | Multilingual embeddings fused with BM25 + TF-IDF | Embeddings handle wording changes; the lexical legs require token overlap |
| **Precision on hard queries** | Optional BGE cross-encoder reranking | Measured **+15.5 NDCG@10 / +24.7 MRR** over plain hybrid in the published ablation |
| **Citable answers** | Source paths on search hits, PDF page markers, read-time line spans, and per-signal scores | Agents can show where grounded evidence came from |
| **Freshness-aware memory** | `age_days`, `stale`, and optional recency weighting | Old facts are visible instead of silently reused as current |
| **Document intelligence** | Hybrid Markdown/PDF recall with OCR, Canvas parsing, Dataview-style LIST/TABLE, and supported Base-filter execution | One backend covers the knowledge you actually keep |
| **Agentic retrieval** | HyDE, bounded subqueries, context packs, GraphRAG-light, and 19 MCP prompts | Complex questions get a repeatable operating path, not just a search result |
| **Local scale controls** | HNSW, int8 vectors, persistence, live watcher updates, and adaptive refill | Dense retrieval stays practical as a real vault grows |
| **Remote-agent readiness** | Streamable HTTP, exact-Origin admission, bearer auth, CORS, rate/session/connection bounds | The same vault can safely serve local and remote MCP clients |
| **Safe defaults** | Read-only by default, explicit write gate, privacy filters, dry-run support | Agents receive the minimum authority they need |
| **Release trust** | 13 release gates, signed npm provenance, semver contracts | Buyers can verify both behavior and package origin |

## Proof surface

These numbers are derived from the current repository and guarded by CI:

| Proof | Current public surface |
|---|---|
| Tool count | **46** |
| MCP prompt count | **19** |
| Test count (public) | **2246** |
| Release-required CI gates | **13** |
| Supported embedder languages | **50+** |
| Default write posture | **Off / read-only** |
| Outbound calls initiated by enquire during serve | **Zero** |
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
when the vault needs them. The umbrella `obsidian_search` path continues with
the retrieval signals that are available; direct diagnostic tools keep their
own explicit readiness errors.

### 3. Evidence an agent can cite

Search hits preserve their source paths and freshness metadata. PDF snippets
carry page markers, read surfaces can return line spans, and fused search
exposes `per_signal` evidence so the caller can inspect why a hit ranked.

### 4. Obsidian-native knowledge coverage

Wikilinks, backlinks, unresolved links, frontmatter, tags, Canvas parsing,
Dataview-style LIST/TABLE queries, supported Base-filter execution, daily
notes, PDFs/OCR, and graph communities are first-class data—not opaque
attachments around a generic vector store.

### 5. Workflows for real questions

Nineteen MCP prompts and dedicated tools cover research, synthesis, query
expansion, HyDE, sub-question decomposition, context packing, vault hygiene,
and GraphRAG-light discovery. The agent gets a repeatable operating model.

### 6. Local-first operations

enquire initiates zero outbound calls during serve after explicit model and OCR
asset installation. Persistent indexes, watch mode, HNSW sidecars, cache
diagnostics, health checks, and bounded HTTP resources make the system operable
instead of merely demonstrable. Returned context still crosses into the
connected MCP client, whose privacy policy and any tunnel are separate trust
boundaries.

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
- hybrid Markdown/PDF/OCR recall plus Canvas, Dataview LIST/TABLE, supported
  Base filters, and graph context in one server;
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

<!-- launch-kit:start -->
## Copy-ready launch and directory kit

This is prepared acquisition copy, not evidence that a listing has already
been submitted, accepted, or published. Keep `@oomkapwn/enquire-mcp@latest` in
public install instructions; prereleases are for evaluation, not the default
shown by directories. Do not add mutable tool, test, download, star, visitor,
or directory-size counts to copied listings—link to the live proof surfaces
instead.

### Canonical directory card

**Name**

`enquire-mcp`

**Listing title**

`enquire-mcp — Fresh, cited AI memory from your vault`

**Tagline**

`Fresh, cited AI memory from your Obsidian vault`

**Short description**

> The #1 Obsidian MCP for freshness-aware, cited AI memory—local-first and
> read-only by default.

**Long description**

> The #1 Obsidian MCP for freshness-aware, cited AI memory. enquire-mcp turns
> the Markdown and documents already in your Obsidian vault into persistent,
> queryable context for every MCP-compatible agent. Search results preserve
> source paths plus `age_days` and `stale` freshness signals; PDF snippets keep
> page markers so agents can cite evidence and re-check old facts. Optional
> local hybrid retrieval combines BM25, TF-IDF, multilingual embeddings, RRF,
> BGE reranking, and HNSW. Structured tools parse Canvas, run Dataview-style
> LIST/TABLE queries, and execute supported Base filters. The server is
> read-only by default; vault-note mutation tools remain hidden until
> `--enable-write`.
> enquire initiates no outbound HTTP during `serve`, while requested note or
> PDF content is returned to the connected MCP client, which remains a
> separate trust boundary. An optional usefulness-feedback sidecar is a
> separate local mutation enabled only through `--feedback-weight`.

**Identity and links**

- Repository: https://github.com/oomkapwn/enquire-mcp
- Package: https://www.npmjs.com/package/@oomkapwn/enquire-mcp
- Product page: https://oomkapwn.github.io/enquire-mcp/
- Documentation:
  https://github.com/oomkapwn/enquire-mcp/blob/main/docs/QUICKSTART.md
- Privacy policy:
  https://github.com/oomkapwn/enquire-mcp/blob/main/SECURITY.md#privacy-policy
- Support:
  https://github.com/oomkapwn/enquire-mcp/blob/main/SUPPORT.md
- License: MIT
- Transport: local stdio; optional user-hosted Streamable HTTP
- Suggested tags: `obsidian`, `ai-memory`, `agent-memory`,
  `freshness-aware-retrieval`, `cited-search`, `local-first`, `read-only`,
  `hybrid-search`, `dataview`, `document-intelligence`

### Install CTA

For a guided, review-before-save client configuration:

```bash
npm install -g @oomkapwn/enquire-mcp@latest
enquire-mcp configure --client claude-desktop --vault "/absolute/path/to/vault"
```

For a generic stdio MCP configuration:

```json
{
  "mcpServers": {
    "enquire": {
      "command": "npx",
      "args": ["-y", "@oomkapwn/enquire-mcp@latest", "serve", "--vault", "/absolute/path/to/vault"]
    }
  }
}
```

The vault path is required. The canonical shape keeps `serve` explicit for
readability and portability, although the CLI defaults to `serve` when the
subcommand is omitted; a configuration without `--vault` is not working.

### Privacy boundary for listings

> enquire runs on the machine where the user starts it. The project operates
> no hosted vault backend, account system, telemetry, or analytics collector.
> During `serve`, enquire initiates no outbound HTTP. It does return requested
> note and PDF content to the connected MCP client; cloud clients, tunnels,
> and proxies therefore remain separate trust boundaries. Installation and
> explicit setup commands may download packages, model weights, or OCR assets.
> Local cache, FTS5, embedding, and HNSW artifacts can contain vault-derived
> content. Vault-note mutations are disabled by default and require an
> explicit `--enable-write` opt-in. The optional usefulness-feedback sidecar
> is instead enabled by `--feedback-weight`; it stores the canonical absolute
> vault root plus relative path keys, counts, and ISO timestamps locally
> without storing note bodies or query text and without modifying vault notes.
> One narrow internal recovery sink also exists for enabled writes: after the
> original source/destination path passes `--read-paths` and
> `--exclude-glob`, incomplete rename compensation may preserve its exact raw bytes
> under hidden vault-local `.enquire-rollback/` even if that derived path
> misses those filters. MCP tools cannot read the snapshots; clear/prune commands do not remove
> them, so the operator must inspect/recover and purge them manually under the
> [security policy](../SECURITY.md).

### Proof links

- [Dated TOP-1 capability matrix and claim boundaries](https://github.com/oomkapwn/enquire-mcp/blob/main/docs/COMPARISON.md#the-top-1-capability-matrix)
- [Runnable synthetic-vault result](https://github.com/oomkapwn/enquire-mcp/blob/main/docs/COMPARISON.md#see-the-result-not-just-the-feature-list)
- [Retrieval methodology and ablation](https://github.com/oomkapwn/enquire-mcp/blob/main/docs/benchmarks.md)
- [Security and privacy model](https://github.com/oomkapwn/enquire-mcp/blob/main/SECURITY.md)
- [Release CI](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml)
- [Signed npm package](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)

### Copy-ready community launch

**Title**

`enquire-mcp: fresh, cited AI memory from your vault (local-first MCP)`

**Post**

> Hi — I'm the maintainer of enquire-mcp, an independent MIT-licensed MCP
> server and CLI for the notes and documents already in your vault. It
> connects the same source of truth to Claude, Cursor, ChatGPT, Codex, and
> other MCP-compatible agents instead of locking memory inside one chat
> product.
>
> I built it around a simple problem: finding a relevant note is not enough.
> An agent should also show where an answer came from and whether the source
> may be stale. enquire keeps note paths, PDF page markers, and
> `age_days`/`stale` metadata in retrieval results; optional recency weighting
> helps agents re-check old facts.
>
> Why I position it as the #1 Obsidian MCP for AI memory:
>
> - freshness-aware, cited recall instead of an opaque memory summary;
> - local hybrid retrieval across Markdown and PDFs/OCR;
> - typed Canvas tools, Dataview-style LIST/TABLE queries, and supported Base
>   filters;
> - read-only defaults, explicit write enablement, and path-level privacy
>   filters;
> - one user-owned vault shared across MCP-compatible agents.
>
> The measurable parts of that claim are linked to a dated capability matrix,
> a runnable synthetic-vault result, a disclosed retrieval ablation, release
> CI, and signed npm packages:
> https://github.com/oomkapwn/enquire-mcp/blob/main/docs/COMPARISON.md
>
> A minimal setup is:
>
> ```bash
> npm install -g @oomkapwn/enquire-mcp@latest
> enquire-mcp configure --client claude-desktop --vault "/absolute/path/to/vault"
> ```
>
> Basic use starts read-only without a model or index build. Hybrid retrieval,
> reranking, HNSW, PDFs, and OCR are optional layers.
>
> Privacy boundary: enquire initiates no outbound HTTP during `serve`, but the
> note or PDF content requested by a connected cloud client is returned to
> that client and is then governed by its privacy terms. Explicit hybrid/OCR
> setup can download assets, and local indexes may contain vault-derived
> content.
>
> enquire-mcp is independent software. It is not an Obsidian community plugin
> and is not affiliated with Obsidian.
>
> I'd especially value feedback on three things: whether freshness metadata
> changes how much you trust recalled facts, which client setup still feels
> too manual, and which Dataview or Base query shapes matter most in real
> vaults.
>
> Repository: https://github.com/oomkapwn/enquire-mcp
>
> Quickstart:
> https://github.com/oomkapwn/enquire-mcp/blob/main/docs/QUICKSTART.md

### Claim discipline for copied listings

- Keep `#1` as the deliberate category position and link it to the dated proof
  surface.
- Do not turn local-first processing into a promise that all requested context
  stays on-device; the connected client boundary must remain explicit.
- Do not turn supported Dataview and Base subsets into complete compatibility.
- Do not imply endorsement by Obsidian, Anthropic, or a marketplace.
- Do not describe a one-click route as shipped before its bundle or listing is
  accepted and independently verified.
- Do not publish uncited cross-project quality, latency, adoption, star,
  download, or directory-traffic claims.
- Do not use “no Local REST API required” as the headline differentiator.
- Say “every MCP-compatible agent” when making a compatibility statement.
<!-- launch-kit:end -->

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
