# External Audit Request — enquire-mcp — FULL FROM-SCRATCH AUDIT

> **Mandate:** Audit the **entire** project from scratch — all code, all files, all logic, all configuration, all documentation, all infrastructure. Verify everything; **change nothing**. Produce one detailed written report.
>
> **Audit target (pin to this exact state — do NOT audit `@latest` or an older RC):**
> - **Commit:** `7a479bbbaeec6321fd5535eaff23cf3ca66caa24` (`main` HEAD as of 2026-06-01)
> - **Version:** `3.9.0-rc.34`  ·  npm `@rc = 3.9.0-rc.34`, `@latest = 3.8.8`
> - **Repo:** https://github.com/oomkapwn/enquire-mcp  ·  npm: `@oomkapwn/enquire-mcp`
> - **Size:** 31 `src/*.ts` files (~21,850 LOC), 53 test files (1024 `it()`), 4 GitHub Actions workflows, 5 `docs/*.md`, 44 MCP tools, 19 prompts, 3 resources.
>
> **⚠️ Read this first — the single most important instruction.** Prior external audits of this project repeatedly went **stale**: they graded an older commit and re-flagged findings that newer RCs had already fixed, presenting them as open. **Every finding in your report MUST be verified against the code AT THE PINNED COMMIT ABOVE, at the time you write the report.** Before reporting any issue, re-open the actual file at that commit and confirm the defect is still present. A finding that was true last week but is fixed at `7a479bb` is a false positive and undermines the whole report. State, per finding, the `file:line` you verified it at.

---

## 1. What this is (and is not)

This is a request for an **independent, adversarial, full-coverage audit** of a mature open-source MCP server. It is **read-only**: you must **not** modify any file, open any PR, push any commit, or change any setting. The deliverable is **a written report only**.

The project has already been through ~25 internal audit cycles and several external rounds; it is deliberately over-engineered for correctness and has a documented anti-overclaim discipline (18 self-documented "overclaim" corrections in its CHANGELOG). **Do not take that as a reason to go easy.** The standing assumption is: *there are still real defects we have not found.* Your value is finding what 25 prior rounds and the maintainer's own tooling missed. Surface-level "looks good" confirmations are low value; concrete, reproduced, file:line-anchored defects are high value.

**Empirical-rejection culture:** this project rejects findings it can disprove and documents why. So: do not pad the report with speculative or style-only items asserted as risks. For every finding, give evidence you can defend — a reproduction, a specific code path, a concrete exploit or failure scenario. "Could theoretically…" without a path is noise. If you assert a number (test count, tool count, line count, a control count), verify it against the source of truth, because the maintainer will.

---

## 2. What enquire-mcp does (orientation)

A TypeScript MCP server that exposes a local Obsidian markdown vault as persistent, queryable long-term memory for AI agents (Claude Code/Desktop, Cursor, ChatGPT, Codex, OpenClaw, any MCP client). Retrieval stack: BM25 (SQLite FTS5) + TF-IDF + ML embeddings (transformers.js, int8-quantized) fused via Reciprocal Rank Fusion, optional BGE cross-encoder reranking, HNSW ANN index, wikilink graph-boost, GraphRAG-light (Louvain community detection), agentic RAG (HyDE + sub-question decomposition), Obsidian Bases DSL, PDF text + OCR. Transports: stdio + streamable-HTTP (bearer auth). Read-only by default; 7 write tools gated behind `--enable-write`.

### Where to read first (suggested order)
1. `README.md` — product surface, capability claims, the "Trust" + comparison tables.
2. `AGENTS.md` — contributor/architecture orientation (5-min map of `src/`).
3. `CLAUDE.md` — the maintainer's working doc: sprint goal, quality bar, and the **anti-pattern log** (the project's catalogue of every failure class it has hit — your hunting map for what tends to break here).
4. `CHANGELOG.md` — 18 documented "overclaim" corrections; the per-RC history.
5. `STABILITY.md` + `SECURITY.md` — the semver-bound surface contract + the security posture claims (verify each claimed guarantee against a real code guard).
6. `src/` — start at `server.ts` (bootstrap/wiring), `tool-registry.ts` + `tool-manifest.ts` (tool surface), then the retrieval core (`search.ts`, `fts5.ts`, `embed-db.ts`, `embeddings.ts`, `hnsw.ts`, `rrf.ts`), then `vault.ts` (path safety + privacy filter), `http-transport.ts` (auth/CORS/sessions), `bases.ts`/`dql.ts` (DSL eval), `ocr.ts`/`pdf.ts` (optional-dep paths), `tools/*.ts` (handlers).

---

## 3. Coverage checklist — audit ALL of the following

