# enquire-mcp — Roadmap

> Public roadmap for **enquire-mcp**, the #1 Obsidian MCP for AI memory and local document intelligence backed by your own vault. Updated 2026-07-26 (v3.12.0-rc.19 candidate: explicit q8 embeddings for the canonical LongMemEval-S run).
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
- **Process maturity** — 1720 tests, 9 release-required CI checks (7 currently branch-protected), semver-bound public surface, signed npm build provenance (SLSA Build L2), 12 state-driven OIA drift checks, structural invariant suite.

Current **v3.12.0 `@rc` preview** closes the activation path: `first-run` validates and renders config in non-destructive preview mode, then requires explicit `--apply` before package-coherent setup/model acquisition and tier-aware doctor verification. The manual commands remain available independently; the orchestrator stops on failure and emits an exact idempotent resume command.

## Leadership plan (why the roadmap is shaped this way)

The 2026-07-25 full-surface audit confirms a broad, inspectable product lead:
enquire combines the complete retrieval ladder, freshness-aware memory,
Obsidian-native document coverage, agentic workflows, remote transport
controls, and a verifiable release chain in one package.

The remaining leverage is not another disconnected feature. It is making the
lead immediately visible and independently reproducible:

- **Show the result first.** The canonical README now demonstrates a concrete
  query, grounded answer, and source note above the fold.
- **Turn comparison traffic into activation.** The public comparison page is
  now a TOP-1 product battlecard with internal proof links and no outbound
  recommendations.
- **Bind every number to evidence.** Absolute scale/latency promises are
  replaced by corpus-scoped observations, commands, and CI invariants.
- **Publish a recognized memory benchmark.** The next major credibility asset
  is a reproducible LongMemEval-S run with raw outputs, ablations,
  latency/index-size measurements, and failure buckets.
- **Shorten onboarding again.** Initialize instructions and verified
  client-specific install actions now lead into a benefit-led Pages landing;
  external client marketplaces remain the conversion tail.

The durable positioning is concrete: **the complete local-first long-term
memory backend grounded in the vault you own**. The proof stack lives in
[`docs/COMPARISON.md`](./docs/COMPARISON.md), [`docs/benchmarks.md`](./docs/benchmarks.md),
and the 9-gate release chain.

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
- [x] **TOP-1 comparison battlecard** — rebuilt in v3.12.0-rc.12 as an enquire-first acquisition surface: buyer outcomes, a runnable cited-memory example, complete-stack proof, current CI-derived counts, and direct activation. Public competitor recommendations were removed; a positive/negative-control invariant keeps them out while preserving evidence-bound product claims.
- [x] **GitHub Pages product front door** — rebuilt in v3.12.0-rc.15 as a dependency-free acquisition surface for humans, AI agents, and search indexers. TypeDoc remains complete at `/api/`; historical symbol URLs remain valid; a deterministic composite builder and structural workflow tests keep PR validation and deployment on the same artifact.
- [x] **TOP-1 repository conversion rebuild** — v3.12.0-rc.16 reframes the front door around portable agent memory + local document intelligence, restores a dated evidence-bound ✓/✕ matrix, and replaces the social preview with a modern vault → local intelligence → agents composition.

## Tier 3 — Memory-layer credibility (v3.10)

- [ ] **Publish a reproducible LongMemEval retrieval score** (THE #1 credibility lever, P0). v3.12.0-rc.17 closed the evidence-contract gap; rc.18 closed the O(N²) fresh-FTS blocker. The exact clean rc.18 sparse control completed (470 scoreable queries, nDCG@5 0.8038), but its dense pre-run exposed an independent transformers.js FP32/q8 dtype drift. rc.19 pins q8 and invalidates FP32-derived embed/HNSW state. Remaining: run the full dense cohort from the exact clean rc.19 release commit, review it, publish headline nDCG@5 plus MRR/Hit@1/Recall@10/AllRel@10 and failure slices in `docs/benchmarks.md`, then lead the README with the result.
- [x] **"Forgetting-aware" note-staleness scoring** (shipped v3.10-rc.5; Memora frontier) — the opt-in recency re-ranking (`--recency-weight` / `--stale-days`, default off) down-weights chunks from long-stale notes for preference/fact queries. Shipped as a post-fusion re-rank (functionally achieving the goal; an RRF-internal decay variant is a possible later refinement, not tracked). Same feature as "Forgetting-aware freshness" under **Already shipped** above — listed here too because it closes this Memora-frontier item. Addresses a documented failure mode of *every* competitor.
- [x] **Messaging reposition** — SHIPPED and strengthened in v3.12.0-rc.5: README ×11, npm/MCP/AI metadata, social preview and GitHub About now lead with the explicit “#1 Obsidian MCP for AI memory” credential. The project-page funnel proves enquire's own leadership across eight product outcomes and no longer routes visitors to alternatives; detailed competitive evidence remains available outside the conversion path. Measurable supporting claims stay current and inspectable, while the broad TOP-1 line remains deliberate promotional positioning.

## Tier 4 — Extend the lead (pick after Tier 3)

- [ ] **Late chunking** opt-in at markdown-heading boundaries (GraLC-RAG, arXiv:2603.22633) — preserves cross-section context; measurable via structural-coverage metrics.
- [ ] **GraphRAG-full** — local entity/relationship extraction from note *content* (not just wikilinks), strengthening the knowledge graph without cloud ingestion.
- [ ] **Conversational write-back** — a reviewable `remember` / distill-to-vault tool that turns an agent conversation into durable Markdown memory.
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
