// Vault file watcher (v1.2 — opt-in via --watch; expanded in v2.8 to
// PDFs; v3.8.0-rc.2 added embed-db sync for .md; v3.8.0-rc.3 added
// embed-db sync for .pdf).
//
// Closes the "edit a note → restart server → wait for FTS5 reindex" loop.
// When enabled, watches the vault root for `.md` add/change/unlink events
// (and `.pdf` events when `--include-pdfs` is on), invalidates the
// parsed-note cache for the affected file, and (if FTS5 is enabled) does
// an incremental reindex of just that file. If the watcher was wired with
// an embed-db handle via {@link VaultWatcher.attachEmbed} (v3.8.0-rc.2+),
// the same event also re-embeds + upserts the affected file's chunks
// into the embed-db so semantic search stays current. Files outside
// `.md` / (`.pdf` when included) are ignored. Symlinks are skipped to
// match the rest of the vault walker.
//
// Debouncing is delegated to chokidar's `awaitWriteFinish` so we don't
// reindex five times during a single Obsidian save.

import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { EmbedDb } from "./embed-db.js";
import type { loadEmbedder } from "./embeddings.js";
import type { FtsIndex } from "./fts5.js";
import type { HnswIndex } from "./hnsw.js";
import type { Vault } from "./vault.js";

/**
 * v3.9.0-rc.2 — shape of the row-metadata entries the HNSW index keeps
 * alongside each label. Mirrors `HnswPersistedMeta["rowsByLabel"][k]`
 * but defined here so the watcher's TypeScript surface stays
 * self-contained (no circular imports between watcher.ts and hnsw.ts's
 * persistence types).
 */
export interface HnswRowMeta {
  rel_path: string;
  chunk_index: number;
  line_start: number;
  line_end: number;
  text_preview: string;
  kind: "md" | "pdf";
}

const SKIP_DIRS = [".git", ".obsidian", ".trash", "node_modules", ".DS_Store"];

export interface WatcherOptions {
  /** Vault to watch — must already be ensureExists()'d. */
  vault: Vault;
  /** Optional FTS5 index to keep in sync on each event. */
  ftsIndex?: FtsIndex | null;
  /** Suppress the "watcher: ..." stderr lines (used by tests). */
  silent?: boolean;
  /**
   * v3.7.16 P1-5 — when true, the watcher also handles `.pdf` lifecycle
   * events (add / change / unlink), keeping the FTS5 PDF chunks in sync.
   * Mirrors the `--include-pdfs` serve flag. Pre-3.7.16 the watcher
   * ignored everything but `.md`, so PDFs added/deleted/moved during a
   * serve session left stale rows in FTS5 until restart.
   *
   * NOTE: PDF re-indexing on `change` requires re-extracting text from
   * the new bytes via `extractPdfText` (~50-200ms per page). For large
   * PDFs this can spike CPU — same cost as the initial-index pass but
   * triggered by a single file. Off by default; opt in alongside
   * `--include-pdfs` for full PDF coverage at runtime.
   */
  includePdfs?: boolean;
  /**
   * v3.8.0-rc.2 R-7 — optional embed-db handle. When provided alongside
   * `embedder`, the watcher re-embeds + upserts on `.md` add/change events
   * and `deleteNote()`s on unlink. Pre-3.8.0 the embed-db drifted on every
   * vault edit until a manual `enquire-mcp build-embeddings` rebuild —
   * search-quality slowly degraded across the session for users on
   * `--use-hnsw` or `--persistent-index` with embeddings.
   *
   * Cost per `.md` change: 1 read + chunkContent + embedder.embed (~50-200ms
   * per chunk on M1 CPU, batched 8x) + db.upsertNote. For a typical
   * 5-paragraph note (~5 chunks), watcher overhead is ~250-500ms — usually
   * invisible against Obsidian's autosave-debounce window. For very long
   * notes the per-edit cost can spike to seconds.
   */
  embedDb?: EmbedDb | null;
  /**
   * v3.8.0-rc.2 R-7 — embedder handle. Same instance used at bulk-sync
   * time so model/dim/late-chunking config stays consistent. Required
   * if `embedDb` is provided.
   */
  embedder?: Awaited<ReturnType<typeof loadEmbedder>> | null;
  /**
   * v3.8.0-rc.2 R-7 — propagate `--late-chunk-context <n>` to per-file
   * re-embeds. Without this, runtime updates would use 0-context while
   * the bulk-built index used n-context — embeddings would diverge in
   * vector space and search recall would drift over the session.
   */
  lateChunkContext?: number;
  /**
   * v3.9.0-rc.1 — when true, the watcher runs Tesseract OCR on
   * image-only / scanned PDFs that pdfjs can't extract text from, then
   * pipes the OCR-derived text through the standard embed pipeline so
   * the embed-db keeps OCR'd PDFs in sync with edits during a long
   * serve session. Off by default (OCR is slow: ~1-2s per page on M1
   * CPU; a 100-page paper takes minutes and blocks the event loop).
   *
   * Requires `tesseract.js` + `@napi-rs/canvas` optional dependencies
   * + the requested language trained-data files pre-installed via
   * `enquire-mcp install-ocr-lang <code>` (see v3.7.16 P1-1 offline
   * enforcement). If those aren't available, OCR fails-soft — the
   * watcher still updates FTS5 + clears any stale embed-db rows.
   *
   * Recommended pairing: `--ocr-pdfs` + `--watch` + `--include-pdfs`
   * for users with scanned-document vaults that change during sessions.
   */
  ocrPdfs?: boolean;
  /**
   * v3.9.0-rc.1 — language pack(s) passed to `extractPdfWithOcr`.
   * Default `'eng'`. Multi-lang via `'+'`, e.g. `'eng+rus'`. See
   * `src/ocr.ts` for the full language model.
   */
  ocrLangs?: string;
  /**
   * v3.9.0-rc.1 — page cap for OCR runs. Mirrors `DEFAULT_OCR_MAX_PAGES`
   * (200) — image-only PDFs that exceed this won't be embed-sync'd
   * (the watcher logs the skip + still updates FTS5). Operators can
   * lift the cap when they trust their PDF set.
   */
  ocrMaxPages?: number;
}

