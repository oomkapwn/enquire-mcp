# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] — 2026-05-03

External-user feedback on `obsidian_search_text`. Three issues, all addressed.

### Changed (BREAKING — semver-minor on 0.x is fine)
- **`obsidian_search_text` default semantics: substring → AND-tokenizer.** Pre-v0.9, a query like `"meeting notes"` only matched files where those two words were a contiguous substring (literal phrase). It silently returned `[]` even when both words appeared separately in a file — confusing and indistinguishable from a broken call. Reported by an external user.

  v0.9 default tokenizes the query on whitespace and requires every token to appear in the note (mode `"all"`). New `mode` parameter:
  - `"all"` — every token must appear (default, AND).
  - `"any"` — at least one token (OR).
  - `"phrase"` — pre-v0.9 contiguous-substring match (use this for the old behavior).

  Migration: if you relied on the old behavior, pass `mode: "phrase"`.

- **`obsidian_search_text` response shape: bare array → structured object.** Was: `[{path, snippet, score, line}]`. Now: `{query, mode, scanned_notes, matches: [{path, snippet, score, line, matched_terms}]}`. The wrapper closes the "0 matches vs broken silently" antipattern (you can now see how many notes were scanned and which terms were used). `matched_terms` lists which tokens actually hit, useful for diagnostic.

### Performance
- **`obsidian_search_text` reads files in parallel chunks of 16** (was strictly sequential). On a 100-note vault that's roughly a 4–8x cold-cache speedup for the search path. Open-fd consumption is bounded by the chunk size. Larger vaults still benefit from `--persistent-cache` for warm reads.

### Tests
- 163 unit tests (was 159). 4 new for `searchText`: AND-default, `any` mode, `phrase` mode (backward-compat), structured-response with `scanned_notes` on zero matches.

### Migration cheat-sheet
```diff
- searchText({ query: "weekly review" })
+ searchText({ query: "weekly review", mode: "phrase" })  // if you wanted the old phrase match
+ searchText({ query: "weekly review" })                  // new default: any note with both words
```

## [0.8.1] — 2026-05-03

### Fixed
- **`npm install -g github:oomkapwn/enquire-mcp` left a broken symlink in `node_modules`**: `dist/` is `.gitignore`d, so a fresh git clone has no compiled output. npm runs the `prepare` script automatically on git-source installs, but `package.json` had none — so npm completed the clone, found no `bin` target, silently cleaned up the tmp clone, and the global symlink ended up pointing at a now-deleted path.

  Fix: added `"prepare": "tsc && chmod +x dist/index.js"` to `package.json` `scripts`. Git-source installs now build automatically. Registry installs (`npm install -g @oomkapwn/enquire-mcp`) were unaffected — the npm tarball already ships `dist/`.

  Reported by an early user. Thank you 🙏

### CI
- v0.8.1 is the first release published via the new `.github/workflows/release.yml` workflow — `npm publish --provenance` runs in CI on `v*` tag push, no manual `npm publish` needed. The published package now carries the npm "Published with provenance" trust badge.

## [0.8.0] — 2026-05-03

Closes the v0.8 backlog from the post-launch audit pass: one DQL semantic correction, four P0 test gaps, and the standard Code of Conduct.

### Changed (potentially breaking — semver-minor on 0.x is fine)
- **DQL `contains` for arrays is now exact-membership, not substring**: `WHERE file.tags contains "core"` no longer falsely matches a `core-team` tag. Strings keep substring semantics (e.g. `WHERE title contains "draft"` still works as before). The previous behavior was a v0.7.x correctness bug that diverged from the Dataview convention this query language emulates. If you relied on substring matching against array elements, switch to `like` with explicit wildcards (e.g. `tags like "*core*"`).

### Added (test coverage for previously-implicit behavior)
- **Empty `[[]]` wikilink** — locked in as "produces no link" (whereas `[[ ]]` with one space is still a link target, surfaced to the user).
- **UTF-8 BOM-prefixed files** — confirmed they parse correctly through `gray-matter`.
- **`createNote` file mode** — verified files are created with reasonable permissions (read+write to owner, no exec bits).
- **DQL `!=` against missing fields** — confirmed absent fields evaluate as "not equal" to any compared value (Dataview-compatible).

