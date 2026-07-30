# Security policy

## Reporting a vulnerability

If you've found a security issue in enquire, **please don't open a public GitHub issue**. You have two equally-valid private channels:

1. **Preferred — GitHub Private Vulnerability Reporting.** Open a [private security advisory](https://github.com/oomkapwn/enquire-mcp/security/advisories/new) directly on the repo. GitHub keeps the report private until you and I jointly publish it; collaboration on the fix happens in the same advisory thread.
2. **Fallback — email.** `oomkapwn@gmail.com` with subject `enquire security`. Include a reproducer if you have one — vault layout, exact CLI flags, the operation that triggered the issue.

Either channel: expect an acknowledgement within **72 hours**. I work on a fix in private, cut a patch release, and then publicly disclose with credit (or anonymously, your call).

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
- YAML parsed via `js-yaml@5` `load` (YAML 1.2 core schema, safe-by-default — no `!!js/function`, no merge-key resolution) — no code execution.
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
- **Watcher-aware (defense-in-depth).** When `--watch` is enabled, file events for paths outside the allowlist are dropped at the chokidar `ignored` predicate — the watcher never even sees writes to private folders. Since v3.10.0-rc.20 the watcher's per-file `handle()` ALSO re-checks `isExcluded()` before any index/embed work, so a filtered note can't be indexed even if an event reaches the handler by another path.
- **Error-message distinguishes the two filters.** When a tool tries to read a path that's blocked, the error says either `"--read-paths allowlist (path doesn't match any allow-glob)"` or `"--exclude-glob denylist"` — so users can tell which flag rejected the path.
- **No silent degradation.** If `--read-paths` is set and zero paths match, `listMarkdown()` returns `[]` and tools return empty results rather than falling back to "everything is visible."
- **Not retroactive for content already at rest.** `--exclude-glob` / `--read-paths` are applied at the read/index/search boundary, so adding a filter immediately hides matching notes from all tool results (the same `isExcluded()` predicate gates search, read, and the walker). But a filter added *after* a note was already indexed does NOT erase the copy already written to disk — the note's chunk text persists in the `.fts5.db` and the `.embed.db` `text_preview` (+ `.hnsw.meta.json` sidecar) until you rebuild. To purge already-indexed content, run `enquire-mcp clear-index` and/or `enquire-mcp clear-embeddings` (and `clear-cache` for the parse cache), then re-run `build-embeddings` with the filter in place. Treat privacy filters as "do not index going forward," not "retroactively erase."

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
- **Bounded startup activation** — native events observed while EmbedDb/OCR/HNSW attach are coalesced by exact path and applied from final disk state only after late attachment. Admission is capped at 50,000 identities, planning/replay at four concurrent tasks, and non-quiescing activation at 16 generations. A post-ready FTS rediff plus exact path/mtime EmbedDb audit covers the ordinary `ignoreInitial` gap; byte replacement that deliberately preserves both path and mtime is outside that proof.
- **Process-restart interlock** — when a watched EmbedDb exists, startup creates an exclusive private guard directory before chokidar starts and removes it only after activation completes. A crash, overflow, non-quiescence or release failure makes every later server/embedding reader refuse that index until strict `clear-embeddings` recovery (or a manual ownership audit when the guard shape is unsafe). The guard contains only a schema version and random token, never note text or vault/note paths. It protects restart admission, not already-admitted concurrent writers or hostile same-account tampering.
- **Cleanup on shutdown** — `SIGINT`/`SIGTERM`/`beforeExit` close chokidar, drain accepted activation/live work, and propagate activation failure instead of reporting false success.

Out of scope:
- Timing-side-channel: `--exclude-glob` filtering happens AFTER chokidar's stat call, so an external observer with read access to system call timing could in principle infer that *some* event fired even for excluded paths. Acceptable — anyone with that level of system access already controls the vault.
- Cross-sink transactionality: the startup barrier removes dependency-order loss, but individual parser/model/SQLite/HNSW handlers retain fail-soft live behavior. A per-sink failure can still leave FTS5/EmbedDb/HNSW mixed in the current process until repair/rebuild; after any uncertain HNSW live sync, close-time HNSW persistence is disabled so the next restart rebuilds rather than trusting that graph. One-generation staging and failure propagation remain a separate hardening item.

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

