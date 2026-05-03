import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chunkContent, FtsIndex, safeFts5Query } from "../src/fts5.js";

let canRunFts5 = true;
beforeAll(async () => {
  // better-sqlite3 is an optional dep — if it failed to compile on the host,
  // skip the FTS5 suite gracefully so unrelated CI still runs green.
  try {
    await import("better-sqlite3");
  } catch {
    canRunFts5 = false;
  }
});

let dbFile: string;
let dbDir: string;
beforeEach(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-fts5-"));
  dbFile = path.join(dbDir, "test.db");
});
afterEach(async () => {
  await fs.rm(dbDir, { recursive: true, force: true });
});

describe("safeFts5Query", () => {
  it("passes plain alphanumeric tokens unchanged", () => {
    expect(safeFts5Query("hello world")).toBe("hello world");
  });

  it("quote-wraps tokens containing hyphens (FTS5 treats `-` as NOT)", () => {
    expect(safeFts5Query("claude-telegram stuck")).toBe('"claude-telegram" stuck');
  });

  it("strips reserved FTS5 keywords (AND/OR/NOT/NEAR)", () => {
    expect(safeFts5Query("foo AND bar OR baz NOT qux")).toBe("foo bar baz qux");
  });

  it("escapes embedded double-quotes inside quote-wrapped tokens", () => {
    expect(safeFts5Query('a"b')).toBe('"a""b"');
  });

  it("returns empty string for whitespace-only or all-reserved input", () => {
    expect(safeFts5Query("")).toBe("");
    expect(safeFts5Query("AND OR NOT")).toBe("");
  });
});

describe("chunkContent", () => {
  it("returns empty array for empty content", () => {
    expect(chunkContent("")).toEqual([]);
  });

  it("splits on blank-line paragraphs", () => {
    const chunks = chunkContent("first paragraph\n\nsecond paragraph\n\nthird");
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.text).toBe("first paragraph");
    expect(chunks[1]?.text).toBe("second paragraph");
    expect(chunks[2]?.text).toBe("third");
  });

  it("keeps a paragraph intact when within size limit", () => {
    const text = "line one\nline two\nline three";
    const chunks = chunkContent(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe(text);
  });

  it("falls back to line-level splits when a paragraph exceeds the size cap", () => {
    const big = `${"x".repeat(3000)}\n${"y".repeat(3000)}\n${"z".repeat(3000)}`;
    const chunks = chunkContent(big, 4096);
    // Each line is 3000 chars, two together = 6001 > 4096, so each line goes solo.
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(4096);
  });

  it("hard-cuts a single line that exceeds the cap", () => {
    const huge = "a".repeat(10_000);
    const chunks = chunkContent(huge, 4096);
    expect(chunks.length).toBe(3); // 10000 / 4096 → 3 chunks
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(4096);
  });

  it("attaches 1-based line offsets", () => {
    const chunks = chunkContent("first\n\nsecond\n\nthird");
    expect(chunks[0]?.lineStart).toBe(1);
    expect(chunks[1]?.lineStart).toBeGreaterThan(1);
    expect(chunks[2]?.lineStart).toBeGreaterThan(chunks[1]?.lineStart ?? 0);
  });
});

