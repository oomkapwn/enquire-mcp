# External Audit & Consulting Request — enquire-mcp v3.11.6-rc.2 (DUAL MANDATE: full read-only technical/architecture audit **+** strategic product/market consultancy)

**Status:** OPEN — broad-and-deep, read-only. This brief asks for **two things at once from one engagement**: (1) a from-scratch, adversarial **technical + architecture audit** of the entire codebase, and (2) an independent **strategy consultant's critique** — competitors, positioning, roadmap, feature bets, growth, and an honest challenge of how the project spends its effort. We want an outside brain that will both find our bugs *and* tell us uncomfortable truths about the product.
**Date issued:** 2026-07-15
**Repository:** https://github.com/oomkapwn/enquire-mcp (public, MIT) · npm `@oomkapwn/enquire-mcp`
**Target commit (pin this exact SHA before you start):**

```bash
git clone https://github.com/oomkapwn/enquire-mcp && cd enquire-mcp
git checkout v3.11.6-rc.2 && git rev-parse HEAD    # expect 9671b339647a14ffd8a4c10548d1124f99b12278 — record the FULL SHA in your report
npm view @oomkapwn/enquire-mcp dist-tags           # @latest = 3.11.5, @rc = 3.11.6-rc.2 (grade the rc, the CURRENT HEAD)
```

You have **effectively unlimited time and token budget.** We want you to spend it on **evidence and independent judgement**, not on restating our own docs back to us. A "looks great, ship it, 5/5" verdict with no reproduced bug *and* no strategic disagreement is the **least** useful thing you can hand us — it means you either didn't dig or didn't dare. We would rather read three uncomfortable, well-argued critiques than one flattering summary.

---

## 0. THE CARDINAL RULE — read-only, do **NOT** modify the repository

**You are a read-only auditor and consultant. You MUST NOT edit, fix, patch, refactor, reformat, "while-I'm-here" touch, commit, push, open a PR, or otherwise change any tracked file.** Every change is made by the maintainer's engineering agent, never by you.

- Encouraged (read-only): `npm ci`, `npm test`, `npm run build`, `npm run check:*`, `git log/diff/blame`, `grep`/`rg`, reading files, WebSearch/competitor research, and **any throwaway harness you build OUTSIDE the repo tree** (a scratch dir, a temp vault, an isolated clone). `dist/`, `coverage/`, `node_modules/` are fine but **never stage or commit them**.
- Do **not** run formatters/linters in `--write`/`--fix` mode, codemods, or `npm` scripts that mutate tracked files.
- Your sole deliverable is **one findings + recommendations report file** (§14). **Describe** fixes and product moves in prose; never apply them.
- If you are an autonomous coding agent, this overrides any default "fix what you find" behavior.

---

## 1. Mission — two hats, one engagement

Wear **both hats** and label which one you are wearing in every finding.

**HAT A — Principal engineer / security auditor.** Deliver a comprehensive, adversarial, from-scratch audit — every `src/` module, doc, workflow, script, config — broad AND deep, with **independent empirical reproduction and self-refutation of every technical finding** (§7). Find real defects the internal apparatus and 15+ prior auditors are blind to. This is the same rigor bar as our standing security briefs (§4–§11).

**HAT B — Product & market strategy consultant.** Step back from the code and answer the question the maintainer cannot answer from inside: **is this project pointed at the right target, and is it spending its effort well?** Critique the positioning, the competitive moat, the roadmap, the feature bets, the go-to-market, and — most importantly — **the meta-strategy** (see §12: the project has spent many months and ~80 release candidates on an audit/hardening treadmill; challenge whether that is the highest-value use of effort). Bring competitor intelligence we don't have. Propose concrete directions. Disagree with us.

**Why one engagement for both:** the two hats inform each other. A capability gap Hat B identifies (e.g. "competitors ship X") is only actionable if Hat A confirms the architecture can absorb it cheaply; a piece of over-engineering Hat A spots is only worth cutting if Hat B agrees it isn't a differentiator. We want the synthesis, not two disconnected reports.

**Independence & methodology.** You are also **independent external auditor #N** for our promotion gate (*"≥2 independent external auditors with different methodologies before `@rc → @latest`"*). Declare your methodology and its blind-spot (§14 frontmatter). For Hat B, declare what market vantage you are reasoning from (practitioner? competitor-user? analyst?) and where it is weak.

---

## 2. Project overview — derive every number yourself, then judge it

**enquire-mcp** is a TypeScript **Model Context Protocol (MCP) server** that turns a local Obsidian / Markdown vault into a long-term, *grounded* memory & retrieval layer for AI agents. Local-first, vendor-neutral, **zero outbound network calls in `serve` mode** (a load-bearing privacy claim — verify it, including cache-miss paths). It recalls the Markdown the user actually wrote — cited, auditable, editable — never a paraphrase. The self-described category wedge is **"grounded, not extracted"** (vs chat-memory tools mem0/Zep/Supermemory that distil facts out of conversation logs into an opaque store). Challenge that wedge in Hat B.