## ML embeddings (v2.0): networked-download + cache posture

The `obsidian_embeddings_search` tool plus the `install-model` and `build-embeddings` subcommands (added v2.0.0-alpha.0) introduce two new surfaces with networked / on-disk implications:

### Model download (`install-model`)

- **Explicit, opt-in model acquisition.** `enquire-mcp install-model [alias]`, `build-embeddings`, and `setup` are the network-enabled model paths (one-time HuggingFace downloads). Runtime/read commands — `serve`, `serve-http`, `query`, and `eval` — call `setEmbeddingsOffline()` before search → transformers.js `env.allowRemoteModels = false`, so embedder/reranker loads use ONLY the local cache. A cache miss **fails closed** with an `install-model` hint instead of silently downloading. TF-IDF/FTS5-only operation remains local. Air-gap-safe by default. **OIA Check 4f** (`scripts/oia-walk.mjs`) enforces all four runtime call sites plus the transformers.js guard.
- **Source: HuggingFace Hub.** Model weights ship as ONNX from the `Xenova/*` org. `@huggingface/transformers` handles explicit downloads and caches them inside its installed package directory. Tiered doctor is a v3.12 preview. Run `enquire-mcp configure --tier hybrid --vault <path>` from the selected installation and use its physically pinned setup/doctor/runtime commands; package version alone does not identify one npx installation. Doctor reports that installation's resolved cache root; legacy `~/.cache/huggingface` paths are not assumed.
- **Reusable across vaults within one installation identity.** Vaults served by the same installed package copy share its model files. A global install and a project-local/npx install can resolve to different package directories and therefore different caches; keep setup, install-model, doctor, and runtime on one exact package identity.
- **Manual purge.** Delete the exact package-local cache root reported by `doctor` to remove cached models. Global and project-local installs can resolve to different directories.

### Persistent embedding index (`build-embeddings`)

- **0600 chmod** on `<vault-hash>.embed.db` + WAL + SHM sidecar files, parent directory mode 0700 — same as the FTS5 index posture.
- **Cross-vault contamination guard.** `meta` table stores `vault_root`, `model_alias`, `dim`, and `schema_version`; if any change between runs, the embedding tables are dropped and rebuilt with a stderr warning. Prevents a stale index from leaking content into a different vault.
- **Caveat — the embed index stores recoverable content at rest.** Two on-disk surfaces hold note content: (1) the `text_preview` column of `.embed.db` (and, for `--use-hnsw`, the `.hnsw.meta.json` sidecar) stores the **raw leading text of each chunk** directly — a snippet needed to return readable hits; and (2) the Float32 vectors are reversible-ish — with the same model loaded, an attacker with read access can run nearest-neighbor searches against arbitrary queries to recover note content topics. Treat the `.embed.db` (+ its `.hnsw.*` sidecars) as having the same sensitivity as the `.fts5.db` (which already stores raw chunk content). If your threat model includes other local users on the same machine, do not use `--persistent-cache` / `--persistent-index` / build-embeddings. (File mode is `0600`, parent dir `0700`, so cross-user read requires already having that account or root.)
- **Caveat — silent token truncation.** `paraphrase-multilingual-MiniLM-L12-v2` truncates inputs at 128 tokens; `bge-small-en-v1.5` at 512. The FTS5 chunker produces ~4096-character chunks (~600-1000 tokens), so the multilingual model only sees the first 128 tokens of each chunk. This is a recall ceiling, not a security issue — but it means `obsidian_embeddings_search` may miss content in the tail of long paragraphs. Mitigation: split notes into shorter chunks, or use the `bge` model for longer-context English content. Sub-chunk-level truncation handling is a v2.1 backlog item.
- **Manual purge and interrupted-startup recovery.** `enquire-mcp clear-embeddings --vault <path>` removes the `.embed.db`, `.embed.db-wal`, `.embed.db-shm` files, **the HNSW sidecars (`.hnsw.bin` + `.hnsw.meta.json`)**, and the token-only watcher startup interlock. Before deleting the first artifact it read-only preflights the guard shape; an unsafe file, symlink, special object or unexpected entry therefore refuses the entire operation for manual ownership inspection. Recoverable artifacts are then removed before the interlock, whose exact shape is revalidated and removed last. Any permission/type/race error is loud, and cleanup never recursively deletes unexpected content. Stop every enquire process first, use the matching `--embed-file` for a custom index, and rebuild with the same model, quantization, late-chunk, privacy and PDF settings.
- **`--exclude-glob` / `--read-paths` honored.** The `build-embeddings` subcommand accepts both flags — excluded notes are never embedded, never appear in results.

