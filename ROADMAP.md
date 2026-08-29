# enquire-mcp — Roadmap

> Public roadmap for **enquire-mcp**, the #1 Obsidian MCP for freshness-aware, cited AI memory backed by your own vault. Updated 2026-08-29 (`v4.0.0-rc.5`: the current preview of the MCPB Basic bundle first introduced in `v4.0.0-rc.2` on the published `v4.0.0-rc.1` official-SDK-v2 foundation, behind a fail-closed 13-gate remote publication chain; stable `@latest` remains v3).
>
> **North Star:** be — and confidently *stay* — the best project in its spheres (Obsidian MCP; local-first AI-memory layer) on **technology** and **reliability**. "Confidently" means every claim we make is one an external auditor or a privacy-conscious user can verify against the code.

This is the *public* roadmap. Per-release detail lives in [`CHANGELOG.md`](./CHANGELOG.md); internal methodology + audit history lives in `CLAUDE.md`.

---

## Where we are (v3.11.x stable on `@latest`)

Already shipped and differentiating:

- **Full hybrid retrieval** — BM25 + TF-IDF + multilingual ML embeddings, RRF-fused, with optional BGE cross-encoder reranking (**+15.5 NDCG@10 / +24.7 MRR** measured on a 60-query ablation).
- **HNSW vector index** with **in-memory live update** on file changes (search reflects edits within ~250 ms), automatic EmbedDb fallback after an uncertain graph diff, close-time disk persistence, int8 quantization and adaptive refill under heavy privacy filtering.
- **Agentic RAG** — HyDE (Gao et al 2023) + sub-question decomposition.
- **GraphRAG-light** — Louvain community detection over the wikilink graph.
- **Structured Obsidian documents** — Canvas parsing, Dataview-style LIST/TABLE queries, and supported Base-filter execution (no Obsidian process needed).
- **PDFs blended into search** with `[page: N]` citations + Tesseract OCR for scanned docs.
- **Forgetting-aware freshness** (v3.10) — every search hit carries `age_days` + a `stale` flag from the note's live mtime, the `obsidian_stale_notes` tool surfaces aged notes, and opt-in recency re-ranking (`--recency-weight` / `--stale-days`, default off) lets agents prefer fresher knowledge. This directly addresses stale-fact reuse; the 2026-07-24 pinned direct-peer sources do not document an equivalent retrieval control.
- **Process maturity** — 2228 tests and 13 release-required CI checks (all 13 currently branch-protected; live snapshot verified 2026-08-21). The v4 line defines official-client protocol conformance, a three-OS packed-consumer aggregate, an MCPB Basic gate that consumes one exact Linux-built candidate on Linux, Windows, and macOS, and a Docker build/introspection gate before release. A pinned Windows hostile-filesystem and startup-interlock prerequisite fails the protected `smoke` context closed; the project also carries a semver-bound public surface, signed npm build provenance (SLSA Build L2), 12 state-driven OIA drift checks, and structural invariants.

The **v4.0.0 `@rc` preview** keeps those v3 activation, watcher-generation and mainstream local-filesystem hardlink guarantees while moving the public transports to official MCP SDK v2. Era-aware stdio and strict modern HTTP (`2026-07-28`) coexist with supported legacy clients from one registration factory; malformed modern claims never downgrade. Aggregate write tracking keeps shared persistence behind active modern/stdio work, and the new remote gates are defined to exercise the official client plus the packed public package across Linux, Windows and macOS. The single intentional programmatic break is the nominal SDK type returned by `buildMcpServer()`; tool/prompt/resource, CLI, privacy, write-gate and storage behavior remain compatible. npm `@latest` remains stable v3 pending the explicit stable-promotion decision.

## Leadership plan (why the roadmap is shaped this way)

The 2026-07-30 competitive scan covered 129 adjacent projects (6 high-, 24
medium-, 38 low-, and 61 negligible-relevance surfaces). Its clearest result:
enquire's near-term gap is distribution, onboarding, and category
communication—not retrieval depth. The product already combines the complete
retrieval ladder, freshness-aware memory, Obsidian-native document coverage,
agentic workflows, remote transport controls, and a verifiable release chain
in one package.

The remaining leverage is not another disconnected feature. It is making the
lead immediately visible and independently reproducible:

- **Show the result first.** The canonical README now demonstrates a concrete
  query, grounded answer, and source note above the fold.
- **Turn comparison traffic into activation.** The public comparison page is
  now a TOP-1 product battlecard with internal proof links and no outbound
  recommendations.
- **Bind every number to evidence.** Absolute scale/latency promises are
  replaced by corpus-scoped observations, commands, and CI invariants.
- **Own the sharp wedge.** Every acquisition surface now leads with
  freshness-aware cited recall, read-only defaults, and exact Obsidian-native
  scope instead of a generic “more search features” pitch.
- **Shorten onboarding again.** Initialize instructions and verified
  client-specific install actions now lead into a benefit-led Pages landing;
  lifecycle recipes and a packageable one-click route are the next conversion
  layer.
