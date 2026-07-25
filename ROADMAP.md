# enquire-mcp — Roadmap

> Public roadmap for **enquire-mcp**, the #1 Obsidian MCP for AI memory backed by your local vault. Updated 2026-07-24 (v3.12.0-rc.8 candidate: token-setup documentation integrity on top of rc.6's autonomous AI/repo discoverability tail).
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
- **Forgetting-aware freshness** (v3.10) — every search hit carries `age_days` + a `stale` flag from the note's live mtime, the `obsidian_stale_notes` tool surfaces aged notes, and opt-in recency re-ranking (`--recency-weight` / `--stale-days`, default off) lets agents prefer fresher knowledge. This directly addresses stale-fact reuse; the 2026-07-24 pinned direct-peer sources do not document an equivalent retrieval control.
- **Process maturity** — 1710 tests, 9 release-required CI checks (7 currently branch-protected), semver-bound public surface, signed npm build provenance (SLSA Build L2), 12 state-driven OIA drift checks, structural invariant suite.

Current **v3.12.0 `@rc` preview** closes the activation path: `first-run` validates and renders config in non-destructive preview mode, then requires explicit `--apply` before package-coherent setup/model acquisition and tier-aware doctor verification. The manual commands remain available independently; the orchestrator stops on failure and emits an exact idempotent resume command.

## Competitive read (why the roadmap is shaped the way it is)

The 2026-07-24 source-pinned refresh changes the strategic picture: **enquire has a broad, inspectable product surface, but it is not categorically ahead.** `flowing-abyss/obsidian-hybrid-search` is a direct retrieval peer with stronger public external-dataset evidence, while `cyanheads/obsidian-mcp-server` has the deeper live-Obsidian and OAuth surface. The current gap is a fair shared-protocol benchmark plus discoverability, not another unbounded feature-count claim.

- **vs focused Obsidian retrieval** — OHS also combines lexical and dense retrieval through RRF and offers a BGE reranker. It adds a native Obsidian plugin, local or OpenAI-compatible embeddings and published Evergreen/LongMemEval-S artifacts. enquire differs through TF-IDF as a third signal, HNSW/int8, standalone Bases, direct PDF/OCR, freshness controls, agentic prompts and a broader stateful-HTTP operational surface. Those are workflow differences; they do not prove a search-quality win.
- **vs live-Obsidian servers** — cyanheads now documents 14 tool entries, three resources, stateless Streamable HTTP, JWT/OAuth, active-file access, command execution and optional Omnisearch/Text Extractor integration. Its running-Obsidian dependency buys capabilities enquire intentionally does not expose. Markus remains the thinner Python REST wrapper.
- **vs model-free filesystem servers** — mcpvault covers filesystem CRUD, metadata, wikilinks and lexical/BM25 search without a model or persistent vector-index lifecycle. Its pinned source inventory and README disagree on the total; the discrepancy is recorded in the comparison, not scored.
- **vs adjacent memory products** — Basic Memory is now a two-way human/agent Markdown knowledge base with graph/schema tools and optional hosted sync, mobile and team access. That is a different product loop from read-first retrieval over an existing general-purpose vault.

**The single highest-leverage move remains a reproducible LongMemEval-S run under OHS's published protocol.** OHS currently reports nDCG@5 0.895 / MRR 0.920 / Hit@1 0.889 / Recall@10 0.950 on its pinned 470-query result. enquire's existing 60-query synthetic ablation answers a narrower question: how much each stage improves its own stack. The backlog therefore calls for the same corpus, judgments, model/scope rules, raw outputs, latency/index-size measurements and failure buckets before either project is ranked. The positioning that survives this audit is concrete: **local-first long-term memory grounded in the vault you own**, with explicit trade-offs documented in [`docs/COMPARISON.md`](./docs/COMPARISON.md).

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

- [x] **AI-search + repo-page.** CLOSED in v3.12.0-rc.6: the curated `llms-ctx.txt` companion, npm-packaged `llms.txt`, supported MCP Registry `title` + `websiteUrl`, exact 20-topic GitHub discoverability set, `CODEOWNERS`, and `SUPPORT.md` complete the autonomous tail. The official 2025-12-11 Registry schema was re-read before editing: it has no standard `categories` or `keywords`, and the Registry roadmap explicitly says tags/categories are unsupported, so no vendor-shaped fields were invented. Canonical identity is already carried by the JSON-LD graph (`@id`, `codeRepository`, `targetProduct`) plus `server.json.websiteUrl`; an inert README comment adds no crawler contract. Earlier pieces shipped as FAQPage + SoftwareSourceCode JSON-LD (v3.9.0-rc.17), `glama.json` (rc.17), hero install line (rc.27), social preview (rc.29), and the TOP-1 public funnel (v3.12.0-rc.5).
- [x] **TDQS pass on all 46 tool descriptions** (the initial 45 shipped v3.10-rc.7; `obsidian_mark_useful` added v3.11.0) — well-described tools are selected ~260% more often (Glama TDQS / arXiv 2602.14878); 89% of MCP tools omit "when NOT to use". rc.7 added explicit purpose / when-to-use / when-NOT-to-use / pre-condition (`--enable-write`, `setup` required) lines to every tool.
- [x] **Obsidian-MCP COMPARISON table** — refreshed in v3.12.0-rc.4 against immutable 2026-07-24 source commits. OHS is now treated as the direct hybrid/reranker peer and its stronger public benchmark evidence is explicit; cyanheads, mcpvault and Basic Memory were reclassified from their current sources; translated legacy tables are visibly historical; a positive/negative-control invariant rejects current unbounded category claims. Re-audit quarterly because competitor facts remain point-in-time.

