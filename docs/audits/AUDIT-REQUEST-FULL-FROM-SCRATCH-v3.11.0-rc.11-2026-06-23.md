# External Audit Request — enquire-mcp v3.11.0-rc.11 (FULL, from scratch)

**Status:** OPEN — commissioned for the **v3.11.0 → `@latest` promotion gate**.
**Date issued:** 2026-06-23
**Supersedes:** `AUDIT-REQUEST-FULL-FROM-SCRATCH-v3.11.0-rc.9-2026-06-23.md` (this brief reflects rc.10 + rc.11, which shipped after that one and closed the entire rc.9-external-audit cascade).
**Repository:** https://github.com/oomkapwn/enquire-mcp (public, MIT) · npm `@oomkapwn/enquire-mcp`
**Target of audit:** `@rc` = **3.11.0-rc.11**. Pin the exact commit before you start:

```bash
git clone https://github.com/oomkapwn/enquire-mcp && cd enquire-mcp
git checkout main && git rev-parse HEAD          # record this SHA in your report
npm view @oomkapwn/enquire-mcp@rc version          # must read 3.11.0-rc.11
```

> The authoritative target is the **squash-merge commit on `main`** tagged `v3.11.0-rc.11` (squash SHA `5953225`, from PR #288 / branch `audit/v3.11.0-rc.11-dos-caps-tail`). Grade THAT commit and cite its SHA in every finding. `@latest` is **3.10.1** (stable); the v3.11.0 line is on `@rc` pending this audit + the ≥2-auditor gate.

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

A **comprehensive, adversarial, from-scratch audit of the entire project** — every `src/` module, every doc, every workflow/script/config — **with extra scrutiny on the recent changes** (the v3.11.0 line: rc.1 → rc.11, summarized in §6). Find real defects the internal apparatus is blind to.

This is the project's **independent-external-auditor #N** for the v3.6.1 promotion gate ("≥2 independent external auditors with **different** methodologies before `@rc → @latest`"). Use whatever methodology you favor (STRIDE, state-driven file-by-file, change-driven diff review, property/fuzz, dependency/supply-chain, threat-model) — but tell us which, because methodological diversity is the point.

**Two things we value most:**
1. **Behavioral / runtime / concurrency / encoding defects** — see §4 for where the internal gates are *structurally blind*. That's the highest-yield territory.
2. **Adversarial re-verification of the maintainer's own recent verdicts** — especially the rc.10 NFC-class "TRULY closed" claim and the rc.11 reasoned-rejections (§6.6). We explicitly invite you to try to prove us wrong.

The two prior external auditors on this line found genuine HIGHs the internal change/claim-driven gates could not (rc.9→a partial-fix that left a producer-side data-corruption + a parallel key surface uncovered; both shipped as HIGH in rc.10). That is exactly the value we are paying for: **state-driven data-path reading + feeding real malformed inputs** to a behavioral surface our gates only describe.

---

## 2. Project overview (so you can reason about impact)

**enquire-mcp** is a TypeScript **Model Context Protocol (MCP) server** that turns a local Obsidian (Markdown) vault into a long-term, *grounded* memory/retrieval layer for AI agents. Local-first, vendor-neutral, **zero outbound network calls in `serve` mode** (a load-bearing privacy claim — verify it). Distinct from chat-memory tools (mem0/Zep/Supermemory): it recalls the Markdown the user actually wrote — cited, auditable, editable — never a paraphrase.

- **Scale:** 40 `src/*.ts` modules (~5,100 source lines), **46 MCP tools** (34 always-on read + 4 opt-in diagnostic + 7 write gated by `--enable-write` + 1 feedback gated by `--feedback-weight`), **19 MCP prompts**, 3 resources. **80 test files / 1359 canonical `it()`** (data-driven loops expand the runtime count higher, ~1456); 19+ `*-invariant.test.ts`; 16 `scripts/*.mjs`; 4 GitHub workflows.
- **Retrieval stack:** BM25 (SQLite FTS5) + TF-IDF + dense ML embeddings (transformers.js, int8-quantized), RRF-fused, BGE cross-encoder rerank, HNSW ANN (live-update + disk persistence), wikilink graph-boost, GraphRAG-light (Louvain communities), HyDE + sub-question, Obsidian Bases (`.base`) DSL, PDF text + OCR (Tesseract). Forgetting-aware staleness (`age_days`/`stale`, opt-in recency re-rank). Closed-loop feedback (`obsidian_mark_useful`, opt-in).
- **Transports:** stdio + Streamable HTTP (bearer auth, rate-limit, CORS). The HTTP path is the **remote attack surface** — anything an authenticated MCP client can reach over `serve-http` is in scope for DoS / info-leak / corruption.
- **Optional deps (6):** `@huggingface/transformers`, `@napi-rs/canvas`, `better-sqlite3`, `hnswlib-node`, `pdfjs-dist`, `tesseract.js`. The server must degrade gracefully (fail-soft) when any are absent.
- **Threat model (single-user, local vault):** the vault owner is trusted; the *agent/MCP client* is semi-trusted (could be driven by untrusted content the user pasted); on `serve-http`, a bearer-authenticated client is the adversary for DoS/leak. Note files themselves may contain adversarial content (prompt-injection text, pathological regex/markdown, hostile frontmatter, NFD-decomposed Unicode).

Authoritative docs to read first: `README.md`, `CLAUDE.md` (the maintainer's North-Star + the running anti-pattern ledger — read this; it tells you the project's own list of recurring failure classes), `SECURITY.md`, `STABILITY.md` (the semver contract), `docs/api.md`, `CHANGELOG.md` (esp. the rc.1→rc.11 entries).

---

## 3. Codebase map (every module + its role)

Read each. Cross-reference TSDoc claims against implementation (TSDoc-vs-reality drift is a documented recurring class).

| Module | Role / what to scrutinize |
|---|---|
| `index.ts` | entrypoint, `VERSION`, CLI dispatch |
| `cli.ts`, `cli-help.ts` | arg parsing, all subcommands + flag help (cli-parity invariants exist) |
| `server.ts` | stdio server wiring, `prepareServerDeps`, boot-time bulk index build, signal/shutdown orchestration |
| `http-transport.ts` | **remote surface** — bearer auth, rate-limit, CORS, stateful session registry, `pendingInits`/`inFlight` refcounts, graceful shutdown |
| `shutdown.ts` | signal-driven teardown ordering |
| `tool-registry.ts`, `tool-manifest.ts` | tool registration + gating (the single source of truth for the 46-tool count + `readOnlyHint`); **rc.11 added `MAX_QUERY_LEN`/`MAX_TAG_ARG_LEN` input caps** |
| `prompts.ts` | 19 MCP prompts |
| `vault.ts` | **core FS boundary** — path traversal guards, `*Safe` fs wrappers (abs-path-leak sanitizer), atomic create/rename/append, privacy filter (`--exclude-glob`/`--read-paths`), `isExcluded`, `globToRegex` (non-backtracking matcher), NFC name folding entrypoints |
| `name-fold.ts` | **canonical Unicode folders** `foldName`/`foldTag`/`nfcLower`/`nfc` + **`lookupFoldedKey`** (rc.10 — case/NFC-insensitive frontmatter KEY lookup) |
| `parser.ts` | frontmatter+body split, wikilink/embed/**tag** extraction (`INLINE_TAG_RE`, rc.10 NFC-before-match + shared), `bodyStartLine` (line-number arithmetic) |
| `frontmatter.ts` | js-yaml@5 parse/stringify port (replaced gray-matter rc.53; YAML 1.2 scalar contract, `coerced` flag, Date handling) |
| `tools/read.ts` | always-on read tools (list/search/neighbors/stats/tags/chat-thread/frontmatter); **rc.10 routed `frontmatter_get`/`frontmatter_search` through `lookupFoldedKey`** |
| `tools/write.ts` | `--enable-write` tools (create/append/rename/replace/archive/frontmatter_set/validate_note_proposal); backlink-rewrite plan; write-fidelity |
| `tools/search.ts` | hybrid search orchestration, RRF, rerank, graph-boost, recency, `filter_frontmatter` (rc.10 key-fold), adaptive HNSW refill, privacy-filter terminal pruning; TF-IDF tokenizer (rc.10 NFC); **rc.11 `searchText` scan cap** |
| `tools/meta.ts` | `obsidian_open_questions` (ReDoS-sensitive; worker sink-bound), wikilink lint, tag suggest (`INLINE_TAG_RE`), paper audit, `findBestMatch`, `validateNoteProposal` (**rc.11 `yaml.coerced` surfaced**) |
| `tools/media.ts` | `read_canvas`, `read_pdf`, `ocr_pdf`, list-pdfs/canvases/bases |
| `tools/limits.ts` | `capScanEntries` resource cap |
| `dql.ts` | Dataview-query subset parser+executor (always-on, remote-reachable); `MAX_DQL_QUERY_LEN`; non-backtracking LIKE matcher; NFC value/tag folding |
| `bases.ts` | Obsidian Bases `.base` DSL parser+executor (always-on, remote-reachable); predicate eval; NFC folding; resource caps; **rc.10 made the inline-tag regex Unicode-aware (`\p{L}`+`u`)** |
| `communities.ts` | Louvain community detection, wikilink graph |
| `embeddings.ts` | transformers.js embedder/reranker, per-alias session cache, **offline enforcement** (`setEmbeddingsOffline`) |
| `embed-db.ts`, `embed-pipeline.ts` | SQLite embed store (`peekEmbedDbMeta` never-throw peek), chunking, upsert/delete, signatures |
| `fts5.ts` | SQLite FTS5 index (`peekFtsMetaSafe` never-throw peek), tokenization, escaping, **the persisted tag column (rc.10 producer-NFC heals it)** |
| `hnsw.ts` | hnswlib-node wrapper — `applyDiff`/`resize`/`capacity`, disk persistence, signature-guard rebuild |
| `wildcard-match.ts` | non-backtracking DP matcher backing LIKE + glob (the ReDoS class-ender) |
| `optional-dep.ts` | `optionalDepDetail` — strips abs paths from optional-dep load errors (leak class) |
| `pdf.ts`, `ocr.ts` | pdfjs + Tesseract; resource cleanup (try/finally), canvas-OOM cap, OCR offline enforcement, page-range arithmetic |
| `staleness.ts` | `computeStaleness`/`recencyScore` (forgetting-aware) |
| `feedback.ts` | **rc.1 feature** — `FeedbackStore` (per-vault sidecar, null-proto map after rc.8), persistChain serialization, scoring |
| `retrieval-opts.ts` | shared serve/serve-http retrieval flag parsing + validation |
| `rrf.ts`, `periodic.ts`, `eval.ts`, `doctor.ts` | RRF fusion; periodic-notes date tokens; eval harness; `doctor` health check |

---

## 4. Where the internal apparatus is **blind** — aim here

The project has 12 OIA checks (`scripts/oia-walk.mjs`) + 19+ invariant tests. Per the maintainer's own meta-audit (CLAUDE.md, "rc.36"), **~85% of these are drift/claim-driven** — they verify that a *doc claim* matches a number/version/string. They are **structurally blind** to:

1. **Concurrency / shared-mutable-state interleave** — async chains mutating shared singletons (watcher HNSW index + `rowsByLabel`, the shared `FeedbackStore`, the HTTP session registry, embed-db connections). A real interleave passes every gate.
2. **Runtime DoS / algorithmic complexity** — O(n²)/O(K×N) amplifiers, unbounded scans, ReDoS, OOM, on always-on **remotely-reachable** tools (`dataview_query`, `query_base`, `open_questions`, `read_canvas`, `validate_note_proposal`, `search`). The drift gates read text, not control-flow cost. (rc.11 added `.max()` caps + a `searchText` scan cap — verify they're complete and that no remote string still reaches a superlinear sink uncapped.)
3. **Encoding correctness** — Unicode NFC/NFD on macOS APFS (names, tags, frontmatter keys+values), surrogate splitting, case-folding under the sink's actual flags. (rc.9 closed the tag *consumer* surface; rc.10 closed the tag *producer* regex + the frontmatter-*key* surface. Look for the *next* uncovered identity/encoding surface — the producer→store→compare data path is the place a previous "closed" claim was actually only ⅓ done.)
4. **Info-disclosure** — absolute host paths / cache layout leaking to a bearer-auth client via error messages (the abs-path-leak + optional-dep-leak classes). Verify EVERY error a `serve-http` client can elicit is path-free.
5. **Claimed-guarantee vs. code-guard** — any "blocked"/"zero outbound"/"fails closed"/"never throws"/"SLSA L2"/"enforced"/"throws if" claim in SECURITY.md/TSDoc/README must point at a real guard. Find a claim with no enforcing code path. (This class has produced multiple HIGHs; a "closed" CHANGELOG claim is itself a claim to verify.)
6. **Right-to-erasure / data-at-rest** — every on-disk artifact a writer creates (caches, sidecars, FTS/embed/HNSW/feedback files, `.tmp` leftovers) must be erased by `prune`/`clear-cache`/`clear-embeddings` as appropriate; check writers ⊆ erasers and that no raw note text survives a decommission.
7. **Write-path fidelity / data-loss** — create/rename/append/replace/frontmatter_set under edge cases (case-insensitive FS, backlinks to source/dest, non-mapping frontmatter, concurrent writers, line-number arithmetic with frontmatter).
8. **Test-theater** — tests that pass without exercising the code they claim to (silent `return` skips on security surfaces, vacuous assertions, invariants whose detector can't actually fire, NEGATIVE controls that are commented out/empty). **Note especially:** a behavioral test that doesn't *generate the failing input shape* (e.g. an NFD inline tag, an adjacency-shaped regex) is the project's repeated blind spot ("generator-blindspot": rc.9/rc.25/rc.36). When you assess a behavioral test, ask "can its inputs even produce the bug it claims to guard?"

These eight are the maintainer's own enumerated blind spots. The most valuable findings live here.

---

## 5. Baseline — reproduce the green state, then go beyond it

Run the full gate battery to confirm the repo is clean (so any defect you find is genuinely *uncaught*, not a known-red):

```bash
npm ci
npm run build                 # tsc strict + noUncheckedIndexedAccess
npm test                      # ~1359 it() (+ data-driven expansion to ~1456)
npm run test:coverage         # per-file floors; regenerates coverage/coverage-summary.json
npm run lint                  # biome, 0 findings
npm run check:version-consistency   # 7 surfaces + CLAUDE roll-up marker
npm run check:oia             # 12 state-driven walks
node scripts/check-audit.mjs  # scoped npm-audit gate (ALLOWLIST is empty = strictest)
node scripts/smoke.mjs        # synthetic-vault tools/list + initialize
npm pack --dry-run            # packaged file set
```

All of the above are expected to pass on rc.11. If any fails on a clean checkout, that itself is a finding. Then audit beyond what these check.

---

## 6. Recent changes — audit these hardest (v3.11.0 line, rc.1 → rc.11)

Read the CHANGELOG entries for each. Treat all of this as fresh, possibly-under-baked code.

### 6.1 rc.1 — closed-loop feedback (`obsidian_mark_useful`), the 46th tool — `src/feedback.ts`
Opt-in (`--feedback-weight <0..1>`, default 0 = no tool, provable no-op). An agent records which recalled notes helped; a per-note tally blends into `obsidian_search` ordering. State in a per-vault `<hash>.feedback.json` sidecar (relative paths + integer counts + ISO ts ONLY — **no note content, no query text**; 0700 dir / 0600 file; atomic tmp+rename; cap 100k entries). Shared single instance across HTTP sessions. **Scrutinize:** the sidecar's data-at-rest claims (no content/query leakage), the `record()` read-modify-write under concurrent serve-http calls (persistChain serialization), prune-erasure coverage, and the `readOnlyHint:false` K-3 classification. (rc.8 fixed a prototype-pollution here — see 6.4; verify the fix and look for siblings.)

### 6.2 rc.6 — `js-yaml` 4 → 5 migration — `src/frontmatter.ts`, `src/bases.ts`
A behavioral major (YAML 1.2; no Date coercion → timestamps load as strings; `load("")` throws; merge-key `<<` removed). **Scrutinize:** frontmatter round-trip fidelity (a `frontmatter_set` on one key must not mutate/reformat others), scalar resolution edge cases (octal/sexagesimal/underscore/booleans/dates), `.base` parse of empty/odd YAML, and that the merge-key-DoS is genuinely gone at the root (not just advisory-allowlisted).

### 6.3 rc.5 — dependency majors — `@types/node` 26, `actions/checkout` 7 (js-yaml@5 was rc.6)
Verify SHA-pins on all GitHub Actions are correct + comments match; no supply-chain regressions; `npm audit` clean (the scoped gate's allowlist is empty).

### 6.4 rc.8 — pre-promotion self-audit response (1 MED + 4 LOW)
- **MED — prototype-pollution in `feedback.ts`:** agent path strings keyed a plain-object map → `paths:["__proto__"]` polluted `Object.prototype` (bearer-reachable when `--feedback-weight>0`). Fixed → null-prototype map. **Verify the fix is complete and find any sibling** where agent-controlled strings become object keys without `z.record()` key-stripping (this was claimed to be the *only* such tool — confirm or refute).
- LOW: DQL frontmatter-value NFC; `renameNote` case-variant dest-exclusion data-loss; `CITATION.cff` stale + drift guard; COMPARISON tool-count version label.

### 6.5 rc.10 — second external auditor's HIGHs: the NFC class TRULY closed across PRODUCER + KEY — **re-verify "TRULY closed"**
A second external auditor (graded the rc.9 commit) confirmed all three rc.9 downgrades AND correctly disputed the rc.9 "L-TAG-1 closed" claim as a **partial fix** — the exact ingest→store→compare data-flow gap that defines this project's signature failure. rc.10 shipped two HIGHs:
- **M1 (HIGH) — producer tag regexes dropped `\p{M}` combining marks.** On macOS APFS an NFD inline `#café` (`cafe`+U+0301) was captured as `cafe` *before* the rc.9 `nfc()` ran (normalize-after-extraction is too late), **corrupting the persisted FTS5 tag column**. Fixed by NFC-normalizing the body *before* the regex at every producer (`parser.ts` `INLINE_TAG_RE`, `meta.ts` (dedup'd to the shared const), `bases.ts` (now `\p{L}`+`u`, was ASCII-only and dropped all non-Latin tags), + `search.ts` TF-IDF tokenizer). **Verify:** is the *whole* data path (extract→store→compare) now NFC-consistent for tags? Are there OTHER producers that extract an identity token with a char-class that excludes combining marks (headings? wikilink targets? frontmatter list values)? Does a pre-rc.10 on-disk FTS5 index that holds the corrupted `cafe` heal correctly on reindex (the CHANGELOG claims it does)?
- **H1 (HIGH) — frontmatter KEY lookups not case/NFC-folded.** rc.9 folded *values*; `frontmatter[key]`/`key in frontmatter` stayed exact-string at 6 sites (`search` filter_frontmatter, `dql` resolveField, `bases` ×2, and `read.ts` `frontmatter_get`+`frontmatter_search` — the last two the auditor itself missed). Fixed with `lookupFoldedKey` (fold at LOOKUP time: exact-wins, first-own-key-wins on collision; never destructive at parse → write fidelity preserved). **Verify:** is `lookupFoldedKey` used at EVERY frontmatter-key read across the codebase, or is there a 7th site? Is the collision rule (first own key wins) deterministic and safe? Could it ever return a value for a key the user didn't mean (over-folding)?
- **Structural defenses added:** a producer-completeness invariant (behavioral NFD/non-Latin extraction + a static "no ASCII-only `#[A-Za-z]` tag regex" gate) and a key-lookup invariant. **Challenge these:** is the producer-completeness detector non-vacuous and complete (does it catch every shape of an identity-extracting regex, or only the `#[A-Za-z]` shape)? Could a new producer escape it?

### 6.6 rc.11 — rc.9-audit LOW/INFO tail (3 LOW fixed; the rest reasoned-to-verdict) — **re-check the reasoned-rejections**
This RC closed the cascade. We re-verified each remaining finding; **independently re-check our conclusions:**
- **L1 (LOW, fixed) — DoS input caps.** `.max(MAX_QUERY_LEN=4096)` on `obsidian_search`/`obsidian_context_pack`/`obsidian_search_text` `query`; `.max(MAX_TAG_ARG_LEN=256)` on `obsidian_paper_audit` `tag`; `parser-input-cap-invariant` extended with 3 always-on entries. **Verify:** is EVERY remotely-reachable free-form string that feeds a superlinear per-note scan now capped (the invariant is a curated inventory — is it complete)? Any always-on tool string still uncapped?
- **L2 (LOW, fixed) — `searchText` whole-vault scan** now `capScanEntries`-bounded (parity with `findSimilar`). Tool is `--diagnostic-search-tools`-gated.
- **L4 (LOW, fixed) — `validate_note_proposal` surfaces `yaml.coerced`** + a `frontmatter-non-mapping` warning, so a green validate doesn't mislead before a `frontmatter_set` refusal (rc.64).
- **Reasoned-to-verdict (no code — challenge the acceptance if you disagree, with a repro):**
  - **L3 (chmod, multi-user host) → ACCEPTED:** feedback sidecar is 0600 + per-write chmod; a shared-host adversary is outside the single-user local-vault threat model.
  - **L5 (feedback concurrency test) → ALREADY_OK:** rc.4 reworked it to assert zero tmp-rename collisions (mutation-verified). *Re-check it isn't test-theater.*
  - **I6 (name-fold detector "inverse shape") → WON'T-FIX:** the inverse `nfcLower(s.replace(/^#/,""))` pattern is functionally CORRECT (NFC+case-fold); flagging correct-but-non-canonical code would be a false positive (per the project's "don't chase EDA-precise detection" rule). *Confirm the inverse shape is genuinely safe everywhere it appears.*
  - **M2 / M3 / I2 / I3 → ALREADY_OK** (rc.10 re-verification: backlink rewrite folds via `findBestMatch`; `clear-cache` erases `.tmp` since rc.36; HNSW reader/writer both synchronous → no interleave). *The HNSW-synchronicity claim (T-MED-1 from the rc.9 round) is the one we most want re-challenged — see below.*

### 6.7 The single verdict we most want re-challenged (carried from rc.9)
**T-MED-1 — "the watcher HNSW critical section is fully synchronous, so cross-file events cannot interleave."** The maintainer downgraded the prior auditor's MED to a FALSE POSITIVE and pinned the property with `tests/hnsw-sync-critical-section.test.ts` (no `await` in the critical section). **Challenge this hard:** is `HnswIndex.applyDiff` + `watcher.syncHnswForFile` truly await-free on every path (md / pdf / unlink)? Is there ANY interleave or lost-update window between embed-db upsert, HNSW apply, the shared `rowsByLabel` mutation, and the close-time disk flush — or against a second writer? Is "no-await" the right guarantee, or is there a residual?

### 6.8 Cross-cutting recent surfaces
9-language READMEs (rc.2/i18n — anchor integrity + per-language numeric claims), forgetting-aware staleness (rc.10-of-the-3.10-line), frontmatter-aware `filter_frontmatter` search.

---

## 7. Comprehensive coverage checklist (by class)

For each class: is it fully closed, or is there an uncovered sibling/surface? (The project's signature failure mode is "instance fixed, adjacent sibling missed" — see rc.9→rc.10.)

- [ ] **STRIDE / security:** auth (bearer `timingSafeEqual`, min-length), rate-limit, CORS (expose/allow headers), path traversal, symlink escape, input validation (zod `.max()` on every remotely-reachable string — rc.11 added several; is it complete?), injection (FTS5/SQL/DQL/glob), prototype pollution.
- [ ] **ReDoS / catastrophic backtracking:** every site that compiles a RegExp from user/agent/config input (DQL `like`, glob, `open_questions` pattern, any other `new RegExp`). The non-backtracking DP matcher (`wildcard-match.ts`) + the worker sink-bound (`open_questions`) are the class-enders — find a sink they don't cover.
- [ ] **Unicode / NFC / encoding:** names, tags (rc.9 consumer + rc.10 producer), frontmatter keys (rc.10) + values (rc.8/rc.9), DQL/bases field names, surrogate-pair splitting in chunking/snippets, case-fold under `/i`/`/u`. **Look for the next identity-extracting char-class that excludes combining marks.**
- [ ] **Concurrency:** every long-lived shared-mutable singleton — serialized or provably interleave-safe? (watcher HNSW/rowsByLabel/embed-db [§6.7], FeedbackStore, SessionRegistry, module-level caches.)
- [ ] **Resource / DoS caps:** every always-on whole-vault scanner CAP-or-EXEMPT (`resource-bound-invariant`); per-request amplifiers on remote tools; canvas/PDF/OCR memory caps; HNSW growth; **every remote free-form string `.max()`-capped (rc.11)**.
- [ ] **Info-disclosure:** every error reachable by a serve-http client is abs-path-free (vault root, cache dir, home, model-cache). Force the error paths.
- [ ] **Optional-dep leaks:** every `await import()` of an optional dep funnels load errors through `optionalDepDetail`; no raw `${err.message}` reaches a client.
- [ ] **Right-to-erasure / data-at-rest:** writers ⊆ erasers for every cache/sidecar/`.tmp`/feedback file; no raw note text survives `prune`/`clear-*`; SECURITY.md content-at-rest claims true.
- [ ] **Write-fidelity / data-loss:** create/rename/append/replace/frontmatter_set atomicity + edge cases; line-number arithmetic (frontmatter offset); backlink-rewrite plan correctness; case-insensitive FS; non-mapping frontmatter (rc.64/rc.11 `coerced`).
- [ ] **Claimed-guarantee vs code-guard:** "zero outbound in serve" (embeddings/reranker/OCR offline enforcement), SLSA L2, fail-closed `.base` predicates, `*Safe`/peek never-throw, "fails closed" privacy filter, and **every "closed"/"complete" CHANGELOG claim on the rc.10/rc.11 fixes**.
- [ ] **MCP contract:** `readOnlyHint` correctness (K-3: every fs/state mutator — including `markUseful` — is in `KNOWN_WRITE_HANDLERS`), tool schemas, error shapes, stateful session lifecycle.
- [ ] **Supply-chain:** SHA-pinned actions + correct comments; `run:`-download content-pinning (mcp-publisher); `overrides` correctness; `check-audit.mjs` allowlist (empty) justified; phantom/undeclared deps; `files[]` accuracy.
- [ ] **Docs / claim-vs-reality:** counts (46 tools / 19 prompts / 1359 tests) across README ×9, llms.txt, AGENTS.md, STABILITY, COMPARISON, api.md, server.json, CITATION; version currency; CLI flag docs vs real `.option()`s; README anchor integrity; TSDoc-vs-impl drift.
- [ ] **Test/CI integrity:** no silent-skip on security surfaces (CI-GUARD pattern); no vacuous/test-theater assertions; every `*-invariant.test.ts` has a real NEGATIVE control (meta-invariant); behavioral tests *generate the failing input shape*; coverage floors honest; flake-blocks-release risks.
- [ ] **Retrieval correctness:** RRF fusion, rerank application, graph-boost, recency blend, `filter_frontmatter` (rc.10 key-fold), chunking parity (FTS5 vs embeddings), HNSW under-return, eval metric correctness (no >1.0 inflation, dedupe).

---

## 8. Specific high-value questions we most want challenged

1. Can a **bearer-authenticated serve-http client** hang the event loop or exhaust memory through any always-on tool (`dataview_query`, `query_base`, `open_questions`, `search`, `read_canvas`, `validate_note_proposal`, `read_pdf`/`ocr_pdf`)? The rc.11 caps were the latest hardening — find the sink they missed. Provide a concrete repro.
2. Is the **NFC class now genuinely complete** across the full ingest→store→compare path (names, tags producer+consumer, frontmatter keys+values), or is there a 7th key-lookup site / another identity-extracting regex that drops combining marks? (rc.9 claimed "closed" and was ⅓ done — we want this stress-tested.)
3. Is the **T-MED-1 "synchronous HNSW critical section" claim** actually airtight (§6.7)? Find any interleave/lost-update/torn-state window.
4. Is the **prototype-pollution fix** (rc.8) complete, and is `feedback.ts` truly the only tool turning agent strings into object keys?
5. Does **any** error message reachable over serve-http leak an absolute host path or cache layout?
6. Is **"zero outbound network calls in serve mode"** genuinely enforced for embeddings, reranker, AND OCR — including cache-miss paths? Or can a crafted query/PDF trigger a CDN fetch?
7. Any **write-path data-loss** beyond the rc.60/rc.61/rc.8/rc.64 cases (case-insensitive FS, backlinks, non-mapping frontmatter, concurrent same-note writes)?
8. Any **test-theater** — a test (especially a security/invariant test, or the rc.10 producer-completeness / key-lookup invariants) that would still pass if the code it guards were broken, or whose inputs can't produce the bug it claims to guard?

---

## 9. Out of scope / known-accepted (do not re-flag as new — but DO challenge the acceptance if you disagree)

These are documented, deliberate decisions (cite the source if you contest them):
- **R-10 HNSW under-return** at >66%-excluded result sets — documented residual, accepted.
- **js-yaml alias/anchor "billion-laughs"** not specifically rejected — bounded by the single-user local-vault threat model (SECURITY.md). Merge-key DoS *is* gone (v5).
- **Bases `.base` frontmatter equality is case-SENSITIVE** by design (mirrors Obsidian Bases); rc.9 made it NFC-normalized but case-preserving — intentional, not a bug.
- **DQL LIKE Unicode case-fold** uses `String.toLowerCase()` (not full ECMAScript canonical fold) — documented contract (rc.75); under-matches ~22 exotic codepoints, never over-matches.
- **`capacity()`/`resize()`** are orphaned (test-only) HNSW API — INFO/WAI (rc.9).
- **rc.11 reasoned-rejections (L3 chmod multi-user · L5 already-OK · I6 inverse-fold-shape WON'T-FIX · M2/M3/I2/I3 already-OK)** — documented in §6.6; escalate with a repro if you disagree.
- **Maintainer-only items** (branch protection, required-review settings, registry-side metadata) — out of the code auditor's scope; flag but don't expect a code fix.

> Note: the rc.9 brief listed "bases.ts tag-extraction is ASCII-regex-scoped" as an accepted narrowing — **that is no longer true.** rc.10 (M1) made it Unicode-aware (`\p{L}`+`u`); it now matches non-Latin tags. Do not treat ASCII-only tag extraction as accepted.

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
- **Repro:** concrete steps / input that triggers it (a failing snippet, a crafted query, a codepoint) — empirical beats theoretical
- **Blast radius / impact:** what actually breaks (DoS, data-loss, leak, wrong result, crash)
- **Recommended fix (DESCRIBE, do not apply):** prose; name the root-cause fix + any sibling sweep + a structural defense (invariant) if applicable
- **Confidence:** high / medium / low; note if you could not run it
```

Plus: an executive summary (counts by severity), the **methodology you used** (for the diversity gate), the **commit SHA you graded**, and an explicit statement of any finding where you **re-verified and DISAGREE with the maintainer's rc.8/rc.9/rc.10/rc.11 verdict**.

**Severity rubric:** CRITICAL = remote/unauth code-exec, silent data-loss, or trivially-remote DoS; HIGH = bearer-reachable DoS/leak/data-loss, or a broken security guarantee; MEDIUM = bounded/conditional version of those, or a real correctness bug; LOW = narrow/edge-case correctness or hardening; INFO = doc/claim drift, dead code, style with a correctness angle.

Per-item re-verification against the graded commit is expected — stale findings (re-flagging something already fixed in rc.1→rc.11) and false positives both reduce signal; when uncertain, say so and show your repro attempt.

Thank you. Findings are the deliverable; the maintainer's agent implements every fix.
