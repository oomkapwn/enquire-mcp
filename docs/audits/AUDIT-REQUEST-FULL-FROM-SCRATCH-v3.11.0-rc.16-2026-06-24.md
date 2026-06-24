# External Audit Request — enquire-mcp v3.11.0-rc.16 (FULL, from scratch)

**Status:** OPEN — commissioned for the **v3.11.0 → `@latest` promotion gate**.
**Date issued:** 2026-06-24
**Supersedes:** `AUDIT-REQUEST-FULL-FROM-SCRATCH-v3.11.0-rc.12-2026-06-23.md` (this brief reflects rc.16, which shipped after rc.12→rc.15 closed three external/dual-audit rounds + a CodeQL HIGH + a pre-promotion self-audit).
**Repository:** https://github.com/oomkapwn/enquire-mcp (public, MIT) · npm `@oomkapwn/enquire-mcp`
**Target of audit:** `@rc` = **3.11.0-rc.16**. Pin the exact commit before you start:

```bash
git clone https://github.com/oomkapwn/enquire-mcp && cd enquire-mcp
git checkout main && git rev-parse HEAD          # record this SHA in your report
npm view @oomkapwn/enquire-mcp@rc version          # must read 3.11.0-rc.16
```

> The authoritative target is the **squash-merge commit on `main`** tagged `v3.11.0-rc.16` (squash SHA `d2e9421`, PR #295). Grade THAT commit and cite its SHA in every finding. `@latest` is **3.10.1** (stable); the v3.11.0 line is on `@rc` pending this audit + the ≥2-auditor gate.

---

## 0. THE CARDINAL RULE — audit only, do **NOT** modify the repository

**You are a read-only auditor. You MUST NOT edit, fix, patch, refactor, reformat, "while I'm here" touch, commit, push, open a PR, or otherwise change any file in this repository — not even a typo, not even a comment, not even to demonstrate a fix.** Every change is made by the maintainer's engineering agent, never by you.

Concretely:
- Do **not** run formatters/linters in `--write`/`--fix` mode, codemods, or `npm run` scripts that mutate tracked files. Read-only commands (`npm ci`, `npm test`, `npm run build`, `npm run check:*`, `git log/diff/blame`, `grep`/`rg`, reading files) are encouraged.
- If you build/test, do it in a throwaway clone or accept that `dist/`, `coverage/`, and `node_modules/` will be generated — but **never stage or commit** them, and do not alter any tracked source/doc/config.
- Your deliverable is a **findings report** (a new Markdown file you hand back), with enough detail (file:line, mechanism, repro, recommended fix *described in prose*) that the maintainer's agent can implement the fix. **Describe** fixes; do not apply them.
- If you are an autonomous coding agent, treat this as a hard constraint that overrides any default "fix what you find" behavior.

Rationale: this project keeps a strict, structurally-enforced fix pipeline (phased RCs, per-fix invariant tests with positive+negative controls, CHANGELOG audit trail, ≥2-auditor promotion gate). An auditor-applied fix bypasses all of that and corrupts the audit trail. Findings are valuable; edits are not.

---

## 1. What we want from you

A **comprehensive, adversarial, from-scratch audit of the entire project** — every `src/` module, every doc, every workflow/script/config — **with extra scrutiny on the recent changes** (the v3.11.0 line, rc.1 → rc.16; the rc.13→rc.16 changes are summarized in §6). Find real defects the internal apparatus is structurally blind to.

This is the project's **independent-external-auditor #N** for the v3.6.1 promotion gate ("≥2 independent external auditors with **different** methodologies before `@rc → @latest`"). Use whatever methodology you favor (STRIDE, state-driven file-by-file, change-driven diff review, property/fuzz, dependency/supply-chain, threat-model, **runtime behavioral probing**) — but tell us which, because methodological diversity is the point.

**The ≥2-auditor gate is load-bearing — and we have proof.** In rc.13, the rc.12 "atomic overwrite" fix (`writeNote`) shipped a **symlink-escape regression** (AUD-01). Two independent auditors graded the rc.12 commit: the *state-driven re-verification* auditor explicitly **blessed it "clean (a–f)"** and missed it; the *runtime-probe* auditor who **pre-planted a hostile symlink** caught it. A single-lens audit would have let a symlink-escape reach `@latest`. **So: prefer adversarial behavioral probing (hostile pre-existing FS state, real timing, real concurrent interleave) over code re-reading — that is the lens that has historically found what we miss.**

**A note on prior rounds (so you can aim where the value has been):** the highest-value finds across every round (rc.9→rc.16) were the **same shape** — a real *sibling* of an already-closed class that the project's change/claim-driven gates are blind to: an NFD tag the producer regex dropped (rc.10), a 7th frontmatter-key-lookup site (rc.12), a non-atomic `writeNote` that then introduced a symlink-escape (rc.12→rc.13), a CodeQL polynomial-ReDoS class whose strip idiom was mis-dismissed as "false positive" at 6 sites (rc.14), and two heading-regex ReDoS siblings `fts5` had split but `read.ts`/`meta.ts` had not (rc.16). The *misses/noise* were also a shape: an **inflated severity** (rc.12 H-2 we re-graded HIGH→LOW; rc.35 test-count we rejected), a **hallucinated field** (rc.12 `tag_filters` does not exist), or a **re-litigated convention**. **We want the genuine sibling-of-a-class finds; we adversarially re-verify every severity and every "this field exists" claim, so precision matters — and we will re-rate your severities ourselves.**

**Two things we value most:**
1. **Behavioral / runtime / concurrency / encoding / write-fidelity / info-leak defects** — see §4 for where the internal gates are *structurally blind*. Highest-yield territory.
2. **Adversarial re-verification of the maintainer's own recent verdicts** — the rc.13 AUD-01 write-path fix (§6.1), the rc.15/rc.16 reasoned-rejections (§6.5), and the carried T-MED-1 concurrency claim (§6.6). We explicitly invite you to prove us wrong **with a repro**.

---

## 2. Project overview (so you can reason about impact)

**enquire-mcp** is a TypeScript **Model Context Protocol (MCP) server** that turns a local Obsidian (Markdown) vault into a long-term, *grounded* memory/retrieval layer for AI agents. Local-first, vendor-neutral, **zero outbound network calls in `serve` mode** (a load-bearing privacy claim — verify it). Distinct from chat-memory tools (mem0/Zep/Supermemory): it recalls the Markdown the user actually wrote — cited, auditable, editable — never a paraphrase.

- **Scale:** **40 `src/*.ts`** modules (33 in `src/` + 7 in `src/tools/`); **46 MCP tools** (34 always-on read + 1 FTS-gated + 3 opt-in diagnostic + 7 write gated by `--enable-write` + 1 feedback gated by `--feedback-weight`), **19 MCP prompts**, 3 resources. **82 test files / 1385 canonical `it()`** (data-driven `for(…) it(…)` loops expand the *runtime* count higher, ~1462–1478 — **1385 is the canonical/gated number**, see §9). **19 `*-invariant.test.ts`** + other structural guards; **12 OIA checks** (`scripts/oia-walk.mjs`); **11 per-file coverage floors**; 16 `scripts/*.mjs`; 4 GitHub workflows.
- **Retrieval stack:** BM25 (SQLite FTS5) + TF-IDF + dense ML embeddings (transformers.js, int8-quantized), RRF-fused, BGE cross-encoder rerank, HNSW ANN (live-update + disk persistence), wikilink graph-boost, GraphRAG-light (Louvain), HyDE + sub-question, Obsidian Bases (`.base`) DSL, PDF text + OCR (Tesseract). Forgetting-aware staleness (`age_days`/`stale`, opt-in recency re-rank). Closed-loop feedback (`obsidian_mark_useful`, opt-in).
- **Transports:** stdio + Streamable HTTP (bearer auth, rate-limit, CORS). **The HTTP path is the remote attack surface** — anything an authenticated MCP client can reach over `serve-http` is in scope for DoS / info-leak / corruption. The watcher (`src/watcher.ts`, 806 lines) is the live-sync concurrency surface.
- **Optional deps (6):** `@huggingface/transformers`, `@napi-rs/canvas`, `better-sqlite3`, `hnswlib-node`, `pdfjs-dist`, `tesseract.js`. The server must degrade gracefully (fail-soft) when any are absent — and **never leak the importing file's absolute path** through a load error (a documented leak class; `optional-dep.ts`).
- **Threat model (single-user, local vault):** the vault owner is trusted; the *agent/MCP client* is semi-trusted (could be driven by untrusted content the user pasted); on `serve-http`, a bearer-authenticated client is the adversary for DoS/leak. Note files themselves may contain adversarial content (prompt-injection text, pathological regex/markdown, hostile frontmatter, NFD-decomposed Unicode, all-`#` ATX-close headings).

Authoritative docs to read first: `README.md`, `CLAUDE.md` (the maintainer's North-Star + the **running anti-pattern ledger + 22-entry overclaim ledger** — read this; it is the project's own list of recurring failure classes), `SECURITY.md`, `STABILITY.md` (the semver contract), `docs/api.md`, `CHANGELOG.md` (esp. the rc.13→rc.16 entries).

---

## 3. Codebase map (every module + its role)

Read each. Cross-reference TSDoc claims against implementation (TSDoc-vs-reality drift is a documented recurring class).

| Module | Role / what to scrutinize |
|---|---|
| `index.ts` | entrypoint, `VERSION`, CLI dispatch |
| `cli.ts`, `cli-help.ts` | arg parsing, all subcommands + flag help (cli-parity invariants); `setEmbeddingsOffline` on serve + serve-http (offline enforcement) |
| `server.ts` | stdio wiring, `prepareServerDeps`, boot-time bulk index build, signal/shutdown orchestration, watcher/HNSW/feedbackStore wire-up |
| `http-transport.ts` | **remote surface** — bearer auth (`timingSafeEqual`, min-len ≥16), rate-limit, CORS (allow + **expose** `Mcp-Session-Id`), stateful `SessionRegistry`, `pendingInits`/`inFlight` refcounts (`runWithPendingInit`/`runWithRefcount`), graceful **bounded** shutdown (`closeServerBounded`) |
| `shutdown.ts` | signal-driven teardown ordering (watcher → embed-db → cache flush → fts last) |
| `tool-registry.ts`, `tool-manifest.ts` | tool registration + gating + `readOnlyHint` (single source of truth for the 46-tool count); `MAX_QUERY_LEN`/`MAX_TAG_ARG_LEN`/`MAX_FRONTMATTER_KEY_LEN` input caps |
| `prompts.ts` | 19 MCP prompts |
| `vault.ts` | **core FS boundary** — path-traversal guards, `*Safe` fs wrappers (abs-path-leak sanitizer), **atomic create/overwrite (`writeNote` random-nonce tmp + `wx`/O_EXCL + rename, rc.13 AUD-01) / rename / append**, privacy filter (`--exclude-glob`/`--read-paths`), `isExcluded`, non-backtracking matchers, NFC name folding, **linear trailing-strip helpers' callers** |
| `name-fold.ts` | **canonical Unicode folders** `foldName`/`foldTag`/`nfcLower`/`nfc` + `lookupFoldedKey` (case/NFC-insensitive frontmatter KEY lookup) + `lookupFoldedAny` (rc.13 producer-fold) |
| `parser.ts` | frontmatter+body split, wikilink/embed/tag extraction (`INLINE_TAG_RE`, NFC-before-match), `bodyStartLine` |
| `frontmatter.ts` | js-yaml@5 parse/stringify port (replaced gray-matter rc.53, js-yaml@4→5 rc.6); YAML 1.2 scalar contract, `coerced` flag, dates load as **strings** |
| `tools/index.ts` | barrel re-exporting media/meta/read/search/write |
| `tools/read.ts` | always-on read tools (list/search/neighbors/stats/tags/chat-thread/frontmatter); `frontmatter_get`/`frontmatter_search` via `lookupFoldedKey`; `extractHeadings` (rc.16 split heading regex) |
| `tools/write.ts` | `--enable-write` tools (create/append/rename/replace/archive/frontmatter_set/validate_note_proposal); backlink-rewrite plan; write-fidelity; `frontmatter_set` null-proto map (rc.13 AUD-05) |
| `tools/search.ts` | hybrid search orchestration, RRF, rerank, graph-boost, recency, `filter_frontmatter` (key-fold), adaptive HNSW refill, privacy-filter terminal pruning; `searchText` scan cap |
| `tools/meta.ts` | `obsidian_open_questions` (ReDoS-sensitive; worker sink-bound), `lint_vault_wiki` (orphans/broken/stub/**stale**/concepts; stale via `lookupFoldedKey`), tag suggest, paper audit, `findBestMatch`, `validateNoteProposal` (`yaml.coerced`); `getOpenQuestions` (rc.16 split heading regex) |
| `tools/media.ts` | `read_canvas` (O(1) `byRelPath`, rc.65), `read_pdf`, `ocr_pdf`, list-pdfs/canvases/bases (sort-then-truncate, rc.76) |
| `tools/limits.ts` | `capScanEntries` resource cap |
| `dql.ts` | Dataview-query subset parser+executor (always-on, remote-reachable); `MAX_DQL_QUERY_LEN`; non-backtracking LIKE matcher; NFC value/tag/key folding |
| `bases.ts` | Obsidian Bases `.base` DSL parser+executor (always-on, remote-reachable); predicate eval (fail-closed); NFC folding; `boundedSetAdd`; resource caps |
| `communities.ts` | Louvain community detection, wikilink graph, `MAX_GRAPH_NODES=50000`, `converged` flag |
| `embeddings.ts` | transformers.js embedder/reranker, per-alias session cache, **offline enforcement** (`setEmbeddingsOffline` + exported `applyOfflineEnv`) |
| `embed-db.ts`, `embed-pipeline.ts` | SQLite embed store (`peekEmbedDbMeta` never-throw peek, self-cleaning `open()`), chunking (surrogate-safe cut), upsert/delete, signatures |
| `fts5.ts` | SQLite FTS5 index (`peekFtsMetaSafe` never-throw peek, self-cleaning `open()`), tokenization, escaping, persisted tag column; **heading parse already split (v3.5.8)** |
| `hnsw.ts` | hnswlib-node wrapper — `applyDiff`/`resize`/`capacity`, disk persistence (live count), signature-guard rebuild, `zipHnswAddPoints` fail-closed |
| `wildcard-match.ts` | non-backtracking DP matcher backing LIKE + glob (the ReDoS class-ender) + **linear trailing-strip helpers** (`stripTrailingSlashes`/`stripSurroundingSlashes`/`stripTrailingNewlines`/`stripTrailingHashes`, rc.14) |
| `optional-dep.ts` | `optionalDepDetail` — strips abs paths from optional-dep load errors (leak class) |
| `pdf.ts`, `ocr.ts` | pdfjs + Tesseract; resource cleanup (try/finally, rc.74), canvas-OOM cap, OCR offline enforcement (`assertOcrLangsInstalled`), page-range arithmetic |
| `staleness.ts` | `computeStaleness`/`recencyScore` (forgetting-aware) |
| `feedback.ts` | `FeedbackStore` (per-vault sidecar, **null-proto map**, persistChain serialization, scoring, per-write chmod 0600) |
| `watcher.ts` | **chokidar live-sync concurrency surface** — per-absPath promise queue (`fileQueues`), `attachEmbed`/`attachHnsw` late-binding, embed-db + HNSW live-sync (`applyDiff`/`rowsByLabel`, **synchronous** critical section — see §6.6), `close()`-drain |
| `retrieval-opts.ts` | shared serve/serve-http retrieval flag parsing + validation |
| `rrf.ts`, `periodic.ts`, `eval.ts`, `doctor.ts` | RRF fusion; periodic-notes date tokens (ISO week/year); eval harness (recall@k/MRR/NDCG@k, failure_bucket); `doctor` health check (privacy/native-dep/index) |

---

## 4. Where the internal apparatus is **blind** — aim here

The project has 12 OIA checks + 19 invariant tests. Per the maintainer's own meta-audit (CLAUDE.md, "rc.36"), **~85% of these are drift/claim-driven** — they verify a *doc claim* matches a number/version/string. They are **structurally blind** to:

1. **Concurrency / shared-mutable-state interleave** — async chains mutating shared singletons (the watcher HNSW index + `rowsByLabel`, the shared `FeedbackStore`, the HTTP `SessionRegistry`, embed-db connections). A real interleave passes every gate. The only defense for the watcher critical section is a **static no-`await` grep** (`hnsw-sync-critical-section.test.ts`) — no CI gate runs an actual concurrent interleave. **Run one.**
2. **Runtime DoS / algorithmic complexity** — O(n²)/O(K×N) amplifiers, unbounded scans, ReDoS, OOM, on always-on **remotely-reachable** tools. Many caps exist (`.max()` on remote strings, `capScanEntries`, `MAX_GRAPH_NODES`, the ReDoS worker sink-bound). **Find a remote string still reaching a superlinear sink uncapped, or an always-on whole-vault scanner not CAP-or-EXEMPT classified.** (rc.16 just capped `hyde_search.query`/`hypothetical_answer` — the last uncapped always-on query inputs; verify completeness.)
3. **Encoding correctness** — Unicode NFC/NFD on macOS APFS (names, tags producer+consumer, frontmatter keys+values), surrogate splitting, case-folding under the sink's actual flags. **Is the NFC class complete across ingest→store→compare — or is there an 8th raw frontmatter-key read, or another identity surface (DQL/bases field, graph-boost membership) still unfolded?**
4. **Info-disclosure** — absolute host paths / cache layout / home dir leaking to a bearer-auth client via error messages. `vault.ts` `*Safe` wrappers + `optionalDepDetail` are the sanitizers. **Force every error path reachable over serve-http and confirm it is abs-path-free** (write path, read path, optional-dep load, SQLite open, OCR/PDF, model-load).
5. **Claimed-guarantee vs. code-guard** — every "blocked"/"zero outbound"/"fails closed"/"never throws"/"SLSA L2"/"enforced"/"throws if" claim must point at a real guard. (`enforcement-guard-invariant.test.ts` is the inventory; OIA Check 4d/4e/4f mirror SLSA + OCR-offline + embeddings-offline.) **Find a claim whose guard doesn't actually enforce it.**
6. **Right-to-erasure / data-at-rest** — every on-disk artifact a writer creates (caches, sidecars, FTS/embed/HNSW/feedback files, `.tmp` leftovers, the `writeNote` `<note>.md.<hex>.tmp`) must be erased by `prune`/`clear-*` (writers ⊆ erasers, `erasure-invariant.test.ts`). **Confirm no raw note text or `text_preview` survives `prune`/`clear-*`.** (Note: the `writeNote` nonce tmp lives in the *vault* dir, not the cache — out of `prune`'s scope by design; but confirm a crash mid-overwrite can't strand it indexed/leaked. See §6.1(g).)
7. **Write-fidelity / data-loss** — create/rename/append/replace/frontmatter_set under edge cases (concurrent writers, case-insensitive FS, non-mapping frontmatter `coerced`, `__proto__` keys, backlink-rewrite, line-number arithmetic, hostile pre-existing FS state). **The rc.13 atomic-`writeNote` fix is the #1 thing to re-probe behaviorally — see §6.1.**
8. **Test-theater** — tests that pass without exercising the code they claim to; a behavioral test that doesn't *generate the failing input shape* (the project's repeated "generator-blindspot"). When you assess a behavioral/invariant test, ask "**can its inputs even produce the bug it claims to guard?**"

