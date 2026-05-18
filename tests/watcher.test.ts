import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultIndexFile, FtsIndex } from "../src/fts5.js";
import { Vault } from "../src/vault.js";
import { VaultWatcher } from "../src/watcher.js";
import { makePdf } from "./helpers/make-pdf.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-watch-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** chokidar awaitWriteFinish polls every 50ms; one event takes ~300-500ms to
 *  propagate. Tests poll for up to `timeoutMs` until `cond` returns true. */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("VaultWatcher (v1.2 — opt-in --watch)", () => {
  it("invalidates the parsed-note cache when a file changes on disk", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "Note.md");
    await fs.writeFile(filePath, "Original body.\n");

    // Prime the cache.
    const before = await v.readNote(filePath);
    expect(before.parsed.body).toContain("Original");

    const w = new VaultWatcher({ vault: v, silent: true });
    await w.start();
    try {
      // Bump mtime past the cached value so the read-cache key updates,
      // and rewrite the body.
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(filePath, "Rewritten body!\n");

      // Wait until the watcher has invalidated the cache. We assert that a
      // fresh read returns the new content.
      const ok = await waitFor(async () => {
        const after = await v.readNote(filePath);
        return after.parsed.body.includes("Rewritten");
      });
      expect(ok).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("ignores non-.md files (a .txt change should NOT invalidate any cache)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Real.md"), "real body");
    await v.readNote(path.join(root, "Real.md")); // prime cache

    const w = new VaultWatcher({ vault: v, silent: true });
    await w.start();
    try {
      // Touch a non-md file — watcher should ignore it.
      await fs.writeFile(path.join(root, "config.txt"), "not markdown");
      await new Promise((r) => setTimeout(r, 600)); // give the watcher time to misbehave
      // The cache for Real.md should still be hot (we never edited it).
      // We can't easily inspect the LRU directly, so just verify the read
      // succeeds — the test is mostly that the watcher doesn't crash.
      const got = await v.readNote(path.join(root, "Real.md"));
      expect(got.parsed.body).toContain("real body");
    } finally {
      await w.close();
    }
  });

  it("respects --exclude-glob (changes to excluded paths don't fire cache invalidation)", async () => {
    await fs.mkdir(path.join(root, "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Private", "secret.md"), "v1");

    const v = new Vault(root, { excludeGlobs: ["Private/**"] });
    await v.ensureExists();

    const w = new VaultWatcher({ vault: v, silent: true });
    await w.start();
    try {
      // Edit the excluded file; the watcher's `ignored` predicate should drop the event.
      await fs.writeFile(path.join(root, "Private", "secret.md"), "v2");
      await new Promise((r) => setTimeout(r, 600));
      // Public path should still be readable; excluded path still throws.
      await fs.writeFile(path.join(root, "Visible.md"), "x");
      const ok = await waitFor(async () => {
        try {
          await v.readNote(path.join(root, "Visible.md"));
          return true;
        } catch {
          return false;
        }
      });
      expect(ok).toBe(true);
      // Excluded path is invisible to readNote regardless of the watcher.
      await expect(v.readNote(path.join(root, "Private", "secret.md"))).rejects.toThrow();
    } finally {
      await w.close();
    }
  });

  it("close() is idempotent and safe to call after start()", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "x.md"), "x");
    const w = new VaultWatcher({ vault: v, silent: true });
    await w.start();
    await w.close();
    await w.close(); // second close — must not throw
  });

  it("close() before start() is a no-op (idempotent)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    // Construct + close without start — this.watcher remains null, so
    // the inner branch at line 137 (if (this.watcher)) is skipped.
    const w = new VaultWatcher({ vault: v, silent: true });
    await w.close(); // closed=false → set closed=true; no watcher to close
    await w.close(); // closed=true → early return
  });

  // v3.6.2 branch-coverage uplift: exercise the silent=false stderr paths
  // (cache-invalidate, unlink, reindex, error skip). We capture stderr so
  // the assertions don't pollute the test runner output. The silent=false
  // branch is otherwise unreachable from the rest of the suite (every
  // other test uses silent:true to keep output clean).
  it("logs cache-invalidate to stderr when silent=false and no FTS index is wired", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "n.md"), "v1");

    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: stderr.write has overloads
    process.stderr.write = ((chunk: any) => {
      if (typeof chunk === "string") captured.push(chunk);
      return true;
    }) as unknown as typeof process.stderr.write;
    try {
      const w = new VaultWatcher({ vault: v, silent: false });
      await w.start();
      try {
        await new Promise((r) => setTimeout(r, 20));
        await fs.writeFile(path.join(root, "n.md"), "v2");
        const ok = await waitFor(() =>
          captured.some((s) => s.includes("watcher change") && s.includes("cache-invalidated"))
        );
        expect(ok).toBe(true);
      } finally {
        await w.close();
      }
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("logs reindexed / unlink lines to stderr when silent=false and FTS5 is wired", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: stderr.write has overloads
    process.stderr.write = ((chunk: any) => {
      if (typeof chunk === "string") captured.push(chunk);
      return true;
    }) as unknown as typeof process.stderr.write;
    try {
      const w = new VaultWatcher({ vault: v, silent: false, ftsIndex: fts });
      await w.start();
      try {
        const abs = path.join(root, "logged.md");
        await fs.writeFile(abs, "# T\n\nbody\n");
        const indexed = await waitFor(() => captured.some((s) => s.includes("fts5 reindexed")));
        expect(indexed).toBe(true);
        await fs.unlink(abs);
        const dropped = await waitFor(() => captured.some((s) => s.includes("fts5 dropped")));
        expect(dropped).toBe(true);
      } finally {
        await w.close();
      }
    } finally {
      process.stderr.write = origWrite;
      fts.close();
    }
  });
});

