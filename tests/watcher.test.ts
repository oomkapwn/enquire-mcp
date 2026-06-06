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
// v3.10.0-rc.15 — default bumped 4000 → 8000ms. The watcher chain on a loaded
// CI runner (event → awaitWriteFinish 250ms → per-file queue → reindex, and for
// embed tests a second embed-sync step) can exceed 4s under coverage
// instrumentation + parallel workers; 8s gives margin without masking a real
// hang (a genuinely-broken watcher still times out and fails).
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// v3.10.0-rc.15 — re-touch-on-miss for NEW-FILE-ADD detection. Writes `content`
// to `filePath`, then waits for `cond`; if `cond` hasn't held within ~1.2s, it
// RE-WRITES the file to regenerate a watch event. This defeats the dominant
// watcher-test flake on loaded runners: chokidar (inotify/FSEvents) occasionally
// drops the FIRST event for a brand-new path (the watch can still be arming when
// the write lands, even after `ready`), so a one-shot write + poll can wait
// forever. A re-touch produces a fresh event the watcher reliably catches; the
// reindex is idempotent (same path + content), so extra writes never change the
// asserted outcome. THIS is the durable fix the prior fixed-`setTimeout` warmups
// (rc.7 #36, rc.9 W-FLAKE-2) only approximated — and it's why the rc.13 RELEASE
// run flaked at `watcher.test.ts:505`. NOTE: only for add/change detection; for
// a signal that LAGS `cond` (e.g. an embed-sync log fired just after the FTS
// reindex), poll that signal with `waitFor` too — don't assert it immediately.
async function writeAndWaitFor(
  filePath: string,
  content: string | Uint8Array,
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 8000
): Promise<boolean> {
  const start = Date.now();
  await fs.writeFile(filePath, content);
  let lastTouch = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    if (Date.now() - lastTouch > 1200) {
      await fs.writeFile(filePath, content); // re-touch: regenerate a missed event
      lastTouch = Date.now();
    }
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

  // v3.10.0-rc.20 (audit M7) — defense-in-depth: even if handle() is reached for
  // an excluded path (bypassing chokidar's `ignored` predicate — a direct call,
  // an edge case), the per-file re-check must return BEFORE any index/cache work.
  // We observe `vault.invalidateOne` (the first side effect handle() performs for
  // a markdown event) to tell "skipped" from "processed".
  it("handle() skips an excluded path before any index work (rc.20 M7 defense-in-depth)", async () => {
    await fs.mkdir(path.join(root, "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Private", "secret.md"), "secret");
    const v = new Vault(root, { excludeGlobs: ["Private/**"] });
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });

    const invalidated: string[] = [];
    (v as unknown as { invalidateOne: (p: string) => void }).invalidateOne = (p) => {
      invalidated.push(p);
    };
    const handle = (
      w as unknown as { handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> }
    ).handle.bind(w);

    // Build the abs path from the CANONICAL root (`v.root` after realpath — /tmp
    // → /private/tmp on macOS), else handle()'s `path.relative` starts with ".."
    // and returns at the FIRST guard, masking the M7 exclude re-check.
    await handle(path.join(v.root, "Private", "secret.md"), "change");
    expect(invalidated).toEqual([]); // exclude re-check returned before invalidateOne
  });

  // v3.10.0-rc.24 (audit L) — but an UNLINK must NOT be skipped for an excluded
  // path: a delete always purges the file's index rows (removing content is never
  // a privacy risk; skipping it orphaned stale rows for a deleted-but-excluded
  // note indexed before the exclusion). So `unlink` falls through the gate — the
  // discriminator vs the "change" test above (which stays gated → []).
  it("handle() lets an excluded path's unlink proceed to cleanup (rc.24)", async () => {
    await fs.mkdir(path.join(root, "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Private", "secret.md"), "secret");
    const v = new Vault(root, { excludeGlobs: ["Private/**"] });
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });

    const invalidated: string[] = [];
    (v as unknown as { invalidateOne: (p: string) => void }).invalidateOne = (p) => {
      invalidated.push(p);
    };
    const handle = (
      w as unknown as { handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> }
    ).handle.bind(w);

    const abs = path.join(v.root, "Private", "secret.md");
    await handle(abs, "unlink");
    expect(invalidated).toEqual([abs]); // unlink proceeded PAST the exclude gate (cleanup runs)
  });

  // POSITIVE control — a NON-excluded path DOES reach invalidateOne, proving the
  // skip above is the exclude re-check and not handle() being inert.
  it("handle() processes a non-excluded path (control for the M7 skip)", async () => {
    await fs.writeFile(path.join(root, "Visible.md"), "ok");
    const v = new Vault(root, { excludeGlobs: ["Private/**"] });
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });

    const invalidated: string[] = [];
    (v as unknown as { invalidateOne: (p: string) => void }).invalidateOne = (p) => {
      invalidated.push(p);
    };
    const handle = (
      w as unknown as { handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> }
    ).handle.bind(w);

    const abs = path.join(v.root, "Visible.md"); // canonical root (see sibling test)
    await handle(abs, "change");
    expect(invalidated).toEqual([abs]);
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
        await new Promise((r) => setTimeout(r, 50));
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
        // Allow chokidar to finish initializing its FSEvents listener before
        // the first write — macOS CI runners can be slow enough that an
        // immediate write is missed (same pattern as the sibling test at
        // line ~140 which had the same race and uses a 20ms warm-up).
        await new Promise((r) => setTimeout(r, 50));
        const abs = path.join(root, "logged.md");
        const indexed = await writeAndWaitFor(abs, "# T\n\nbody\n", () =>
          captured.some((s) => s.includes("fts5 reindexed"))
        );
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
        const indexed = await writeAndWaitFor(
          abs,
          "# Heading\n\nFirst body chunk.\n\nSecond chunk has more text.\n",
          () => fts.totalFiles() >= 1
        );
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
        const indexed = await writeAndWaitFor(pdfPath, pdfBuf, () => fts.totalFiles() >= 1);
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

  // v3.8.0-rc.2 R-7 — watcher → embed-db sync. Closes the "edit-then-rebuild"
  // loop for users on --use-hnsw or persistent embedding search. Uses a
  // MOCK embedder (no 120MB HuggingFace model download) — testing the
  // wiring, not the model. The real-model smoke test stays opt-in via
  // ENQUIRE_LOAD_RERANKER_SMOKE pattern.
  it("attachEmbed: .md change re-embeds + upserts to embed-db (R-7)", async () => {
    const { EmbedDb } = await import("../src/embed-db.js");
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();

    // Mock embedder — returns Float32Array of fixed dim per chunk. Deterministic
    // so we can assert the upsert went through.
    const mockDim = 4;
    const mockEmbedder = {
      model: { alias: "test-mock", hfId: "mock", dim: mockDim, multilingual: false, maxTokens: 128 },
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        return texts.map((_, i) => {
          const vec = new Float32Array(mockDim);
          for (let j = 0; j < mockDim; j++) vec[j] = (i + 1) / (j + 1);
          return vec;
        });
      }
    };

    const embedDbFile = path.join(root, ".cache", "test.embed.db");
    await fs.mkdir(path.dirname(embedDbFile), { recursive: true });
    const embedDb = new EmbedDb({
      file: embedDbFile,
      vaultRoot: root,
      modelAlias: "test-mock",
      dim: mockDim,
      quantization: "f32"
    });
    await embedDb.open();

    try {
      const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
      w.attachEmbed(embedDb, mockEmbedder, 0);
      await w.start();
      try {
        // v3.10.0-rc.15 — re-touch-on-miss (supersedes the fixed FSEvents warm-up
        // this test used to need; cf. rc.8 W-FLAKE-2 / rc.7 #36): the first write
        // to a brand-new path can be dropped under coverage + parallel workers, so
        // writeAndWaitFor re-writes on miss. embed-sync fires AFTER the fts5
        // reindex within the handler.
        const filePath = path.join(root, "note-embed.md");
        const synced = await writeAndWaitFor(
          filePath,
          "# Heading\n\nFirst paragraph body.\n\nSecond paragraph here.\n",
          () => embedDb.totalChunks() > 0
        );
        expect(synced).toBe(true);
        const chunks = embedDb.totalChunks();
        expect(chunks).toBeGreaterThanOrEqual(1);

        // Unlink should drop both fts5 chunks AND embed-db rows.
        await fs.unlink(filePath);
        const dropped = await waitFor(() => embedDb.totalChunks() === 0);
        expect(dropped).toBe(true);
      } finally {
        await w.close();
      }
    } finally {
      embedDb.close();
      fts.close();
    }
  });

  // v3.8.0-rc.3 — PDF embed-sync via watcher (rc.2 was md-only; rc.3
  // closes the PDF gap). PDF chunks should appear in embed-db with
  // kind="pdf" after add, and disappear on unlink.
  it("attachEmbed: PDF add upserts to embed-db with kind=pdf (rc.3 R-7 continuation)", async () => {
    const { EmbedDb } = await import("../src/embed-db.js");
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();

    const mockEmbedder = {
      model: { alias: "test-mock", hfId: "mock", dim: 4, multilingual: false, maxTokens: 128 },
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array(4));
      }
    };

    const embedDbFile = path.join(root, ".cache", "test-pdf.embed.db");
    await fs.mkdir(path.dirname(embedDbFile), { recursive: true });
    const embedDb = new EmbedDb({
      file: embedDbFile,
      vaultRoot: root,
      modelAlias: "test-mock",
      dim: 4,
      quantization: "f32"
    });
    await embedDb.open();

    try {
      const w = new VaultWatcher({ vault: v, ftsIndex: fts, includePdfs: true, silent: true });
      w.attachEmbed(embedDb, mockEmbedder, 0);
      await w.start();
      try {
        // v3.8.0-rc.9 W-FLAKE-2 — same chokidar FSEvents warm-up fix as the .md
        // embed test above and rc.7 sibling fix at lines 156/190.
        await new Promise((r) => setTimeout(r, 50));
        const pdfPath = path.join(root, "doc.pdf");
        const pdfBuf = makePdf({ pages: ["PDF body for test embedding sync"] });
        await fs.writeFile(pdfPath, pdfBuf);
        // FTS5 + embed-db should BOTH receive PDF chunks.
        // Timeout bumped to 6000ms for coverage-instrumented runs.
        const ftsIndexed = await waitFor(() => fts.totalFiles() >= 1, 6000);
        expect(ftsIndexed).toBe(true);
        const embedded = await waitFor(() => embedDb.totalChunks() > 0);
        expect(embedded).toBe(true);
        // Verify kind="pdf" by inspecting source_states.
        const pdfStates = embedDb.getSourceStates("pdf");
        expect(pdfStates.some((s) => s.rel_path === "doc.pdf")).toBe(true);

        // Unlink should drop embed-db rows for the PDF.
        await fs.unlink(pdfPath);
        const dropped = await waitFor(() => embedDb.totalChunks() === 0);
        expect(dropped).toBe(true);
      } finally {
        await w.close();
      }
    } finally {
      embedDb.close();
      fts.close();
    }
  });

  // v3.8.0-rc.10 — watcher embed-db sync error path: silent=false branch
  // (lines 314-319 in watcher.ts). When the embedder throws, the watcher
  // MUST: (a) still update FTS5 (fail-soft), (b) log the error to stderr
  // when silent=false, (c) NOT update embed-db chunks. Tests the uncovered
  // `if (!this.silent)` branch in the embed-db sync catch block.
  it("attachEmbed: embed-db sync failure is logged to stderr (silent=false) and FTS5 still updates — NEGATIVE control", async () => {
    const { EmbedDb } = await import("../src/embed-db.js");
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();

    // An embedder that always throws — simulates embed pipeline failure.
    const throwingEmbedder = {
      model: { alias: "throwing-mock", hfId: "mock", dim: 4, multilingual: false, maxTokens: 128 },
      async embed(_texts: readonly string[]): Promise<Float32Array[]> {
        throw new Error("synthetic embed failure for watcher test");
      }
    };
    const embedDbFile = path.join(root, ".cache", "throwing.embed.db");
    await fs.mkdir(path.dirname(embedDbFile), { recursive: true });
    const embedDb = new EmbedDb({
      file: embedDbFile,
      vaultRoot: root,
      modelAlias: "throwing-mock",
      dim: 4,
      quantization: "f32"
    });
    await embedDb.open();

    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: stderr.write has overloads
    process.stderr.write = ((chunk: any) => {
      if (typeof chunk === "string") captured.push(chunk);
      return true;
    }) as unknown as typeof process.stderr.write;

    try {
      const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: false });
      w.attachEmbed(embedDb, throwingEmbedder, 0);
      await w.start();
      try {
        await new Promise((r) => setTimeout(r, 50)); // chokidar FSEvents warmup
        const filePath = path.join(root, "embed-error.md");
        // FTS5 must still be updated (fail-soft) even though embed-db throws.
        const ftsOk = await writeAndWaitFor(
          filePath,
          "# Heading\n\nBody for embed error test.\n",
          () => fts.totalFiles() >= 1
        );
        expect(ftsOk).toBe(true);
        // v3.10.0-rc.15 — the embed-db sync error is logged JUST AFTER the fts5
        // reindex within the SAME handler, so it can lag the totalFiles() check by
        // a tick. The rc.13 release flaked here (`:505`) because the test asserted
        // `hasEmbedError` IMMEDIATELY after `ftsOk`. Poll for the log instead.
        const hasEmbedError = await waitFor(() =>
          captured.some((s) => s.includes("embed-db sync failed") && s.includes("synthetic embed failure"))
        );
        expect(hasEmbedError).toBe(true);
        // Embed-db must NOT have been updated (the sync failed).
        expect(embedDb.totalChunks()).toBe(0);
      } finally {
        await w.close();
      }
    } finally {
      process.stderr.write = origWrite;
      embedDb.close();
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

  // v3.9.0-rc.1 — setOcrPdfs validation: requires includePdfs.
  // Without --include-pdfs the watcher filters out PDF events before the
  // OCR codepath; enabling OCR in that state would be silently broken.
  it("setOcrPdfs(true) throws when includePdfs was not enabled at construction", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true /* includePdfs omitted */ });
    expect(() => w.setOcrPdfs(true)).toThrow(/includePdfs=true/);
  });

  // v3.9.0-rc.1 — setOcrPdfs validation: requires embedDb (via attachEmbed).
  // OCR fallback only makes sense if the embed-db path runs; without it,
  // OCR-derived text wouldn't reach storage.
  it("setOcrPdfs(true) throws when embedDb has not been attached", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true, includePdfs: true });
    expect(() => w.setOcrPdfs(true)).toThrow(/embedDb/);
  });

  // v3.9.0-rc.1 NEGATIVE control: setOcrPdfs(false) is always safe to
  // call. Proves we're not over-restricting the API.
  it("(NEGATIVE control) — setOcrPdfs(false) is a no-op even without includePdfs/embedDb", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });
    expect(() => w.setOcrPdfs(false)).not.toThrow();
  });

  // v3.9.0-rc.2 — attachHnsw validation: requires embedDb (via attachEmbed).
  // The HNSW live-update path consumes embed-db's {oldIds, newIds} return
  // value; without embed-db wired there's nothing to mirror into HNSW.
  it("attachHnsw throws when embedDb has not been attached", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });
    // Stub HnswIndex — never called, just satisfies the param type. Cast
    // via unknown to skip the strict type check (we're testing the
    // validation path, not the index behavior).
    const fakeHnsw = {
      dim: 8,
      size: 0,
      searchKnn: () => ({ labels: [], distances: [] }),
      applyDiff: () => ({ removed: 0, added: 0 }),
      resize: () => {},
      capacity: () => ({ currentCount: 0, maxElements: 0 }),
      saveTo: async () => true
    } as unknown as Parameters<typeof w.attachHnsw>[0];
    expect(() => w.attachHnsw(fakeHnsw, new Map())).toThrow(/embedDb not attached/);
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