**Counts are NOT authority here — DERIVE and VERIFY each at the graded commit; a mismatch is a docs-drift finding.** At this commit the repo *claims*: **46 MCP tools** (`src/tool-manifest.ts` `TOOL_MANIFEST`: always-on read + opt-in diagnostic + `--enable-write` + 1 feedback), **19 MCP prompts**, **12 OIA checks** (`scripts/oia-walk.mjs` self-declares its canonical count), a canonical **source-`it()` test count** gated by `tests/docs-consistency.test.ts` (runtime count is *higher* — data-driven `for(...) it(...)` loops; **WAI, do not re-file as an "overclaim"** — rejected ×2 before), **~35 top-level `src/*.ts` modules** (42 recursive), **~26k LOC**, README in **11 languages**. Confirm each by command; report drift.

- **Retrieval stack:** BM25 (SQLite FTS5) + TF-IDF + dense ML embeddings (transformers.js, int8-quantized) RRF-fused, BGE cross-encoder rerank, HNSW ANN (live-update + disk persistence), wikilink graph-boost, GraphRAG-light (Louvain communities), HyDE + sub-question decomposition, Obsidian Bases (`.base`) DSL, PDF text + OCR (Tesseract). Forgetting-aware staleness; closed-loop feedback (`obsidian_mark_useful`, opt-in). **Judge this stack in Hat B: is it over-built for the actual retrieval problem, correctly ambitious, or missing a table-stakes capability?**
- **Transports:** stdio + Streamable HTTP (bearer auth, rate-limit, CORS). The HTTP path is the remote attack surface. Treat note CONTENT as adversarial.
- **Optional deps (6):** `@huggingface/transformers`, `@napi-rs/canvas`, `better-sqlite3`, `hnswlib-node`, `pdfjs-dist`, `tesseract.js` — must degrade gracefully (fail-soft) and never leak host paths via load errors. Record in §14 frontmatter which built and whether any build FAILED (a class you could not exercise is `ENV-BLOCKED`, not `clean`).
- **Threat model (single-user, local vault):** vault owner trusted; the agent/MCP client semi-trusted; on `serve-http`, a bearer-authenticated client is the adversary for DoS/leak; note files carry adversarial content. **No multi-tenant cloud.** Worst realistic harm: event-loop DoS, local data corruption/loss, or vault-path info-leak. Calibrate severity to that.

**Authoritative docs to read first:** `README.md`, **`CLAUDE.md`** (the maintainer's North-Star + the running anti-pattern ledger and overclaim corrections #1–#22 — your map of where the apparatus has historically failed, and a candid record of the project's own recursion), `SECURITY.md`, `STABILITY.md` (semver contract), `docs/api.md`, `docs/COMPARISON.md`, `ROADMAP.md`, `CHANGELOG.md` (esp. the v3.11.x line), `llms.txt`, `AGENTS.md`.

---

# PART I — HAT A: TECHNICAL & ARCHITECTURE AUDIT

## 3. Codebase map (read each; cross-check TSDoc/header claims vs implementation — drift is a documented recurring class)

