# Security policy

## Reporting a vulnerability

If you've found a security issue in enquire, **please don't open a public GitHub issue**. Instead:

1. Email the maintainer at `oomkapwn@gmail.com` with the subject `enquire security`.
2. Include a reproducer if you have one — vault layout, exact CLI flags, the operation that triggered the issue.
3. Expect an acknowledgement within 72 hours.

I'll work on a fix in private, cut a patch release, and then publicly disclose with credit (or anonymously, your call).

## Scope

In scope:
- Path traversal, symlink-escape, or any way to read/write files outside the configured vault root
- Resource exhaustion (DoS) via crafted markdown, frontmatter, or DQL input
- Unintended code execution via YAML, regex, or input parsing
- Cache or memory issues that grow unbounded under attacker-controlled input

Out of scope (won't accept reports):
- Behavior controlled by `--enable-write` — yes, write tools can write notes; that's the point. Reports here need to show writes outside the vault or other privilege escalation.
- Issues that require a malicious MCP client (the client is the trusted party; if it's compromised, all bets are off).
- Vulnerabilities in dependencies — please report those upstream first.

## Supported versions

Only the latest minor release receives security patches. We bump the patch version for security fixes and call them out clearly in [CHANGELOG.md](./CHANGELOG.md).

## Hardening already in place

- Realpath-based check on every read and write target — symlinks inside the vault that resolve outside are rejected.
- Walker skips symlinks entirely.
- Default 5 MB cap on any single file read or write (configurable via `--max-file-bytes`). Persistent-cache load enforces the same per-entry cap.
- Bounded parsed-note cache (default 1024 entries, LRU eviction). Persistent cache file is bounded at 50 MB by default.
- Read-only by default; write tools require an explicit CLI flag.
- YAML parsed via `gray-matter` (`js-yaml` safeLoad) — no code execution.
- DQL parser respects quoted strings; no shell, no `eval`, no template expansion. Empty `OR`/`AND` groups and empty `FROM #` / `FROM ""` are rejected to prevent silently-overbroad queries.

## Persistent cache: privacy posture

When `--persistent-cache` is enabled, full note bodies are written to a JSON file under `~/Library/Caches/enquire/` (macOS) or `~/.cache/enquire/` (Linux).

- File mode is **`0600`**, parent directory mode is **`0700`** — restricted to the user account.
- Cache file is rejected if its `root` field doesn't match the current vault realpath (cross-vault protection).
- Cache file is rejected if its declared `version` doesn't match the current schema version.
- Deleted notes: on load, entries whose source file no longer exists are dropped from memory AND the cache is marked dirty so the next save rewrites the file without those entries.
- Manual purge: `enquire-mcp clear-cache --vault <path>` deletes the cache file.
- **Caveat:** anyone with read access to your user account can read the cache file. If your threat model includes other local users on the same machine, do not use `--persistent-cache`.

## `--read-paths`: strict-allowlist posture

`--read-paths` (added v1.6.0) is a **denylist's complement** — when set, ONLY paths matching one of the glob patterns are visible to any tool. Same glob semantics as `--exclude-glob` (`*`, `**`, `?`). Repeatable.

Threat model: an attacker-controlled MCP client tries to read a path the user hasn't whitelisted. Mitigations:

- **`Vault.isExcluded()` enforces both flags.** A path must match the allowlist AND not match any exclude pattern. The same predicate gates `listMarkdown()`, `listFilesByExtension()`, `resolveSafePath()` (so `readNote` / `readBinaryFile` / write paths all respect it).
- **Watcher-aware.** When `--watch` is enabled, file events for paths outside the allowlist are dropped at the chokidar `ignored` predicate — the watcher never even sees writes to private folders.
- **Error-message distinguishes the two filters.** When a tool tries to read a path that's blocked, the error says either `"--read-paths allowlist (path doesn't match any allow-glob)"` or `"--exclude-glob denylist"` — so users can tell which flag rejected the path.
- **No silent degradation.** If `--read-paths` is set and zero paths match, `listMarkdown()` returns `[]` and tools return empty results rather than falling back to "everything is visible."

## v1.5+ read tools: read-only safety

Tools added in v1.5 (`obsidian_lint_wiki`, `obsidian_open_questions`, `obsidian_paper_audit`), v1.6 (`obsidian_find_path`, `obsidian_open_in_ui`), v1.7 (`obsidian_list_canvases`, `obsidian_read_canvas`), and v1.8 (`obsidian_semantic_search`) are all **read-only**. They never call any write path; they only consume the existing parse / wikilink / FTS5 surfaces.

Specific notes:

- **`obsidian_read_canvas`** uses `Vault.readBinaryFile()`, which goes through the same `resolveSafePath()` + `assertSize()` chain as `readNote`. Path traversal, symlink-escape, and the `--max-file-bytes` cap all apply. The cap is **shared with markdown** (so a `--max-file-bytes 1000000` setting limits both `.md` and `.canvas` files); operators wanting separate limits should split via folder filters or run separate enquire instances.
- **`obsidian_open_in_ui`** emits an `obsidian://open?vault=&file=` URI — pure URI emission, no fs/network side effect. The vault name is the leaf folder of `vault.root`; if a user runs Obsidian under a different vault name, the URI may fail to resolve in the desktop app, but no privilege escalation is possible.
- **`obsidian_semantic_search`** memoizes the TF-IDF index in a per-vault `WeakMap` (in-process only; never written to disk). The index rebuilds when `listMarkdown()` returns a different paths-or-mtimes set, so cache invalidation tracks vault edits.
- **`obsidian_lint_wiki`** + **`obsidian_open_questions`** + **`obsidian_paper_audit`** scan note bodies via `parsed.body` (frontmatter stripped) — a regex match in YAML metadata can't trigger a false-positive in the body-side hygiene reports.

## `obsidian_rename_note`: atomic-rewrite posture

`obsidian_rename_note` (write tool, requires `--enable-write`) is the most privileged MCP surface — a single call mutates many files in the vault. The threat model is: an attacker-controlled MCP client invokes `rename_note` with crafted arguments to clobber files outside the vault, leak content, or leave the vault in a corrupted half-state.

Mitigations already in place:

- **Path-traversal rejected** on both `from` and `to` arguments via `vault.resolveInside()` + `vault.stat()` + `vault.renameFile()`. A `to` that escapes the vault root throws before any writes.
- **Symlink-escape rejected** — destination behind a symlink is refused at rename time.
- **`--exclude-glob` honored** — both `from` and `to` are checked against the exclude list. A rename whose source or destination matches a privacy-filtered pattern is refused.
- **Refuses overwrite by default** — `to` already exists → throws unless the caller passes `overwrite: true` explicitly.
- **Refuses `from === to`** — a same-path rename is treated as an error rather than a silent no-op.
- **Code-fence-aware rewrite** — wikilinks inside ` ``` ` / `~~~` blocks are left verbatim. An attacker can't smuggle a payload like `[[Foo]]` inside a code block to force unrelated files to be rewritten — only outside-fence wikilinks resolved by the parser are touched.
- **Atomicity & recovery posture** — write order is: (1) all backlink-bearing files, (2) the source file's rewritten content (still at OLD path), (3) `fs.rename` source's old path → new path. A failure at any step before step 3 leaves backlinks pointing at the still-present old name (worst case: safe and recoverable; old wikilinks resolve, the user can re-run the rename).
- **`dry_run: true` preview** — caller can inspect the full per-file rewrite plan before any disk mutation.

Out of scope:
- A vault that spans multiple filesystems (rare; symlink to a mounted drive). `fs.rename` will fail with `EXDEV` after the backlink files are written. The user can move the vault to a single filesystem and re-run; we don't auto-fall back to copy-then-delete.
- A note that contains identical literal `[[X]]` strings inside AND outside a code fence where only the outside ones should be rewritten — the parser excludes code-fenced wikilinks, so the rewrite plan correctly only includes outside-fence ones, and the line-walker skips fence lines during the actual replacement.

## `--watch`: live-watcher posture

`--watch` (added v1.2.0, opt-in) registers a chokidar-backed watcher on the vault root so the parsed-note cache and the FTS5 index can stay fresh while the server is alive. Threat model: an attacker with write access to the vault filesystem is already inside the trust boundary (they can edit notes directly); the concern here is reducing the watcher's surface beyond what they could do without it.

Mitigations already in place:

- **Symlinks not followed** — `chokidar` is configured with `followSymlinks: false`, matching the vault walker. A symlink inside the vault that resolves outside the vault is invisible to the watcher.
- **`--exclude-glob` honoured at runtime** — the watcher's `ignored` predicate calls `vault.isExcluded(rel)` per file. Edits to excluded paths fire **no** cache invalidation and **no** FTS5 reindex, so a private subfolder stays private even when the watcher is on.
- **Skip-dirs match the walker** — `.git`, `.obsidian`, `.trash`, `node_modules`, `.DS_Store` are ignored so editor metadata and SCM noise don't trigger reindex.
- **Non-`.md` files ignored** — `.txt`, `.png`, `.canvas`, etc. don't fire events.
- **Editor-debouncing** — chokidar's `awaitWriteFinish` (`stabilityThreshold: 250ms`, `pollInterval: 50ms`) collapses bursts of save events from editors like Obsidian into a single reindex per logical write. This isn't a security mitigation, but it prevents resource-exhaustion via rapid saves.
- **Cleanup on shutdown** — `SIGINT`/`SIGTERM`/`beforeExit` close the chokidar watcher (releases native fs handles).

Out of scope:
- Timing-side-channel: `--exclude-glob` filtering happens AFTER chokidar's stat call, so an external observer with read access to system call timing could in principle infer that *some* event fired even for excluded paths. Acceptable — anyone with that level of system access already controls the vault.
- Watcher event ordering: chokidar coalesces but doesn't strictly serialize events. If the server's own write tools (`create_note`, `append_to_note`, `rename_note`) fire and the watcher reacts before the tool's own cache invalidation, the watcher may do redundant work but never produces inconsistent state — every read goes back to the disk.

## Periodic-Notes plugin config: disk-read posture

The periodic-alias resolver inside `obsidian_read_note` / `obsidian_append_to_note` etc. (added v1.10.0) lazily reads **two files** under the vault's `.obsidian/` directory at first use:

1. `.obsidian/daily-notes.json` — the core Daily Notes plugin's settings.
2. `.obsidian/plugins/periodic-notes/data.json` — the community Periodic Notes plugin's settings.

Posture:

- **Reads only.** Both files are opened with `fs.readFile` and parsed via `JSON.parse`; the resolver never writes back. A malformed file logs to stderr and falls through to the v0.11 hard-coded defaults — never throws.
- **Inside the vault root.** Both paths live under the vault root the user already exposed. No new filesystem surface is introduced.
- **No `.obsidian/` listing.** The walker's `SKIP_DIRS` set (which includes `.obsidian`) still hides everything else under that folder; only those two specific files are read by-name.
- **Cached for the process lifetime.** The first call populates `Vault.periodicConfig` and subsequent calls return that snapshot — restart the server after editing the plugin config.
- **No string interpolation.** The `format` string from the plugin config feeds a fixed Moment.js token table (`YYYY`, `MMM`, `Do`, …) and bracket-escaped literals; there's no `eval` or template path that could turn user-provided format text into code execution.
- **`--read-paths` allowlist now consistent.** v1.11.1 surfaces "excluded by --read-paths / --exclude-glob" errors from the periodic-alias path lookup the same way as the path-based lookup. Pre-1.11.1, exclusion errors were silently caught and the resolver fell through to the legacy basename matcher — which could surface a different (visible) note with a colliding basename. v1.11.1 re-throws exclusion errors, so the agent gets a clear refusal instead.

## `--enabled-tools` / `--disabled-tools`: per-tool gating posture

`--disabled-tools` (added v1.10.0) and `--enabled-tools` (added v1.11.0) both gate which MCP tools the server registers, via a monkey-patched `server.registerTool()`:

- **`--disabled-tools` is a denylist.** Comma-separated list of tool names; matching tools are skipped at registration time. Useful for surface-area reduction without forking.
- **`--enabled-tools` is an allowlist.** Comma-separated list; ONLY listed tools are registered. Combined with `--disabled-tools`, both predicates apply (a tool must be in the allowlist AND not in the denylist).
- **Names are validated against the canonical tool list.** Unknown names log a stderr warning and are otherwise ignored — typos don't silently disable nothing.
- **Write-tool gating composes with `--enable-write`.** Disabling `obsidian_create_note` while leaving `obsidian_replace_in_notes` enabled is a valid configuration; the gate is independent of the global write flag.
- **Posture is "fail closed".** Tools blocked at registration time never appear in `tools/list` and a `tools/call` against a gated name returns a clean MCP-protocol error from the SDK — there's no codepath where a disabled tool can still execute.

## ML embeddings (v2.0 alpha): networked-download + cache posture

The `obsidian_embeddings_search` tool plus the `install-model` and `build-embeddings` subcommands (added v2.0.0-alpha.0) introduce two new surfaces with networked / on-disk implications:

### Model download (`install-model`)

- **Explicit, opt-in.** The `enquire-mcp install-model [alias]` subcommand is the ONLY codepath that hits the network. Serving / read-only / TF-IDF / FTS5 paths never make outbound HTTP. Air-gap-safe by default.
- **Source: HuggingFace Hub.** Model weights ship as ONNX from the `Xenova/*` org. `@huggingface/transformers` handles the download, hash verification, and caching to `~/.cache/huggingface/transformers.js/`.
- **Reusable across vaults.** The cache is per-machine, not per-vault. Multiple `enquire-mcp` instances on different vaults share the same model files.
- **Manual purge.** Delete `~/.cache/huggingface/transformers.js/` to remove cached models.

### Persistent embedding index (`build-embeddings`)

- **0600 chmod** on `<vault-hash>.embed.db` + WAL + SHM sidecar files, parent directory mode 0700 — same as the FTS5 index posture.
- **Cross-vault contamination guard.** `meta` table stores `vault_root`, `model_alias`, `dim`, and `schema_version`; if any change between runs, the embedding tables are dropped and rebuilt with a stderr warning. Prevents a stale index from leaking content into a different vault.
- **Caveat — embedding values can leak content via cosine.** Float32 vectors stored in the index are reversible-ish: with the same model loaded, an attacker with read access to the .embed.db file can run nearest-neighbor searches against arbitrary queries to recover note content topics. Treat the .embed.db as having the same sensitivity as the .fts5.db (which already stores raw chunk content). If your threat model includes other local users on the same machine, do not use `--persistent-cache` / `--persistent-index` / build-embeddings.
- **Caveat — silent token truncation.** `paraphrase-multilingual-MiniLM-L12-v2` truncates inputs at 128 tokens; `bge-small-en-v1.5` at 512. The FTS5 chunker produces ~4096-character chunks (~600-1000 tokens), so the multilingual model only sees the first 128 tokens of each chunk. This is a recall ceiling, not a security issue — but it means `obsidian_embeddings_search` may miss content in the tail of long paragraphs. Mitigation: split notes into shorter chunks, or use the `bge` model for longer-context English content. Sub-chunk-level truncation handling is a v2.1 backlog item.
- **Manual purge.** `enquire-mcp clear-embeddings --vault <path>` removes the `.embed.db`, `.embed.db-wal`, and `.embed.db-shm` files.
- **`--exclude-glob` / `--read-paths` honored.** The `build-embeddings` subcommand accepts both flags — excluded notes are never embedded, never appear in results.

### Optional-dep failure mode

- If `@huggingface/transformers` failed to install (e.g., user ran `npm install --omit=optional`, or the platform lacks ONNX runtime binaries), the embedding tools and subcommands surface a clean error message pointing the user at `npm install @huggingface/transformers` — never a cryptic module-not-found stack trace.
- Read-only / TF-IDF / FTS5 surfaces are unaffected. The server starts and serves all v1.x tools normally.

## Persistent FTS5 index: privacy posture

When `--persistent-index` is enabled, the search-index file at `<vault-hash>.fts5.db` (alongside the parse cache) stores **chunked note content** (paragraph-level, ~4 KB each), the **comma-serialized tag list** of each note, and the **list of wikilink targets** as part of the FTS5 enrichment for recall.

- DB file + WAL (`<file>-wal`) + SHM (`<file>-shm`) sidecar files are all chmod'd to **`0600`** on every `open()`.
- Parent directory mode is **`0700`**.
- `obsidian://chunk/{n}/{path}` resource returns the **raw original chunk text only** — the synthetic `[wikilink_targets: …]` enrichment used for FTS5 recall does NOT leak into the resource response.
- Cross-vault contamination guard: a `meta` table stores `vault_root` and `tokenize_mode`; if either changes between runs, the index is dropped and rebuilt with a stderr warning.
- Manual purge: `enquire-mcp clear-index --vault <path>` removes the `.fts5.db`, `.fts5.db-wal`, and `.fts5.db-shm` files.
- **Caveat:** SQLite WAL mode keeps the most-recent uncommitted writes in `<file>-wal`. If you delete only `<file>` manually (not via `clear-index`), some recently-indexed chunks may persist in the sidecar. Always use `clear-index` for full removal.
