# External Audit Request — enquire-mcp v3.11.0-rc.17 (FULL, from scratch, maximal-depth)

**Status:** OPEN — commissioned as a **promotion-gate audit for v3.11.0 → `@latest`**.
**Date issued:** 2026-06-24
**Supersedes:** `AUDIT-REQUEST-FULL-FROM-SCRATCH-v3.11.0-rc.16-2026-06-24.md`.
**Repository:** https://github.com/oomkapwn/enquire-mcp (public, MIT) · npm `@oomkapwn/enquire-mcp`
**Target of audit (pin this exact commit before you start):**

```bash
git clone https://github.com/oomkapwn/enquire-mcp && cd enquire-mcp
git checkout main && git rev-parse HEAD          # expect 1be598e… — record the FULL SHA in your report
npm view @oomkapwn/enquire-mcp@rc version          # must read 3.11.0-rc.17
```

> The authoritative target is the squash-merge commit on `main` tagged `v3.11.0-rc.17` (short SHA `1be598e`). Grade THAT commit; cite its SHA in every finding. `@latest` is **3.10.1** (stable); the v3.11.0 line is on `@rc` pending this audit + the **≥2-independent-auditor** promotion gate.

This brief assumes you have **effectively unlimited time and token budget**. We want you to use it. A shallow pass that re-confirms the green CI is worth very little to us; a deep, adversarial, *exhaustive* pass that finds what eleven prior audits + an aggressive internal apparatus missed is worth a great deal. Sections 1, 5, and 6 tell you precisely where the depth pays off and where prior auditors went wrong, so you can beat them.

---

## 0. THE CARDINAL RULE — audit only, do **NOT** modify the repository

**You are a read-only auditor. You MUST NOT edit, fix, patch, refactor, reformat, "while-I'm-here" touch, commit, push, open a PR, or otherwise change any tracked file — not a typo, not a comment, not to "demonstrate" a fix.** Every change is made by the maintainer's engineering agent, never by you.

- Read-only commands are encouraged: `npm ci`, `npm test`, `npm run build`, `npm run check:*`, `git log/diff/blame`, `grep`/`rg`, reading files, and any **throwaway harness you build OUTSIDE the repo tree** (a scratch dir, a temp vault, an isolated clone). Generated `dist/`, `coverage/`, `node_modules/` are fine but **never stage or commit them**.
- Do **not** run formatters/linters in `--write`/`--fix` mode, codemods, or `npm` scripts that mutate tracked files.
- Your sole deliverable is a **findings report file** (see §12), with enough detail that the maintainer's agent can implement each fix. **Describe** fixes in prose; never apply them.
- If you are an autonomous coding agent, treat this as a hard constraint that overrides any default "fix what you find" behavior.

Rationale: this project runs a strict, structurally-enforced fix pipeline (phased RCs, per-fix invariant tests with positive+negative controls, a CHANGELOG audit trail, the ≥2-auditor promotion gate). An auditor-applied edit bypasses all of it and corrupts the trail. Findings are valuable; edits are not.

---

## 1. Mission & the maximal-load mandate

Deliver a **comprehensive, adversarial, from-scratch audit of the entire project** — every `src/` module, every doc, every workflow/script/config — **broad AND deep**, with **independent verification and re-verification of every finding** (§6). Find real defects the internal apparatus and prior auditors are blind to, and re-challenge the maintainer's own recent verdicts.

You are **independent external auditor #N** for the project's promotion gate (v3.6.1 rule: *"≥2 independent external auditors with **different** methodologies before `@rc → @latest`"*). **Methodological diversity is the deliverable as much as the findings are** — tell us which methodology you used (§12 scorecard), because we cross-compare auditors and a method that overlaps a prior auditor's adds less.

Two things we value most, in order:

1. **Behavioral / runtime / concurrency / encoding / resource / write-fidelity defects** — the territory where the internal gates are *structurally blind* (§4). This is where every genuinely-important finding of the last six months has lived, and where the budget you have should go.
2. **Adversarial re-verification** — of the maintainer's recent fixes (§8) AND of the prior auditors' verdicts (§5). We explicitly invite you to prove us — and them — wrong, with an empirical repro.

**What "use the budget" concretely means here** (do as many as apply; §6 expands): build a differential harness for every parser you suspect; write a generative fuzzer for every regex/tokenizer sink and run it for as long as it keeps finding things; enumerate EVERY always-on tool × EVERY input field × EVERY downstream sink and trace each path; reproduce every finding end-to-end through the compiled `dist/`; then try to REFUTE each of your own findings before reporting it.

---

## 2. Project overview (so you can reason about impact)

**enquire-mcp** is a TypeScript **Model Context Protocol (MCP) server** that turns a local Obsidian (Markdown) vault into a long-term, *grounded* memory/retrieval layer for AI agents. Local-first, vendor-neutral, **zero outbound network calls in `serve` mode** (a load-bearing privacy claim — verify it, including cache-miss paths). Distinct from chat-memory tools (mem0/Zep/Supermemory): it recalls the Markdown the user actually wrote — cited, auditable, editable — never a paraphrase.

