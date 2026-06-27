# External Audit Request — enquire-mcp v3.11.0-rc.24 (FULL, from scratch, obligation-gated, comparison-ready — round 2)

**Status:** OPEN — **promotion-gate audit for v3.11.0 → `@latest`**.
**Date issued:** 2026-06-27
**Supersedes:** `AUDIT-REQUEST-FULL-FROM-SCRATCH-v3.11.0-rc.21-2026-06-26.md` (which 3 external auditors graded well — this round folds in what they found + where even the best ones fell short; see §13).
**Repository:** https://github.com/oomkapwn/enquire-mcp (public, MIT) · npm `@oomkapwn/enquire-mcp`
**Target of audit (pin this exact commit before you start):**

```bash
git clone https://github.com/oomkapwn/enquire-mcp && cd enquire-mcp
git checkout v3.11.0-rc.24 && git rev-parse HEAD   # expect 39cdd4f… — record the FULL SHA in your report
npm view @oomkapwn/enquire-mcp@rc version            # must read 3.11.0-rc.24
```

> The authoritative target is the commit **tagged `v3.11.0-rc.24`** (short SHA `39cdd4f`). Grade THAT commit, not whatever `main` currently points at (this brief itself lands on `main` as a later doc-only commit). Cite the SHA in every finding. `@latest` is **3.10.1** (stable); the v3.11.0 line is on `@rc` pending this audit + the **≥2-independent-auditor** promotion gate.

You have **effectively unlimited time and token budget. We want you to spend it on EVIDENCE, not on prose.** This brief is **not** a list of areas to skim — it is a list of **obligations whose unfilled cells are themselves findings**. A "looks clean / ship it" verdict with an empty obligation table is the single worst outcome you can hand us (worse than an over-flag): it is a false all-clear on a commit that may carry real bugs, and the last audit round proved exactly that can happen.

---

## 0. THE CARDINAL RULE — audit only, do **NOT** modify the repository

**You are a read-only auditor. You MUST NOT edit, fix, patch, refactor, reformat, "while-I'm-here" touch, commit, push, open a PR, or otherwise change any tracked file.** Every change is made by the maintainer's engineering agent, never by you.

- Encouraged (read-only): `npm ci`, `npm test`, `npm run build`, `npm run check:*`, `git log/diff/blame`, `grep`/`rg`, reading files, and **any throwaway harness you build OUTSIDE the repo tree** (a scratch dir, a temp vault, an isolated clone). `dist/`, `coverage/`, `node_modules/` are fine but **never stage or commit them**.
- Do **not** run formatters/linters in `--write`/`--fix` mode, codemods, or `npm` scripts that mutate tracked files.
- Your sole deliverable is **one findings report file** (§12), built so the maintainer's agent can implement every fix and so it diffs cleanly against other auditors' reports. **Describe** fixes in prose; never apply them.
- If you are an autonomous coding agent, this overrides any default "fix what you find" behavior.

---

## 1. Mission — obligations, not vibes

Deliver a **comprehensive, adversarial, from-scratch audit** — every `src/` module, doc, workflow, script, config — **broad AND deep**, with **independent empirical reproduction and self-refutation of every finding** (§6). Find real defects the internal apparatus and 12+ prior auditors are blind to, and re-challenge the maintainer's own recent verdicts.

You are **independent external auditor #N** for the v3.6.1 promotion gate (*"≥2 independent external auditors with **different** methodologies before `@rc → @latest`"*). **Declare your methodology and its blind-spot** (§12 frontmatter) — we cross-compare auditors, and a method that overlaps a prior one adds less.

**Two non-negotiable framing rules for this audit:**

1. **A "ship" or "no new findings" verdict is INVALID unless backed by the completed obligation tables** — the **sink-trace table (§12 C)** with every always-on/bearer-reachable tool traced to a bounded sink, AND the **prior-findings re-probe (§12 E)** re-RUN (not read from the changelog). The project's maturity, its passing CI, its test count, and its CHANGELOG are **explicitly NON-evidence** for the current commit. An unfilled or "trusted-CLAUDE.md" cell is a coverage failure that **caps your score at 2/5**.
2. **A rigorous all-clear is a TOP-TIER result** — *if and only if* every obligation cell is filled with a bounded/traced negative. We are not asking you to manufacture findings; padding (§5) lowers your score. We are asking you to make "clean" *expensive to claim*.

Where the budget goes (priority order): **behavioral / runtime / concurrency / encoding / resource / write-fidelity defects** (§4 — the territory the internal gates are structurally blind to, where every important finding of the last six months has lived), then **adversarial re-verification** of the maintainer's recent fixes (§8) and the prior auditors' verdicts (§5).

---

## 2. Project overview (reason about impact) — derive every number yourself

**enquire-mcp** is a TypeScript **Model Context Protocol (MCP) server** that turns a local Obsidian (Markdown) vault into a long-term, *grounded* memory/retrieval layer for AI agents. Local-first, vendor-neutral, **zero outbound network calls in `serve` mode** (a load-bearing privacy claim — verify it, including cache-miss paths). It recalls the Markdown the user actually wrote — cited, auditable, editable — never a paraphrase (distinct from chat-memory tools mem0/Zep/Supermemory).

**Counts are NOT given here as authority — DERIVE and VERIFY each one yourself at the graded commit, and a mismatch is a docs-drift finding.** (The previous brief asserted "40 `src/*.ts` modules" — that is the *recursive* count; `ls src/*.ts` is 33, `find src -name '*.ts'` is 40. We do not want you to inherit our drift.) The repo *claims*, at this commit: ~46 MCP tools (derive from `src/tool-manifest.ts` `TOOL_MANIFEST`: always-on read + opt-in diagnostic + `--enable-write` + 1 feedback), 19 MCP prompts, 12 OIA checks (`scripts/oia-walk.mjs` self-declares `canonical count is "N"`), and a canonical source-`it()` test count gated by `tests/docs-consistency.test.ts` (the runtime count is *higher* — data-driven `for(...) it(...)` loops; this convention is documented and is **WAI — do not re-file it as an "overclaim"**, two prior auditors did and were rejected). Confirm each by command and report drift.

