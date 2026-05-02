# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-05-02

Wave 4: persistent on-disk cache for warm cold-starts on large vaults.

### Added
- `--persistent-cache` CLI flag — opt-in. When set, the parsed-note cache is loaded from disk on boot and written back on graceful shutdown (SIGINT/SIGTERM/`beforeExit`). On second startup of the same process against an unchanged vault, repeat parses are skipped — net win on tools that walk the whole vault (`get_backlinks`, `search_text`, `list_tags`, `get_unresolved_wikilinks`).
- `--cache-file <path>` flag to override the default cache file location (useful for sandboxed environments).
- Default cache location: `$XDG_CACHE_HOME/obsidian-mcp/<vault-hash>.json` if set, otherwise `~/Library/Caches/obsidian-mcp/<hash>.json` on macOS, `~/.cache/obsidian-mcp/<hash>.json` on Linux. Vault path is hashed (sha1, 12 chars) so multiple vaults coexist.
- Atomic writes: cache is staged to `<file>.tmp` and renamed on success.
- Schema-versioned cache (`version: 1`) — invalidates whole file if shape ever changes between releases.
- Stale-entry detection: each entry stores its source mtime; on load, mismatched mtimes are silently dropped.
- Cross-vault protection: cache is rejected if its `root` field doesn't match the current vault realpath.

### Why opt-in (not default)
- The default fast path (in-memory cache + per-read mtime stat) is already O(1) for repeat reads within a session. Persistent cache only helps **across** process restarts, which most MCP-client workflows don't need (the client keeps the server warm).
- For users who do restart often (e.g. CI bots, scratch agents on huge vaults), the flag delivers a meaningful warm-cache start. Once we have telemetry from real users, we may flip the default.

### Skipped (was J in the roadmap): chokidar-based watch mode
- Decided to skip for now. The current mtime-on-read check is correct and cheap (one `fs.stat` per read), and chokidar adds ~50KB of dep weight without measurable user-facing benefit at our vault sizes. Will revisit in v0.7+ if a benchmark says otherwise.

### Tests
- 126 unit tests (was 119). 7 new for persistent-cache: opt-in default-off, write-then-read round-trip, mtime invalidation, vault-root rejection, version mismatch rejection, corrupt-file graceful fallback, and cache file write atomicity.

## [0.5.0] — 2026-05-02

Wave 3 of the launch-prep roadmap: stricter TypeScript, lint/format with Biome, and DQL gains `OR` + `LIKE`.

### Added (DQL)
- `OR` between predicate groups: `WHERE a = 1 OR b = 2`. `OR` has lower precedence than `AND`, so `a = 1 AND b = 2 OR c = 3` parses as `(a = 1 AND b = 2) OR (c = 3)`. Quote-aware tokenizer ensures `"OR"` inside a string is data, not a clause boundary.
- `like` operator: SQL-LIKE-style wildcard matching, case-insensitive. `*` is the wildcard, `\*` is a literal asterisk. Works on string fields and on string elements of array fields. Examples: `file.name like "draft*"`, `status like "*progress*"`.

### Changed (DQL parse model — backward compatible at the query level)
- `DataviewQuery.where` is now `Predicate[][]` (disjunction of conjunctions) instead of `Predicate[]`. Querie strings without `OR` produce a single-element outer array, so existing AND-only queries keep working unchanged.

### Code quality
- TypeScript strict++: enabled `noUncheckedIndexedAccess` and `noImplicitOverride`. Surfaced and fixed real defensive-coding gaps in `dql.ts` and `parser.ts` where regex match groups and array indexing could return `undefined`. (`exactOptionalPropertyTypes` was tried and removed — fights too hard with Zod-inferred types.)
- **Biome 2** added as a lint+format toolchain: `npm run lint`, `npm run lint:fix`, `npm run format`. CI gains a dedicated `lint` job. `prepublishOnly` now runs `lint && build && test`. Codebase formatted to a consistent house style (line-width 120, double quotes, trailing-comma none).
- All `catch (err: any)` replaced with `catch (err) { if (isErrnoException(err)) ... }` for type-safe error handling.