| Module | Role / what to scrutinize |
|---|---|
| `index.ts` | entrypoint, `VERSION`, CLI dispatch, re-export surface |
| `cli.ts`, `cli-help.ts` | arg parsing, subcommands + flag help (cli-parity invariants); `setEmbeddingsOffline` on serve/serve-http |
| `server.ts` | stdio wiring, `prepareServerDeps`, boot-time bulk index build, signal/shutdown orchestration, watcher/HNSW/feedback wire-up |
| `http-transport.ts` | **remote surface** — bearer auth (`timingSafeEqual`, ≥16-char), rate-limit, CORS (allow+expose), stateful session registry, `pendingInits`/`inFlight` refcounts, bounded graceful shutdown |
| `shutdown.ts` | signal-driven teardown ordering |
| `tool-registry.ts`, `tool-manifest.ts` | tool registration + gating + `readOnlyHint`; input caps (`MAX_QUERY_LEN`/`MAX_TAG_ARG_LEN`/`MAX_FRONTMATTER_KEY_LEN`/`MAX_FRONTMATTER_VALUE_LEN`/`MAX_DQL_QUERY_LEN`/`MAX_QUESTION_PATTERN_LEN`) |
| `prompts.ts` | MCP prompts |
| `vault.ts` | **core FS boundary** — path-traversal guards, `*Safe` fs wrappers (abs-path-leak sanitizer), atomic create/overwrite (random-nonce tmp + `wx`/O_EXCL), rename/append, privacy filter via non-backtracking matchers, `isExcluded`, NFC name folding |
| `name-fold.ts` | canonical Unicode folders + `lookupFoldedKey`/`lookupFoldedAny` |
| `parser.ts` | frontmatter+body split, `bodyStartLine`, `scanWikilinkInners` (linear non-backtracking), `INLINE_TAG_RE`, code-fence stripping, `stripCodeAndInline` |
| `structure.ts` | **NEW (rc.2)** — canonical line-structure accessors (`iterateBodyLines`/`iterateContentLines`/`noteHeadings`) via `advanceFence`; the fence/parser-desync class-ender (phase 1 of ~7) |
| `fence.ts` | shared `opensBlockFence`/`advanceFence` fence primitives |
| `frontmatter.ts` | js-yaml@5 parse/stringify port; YAML 1.2 scalar contract, `coerced` flag |
| `wildcard-match.ts` | non-backtracking DP matcher (LIKE + glob + linear strips), `splitLines`/`countLineBreaks`, `foldForMatch` |
| `tools/read.ts` | always-on read tools; `extractHeadings`; frontmatter get/search via `lookupFoldedKey` |
| `tools/write.ts` | `--enable-write` tools; backlink-rewrite plan; write-fidelity; fold-offset map; `__proto__` handling |
| `tools/search.ts` | hybrid orchestration, RRF, rerank, graph-boost, recency, `filter_frontmatter`, adaptive HNSW refill, scan caps, snippet-offset helpers |
| `tools/meta.ts` | `open_questions` (ReDoS-sensitive; worker sink-bound), `lint_vault_wiki`, tag suggest, `paper_audit`, `findBestMatch`, `validateNoteProposal` |
| `tools/media.ts` | `read_canvas`, `read_pdf`, `ocr_pdf`, list-pdfs/canvases/bases (sort-then-truncate) |
| `tools/limits.ts` | `capScanEntries` |
| `dql.ts` | Dataview-query subset (**always-on, remote-reachable**); non-backtracking LIKE; NFC folding |
| `bases.ts` | Obsidian `.base` DSL (**always-on, remote-reachable**); predicate eval; NFC; caps; `coerced` guard |
| `communities.ts` | Louvain, wikilink graph, `MAX_GRAPH_NODES`, `converged` |
| `embeddings.ts` | transformers.js embedder/reranker, per-alias session cache, offline enforcement |
| `embed-db.ts`, `embed-pipeline.ts` | SQLite embed store (never-throw peek; self-cleaning `open()`), chunking, upsert/delete |
| `fts5.ts` | SQLite FTS5 (never-throw peek; self-cleaning `open()`), tokenization, escaping, breadcrumb enrichment |
| `hnsw.ts` | hnswlib-node wrapper — `applyDiff`/`resize`/`capacity`, disk persistence, `zipHnswAddPoints` |
| `optional-dep.ts` | `optionalDepDetail` — strips abs paths from optional-dep load errors |
| `pdf.ts`, `ocr.ts` | pdfjs + Tesseract; resource cleanup; canvas-OOM cap; OCR offline enforcement; page-range arithmetic |
| `staleness.ts`, `feedback.ts`, `retrieval-opts.ts` | staleness/recency; `FeedbackStore` (null-proto map, serialized persist, chmod 0600); shared retrieval-flag parse |
| `watcher.ts` | chokidar — per-absPath queue, `attachEmbed`/`attachHnsw`, live-sync, `close()`-drain |
| `rrf.ts`, `periodic.ts`, `eval.ts`, `doctor.ts` | RRF fusion; periodic-notes date tokens; eval harness; health check |

## 4. Where the internal apparatus is structurally BLIND — spend the budget here

By the maintainer's own meta-audit (`CLAUDE.md`), **~85% of the 12 OIA checks + ~20 invariant tests are drift/claim-driven** and structurally blind to behavioral classes. Every genuinely-important finding of the last six months lived here:

1. **Runtime DoS / algorithmic complexity** — O(n²)/O(K×N) amplifiers, unbounded scans, ReDoS, OOM, on always-on remotely-reachable tools.
2. **Encoding correctness** — Unicode NFC/NFD on macOS APFS (names, tags producer+consumer, frontmatter keys+values, DQL/bases fields), surrogate splitting, length-changing case-folds used as offsets, CRLF/LS/PS terminators. The producer→store→compare path is where these hide.
3. **Concurrency / shared-mutable-state interleave** — watcher HNSW + `rowsByLabel`, shared `FeedbackStore`, HTTP session registry, embed-db/fts connections, module caches. (One prior "race" was a false positive — synchronous section — so confirm reachability, but also re-confirm every "it's synchronous" claim.)
4. **Info-disclosure** — abs host paths / cache layout leaking to a bearer client via error messages. Force every error path on the remote surface.
5. **Claimed-guarantee vs code-guard** — every "blocked"/"zero outbound"/"fails closed"/"never throws"/"SLSA L2"/"enforced"/"throws if"/"atomic" claim must point at a guard that *actually fires*; a guard that runs after the expensive work is **Partial, not Holds**.
6. **Right-to-erasure / data-at-rest** — every on-disk artifact a writer creates must be erased by `prune`/`clear-*`. Writers ⊆ erasers; no raw note text survives.
7. **Write-fidelity / data-loss** — create/rename/append/replace/frontmatter_set atomicity + edge cases; line-number arithmetic; backlink-rewrite; case-insensitive FS; non-mapping frontmatter; symlink/hostile-FS pre-state.
8. **Test-theater / generator blind spots** — tests that pass without exercising the code, or whose inputs cannot produce the bug they guard.

> **ANTI-ANCHORING (mandatory).** The eight classes above are where bugs lived *before*; they are not exhaustive. **At least one pass must hunt a defect class NOT in this list.** A genuinely novel class is rewarded above another sibling of a named one (`novel_class_found: true`).