### Added
- **`CODE_OF_CONDUCT.md`** based on Contributor Covenant 2.1. Brings the GitHub community profile to 100%.

### Tests
- 156 unit tests (was 150). 6 new regression tests covering all four P0 audit gaps + the DQL contains semantics change (2 tests).

## [0.7.6] — 2026-05-03

Audit-pass cleanup: two real correctness bugs in write-mode + DQL, plus a privacy guarantee tightening and a few P3/P4 polishes.

### Fixed
- **P2 — `obsidian_create_note` could corrupt YAML frontmatter**: the hand-rolled YAML renderer in `tools.ts` quoted only a narrow set of special chars, so date-like strings (`"2026-05-03"`), values starting with `!`/`>`/`@`, and values containing `|` either round-tripped as the wrong type (timestamp instead of string) or produced YAML that `gray-matter` couldn't parse back. Replaced with `gray-matter`'s `stringify` (backed by `js-yaml`) — every YAML edge case is now correctly handled. Two regression tests added (`tests/write.test.ts`).
- **P2 — DQL parser collapsed whitespace inside quoted strings**: `parseDql` did a global `.replace(/\s+/g, " ")` *before* the quote-aware tokenizer ran. Folder names like `"Two  Spaces"` and frontmatter values like `"in  progress"` silently lost their repeated whitespace and failed to match. Removed the global collapse — `splitClauses` is already quote-aware and handles separator whitespace correctly. Three regression tests added (`tests/dql.test.ts`).
- **P3 — Persistent-cache directory mode could be looser than `0700`**: `fs.mkdir({ mode: 0o700 })` only applies on creation. If the cache parent directory already existed with looser perms (custom `--cache-file` path, or pre-existing XDG dir), the README/SECURITY.md `0700` guarantee was unenforced. Added a follow-up `chmod(dir, 0o700)`.
- **P4 — DQL `LIMIT` accepted floats**: `LIMIT 1.5` silently truncated to `1`. Now requires `Number.isInteger(n)`.

### Tests
- 150 unit tests (was 142). 8 new regression tests covering the YAML, DQL whitespace, and LIMIT edge cases.

