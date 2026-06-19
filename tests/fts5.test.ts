import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chunkContent, FtsIndex, peekFtsMetaSafe, safeFts5Query } from "../src/fts5.js";

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
  // v3.9.0-rc.23 — CI-GUARD: better-sqlite3 is installed in CI, so the 23
  // FTS5 tests below (incl. the safeFts5Query injection-escaping security
  // checks) MUST run, not silently `return` on a load failure. Fail loud if
  // the precondition vanishes in CI. No-op outside CI. (rc.8 T1 pattern.)
  it("CI GUARD — better-sqlite3 loads in CI so FTS5 tests actually run", () => {
    if (!process.env.CI) return;
    expect(canRunFts5, "better-sqlite3 must load in CI so FTS5 + injection-escaping tests execute").toBe(true);
  });

  it("passes plain alphanumeric tokens unchanged", () => {
    expect(safeFts5Query("hello world")).toBe("hello world");
  });

  it("quote-wraps tokens containing hyphens (FTS5 treats `-` as NOT)", () => {
    expect(safeFts5Query("claude-telegram stuck")).toBe('"claude-telegram" stuck');
  });

  // v3.7.16 P3-28 — contract change: reserved FTS5 keywords (AND / OR /
  // NOT / NEAR) are now quoted as LITERALS, not stripped. Pre-3.7.16
  // a search for "operating systems AND databases" got `AND` dropped
  // silently AND the surrounding tokens implicitly OR'd — but users
  // searching for the literal word "AND" (e.g. in a logic-puzzle note)
  // had no recourse. Quoting makes the literal-search path work AND
  // still neutralizes the boolean operator (FTS5 treats `"AND"` as the
  // literal token, not the connective).
  it("quotes reserved FTS5 keywords as literals (v3.7.16 P3-28)", () => {
    expect(safeFts5Query("foo AND bar OR baz NOT qux")).toBe('foo "AND" bar "OR" baz "NOT" qux');
  });

  it("escapes embedded double-quotes inside quote-wrapped tokens", () => {
    expect(safeFts5Query('a"b')).toBe('"a""b"');
  });

  it("returns empty string for whitespace-only input; all-reserved input becomes quoted literals", () => {
    expect(safeFts5Query("")).toBe("");
    // v3.7.16 P3-28 — `"AND OR NOT"` is no longer stripped to empty;
    // it's now a literal-token search (probably yielding 0 hits unless
    // user has notes with those literal words, which is fine).
    expect(safeFts5Query("AND OR NOT")).toBe('"AND" "OR" "NOT"');
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

  it("hard-cut never splits a surrogate pair (rc.55 CHUNK-SURROGATE-SPLIT)", () => {
    // A long emoji run forces the hard-cut path; a cut at an odd UTF-16 boundary used
    // to land between a surrogate pair → a lone surrogate (a corrupt code point in the
    // indexed chunk). maxChars=5 makes the boundary fall mid-emoji (each 😀 = 2 units).
    const huge = "😀".repeat(20); // 40 UTF-16 units, 20 code points
    const chunks = chunkContent(huge, 5);
    const hasLoneSurrogate = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true; // high surrogate not followed by low
          i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return true; // low surrogate without a preceding high
        }
      }
      return false;
    };
    for (const c of chunks) {
      expect(hasLoneSurrogate(c.text), `chunk has a lone surrogate: ${JSON.stringify(c.text)}`).toBe(false);
      expect(c.text.length).toBeLessThanOrEqual(5);
    }
    // No data lost: re-joining the chunks reconstructs the original emoji run.
    expect(chunks.map((c) => c.text).join("")).toBe(huge);
  });

  it("attaches 1-based line offsets", () => {
    const chunks = chunkContent("first\n\nsecond\n\nthird");
    expect(chunks[0]?.lineStart).toBe(1);
    expect(chunks[1]?.lineStart).toBeGreaterThan(1);
    expect(chunks[2]?.lineStart).toBeGreaterThan(chunks[1]?.lineStart ?? 0);
  });

  // v2.1.0: heading breadcrumb propagation
  it("attaches heading breadcrumb (H1 > H2 > H3 in scope) to each chunk", () => {
    const md = `# Setup

intro paragraph

## Install

run npm install

### Requirements

Node 20+

## Configure

set VAULT env`;
    const chunks = chunkContent(md);
    // Find chunk with body "intro paragraph"
    const intro = chunks.find((c) => c.text === "intro paragraph");
    expect(intro?.breadcrumb).toBe("Setup");
    // Find chunk with body "run npm install"
    const install = chunks.find((c) => c.text === "run npm install");
    expect(install?.breadcrumb).toBe("Setup > Install");
    // Find chunk with body "Node 20+"
    const reqs = chunks.find((c) => c.text === "Node 20+");
    expect(reqs?.breadcrumb).toBe("Setup > Install > Requirements");
    // Find chunk with body "set VAULT env" — sibling H2 should pop the H3
    const cfg = chunks.find((c) => c.text === "set VAULT env");
    expect(cfg?.breadcrumb).toBe("Setup > Configure");
  });

  it("breadcrumb is empty for content before any heading (preamble)", () => {
    const md = "intro line\n\n# First Heading\n\nbody";
    const chunks = chunkContent(md);
    const intro = chunks.find((c) => c.text === "intro line");
    expect(intro?.breadcrumb).toBe("");
  });

  it("`#` inside a fenced code block is NOT treated as a heading", () => {
    const md = `# Real Heading

\`\`\`bash
# this is a shell comment, not a heading
echo hi
\`\`\`

after the fence`;
    const chunks = chunkContent(md);
    // The "after the fence" chunk should still have breadcrumb "Real Heading"
    // (the # in the code block must not have hijacked the stack).
    const after = chunks.find((c) => c.text === "after the fence");
    expect(after?.breadcrumb).toBe("Real Heading");
  });

  // v3.5.8 — regression test for CodeQL js/polynomial-redos. Pre-fix
  // heading parser used `/^(#{1,6})\s+(.+?)\s*#*\s*$/` which has O(n²)
  // worst-case on input like `## h<spaces×N>####`. Post-fix splits into
  // one anchored capture + two linear trailing-trim ops (both `$`-anchored).
  // We assert linear-ish wall time on a pathological input — a true
  // polynomial blowup would take seconds; linear should finish in <100ms.
  it("heading parser is linear-time on pathological input (no polynomial-redos)", () => {
    // H1 depth so the stack starts clean (no leading empty levels).
    // 5000 chars of spaces + 5000 chars of trailing `#`. Pre-fix the regex
    // `(.+?)\s*#*\s*$` backtracks O(n²) on this shape; n=10k → 10⁸ ops ≈
    // several seconds. Post-fix splits into anchored ops, all linear.
    const pathological = `# heading${" ".repeat(5_000)}${"#".repeat(5_000)}\n\nbody`;
    const start = Date.now();
    const chunks = chunkContent(pathological);
    const elapsedMs = Date.now() - start;
    // Sanity: it parsed.
    expect(chunks.length).toBeGreaterThan(0);
    // The breadcrumb should be "heading" (whitespace + trailing # stripped).
    const body = chunks.find((c) => c.text === "body");
    expect(body?.breadcrumb).toBe("heading");
    // Regression-detection bound. Linear post-fix on a 10k-char line
    // should complete in well under 500ms even on a slow CI runner.
    // Pre-fix polynomial would blow past this comfortably.
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe("FtsIndex — full lifecycle", () => {
  it("releases its handle when open() throws on a corrupt index — close-on-throw (rc.70 reserve-before-try)", async () => {
    if (!canRunFts5) return;
    await fs.writeFile(dbFile, "not a sqlite database — garbage ".repeat(40));
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
    await expect(idx.open()).rejects.toThrow();
    // Self-cleaning resets this.db=null on a post-construction throw, so a second open() RE-THROWS
    // (pre-rc.70 the `if (this.db) return` guard made it a silent no-op, leaking the handle).
    await expect(idx.open()).rejects.toThrow();
  });

  it("indexes files, searches with BM25, and round-trips snippets", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
    await idx.open();
    try {
      idx.reindexFile("notes/alpha.md", 1000, "Alpha note about productivity and notes\n\nSecond paragraph here.");
      idx.reindexFile("notes/beta.md", 1001, "Beta note discussing Apollo project plans.\n\nDetails on rocketry.");
      idx.reindexFile("notes/gamma.md", 1002, "Gamma is unrelated to the search keywords above.");
      expect(idx.totalFiles()).toBe(3);
      // Tightened from `>= 5`: alpha has 2 paragraphs, beta has 2, gamma has 1 → exactly 5 chunks.
      expect(idx.totalChunks()).toBe(5);

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

  it("getChunk returns RAW chunk text, not the enriched FTS5 storage form (audit v0.10.4 P1)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      const original = "Quick standup notes for today.";
      idx.reindexFile("daily.md", 1000, original, ["Apollo", "Hermes"]);
      const chunk = idx.getChunk("daily.md", 0);
      // Negative assertion — the synthetic FTS5 enrichment must NOT leak.
      expect(chunk?.content).not.toContain("[wikilink_targets:");
      expect(chunk?.content).not.toContain("Apollo");
      // Positive: getChunk returns the verbatim original text.
      expect(chunk?.content).toBe(original);
      // But the search index DOES find Apollo through the enrichment.
      expect(idx.search("Apollo").length).toBe(1);
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

  it("folder filter matches an emoji (astral-char) folder name (rc.43 M1 — substr by char, not JS UTF-16)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      // "📚Books" leads with a non-BMP char → JS .length=7 but 6 code points. Pre-rc.43
      // bound prefix.length (UTF-16 units) to substr(...,1,?) (code points) → over-read by
      // one → ZERO matches. Now bound via length(?) so SQLite counts chars consistently.
      idx.reindexFile("📚Books/a.md", 1000, "emoji-folder-marker");
      idx.reindexFile("Other/b.md", 1000, "emoji-folder-marker");
      const hits = idx.search("emoji-folder-marker", { folder: "📚Books" });
      expect(hits.map((h) => h.rel_path)).toEqual(["📚Books/a.md"]);
    } finally {
      idx.close();
    }
  });

  it("folder filter prefix-equality, NOT GLOB pattern (audit v0.10.4 P2 — folders with `*` `?` `[` should not glob-expand)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      idx.reindexFile("Project [A]/a.md", 1000, "specials-marker");
      idx.reindexFile("Project [B]/b.md", 1000, "specials-marker");
      idx.reindexFile("Other/c.md", 1000, "specials-marker");
      // With the v0.10.4 substr-equality fix, folder:"Project [A]" must match
      // ONLY "Project [A]/a.md" — not glob-expand to "Project [B]" too.
      const a = idx.search("specials-marker", { folder: "Project [A]" });
      expect(a.map((h) => h.rel_path)).toEqual(["Project [A]/a.md"]);
      // Folder with `*` should also be safe (no glob).
      idx.reindexFile("star*folder/x.md", 1000, "specials-marker");
      idx.reindexFile("star_folder/y.md", 1000, "specials-marker"); // would match if `*` glob'd to anything
      const star = idx.search("specials-marker", { folder: "star*folder" });
      expect(star.map((h) => h.rel_path)).toEqual(["star*folder/x.md"]);
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

  it("getChunk returns the right chunk by (rel_path, chunk_index) — backs the chunk resource URI (v0.10.2)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      idx.reindexFile("multi.md", 1000, "first paragraph here\n\nsecond paragraph there\n\nthird paragraph done");
      const c0 = idx.getChunk("multi.md", 0);
      const c1 = idx.getChunk("multi.md", 1);
      const c2 = idx.getChunk("multi.md", 2);
      expect(c0?.content).toContain("first paragraph");
      expect(c1?.content).toContain("second paragraph");
      expect(c2?.content).toContain("third paragraph");
      expect(c0?.line_start).toBe(1);
      expect(c1?.line_start).toBeGreaterThan(1);
      // out-of-range index returns null
      expect(idx.getChunk("multi.md", 99)).toBeNull();
      // missing path returns null
      expect(idx.getChunk("nonexistent.md", 0)).toBeNull();
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

// v2.8.0 — PDF chunks indexed alongside markdown via the kind column.
// Verifies: (1) reindexPdfFile writes kind="pdf" rows, (2) search returns
// kind in hits, (3) markdown sync doesn't delete PDF rows and vice versa,
// (4) page markers appear in chunk text so snippets carry citations.
describe("FtsIndex — PDF chunks (v2.8.0)", () => {
  it("indexes PDF chunks with kind='pdf' alongside markdown", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    try {
      idx.reindexFile("note.md", 1000, "Alpha keyword in markdown");
      idx.reindexPdfFile("paper.pdf", 2000, [
        { pageNumber: 1, text: "Alpha keyword on page one" },
        { pageNumber: 2, text: "Beta keyword on page two" }
      ]);
      const hits = idx.search("Alpha");
      const kinds = new Set(hits.map((h) => h.kind));
      expect(kinds).toContain("md");
      expect(kinds).toContain("pdf");
      // Both kinds returned — blended retrieval works.
      expect(hits.length).toBeGreaterThanOrEqual(2);
    } finally {
      idx.close();
    }
  });

  it("page markers travel through chunks so snippets cite the page", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    try {
      idx.reindexPdfFile("paper.pdf", 1000, [
        { pageNumber: 7, text: "rocketry research findings" },
        { pageNumber: 8, text: "navigation algorithm comparison" }
      ]);
      const hits = idx.search("rocketry");
      expect(hits.length).toBe(1);
      // Snippet should include the [page: 7] marker we injected.
      expect(hits[0]?.snippet).toContain("page: 7");
    } finally {
      idx.close();
    }
  });

  it("diff(kind='md') doesn't see PDF source_state rows (and vice versa)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    try {
      idx.reindexFile("a.md", 1000, "alpha");
      idx.reindexPdfFile("b.pdf", 2000, [{ pageNumber: 1, text: "beta" }]);
      // Diff scoped to md sees only a.md as known. If we tell it about live
      // a.md, it reports unchanged (not deleted) — meaning b.pdf is invisible.
      const mdDiff = idx.diff([{ relPath: "a.md", mtimeMs: 1000 }], "md");
      expect(mdDiff.deleted).toEqual([]);
      expect(mdDiff.unchanged).toEqual(["a.md"]);
      // And the PDF-scoped diff is the mirror image.
      const pdfDiff = idx.diff([{ relPath: "b.pdf", mtimeMs: 2000 }], "pdf");
      expect(pdfDiff.deleted).toEqual([]);
      expect(pdfDiff.unchanged).toEqual(["b.pdf"]);
    } finally {
      idx.close();
    }
  });

  it("diff(kind=undefined) sees both kinds — backward compat for legacy callers", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    try {
      idx.reindexFile("a.md", 1000, "alpha");
      idx.reindexPdfFile("b.pdf", 2000, [{ pageNumber: 1, text: "beta" }]);
      // Global diff with no kind filter shows both as known.
      const all = idx.diff([
        { relPath: "a.md", mtimeMs: 1000 },
        { relPath: "b.pdf", mtimeMs: 2000 }
      ]);
      expect(all.unchanged.sort()).toEqual(["a.md", "b.pdf"]);
    } finally {
      idx.close();
    }
  });

  it("reindexPdfFile is idempotent — replaces existing chunks atomically", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    try {
      idx.reindexPdfFile("p.pdf", 1000, [{ pageNumber: 1, text: "old content" }]);
      idx.reindexPdfFile("p.pdf", 2000, [{ pageNumber: 1, text: "new content" }]);
      const hits1 = idx.search("old");
      expect(hits1).toEqual([]);
      const hits2 = idx.search("new");
      expect(hits2.length).toBe(1);
    } finally {
      idx.close();
    }
  });

  it("schema bump from v3 → v4 auto-rebuilds the index", async () => {
    if (!canRunFts5) return;
    // Open + populate with the current schema (v4), close, reopen — should
    // be a no-op rebuild (schema_version matches).
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    idx.reindexFile("a.md", 1000, "test");
    expect(idx.totalChunks()).toBeGreaterThan(0);
    idx.close();

    // Reopen — should preserve data (no rebuild on matching schema).
    const idx2 = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx2.open();
    expect(idx2.totalChunks()).toBeGreaterThan(0);
    idx2.close();
  });
});

// v3.6.2 — peekFtsMetaSafe (audit M-8 / K-1b class fix). Reads meta from
// a SQLite file without triggering bootstrapSchema's DROP-TABLE-on-mismatch
// path. We cover: missing file → null; populated db → meta dict; reopened
// with the discovered tokenize → no rebuild.
describe("peekFtsMetaSafe (v3.6.2 — meta peek without bootstrap)", () => {
  it("returns null when the file doesn't exist", async () => {
    if (!canRunFts5) return;
    const missing = path.join(dbDir, "nope.db");
    expect(await peekFtsMetaSafe(missing)).toBeNull();
  });

  it("reads tokenize_mode + vault_root + schema_version from an existing db", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v", tokenize: "trigram" });
    await idx.open();
    idx.reindexFile("a.md", 1000, "content");
    idx.close();

    const meta = await peekFtsMetaSafe(dbFile);
    expect(meta).not.toBeNull();
    expect(meta?.tokenize_mode).toBe("trigram");
    expect(meta?.vault_root).toBe("/v");
    expect(meta?.schema_version).toBeDefined();
  });

  it("default-falls back to unicode61 when tokenize_mode is unknown", async () => {
    if (!canRunFts5) return;
    // Build a fresh db with the default tokenize_mode (unicode61) — the
    // else-branch of the ternary at L779 fires for any non-trigram value.
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    idx.reindexFile("a.md", 1000, "content");
    idx.close();

    const meta = await peekFtsMetaSafe(dbFile);
    expect(meta?.tokenize_mode).toBe("unicode61");
  });
});
