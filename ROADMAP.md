# enquire-mcp — Roadmap

> Public roadmap for **enquire-mcp**, the long-term-memory MCP server backed by your local Obsidian vault. Updated 2026-05-29 after the pre-stable audit batches (rc.21 security · rc.25 ReDoS C-1 + fuzz · rc.26 test-infra + docs); the Tier-1 hardening sprint is complete and most Tier-1 items are checked below.
>
> **North Star:** be — and confidently *stay* — the best project in its spheres (Obsidian MCP; local-first AI-memory layer) on **technology** and **reliability**. "Confidently" means every claim we make is one an external auditor or a privacy-conscious user can verify against the code.

This is the *public* roadmap. Per-release detail lives in [`CHANGELOG.md`](./CHANGELOG.md); internal methodology + audit history lives in `CLAUDE.md`.

---

## Where we are (v3.11.x stable on `@latest`)

Already shipped and differentiating:

- **Full hybrid retrieval** — BM25 + TF-IDF + multilingual ML embeddings, RRF-fused, with optional BGE cross-encoder reranking (**+15.5 NDCG@10 / +24.7 MRR** measured on a 60-query ablation).
- **HNSW vector index** with **in-memory live update** on file changes (search reflects edits within ~250 ms) + close-time disk persistence + int8 quantization + adaptive refill under heavy privacy filtering.
- **Agentic RAG** — HyDE (Gao et al 2023) + sub-question decomposition.
- **GraphRAG-light** — Louvain community detection over the wikilink graph.
- **Standalone Obsidian Bases** `.base` query execution (no Obsidian process needed).
- **PDFs blended into search** with `[page: N]` citations + Tesseract OCR for scanned docs.
- **Forgetting-aware freshness** (v3.10) — every search hit carries `age_days` + a `stale` flag from the note's live mtime, the `obsidian_stale_notes` tool surfaces aged notes, and opt-in recency re-ranking (`--recency-weight` / `--stale-days`, default off) lets agents prefer fresher knowledge. Directly addresses the stale-fact-reuse frontier (Memora, arXiv:2604.20006) that conversation-memory stores ignore — the only Obsidian MCP with it.
- **Process maturity** — 1490 tests, 9 required CI gates, semver-bound public surface, signed npm build provenance (SLSA Build L2), 12 state-driven OIA drift checks, structural invariant suite.

## Competitive read (why the roadmap is shaped the way it is)

The May-2026 survey confirms the strategic picture: **we are capability-ahead in our category; the gap to the memory leaders is published benchmarks + discoverability, not technology.**

- **vs other Obsidian MCPs** — we are the *only* Obsidian MCP combining standalone (no plugin / no REST bridge) operation + BM25+embedding hybrid + cross-encoder reranker + HyDE + sub-question + GraphRAG-light + PDF/OCR + HTTP transport. The visible leaders are *plugins* (Obsidian Copilot ~7.1k★, Smart Connections ~5.1k★ — both require Obsidian running) or *CRUD/REST bridges* (MarkusPfundstein/mcp-obsidian ~3.8k★, cyanheads/obsidian-mcp-server ~562★ — both require the Local REST plugin). The closest standalone-architecture peer (sweir1/obsidian-brain) has ~7★ and lacks reranker/HyDE/HNSW/PDF/HTTP. **Our gap is stars/discoverability, not capability.**
- **vs local-RAG MCPs** — knowledge-rag (~86★, actively developed, *has a Glama score badge*) is the closest generic peer: hybrid + reranker + watcher + zero-cloud. We lead on Obsidian-native features (Bases DSL, wikilink graph, frontmatter parsing), HNSW int8 + live update, HyDE + sub-question, HTTP transport, and PDF OCR. chroma-mcp (~551★) is vector-only.
- **vs AI-memory frameworks** — mem0 (~57k★, LoCoMo 92.5 / LongMemEval 94.4), Zep/Graphiti (~27k★, peer-reviewed arXiv:2501.13956, DMR 94.8 / strong LongMemEval), Letta (~23k★), cognee (~17.5k★). They publish standard benchmark numbers and do conversational write-back + entity KGs; we don't *yet*. Two findings reshape our plan: (1) **Letta's own result that a trivial filesystem-storage baseline scores 74% on LoCoMo validates the vault-as-memory thesis** — we should measure and claim it; (2) the **Memora benchmark (arXiv:2604.20006, Apr 2026) shows ALL memory systems fail on stale-memory reuse** — a documented frontier we can address cheaply because every note carries an `mtime`.