### Tests
- 119 unit tests (was 112). New coverage: `OR` parsing, mixed AND/OR precedence, `LIKE` parsing, `LIKE` matching with leading/trailing wildcards, `LIKE` case-insensitivity. Plus 2 quote-aware-keyword tests now covering `OR`.

## [0.4.0] — 2026-05-02

Wave 2 of the launch-prep roadmap: two new vault-introspection tools, three new workflow prompts, and CI-driven coverage.

### Added (read tools)
- `obsidian_get_unresolved_wikilinks` — find every `[[wikilink]]` (and `![[embed]]`) whose target doesn't resolve. Vault-hygiene utility for finding broken links, typos, and intended-but-not-yet-created notes. Args: `folder?`, `include_embeds?`, `limit?`. Returns `{ from_path, target, raw, kind, alias, section, block, line, snippet }`.
- `obsidian_get_outbound_links` — symmetric counterpart to `obsidian_get_backlinks`. For one note, lists every link it points to with each one's resolution status. Args: `path?`, `title?`, `include_embeds?`, `include_unresolved?`. Returns `{ from_path, from_title, links: [...] }`.

### Added (prompts)
- `weekly_review` — aggregates the past 7 days of edits, groups by tag, surfaces "shipped / open / stuck" per group, ends with a 2-sentence reflection on actual vs. intended energy spend.
- `extract_todos` — greps TODO / FIXME / QUESTION across the vault (optionally filtered by `folder` and/or `tag`), groups verbatim hits by note, picks one highest-leverage next action.
- `process_inbox` — walks an inbox folder (`folder` required) and for each note proposes Move / Merge / Promote / Archive based on tags, content, and inbound/outbound links. Doesn't actually move anything — proposal-only.

### Added (CI / observability)
- `npm run test:coverage` — vitest with the v8 coverage provider.
- New CI job `coverage`: runs on every push/PR, uploads the full HTML report as a workflow artifact (`coverage-report`).
- README badges now include `tests-112-passing` and `coverage-83%-lines`.

### Tests
- 112 unit tests (was 103). New coverage: 4 cases for `get_unresolved_wikilinks` (basic detection, filtered out resolved, folder filter, embeds toggle), 5 cases for `get_outbound_links` (basic listing, embed toggle, unresolved marking, unresolved filter, alias/section/block preservation).
- Coverage on this release: **83% lines · 79% statements · 73% branches · 67% functions** (the function gap is mostly MCP wiring in `index.ts`, which is exercised by the smoke test rather than unit tests).

### Surface size
- 10 read tools (was 8) + 2 opt-in write tools.
- 2 MCP resources.
- 6 MCP prompts (was 3).

## [0.3.3] — 2026-05-02

Dependency triage — all 7 outstanding Dependabot major-version PRs landed in a single verified bump. Each was tested locally (full test suite + JSON-RPC smoke against a synthetic vault) before bundling.