- **Meet the modern MCP contract as a real major.** The published `4.0.0-rc.1`
  moved the final 2026-07-28 protocol boundary to TypeScript SDK v2,
  with separate strict-modern and supported-legacy paths rather than a partial
  v1 compatibility claim.
- **Package only the safe install tier.** The `v4.0.0-rc.2` release packages the first
  MCPB target as Basic read-only, pure JavaScript, explicit-vault and a fixed
  tool allowlist. Native hybrid/model/OCR/index dependencies stay out of that
  first bundle; publication is fail-closed until its canonical candidate passes
  the declared remote three-OS consumer gate.

The durable positioning is concrete: **the complete local-first long-term
memory backend grounded in the vault you own**. The proof stack lives in
[`docs/COMPARISON.md`](./docs/COMPARISON.md), [`docs/benchmarks.md`](./docs/benchmarks.md),
and the 13-gate release chain.

---

## Tier 0 — Integrity: every claim verifiable (gates v3.9.0 stable)

The whole pitch is rigor, so unverifiable claims come first. The second audit surfaced concrete security findings alongside the integrity items.

- [x] **#15 SLSA-3 → SLSA L2** (v3.9.0-rc.7) — corrected across all surfaces; OIA **Check 4d** now statically enforces the SLSA-level claim against `release.yml` (negative-control verified in rc.8). Real **L3** is a tracked Tier-4 item, not a claim.
- [x] **Version/RC + reranker-number drift** (v3.9.0-rc.7, partial) — README/QUICKSTART/benchmarks/AGENTS synced; reranker corrected to the measured +15.5/+24.7. _Residual instances found in the rc.8 audit (4× stale "currently rc.N", 4× stale "+5-10 NDCG@10" in api.md/COMPARISON/QUICKSTART, ROADMAP "926→927") → closed in **rc.12** below._
- [x] **#16 OCR offline enforcement** (v3.9.0-rc.10 ✓). Built the guards the docs promised: pre-flight `assertOcrLangsInstalled` throw before `createWorker`, `langPath`/`cachePath` + `cacheMethod: "readOnly"` pinning, a real `install-ocr-lang <code>` subcommand, an absolute canvas-dimension clamp (the canvas-OOM DoS), and page-range validation. "Zero outbound network calls in serve mode" is now actually true + regression-proofed by OIA Check 4e.
- [x] **Close the original overclaim-currency class STRUCTURALLY** (rc.10 → rc.14). OIA Check 4e binds the offline-OCR claim to its guard, the RC/header currency checks pin current-version prose, and the broader state-driven docs/supply-chain sweep is recorded in the completed rc.12–rc.14 item below. A generalized enforcement-verb taxonomy remains a separate future hardening idea, not unfinished work in this historical sprint.

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
- [x] **Competitive-distribution rebuild** — v3.12.0-rc.29 converts the
  129-project scan into a freshness/citation/read-only wedge, publishes the
  exact privacy boundary, refreshes AI/search metadata and high-intent GitHub
  discovery terms, and adds a remote-only social-preview artifact loop.
- [x] **Agent lifecycle recipes** — v3.12.0-rc.30 packages client-neutral
  playbooks for first recall, evidence follow-up, stale-fact revalidation,
  weekly synthesis, research capture, and safe write escalation. They reuse
  the 19 MCP prompts, live `tools/list`, and `initialize.instructions`; no
  parallel orchestration engine or automatic hook is introduced.
- [x] **Directory/community launch preparation** — v3.12.0-rc.30 packages one
  evidence-backed directory card, community post, stable install CTA, privacy
  boundary, proof links, and bounded claim rules. Channel-specific submission
  operations stay in the private maintainer backlog. External posting, account
  use, paid submission, and listing acceptance remain maintainer-gated actions
  below.

## Tier 3 — Memory-layer credibility (v3.10)

- [ ] **LongMemEval publication is parked, not active.** The evidence tooling
  shipped through rc.20, but the maintainer cancelled benchmark execution and
  headline publication. Do not run local or remote benchmark/evaluation work
  without a new explicit instruction; the current acquisition plan relies on
  already-reviewed evidence.
- [x] **"Forgetting-aware" note-staleness scoring** (shipped v3.10-rc.5; Memora frontier) — the opt-in recency re-ranking (`--recency-weight` / `--stale-days`, default off) down-weights chunks from long-stale notes for preference/fact queries. Shipped as a post-fusion re-rank (functionally achieving the goal; an RRF-internal decay variant is a possible later refinement, not tracked). Same feature as "Forgetting-aware freshness" under **Already shipped** above — listed here too because it closes this Memora-frontier item. Addresses a documented failure mode of nearly every reviewed competitor; Engraph is the notable temporal-scoring exception in the 2026-07-30 scan.
- [x] **Messaging reposition** — SHIPPED and strengthened in v3.12.0-rc.5: README ×11, npm/MCP/AI metadata, social preview and GitHub About now lead with the explicit “#1 Obsidian MCP for AI memory” credential. The project-page funnel proves enquire's own leadership across eight product outcomes and no longer routes visitors to alternatives; detailed competitive evidence remains available outside the conversion path. Measurable supporting claims stay current and inspectable, while the broad TOP-1 line remains deliberate promotional positioning.