**The single highest-leverage move is publishing a LongMemEval score** (no Obsidian MCP has any) — it moves us from the "Obsidian plugin" tier into the "serious memory infrastructure" peer tier (Zep/Mem0), and it plays to our strongest suit (retrieval). Second: own the precise message **"the only local memory layer grounded in *your* knowledge — not extracted and re-stored from conversations"** (mem0/Zep/Letta all extract; our vault *is* the source of truth — structurally simpler and privacy-superior).

---

## Tier 0 — Integrity: every claim verifiable (gates v3.9.0 stable)

The whole pitch is rigor, so unverifiable claims come first. The second audit surfaced concrete security findings alongside the integrity items.

- [x] **#15 SLSA-3 → SLSA L2** (v3.9.0-rc.7) — corrected across all surfaces; OIA **Check 4d** now statically enforces the SLSA-level claim against `release.yml` (negative-control verified in rc.8). Real **L3** is a tracked Tier-4 item, not a claim.
- [x] **Version/RC + reranker-number drift** (v3.9.0-rc.7, partial) — README/QUICKSTART/benchmarks/AGENTS synced; reranker corrected to the measured +15.5/+24.7. _Residual instances found in the rc.8 audit (4× stale "currently rc.N", 4× stale "+5-10 NDCG@10" in api.md/COMPARISON/QUICKSTART, ROADMAP "926→927") → closed in **rc.12** below._
- [x] **#16 OCR offline enforcement** (v3.9.0-rc.10 ✓). Built the guards the docs promised: pre-flight `assertOcrLangsInstalled` throw before `createWorker`, `langPath`/`cachePath` + `cacheMethod: "readOnly"` pinning, a real `install-ocr-lang <code>` subcommand, an absolute canvas-dimension clamp (the canvas-OOM DoS), and page-range validation. "Zero outbound network calls in serve mode" is now actually true + regression-proofed by OIA Check 4e.
- [ ] **Close the overclaim class STRUCTURALLY** (rc.10 partial → rc.12). _rc.10 shipped **OIA Check 4e** — the #16-specific code-guard verifier (docs claiming offline OCR must be backed by `assertOcrLangsInstalled` + `cacheMethod:"readOnly"` + the `install-ocr-lang` subcommand), mirroring rc.8's #15-specific Check 4d._ Still open: (a) a GENERALIZED enforcement-verb grep (a verb→guard taxonomy beyond the SLSA/OCR specifics), (b) **RC-level currency check** — extend `check-version-consistency.mjs` / OIA to the "currently v…-rc.N" + QUICKSTART example strings (current OIA Check 7 treats 3.9==3.9 as current, so RC drift never trips) (rc.12). Together these close overclaim classes #12/#13 permanently.

## Tier 1 — Security & correctness hardening (the rc.9 → rc.13 sprint; ReDoS line extended through rc.21–rc.25)

Severity-ordered, phased per the project's "no big-bang" rule; audit checkpoint after each RC.