This is a from-scratch audit. Cover every area below. For each, the report should state what you examined, what you verified as sound (briefly), and every defect found (in detail).

### 3.1 Code quality & architecture (all of `src/`)
- TypeScript discipline: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Hunt for any unsound `as` cast, `!` non-null assertion, hidden `any`, or index access that assumes definedness.
- Layer separation, circular deps, dead code, leaky barrels (`tools/index.ts` re-exports).
- Error handling: every `throw`, every `catch`. Distinguish *deliberate fail-soft* `catch {}` (returns null/continue — acceptable) from *swallowed errors that hide bugs*. (Note: a prior auditor miscounted these and rated style as severity — verify the actual count and the actual body of each.)
- Resource lifecycle: every DB handle, HNSW index, Tesseract worker, HTTP transport, file descriptor, watcher — confirm guaranteed cleanup (`finally`, idempotent close) and no leak on the error path.
- Concurrency / races / TOCTOU across: the watcher per-file queue, HNSW live-update (`applyDiff`), HTTP stateful-session registry (refcount + cap + idle eviction), embed-db open/peek, any stat-then-act pattern.

### 3.2 Security (treat as adversarial; assume a hostile MCP client on bearer-auth `serve-http`)
- **Path traversal / symlink escape / case-collision** on every read AND write path (`vault.ts` resolve/realpath logic). Try to escape the vault root.
- **Injection:** FTS5 query building, the Bases/DQL `like`→regex and predicate evaluation (is it really non-`eval`, non-SQL?), any `new RegExp` on caller input (ReDoS — the project has fought this 3×; try to find a 4th catastrophic pattern under the 200-char cap), any path/glob built from input.
- **HTTP transport:** bearer auth (constant-time? length oracle?), CORS allowlist (sourced from config, not request header?), rate-limit, body-size cap, session cap/eviction, the `/health` endpoint, default bind host.
- **DoS / resource exhaustion:** every unbounded loop, recursion, cache, queue, regex, or graph traversal reachable from a tool call. PDF page counts, OCR canvas size, BFS/community-detection bounds, embedding batch sizes.
- **Info disclosure:** do any client-facing errors leak absolute filesystem paths, internal config, or token material? (Distinguish client-facing throws from server-operator stderr logs.)
- **Secrets / credentials:** none hardcoded; bearer token never logged in the clear.
- **Privacy filter** (`--exclude-glob` / `--read-paths`): is it enforced at *every* boundary — FTS5 search, embed-db search, chunk resource, watcher ignore, vault walk, write tools — and fail-closed?
- **Content at rest:** what exactly is written to disk (FTS5 chunks, embed-db `text_preview`, HNSW `.meta.json`), at what file mode, and does `clear-*` fully erase it (right-to-erasure)?
- **OCR offline guarantee:** does `serve` truly make zero outbound calls, and is the "no CDN download" claim enforced by an actual code guard (not just docs)?

### 3.3 Supply chain & build provenance
- Lockfile integrity, dependency licenses (any GPL contamination?), postinstall scripts, optional vs prod vs dev dependency hygiene (note: `optionalDependencies` here are the *end-user* runtime-dep install path — verify before claiming any is removable).
- GitHub Actions: SHA-pinning of third-party actions, least-privilege `permissions:`, the release workflow's tag-on-main assertion, the OIDC MCP-registry publish step (`release.yml`), the `mcp-publisher` download (pinned?), SLSA provenance level claimed vs actually earned.
- Reproducibility of the published npm artifact vs the tagged source.

### 3.4 Correctness of the retrieval logic (the product's core value)
- RRF fusion math, graph-boost, reranker score handling, HNSW recall/k-multiplier/adaptive-refill, int8 quantization round-trip, chunking + late-chunking offsets, FTS5↔embed-db chunk-identity alignment, the K-1 "embedder thread-through" invariant (a historical data-corruption class — verify it holds at every `new EmbedDb`/`FtsIndex` site).
- Any path where a query could silently return wrong/empty results instead of erroring.

### 3.5 CI/CD, tests & structural defenses
- Are the 9 required CI gates real and enforced? Is the test suite meaningful or are there vacuous/always-pass tests, silent skips, or coverage-gaming? (The project claims every invariant test has a real NEGATIVE control enforced by a meta-invariant — verify that meta-invariant is itself sound, not vacuous.)
- Per-file coverage floors: honest, or set artificially low to mask 0% coverage on a critical module?
- The `scripts/oia-walk.mjs` "Outside-In Audit" (11 checks) and `check-version-consistency.mjs` / `docs-consistency.test.ts` — do they actually catch what they claim?

