import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HnswBuildSnapshot,
  HnswPersistenceReceipt,
  HnswPersistenceRow,
  HnswReceiptSnapshot
} from "../src/embed-db.js";
import { defaultIndexFile, FtsIndex } from "../src/fts5.js";
import type { HnswIndex } from "../src/hnsw.js";
import * as hnswModule from "../src/hnsw.js";
import type { PersistenceFamilyScopes } from "../src/persistence-coordination.js";
import { Vault } from "../src/vault.js";
import { type HnswRowMeta, VaultWatcher } from "../src/watcher.js";
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
    await fs.writeFile(path.join(root, ".hidden.md"), "hidden");
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
    await handle(path.join(v.root, ".hidden.md"), "change");
    expect(invalidated).toEqual([]); // exclude re-check returned before invalidateOne

    // NEGATIVE control for lexical-vs-physical identity: an intermediate
    // hidden alias resolves to a visible canonical directory. Canonical-only
    // admission would therefore miss the hidden spelling and upsert it.
    const visibleDir = path.join(v.root, "Visible-target");
    const hiddenAlias = path.join(v.root, ".HiddenAlias");
    await fs.mkdir(visibleDir, { recursive: true });
    await fs.writeFile(path.join(visibleDir, "note.md"), "visible target");
    const aliasCreated = await fs
      .symlink(visibleDir, hiddenAlias)
      .then(() => true)
      .catch(() => false);
    if (process.env.CI) expect(aliasCreated, "CI must exercise watcher hidden-alias admission").toBe(true);
    if (aliasCreated) {
      const aliasPath = path.join(hiddenAlias, "note.md");
      const internals = w as unknown as {
        activationPlan(absPath: string): Promise<{ purge: ReadonlyArray<string>; upsert: string | null }>;
        inspectAliasPath(absPath: string): Promise<{ state: string }>;
      };
      await expect(internals.activationPlan(aliasPath)).resolves.toEqual({ purge: [aliasPath], upsert: null });
      await expect(internals.inspectAliasPath(aliasPath)).resolves.toEqual({ state: "purge" });
    }
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
    const hiddenAbs = path.join(v.root, ".hidden.md");
    await handle(hiddenAbs, "unlink");
    expect(invalidated).toEqual([abs, hiddenAbs]); // unlink proceeded PAST the exclude gate (cleanup runs)
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

  it("start() is one-shot and cannot orphan an already-running native watcher", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });
    await w.start();
    try {
      const nativeWatcher = (w as unknown as { watcher: FSWatcher | null }).watcher;
      expect(nativeWatcher).not.toBeNull();
      await expect(w.start()).rejects.toThrow(/already started/);
      expect((w as unknown as { watcher: FSWatcher | null }).watcher).toBe(nativeWatcher);
    } finally {
      await w.close();
    }
  });

  it("fails stop on a native error after ready and removes the listener on close", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });
    await w.start();
    const nativeWatcher = (w as unknown as { watcher: FSWatcher | null }).watcher;
    expect(nativeWatcher).not.toBeNull();
    if (!nativeWatcher) throw new Error("expected a started native watcher");

    expect(nativeWatcher.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(() => nativeWatcher.emit("error", new Error("late native watch failure"))).toThrow(
      /late native watch failure/
    );
    await w.close();
    expect(nativeWatcher.listenerCount("error")).toBe(0);
  });

  it("native ready resolves its owned wait and removes lifecycle listeners", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });
    const internals = w as unknown as {
      waitForWatcherReady(watcher: FSWatcher): Promise<void>;
      watcherReadyReject: ((reason: Error) => void) | null;
    };
    const nativeEmitter = new EventEmitter();
    const nativeWatcher = nativeEmitter as unknown as FSWatcher;
    const readiness = internals.waitForWatcherReady(nativeWatcher);
    const readinessHandled = readiness.catch(() => undefined);

    try {
      expect(nativeEmitter.listenerCount("ready")).toBe(1);
      expect(nativeEmitter.listenerCount("error")).toBe(1);
      expect(internals.watcherReadyReject).not.toBeNull();

      nativeEmitter.emit("ready");
      await readiness;

      expect(nativeEmitter.listenerCount("ready")).toBe(0);
      expect(nativeEmitter.listenerCount("error")).toBe(0);
      expect(internals.watcherReadyReject).toBeNull();
    } finally {
      await w.close().catch(() => {});
      await readinessHandled;
    }
  });

  it("close() rejects a pending native-ready wait and prevents post-close seeding", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const w = new VaultWatcher({ vault: v, silent: true });
    const internals = w as unknown as {
      watcher: FSWatcher | null;
      waitForWatcherReady(watcher: FSWatcher): Promise<void>;
      runTrackedPhysicalAliasSeed(): Promise<void>;
      watcherReadyReject: ((reason: Error) => void) | null;
    };

    let releaseNativeClose: (() => void) | undefined;
    const nativeCloseRelease = new Promise<void>((resolve) => {
      releaseNativeClose = resolve;
    });
    let nativeCloseCalls = 0;
    const nativeEmitter = new EventEmitter() as EventEmitter & { close(): Promise<void> };
    nativeEmitter.close = async () => {
      nativeCloseCalls += 1;
      await nativeCloseRelease;
    };
    const nativeWatcher = nativeEmitter as unknown as FSWatcher;
    internals.watcher = nativeWatcher;

    let seedCalls = 0;
    internals.runTrackedPhysicalAliasSeed = async () => {
      seedCalls += 1;
    };

    const readiness = internals.waitForWatcherReady(nativeWatcher);
    const readinessAssertion = expect(readiness).rejects.toThrow(/closing or closed/);
    const postReadySeed = readiness.then(() => internals.runTrackedPhysicalAliasSeed()).catch(() => undefined);

    let closeSettled = false;
    let closeTask: Promise<void> | undefined;
    try {
      expect(nativeEmitter.listenerCount("ready")).toBe(1);
      expect(nativeEmitter.listenerCount("error")).toBe(1);
      expect(internals.watcherReadyReject).not.toBeNull();

      closeTask = w.close().then(() => {
        closeSettled = true;
      });
      expect(nativeCloseCalls).toBe(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSettled, "close must await the native watcher's asynchronous close").toBe(false);

      releaseNativeClose?.();
      await closeTask;
      await readinessAssertion;
      await postReadySeed;

      expect(closeSettled).toBe(true);
      expect(nativeEmitter.listenerCount("ready")).toBe(0);
      expect(nativeEmitter.listenerCount("error")).toBe(0);
      expect(internals.watcherReadyReject).toBeNull();
      expect(internals.watcher).toBeNull();
      nativeEmitter.emit("ready");
      await Promise.resolve();
      expect(seedCalls).toBe(0);
    } finally {
      releaseNativeClose?.();
      if (closeTask) await closeTask.catch(() => {});
      else await w.close().catch(() => {});
    }
  });

  it("close() before start() is a no-op (idempotent)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    // Construct + close without start — this.watcher remains null, so
    // the inner branch at line 137 (if (this.watcher)) is skipped.
    const w = new VaultWatcher({ vault: v, silent: true });
    await w.close(); // creates + resolves the shared close promise
    await w.close(); // joins the same resolved promise
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
      await fts.closeAndRelease();
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
      await fts.closeAndRelease();
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
      await fts.closeAndRelease();
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
      await fts.closeAndRelease();
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
          const norm = Math.sqrt([...vec].reduce((sum, value) => sum + value * value, 0));
          for (let j = 0; j < mockDim; j++) vec[j] = (vec[j] ?? 0) / norm;
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
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
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
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
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
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }
  });

  // S-8d — embedding is preparation for a cross-index generation, not a
  // post-FTS best-effort tail. If preparation rejects, the event stays
  // fail-soft (log + return) but neither FTS5 nor EmbedDb may publish it.
  it("attachEmbed failures quarantine exact generations, heal on restart, and preserve alias convergence", async () => {
    const { EmbedDb } = await import("../src/embed-db.js");
    const v = new Vault(root);
    await v.ensureExists();
    const fts = new FtsIndex({ file: defaultIndexFile(root), vaultRoot: root });
    await fts.open();

    // An embedder that always throws — simulates embed pipeline failure.
    let embedCalls = 0;
    const throwingEmbedder = {
      model: { alias: "throwing-mock", hfId: "mock", dim: 4, multilingual: false, maxTokens: 128 },
      async embed(_texts: readonly string[]): Promise<Float32Array[]> {
        embedCalls += 1;
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

    let w: VaultWatcher | null = null;
    let activationWatcher: VaultWatcher | null = null;
    try {
      w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: false });
      w.attachEmbed(embedDb, throwingEmbedder, 0);
      const filePath = v.resolveInside("embed-error.md");
      await fs.writeFile(filePath, "# Heading\n\nBody for embed error test.\n");
      const handle = (
        w as unknown as {
          handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void>;
        }
      ).handle.bind(w);

      // Directly drive the deterministic handler seam: no chokidar polling or
      // re-touch can hide the first failed generation behind a later event.
      await handle(filePath, "add");

      expect(embedCalls).toBe(1);
      expect(
        captured.some((s) => s.includes("markdown preparation failed") && s.includes("synthetic embed failure"))
      ).toBe(true);
      expect(fts.totalFiles()).toBe(0);
      expect(embedDb.totalChunks()).toBe(0);
      expect(w.searchHealth.semanticUsable).toBe(true);

      await w.close();
      w = null;

      // The same preparation failure during startup replay is not absorbable:
      // activation must reject so production keeps its restart interlock armed.
      const activationPath = v.resolveInside("activation-embed-error.md");
      await fs.writeFile(activationPath, "# Activation\n\nMust not publish after a failed startup replay.\n");
      activationWatcher = new VaultWatcher({
        vault: v,
        ftsIndex: fts,
        silent: false,
        deferActivation: true
      });
      activationWatcher.attachEmbed(embedDb, throwingEmbedder, 0);
      (
        activationWatcher as unknown as {
          onFsEvent(absPath: string, kind: "add" | "change" | "unlink"): void;
        }
      ).onFsEvent(activationPath, "add");
      await expect(activationWatcher.activate()).rejects.toThrow(/synthetic embed failure/);
      await expect(activationWatcher.close()).rejects.toThrow(/synthetic embed failure/);
      expect(embedCalls).toBe(2);
      expect(fts.totalFiles()).toBe(0);
      expect(embedDb.totalChunks()).toBe(0);
    } finally {
      if (w) await w.close().catch(() => {});
      if (activationWatcher) await activationWatcher.close().catch(() => {});
      process.stderr.write = origWrite;
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }

    await assertEqualMtimePreparationQuarantine();
    await assertRestartQuarantineHealing();
    await assertHardlinkPreparationFailureContinues();
    await assertHardlinkCommitFailureContinues();
    await assertHardlinkControlConverges();
  });

  async function assertEqualMtimePreparationQuarantine(): Promise<void> {
    const { EmbedDb } = await import("../src/embed-db.js");
    const scenarioRoot = path.join(root, "equal-mtime-preparation");
    await fs.mkdir(scenarioRoot, { recursive: true });
    const v = new Vault(scenarioRoot);
    await v.ensureExists();
    const relPath = "equal-mtime-failure.md";
    const absPath = v.resolveInside(relPath);
    await fs.writeFile(absPath, "old_watcher_secret\n");
    const pinnedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(absPath, pinnedTime, pinnedTime);
    const indexedMtimeMs = (await fs.stat(absPath)).mtimeMs;

    const fts = new FtsIndex({
      file: path.join(scenarioRoot, ".cache", "equal-mtime.fts5.db"),
      vaultRoot: scenarioRoot
    });
    await fts.open();
    fts.reindexFile(relPath, indexedMtimeMs, "old_watcher_secret", [], []);
    const embedDb = new EmbedDb({
      file: path.join(scenarioRoot, ".cache", "equal-mtime.embed.db"),
      vaultRoot: scenarioRoot,
      modelAlias: "throwing-mock",
      dim: 4,
      quantization: "f32"
    });
    await embedDb.open();
    const vector = new Float32Array([1, 0, 0, 0]);
    embedDb.upsertNote(relPath, indexedMtimeMs, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "old_watcher_secret", vector }
    ]);
    const neverReachedEmbedder = {
      model: { alias: "throwing-mock", hfId: "mock", dim: 4, multilingual: false, maxTokens: 128 },
      async embed(_texts: readonly string[]): Promise<Float32Array[]> {
        throw new Error("embedder must not run after the injected source-read failure");
      }
    };
    const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
    w.attachEmbed(embedDb, neverReachedEmbedder, 0);

    try {
      // Positive control: both retained stores return the matching committed
      // generation before the watcher observes a failed replacement.
      expect(fts.search("old_watcher_secret", { limit: 5 })).toHaveLength(1);
      expect(embedDb.search(vector, 5)).toHaveLength(1);

      await fs.writeFile(absPath, "new generation with the same mtime\n");
      await fs.utimes(absPath, new Date(indexedMtimeMs), new Date(indexedMtimeMs));
      expect((await fs.stat(absPath)).mtimeMs).toBe(indexedMtimeMs);
      const originalReadNoteUncached = v.readNoteUncached;
      v.readNoteUncached = async () => {
        throw new Error("synthetic equal-mtime source-read failure");
      };
      try {
        await (
          w as unknown as {
            handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void>;
          }
        ).handle(absPath, "change");
      } finally {
        v.readNoteUncached = originalReadNoteUncached;
      }

      // Mutation control: physical old rows remain, but durable source-scoped
      // markers withhold both egresses and force retry despite equal mtime.
      expect(fts.totalChunks()).toBeGreaterThan(0);
      expect(embedDb.totalChunks()).toBeGreaterThan(0);
      expect(fts.search("old_watcher_secret", { limit: 5 })).toEqual([]);
      expect(embedDb.search(vector, 5)).toEqual([]);
      expect(embedDb.getQuarantinedPaths("md")).toEqual([relPath]);
      expect(fts.diff([{ relPath, mtimeMs: indexedMtimeMs }], "md").updated).toContain(relPath);
    } finally {
      await w.close();
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }
  }

  async function assertRestartQuarantineHealing(): Promise<void> {
    const { EmbedDb } = await import("../src/embed-db.js");
    const scenarioRoot = path.join(root, "restart-quarantine-healing");
    await fs.mkdir(scenarioRoot, { recursive: true });
    const v = new Vault(scenarioRoot);
    await v.ensureExists();
    const relPath = "restart-quarantine.md";
    const absPath = v.resolveInside(relPath);
    const content = "restart_quarantine_marker must become visible after a healthy activation retry\n";
    await fs.writeFile(absPath, content);
    const indexedMtimeMs = (await fs.stat(absPath)).mtimeMs;
    const ftsFile = path.join(scenarioRoot, ".cache", "restart-quarantine.fts5.db");
    const embedDbFile = path.join(scenarioRoot, ".cache", "restart-quarantine.embed.db");
    const seedFts = new FtsIndex({ file: ftsFile, vaultRoot: scenarioRoot });
    const seedEmbedDb = new EmbedDb({
      file: embedDbFile,
      vaultRoot: scenarioRoot,
      modelAlias: "restart-mock",
      dim: 4,
      quantization: "f32"
    });
    const vector = new Float32Array([1, 0, 0, 0]);
    await seedFts.open();
    try {
      await seedEmbedDb.open();
      try {
        seedFts.reindexFile(relPath, indexedMtimeMs, content, [], []);
        seedEmbedDb.upsertNote(relPath, indexedMtimeMs, [
          { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: content, vector }
        ]);
        seedFts.quarantineFile(relPath, "md");
        seedEmbedDb.quarantineSource(relPath, "md");
        seedFts.quarantineFile("missing-first-add.md", "md");
        seedEmbedDb.quarantineSource("missing-first-add.md", "md");
      } finally {
        seedEmbedDb.close();
      }
    } finally {
      seedFts.close();
    }

    // Exercise the actual restart boundary: activation receives fresh handles
    // opened from the exact durable stores written by the failed generation.
    const fts = new FtsIndex({ file: ftsFile, vaultRoot: scenarioRoot });
    const embedDb = new EmbedDb({
      file: embedDbFile,
      vaultRoot: scenarioRoot,
      modelAlias: "restart-mock",
      dim: 4,
      quantization: "f32"
    });
    await fts.open();
    await embedDb.open();
    const embedder = {
      model: { alias: "restart-mock", hfId: "mock", dim: 4, multilingual: false, maxTokens: 128 },
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        return texts.map(() => vector);
      }
    };
    const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true, deferActivation: true });
    w.attachEmbed(embedDb, embedder, 0);

    try {
      expect(fts.search("restart_quarantine_marker", { limit: 5 })).toEqual([]);
      expect(embedDb.search(vector, 5)).toEqual([]);

      await w.captureAttachedSinkDrift();
      const activation = w as unknown as {
        activationPaths: ReadonlySet<string>;
        activationStoredIdentities: ReadonlyMap<string, "md" | "pdf">;
      };
      expect(activation.activationPaths).toContain(absPath);
      expect(activation.activationStoredIdentities.get("missing-first-add.md")).toBe("md");
      await w.activate();

      expect(fts.search("restart_quarantine_marker", { limit: 5 }).map((hit) => hit.rel_path)).toEqual([relPath]);
      expect(embedDb.search(vector, 5).map((hit) => hit.rel_path)).toEqual([relPath]);
      expect(embedDb.getQuarantinedPaths("md")).toEqual([]);
      expect(fts.auditKind("md").mismatched_files).toBe(0);
    } finally {
      await w.close();
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }
  }

  async function assertHardlinkPreparationFailureContinues(): Promise<void> {
    const scenarioRoot = path.join(root, "hardlink-preparation-failure");
    await fs.mkdir(scenarioRoot, { recursive: true });
    const v = new Vault(scenarioRoot);
    await v.ensureExists();
    const aRel = "A-hardlink.md";
    const bRel = "B-hardlink.md";
    const aPath = v.resolveInside(aRel);
    const bPath = v.resolveInside(bRel);
    await fs.writeFile(aPath, "alias_old_secret\n");
    try {
      await fs.link(aPath, bPath);
    } catch (error) {
      throw new Error(`hardlink preparation-failure precondition failed: ${String(error)}`);
    }
    const pinnedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(aPath, pinnedTime, pinnedTime);
    const pinnedMtimeMs = pinnedTime.getTime();
    expect((await fs.stat(aPath)).mtimeMs).toBe(pinnedMtimeMs);
    expect((await fs.stat(bPath)).mtimeMs).toBe(pinnedMtimeMs);
    const fts = new FtsIndex({
      file: path.join(scenarioRoot, ".cache", "hardlink-failure.fts5.db"),
      vaultRoot: scenarioRoot
    });
    await fts.open();
    fts.reindexFile(aRel, pinnedMtimeMs, "alias_old_secret", [], []);
    fts.reindexFile(bRel, pinnedMtimeMs, "alias_old_secret", [], []);
    const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });

    try {
      await fs.writeFile(aPath, "alias_new_marker shared by both hardlinks\n");
      await fs.utimes(aPath, pinnedTime, pinnedTime);
      expect((await fs.stat(aPath)).mtimeMs).toBe(pinnedMtimeMs);
      expect((await fs.stat(bPath)).mtimeMs).toBe(pinnedMtimeMs);
      const originalReadNoteUncached = v.readNoteUncached.bind(v);
      v.readNoteUncached = async (...args: Parameters<Vault["readNoteUncached"]>) => {
        if (args[0] === aPath) throw new Error("synthetic alias preparation failure");
        return originalReadNoteUncached(...args);
      };
      try {
        await (w as unknown as { handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> }).handle(
          aPath,
          "change"
        );
      } finally {
        v.readNoteUncached = originalReadNoteUncached;
      }

      expect(fts.search("alias_old_secret", { limit: 10 })).toEqual([]);
      expect(fts.search("alias_new_marker", { limit: 10 }).map((hit) => hit.rel_path)).toEqual([bRel]);
      expect(fts.diff([{ relPath: aRel, mtimeMs: pinnedMtimeMs }], "md").updated).toContain(aRel);
      expect(fts.diff([{ relPath: bRel, mtimeMs: pinnedMtimeMs }], "md").unchanged).toContain(bRel);
    } finally {
      await w.close();
      await fts.closeAndRelease();
    }
  }

  async function assertHardlinkCommitFailureContinues(): Promise<void> {
    const scenarioRoot = path.join(root, "hardlink-commit-failure");
    await fs.mkdir(scenarioRoot, { recursive: true });
    const v = new Vault(scenarioRoot);
    await v.ensureExists();
    const aRel = "A-hardlink-commit.md";
    const bRel = "B-hardlink-commit.md";
    const aPath = v.resolveInside(aRel);
    const bPath = v.resolveInside(bRel);
    await fs.writeFile(aPath, "alias_commit_old\n");
    try {
      await fs.link(aPath, bPath);
    } catch (error) {
      throw new Error(`hardlink commit-failure precondition failed: ${String(error)}`);
    }
    const pinnedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(aPath, pinnedTime, pinnedTime);
    const pinnedMtimeMs = pinnedTime.getTime();
    expect((await fs.stat(aPath)).mtimeMs).toBe(pinnedMtimeMs);
    expect((await fs.stat(bPath)).mtimeMs).toBe(pinnedMtimeMs);
    const fts = new FtsIndex({
      file: path.join(scenarioRoot, ".cache", "hardlink-commit-failure.fts5.db"),
      vaultRoot: scenarioRoot
    });
    await fts.open();
    fts.reindexFile(aRel, pinnedMtimeMs, "alias_commit_old", [], []);
    fts.reindexFile(bRel, pinnedMtimeMs, "alias_commit_old", [], []);
    const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
    const originalReadNoteUncached = v.readNoteUncached.bind(v);
    const stagedReads = new Set<string>();
    v.readNoteUncached = async (...args: Parameters<Vault["readNoteUncached"]>) => {
      if (args[0] === aPath || args[0] === bPath) stagedReads.add(args[0]);
      return originalReadNoteUncached(...args);
    };
    const originalReindexFile = fts.reindexFile.bind(fts);
    let commitFailureInjected = false;
    let bothAliasesStagedAtFailure = false;
    let failedRelPath: string | undefined;
    fts.reindexFile = ((...args: Parameters<FtsIndex["reindexFile"]>) => {
      if (!commitFailureInjected && (args[0] === aRel || args[0] === bRel)) {
        commitFailureInjected = true;
        failedRelPath = args[0];
        bothAliasesStagedAtFailure = stagedReads.has(aPath) && stagedReads.has(bPath);
        throw new Error("synthetic source-scoped alias commit failure");
      }
      return originalReindexFile(...args);
    }) as FtsIndex["reindexFile"];

    try {
      await fs.writeFile(aPath, "alias_commit_new shared by both hardlinks\n");
      await fs.utimes(aPath, pinnedTime, pinnedTime);
      expect((await fs.stat(aPath)).mtimeMs).toBe(pinnedMtimeMs);
      expect((await fs.stat(bPath)).mtimeMs).toBe(pinnedMtimeMs);
      await (w as unknown as { handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> }).handle(
        aPath,
        "change"
      );

      expect(commitFailureInjected).toBe(true);
      expect(bothAliasesStagedAtFailure).toBe(true);
      if (failedRelPath === undefined) throw new Error("expected a source-scoped alias commit failure");
      const convergedRelPath = failedRelPath === aRel ? bRel : aRel;
      expect(fts.totalChunks()).toBe(2);
      expect(fts.search("alias_commit_old", { limit: 10 })).toEqual([]);
      expect(fts.search("alias_commit_new", { limit: 10 }).map((hit) => hit.rel_path)).toEqual([convergedRelPath]);
      expect(fts.diff([{ relPath: failedRelPath, mtimeMs: pinnedMtimeMs }], "md").updated).toContain(failedRelPath);
      expect(fts.diff([{ relPath: convergedRelPath, mtimeMs: pinnedMtimeMs }], "md").unchanged).toContain(
        convergedRelPath
      );
    } finally {
      fts.reindexFile = originalReindexFile;
      v.readNoteUncached = originalReadNoteUncached;
      await w.close();
      await fts.closeAndRelease();
    }
  }

  async function assertHardlinkControlConverges(): Promise<void> {
    const scenarioRoot = path.join(root, "hardlink-success-control");
    await fs.mkdir(scenarioRoot, { recursive: true });
    const v = new Vault(scenarioRoot);
    await v.ensureExists();
    const aRel = "A-hardlink-control.md";
    const bRel = "B-hardlink-control.md";
    const aPath = v.resolveInside(aRel);
    const bPath = v.resolveInside(bRel);
    await fs.writeFile(aPath, "alias_control_old\n");
    try {
      await fs.link(aPath, bPath);
    } catch (error) {
      throw new Error(`hardlink success-control precondition failed: ${String(error)}`);
    }
    const pinnedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(aPath, pinnedTime, pinnedTime);
    const pinnedMtimeMs = pinnedTime.getTime();
    expect((await fs.stat(aPath)).mtimeMs).toBe(pinnedMtimeMs);
    expect((await fs.stat(bPath)).mtimeMs).toBe(pinnedMtimeMs);
    const fts = new FtsIndex({
      file: path.join(scenarioRoot, ".cache", "hardlink-control.fts5.db"),
      vaultRoot: scenarioRoot
    });
    await fts.open();
    fts.reindexFile(aRel, pinnedMtimeMs, "alias_control_old", [], []);
    fts.reindexFile(bRel, pinnedMtimeMs, "alias_control_old", [], []);
    const w = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
    try {
      await fs.writeFile(aPath, "alias_control_new shared by both hardlinks\n");
      await fs.utimes(aPath, pinnedTime, pinnedTime);
      expect((await fs.stat(aPath)).mtimeMs).toBe(pinnedMtimeMs);
      expect((await fs.stat(bPath)).mtimeMs).toBe(pinnedMtimeMs);
      await (w as unknown as { handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void> }).handle(
        aPath,
        "change"
      );
      expect(fts.search("alias_control_old", { limit: 10 })).toEqual([]);
      expect(
        fts
          .search("alias_control_new", { limit: 10 })
          .map((hit) => hit.rel_path)
          .sort()
      ).toEqual([aRel, bRel]);
    } finally {
      await w.close();
      await fts.closeAndRelease();
    }
  }

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
      await fts.closeAndRelease();
    }
    await assertImageOnlyPdfMarkerClears();
  });

  async function assertImageOnlyPdfMarkerClears(): Promise<void> {
    const scenarioRoot = path.join(root, "image-only-sync");
    await fs.mkdir(scenarioRoot, { recursive: true });
    const v = new Vault(scenarioRoot);
    await v.ensureExists();
    const relPath = "image-only-retry.pdf";
    await fs.writeFile(v.resolveInside(relPath), makePdf({ pages: [""] }));
    const fts = new FtsIndex({
      file: path.join(scenarioRoot, ".cache", "image-only-retry.fts5.db"),
      vaultRoot: scenarioRoot
    });
    await fts.open();
    try {
      // Failed first ADD: there are no rows/source_state to delete, only the
      // durable marker that withholds and forces the next sync attempt.
      fts.quarantineFile(relPath, "pdf");
      expect(fts.auditKind("pdf").mismatched_files).toBe(1);

      // The PDF sync lives with the FTS persistence implementation rather than
      // registration-only server bootstrap, so tests can exercise it directly.
      const { syncPdfFtsIndex } = await import("../src/fts5.js");
      const report = await syncPdfFtsIndex(v, fts);

      expect(report).toMatchObject({ added: 0, updated: 0, skipped: 1, failed: 0, total_chunks: 0 });
      expect(fts.auditKind("pdf").mismatched_files).toBe(0);
      expect(
        fts.diff([{ relPath, mtimeMs: (await fs.stat(v.resolveInside(relPath))).mtimeMs }], "pdf").added
      ).toContain(relPath);
    } finally {
      await fts.closeAndRelease();
    }
  }

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
      await fts.closeAndRelease();
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
    const sharedGenerationAuthority = { ...embedDb.captureGenerationIdentity() };
    w.attachHnsw(index, rowsByLabel, persist ? persistFile : undefined, sharedGenerationAuthority);
    return { w, embedDb, index, rowsByLabel, persistFile, sharedGenerationAuthority, v, fts };
  }

  it("publishes a live upsert generation only after the synchronous HNSW diff", async () => {
    const { w, embedDb, index, sharedGenerationAuthority, fts } = await setup(false);
    const applyDiff = vi.spyOn(index, "applyDiff");
    const internals = w as unknown as {
      upsertEmbedAndSyncHnsw(
        relPath: string,
        mtimeMs: number,
        rows: ReadonlyArray<{
          chunkIndex: number;
          lineStart: number;
          lineEnd: number;
          textPreview: string;
          vector: Float32Array;
        }>,
        kind: "md" | "pdf"
      ): { oldIds: number[]; newIds: number[]; hnswResult: { removed: number; added: number } | null };
    };
    try {
      const priorEpoch = sharedGenerationAuthority.dbMutationEpoch;
      const vector = (await mockEmbedder.embed(["watcher-owned generation"]))[0] as Float32Array;
      const result = internals.upsertEmbedAndSyncHnsw(
        "watcher-owned.md",
        2,
        [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "watcher-owned", vector }],
        "md"
      );

      expect(applyDiff).toHaveBeenCalledOnce();
      expect(result.hnswResult).toEqual({ removed: 0, added: 1 });
      expect(sharedGenerationAuthority.dbMutationEpoch).toBeGreaterThan(priorEpoch);
      expect(sharedGenerationAuthority).toEqual(embedDb.captureGenerationIdentity());
      expect(w.searchHealth).toEqual({ semanticUsable: true, hnswUsable: true });
    } finally {
      await w.close();
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }
  });

  it("refuses a stale shared authority before attaching an HNSW candidate", async () => {
    const { w, embedDb, index, rowsByLabel, sharedGenerationAuthority, v, fts } = await setup(false);
    const { EmbedDb } = await import("../src/embed-db.js");
    const external = new EmbedDb({
      file: path.join(root, ".cache", "test.embed.db"),
      vaultRoot: root,
      modelAlias: "test-mock",
      dim: mockDim
    });
    const candidateWatcher = new VaultWatcher({ vault: v, ftsIndex: fts, silent: true });
    candidateWatcher.attachEmbed(embedDb, mockEmbedder, 0);
    await external.open();
    try {
      const vector = (await mockEmbedder.embed(["external attach drift"]))[0] as Float32Array;
      external.upsertNote("attach-drift.md", 2, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "attach drift", vector }
      ]);

      expect(() => candidateWatcher.attachHnsw(index, rowsByLabel, undefined, sharedGenerationAuthority)).toThrow(
        "shared HNSW authority does not match the current EmbedDb generation"
      );
      const internals = candidateWatcher as unknown as {
        hnsw: HnswIndex | null;
        hnswGenerationAuthority: object | null;
      };
      expect(internals.hnsw).toBeNull();
      expect(internals.hnswGenerationAuthority).toBeNull();
    } finally {
      await external.closeAndRelease();
      await candidateWatcher.close();
      await w.close();
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }
  });

  it("never blesses an external writer and keeps authoritative EmbedDb search usable", async () => {
    const { w, embedDb, index, sharedGenerationAuthority, fts } = await setup(false);
    const { EmbedDb } = await import("../src/embed-db.js");
    const external = new EmbedDb({
      file: path.join(root, ".cache", "test.embed.db"),
      vaultRoot: root,
      modelAlias: "test-mock",
      dim: mockDim
    });
    await external.open();
    const applyDiff = vi.spyOn(index, "applyDiff");
    const internals = w as unknown as {
      hnswPersistUnsafe: boolean;
      upsertEmbedAndSyncHnsw(
        relPath: string,
        mtimeMs: number,
        rows: ReadonlyArray<{
          chunkIndex: number;
          lineStart: number;
          lineEnd: number;
          textPreview: string;
          vector: Float32Array;
        }>,
        kind: "md" | "pdf"
      ): { hnswResult: { removed: number; added: number } | null };
    };
    try {
      const attachedAuthority = { ...sharedGenerationAuthority };
      const externalVector = (await mockEmbedder.embed(["external generation"]))[0] as Float32Array;
      external.upsertNote("external.md", 2, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "external", vector: externalVector }
      ]);
      const externalAuthority = external.captureGenerationIdentity();
      expect(externalAuthority.dbMutationEpoch).toBeGreaterThan(attachedAuthority.dbMutationEpoch);

      const watcherVector = (await mockEmbedder.embed(["watcher fallback generation"]))[0] as Float32Array;
      const result = internals.upsertEmbedAndSyncHnsw(
        "watcher-fallback.md",
        3,
        [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "watcher fallback", vector: watcherVector }],
        "md"
      );

      expect(result.hnswResult).toBeNull();
      expect(applyDiff).not.toHaveBeenCalled();
      expect(sharedGenerationAuthority).toEqual(attachedAuthority);
      expect(sharedGenerationAuthority).not.toEqual(externalAuthority);
      expect(embedDb.getSourceStates().map((row) => row.rel_path)).toEqual([
        "a.md",
        "external.md",
        "watcher-fallback.md"
      ]);
      expect(internals.hnswPersistUnsafe).toBe(true);
      expect(w.searchHealth).toEqual({ semanticUsable: true, hnswUsable: false });
    } finally {
      await external.closeAndRelease();
      await w.close();
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }
  });

  it("flushHnswToDisk skips a clean index and every generation with an uncertain live graph", async () => {
    const { w, embedDb, index, persistFile, v, fts } = await setup(true);
    const { isHnswGenerationBasename } = await import("../src/hnsw.js");
    const generationNames = async () =>
      (await fs.readdir(path.dirname(persistFile))).filter((entry) => isHnswGenerationBasename(persistFile, entry));
    try {
      const flushed = await w.flushHnswToDisk();
      expect(flushed).toBe(false);
      // Neither the stable pointer nor an immutable generation may be written.
      await expect(fs.access(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await generationNames()).toEqual([]);

      const watcherInternals = w as unknown as {
        hnswPersistUnsafe: boolean;
        handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void>;
        commitPdfGeneration(
          relPath: string,
          generation: {
            dev: bigint;
            ino: bigint;
            nlink: bigint;
            size: bigint;
            mtimeNs: bigint;
            ctimeNs: bigint;
            mtimeMs: number;
          },
          staged: {
            pages: ReadonlyArray<{ pageNumber: number; text: string }>;
            embedResult: undefined;
            embedSource: null;
          }
        ): string | undefined;
        commitUnlinkPath(relPath: string, isPdf: boolean): void;
        purgeStoredIdentity(relPath: string, kind: "md" | "pdf"): Promise<void>;
        syncHnswForFile(
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
        ): { removed: number; added: number } | null;
      };
      const syncHnswForFile = watcherInternals.syncHnswForFile.bind(w);
      const row = {
        vector: new Float32Array([1, 0, 0, 0]),
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 1,
        textPreview: "persistence safety control"
      };

      // First prove the index is dirty and would ordinarily persist.
      expect(syncHnswForFile("safe.md", "md", [], [{ id: 10_001, ...row }])).toEqual({
        removed: 0,
        added: 1
      });
      expect(w.searchHealth.hnswUsable).toBe(true);
      // Then model a native applyDiff that throws after the EmbedDb-side
      // mutation. The permanent unsafe latch must dominate the earlier dirty
      // state, otherwise close would stamp a partial graph with a fresh
      // EmbedDb signature and the next serve would trust it.
      const originalApplyDiff = index.applyDiff.bind(index);
      (
        index as unknown as {
          applyDiff(): { removed: number; added: number };
        }
      ).applyDiff = () => {
        throw new Error("synthetic partial HNSW diff");
      };
      expect(syncHnswForFile("unsafe.md", "md", [], [{ id: 10_002, ...row }])).toBeNull();
      expect(watcherInternals.hnswPersistUnsafe).toBe(true);
      expect(w.searchHealth.hnswUsable).toBe(false);

      // Class sibling: zipHnswAddPoints runs after the EmbedDb transaction but
      // before syncHnswForFile. Restore applyDiff so per-path quarantine can
      // drop the withheld labels. The markdown catch must not re-arm persist.
      index.applyDiff = originalApplyDiff;
      watcherInternals.hnswPersistUnsafe = false;
      w.searchHealth.hnswUsable = true;
      const originalConditionalUpsert = embedDb.upsertNoteWithCanonicalVectorsIfGeneration.bind(embedDb);
      let mismatchInjectedAfterCommit = false;
      embedDb.upsertNoteWithCanonicalVectorsIfGeneration = (
        ...args: Parameters<typeof embedDb.upsertNoteWithCanonicalVectorsIfGeneration>
      ) => {
        const result = originalConditionalUpsert(...args);
        if (result.kind !== "committed") return result;
        mismatchInjectedAfterCommit = args[3].length > 0 && result.value.newIds.length === args[3].length;
        return {
          ...result,
          value: { ...result.value, newIds: result.value.newIds.slice(1) }
        };
      };
      try {
        await watcherInternals.handle(v.resolveInside("a.md"), "change");
      } finally {
        embedDb.upsertNoteWithCanonicalVectorsIfGeneration = originalConditionalUpsert;
      }
      expect(mismatchInjectedAfterCommit).toBe(true);
      expect(watcherInternals.hnswPersistUnsafe).toBe(false);
      expect(w.searchHealth.hnswUsable).toBe(true);
      // Per-path quarantine is the correct scope. The markdown catch used to
      // latch semanticUsable globally, which disabled embeddings search for
      // every other note until restart. Each phase below is a causal negative
      // control for one of the four sites that carried that latch: restoring
      // `searchHealth.semanticUsable = false` at that site turns the phase red.
      // The live-queue overflow in scheduleLiveEvent remains latched and is
      // covered by tests/vault-bounded-listing.test.ts.
      expect(embedDb.getQuarantinedPaths("md")).toContain("a.md");
      expect(w.searchHealth.semanticUsable).toBe(true);

      const dummyGeneration = {
        dev: 0n,
        ino: 0n,
        nlink: 1n,
        size: 1n,
        mtimeNs: 0n,
        ctimeNs: 0n,
        mtimeMs: 1
      };

      const originalReindexPdfFile = fts.reindexPdfFile.bind(fts);
      fts.reindexPdfFile = () => {
        throw new Error("synthetic pdf commit failure");
      };
      try {
        w.searchHealth.semanticUsable = true;
        expect(
          watcherInternals.commitPdfGeneration("paper.pdf", dummyGeneration, {
            pages: [{ pageNumber: 1, text: "pdf" }],
            embedResult: undefined,
            embedSource: null
          })
        ).toBeUndefined();
        expect(embedDb.getQuarantinedPaths("pdf")).toEqual(["paper.pdf"]);
        expect(w.searchHealth.semanticUsable).toBe(true);
        expect(watcherInternals.hnswPersistUnsafe).toBe(false);
        expect(w.searchHealth.hnswUsable).toBe(true);
      } finally {
        fts.reindexPdfFile = originalReindexPdfFile;
      }

      const originalDeleteNote = embedDb.deleteNote.bind(embedDb);
      const originalDeleteNoteIfGeneration = embedDb.deleteNoteIfGeneration.bind(embedDb);
      embedDb.deleteNote = () => {
        throw new Error("synthetic embed-db delete failure");
      };
      embedDb.deleteNoteIfGeneration = () => {
        throw new Error("synthetic embed-db delete failure");
      };
      try {
        w.searchHealth.semanticUsable = true;
        watcherInternals.commitUnlinkPath("gone.md", false);
        expect(embedDb.getQuarantinedPaths("md")).toContain("gone.md");
        expect(w.searchHealth.semanticUsable).toBe(true);
      } finally {
        embedDb.deleteNote = originalDeleteNote;
        embedDb.deleteNoteIfGeneration = originalDeleteNoteIfGeneration;
      }

      const originalDropFile = fts.dropFile.bind(fts);
      fts.dropFile = () => {
        throw new Error("synthetic stored-identity purge failure");
      };
      try {
        w.searchHealth.semanticUsable = true;
        await expect(watcherInternals.purgeStoredIdentity("stale.md", "md")).rejects.toThrow(
          /synthetic stored-identity purge failure/
        );
        // Assignment-sensitive only: this method is activation-only and still
        // rethrows, so dropping the latch does not restore a live search path.
        expect(embedDb.getQuarantinedPaths("md")).toContain("stale.md");
        expect(w.searchHealth.semanticUsable).toBe(true);
      } finally {
        fts.dropFile = originalDropFile;
      }

      // The applyDiff throw for unsafe.md still left a partial native graph.
      // Re-arm that persist latch so close cannot stamp it. Per-path
      // quarantine no longer re-arms it.
      watcherInternals.hnswPersistUnsafe = true;
      w.searchHealth.hnswUsable = false;
      await expect(w.flushHnswToDisk()).resolves.toBe(false);
      await expect(fs.access(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await generationNames()).toEqual([]);
    } finally {
      await w.close();
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }
  });

  it("(NEGATIVE control) — flushHnswToDisk is a no-op when persistFile was omitted", async () => {
    const { w, embedDb, index, fts } = await setup(false); // persist=false → no persistFile
    try {
      // Force a live update directly on the index via the public applyDiff,
      // then set the watcher's dirty flag explicitly. This makes the test a
      // causal negative control for the missing-persistFile guard rather than
      // letting the earlier clean-index guard vacuously return false.
      index.applyDiff([], [{ label: 999, vector: new Float32Array([0.5, 0.5, 0.5, 0.5]) }]);
      const watcherInternals = w as unknown as { hnswDirty: boolean };
      watcherInternals.hnswDirty = true;
      expect(watcherInternals.hnswDirty).toBe(true);
      const flushed = await w.flushHnswToDisk();
      expect(flushed).toBe(false);
      expect(watcherInternals.hnswDirty).toBe(true);
    } finally {
      await w.close();
      await embedDb.closeAndRelease();
      await fts.closeAndRelease();
    }
  });

  it("close() flushes the live-updated index to a loadable sidecar with matching signature", async () => {
    const { w, embedDb, persistFile, fts } = await setup(true);
    const { isHnswGenerationBasename, loadHnswFromDisk } = await import("../src/hnsw.js");
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
    // Stable metadata must point to one strict immutable generation that exists.
    const meta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as { binFile: string };
    expect(isHnswGenerationBasename(persistFile, meta.binFile)).toBe(true);
    await expect(fs.access(path.join(path.dirname(persistFile), meta.binFile))).resolves.toBeUndefined();
    const snapshot = embedDb.captureHnswLoadSnapshot();
    const loaded = await loadHnswFromDisk(persistFile, snapshot.receipt.signature, {
      expectedDim: snapshot.receipt.dim,
      expectedRowsByLabel: snapshot.rowsByLabel,
      expectedVectorsByLabel: snapshot.vectorsByLabel
    });
    expect(loaded, "persisted sidecar should load with the post-edit signature").not.toBeNull();
    await embedDb.closeAndRelease();
    await fts.closeAndRelease();
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
    await embedDb.closeAndRelease();
    await fts.closeAndRelease();
  });
});

