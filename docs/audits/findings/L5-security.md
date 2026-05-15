# L5 — Security (v3.6.0 audit)

**Scope**: CodeQL, Dependabot, npm audit, SLSA-3 provenance, bearer auth, path traversal, privacy filters, cache permissions.
**Auditor**: sub-agent C5.
**Date**: 2026-05-15.
**Repo**: `oomkapwn/enquire-mcp` (local folder name is `obsidian-mcp`, project name is `enquire-mcp`).
**Branch**: `v3.6.0/post-stable-audit`.
**Baseline package**: `@oomkapwn/enquire-mcp@3.6.0` (published 2026-05-15).

## Summary

The security posture is strong. Every external check is clean: 0 open CodeQL alerts, 0 open Dependabot alerts, 0 npm-audit findings at every audit level (`--audit-level=low/moderate/high` × dev/prod). SLSA-3 provenance attestation IS emitted for v3.6.0. Bearer auth uses `crypto.timingSafeEqual` after hashing both sides, no naive `===` comparison. CORS implementation explicitly defends against the `js/cors-misconfiguration-for-credentials` class. Path traversal goes through `vault.resolveSafePath()` with `fs.realpath` checks on every read/write; symlink-escape rejected at both parent-dir and leaf-target. Privacy filters (`--exclude-glob` / `--read-paths`) applied at 11+ surfaces: listMarkdown, listFilesByExtension, resolveSafePath, writeNote, renameFile, watcher (chokidar `ignored` predicate), text search post-filter, chunk resource gate, FTS5 hybrid post-filter, embeddings post-filter, replace_in_notes folder check. Cache files (.embed.db, .fts5.db, persistent-note-cache) consistently chmod 0600 with 0700 parent dirs.

The findings below cluster into 3 classes, all defense-in-depth (no exploitable issues):