// v3.6 — branches coverage. The watcher's FTS5-reindex paths
// (add/change → reindexFile, unlink → dropFile, missing-file error in
// the read-and-reindex try/catch) are only reachable when an
// FtsIndex is wired in. Stand up a real FTS5 index against a temp
// vault and observe totalFiles() / totalChunks() flip as files
// move on disk. Deterministic — no time-based asserts beyond
// chokidar's awaitWriteFinish (already polled via waitFor()).
describe("VaultWatcher with FTS5 index (v3.6 — reindex branches)", () => {
  it("reindexes on add + unlink drops the file's chunks", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();
    try {
      const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
      await w.start();
      try {
        // Add: a fresh .md file should land in the index after the watcher
        // picks it up.
        const abs = path.join(root, "added.md");
        await fs.writeFile(abs, "# Heading\n\nFirst body chunk.\n\nSecond chunk has more text.\n");
        const indexed = await waitFor(() => fts.totalFiles() >= 1);
        expect(indexed).toBe(true);
        expect(fts.totalChunks()).toBeGreaterThan(0);
        // Unlink: deleting the file should drop chunks via dropFile().
        await fs.unlink(abs);
        const dropped = await waitFor(() => fts.totalFiles() === 0);
        expect(dropped).toBe(true);
        expect(fts.totalChunks()).toBe(0);
      } finally {
        await w.close();
      }
    } finally {
      fts.close();
    }
  });

  it("change event re-runs reindexFile (chunks update in place)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "iter.md");
    await fs.writeFile(filePath, "# T\n\nfirst body\n");
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();
    try {
      // Seed the index with the initial content so the chunk count is known.
      const note = await v.readNote(filePath);
      const stat = await v.stat(filePath);
      fts.reindexFile(
        "iter.md",
        stat.mtimeMs,
        note.content,
        note.parsed.wikilinks.map((w) => w.target),
        note.parsed.tags
      );
      const chunksBefore = fts.totalChunks();
      expect(chunksBefore).toBeGreaterThan(0);

      const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
      await w.start();
      try {
        // Rewrite with a longer body so the chunk count goes up — proof
        // that the watcher invoked reindexFile (not a no-op).
        await new Promise((r) => setTimeout(r, 20));
        const bigger = "# T\n\nfirst body\n\nadded paragraph one.\n\nadded paragraph two.\n\nadded paragraph three.\n";
        await fs.writeFile(filePath, bigger);
        const grew = await waitFor(() => fts.totalChunks() > chunksBefore);
        expect(grew).toBe(true);
      } finally {
        await w.close();
      }
    } finally {
      fts.close();
    }
  });

  // v3.7.16 P1-5 — PDF lifecycle when includePdfs is on. Pre-3.7.16 the
  // watcher ignored everything but `.md`. Now `.pdf` add/change/unlink
  // events flow through to reindexPdfFile / dropFile. Tests don't need
  // real PDFs — we use the synthetic `makePdf` from the pdf test fixtures
  // and verify FtsIndex sees the chunks. The change-branch is exercised
  // by the initial add (the watcher debounces and may collapse events;
  // testing add+unlink is the canonical lifecycle).
  it("includePdfs=true: PDF add fires reindexPdfFile + PDF unlink drops chunks (P1-5)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();
    try {
      const w = new VaultWatcher({ vault: v, ftsIndex: fts, includePdfs: true, silent: true });
      await w.start();
      try {
        const pdfPath = path.join(root, "added.pdf");
        const pdfBuf = makePdf({ pages: ["PDF page one", "Second page text"] });
        await fs.writeFile(pdfPath, pdfBuf);
        const indexed = await waitFor(() => fts.totalFiles() >= 1);
        expect(indexed).toBe(true);
        expect(fts.totalChunks()).toBeGreaterThan(0);
        // Unlink should drop chunks (same dropFile branch as .md unlink).
        await fs.unlink(pdfPath);
        const dropped = await waitFor(() => fts.totalFiles() === 0);
        expect(dropped).toBe(true);
      } finally {
        await w.close();
      }
    } finally {
      fts.close();
    }
  });

  it("includePdfs=false: PDF events are silently ignored (P1-5 default safety)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();
    try {
      // includePdfs intentionally omitted (defaults to false).
      const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
      await w.start();
      try {
        const pdfPath = path.join(root, "ignored.pdf");
        // Write a synthetic PDF — we don't care if it parses; the watcher
        // should never touch it because includePdfs is false.
        await fs.writeFile(pdfPath, "%PDF-1.4\n...");
        // Wait a beat — if the watcher were going to process it, this is
        // enough time for chokidar's awaitWriteFinish + the handler call.
        await new Promise((r) => setTimeout(r, 800));
        // No chunks should appear (FTS5 stays empty).
        expect(fts.totalFiles()).toBe(0);
        expect(fts.totalChunks()).toBe(0);
      } finally {
        await w.close();
      }
    } finally {
      fts.close();
    }
  });

  it("survives an add event for a file that disappears before stat (skip branch)", async () => {
    // Race: chokidar fires `add`, but the file is unlinked before the
    // watcher's stat() runs. The handle() try/catch should swallow it
    // and emit a "skip" stderr line (we use silent:true so nothing
    // pollutes the test runner).
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();
    try {
      const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
      await w.start();
      try {
        const abs = path.join(root, "ephemeral.md");
        await fs.writeFile(abs, "transient");
        // Immediately unlink. By the time chokidar's awaitWriteFinish
        // settles, the file is gone — vault.stat will throw ENOENT in
        // the handle() try block, which falls into the "skip" branch.
        await fs.unlink(abs).catch(() => {});
        // Give chokidar a window to process and discard the event.
        // We can't directly assert the skip-branch from outside the
        // watcher, but we DO assert the FTS index stays empty (the
        // alternative — chunks getting added for a phantom file —
        // would mean the error branch silently succeeded).
        await new Promise((r) => setTimeout(r, 800));
        expect(fts.totalFiles()).toBe(0);
      } finally {
        await w.close();
      }
    } finally {
      fts.close();
    }
  });
});