/** Row shape shared by `embedSingleNote` / `embedSinglePdf` results. */
interface EmbedRowLike {
  vector: Float32Array;
  chunkIndex: number;
  lineStart: number;
  lineEnd: number;
  textPreview: string;
}

/**
 * v3.9.0-rc.11 (audit) — zip embed-db rows with their freshly-assigned row ids
 * for an HNSW add-diff. `EmbedDb.upsertNote` returns exactly one id per row in
 * the same order, so a length mismatch is a bug. The pre-rc.11 code used
 * `newIds[i] ?? -1`, which silently inserted a vector under SENTINEL label
 * `-1` on any mismatch — corrupting the in-memory index, the shared
 * `rowsByLabel` map, AND the persisted `.hnsw.bin` sidecar (a later
 * `markDelete(-1)` or a real row colliding on `-1` then scrambles results).
 * This throws (fail-closed) instead: the watcher's per-event try/catch logs it
 * and skips the HNSW update for that file, and the signature guard rebuilds a
 * correct index on the next serve. A corrupt sentinel label is never inserted.
 *
 * @param rows - The embed rows (vector + chunk metadata), in insertion order.
 * @param newIds - The row ids `upsertNote` assigned, parallel to `rows`.
 * @returns Add-points for `syncHnswForFile`, each id guaranteed defined.
 * @throws {Error} If `newIds.length !== rows.length`.
 */
