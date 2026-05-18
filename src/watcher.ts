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
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private readonly vault: Vault;
  private readonly ftsIndex: FtsIndex | null;
  private readonly silent: boolean;
  private readonly includePdfs: boolean;
  private closed = false;

  constructor(opts: WatcherOptions) {
    this.vault = opts.vault;
    this.ftsIndex = opts.ftsIndex ?? null;
    this.silent = opts.silent ?? false;
    this.includePdfs = opts.includePdfs ?? false;
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
      if (!this.silent) {
        process.stderr.write(`enquire: watcher unlink ${relPath} (fts5 dropped)\n`);
      }
      return;
    }

    // add / change: re-read + reindex this single file.
    try {
      const stat = await this.vault.stat(absPath);
      if (isPdf) {
        // v3.7.16 P1-5 — extract text and re-index PDF pages. Lazy
        // import to keep markdown-only deployments zero-cost.
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
      if (!this.silent) {
        process.stderr.write(`enquire: watcher ${kind} ${relPath} (fts5 reindexed)\n`);
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