### Optional-dep failure mode

- If `@huggingface/transformers` failed to install (e.g., user ran `npm install --omit=optional`, or the platform lacks ONNX runtime binaries), the embedding tools and subcommands surface a clean error message pointing the user at `npm install @huggingface/transformers` — never a cryptic module-not-found stack trace.
- Read-only / TF-IDF / FTS5 surfaces are unaffected. The server starts and serves all v1.x tools normally.

## Published dependency resolution (introduced in v3.11.7-rc.8; current at v3.12.0-rc.25)

npm applies `overrides` only from the root project performing an install. The overrides in enquire's source `package.json` keep its development/release lockfile on patched transitive versions, but they are ignored when the published package is installed as somebody else's dependency. Release CI therefore audits two distinct graphs:

- **Source checkout:** production advisories at moderate+ and development advisories at high+ fail with an empty allowlist.
- **Published consumer:** CI packs the actual npm tarball with scripts disabled, uses that artifact as a file dependency in a clean temporary root with no overrides, resolves a lockfile from scratch without running lifecycle scripts, and audits production dependencies at moderate+. This preserves future peer/bundled dependency semantics instead of copying a hand-selected subset of manifest fields. A new advisory fails; a temporary exception also fails once its advisory disappears, forcing removal instead of becoming permanent.

As of v3.12.0-rc.25, the clean consumer graph has exactly two temporary upstream exceptions. The former `GHSA-frvp-7c67-39w9` exception was removed as soon as the live audit proved that advisory had disappeared:

