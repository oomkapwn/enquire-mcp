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
 * A fatal staged watcher preparation failure leaves the prior generation
 * intact and does not change these flags. Optional OCR failure retains its
 * explicit fail-soft path. A sink mutation failure is different: the current
 * route can no longer prove it matches the other enabled sinks, so the affected
 * optimization is quarantined until restart.
 */
export interface WatcherSearchHealth {
  semanticUsable: boolean;
  hnswUsable: boolean;
}

const DEFAULT_ACTIVATION_PATH_LIMIT = 50_000;
const ACTIVATION_REPLAY_CONCURRENCY = 4;
const ACTIVATION_MAX_GENERATIONS = 16;
const FILE_GENERATION_ATTEMPTS = 2;
const PHYSICAL_ALIAS_ATTEMPTS = 2;
const PHYSICAL_ALIAS_INVENTORY_LOCK = "inventory:physical-alias";
const PHYSICAL_ALIAS_UNKNOWN_LOCK = "identity:unavailable";

class PhysicalAliasInventoryLimitError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number
  ) {
    super(`watcher physical-alias inventory/plan found ${count} paths (limit ${limit})`);
    this.name = "PhysicalAliasInventoryLimitError";
  }
}

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
   * Maximum distinct paths retained by deferred activation or admitted by one
   * physical-alias inventory/plan. Repeated activation events for one path
   * coalesce. Exceeding the limit fails guarded activation closed; an ordinary
   * live alias event preserves the historical exact/previously-known-group
   * reconciliation and logs that unobserved aliases could not be discovered.
   * Primarily configurable for deterministic tests.
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
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mtimeMs: number;
}

interface LiveAliasPath {
  absPath: string;
  relPath: string;
  isPdf: boolean;
  generation: FileGeneration;
  physicalIdentity: string | null;
}

type AliasPathInspection = { state: "live"; live: LiveAliasPath } | { state: "purge" } | { state: "retry" };

interface VisibleAliasInventoryEntry {
  absPath: string;
  inspection: AliasPathInspection;
}

interface StagedAliasPath {
  live: LiveAliasPath;
  staged: StagedMarkdownGeneration | StagedPdfGeneration;
}

