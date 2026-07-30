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

import { lstat } from "node:fs/promises";
import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { EmbedDb } from "./embed-db.js";
import type { loadEmbedder } from "./embeddings.js";
import { deriveFtsTitle, extractAliases, type FtsIndex } from "./fts5.js";
import type { HnswIndex } from "./hnsw.js";
import type { CachedNote, Vault } from "./vault.js";

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

/**
 * Mutable search-route health shared with the prepared server generation.
 *
 * A staged watcher preparation failure leaves the prior generation intact and
 * does not change these flags. A sink mutation failure is different: the
 * current route can no longer prove it matches the other enabled sinks, so the
 * affected optimization is quarantined until restart.
 */
export interface WatcherSearchHealth {
  semanticUsable: boolean;
  hnswUsable: boolean;
}

const SKIP_DIRS = [".git", ".obsidian", ".trash", "node_modules", ".DS_Store"];
const DEFAULT_ACTIVATION_PATH_LIMIT = 50_000;
const ACTIVATION_REPLAY_CONCURRENCY = 4;
const ACTIVATION_MAX_GENERATIONS = 16;
const FILE_GENERATION_ATTEMPTS = 2;

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
  /**
   * Defer filesystem-event processing until {@link VaultWatcher.activate}.
   * Production startup uses this while the embedder and optional HNSW index
   * are still being attached: events coalesce by exact path, then activation
   * derives the safe canonical final state from disk. Replay begins once every
   * configured sink attempt has finished. Off by default so callers that
   * already provide dependencies retain historical behavior.
   */
  deferActivation?: boolean;
  /**
   * Maximum number of distinct paths retained while activation is deferred.
   * Repeated events for one path coalesce and do not consume another slot.
   * Exceeding the limit fails activation closed instead of silently dropping
   * a boot-window change. Primarily configurable for deterministic tests.
   */
  activationPathLimit?: number;
}

/** Row shape shared by `embedSingleNote` / `embedSinglePdf` results. */
interface EmbedRowLike {
  vector: Float32Array;
  chunkIndex: number;
  lineStart: number;
  lineEnd: number;
  textPreview: string;
}

/** Filesystem identity captured around one staged watcher update. */
interface FileGeneration {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mtimeMs: number;
}

interface StagedEmbedResult {
  chunks: number;
  rows: EmbedRowLike[];
}

interface StagedMarkdownGeneration {
  note: CachedNote;
  embedResult: StagedEmbedResult | null | undefined;
}

interface StagedPdfGeneration {
  pages: ReadonlyArray<{ pageNumber: number; text: string }>;
  embedResult: StagedEmbedResult | null | undefined;
  embedSource: "OCR" | "pdfjs" | null;
}

/**
 * Convert nanoseconds to the same millisecond shape as ordinary `fs.Stats`.
 *
 * Splitting seconds from the sub-second remainder before either BigInt becomes
 * a Number avoids losing low nanosecond bits at epoch-scale magnitudes.
 *
 * @param mtimeNs - Filesystem modification time in nanoseconds.
 * @returns Milliseconds compatible with `Stats.mtimeMs`.
 */