### Docs / assets
- Social preview banner: `140 tests` → `142 tests` (also matches v0.7.5 baseline; the v0.7.6 PNG re-render reflects 142 since that's what the v0.7.5 published baseline showed). README badge already at 142.

## [0.7.5] — 2026-05-03

**Critical hotfix** — v0.7.4 (and likely all earlier published versions) had a CLI guard that compared `import.meta.url` (resolved through realpath) against `process.argv[1]` (raw, no symlink resolution). When npm installs the package, the `bin` entry is exposed as a symlink in `node_modules/.bin/`, and on macOS `/tmp` is itself a symlink to `/private/tmp` — so the comparison failed and `main()` never ran. The CLI exited 0 with no output, making `npx -y @oomkapwn/enquire-mcp serve …` a no-op.

### Fixed
- `src/index.ts` `isCliEntry` check now `realpathSync`s both sides of the comparison. Tested via two regression cases in `tests/cli.test.ts`: (1) explicit symlink mimicking the npm bin shim, (2) macOS `/tmp` indirection.

### Tests
- 142 unit tests (was 140). 2 new regression tests for the CLI guard.

### Mitigation for users on 0.7.4
- v0.7.4 has been deprecated on npm with a redirect message. `npx -y @oomkapwn/enquire-mcp@latest …` automatically picks up 0.7.5.

## [0.7.4] — 2026-05-03

Repeat-audit pass — five public-facing inconsistencies closed.

### Packaging
- Regenerated `package-lock.json`. The lockfile root still claimed `@oomkapwn/obsidian-mcp@0.4.0` with `node>=18` and bin `obsidian-mcp` — pre-rename identity. Now correctly reflects `@oomkapwn/enquire-mcp@0.7.4`, `node>=20`, bin `enquire-mcp`. No dependency-tree changes.

### Docs
- README "Support the project" links now use absolute GitHub URLs (`https://github.com/oomkapwn/enquire-mcp/issues/new?template=...`) instead of relative `./.github/...` paths that would 404 when the README is rendered on npmjs.com.
- `docs/api.md` "Phase 3 (planned)" section renamed to "Roadmap" and rewritten — it claimed persistent cache and write tools were future work, but both shipped in v0.6.0 / v0.3.0 respectively. Now lists actual remaining items (cross-vault index, full DQL, rename/move tools, graph queries).
- `.github/ISSUE_TEMPLATE/bug_report.yml` version placeholder bumped from `0.7.1` to neutral `0.7.x` so it doesn't drift again next release.
- Social preview banner updated: `137 tests` → `140 tests`. Both SVG and rendered PNG refreshed.

### Security
- **P1 — Symlink-overwrite via `obsidian_create_note` with `overwrite=true`**: if a path inside the vault was a symlink whose target lived outside the vault, `fs.writeFile(abs, ...)` followed the link and overwrote the outside file. The existing `assertParentInsideVault` only protected parent directories; the leaf target was unchecked. Fix: `writeNote` now `lstat`s the target before writing and refuses if it's a symlink. The `overwrite=false` path was unaffected (a dangling symlink-to-missing-target presents as `not exists` to `fs.stat`, but `lstat` catches it explicitly). Regression test added.

### Packaging
- Added `assets/social-preview.png` to the `files` list in `package.json`. Without it, the README hero image rendered broken on npmjs.com — the file was referenced but not shipped. Tarball grew from ~58 kB → ~214 kB (the PNG is 159 kB).

### Repo hygiene
- Added `.claude/` to `.gitignore`.

### Tests
- 140 unit tests (was 139).

## [0.7.2] — 2026-05-03

### Security
- **P1 — Cache pollution via path traversal**: a crafted persistent-cache file with a `relPath` like `../../../etc/hosts` could pollute the in-memory cache with content keyed by paths outside the vault root. The orphaned entry was never *served* via tools (`resolveSafePath` blocks reads to out-of-vault paths), but it would persist back to the on-disk cache file on the next save, perpetuating the pollution. Fix: `loadDiskCache` now validates the resolved abs path stays inside the vault (relative-path check + `realpath` belt-and-braces). Two regression tests added (relative `../` traversal and absolute paths).

### MCP-spec correctness
- **Write tool annotations**: `obsidian_create_note` (which can overwrite irreversibly with `overwrite=true`) and `obsidian_append_to_note` (which mutates persistent state) were both annotated `destructiveHint: false`. Per MCP spec, `destructiveHint: true` is the right hint for tools that may make non-undoable changes. Updated. Read tools remain `destructiveHint` unset / `readOnlyHint: true`.

### Cleanup
- Dead conditional in `likeToRegex`: simplified `next === "*" || next === "\\" ? \`\\${next}\` : \`\\${next}\`` to its always-equal RHS. No behavior change.
- README coverage badge drifted from 83% → actual 82% lines (slight churn after persistent-cache code added). Refreshed badge and the per-percent breakdown.

### Docs
- README gains a "Support the project" section (star CTA + bug-report / feature-request / PR / Discussions pointers) and the ENQUIRE/Berners-Lee origin moved into the credits as a one-paragraph close.

### Tests
- 139 unit tests (was 137). 2 new regression tests for cache path-traversal (relative `..` escape and absolute path).

## [0.7.1] — 2026-05-03

**Second rename: `memex` → `enquire-mcp`.**

### Why a second rename
After v0.7.0 shipped under «memex», a deeper landscape audit revealed the `memex` namespace is even more contested than `obsidian-mcp`:
- **[WorldBrain Memex](https://github.com/WorldBrain/Memex)** — established browser extension with an explicit **memex-obsidian** plugin. Direct user-confusion risk.
- **[iamtouchskyer/memex](https://github.com/iamtouchskyer/memex)** (npm `@touchskyer/memex`) — Zettelkasten persistent memory for AI coding agents. Same client list (Claude Code / Cursor / Codex / Windsurf), same MCP positioning. Functionally near-identical.
- **[memex.tech](https://memex.tech/)** — commercial product with active MCP launch.
- **[memex.ai](https://memex.ai/)** — commercial brand.
- **[`memex-ai`](https://www.npmjs.com/package/memex-ai)** npm package: «Install the Memex AI MCP server for Claude Code and Claude Desktop». Tight collision.
- Plus `memex-md`, `@ai2070/memex`, `memex-cc`, `memex-vault` (Obsidian template), `memex-life/memex`, `memex-lab/memex`, etc.

We traded one crowded namespace for an even more crowded one. Time to commit to a name with a unique historical referent and minimal commercial collision.

### Why ENQUIRE
[**ENQUIRE**](https://en.wikipedia.org/wiki/ENQUIRE) is the program Tim Berners-Lee wrote at CERN in 1980 to track «the complex web of relationships between people, programs, machines and ideas». It was the **direct prototype of the World Wide Web** — cards with hyperlinked relationships, exactly the data model we expose to AI agents over MCP. Bush's memex was theoretical; ENQUIRE was real, working hypertext software. No commercial trademark holder. Available on npm with `-mcp` suffix and across all relevant places.

### Renamed
- npm package: `@oomkapwn/memex` → `@oomkapwn/enquire-mcp`
- CLI binary: `memex-mcp` → `enquire-mcp`
- GitHub repo: `oomkapwn/memex` → `oomkapwn/enquire-mcp`
- MCP server `name` reported in handshake: `memex` → `enquire`
- Boot stderr message: `memex <v> ready` → `enquire <v> ready`
- Default cache dir: `~/Library/Caches/memex/` → `~/Library/Caches/enquire/`
- Banner redesigned: «enquire» as brand, «MCP server for Obsidian vaults» subtitle in cyan, Berners-Lee tagline.
- README hero rewritten with the ENQUIRE narrative + Wikipedia link to ENQUIRE.

### Tool names: still unchanged
`obsidian_*` tool names (`obsidian_list_notes`, etc.) **remain `obsidian_`-prefixed** by design. The prefix tells the LLM what domain it's operating in.

### Disclaimer reaffirmed
README and SECURITY.md still carry the «Not affiliated with Obsidian.md» notice. Added clarification that the «enquire» name is a tribute to Berners-Lee's 1980 system, not a trademark claim.

### Tests
Still 137 unit tests, all green. No code changes — pure rename + docs.

## [0.7.0] — 2026-05-03

**First rename: `obsidian-mcp` → `memex`.**

### Why the rename
- The npm/GitHub `obsidian-mcp` namespace turned out to be crowded — at least 12 GitHub projects and 4 npm packages with overlapping names. We're indistinguishable in search.
- Trademark risk: `bitbonsai/mcpvault` was forced-renamed by Obsidian.md in March 2026, even though it didn't contain "obsidian" in the name. Anything with "obsidian" in the package name is exposed.
- The new name (`memex`) is a nod to Vannevar Bush's 1945 essay [As We May Think](https://en.wikipedia.org/wiki/Memex) — the original vision of a personal knowledge system. Resonates with the PKM / second-brain audience without leaning on Obsidian's brand.
- Obsidian-MCP discoverability is preserved via npm description, GitHub topics, README hero subtitle ("MCP server for Obsidian vaults"), and SVG banner — not via the package name.

### Renamed
- npm package: `@oomkapwn/obsidian-mcp` → `@oomkapwn/memex`
- CLI binary: `obsidian-mcp` → `memex-mcp`
- GitHub repo: `oomkapwn/obsidian-mcp` → `oomkapwn/memex`
- MCP server `name` reported in handshake: `obsidian-mcp` → `memex`
- Boot stderr message: `obsidian-mcp <v> ready` → `memex <v> ready`
- Default cache dir: `~/Library/Caches/obsidian-mcp/` → `~/Library/Caches/memex/`

### Tool names: unchanged
All `obsidian_*` tool names (`obsidian_list_notes`, `obsidian_read_note`, etc.) **remain `obsidian_`-prefixed** by design. The prefix tells the LLM what domain it's operating in. We are an MCP server that operates on Obsidian vaults; the tools should advertise that.

### Disclaimer added
Explicit "Not affiliated with Obsidian.md" notice in README and SECURITY.md. Obsidian and the Obsidian logo are trademarks of Dynalist Inc.

### Bundled fixes

**Cleanups carried into this release:**
- **DQL `LIKE` regex bug**: `\*` (escaped literal asterisk) used to compile to `^\\*$` — a regex matching "any number of literal backslashes" — instead of matching a literal `*`. Rewrote `likeToRegex` as a single-pass walker so escaping is unambiguous.
- **Disk cache load: parallelized stats**: `loadDiskCache` now does `Promise.all` over all entry-stat checks instead of awaiting them one at a time.
- **Disk cache size guard**: refuses to load or save cache files exceeding 50 MB by default (configurable via `maxDiskCacheBytes`).
- **Disk cache per-entry validation**: rejects entries whose `content` exceeds `maxFileBytes`, whose `relPath` isn't a string, or whose `mtimeMs` isn't a number.
- **`beforeExit` flush race**: guarded by a `saved` flag so flush completion doesn't trigger recursive `beforeExit`. Signal handlers use `process.once`.

**Audit findings closed:**
- **Persistent cache size-limit bypass**: `loadDiskCache` filters oversized entries from the in-memory cache load.
- **Persistent cache privacy**: cache file is now written with mode `0600` and parent directory `0700`. Documented explicitly in [README "Cache & privacy"](./README.md#cache--privacy) and [SECURITY.md](./SECURITY.md). Added test for file mode.
- **Deleted-note content lingers in cache**: when `loadDiskCache` skips entries because the source file was deleted (or is mtime-stale, or oversized), the cache is now marked dirty. Next save writes a clean file without those entries. Added test for deleted-note purge.
- **`clear-cache` CLI subcommand**: `enquire-mcp clear-cache --vault <path>` deletes the persistent-cache file. Returns 0 even if no file exists.
- **Node 18 incompatibility**: `commander` 14 and `vitest` 4 (shipped in v0.3.3) require Node ≥ 20. Bumped `engines.node` to `>=20`, dropped Node 18 from CI matrix (now `[20, 22, 24]`), updated README badge.
- **DQL malformed `OR` / `FROM #` accepted as match-all**: `parseWhere` now rejects empty `OR` / `AND` groups (trailing-OR, duplicated-OR-OR, trailing-AND, etc.) with `DqlParseError`. `parseSource` rejects `FROM ""` and `FROM #` with no tag name. 5 regression tests added.
- **Stale `obsidian_dataview_query` description**: tool description still claimed "no OR" — updated to reflect `AND`/`OR`, `=`/`!=`/`contains`/`like` operators, and the actual unsupported list (`FLATTEN`/`GROUP BY`/parens).
- **README stale references** (`119 unit tests`, `0.3.x current`, "no OR" FAQ) refreshed.

### Tests
- 137 unit tests (was 119). New since v0.6.0:
  - Cache mode `0600` enforced on save
  - Deleted-note entries purged on next save after load
  - `clearDiskCache` integration
  - Oversized cached content rejected on load
  - DQL: `FROM #` rejected (audit P2-4)
  - DQL: `FROM ""` rejected
  - DQL: trailing `OR` rejected
  - DQL: trailing `AND` rejected
  - DQL: `OR OR` (empty middle group) rejected
  - DQL: `LIKE` with regex specials (`a.b` is literal)
  - DQL: `LIKE` with `\*` matches literal asterisk

## [0.6.0] — 2026-05-02

Adds an opt-in persistent on-disk cache for warm cold-starts on large vaults.

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

### Skipped: chokidar-based watch mode
- Decided to skip for now. The current mtime-on-read check is correct and cheap (one `fs.stat` per read), and chokidar adds ~50KB of dep weight without measurable user-facing benefit at our vault sizes. Will revisit in v0.7+ if a benchmark says otherwise.

### Tests
- 126 unit tests (was 119). 7 new for persistent-cache: opt-in default-off, write-then-read round-trip, mtime invalidation, vault-root rejection, version mismatch rejection, corrupt-file graceful fallback, and cache file write atomicity.

## [0.5.0] — 2026-05-02

Stricter TypeScript, lint/format with Biome, and DQL gains `OR` + `LIKE`.

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

Two new vault-introspection tools, three new workflow prompts, and CI-driven coverage.

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