function aliasAdmissionFailure(error: unknown): "purge" | "retry" {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return "purge";
  if (code !== undefined) return "retry";
  if (error instanceof Error && /(?:refusing|outside (?:the )?vault|escapes (?:the )?vault)/iu.test(error.message)) {
    return "purge";
  }
  return "retry";
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
  // v3.12.0-rc.27 — regular-file hardlinks remain distinct searchable paths,
  // but all currently-visible aliases of one physical identity reconcile under
  // one multi-key critical section. Exact strings are retained: storage
  // identity never case-folds or Unicode-normalizes a path.
  private readonly physicalIdentityByPath = new Map<string, string>();
  private readonly physicalPathsByIdentity = new Map<string, Set<string>>();
  private readonly physicalKnownPaths = new Set<string>();
  private readonly physicalAliasLockTails = new Map<string, Promise<void>>();
  private physicalAliasSeedPromise: Promise<void> | null = null;
  private watcherReadyReject: ((reason: Error) => void) | null = null;
  private readonly handleNativeWatcherError = (error: unknown): void => {
    // The readiness waiter owns startup errors and rejects start(). Once ready,
    // keep a lifetime listener installed so a later chokidar error has an
    // explicit fail-stop policy. Continuing after a root/subtree watch loss
    // would serve derived indexes whose future freshness is no longer proven.
    if (this.watcherReadyReject !== null) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!this.silent) {
      process.stderr.write(`enquire: native watcher error — ${normalized.message}\n`);
    }
    throw normalized;
  };

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
    const canonicalAbsPath = this.canonicalWatcherEventPath(absPath);
    if (canonicalAbsPath === null) return Promise.resolve();
    return this.enqueueFileTask(
      canonicalAbsPath,
      `(${kind})`,
      () => this.handle(canonicalAbsPath, kind),
      propagateFailure
    );
  }

  /**
   * Map an accepted configured-root spelling onto the canonical vault root.
   *
   * `Vault.ensureExists()` replaces `vault.root` with `realpath()`, while a
   * native event or deterministic test may still carry the configured spelling
   * (`/var` vs `/private/var`, or a Windows alias). `resolveInside()` preserves
   * that compatibility without following the event leaf and rejects lexical
   * escapes before they can acquire a queue identity.
   *
   * @param absPath - Absolute path supplied by chokidar or activation replay.
   * @returns Canonical in-vault spelling, or null for an unsafe/outside path.
   */
  private canonicalWatcherEventPath(absPath: string): string | null {
    try {
      const admitted = this.vault.resolveInside(absPath);
      const relPath = path.relative(this.vault.root, admitted);
      if (relPath.startsWith("..") || path.isAbsolute(relPath)) return null;
      // `path.relative()` on Windows treats the root prefix case-insensitively
      // and preserves the child spelling. Re-anchor that child to the canonical
      // root so configured-root casing/8.3 aliases cannot split queue identity,
      // while exact case/Unicode below the root remains untouched.
      return path.resolve(this.vault.root, relPath);
    } catch {
      return null;
    }
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
    const canonicalAbsPath = this.canonicalWatcherEventPath(absPath);
    if (canonicalAbsPath === null) return;
    if (this.activationState !== "live") {
      this.captureActivationPath(canonicalAbsPath);
      return;
    }
    void this.enqueueFileEvent(canonicalAbsPath, kind);
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
    if (this.vault.isExcluded(nativeRelPath)) {
      return { purge: [absPath], upsert: null };
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

  /**
   * Await chokidar readiness as watcher-owned work.
   *
   * close() rejects this wait before closing the native watcher, so a start
   * racing shutdown cannot remain pending after shutdown has completed.
   *
   * @param watcher - Native watcher created for this start attempt.
   * @returns A promise that resolves on ready and rejects on error or close.
   */
  private waitForWatcherReady(watcher: FSWatcher): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        watcher.off("ready", onReady);
        watcher.off("error", onError);
        this.watcherReadyReject = null;
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      this.watcherReadyReject = (error) => {
        cleanup();
        reject(error);
      };
      watcher.once("ready", onReady);
      watcher.once("error", onError);
      if (this.closing || this.closed) {
        this.watcherReadyReject(new Error("VaultWatcher.start: watcher is closing or closed"));
      }
    });
  }

  /** Start watching. Resolves once the watcher has reported `ready`. */
  async start(): Promise<void> {
    if (this.closing || this.closed) {
      throw new Error("VaultWatcher.start: watcher is closing or closed");
    }
    if (this.watcher) {
      throw new Error("VaultWatcher.start: watcher is already started");
    }
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
        // Use the Vault's single visibility policy for hidden/reserved paths
        // and configured globs. Keeping this after the no-stats return lets
        // unlink events reach cleanup and purge stale index rows.
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
    this.watcher.on("error", this.handleNativeWatcherError);

    await this.waitForWatcherReady(this.watcher);
    if (this.closing || this.closed) {
      throw new Error("VaultWatcher.start: watcher is closing or closed");
    }
    // Production uses deferred activation. Chokidar is now listening, so any
    // membership change that races this identity-only scan is captured for the
    // activation replay; handlers cannot concurrently publish registry state.
    if (this.deferredActivation) await this.runTrackedPhysicalAliasSeed();
    if (this.closing || this.closed) {
      throw new Error("VaultWatcher.start: watcher is closing or closed");
    }
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
      nlink: stat.nlink,
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
      left.nlink === right.nlink &&
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
   * Resolve the watcher-private physical identity for one regular-file leaf.
   *
   * This method is deliberately separate from the generation guard so tests
   * can force the conservative unavailable-identity path without weakening
   * the `lstat → stage → lstat` proof. The identity is process-local only:
   * zero-valued device/inode fields are not treated as a shared alias key.
   *
   * @param absPath - Exact admitted filesystem path.
   * @returns A BigInt-preserving device/inode key, or null when unavailable.
   */
  private async physicalAliasIdentity(absPath: string): Promise<string | null> {
    const stat = await lstat(absPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev === 0n || stat.ino === 0n) return null;
    return `inode:${stat.dev}:${stat.ino}`;
  }

  /**
   * Admit one live regular Markdown/PDF path for physical reconciliation.
   *
   * Leaf `lstat` rejects symlinks. Canonical privacy resolution additionally
   * rejects an intermediate symlink/junction that escapes the vault. The
   * returned path spelling is exact and is never case- or Unicode-folded.
   *
   * @param absPath - Exact path supplied by chokidar, activation, or inventory.
   * @returns Live evidence, a definite purge decision, or transient retry.
   */
  private async inspectAliasPath(absPath: string): Promise<AliasPathInspection> {
    const nativeRelPath = path.relative(this.vault.root, absPath);
    if (!nativeRelPath || nativeRelPath.startsWith("..") || path.isAbsolute(nativeRelPath)) {
      return { state: "purge" };
    }
    if (this.vault.isExcluded(nativeRelPath)) return { state: "purge" };

    let generation: FileGeneration;
    try {
      generation = await this.captureFileGeneration(absPath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("watcher source is not a regular file:")) {
        return { state: "purge" };
      }
      return { state: aliasAdmissionFailure(error) };
    }

    let canonicalRel: string;
    let canonicalAbs: string;
    try {
      canonicalRel = await this.vault.canonicalRelForPrivacyCheckPublic(absPath);
      canonicalAbs = this.vault.resolveInside(canonicalRel);
    } catch (error) {
      return { state: aliasAdmissionFailure(error) };
    }
    if (this.vault.isExcluded(canonicalRel)) return { state: "purge" };

    const lower = canonicalRel.toLowerCase();
    const isPdf = lower.endsWith(".pdf");
    if (!lower.endsWith(".md") && !(this.includePdfs && isPdf)) return { state: "purge" };

    if (canonicalAbs !== absPath) {
      try {
        generation = await this.captureFileGeneration(canonicalAbs);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("watcher source is not a regular file:")) {
          return { state: "purge" };
        }
        return { state: aliasAdmissionFailure(error) };
      }
    }

    let physicalIdentity: string | null;
    try {
      physicalIdentity = await this.physicalAliasIdentity(canonicalAbs);
    } catch {
      // Within the configured path bound, inaccessible identity takes the
      // serialized global fallback. Over the bound, live work logs and retains
      // only exact/previously-known-group behavior.
      physicalIdentity = null;
    }

    return {
      state: "live",
      live: {
        absPath: canonicalAbs,
        relPath: canonicalRel,
        isPdf,
        generation,
        physicalIdentity
      }
    };
  }

  /**
   * Compare two admission snapshots without normalizing path identity.
   *
   * @param left - Earlier planning evidence.
   * @param right - Evidence captured under the final alias locks.
   * @returns True only when state and every live generation field match.
   */
  private sameAliasInspection(left: AliasPathInspection, right: AliasPathInspection): boolean {
    if (left.state !== right.state) return false;
    if (left.state !== "live") return true;
    if (right.state !== "live") return false;
    return (
      left.live.absPath === right.live.absPath &&
      left.live.relPath === right.live.relPath &&
      left.live.isPdf === right.live.isPdf &&
      left.live.physicalIdentity === right.live.physicalIdentity &&
      this.sameFileGeneration(left.live.generation, right.live.generation)
    );
  }

  /**
   * Distinguish ordinary content churn from a physical alias-membership change.
   *
   * Size/timestamp drift on the same path, inode, and link count needs only the
   * caller's bounded same-mode retry. A state/path/inode/link-count change can
   * alter which exact aliases belong to the plan and therefore requires the
   * serialized global inventory.
   *
   * @param left - Earlier admission evidence.
   * @param right - Later admission evidence.
   * @returns No drift, generation-only drift, or membership drift.
   */
  private classifyAliasInspectionDrift(
    left: AliasPathInspection,
    right: AliasPathInspection
  ): "none" | "generation" | "membership" {
    if (this.sameAliasInspection(left, right)) return "none";
    if (left.state !== "live" || right.state !== "live") return "membership";
    return left.live.absPath === right.live.absPath &&
      left.live.relPath === right.live.relPath &&
      left.live.isPdf === right.live.isPdf &&
      left.live.physicalIdentity === right.live.physicalIdentity &&
      left.live.generation.dev === right.live.generation.dev &&
      left.live.generation.ino === right.live.generation.ino &&
      left.live.generation.nlink === right.live.generation.nlink
      ? "generation"
      : "membership";
  }

  /**
   * Detach one exact path from its remembered physical identity.
   *
   * @param absPath - Exact canonical absolute path.
   */
  private forgetPhysicalAlias(absPath: string): void {
    const previous = this.physicalIdentityByPath.get(absPath);
    if (!previous) return;
    this.physicalIdentityByPath.delete(absPath);
    const paths = this.physicalPathsByIdentity.get(previous);
    paths?.delete(absPath);
    if (paths?.size === 0) this.physicalPathsByIdentity.delete(previous);
  }

  /**
   * Attach one exact path to its latest non-null physical identity.
   *
   * @param absPath - Exact canonical absolute path.
   * @param physicalIdentity - BigInt-preserving device/inode key.
   */
  private rememberPhysicalAlias(absPath: string, physicalIdentity: string): void {
    this.physicalKnownPaths.add(absPath);
    if (this.physicalIdentityByPath.get(absPath) !== physicalIdentity) {
      this.forgetPhysicalAlias(absPath);
      this.physicalIdentityByPath.set(absPath, physicalIdentity);
      const paths = this.physicalPathsByIdentity.get(physicalIdentity) ?? new Set<string>();
      paths.add(absPath);
      this.physicalPathsByIdentity.set(physicalIdentity, paths);
    }
  }

  /**
   * List every currently admitted watcher path with a bounded fan-out.
   *
   * The vault walkers already exclude hidden/private paths and refuse
   * directory symlinks. Each entry is still independently re-admitted here to
   * close leaf/intermediate replacement gaps before it reaches the registry.
   *
   * A listed path is retained even when its second admission does not produce
   * live evidence. A definite inadmissible result drives exact-key purge via a
   * global plan; a transient I/O result aborts and retries without mutation.
   *
   * @returns Listed paths plus their independently admitted live evidence.
   * @throws {Error} When the configured activation bound would be exceeded.
   */
  private async inspectVisibleAliasInventory(): Promise<VisibleAliasInventoryEntry[]> {
    const entries = [
      ...(await this.vault.listMarkdown()),
      ...(this.includePdfs ? await this.vault.listFilesByExtension(".pdf") : [])
    ];
    if (entries.length > this.activationPathLimit) {
      throw new PhysicalAliasInventoryLimitError(entries.length, this.activationPathLimit);
    }

    const inspected: VisibleAliasInventoryEntry[] = [];
    for (let offset = 0; offset < entries.length; offset += ACTIVATION_REPLAY_CONCURRENCY) {
      const chunk = entries.slice(offset, offset + ACTIVATION_REPLAY_CONCURRENCY);
      const results = await Promise.all(chunk.map((entry) => this.inspectAliasPath(entry.absPath)));
      for (let index = 0; index < chunk.length; index += 1) {
        const entry = chunk[index];
        if (entry) {
          inspected.push({
            absPath: entry.absPath,
            inspection: results[index] ?? { state: "retry" }
          });
        }
      }
    }
    return inspected;
  }

  /**
   * Serialize full-vault identity inventories without serializing ordinary
   * single-link file updates.
   *
   * Registry membership is deliberately not mutated here: the inventory is a
   * local planning snapshot and may be stale before the later path/group locks
   * are acquired.
   *
   * @returns One bounded privacy-filtered planning snapshot.
   */
  private async inspectVisibleAliasInventoryInLane(): Promise<VisibleAliasInventoryEntry[]> {
    return this.withPhysicalAliasLocks([PHYSICAL_ALIAS_INVENTORY_LOCK], () => this.inspectVisibleAliasInventory());
  }

  /**
   * Seed process-local physical membership before live handlers can publish.
   *
   * This is identity-only preparation: it never reads note/PDF content and
   * never mutates FTS5, EmbedDb, or HNSW. Production's deferred watcher is
   * already listening and capturing paths before this scan. A stale or partial
   * seed is only a narrowing hint because every missing origin runs a fresh
   * bounded inventory and every later plan re-admits paths under its final
   * locks. Failure leaves event-time bounded/degraded reconciliation intact.
   */
  private async seedPhysicalAliasRegistry(): Promise<void> {
    if (!this.deferredActivation && !this.ftsIndex && !this.embedDb) return;
    let inventory: VisibleAliasInventoryEntry[];
    try {
      inventory = await this.inspectVisibleAliasInventoryInLane();
    } catch (error) {
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher physical-alias seed skipped — ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
      return;
    }
    if (this.closing || this.closed) return;

    // No await below: close() either observes all seeded hints and clears them,
    // or sets `closing` before this publication and the guard above returns.
    for (const entry of inventory) {
      if (entry.inspection.state !== "live") continue;
      const { live } = entry.inspection;
      this.physicalKnownPaths.add(live.absPath);
      if (live.physicalIdentity) {
        this.rememberPhysicalAlias(live.absPath, live.physicalIdentity);
      }
    }
  }

  /**
   * Own the identity-only seed as accepted watcher work.
   *
   * Concurrent callers share one scan. close() waits for the same promise
   * before clearing registry and lock state, so no filesystem work outlives
   * the watcher lifecycle.
   *
   * @returns The current seed operation.
   */
  private async runTrackedPhysicalAliasSeed(): Promise<void> {
    if (this.physicalAliasSeedPromise) return this.physicalAliasSeedPromise;
    const seed = this.seedPhysicalAliasRegistry();
    this.physicalAliasSeedPromise = seed;
    try {
      await seed;
    } finally {
      if (this.physicalAliasSeedPromise === seed) this.physicalAliasSeedPromise = null;
    }
  }

  /**
   * Reserve a set of physical/path locks in one synchronous event-loop turn.
   *
   * Every key receives the same tail before this method awaits any predecessor,
   * so overlapping alias groups cannot partially reserve each other. Entries
   * self-evict after the final waiter releases.
   *
   * @param keys - Exact path and/or physical identity lock keys.
   * @param task - Reconciliation work protected by all keys.
   * @returns The task result.
   */
  private async withPhysicalAliasLocks<T>(keys: ReadonlyArray<string>, task: () => Promise<T>): Promise<T> {
    const uniqueKeys = [...new Set(keys)].sort();
    const predecessors = uniqueKeys.map((key) => this.physicalAliasLockTails.get(key) ?? Promise.resolve());
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = Promise.all(predecessors.map((previous) => previous.catch(() => {})));
    const tail = ready.then(() => gate);
    for (const key of uniqueKeys) this.physicalAliasLockTails.set(key, tail);

    await ready;
    try {
      return await task();
    } finally {
      release?.();
      for (const key of uniqueKeys) {
        if (this.physicalAliasLockTails.get(key) === tail) this.physicalAliasLockTails.delete(key);
      }
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
          const { oldIds, newIds } = this.embedDb.upsertNote(relPath, generation.mtimeMs, staged.embedResult.rows);
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

  /**
   * Drop one exact searchable path from every configured derived sink.
   *
   * Hardlink siblings are deliberately untouched: each directory entry is a
   * distinct public document identity. A caller may separately refresh the
   * remaining physical group after this synchronous purge.
   *
   * @param relPath - Exact public vault-relative identity to remove.
   * @param isPdf - Whether HNSW metadata uses the PDF kind.
   */
  private commitUnlinkPath(relPath: string, isPdf: boolean): void {
    this.ftsIndex?.dropFile(relPath);
    let unlinkHnswNote = "";
    let embedDeleteSucceeded = this.embedDb === null;
    if (this.embedDb) {
      try {
        const deletedIds = this.embedDb.deleteNote(relPath);
        embedDeleteSucceeded = true;
        if (deletedIds.length > 0 && this.hnsw) {
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
  }

  /**
   * Stage one exact alias without mutating any sink.
   *
   * @param live - Re-admitted live path and captured generation.
   * @returns Staged path work, or undefined after a fail-soft preparation error.
   */
  private async stageAliasPath(live: LiveAliasPath): Promise<StagedAliasPath | undefined> {
    const staged = live.isPdf
      ? await this.stagePdfGeneration(live.absPath, live.relPath, live.generation)
      : await this.stageMarkdownGeneration(live.absPath, live.relPath, live.generation);
    return staged === undefined ? undefined : { live, staged };
  }

  /**
   * Commit one already-revalidated exact alias synchronously.
   *
   * @param prepared - Exact path plus its staged lexical/semantic work.
   * @param kind - Diagnostic event label.
   * @returns True after a successful sink commit.
   */
  private commitAliasPath(prepared: StagedAliasPath, kind: "add" | "change"): boolean {
    const { live, staged } = prepared;
    const commitNote = live.isPdf
      ? this.commitPdfGeneration(live.relPath, live.generation, staged as StagedPdfGeneration)
      : this.commitMarkdownGeneration(live.relPath, live.generation, staged as StagedMarkdownGeneration);
    if (commitNote === undefined) return false;

    if (!this.silent) {
      const sinkLabel = live.isPdf
        ? `fts5 PDF reindexed, ${(staged as StagedPdfGeneration).pages.length} pages`
        : "fts5 reindexed";
      process.stderr.write(`enquire: watcher ${kind} ${live.relPath} (${sinkLabel}${commitNote})\n`);
    }
    return true;
  }

  /**
   * Reconcile one locked physical-alias plan.
   *
   * Every live exact path is independently admitted, staged, and revalidated.
   * Only after all awaited work succeeds are inadmissible/stale-key purges and
   * live-path commits performed in one no-await section. Membership drift asks
   * the caller for a global replan; generation-only drift and transient
   * admission failure retry without mutating any sink.
   *
   * @param originAbsPath - Exact event path.
   * @param plannedEvidence - Latest pre-lock admission for every inspected path.
   * @param paths - Exact path identities reserved by the multi-key lock.
   * @param physicalIdentity - Stable group key, or null for bounded global fallback.
   * @param kind - Native event kind, used only for the origin log label.
   * @returns Terminal success, global replan, or same-mode transient retry.
   */
  private async applyPhysicalAliasPlan(
    originAbsPath: string,
    plannedEvidence: ReadonlyMap<string, AliasPathInspection>,
    paths: ReadonlyArray<string>,
    physicalIdentity: string | null,
    kind: "add" | "change" | "unlink"
  ): Promise<"done" | "global" | "retry"> {
    const uniquePaths = [...new Set(paths)];
    const initialEvidence = new Map<string, AliasPathInspection>();
    const liveByCanonicalPath = new Map<string, LiveAliasPath>();
    const inadmissiblePaths = new Set<string>();
    const staleStoredPaths = new Set<string>();

    for (let offset = 0; offset < uniquePaths.length; offset += ACTIVATION_REPLAY_CONCURRENCY) {
      const chunk = uniquePaths.slice(offset, offset + ACTIVATION_REPLAY_CONCURRENCY);
      const inspected = await Promise.all(chunk.map((candidatePath) => this.inspectAliasPath(candidatePath)));
      for (let index = 0; index < chunk.length; index += 1) {
        const candidatePath = chunk[index];
        if (!candidatePath) continue;
        const inspection = inspected[index] ?? { state: "retry" as const };
        initialEvidence.set(candidatePath, inspection);
        if (inspection.state === "retry") return "retry";
        const planned = plannedEvidence.get(candidatePath);
        if (planned?.state === "retry") return "retry";
        if (planned) {
          const drift = this.classifyAliasInspectionDrift(planned, inspection);
          if (drift === "generation") return "retry";
          if (drift === "membership") return "global";
        }
        if (inspection.state === "purge") {
          inadmissiblePaths.add(candidatePath);
          continue;
        }
        const { live } = inspection;

        // A stable group plan may not silently drop an unavailable or replaced
        // sibling. Replan the complete visible set under the global lane.
        if (physicalIdentity !== null && live.physicalIdentity !== physicalIdentity) return "global";

        if (candidatePath !== live.absPath) staleStoredPaths.add(candidatePath);
        const existing = liveByCanonicalPath.get(live.absPath);
        if (existing) {
          const drift = this.classifyAliasInspectionDrift({ state: "live", live: existing }, { state: "live", live });
          if (drift === "generation") return "retry";
          if (drift === "membership") return "global";
        }
        liveByCanonicalPath.set(live.absPath, live);
      }
    }

    const stagedPaths: StagedAliasPath[] = [];
    for (const live of liveByCanonicalPath.values()) {
      const staged = await this.stageAliasPath(live);
      if (!staged) return "done";
      stagedPaths.push(staged);
    }

    // Revalidate every originally-reserved spelling, including paths that were
    // missing during preparation. This closes stale-unlink recreation and
    // case-only canonicalization gaps before the no-await publication block.
    for (let offset = 0; offset < uniquePaths.length; offset += ACTIVATION_REPLAY_CONCURRENCY) {
      const chunk = uniquePaths.slice(offset, offset + ACTIVATION_REPLAY_CONCURRENCY);
      const inspected = await Promise.all(chunk.map((candidatePath) => this.inspectAliasPath(candidatePath)));
      for (let index = 0; index < chunk.length; index += 1) {
        const candidatePath = chunk[index];
        if (!candidatePath) continue;
        const expected = initialEvidence.get(candidatePath) ?? { state: "retry" as const };
        const current = inspected[index] ?? { state: "retry" as const };
        if (current.state === "retry") return "retry";
        if (expected.state === "retry") return "retry";
        const drift = this.classifyAliasInspectionDrift(expected, current);
        if (drift === "generation") return "retry";
        if (drift === "membership") return "global";
      }
    }

    // Successful publication begins here. Keep this block free of await: every
    // alias has completed preparation and final generation validation.
    for (const purgePath of new Set([...inadmissiblePaths, ...staleStoredPaths])) {
      const relPath = this.vault.toRel(purgePath);
      const isPdf = relPath.toLowerCase().endsWith(".pdf");
      if (!isPdf) this.vault.invalidateOne(purgePath);
      this.commitUnlinkPath(relPath, isPdf);
      this.forgetPhysicalAlias(purgePath);
      this.physicalKnownPaths.delete(purgePath);
    }
    for (const prepared of stagedPaths) {
      const eventKind = prepared.live.absPath === originAbsPath && kind !== "unlink" ? kind : ("change" as const);
      if (!this.commitAliasPath(prepared, eventKind)) return "done";
      if (prepared.live.physicalIdentity) {
        this.rememberPhysicalAlias(prepared.live.absPath, prepared.live.physicalIdentity);
      } else {
        this.forgetPhysicalAlias(prepared.live.absPath);
        this.physicalKnownPaths.add(prepared.live.absPath);
      }
    }
    return "done";
  }

  /**
   * Preserve exact/previously-known watcher behavior when a live vault exceeds
   * the configured full-inventory bound.
   *
   * This is an explicitly degraded path, not proof that every unobserved
   * hardlink converged. Guarded activation never uses it.
   *
   * @param originAbsPath - Exact event path.
   * @param plannedEvidence - Admission evidence already captured this attempt.
   * @param knownGroup - Previously observed members of the same physical key.
   * @param origin - Current live origin, when present.
   * @param physicalIdentity - Stable scheduling key, or null when unavailable.
   * @param kind - Native event kind.
   * @param observedCount - Inventory or planned path count that exceeded the cap.
   * @returns Terminal success, global retry, or transient retry.
   */
  private async applyBoundedPhysicalAliasFallback(
    originAbsPath: string,
    plannedEvidence: ReadonlyMap<string, AliasPathInspection>,
    knownGroup: ReadonlySet<string> | undefined,
    origin: LiveAliasPath | null,
    physicalIdentity: string | null,
    kind: "add" | "change" | "unlink",
    observedCount: number
  ): Promise<"done" | "global" | "retry"> {
    const boundedPaths = [...new Set([...(knownGroup ?? []), originAbsPath, ...(origin ? [origin.absPath] : [])])];
    if (boundedPaths.length > this.activationPathLimit) {
      throw new PhysicalAliasInventoryLimitError(observedCount, this.activationPathLimit);
    }
    const lockIdentity = physicalIdentity ?? PHYSICAL_ALIAS_UNKNOWN_LOCK;
    const lockKeys = [lockIdentity, ...boundedPaths.map((candidatePath) => `path:${candidatePath}`)];
    const result = await this.withPhysicalAliasLocks(lockKeys, () =>
      this.applyPhysicalAliasPlan(originAbsPath, plannedEvidence, boundedPaths, physicalIdentity, kind)
    );
    if (result === "done" && !this.silent) {
      process.stderr.write(
        `enquire: watcher physical-alias inventory/plan exceeded ${this.activationPathLimit} paths (${observedCount} observed); full alias discovery was skipped and this event was limited to the exact/previously-known group\n`
      );
    }
    return result;
  }

  /**
   * Reconcile one native event through physical-alias scheduling.
   *
   * Stable `dev+ino` identities fan out only to independently re-admitted
   * exact paths. A multi-link source triggers a complete privacy-filtered
   * inventory because filesystems provide no reverse inode-to-path lookup.
   * Within the configured path bound, unknown identity takes one serialized
   * global lane and reconciles every visible watcher path. Above the bound,
   * ordinary live work logs and preserves only exact/previously-known-group
   * behavior; guarded activation rejects an over-limit required plan.
   *
   * @param absPath - Exact event path.
   * @param kind - Native event kind; final disk state remains authoritative.
   */
  private async handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> {
    if (this.closed) return;
    const eventPath = this.canonicalWatcherEventPath(absPath);
    if (eventPath === null) return;
    const nativeRelPath = path.relative(this.vault.root, eventPath);
    if (!nativeRelPath || nativeRelPath.startsWith("..") || path.isAbsolute(nativeRelPath)) return;
    const lower = nativeRelPath.toLowerCase();
    if (!lower.endsWith(".md") && !(this.includePdfs && lower.endsWith(".pdf"))) return;

    // Preserve the historical cache-only/logging path without paying for a
    // physical inventory when no derived sink exists.
    if (!this.ftsIndex && !this.embedDb) {
      await this.handleExactPath(eventPath, kind);
      return;
    }

    try {
      let forceGlobal = false;
      for (let attempt = 0; attempt < PHYSICAL_ALIAS_ATTEMPTS; attempt += 1) {
        const originInspection = await this.inspectAliasPath(eventPath);
        if (originInspection.state === "retry") {
          if (attempt + 1 < PHYSICAL_ALIAS_ATTEMPTS) continue;
          throw new Error("physical alias admission remained uncertain during both reconciliation attempts");
        }
        const origin = originInspection.state === "live" ? originInspection.live : null;
        const rememberedIdentity =
          this.physicalIdentityByPath.get(eventPath) ??
          (origin && origin.absPath !== eventPath ? this.physicalIdentityByPath.get(origin.absPath) : undefined);
        let physicalIdentity = origin?.physicalIdentity ?? rememberedIdentity ?? null;
        let paths: string[];
        const plannedEvidence = new Map<string, AliasPathInspection>([[eventPath, originInspection]]);

        const knownGroup = physicalIdentity === null ? undefined : this.physicalPathsByIdentity.get(physicalIdentity);
        const needsInventory =
          forceGlobal ||
          origin === null ||
          origin.physicalIdentity === null ||
          origin.generation.nlink > 1n ||
          (knownGroup?.size ?? 0) > 1;

        if (needsInventory) {
          let inventory: VisibleAliasInventoryEntry[];
          try {
            inventory = await this.inspectVisibleAliasInventoryInLane();
          } catch (error) {
            if (!(error instanceof PhysicalAliasInventoryLimitError) || this.activationState === "activating") {
              throw error;
            }
            const fallbackResult = await this.applyBoundedPhysicalAliasFallback(
              eventPath,
              plannedEvidence,
              knownGroup,
              origin,
              physicalIdentity,
              kind,
              error.count
            );
            if (fallbackResult === "done") {
              return;
            }
            if (fallbackResult === "global") forceGlobal = true;
            continue;
          }
          if (inventory.some((entry) => entry.inspection.state === "retry")) {
            if (attempt + 1 < PHYSICAL_ALIAS_ATTEMPTS) continue;
            throw new Error("physical alias inventory remained uncertain during both reconciliation attempts");
          }
          let planningGenerationDrifted = false;
          let planningMembershipDrifted = false;
          for (const entry of inventory) {
            const previous = plannedEvidence.get(entry.absPath);
            if (previous) {
              const drift = this.classifyAliasInspectionDrift(previous, entry.inspection);
              if (drift === "generation") planningGenerationDrifted = true;
              if (drift === "membership") planningMembershipDrifted = true;
            }
            plannedEvidence.set(entry.absPath, entry.inspection);
          }
          if (planningMembershipDrifted) {
            forceGlobal = true;
            continue;
          }
          if (planningGenerationDrifted) continue;
          const uncertainInventory = inventory.some(
            (entry) => entry.inspection.state !== "live" || entry.inspection.live.physicalIdentity === null
          );
          if (forceGlobal || origin?.physicalIdentity === null || physicalIdentity === null || uncertainInventory) {
            physicalIdentity = null;
            paths = [
              ...new Set([
                ...inventory.map((entry) => entry.absPath),
                ...this.physicalKnownPaths,
                ...this.physicalIdentityByPath.keys(),
                eventPath,
                ...(origin ? [origin.absPath] : [])
              ])
            ];
          } else {
            paths = [
              ...new Set([
                ...(knownGroup ?? []),
                ...inventory
                  .filter(
                    (entry) =>
                      entry.inspection.state === "live" && entry.inspection.live.physicalIdentity === physicalIdentity
                  )
                  .map((entry) => entry.absPath),
                eventPath,
                ...(origin ? [origin.absPath] : [])
              ])
            ];
          }
        } else if (physicalIdentity !== null) {
          paths = [...new Set([...(knownGroup ?? []), eventPath, ...(origin ? [origin.absPath] : [])])];
        } else {
          // Defensive fallback: needsInventory is true for every missing or
          // null-identity origin, so a null identity should not reach here.
          forceGlobal = true;
          continue;
        }

        if (paths.length > this.activationPathLimit) {
          if (this.activationState === "activating") {
            throw new PhysicalAliasInventoryLimitError(paths.length, this.activationPathLimit);
          }
          const fallbackResult = await this.applyBoundedPhysicalAliasFallback(
            eventPath,
            plannedEvidence,
            knownGroup,
            origin,
            physicalIdentity,
            kind,
            paths.length
          );
          if (fallbackResult === "done") return;
          if (fallbackResult === "global") forceGlobal = true;
          continue;
        }
        const lockIdentity = physicalIdentity ?? PHYSICAL_ALIAS_UNKNOWN_LOCK;
        const lockKeys = [lockIdentity, ...paths.map((candidatePath) => `path:${candidatePath}`)];
        const result = await this.withPhysicalAliasLocks(lockKeys, () =>
          this.applyPhysicalAliasPlan(eventPath, plannedEvidence, paths, physicalIdentity, kind)
        );
        if (result === "done") return;
        if (result === "global") forceGlobal = true;
      }

      throw new Error("physical alias membership or source generation changed during both reconciliation attempts");
    } catch (err) {
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher physical-alias reconciliation failed for ${this.vault.toRel(eventPath)} (${kind}) — ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
      if (this.activationState === "activating") throw err;
    }
  }

  private async handleExactPath(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> {
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
      this.commitUnlinkPath(relPath, isPdf);
      return;
    }

    // Add/change: derive every enabled sink from one captured path generation
    // for an ordinary update.
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
            process.stderr.write(`enquire: watcher skip ${relPath} (${kind}) — ${error.message}\n`);
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
          process.stderr.write(`enquire: watcher ${kind} ${relPath} (${sinkLabel}${commitNote})\n`);
        }
        return;
      }
    } catch (err) {
      if (!this.silent) {
        process.stderr.write(
          `enquire: watcher skip ${relPath} (${kind}) — ${err instanceof Error ? err.message : String(err)}\n`
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
    this.watcherReadyReject?.(new Error("VaultWatcher.start: watcher is closing or closed"));
    this.closePromise = (async () => {
      let watcherCloseError: unknown;
      let watcherCloseFailed = false;
      try {
        // v3.10.0-rc.40 (#6) — stop chokidar before draining so no new
        // event can enter the queue during the flush window.
        if (this.watcher) {
          const nativeWatcher = this.watcher;
          try {
            await nativeWatcher.close();
          } catch (err) {
            // Keep draining accepted work even if the native watcher reports
            // a close failure; surface that failure only after cleanup.
            watcherCloseError = err;
            watcherCloseFailed = true;
          }
          nativeWatcher.off("error", this.handleNativeWatcherError);
          this.watcher = null;
        }
        let seedError: unknown;
        if (this.physicalAliasSeedPromise) {
          try {
            await this.physicalAliasSeedPromise;
          } catch (err) {
            seedError = err;
          }
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
        if (seedError !== undefined) throw seedError;
      } finally {
        this.activationPaths.clear();
        this.activationStoredIdentities.clear();
        this.physicalIdentityByPath.clear();
        this.physicalPathsByIdentity.clear();
        this.physicalKnownPaths.clear();
        this.physicalAliasLockTails.clear();
        this.physicalAliasSeedPromise = null;
        this.watcherReadyReject = null;
        this.closed = true;
      }
      if (watcherCloseFailed) throw watcherCloseError;
    })();
    return this.closePromise;
  }
}