export function statsMtimeMsFromNs(mtimeNs: bigint): number {
  const wholeSeconds = mtimeNs / 1_000_000_000n;
  const remainderNs = mtimeNs % 1_000_000_000n;
  return Number(wholeSeconds) * 1000 + Number(remainderNs) / 1_000_000;
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
 * and skips the HNSW update for that file. The surrounding embed-sync catch
 * permanently disables sidecar persistence for that watcher generation, so the
 * next serve rebuilds instead of trusting a stale graph under a fresh database
 * signature. A corrupt sentinel label is never inserted.
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
  /** Live route-health object shared by reference with search handlers. */
  readonly searchHealth: WatcherSearchHealth = {
    semanticUsable: true,
    hnswUsable: true
  };
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
  // Once an in-memory HNSW diff throws, its exact graph state is no longer
  // provable. Never persist that graph with a fresh EmbedDb signature: doing so
  // would make the next serve trust a partial sidecar instead of rebuilding.
  // This latch is deliberately permanent for the watcher generation.
  private hnswPersistUnsafe = false;
  // v3.12.0-rc.25 — production starts chokidar before the embedder/HNSW
  // startup path completes. While deferred, retain each exact absolute path
  // whose FINAL on-disk state must be reconciled. Native event order is not an
  // authority (replacement saves can deliver unlink after add/change). Exact
  // identity matters: folding case or Unicode would merge genuinely distinct
  // files on case-sensitive filesystems.
  private activationState: "capturing" | "activating" | "live";
  private readonly deferredActivation: boolean;
  private readonly activationPathLimit: number;
  private readonly activationPaths = new Set<string>();
  // Exact source_state keys that no longer appear in the live listing. Keep
  // these separate from filesystem paths: on Windows, legacy separators or
  // normalized `.` aliases can resolve to the same absolute path as the new
  // canonical spelling, while the old exact SQLite key still needs purging.
  private readonly activationStoredIdentities = new Map<string, "md" | "pdf">();
  private activationOverflowed = false;
  private activationPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;
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
    this.deferredActivation = opts.deferActivation === true;
    this.activationState = this.deferredActivation ? "capturing" : "live";
    this.activationPathLimit = opts.activationPathLimit ?? DEFAULT_ACTIVATION_PATH_LIMIT;
    if (!Number.isSafeInteger(this.activationPathLimit) || this.activationPathLimit < 1) {
      throw new Error("VaultWatcher: activationPathLimit must be a positive safe integer");
    }
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
    this.assertLateAttachmentAllowed("setOcrPdfs");
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
    this.assertLateAttachmentAllowed("attachEmbed");
    if (embedDb && !embedder) {
      throw new Error("VaultWatcher.attachEmbed: embedDb passed without embedder");
    }
    this.embedDb = embedDb;
    this.embedder = embedder;
    this.lateChunkContext = lateChunkContext;
  }

  /**
   * Capture source-state drift that predates chokidar's `ready` event.
   *
   * Chokidar runs with `ignoreInitial:true`, so a file created while its first
   * scan is in progress can be classified as initial state and emit no native
   * `add`. Once EmbedDb is attached, compare its exact path/mtime declarations
   * with the current privacy-filtered vault listing and feed every mismatch
   * through the same bounded final-state activation set. PDF mismatches are
   * included only when PDF watching is enabled, so activation still uses the
   * configured OCR path rather than a separate bulk-PDF implementation.
   *
   * @returns A promise that resolves after the current source-state snapshot
   *   has been represented in the activation set.
   * @throws {Error} If called after activation or while closing.
   * @example
   * watcher.attachEmbed(db, embedder);
   * await watcher.captureAttachedSinkDrift();
   * await watcher.activate();
   */
  async captureAttachedSinkDrift(): Promise<void> {
    if (this.closing || this.closed || this.activationState !== "capturing") {
      throw new Error("VaultWatcher.captureAttachedSinkDrift: activation is already live or watcher is closing");
    }
    const embedDb = this.embedDb;
    if (!embedDb) return;

    const captureKind = async (
      kind: "md" | "pdf",
      entries: ReadonlyArray<{ relPath: string; absPath: string; mtimeMs: number }>
    ): Promise<void> => {
      const known = new Map(embedDb.getSourceStates(kind).map((state) => [state.rel_path, state.mtime_ms]));
      const live = new Set<string>();
      for (const entry of entries) {
        live.add(entry.relPath);
        if (known.get(entry.relPath) !== entry.mtimeMs) {
          this.captureActivationPath(entry.absPath);
        }
      }
      for (const relPath of known.keys()) {
        if (!live.has(relPath)) this.captureActivationStoredIdentity(relPath, kind);
      }
    };

    await captureKind("md", await this.vault.listMarkdown());
    if (this.includePdfs) {
      await captureKind("pdf", await this.vault.listFilesByExtension(".pdf"));
    }
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
    this.assertLateAttachmentAllowed("attachHnsw");
    if (!this.embedDb) {
      throw new Error(
        "VaultWatcher.attachHnsw: embedDb not attached — call attachEmbed first (HNSW live update requires it)"
      );
    }
    this.hnsw = hnsw;
    this.hnswRowsByLabel = rowsByLabel;
    this.hnswPersistFile = persistFile ?? null;
    this.searchHealth.hnswUsable = true;
  }

  /**
   * Keep deferred startup sinks immutable once activation has begun.
   *
   * Historical non-deferred watchers retain their late-binding behavior.
   *
   * @param method - Public attachment method used for the diagnostic.
   */
  private assertLateAttachmentAllowed(method: string): void {
    if (this.deferredActivation && this.activationState !== "capturing") {
      throw new Error(`VaultWatcher.${method}: deferred attachments are closed once activation begins`);
    }
  }

  /**
   * v3.9.0-rc.6 — flush the live-updated HNSW index to its disk sidecar.
   * No-op unless ALL of: the index is dirty (had ≥1 applyDiff since the
   * last flush), an index + rowsByLabel + persistFile + embedDb are all
   * wired. Recomputes the embed-db signature so the persisted
   * `.meta.json` matches what `loadHnswFromDisk` will expect on the next
   * serve (any external embed-db change since then → signature mismatch
   * → safe rebuild). Permanently skips persistence after any live HNSW diff
   * failure, leaving the older signature behind so restart must rebuild rather
   * than blessing a partial graph as current. Fail-soft: a save error is logged
   * + swallowed (the signature guard means a stale/missing sidecar rebuilds).
   *
   * @returns true if a flush was performed, false if it was a no-op.
   */
  async flushHnswToDisk(): Promise<boolean> {
    if (
      this.hnswPersistUnsafe ||
      !this.hnswDirty ||
      !this.hnsw ||
      !this.hnswRowsByLabel ||
      !this.hnswPersistFile ||
      !this.embedDb
    ) {
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
   * Live events remain fail-soft: on any error, log and return. Activation
   * replay rethrows after arming the persistence latch so the startup interlock
   * cannot release a process with an uncertain in-memory graph.
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
      // applyDiff may have mutated only part of the native graph before
      // throwing. Even if an earlier/later successful diff marked the index
      // dirty, never save this uncertain graph with the current EmbedDb
      // signature: that would defeat the restart signature guard.
      this.hnswPersistUnsafe = true;
      this.searchHealth.hnswUsable = false;
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher HNSW live-update failed for ${relPath} — ${err instanceof Error ? err.message : String(err)} (HNSW quarantined; semantic search falls back to EmbedDb until restart)\n`
        );
      }
      if (this.activationState === "activating") throw err;
      return null;
    }
  }

  /**
   * Chain one task behind prior work for the same exact path.
   *
   * @param absPath - Absolute path supplied by chokidar or activation replay.
   * @param context - Short diagnostic context appended to watcher errors.
   * @param task - Filesystem reconciliation task to serialize.
   * @param propagateFailure - Reject the tail instead of absorbing a handler
   *   error. Activation replay uses this to keep the startup interlock armed.
   * @returns The per-path queue tail.
   */
  private enqueueFileTask(
    absPath: string,
    context: string,
    task: () => Promise<void>,
    propagateFailure = false
  ): Promise<void> {
    const prev = this.fileQueues.get(absPath) ?? Promise.resolve();
    const run = prev.then(task);
    const tail = propagateFailure
      ? run
      : run.catch((err) => {
          if (!this.silent) {
            process.stderr.write(
              `enquire: watcher error on ${this.vault.toRel(absPath)} ${context} — ${
                err instanceof Error ? err.message : String(err)
              }\n`
            );
          }
        });
    this.fileQueues.set(absPath, tail);
    // Self-evict once this is the last queued event for the file so the map
    // stays bounded. If a newer event chained after us it owns the entry.
    const evict = () => {
      if (this.fileQueues.get(absPath) === tail) this.fileQueues.delete(absPath);
    };
    void tail.then(evict, evict);
    return tail;
  }

  /**
   * Chain one native event behind prior work for the same exact path.
   *
   * @param absPath - Absolute path supplied by chokidar.
   * @param kind - Filesystem event kind to apply.
   * @param propagateFailure - Reject activation replay on reconciliation error.
   * @returns The per-path queue tail.
   */
  private enqueueFileEvent(
    absPath: string,
    kind: "add" | "change" | "unlink",
    propagateFailure = false
  ): Promise<void> {
    return this.enqueueFileTask(absPath, `(${kind})`, () => this.handle(absPath, kind), propagateFailure);
  }

  /**
   * Record one boot-window path without preserving noisy native event order.
   *
   * @param absPath - Absolute path whose final state must be replayed.
   */
  private captureActivationPath(absPath: string): void {
    if (this.activationPaths.has(absPath)) return;
    if (this.activationPaths.size + this.activationStoredIdentities.size >= this.activationPathLimit) {
      this.activationOverflowed = true;
      return;
    }
    this.activationPaths.add(absPath);
  }

  /**
   * Capture one exact stale source-state key without resolving it through the
   * host filesystem's separator/case rules.
   *
   * @param relPath - Exact persisted EmbedDb source_state key.
   * @param kind - Stored content-source kind.
   */
  private captureActivationStoredIdentity(relPath: string, kind: "md" | "pdf"): void {
    if (this.activationStoredIdentities.has(relPath)) return;
    if (this.activationPaths.size + this.activationStoredIdentities.size >= this.activationPathLimit) {
      this.activationOverflowed = true;
      return;
    }
    this.activationStoredIdentities.set(relPath, kind);
  }

  /**
   * Purge an exact persisted key from every attached derived sink.
   *
   * This deliberately performs no filesystem resolution or read: the identity
   * originates in EmbedDb source_state and may use a legacy path spelling.
   *
   * @param relPath - Exact stored identity to remove.
   * @param kind - Stored content-source kind for HNSW metadata.
   */
  private async purgeStoredIdentity(relPath: string, kind: "md" | "pdf"): Promise<void> {
    try {
      this.ftsIndex?.dropFile(relPath);
      if (this.embedDb) {
        const deletedIds = this.embedDb.deleteNote(relPath);
        if (deletedIds.length > 0 && this.hnsw) {
          this.syncHnswForFile(relPath, kind, deletedIds, []);
        }
      }
    } catch (err) {
      this.searchHealth.semanticUsable = false;
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher stored-identity purge failed for ${relPath} — ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
      throw err;
    }
  }

  /**
   * Apply exact stored-key purges with the same startup concurrency bound.
   *
   * @param identities - Exact persisted keys and source kinds.
   */
  private async applyStoredIdentityPurges(identities: ReadonlyArray<readonly [string, "md" | "pdf"]>): Promise<void> {
    for (let offset = 0; offset < identities.length; offset += ACTIVATION_REPLAY_CONCURRENCY) {
      if (this.activationOverflowed) return;
      const chunk = identities.slice(offset, offset + ACTIVATION_REPLAY_CONCURRENCY);
      await Promise.all(chunk.map(([relPath, kind]) => this.purgeStoredIdentity(relPath, kind)));
    }
  }

  /**
   * Dispatch one native event into either the activation buffer or the live
   * per-file queue. Kept as a method so deterministic tests can exercise the
   * lifecycle without depending on chokidar delivery timing.
   *
   * @param absPath - Absolute event path.
   * @param kind - Native event kind.
   */
  private onFsEvent(absPath: string, kind: "add" | "change" | "unlink"): void {
    if (this.closing || this.closed) return;
    if (this.activationState !== "live") {
      this.captureActivationPath(absPath);
      return;
    }
    void this.enqueueFileEvent(absPath, kind);
  }

  /**
   * Resolve the safe final-state operations for one captured path.
   *
   * @param absPath - Absolute path captured during startup.
   * @returns Exact stale identities to purge and, when present, the canonical
   *   on-disk identity to upsert.
   */
  private async activationPlan(absPath: string): Promise<{ purge: ReadonlyArray<string>; upsert: string | null }> {
    const nativeRelPath = path.relative(this.vault.root, absPath);
    if (!nativeRelPath || nativeRelPath.startsWith("..") || path.isAbsolute(nativeRelPath)) {
      return { purge: [], upsert: null };
    }
    try {
      // Never let final-state reconciliation follow a symlink or junction.
      // lstat observes the captured leaf itself; canonicalization below is
      // reached only for a regular file.
      const stat = await lstat(absPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { purge: [absPath], upsert: null };
      }
      const canonicalRel = await this.vault.canonicalRelForPrivacyCheckPublic(absPath);
      const canonicalAbs = this.vault.resolveInside(canonicalRel);
      if (this.vault.isExcluded(canonicalRel)) {
        return {
          purge: canonicalAbs === absPath ? [absPath] : [absPath, canonicalAbs],
          upsert: null
        };
      }
      return {
        purge: canonicalAbs === absPath ? [] : [absPath],
        upsert: canonicalAbs
      };
    } catch {
      // Missing, inaccessible, unsafe, or escaping paths must not retain stale
      // searchable rows. The exact captured identity is safe to purge without
      // reading or following the path.
      return { purge: [absPath], upsert: null };
    }
  }

  /**
   * Resolve activation plans without launching one filesystem/realpath task per
   * captured file at once.
   *
   * @param paths - Exact captured paths in deterministic insertion order.
   * @returns One final-state plan per path, in the same order.
   */
  private async planActivationPaths(
    paths: ReadonlyArray<string>
  ): Promise<Array<{ purge: ReadonlyArray<string>; upsert: string | null }>> {
    const plans: Array<{ purge: ReadonlyArray<string>; upsert: string | null }> = [];
    for (let offset = 0; offset < paths.length; offset += ACTIVATION_REPLAY_CONCURRENCY) {
      if (this.activationOverflowed) break;
      const chunk = paths.slice(offset, offset + ACTIVATION_REPLAY_CONCURRENCY);
      plans.push(...(await Promise.all(chunk.map((absPath) => this.activationPlan(absPath)))));
    }
    return plans;
  }

  /**
   * Apply one deduplicated activation phase with bounded concurrency.
   *
   * @param paths - Exact identities to reconcile.
   * @param kind - Purge (`unlink`) or final-state upsert (`change`).
   */
  private async applyActivationPaths(paths: ReadonlyArray<string>, kind: "change" | "unlink"): Promise<void> {
    for (let offset = 0; offset < paths.length; offset += ACTIVATION_REPLAY_CONCURRENCY) {
      if (this.activationOverflowed) return;
      const chunk = paths.slice(offset, offset + ACTIVATION_REPLAY_CONCURRENCY);
      await Promise.all(chunk.map((absPath) => this.enqueueFileEvent(absPath, kind, true)));
    }
  }

  /**
   * Activate live event processing and replay every path captured while
   * production dependencies were attaching. Repeated events for one exact path
   * coalesce, then each generation derives current disk state rather than
   * trusting noisy native add/change/unlink ordering. Events received during a
   * generation form the next generation. Canonical upserts are deduplicated so
   * a case-only rename cannot race the same EmbedDb/HNSW identity through two
   * different queue keys.
   *
   * Activation fails closed if the distinct-path bound was exceeded. The
   * server must not begin serving from a potentially stale partial snapshot;
   * production keeps its process-restart activation interlock armed so a later
   * serve cannot publish the derived indexes until explicit recovery.
   *
   * @returns A promise that resolves after all captured paths and their
   *   per-file queues drain. Repeated calls share the same activation.
   */
  async activate(): Promise<void> {
    if (this.closed) {
      throw new Error("VaultWatcher.activate: watcher is closing or closed");
    }
    if (this.activationPromise) return this.activationPromise;
    if (this.closing) {
      throw new Error("VaultWatcher.activate: watcher is closing or closed");
    }
    if (this.activationState === "live") return;

    this.activationPromise = (async () => {
      this.activationState = "activating";
      let generation = 0;
      while (true) {
        if (this.activationOverflowed) {
          throw new Error(
            `VaultWatcher activation captured more than ${this.activationPathLimit} distinct paths — refusing to serve with potentially stale indexes; stop vault writers and rebuild the derived indexes before retrying`
          );
        }

        // This empty-check + live assignment is the linearization point. There
        // is no await between them, so every earlier event is in a completed
        // generation and every later event enters the normal live queue.
        if (this.activationPaths.size === 0 && this.activationStoredIdentities.size === 0) {
          this.activationState = "live";
          return;
        }
        if (generation >= ACTIVATION_MAX_GENERATIONS) {
          throw new Error(
            `VaultWatcher activation did not quiesce after ${ACTIVATION_MAX_GENERATIONS} generations — refusing to serve with potentially stale indexes; retry after the vault becomes quiet`
          );
        }
        generation += 1;

        const captured = [...this.activationPaths];
        const storedIdentities = [...this.activationStoredIdentities.entries()];
        this.activationPaths.clear();
        this.activationStoredIdentities.clear();
        const plans = await this.planActivationPaths(captured);
        if (this.activationOverflowed) continue;

        const purge = new Set<string>();
        const upsert = new Set<string>();
        for (const plan of plans) {
          for (const absPath of plan.purge) purge.add(absPath);
          if (plan.upsert) upsert.add(plan.upsert);
        }
        // A canonical identity that exists at planning time wins over a stale
        // alias purge from another native event in the same generation.
        for (const absPath of upsert) purge.delete(absPath);

        // Purge exact legacy SQLite identities and stale physical spellings
        // first, then upsert each canonical final identity once. Batches are
        // awaited, keeping planning + replay bounded to four active tasks.
        await this.applyStoredIdentityPurges(storedIdentities);
        await this.applyActivationPaths([...purge], "unlink");
        await this.applyActivationPaths([...upsert], "change");
      }
    })();

    return this.activationPromise;
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

    this.watcher.on("add", (p: string) => this.onFsEvent(p, "add"));
    this.watcher.on("change", (p: string) => this.onFsEvent(p, "change"));
    this.watcher.on("unlink", (p: string) => this.onFsEvent(p, "unlink"));

    await new Promise<void>((resolve) => {
      this.watcher?.once("ready", () => resolve());
    });
  }

  /**
   * Capture the physical file generation that brackets staged watcher work.
   *
   * Nanosecond timestamps plus device/inode/size distinguish in-place writes
   * and same-path atomic replacement without folding path identities. The
   * public source-state mtime remains a millisecond number for schema
   * compatibility.
   *
   * @param absPath - Canonical in-vault file path.
   * @returns A regular, non-symlink leaf generation.
   * @throws {Error} If the leaf is missing, not a regular file, or a symlink.
   */
  private async captureFileGeneration(absPath: string): Promise<FileGeneration> {
    const stat = await lstat(absPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`watcher source is not a regular file: ${this.vault.toRel(absPath)}`);
    }
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      mtimeMs: statsMtimeMsFromNs(stat.mtimeNs)
    };
  }

  /**
   * Compare two filesystem generations without normalizing their path.
   *
   * @param left - Generation captured before staged work.
   * @param right - Generation captured immediately before synchronous commit.
   * @returns True only when every physical generation field is unchanged.
   */
  private sameFileGeneration(left: FileGeneration, right: FileGeneration): boolean {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    );
  }

  /**
   * Revalidate a staged generation. A missing/replaced/inaccessible leaf is a
   * mismatch, not a commit error: the bounded retry derives latest disk state.
   *
   * @param absPath - Canonical in-vault path.
   * @param expected - Generation used for staged lexical/semantic work.
   * @returns True when the leaf is still exactly the staged generation.
   */
  private async fileGenerationIsCurrent(absPath: string, expected: FileGeneration): Promise<boolean> {
    try {
      return this.sameFileGeneration(expected, await this.captureFileGeneration(absPath));
    } catch {
      return false;
    }
  }

  /**
   * Derive markdown lexical input and optional embeddings from one note
   * snapshot. No index mutation happens here.
   *
   * @param absPath - Canonical note path.
   * @param relPath - Public vault-relative note path.
   * @param generation - Captured filesystem generation.
   * @returns Staged work, or undefined when embedding preparation failed.
   */
  private async stageMarkdownGeneration(
    absPath: string,
    relPath: string,
    generation: FileGeneration
  ): Promise<StagedMarkdownGeneration | undefined> {
    this.vault.invalidateOne(absPath);
    const note = await this.vault.readNote(absPath, generation.mtimeMs);
    let embedResult: StagedEmbedResult | null | undefined;
    if (this.embedDb && this.embedder) {
      try {
        const { embedSingleNote } = await import("./embed-pipeline.js");
        embedResult = await embedSingleNote(
          this.vault,
          this.embedder,
          { relPath, absPath, mtimeMs: generation.mtimeMs },
          { lateChunkContext: this.lateChunkContext, preReadNote: note }
        );
      } catch (err) {
        // Keep the previous lexical + semantic generation together when
        // embedding preparation fails. The watcher remains fail-soft: it logs
        // and waits for the next event/bulk reconciliation instead of throwing.
        if (!this.silent) {
          process.stderr.write(
            `enquire: watcher embed-db sync failed for ${relPath} — ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
        if (this.activationState === "activating") throw err;
        return undefined;
      }
    }
    return { note, embedResult };
  }

  /**
   * Derive PDF lexical pages and optional embeddings from one binary snapshot.
   * OCR, when enabled, consumes the same captured bytes. No index mutation
   * happens here.
   *
   * @param absPath - Canonical PDF path.
   * @param relPath - Public vault-relative PDF path.
   * @param generation - Captured filesystem generation.
   * @returns Staged work, or undefined when embedding preparation failed.
   */
  private async stagePdfGeneration(
    absPath: string,
    relPath: string,
    generation: FileGeneration
  ): Promise<StagedPdfGeneration | undefined> {
    const buf = await this.vault.readBinaryFile(absPath);
    const { extractPdfText } = await import("./pdf.js");
    const extracted = await extractPdfText(buf);
    const pages = extracted.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text }));
    let embedResult: StagedEmbedResult | null | undefined;
    let embedSource: "OCR" | "pdfjs" | null = null;

    if (this.embedDb && this.embedder) {
      try {
        let pagesForEmbed: ReadonlyArray<{ pageNumber: number; text: string }> = extracted.hasText ? pages : [];
        if (this.ocrPdfs && !extracted.hasText) {
          try {
            const { extractPdfWithOcr } = await import("./ocr.js");
            const ocrResult = await extractPdfWithOcr(buf, {
              langs: this.ocrLangs,
              ...(this.ocrMaxPages !== undefined ? { maxPages: this.ocrMaxPages } : {})
            });
            pagesForEmbed = ocrResult.pages
              .filter((page) => !page.isEmpty)
              .map((page) => ({ pageNumber: page.pageNumber, text: page.text }));
          } catch (ocrErr) {
            // OCR remains fail-soft. The same captured pdfjs pages still feed
            // FTS, while an image-only semantic generation is staged as empty.
            if (!this.silent) {
              process.stderr.write(
                `enquire: watcher PDF OCR failed for ${relPath} — ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}\n`
              );
            }
            pagesForEmbed = [];
          }
        }

        if (pagesForEmbed.length === 0) {
          embedResult = null;
        } else {
          const { embedSinglePdf } = await import("./embed-pipeline.js");
          embedResult = await embedSinglePdf(
            this.vault,
            this.embedder,
            { relPath, absPath, mtimeMs: generation.mtimeMs },
            {
              lateChunkContext: this.lateChunkContext,
              preExtractedPages: pagesForEmbed
            }
          );
          embedSource = extracted.hasText ? "pdfjs" : "OCR";
        }
      } catch (err) {
        if (!this.silent) {
          process.stderr.write(
            `enquire: watcher embed-db PDF sync failed for ${relPath} — ${
              err instanceof Error ? err.message : String(err)
            }\n`
          );
        }
        if (this.activationState === "activating") throw err;
        return undefined;
      }
    }

    return { pages, embedResult, embedSource };
  }

  /**
   * Commit one staged markdown generation synchronously. There is no await
   * between the independent SQLite/HNSW mutations, so a tool request cannot
   * observe an ordinary successful commit halfway through.
   *
   * @param relPath - Public vault-relative note path.
   * @param generation - Revalidated source generation.
   * @param staged - Lexical and optional semantic work from that generation.
   * @returns A log suffix on success, or undefined after a fail-soft error.
   */
  private commitMarkdownGeneration(
    relPath: string,
    generation: FileGeneration,
    staged: StagedMarkdownGeneration
  ): string | undefined {
    try {
      const wikilinkTargets = staged.note.parsed.wikilinks
        .map((link) => link.target)
        .filter((target) => target.length > 0);
      this.ftsIndex?.reindexFile(
        relPath,
        generation.mtimeMs,
        staged.note.content,
        wikilinkTargets,
        staged.note.parsed.tags,
        deriveFtsTitle(relPath),
        extractAliases(staged.note.parsed.frontmatter)
      );

      let embedNote = "";
      if (this.embedDb && staged.embedResult !== undefined) {
        if (staged.embedResult === null) {
          const deletedIds = this.embedDb.deleteNote(relPath);
          embedNote = " + embed-db cleared (empty note)";
          if (deletedIds.length > 0 && this.hnsw) {
            const hnswResult = this.syncHnswForFile(relPath, "md", deletedIds, []);
            if (hnswResult) embedNote += ` + hnsw -${hnswResult.removed}`;
          }
        } else {
          const { oldIds, newIds } = this.embedDb.upsertNote(
            relPath,
            generation.mtimeMs,
            staged.embedResult.rows
          );
          embedNote = ` + embed-db upserted (${staged.embedResult.chunks} chunks)`;
          if (this.hnsw) {
            const hnswResult = this.syncHnswForFile(
              relPath,
              "md",
              oldIds,
              zipHnswAddPoints(staged.embedResult.rows, newIds)
            );
            if (hnswResult) embedNote += ` + hnsw -${hnswResult.removed}/+${hnswResult.added}`;
          }
        }
      }
      return embedNote;
    } catch (err) {
      this.searchHealth.semanticUsable = false;
      if (this.hnsw) this.hnswPersistUnsafe = true;
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher generation commit failed for ${relPath} — ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
      if (this.activationState === "activating") throw err;
      return undefined;
    }
  }

  /**
   * Commit one staged PDF generation synchronously.
   *
   * @param relPath - Public vault-relative PDF path.
   * @param generation - Revalidated source generation.
   * @param staged - PDF pages and optional semantic work from that generation.
   * @returns A log suffix on success, or undefined after a fail-soft error.
   */
  private commitPdfGeneration(
    relPath: string,
    generation: FileGeneration,
    staged: StagedPdfGeneration
  ): string | undefined {
    try {
      this.ftsIndex?.reindexPdfFile(relPath, generation.mtimeMs, staged.pages);
      let embedNote = "";
      if (this.embedDb && staged.embedResult !== undefined) {
        if (staged.embedResult === null) {
          const deletedIds = this.embedDb.deleteNote(relPath);
          embedNote =
            staged.embedSource === "OCR"
              ? " + embed-db cleared (OCR also empty)"
              : " + embed-db cleared (image-only or empty)";
          if (deletedIds.length > 0 && this.hnsw) {
            const hnswResult = this.syncHnswForFile(relPath, "pdf", deletedIds, []);
            if (hnswResult) embedNote += ` + hnsw -${hnswResult.removed}`;
          }
        } else {
          const { oldIds, newIds } = this.embedDb.upsertNote(
            relPath,
            generation.mtimeMs,
            staged.embedResult.rows,
            "pdf"
          );
          embedNote = ` + embed-db upserted (${staged.embedResult.chunks} chunks, kind=pdf, src=${
            staged.embedSource ?? "pdfjs"
          })`;
          if (this.hnsw) {
            const hnswResult = this.syncHnswForFile(
              relPath,
              "pdf",
              oldIds,
              zipHnswAddPoints(staged.embedResult.rows, newIds)
            );
            if (hnswResult) embedNote += ` + hnsw -${hnswResult.removed}/+${hnswResult.added}`;
          }
        }
      }
      return embedNote;
    } catch (err) {
      this.searchHealth.semanticUsable = false;
      if (this.hnsw) this.hnswPersistUnsafe = true;
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher PDF generation commit failed for ${relPath} — ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
      if (this.activationState === "activating") throw err;
      return undefined;
    }
  }

  private async handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> {
    // v3.10.0-rc.40 (#6) — a chokidar event that slipped through after close() began
    // must not mutate embed-db/HNSW post-drain (belt-and-suspenders to the onChange
    // guard + the watcher being stopped first in close()).
    if (this.closed) return;
    const nativeRelPath = path.relative(this.vault.root, absPath);
    if (!nativeRelPath || nativeRelPath.startsWith("..") || path.isAbsolute(nativeRelPath)) return;
    const relPath = this.vault.toRel(absPath);
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
      let embedDeleteSucceeded = this.embedDb === null;
      if (this.embedDb) {
        try {
          const deletedIds = this.embedDb.deleteNote(relPath);
          embedDeleteSucceeded = true;
          if (deletedIds.length > 0 && this.hnsw) {
            // v3.9.0-rc.11 (L2) — pass the correct kind for PDF unlinks (was
            // hardcoded "md"). Cosmetic on a pure-delete diff today since no
            // new rows are set, but correct + future-proof if the delete path
            // ever records kind.
            const result = this.syncHnswForFile(relPath, isPdf ? "pdf" : "md", deletedIds, []);
            if (result) unlinkHnswNote = ` + hnsw -${result.removed}`;
          }
        } catch (err) {
          this.searchHealth.semanticUsable = false;
          if (!this.silent) {
            process.stderr.write(
              `enquire: watcher embed-db delete failed for ${relPath} — ${err instanceof Error ? err.message : String(err)}\n`
            );
          }
          if (this.activationState === "activating") throw err;
        }
      }
      if (!this.silent) {
        const embedNote = this.embedDb
          ? embedDeleteSucceeded
            ? " + embed-db dropped"
            : " + embed-db QUARANTINED (delete failed)"
          : "";
        process.stderr.write(`enquire: watcher unlink ${relPath} (fts5 dropped${embedNote}${unlinkHnswNote})\n`);
      }
      return;
    }

    // Add/change: derive every enabled sink from one physical generation.
    // All awaited preparation finishes before any store mutation; a final
    // lstat revalidation either authorizes one run-to-completion commit or
    // retries the latest disk generation once.
    try {
      for (let attempt = 0; attempt < FILE_GENERATION_ATTEMPTS; attempt += 1) {
        const generation = await this.captureFileGeneration(absPath);
        const staged = isPdf
          ? await this.stagePdfGeneration(absPath, relPath, generation)
          : await this.stageMarkdownGeneration(absPath, relPath, generation);
        if (staged === undefined) return;

        if (!(await this.fileGenerationIsCurrent(absPath, generation))) {
          if (attempt + 1 < FILE_GENERATION_ATTEMPTS) continue;
          const error = new Error(
            `source changed during both preparation attempts; keeping the previous indexed generation`
          );
          if (this.activationState === "activating") throw error;
          if (!this.silent) {
            process.stderr.write(
              `enquire: watcher skip ${relPath} (${kind}) — ${error.message}\n`
            );
          }
          return;
        }

        const commitNote = isPdf
          ? this.commitPdfGeneration(relPath, generation, staged as StagedPdfGeneration)
          : this.commitMarkdownGeneration(relPath, generation, staged as StagedMarkdownGeneration);
        if (commitNote === undefined) return;

        if (!this.silent) {
          const sinkLabel = isPdf
            ? `fts5 PDF reindexed, ${(staged as StagedPdfGeneration).pages.length} pages`
            : "fts5 reindexed";
          process.stderr.write(
            `enquire: watcher ${kind} ${relPath} (${sinkLabel}${commitNote})\n`
          );
        }
        return;
      }
    } catch (err) {
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher skip ${relPath} (${kind}) — ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
      if (this.activationState === "activating") throw err;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // D-46: a normal close before the explicit server barrier still owns the
    // work it accepted. Begin activation synchronously so its replay tails are
    // installed before `closing` rejects any later event. An overflow already
    // known at entry rejects before first replay; a later generation failure is
    // still surfaced by close and remains quarantined by production's guard.
    if (!this.activationPromise && this.activationState === "capturing") {
      const activation = this.activate();
      void activation.catch(() => {});
    }
    // Reject new native events synchronously. Accepted handlers deliberately
    // keep running while `closing` is true; only `closed` makes handle() stop.
    this.closing = true;
    this.closePromise = (async () => {
      let watcherCloseError: unknown;
      let watcherCloseFailed = false;
      try {
        // v3.10.0-rc.40 (#6) — stop chokidar before draining so no new
        // event can enter the queue during the flush window.
        if (this.watcher) {
          try {
            await this.watcher.close();
          } catch (err) {
            // Keep draining accepted work even if the native watcher reports
            // a close failure; surface that failure only after cleanup.
            watcherCloseError = err;
            watcherCloseFailed = true;
          }
          this.watcher = null;
        }
        let activationError: unknown;
        if (this.activationPromise) {
          // Accepted activation work must finish before shutdown returns. Keep
          // its rejection so overflow/churn cannot masquerade as a clean close.
          try {
            await this.activationPromise;
          } catch (err) {
            activationError = err;
          }
        }
        // v3.9.0-rc.11 (H1) — drain every accepted per-file tail so a pending
        // upsert + applyDiff completes before the sidecar flush.
        await Promise.allSettled([...this.fileQueues.values()]);
        // v3.9.0-rc.6 — persist the fully drained live-updated index.
        if (activationError === undefined) {
          await this.flushHnswToDisk();
        }
        if (activationError !== undefined) throw activationError;
      } finally {
        this.activationPaths.clear();
        this.activationStoredIdentities.clear();
        this.closed = true;
      }
      if (watcherCloseFailed) throw watcherCloseError;
    })();
    return this.closePromise;
  }
}
