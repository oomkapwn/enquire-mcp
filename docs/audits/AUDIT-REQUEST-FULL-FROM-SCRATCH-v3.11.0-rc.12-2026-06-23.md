# External Audit Request — enquire-mcp v3.11.0-rc.12 (FULL, from scratch)

**Status:** OPEN — commissioned for the **v3.11.0 → `@latest` promotion gate**.
**Date issued:** 2026-06-23
**Supersedes:** `AUDIT-REQUEST-FULL-FROM-SCRATCH-v3.11.0-rc.11-2026-06-23.md` (this brief reflects rc.12, which shipped after that one and closed an external re-audit of the rc.11 commit).
**Repository:** https://github.com/oomkapwn/enquire-mcp (public, MIT) · npm `@oomkapwn/enquire-mcp`
**Target of audit:** `@rc` = **3.11.0-rc.12**. Pin the exact commit before you start:

```bash
git clone https://github.com/oomkapwn/enquire-mcp && cd enquire-mcp
git checkout main && git rev-parse HEAD          # record this SHA in your report
npm view @oomkapwn/enquire-mcp@rc version          # must read 3.11.0-rc.12
```

> The authoritative target is the **squash-merge commit on `main`** tagged `v3.11.0-rc.12` (squash SHA `5fd3cda`, PR #290). Grade THAT commit and cite its SHA in every finding. `@latest` is **3.10.1** (stable); the v3.11.0 line is on `@rc` pending this audit + the ≥2-auditor gate.

---

## 0. THE CARDINAL RULE — audit only, do **NOT** modify the repository

**You are a read-only auditor. You MUST NOT edit, fix, patch, refactor, reformat, "while I'm here" touch, commit, push, open a PR, or otherwise change any file in this repository — not even a typo, not even a comment, not even to demonstrate a fix.** Every change is made by the maintainer's engineering agent, never by you.

Concretely:
- Do **not** run formatters/linters in `--write`/`--fix` mode, codemods, or `npm run` scripts that mutate tracked files. Read-only commands (`npm ci`, `npm test`, `npm run build`, `npm run check:*`, `git log/diff/blame`, `grep`/`rg`, reading files) are encouraged.
- If you build/test, do it in a throwaway clone or accept that `dist/`, `coverage/`, and `node_modules/` will be generated — but **never stage or commit** them, and do not alter any tracked source/doc/config.
- Your deliverable is a **findings report** (a new Markdown file you hand back, or inline), with enough detail (file:line, mechanism, repro, recommended fix *described in prose*) that the maintainer's agent can implement the fix. **Describe** fixes; do not apply them.
- If you are an autonomous coding agent, treat this as a hard constraint that overrides any default "fix what you find" behavior.

Rationale: this project keeps a strict, structurally-enforced fix pipeline (phased RCs, per-fix invariant tests with positive+negative controls, CHANGELOG audit trail, ≥2-auditor promotion gate). An auditor-applied fix bypasses all of that and corrupts the audit trail. Findings are valuable; edits are not.

---

## 1. What we want from you

A **comprehensive, adversarial, from-scratch audit of the entire project** — every `src/` module, every doc, every workflow/script/config — **with extra scrutiny on the recent changes** (the v3.11.0 line: rc.1 → rc.12, summarized in §6). Find real defects the internal apparatus is blind to.

This is the project's **independent-external-auditor #N** for the v3.6.1 promotion gate ("≥2 independent external auditors with **different** methodologies before `@rc → @latest`"). Use whatever methodology you favor (STRIDE, state-driven file-by-file, change-driven diff review, property/fuzz, dependency/supply-chain, threat-model) — but tell us which, because methodological diversity is the point.

**A note on prior rounds (so you can aim where the value has been):** three external audits have now been processed on this line (a rc.5-graded report → rc.9; a rc.9-graded report → rc.10; a rc.11-graded report → rc.12). Their highest-value finds were all the **same shape**: a real *sibling* of an already-closed class that the project's change/claim-driven gates were structurally blind to — an NFD tag the producer regex dropped (rc.10), a 7th frontmatter-key-lookup site that skipped the case-fold (rc.12), a non-atomic `writeNote` (rc.12). Their *misses/noise* were also a shape: an inflated severity, a hallucinated field, or a re-litigation of a documented convention. **We want the genuine sibling-of-a-class finds; we will adversarially re-verify every severity and every "this field exists" claim, so precision matters.**

**Two things we value most:**
1. **Behavioral / runtime / concurrency / encoding / write-fidelity defects** — see §4 for where the internal gates are *structurally blind*. That's the highest-yield territory.
2. **Adversarial re-verification of the maintainer's own recent verdicts** — especially the rc.12 fixes (§6.6) and the rc.11-audit rejections we did NOT act on (§6.7). We explicitly invite you to try to prove us wrong.

---

## 2. Project overview (so you can reason about impact)

**enquire-mcp** is a TypeScript **Model Context Protocol (MCP) server** that turns a local Obsidian (Markdown) vault into a long-term, *grounded* memory/retrieval layer for AI agents. Local-first, vendor-neutral, **zero outbound network calls in `serve` mode** (a load-bearing privacy claim — verify it). Distinct from chat-memory tools (mem0/Zep/Supermemory): it recalls the Markdown the user actually wrote — cited, auditable, editable — never a paraphrase.

- **Scale:** 40 `src/*.ts` modules (~5,100 source lines), **46 MCP tools** (34 always-on read + 4 opt-in diagnostic + 7 write gated by `--enable-write` + 1 feedback gated by `--feedback-weight`), **19 MCP prompts**, 3 resources. **80 test files / 1365 canonical `it()`** (data-driven loops expand the runtime count higher, ~1462); 19+ `*-invariant.test.ts`; 16 `scripts/*.mjs`; 4 GitHub workflows.
- **Retrieval stack:** BM25 (SQLite FTS5) + TF-IDF + dense ML embeddings (transformers.js, int8-quantized), RRF-fused, BGE cross-encoder rerank, HNSW ANN (live-update + disk persistence), wikilink graph-boost, GraphRAG-light (Louvain communities), HyDE + sub-question, Obsidian Bases (`.base`) DSL, PDF text + OCR (Tesseract). Forgetting-aware staleness (`age_days`/`stale`, opt-in recency re-rank). Closed-loop feedback (`obsidian_mark_useful`, opt-in).
- **Transports:** stdio + Streamable HTTP (bearer auth, rate-limit, CORS). The HTTP path is the **remote attack surface** — anything an authenticated MCP client can reach over `serve-http` is in scope for DoS / info-leak / corruption.
- **Optional deps (6):** `@huggingface/transformers`, `@napi-rs/canvas`, `better-sqlite3`, `hnswlib-node`, `pdfjs-dist`, `tesseract.js`. The server must degrade gracefully (fail-soft) when any are absent.
- **Threat model (single-user, local vault):** the vault owner is trusted; the *agent/MCP client* is semi-trusted (could be driven by untrusted content the user pasted); on `serve-http`, a bearer-authenticated client is the adversary for DoS/leak. Note files themselves may contain adversarial content (prompt-injection text, pathological regex/markdown, hostile frontmatter, NFD-decomposed Unicode).

Authoritative docs to read first: `README.md`, `CLAUDE.md` (the maintainer's North-Star + the running anti-pattern ledger — read this; it tells you the project's own list of recurring failure classes), `SECURITY.md`, `STABILITY.md` (the semver contract), `docs/api.md`, `CHANGELOG.md` (esp. the rc.1→rc.12 entries).

---

## 3. Codebase map (every module + its role)

Read each. Cross-reference TSDoc claims against implementation (TSDoc-vs-reality drift is a documented recurring class).

| Module | Role / what to scrutinize |
|---|---|
| `index.ts` | entrypoint, `VERSION`, CLI dispatch |
| `cli.ts`, `cli-help.ts` | arg parsing, all subcommands + flag help (cli-parity invariants exist); `setEmbeddingsOffline` on serve + serve-http |
| `server.ts` | stdio server wiring, `prepareServerDeps`, boot-time bulk index build, signal/shutdown orchestration |
| `http-transport.ts` | **remote surface** — bearer auth, rate-limit, CORS, stateful session registry, `pendingInits`/`inFlight` refcounts, graceful shutdown |
| `shutdown.ts` | signal-driven teardown ordering |
| `tool-registry.ts`, `tool-manifest.ts` | tool registration + gating (the single source of truth for the 46-tool count + `readOnlyHint`); `MAX_QUERY_LEN`/`MAX_TAG_ARG_LEN` input caps (rc.11/rc.12) |
| `prompts.ts` | 19 MCP prompts |
| `vault.ts` | **core FS boundary** — path traversal guards, `*Safe` fs wrappers (abs-path-leak sanitizer), **atomic create/overwrite (`writeNote` tmp+rename, rc.12) / rename / append**, privacy filter (`--exclude-glob`/`--read-paths`), `isExcluded`, `globToRegex` (non-backtracking matcher), NFC name folding entrypoints |
| `name-fold.ts` | **canonical Unicode folders** `foldName`/`foldTag`/`nfcLower`/`nfc` + `lookupFoldedKey` (case/NFC-insensitive frontmatter KEY lookup) |
| `parser.ts` | frontmatter+body split, wikilink/embed/tag extraction (`INLINE_TAG_RE`, NFC-before-match), `bodyStartLine` |
| `frontmatter.ts` | js-yaml@5 parse/stringify port (replaced gray-matter rc.53; YAML 1.2 scalar contract, `coerced` flag, dates load as strings) |
| `tools/read.ts` | always-on read tools (list/search/neighbors/stats/tags/chat-thread/frontmatter); `frontmatter_get`/`frontmatter_search` via `lookupFoldedKey` |
| `tools/write.ts` | `--enable-write` tools (create/append/rename/replace/archive/frontmatter_set/validate_note_proposal); backlink-rewrite plan; write-fidelity |
| `tools/search.ts` | hybrid search orchestration, RRF, rerank, graph-boost, recency, `filter_frontmatter` (key-fold), adaptive HNSW refill, privacy-filter terminal pruning; `searchText` scan cap |
| `tools/meta.ts` | `obsidian_open_questions` (ReDoS-sensitive; worker sink-bound), `lint_vault_wiki` (orphans/broken/stub/**stale**/concepts — the stale pass reads `last_reviewed` via `lookupFoldedKey`, rc.12 H-2), tag suggest, paper audit, `findBestMatch`, `validateNoteProposal` (`yaml.coerced`) |
| `tools/media.ts` | `read_canvas`, `read_pdf`, `ocr_pdf`, list-pdfs/canvases/bases |
| `tools/limits.ts` | `capScanEntries` resource cap |
| `dql.ts` | Dataview-query subset parser+executor (always-on, remote-reachable); `MAX_DQL_QUERY_LEN`; non-backtracking LIKE matcher; NFC value/tag/key folding |
| `bases.ts` | Obsidian Bases `.base` DSL parser+executor (always-on, remote-reachable); predicate eval; NFC folding; resource caps |
| `communities.ts` | Louvain community detection, wikilink graph |
| `embeddings.ts` | transformers.js embedder/reranker, per-alias session cache, **offline enforcement** (`setEmbeddingsOffline` + exported `applyOfflineEnv`) |
| `embed-db.ts`, `embed-pipeline.ts` | SQLite embed store (`peekEmbedDbMeta` never-throw peek), chunking, upsert/delete, signatures |
| `fts5.ts` | SQLite FTS5 index (`peekFtsMetaSafe` never-throw peek), tokenization, escaping, persisted tag column |
| `hnsw.ts` | hnswlib-node wrapper — `applyDiff`/`resize`/`capacity`, disk persistence, signature-guard rebuild |
| `wildcard-match.ts` | non-backtracking DP matcher backing LIKE + glob (the ReDoS class-ender) |
| `optional-dep.ts` | `optionalDepDetail` — strips abs paths from optional-dep load errors (leak class) |
| `pdf.ts`, `ocr.ts` | pdfjs + Tesseract; resource cleanup (try/finally), canvas-OOM cap, OCR offline enforcement, page-range arithmetic |
| `staleness.ts` | `computeStaleness`/`recencyScore` (forgetting-aware) |
| `feedback.ts` | `FeedbackStore` (per-vault sidecar, null-proto map), persistChain serialization, scoring |
| `retrieval-opts.ts` | shared serve/serve-http retrieval flag parsing + validation |
| `rrf.ts`, `periodic.ts`, `eval.ts`, `doctor.ts` | RRF fusion; periodic-notes date tokens; eval harness; `doctor` health check |

---

## 4. Where the internal apparatus is **blind** — aim here

The project has 12 OIA checks (`scripts/oia-walk.mjs`) + 19+ invariant tests. Per the maintainer's own meta-audit (CLAUDE.md, "rc.36"), **~85% of these are drift/claim-driven** — they verify that a *doc claim* matches a number/version/string. They are **structurally blind** to:

1. **Concurrency / shared-mutable-state interleave** — async chains mutating shared singletons (watcher HNSW index + `rowsByLabel`, the shared `FeedbackStore`, the HTTP session registry, embed-db connections). A real interleave passes every gate.
2. **Runtime DoS / algorithmic complexity** — O(n²)/O(K×N) amplifiers, unbounded scans, ReDoS, OOM, on always-on **remotely-reachable** tools. rc.11/rc.12 added `.max()` caps + a `searchText` scan cap — verify completeness; find a remote string still reaching a superlinear sink uncapped.
3. **Encoding correctness** — Unicode NFC/NFD on macOS APFS (names, tags producer+consumer, frontmatter keys+values), surrogate splitting, case-folding under the sink's actual flags. rc.12 wired the **7th** frontmatter-key-lookup site (`lint_vault_wiki` staleness) — **is there an 8th key read by raw string, or a different identity surface still unfolded?**
4. **Info-disclosure** — absolute host paths / cache layout leaking to a bearer-auth client via error messages. The rc.11-audit's own re-analysis confirmed the path-escape throw echoes *user* input, not the host path (no leak) — verify that holds and that no OTHER error path leaks `this.root`/cache/home.
5. **Claimed-guarantee vs. code-guard** — any "blocked"/"zero outbound"/"fails closed"/"never throws"/"SLSA L2"/"enforced"/"throws if" claim must point at a real guard. (rc.12 added the offline-enforcement *wire-up* test; the claim now has a behavioral check — confirm it's not test-theater.)
6. **Right-to-erasure / data-at-rest** — every on-disk artifact a writer creates (caches, sidecars, FTS/embed/HNSW/feedback files, `.tmp` leftovers — **note `writeNote` now creates a `<name>.md.tmp` mid-write; confirm it's never left behind, never indexed, never leaked**) must be erased by `prune`/`clear-*`.
7. **Write-fidelity / data-loss** — create/rename/append/replace/frontmatter_set under edge cases. **rc.12 made `writeNote` overwrite atomic (tmp+rename, preserving the dest's mode); scrutinize it hard** — see §6.6.
8. **Test-theater** — tests that pass without exercising the code they claim to; a behavioral test that doesn't *generate the failing input shape* (the project's repeated "generator-blindspot"). When you assess a behavioral test, ask "can its inputs even produce the bug it claims to guard?"

These eight are the maintainer's own enumerated blind spots. The most valuable findings live here.

---

## 5. Baseline — reproduce the green state, then go beyond it

```bash
npm ci
npm run build                 # tsc strict + noUncheckedIndexedAccess
npm test                      # ~1365 it() (+ data-driven expansion to ~1462)
npm run test:coverage         # per-file floors; regenerates coverage/coverage-summary.json
npm run lint                  # biome, 0 findings
npm run check:version-consistency   # 7 surfaces + CLAUDE roll-up marker
npm run check:oia             # 12 state-driven walks
node scripts/check-audit.mjs  # scoped npm-audit gate (ALLOWLIST is empty = strictest)
node scripts/smoke.mjs        # synthetic-vault tools/list + initialize
npm pack --dry-run            # packaged file set
```

All expected to pass on rc.12. If any fails on a clean checkout, that itself is a finding. Then audit beyond what these check.

---

## 6. Recent changes — audit these hardest (v3.11.0 line, rc.1 → rc.12)

Read the CHANGELOG entries for each. Treat all of this as fresh, possibly-under-baked code.

### 6.1 rc.1 — closed-loop feedback (`obsidian_mark_useful`), 46th tool — `src/feedback.ts`
Opt-in (`--feedback-weight <0..1>`, default 0). Per-vault `<hash>.feedback.json` sidecar (relative paths + integer counts + ISO ts ONLY — **no note content, no query text**; 0600; atomic tmp+rename; cap 100k). Shared across HTTP sessions. **Scrutinize:** data-at-rest claims, `record()` read-modify-write under concurrent serve-http calls (persistChain), prune-erasure, the `readOnlyHint:false` K-3 classification, the null-proto map (rc.8 fixed a prototype-pollution here — verify complete + no sibling).

### 6.2 rc.6 — `js-yaml` 4 → 5 migration — `src/frontmatter.ts`, `src/bases.ts`
YAML 1.2; dates load as **strings** (not Date); `load("")` throws; merge-key `<<` removed. **Scrutinize:** frontmatter round-trip fidelity (a `frontmatter_set` on one key must not mutate/reformat others), scalar resolution edge cases, `.base` parse of empty/odd YAML, merge-key-DoS genuinely gone at root.

### 6.3 rc.5 — dependency majors — `@types/node` 26, `actions/checkout` 7 (js-yaml@5 was rc.6)
Verify SHA-pins on all GitHub Actions are correct + comments match; `npm audit` clean (scoped gate allowlist empty).

### 6.4 rc.8/rc.9/rc.10/rc.11 — prior self- + external-audit responses (lineage)
- **rc.8** — prototype-pollution in `feedback.ts` (agent path keys → `Object.create(null)`); DQL frontmatter-value NFC; `renameNote` case-variant dest-exclusion; CITATION drift.
- **rc.9** — NFC-**tag** class (consumer side) + value siblings; folder/key folding.
- **rc.10** — NFC-tag **producer** regexes (dropped `\p{M}` combining marks, corrupting the persisted FTS5 tag column) + frontmatter **KEY** fold (`lookupFoldedKey` at 6 sites).
- **rc.11** — DoS input caps (`.max()` on free-form query/tag) + `searchText` scan cap + `validate_note_proposal` `yaml.coerced` surface.

### 6.5 rc.12 — external re-audit (rc.11 report) response — **re-verify these fixes adversarially**
A third external auditor graded the rc.11 commit; the maintainer re-verified each finding (workflow, verify + 3-skeptic) and shipped 4. **Independently re-check:**
- **H-2 (the 7th key-lookup site) — `meta.ts` `lint_vault_wiki` stale pass.** Was reading `frontmatter.last_reviewed` by RAW exact string; now routes BOTH `last_reviewed`/`last-reviewed` through `lookupFoldedKey` (case+NFC fold; the `_`/`-` spelling alias preserved). **Verify:** is EVERY frontmatter-KEY read across the codebase now folded — or is there an **8th** site (grep `frontmatter\.\w+` / `frontmatter\?\.\[` for raw reads of a *specific* property name)? Does the fix preserve the documented behavior (a genuinely-recent `last_reviewed` value wins over an old mtime; an absent key falls back to mtime)? The new regression guard is deliberately NARROW (it asserts meta.ts doesn't read that one key raw) — is that the right scope, or should the maintainer accept the broad-detector false-positive cost?
- **L-7 (atomic `writeNote`) — `vault.ts`.** Overwrite now writes `${abs}.tmp` then `rename(2)`s over the target, **preserving the destination's existing mode** (a brand-new path gets default perms). **Challenge this hard:** (a) any window where a concurrent reader/watcher sees the `.tmp` or a missing target? (b) is the `.md.tmp` truly never matched by the watcher glob / walker / FTS indexer / privacy filter? (c) is a stale `.tmp` ever left behind (the catch unlinks best-effort — what if unlink fails)? (d) does the mode-preservation `statSafe(abs).catch(()=>null)` correctly handle a brand-new path (no stat) vs an existing one? (e) the `overwrite=false` path still uses `wx` (unchanged) — confirm no regression to the exclusive-create + symlink-refusal + privacy-filter ordering. (f) cross-device: the tmp sits in the same dir as the target, so rename is same-filesystem — confirm there's no path where it isn't.
- **L-2 (offline wire-up test) + I-1 (`replace_in_notes` caps)** — `applyOfflineEnv` exported + a mock-mod test asserts `env.allowRemoteModels=false`; `.max(MAX_QUERY_LEN)` on `replace_in_notes` search/replace. Verify the test isn't theater and the caps are correct.

### 6.6 rc.12 — verdicts we did NOT act on — challenge the rejections (with a repro if you disagree)
- **L-1 (auditor's `obsidian_paper_audit.tag_filters` array without per-item cap) → REJECTED as a FALSE POSITIVE:** we found **no `tag_filters` field anywhere** in the codebase (paper_audit has only `tag`/`folder`/`limit`). If you can point to such a field, escalate; otherwise confirm it doesn't exist.
- **L-5 (README "1365 tests" vs runtime ~1462) → REJECTED as KNOWN-WAI:** `1365` is the deliberate **source-`it()`** count gated by `docs-consistency.test.ts`; the runtime is higher due to data-driven `for(…) it(…)` loop expansion. The identical "overclaim" was rejected on a prior Mavis HIGH (rc.35). Challenge only if you think the *convention itself* is wrong (and say why).
- **L-6 (path-escape throw consistency / `PathEscapeError` wrapper across 14 read tools) → ACCEPTED-as-is:** the auditor's own re-analysis confirmed the throw echoes *user* input, not the host path (zero leak); a structured-error refactor is consistency-only. Challenge only if you find an actual host-path leak.
- **L-3 / L-4 / M-1 (broaden the feedback-concurrency / producer-completeness / abs-path-leak detectors) → DOCUMENT-ACCEPT:** rc.4 already mutation-verified the feedback test; broadening the detectors adds false-positive surface for zero current risk (per the rc.39 "don't chase EDA-precise detection" rule). Challenge only if you find a *live* bug the current detectors miss.

### 6.7 The verdict we most want re-challenged (carried from rc.9)
**T-MED-1 — "the watcher HNSW critical section is fully synchronous, so cross-file events cannot interleave."** Pinned by `tests/hnsw-sync-critical-section.test.ts` (no `await` in the critical section). **Challenge hard:** is `HnswIndex.applyDiff` + `watcher.syncHnswForFile` truly await-free on every path (md / pdf / unlink)? Any interleave / lost-update window between embed-db upsert, HNSW apply, the shared `rowsByLabel` mutation, and the close-time disk flush — or against a second writer?

### 6.8 Cross-cutting recent surfaces
9-language READMEs (rc.2/i18n — anchor integrity + per-language numeric claims), forgetting-aware staleness, frontmatter-aware `filter_frontmatter` search.

---

## 7. Comprehensive coverage checklist (by class)

For each class: fully closed, or an uncovered sibling/surface? (The project's signature failure mode is "instance fixed, adjacent sibling missed" — see rc.9→rc.10→rc.12.)

- [ ] **STRIDE / security:** auth (bearer `timingSafeEqual`, min-length ≥16), rate-limit, CORS (expose/allow headers), path traversal, symlink escape, input validation (zod `.max()` on every remotely-reachable string), injection (FTS5/SQL/DQL/glob), prototype pollution.
- [ ] **ReDoS / catastrophic backtracking:** every `new RegExp` from user/agent/config input. The non-backtracking DP matcher + the worker sink-bound are the class-enders — find a sink they don't cover.
- [ ] **Unicode / NFC / encoding:** names, tags (producer+consumer), frontmatter keys (7 sites — is there an 8th?) + values, DQL/bases field names, surrogate splitting, case-fold under `/i`/`/u`.
- [ ] **Concurrency:** every long-lived shared-mutable singleton — serialized or provably interleave-safe? (watcher HNSW/rowsByLabel/embed-db [§6.7], FeedbackStore, SessionRegistry, module caches.)
- [ ] **Resource / DoS caps:** every always-on whole-vault scanner CAP-or-EXEMPT; per-request amplifiers; canvas/PDF/OCR memory caps; HNSW growth; every remote free-form string `.max()`-capped.
- [ ] **Info-disclosure:** every error reachable by a serve-http client is abs-path-free. Force the error paths.
- [ ] **Optional-dep leaks:** every `await import()` funnels load errors through `optionalDepDetail`.
- [ ] **Right-to-erasure / data-at-rest:** writers ⊆ erasers for every cache/sidecar/`.tmp` (incl. the new `writeNote` `.md.tmp`); no raw note text survives `prune`/`clear-*`.
- [ ] **Write-fidelity / data-loss:** create/rename/append/replace/frontmatter_set atomicity (rc.12 `writeNote` tmp+rename — §6.6) + edge cases; line-number arithmetic; backlink-rewrite; case-insensitive FS; non-mapping frontmatter (`coerced`).
- [ ] **Claimed-guarantee vs code-guard:** "zero outbound in serve" (embeddings/reranker/OCR offline enforcement + the rc.12 wire-up test), SLSA L2, fail-closed `.base` predicates, `*Safe`/peek never-throw, "fails closed" privacy filter.
- [ ] **MCP contract:** `readOnlyHint` correctness (K-3: every fs/state mutator — incl. `markUseful` — in `KNOWN_WRITE_HANDLERS`), tool schemas, error shapes, stateful session lifecycle.
- [ ] **Supply-chain:** SHA-pinned actions + correct comments; `run:`-download content-pinning; `overrides`; `check-audit.mjs` allowlist (empty); phantom/undeclared deps; `files[]` accuracy.
- [ ] **Docs / claim-vs-reality:** counts (46 tools / 19 prompts / 1365 tests) across README ×9, llms.txt, AGENTS.md, STABILITY, COMPARISON, api.md, server.json, CITATION; version currency; CLI flag docs vs real `.option()`s; README anchor integrity; TSDoc-vs-impl drift.
- [ ] **Test/CI integrity:** no silent-skip on security surfaces; no vacuous/test-theater; every `*-invariant.test.ts` has a real NEGATIVE control; behavioral tests *generate the failing input shape*; coverage floors honest; flake-blocks-release risks.
- [ ] **Retrieval correctness:** RRF, rerank, graph-boost, recency blend, `filter_frontmatter` (key-fold), chunking parity (FTS5 vs embeddings), HNSW under-return, eval metric correctness.

---

## 8. Specific high-value questions we most want challenged

1. Can a **bearer-authenticated serve-http client** hang the event loop or exhaust memory through any always-on tool (`dataview_query`, `query_base`, `open_questions`, `search`, `read_canvas`, `validate_note_proposal`, `read_pdf`/`ocr_pdf`)? Concrete repro.
2. Is the **NFC class now complete** across ingest→store→compare (names, tags, frontmatter keys [7 sites]+values), or is there an **8th** raw frontmatter-key read / another identity surface?
3. Is the **rc.12 atomic `writeNote`** correct under every edge case (§6.6 a–f) — concurrent readers, watcher seeing the `.tmp`, stale `.tmp` on unlink failure, mode preservation, `wx`/symlink ordering, cross-device)?
4. Is the **T-MED-1 "synchronous HNSW critical section" claim** airtight (§6.7)?
5. Is the **prototype-pollution fix** (rc.8) complete, and is `feedback.ts` truly the only tool turning agent strings into object keys?
6. Does **any** error message reachable over serve-http leak an absolute host path or cache layout?
7. Is **"zero outbound in serve mode"** genuinely enforced for embeddings, reranker, AND OCR — including cache-miss paths?
8. Any **test-theater** — a test (especially a security/invariant test or the rc.12 H-2 regression guard / L-2 wire-up test) that would still pass if the code it guards were broken, or whose inputs can't produce the bug it claims to guard?

---

## 9. Out of scope / known-accepted (do not re-flag as new — but DO challenge the acceptance if you disagree)

- **R-10 HNSW under-return** at >66%-excluded result sets — documented residual, accepted.
- **js-yaml alias/anchor "billion-laughs"** not specifically rejected — bounded by the single-user local-vault threat model (SECURITY.md). Merge-key DoS is gone (v5).
- **Bases `.base` frontmatter equality is case-SENSITIVE** by design (mirrors Obsidian Bases); NFC-normalized but case-preserving — intentional.
- **DQL LIKE Unicode case-fold** uses `String.toLowerCase()` (not full ECMAScript canonical fold) — documented contract (rc.75); under-matches ~22 exotic codepoints, never over-matches.
- **`capacity()`/`resize()`** are orphaned (test-only) HNSW API — INFO/WAI.
- **rc.12 reasoned-rejections (§6.6):** L-1 (the `tag_filters` field does not exist — hallucinated), L-5 (source-`it()` count convention), L-6 (path-escape throw echoes user input, zero host-path leak), L-3/L-4/M-1 (detector-scope, zero current risk). Escalate with a repro if you disagree.
- **The `_` vs `-` spelling distinction** in folded keys (`last_reviewed` ≠ `last-reviewed` under the fold; both checked explicitly) — intentional (the fold normalizes case + Unicode form, NOT spelling/separator).
- **Maintainer-only items** (branch protection, required-review settings, registry-side metadata) — out of the code auditor's scope; flag but don't expect a code fix.

If you believe any "accepted" item is actually exploitable, **escalate it with a repro** — accepted ≠ immune.

---

## 10. Deliverable format

Hand back a Markdown report (do not commit it to the repo). For each finding:

```
### <ID> (<CRITICAL|HIGH|MEDIUM|LOW|INFO>) — <one-line title>
- **File:line:** src/foo.ts:123 (cite the graded commit SHA)
- **Class:** <security|concurrency|resource-DoS|encoding|info-leak|write-fidelity|claim-vs-reality|supply-chain|docs|test-integrity|...>
- **Mechanism:** precise control/data-flow explanation (why it's wrong)
- **Reachability:** local-only | serve-http bearer-reachable | CLI | watcher | build-time; and which tool/flag gates it
- **Repro:** concrete steps / input that triggers it — empirical beats theoretical
- **Blast radius / impact:** what actually breaks (DoS, data-loss, leak, wrong result, crash)
- **Recommended fix (DESCRIBE, do not apply):** prose; root-cause fix + any sibling sweep + a structural defense (invariant) if applicable
- **Confidence:** high / medium / low; note if you could not run it
```

Plus: an executive summary (counts by severity), the **methodology you used** (for the diversity gate), the **commit SHA you graded**, and an explicit statement of any finding where you **re-verified and DISAGREE with the maintainer's rc.10/rc.11/rc.12 verdict**.

**Severity rubric:** CRITICAL = remote/unauth code-exec, silent data-loss, or trivially-remote DoS; HIGH = bearer-reachable DoS/leak/data-loss, or a broken security guarantee; MEDIUM = bounded/conditional version of those, or a real correctness bug; LOW = narrow/edge-case correctness or hardening; INFO = doc/claim drift, dead code, style with a correctness angle. **Calibrate carefully** — a prior round inflated a correctness-on-opt-in-convention bug to HIGH; we re-graded it LOW. State your severity *and* its justification so we can re-verify both.

Per-item re-verification against the graded commit is expected — stale findings (re-flagging something already fixed in rc.1→rc.12) and false positives (e.g. a field that doesn't exist) both reduce signal; when uncertain, say so and show your repro attempt.

Thank you. Findings are the deliverable; the maintainer's agent implements every fix.