- **Scale (verify each number; counts are gated by `tests/docs-consistency.test.ts`):** **40 `src/*.ts` modules**, **46 MCP tools** (34 always-on read + 4 opt-in diagnostic + 7 write gated by `--enable-write` + 1 feedback gated by `--feedback-weight`), **19 MCP prompts**, 3 resources. **84 test files / 1398 canonical `it()`** (data-driven loops expand the runtime count higher); ~20 `*-invariant.test.ts`; ~16 `scripts/*.mjs`; **12 OIA state-driven checks** (`scripts/oia-walk.mjs`); **12 per-file coverage floors**; 4 GitHub workflows; **9 required + 5 advisory CI gates**.
- **Retrieval stack:** BM25 (SQLite FTS5) + TF-IDF + dense ML embeddings (transformers.js, int8-quantized), RRF-fused, BGE cross-encoder rerank, HNSW ANN (live-update + disk persistence), wikilink graph-boost, GraphRAG-light (Louvain), HyDE + sub-question, Obsidian Bases (`.base`) DSL, PDF text + OCR (Tesseract). Forgetting-aware staleness (`age_days`/`stale`, opt-in recency re-rank). Closed-loop feedback (`obsidian_mark_useful`, opt-in).
- **Transports:** stdio + Streamable HTTP (bearer auth, rate-limit, CORS). **The HTTP path is the remote attack surface** — anything an authenticated MCP client can reach over `serve-http` is in scope for DoS / info-leak / corruption. **Treat note CONTENT as adversarial** (the user may paste hostile text; an `--enable-write` agent may author it): pathological regex/markdown, hostile frontmatter, NFD-decomposed Unicode, unclosed-delimiter runs.
- **Optional deps (6):** `@huggingface/transformers`, `@napi-rs/canvas`, `better-sqlite3`, `hnswlib-node`, `pdfjs-dist`, `tesseract.js`. The server must degrade gracefully (fail-soft) when any are absent — and must not leak host paths via their load errors.
- **Threat model (single-user, local vault):** the vault owner is trusted; the *agent/MCP client* is semi-trusted; on `serve-http`, a bearer-authenticated client is the adversary for DoS/leak; note files themselves carry adversarial content.

