# External Audit Request — enquire-mcp — FULL FROM-SCRATCH AUDIT (v3.11.0 promotion gate)

> **Mandate:** Audit the **entire** project from scratch — all code, all files, all logic, all configuration, all documentation, all infrastructure. Verify everything; **change nothing**. Produce one detailed written report.
>
> **Audit target (pin to this exact state — do NOT audit `@latest` or an older RC):**
> - **Commit:** `610429c6cd97bdb0a0429364d0e6e8b45c4e11d1` (`main` HEAD as of 2026-06-23)
> - **Version:** `3.11.0-rc.7`  ·  npm `@rc = 3.11.0-rc.7`, `@latest = 3.10.1`
> - **Repo:** https://github.com/oomkapwn/enquire-mcp  ·  npm: `@oomkapwn/enquire-mcp`
> - **Size:** 40 `src/*.ts` modules (~24,950 LOC), 79 test files (1336 `it()`), 4 GitHub Actions workflows, 6 `docs/*.md`, **46 MCP tools, 19 prompts, 3 resources**, README in **9 languages**.
>
> **⚠️ Read this first — the single most important instruction.** Prior external audits of this project repeatedly went **stale**: they graded an older commit and re-flagged findings that newer RCs had already fixed, presenting them as open. **Every finding in your report MUST be verified against the code AT THE PINNED COMMIT ABOVE, at the time you write the report.** Before reporting any issue, re-open the actual file at that commit and confirm the defect is still present. A finding that was true last week but is fixed at `610429c` is a false positive and undermines the whole report. State, per finding, the `file:line` you verified it at.

---

## 1. What this is (and is not)

This is a request for an **independent, adversarial, full-coverage audit** of a mature open-source MCP server, gating the promotion of the **v3.11.0 minor** from `@rc` to `@latest`. It is **read-only**: you must **not** modify any file, open any PR, push any commit, or change any setting. The deliverable is **a written report only**.

The project has been through ~30 internal audit cycles and several external rounds; it is deliberately over-engineered for correctness and has a documented anti-overclaim discipline (20 self-documented "overclaim" corrections in its CHANGELOG/CLAUDE.md). **Do not take that as a reason to go easy.** The standing assumption is: *there are still real defects we have not found.* Your value is finding what the prior rounds and the maintainer's own tooling missed. Surface-level "looks good" confirmations are low value; concrete, reproduced, `file:line`-anchored defects are high value.

**Empirical-rejection culture:** this project rejects findings it can disprove and documents why. So: do not pad the report with speculative or style-only items asserted as risks. For every finding, give evidence you can defend — a reproduction, a specific code path, a concrete exploit or failure scenario. "Could theoretically…" without a path is noise. If you assert a number (test count, tool count, control count), verify it against the source of truth, because the maintainer will.

---

## 2. What enquire-mcp does (orientation)

A TypeScript MCP server that exposes a local Obsidian markdown vault as persistent, queryable long-term memory for AI agents (Claude Code/Desktop, Cursor, ChatGPT, Codex, OpenClaw, any MCP client). Retrieval stack: BM25 (SQLite FTS5) + TF-IDF + ML embeddings (transformers.js, int8-quantized) fused via Reciprocal Rank Fusion, optional BGE cross-encoder reranking, HNSW ANN index, wikilink graph-boost, GraphRAG-light (Louvain), agentic RAG (HyDE + sub-question decomposition), Obsidian Bases DSL, PDF text + OCR, **forgetting-aware staleness** (`age_days`/`stale`, opt-in recency re-rank), **frontmatter-aware filtering**, and an opt-in **closed-loop retrieval feedback** signal. Transports: stdio + streamable-HTTP (bearer auth). Read-only by default; 7 write tools gated behind `--enable-write`; 1 feedback tool gated behind `--feedback-weight`.

