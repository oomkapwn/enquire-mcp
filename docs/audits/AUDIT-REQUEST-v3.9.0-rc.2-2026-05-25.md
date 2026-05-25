# External Audit Request — enquire-mcp v3.9.0-rc.2

> **📌 Snapshot notice.** This document is a snapshot from **commit `a80d491` / `v3.9.0-rc.2` / 2026-05-25**. Numeric figures cited below reflect the project state on that date. Later release candidates (rc.3, rc.4, …) will increment some of these numbers; the auditor should target the commit SHA cited here (or the closest later release-candidate tag) for the actual review.

**Prepared:** 2026-05-25
**Commit SHA:** [`a80d491`](https://github.com/oomkapwn/enquire-mcp/commit/a80d491) (`main` HEAD at time of writing — v3.9.0-rc.2 squash-merge SHA)
**Audit target version:** `3.9.0-rc.2` (npm `@rc` dist-tag)
**Promotion blocker:** required before `@rc → @latest` promotion to v3.9.0 stable
**CLAUDE.md rule since:** v3.6.1 — "every minor/major needs ≥2 independent external auditors with DIFFERENT methodologies"
**Last external audit:** 2026-05-25 on `v3.8.0-rc.15` (docs/audits/v3.8.0-rc.15-external-2026-05-25.md) — verdict 4.85/5, ship-blockers: none. All Medium / Low findings closed by v3.8.0-rc.18+.

---

## What this is

Fresh external audit request for the in-flight **v3.9.0 minor** release. Since the prior audit on rc.15 we shipped:

| Release | Day | Surface change |
|---|---|---|
| v3.8.0-rc.16 | 2026-05-24 | META-invariant enforcing NEGATIVE control on every `*-invariant.test.ts` |
| v3.8.0-rc.17 | 2026-05-24 | Multi-subcommand CLI drift audit (4 byte-identical lifts) |
| v3.8.0-rc.18 | 2026-05-24 | S-AUDIT-1/2/3: server.json 5→7 surfaces, terminal isExcluded, OIA doc |
| **v3.8.0 STABLE** | 2026-05-25 | Promoted `@rc → @latest` |
| v3.8.1 | 2026-05-25 | Retroactive — overclaim #11 retraction (misdirected audit doc) |
| v3.8.2 | 2026-05-25 | State-driven docs refresh (6 stale-version fixes) |
| v3.8.3 | 2026-05-25 | OIA Check 7 — docs/+CLAUDE.md currency claims |
| v3.8.4 | 2026-05-25 | Check 7 scope expansion (README/AGENTS/examples — overclaim #12) |
| v3.8.5 | 2026-05-25 | T-2/T-3/T-4 E2E backlog closure (+7 tests) |
| v3.8.6 | 2026-05-25 | Tier C discoverability — JSON-LD on GH Pages |
| v3.8.7 | 2026-05-25 | HTTP P2-10/P2-11 — stateful session races + close cleanup (+10 tests) |
| v3.8.8 | 2026-05-25 | META structural-defense scope completeness audit (+5 tests) |
| v3.9.0-rc.1 | 2026-05-25 | OCR'd PDF watcher embed-sync (+5 tests) |
| v3.9.0-rc.2 | 2026-05-25 | HNSW in-memory live update (+13 tests) |
| v3.9.0-rc.3 (this snapshot's target) | 2026-05-25 | R-10 adaptive HNSW refill + audit attribution |

Internal methodology is change-driven and predictably misses stale state. Past external audits caught precisely what internal change-driven sweeps missed. This audit serves as the **state-driven sign-off** before v3.9.0 stable promotion.

---

## Context for the auditor

### What enquire-mcp does (1-line)

MCP server giving AI agents (Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw) persistent long-term memory backed by a local Obsidian markdown vault, with hybrid retrieval (BM25 + ML embeddings + BGE reranker, RRF-fused), HNSW vector index (with **live update on watcher events as of v3.9.0-rc.2**), agentic RAG (HyDE + sub-question), standalone Obsidian Bases query execution, and **OCR'd PDF watcher embed-sync as of v3.9.0-rc.1**.

### Where to read first (in this order)

1. [`llms.txt`](../../llms.txt) — AI-discoverable project overview
2. [`README.md`](../../README.md) — human-readable hero
3. [`AGENTS.md`](../../AGENTS.md) — coding-agent orientation
4. [`CLAUDE.md`](../../CLAUDE.md) — sprint methodology, accumulated anti-patterns (read this to understand the maintainer's mental model + 12 documented overclaim instances + 6 recursion-pair shapes)
5. [`docs/api.md`](../api.md) — full tool catalog (44 tools, 19 prompts)
6. [`docs/COMPARISON.md`](../COMPARISON.md) — side-by-side comparison
7. [`STABILITY.md`](../../STABILITY.md) — semver-bound public surface
8. [`SECURITY.md`](../../SECURITY.md) — privacy filter + write modes + threat model
9. [`CHANGELOG.md`](../../CHANGELOG.md) §3.8.0-rc.15 onward — what's changed since prior audit
10. [`docs/audits/v3.8.0-rc.15-external-2026-05-25.md`](v3.8.0-rc.15-external-2026-05-25.md) — prior audit verdict + finding cross-walk (all closed)

---

## Current state snapshot

| Surface | Value at `a80d491` |
|---|---|
| Tests | **911 passed**, 2 skipped |
| Coverage | lines ~89%, branches ~76%, stmts ~86%, funcs ~81% |
| Per-file floors | **10/10** met (watcher 53% floor — see rc.3 note below) |
| Required CI gates | **9** (lint, test ×2 [Node 22/24], smoke, audit, coverage, version-consistency, docs, oia) |
| `npm audit` | 0 vulnerabilities at moderate level |
| Version-consistency surfaces | **7** (package.json, package-lock.json root + packages[""], src/index.ts, CHANGELOG, server.json + packages[0]) |
| OIA checks | **8** (Check 1–7 + scope-completeness Check 8) |
| Structural defenses (invariant tests + audits) | tests/*-invariant.test.ts + scope-completeness-invariant.test.ts + META-invariant-coverage.test.ts + docs-consistency.test.ts (~50 numeric-claim sub-invariants) |
| Documented overclaim instances | 12 |
| Documented recursion-pair shapes | 6 |

---

## What changed since v3.8.0-rc.15 (audit prior)

### New code paths to scrutinize (highest signal)

1. **HNSW live update** (v3.9.0-rc.2): `EmbedDb.upsertNote/deleteNote` now return `{oldIds, newIds}` / `number[]`; `HnswIndex.applyDiff(removeLabels, addPoints)` mutates the in-memory graph; `VaultWatcher.attachHnsw(hnsw, rowsByLabel)` wires the watcher to apply diffs after every md/pdf upsert. The native `addPoint(replaceDeleted=true)` reuses markDelete'd slots; `allowReplaceDeleted=true` on `initIndex`. **Concurrency model**: JS event loop single-threaded, mutation block sync, no explicit mutex — review whether this is safe under concurrent serve-time searches.

2. **OCR'd PDF watcher embed-sync** (v3.9.0-rc.1): `embedSinglePdf` accepts `preExtractedPages` bypass; watcher's `setOcrPdfs(enabled, langs?, maxPages?)` late-bound after `attachEmbed`; new CLI flags `--ocr-pdfs / --ocr-langs / --ocr-max-pages`. **Fail-soft**: tesseract.js / canvas optional deps; missing deps log + continue.

3. **R-10 adaptive HNSW refill** (v3.9.0-rc.3): `adaptiveHnswRefill()` helper in `src/tools/search.ts` — doubles k until post-filter hits ≥ limit or saturation. Bounded by maxAttempts=3. Closes the ">66% excluded" under-return class from rc.9.

4. **HTTP transport hardening** (v3.8.7): `StatefulSession.{inFlight, closing}`, `SessionRegistry.{pendingInits, closeAll}`, `runWithRefcount` helper, DELETE marks-then-deletes, new `shutdownHttpServer(server)` exported. **Race conditions**: cap-check TOCTOU + sweep vs in-flight + DELETE vs concurrent use — all addressed; review whether the in-flight refcount actually closes the races under realistic load.

5. **META scope-completeness audit** (v3.8.8): `scripts/scope-completeness-audit.mjs` + `tests/scope-completeness-invariant.test.ts` + OIA Check 8 — sweeps every numeric-claim defense's scope, flags gaps. Initial defense set 5 patterns.

### State-driven walks (likely-stale surfaces to verify)

- README badges, hero, comparison table
- `docs/*.md` headers + currency claims
- CLAUDE.md status section (chronological log, 80+ entries)
- llms.txt / AGENTS.md / package.json description
- server.json (npm + MCP Registry submission)
- CHANGELOG TL;DR claims vs measured reality (especially test counts cited mid-paragraph)

### Specific zones of interest for state-driven walk

1. **R-10 residual**: even with adaptive refill, at 95%+ excluded the bounded loop may still under-return. Test with a synthetic 95% excluded fixture and report the worst-case under-return.
2. **HNSW concurrency**: review `src/watcher.ts` `syncHnswForFile` + `src/hnsw.ts` `applyDiff` for races against concurrent `searchKnn` (no explicit lock; relying on JS event-loop semantics + hnswlib markDelete being sync).
3. **OCR network posture**: v3.7.16 P1-1 said tesseract.js CDN download is gated by pre-install. Re-verify that the `install-ocr-lang` command exists, works, and is documented.
4. **MCP Registry sync**: `server.json` version + `mcpName` + the published `io.github.oomkapwn/enquire-mcp@<version>` should match each ship. Verify against `registry.modelcontextprotocol.io`.
5. **HTTP P2-10/P2-11 verification**: drive 6 concurrent inits at `maxSessions: 2` over the wire (not just unit-tested) and confirm only 2 succeed. Drive DELETE during concurrent SSE and confirm 404 on the late-arriving fetcher.
6. **Test count drift**: 911 cited across 5 surfaces (README, llms.txt, AGENTS.md, docs/COMPARISON.md, package.json). Verify each matches `grep -c '^\s*it\s*(' tests/*.test.ts`.

---

## What I'd value most

A state-driven sweep that asks: **"if I read this codebase + docs cold, what looks wrong?"**

Past external audits caught:
- Stale shell scripts referencing removed subcommands
- Drift in CHANGELOG TL;DR vs measured reality
- Inline coverage comments stale by 1pp+
- Numeric claims in NEW docs files not covered by existing invariants
- Hardcoded counts that bypass `docs-consistency.test.ts`
- File-header tombstones still claiming "rc.X is current" after several rc bumps

Internal sweeps catch what changed. External eyes catch what stayed wrong.

---

## Out of scope

- Production load test (no shared infra)
- Reranker smoke in CI (gated by env var `ENQUIRE_LOAD_RERANKER_SMOKE` — needs ~110 MB model download)
- Live SLSA-3 provenance verify (npm-side; needs npm CLI + cosign / slsa-verifier)
- Fuzz HTTP transport (no fuzzer in CI; deferred to v3.9.x+)

---

## Reproduce locally

```bash
git clone https://github.com/oomkapwn/enquire-mcp.git
cd enquire-mcp
git checkout a80d491
npm ci
npm run lint && npm run build
npm test
npm run test:coverage
npm run check:per-file-coverage
npm run check:oia
node scripts/check-version-consistency.mjs
node scripts/scope-completeness-audit.mjs
npm audit --audit-level=moderate
```

---

*This document is a snapshot; if you read it from a later commit, the cited numbers may have drifted. The auditor should anchor on the commit SHA + tag explicitly cited at the top.*