- [x] **rc.9 — Input-validation security** ✓ (shipped v3.9.0-rc.9; the ReDoS guard was hardened further in rc.21/rc.24/rc.25 — overlapping-alternation, case/escape aliasing, optional/nullable/variable bodies — plus a permanent generative fuzz harness). **ReDoS** in `obsidian_open_questions` (`tools/meta.ts` compiled a user-supplied `pattern` arg into a `RegExp` with no length/quantifier guard; the tool is always-registered, so any stdio/HTTP client could peg the event loop) → capped length + reject the unsafe override. + `dql.ts` `like`-pattern length cap (defensive). + bearer-token min-length reconciliation (`cli.ts` ↔ `http-transport.ts` ≥16).
- [x] **rc.10 — OCR offline enforcement + DoS** (Tier-0 #16) **+ canvas-OOM DoS** ✓ — `clampOcrScale` bounds absolute pixels (`MAX_OCR_CANVAS_DIM`), `resolveOcrPageRange` rejects inverted ranges, OIA Check 4e regression-proofs the offline claim. +15 tests.
- [x] **rc.11 — Watcher / HNSW correctness** ✓. **H1** fixed via a per-absPath promise queue (`fileQueues`) serializing same-file events + `close()` draining in-flight handlers before flush. **`-1` sentinel-label** fixed via `zipHnswAddPoints` (asserts `newIds.length === rows.length`, throws fail-closed — no corrupt label). + M1 (`saveTo` persists the live `getCurrentCount()`) + L2 (correct `kind` on PDF unlink). +7 tests.
- [x] **rc.12 — Structural defenses + state-driven docs + supply-chain** ✓ (RC-currency check + state-driven docs shipped rc.12/rc.13; **all 28 GitHub Actions SHA-pinned** + OIA Check 9 in rc.14; `npm ci` retry + Check 10 in rc.20). Built the RC-level currency check + added `AGENTS.md` (rc.13) then `ROADMAP.md` (rc.37, with a `docs-consistency` test-count guard) to `scope-completeness-audit.mjs` `AUDIT_FILES`; backfilled every stale instance the audit found (currently-rc.N ×4, +5-10 ×4, ROADMAP test count, broken packaged-doc relative links → absolute GitHub URLs, `api.md` SECURITY anchor, AGENTS "5 surfaces"→7 + phantom `bench` subcommand, CITATION.cff model names, the retracted-Cursor-audit comment, stale SECURITY.md "v3.8.0" stamps, README/AGENTS suite-timing, the rc.7↔rc.8 CHANGELOG sequencing contradiction). All 28 Actions SHA-pinned (rc.14). _Deferred:_ OpenSSF Scorecard + `dependency-review-action` workflows + an OIA scan for unpinned `run:` downloads (the M-9 class) — additive supply-chain rigor, not yet shipped.
- [x] **rc.13 — Remaining correctness / cleanup** ✓ (shipped across rc.13/rc.15/rc.16). `bases.ts` unbounded `warnedUnknownPredicates` Set (memory growth) · `tools/search.ts` citation line/kind mis-attribution across rankers · `embeddings.ts`/`tool-registry.ts` reranker/model default doc drift ("multilingual" vs `rerank-bge`) · `eval.ts` surface a `query_errors` count (don't fold failures into zero-scores) · `doctor` privacy-glob flags (P2-12) · stateless HTTP handler cleanup parity with the stateful path · `--ocr-pdfs` "no embed-db" warning · `communities.ts` non-convergence flag.

## Tier 2 — Discoverability & AI-indexability (rc.14+)

The capability gap is won; this closes the *visibility* gap. (Several items below need an account/OAuth action and are listed under "Requires the maintainer".)

- [ ] **rc.14 — AI-search + repo-page.** **FAQPage JSON-LD** (highest AI-citation rate; the README FAQ already has the Q&A pairs — extend `inject-jsonld.mjs`) + `SoftwareSourceCode`/`targetProduct` + `maintainer`/`dateModified`/`featureList` in the existing JSON-LD · `llms.txt` blockquote split + generated `llms-ctx.txt` companion · `server.json` `categories`/`keywords`/`homepage` (within the 2025-12-11 schema) · `glama.json` (maintainer + related servers) · canonical-URL comments in README · move the `claude mcp add` one-liner into the hero · **regenerate the social-preview** (`scripts/render-social-preview.mjs`) — dark GitHub-native palette; deliberately count-agnostic (rc.29 dropped hardcoded stat-pills to avoid a numeric-drift surface).
- [x] **TDQS pass on all 46 tool descriptions** (the initial 45 shipped v3.10-rc.7; `obsidian_mark_useful` added v3.11.0) — well-described tools are selected ~260% more often (Glama TDQS / arXiv 2602.14878); 89% of MCP tools omit "when NOT to use". rc.7 added explicit purpose / when-to-use / when-NOT-to-use / pre-condition (`--enable-write`, `setup` required) lines to every tool.
- [ ] **Obsidian-MCP COMPARISON table** — extend `docs/COMPARISON.md` with a head-to-head vs knowledge-rag, cyanheads, mcp-obsidian, Smart Connections, obsidian-brain (today it compares only to plugins / mem0-class). Make the standalone + hybrid + reranker + HyDE + Bases + OCR exclusivity explicit.

## Tier 3 — Memory-layer credibility (v3.10)

- [ ] **Publish LongMemEval scores** (THE #1 credibility lever). Run the harness (github.com/xiaowu0162/longmemeval) with `obsidian_search` as the retrieval backend (benchmark conversations ingested as notes); publish head-to-head vs mem0 (94.4) / Zep (71.2) / Supermemory (81.6) in `docs/benchmarks.md` + lead the README with it. First Obsidian MCP with a published number.
- [x] **"Forgetting-aware" note-staleness scoring** (shipped v3.10-rc.5; Memora frontier) — the opt-in recency re-ranking (`--recency-weight` / `--stale-days`, default off) down-weights chunks from long-stale notes for preference/fact queries. Shipped as a post-fusion re-rank (functionally achieving the goal; an RRF-internal decay variant is a possible later refinement, not tracked). Same feature as "Forgetting-aware freshness" under **Already shipped** above — listed here too because it closes this Memora-frontier item. Addresses a documented failure mode of *every* competitor.
- [ ] **Messaging reposition** — "the only local memory layer grounded in your own knowledge, not extracted from conversations" across README/llms.txt/COMPARISON; "what comes after Obsidian Copilot when you want agents, not just chat".

## Tier 4 — Extend the lead (pick after Tier 3)

- [ ] **Late chunking** opt-in at markdown-heading boundaries (GraLC-RAG, arXiv:2603.22633) — preserves cross-section context; measurable via structural-coverage metrics.
- [ ] **GraphRAG-full** — entity/relationship extraction from note *content* (not just wikilinks), staying local — to match cognee/Zep-class KGs.
- [ ] **Conversational write-back** — a `remember` / distill-to-vault tool turning an agent conversation into durable markdown memory (the mem0/Zep core use-case), entering that niche directly.
- [ ] **Queryable wikilink graph tool** — expose shortest-path / entity-neighborhood over the graph already built for community detection (reframes GraphRAG-light as a queryable KG).
- [ ] **ColBERT-style late-interaction reranker** as an opt-in `--reranker colbert` for long documents.
- [ ] **Earn real SLSA Build L3** via `slsa-framework/slsa-github-generator`; restore an L3 badge once verified. + CycloneDX SBOM on release, `step-security/harden-runner` egress auditing, CODEOWNERS / SUPPORT.md.

## Requires the maintainer (account / OAuth / external — I can't do these for you)

- **Claim the Glama server** (GitHub OAuth) + deploy the Dockerfile + publish a Glama release → moves it from "withheld from search" (17% score) to indexed for 50k+ Glama users. (I'll add `glama.json` + the Dockerfile; you claim + deploy.)
- **Verify the official MCP Registry entry resolves and tracks the published version** via `mcp-publisher` (re-publish on each release; confirm `io.github.oomkapwn/enquire-mcp` is `active` / `isLatest`).
- **Post to the Obsidian forum thread** (81.2k views — the primary organic discovery surface) with the comparison table; submit to **PulseMCP**, **mcp.so**, **smithery.ai**, **Cursor MCP marketplace**; update the awesome-mcp-servers PR with the Glama badge.
- **Enable GitHub Discussions** + pin the repo on your profile.

## Explicit non-goals

- Multi-vault support · OAuth for the server (bearer-only is a deliberate security-positive choice) · live Obsidian-plugin integration via Local REST API (different positioning) · multi-source cloud ingestion (vault-only is the privacy thesis) · distributed/multi-process rate-limiting.

---

*Roadmap items are intentions, not commitments or dates. The only hard gate is Tier 0: no claim ships that the code doesn't enforce.*
