// Vault file watcher (v1.2 — opt-in via --watch).
//
// Closes the "edit a note → restart server → wait for FTS5 reindex" loop.
// When enabled, watches the vault root for .md add/change/unlink events,
// invalidates the parsed-note cache for the affected file, and (if FTS5 is
// enabled) does an incremental reindex of just that file. Non-MD files are
// ignored. Symlinks are skipped to match the rest of the vault walker.
//
// Debouncing is delegated to chokidar's `awaitWriteFinish` so we don't
// reindex five times during a single Obsidian save.

import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { EmbedDb } from "./embed-db.js";
import type { loadEmbedder } from "./embeddings.js";
import type { FtsIndex } from "./fts5.js";
import type { Vault } from "./vault.js";

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
  private closed = false;

  constructor(opts: WatcherOptions) {
    this.vault = opts.vault;
    this.ftsIndex = opts.ftsIndex ?? null;
    this.silent = opts.silent ?? false;
    this.includePdfs = opts.includePdfs ?? false;
    this.embedDb = opts.embedDb ?? null;
    this.embedder = opts.embedder ?? null;
    this.lateChunkContext = opts.lateChunkContext ?? 0;
    // v3.8.0-rc.2 R-7 — fail loud if embedDb is wired without embedder.
    // Pre-flight check vs silently no-op'ing the embed sync.
    if (this.embedDb && !this.embedder) {
      throw new Error("VaultWatcher: embedDb wired without embedder — both must be set together");
    }
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
      // Fire-and-forget; failures are logged, not propagated.
      this.handle(absPath, kind).catch((err) => {
        if (!this.silent) {
          process.stderr.write(
            `enquire: watcher error on ${path.relative(root, absPath)} (${kind}) — ${
              err instanceof Error ? err.message : String(err)
            }\n`
          );
        }
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
    const relPath = path.relative(this.vault.root, absPath);
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) return;
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

    if (!this.ftsIndex) {
      if (!this.silent) {
        process.stderr.write(`enquire: watcher ${kind} ${relPath} (cache-invalidated)\n`);
      }
      return;
    }

    if (kind === "unlink") {
      this.ftsIndex.dropFile(relPath);
      // v3.8.0-rc.2 R-7 — also drop embed-db rows so search results
      // don't surface vectors for deleted notes.
      if (!isPdf && this.embedDb) {
        try {
          this.embedDb.deleteNote(relPath);
        } catch (err) {
          if (!this.silent) {
            process.stderr.write(
              `enquire: watcher embed-db delete failed for ${relPath} — ${err instanceof Error ? err.message : String(err)}\n`
            );
          }
        }
      }
      if (!this.silent) {
        const embedNote = !isPdf && this.embedDb ? " + embed-db dropped" : "";
        process.stderr.write(`enquire: watcher unlink ${relPath} (fts5 dropped${embedNote})\n`);
      }
      return;
    }

    // add / change: re-read + reindex this single file.
    try {
      const stat = await this.vault.stat(absPath);
      if (isPdf) {
        // v3.7.16 P1-5 — extract text and re-index PDF pages. Lazy
        // import to keep markdown-only deployments zero-cost.
        // v3.8.0-rc.2 R-7 — PDF embedding sync deferred to rc.3+: needs
        // chunking + embedder loop similar to syncPdfEmbedDb, plus the
        // OCR fallback path. Markdown is the higher-value first cut.
        const buf = await this.vault.readBinaryFile(absPath);
        const { extractPdfText } = await import("./pdf.js");
        const result = await extractPdfText(buf);
        const pages = result.pages.map((p) => ({ pageNumber: p.pageNumber, text: p.text }));
        this.ftsIndex.reindexPdfFile(relPath, stat.mtimeMs, pages);
        if (!this.silent) {
          process.stderr.write(`enquire: watcher ${kind} ${relPath} (fts5 PDF reindexed, ${pages.length} pages)\n`);
        }
        return;
      }
      const note = await this.vault.readNote(absPath, stat.mtimeMs);
      const wikilinkTargets = note.parsed.wikilinks.map((w) => w.target).filter((t) => t.length > 0);
      this.ftsIndex.reindexFile(relPath, stat.mtimeMs, note.content, wikilinkTargets, note.parsed.tags);
      // v3.8.0-rc.2 R-7 — re-embed + upsert if embed-db is wired.
      // Failures here are logged but DON'T fail the whole watcher event
      // (FTS5 update already succeeded; embed-db will resync on next bulk
      // build). Same fail-soft posture as the existing FTS5 path.
      let embedNote = "";
      if (this.embedDb && this.embedder) {
        try {
          const { embedSingleNote } = await import("./server.js");
          const result = await embedSingleNote(
            this.vault,
            this.embedder,
            { relPath, absPath, mtimeMs: stat.mtimeMs },
            { lateChunkContext: this.lateChunkContext }
          );
          if (result === null) {
            this.embedDb.deleteNote(relPath);
            embedNote = " + embed-db cleared (empty note)";
          } else {
            this.embedDb.upsertNote(relPath, stat.mtimeMs, result.rows);
            embedNote = ` + embed-db upserted (${result.chunks} chunks)`;
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
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