### NEW since the last external audit (v3.9.0) — scrutinize these HARDEST (least externally reviewed)
1. **Closed-loop feedback (v3.11.0-rc.1, the 46th tool)** — `obsidian_mark_useful` (gated by `--feedback-weight <0..1>`, default 0 = provable no-op). `src/feedback.ts` `FeedbackStore` persists a per-vault `<hash>.feedback.json` sidecar (relative paths + integer counts + ISO ts ONLY — no note content / query text; 0600; serialized atomic writes; capped). The tally blends into `obsidian_search` rank after recency. Verify: the data-at-rest claim, the no-op-at-0 guarantee, the K-3 WRITE annotation, prune/right-to-erasure coverage, concurrency of the shared store.
2. **js-yaml 4 → 5 migration (v3.11.0-rc.6)** — `src/frontmatter.ts` + `src/bases.ts`. js-yaml@5 drops `Date` coercion (timestamps load as strings, round-trip faithfully), drops merge-key (`<<`) resolution, and `load("")` throws. Verify: no YAML-safety regression, the empty-input guards, scalar resolution, no frontmatter round-trip corruption.
3. **9-language README surface (v3.10.1 + v3.11.0-rc.2)** — EN + zh/es/hi/ar/ru/pt/fr/ja. Verify: every in-file anchor resolves (per-file slugs), numeric claims consistent, no broken/altered badge URLs, the 9-way switcher correctness, Arabic RTL.
4. **v3.10 forgetting-aware staleness + frontmatter filter** — `age_days`/`stale`, `--recency-weight`, `obsidian_stale_notes` (45th tool), `obsidian_search` `filter_frontmatter`.

### Where to read first (suggested order)
1. `README.md` — product surface, the "Trust" + comparison tables. `AGENTS.md` — architecture map of `src/`.
2. `CLAUDE.md` — the maintainer's working doc + the **anti-pattern log** (the catalogue of every failure class this project has hit — your hunting map).
3. `CHANGELOG.md` — 20 documented "overclaim" corrections + per-RC history.
4. `STABILITY.md` + `SECURITY.md` — the semver-bound surface contract + security posture (verify each claimed guarantee against a real code guard).
5. `src/` — `server.ts` (wiring), `tool-registry.ts` + `tool-manifest.ts` (surface), retrieval core (`tools/search.ts`, `fts5.ts`, `embed-db.ts`, `embeddings.ts`, `hnsw.ts`, `rrf.ts`), `vault.ts` (path safety + privacy filter + the abs-path-leak sanitizers), `http-transport.ts` (auth/CORS/sessions), `bases.ts`/`dql.ts`/`wildcard-match.ts` (DSL eval + the non-backtracking matcher), `frontmatter.ts` (the js-yaml@5 port), `feedback.ts`, `ocr.ts`/`pdf.ts` (optional-dep paths), `tools/*.ts` (handlers).

---

## 3. Coverage checklist — audit ALL of the following

For each area: state what you examined, what you verified sound (briefly), and every defect found (in detail).

### 3.1 Code quality & architecture (all of `src/`)
- TypeScript discipline: `strict`, `noUncheckedIndexedAccess`. Hunt for any unsound `as` cast, `!` non-null assertion, hidden `any`, or index access assuming definedness.
- Layer separation, circular deps, dead code, leaky barrels (`tools/index.ts`). Note: tests enforce a `no-internal-imports` rule + a `name-fold` inventory invariant — verify they're sound.
- Error handling: every `throw`/`catch`. Distinguish *deliberate fail-soft* `catch {}` from *swallowed errors that hide bugs*.
- Resource lifecycle: every DB handle, HNSW index, Tesseract worker, pdfjs document, HTTP transport, fd, watcher — confirm guaranteed cleanup (`finally`, self-cleaning `open()`, idempotent close) and no leak on the error path. (rc.70/rc.74 made these self-cleaning — verify no sink was missed.)
- Concurrency / races / TOCTOU: watcher per-file queue + close window, HNSW `applyDiff`, HTTP stateful-session registry (refcount + cap + idle eviction + `runWithPendingInit`), embed-db/fts open/peek, the shared `FeedbackStore` persist chain, any stat-then-act.