// v3.9.0-rc.6 — HNSW disk persistence on live update. The watcher
// re-persists the live-updated HNSW index at close time so the next
// serve loads the up-to-date sidecar instead of rebuilding (~25s on
// 50K chunks). Correctness is already guaranteed by the signature
// guard; this is a restart-speed optimization.
describe("VaultWatcher HNSW disk persistence (v3.9.0-rc.6)", () => {
  const mockDim = 4;
  const mockEmbedder = {
    model: { alias: "test-mock", hfId: "mock", dim: mockDim, multilingual: false, maxTokens: 128 },
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => {
        const vec = new Float32Array(mockDim);
        // L2-normalize so HNSW cosine space is well-defined.
        for (let j = 0; j < mockDim; j++) vec[j] = (i + 1) / (j + 2);
        let norm = 0;
        for (let j = 0; j < mockDim; j++) norm += (vec[j] ?? 0) ** 2;
        const inv = 1 / Math.sqrt(norm || 1);
        for (let j = 0; j < mockDim; j++) vec[j] = (vec[j] ?? 0) * inv;
        return vec;
      });
    }
  };

  // Build an EmbedDb + HNSW + rowsByLabel from one pre-embedded note.
  // NOTE: the watcher's embed-db + HNSW sync only fires when an FtsIndex
  // is wired (the handler early-returns at "if (!this.ftsIndex)" when it's
  // null — mirrors production where server.ts always wires FTS when
  // watching with embeddings).
  async function setup(persist: boolean) {
    const { EmbedDb } = await import("../src/embed-db.js");
    const { buildHnsw } = await import("../src/hnsw.js");
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "a.md"), "# Title\n\nOriginal body content here.\n");
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();
    const embedDbFile = path.join(root, ".cache", "test.embed.db");
    await fs.mkdir(path.dirname(embedDbFile), { recursive: true });
    const embedDb = new EmbedDb({ file: embedDbFile, vaultRoot: root, modelAlias: "test-mock", dim: mockDim });
    await embedDb.open();
    // Pre-embed a.md so getAllVectors has ≥1 row to build HNSW from.
    const [vec] = await mockEmbedder.embed(["seed"]);
    embedDb.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "seed", vector: vec as Float32Array }
    ]);
    const rows = embedDb.getAllVectors();
    const index = await buildHnsw(
      rows.map((r) => ({ label: r.label, vector: r.vector })),
      { dim: mockDim, maxElements: 100 }
    );
    const rowsByLabel = new Map(
      rows.map((r) => [
        r.label,
        {
          rel_path: r.rel_path,
          chunk_index: r.chunk_index,
          line_start: r.line_start,
          line_end: r.line_end,
          text_preview: r.text_preview,
          kind: r.kind
        }
      ])
    );
    const persistFile = path.join(root, ".cache", "test.hnsw");
    const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
    w.attachEmbed(embedDb, mockEmbedder, 0);
    w.attachHnsw(index, rowsByLabel, persist ? persistFile : undefined);
    return { w, embedDb, index, rowsByLabel, persistFile, v, fts };
  }

  it("flushHnswToDisk is a no-op when no live update occurred (not dirty)", async () => {
    const { w, embedDb, persistFile, fts } = await setup(true);
    try {
      const flushed = await w.flushHnswToDisk();
      expect(flushed).toBe(false);
      // No sidecar should be written.
      const binExists = await fs
        .access(`${persistFile}.bin`)
        .then(() => true)
        .catch(() => false);
      expect(binExists).toBe(false);
    } finally {
      await w.close();
      embedDb.close();
      fts.close();
    }
  });

  it("(NEGATIVE control) — flushHnswToDisk is a no-op when persistFile was omitted", async () => {
    const { w, embedDb, index, fts } = await setup(false); // persist=false → no persistFile
    try {
      // Force a live update directly on the index via the public applyDiff,
      // but the watcher's dirty flag is only set by syncHnswForFile. We
      // assert the no-persistFile guard: even if dirty were set, flush
      // returns false without a persistFile.
      index.applyDiff([], [{ label: 999, vector: new Float32Array([0.5, 0.5, 0.5, 0.5]) }]);
      const flushed = await w.flushHnswToDisk();
      expect(flushed).toBe(false);
    } finally {
      await w.close();
      embedDb.close();
      fts.close();
    }
  });

  it("close() flushes the live-updated index to a loadable sidecar with matching signature", async () => {
    const { w, embedDb, persistFile, fts } = await setup(true);
    const { loadHnswFromDisk } = await import("../src/hnsw.js");
    await w.start();
    try {
      // chokidar FSEvents warm-up (W-FLAKE-2 pattern).
      await new Promise((r) => setTimeout(r, 50));
      // Edit a.md → watcher re-embeds (mock) → upsertNote → syncHnswForFile
      // → applyDiff → hnswDirty = true.
      await fs.writeFile(path.join(root, "a.md"), "# Title\n\nEDITED body with different words entirely.\n");
      const dirtied = await waitFor(
        () => embedDb.totalChunks() > 0 && embedDb.getAllVectors().some((r) => r.label > 1),
        6000
      );
      expect(dirtied).toBe(true);
    } finally {
      // close() triggers flushHnswToDisk.
      await w.close();
    }
    // Sidecar must now exist + load back with the post-edit signature.
    const binExists = await fs
      .access(`${persistFile}.bin`)
      .then(() => true)
      .catch(() => false);
    expect(binExists, "close() should have persisted the live-updated HNSW sidecar").toBe(true);
    const signature = embedDb.computeSignature();
    const loaded = await loadHnswFromDisk(persistFile, signature);
    expect(loaded, "persisted sidecar should load with the post-edit signature").not.toBeNull();
    embedDb.close();
    fts.close();
  });

  // v3.9.0-rc.11 (H1) — per-file serialization + close() drain. chokidar
  // coalesces rapid writes within its 250ms awaitWriteFinish window, so a
  // deterministic race-reproducer isn't feasible; instead we assert the
  // INVARIANT the serialization + zipHnswAddPoints guard guarantee: after the
  // close() drain, the HNSW rowsByLabel never holds a -1 sentinel and never a
  // ghost label (one live in HNSW but absent from the embed-db).
  it("H1 (v3.9.0-rc.11) — after close() drains: no -1 sentinel, no ghost labels", async () => {
    const { w, embedDb, rowsByLabel, fts } = await setup(true);
    await w.start();
    await new Promise((r) => setTimeout(r, 50)); // chokidar FSEvents warm-up
    // Edit the file; give chokidar a beat to enqueue, then close — the per-file
    // queue drain in close() guarantees the in-flight upsert+applyDiff finishes
    // before we inspect state (rather than racing close vs. the handler).
    await fs.writeFile(path.join(root, "a.md"), "# Title\n\nH1 drain edit with several distinct words.\n");
    await new Promise((r) => setTimeout(r, 100));
    await w.close();
    const dbLabels = new Set(embedDb.getAllVectors().map((r) => r.label));
    expect([...rowsByLabel.keys()].includes(-1), "no -1 sentinel label").toBe(false);
    for (const label of rowsByLabel.keys()) {
      expect(dbLabels.has(label), `rowsByLabel label ${label} must exist in embed-db (no ghost)`).toBe(true);
    }
    embedDb.close();
    fts.close();
  });
});