- [`GHSA-f88m-g3jw-g9cj`](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) via optional `@huggingface/transformers` → `sharp`. Enquire uses text-only feature extraction and reranking, not Transformers' image/Sharp decode path. Removal is tracked in [huggingface/transformers.js#1729](https://github.com/huggingface/transformers.js/issues/1729).
- [`GHSA-xcpc-8h2w-3j85`](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) via optional Transformers → `onnxruntime-node` → `adm-zip`. This code is outside the MCP/vault runtime and is used by an upstream install-time extraction path; the residual install-time supply-chain/availability risk is accepted for RC testing only. Removal is tracked in [huggingface/transformers.js#1727](https://github.com/huggingface/transformers.js/issues/1727).

These are reachability assessments, not claims that the dependencies are patched. A standard consumer may report multiple vulnerable package nodes because npm propagates the two unique advisories through their parent packages. Release candidates may carry the exact, removal-tracked exceptions above; promotion to npm `@latest` is blocked until the published-consumer audit is clean.

<a id="ocr-network-posture"></a>

## OCR (`obsidian_ocr_pdf`): network posture (offline-ENFORCED since v3.9.0-rc.10)

The `obsidian_ocr_pdf` tool (v2.10+) uses `tesseract.js` for image-PDF OCR. Tesseract.js's *default* behavior is to fetch the `<lang>.traineddata` file (~10 MB per language) from a CDN on first use of each language. **enquire `serve` blocks that path entirely** — so the "zero outbound network calls in serve mode" guarantee holds even for OCR.

**How it is enforced (the code guards, verifiable):**
- **Pre-flight throw.** Before any Tesseract worker is created, `extractPdfWithOcr` calls `assertOcrLangsInstalled(langs, langPath)` (`src/ocr.ts`), which `existsSync`-checks every requested `<lang>.traineddata` in the local tessdata cache and **throws, fail-closed**, if any is missing — naming the exact `install-ocr-lang` command. The check runs *before* the optional deps even load, so the guarantee holds on hosts without `tesseract.js`/`canvas`.
- **Read-only local cache.** The worker is created with `langPath` + `cachePath` pointed at the local tessdata dir and `cacheMethod: "readOnly"` — it never writes or re-fetches.
- **OIA Check 4e** (`scripts/oia-walk.mjs`) fails CI if any doc claims this offline guarantee while a code guard is absent (regression-proofs the claim).

**Installing a language pack (the ONLY OCR-related network call — explicit + opt-in, never during `serve`):**
```
enquire-mcp install-ocr-lang eng      # downloads eng.traineddata into the local tessdata cache
enquire-mcp install-ocr-lang chi_sim  # one code per invocation
```
Packs are cached under `$ENQUIRE_TESSDATA_DIR` → `$XDG_CACHE_HOME/enquire-mcp/tessdata` → `~/.cache/enquire-mcp/tessdata` (see `resolveTessdataDir`). For air-gapped hosts, run `install-ocr-lang` on an online machine and copy that directory across.

**Other mitigations:**
- The OCR tool is only registered when the optional deps (`tesseract.js`, `@napi-rs/canvas`) are installed — `npm install --omit=optional` leaves OCR unavailable, the strictest posture.
- Each rendered page's absolute pixel dimensions are clamped (`MAX_OCR_CANVAS_DIM`) so an adversarially huge PDF MediaBox can't OOM the process; per-call page count is capped (`DEFAULT_OCR_MAX_PAGES`, default 200; `--ocr-max-pages` configures watcher runs).
- All OCR entry points share one process-wide FIFO slot, a bounded waiting queue, and a finite default wall-clock budget. Client cancellation and timeout trigger render/worker/PDF cleanup; the slot remains leased until that cleanup settles.

Tracked in CHANGELOG under v3.7.16 P1-1 (original disclosure) → v3.9.0-rc.10 (offline enforcement shipped: pre-flight guard + `install-ocr-lang` + read-only cache + OIA Check 4e) → v3.12.0-rc.8 (timeout, admission and cancellation cleanup).

### OCR resource limits (v3.7.16 P1-2; completed v3.12.0-rc.8)

OCR is the slowest path in the project — ~1-2s per page on M1 CPU at default scale. Before the resource-control sequence, a single bearer-authenticated HTTP request could trigger unbounded OCR work and concurrent callers could multiply its canvas/WASM memory pressure.

The current controls are cumulative:

- **Page work:** `DEFAULT_OCR_MAX_PAGES=200` applies to both whole-document and explicit `pages: [from, to]` requests. A trusted host integration may set a different `maxPages`; the MCP tool does not expose that override. The guard runs before Tesseract starts.
- **Pixel work:** `MAX_OCR_CANVAS_DIM=5000` bounds the largest rendered side even for a hostile PDF MediaBox.
- **Concurrent work:** `MAX_CONCURRENT_OCR_CALLS=1` serializes MCP-tool and watcher OCR in one fair FIFO process-wide lane. `MAX_QUEUED_OCR_CALLS=4` bounds waiting requests because each retains its PDF buffer; overflow fails fast with a retryable busy error. At the maximum canvas dimension, one RGBA canvas alone is roughly 100 MiB before PNG/Tesseract buffers, so one slot is the safe cross-platform default.
- **Elapsed work:** `DEFAULT_OCR_TIMEOUT_MS=600000` bounds the complete call, including queue wait. Narrow the page range when the budget is exceeded.
- **Cancellation/cleanup:** the MCP SDK signal is propagated into OCR. Timeout or client cancellation cancels the active pdfjs render, terminates Tesseract, destroys the loading task, and surfaces a stable client-safe error. The caller is released immediately, but the concurrency lease is held until the underlying operation settles its cleanup, preventing a timed-out native/WASM task from overlapping a newly admitted one.

These controls live in the shared OCR core rather than only in `serve-http`, so stdio, HTTP, and watcher ingress have the same resource bound without imposing a blanket timeout on unrelated MCP operations.

## Persistent FTS5 index: privacy posture

When `--persistent-index` is enabled, the search-index file at `<vault-hash>.fts5.db` (alongside the parse cache) stores **chunked note content** (paragraph-level, ~4 KB each), the **comma-serialized tag list** of each note, and the **list of wikilink targets** as part of the FTS5 enrichment for recall.

- DB file + WAL (`<file>-wal`) + SHM (`<file>-shm`) sidecar files are all chmod'd to **`0600`** on every `open()`.
- Parent directory mode is **`0700`**.
- `obsidian://chunk/{n}/{path}` resource returns the **raw original chunk text only** — the synthetic `[wikilink_targets: …]` enrichment used for FTS5 recall does NOT leak into the resource response.
- Cross-vault contamination guard: a `meta` table stores `vault_root` and `tokenize_mode`; if either changes between runs, the index is dropped and rebuilt with a stderr warning.
- Manual purge: `enquire-mcp clear-index --vault <path>` removes the `.fts5.db`, `.fts5.db-wal`, and `.fts5.db-shm` files.
- **Caveat:** SQLite WAL mode keeps the most-recent uncommitted writes in `<file>-wal`. If you delete only `<file>` manually (not via `clear-index`), some recently-indexed chunks may persist in the sidecar. Always use `clear-index` for full removal.

## Closed-loop feedback store (v3.11.0): data-at-rest posture

When `--feedback-weight > 0`, the `obsidian_mark_useful` tool records which recalled notes helped a query, into a per-vault JSON sidecar at `<vault-hash>.feedback.json` (same cache dir as the parse cache / FTS5 index).

- **Low-sensitivity by design.** The file holds ONLY **relative note paths** + integer **useful / not-useful counts** + an ISO timestamp per note. It does **NOT** store note content, snippets, or the query text — so unlike `.fts5.db` / `.embed.db`, it cannot leak note *bodies*. The worst-case disclosure to a local reader is *which* notes were marked useful (a usage-pattern signal), not their content.
- **0600 chmod** on the sidecar; written atomically (tmp + rename) so a crash never leaves a torn file. Parent dir mode is `0700` (shared with the other cache artifacts).
- **Bounded.** At most `MAX_FEEDBACK_ENTRIES` (100,000) distinct notes are tracked; at the cap, existing entries still update but new paths are ignored — bounding disk growth from a misbehaving `serve-http` client.
- **Right-to-erasure.** `enquire-mcp prune` erases a decommissioned vault's `<hash>.feedback.json` (+ any `.tmp` leftover) along with every other per-vault artifact — pinned by the erasure-completeness invariant (`tests/erasure-invariant.test.ts`). It is **preserved across `clear-cache`** (it is user-generated signal, not regenerable cache); delete the vault's cache artifacts via `prune` to remove it.
- **Opt-in.** With `--feedback-weight` unset or 0 (the default), the tool is not registered, no boost is applied, and no feedback file is ever created.

## HTTP transport (v2.6.0): bearer auth + remote-MCP posture

The `serve-http` subcommand (added v2.6.0) exposes the same MCP server over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) so claude.ai web, ChatGPT, Cursor HTTP mode, and mobile MCP clients can reach a remote vault. It introduces a network-exposed endpoint that the default stdio path doesn't have. The threat model + deployment recipes are documented at length in [`docs/http-transport.md`](docs/http-transport.md); this section is the canonical security posture.