**rc.2-specific scrutiny (the freshest, least-audited surface):** `src/structure.ts` is a new leaf that 3 read-path walkers now delegate to (`fts5.computeBreadcrumbsByLine`, `read.extractHeadings`, `meta.getOpenQuestions`). The maintainer claims **byte-identical behavior** proven by each walker's existing test as a differential oracle, and that `ParsedNote` stays byte-identical so the disk cache is unaffected. **Re-verify:** build your own differential harness (structure.ts walk vs an inlined copy of each predecessor walker) over a broad corpus incl. the fence shapes in §7; find a shape where they diverge. Confirm the plain-object rehydration claim (a `JSON.parse`'d `ParsedNote` still works with the free-function accessors). This refactor deliberately did **not** touch the write-path terminator rewriters or re-express `stripCodeAndInline` onto the shared walk — confirm those remain on their old paths and note any read/write divergence the split introduces.

## 5. Named worst-case shapes (§7 fuzzing MUST emit these; paste the exact input)

- **dense run of CLOSED tokens, no newline** (`"[[a]]".repeat(N)`, `"#x ".repeat(N)`) — NOT a long *unclosed* run (early-exits).
- **occurrences × replacement-length** blow-up.
- **length-changing case-fold** before a match (`"İ".repeat(K)+"x"`, U+0130 / final-sigma / ẞ) used as offset or tag/key compare.
- **non-mapping / hostile frontmatter**, **astral/BMP non-ASCII**, **CRLF + LS (U+2028) + PS (U+2029)** as both line *content* and line *separator*.
- **adjacent/overlapping/literal-separated unbounded quantifiers**, deeply-nested groups.
- **fence shapes** (for structure.ts / the parser-desync class): backtick, tilde, ≤3-space-indented, mismatched-inner-char (`~~~`-in-```` ``` ````), line-start inline span, **unclosed fence at EOF**, nested fences, frontmatter-adjacent fence.

## 6. Past auditors — the bar and the failure modes

15+ external audits processed. **The high-value shape they found:** a *sibling of an already-closed class* the gates were blind to. **What they MISSED (your bar):** a live CRITICAL ReDoS a "no critical findings" pass graded clean; a symlink-escape a state-driven auditor "verified clean" while a hostile-FS-probing auditor caught it (**methodology decided who saw it**); a HIGH wikilink quadratic three consecutive audits re-blessed by running the *wrong* (unclosed) shape. **What they GOT WRONG (counts against precision):** a hallucinated field (`tag_filters`); the source-`it()` convention re-litigated as an "overclaim" (×2 rejected); a ReDoS-detector "fix" that would have introduced a desync; an over-broad "cap ALL scans" contradicting the CAP-vs-EXEMPT invariant; a "ship it 4.75/5" with zero code-path traces on a commit carrying a HIGH + 3 MED. **Scoring:** 90%-real beats 50%-real even at lower count. Per-item empirical reproduction + self-refutation + severity calibration is mandatory.

## 7. Maximal-depth methodology (Hat A) — verify, then RE-VERIFY

- **T0 — Reproduce the green baseline (§8).** Anything failing on a clean checkout is a finding. Record env (node, OS, which optional deps BUILT, any build FAILURE).
- **T1 — Broad state-driven sweep.** Read EVERY `src/` module, doc, workflow, script as-is. Build the inventories the tables demand (§14 C/D/F): every always-on tool, every input field + cap, every regex/parser/resource sink, every error path, every on-disk artifact + eraser, every enforcement claim + guard, every NEW function since the prior tag.
- **T2 — Deep per-module reading + SINK TRACE.** For each always-on/bearer tool trace input **field → validation (file:line) → cost-bearing sink (file:symbol) → cost O(?) → bound or UNBOUNDED**. Required deliverable (§14 C). Cross-check TSDoc vs impl; trace each public fn ingest→store→compare; check resource lifecycles (acquire→use→release on every throw path).
- **T3 — Adversarial empirical fuzzing with the §5 NAMED SHAPES.** For every regex/tokenizer/parser reachable from remote or note-content input, emit each named shape and **paste the exact generated input**. Run against the real compiled sink (through `dist/`) with a wall-clock budget; flag any super-linear input with a **3-point complexity curve** (`t(n)`, `t(4n)`, `t(16n)` + ratios). Build differential harnesses vs an inlined predecessor. Force every serve-http error path and grep output for host paths. Drive concurrent calls at shared singletons.
- **T4 — Self-refutation + re-verification.** For each candidate: reproduce end-to-end through `dist/`; spawn a skeptic pass that tries to prove it wrong (reachable? upstream guard? threat-model? CAP-vs-EXEMPT? known-accepted §11?); calibrate severity with written justification; re-verify against current HEAD.

> **WRONG-PROBE SELF-CHECK.** A "fast/linear/no-divergence" result is NOT evidence of safety until you run the 3-point curve. A single fast timing on an unplotted curve may not be cited as proof of linearity. If you cannot make the named worst-case shape, that is `not-covered`, not `clean`.

> **EVIDENCE-OR-DOWNGRADE.** `repro: empirical` with no pasted harness + concrete input + ≥3-point timing is auto-downgraded to theoretical and capped at MEDIUM. Any timing run with non-empty stderr is INVALID. Do not report self-reported effort scalars — paste the work.

## 8. Baseline commands (reproduce the green state, then go beyond it)

```bash
npm ci && npm run build          # tsc strict + noUncheckedIndexedAccess
npm test                         # DERIVE the it() count, don't trust a comment
npm run test:coverage            # per-file floors; regenerates coverage-summary.json
npm run lint                     # biome, 0 findings
npm run check:version-consistency   # 7 version surfaces + CLAUDE roll-up marker
npm run check:oia                # state-driven walks (script self-declares canonical count)
node scripts/check-audit.mjs     # scoped npm-audit gate (ALLOWLIST empty = strictest)
node scripts/smoke.mjs           # synthetic-vault tools/list + initialize
npm pack --dry-run               # packaged file set
```

All expected green on rc.2. These are the **floor, not the ceiling**. Any FAIL on a clean checkout is a finding.

## 9. Coverage obligations (Hat A) — fill §14 B for each class

STRIDE/security · ReDoS/polynomial-regex · resource/DoS caps (CAP-or-EXEMPT — check `resource-bound-invariant` before proposing a cap) · Unicode/NFC/encoding/line-terminators · concurrency · info-disclosure · optional-dep leaks · right-to-erasure/data-at-rest · write-fidelity/data-loss · claim-vs-guard (§10) · MCP contract (`readOnlyHint`/K-3) · retrieval correctness (RRF/rerank/graph-boost/recency/chunking-parity/HNSW-under-return/eval-metric) · supply-chain (SHA-pinned actions, `run:`-download content-pinning, `overrides`, allowlist, phantom deps, `files[]`) · docs/claim-vs-reality (derive every count) · test/CI integrity (no silent-skip on security surfaces, no test-theater, real NEGATIVE controls, behavioral tests generate the failing shape) · **novel (name it)**.

## 10. Claims ledger (Hat A) — fill §14 F: `Holds` / `Partial(late-guard)` / `False` + the guard file:line

Zero-outbound (embeddings + reranker + OCR, incl. cache-miss) · SLSA L2 (no surface overclaims L3+) · `.base` unevaluable predicates fail-closed (incl. `not:`) · `*Safe`/`peek*Meta` never throw (corrupt/dir/unreadable file) · privacy filter fails-closed (excluded notes never surface, incl. graph-boost/recency intermediates) · atomic `writeNote` overwrite (no truncation window, no symlink escape, no stale tmp) · OCR offline-enforced (fails closed BEFORE any worker fetch) · bearer constant-time + ≥16 · input caps fail-closed at the BOUNDARY (before the expensive scan).

## 11. Out of scope / known-accepted (Hat A) — do NOT re-flag as NEW; DO challenge with a repro

Fixed & re-probe-only (do not re-report): the wikilink/embed quadratic ReDoS, CRLF heading + open_questions drop, `writeNote` symlink-escape, the NFC tag/frontmatter-key class, `frontmatter_set` non-mapping data-loss, reserve-before-try open()/listen() leaks, the DQL/LIKE/glob ReDoS family, the abs-path-leak class, feedback prototype-pollution, the line-terminator class (`split("\n")` + `match(/\n/g)` → `splitLines`/`countLineBreaks`), the case-fold-asymmetry class (`foldForMatch`), the fence/parser-desync class (rc.1→rc.6 of the v3.11.5 line + the rc.2 structure.ts phase 1). **Reasoned-rejected — do NOT re-flag:** `create_note`/`append_to_note` uncapped content (deliberate — strictly linear sink, double-bounded by `deriveHttpBodyCap` 7.5 MB + `maxFileBytes` 5 MB; a 1 MB cap would be a regression — re-raise only with a SUPERLINEAR cost or sub-7.5 MB harm). **Accepted:** R-10 HNSW under-return at >66%-excluded; js-yaml alias/anchor billion-laughs (bounded by single-user model; merge-key DoS gone in v5); `.base` frontmatter equality case-SENSITIVE by design; DQL LIKE `toLowerCase()` under-matches ~22 exotic codepoints (never over); `capacity()`/`resize()` orphaned test-only API; the source-`it()` convention; maintainer-only items (branch protection, registry metadata). If you believe any accepted item is exploitable, escalate WITH a repro.

---

# PART II — HAT B: STRATEGY, COMPETITION, POSITIONING & ROADMAP

> This is the half most external technical audits skip and the maintainer most needs. Treat every question below as a **prompt to form and defend an independent opinion**, not a form to fill. Bring outside evidence (competitor repos, star counts, download trends, HN/Reddit sentiment, analyst framing). **Disagreement backed by reasoning is the deliverable.** Cite sources; a strategic claim with no evidence is worth as little as an `empirical` finding with no harness.

## 12. The meta-question — is the effort pointed at the right target? (answer this FIRST and bluntly)

Read `CLAUDE.md` and the `CHANGELOG` end-to-end as an *artifact of how the project spends its time*. Observed pattern: **~80 release candidates for a single minor version**, a very large fraction of them audit-driven hardening of security/correctness classes (ReDoS, NFC, abs-path-leak, fence-desync, line-terminators), each closed with a behavioral test + a structural invariant, frequently followed by a "post-merge re-sweep" that finds a sibling of the just-fixed class, recursively.

Answer, with reasons:

1. **Is this discipline a moat or a treadmill?** The maintainer believes the audit-cascade + invariant apparatus is the project's defining competitive advantage ("максимальное качество, уверенный топ-1"). An outside engineer might see over-fitting: months of effort hardening a single-user, local-first tool against threat classes whose worst realistic harm is a self-inflicted event-loop hang. **Which is it?** Quantify if you can (e.g., share of RCs that fixed a *user-observable* bug vs a theoretical/invariant one).
2. **Opportunity cost.** For the same effort, what user-facing value could have shipped instead? Name the top 3 things the project did NOT do because it was hardening.
3. **Is the marginal audit still positive-ROI?** At 1490+ tests, 12 OIA checks, ~20 invariants — where is the point of diminishing returns, and has it passed? What would you *stop* doing?
4. **Sustainability & bus-factor.** This is a solo maintainer + AI-agent workflow. Is the apparatus (the invariant zoo, the RC cadence, the CLAUDE.md ledger) maintainable by anyone else, or is it a personal artifact? Does it help or hurt a future contributor?
5. **The honest recommendation.** If you had one sentence of advice for how the maintainer should allocate the next 3 months, what is it?

## 13. Competitive landscape — map it, then critique the position

We want an **actual map with names, links, and a comparison**, not generalities. Cover at least these cohorts (find more):

- **Direct — other Obsidian / Markdown-vault MCP servers.** e.g. `cyanheads/obsidian-mcp-server`, `MarkusPfundstein/mcp-obsidian`, Smithery/Glama-listed Obsidian servers, any "obsidian" entry in the official MCP registry. How many are there now? What do they do that enquire does not, and vice-versa? Where does enquire genuinely lead (retrieval sophistication) vs where does a simpler competitor win (setup friction, Local REST API live integration, popularity/stars)?
- **Adjacent — AI memory / agent-memory tools.** mem0, Zep, Supermemory, Letta/MemGPT, Cognee, Memobase, txtai. The "grounded, not extracted" wedge is aimed at these. **Is that distinction legible to the market, or is it inside-baseball?** Are these actually competitors or a different buyer?
- **Adjacent — code/knowledge memory MCPs.** The DeusData/codebase-memory-mcp class (21k★, "120× fewer tokens" positioning). What is *transferable* from their playbook (a single measured hook, frictionless install) and what is a trap to copy (single-binary rewrite, code-domain features) for a notes tool?
- **Adjacent — PKM + AI apps and local semantic search.** Khoj, Reor, Amurex, Notion AI / Q&A, Mem, Saga, Obsidian's own Copilot/Smart Connections community plugins, `llamaindex`/`llama.cpp`-based local RAG. Where does a *server* (MCP) win or lose vs an *app/plugin* the user already lives in?

For each, we want: **who wins which buyer, on what axis, and why.** Then your verdict: **is "the most advanced Obsidian MCP" a winning position or a niche ceiling?** Obsidian's user base is finite; is the right target "any Markdown vault", "any local-first knowledge store", "the retrieval backend for agent frameworks", or something else? Argue it.

## 14-topics. Positioning & messaging critique

- Is **"grounded, not extracted"** the sharpest wedge available, or is there a stronger one (privacy/local-first? retrieval quality with a *published number*? auditability/citations?)? Rewrite the one-line positioning if you can beat it.
- The README leads with capability breadth (46 tools, 7-tier retrieval). Is breadth the right lead, or does it signal complexity/over-engineering to a buyer who wants "point it at my vault and it works"? What should the hero say?
- **Credibility gap:** the project has an eval harness (LongMemEval retrieval, `bench:context`) but has NOT published a headline number (deliberately — "measured, reproducible, reviewed, never a placeholder"). The 21k★ competitor leads with one falsifiable number. **Is withholding the number principled caution or a growth mistake?** What is the single most credible number this project could publish, and what would it take to publish it responsibly?
- **Discoverability / agent-SEO.** 11-language READMEs, `llms.txt`, `AGENTS.md`, MCP-registry sync, JSON-LD. Is this effort proportionate and effective, or cargo-culted? What actually drives MCP-server adoption in 2026 (registry rank? awesome-lists? a viral demo? word-of-mouth in agent-framework communities?) and where should discovery effort go?

## 15-topics. Roadmap & feature strategy — critique the bets, propose new ones

Read `ROADMAP.md` + the CLAUDE.md "deferred / maintainer-gated / tracked" items (structure-accessor phases 2–7, forgetting-aware staleness, closed-loop feedback, published LongMemEval score, multi-vault, the deliberately-not-done list: OAuth, Local REST API live integration, formula-eval for Bases).

1. **Critique the existing bets.** Forgetting-aware staleness and closed-loop feedback (`mark_useful`) are the two most novel recent features. Are they solving a real user pain or are they clever-but-unused? What is the evidence either way, and how would you validate demand cheaply?
2. **Table-stakes gaps.** What does a 2026 agent-memory/retrieval buyer expect that enquire lacks? (Candidates to assess, not a checklist to accept: incremental/streaming ingestion at scale, multi-vault, a hosted/team option, write-back workflows, richer GraphRAG, an eval/observability dashboard, tighter Obsidian live integration, non-Obsidian source connectors.)
3. **The 3 highest-leverage features** you would ship in the next quarter, each with: the user pain, why now, rough effort (given the architecture Hat A just read), and the risk.
4. **What to KILL or not build.** Name features/subsystems that add surface without proportional value. The maintainer explicitly declined OAuth, multi-vault, Local REST API live integration, and a Bases formula evaluator — **do you agree with each of those "no"s?** Is any of them now worth reversing?
5. **Architecture-enabled vs architecture-blocked.** From Hat A's reading: which of your proposed features does the current architecture absorb cheaply, and which would require a painful refactor (e.g., the single-vault assumption, the disk-cache `ParsedNote` shape, the synchronous watcher critical section)?

## 16-topics. Growth, distribution, and (optionally) business model

- **What does "winning" look like for this project**, and what is the one metric that best proxies it (npm downloads? registry rank? GitHub stars? actual serve-mode usage)? Is the maintainer optimizing a vanity metric?
- **Distribution.** How does an MCP server actually get adopted at scale in 2026? Concrete, ranked channels for THIS project.
- **Community & contribution.** Is the project set up to accept outside contributors, or is the RC/audit cadence a wall? Should it be?
- **Business model (optional but welcome).** It is MIT OSS with a solo maintainer. Is there a sustainable model (hosted multi-vault/team, pro support, a paid eval/observability layer, sponsorship) that would NOT betray the local-first/privacy brand — or is "beloved OSS tool" the correct and sufficient goal? Argue for or against monetization.

## 17-topics. Risks (non-code) — name the strategic ones

Platform risk (Obsidian API/Bases changes; Anthropic/MCP spec churn; transformers.js / model-license shifts), commoditization risk (a first-party Obsidian AI feature or an Anthropic-blessed memory server eating the category), key-person risk, and the "great tech, no distribution" risk. For each: likelihood, blast radius, and a cheap hedge.

---

## 18. Deliverable — ONE Markdown report (do not commit it to the repo)

Structure it so a maintainer's agent can act on it and so it diffs cleanly against other auditors' reports. Field names are stable; the JSON appendix is authoritative on any prose conflict. **Sections C and E are GATING for the technical verdict** (a `ship_to_latest:true` is invalid without them).

### FRONTMATTER (YAML)
```yaml
audit_id: <name>-<model>-<short-sha>
graded_commit: <full sha you read>
methodology_technical: <static-file-by-file | code-path-sink-tracing | runtime-differential-probing | hybrid>
methodology_strategic: <practitioner | competitor-user | analyst | hybrid — and your market vantage>
methodology_blindspot: <one sentence: what your approach CANNOT see>
overall_technical_score: <0.0-5.0 — the JSON appendix MUST equal this>
strategic_conviction: <0.0-5.0 — how strongly you'd stake your reputation on your Hat-B recommendations>
ship_to_latest: <true|false>   # INVALID as true unless §C complete+bounded AND §E priors re-RAN
severity_counts: { critical: N, high: N, medium: N, low: N, info: N }
novel_class_found: <true|false>
env: { os: , node: , optional_deps_built: [...], any_dep_build_failed: <true|false> }
```

### SECTION A · EXECUTIVE VERDICT (≤10 sentences) — BOTH hats
The technical headline (ship or not, why, cite §C+§E) AND the single most important strategic message. If these two conflict (e.g., "code is immaculate but the project is polishing the wrong thing"), **say so plainly** — that synthesis is the highest-value sentence in the report.

### SECTION B · TECHNICAL COVERAGE MATRIX (one row per §9 class)
`| class | depth(0-3) | sink-rows-traced | repros-run | status(clean/finding/ENV-BLOCKED/not-covered) | notes |` — a `depth≥2 clean` REQUIRES its sink rows in §C.

### SECTION C · SINK-TRACE TABLE — GATING (one row per always-on/bearer-reachable tool, enumerated from `src/tool-registry.ts` at the graded commit)
`| tool | input field | validation (file:line) | sink (file:symbol) | cost O(?) | bound (value/UNBOUNDED) | repro-status |` — a "trusted (rc.N)" cell is INVALID; a missing row for a registered always-on tool, or an UNBOUNDED+not-probed row, caps `overall_technical_score` at 2/5.

### SECTION D · NEW-CODE INVENTORY (since prior tag; incl. `src/structure.ts`)
`| new function/line | file:symbol | probed? | worst-case shape emitted? |`

### SECTION E · PRIOR-FINDINGS RE-VERIFICATION — GATING (re-RUN, do not trust the changelog)
`| prior finding | rc closed | probe you RE-RAN | result (holds/REGRESSED/inconclusive) |`
**MANDATORY rows:** (1) hostile-FS symlink re-probe of `writeNote` overwrite through `dist/`; (2) offline cache-miss network check in `serve` mode; (3) structure.ts differential vs an inlined predecessor walker on the §5 fence shapes.

### SECTION F · CLAIMS LEDGER (§10)
`| claimed guarantee | enforcing guard (file:line) | verdict: Holds/Partial(late-guard)/False | verification method |`

### SECTION G · TECHNICAL FINDINGS (zero or more; severity-ordered; zero is a TOP result if C+E are complete)
Each finding a block:
```
id: <CLASS>-<sink-file>:<symbol>       # key on the SINK, not a slug, so auditors collide/de-dup
severity: CRITICAL|HIGH|MEDIUM|LOW|INFO
reachability: <tool> · <auth/flags?> · least-privileged-tool-reproduced-through
root_cause_of: <this id | parent id>
sink: <file:symbol + the algorithmic reason, one line>
cost_function: <O(?) in terms of which input>
repro: <empirical | theoretical>
harness: | <pasted ≤40-line harness, run through dist/>
evidence: <input + t(n) at ≥3 sizes (n,4n,16n) + small-input control; non-empty stderr = INVALID>
self_refutation: <strongest FP/WAI/over-broad argument + why it survives; check CAP-vs-EXEMPT + §11>
severity_justification: <map to the §19 rubric>
fix_sketch: <≤2 sentences; state you checked it doesn't contradict a passing invariant>
confidence: <high|medium|low>
disagrees_with_maintainer: <none | "re-verified rc.NN and disagree because …">
```

### SECTION H · STRATEGIC ANALYSIS (Hat B — the other half of the value; prose, evidence-cited)
- **H1 · Meta-strategy verdict (§12):** moat or treadmill? the opportunity-cost top-3; the one-sentence allocation advice.
- **H2 · Competitive map (§13):** a table `| competitor | cohort | who it wins | axis | enquire's edge | enquire's gap | source-link |` + the "is Obsidian-MCP a ceiling?" verdict.
- **H3 · Positioning (§14-topics):** your best one-line positioning (beat "grounded, not extracted" or defend it); the hero-message recommendation; the published-number verdict.
- **H4 · Roadmap critique + proposals (§15-topics):** critique of the current bets; the 3 highest-leverage features (pain / why-now / effort-given-architecture / risk); the kill-list; the "no"s to reverse.
- **H5 · Growth / distribution / model (§16-topics):** the one true success metric; ranked distribution channels; the monetization take.
- **H6 · Strategic risks (§17-topics):** the ranked risk table with hedges.

### SECTION I · SELF-ASSESSMENT
- `under_covered:` [technical classes you skimmed — may NOT be `clean` in B]
- `strategic_confidence_low:` [Hat-B claims you're least sure of / most want challenged]
- `with_2x_budget:` [what you'd probe/research next]
- `novel_class:` <name + repro, or 'none'>
- `methodology_unique_value:` <what your lens saw that another wouldn't — the ≥2-auditor-gate statement>

### JSON APPENDIX (REQUIRED — the aggregator parses this; must match frontmatter)
```json
{ "audit_id":"", "graded_commit":"", "overall_technical_score":0.0, "strategic_conviction":0.0,
  "ship_to_latest":false, "severity_counts":{"critical":0,"high":0,"medium":0,"low":0,"info":0},
  "novel_class_found":false, "sink_trace_complete":false, "priors_reprobed":false,
  "top_strategic_recommendation":"", "competitors_mapped":0,
  "technical_findings":[ {"id":"","severity":"","reachability":"","sink":"","cost_function":"","repro":"","root_cause_of":""} ],
  "strategic_theses":[ {"topic":"","claim":"","evidence_strength":"high|medium|low"} ],
  "env":{} }
```

## 19. Severity rubric (technical — anchored to this project's real outcomes)

- **CRITICAL** — Unauthenticated remote exploit, OR **note-content-triggered** (fires through an always-on read tool with NO bearer/flag) causing data loss, write-outside-vault, or an unrecoverable hang.
- **HIGH** — Bearer-reachable via an **ALWAYS-ON** tool (no `--enable-write`/diagnostic flag), empirically reproduced through that exact tool, causing multi-second event-loop DoS at a legal input size OR silent data loss/corruption. A finding you cannot trace to a file:symbol sink, or only reproduce through a write/diagnostic-gated tool, is NOT HIGH.
- **MEDIUM** — Bearer-reachable but GATED behind ≥1 opt-in flag, empirically reproduced, DoS or local corruption. Double-opt-in-flag gating pulls a would-be HIGH down to MEDIUM.
- **LOW** — Real, reproducible, bounded by an existing guard, single-user-only with no security/data impact, or a doc/TSDoc drift verified against code.
- **INFO** — Baseline/hygiene. Fold into a one-line note; don't file a block unless it changes behavior.
- **REJECTED (counts against precision):** an over-broad rec contradicting a passing invariant; a re-litigated documented-WAI item without fresh repro; a finding whose evidence runs contradict each other; a fix worse than the non-issue; a hallucinated field/method.

> **A false "all-clear"** (`ship_to_latest:true` with an unfilled §C) **is the worst technical outcome.** **A flattering strategic section with no disagreement is the worst Hat-B outcome.** We are paying for independent judgement on both — make "clean" and "great strategy" expensive to claim. Reproduce everything technical through `dist/`; cite every strategic claim; run the named shapes; and try to tell us the one thing we most need to hear and least want to.

Thank you. **Findings and recommendations are the deliverable; the maintainer's agent implements the fixes and decides the strategy.**
