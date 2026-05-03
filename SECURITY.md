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

## Persistent FTS5 index: privacy posture

When `--persistent-index` is enabled, the search-index file at `<vault-hash>.fts5.db` (alongside the parse cache) stores **chunked note content** (paragraph-level, ~4 KB each), the **comma-serialized tag list** of each note, and the **list of wikilink targets** as part of the FTS5 enrichment for recall.

- DB file + WAL (`<file>-wal`) + SHM (`<file>-shm`) sidecar files are all chmod'd to **`0600`** on every `open()`.
- Parent directory mode is **`0700`**.
- `obsidian://chunk/{n}/{path}` resource returns the **raw original chunk text only** — the synthetic `[wikilink_targets: …]` enrichment used for FTS5 recall does NOT leak into the resource response.
- Cross-vault contamination guard: a `meta` table stores `vault_root` and `tokenize_mode`; if either changes between runs, the index is dropped and rebuilt with a stderr warning.
- Manual purge: `enquire-mcp clear-index --vault <path>` removes the `.fts5.db`, `.fts5.db-wal`, and `.fts5.db-shm` files.
- **Caveat:** SQLite WAL mode keeps the most-recent uncommitted writes in `<file>-wal`. If you delete only `<file>` manually (not via `clear-index`), some recently-indexed chunks may persist in the sidecar. Always use `clear-index` for full removal.
