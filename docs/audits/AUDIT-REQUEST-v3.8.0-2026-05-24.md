# External Audit Request — enquire-mcp v3.8.0

> **📌 Snapshot notice.** This document is a snapshot from **commit `bad0518` / `v3.8.0-rc.14` / 2026-05-24**. Numeric figures cited below (test counts, CI gate counts, release-candidate index, etc.) reflect the project state on that date. Later release candidates (rc.15, rc.16, …) will increment some of these numbers; the auditor should target the commit SHA cited here (or the closest later release-candidate tag, e.g. `v3.8.0-rc.15`) for the actual review. Architectural areas, methodology rules, and known deferrals remain valid through any pre-stable RC.

**Prepared:** 2026-05-24
**Commit SHA:** [`bad0518`](https://github.com/oomkapwn/enquire-mcp/commit/bad0518) (`main` HEAD at time of writing)
**Audit target version:** `3.8.0-rc.14` (npm `@rc` dist-tag)
**Promotion blocker:** required before `@rc → @latest` promotion to v3.8.0 stable
**CLAUDE.md rule since:** v3.6.1 — "every minor/major needs ≥2 independent external auditors with DIFFERENT methodologies"

---

## What this is

This is a request for an **independent external audit** of `enquire-mcp` at the v3.8.0 release-candidate state, before the project promotes from `@rc` dist-tag to `@latest` (general availability of the v3.8.0 minor).

The project has accumulated 14 release candidates in the v3.8.0 cascade (rc.1 → rc.14) on top of the v3.7.20 stable line. Internal audits and prior external audits have driven the cascade. This audit serves as the **final external sign-off** before stable.

The maintainer's request: read the project state as-it-is (state-driven), not just the v3.8.0 diff (change-driven). Internal methodology is change-driven and predictably misses stale state. Past external audits caught precisely what internal change-driven sweeps missed.

---

## Context for the auditor

### What enquire-mcp does (1-line)

MCP server giving AI agents (Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw) persistent long-term memory backed by a local Obsidian markdown vault, with hybrid retrieval (BM25 + ML embeddings + BGE reranker, RRF-fused), HNSW vector index, agentic RAG (HyDE + sub-question), and standalone Obsidian Bases query execution.

### Where to read first (in this order)

1. [`llms.txt`](../../llms.txt) — AI-discoverable project overview (15 sections, curated links)
2. [`README.md`](../../README.md) — human-readable hero + comparison table + 7-tier setup ladder
3. [`AGENTS.md`](../../AGENTS.md) — coding-agent orientation: architecture, conventions, commands
4. [`CLAUDE.md`](../../CLAUDE.md) — sprint methodology, accumulated anti-patterns (read this to understand the maintainer's mental model)
5. [`docs/api.md`](../api.md) — full tool catalog (44 tools, 19 prompts)
6. [`docs/COMPARISON.md`](../COMPARISON.md) — side-by-side vs Smart Connections / other Obsidian-MCPs
7. [`STABILITY.md`](../../STABILITY.md) — semver-bound public surface
8. [`SECURITY.md`](../../SECURITY.md) — privacy filter + write modes + threat model

---

## Audit history (prior external + internal)

5 prior external audits + ~20 internal audit rounds shaped the v3.6.0 → v3.8.0 cascade:

| When | Auditor | Verdict | Focus |
|---|---|---|---|
| 2026-05-15 | Mavis (external) | 4.9/5 | v3.6.0 stable |
| 2026-05-15 | Anonymous (external) | CRITICAL findings | v3.6.0 stable (3 ship-blockers missed by Mavis) |
| 2026-05-?? | Round-7 (external) | CRITICAL | v3.6.2 — K-1/K-2 silent corruption |
| 2026-05-?? | Round-14 (external) | High-impact | v3.7.5 — 10 findings |
| 2026-05-?? | Round-15 (external) | High-impact | v3.6.0 (round 4) — PDF DoS, HTTP lifecycle |
| 2026-05-?? | Round-18 (external) | High-impact | v3.7.5 (round 5) — OCR, FTS5, GraphRAG |
| 2026-05-22 | Round-23 (external) | Medium | v3.7.5 (round 6) |
| 2026-05-22 | Round-24 (external) | Medium | v3.7.5 (round 7) |

Findings from each cycle are in [`docs/audits/`](.) and [`docs/audits/findings/`](./findings).

---

## What's NEW in v3.8.0 (rc.1 → rc.14)

### Architectural changes (where most audit attention should go)

- **rc.1**: `addAdvancedRetrievalOptions` helper — both `serve` and `serve-http` now register the same 8 retrieval flags (`--include-pdfs`, `--enable-reranker`, etc.). Closed round-20 R-3.
- **rc.2**: Watcher → embed-db sync — `chokidar` watcher (`src/watcher.ts:attachEmbed`) now incrementally updates the embed-db (not just FTS5) on `.md` changes.
- **rc.3**: PDF embed-pipeline factored into `src/embed-pipeline.ts`; watcher PDF path uses it (closed round-20 R-7).
- **rc.5**: K-3 readOnlyHint structural invariant (`tests/k3-invariant.test.ts`) — every write tool MUST set `readOnlyHint: false` in its manifest entry; every read tool MUST NOT set it.
- **rc.6**: Round-23 external audit response (6 fixes): vitest per-it timeout, protobufjs CVE, serve-http `--watch` parity, circular import fix, contextPack hard budget cap, OIA promoted from advisory → required (9th gate).
- **rc.7**: Self-audit α-class TSDoc drift fixes.
- **rc.8**: Round-24 external audit — 2 findings (contextPack test coverage, embed-pipeline floor).
- **rc.9**: Round-7 external audit response (3 fixes): W-FLAKE-2 chokidar warmup, HNSW k multiplier under-return fix, qs CVE.
- **rc.10**: P3-25/21/27 backlog: extractHeadings tilde-fence fix, PERSISTENT_INDEX_HELP wording, HNSW meta validation. Watcher floor 69% → 71%.
- **rc.11**: M-1 root-class fix — 9 shared CLI flags lifted to `cli-help.ts` + new `cli-parity` invariant for help-text equality. L-1 root-class fix — OIA walk check 6 for stale `// current ~X%` coverage comments.
- **rc.12**: AI/LLM discoverability Tier A — `llms.txt`, `AGENTS.md`, README polish.
- **rc.13**: AI/LLM discoverability Tier B — `mcpName` field, `server.json`, `CITATION.cff`. Submitted to official MCP Registry (status active, isLatest true).
- **rc.14**: Post-rc.13 audit closure — M-2 root-class fix (7 new docs-consistency invariants for llms.txt + AGENTS.md), L-2/L-3/L-4 documentation gaps.

### Behavior-bearing src/ files most touched (in v3.8.0 cascade)

```
src/cli-help.ts          (new constants for shared CLI help — drift-prevention surface)
src/cli.ts               (addAdvancedRetrievalOptions helper + 13 cli-help constants)
src/embed-pipeline.ts    (NEW in rc.3, ~84% branch coverage)
src/hnsw.ts              (P3-27 meta validation, rc.9 R-10 k multiplier)
src/http-transport.ts    (P1-3 deferred; some fixes from prior audits)
src/server.ts            (R-7 watcher embed-db lifecycle)
src/tools/meta.ts        (rc.6 R-4 contextPack hard budget cap)
src/tools/read.ts        (rc.10 P3-25 tilde-fence fix in extractHeadings)
src/tools/search.ts      (rc.9 R-10 HNSW k multiplier)
src/watcher.ts           (rc.2 + rc.3 R-7 watcher embed sync, ~71% branch coverage)
```

---

## Areas requesting extra scrutiny

The maintainer's internal multi-round audits + prior external rounds covered most surfaces. Specific areas where additional eyes are most valuable:

### 1. Watcher embed-db sync race conditions (`src/watcher.ts`)

rc.2 added embed-db updates on filesystem changes. Concurrent writes (Obsidian editing + simultaneous `enquire-mcp serve` reading) could race. Coverage 71%, fail-soft branches (embedder throws) tested via rc.10 NEGATIVE control. Look for:
- Cross-file rename followed by content edit in <50ms window
- chokidar event ordering quirks under FSEvents (macOS)
- Embedding model lifecycle (open/close) during continuous edits

### 2. HNSW k-multiplier under-return (`src/tools/search.ts`)

rc.9 R-10 bumped HNSW over-fetch from 4× → 6×. Residual under-return possible when >66% of index is excluded by `--exclude-glob`. Documented as accepted but may surface user-facing complaints. Look for:
- Privacy filter applied AFTER HNSW search (not before) — could leak signal via `per_signal` observability
- HNSW filter-during-search (architectural, v3.8.0+ deferred)

### 3. HTTP transport stateful session lifecycle (`src/http-transport.ts`)

P2-10 (stateful session race), P2-11 (HTTP server close cleanup) deferred from prior audits. Coverage 69%. Look for:
- `--max-sessions` cap enforcement
- Idle session eviction (`--session-idle-timeout-ms`)
- Bearer-auth bypass paths

### 4. Privacy filter completeness (every search + write path)

Class ε swept in v3.7.20 but worth re-checking after rc.2+rc.3 watcher changes. Look for:
- Watcher writing chunks to embed-db for paths matching `--exclude-glob` (should refuse)
- Privacy filter on graph traversal (wikilink backlinks could leak excluded paths)
- canvas read paths

### 5. Concurrent write atomicity

rc.11 lifted M-1 (CLI help drift) — but multi-subcommand drift (install-model/build-embeddings/eval/bench for `--include-pdfs`, `--quantize-embeddings`, etc.) is in backlog. Auditor input on which deserve unification vs context-specific text would help prioritize.

### 6. Documentation accuracy (state-driven)

CLAUDE.md anti-patterns explicitly call out internal change-driven methodology missing state-driven drift. Run a full read of:
- README.md (855 tests, 44 tools, 19 prompts claims)
- llms.txt, AGENTS.md (new in rc.12)
- docs/api.md, docs/COMPARISON.md, docs/QUICKSTART.md
- inline file headers in src/*.ts

…and report any stale fragments.

---

## What the maintainer already KNOWS is open

These are explicit deferrals to v3.8.0 *post-stable* or later:

- **Tier C discoverability** — JSON-LD `SoftwareApplication` schema on GH Pages, GitHub Sponsors funding.yml
- **T-2, T-3** — communities handler + hyde E2E tests
- **T-4** — optional serve-http HTTP smoke test
- **Multi-subcommand CLI drift audit** (from rc.11 RCA) — install-model/build-embeddings/eval/bench
- **OCR'd PDF watcher embed-sync** — pdfjs binary read in chokidar timing window
- **HNSW in-memory live update** — currently rebuilds from disk on every signature change
- **P1-3** — serve-http flag parity for the few flags addAdvancedRetrievalOptions doesn't cover
- **P2-7** search underfill
- **P2-8** FTS5/embedding chunking parity
- **P2-12** doctor privacy filters
- **P2-18** npm package broken links
- **P2-20** canonical CLI docs
- **P3-29** setup-snippet mkdir

If the audit raises a NEW finding outside these — that's the highest-value signal. If it raises a finding INSIDE these — confirms the prioritization.

---

## How to validate things locally

```bash
git clone https://github.com/oomkapwn/enquire-mcp
cd enquire-mcp
git checkout bad0518   # exact commit this audit targets
npm ci                 # uses package-lock.json
npm run build          # tsc → dist/
npm test               # 855 tests, ~12s
npm run lint           # biome check (must exit 0)
npm run test:coverage  # full suite + coverage-summary.json
node scripts/check-per-file-coverage.mjs   # 10 per-file branch floors
node scripts/check-version-consistency.mjs # 5-surface version sync
npm run check:oia      # state-driven drift scan (6 checks, exit 1 on findings)
```

CI gates (9 required + 4 advisory) configured in `.github/workflows/ci.yml`. Release workflow `.github/workflows/release.yml` re-verifies all 9 required passed on tagged SHA before npm publish.

---

## Methodology notes (for the auditor)

The CLAUDE.md anti-patterns section accumulates ~12 explicit rules from past cycles, including:

1. **Audit BEFORE ship, not after** (rule since v3.6.4)
2. **Single class-sweep is not enough — same-release recursion happens** (rule since v3.7.15)
3. **Tag the SQUASH-MERGE commit on main, not the feature-branch HEAD** (rule since v3.7.15)
4. **Internal change-driven sweeps miss state-driven failure modes — run OIA before claiming "no open findings"** (rule since v3.7.17)
5. **"Drift" findings demand a full-surface sweep BEFORE per-instance fix** (rule since v3.8.0-rc.11)
6. **Every new docs surface with numeric claims MUST extend `docs-consistency.test.ts` in the SAME PR** (rule since v3.8.0-rc.14)

The maintainer expects the auditor will challenge **any of these rules** if they seem misguided. Documented inline-rejections of auditor recommendations are accepted with reasoning in CHANGELOG (rule since v3.5.14 L-2).

---

## Deliverable

A markdown report with:
- One-line summary verdict + score (e.g. "4.8/5 — 0 ship-blockers, 3 medium")
- Findings table: severity / location / evidence / fix recommendation
- Rejections (if any) of the methodology rules above with reasoning
- Recommendation: ship v3.8.0 stable as-is / ship with fixes / hold

Save as `docs/audits/v3.8.0-<auditor-name>-<date>.md` and reference the commit SHA `bad0518` (or whatever main HEAD is when you read this).

---

## Contact

- Maintainer: Alex (@OomkaBear on X, @oomkapwn on GitHub)
- npm: `@oomkapwn/enquire-mcp`
- GitHub: `https://github.com/oomkapwn/enquire-mcp`
- License: MIT