## Tier 3 — Memory-layer credibility (v3.10)

- [ ] **Publish a reproducible LongMemEval retrieval score** (THE #1 credibility lever, P0). Run the harness (github.com/xiaowu0162/longmemeval) with `obsidian_search` as the retrieval backend (benchmark conversations ingested as notes). **Goal updated (2026-07-16 audit): an apples-to-apples retrieval comparison vs `flowing-abyss/obsidian-hybrid-search`'s public LongMemEval-S protocol** (headline nDCG@5; also MRR/Hit@1/Recall@10/AllRel@10 — retrieval metrics, NOT answer-generation accuracy) on the same pinned corpus/queries/relevance-judgments/hardware, with raw per-query outputs, our BM25/dense/reranker/graph-boost/staleness ablations, latency/index-size, and failure buckets, in `docs/benchmarks.md` + lead the README with it. (No longer "first" — a peer already publishes; a credible fair number beats an unauditable dramatic one.)
- [x] **"Forgetting-aware" note-staleness scoring** (shipped v3.10-rc.5; Memora frontier) — the opt-in recency re-ranking (`--recency-weight` / `--stale-days`, default off) down-weights chunks from long-stale notes for preference/fact queries. Shipped as a post-fusion re-rank (functionally achieving the goal; an RRF-internal decay variant is a possible later refinement, not tracked). Same feature as "Forgetting-aware freshness" under **Already shipped** above — listed here too because it closes this Memora-frontier item. Addresses a documented failure mode of *every* competitor.
- [x] **Messaging reposition** — SHIPPED and strengthened in v3.12.0-rc.5: README ×11, npm/MCP/AI metadata, social preview and GitHub About now lead with the explicit “#1 Obsidian MCP for AI memory” credential. The project-page funnel proves enquire's own leadership across eight product outcomes and no longer routes visitors to alternatives; detailed competitive evidence remains available outside the conversion path. Measurable supporting claims stay current and inspectable, while the broad TOP-1 line remains deliberate promotional positioning.

## Tier 4 — Extend the lead (pick after Tier 3)

- [ ] **Late chunking** opt-in at markdown-heading boundaries (GraLC-RAG, arXiv:2603.22633) — preserves cross-section context; measurable via structural-coverage metrics.
- [ ] **GraphRAG-full** — entity/relationship extraction from note *content* (not just wikilinks), staying local — to match cognee/Zep-class KGs.
- [ ] **Conversational write-back** — a `remember` / distill-to-vault tool turning an agent conversation into durable markdown memory (the mem0/Zep core use-case), entering that niche directly.
- [x] **Queryable wikilink graph tool** — SHIPPED: `obsidian_find_path` (shortest-path) + `obsidian_get_note_neighbors` (entity-neighborhood) + `obsidian_get_communities` expose the graph already built for community detection. _(Marked done in the 2026-07-16 audit truth-reset — the tools exist in TOOL_MANIFEST; remaining work is examples + usage measurement, not build.)_
- [ ] **ColBERT-style late-interaction reranker** as an opt-in `--reranker colbert` for long documents.
- [ ] **Earn real SLSA Build L3** via `slsa-framework/slsa-github-generator`; restore an L3 badge once verified. + CycloneDX SBOM on release and `step-security/harden-runner` egress auditing. (`CODEOWNERS` + `SUPPORT.md` shipped in v3.12.0-rc.6.)

## Requires the maintainer (account / OAuth / external — I can't do these for you)

- **Claim the Glama server** (GitHub OAuth) + deploy the Dockerfile + publish a Glama release → moves it from "withheld from search" (17% score) to indexed for 50k+ Glama users. (I'll add `glama.json` + the Dockerfile; you claim + deploy.)
- **Keep the official MCP Registry entry tracking stable releases** via `mcp-publisher`. Verified 2026-07-24: `io.github.oomkapwn/enquire-mcp` is active and stable v3.11.6 is `isLatest`; prereleases intentionally remain npm/GitHub-only.
- **Post to the Obsidian forum thread** (81.2k views — the primary organic discovery surface) with the comparison table; submit to **PulseMCP**, **mcp.so**, **smithery.ai**, **Cursor MCP marketplace**; update the awesome-mcp-servers PR with the Glama badge.
- **Pin the repo on your GitHub profile.** Discussions are already enabled and linked from `SUPPORT.md`.

## Explicit non-goals

- OAuth for the server (bearer-only is a deliberate security-positive choice for local/single-user; revisited only if a hosted/team boundary ever exists) · multi-source cloud ingestion (vault-only is the privacy thesis) · cloud embeddings by default (localhost/opt-in only, outside the zero-outbound guarantee) · automatic conversational write-back (reviewable proposals only) · formula evaluator · distributed/multi-process rate-limiting.

**Reversed to RFC-gated (no longer a flat non-goal):** *multi-vault support* — the "no multi-vault" non-goal was reversed to **RFC-gated**, blocked on a demand test (5 concrete workflows + ≥5-user evidence + ruling out the zero-code "N processes" alternative) before any code. *live Obsidian-plugin integration* — reconsidered as an **optional thin companion** (install/status/open-result/community-store discovery) with the filesystem staying the source of truth; not a core dependency.

---

*Roadmap items are intentions, not commitments or dates. The only hard gate is Tier 0: no claim ships that the code doesn't enforce.*