### 3.2 Security (adversarial; assume a hostile MCP client on bearer-auth `serve-http`)
- **Path traversal / symlink escape / case-collision** on every read AND write path (`vault.ts`). Try to escape the vault root.
- **Injection / ReDoS:** FTS5 query building; the Bases/DQL `like`→matcher + predicate eval (really non-`eval`, non-SQL?); **every `new RegExp` on caller input** — this project has fought catastrophic-backtracking ReDoS **4 times** (rc.21/24/25/36/63/68/71) and ultimately bounded the `obsidian_open_questions` sink on a worker thread (`MAX_QUESTION_SCAN_MS`) + replaced the LIKE/glob regex with a non-backtracking DP matcher (`src/wildcard-match.ts`). Try to find a 5th catastrophic path, or a sink that still compiles a backtracking regex from input.
- **HTTP transport:** bearer auth (length/constant-time), CORS allowlist (config-sourced, not request-header), body-size cap (`deriveHttpBodyCap`), session cap/eviction, `/health`, default bind host, `Access-Control-Expose-Headers: Mcp-Session-Id`.
- **DoS / resource exhaustion:** every unbounded loop, recursion, cache, queue, regex, or graph traversal reachable from a tool call. The project maintains a `resource-bound-invariant` inventory (every always-on whole-vault scanner must be CAP-or-EXEMPT). Try to find an always-on, bearer-reachable read tool with an unbounded or O(K×N) cost that escapes that inventory (recent finds: read_canvas, validate_note_proposal).
- **Info disclosure:** do any **client-facing** errors leak absolute filesystem paths, config, or token material? `vault.ts` routes every fs sink through `sanitizeFsError`; `optional-dep.ts` strips module-not-found abs paths. Verify no thrown Error reaching an MCP client still embeds `vault.root` or a host path (distinguish client throws from operator stderr).
- **Privacy filter** (`--exclude-glob` / `--read-paths`): enforced + fail-closed at *every* boundary — FTS5, embed-db, chunk resource, watcher, vault walk, write tools, the fusion stage (`pruneExcludedHits`)?
- **Content at rest:** what is written to disk (FTS5 chunks, embed-db `text_preview`, HNSW `.meta.json`, the new `.feedback.json`), at what mode, and does `clear-*` / `prune` fully erase it (the `erasure-invariant`: writers ⊆ erasers)?
- **Offline/zero-cloud guarantees:** `serve`/`serve-http` set `setEmbeddingsOffline()` (transformers.js `allowRemoteModels=false`) + OCR `assertOcrLangsInstalled` fail-closed. Verify these are real code guards (OIA Check 4e/4f), not just docs — and that the "zero cloud calls during serve" claim holds for the embedder/reranker/OCR paths.
- **js-yaml@5 YAML safety:** no `!!js/function`; merge-key resolution truly gone (not just version-bumped); anchor/alias bombs (note the documented threat-model scope: single-user local vault, not network input).

### 3.3 Supply chain & build provenance
- Lockfile integrity, dependency licenses, postinstall scripts, optional-vs-prod-vs-dev hygiene (note: `optionalDependencies` here are the *end-user* runtime-dep install path — verify before claiming any removable). The scoped audit gate is `scripts/check-audit.mjs` (allowlist currently empty — verify).
- GitHub Actions: SHA-pinning of third-party actions (note: rc.5 bumped `actions/checkout` to v7 — verify the SHA + the `# vN` comments), least-privilege `permissions:`, the release workflow's tag-on-main assertion, the OIDC MCP-registry publish step, the `mcp-publisher` download (tag-pinned + SHA256 content-pinned — OIA Check 9b), SLSA provenance level **claimed vs actually earned** (claim is SLSA Build **L2** via `npm publish --provenance`; flag any surface claiming L3+).
- Reproducibility of the published npm artifact vs the tagged source.