describe("FtsIndex — full lifecycle", () => {
  it("indexes files, searches with BM25, and round-trips snippets", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
    await idx.open();
    try {
      idx.reindexFile("notes/alpha.md", 1000, "Alpha note about productivity and notes\n\nSecond paragraph here.");
      idx.reindexFile("notes/beta.md", 1001, "Beta note discussing Apollo project plans.\n\nDetails on rocketry.");
      idx.reindexFile("notes/gamma.md", 1002, "Gamma is unrelated to the search keywords above.");
      expect(idx.totalFiles()).toBe(3);
      expect(idx.totalChunks()).toBeGreaterThanOrEqual(5);

      const apolloHits = idx.search("Apollo");
      expect(apolloHits.length).toBeGreaterThan(0);
      expect(apolloHits[0]?.rel_path).toBe("notes/beta.md");
      expect(apolloHits[0]?.snippet.toLowerCase()).toContain("apollo");

      const productivityHits = idx.search("productivity");
      expect(productivityHits.length).toBe(1);
      expect(productivityHits[0]?.rel_path).toBe("notes/alpha.md");
    } finally {
      idx.close();
    }
  });

  it("incremental: diff() categorizes new / changed / deleted / unchanged", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
    await idx.open();
    try {
      idx.reindexFile("a.md", 1000, "alpha");
      idx.reindexFile("b.md", 1000, "beta");
      const diff1 = idx.diff([
        { relPath: "a.md", mtimeMs: 1000 },
        { relPath: "b.md", mtimeMs: 2000 }, // changed
        { relPath: "c.md", mtimeMs: 3000 } // new
      ]);
      expect(diff1.added).toEqual(["c.md"]);
      expect(diff1.updated).toEqual(["b.md"]);
      expect(diff1.unchanged).toEqual(["a.md"]);
      expect(diff1.deleted).toEqual([]);

      idx.dropFile("a.md");
      const diff2 = idx.diff([{ relPath: "b.md", mtimeMs: 1000 }]);
      expect(diff2.deleted).toEqual([]);
      // After dropFile + only b.md present in live, a.md is gone from state too
      expect(diff2.unchanged).toEqual(["b.md"]);
    } finally {
      idx.close();
    }
  });

  it("dropFile removes both chunks and source_state row", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
    await idx.open();
    try {
      idx.reindexFile("x.md", 1000, "to-be-deleted-marker should appear here");
      expect(idx.search("to-be-deleted-marker").length).toBe(1);
      idx.dropFile("x.md");
      expect(idx.search("to-be-deleted-marker").length).toBe(0);
      expect(idx.totalFiles()).toBe(0);
      expect(idx.totalChunks()).toBe(0);
    } finally {
      idx.close();
    }
  });

  it("clears the index when vault_root changes (cross-vault contamination guard)", async () => {
    if (!canRunFts5) return;
    const idx1 = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault-A" });
    await idx1.open();
    idx1.reindexFile("a.md", 1000, "marker-A");
    expect(idx1.totalFiles()).toBe(1);
    idx1.close();

    const idx2 = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault-B" });
    await idx2.open();
    expect(idx2.totalFiles()).toBe(0);
    expect(idx2.search("marker-A").length).toBe(0);
    idx2.close();
  });

  it("clears the index when tokenize mode changes (rebuild required)", async () => {
    if (!canRunFts5) return;
    const idx1 = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v", tokenize: "unicode61" });
    await idx1.open();
    idx1.reindexFile("a.md", 1000, "tokenize-mode-marker");
    expect(idx1.totalFiles()).toBe(1);
    idx1.close();

    const idx2 = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v", tokenize: "trigram" });
    await idx2.open();
    expect(idx2.totalFiles()).toBe(0);
    idx2.close();
  });

  it("appends a wikilink_targets meta-line so out-link recall hits", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      // The note's body says nothing about "Apollo" but it links to it.
      idx.reindexFile("daily.md", 1000, "Quick standup notes for today.", ["Apollo", "Hermes"]);
      const apolloHits = idx.search("Apollo");
      expect(apolloHits.length).toBe(1);
      expect(apolloHits[0]?.rel_path).toBe("daily.md");
    } finally {
      idx.close();
    }
  });

  it("folder filter restricts results to a subtree", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      idx.reindexFile("projects/a.md", 1000, "common-marker in projects");
      idx.reindexFile("inbox/b.md", 1000, "common-marker in inbox");
      const all = idx.search("common-marker");
      expect(all.length).toBe(2);
      const projectsOnly = idx.search("common-marker", { folder: "projects" });
      expect(projectsOnly.map((h) => h.rel_path)).toEqual(["projects/a.md"]);
    } finally {
      idx.close();
    }
  });

  it("tag filter exact-matches against comma-separated frontmatter+inline tags (v0.10.1)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      idx.reindexFile("a.md", 1000, "shared-marker", [], ["project", "core"]);
      idx.reindexFile("b.md", 1000, "shared-marker", [], ["core-team"]); // substring of "core"
      idx.reindexFile("c.md", 1000, "shared-marker", [], ["archive"]);
      // tag="core" must match a.md only — NOT b.md (which has "core-team", a substring trap).
      const coreOnly = idx.search("shared-marker", { tag: "core" });
      expect(coreOnly.map((h) => h.rel_path)).toEqual(["a.md"]);
      // tag="archive" matches just c.md.
      const archiveOnly = idx.search("shared-marker", { tag: "archive" });
      expect(archiveOnly.map((h) => h.rel_path)).toEqual(["c.md"]);
      // No filter: all three.
      const all = idx.search("shared-marker");
      expect(all.length).toBe(3);
    } finally {
      idx.close();
    }
  });

  it("since filter restricts to chunks from notes modified at or after a timestamp (v0.10.1)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      const t1 = Date.parse("2026-01-01T00:00:00Z");
      const t2 = Date.parse("2026-06-01T00:00:00Z");
      const t3 = Date.parse("2026-11-01T00:00:00Z");
      idx.reindexFile("old.md", t1, "deadline-marker old");
      idx.reindexFile("mid.md", t2, "deadline-marker mid");
      idx.reindexFile("new.md", t3, "deadline-marker new");
      const sinceMid = idx.search("deadline-marker", { sinceMtimeMs: t2 });
      expect(sinceMid.map((h) => h.rel_path).sort()).toEqual(["mid.md", "new.md"]);
      const sinceFuture = idx.search("deadline-marker", { sinceMtimeMs: Date.parse("2027-01-01T00:00:00Z") });
      expect(sinceFuture).toEqual([]);
    } finally {
      idx.close();
    }
  });

  it("combined filters (folder + tag + since) compose with AND semantics (v0.10.1)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      const recent = Date.parse("2026-06-01T00:00:00Z");
      const old = Date.parse("2025-06-01T00:00:00Z");
      idx.reindexFile("projects/x.md", recent, "combo-marker", [], ["project"]);
      idx.reindexFile("projects/y.md", recent, "combo-marker", [], ["archive"]);
      idx.reindexFile("inbox/z.md", recent, "combo-marker", [], ["project"]);
      idx.reindexFile("projects/old.md", old, "combo-marker", [], ["project"]);
      const r = idx.search("combo-marker", {
        folder: "projects",
        tag: "project",
        sinceMtimeMs: recent
      });
      // Only projects/x.md satisfies all three filters.
      expect(r.map((h) => h.rel_path)).toEqual(["projects/x.md"]);
    } finally {
      idx.close();
    }
  });
});