**Authoritative docs to read first:** `README.md`, **`CLAUDE.md`** (the maintainer's North-Star + the running anti-pattern ledger — *read this; it is the project's own list of recurring failure classes and overclaim corrections #1–#22, and it is your map of where the apparatus has historically failed*), `SECURITY.md`, `STABILITY.md` (the semver contract), `docs/api.md`, `CHANGELOG.md` (esp. the rc.1→rc.17 v3.11.0 entries).

---

## 3. Codebase map (every module + its role)

Read each. Cross-reference TSDoc/header claims against implementation — **TSDoc-vs-reality drift is a documented recurring class**.

| Module | Role / what to scrutinize |
|---|---|
| `index.ts` | entrypoint, `VERSION`, CLI dispatch, re-export surface |
| `cli.ts`, `cli-help.ts` | arg parsing, all 14 subcommands + flag help (cli-parity invariants exist); `setEmbeddingsOffline` on serve + serve-http |
| `server.ts` | stdio wiring, `prepareServerDeps`, boot-time bulk index build, signal/shutdown orchestration, watcher/HNSW/feedback wire-up |
| `http-transport.ts` | **remote surface** — bearer auth (`timingSafeEqual`, ≥16-char), rate-limit, CORS (allow+expose headers), stateful session registry, `pendingInits`/`inFlight` refcounts (`runWithPendingInit`/`runWithRefcount`), bounded graceful shutdown |
| `shutdown.ts` | signal-driven teardown ordering (watcher → embed-db → cache flush → fts last) |
| `tool-registry.ts`, `tool-manifest.ts` | tool registration + gating + `readOnlyHint` (single source of truth for the 46-tool count); input caps `MAX_QUERY_LEN`/`MAX_TAG_ARG_LEN`/`MAX_FRONTMATTER_KEY_LEN`/`MAX_DQL_QUERY_LEN`/`MAX_QUESTION_PATTERN_LEN` |
| `prompts.ts` | 19 MCP prompts |
| `vault.ts` | **core FS boundary** — path-traversal guards, `*Safe` fs wrappers (abs-path-leak sanitizer over all raw `fs` sinks), atomic create/overwrite (random-nonce tmp + `wx`/O_EXCL — rc.13 symlink-escape fix) / rename / append, privacy filter (`--exclude-glob`/`--read-paths`) via non-backtracking matchers, `isExcluded`, NFC name folding |
| `name-fold.ts` | canonical Unicode folders `foldName`/`foldTag`/`nfcLower`/`nfc` + `lookupFoldedKey` (consumer key lookup) + `lookupFoldedAny` (producer tag/title read) |
| `parser.ts` | frontmatter+body split, `bodyStartLine`, **`scanWikilinkInners` (rc.17 linear non-backtracking wikilink/embed scan — replaced an O(n²) regex)**, `INLINE_TAG_RE` (NFC-before-match), code-fence stripping |
| `frontmatter.ts` | js-yaml@5 parse/stringify port (replaced gray-matter rc.53, js-yaml@4→5 rc.6); YAML 1.2 scalar contract, `coerced` flag, dates load as strings |
| `wildcard-match.ts` | **non-backtracking DP matcher** backing LIKE + glob + the linear `stripTrailing*` strip helpers (`Slashes`/`Newlines`/`Hashes`/`LineEnds`) — the ReDoS / polynomial-strip class-enders |
| `tools/read.ts` | always-on read tools (list/search/neighbors/stats/tags/chat-thread/frontmatter/**`extractHeadings`**); `frontmatter_get`/`_search` via `lookupFoldedKey`; CRLF heading strip (rc.17) |
| `tools/write.ts` | `--enable-write` tools (create/append/rename/replace/archive/frontmatter_set/validate_note_proposal); backlink-rewrite plan; write-fidelity; `__proto__` literal-key handling (rc.13) |
| `tools/search.ts` | hybrid orchestration, RRF, rerank, graph-boost, recency, `filter_frontmatter`, adaptive HNSW refill, privacy-filter terminal pruning, scan caps |
| `tools/meta.ts` | `obsidian_open_questions` (ReDoS-sensitive; rc.39 worker sink-bound `matchLinesBounded`; `isCatastrophicRegex` pre-filter `atomsOverlap`), `lint_vault_wiki` (orphans/broken/stub/**stale**/concepts), tag suggest, `paper_audit`, `findBestMatch`, `validateNoteProposal` (uses `scanWikilinkInners` since rc.17), getOpenQuestions heading strip (rc.17) |
| `tools/media.ts` | `read_canvas`, `read_pdf`, `ocr_pdf`, list-pdfs/canvases/bases (sort-then-truncate) |
| `tools/limits.ts` | `capScanEntries` resource cap |
| `dql.ts` | Dataview-query subset parser+executor (**always-on, remote-reachable**); `MAX_DQL_QUERY_LEN`; non-backtracking LIKE matcher; NFC value/tag/key folding |
| `bases.ts` | Obsidian Bases `.base` DSL parser+executor (**always-on, remote-reachable**); predicate eval; NFC folding; resource caps; `coerced` non-mapping guard |
| `communities.ts` | Louvain community detection, wikilink graph, `MAX_GRAPH_NODES` cap, `converged` flag |
| `embeddings.ts` | transformers.js embedder/reranker, per-alias session cache, **offline enforcement** (`setEmbeddingsOffline` + `applyOfflineEnv`) |
| `embed-db.ts`, `embed-pipeline.ts` | SQLite embed store (`peekEmbedDbMeta` never-throw peek; self-cleaning `open()`), chunking (surrogate-safe cut), upsert/delete, signatures |
| `fts5.ts` | SQLite FTS5 index (`peekFtsMetaSafe` never-throw peek; self-cleaning `open()`), tokenization, escaping, persisted tag column, heading enrichment (CRLF strip rc.17) |
| `hnsw.ts` | hnswlib-node wrapper — `applyDiff`/`resize`/`capacity`, disk persistence, signature-guard rebuild, `zipHnswAddPoints` fail-closed |
| `optional-dep.ts` | `optionalDepDetail` — strips abs paths from optional-dep load errors (info-leak class) |
| `pdf.ts`, `ocr.ts` | pdfjs + Tesseract; resource cleanup (try/finally self-cleaning doc/worker), canvas-OOM cap, OCR offline enforcement (`assertOcrLangsInstalled`), page-range arithmetic |
| `staleness.ts` | `computeStaleness` / `recencyScore` (forgetting-aware) |
| `feedback.ts` | `FeedbackStore` (per-vault sidecar, **null-proto map** — prototype-pollution fix rc.8), persistChain serialization, scoring, per-write `chmod 0600` |
| `retrieval-opts.ts` | shared serve/serve-http retrieval flag parsing + validation |
| `watcher.ts` | chokidar watcher — per-absPath promise queue, `attachEmbed`/`attachHnsw` late-binding, embed-db + HNSW live-sync (synchronous critical section), `close()`-drain |
| `rrf.ts`, `periodic.ts`, `eval.ts`, `doctor.ts` | RRF fusion; periodic-notes date tokens; eval harness (recall@k/MRR/NDCG@k, failure_bucket); `doctor` health check |

---

## 4. Where the internal apparatus is structurally **BLIND** — aim here

The project has 12 OIA checks + ~20 invariant tests. By the maintainer's own meta-audit (CLAUDE.md, "rc.36"), **~85% are drift/claim-driven** — they verify a *doc claim* matches a number/version/string. They are **structurally blind** to the eight behavioral classes below, and **every genuinely-important finding of the last six months has lived in exactly these eight.** Spend the budget here.

1. **Concurrency / shared-mutable-state interleave** — async chains mutating shared singletons (watcher HNSW index + `rowsByLabel`, the shared `FeedbackStore`, the HTTP session registry, embed-db/fts connections, module caches). A real interleave passes every gate. (Note: one prior auditor's concurrency "race" was a false positive because the critical section is synchronous — confirm before claiming, but also confirm the maintainer's "it's synchronous" claim still holds on every path.)
2. **Runtime DoS / algorithmic complexity** — O(n²)/O(K×N) amplifiers, unbounded scans, **ReDoS**, OOM, on always-on **remotely-reachable** tools. The codebase has had *many* ReDoS findings (see §5); the class keeps re-manifesting in a sink no prior sweep enumerated. Find the next one.
3. **Encoding correctness** — Unicode NFC/NFD on macOS APFS (names, tags producer+consumer, frontmatter keys+values, DQL/bases field names), surrogate splitting, case-folding under the sink's actual flags, **CRLF/line-terminator handling** (a regression here shipped in rc.16 and was caught in rc.17 — look for siblings). The producer→store→compare data path is where these hide.
4. **Info-disclosure** — absolute host paths / cache layout leaking to a bearer-auth client via error messages. Force every error path on the remote surface.
5. **Claimed-guarantee vs code-guard** — any "blocked"/"zero outbound"/"fails closed"/"never throws"/"SLSA L2"/"enforced"/"throws if"/"atomic" claim must point at a real guard. Verify the guard EXISTS and actually fires.
6. **Right-to-erasure / data-at-rest** — every on-disk artifact a writer creates (caches, sidecars, FTS/embed/HNSW/feedback files, `.tmp` leftovers incl. the random-nonce `writeNote` tmp) must be erased by `prune`/`clear-*`. Verify writers ⊆ erasers, and that no raw note text survives.
7. **Write-fidelity / data-loss** — create/rename/append/replace/frontmatter_set atomicity + edge cases; line-number arithmetic; backlink-rewrite; case-insensitive FS; non-mapping frontmatter (`coerced`); symlink/hostile-FS pre-state.
8. **Test-theater / generator blind spots** — tests that pass without exercising the code they claim to; a behavioral test whose inputs *cannot produce the bug it guards* (the project's repeated "differential corpus can't produce the divergent shape" — the rc.16 CRLF regression and several ReDoS recurrences slipped through exactly this way). When you assess a behavioral/invariant test, ask: *can its inputs even generate the failure it claims to catch, and does it assert PRESENCE (non-vacuous) not just absence?*

---

## 5. Past external audits — the ground truth you are measured against

Eleven+ external audits have been processed on this project. We give you their track record so you can (a) **not waste budget re-deriving what's known**, and (b) **beat their recall** — every "miss" below is a class where a sufficiently deep auditor should have found it, and a fresh sibling may still be live.

**What prior auditors GENUINELY found (the high-value shape):** a *sibling of an already-closed class* that the change/claim-driven gates were blind to — an NFD tag the producer regex dropped; a 7th frontmatter-key-lookup site that skipped the fold; a non-atomic `writeNote`; a symlink-escape; privacy/erasure gaps (HNSW sidecar, path-leak); unbounded-graph DoS.

**What prior auditors MISSED (your bar to beat — these are real, and were found by *someone else* later):**
- A **CRITICAL ReDoS** that one external auditor's "no critical findings" pass graded as clean while it was *live at that very commit* (found by an independent re-sweep). A single competent auditor missed the one finding that mattered most.
- A **symlink-escape** that a state-driven re-verification auditor explicitly "verified clean (a–f)" — and *missed* — while a runtime-probe auditor who pre-planted a hostile FS state caught it. **Methodology determined who saw it.**
- A **HIGH wikilink/embed quadratic ReDoS**, reachable via the always-on `obsidian_read_note` over adversarial note content, that **at least three consecutive external audits (including a fully "clean" 0/0/0 pass) did not find** — caught only by the maintainer's own adversarial re-challenge. (Fixed in rc.17; do not re-flag it, but **find its next sibling** — the class is "a regex/scan over note content with a lazy-or-overlapping quantifier and no sink-bound").

**What prior auditors GOT WRONG (false positives / severity errors — don't repeat these):**
- A hallucinated field (`tag_filters`) that does not exist anywhere in the code, reported as a finding.
- A test-count "overclaim" HIGH that is a deliberate convention (source-`it()` count gated by docs-consistency; the runtime count is higher due to data-driven loops) — re-litigated by two auditors, rejected both times.
- A proposed ReDoS-detector fix (adding a `u` flag) that would have **introduced** a desync between the detector and its `i`-only sink — i.e. the fix was worse than the non-issue.
- A concurrency "race" that is impossible because the critical section is fully synchronous (JS run-to-completion).
- A severity inflation: a correctness-on-opt-in-convention bug rated HIGH, re-graded LOW.

**The lesson for you:** per-item **empirical reproduction + self-refutation + severity calibration** is mandatory (§6). We will adversarially re-verify every finding, every severity, and every "this field/method exists" claim. Precision matters as much as recall — a report that is 90% real findings beats one that is 50% real even if the latter has more raw count.

A consolidated, machine-readable history of prior findings (closed + accepted) is in `CLAUDE.md` and `CHANGELOG.md`; §11 lists the known-accepted items you should not re-flag as new (but may challenge with a repro).

---

## 6. Maximal-depth methodology — verify, then RE-VERIFY (mandatory protocol)

Run as many depth tiers as your budget allows; you have a lot, so we expect T0–T4 in full.

- **T0 — Reproduce the green baseline (§7).** If anything fails on a clean checkout, that itself is a finding. Record the exact env (node version, OS, which optional deps built).
- **T1 — Broad state-driven sweep.** Read EVERY `src/` module, doc, workflow, script *as it exists* (not just the diff). Build the inventory: every always-on tool, every input field + its zod cap, every regex/parser sink, every resource-acquiring sink, every error path, every on-disk artifact + its eraser, every enforcement claim + its guard.
- **T2 — Deep per-module reading.** For each module, cross-check TSDoc/header claims vs implementation; trace each public function's data path **ingest → store → compare** (this is where the NFC/encoding class hides); check resource lifecycles (acquire→use→release on every throw path).
- **T3 — Adversarial empirical fuzzing (use the budget here).** For every regex/tokenizer/parser reachable from a remote or note-content input: build a **generative fuzzer** whose generator can emit the pathological shapes (unclosed delimiters, overlapping/lazy quantifiers, adjacent quantifiers, escapes, astral/BMP non-ASCII, CRLF/LS/PS line terminators, deeply-nested groups) and run it against the **real compiled sink** with a wall-clock budget; flag any input that is super-linear. Build **differential harnesses** comparing any refactored parser against an inlined copy of its predecessor over a broad corpus. Force every error path on the serve-http surface and grep the output for host paths. Drive concurrent calls at the shared singletons.
- **T4 — Self-refutation + re-verification (the step prior auditors skipped).** For EACH candidate finding: (a) reproduce it **end-to-end through the compiled `dist/`**, not just by reasoning; (b) spawn an independent skeptic pass that tries to **prove the finding wrong** (is the path actually reachable? is there an upstream cap/guard? does the threat model cover it?); keep it only if it survives; (c) **calibrate severity** against the §12 rubric with a written justification; (d) **re-verify against current HEAD** (don't re-flag something fixed in rc.1→rc.17). Record the self-refutation outcome in the report (§12 asks for it).

**A note on the project's own anti-overclaim rule (apply it to yourself):** never claim an *enforced* guarantee you haven't empirically shown; never claim "every X" without enumerating X; for any ReDoS claim, **time the worst-case shape (`<class>×n + boundary char`)** rather than arguing from the regex structure. A CodeQL-style dismissal ("the `$` anchor makes it linear") is a hypothesis to be timed, not a conclusion.

---

## 7. Baseline — reproduce the green state, then go beyond it

```bash
npm ci
npm run build                 # tsc strict + noUncheckedIndexedAccess
npm test                      # ~1398 source it() (+ data-driven expansion)
npm run test:coverage         # 12 per-file floors; regenerates coverage/coverage-summary.json
npm run lint                  # biome, 0 findings
npm run check:version-consistency   # 7 surfaces + CLAUDE roll-up marker
npm run check:oia             # 12 state-driven walks
node scripts/check-audit.mjs  # scoped npm-audit gate (ALLOWLIST is empty = strictest)
node scripts/smoke.mjs        # synthetic-vault tools/list + initialize
npm pack --dry-run            # packaged file set
```

All expected to pass on rc.17. Then audit beyond what these check — they are the floor, not the ceiling.

---

## 8. Recent changes — audit these HARDEST (v3.11.0 line, rc.1 → rc.17)

Read the CHANGELOG entries for each; treat all of it as fresh, possibly-under-baked. **Re-verify these maintainer fixes adversarially — several were themselves bug-introducing in the same commit (a documented recurring shape).**

- **rc.17 (HIGH + MED, JUST shipped) — `parser.ts` `scanWikilinkInners` + CRLF heading strip.** The wikilink/embed extraction was rewritten from an O(n²) lazy regex to a linear non-backtracking scanner; `validateNoteProposal`'s byte-identical copy was de-duped through it. **Re-verify:** is the scanner truly byte-equivalent to the old regex on EVERY shape (build your own differential — the maintainer's corpus is 26 cases; find a 27th where they diverge)? Is it genuinely O(n) on every adversarial input? The CRLF fix added `stripTrailingLineEnds` at 3 heading sites — **is there a 4th heading/line-split site, or a different `(.+)$`-over-a-split-line pattern still terminator-blind** (e.g. a note using U+2028/U+2029 as the *separator*, which `split("\n")` doesn't split on at all)?
- **rc.13 (the auditor-introduced-a-regression case) — `vault.ts` atomic `writeNote`.** rc.12 made overwrite atomic (tmp+rename); that fix **introduced a symlink-escape** (deterministic `.tmp` followed a pre-planted symlink), fixed in rc.13 with a random-nonce tmp opened `wx`/O_EXCL. **Re-probe against a HOSTILE pre-existing FS state** (pre-plant symlinks, race a concurrent writer, exhaust the nonce space conceptually, fail the cleanup `unlink`): does any path still escape the vault, leave a stale tmp, or corrupt the note? This is the single highest-value re-verification in the brief.
- **rc.6 — `js-yaml` 4 → 5 migration (`frontmatter.ts`, `bases.ts`).** YAML 1.2; dates load as strings; `load("")` throws; merge-key `<<` removed. **Scrutinize:** round-trip fidelity (a `frontmatter_set` on one key must not mutate/reformat others), scalar resolution, `.base` parse of empty/odd YAML, alias/anchor "billion-laughs" bound (documented as accepted under the single-user model — challenge if exploitable).
- **rc.1 — closed-loop feedback (`feedback.ts`), 46th tool.** Per-vault `<hash>.feedback.json` (relative paths + counts + ISO ts ONLY — no note content/query). null-proto map (prototype-pollution fix rc.8). **Scrutinize:** data-at-rest claims, `record()` read-modify-write under concurrent serve-http calls, prune-erasure, the `readOnlyHint:false` K-3 classification, any OTHER tool that turns agent strings into object keys.
- **rc.9 → rc.12 — the NFC class (tags producer+consumer, frontmatter keys/values) + DoS input caps + the rc.13 dual-audit fixes.** Verify the NFC class is complete across ingest→store→compare; verify every remote free-form string is `.max()`-capped; re-verify the rc.12/rc.13 fixes.

**Deferred (the maintainer plans these for rc.18 — confirm they are genuinely deferred, not silently broken):** the `atomsOverlap` ReDoS pre-filter under-flags single-code-unit non-ASCII literal atoms (bounded by the rc.39 worker sink-bound — verify the bound actually holds and no event-loop hang is reachable); the `name-fold` producer invariant is vacuous-on-deletion and misses the bases.ts single-key `fm.tags` shape; 6 stale CLI exempts in `scope-completeness-audit.mjs`.

---

## 9. Comprehensive coverage checklist (by class) — report your depth on EACH

For each class: fully closed, or an uncovered sibling/surface? (The project's signature failure mode is "instance fixed, adjacent sibling missed".) §12 asks you to self-report examined/depth/findings per row, so we can compare your coverage to other auditors'.

- [ ] **STRIDE / security:** bearer auth (`timingSafeEqual`, min-length ≥16), rate-limit, CORS (allow+expose headers), path traversal, symlink escape (incl. hostile pre-state), input validation (zod `.max()` on every remote string), injection (FTS5/SQL/DQL/glob), prototype pollution (every agent-string→object-key site).
- [ ] **ReDoS / catastrophic backtracking / polynomial regex:** EVERY `new RegExp`/regex-literal fed by user/agent/config input OR by note content. The non-backtracking DP matcher, the rc.39 worker sink-bound, the rc.14 linear strips, and the rc.17 wikilink scanner are class-enders for *specific* sinks — **find a sink they don't cover** (time the worst-case shape).
- [ ] **Resource / DoS caps:** every always-on whole-vault scanner CAP-or-EXEMPT; per-request amplifiers (O(K×N)); canvas/PDF/OCR memory caps; HNSW growth; graph node cap; every remote free-form string `.max()`-capped.
- [ ] **Unicode / NFC / encoding / line-terminators:** names, tags (producer+consumer), frontmatter keys+values, DQL/bases field names, surrogate splitting, case-fold under `/i`/`/u`, CRLF/LS/PS handling across every line-split site.
- [ ] **Concurrency:** every long-lived shared-mutable singleton — serialized or provably interleave-safe? (watcher HNSW/rowsByLabel/embed-db, FeedbackStore, SessionRegistry, module caches).
- [ ] **Info-disclosure:** every error reachable by a serve-http client is abs-path-free. Force the error paths.
- [ ] **Optional-dep leaks:** every `await import()` funnels load errors through `optionalDepDetail`.
- [ ] **Right-to-erasure / data-at-rest:** writers ⊆ erasers for every cache/sidecar/`.tmp` (incl. the nonce `writeNote` tmp + feedback sidecar); no raw note text survives `prune`/`clear-*`.
- [ ] **Write-fidelity / data-loss:** create/rename/append/replace/frontmatter_set atomicity + edge cases; line-number arithmetic; backlink-rewrite; case-insensitive FS; non-mapping frontmatter (`coerced`); hostile-FS pre-state.
- [ ] **Claimed-guarantee vs code-guard:** "zero outbound in serve" (embeddings/reranker/OCR offline, incl. cache-miss), SLSA L2, fail-closed `.base` predicates, `*Safe`/peek never-throw, "fails closed" privacy filter, atomic write.
- [ ] **MCP contract:** `readOnlyHint` correctness (K-3: every fs/state mutator incl. `markUseful` in `KNOWN_WRITE_HANDLERS`), tool schemas, error shapes, stateful session lifecycle.
- [ ] **Retrieval correctness:** RRF, rerank, graph-boost, recency blend, `filter_frontmatter` (key-fold), chunking parity (FTS5 vs embeddings), HNSW under-return, eval metric correctness (recall@k/MRR/NDCG dedup).
- [ ] **Supply-chain:** SHA-pinned actions + correct `# vN` comments; `run:`-download content-pinning; `overrides`; `check-audit.mjs` allowlist (empty); phantom/undeclared deps; `files[]` accuracy.
- [ ] **Docs / claim-vs-reality:** counts (46 tools / 19 prompts / 1398 tests) across README ×9 + llms.txt + AGENTS.md + STABILITY + COMPARISON + api.md + server.json + CITATION; version currency; CLI flag docs vs real `.option()`s; README anchor integrity; TSDoc-vs-impl drift.
- [ ] **Test/CI integrity:** no silent-skip on security surfaces; no vacuous/test-theater; every `*-invariant.test.ts` has a real NEGATIVE control AND asserts presence (non-vacuous); behavioral tests *generate the failing input shape*; coverage floors honest; flake-blocks-release risks.

---

## 10. Claims ledger — verify each enforced guarantee points at a real guard

For EACH claim below, report in §12's claims table: `holds` / `partial` / `false`, the specific code guard (file:line) that enforces it (or its absence), and your verification method.

1. "Zero outbound network calls in `serve`/`serve-http`" — embeddings, reranker, AND OCR, including the **cache-miss** path.
2. "SLSA Build L2 (signed provenance)" — the workflow actually produces it; no surface overclaims L3+.
3. "`.base` unevaluable predicates fail **closed**" (incl. under `not:` negation).
4. "`*Safe` / `peek*Meta` never throw" — on a corrupt/dir/unreadable index file.
5. "Privacy filter (`--exclude-glob`/`--read-paths`) fails closed" — excluded notes never appear in any tool's output, including graph-boost and recency re-rank intermediates.
6. "Atomic `writeNote` overwrite" — no truncation/partial-write window; no symlink escape; no stale tmp.
7. "OCR is offline-enforced" — `assertOcrLangsInstalled` fails closed before any worker fetch.
8. "Bearer auth constant-time + ≥16 chars" — `timingSafeEqual`, length enforced at the boundary.

---

## 11. Out of scope / known-accepted (do not re-flag as NEW — but DO challenge the acceptance with a repro)

- **Fixed in rc.1→rc.17 — do not re-report as new** (verify still-closed in §12's prior-findings table): the wikilink/embed quadratic ReDoS (rc.17), the CRLF heading drop (rc.17), the `writeNote` symlink-escape (rc.13), the NFC tag producer+consumer + frontmatter-key class (rc.9/rc.10), `frontmatter_set` non-mapping data-loss (rc.64), the reserve-before-try open()/listen() leaks (rc.70), the DQL/LIKE/glob ReDoS family (rc.57/rc.63/rc.68/rc.71), the abs-path-leak class (rc.45/rc.49/rc.55/rc.57/rc.59), prototype-pollution in `feedback.ts` (rc.8).
- **R-10 HNSW under-return** at >66%-excluded result sets — documented residual, accepted.
- **js-yaml alias/anchor "billion-laughs"** not specifically rejected — bounded by the single-user local-vault threat model (SECURITY.md). Merge-key DoS is gone (v5).
- **Bases `.base` frontmatter equality is case-SENSITIVE** by design (mirrors Obsidian); NFC-normalized but case-preserving — intentional.
- **DQL LIKE Unicode case-fold** uses `String.toLowerCase()` (not full ECMAScript canonical fold) — documented contract; under-matches ~22 exotic codepoints, never over-matches.
- **`capacity()`/`resize()`** are orphaned (test-only) HNSW API — INFO/WAI.
- **The source-`it()` test-count convention** (1398 is the source count gated by docs-consistency; runtime is higher via data-driven loops) — challenge only the *convention*, with reasoning, not as an "overclaim".
- **`atomsOverlap` non-ASCII single-char under-flag** + the **vacuous-on-deletion `name-fold` producer guard** + the **6 stale CLI exempts** — already triaged for rc.18; confirm they are bounded (no live event-loop hang / no live unfolded site), or escalate with a repro if not.
- **Maintainer-only items** (branch protection, required-review settings, registry-side metadata) — out of the code auditor's scope; flag but don't expect a code fix.

If you believe any "accepted" item is actually exploitable, **escalate it with a repro** — accepted ≠ immune.

---

## 12. Deliverable format — built for CROSS-AUDITOR COMPARISON

Hand back **one Markdown report file** (do not commit it to the repo). It MUST contain, in this order: (A) a machine-readable scorecard header, (B) a coverage matrix, (C) a prior-findings re-verification table, (D) a claims-ledger table, (E) the findings, (F) a self-assessment, (G) a machine-readable JSON appendix. The fixed schemas below let us **diff and aggregate multiple auditors' reports** — please follow them exactly (an aggregator script parses the JSON appendix; the human tables mirror it).

### (A) Scorecard header — YAML front-matter (fill every field)

```yaml
audit:
  auditor_id: "<your name/handle/model>"
  methodologies: ["state-driven", "change-driven", "STRIDE", "property-fuzz", "dependency", "threat-model", "..."]  # pick all you used
  graded_commit: "<full SHA from `git rev-parse HEAD`>"
  npm_rc_version: "3.11.0-rc.17"
  environment: { node: "<x.y.z>", os: "<os>", optional_deps_built: ["better-sqlite3", "..."] }
  effort: { wall_clock_hours: <n>, approx_tokens: <n>, harnesses_built: <n>, fuzz_iterations: <n> }
  verdict: { ship_to_latest: <true|false>, score_0_5: <x.x>, one_line: "<...>" }
  severity_counts: { critical: <n>, high: <n>, medium: <n>, low: <n>, info: <n> }
  confidence: "<high|medium|low>"
```

### (B) Coverage matrix — your self-reported depth per area (one row per §9 class + the §3 modules you went deep on)

| Area | Examined (Y/N) | Depth (0–3) | Method | Findings (IDs) | Notes |
|---|---|---|---|---|---|
| ReDoS/polynomial | | | | | |
| concurrency | | | | | |
| … (all §9 classes) | | | | | |

Depth: 0 = not examined · 1 = read/skim · 2 = traced data-flow / reasoned · 3 = empirical repro / fuzz / differential. **This matrix is the primary cross-auditor comparison artifact** — be honest; a "0" is more useful to us than a false "3".

### (C) Prior-findings re-verification table — confirm the §11 "fixed" set is still closed

| Prior finding | Expected state | Your verification | Still closed? (Y/N) |
|---|---|---|---|
| wikilink/embed ReDoS (rc.17) | linear scanner, no O(n²) | | |
| writeNote symlink-escape (rc.13) | nonce tmp + wx, no escape | | |
| … | | | |

### (D) Claims-ledger table — §10

| Claim | Holds / Partial / False | Enforcing guard (file:line) | Verification method |
|---|---|---|---|

### (E) Findings — one block per finding, this exact schema

```
### <ID>  — <CRITICAL|HIGH|MEDIUM|LOW|INFO> — <one-line title>
- id: <stable id: CLASS-FILE-SHORTSLUG, e.g. REDOS-parser-embedrun>   # so two auditors' same find maps to comparable ids
- class: <security|concurrency|resource-dos|redos|encoding-nfc|line-terminator|info-leak|write-fidelity|data-loss|claim-vs-reality|supply-chain|mcp-contract|docs-drift|test-integrity|retrieval-correctness|optional-dep-leak|reserve-before-try|erasure|other>
- severity: <CRITICAL|HIGH|MEDIUM|LOW|INFO>   # justify below
- file_line: src/foo.ts:123 (cite the graded SHA)
- reachability: <local-only | serve-http-bearer | cli | watcher | build-time>; gated by <tool/flag>
- mechanism: <precise control/data-flow — why it's wrong>
- repro: <concrete steps/input; EMPIRICAL beats theoretical — say if you ran it through dist/>
- impact: <DoS | data-loss | leak | wrong-result | crash | corruption | drift>; blast radius
- self_refutation: <you TRIED to prove this wrong — what you checked, why it survived>
- severity_justification: <map to the rubric below>
- recommended_fix: <DESCRIBE in prose; root-cause + sibling sweep + a structural defense (invariant) if applicable — do NOT apply>
- confidence: <high|medium|low>; note if you could not run it
- disagrees_with_maintainer: <none | "I re-verified rc.NN's verdict X and disagree because …">
```

### (F) Self-assessment

- Estimated **recall** ("what classes might I have under-covered, and what would I do with 2× the budget?") and **precision** ("which of my findings am I least sure of?").
- The **methodology diversity statement** for the ≥2-auditor gate: what your approach sees that a state-driven file-by-file reader (or a change-driven diff reviewer) would not.
- Any finding where you **re-verified and DISAGREE** with the maintainer's rc.1→rc.17 verdicts.

### (G) Machine-readable appendix (REQUIRED — this is what the aggregator parses)

A single fenced ```json block containing `{ scorecard: {...same as A...}, coverage: [...same as B...], prior_findings: [...C...], claims: [...D...], findings: [...E, one object per finding...] }`. Keep it consistent with the human sections; if they diverge, the JSON is authoritative.

### Severity rubric (calibrate carefully — a prior auditor inflated a convention bug to HIGH)

- **CRITICAL** = remote/unauth code-exec, silent data-loss, or trivially-remote DoS (an unauthenticated or single-note-content trigger that hangs the server).
- **HIGH** = bearer-reachable DoS/leak/data-loss, or a broken security guarantee (e.g. the privacy filter or offline enforcement failing).
- **MEDIUM** = a bounded/conditional version of the above, or a real correctness bug with user-visible wrong results.
- **LOW** = narrow/edge-case correctness or hardening.
- **INFO** = doc/claim drift, dead code, style with a correctness angle.

State your severity **and its justification** so we can re-verify both. Per-item re-verification against the graded commit is expected — stale findings (re-flagging something fixed in rc.1→rc.17) and false positives (a field/method that doesn't exist) both reduce your signal; when uncertain, say so and show your repro attempt.

---

Thank you. **Findings are the deliverable; the maintainer's agent implements every fix.** Go deep, go broad, reproduce everything, and try to beat eleven prior auditors and an aggressive internal apparatus — the budget is yours to spend.