### 3.4 Correctness of the retrieval logic (the product's core value)
- RRF fusion math, graph-boost (NFC-folded membership), reranker score handling, HNSW recall/k-multiplier/adaptive-refill, int8 quantization round-trip, chunking + late-chunking offsets, FTS5↔embed-db chunk-identity alignment, the K-1 "embedder thread-through" invariant (a historical data-corruption class — verify it holds at every `new EmbedDb`/`FtsIndex` site).
- **NFC/Unicode name resolution** (`src/name-fold.ts` + the 14-site inventory): wikilinks/titles/DQL `file.name`/`file.path`/bases `path` comparisons must NFC-fold (macOS APFS returns NFD). Try to find a name-comparison site that doesn't.
- **Body-relative vs file-absolute line numbers** (`bodyStartLine`): `open_questions` + `readNote(map)` report file-absolute lines even with frontmatter — verify.
- Any path where a query could silently return wrong/empty results instead of erroring (recent: truncate-before-sort in `listPdfs`/`listCanvases`/`listBases` — verify the sort-then-truncate fix holds).

### 3.5 CI/CD, tests & structural defenses
- Are the **9 required CI gates** real and enforced (lint, test×2, smoke, audit, coverage, version-consistency, docs, oia) + 5 advisory? Is the suite meaningful, or are there vacuous/always-pass tests, silent skips, or coverage-gaming? The project claims every `*-invariant.test.ts` has a real NEGATIVE control enforced by `tests/meta-invariant-coverage.test.ts` — **verify that meta-invariant is itself sound, not vacuous.** (Scrutinize the new `tests/feedback.test.ts`, `tests/readme-anchor-invariant.test.ts`, and the `retryUntil` controls in `tests/github-metadata-invariant.test.ts` for vacuity.)
- Per-file coverage floors (`scripts/check-per-file-coverage.mjs`): honest, or set artificially low to mask 0% coverage on a critical module? Are the inline `// current X%` comments accurate (OIA Check 6)?
- `scripts/oia-walk.mjs` (**12 checks**), `check-version-consistency.mjs` (7 surfaces + the CLAUDE roll-up `@rc` marker), `docs-consistency.test.ts`, `scope-completeness-audit.mjs` — do they actually catch what they claim, and is there a drift dimension they leave uncovered?

### 3.6 Documentation & claims accuracy (state-driven — read every claim, verify against reality)
- Every **numeric** claim (test count = 1336, tool = 46, prompt = 19, CI-gate, OIA-check = 12, per-file-floor, language = 9, benchmark numbers) across README ×9 + llms.txt + AGENTS.md + STABILITY.md + api.md + COMPARISON.md + package.json + server.json + CITATION.cff — against its source of truth.
- Every **enforced-guarantee** claim ("blocked", "zero outbound", "fails closed", "SLSA L2", "atomic", "merge keys removed", "offline") — point to the code guard or flag it as an overclaim. This is the project's most-tracked defect class.
- Currency/version drift, broken links (especially packaged-doc links that 404 in the npm tarball), feature-mention drift (shipped-but-undocumented or documented-but-absent — confirm every CLI subcommand/flag referenced in docs actually exists), **in-file README anchors** (every `(#anchor)` must resolve — guarded by `readme-anchor-invariant`, but verify across all 9).
- The GitHub repo **About** description + Topics (live metadata, outside the repo files) — verify against reality (a SLSA-overclaim there survived ~23 RCs once).

### 3.7 Performance, scalability & reliability
- Cold-build and warm-query behavior, memory ceilings at 100K+ notes, brute-force-vs-HNSW threshold, watcher behavior under bulk moves / folder renames, crash-safety of HNSW persistence (write-order, signature cross-check, recovery), graceful HTTP shutdown (`closeServerBounded` — no unbounded `server.close()` hang).