## Tier 4 — Major contract and safe distribution

- [x] **MCP 2026-07-28 + TypeScript SDK v2 (`4.0.0-rc.1`)** — the published major foundation has official modern/legacy handlers, no-downgrade routing, write-drain parity, and remote protocol-conformance and packed-consumer gates. This is the semver-major migration: inventory protocol/SDK changes, preserve the stable v3 contract where possible, publish an explicit compatibility matrix, and validate every release gate remotely. A hand-built “modern MCP” shim on SDK v1 is explicitly rejected.
- [x] **First MCPB Basic bundle (`v4.0.0-rc.2`)** — exact v0.3 manifest pin, explicit vault selection, fixed 13-tool read-only allowlist, zero prompts, a Node.js 22.13+ host floor, no native/optional hybrid dependencies, logical content inventory, CycloneDX SBOM, third-party notices, and one CI-built candidate consumed through the official client on macOS, Windows, and Linux.
- [x] **Fail-closed remote publication gate** — the exact final main/tag identity must pass every protocol, packed-package, MCPB Basic, and Docker lane plus the complete 13-context release gate before npm or GitHub Release publication. Cross-platform runtime success is claimed only by those exact remote results; desktop GUI behavior is not.
- [ ] **Maintainer UI acceptance and directory decision** — manually review
  installation/removal in a real compatible desktop host, then decide whether
  to submit the bundle to any public directory. Remote consumer evidence does
  not claim desktop UI acceptance, signing, or directory approval.
- [ ] **Optional Obsidian companion** — RFC/demand-gated thin layer for
  install/status/open-result/community discovery. The filesystem remains the
  source of truth; no desktop/wiki-builder rewrite.

- [ ] **Late chunking** opt-in at markdown-heading boundaries (GraLC-RAG, arXiv:2603.22633) — preserves cross-section context; measurable via structural-coverage metrics.
- [ ] **GraphRAG-full** — local entity/relationship extraction from note *content* (not just wikilinks), strengthening the knowledge graph without cloud ingestion.
- [ ] **Conversational write-back** — a reviewable `remember` / distill-to-vault tool that turns an agent conversation into durable Markdown memory.
- [x] **Queryable wikilink graph tool** — SHIPPED: `obsidian_find_path` (shortest-path) + `obsidian_get_note_neighbors` (entity-neighborhood) + `obsidian_get_communities` expose the graph already built for community detection. _(Marked done in the 2026-07-16 audit truth-reset — the tools exist in TOOL_MANIFEST; remaining work is examples + usage measurement, not build.)_
- [ ] **ColBERT-style late-interaction reranker** as an opt-in `--reranker colbert` for long documents.
- [ ] **Earn real SLSA Build L3** via `slsa-framework/slsa-github-generator`; restore an L3 badge once verified. + CycloneDX SBOM on release and `step-security/harden-runner` egress auditing. (`CODEOWNERS` + `SUPPORT.md` shipped in v3.12.0-rc.6.)

## Requires the maintainer (account / OAuth / external — I can't do these for you)

- **Optional Glama ownership claim.** The server is already auto-indexed and
  discoverable at its public schema page; OAuth claiming is no longer an
  indexing blocker. Claim only if the maintainer wants dashboard/community
  controls.
- **Keep the official MCP Registry entry tracking stable releases** via `mcp-publisher`. Verified 2026-07-24: `io.github.oomkapwn/enquire-mcp` is active and stable v3.11.6 is `isLatest`; prereleases intentionally remain npm/GitHub-only.
- **Publish the prepared community post** from the maintainer account.
- **Directory and marketplace publication.** Search by exact repository,
  package, and Registry identity before correcting or submitting a card; paid
  routes, account attestations, and external acceptance remain maintainer
  actions. Local-marketplace publication stays gated on the Basic read-only
  MCPB plus remote cross-platform evidence. Never submit a user-hosted
  `serve-http` URL as project-operated infrastructure or invent an install
  URI before a listing is accepted.
- **Pin the repo on your GitHub profile.** Discussions are already enabled and linked from `SUPPORT.md`.

## Explicit non-goals

- OAuth for the server (bearer-only is a deliberate security-positive choice for local/single-user; revisited only if a hosted/team boundary ever exists) · multi-source cloud ingestion (vault-only is the privacy thesis) · cloud embeddings by default (localhost/opt-in only, outside the zero-outbound guarantee) · automatic conversational write-back (reviewable proposals only) · formula evaluator · distributed/multi-process rate-limiting.

**Reversed to RFC-gated (no longer a flat non-goal):** *multi-vault support* — the "no multi-vault" non-goal was reversed to **RFC-gated**, blocked on a demand test (5 concrete workflows + ≥5-user evidence + ruling out the zero-code "N processes" alternative) before any code. *live Obsidian-plugin integration* — reconsidered as an **optional thin companion** (install/status/open-result/community-store discovery) with the filesystem staying the source of truth; not a core dependency.

---

*Roadmap items are intentions, not commitments or dates. The only hard gate is Tier 0: no claim ships that the code doesn't enforce.*