These eight are the maintainer's own enumerated blind spots. The most valuable findings live here.

---

## 5. Baseline — reproduce the green state, then go beyond it

```bash
npm ci
npm run build                 # tsc strict + noUncheckedIndexedAccess
npm test                      # 1385 canonical it() (+ data-driven expansion to ~1478)
npm run test:coverage         # 11 per-file floors; regenerates coverage/coverage-summary.json
npm run lint                  # biome, 0 findings
npm run check:version-consistency   # 7 surfaces + CLAUDE roll-up marker
npm run check:oia             # 12 state-driven walks
node scripts/check-audit.mjs  # scoped npm-audit gate (ALLOWLIST is EMPTY = strictest)
node scripts/smoke.mjs        # synthetic-vault tools/list + initialize
npm pack --dry-run            # packaged file set
```

All expected to pass on rc.16 (`d2e9421`). If any fails on a clean checkout, that itself is a finding. Then audit beyond what these check.

**Canonical-count grep methodology** (so you don't mis-litigate counts as overclaims — this was a prior false-HIGH and a prior false-LOW): the gated test count is `grep -E '^\s*it\s*\(' tests/**/*.test.ts | wc -l` = **1385** (what `docs-consistency.test.ts` pins). A naive `grep -c 'it('` over-counts (matches `it(` inside strings / `omit(`); the runtime count (~1478) is higher due to data-driven `for(…) it(…)` loops. **1385 is correct by design.**

---

## 6. Recent changes — audit these hardest (v3.11.0 line, rc.13 → rc.16)

Read the CHANGELOG entries for each. Treat all of this as fresh, possibly-under-baked code. (rc.1→rc.12 are covered in the superseded brief; the headline earlier-line surfaces still in scope: the rc.1 closed-loop **feedback** store `src/feedback.ts`, the rc.6 **js-yaml@5** migration, the i18n 9-language READMEs.)

### 6.1 rc.13 — AUD-01 atomic-`writeNote` symlink-escape **regression** (the #1 re-probe target) — `src/vault.ts:777-813`
This is a textbook *"security fix that introduced a vuln."* rc.12's L-7 atomic-overwrite (deterministic `${abs}.tmp` + plain `writeFile`) **followed a pre-planted symlink** at the tmp path → an attacker who could drop `victim.md.tmp` as a symlink redirected the write out-of-vault AND replaced the note with a symlink. Caught by **only 1 of 2** rc.13 auditors (the runtime-probe one who pre-planted a hostile symlink). The rc.13 fix: a **random-nonce tmp** (`${abs}.${randomBytes(8).toString("hex")}.tmp`) opened **`wx` (O_CREAT\|O_EXCL)**, then `renameSafe` over the target, preserving the dest's mode. **Re-verify ADVERSARIALLY (a behavioral repro against a HOSTILE pre-existing FS, not a code re-reading):**
- (a) Is the nonce path itself provably symlink-safe? (The current regression test exercises the OLD deterministic-name attack — does it actually prove the nonce path can't be pre-planted/won-race?)
- (b) Is there a rename-over-target TOCTOU between the `lstat(abs)` symlink check (`777-779`) and `renameSafe(tmp, abs)` (`808`)? `rename(2)` over a symlink *replaces* it (doesn't follow) — confirm that behaviorally, not by assumption.
- (c) Concurrent reader/watcher seeing the `.tmp` or a momentarily-missing target?
- (d) Mode-preservation: `statSafe(abs).catch(()=>null)` on a brand-new path (no stat) vs existing — correct perms in both?
- (e) `overwrite=false` path still `wx` — confirm no regression to exclusive-create + symlink-refusal + privacy-filter ordering.
- (f) Cross-device: tmp is same-dir as target, so rename is same-fs — any path where it isn't?
- (g) **Crash mid-overwrite:** a SIGKILL between `write` (804) and `rename` (808) leaves `<note>.md.<hex>.tmp` (full new content) in the vault dir. It's never indexed (walk is `.md`-only) / never watched / not a `prune` target (in-vault, not cache). Confirm that's genuinely benign, or escalate.

### 6.2 rc.14 — CodeQL HIGH polynomial-ReDoS, the **strip** idiom — `src/wildcard-match.ts` + 9 sites
CodeQL `js/polynomial-redos` flagged `s.replace(/<class>+$/, "")` as O(n²) on `<class>×n + non-class` (the anchored `+$` retries from every run position). The team had **mis-dismissed** the same pattern as "false positive" at 6 sites by *reasoning about the `$` anchor*. Empirically `"/"×160k+"x"` = 10.4 s; uncapped bearer-reachable `folder` arg. Fixed: linear `charCodeAt`-loop strips at **all 9 sites** (fts5 ×2, embed-db, search ×2, write ×2, periodic, read). **Verify the 9 strips are byte-identical to the old regexes** (esp. `fts5` `\s+$`→`.trim()` also strips *leading* whitespace — confirm `headingMatch[2]` never has leading whitespace post-match), and that **no other anchored-quantifier-over-user-input `.replace`/`.exec`/`.match`/`.test` sink** remains. (The known in-scope-but-LOW residual: `search.ts` `stripChunkSuffix /#\d+$/` — server-generated id, bounded by filename ≤255/segment.)

### 6.3 rc.16 — the **heading-regex** ReDoS siblings (this brief's own prep-audit found these) — `src/tools/read.ts:239`, `src/tools/meta.ts:1523`
`extractHeadings` (`obsidian_read_note format:map`) and `getOpenQuestions` (`obsidian_open_questions`) used the combined `/^(#{1,6})\s+(.+?)\s*#*\s*$/` capture — the **exact** regex `fts5.ts:796` had split for CodeQL in v3.5.8, left combined at two siblings (the signature "instance fixed, sibling missed"). **A prep-audit subagent over-claimed this as a HIGH** ("1.5 s @ n=2000, 11.7 s @ n=4000"); the maintainer **empirically timed it** (per the rc.14 rule) and the claim **did not reproduce** — the precise O(n²) shape (`# `+space×500k+`x`) is **0.4 ms**, the worst real shape (`(# )`×250k = 500 KB) is **~12 ms**, mildly super-linear, bounded by `maxFileBytes`. So it shipped as a **LOW** (defense-in-depth + parity), splitting both to fts5's safe form + a static guard. **Challenge:** (a) confirm our empirical-linearity claim (is there a heading-line shape that IS super-quadratic in V8?); (b) is the split byte-identical except the documented `# ###`→empty edge? (c) is there a **3rd** ReDoS shape anywhere — a `.exec`/`.match` regex with adjacent/nested quantifiers over body/path/folder/tag content the strip-idiom guard can't see?

### 6.4 rc.15 — AUD-NEW-1 re-verified as a FALSE POSITIVE + the trust-boundary doc — `src/tools/meta.ts:1655`, `src/tools/read.ts`
A rc.14 re-audit claimed `paperAudit` misses case-variant/NFD citation keys (`ArXiv:`) because it `.toLowerCase()`s without NFC-folding. **Re-verified empirically as a FALSE POSITIVE:** the target keys (`arxiv`/`doi`/`url`/`isbn`) are **pure ASCII**, so `nfcLower` is byte-identical to `.toLowerCase()` for any matching key (`"Arxiv" === "Arxiv".normalize("NFD")`); every case variant already matches. Pinned with a contract test. Also accepted (doc-only) a `@remarks` trust-boundary note on `frontmatterGet`/`frontmatterSearch` (in-process trusts `key` length; the MCP boundary caps at 256). **Challenge only if you can show a citation key that is NOT pure-ASCII-equivalent and is missed.**

### 6.5 rc.16 — the prep-audit's own two LOWs (re-verify the fixes) + `hyde_search` caps — `src/tool-registry.ts`
Besides the heading split (§6.3), rc.16 capped `obsidian_hyde_search.query` + `hypothetical_answer` (`.max(MAX_QUERY_LEN)`) — the one always-on bearer-reachable query tool the rc.11 input-cap sweep missed (`hypothetical_answer` is embedded). Added both to `parser-input-cap-invariant`. **Verify the cap inventory is now complete** (is there any other always-on free-form string → superlinear sink without a `.max()`?).

### 6.6 The verdict we most want re-challenged (carried) — watcher HNSW concurrency
**"The watcher HNSW critical section is fully synchronous, so cross-file events cannot interleave."** Pinned only by `tests/hnsw-sync-critical-section.test.ts` (a static no-`await` grep). **Challenge with a RUNTIME test:** rapid same-file + cross-file saves through the chokidar watcher — any ghost-label drift between the HNSW index and embed-db (live in HNSW, absent from embed-db → stale/ghost hits)? Is `HnswIndex.applyDiff` + `watcher.syncHnswForFile` + the shared `rowsByLabel` mutation + the close-time disk flush truly interleave-safe on every path (md / pdf / unlink), and against a second writer? `FeedbackStore.record()` (read-modify-write serialized via `persistChain`) is the sibling — confirm no lost-update under concurrent serve-http `mark_useful`.

---

## 7. Comprehensive coverage checklist (by class)

For each class: fully closed, or an uncovered sibling/surface? (The signature failure mode is "instance fixed, adjacent sibling missed" — rc.9→rc.10→rc.12→rc.13→rc.16.)

- [ ] **STRIDE / security:** bearer auth (`timingSafeEqual`, min-len ≥16), rate-limit, CORS (allow + expose headers), path traversal, **symlink escape (§6.1)**, input validation (zod `.max()` on every remotely-reachable string), injection (FTS5/SQL/DQL/glob), **prototype pollution** (`mark_useful` paths → null-proto map; `frontmatter_set` keys; any other agent-string→object-key sink?).
- [ ] **ReDoS / catastrophic backtracking:** every `new RegExp`/`.exec`/`.match`/`.test`/`.replace` over user/agent/config input. The non-backtracking DP matcher + the worker sink-bound (`open_questions`) + the linear strips (rc.14) + the heading splits (rc.16) are the class-enders — **find a sink they don't cover.**
- [ ] **Unicode / NFC / encoding:** names, tags (producer+consumer), frontmatter keys + values, DQL/bases field names + values, surrogate splitting, case-fold under `/i`/`/u`. **Is there an 8th raw frontmatter-key read?**
- [ ] **Concurrency:** every long-lived shared-mutable singleton — serialized or provably interleave-safe? (watcher HNSW/rowsByLabel/embed-db [§6.6], FeedbackStore, SessionRegistry, module caches.) **Runtime test beats static grep.**
- [ ] **Resource / DoS caps:** every always-on whole-vault scanner CAP-or-EXEMPT; per-request amplifiers; canvas/PDF/OCR memory caps; HNSW growth; every remote free-form string `.max()`-capped (hyde now capped — complete?).
- [ ] **Info-disclosure:** every error reachable by a serve-http client is abs-path-free. **Force the error paths.**
- [ ] **Optional-dep leaks:** every `await import()` funnels load errors through `optionalDepDetail` (incl. indirection: a `const msg = err.message` then thrown).
- [ ] **Right-to-erasure / data-at-rest:** writers ⊆ erasers for every cache/sidecar/`.tmp`; no raw note text / `text_preview` survives `prune`/`clear-*`.
- [ ] **Write-fidelity / data-loss:** create/rename/append/replace/frontmatter_set atomicity (§6.1) + edge cases; line-number arithmetic; backlink-rewrite; case-insensitive FS; non-mapping frontmatter (`coerced`); `__proto__` keys.
- [ ] **Claimed-guarantee vs code-guard:** "zero outbound in serve" (embeddings/reranker/OCR offline enforcement + wire-up tests), SLSA L2, fail-closed `.base` predicates, `*Safe`/peek never-throw, "fails closed" privacy filter.
- [ ] **MCP contract:** `readOnlyHint` correctness (K-3: every fs/state mutator — incl. `markUseful` — in `KNOWN_WRITE_HANDLERS`), tool schemas, error shapes, stateful session lifecycle (`pendingInits`/`inFlight` refcounts, bounded shutdown).
- [ ] **Supply-chain:** SHA-pinned actions + correct `# vN` comments; `run:`-download content-pinning (mcp-publisher SHA256); `overrides`; `check-audit.mjs` allowlist (empty); phantom/undeclared deps; `files[]` accuracy.
- [ ] **Docs / claim-vs-reality:** counts (46 tools / 19 prompts / 1385 tests) across README ×9, llms.txt, AGENTS.md, STABILITY, COMPARISON, api.md, server.json, CITATION; version currency; CLI flag docs vs real `.option()`s; README anchor integrity (9 languages); TSDoc-vs-impl drift.
- [ ] **Test/CI integrity:** no silent-skip on security surfaces (CI-GUARD tripwires); no vacuous/test-theater; every `*-invariant.test.ts` has a real NEGATIVE control (META-invariant enforces this); behavioral tests *generate the failing input shape*; coverage floors honest; flake-blocks-release risks.
- [ ] **Retrieval correctness:** RRF, rerank, graph-boost, recency blend, `filter_frontmatter` (key-fold), feedback blend, chunking parity (FTS5 vs embeddings), HNSW under-return, eval metric correctness.

---

## 8. Specific high-value questions we most want challenged

1. Can a **bearer-authenticated serve-http client** hang the event loop or exhaust memory through any always-on tool (`dataview_query`, `query_base`, `open_questions`, `search`, `hyde_search`, `read_canvas`, `validate_note_proposal`, `read_pdf`/`ocr_pdf`, `find_path`, `get_communities`)? **Concrete repro with measured timing** (we will re-time it).
2. Is the **rc.13 atomic `writeNote`** correct under a HOSTILE pre-existing FS state and concurrency (§6.1 a–g)? An adversarial behavioral repro, not a code re-reading.
3. Is the **ReDoS class now complete** across strip idioms (rc.14) + heading `.exec` (rc.16) + the DP matcher + the worker sink-bound — or is there a **3rd shape**?
4. Is the **NFC class complete** across ingest→store→compare (names, tags, frontmatter keys+values, DQL/bases fields), or is there an **8th** raw key read / another identity surface?
5. Is the **watcher HNSW critical section** truly interleave-safe at runtime (§6.6)? Is **any** agent-string→object-key sink besides `mark_useful`/`frontmatter_set` exploitable for prototype pollution?
6. Does **any** error message reachable over serve-http leak an absolute host path / cache layout / home dir?
7. Is **"zero outbound in serve mode"** genuinely enforced for embeddings, reranker, AND OCR — including cache-miss paths?
8. Any **test-theater** — a test (especially a security/invariant test, or the rc.15 AUD-NEW-1 contract / rc.16 heading guard) that would still pass if the code it guards were broken, or whose inputs can't produce the bug it claims to guard?

---

## 9. Out of scope / known-accepted (do not re-flag as new — but DO challenge the acceptance with a repro if you disagree)

- **Heading-regex empirical linearity (rc.16):** the split was defense-in-depth/parity; the old combined form is empirically ~linear (worst ~12 ms at 500 KB, bounded by `maxFileBytes`) — **NOT** a DoS. Escalate only with a reproducing super-quadratic heading-line shape + measured timing.
- **AUD-NEW-1 (rc.15) → FALSE POSITIVE:** `paperAudit` ASCII citation keys; `.toLowerCase()` == `nfcLower` for ASCII. Escalate only with a non-ASCII-equivalent citation key that is missed.
- **`hyde_search` now capped (rc.16):** `query`/`hypothetical_answer` carry `.max(MAX_QUERY_LEN)`. (Was the prior gap; now closed.)
- **`paper_audit.tag_filters`** — **hallucinated field, does not exist** (paper_audit has only `tag`/`folder`/`limit`). Confirm absence; do not re-raise.
- **Source-`it()` test count (1385) vs runtime (~1478)** — deliberate convention (§5). Challenge only the *convention*, with reasoning.
- **`frontmatterGet`/`frontmatterSearch` in-process `key`-length trust (rc.15):** documented `@remarks`; the MCP boundary caps at 256. In-process callers are trusted by design.
- **R-10 HNSW under-return** at >66%-excluded result sets — documented architectural floor.
- **js-yaml@5 alias/anchor "billion-laughs"** not specifically rejected — bounded by the single-user local-vault threat model (SECURITY.md). **Merge-key DoS is gone at the ROOT** (v5 removed merge-key resolution, rc.6), not merely bounded.
- **Bases `.base` frontmatter equality is case-SENSITIVE** by design (mirrors Obsidian Bases); NFC-normalized but case-preserving — intentional.
- **DQL LIKE Unicode case-fold** uses `String.toLowerCase()` (not full ECMAScript canonical fold) — documented contract (rc.75); under-matches ~22 exotic BMP codepoints, never over-matches, glob path unaffected.
- **`capacity()`/`resize()`** are orphaned (test-only) HNSW API — INFO/WAI.
- **`CITATION.cff` tracks the latest STABLE** (3.10.1), not `@rc` — by design (pinned by a docs-consistency drift guard).
- **The `_` vs `-` spelling distinction** in folded keys (`last_reviewed` ≠ `last-reviewed`; both checked explicitly) — intentional (the fold normalizes case + Unicode form, NOT spelling/separator).

If you believe any "accepted" item is actually exploitable, **escalate it with a repro** — accepted ≠ immune.

### 9.1 Release-integrity / process (flag, but these are maintainer-gated — not code fixes)
- **Stranded-tag pattern:** the rc.14 ReDoS fix was merged-but-unpublished for a window (the squash-commit's `ci.yml` never fired → the release guard timed out), recovered by rc.15. The published `@rc` artifacts now contain the rc.14 + rc.16 fixes (`29c912a` and `d2e9421` are ancestors of `main`). Worth confirming the released `rc.16` artifact contains the linear strips + heading splits; the stranded-tag race is a CI-wiring follow-up.
- **rc.13 AUD-02 (cold-CI OIA Check 6 skip)** — a still-open maintainer follow-up.
- **Branch protection** — verified previously as **7 (not 9) enforced checks, `enforce_admins:false`, 0 required reviews**; modifying repo security settings is out of the code-auditor's scope (flag, don't expect a code fix).
- **Registry / Glama / npm-keyword drift** — reconciles only on the next *stable* publish (OIDC registry sync is stable-only).

---

## 10. Deliverable format

Hand back a Markdown report (do not commit it to the repo). For each finding:

```
### <ID> (<CRITICAL|HIGH|MEDIUM|LOW|INFO>) — <one-line title>
- **File:line:** src/foo.ts:123 (cite the graded commit SHA d2e9421)
- **Class:** <security|concurrency|resource-DoS|encoding|info-leak|write-fidelity|claim-vs-reality|supply-chain|docs|test-integrity|...>
- **Mechanism:** precise control/data-flow explanation (why it's wrong)
- **Reachability:** local-only | serve-http bearer-reachable | CLI | watcher | build-time; and which tool/flag gates it
- **Repro:** concrete steps / input that triggers it — empirical beats theoretical (for DoS, MEASURED timing)
- **Blast radius / impact:** what actually breaks (DoS, data-loss, leak, wrong result, crash)
- **Recommended fix (DESCRIBE, do not apply):** prose; root-cause fix + any sibling sweep + a structural defense (invariant) if applicable
- **Confidence:** high / medium / low; note if you could not run it
```

Plus: an executive summary (counts by severity), the **methodology you used** (for the diversity gate), the **commit SHA you graded**, and an explicit statement of any finding where you **re-verified and DISAGREE with the maintainer's rc.13/rc.15/rc.16 verdict**.

**Severity rubric:** CRITICAL = remote/unauth code-exec, silent data-loss, or trivially-remote DoS; HIGH = bearer-reachable DoS/leak/data-loss, or a broken security guarantee; MEDIUM = bounded/conditional version of those, or a real correctness bug; LOW = narrow/edge-case correctness or hardening; INFO = doc/claim drift, dead code, style with a correctness angle. **Calibrate carefully and state your severity AND its justification** — prior rounds inflated a correctness-on-opt-in-convention bug to HIGH (re-graded LOW), claimed a HIGH ReDoS with non-reproducing timings (re-graded LOW), and raised a hallucinated field. We re-verify both validity and severity; for any DoS claim, **include measured timing** — we will re-time it.

Per-item re-verification against the graded commit is expected — stale findings (re-flagging something already fixed in rc.1→rc.16) and false positives both reduce signal; when uncertain, say so and show your repro attempt. **Supply a repro for every ACCEPT, not just every CRITICAL.**

Thank you. Findings are the deliverable; the maintainer's agent implements every fix.
