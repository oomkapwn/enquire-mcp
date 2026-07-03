# AGENTS.md

Notes for AI coding agents (Cursor, Claude Code, Codex, Aider, Devin, etc.) working in **this repo**.

> **You are NOT a user.** Users invoke `enquire-mcp` via MCP from their AI agents. This file is for AI agents *modifying enquire-mcp's source code* (PRs, refactors, bug fixes). For end-user docs see [README.md](./README.md) and [docs/](./docs/).

## TL;DR

- Production code: `src/*.ts` (TypeScript strict + `noUncheckedIndexedAccess`)
- Tests: `tests/*.test.ts` (Vitest, 1490+ tests)
- Build: `npm run build` (tsc → `dist/`)
- Test: `npm test` (full suite ~12s)
- Lint: `npm run lint` (biome — must exit 0)
- Coverage: `npm run test:coverage` (11 per-file coverage floors enforced)
- OIA: `npm run check:oia` (state-driven drift scan — 12 checks)
- Version sync: `node scripts/check-version-consistency.mjs`

All 9 required CI gates run on every PR. Local checks above must pass before pushing.

## Architecture (5-minute orientation)

```
src/
├── cli.ts              — commander.js CLI (subcommands: serve, serve-http, setup, install-model, build-embeddings, index, doctor, eval, install-ocr-lang)
├── cli-help.ts         — shared CLI help-text constants (drift-prevention; see "Help text rule" below)
├── server.ts           — MCP server bootstrap + dependency wiring
├── tool-registry.ts    — tool registration manifest
├── tool-manifest.ts    — tool metadata (names, schemas, readOnlyHint)
├── prompts.ts          — 19 MCP prompts
├── tools/              — 46 tool implementations (read, write, search, media, meta)
├── vault.ts            — Obsidian vault filesystem layer + privacy filter
├── fts5.ts             — SQLite FTS5 BM25 index
├── embed-db.ts         — embedding storage (int8-quantized BLOBs)
├── embeddings.ts       — Hugging Face transformer.js loader
├── embed-pipeline.ts   — chunking + embedding build pipeline
├── hnsw.ts             — HNSW vector index wrapper
├── rrf.ts              — reciprocal-rank-fusion (orchestration in tools/search.ts)
├── watcher.ts          — chokidar filesystem watcher → incremental re-index
├── http-transport.ts   — streamable HTTP MCP transport (Express)
├── bases.ts            — Obsidian Bases DSL parser + executor
└── doctor.ts           — health check (color-coded ✓/⚠/✗)

scripts/
├── oia-walk.mjs                       — state-driven drift scan (12 checks)
├── check-per-file-coverage.mjs        — per-file branch floor enforcement
├── check-version-consistency.mjs      — version sync across 7 surfaces
├── check-changelog-coverage.mjs       — CHANGELOG claims vs reality

tests/
├── *.test.ts                          — Vitest unit tests
├── docs-consistency.test.ts           — invariant: README/package.json claims match reality
├── cli-parity.test.ts                 — invariant: serve and serve-http have identical shared-flag help text
├── k1-class-invariant.test.ts         — structural guard for the K-1 saga
└── ...

docs/
├── api.md              — tool catalog
├── COMPARISON.md       — vs Smart Connections / other Obsidian-MCPs
├── QUICKSTART.md       — onboarding
├── benchmarks.md       — retrieval-quality benchmarks
├── http-transport.md   — remote MCP transport guide
└── api-reference/      — auto-generated TypeDoc (do NOT edit by hand)
```

## Conventions

### TypeScript

- Strict mode + `noUncheckedIndexedAccess`. Index access (`arr[i]`) returns `T | undefined`.
- TSDoc (`/** ... */`) on every exported symbol with `@param` / `@returns` / `@example`. Drift between TSDoc and implementation is the α-class antipattern (caught by CLAUDE.md rule + invariant tests).
- No `any` — use `unknown` + narrowing.
- Imports: alphabetical, grouped (node → third-party → local).

### Tests

- Vitest. Every fix needs a positive **and** a negative-control test (rule since v3.6.4). A test that always passes proves nothing.
- Invariant tests (`tests/*-invariant.test.ts`, `tests/cli-parity.test.ts`, `tests/docs-consistency.test.ts`) are structural defenses. Adding a new behavior often requires extending an invariant.
- Per-file branch coverage floors live in `scripts/check-per-file-coverage.mjs`. Lowering a floor without uplift work is not allowed.

### CLI help text rule

Every flag that BOTH `serve` and `serve-http` accept **must** pull its help text from a constant in `src/cli-help.ts` — not an inline string literal. The `cli-parity.test.ts` invariant fails the build if a shared flag has different help text. Adding a new shared flag = add a `_HELP` constant first.

### CHANGELOG

- Every PR must add a CHANGELOG entry with a TL;DR blockquote + method note.
- Format: `## [version] — date` headers, Keep-a-Changelog style.
- "N of N fixed" claims require a structural test gate (rule since v3.6.4). Don't ship overclaims.

### Commits

- Co-Author trailer: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` (or the model you are).
- Conventional-commit-ish style preferred but not strictly enforced. Be descriptive.
- One commit per logical change. Squash-merge to main via PR.

### PRs

- Title under 70 chars.
- Body: ## Summary (bullets) + ## Test plan (markdown checklist).
- Wait for all 9 required CI gates to pass green before merging.
- Tag the **squash-merge SHA on main** (not the pre-merge branch HEAD) — rule since v3.7.15.

## Commands cheat sheet

```bash
# Setup
npm ci                              # install (uses package-lock.json)
npm run build                       # tsc → dist/