1. **L5-01 (Medium)** — HNSW persistence files (`.hnsw.bin` + `.hnsw.meta.json`) are written without explicit 0600 chmod, defaulting to 0644 (umask-modified). The `.meta.json` contains note path + text-preview snippets. Parent dir is implicitly 0700 (shared with `.embed.db`'s open path), but the files themselves break the pattern set by `embed-db.ts`, `fts5.ts`, and `vault.ts`.
2. **L5-02 (Medium)** — `enquire-mcp setup` and `enquire-mcp index` CLI commands instantiate `Vault` WITHOUT `excludeGlobs` / `readPaths`, while `serve` and `build-embeddings` accept those flags. A user who runs `setup --vault foo` then later runs `serve --exclude-glob` ends up with FTS5 chunks for excluded paths persisted on disk in the `.fts5.db`. Runtime search filters those out via `vault.isExcluded()`, so an LLM never receives them — but at-rest content of excluded paths lives in the index file, contrary to the SECURITY.md "denylist" expectation.
3. **L5-03 (Info)** — 5 dismissed CodeQL alerts (`js/polynomial-redos` #5, #6, #8, #9, #10) all share the same dismissed_comment template. Code at the cited lines is unchanged since dismissal (2026-05-13); inline reasoning still holds (anchored `$` regex on single char class, strictly linear). No action needed; called out only for traceability.

No Critical / High findings. No exploitable issues. Both Mediums are defense-in-depth — they don't expose excluded content over the wire, they just leave artifacts on disk with weaker permissions or in caches the user expected to be empty.

---

## Scope-item-by-scope-item verification

### 1. CodeQL alerts

`gh api repos/oomkapwn/enquire-mcp/code-scanning/alerts --jq '[.[] | select(.state == "open")] | length'` → **0**.

5 dismissed alerts, all `js/polynomial-redos`, all with the same template comment:
> Anchored-$ regex on single char class — strictly linear (O(n) worst case, no backtracking branch). Same class as v3.5.8 chunker.ts/bases.ts dismissals. See inline comments in src for per-site reasoning.

| # | Path | Line | Pattern | Dismissed at | Inline comment still present? |
|---|------|------|---------|--------------|-------------------------------|
| 5 | `src/embed-db.ts` | 407 | `/\/+$/` (folder-prefix trim) | 2026-05-13 | Yes — `src/embed-db.ts:403-406` |
| 6 | `src/fts5.ts` | 377 | `/\/+$/` (folder-prefix trim) | 2026-05-13 | Yes — `src/fts5.ts:373-376` |
| 8 | `src/fts5.ts` | 596 | `/^(#{1,6})\s+(.+)$/` (heading parse) | 2026-05-13 | Yes — `src/fts5.ts:591-595` |
| 9 | `src/fts5.ts` | 599 | `/\s+$/` (heading trim) | 2026-05-13 | Yes — `src/fts5.ts:591-595` |
| 10 | `src/fts5.ts` | 599 | `/#+$/` (heading trim) | 2026-05-13 | Yes — `src/fts5.ts:591-595` |

`git log --since="2026-05-13" -- src/embed-db.ts src/fts5.ts` returns no commits. Dismissed reasoning is still accurate.

### 2. Dependabot alerts

`gh api repos/oomkapwn/enquire-mcp/dependabot/alerts --jq '[.[] | select(.state == "open")] | length'` → **0**.

Upgrade policy in `.github/dependabot.yml`:
- Weekly cadence, Monday 06:00 Moscow time.
- Open-PR limit: 5 (npm) + 3 (gh-actions).
- Groups dev-deps (minor/patch) and runtime-patches separately — no auto-merge configured (PRs require human review).
- Production major bumps land as individual PRs (not grouped), so risky upgrades get individual scrutiny.

Upgrade policy is reasonable; no auto-merge means the human-review gate is intact.

### 3. npm audit

| Command | Result |
|---------|--------|
| `npm audit --omit=dev --audit-level=moderate` | `found 0 vulnerabilities` |
| `npm audit --include=dev --audit-level=high` | `found 0 vulnerabilities` |
| `npm audit --include=dev` (low) | `found 0 vulnerabilities` |

Zero findings at every level — the dependency tree is clean.

### 4. SLSA-3 provenance

`npm view @oomkapwn/enquire-mcp@latest --json | jq '.dist'` returns:
```json
{
  "attestations": {
    "url": "https://registry.npmjs.org/-/npm/v1/attestations/@oomkapwn%2fenquire-mcp@3.6.0",
    "provenance": { "predicateType": "https://slsa.dev/provenance/v1" }
  },
  "signatures": [
    { "keyid": "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", ... }
  ]
}
```

`.attestations.provenance.predicateType` is `slsa.dev/provenance/v1` — full SLSA-3 provenance attached. Same for `@oomkapwn/enquire-mcp@3.6.0` exact version.

Release workflow (`.github/workflows/release.yml:14-16`) declares `id-token: write` permission; publish step (line 117) uses `npm publish --provenance --access public`. Confirmed.

### 5. Bearer auth — constant-time comparison

`grep -n 'timingSafeEqual\|=== bearerToken\|===.*token' src/http-transport.ts`:

- Line 31: `import { createHash, randomBytes, timingSafeEqual } from "node:crypto";`
- Line 161: `const expectedHash = createHash("sha256").update(expectedToken).digest();`
- Line 162: `const presentedHash = createHash("sha256").update(presented).digest();`
- Line 163: `if (!timingSafeEqual(expectedHash, presentedHash)) return null;`

`verifyBearer()` (`src/http-transport.ts:154-167`) hashes both sides to fixed-length SHA-256 buffers before `timingSafeEqual`, defeating length-leak side channels. Token validation is constant-time. No naive `===` comparison anywhere in the file (only `=== null` for the verifyBearer return value, line 358).

Generation: `generateBearerToken()` (line 582) → `randomBytes(32).toString("base64url")` → ~43 char base64url, CSPRNG. Startup gate (line 591): rejects `bearerToken < 16 chars`.

### 6. Path traversal — realpath checks

Every Vault file operation routes through one of two entry points:

- **`Vault.resolveInside(p)`** (`src/vault.ts:292-299`) — pure lexical check (`path.relative` rejects `..` or absolute escapes). Used for non-existent-file paths (writes to new files).
- **`Vault.resolveSafePath(relOrAbs)`** (`src/vault.ts:573-610`) — realpath-after-resolve, rejects if resolved path escapes vault root; also enforces `isExcluded`.

Direct `fs.readFile` / `fs.writeFile` outside `vault.ts`:

```
src/eval.ts:145          fs.readFile(file, "utf8")    # user-supplied JSONL, CLI-only diagnostic tool
src/hnsw.ts:309          fs.writeFile(metaFile, ...)   # HNSW persistence (see L5-01)
src/hnsw.ts:337          fs.readFile(metaFile, "utf8") # HNSW load (own cache file)
src/periodic.ts:64       fs.readFile(dailyJsonPath)    # .obsidian/daily-notes.json — gated by isExcluded
src/periodic.ts:84       fs.readFile(periodicJsonPath) # .obsidian/plugins/periodic-notes/data.json — gated
```

`eval.ts:145` — CLI-only `enquire eval` diagnostic; reads a user-supplied JSONL path. Not user-controllable via MCP. Not a concern.
`hnsw.ts:309/337` — owns the HNSW sidecar files at known-good paths (`<embedDir>/<vaultname>.hnsw.bin` + `.meta.json`); not influenced by note content. See L5-01 for chmod.
`periodic.ts:64/84` — both calls gated by an `isExcluded` predicate (`src/periodic.ts:62`, `src/periodic.ts:80`); both target fixed `.obsidian/...` paths that can't be redirected.

Symlink-escape protection: `Vault.assertParentInsideVault` (`src/vault.ts:446-459`) walks parent chain with `fs.realpath`, refuses writes if any parent resolves outside. Leaf-target symlinks rejected explicitly (`src/vault.ts:431-434`). Walker `followSymlinks: false`.

Path traversal class fully defended.

### 7. Privacy filters

`--exclude-glob` and `--read-paths` are applied at the following surfaces (file:line citations):

| Surface | Function | File:line | Notes |
|---|---|---|---|
| 1 | Vault `listMarkdown` | `src/vault.ts:321-323` | Post-walk filter. Also gates folder-arg via `isExcluded(rel)` on line 313 |
| 2 | Vault `listFilesByExtension` | `src/vault.ts:344-346` | Same pattern as listMarkdown, also gates folder-arg (line 340) |
| 3 | Vault `resolveSafePath` (read path) | `src/vault.ts:598-604` | Refuses with allowlist-vs-denylist distinction in error message |
| 4 | Vault `writeNote` | `src/vault.ts:412-418` | Pre-write enforcement (P0 fix from v2.0.0-beta.1); both allowlist + denylist |
| 5 | Vault `renameFile` (target) | `src/vault.ts:481-485` | Same predicate as writeNote |
| 6 | `VaultWatcher.start` (chokidar predicate) | `src/watcher.ts:54-58` | Watcher never sees writes to excluded files (no FTS5 reindex trigger, no cache invalidation reveal) |
| 7 | `tool-registry.ts` text-search results | `src/tool-registry.ts:104` | Post-filter on `searchText`-style hits |
| 8 | `tool-registry.ts` chunk resource | `src/tool-registry.ts:1188` | "Chunk not found" framing matches the not-found branch — attacker can't distinguish |
| 9 | `tools/search.ts` `embeddingsSearch` | `src/tools/search.ts:908` | Post-filter on embed-cosine hits + HNSW results |
| 10 | `tools/search.ts` `searchHybrid` FTS5 leg | `src/tools/search.ts:1151` | Filters BM25 hits before RRF fusion — stale entries from pre-flag indexes blocked |
| 11 | `tools/write.ts` `replace_in_notes` folder | `src/tools/write.ts:577-582` | Tests both `<folder>` and `<folder>/_probe.md` to handle `**`-glob semantics |
| 12 | `periodic.ts` config loader | `src/periodic.ts:62, 80` | `.obsidian/daily-notes.json` and `.obsidian/plugins/periodic-notes/data.json` both gated |

**Trace 1 — FTS5 indexing**: `syncFtsIndex` (`src/server.ts:678`) calls `vault.listMarkdown()` which filters via `isExcluded` at `src/vault.ts:322`. Indexed entries never include excluded paths (at build time, with privacy flags wired through the relevant Vault constructor).

**Trace 2 — Embeddings build**: `syncEmbedDb` (`src/server.ts:567`) calls `vault.listMarkdown()` — same filter point. Chunker (`chunkContent` in `src/fts5.ts:502`) receives only already-vetted content; no separate filter needed.

**Trace 3 — Hybrid search at query time**: `searchHybrid` (`src/tools/search.ts`) calls FTS5 + TF-IDF + embeddings; each leg filters via `vault.isExcluded()` (line 1151 + line 908 + via TF-IDF's `buildTfidfIndex` which uses `vault.listMarkdown`). Plus, even if `.fts5.db` contained stale excluded entries from a pre-flag setup, the runtime filter strips them before RRF fusion. Defense-in-depth holds.

**Trace 4 — TF-IDF**: `buildTfidfIndex` (`src/tools/search.ts:484-487`) uses `vault.listMarkdown()` directly; index built only from non-excluded files. Per-query post-filter not needed because the index never contained them.

**Trace 5 — Tool resources (chunk URI)**: `tool-registry.ts:1188` blocks `enquire://chunk/...` URIs for excluded paths, even if those URIs were issued earlier in the session when no exclude flag was active.

Privacy filter coverage is complete at every code path I traced. See L5-02 for an at-rest-only concern around `setup` / `index` CLI commands.

### 8. Cache permissions

Cache files (verified):

| File | chmod 0600 | Parent dir chmod 0700 | Source |
|---|---|---|---|
| `.embed.db` + `-wal` + `-shm` | Yes | Yes | `src/embed-db.ts:210, 211, 217` |
| `.fts5.db` + `-wal` + `-shm` | Yes | Yes | `src/fts5.ts:125, 126, 135` |
| Persistent note cache (JSON) | Yes (0600 on write + chmod) | Yes (0700 on mkdir + chmod) | `src/vault.ts:277, 282, 285, 288` |
| `.hnsw.bin` (binary index) | **No (defaults to 0644 via umask)** | Implicit 0700 (shares dir with `.embed.db` if EmbedDb opened first) | `src/hnsw.ts:300` (no chmod) |
| `.hnsw.meta.json` (path + text-preview rows) | **No (defaults to 0644 via umask)** | Same as above | `src/hnsw.ts:309` (no chmod) |

See L5-01 for the HNSW chmod gap.

---

## Findings detail

### Finding L5-01 (Medium)

**File**: `src/hnsw.ts:289-312` (`saveTo` method, the inner of `wrapNativeIndex`).
**Class**: Cache-file permission drift — sidecar files written via `fs.writeFile` or native libs without an explicit `mode` argument or post-write `chmod`. The strict 0600/0700 invariant enforced in `embed-db.ts`, `fts5.ts`, and `vault.ts` is broken at the HNSW persistence path.
**Severity**: Medium (defense-in-depth — files live in a 0700 parent dir created by `EmbedDb.open()`, so a sibling user can't traverse in unless they were granted access at the parent level. But the SECURITY.md "0600 cache" guarantee doesn't apply to HNSW sidecar files, and a fresh HNSW save creates files under the user's umask, which on shared / NFS / corporate-image systems can be 0664 or 0644).

**Description**: When the HNSW index is persisted, the workflow is:

```ts
// src/hnsw.ts:289-310
async saveTo(file, rowsByLabel, signature): Promise<boolean> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(file), { recursive: true });   // ← no mode: 0o700
  const binFile = `${file}.bin`;
  const metaFile = `${file}.meta.json`;
  await ctor.writeIndex(binFile);                            // ← native lib write, no chmod after
  const meta: HnswPersistedMeta = { ... };
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8"); // ← no mode option, no chmod after
  return true;
}
```

The `.hnsw.meta.json` payload includes (`src/hnsw.ts:82-92`):
- `rel_path` (vault-relative path to every chunk)
- `text_preview` (note-content snippet, up to 480 chars per chunk)
- `chunk_index`, `line_start`, `line_end`, `kind`

This is the same class of sensitive metadata that `.embed.db` and `.fts5.db` already protect with 0600. The HNSW sidecar leaks it under a more permissive default mode.

Mitigating factor: HNSW files are written to `<embedDir>/<vaultname>.hnsw.{bin,meta.json}`, and `embedDir` is set to 0700 by `EmbedDb.connect()` at `src/embed-db.ts:210-211`. So in practice, file mode 0644 is overridden by the parent dir's 0700 — a sibling user can't `cd` in to read them. BUT: (a) defense-in-depth wants both layers, (b) `saveTo` is also called when the user has not run `EmbedDb.open()` for this exact dir before (parent might not exist), (c) some filesystems (NFS, FAT-on-USB) ignore Unix mode bits — the parent-dir guarantee evaporates.

**Class**: Same-class instances of "writes cache file without explicit chmod":
- `src/hnsw.ts:295` `fs.mkdir` — missing `mode: 0o700` (other call-sites set it: `src/embed-db.ts:210`, `src/fts5.ts:125`, `src/vault.ts:277`).
- `src/hnsw.ts:300` `ctor.writeIndex(binFile)` — native lib write, no post-write `chmod`.
- `src/hnsw.ts:309` `fs.writeFile(metaFile, ...)` — no `mode` option in the third arg, no post-write `chmod`.

**Class fix**:
1. In `src/hnsw.ts:saveTo`, mirror the pattern from `src/embed-db.ts:207-219`:
   ```ts
   await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
   await fs.chmod(path.dirname(file), 0o700).catch(() => {});
   await ctor.writeIndex(binFile);
   await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
   await Promise.all([binFile, metaFile].map((p) => fs.chmod(p, 0o600).catch(() => {})));
   ```
2. Add a test in `tests/hnsw.test.ts` (if it exists) or a new test that asserts mode bits after `saveTo`. See `tests/embed-db.test.ts` for the pattern (assertions on `stat.mode & 0o777`).
3. Document the chmod-on-cache invariant in `CLAUDE.md` or a new `docs/internals/cache-permissions.md` so future cache-file additions get audited.

**Backfill**: Single instance; the fix above resolves L5-01.

**Recommendation**: Ship in v3.6.1. Low complexity, no behavior change for the common case.

---

### Finding L5-02 (Medium)

**File**: `src/cli.ts:298` (`enquire-mcp index` command), `src/cli.ts:487` (`enquire-mcp setup` command).
**Class**: CLI-flag drift — privacy flags (`--exclude-glob` / `--read-paths`) accepted by `serve`, `serve-http`, and `build-embeddings`, but NOT by `setup` and `index`. A user who runs `setup --vault foo` (the documented "zero-touch onboarding" path) gets a `.fts5.db` containing chunks of every file in their vault, including any path they later want to mark private.

**Severity**: Medium (the runtime filter at `tools/search.ts:1151` strips excluded paths from search results, so an LLM never receives them — but at-rest content of supposedly-private notes lives in `.fts5.db` and `.embed.db` with 0600 perms, contrary to the SECURITY.md "privacy filter at indexing time" guarantee).

**Description**: 

```ts
// src/cli.ts:298 — `index` subcommand
const vault = new Vault(opts.vault);          // no excludeGlobs, no readPaths
```

```ts
// src/cli.ts:487 — `setup` subcommand
const v = new Vault(opts.vault);              // no excludeGlobs, no readPaths
```

Compare to:

```ts
// src/cli.ts:384 — `build-embeddings` (has flags)
const vault = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
```

```ts
// src/cli.ts:57-62 — `serve` accepts these flags
program.option("--exclude-glob <pattern...>", "...");
program.option("--read-paths <pattern...>", "...");
```

So the CLI surface is inconsistent: `serve` + `build-embeddings` honor privacy, `setup` + `index` don't.

Practical attack scenario: User runs `enquire-mcp setup --vault ~/Notes` (recommended in README QUICKSTART). Cold-built `.fts5.db` and `.embed.db` now contain every file. User then writes a script that runs `enquire-mcp serve --vault ~/Notes --exclude-glob '02_Private/**'`. At runtime, search results are filtered. But:
1. Any other process that opens the `.fts5.db` directly (a SQLite client, a `sqlite3` shell, the `enquire-mcp dump-index` command if one exists, leaked backup) sees all the private chunks.
2. If the user later removes the `--exclude-glob` flag, the index already has the private chunks — no rebuild needed for them to surface.
3. SECURITY.md section `--read-paths: strict-allowlist posture` (line 50-59) implies the filter is enforced at every layer, not just runtime.

**Class**: Same-class instances of "Vault constructor not threading user privacy flags":
- `src/cli.ts:266` (`clear-index` — Vault used only for `defaultIndexFile()` path derivation; no file content access). **Not a finding** — just path resolution.
- `src/cli.ts:298` (`index`). **Finding**.
- `src/cli.ts:425` (`clear-embeddings` — same, path-only). **Not a finding**.
- `src/cli.ts:487` (`setup`). **Finding**.
- `src/cli.ts:607` (`eval` — diagnostic / benchmark; query set is explicit). **Not a finding** — eval is intended to exercise the full corpus for retrieval quality measurement.

**Class fix**:
1. Add `--exclude-glob` and `--read-paths` options to both `index` (`src/cli.ts:283-295`) and `setup` (`src/cli.ts:468-485`) commands.
2. Thread them through the `new Vault(...)` constructor at lines 298 and 487 (matching the pattern at `src/cli.ts:384`).
3. Add a guard in `setup` that warns when a user runs `setup` without privacy flags but their `serve` invocations elsewhere DO use them. Alternative: add a `--re-setup-needed` notice on `serve` start when the index mtime predates the privacy flags being introduced. (Low priority — main fix is just threading the flags.)
4. Add a CHANGELOG-tracked invariant: "every CLI command that opens a Vault for indexing must accept `--exclude-glob` and `--read-paths`."
5. Update `docs/QUICKSTART.md` to show `enquire-mcp setup --vault ~/Notes --exclude-glob '02_Private/**'` as the privacy-aware default.

**Backfill**: Two instances (`src/cli.ts:298`, `src/cli.ts:487`). Plus an integration test that runs `enquire-mcp setup --vault tmp --exclude-glob 'Secret/**'` and asserts the `.fts5.db` doesn't contain any rows where `rel_path` matches the exclude glob.

**Recommendation**: Ship in v3.6.1 alongside L5-01. Could be batched as a single "v3.6.1: hardening" release.

---

### Finding L5-03 (Info)

**File**: 5 dismissed CodeQL alerts on `oomkapwn/enquire-mcp/security/code-scanning`.
**Class**: CodeQL `js/polynomial-redos` false positives on anchored `$` regexes over single character classes. Same class as the v3.5.8 `chunker.ts` / `bases.ts` dismissals (referenced in the dismissed_comment template).
**Severity**: Info — no action needed. Captured here so the v3.7+ auditor can confirm at re-audit time that the dismissed_comment template still applies.

**Description**: All 5 alerts dismissed 2026-05-13 by Alex with the same inline-reasoning comment template ("Anchored-$ regex on single char class — strictly linear..."). I verified each alert's cited source line and confirmed:

1. Code at the cited lines is **unchanged** since dismissal — `git log --since="2026-05-13" -- src/embed-db.ts src/fts5.ts` is empty.
2. Each regex has an inline `// CodeQL js/polynomial-redos flags ... false positive...` comment in source pointing readers at the reasoning. Examples: `src/embed-db.ts:403-406`, `src/fts5.ts:373-376`, `src/fts5.ts:591-595`.
3. The regex patterns are all `/\/+$/`, `/\s+$/`, `/#+$/`, `/^(#{1,6})\s+(.+)$/` — all anchored, all character-class greedy with no nested quantifier. Linear-time by construction.

**Class fix**: None — these are working as intended. The class invariant ("any new `$`-anchored regex on a single char class with a `// CodeQL js/polynomial-redos: anchored-$ ...` comment is acceptable; otherwise grep for backtrack-able combinators") should be added to CLAUDE.md for future auditors.

**Backfill**: None.

**Recommendation**: No action. Re-audit at v3.7+ to confirm code lines haven't shifted under the dismissed alerts.

---

## Verification commands (rerunnable)

```bash
# CodeQL state
gh api repos/oomkapwn/enquire-mcp/code-scanning/alerts --jq '[.[] | select(.state == "open")] | length'
gh api repos/oomkapwn/enquire-mcp/code-scanning/alerts --jq '[.[] | select(.state == "dismissed")] | .[] | {number, rule: .rule.id, dismissed_comment, most_recent_instance: .most_recent_instance.location}'

# Dependabot
gh api repos/oomkapwn/enquire-mcp/dependabot/alerts --jq '[.[] | select(.state == "open")] | length'

# npm audit (run from project root)
npm audit --omit=dev --audit-level=moderate
npm audit --include=dev --audit-level=high
npm audit --include=dev   # full

# SLSA provenance
npm view @oomkapwn/enquire-mcp@latest --json | jq '.dist.attestations'

# Bearer auth
grep -n 'timingSafeEqual\|=== bearerToken\|===.*token' src/http-transport.ts

# Path traversal — direct fs calls outside vault.ts
grep -rn 'fs\.readFile\|fs\.writeFile\|fsp\.readFile\|fsp\.writeFile' src/ | grep -v "vault.ts"

# Privacy filter sites
grep -rn 'isExcluded' src/

# Cache file modes
grep -n '0o600\|0o700\|chmod\|mode: 0' src/embed-db.ts src/fts5.ts src/vault.ts src/hnsw.ts
```

---

## Sign-off

- CodeQL: 0 open, 5 dismissed with current reasoning.
- Dependabot: 0 open.
- npm audit: 0 findings at every level.
- SLSA-3: v3.6.0 attestation present, `slsa.dev/provenance/v1` predicate confirmed.
- Bearer auth: constant-time via SHA-256 + `timingSafeEqual`.
- Path traversal: every read/write through `vault.resolveSafePath()` or `vault.resolveInside()`; 5 direct `fs.*` calls outside `vault.ts` reviewed, all benign.
- Privacy filters: 11+ enforcement points traced; 4 distinct code paths cited (FTS5 build, embeddings build, hybrid search, TF-IDF build).
- Cache permissions: 0600 / 0700 enforced for `.embed.db`, `.fts5.db`, persistent-cache; **gap at HNSW sidecar files** (L5-01).
- Privacy flag CLI surface: **inconsistent** — `setup` and `index` don't accept them (L5-02).

No Critical / High. Two Mediums (L5-01, L5-02) shipable in a single v3.6.1 hardening release.
