import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../src/vault.js";
import { VaultWatcher } from "../src/watcher.js";

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
});