### 3.6 Documentation & claims accuracy (state-driven — read every claim, verify against reality)
- Every **numeric** claim (test count, tool count, prompt count, CI-gate count, OIA-check count, per-file-floor count, language count, benchmark numbers) against its source of truth.
- Every **enforced-guarantee** claim ("blocked", "zero outbound", "fails closed", "SLSA Lx", "atomic", "validated before") — point to the code guard or flag it as an overclaim. This is the project's most-tracked defect class; find any that slipped.
- Currency/version drift, broken links (especially packaged-doc links that 404 in the npm tarball), feature-mention drift (shipped-but-undocumented or documented-but-absent — e.g. confirm every CLI subcommand referenced in docs actually exists).
- The GitHub repo **About** description + Topics (live metadata, outside the repo files) — verify against reality too.

### 3.7 Performance, scalability & reliability
- Cold-build and warm-query behavior, memory ceilings (caches, indexes) at 100K+ notes, the brute-force-vs-HNSW threshold, watcher behavior under bulk file moves / folder renames, crash-safety of HNSW persistence (write-order, signature cross-check, recovery paths).

### 3.8 MCP protocol compliance
- Tool/resource/prompt spec conformance, `inputSchema` coverage, annotations (`readOnlyHint`/`destructiveHint`), JSON-RPC error codes, stdio cleanliness (no stray stdout), streamable-HTTP semantics, session lifecycle.

---

## 4. Deliverable — the report

A single written report (markdown preferred). Structure suggestion:
1. **Executive summary** + overall verdict (is it production-ready? what's the risk profile per category?).
2. **Findings**, each with: a stable ID, **severity** (Critical / High / Medium / Low), **`file:line` verified at commit `7a479bb`**, a one-line title, concrete **evidence** (the offending code + why it's wrong, ideally a reproduction), and a **recommended fix** (described, not applied).
3. **What you verified as sound** (so we know coverage was real, not skipped).
4. **Areas you could NOT fully assess** and why (so gaps are explicit, not silent).

Severity guidance: reserve **Critical** for remotely-exploitable or data-loss/corruption defects; **High** for real security/correctness bugs with a plausible trigger; don't inflate governance/style items into High.

**Methodology note we value:** different audit methodologies find non-overlapping defects. A *change-driven* read (what changed) and a *state-driven* read (every file as it exists) and an *adversarial/threat-model* read (STRIDE, attacker scenarios) each catch things the others miss. A from-scratch audit should use all three. Prior rounds proved this: the threat-model/privacy lens found real bugs that line-by-line review had missed for many releases.

---

## 5. Out of scope (do not report as defects)
- **Do not change anything** — no edits, PRs, commits, settings, or "I went ahead and fixed…". Report only.
- LLM prompt injection via vault *content* is a structural property of all RAG (the agent reads notes); note it once if you like, but it is not a code defect to fix here.
- Repository **branch-protection / required-reviews / admin-bypass** settings are known and maintainer-gated; you may note them once but they are not code findings.
- Pure style/lint preferences (biome already gates these). Refactor suggestions are welcome but should be clearly labeled non-defects.
- Features the project deliberately does NOT have (multi-vault, OAuth, live-Obsidian-REST integration, Bases formula evaluation) — these are documented non-goals, not gaps.

---

## 6. Reproduce locally

```bash
git clone https://github.com/oomkapwn/enquire-mcp.git
cd enquire-mcp
git checkout 7a479bbbaeec6321fd5535eaff23cf3ca66caa24   # the pinned audit target
npm ci
npm run build            # tsc → dist/
npm test                 # full suite (~1024 it(), ~12s)
npm run test:coverage    # global + per-file floors
npm run check:oia        # state-driven drift scan (11 checks)
node scripts/check-version-consistency.mjs   # 7-surface version sync
npm run smoke 2>/dev/null || node scripts/smoke.mjs   # JSON-RPC smoke vs synthetic vault
```

Optional-dep paths (embeddings/reranker/HNSW/PDF/OCR) require `better-sqlite3`, `@huggingface/transformers`, `hnswlib-node`, `pdfjs-dist`, `tesseract.js`, `@napi-rs/canvas` — installed via `npm ci` (they're optionalDependencies). `enquire-mcp setup --vault <path>` does zero-touch model download + index build; `enquire-mcp doctor --vault <path>` reports what's available.

---

## 7. Why this audit matters to us

The project's North Star is "the most reliable, technically-best Obsidian MCP." A clean from-scratch external pass on a pinned commit — with findings verified against current code — is the gate for promoting `v3.9.0` from `@rc` to `@latest` (our policy requires ≥2 independent external auditors with **different** methodologies). The most useful outcome is either a defensible "no remaining Critical/High defects at `7a479bb`" — or, better, the specific defects that prove otherwise. Be thorough; be adversarial; verify everything; change nothing.