### Dependencies
- `@types/node` 22 → 25 (devDep)
- `typescript` 5 → 6 (devDep) — required adding `types: ["node"]` to `tsconfig.json`. TS 6 dropped the implicit fallback that auto-discovered `@types/node` ambient globals; `process`, `Buffer`, and `node:*` modules need an explicit type-resolution hint now.
- `commander` 12 → 14 (runtime) — no API surface change in our usage.
- `zod` 3 → 4 (runtime) — `z.string().optional()`, `z.boolean().optional()`, `z.record(z.string(), z.unknown())` all migrate cleanly. No app code changes.
- `vitest` 2 → 4 (devDep) — also resolves the moderate-severity vulnerabilities flagged by `npm audit` in the `vite` / `esbuild` chain (Dependabot security PRs #8 and #9 superseded).

### Tests
- 103 unit tests, all green on the new dependency stack.
- Smoke green: 17 checks, all 10 MCP tools + 2 resources + 3 prompts verified against the synthetic CI vault.

### Notes
- Zero application code changes — pure dependency updates with one tsconfig tweak.
- Dependabot PRs #3 — #9 closed as superseded by this release.

## [0.3.2] — 2026-05-02

External read-only audit pass closed four real findings.

### Security & correctness
- **P2** `listMarkdown(folder)` now `lstat`s and realpath-checks the start directory before walking. Previously, passing a vault-internal symlink that pointed *outside* the vault as the `folder` argument would enumerate the external directory's `.md` files (reads still failed downstream, but the listing leaked filenames). Fix: empty list returned in that case.
- **P2** `--max-file-bytes` and `--cache-size` are now validated as positive finite integers at server boot. Previously, passing `NaN` / `Infinity` / floats / negative values silently disabled the size guard and produced unpredictable cache behavior. The server now exits with a clear error.
- **P2** `obsidian_read_note` now honors its documented contract — `path` works with *or* without the `.md` extension, matching the schema description and the parallel behavior of `obsidian_create_note`.
- **P3** Inline tag regex is now Unicode-aware: `#русский`, `#日本語`, `#café-au-lait`, `#русский/путь` all parse correctly. Previously the regex started with `[A-Za-z]` and silently dropped non-ASCII tags, contradicting the README's i18n promise.

### Packaging
- `docs/api.md` and `SECURITY.md` are now included in the npm tarball — README links from the published package no longer 404.
- CI: `actions/setup-node@v4` → `v6` on `main` (dependabot superseded).

### Docs
- README quick-start no longer hard-codes a stale boot-message version string.
- `LAUNCH-PACK.md` gains a top-of-file note clarifying it's a historical day-by-day log, not the current state of the project.

### Tests
- 103 unit tests (was 86). New regression coverage for every audit finding above:
  - `listMarkdown(folder)` returns `[]` for symlinked-out start directory (P2-1).
  - `parsePositiveInt` rejects NaN / Infinity / non-integer / non-positive / non-numeric (P2-2).
  - `obsidian_read_note` accepts paths with and without `.md` (P2-3).
  - Cyrillic / CJK / accented inline tags parse correctly; mid-word `#` does not produce a tag (P3-1).

## [0.3.1] — 2026-05-02

### Security
- `obsidian_create_note` now realpath-checks the *parent directory* of the target before writing. Previously, a parent dir that was a symlink resolving outside the vault would let a write escape the vault root. With this fix, such writes are refused.

### Fixed
- Cache eviction is now a true **LRU** instead of FIFO — re-reading a cached entry bumps it to the freshest slot. README/CHANGELOG already advertised LRU; behavior now matches docs.
- Dropped a small dead-code path in `obsidian_list_tags` (an unused `WeakMap`).

### Added
- `obsidian_dataview_query` now applies a default row cap of **1000** when the query has no explicit `LIMIT`. Prevents runaway responses on huge vaults.
- CI gains a dedicated **smoke job** that builds a synthetic vault and runs the JSON-RPC end-to-end against the real binary.
- CI gains an **`npm audit --audit-level=high`** job.
- CI hardened with `permissions: contents: read`, `timeout-minutes`, and concurrency cancellation.
- New tests (86 total, was 79): LRU eviction order, internal-symlink rejection in walker, path-form wikilink backlink, mtime moves forward across write→append, write refusal when parent dir is a symlink to outside the vault, default-row-cap behavior in DQL.
- `SECURITY.md`, GitHub issue templates (bug / feature), PR template, FUNDING.yml.

### Docs
- Major README rewrite for launch readiness: value-prop lead, comparison table vs filesystem MCPs, "who is this for?" section, ASCII architecture diagram, FAQ, transactional install / `npx` / global blocks.
- `docs/api.md`: documented tag-counting semantics (`fm + inline == count`) and the default DQL row cap.

## [0.3.0] — 2026-05-02

### Added
- `obsidian_list_tags` — every unique tag in the vault with frontmatter / inline counts. Sorted by usage.
- **Opt-in write tools** behind `--enable-write`:
  - `obsidian_create_note` — creates a new note with optional frontmatter; refuses overwrite by default.
  - `obsidian_append_to_note` — appends a markdown block to an existing note (`path` or `title`).
- **MCP resources**:
  - `obsidian://vault/info` — vault metadata (root, note count, limits, write flag).
  - `obsidian://note/<relative-path>` — every note as a browsable resource via `ResourceTemplate`.
- **MCP prompts**: `summarize_recent_edits`, `review_tag`, `find_orphans`.
- **Tool annotations**: every read tool tagged `readOnlyHint: true, idempotentHint: true`; write tools tagged `readOnlyHint: false`.
- New CLI flags: `--enable-write`, `--max-file-bytes <n>`, `--cache-size <n>`.

### Security & robustness
- Vault walker skips symbolic links and refuses to descend into directories whose realpath exits the vault.
- `realpath`-based safety check on every read/write target — prevents symlink-escape attacks even if a link is created after server boot.
- File-size guard (default 5 MB) on every read and write — blocks oversized binary-renamed-md from blowing memory.
- Parsed-note cache is now bounded (default 1024 entries) with FIFO eviction — predictable memory ceiling on huge vaults.
- DQL parser respects quoted strings: `WHERE x = "foo SORT bar"` no longer prematurely splits on `SORT` / `WHERE` / `LIMIT` / `AND` keywords inside string literals.

### Changed
- `obsidian_resolve_wikilink` now also accepts `![[…]]` syntax in its `wikilink` argument.
- `obsidian_read_note` output now includes `embeds` alongside `wikilinks`.
- `package.json` — dropped `main` field (CLI-only package), added `publishConfig.access = public`, added `CHANGELOG.md` to `files`, `prepublishOnly` now runs build *and* tests.
- CLI no longer runs `main()` on bare module import (guarded by `import.meta.url` check).

### Docs
- New `CONTRIBUTING.md` with scope guidelines.
- `.editorconfig` for consistent style across editors.
- README gains a Troubleshooting section, an `npx`-based MCP wiring snippet, and write-flag docs.

### Tests
- 79 unit tests (was 57). New coverage: symlink rejection, oversized-file refusal, malformed YAML fallback, Unicode titles/tags, DQL keyword-in-string, write-tool happy paths and refusals.

## [0.2.0] — 2026-05-02

### Added
- `obsidian_get_backlinks` — list every note that wikilinks (or embeds) the target. Returns ranked hits with snippets and link kind (`wikilink` / `embed` / `mixed`). `include_embeds` flag, default `true`.
- `obsidian_dataview_query` — basic Dataview-style queries: `LIST` / `TABLE col1, col2 FROM ("folder" | #tag) [WHERE field op value [AND …]] [SORT field [ASC|DESC]] [LIMIT n]`. Operators: `=`, `!=`, `contains`. Special fields: `file.name`, `file.path`, `file.mtime`, `file.tags`. Other identifiers read frontmatter.
- Parser now extracts `![[…]]` embeds separately from `[[…]]` wikilinks; both surface in `obsidian_read_note` output.
- Vault gets an mtime-keyed parse cache — repeat reads of an unchanged note are now O(1).
- GitHub Actions CI on Node 18 / 20 / 22.

### Changed
- `obsidian_resolve_wikilink` now also accepts the `![[Embed]]` syntax in its input.
- Read paths route through the new cache, removing redundant `readFile` + `parseNote` work in tools that scan the whole vault.

### Notes
- Dataview implementation is intentionally minimal — no expressions, function calls, joins, or `FLATTEN`. It covers the common LIST/TABLE-with-WHERE shape and explicitly degrades for anything fancier.

## [0.1.0] — 2026-05-02

### Added
- Initial Phase 1 release.
- Five MCP tools: `obsidian_list_notes`, `obsidian_read_note`, `obsidian_resolve_wikilink`, `obsidian_search_text`, `obsidian_get_recent_edits`.
- Stdio transport via `@modelcontextprotocol/sdk` 1.29.
- Wikilink resolver covers aliases (`Note|alias`), section refs (`Note#Heading`), block refs (`Note^id`), and `..` relative paths.
- Path-traversal guards on every read; walker skips `.git`, `.obsidian`, `.trash`, `node_modules`, and dot-dirs.
- 33 unit tests + JSON-RPC smoke test against a real 117-note vault.