### What we protect against

- **Unauthenticated read.** Wrong/missing token → 401, fail-closed at the auth middleware before any tool dispatch. The startup itself refuses to bind without `--bearer-token` (or `--bearer-token-env`) of length ≥16 chars.
- **Token timing leaks.** Bearer compare hashes both presented and expected token with SHA-256 first, then `crypto.timingSafeEqual` on the equal-length 32-byte digests. No length oracle; equal-length compare is constant-time.
- **Token logging.** Stderr / log output uses the SHA-256 prefix as the rate-limit key — the raw bearer token never appears in logs, error messages, or rate-limit state.
- **Rate-limit abuse.** Per-token sliding 60-second window, default 120 requests/minute. Tunable via `--rate-limit` (`0` disables for trusted private LANs). 429 + `Retry-After: 60` on overflow.
- **CORS-based credential leakage.** `--cors-origin` is a strict allowlist. Default empty (no `Access-Control-Allow-Origin` sent — same-origin works regardless). With explicit origins, we send `Access-Control-Allow-Credentials: true` so cookies + bearer requests work cross-origin. With the `*` wildcard, we deliberately OMIT `Allow-Credentials` (browsers reject the combo anyway, and reflecting credentialed CORS to attacker-controlled origins is the [CodeQL `js/cors-misconfiguration-for-credentials` class of bug](https://codeql.github.com/codeql-query-help/javascript/js-cors-misconfiguration-for-credentials/)). The response value is sourced from the allowlist itself, not from `req.headers.origin`, so static-analysis taint flows from a server-controlled root.
- **Body bombs.** Per-request body size cap derived from `--max-file-bytes` as `max(4 MB, max-file-bytes × 1.5)` (7.5 MB at the default 5 MB file cap), enforced as we accumulate chunks. Bigger requests get `400 Parse error` before we attempt JSON.parse.
- **Privacy filter (`--exclude-glob` / `--read-paths`)** applies identically to HTTP and stdio paths. The same audit-tested filter runs at every search/read/walker boundary; there are no HTTP-specific shortcuts. v2.0.0-beta.2 P0 fixes for FTS5 + embed-index search apply here.
- **Tag-deletion / write-tool gating.** All write tools (chat-thread-append, frontmatter-set, create/append/rename/replace/archive) remain gated by `--enable-write` regardless of transport. HTTP doesn't lower the bar.

### What we do NOT protect against (deliberate non-goals)

- **TLS termination.** We bind plain HTTP and assume a tunnel (Tailscale Funnel / Cloudflare Tunnel / nginx + Let's Encrypt) handles HTTPS. We deliberately default `--host 127.0.0.1` so direct internet exposure is opt-in via `0.0.0.0`. Recipes in `docs/http-transport.md` walk through the tunneled deployments.
- **Compromised client.** A user who pastes their bearer token into a malicious chat or who lets it leak via `ps aux` / shell history is owned. Hence `--bearer-token-env <name>` (read from env) and `enquire-mcp gen-token` (32-byte base64url generator). Treat the token like a password.
- **DoS from a single token.** A malicious client can fire rate-limit-budget worth of requests indefinitely; we just answer 429 once over budget. Use the tunnel's WAF for upstream DoS protection. Single-process — for shared limits use a reverse proxy with its own rate-limit module.
- **Multi-tenant cross-token attacks.** This is a single-tenant tool. A small team should run **one process per user** (e.g. systemd template unit) and not share tokens. We don't do tenant isolation in-process beyond the per-token rate-limit.
- **OAuth.** No OAuth flow, no token minting, no refresh logic. Static long-lived bearer is by design — generated with `enquire-mcp gen-token`, rotated manually. OAuth is tracked for v2.7+ if a user explicitly needs it.

### Stateful sessions (v2.14.0+)

v2.6.0 initially shipped **stateless** mode only (fresh `McpServer` per request over the SHARED vault + FTS5 + embedding handles). v2.14.0 added an **opt-in stateful** mode via `--stateful` for clients that need persistent state across requests (notably ChatGPT custom GPT actions). Stateful posture:

- **Off by default.** `--stateful` is explicit opt-in; stateless remains the default for minimum attack surface. Short-running tools (search, read, frontmatter ops) work fine stateless and don't need the persistence-aware shutdown complexity.
- **Session ID generation.** `Mcp-Session-Id` is `randomBytes(16).toString("hex")` — 128 bits, allocated at `initialize` time, returned in response header. Clients must echo it on subsequent requests; unknown IDs return 404 (no info leak about whether the ID was ever valid).
- **Per-token + per-session rate limit.** The bearer-token rate limit still applies. Sessions are anchored to a bearer token; one token holding multiple sessions is allowed, but each session is bound to the token that initialized it.
- **Max concurrent sessions cap.** `--max-sessions <n>` (default **100**). New sessions beyond the cap return **503 + `Retry-After`**. Prevents memory exhaustion via session-spam.
- **Idle eviction is lazy, not timer-driven.** `--session-idle-timeout-ms <n>` defaults to **1,800,000 ms = 30 min**. Before every authenticated stateful request, the registry lazily sweeps sessions whose last activity is older than the cutoff. A session currently inside `transport.handleRequest()` is treated as active and skipped; a later request can evict it after that handler finishes. With no later traffic, an idle session can remain allocated until shutdown, while `--max-sessions` still bounds the registry and a new initialize request runs the sweep before the cap check.
- **Explicit termination preserves persistent writes past the ordinary drain.** `DELETE /mcp` marks the session closing (so concurrent GET/POST requests reject) and waits up to `DELETE_DRAIN_MS` (**5 seconds**) for pre-existing POST / initialize calls (`inFlightCalls`) to finish. A concurrent DELETE receives retryable **409**, not a false idempotent success. Long-lived GET SSE streams are excluded because teardown closes them. Persistent write requests are identified from `TOOL_MANIFEST` and counted in `inFlightWrites` through SDK response delivery. If the bound expires, rollback-safe batch tools (`rename`, `replace`, `archive`) receive an abort signal and restore every effect committed by that invocation; atomic/single-effect tools finish instead of being cut off. All persistent MCP mutations sharing the same vault or feedback store are serialized, so one request's rollback cannot overwrite a later MCP write. The transport remains alive and DELETE returns retryable **409** + `Retry-After`; the client retries DELETE after the original tool call settles. An unknown or already-terminated `Mcp-Session-Id` remains idempotent **204**.
- **GET /mcp for persistent SSE.** A `GET /mcp` with a valid `Mcp-Session-Id` opens a server-sent-events stream for server-initiated notifications. Same auth + rate-limit predicates as POST. The stream closes on DELETE or process shutdown; while open it counts as active for the lazy sweep and is not evicted as idle.
- **Privacy filter parity.** `--exclude-glob` / `--read-paths` apply identically to stateful and stateless paths. There is no codepath where a stateful session bypasses the privacy filter.
- **Graceful shutdown.** SIGINT / SIGTERM / `beforeExit` close the initialize gate, remove the current session snapshot, and drain pending initializes + `inFlightCalls` under the same ordinary bound. Before transport teardown, rollback-safe batch writes are cancelled and restored while atomic/single-effect writes are allowed to finish; this integrity tail may exceed five seconds. Long-lived SSE streams and stuck reads are terminated rather than awaited.

Out of scope (stateful mode specifically):
- **Session takeover** if a bearer token leaks. The session-id is in a response header, not a secret — possession of the bearer token is sufficient to initialize new sessions OR (if the attacker captured a previous `Mcp-Session-Id`) re-attach to an existing one. Treat the bearer token as the trust boundary; don't share it.
- **Cross-session leakage.** Each session has its own `McpServer` instance but shares the vault + FTS5 + embedding handles. A misbehaving tool that mutates shared state could affect other sessions. Write tools (`--enable-write`) are still atomic per-file; read tools don't mutate. We don't run per-session sandboxing — single-tenant tool, see "Multi-tenant cross-token attacks" above.

### Observability

- Ready banner on stderr: `enquire <version> ready (read-only|WRITE-ENABLED, vault=…) (transport=http, bound=…)`.
- Transport errors written to stderr with no token / no credential leakage.
- `/health` endpoint (`GET /health → 200 ok`) is **unauthenticated** and exists specifically for tunnel/uptime monitors. It returns the literal string `ok` — no version info, no vault path, no operational metadata. Health probes can't be used to fingerprint the deployment.
- `OPTIONS` preflight requests are unauthenticated (per CORS spec) but only emit CORS headers when the request's `Origin` is in the allowlist.

## Obsidian Bases (`.base`) execution (v3.2.0+): parser + DSL posture

`obsidian_list_bases` / `obsidian_read_base` / `obsidian_query_base` parse user-authored YAML files and evaluate a filter-DSL subset against the vault's markdown notes. New attack surfaces vs the markdown-only v1.x baseline:

**Threat model:**
- **Malformed YAML / YAML bombs.** Parsed via `js-yaml@5`'s default `load` (YAML 1.2 core schema — the safe-by-default successor to v3's `safeLoad`; the same engine used for frontmatter since v3.10.0-rc.53, migrated v4 → v5 in v3.11.0-rc.6). No `!!js/function` / `!!js/regexp` tag, no code-execution path. Malformed YAML throws and is caught before our zod schema validation runs. The quadratic merge-key DoS (GHSA-h67p-54hq-rp68) that affected the previously-bundled js-yaml@3 is gone at the ROOT in js-yaml@5, which does NOT resolve YAML merge keys (`<<`) at all (YAML 1.2 core has no merge key) — not merely patched. **Honest scope (not over-claimed):** js-yaml still resolves YAML anchors/aliases (`&a`/`*a`), so a deeply-nested-alias "billion-laughs" document is **not** specifically rejected at parse time — there is no code guard for general alias-expansion bombs. This is acceptable under the threat model: `.base`/frontmatter YAML is authored in the user's **own single-user local vault**, not supplied by a network attacker; it is not parsed from untrusted remote input.
- **ReDoS in DSL predicate regexes.** Each predicate is matched against a small set of fixed, non-backtracking regexes (`^tag\s*(==|!=)\s*..." literal "$"` style). No user-controlled regex compilation. Predicate strings that don't match any pattern fall into `unevaluated_predicates` and are treated as `false` (**fail-closed since v3.6.2 HN-2** — exclude the row rather than over-include it). The unevaluated set is surfaced to the caller via `BaseQueryResult.unevaluated_predicates` so a typo is visible in the response itself, not just in stderr. Pre-3.6.2 the policy was the opposite (permissive `true`); the v3.6.2 audit batch flipped it after an external auditor flagged the over-include risk for `inDate`/formula-style predicates. They don't cause regex evaluation against user content either way.
- **Path traversal via `.base` file path.** `obsidian_read_base({ path })` and `obsidian_query_base({ path })` resolve through `vault.readBinaryFile` → `vault.resolveSafePath` — the same realpath + `--exclude-glob` + `--read-paths` chain as `readNote`. Symlinks-out-of-vault rejected; excluded paths refuse to load.
- **Filter against private paths.** `queryBase`'s vault walk goes through `vault.listFilesByExtension(".md", folder)`, which respects `--exclude-glob` / `--read-paths`. A `.base` filter cannot surface content that the privacy filter would block from `readNote`.
- **Outbound wikilink-set materialization.** v3.5.0 added `linksTo()` predicate evaluation; the per-note outbound set is computed from `extractWikilinks(body)` — same parser as the read-only `obsidian_get_outbound_links` tool. No new file reads or path resolution beyond what's already exposed.

**Out of scope (deferred):**
- **Formula evaluation** (`formulas:` section). Our DSL is filters-only; formulas are surfaced as metadata via `obsidian_read_base` but never evaluated. Until a formula evaluator ships (separate sprint), there is no code execution path through `.base` formulas — they're inert strings.
- **Summaries / aggregations.** Same — surfaced as metadata, not evaluated. No SQL-injection-class concern since there's no executable backend.
- **Date arithmetic** (`inDate` etc). Falls into `unevaluated_predicates` and is **fail-closed** (excludes the row) since v3.6.2 HN-2. No date-parser surface yet; when one ships, this section gets a dedicated subsection covering its threat model.

When formula evaluation lands, this section gets an "Expression engine sandbox" subsection covering the threat model for that.

## GraphRAG-light: wikilink community detection (v3.4.0+): graph-build posture

`obsidian_get_communities` builds an in-memory undirected graph from every resolved `[[wikilink]]` in the vault, then runs single-phase Louvain modularity optimization. New attack surfaces:

**Threat model:**
- **Vault-wide read amplification.** Where a single `obsidian_read_note` call reads one file, `obsidian_get_communities` reads ALL markdown files in the vault (or under `--folder` if specified) to extract their wikilinks. Privacy filter is honored: excluded/disallowed paths are never in `listFilesByExtension(".md")`'s output, so they don't contribute nodes or edges to the graph. The graph is also bounded by the vault: nodes are vault-relative paths only, no off-vault leakage.
- **Memory bounds on huge vaults.** The adjacency map is `Map<path, Map<path, weight>>` — O(|V| + |E|). For a vault with 50K notes and average degree 10, that's ~250 KB of node strings plus ~3 MB of edge weights — comfortably bounded. Pathologically dense vaults (every note links every other note) hit O(|V|²) memory; this is acceptable since the dense case is implausible and the user controls the vault.
- **Modularity-optimization compute bounds.** Louvain is capped at 50 passes per `detectCommunities` call; each pass is O(|E|). On a 50K-node vault with 500K edges this is ~25M ops × 50 = ~1.3B ops, ~5-10 s wall time. The tool is read-only and per-call (we don't cache), so cost is paid only when the agent explicitly invokes the tool. No persistent background work.
- **No LLM call surface.** The server stays LLM-free for this tool — the agent is expected to summarize communities itself with the member list we return. There is no code path where `obsidian_get_communities` makes outbound HTTP or invokes an embedding model.

**Out of scope:**
- **Multi-phase Louvain refinement.** Single-phase is "good enough up to ~50K notes" by design; the trade-off is documented in `src/communities.ts`. Vault > 50K notes may see lower modularity quality, but never an unbounded compute spike (the 50-pass cap holds).
- **Adversarial graph construction.** A vault author could construct a graph designed to be slow to partition (e.g. specific dense bipartite structures). Acceptable — the user owns the vault; there is no "attacker writes a vault" threat model.