# Test
npm test                            # full suite (~12s)
npm test -- --reporter=verbose      # detailed output
npm test -- tests/cli-parity        # run one file

# Lint / format
npm run lint                        # biome check (must exit 0)

# Coverage
npm run test:coverage               # full suite + coverage-summary.json
node scripts/check-per-file-coverage.mjs  # enforce per-file floors

# State-driven audit (catches stale docs / drift)
# IMPORTANT: Check 6 (coverage drift) reads coverage/coverage-summary.json.
# On dirty dev trees with stale summary, it false-positives. Always run
# coverage IMMEDIATELY BEFORE OIA locally (rule since v3.8.0-rc.18 L-OIA-1):
npm run test:coverage && npm run check:oia   # local dev order
node scripts/oia-walk.mjs --allow   # always exit 0 (override for documented deferrals)

# Version consistency
node scripts/check-version-consistency.mjs  # checks 7 surfaces

# CHANGELOG coverage gate
node scripts/check-changelog-coverage.mjs

# Smoke test (synthetic vault)
node scripts/smoke.mjs
```

## CI gates (9 required + 5 advisory)

Required (block merge if failed):
1. `lint` — biome check
2. `test (22)` — full suite on Node 22
3. `test (24)` — full suite on Node 24
4. `smoke` — JSON-RPC smoke against synthetic vault
5. `audit` — `npm audit --audit-level=moderate`
6. `coverage` — global + per-file branch floors
7. `version-consistency` — 7-surface version sync
8. `docs` — TypeDoc generation
9. `oia` — state-driven drift scan

Advisory (don't block, but tracked):
- `test-macos`, `docker` (image build + tools/list smoke), `CodeQL`, `Analyze (actions)`, `Analyze (javascript-typescript)`

## Do NOT

- **Do NOT modify shared CLI help strings inline.** Lift to `src/cli-help.ts` first. The `cli-parity.test.ts` invariant fails inline drift between serve and serve-http.
- **Do NOT bump version in `package.json` alone.** Run `node scripts/check-version-consistency.mjs` after — version must sync across 7 surfaces (package.json, package-lock.json root + packages[""], src/index.ts, CHANGELOG latest heading, server.json version + packages[0]).
- **Do NOT skip CI hooks** (`--no-verify`) without explicit user instruction. Investigate the hook failure root cause.
- **Do NOT force-push to main.** Main is branch-protected. All changes go through PR + 9 required gates.
- **Do NOT tag the pre-merge branch SHA.** Tag the squash-merge SHA on main after `gh pr merge --squash`. Rule since v3.7.15 (`Assert tag is on main` guard).
- **Do NOT edit `docs/api-reference/`** — it's auto-generated TypeDoc output. Edit TSDoc in `src/` instead.
- **Do NOT add `// current X%` inline comments without commitment to maintain.** OIA check 6 catches drift > 1pp against `coverage-summary.json`. Either keep current OR remove the annotation.
- **Do NOT make instance fixes when a class fix is needed.** When an audit finds a "drift" of any kind (CLI text, inline comment, doc fragment), run a full-surface sweep across the same surface type BEFORE the per-instance fix. Rule since v3.8.0-rc.11.
- **Do NOT add documentation files (`*.md`) unless explicitly requested.** README, CHANGELOG, CLAUDE.md, AGENTS.md, llms.txt are the canonical project-level docs.

## Helpful entrypoints when you're new

1. Want to add a new MCP tool? Read `src/tools/read.ts` for a representative example. Add to `src/tool-manifest.ts`. Register in `src/tool-registry.ts`. Add to `docs/api.md`. Add tests.
2. Want to fix a retrieval bug? Start in `src/tools/search.ts` (retrieval + rerank orchestration) and `src/rrf.ts` (rank fusion). The unit tests in `tests/rrf.test.ts` + `tests/search.test.ts` show the contracts.
3. Want to extend the watcher? `src/watcher.ts` + `tests/watcher.test.ts`. Note: chokidar requires a 50ms warmup after `w.start()` before the first file write in tests (rule since v3.7.15 — see W-FLAKE-1/2 history). **v3.9.0-rc.1+** added `setOcrPdfs(enabled, langs?, maxPages?)` for OCR-on-watch; **v3.9.0-rc.2+** added `attachHnsw(hnsw, rowsByLabel)` for HNSW in-memory live update — both are late-binding methods called by `server.ts` after `attachEmbed()`.
4. Want to add a CHANGELOG entry? Follow the format in existing entries. TL;DR blockquote at the top, ### sections per finding, ### Stats at the bottom.

## Project-specific style

- Methodology context (sprint goals, anti-patterns, rules accumulated through rc cascades) lives in [CLAUDE.md](./CLAUDE.md). Read it before non-trivial PRs.
- We document explicit rejections of auditor recommendations inline in the CHANGELOG (rule since v3.5.14 L-2).
- Tombstone vs current-claim comments: legitimate history (`// v3.6.1 CRIT-2 — was X`) is preserved. Current-state claims (`// current behavior:`, `// since vA.B.C`) are maintenance burden — prefer to remove if not strictly needed.
- Empirical validation > theoretical: when an auditor flags a defense as "weak", the burden is on us to demonstrate empirically that the alternative is better (e.g., v3.5.14 L-2 optional-dep removal — rejected with bench data).

## Where to ask

- Bug? Open an issue. Tag the version (`v3.7.20`, `v3.8.0-rc.11`, etc.).
- Question? Discussions tab.
- Security? See [SECURITY.md](./SECURITY.md) for disclosure policy. Don't open a public issue for vulnerabilities.