- **Retrieval stack:** BM25 (SQLite FTS5) + TF-IDF + dense ML embeddings (transformers.js, int8-quantized) RRF-fused, BGE cross-encoder rerank, HNSW ANN (live-update + disk persistence), wikilink graph-boost, GraphRAG-light (Louvain), HyDE + sub-question, Obsidian Bases (`.base`) DSL, PDF text + OCR (Tesseract). Forgetting-aware staleness; closed-loop feedback (`obsidian_mark_useful`, opt-in).
- **Transports:** stdio + Streamable HTTP (bearer auth, rate-limit, CORS). **The HTTP path is the remote attack surface.** **Treat note CONTENT as adversarial** (the user may paste hostile text; an `--enable-write` agent may author it): pathological regex/markdown, hostile frontmatter, NFD-decomposed Unicode, unclosed/dense-closed delimiter runs, CRLF/LS/PS line terminators.
- **Optional deps (6):** `@huggingface/transformers`, `@napi-rs/canvas`, `better-sqlite3`, `hnswlib-node`, `pdfjs-dist`, `tesseract.js`. Must degrade gracefully (fail-soft) when absent — and must not leak host paths via their load errors. **Record in §12 frontmatter which built and whether any build FAILED** (a dep that failed to build silently disables a whole class — say so; a class you could not exercise is `ENV-BLOCKED`, not `clean`).
- **Threat model (single-user, local vault):** vault owner trusted; the *agent/MCP client* semi-trusted; on `serve-http`, a bearer-authenticated client is the adversary for DoS/leak; note files carry adversarial content. **There is NO multi-tenant cloud** — the worst realistic harm is event-loop DoS, local data corruption/loss, or vault-path info-leak, NOT cross-tenant breach. Calibrate severity (§12 rubric) to that.