export function zipHnswAddPoints(
  rows: ReadonlyArray<EmbedRowLike>,
  newIds: ReadonlyArray<number>
): Array<EmbedRowLike & { id: number }> {
  if (newIds.length !== rows.length) {
    throw new Error(
      `HNSW sync: embed-db returned ${newIds.length} ids for ${rows.length} rows — refusing to insert a sentinel label (would corrupt the index).`
    );
  }
  const points: Array<EmbedRowLike & { id: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id = newIds[i];
    if (r === undefined || id === undefined) {
      throw new Error("HNSW sync: unexpected undefined row/id during zip.");
    }
    points.push({
      id,
      vector: r.vector,
      chunkIndex: r.chunkIndex,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      textPreview: r.textPreview
    });
  }
  return points;
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private readonly vault: Vault;
  private readonly ftsIndex: FtsIndex | null;
  private readonly silent: boolean;
  private readonly includePdfs: boolean;
  // v3.8.0-rc.2 R-7 — mutable so server.ts can `attachEmbed()` after
  // HNSW context init populates embedDb + embedder. Watcher boots BEFORE
  // HNSW (so file events from boot-time edits are captured) but the
  // embed-sync feature engages once handles are available.
  private embedDb: EmbedDb | null;
  private embedder: Awaited<ReturnType<typeof loadEmbedder>> | null;
  private lateChunkContext: number;
  // v3.9.0-rc.1 — OCR-on-watch options. Mutable so server.ts can wire
  // them via setOcrPdfs() AFTER attachEmbed() runs — the embed-db opens
  // late, but the watcher boots early so file events from boot-time
  // edits are captured.
  private ocrPdfs: boolean;
  private ocrLangs: string;
  private ocrMaxPages: number | undefined;
  // v3.9.0-rc.2 — HNSW in-memory live update wiring. The watcher
  // boots before HNSW initializes (similar pattern to embedDb above),
  // so attachHnsw() is the late-binding entry point. When wired, every
  // md/pdf event that mutates embed-db also calls
  // `hnsw.applyDiff(oldIds, newPoints)` so search reflects the change
  // immediately (pre-3.9.0 the in-memory HNSW went stale until the
  // next serve restart rebuilt from the freshly-upserted embed-db).
  private hnsw: HnswIndex | null = null;
  private hnswRowsByLabel: Map<number, HnswRowMeta> | null = null;
  // v3.9.0-rc.6 — HNSW disk persistence on live update. The in-memory
  // HNSW index diverges from the persisted `.hnsw.bin` after every
  // applyDiff. Correctness is already guaranteed by the signature guard
  // (a stale `.hnsw.bin` is ignored on next serve because
  // loadHnswFromDisk recomputes the embed-db signature and rebuilds on
  // mismatch). The ONLY benefit of re-persisting is restart SPEED:
  // keeping the sidecar current avoids the ~25s rebuild on next serve.
  // We persist at watcher CLOSE time (not on a debounced during-serve
  // timer): the close-time flush delivers the restart-speed benefit
  // without timer-lifecycle complexity or mid-serve disk I/O. An
  // ungraceful SIGKILL skips the flush, but the signature guard makes
  // that safe (falls back to rebuild). `hnswPersistFile` is null when
  // `--no-hnsw-persist` was passed (no sidecar to keep current).
  private hnswPersistFile: string | null = null;
  private hnswDirty = false;
  private closed = false;
  // v3.9.0-rc.11 (audit H1) — per-file serialization. chokidar dispatches file
  // events concurrently; without this, two rapid saves to the SAME file
  // interleave their embed-db upsert + HNSW applyDiff + shared-`rowsByLabel`
  // mutation → silent index drift (ghost labels live in HNSW but absent from
  // the embed-db → stale search hits). Each event chains on the file's prior
  // handle so same-file events run strictly sequentially while different files
  // keep independent chains and stay parallel. Keyed by absolute path; entries
  // self-evict when a file's chain drains (bounded memory over a long serve).
  private readonly fileQueues = new Map<string, Promise<void>>();

  constructor(opts: WatcherOptions) {
    this.vault = opts.vault;
    this.ftsIndex = opts.ftsIndex ?? null;
    this.silent = opts.silent ?? false;
    this.includePdfs = opts.includePdfs ?? false;
    this.embedDb = opts.embedDb ?? null;
    this.embedder = opts.embedder ?? null;
    this.lateChunkContext = opts.lateChunkContext ?? 0;
    // v3.9.0-rc.1 — OCR-on-watch wiring. Constructor accepts the flags
    // but defers validation: when the watcher is built BEFORE attachEmbed
    // runs (the normal startup order in server.ts), ocrPdfs would fail
    // the embedDb-required check. Instead, the PDF event handler checks
    // `ocrPdfs && embedDb && includePdfs` at runtime and skips the OCR
    // codepath silently if any leg is missing.
    this.ocrPdfs = opts.ocrPdfs ?? false;
    this.ocrLangs = opts.ocrLangs ?? "eng";
    this.ocrMaxPages = opts.ocrMaxPages;
    // v3.8.0-rc.2 R-7 — fail loud if embedDb is wired without embedder.
    // Pre-flight check vs silently no-op'ing the embed sync.
    if (this.embedDb && !this.embedder) {
      throw new Error("VaultWatcher: embedDb wired without embedder — both must be set together");
    }
  }

  /**
   * v3.9.0-rc.1 — enable / configure OCR-on-watch after construction.
   * Called by server.ts after attachEmbed() runs (since OCR fallback
   * only makes sense once embed-db is wired). Fails loud if includePdfs
   * is off — without it, PDF events are filtered before the OCR
   * codepath runs.
   *
   * @param enabled - When true, image-only PDFs that pdfjs can't read
   *   trigger a Tesseract OCR pass; the OCR-derived text feeds the
   *   normal embed pipeline via embedSinglePdf's preExtractedPages path.
   * @param langs - Tesseract language pack (default "eng"). Multi-lang
   *   via `+`, e.g. "eng+rus".
   * @param maxPages - Page cap for OCR runs. Default 200 (DEFAULT_OCR_MAX_PAGES).
   */
  setOcrPdfs(enabled: boolean, langs?: string, maxPages?: number): void {
    if (enabled && !this.includePdfs) {
      throw new Error("VaultWatcher.setOcrPdfs: enabling OCR requires includePdfs=true at construction time");
    }
    if (enabled && !this.embedDb) {
      throw new Error("VaultWatcher.setOcrPdfs: enabling OCR requires embedDb (call attachEmbed first)");
    }
    this.ocrPdfs = enabled;
    if (langs !== undefined) this.ocrLangs = langs;
    if (maxPages !== undefined) this.ocrMaxPages = maxPages;
  }

  /**
   * v3.8.0-rc.2 R-7 — attach an embed-db handle + embedder after the
   * watcher has started. Used by `prepareServerDeps` when HNSW context
   * init completes after the watcher's initial `start()` call (HNSW
   * build can take 25s+; watcher needs to be running before that to
   * capture file edits during the boot window).
   *
   * Calling this is idempotent — if you pass the same handle twice,
   * the watcher uses the most recent one. Pass `null` for both to
   * detach (the FTS5-only sync continues).
   */
  attachEmbed(
    embedDb: EmbedDb | null,
    embedder: Awaited<ReturnType<typeof loadEmbedder>> | null,
    lateChunkContext = 0
  ): void {
    if (embedDb && !embedder) {
      throw new Error("VaultWatcher.attachEmbed: embedDb passed without embedder");
    }
    this.embedDb = embedDb;
    this.embedder = embedder;
    this.lateChunkContext = lateChunkContext;
  }

  /**
   * v3.9.0-rc.2 — wire an in-memory HNSW index for live updates. After
   * this call, every md/pdf event that mutates embed-db ALSO updates
   * the HNSW graph via `hnsw.applyDiff(oldIds, newPoints)` so search
   * results reflect the change immediately. Pre-3.9.0, the HNSW index
   * was rebuilt from embed-db only at serve startup; vault edits during
   * the session left the HNSW stale until restart, and `--use-hnsw`
   * users saw new content omitted from semantic-search results.
   *
   * Must be called AFTER `attachEmbed` (the HNSW + embed-db handles
   * share a lifecycle — server.ts opens both during HNSW init).
   *
   * @param hnsw - the in-memory HNSW index built by server.ts.
   * @param rowsByLabel - the mutable label→row map shared with
   *   `searchHybrid` (the live update writes into it so subsequent
   *   searches see the new chunks).
   * @param persistFile - v3.9.0-rc.6: optional sidecar base path
   *   (`<embed-db-without-suffix>.hnsw`). When provided AND HNSW live
   *   updates occurred, the watcher re-persists the index at close time
   *   so the next serve loads the up-to-date sidecar instead of
   *   rebuilding. Omit (or pass when `--no-hnsw-persist`) to skip
   *   persistence — correctness is unaffected (signature guard).
   */
  attachHnsw(hnsw: HnswIndex, rowsByLabel: Map<number, HnswRowMeta>, persistFile?: string): void {
    if (!this.embedDb) {
      throw new Error(
        "VaultWatcher.attachHnsw: embedDb not attached — call attachEmbed first (HNSW live update requires it)"
      );
    }
    this.hnsw = hnsw;
    this.hnswRowsByLabel = rowsByLabel;
    this.hnswPersistFile = persistFile ?? null;
  }

  /**
   * v3.9.0-rc.6 — flush the live-updated HNSW index to its disk sidecar.
   * No-op unless ALL of: the index is dirty (had ≥1 applyDiff since the
   * last flush), an index + rowsByLabel + persistFile + embedDb are all
   * wired. Recomputes the embed-db signature so the persisted
   * `.meta.json` matches what `loadHnswFromDisk` will expect on the next
   * serve (any external embed-db change since then → signature mismatch
   * → safe rebuild). Fail-soft: a save error is logged + swallowed (the
   * signature guard means a stale/missing sidecar just triggers rebuild).
   *
   * @returns true if a flush was performed, false if it was a no-op.
   */
  async flushHnswToDisk(): Promise<boolean> {
    if (!this.hnswDirty || !this.hnsw || !this.hnswRowsByLabel || !this.hnswPersistFile || !this.embedDb) {
      return false;
    }
    try {
      // v3.10.0-rc.40 (#7) — clear dirty BEFORE the await: a concurrent applyDiff that
      // re-marks dirty DURING saveTo must NOT be clobbered by a late `= false`. If it
      // stays dirty, the next serve's signature-guard rebuilds rather than trusting a
      // sidecar that predates the concurrent diff. Re-set to true on failure below.
      this.hnswDirty = false;
      const signature = this.embedDb.computeSignature();
      await this.hnsw.saveTo(this.hnswPersistFile, this.hnswRowsByLabel, signature);
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher persisted live-updated HNSW index to ${this.hnswPersistFile}.bin (+ .meta.json)\n`
        );
      }
      return true;
    } catch (err) {
      this.hnswDirty = true; // v3.10.0-rc.40 (#7) — persist failed → still dirty so a later flush retries
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher HNSW persist failed — ${err instanceof Error ? err.message : String(err)} (next serve will rebuild from embed-db; correctness unaffected)\n`
        );
      }
      return false;
    }
  }

  /**
   * v3.9.0-rc.2 — internal helper. Apply an embed-db {oldIds, newIds}
   * diff to the wired HNSW index + rowsByLabel map. Called by both the
   * md and pdf event handlers after upsertNote / deleteNote returns.
   * Fail-soft: on any error, logs to stderr and returns — the embed-db
   * is already updated, so the next serve restart will rebuild HNSW
   * from the correct state. (Same posture as the watcher's existing
   * embed-db fail-soft.)
   *
   * CONCURRENCY CONTRACT (v3.11.0-rc.9, external audit T-MED-1 re-verify): this
   * method and the `HnswIndex.applyDiff` it calls are FULLY SYNCHRONOUS — there is
   * NO `await` between `markDelete` and `addPoint`, nor around the shared
   * `hnswRowsByLabel` delete/set. On Node's single-threaded event loop that makes
   * the entire shared-state mutation an atomic critical section: two DIFFERENT-file
   * `handle()` chains can only context-switch at their `await`ed embed steps (which
   * don't touch the shared index), so they CANNOT interleave a partial apply. The
   * synchronicity IS the cross-file serialization — an explicit mutation queue would
   * be redundant. **A future edit MUST NOT introduce an `await` into this method or
   * applyDiff** (it would open a real cross-file interleave window); the per-file
   * `fileQueues` (rc.11 H1) serialize only SAME-file events, whose chains span the
   * diff-compute awaits. (Enforced by `tests/hnsw-sync-critical-section.test.ts`.)
   */
  private syncHnswForFile(
    relPath: string,
    kind: "md" | "pdf",
    oldIds: ReadonlyArray<number>,
    newRows: ReadonlyArray<{
      id: number;
      vector: Float32Array;
      chunkIndex: number;
      lineStart: number;
      lineEnd: number;
      textPreview: string;
    }>
  ): { removed: number; added: number } | null {
    if (!this.hnsw || !this.hnswRowsByLabel) return null;
    try {
      const result = this.hnsw.applyDiff(
        oldIds,
        newRows.map((r) => ({ label: r.id, vector: r.vector }))
      );
      // v3.9.0-rc.6 — mark the index dirty so close-time flushHnswToDisk
      // re-persists it. Set only after applyDiff succeeds (a thrown diff
      // leaves the on-disk sidecar as the last-known-good state).
      this.hnswDirty = true;
      // Update the rowsByLabel map: drop old, add new. The map is shared
      // with searchHybrid via reference; mutations are visible immediately.
      for (const oldId of oldIds) this.hnswRowsByLabel.delete(oldId);
      for (const r of newRows) {
        this.hnswRowsByLabel.set(r.id, {
          rel_path: relPath,
          chunk_index: r.chunkIndex,
          line_start: r.lineStart,
          line_end: r.lineEnd,
          text_preview: r.textPreview,
          kind
        });
      }
      return result;
    } catch (err) {
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher HNSW live-update failed for ${relPath} — ${err instanceof Error ? err.message : String(err)} (search results may be stale until next serve restart)\n`
        );
      }
      return null;
    }
  }

  /** Start watching. Resolves once the watcher has reported `ready`. */
  async start(): Promise<void> {
    const root = this.vault.root;
    this.watcher = chokidar.watch(root, {
      ignored: (p: string, stats?: import("node:fs").Stats) => {
        if (!stats) return false;
        // v3.7.16 P1-5 — accept `.md` always; accept `.pdf` when
        // includePdfs is on. Everything else is ignored at the file
        // level (we still let directory events through so we notice
        // when an entire folder is moved/deleted).
        if (stats.isFile()) {
          const lower = p.toLowerCase();
          const isMd = lower.endsWith(".md");
          const isPdf = lower.endsWith(".pdf");
          if (!isMd && !(this.includePdfs && isPdf)) return true;
        }
        // Skip well-known directories.
        for (const skip of SKIP_DIRS) {
          if (p.includes(`${path.sep}${skip}${path.sep}`) || p.endsWith(`${path.sep}${skip}`)) return true;
        }
        // Skip excluded-by-glob paths so the watcher doesn't reveal note
        // existence or trigger reindex of files the user marked private.
        const rel = path.relative(root, p);
        if (rel && this.vault.isExcluded(rel)) return true;
        return false;
      },
      // Don't let chokidar follow symlinks — matches the vault walker.
      followSymlinks: false,
      // Survive vault-relative paths.
      cwd: undefined,
      // Debounce noisy editors. Obsidian's autosave can fire every keystroke;
      // wait until the file's mtime is stable for 250ms before processing.
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      // Don't fire add events for the initial scan — we sync on boot already.
      ignoreInitial: true
    });

    const onChange = (absPath: string, kind: "add" | "change" | "unlink") => {
      if (this.closed) return; // v3.10.0-rc.40 (#6) — no new work once close() began
      // v3.9.0-rc.11 (H1) — serialize per file. Chain this event on the file's
      // prior handle (which always resolves — it catches its own errors) so
      // same-file events run sequentially and never interleave their embed-db
      // + HNSW mutations; different files keep independent chains → parallel.
      const prev = this.fileQueues.get(absPath) ?? Promise.resolve();
      const tail = prev
        .then(() => this.handle(absPath, kind))
        .catch((err) => {
          if (!this.silent) {
            process.stderr.write(
              `enquire: watcher error on ${path.relative(root, absPath)} (${kind}) — ${
                err instanceof Error ? err.message : String(err)
              }\n`
            );
          }
        });
      this.fileQueues.set(absPath, tail);
      // Self-evict once this is the last queued event for the file so the map
      // stays bounded. If a newer event chained after us it owns the entry.
      void tail.finally(() => {
        if (this.fileQueues.get(absPath) === tail) this.fileQueues.delete(absPath);
      });
    };

    this.watcher.on("add", (p: string) => onChange(p, "add"));
    this.watcher.on("change", (p: string) => onChange(p, "change"));
    this.watcher.on("unlink", (p: string) => onChange(p, "unlink"));

    await new Promise<void>((resolve) => {
      this.watcher?.once("ready", () => resolve());
    });
  }

  private async handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> {
    // v3.10.0-rc.40 (#6) — a chokidar event that slipped through after close() began
    // must not mutate embed-db/HNSW post-drain (belt-and-suspenders to the onChange
    // guard + the watcher being stopped first in close()).
    if (this.closed) return;
    const relPath = path.relative(this.vault.root, absPath);
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) return;
    // v3.10.0-rc.20 (audit M7) — privacy defense-in-depth. The chokidar
    // `ignored` predicate (see watch() setup) already drops excluded paths, but
    // re-check here so a `--exclude-glob` / `--read-paths`-filtered note can
    // NEVER be indexed even if handle() is reached another way (a direct call, a
    // chokidar edge case, a future caller). Mirrors the PDF re-check below.
    // v3.10.0-rc.24 (audit L) — gate only add/change (the INDEXING ops): an
    // `unlink` must always fall through to drop the file's rows, even when the
    // path is excluded — purging a deleted note's index entries is never a
    // privacy risk, and skipping it orphaned stale rows for a deleted-but-
    // excluded note (e.g. indexed before exclusion, then deleted).
    if (kind !== "unlink" && this.vault.isExcluded(relPath)) {
      if (!this.silent) {
        process.stderr.write(`enquire: watcher skip ${relPath} (excluded by privacy filter)\n`);
      }
      return;
    }
    // v3.7.16 P1-5 — dispatch by file kind. PDFs only flow through when
    // `--watch --include-pdfs` is on (the chokidar `ignored` filter
    // already gates this, but we re-check defensively).
    const isPdf = relPath.toLowerCase().endsWith(".pdf");
    if (isPdf && !this.includePdfs) return;

    if (!isPdf) {
      // Cache invalidation is the first thing we do regardless of kind. The
      // next read picks up disk state. (Cache only holds markdown notes.)
      this.vault.invalidateOne(absPath);
    }

    // v3.10.0-rc.44 (M5) — only early-return when there's NOTHING to sync (no FTS AND no
    // embed-db). Pre-rc.44 this returned whenever ftsIndex was null, silently skipping the
    // embed-db + HNSW live-update below — even though server.ts had wired attachEmbed /
    // attachHnsw and printed "watcher embed-db sync enabled" / "HNSW live-update enabled"
    // banners. Now embed/HNSW sync runs regardless of FTS; each ftsIndex call below is
    // optional-chained so a null FTS index simply skips the FTS5 reindex/drop.
    if (!this.ftsIndex && !this.embedDb) {
      if (!this.silent) {
        process.stderr.write(`enquire: watcher ${kind} ${relPath} (cache-invalidated)\n`);
      }
      return;
    }

    if (kind === "unlink") {
      this.ftsIndex?.dropFile(relPath);
      // v3.8.0-rc.2 R-7 — also drop embed-db rows so search results
      // don't surface vectors for deleted notes.
      // v3.8.0-rc.3 R-7 — extended to PDFs (rc.2 was md-only).
      // v3.9.0-rc.2 — propagate the deletion to the in-memory HNSW
      // index too via syncHnswForFile (with empty newRows = pure-delete
      // diff). Pre-3.9.0 HNSW retained deleted-file labels until next
      // serve restart; semantic-search results would surface vectors
      // for files no longer in the vault.
      let unlinkHnswNote = "";
      if (this.embedDb) {
        try {
          const deletedIds = this.embedDb.deleteNote(relPath);
          if (deletedIds.length > 0 && this.hnsw) {
            // v3.9.0-rc.11 (L2) — pass the correct kind for PDF unlinks (was
            // hardcoded "md"). Cosmetic on a pure-delete diff today since no
            // new rows are set, but correct + future-proof if the delete path
            // ever records kind.
            const result = this.syncHnswForFile(relPath, isPdf ? "pdf" : "md", deletedIds, []);
            if (result) unlinkHnswNote = ` + hnsw -${result.removed}`;
          }
        } catch (err) {
          if (!this.silent) {
            process.stderr.write(
              `enquire: watcher embed-db delete failed for ${relPath} — ${err instanceof Error ? err.message : String(err)}\n`
            );
          }
        }
      }
      if (!this.silent) {
        const embedNote = this.embedDb ? " + embed-db dropped" : "";
        process.stderr.write(`enquire: watcher unlink ${relPath} (fts5 dropped${embedNote}${unlinkHnswNote})\n`);
      }
      return;
    }

    // add / change: re-read + reindex this single file.
    try {
      const stat = await this.vault.stat(absPath);
      if (isPdf) {
        // v3.7.16 P1-5 — extract text and re-index PDF pages. Lazy
        // import to keep markdown-only deployments zero-cost.
        // v3.8.0-rc.3 R-7 — PDF embedding sync (rc.2 was md-only).
        const buf = await this.vault.readBinaryFile(absPath);
        const { extractPdfText } = await import("./pdf.js");
        const result = await extractPdfText(buf);
        const pages = result.pages.map((p) => ({ pageNumber: p.pageNumber, text: p.text }));
        this.ftsIndex?.reindexPdfFile(relPath, stat.mtimeMs, pages);
        // v3.8.0-rc.3 — embed-db sync for PDFs. Uses embedSinglePdf helper
        // to match syncPdfEmbedDb's chunking + page-marker logic exactly.
        // Image-only PDFs (hasText === false) get embed-db rows DROPPED
        // because they have no useful embedding content (same v3.7.6 H-4
        // staleness fix as bulk sync). Fail-soft: embed-db errors don't
        // fail the watcher event.
        //
        // v3.9.0-rc.1 — when `ocrPdfs` is on AND the cheap pdfjs path
        // returns hasText=false, fall back to Tesseract OCR + feed
        // OCR-derived pages through embedSinglePdf's new preExtractedPages
        // mode. Without this, scanned PDFs that change during a serve
        // session lose their embed rows + slowly degrade hybrid recall
        // until the next manual `enquire-mcp build-embeddings` run.
        let pdfEmbedNote = "";
        if (this.embedDb && this.embedder) {
          try {
            let preExtractedPages: ReadonlyArray<{ pageNumber: number; text: string }> | undefined;
            // OCR fallback path. The cheap pdfjs result already lives in
            // `result` (from the FTS5 reindex above); if it's image-only,
            // we run Tesseract + use the OCR pages directly.
            if (this.ocrPdfs && !result.hasText) {
              try {
                const { extractPdfWithOcr } = await import("./ocr.js");
                const ocrResult = await extractPdfWithOcr(buf, {
                  langs: this.ocrLangs,
                  ...(this.ocrMaxPages !== undefined ? { maxPages: this.ocrMaxPages } : {})
                });
                // Filter empty pages so we don't emit `[page: N]\n` blocks
                // that the chunker would otherwise group with surrounding
                // text. (Tesseract returns isEmpty=true for blank pages.)
                preExtractedPages = ocrResult.pages
                  .filter((p) => !p.isEmpty)
                  .map((p) => ({ pageNumber: p.pageNumber, text: p.text }));
                if (preExtractedPages.length === 0) {
                  // OCR returned zero pages with text — treat as image-only
                  // (drop rows). Don't pass empty preExtractedPages; that
                  // would short-circuit to null on the embed-pipeline side.
                  preExtractedPages = undefined;
                }
              } catch (ocrErr) {
                // OCR fails-soft. Log, then fall through to the default
                // path (which will treat the PDF as image-only and drop
                // stale rows). Common failure: tesseract.js / canvas not
                // installed, or language file missing.
                if (!this.silent) {
                  process.stderr.write(
                    `enquire: watcher PDF OCR failed for ${relPath} — ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}\n`
                  );
                }
              }
            }
            const { embedSinglePdf } = await import("./embed-pipeline.js");
            const pdfResult = await embedSinglePdf(
              this.vault,
              this.embedder,
              { relPath, absPath, mtimeMs: stat.mtimeMs },
              {
                lateChunkContext: this.lateChunkContext,
                ...(preExtractedPages ? { preExtractedPages } : {})
              }
            );
            if (pdfResult === null) {
              // Image-only or zero chunks — drop any stale embed-db rows.
              const deletedIds = this.embedDb.deleteNote(relPath);
              pdfEmbedNote = preExtractedPages
                ? " + embed-db cleared (OCR also empty)"
                : " + embed-db cleared (image-only or empty)";
              // v3.9.0-rc.2 — propagate cleared rows to HNSW live update.
              if (deletedIds.length > 0 && this.hnsw) {
                const hnswResult = this.syncHnswForFile(relPath, "pdf", deletedIds, []);
                if (hnswResult) pdfEmbedNote += ` + hnsw -${hnswResult.removed}`;
              }
            } else {
              const { oldIds, newIds } = this.embedDb.upsertNote(relPath, stat.mtimeMs, pdfResult.rows, "pdf");
              const sourceLabel = preExtractedPages ? "OCR" : "pdfjs";
              pdfEmbedNote = ` + embed-db upserted (${pdfResult.chunks} chunks, kind=pdf, src=${sourceLabel})`;
              // v3.9.0-rc.2 — keep HNSW in sync with the embed-db change.
              // The newIds array runs parallel to pdfResult.rows (same order)
              // so we can zip them into HNSW add-points by index.
              if (this.hnsw) {
                const hnswResult = this.syncHnswForFile(
                  relPath,
                  "pdf",
                  oldIds,
                  zipHnswAddPoints(pdfResult.rows, newIds)
                );
                if (hnswResult) pdfEmbedNote += ` + hnsw -${hnswResult.removed}/+${hnswResult.added}`;
              }
            }
          } catch (err) {
            if (!this.silent) {
              process.stderr.write(
                `enquire: watcher embed-db PDF sync failed for ${relPath} — ${err instanceof Error ? err.message : String(err)}\n`
              );
            }
            pdfEmbedNote = " + embed-db FAILED (see above)";
          }
        }
        if (!this.silent) {
          process.stderr.write(
            `enquire: watcher ${kind} ${relPath} (fts5 PDF reindexed, ${pages.length} pages${pdfEmbedNote})\n`
          );
        }
        return;
      }
      const note = await this.vault.readNote(absPath, stat.mtimeMs);
      const wikilinkTargets = note.parsed.wikilinks.map((w) => w.target).filter((t) => t.length > 0);
      this.ftsIndex?.reindexFile(relPath, stat.mtimeMs, note.content, wikilinkTargets, note.parsed.tags);
      // v3.8.0-rc.2 R-7 — re-embed + upsert if embed-db is wired.
      // Failures here are logged but DON'T fail the whole watcher event
      // (FTS5 update already succeeded; embed-db will resync on next bulk
      // build). Same fail-soft posture as the existing FTS5 path.
      let embedNote = "";
      if (this.embedDb && this.embedder) {
        try {
          const { embedSingleNote } = await import("./embed-pipeline.js");
          const result = await embedSingleNote(
            this.vault,
            this.embedder,
            { relPath, absPath, mtimeMs: stat.mtimeMs },
            { lateChunkContext: this.lateChunkContext }
          );
          if (result === null) {
            const deletedIds = this.embedDb.deleteNote(relPath);
            embedNote = " + embed-db cleared (empty note)";
            // v3.9.0-rc.2 — propagate cleared rows to HNSW live update.
            if (deletedIds.length > 0 && this.hnsw) {
              const hnswResult = this.syncHnswForFile(relPath, "md", deletedIds, []);
              if (hnswResult) embedNote += ` + hnsw -${hnswResult.removed}`;
            }
          } else {
            const { oldIds, newIds } = this.embedDb.upsertNote(relPath, stat.mtimeMs, result.rows);
            embedNote = ` + embed-db upserted (${result.chunks} chunks)`;
            // v3.9.0-rc.2 — keep HNSW in sync. newIds and result.rows run
            // parallel (same order), so we zip them into HNSW add-points.
            if (this.hnsw) {
              const hnswResult = this.syncHnswForFile(relPath, "md", oldIds, zipHnswAddPoints(result.rows, newIds));
              if (hnswResult) embedNote += ` + hnsw -${hnswResult.removed}/+${hnswResult.added}`;
            }
          }
        } catch (err) {
          if (!this.silent) {
            process.stderr.write(
              `enquire: watcher embed-db sync failed for ${relPath} — ${err instanceof Error ? err.message : String(err)}\n`
            );
          }
          embedNote = " + embed-db FAILED (see above)";
        }
      }
      if (!this.silent) {
        process.stderr.write(`enquire: watcher ${kind} ${relPath} (fts5 reindexed${embedNote})\n`);
      }
    } catch (err) {
      // File may have been deleted between event and our stat — drop it.
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher skip ${relPath} (${kind}) — ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // v3.10.0-rc.40 (#6) — STOP the chokidar watcher FIRST so no new file event can
    // enter the queue during the drain+flush window below (onChange + handle also
    // early-return when `closed`). Pre-rc.40 the watcher stayed live until AFTER the
    // flush, so an edit landing mid-flush could apply a live diff the just-persisted
    // sidecar didn't reflect (a lost fast-reload — the signature-guard then rebuilt).
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    // v3.9.0-rc.11 (H1) — drain in-flight per-file handlers so a pending upsert +
    // applyDiff completes and the flushed sidecar reflects it. allSettled: a failed
    // handler shouldn't block shutdown.
    await Promise.allSettled([...this.fileQueues.values()]);
    // v3.9.0-rc.6 — flush the live-updated HNSW index before shutting down so the
    // next serve loads the up-to-date sidecar. No-op if no live updates occurred or
    // persistence is disabled. Fail-soft.
    await this.flushHnswToDisk();
  }
}