describe("VaultWatcher direct HNSW flush generation binding", () => {
  interface DirectFlushInternals {
    hnswDirty: boolean;
    hnswPersistUnsafe: boolean;
    hnsw: object | null;
    hnswRowsByLabel: Map<number, HnswRowMeta> | null;
    hnswPersistFile: string | null;
    embedDb: {
      captureHnswBuildSnapshot(): HnswBuildSnapshot;
      captureHnswReceiptSnapshot(): HnswReceiptSnapshot;
      getPersistenceFamilyScopes(): PersistenceFamilyScopes;
    } | null;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const row = (textPreview = "current"): HnswPersistenceRow => ({
    rel_path: "direct.md",
    chunk_index: 0,
    line_start: 1,
    line_end: 1,
    text_preview: textPreview,
    kind: "md"
  });

  const receipt = (payloadByte: "a" | "b"): HnswPersistenceReceipt => ({
    version: 3,
    signature: `direct-flush-${payloadByte}`,
    dbInstanceUuid: "d".repeat(32),
    dbMutationEpoch: payloadByte === "a" ? 11 : 12,
    dim: 4,
    activeRows: 1,
    maxLabel: 7,
    liveLabelSha256: "c".repeat(64),
    dbPayloadSha256: payloadByte.repeat(64)
  });

  const snapshot = (payloadByte: "a" | "b"): HnswReceiptSnapshot => ({
    receipt: receipt(payloadByte),
    rowsByLabel: new Map([[7, row()]])
  });

  const buildSnapshot = (payloadByte: "a" | "b"): HnswBuildSnapshot => {
    const current = snapshot(payloadByte);
    return {
      ...current,
      vectors: [
        {
          label: 7,
          vector: new Float32Array([1, 0, 0, 0]),
          ...row()
        }
      ]
    };
  };

  const compactIndex = (saveTo: HnswIndex["saveTo"]): HnswIndex => ({
    dim: 4,
    size: 1,
    searchKnn: () => ({ labels: [], distances: [] }),
    saveTo,
    applyDiff: () => ({ removed: 0, added: 0 }),
    resize: () => {},
    capacity: () => ({ currentCount: 1, maxElements: 1 })
  });

  const configure = (
    watcher: VaultWatcher,
    before: HnswBuildSnapshot,
    receipts: ReadonlyArray<HnswReceiptSnapshot>,
    persistFile: string | null = path.join(root, ".cache", "direct.hnsw")
  ): {
    internals: DirectFlushInternals;
    persistenceScopes: PersistenceFamilyScopes;
    receiptCaptures: () => number;
  } => {
    const internals = watcher as unknown as DirectFlushInternals;
    // The direct unit tests mock both native persistence and erasure. This
    // opaque sentinel proves that the watcher's exact pinned family authority
    // is threaded through both boundaries without creating real lease state.
    const persistenceScopes = Object.freeze({}) as PersistenceFamilyScopes;
    let receiptIndex = 0;
    internals.hnswDirty = true;
    internals.hnswPersistUnsafe = false;
    internals.hnsw = {};
    internals.hnswRowsByLabel = new Map(before.rowsByLabel);
    internals.hnswPersistFile = persistFile;
    internals.embedDb = {
      captureHnswBuildSnapshot: () => before,
      captureHnswReceiptSnapshot: () => {
        const next = receipts[receiptIndex];
        if (!next) throw new Error(`unexpected receipt capture ${receiptIndex + 1}`);
        receiptIndex += 1;
        return next;
      },
      getPersistenceFamilyScopes: () => persistenceScopes
    };
    return { internals, persistenceScopes, receiptCaptures: () => receiptIndex };
  };

  it("rejects a rowsByLabel mismatch before building a compact graph", async () => {
    const watcher = new VaultWatcher({ vault: new Vault(root), silent: true });
    const before = buildSnapshot("a");
    const fixture = configure(watcher, before, []);
    const { internals } = fixture;
    internals.hnswRowsByLabel = new Map([[7, row("stale")]]);
    const build = vi.spyOn(hnswModule, "buildHnsw");
    const clear = vi.spyOn(hnswModule, "clearHnswPersistedArtifacts");

    await expect(watcher.flushHnswToDisk()).resolves.toBe(false);
    expect(build).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(fixture.receiptCaptures()).toBe(0);
    expect(internals.hnswPersistUnsafe).toBe(true);
    expect(internals.hnswDirty).toBe(true);
    expect(watcher.searchHealth.hnswUsable).toBe(false);
  });

  it("rejects generation drift after compact build and never invokes saveTo", async () => {
    const watcher = new VaultWatcher({ vault: new Vault(root), silent: true });
    const before = buildSnapshot("a");
    const fixture = configure(watcher, before, [snapshot("b")]);
    const { internals } = fixture;
    const saveTo = vi.fn<HnswIndex["saveTo"]>().mockResolvedValue(true);
    const compact = compactIndex(saveTo);
    const build = vi.spyOn(hnswModule, "buildHnsw").mockResolvedValue(compact);
    const clear = vi.spyOn(hnswModule, "clearHnswPersistedArtifacts");

    await expect(watcher.flushHnswToDisk()).resolves.toBe(false);
    expect(build).toHaveBeenCalledWith([{ label: 7, vector: before.vectors[0]?.vector }], {
      dim: 4,
      maxElements: 1
    });
    expect(saveTo).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(fixture.receiptCaptures()).toBe(1);
    expect(internals.hnswPersistUnsafe).toBe(true);
    expect(internals.hnswDirty).toBe(true);
    expect(watcher.searchHealth.hnswUsable).toBe(false);
  });

  it("keeps the dirty retry state when compact saveTo returns false", async () => {
    const watcher = new VaultWatcher({ vault: new Vault(root), silent: true });
    const before = buildSnapshot("a");
    const fixture = configure(watcher, before, [snapshot("a")]);
    const { internals } = fixture;
    const saveTo = vi.fn<HnswIndex["saveTo"]>().mockResolvedValue(false);
    vi.spyOn(hnswModule, "buildHnsw").mockResolvedValue(compactIndex(saveTo));
    const clear = vi.spyOn(hnswModule, "clearHnswPersistedArtifacts");

    await expect(watcher.flushHnswToDisk()).resolves.toBe(false);
    expect(saveTo).toHaveBeenCalledWith(
      internals.hnswPersistFile,
      before.rowsByLabel,
      before.receipt.signature,
      {
        dbInstanceUuid: before.receipt.dbInstanceUuid,
        dbMutationEpoch: before.receipt.dbMutationEpoch
      },
      fixture.persistenceScopes
    );
    expect(clear).not.toHaveBeenCalled();
    expect(fixture.receiptCaptures()).toBe(1);
    expect(internals.hnswPersistUnsafe).toBe(false);
    expect(internals.hnswDirty).toBe(true);
    expect(watcher.searchHealth.hnswUsable).toBe(true);
  });

  it("clears the just-published family when the DB drifts after saveTo", async () => {
    const watcher = new VaultWatcher({ vault: new Vault(root), silent: true });
    const before = buildSnapshot("a");
    const fixture = configure(watcher, before, [snapshot("a"), snapshot("b")]);
    const { internals } = fixture;
    const events: string[] = [];
    const saveTo = vi.fn<HnswIndex["saveTo"]>().mockImplementation(async () => {
      events.push("save");
      return true;
    });
    vi.spyOn(hnswModule, "buildHnsw").mockImplementation(async () => {
      events.push("build");
      return compactIndex(saveTo);
    });
    const clear = vi.spyOn(hnswModule, "clearHnswPersistedArtifacts").mockImplementation(async () => {
      events.push("clear");
      return true;
    });

    await expect(watcher.flushHnswToDisk()).resolves.toBe(false);
    expect(events).toEqual(["build", "save", "clear"]);
    expect(clear).toHaveBeenCalledWith(internals.hnswPersistFile, fixture.persistenceScopes);
    expect(fixture.receiptCaptures()).toBe(2);
    expect(internals.hnswPersistUnsafe).toBe(true);
    expect(internals.hnswDirty).toBe(true);
    expect(watcher.searchHealth.hnswUsable).toBe(false);
  });

  it("persists a healthy compact snapshot and clears the dirty bit", async () => {
    const watcher = new VaultWatcher({ vault: new Vault(root), silent: true });
    const before = buildSnapshot("a");
    const fixture = configure(watcher, before, [snapshot("a"), snapshot("a")]);
    const { internals } = fixture;
    const saveTo = vi.fn<HnswIndex["saveTo"]>().mockResolvedValue(true);
    const compact = compactIndex(saveTo);
    const build = vi.spyOn(hnswModule, "buildHnsw").mockResolvedValue(compact);
    const clear = vi.spyOn(hnswModule, "clearHnswPersistedArtifacts");

    await expect(watcher.flushHnswToDisk()).resolves.toBe(true);
    expect(build).toHaveBeenCalledWith([{ label: 7, vector: before.vectors[0]?.vector }], {
      dim: 4,
      maxElements: 1
    });
    expect(saveTo).toHaveBeenCalledWith(
      internals.hnswPersistFile,
      before.rowsByLabel,
      before.receipt.signature,
      {
        dbInstanceUuid: before.receipt.dbInstanceUuid,
        dbMutationEpoch: before.receipt.dbMutationEpoch
      },
      fixture.persistenceScopes
    );
    expect(clear).not.toHaveBeenCalled();
    expect(fixture.receiptCaptures()).toBe(2);
    expect(internals.hnswPersistUnsafe).toBe(false);
    expect(internals.hnswDirty).toBe(false);
    expect(watcher.searchHealth.hnswUsable).toBe(true);
  });

  it("(NEGATIVE control) keeps a dirty graph unpersisted when persistFile is absent", async () => {
    const watcher = new VaultWatcher({ vault: new Vault(root), silent: true });
    const before = buildSnapshot("a");
    const fixture = configure(watcher, before, [], null);
    const { internals } = fixture;
    const build = vi.spyOn(hnswModule, "buildHnsw");
    const clear = vi.spyOn(hnswModule, "clearHnswPersistedArtifacts");

    expect(internals.hnswDirty).toBe(true);
    await expect(watcher.flushHnswToDisk()).resolves.toBe(false);
    expect(build).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(fixture.receiptCaptures()).toBe(0);
    expect(internals.hnswDirty).toBe(true);
  });
});