**Authoritative docs to read first:** `README.md`, **`CLAUDE.md`** (the maintainer's North-Star + the running anti-pattern ledger and overclaim corrections #1–#22 — your map of where the apparatus has historically failed), `SECURITY.md`, `STABILITY.md` (semver contract), `docs/api.md`, `CHANGELOG.md` (esp. the rc.1→rc.21 v3.11.0 entries).

---

## 3. Codebase map (every module + its role)

Read each. Cross-check TSDoc/header claims against implementation — **TSDoc-vs-reality drift is a documented recurring class**. (This table is a *map*, not a checklist of where bugs are — see §4's anti-anchoring rule.)

| Module | Role / what to scrutinize |
|---|---|
| `index.ts` | entrypoint, `VERSION`, CLI dispatch, re-export surface |
| `cli.ts`, `cli-help.ts` | arg parsing, subcommands + flag help (cli-parity invariants); `setEmbeddingsOffline` on serve/serve-http |
| `server.ts` | stdio wiring, `prepareServerDeps`, boot-time bulk index build, signal/shutdown orchestration, watcher/HNSW/feedback wire-up |
| `http-transport.ts` | **remote surface** — bearer auth (`timingSafeEqual`, ≥16-char), rate-limit, CORS (allow+expose), stateful session registry, `pendingInits`/`inFlight` refcounts, bounded graceful shutdown |
| `shutdown.ts` | signal-driven teardown ordering (watcher → embed-db → cache flush → fts last) |
| `tool-registry.ts`, `tool-manifest.ts` | tool registration + gating + `readOnlyHint` (source of truth for the tool count); input caps `MAX_QUERY_LEN`/`MAX_TAG_ARG_LEN`/`MAX_FRONTMATTER_KEY_LEN`/`MAX_FRONTMATTER_VALUE_LEN`/`MAX_DQL_QUERY_LEN`/`MAX_QUESTION_PATTERN_LEN` |
| `prompts.ts` | MCP prompts |
| `vault.ts` | **core FS boundary** — path-traversal guards, `*Safe` fs wrappers (abs-path-leak sanitizer over raw `fs` sinks), atomic create/overwrite (random-nonce tmp + `wx`/O_EXCL), rename/append, privacy filter (`--exclude-glob`/`--read-paths`) via non-backtracking matchers, `isExcluded`, NFC name folding |
| `name-fold.ts` | canonical Unicode folders `foldName`/`foldTag`/`nfcLower`/`nfc` + `lookupFoldedKey` (consumer key lookup) + `lookupFoldedAny` (producer tag/title read) |
| `parser.ts` | frontmatter+body split, `bodyStartLine`, **`scanWikilinkInners` (rc.17/rc.18 linear non-backtracking wikilink/embed scan)**, `INLINE_TAG_RE` (NFC-before-match), code-fence stripping |
| `frontmatter.ts` | js-yaml@5 parse/stringify port (replaced gray-matter rc.53; js-yaml@4→5 rc.6); YAML 1.2 scalar contract, `coerced` flag, dates load as strings |
| `wildcard-match.ts` | **non-backtracking DP matcher** backing LIKE + glob + the linear `stripTrailing*` strips — the ReDoS / polynomial-strip class-enders |
| `tools/read.ts` | always-on read tools (list/search/neighbors/stats/tags/chat-thread/frontmatter/`extractHeadings`); `frontmatter_get`/`_search` via `lookupFoldedKey`; CRLF heading strip; **rc.21 `frontmatter_search` value-predicate cap + JSON.stringify hoist** |
| `tools/write.ts` | `--enable-write` tools (create/append/rename/replace/archive/frontmatter_set/validate_note_proposal); backlink-rewrite plan; write-fidelity; `replaceLineOnce` fold-offset map; `__proto__` literal-key handling |
| `tools/search.ts` | hybrid orchestration, RRF, rerank, graph-boost, recency, `filter_frontmatter`, adaptive HNSW refill, privacy-filter terminal pruning, scan caps; **rc.21 `foldWithMap`/`foldedIndexOf` snippet-offset helpers** (semanticSearch + searchText) |
| `tools/meta.ts` | `obsidian_open_questions` (ReDoS-sensitive; rc.39 worker sink-bound `matchLinesBounded`; `isCatastrophicRegex` pre-filter), `lint_vault_wiki`, tag suggest, `paper_audit`, `findBestMatch`, `validateNoteProposal`, getOpenQuestions CRLF strip |
| `tools/media.ts` | `read_canvas`, `read_pdf`, `ocr_pdf`, list-pdfs/canvases/bases (sort-then-truncate) |
| `tools/limits.ts` | `capScanEntries` resource cap |
| `dql.ts` | Dataview-query subset parser+executor (**always-on, remote-reachable**); `MAX_DQL_QUERY_LEN`; non-backtracking LIKE matcher; NFC value/tag/key folding |
| `bases.ts` | Obsidian `.base` DSL parser+executor (**always-on, remote-reachable**); predicate eval; NFC folding; resource caps; `coerced` non-mapping guard |
| `communities.ts` | Louvain community detection, wikilink graph, `MAX_GRAPH_NODES` cap, `converged` flag |
| `embeddings.ts` | transformers.js embedder/reranker, per-alias session cache, **offline enforcement** (`setEmbeddingsOffline`/`applyOfflineEnv`) |
| `embed-db.ts`, `embed-pipeline.ts` | SQLite embed store (`peekEmbedDbMeta` never-throw peek; self-cleaning `open()`), chunking (surrogate-safe cut), upsert/delete, signatures |
| `fts5.ts` | SQLite FTS5 index (`peekFtsMetaSafe` never-throw peek; self-cleaning `open()`), tokenization, escaping, persisted tag column, heading enrichment |
| `hnsw.ts` | hnswlib-node wrapper — `applyDiff`/`resize`/`capacity`, disk persistence, signature-guard rebuild, `zipHnswAddPoints` fail-closed |
| `optional-dep.ts` | `optionalDepDetail` — strips abs paths from optional-dep load errors |
| `pdf.ts`, `ocr.ts` | pdfjs + Tesseract; resource cleanup (try/finally self-cleaning doc/worker), canvas-OOM cap, OCR offline enforcement, page-range arithmetic |
| `staleness.ts` | `computeStaleness` / `recencyScore` |
| `feedback.ts` | `FeedbackStore` (per-vault sidecar, **null-proto map**), persistChain serialization, scoring, per-write `chmod 0600` |
| `retrieval-opts.ts` | shared serve/serve-http retrieval flag parse + validate |
| `watcher.ts` | chokidar watcher — per-absPath promise queue, `attachEmbed`/`attachHnsw`, embed-db + HNSW live-sync (synchronous critical section), `close()`-drain |
| `rrf.ts`, `periodic.ts`, `eval.ts`, `doctor.ts` | RRF fusion; periodic-notes date tokens; eval harness; `doctor` health check |

---

## 4. Where the internal apparatus is structurally **BLIND** — and the anti-anchoring rule

By the maintainer's own meta-audit (CLAUDE.md, "rc.36"), **~85% of the 12 OIA checks + ~20 invariant tests are drift/claim-driven** — they verify a *doc claim* matches a number/version/string, and are **structurally blind** to behavioral classes. Every genuinely-important finding of the last six months has lived in these. Spend the budget here:

1. **Runtime DoS / algorithmic complexity** — O(n²)/O(K×N) amplifiers, unbounded scans, ReDoS, OOM, on always-on **remotely-reachable** tools. *The class keeps re-manifesting in a sink no prior sweep enumerated.*
2. **Encoding correctness** — Unicode NFC/NFD on macOS APFS (names, tags producer+consumer, frontmatter keys+values, DQL/bases field names), surrogate splitting, **length-changing case-folds used as string offsets**, CRLF/LS/PS line terminators. The producer→store→compare data path is where these hide.
3. **Concurrency / shared-mutable-state interleave** — async chains mutating shared singletons (watcher HNSW index + `rowsByLabel`, the shared `FeedbackStore`, the HTTP session registry, embed-db/fts connections, module caches). (One prior auditor's "race" was a false positive — the critical section is synchronous, JS run-to-completion — so *confirm reachability before claiming*, but also re-confirm the maintainer's "it's synchronous" claim on every path.)
4. **Info-disclosure** — absolute host paths / cache layout leaking to a bearer client via error messages. Force every error path on the remote surface.
5. **Claimed-guarantee vs code-guard** — any "blocked"/"zero outbound"/"fails closed"/"never throws"/"SLSA L2"/"enforced"/"throws if"/"atomic" claim must point at a real guard that **actually fires** — and a guard that runs **after** the expensive work / after materialization is **Partial, not Holds** (§12 F).
6. **Right-to-erasure / data-at-rest** — every on-disk artifact a writer creates (caches, sidecars, FTS/embed/HNSW/feedback files, the random-nonce `writeNote` `.tmp`) must be erased by `prune`/`clear-*`. Writers ⊆ erasers; no raw note text survives.
7. **Write-fidelity / data-loss** — create/rename/append/replace/frontmatter_set atomicity + edge cases; line-number arithmetic; backlink-rewrite; case-insensitive FS; non-mapping frontmatter (`coerced`); symlink/hostile-FS pre-state.
8. **Test-theater / generator blind spots** — tests that pass without exercising the code they claim to; a behavioral test whose inputs *cannot produce the bug it guards* (the project's repeated "differential corpus can't produce the divergent shape"). When you assess a behavioral/invariant test, ask: *can its inputs even generate the failure, and does it assert PRESENCE (non-vacuous), not just absence?*

> **ANTI-ANCHORING (mandatory).** The eight classes above are where bugs have lived *before*. They are **not exhaustive**, and naming them risks capping your recall at "siblings of known bugs." **At least one of your passes must hunt for a defect class NOT in this list**, ideally with the list out of mind. If you find a novel class, set `novel_class_found: true` (§12) and describe it — a genuinely new class is rewarded above another sibling of a named one. Do **not** present a near-miss of a bug this brief already narrates (the rc.17 wikilink quadratic, the rc.13 symlink-escape) as an independent discovery; those are CLOSED (§11) — re-probe them in §12 E, don't re-file them.

---

## 5. Past auditors — the bar, and the exact failure modes to avoid

12+ external audits have been processed. Their track record is your calibration:

**The high-value shape they GENUINELY found:** a *sibling of an already-closed class* the change/claim-driven gates were blind to — an NFD tag the producer regex dropped; a 7th frontmatter-key-lookup site; a non-atomic `writeNote`; a symlink-escape; privacy/erasure gaps; an unbounded-graph DoS; a remote DoS via an uncapped tool input.

**What they MISSED (your bar to beat — each was real and found by someone else):**
- A **CRITICAL ReDoS** one auditor's "no critical findings" pass graded clean while it was *live at that commit*.
- A **symlink-escape** a state-driven re-verification auditor "verified clean (a–f)" and missed — while a runtime-probe auditor who **pre-planted a hostile FS state** caught it. **Methodology determined who saw it** (this is why §12 E *requires* the hostile-FS re-probe).
- A **HIGH wikilink/embed quadratic ReDoS** that **three consecutive audits (incl. a "clean" 0/0/0 pass) re-blessed** — because their corpora used a long **UNCLOSED** `[[` token (early-exits, genuinely O(n)) instead of a **DENSE single-line run of CLOSED `[[a]][[a]]…`** (rescans to EOF per link, the real O(n²)). **They ran the wrong adversarial shape on the exact buggy function and declared it linear.** This is the marquee lesson of this audit — see §6's named-shape obligation.

**What they GOT WRONG (don't repeat — these count AGAINST your precision):**
- A hallucinated field (`tag_filters`) that exists nowhere, reported as a finding.
- The source-`it()` test-count convention re-litigated as an "overclaim" (×2, rejected both).
- A proposed ReDoS-detector "fix" (adding a `u` flag) that would have *introduced* a detector↔sink desync — worse than the non-issue.
- A concurrency "race" impossible because the section is synchronous.
- An over-broad "cap ALL 10 `vault.listMarkdown()` sites" — 4 are deliberately **EXEMPT** (capping an exhaustive/aggregation scan silently corrupts results; the WRONG fix) and `resource-bound-invariant` already passes. **Before recommending a fix, check it against the project's OWN CAP-vs-EXEMPT and anti-overclaim invariants (§11); a recommendation that contradicts a passing invariant is REJECTED.**
- A "ship it, 4.75/5" verdict with **zero** code-path traces on a commit that actually carried a HIGH + 3 MED. **This false all-clear is the worst outcome in this brief's scoring** — and §1/§12's obligation gates exist specifically to make it impossible to produce.

**The scoring philosophy:** a report 90% real findings beats one 50% real even at higher raw count. Per-item **empirical reproduction + self-refutation + severity calibration** is mandatory (§6). We adversarially re-verify every finding, severity, and "this field/method exists" claim.

---

## 6. Maximal-depth methodology — verify, then RE-VERIFY (mandatory protocol)

Run T0–T4 in full; you have the budget.

- **T0 — Reproduce the green baseline (§7).** Anything that fails on a clean checkout is itself a finding. Record exact env (node version, OS, which optional deps BUILT, any build FAILURE).
- **T1 — Broad state-driven sweep.** Read EVERY `src/` module, doc, workflow, script *as it exists*. Build the **inventory the obligation tables demand (§12 C/D/F)**: every always-on tool, every input field + its cap, every regex/parser sink, every resource-acquiring sink, every error path, every on-disk artifact + its eraser, every enforcement claim + its guard, every NEW function since the prior tag.
- **T2 — Deep per-module reading + the SINK TRACE.** For each always-on/bearer tool, trace its input **field → validation (file:line) → cost-bearing sink (file:symbol) → cost function O(?) → bound or UNBOUNDED**. This trace is a *required deliverable* (§12 C), not optional notes. For each module, cross-check TSDoc vs impl; trace each public function's data path **ingest → store → compare** (where the NFC/encoding class hides); check resource lifecycles (acquire→use→release on every throw path).
- **T3 — Adversarial empirical fuzzing with the NAMED SHAPES (use the budget here).** For every regex/tokenizer/parser reachable from a remote or note-content input, your generator MUST emit — and you MUST paste the exact input it generated to confirm it matches — these canonical worst-case shapes:
  - **dense run of CLOSED tokens, no newline** (`"[[a]]".repeat(N)`, `"#x ".repeat(N)`, etc.) — NOT a long *unclosed* run, which early-exits;
  - **occurrences × replacement-length** blow-up (many short matches, large replacement);
  - **length-changing case-fold** before a match (`"İ".repeat(K)+"x"`, U+0130/final-sigma/ẞ) — used as a string offset or a tag/key compare;
  - **non-mapping / hostile frontmatter**, **astral/BMP non-ASCII**, **CRLF + LS (U+2028) + PS (U+2029)** as both line *content* and line *separator*;
  - **adjacent/overlapping/literal-separated unbounded quantifiers**, deeply-nested groups.
  Run each against the **real compiled sink** (through `dist/`) with a wall-clock budget; flag any super-linear input. Build **differential harnesses** comparing any refactored parser against an inlined copy of its predecessor over a broad corpus that *includes* the shapes above. Force every serve-http error path and grep output for host paths. Drive concurrent calls at shared singletons.
- **T4 — Self-refutation + re-verification.** For EACH candidate: (a) reproduce **end-to-end through compiled `dist/`**; (b) spawn an independent skeptic pass that tries to **prove it wrong** (is the path reachable? upstream cap/guard? threat-model coverage? CAP-vs-EXEMPT? known-accepted?); keep only if it survives; (c) **calibrate severity** (§12 rubric) with written justification; (d) **re-verify against current HEAD** — don't re-flag something closed in rc.1→rc.21.

> **WRONG-PROBE SELF-CHECK (mandatory — this is what 3 auditors failed).** Any "fast / linear / no-divergence" result on a flagged hot-spot is **NOT evidence of safety** until you run a **3-point complexity curve**: measure `t(n)`, `t(4n)`, `t(16n)` and report the ratios. A single fast timing on an unplotted curve may not be cited as proof of linearity. If you cannot make the named worst-case shape, say so — that is `not-covered`, not `clean`.

> **EVIDENCE-OR-DOWNGRADE.** A finding marked `repro: empirical` with no pasted harness + concrete input + ≥3-point timing table is **auto-downgraded to theoretical and capped at MEDIUM**. **Any timing run with a non-empty stderr is INVALID** and cannot back a finding (an exception thrown mid-run means you measured the error path, not the algorithm). Do **not** report self-reported scalar effort (hours/tokens/"fuzz_iterations") — those are unfalsifiable; paste the work instead.

**Apply the project's own anti-overclaim rule to yourself:** never claim an *enforced* guarantee you haven't empirically shown; never claim "every X" without enumerating X; for any ReDoS claim, **time the worst-case shape** (`<class>×n + boundary char`) rather than arguing from regex structure. A CodeQL-style dismissal ("the `$` anchor makes it linear") is a hypothesis to be **timed**, not a conclusion (the project itself shipped this mistake — see CLAUDE.md rc.14).

---

## 7. Baseline — reproduce the green state, then go beyond it

```bash
npm ci
npm run build                 # tsc strict + noUncheckedIndexedAccess
npm test                      # canonical source it() (+ data-driven expansion) — DERIVE the number, don't trust this comment
npm run test:coverage         # per-file floors; regenerates coverage/coverage-summary.json
npm run lint                  # biome --error-on-warnings, 0 findings
npm run check:version-consistency   # 7 version surfaces + CLAUDE roll-up marker
npm run check:oia             # state-driven walks (the script self-declares its canonical count)
node scripts/check-audit.mjs  # scoped npm-audit gate (ALLOWLIST empty = strictest)
node scripts/smoke.mjs        # synthetic-vault tools/list + initialize
npm pack --dry-run            # packaged file set
```

All expected to pass on rc.21. These are the **floor, not the ceiling** — audit beyond what they check. If any FAILS on a clean checkout, that is a finding (record env).

---

## 8. Recent changes — audit these HARDEST (v3.11.0 line, rc.1 → rc.21)

Read the CHANGELOG for each; treat all of it as fresh, possibly under-baked. **Re-verify these maintainer fixes adversarially — several were themselves bug-introducing in the same commit (a documented recurring shape), and the freshest are the least-audited.** Populate §12 D (new-code inventory) from this list + your own `git diff`.

- **rc.21 (JUST shipped — the post-rc.20 re-sweep) — `frontmatter_search` value cap + read-path fold-offset.** `obsidian_frontmatter_search` `equals`/`contains` were `z.unknown()` (uncapped) and `JSON.stringify`'d per-note vault-wide → bearer-reachable O(notes×len) amplifier; now a `.refine()` cap (`MAX_FRONTMATTER_VALUE_LEN`) + hoisted stringify. `semanticSearch`/`searchText` computed a snippet offset on a `toLowerCase()` copy and sliced the ORIGINAL (length-changing-fold drift); now route through `foldWithMap`/`foldedIndexOf`. **Re-verify:** is the cap actually enforced at the boundary (not after the scan)? Is `foldWithMap`'s offset map correct for **astral** code points and chained expansions (`İİ…`)? Are there OTHER `toLowerCase().indexOf` → slice-original sites (the class)? Is the `filter_frontmatter` value (still `z.unknown()`) genuinely bounded by the candidate pool, or vault-wide on some path?
- **rc.18 (the 4-way-audit batch) — `scanWikilinkInners` quadratic (HIGH, a regression the maintainer shipped in rc.17), FTS query cap, `replace_in_notes` O(n²)+materialization + Unicode offset.** **Re-verify with the DENSE-CLOSED shape (§6), not an unclosed run.** Build your own differential of `scanWikilinkInners` vs an inlined predecessor; find a shape where they diverge. Is `replace_in_notes` bounded in BOTH occurrence-count and replacement-size?
- **rc.13 (the auditor-introduced-a-regression case) — `vault.ts` atomic `writeNote`.** rc.12 made overwrite atomic (tmp+rename); that fix **introduced a symlink-escape** (deterministic `.tmp` followed a pre-planted symlink), fixed in rc.13 with a random-nonce tmp opened `wx`/O_EXCL. **§12 E REQUIRES you to re-probe this against a HOSTILE pre-existing FS state** (pre-plant symlinks, race a concurrent writer, fail the cleanup `unlink`): does any path still escape the vault, leave a stale tmp, or corrupt the note? **This is the single highest-value re-verification in the brief.**
- **rc.6 — `js-yaml` 4 → 5 migration (`frontmatter.ts`, `bases.ts`).** YAML 1.2; dates load as strings; `load("")` throws; merge-key `<<` removed. Scrutinize round-trip fidelity (a `frontmatter_set` on one key must not mutate/reformat others), `.base` parse of empty/odd YAML, alias/anchor "billion-laughs" bound (documented as accepted under the single-user model — challenge only with a repro).
- **rc.1 — closed-loop feedback (`feedback.ts`), the 46th tool.** Per-vault `<hash>.feedback.json` (relative paths + counts + ISO ts ONLY — no content/query). null-proto map (prototype-pollution fix rc.8). Scrutinize data-at-rest claims, `record()` read-modify-write under concurrent serve-http calls, prune-erasure, the `readOnlyHint:false` K-3 classification, and **any OTHER tool that turns agent strings into object keys**.
- **rc.9 → rc.12 — the NFC class** (tags producer+consumer, frontmatter keys/values, DQL/bases fields) + DoS input caps + the rc.13 dual-audit fixes. Verify the NFC class is complete across ingest→store→compare; verify every remote free-form string is capped.

---

## 9. Coverage obligations (by class) — fill §12 B for EACH

For each class: fully closed, or an uncovered sibling/surface? (The project's signature failure mode is "instance fixed, adjacent sibling missed" — rc.21 itself closed two such siblings.) Mark each row `clean` / `finding` / `ENV-BLOCKED` / `not-covered`, with depth 0–3; a `depth≥2 clean` REQUIRES its sink rows in §12 C.

- **STRIDE / security:** bearer auth (`timingSafeEqual`, ≥16), rate-limit, CORS (allow+expose), path traversal, symlink escape (incl. hostile pre-state), input validation (cap on every remote string AND every `z.unknown()` predicate), injection (FTS5/SQL/DQL/glob), prototype pollution (every agent-string→object-key site).
- **ReDoS / catastrophic backtracking / polynomial regex:** EVERY `new RegExp`/regex-literal fed by user/agent/config input OR note content. The non-backtracking DP matcher, the rc.39 worker sink-bound, the linear strips, and the rc.17/rc.18 wikilink scanner are class-enders for *specific* sinks — **find a sink they don't cover; time the dense-closed shape.**
- **Resource / DoS caps:** every always-on whole-vault scanner CAP-or-EXEMPT (check `resource-bound-invariant`'s manifest before proposing a cap); per-request amplifiers (O(K×N)); canvas/PDF/OCR memory caps; HNSW growth; graph node cap; every remote free-form string AND `z.unknown()` predicate capped.
- **Unicode / NFC / encoding / line-terminators:** names, tags (producer+consumer), frontmatter keys+values, DQL/bases field names, surrogate splitting, case-fold under `/i`/`/u`, **length-changing folds used as offsets**, CRLF/LS/PS across every line-split AND every `(.+)$`/`.`-no-`s`/`m` regex over a split line.
- **Concurrency:** every long-lived shared-mutable singleton — serialized or provably interleave-safe?
- **Info-disclosure:** every error reachable by a serve-http client is abs-path-free. Force the error paths.
- **Optional-dep leaks:** every `await import()` funnels load errors through `optionalDepDetail`.
- **Right-to-erasure / data-at-rest:** writers ⊆ erasers for every cache/sidecar/`.tmp` (incl. nonce `writeNote` tmp + feedback sidecar); no raw note text survives `prune`/`clear-*`.
- **Write-fidelity / data-loss:** atomicity + edge cases; line-number arithmetic; backlink-rewrite; case-insensitive FS; non-mapping frontmatter; hostile-FS pre-state.
- **Claim-vs-guard:** §10 ledger.
- **MCP contract:** `readOnlyHint` correctness (K-3: every fs/state mutator incl. `markUseful` in `KNOWN_WRITE_HANDLERS`), tool schemas, error shapes, stateful session lifecycle.
- **Retrieval correctness:** RRF, rerank, graph-boost, recency blend, `filter_frontmatter` (key-fold), chunking parity (FTS5 vs embeddings), HNSW under-return, eval metric correctness.
- **Supply-chain:** SHA-pinned actions + correct `# vN` comments; `run:`-download content-pinning; `overrides`; `check-audit.mjs` allowlist (empty); phantom/undeclared deps; `files[]` accuracy.
- **Docs / claim-vs-reality:** counts (derive each) across README ×9 + llms.txt + AGENTS.md + STABILITY + COMPARISON + api.md + server.json + CITATION; version currency; CLI flag docs vs real `.option()`s; README anchor integrity; TSDoc-vs-impl drift.
- **Test/CI integrity:** no silent-skip on security surfaces; no vacuous/test-theater; every `*-invariant.test.ts` has a real NEGATIVE control AND asserts presence; behavioral tests *generate the failing shape*; coverage floors honest; flake-blocks-release risks.
- **novel (name it):** the §4 anti-anchoring obligation.

---

## 10. Claims ledger — verify each enforced guarantee points at a real guard (fill §12 F)

For EACH: `Holds` / `Partial(late-guard)` / `False`, the specific guard (file:line you read) or its absence, and your verification method. **A guard that runs AFTER the expensive work / after materialization is `Partial`, not `Holds`.**

1. "Zero outbound network calls in `serve`/`serve-http`" — embeddings, reranker, AND OCR, **including the cache-miss path** (§12 E requires this re-probe).
2. "SLSA Build L2 (signed provenance)" — the workflow actually produces it; no surface overclaims L3+.
3. "`.base` unevaluable predicates fail **closed**" (incl. under `not:` negation).
4. "`*Safe` / `peek*Meta` never throw" — on a corrupt/dir/unreadable index file.
5. "Privacy filter (`--exclude-glob`/`--read-paths`) fails closed" — excluded notes never appear in any tool's output, including graph-boost / recency intermediates.
6. "Atomic `writeNote` overwrite" — no truncation/partial-write window; no symlink escape; no stale tmp.
7. "OCR is offline-enforced" — `assertOcrLangsInstalled` fails closed BEFORE any worker fetch.
8. "Bearer auth constant-time + ≥16 chars" — `timingSafeEqual`, length enforced at the boundary.
9. "Input caps fail closed at the BOUNDARY" — every remote string `.max()` and every `z.unknown()` predicate `.refine()`-bounded; the cap rejects **before** the expensive per-note scan (rc.21 `MAX_FRONTMATTER_VALUE_LEN` — is it boundary-enforced or post-scan?).

---

## 11. Out of scope / known-accepted (do not re-flag as NEW — but DO challenge with a repro)

- **Fixed in rc.1→rc.21 — re-probe in §12 E, do NOT re-report as new:** the wikilink/embed quadratic ReDoS (rc.17/rc.18), the CRLF heading + open_questions drop (rc.17/rc.19), the `writeNote` symlink-escape (rc.13), the NFC tag producer+consumer + frontmatter-key class (rc.9/rc.10), `frontmatter_set` non-mapping data-loss (rc.64), the reserve-before-try open()/listen() leaks (rc.70), the DQL/LIKE/glob ReDoS family (rc.57/rc.63/rc.68/rc.71), the abs-path-leak class (rc.45/rc.49/rc.55/rc.57/rc.59), prototype-pollution in `feedback.ts` (rc.8), `full_text_search`/`replace_in_notes` caps + replace Unicode offset (rc.18), `frontmatter_search` value cap + read-path fold-offset (rc.21).
- **R-10 HNSW under-return** at >66%-excluded result sets — documented residual, accepted.
- **js-yaml alias/anchor "billion-laughs"** not specifically rejected — bounded by the single-user local-vault threat model. Merge-key DoS is gone (v5).
- **Bases `.base` frontmatter equality is case-SENSITIVE** by design (mirrors Obsidian); NFC-normalized but case-preserving — intentional.
- **DQL LIKE Unicode case-fold** uses `String.toLowerCase()` (not full ECMAScript canonical fold) — documented contract; under-matches ~22 exotic codepoints, never over-matches.
- **`capacity()`/`resize()`** are orphaned (test-only) HNSW API — INFO/WAI.
- **The source-`it()` test-count convention** (the canonical number is the source count gated by docs-consistency; runtime is higher via data-driven loops) — challenge only the *convention*, with reasoning, NOT as an "overclaim" (rejected ×2 already).
- **Maintainer-only items** (branch protection, required-review settings, registry-side metadata) — out of the code auditor's scope; flag but don't expect a code fix.

If you believe any "accepted" item is actually exploitable, **escalate it with a repro** — accepted ≠ immune.

---

## 12. Deliverable — ONE Markdown file, built for cross-auditor diffing (do not commit it to the repo)

Field names are stable so 4 LLM reports diff cleanly; the **JSON appendix is authoritative** on any prose conflict. **Sections C and E are GATING** — see §1.

### FRONTMATTER (YAML, exactly one of each)
```yaml
audit_id: <auditor-name>-<model>-<short-commit-sha>
graded_commit: <full sha you actually read>
methodology: <static-file-by-file | code-path-sink-tracing | runtime-differential-probing | hybrid>
methodology_blindspot: <one sentence: what your approach CANNOT see that a different methodology would>
overall_score: <0.0-5.0, ONE number; the JSON appendix MUST equal this>
ship_to_latest: <true|false>          # INVALID as true unless §C is complete+bounded AND §E priors re-RAN
severity_counts: { critical: N, high: N, medium: N, low: N, info: N }   # count ROOT CAUSES, not symptoms
novel_class_found: <true|false>
env: { os: , node: , optional_deps_built: [...], any_dep_build_failed: <true|false> }
```

### SECTION A · VERDICT (≤6 sentences)
The headline. If `ship_to_latest:true` you MUST cite §C (sink-trace complete + bounded) and §E (priors re-probed) as justification. A clean verdict not backed by C+E is invalid.

### SECTION B · COVERAGE MATRIX (one row per §9 class)
`| class | depth(0-3) | sink-rows-traced | repros-run | status(clean/finding/ENV-BLOCKED/not-covered) | notes |`
Depth honesty: a `0` is more useful than a false `3`. A `depth≥2 clean` REQUIRES its sink rows in §C. **A class you list in §H as under-covered may NOT be marked `clean` here.**

### SECTION C · SINK-TRACE TABLE — **GATING** (one row per always-on/bearer-reachable tool, enumerated from `src/tool-registry.ts` at the graded commit — do NOT trust this brief's list)
`| tool | input field | validation (file:line read) | sink (file:symbol) | cost fn O(?) | bound (value or UNBOUNDED) | repro-status |`
A "trusted (rc.N)" cell is INVALID. **A missing row for a registered always-on tool, or an UNBOUNDED+not-probed row, caps `overall_score` at 2/5.**

### SECTION D · NEW-CODE INVENTORY (change-driven)
`| new function/line since prior tag | file:symbol | probed? (Y/N) | worst-case shape emitted? |`
List every new function/line since the prior tag (`git diff`). **Unprobed new code caps your max score.**

### SECTION E · PRIOR-FINDINGS RE-VERIFICATION — **GATING** (re-RUN, do not trust the changelog)
`| prior finding | rc closed | probe you RE-RAN (pasted/described) | result (holds / REGRESSED / inconclusive) |`
**MANDATORY pass/fail rows:** (1) rc.13 hostile-FS symlink re-probe — pre-plant a symlink, re-run `writeNote` overwrite through `dist/`, Y/N escaped vault; (2) offline cache-miss network check — force a model cache-miss in `serve` mode, Y/N any outbound call.

### SECTION F · CLAIMS LEDGER (§10)
`| claimed guarantee | enforcing guard (file:line) | verdict: Holds / Partial(late-guard) / False | verification method |`

### SECTION G · FINDINGS (zero or more; ordered by severity — zero is a TOP result if C+E are complete)
Each finding is a block:
```
id: <CLASS>-<sink-file>:<symbol>      # key on the SINK file:symbol, NOT a free-text slug, so two auditors hitting the same sink COLLIDE (de-dup)
severity: CRITICAL|HIGH|MEDIUM|LOW|INFO
reachability: <tool name> · <auth? which flags?> · least-privileged-tool-empirically-reproduced-through
root_cause_of: <this id | parent id>  # amplifiers NEST under a parent, never separate-counted
sink: <file:symbol + the algorithmic reason, one line>
cost_function: <O(?) in terms of which input>
repro: <empirical | theoretical>      # empirical REQUIRES the harness+evidence below or it auto-downgrades to MEDIUM
harness: |
  <pasted ≤40-line harness source, run through dist/>
evidence: <input + measured t(n) at ≥3 sizes (n, 4n, 16n) + a small-input control, as a table; HTTP: banner/port/status. A run with non-empty stderr is INVALID.>
self_refutation: <the strongest argument this is a false positive / WAI / over-broad, and why it survives — incl. checking CAP-vs-EXEMPT + the §11 accepted set>
severity_justification: <map to the §12 rubric>
fix_sketch: <≤2 sentences; MUST state you checked it does not contradict a passing structural invariant>
confidence: <high|medium|low>
disagrees_with_maintainer: <none | "I re-verified rc.NN's verdict X and disagree because …">
```

### SECTION H · SELF-ASSESSMENT
- `under_covered:` [classes you skimmed — **anything here may NOT be `clean` in A/B**]
- `with_2x_budget:` [what you'd probe next]
- `novel_class:` <name + repro, or 'none'>
- `methodology_unique_value:` <what your lens saw that a file-by-file reader would not — the ≥2-auditor-gate statement>

### JSON APPENDIX (REQUIRED — the aggregator parses this; must match the frontmatter)
A single fenced ```json block:
```json
{ "audit_id":"", "graded_commit":"", "overall_score":0.0, "ship_to_latest":false,
  "severity_counts":{"critical":0,"high":0,"medium":0,"low":0,"info":0}, "novel_class_found":false,
  "sink_trace_complete": false, "priors_reprobed": false,
  "findings":[ {"id":"","severity":"","reachability":"","sink":"","cost_function":"","repro":"","root_cause_of":""} ],
  "env":{} }
```

### SEVERITY RUBRIC (anchored to THIS project's real rc.18→rc.20 outcomes — calibrate against them)

- **CRITICAL** — Unauthenticated remote exploit, OR **note-content-triggered** (fires through an always-on read tool with NO bearer/flag because the malicious input is a note in the vault) causing data loss, write-outside-vault, or an unrecoverable hang. (None shipped this campaign; the bar is genuinely "no auth OR purely content-triggered + severe".)
- **HIGH** — Bearer-reachable via an **ALWAYS-ON** tool (no `--enable-write`, no diagnostic flag), **empirically reproduced through that exact tool**, causing a remote event-loop DoS (multi-second hang at a legal input size) OR silent data loss/corruption. *Anchor:* the rc.17 `scanWikilinkInners` quadratic (always-on `obsidian_read_note`→`parseNote`, ~50 s at the 5 MB cap). **A finding you cannot trace to a file:symbol sink, or can only reproduce through a write/diagnostic-gated tool, is NOT HIGH.**
- **MEDIUM** — Bearer-reachable but **GATED** behind ≥1 opt-in flag (`--enable-write`, `--persistent-index`, `--diagnostic-search-tools`), empirically reproduced, causing DoS or local corruption. *Anchors (all shipped MED):* `full_text_search` uncapped query (double-flag-gated); `replace_in_notes` O(n²) + its Unicode offset (write-gated); `getOpenQuestions` CRLF-blindness (always-on but recoverable, no hang/loss → MED). **Double-opt-in-flag gating pulls a would-be HIGH down to MEDIUM.**
- **LOW** — Real, reproducible, but bounded by an existing guard, single-user-only with no security/data impact, or a doc/TSDoc drift verified against code. *Anchors:* CI coverage-comment silent-skip (rc.19); a TSDoc claim refuted by a probe; U+2028/U+2029 blindness (observable, no impact); rc.21's two read-path fold-offset siblings.
- **INFO** — Baseline/hygiene (lint warning while exiting 0; style nit; non-runtime checklist drift). Fold into a one-line baseline note; do NOT file a finding block unless it changes behavior.
- **REJECTED (counts AGAINST your precision):** an over-broad recommendation contradicting a passing invariant; a re-litigated documented-WAI item without fresh repro; a finding whose own evidence runs contradict each other (>5× same-state timing variance unreconciled); a fix worse than the non-issue; a hallucinated field/method.

> Per-item re-verification against the graded commit is expected. **A false "all-clear" (`ship_to_latest:true` with an unfilled §C) is the WORST possible outcome — worse than any over-flag.** When uncertain, say so and show your repro attempt.

---

## 13. Why this brief is different (changelog vs the rc.17 brief)

This brief was redesigned after analyzing what 4 LLM auditors did with the rc.17 brief. The deltas: (1) **obligation gating** — the sink-trace table (§12 C) and prior-finding re-probe (§12 E) are *required* and cap the score if unfilled, so a "clean" verdict is expensive to claim (the rc.17 rubber-stamp had zero sink traces); (2) **named worst-case shapes** (§6) — three auditors re-blessed the wikilink quadratic by running an *unclosed* `[[` run instead of a *dense-closed* one, so the canonical shapes are now spelled out and you must paste the input you generated; (3) **wrong-probe self-check** — a fast timing now forces a 3-point complexity curve; (4) **evidence-or-downgrade** — `empirical` requires a pasted harness + ≥3-point timing + a stderr-clean run, and self-reported effort scalars are dropped; (5) **severity anchored to real outcomes** + reachability-proof (severity = least-privileged tool you reproduced through; opt-in gating moves it DOWN); (6) **precision counts against noise** — over-broad recs that contradict a passing invariant lower your score, and you must check CAP-vs-EXEMPT before recommending a cap; (7) **anti-anchoring** — at least one pass hunts a class NOT in this brief, and a novel class is rewarded; (8) **we fixed our own ground-truth** — counts are "derive and verify yourself", not asserted (the rc.17 brief shipped its own `40 src/*.ts` drift). 

Thank you. **Findings are the deliverable; the maintainer's agent implements every fix.** Make "clean" expensive, reproduce everything through `dist/`, run the named shapes, and try to beat 12 prior auditors and an aggressive internal apparatus — the budget is yours to spend.


## 14. Round-2 specifics — what the three rc.21 auditors taught us (read before you start)

The rc.21 brief was graded by **three** independent auditors (a code-path/sink tracer, a runtime-probe auditor, a state-driven reader). All three filled the gating tables, re-ran the mandatory probes through `dist/`, and ran the named 3-point curves — the obligation gating worked. They also exposed three things to push harder on this round:

1. **TRACE EACH CORRECTNESS CLASS THROUGH BOTH THE READ *AND* THE WRITE PATH.** The single most important finding of round 1 (the line-terminator code-fence **data-corruption MEDIUM**) was found by **only one of three** auditors; the other two found only the *read-path* LOW manifestation of the same `split("\n")` root and stopped. When you find a shared primitive (a split, a fold, an offset, a regex) misbehaving in a read/observability path, **immediately check whether the same primitive backs a write/mutate path** — there the impact is data corruption, not observability, and the severity jumps a tier. The §12 C sink-trace must cover the `--enable-write` tools too, not only always-on reads.
2. **DISTINGUISH REAL LINE/SEMANTIC BOUNDARIES FROM LOOK-ALIKES.** One auditor flagged NEL/VT/FF (U+0085/U+000B/U+000C) as "line breaks" — they are not CommonMark/Obsidian line endings (they render in-line), so "fixing" them would itself be a bug. Before you call a Unicode/encoding divergence a defect, confirm the *intended* semantic (CommonMark line endings = LF/CR/CRLF; the project additionally treats U+2028/U+2029 as terminators via `stripTrailingLineEnds`) — an over-broad "fix" recommendation is scored against precision exactly like an over-broad cap (§5).
3. **A "PROMOTE / 4.x" VERDICT WITH AN OPEN FINDING IS A JUDGEMENT, NOT A FACT — JUSTIFY IT.** One auditor returned ship=true at 4.75 while a real (write-gated) finding was open; another returned ship=false on LOWs. Both are defensible, but the verdict must state, in §A, *which* open findings you are willing to ship past and *why* (severity, gating, reachability) — a bare score is not enough for a promotion gate.

Everything in §1–§13 still applies in full. This round, spend extra budget on the write-path/data-corruption dimension (§4 class 7) and on the retrieval-correctness class one auditor marked `not-covered`.