### 3.8 MCP protocol compliance
- Tool/resource/prompt spec conformance, `inputSchema` coverage, annotations (`readOnlyHint`/`destructiveHint`), JSON-RPC error codes, stdio cleanliness (no stray stdout), streamable-HTTP semantics, session lifecycle.

---

## 4. Deliverable — the report

A single written report (markdown preferred):
1. **Executive summary** + overall verdict (production-ready? risk profile per category? OK to promote v3.11.0 → `@latest`?).
2. **Findings**, each with: a stable ID, **severity** (Critical / High / Medium / Low), **`file:line` verified at commit `610429c`**, a one-line title, concrete **evidence** (the offending code + why it's wrong, ideally a reproduction), and a **recommended fix** (described, not applied).
3. **What you verified as sound** (so coverage is demonstrably real).
4. **Areas you could NOT fully assess** and why (so gaps are explicit, not silent).

Severity guidance: reserve **Critical** for remotely-exploitable or data-loss/corruption defects; **High** for real security/correctness bugs with a plausible trigger; don't inflate governance/style items.

**Methodology note we value:** different methodologies find non-overlapping defects. A *change-driven* read, a *state-driven* read (every file as it exists), and an *adversarial/threat-model* read (STRIDE) each catch what the others miss — use all three. Prior rounds proved the threat-model/privacy lens finds real bugs that line-by-line review missed for many releases.

---

## 5. Out of scope (do not report as defects)
- **Do not change anything** — no edits, PRs, commits, settings. Report only.
- LLM prompt injection via vault *content* is a structural property of all RAG; note it once if you like, not a code defect to fix here.
- Repository **branch-protection / required-reviews / admin-bypass** settings are known + maintainer-gated; note once, not code findings.
- Pure style/lint preferences (biome gates these). Labeled refactor suggestions are welcome as non-defects.
- Deliberate non-goals (multi-vault, OAuth, live-Obsidian-REST, Bases formula evaluation) — documented, not gaps.
- The `js-yaml@5` LIKE Unicode case-fold divergence + the UTC-midnight-Date date-only collapse are documented, deliberate, pinned contracts (see `src/frontmatter.ts` + `src/wildcard-match.ts` headers) — not defects.

---

## 6. Reproduce locally

```bash
git clone https://github.com/oomkapwn/enquire-mcp.git
cd enquire-mcp
git checkout 610429c6cd97bdb0a0429364d0e6e8b45c4e11d1   # the pinned audit target
npm ci
npm run build            # tsc → dist/
npm test                 # full suite (~1336 it(), ~12s)
npm run test:coverage    # global + per-file floors
npm run check:oia        # state-driven drift scan (12 checks)
node scripts/check-version-consistency.mjs   # 7-surface version sync + CLAUDE @rc marker
node scripts/check-audit.mjs                 # scoped npm-audit gate
node scripts/smoke.mjs                        # JSON-RPC smoke vs synthetic vault
```

Optional-dep paths (embeddings/reranker/HNSW/PDF/OCR) require `better-sqlite3`, `@huggingface/transformers`, `hnswlib-node`, `pdfjs-dist`, `tesseract.js`, `@napi-rs/canvas` (installed via `npm ci` — they're optionalDependencies). `enquire-mcp setup --vault <path>` does zero-touch model download + index build; `enquire-mcp doctor --vault <path>` reports what's available.

---

## 7. Why this audit matters to us

The project's North Star is "the most reliable, technically-best Obsidian MCP." A clean from-scratch external pass on a pinned commit — findings verified against current code — is the gate for promoting **v3.11.0** from `@rc` to `@latest` (policy requires ≥2 independent external auditors with **different** methodologies). The most useful outcome is either a defensible "no remaining Critical/High defects at `610429c`" — or, better, the specific defects that prove otherwise. Be thorough; be adversarial; verify everything; change nothing.
