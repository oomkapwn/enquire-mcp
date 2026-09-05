import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunkContent,
  deriveFtsTitle,
  discoverFtsIndexConfig,
  extractAliases,
  FtsIndex,
  ftsFolderToken,
  ftsPathToken,
  ftsScopeTokens,
  peekFtsMetaSafe,
  safeFts5Query,
  splitIdentifierParts,
  syncFtsIndex,
  type TokenizeMode
} from "../src/fts5.js";
import { FTS_SCHEMA_VERSION } from "../src/schema-contract.js";
import { Vault } from "../src/vault.js";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

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
  dbFile = path.join(dbDir, "test.fts5.db");
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
  const logicalTerminators = [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
    ["LS", "\u2028"],
    ["PS", "\u2029"]
  ] as const;

  it("returns empty array for empty content", () => {
    expect(chunkContent("")).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects non-progressing or non-integral maxChars=%s before chunking",
    (maxChars) => {
      expect(() => chunkContent("non-empty content", maxChars)).toThrow(
        new RangeError("maxChars must be a positive safe integer")
      );
      expect(() => chunkContent("", maxChars)).toThrow(RangeError);
    }
  );

  it("accepts the one-unit boundary and reconstructs ASCII content exactly", () => {
    const content = "abcd";
    const chunks = chunkContent(content, 1);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["a", "b", "c", "d"]);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(content);
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

  it.each(logicalTerminators)(
    "splits %s blank-line paragraphs with exact monotonic logical-line coordinates",
    (_name, end) => {
      const chunks = chunkContent(`first${end}${end}second${end}${end}third`);
      expect(chunks.map((chunk) => chunk.text)).toEqual(["first", "second", "third"]);
      expect(chunks.map((chunk) => [chunk.lineStart, chunk.lineEnd])).toEqual([
        [1, 1],
        [3, 3],
        [5, 5]
      ]);
    }
  );

  it("treats adjacent mixed logical terminators as one paragraph boundary", () => {
    expect(chunkContent("first\r\n\u2028second")).toEqual([
      { text: "first", lineStart: 1, lineEnd: 1, breadcrumb: "" },
      { text: "second", lineStart: 3, lineEnd: 3, breadcrumb: "" }
    ]);
  });

  it.each(logicalTerminators)(
    "packs %s-separated lines at the exact maxChars boundary without normalizing bytes",
    (_name, end) => {
      const firstChunk = `aa${end}bb`;
      const content = `${firstChunk}${end}cccc`;
      const chunks = chunkContent(content, firstChunk.length);
      expect(chunks.map((chunk) => chunk.text)).toEqual([firstChunk, "cccc"]);
      expect(chunks.map((chunk) => [chunk.lineStart, chunk.lineEnd])).toEqual([
        [1, 2],
        [3, 3]
      ]);
      expect(chunks.every((chunk) => chunk.text.length <= firstChunk.length)).toBe(true);
    }
  );

  it.each(logicalTerminators)(
    "updates breadcrumbs and line coordinates after %s-separated headings inside one oversize paragraph",
    (_name, end) => {
      const content = `# A${end}body${end}## B${end}tail`;
      const chunks = chunkContent(content, 4);
      expect(chunks.map((chunk) => chunk.text)).toEqual(["# A", "body", "## B", "tail"]);
      expect(chunks.map((chunk) => chunk.breadcrumb)).toEqual(["A", "A", "A > B", "A > B"]);
      expect(chunks.map((chunk) => [chunk.lineStart, chunk.lineEnd])).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4]
      ]);
    }
  );

  it("preserves a mixed logical-terminator paragraph byte-for-byte when it fits", () => {
    const content = "a\r\nb\rc\u2028d\u2029e\nf";
    expect(chunkContent(content, content.length)).toEqual([
      { text: content, lineStart: 1, lineEnd: 6, breadcrumb: "" }
    ]);
  });

  it("keeps every mixed-terminator chunk an ordered exact source substring with coordinate-derived ranges", () => {
    const countLogicalBreaks = (text: string): number => text.match(/\r\n|[\n\r\u2028\u2029]/gu)?.length ?? 0;
    for (const [, firstEnd] of logicalTerminators) {
      for (const [, secondEnd] of logicalTerminators) {
        const content = `# H${firstEnd}aa${secondEnd}## S${firstEnd}bb`;
        const chunks = chunkContent(content, 6);
        let sourceCursor = 0;
        let previousLineEnd = 0;
        for (const chunk of chunks) {
          const sourceOffset = content.indexOf(chunk.text, sourceCursor);
          expect(
            sourceOffset,
            `${JSON.stringify(chunk.text)} must be an ordered exact source substring`
          ).toBeGreaterThanOrEqual(sourceCursor);
          const expectedStart = countLogicalBreaks(content.slice(0, sourceOffset)) + 1;
          const expectedEnd = expectedStart + countLogicalBreaks(chunk.text);
          expect([chunk.lineStart, chunk.lineEnd]).toEqual([expectedStart, expectedEnd]);
          expect(chunk.lineStart).toBeGreaterThanOrEqual(previousLineEnd);
          sourceCursor = sourceOffset + chunk.text.length;
          previousLineEnd = chunk.lineEnd;
        }
      }
    }
  });

  it("NEGATIVE mutation control — the legacy LF-only boundary misses CR paragraphs that canonical chunking finds", () => {
    const content = "first\r\rsecond";
    const legacyParagraphs = content.split(/\n{2,}/);
    expect(legacyParagraphs).toEqual([content]);
    expect(chunkContent(content).map((chunk) => chunk.text)).toEqual(["first", "second"]);
  });

  it("structurally routes chunk boundaries through the canonical logical-line authority", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/fts5.ts"), "utf8");
    const chunkStart = source.indexOf("export function chunkContent");
    const chunkEnd = source.indexOf("export function computeBreadcrumbsByLine", chunkStart);
    const body = source.slice(chunkStart, chunkEnd);
    const hasLfOnlyBoundary = (candidate: string): boolean =>
      /splitWithLines\([^,]+,\s*\/\\n(?:\{2,\})?\//u.test(candidate);
    expect(body).toContain("chunkLogicalLines(content)");
    expect(source).not.toContain("function splitWithLines");
    expect(hasLfOnlyBoundary(source)).toBe(false);
    expect(hasLfOnlyBoundary("splitWithLines(content, /\\n{2,}/)")).toBe(true);
    expect(hasLfOnlyBoundary("splitWithLines(paragraph, /\\n/)")).toBe(true);
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

describe("FtsIndex — exact namespace admission and bounded erasure", () => {
  const invalidNames = [
    ["missing suffix", "index.db"],
    ["uppercase suffix", "index.FTS5.DB"],
    ["trailing LF", "index.fts5.db\n"],
    ["trailing U+2028", "index.fts5.db\u2028"]
  ] as const;
  const invalidAdmissionCases = [
    {
      route: "constructor",
      invoke: async (file: string) => {
        new FtsIndex({ file, vaultRoot: "/v" });
      }
    },
    {
      route: "discovery",
      invoke: async (file: string) => discoverFtsIndexConfig(file, "/v")
    },
    {
      route: "diagnostic peek",
      invoke: async (file: string) => peekFtsMetaSafe(file, "/v")
    }
  ].flatMap(({ route, invoke }) => invalidNames.map(([shape, basename]) => ({ route, invoke, shape, basename })));

  it.each(invalidAdmissionCases)("$route rejects $shape before filesystem work", async ({ invoke, basename }) => {
    const absentParent = path.join(dbDir, `invalid-${Buffer.from(basename).toString("hex")}`);
    const candidate = path.join(absentParent, basename);
    await expect(invoke(candidate)).rejects.toThrow(new TypeError("FTS index file must end exactly in '.fts5.db'"));
    await expect(fs.lstat(absentParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.for([
    {
      route: "mutating open",
      verify: async (file: string) => {
        const index = new FtsIndex({ file, vaultRoot: "/v" });
        try {
          await expect(index.open()).rejects.toThrow(/artifact family could not be admitted/);
        } finally {
          await index.closeAndRelease();
        }
      }
    },
    {
      route: "configuration discovery",
      verify: async (file: string) => {
        await expect(discoverFtsIndexConfig(file, "/v")).resolves.toEqual({ kind: "refused" });
      }
    },
    {
      route: "diagnostic peek",
      verify: async (file: string) => {
        await expect(peekFtsMetaSafe(file, "/v")).resolves.toBeNull();
      }
    }
  ])(
    "$route refuses a symlink SQLite sidecar without changing either sentinel",
    async ({ route, verify }, { skip }) => {
      const file = path.join(dbDir, `unsafe-open-${route.replaceAll(" ", "-")}.fts5.db`);
      const unsafeWal = `${file}-wal`;
      const external = `${file}.external`;
      const mainSentinel = Buffer.from(`FTS_MAIN_SENTINEL_${route}`);
      const externalSentinel = Buffer.from(`FTS_EXTERNAL_SENTINEL_${route}`);
      await fs.writeFile(file, mainSentinel);
      await fs.writeFile(external, externalSentinel);
      try {
        await fs.symlink(external, unsafeWal, "file");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          skip(`filesystem cannot create the FTS sidecar symlink control (${code})`);
          return;
        }
        throw error;
      }

      await verify(file);

      expect(await fs.readFile(file)).toEqual(mainSentinel);
      expect(await fs.readFile(external)).toEqual(externalSentinel);
      expect((await fs.lstat(unsafeWal)).isSymbolicLink()).toBe(true);
    }
  );

  it.each(["unsafe rollback-journal directory"])(
    "preflights the complete family before deleting around an %s",
    async () => {
      const wal = `${dbFile}-wal`;
      const shm = `${dbFile}-shm`;
      const journal = `${dbFile}-journal`;
      await fs.writeFile(dbFile, "MAIN_SENTINEL");
      await fs.writeFile(wal, "WAL_SENTINEL");
      await fs.writeFile(shm, "SHM_SENTINEL");
      await fs.mkdir(journal);

      const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
      await expect(idx.clearOnDisk()).rejects.toThrow("Refusing to clear an unsafe FTS index artifact");
      expect(await fs.readFile(dbFile, "utf8")).toBe("MAIN_SENTINEL");
      expect(await fs.readFile(wal, "utf8")).toBe("WAL_SENTINEL");
      expect(await fs.readFile(shm, "utf8")).toBe("SHM_SENTINEL");
      expect((await fs.lstat(journal)).isDirectory()).toBe(true);
    }
  );

  it.each(["rollback journal"])("removes a recognized %s with the main index", async () => {
    const journal = `${dbFile}-journal`;
    await fs.writeFile(dbFile, "MAIN_SENTINEL");
    await fs.writeFile(journal, "JOURNAL_SENTINEL");
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });

    await expect(idx.clearOnDisk()).resolves.toBe(true);
    await expect(fs.lstat(dbFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(journal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["inspection", "deletion", "receipt"] as const)("reports a non-ENOENT %s failure", async (phase) => {
    const wal = `${dbFile}-wal`;
    const shm = `${dbFile}-shm`;
    const journal = `${dbFile}-journal`;
    await fs.writeFile(dbFile, "MAIN_SENTINEL");
    await fs.writeFile(wal, "WAL_SENTINEL");
    await fs.writeFile(shm, "SHM_SENTINEL");
    await fs.writeFile(journal, "JOURNAL_SENTINEL");
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    const canonicalDbFile = path.join(await fs.realpath(dbDir), path.basename(dbFile));
    const canonicalWal = `${canonicalDbFile}-wal`;
    const denied = Object.assign(new Error("injected access denial"), { code: "EACCES" });

    if (phase === "inspection") {
      const realLstat = fs.lstat.bind(fs);
      const spy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, ...args) => {
        if (String(candidate) === canonicalWal) throw denied;
        return realLstat(candidate, ...args);
      });
      try {
        await expect(idx.clearOnDisk()).rejects.toThrow("Unable to inspect FTS index artifacts before clearing");
      } finally {
        spy.mockRestore();
      }
    } else if (phase === "deletion") {
      const realUnlink = fs.unlink.bind(fs);
      const spy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
        if (String(candidate) === canonicalDbFile) throw denied;
        return realUnlink(candidate);
      });
      try {
        // AH-5 — the failure names the exact artifact that survived.
        await expect(idx.clearOnDisk()).rejects.toThrow(
          `Unable to remove FTS index artifact: ${path.basename(dbFile)}`
        );
      } finally {
        spy.mockRestore();
      }
    } else {
      // AH-5 — a filesystem that reports unlink success while the entry
      // survives must not produce a "removed" receipt: the removal is
      // re-statted and the surviving artifact is named.
      const realUnlink = fs.unlink.bind(fs);
      const spy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
        if (String(candidate) === canonicalDbFile) return;
        return realUnlink(candidate);
      });
      try {
        await expect(idx.clearOnDisk()).rejects.toThrow(
          `FTS index artifact still present after removal: ${path.basename(dbFile)}`
        );
      } finally {
        spy.mockRestore();
      }
    }

    expect(await fs.readFile(dbFile, "utf8")).toBe("MAIN_SENTINEL");
    expect(await fs.readFile(wal, "utf8")).toBe("WAL_SENTINEL");
    expect(await fs.readFile(shm, "utf8")).toBe("SHM_SENTINEL");
    expect(await fs.readFile(journal, "utf8")).toBe("JOURNAL_SENTINEL");
  });

  it.for([{ leaf: "main symlink" }])(
    "unlinks a recognized $leaf without following its target",
    async (_fixture, ctx) => {
      const sentinel = path.join(dbDir, "external-sentinel.txt");
      await fs.writeFile(sentinel, "EXTERNAL_SENTINEL");
      try {
        await fs.symlink(sentinel, dbFile, "file");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          return ctx.skip(`filesystem cannot create the symlink control (${code})`);
        }
        throw error;
      }

      const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
      await expect(idx.clearOnDisk()).resolves.toBe(true);
      expect(await fs.readFile(sentinel, "utf8")).toBe("EXTERNAL_SENTINEL");
      await expect(fs.lstat(dbFile)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );
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
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
    }

    await assertDurableQuarantineLifecycle();
  });

  async function assertDurableQuarantineLifecycle(): Promise<void> {
    if (!canRunFts5) return;
    const quarantineDbFile = path.join(dbDir, "quarantine-lifecycle.fts5.db");
    const first = new FtsIndex({ file: quarantineDbFile, vaultRoot: "/tmp/vault" });
    await first.open();
    first.reindexFile("stale.md", 1000, "old-generation-marker");
    first.reindexFile("control.md", 1000, "unchanged-control-marker");
    const legacyHit = first.search("old-generation-marker")[0];
    const legacyChunk = first.getChunk("stale.md", 0);
    const firstHit = first.searchWithReceipts("old-generation-marker")[0];
    const firstChunk = first.getChunkWithReceipt("stale.md", 0);
    expect(Object.keys(legacyHit ?? {}).sort()).toEqual([
      "chunk_index",
      "kind",
      "line_end",
      "line_start",
      "rel_path",
      "score",
      "snippet"
    ]);
    expect(Object.keys(legacyChunk ?? {}).sort()).toEqual(["content", "line_end", "line_start"]);
    expect(legacyHit).not.toHaveProperty("indexed_mtime_ms");
    expect(legacyHit).not.toHaveProperty("indexed_revision");
    expect(legacyChunk).not.toHaveProperty("indexed_mtime_ms");
    expect(legacyChunk).not.toHaveProperty("indexed_revision");
    expect(firstHit?.indexed_mtime_ms).toBe(1000);
    expect(firstHit?.indexed_revision).toBe(1);
    expect(firstChunk?.indexed_mtime_ms).toBe(1000);
    expect(firstChunk?.indexed_revision).toBe(firstHit?.indexed_revision);
    expect(firstChunk).toMatchObject({ rel_path: "stale.md", kind: "md" });
    expect(
      firstHit &&
        first.isCurrentSourceReceipt(
          firstHit.rel_path,
          firstHit.kind,
          firstHit.indexed_mtime_ms,
          firstHit.indexed_revision
        )
    ).toBe(true);
    await first.closeAndRelease();

    // Migration control: both tables/triggers are additive. A same-schema
    // database made before this fix has neither; reopening must backfill a
    // safe revision without rebuilding or discarding the existing FTS rows.
    const { default: Database } = await import("better-sqlite3");
    const legacy = new Database(quarantineDbFile);
    legacy.exec(`
      DROP TRIGGER IF EXISTS source_state_revision_insert;
      DROP TRIGGER IF EXISTS source_state_revision_update;
      DROP TRIGGER IF EXISTS source_state_revision_delete;
      DROP TRIGGER IF EXISTS source_quarantine_revision_insert;
      DROP TRIGGER IF EXISTS source_quarantine_revision_update;
      DROP TRIGGER IF EXISTS source_quarantine_revision_delete;
      DROP TABLE source_revision;
      DROP TABLE source_quarantine;
    `);
    // Same-name collision control: bootstrap must replace, not silently keep,
    // a preexisting no-op trigger definition.
    legacy.exec(`
      CREATE TRIGGER source_state_revision_insert
      AFTER INSERT ON source_state
      BEGIN
        SELECT 1;
      END;
    `);
    legacy.close();

    const quarantined = new FtsIndex({ file: quarantineDbFile, vaultRoot: "/tmp/vault" });
    await quarantined.open();
    const migrated = quarantined.searchWithReceipts("old-generation-marker")[0];
    const migratedChunk = quarantined.getChunkWithReceipt("stale.md", 0);
    expect(migrated?.indexed_revision).toBe(1);
    expect(migratedChunk?.indexed_revision).toBe(migrated?.indexed_revision);
    expect(quarantined.currentSourceReceiptMask([])).toEqual([]);
    expect(
      migrated &&
        quarantined.isCurrentSourceReceipt(
          migrated.rel_path,
          migrated.kind,
          migrated.indexed_mtime_ms,
          migrated.indexed_revision
        )
    ).toBe(true);
    const control = quarantined.searchWithReceipts("unchanged-control-marker")[0];
    expect(control).toBeDefined();
    expect(migrated && control && quarantined.currentSourceReceiptMask([migrated, control])).toEqual([true, true]);
    const triggerProbe = new Database(quarantineDbFile);
    try {
      const triggerSql = triggerProbe
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'source_state_revision_insert'")
        .get() as { sql?: string } | undefined;
      expect(triggerSql?.sql).toContain("source_revision.revision + 1");
    } finally {
      triggerProbe.close();
    }
    expect(
      control &&
        quarantined.isCurrentSourceReceipt(
          control.rel_path,
          control.kind,
          control.indexed_mtime_ms,
          control.indexed_revision
        )
    ).toBe(true);

    // Same-mtime replacement is a distinct generation: mtime alone is equal,
    // while the trigger-bumped revision makes the captured receipt obsolete.
    const manifestBeforeSameMtime = quarantined.fingerprintKind("md");
    quarantined.reindexFile("stale.md", 1000, "same-mtime-generation-marker");
    const sameMtime = quarantined.searchWithReceipts("same-mtime-generation-marker")[0];
    expect(sameMtime?.indexed_mtime_ms).toBe(migrated?.indexed_mtime_ms);
    expect(sameMtime?.indexed_revision).toBeGreaterThan(migrated?.indexed_revision ?? 0);
    expect(
      migrated &&
        quarantined.isCurrentSourceReceipt(
          migrated.rel_path,
          migrated.kind,
          migrated.indexed_mtime_ms,
          migrated.indexed_revision
        )
    ).toBe(false);
    expect(
      sameMtime &&
        quarantined.isCurrentSourceReceipt(
          sameMtime.rel_path,
          sameMtime.kind,
          sameMtime.indexed_mtime_ms,
          sameMtime.indexed_revision
        )
    ).toBe(true);
    expect(quarantined.fingerprintKind("md")).not.toBe(manifestBeforeSameMtime);
    expect(
      sameMtime &&
        quarantined.isCurrentSourceReceipt(sameMtime.rel_path, sameMtime.kind, Number.NaN, sameMtime.indexed_revision)
    ).toBe(false);
    expect(
      sameMtime &&
        quarantined.isCurrentSourceReceipt(
          sameMtime.rel_path,
          "bogus" as never,
          sameMtime.indexed_mtime_ms,
          sameMtime.indexed_revision
        )
    ).toBe(false);
    expect(
      sameMtime &&
        quarantined.isCurrentSourceReceipt(
          sameMtime.rel_path,
          sameMtime.kind,
          sameMtime.indexed_mtime_ms,
          sameMtime.indexed_revision + 0.5
        )
    ).toBe(false);
    expect(
      migrated && sameMtime && control && quarantined.currentSourceReceiptMask([migrated, sameMtime, control])
    ).toEqual([false, true, true]);
    expect(
      migratedChunk &&
        quarantined.isCurrentSourceReceipt(
          "stale.md",
          "md",
          migratedChunk.indexed_mtime_ms,
          migratedChunk.indexed_revision
        )
    ).toBe(false);
    expect(
      () => sameMtime && quarantined.currentSourceReceiptMask(Array.from({ length: 513 }, () => sameMtime))
    ).toThrow(/exceeds 512/);
    expect(
      sameMtime &&
        quarantined.currentSourceReceiptMask([
          { ...sameMtime, indexed_revision: sameMtime.indexed_revision + 0.5 },
          { ...sameMtime, indexed_mtime_ms: Number.POSITIVE_INFINITY }
        ])
    ).toEqual([false, false]);
    quarantined.quarantineFile("stale.md", "md");

    // Positive control: retained physical bytes are immediately unreachable
    // through both FTS egress routes and strict evidence rejects the marker.
    expect(quarantined.totalFiles()).toBe(2);
    expect(quarantined.totalChunks()).toBe(2);
    expect(quarantined.search("same-mtime-generation-marker")).toEqual([]);
    expect(quarantined.getChunk("stale.md", 0)).toBeNull();
    expect(
      sameMtime &&
        quarantined.isCurrentSourceReceipt(
          sameMtime.rel_path,
          sameMtime.kind,
          sameMtime.indexed_mtime_ms,
          sameMtime.indexed_revision
        )
    ).toBe(false);
    expect(quarantined.auditKind("md").mismatched_files).toBe(1);
    expect(
      quarantined.diff(
        [
          { relPath: "stale.md", mtimeMs: 1000 },
          { relPath: "control.md", mtimeMs: 1000 }
        ],
        "md"
      )
    ).toEqual({ added: [], updated: ["stale.md"], deleted: [], unchanged: ["control.md"] });

    // Negative control: unrelated, receipt-backed rows remain available.
    const visibleControl = quarantined.searchWithReceipts("unchanged-control-marker");
    expect(visibleControl).toHaveLength(1);
    expect(visibleControl[0]?.indexed_mtime_ms).toBe(1000);
    expect(visibleControl[0]?.indexed_revision).toBe(control?.indexed_revision);
    await quarantined.closeAndRelease();

    // The exclusion survives a restart; a successful replacement publishes
    // the new generation and atomically clears the quarantine marker.
    const reopened = new FtsIndex({ file: quarantineDbFile, vaultRoot: "/tmp/vault" });
    await reopened.open();
    try {
      expect(reopened.search("same-mtime-generation-marker")).toEqual([]);
      expect(reopened.getChunk("stale.md", 0)).toBeNull();
      reopened.reindexFile("stale.md", 2000, "fresh-generation-marker");
      expect(reopened.search("same-mtime-generation-marker")).toEqual([]);
      const fresh = reopened.searchWithReceipts("fresh-generation-marker")[0];
      const freshChunk = reopened.getChunkWithReceipt("stale.md", 0);
      expect(fresh?.indexed_mtime_ms).toBe(2000);
      expect(freshChunk?.indexed_mtime_ms).toBe(2000);
      expect(freshChunk?.indexed_revision).toBe(fresh?.indexed_revision);
      expect(
        fresh &&
          reopened.isCurrentSourceReceipt(fresh.rel_path, fresh.kind, fresh.indexed_mtime_ms, fresh.indexed_revision)
      ).toBe(true);
      expect(reopened.auditKind("md").mismatched_files).toBe(0);

      // dropFile is the other successful terminal transition and clears even
      // a marker whose retained source row/chunks are being removed. The
      // ledger tombstone then forces a higher revision on same-mtime re-add,
      // closing delete/re-add ABA without disturbing the sibling receipt.
      reopened.quarantineFile("stale.md", "md");
      expect(reopened.auditKind("md").mismatched_files).toBe(1);
      reopened.dropFile("stale.md");
      expect(reopened.auditKind("md").mismatched_files).toBe(0);
      expect(reopened.search("fresh-generation-marker")).toEqual([]);
      expect(
        fresh &&
          reopened.isCurrentSourceReceipt(fresh.rel_path, fresh.kind, fresh.indexed_mtime_ms, fresh.indexed_revision)
      ).toBe(false);
      reopened.reindexFile("stale.md", 2000, "aba-generation-marker");
      const readded = reopened.searchWithReceipts("aba-generation-marker")[0];
      expect(readded?.indexed_revision).toBeGreaterThan(fresh?.indexed_revision ?? 0);
      expect(
        readded &&
          reopened.isCurrentSourceReceipt(
            readded.rel_path,
            readded.kind,
            readded.indexed_mtime_ms,
            readded.indexed_revision
          )
      ).toBe(true);
      expect(
        control &&
          reopened.isCurrentSourceReceipt(
            control.rel_path,
            control.kind,
            control.indexed_mtime_ms,
            control.indexed_revision
          )
      ).toBe(true);
    } finally {
      await reopened.closeAndRelease();
    }
  }

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

      // v7 — a dropped file must leave no identifier-parts row behind. The
      // sibling table holds a COPY of the chunk text, so a stale row would
      // resurface the deleted note as a score-0 tail hit. `daily`/`report`
      // are reachable ONLY through the parts split (unicode61 keeps
      // `fetchDailyReport` as one token), so this asserts the parts pass.
      idx.reindexFile("y.md", 1000, "call fetchDailyReport in the pipeline");
      expect(idx.search("daily report").map((hit) => hit.rel_path)).toEqual(["y.md"]);
      idx.dropFile("y.md");
      expect(idx.search("daily report")).toEqual([]);
      // Class invariant for rc.18: every chunk replacement/removal path must
      // enter through the indexed scope token. A bare rel_path DELETE scans
      // the growing FTS virtual table and made a 22k-note fresh build O(N²).
      const source = await fs.readFile(path.resolve("src/fts5.ts"), "utf8");
      expect(source).not.toContain("DELETE FROM chunks WHERE rel_path = ?");
      expect(source.match(/DELETE FROM chunks WHERE chunks MATCH \? AND rel_path = \?/g)).toHaveLength(3);
      // The v7 sibling table is the same class: `rel_path` is UNINDEXED there
      // too, so a bare rel_path DELETE would reintroduce the O(N²) scan.
      expect(source).not.toContain("DELETE FROM chunk_parts WHERE rel_path = ?");
      expect(source.match(/DELETE FROM chunk_parts WHERE chunk_parts MATCH \? AND rel_path = \?/g)).toHaveLength(3);
    } finally {
      await idx.closeAndRelease();
    }
  });

  it("refuses foreign or malformed populated databases without changing logical contents", async () => {
    if (!canRunFts5) return;
    const { default: Database } = await import("better-sqlite3");
    const snapshot = (file: string, queries: readonly string[]) => {
      const raw = new Database(file, { readonly: true, fileMustExist: true });
      try {
        return {
          schema: raw
            .prepare(
              "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name"
            )
            .all(),
          cells: queries.map((query) => raw.prepare(query).all())
        };
      } finally {
        raw.close();
      }
    };
    const refusePathFree = async (idx: FtsIndex, forbidden: readonly string[], pattern: RegExp) => {
      const rejection = await idx.open().then(
        () => null,
        (error: unknown) => error
      );
      expect(rejection).toBeInstanceOf(Error);
      const message = rejection instanceof Error ? rejection.message : "";
      expect(message).toMatch(pattern);
      for (const value of forbidden) expect(message).not.toContain(value);
      await idx.closeAndRelease();
    };

    // Positive boundary: a pre-existing SQLite container with no logical
    // schema is genuinely empty and may be initialized on this same handle.
    const emptyFile = path.join(dbDir, "existing-empty.fts5.db");
    new Database(emptyFile).close();
    const empty = new FtsIndex({ file: emptyFile, vaultRoot: "/tmp/vault-A" });
    await empty.open();
    expect(empty.totalFiles()).toBe(0);
    expect(empty.totalChunks()).toBe(0);
    await empty.closeAndRelease();

    // Real FTS ownership with a different root must be refused, not treated as
    // a caller-authorized rebuild. The ordered logical schema + cells are the
    // bounded preservation contract; SQLite container/sidecar bytes are not.
    const idx1 = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault-A" });
    await idx1.open();
    idx1.reindexFile("a.md", 1000, "marker-A");
    expect(idx1.totalFiles()).toBe(1);
    await idx1.closeAndRelease();
    const foreignPolicy = new Database(dbFile);
    foreignPolicy.pragma("journal_mode = DELETE");
    foreignPolicy.close();
    await fs.chmod(dbFile, 0o640);
    const ftsQueries = [
      "SELECT * FROM meta ORDER BY key",
      "SELECT rowid, * FROM chunks ORDER BY rowid",
      "SELECT * FROM chunks_data ORDER BY id",
      "SELECT * FROM chunks_idx ORDER BY segid, term, pgno",
      "SELECT * FROM chunks_content ORDER BY id",
      "SELECT * FROM chunks_docsize ORDER BY id",
      "SELECT * FROM chunks_config ORDER BY k",
      "SELECT rowid, * FROM chunk_parts ORDER BY rowid",
      "SELECT * FROM chunk_parts_data ORDER BY id",
      "SELECT * FROM chunk_parts_idx ORDER BY segid, term, pgno",
      "SELECT * FROM chunk_parts_content ORDER BY id",
      "SELECT * FROM chunk_parts_docsize ORDER BY id",
      "SELECT * FROM chunk_parts_config ORDER BY k",
      "SELECT * FROM source_state ORDER BY rel_path",
      "SELECT * FROM source_quarantine ORDER BY rel_path, kind",
      "SELECT * FROM source_revision ORDER BY rel_path, kind"
    ];
    const beforeForeign = snapshot(dbFile, ftsQueries);
    const idx2 = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault-B" });
    await refusePathFree(idx2, [dbFile, "/tmp/vault-A", "/tmp/vault-B"], /different vault root/);
    expect(snapshot(dbFile, ftsQueries)).toEqual(beforeForeign);
    expect((await fs.stat(dbFile)).mode & 0o777).toBe(0o640);
    const foreignPolicyAfter = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      expect(foreignPolicyAfter.pragma("journal_mode", { simple: true })).toBe("delete");
    } finally {
      foreignPolicyAfter.close();
    }

    // Discovery is a configuration snapshot, not a timeless rebuild grant.
    // A legitimate same-root low-level writer may intentionally switch the
    // tokenizer after discovery A; a stale discovery-bound open must then
    // refuse before changing B's logical schema, rows, or FTS shadow BLOBs.
    const configRaceFile = path.join(dbDir, "config-race.fts5.db");
    const configASeed = new FtsIndex({
      file: configRaceFile,
      vaultRoot: "/tmp/config-race",
      tokenize: "unicode61"
    });
    await configASeed.open();
    configASeed.reindexFile("a.md", 1, "config-a-marker");
    await configASeed.closeAndRelease();
    const expectedConfigA = await discoverFtsIndexConfig(configRaceFile, "/tmp/config-race");
    expect(expectedConfigA.kind).toBe("owned");

    const configBWriter = new FtsIndex({
      file: configRaceFile,
      vaultRoot: "/tmp/config-race",
      tokenize: "trigram"
    });
    await configBWriter.open();
    configBWriter.reindexFile("b.md", 2, "config-b-marker");
    await configBWriter.closeAndRelease();
    const expectedConfigB = await discoverFtsIndexConfig(configRaceFile, "/tmp/config-race");
    expect(expectedConfigB.kind).toBe("owned");
    const beforeStaleConfigOpen = snapshot(configRaceFile, ftsQueries);

    const staleConfigOpen = new FtsIndex({
      file: configRaceFile,
      vaultRoot: "/tmp/config-race",
      tokenize: "unicode61"
    });
    const stalePending = staleConfigOpen.open(expectedConfigA);
    if (expectedConfigA.kind === "owned") {
      (expectedConfigA.meta as { tokenize_mode: TokenizeMode }).tokenize_mode = "trigram";
    }
    const staleError = await stalePending.then(
      () => null,
      (error: unknown) => error
    );
    await staleConfigOpen.closeAndRelease();
    expect(staleError).toBeInstanceOf(Error);
    const staleMessage = staleError instanceof Error ? staleError.message : "";
    expect(staleMessage).toBe("FTS index configuration changed before open");
    for (const value of [configRaceFile, "/tmp/config-race", "unicode61", "trigram"]) {
      expect(staleMessage).not.toContain(value);
    }
    expect(snapshot(configRaceFile, ftsQueries)).toEqual(beforeStaleConfigOpen);

    if (expectedConfigB.kind !== "owned") throw new Error("expected current FTS discovery");
    const currentConfigOpen = new FtsIndex({
      file: configRaceFile,
      vaultRoot: "/tmp/config-race",
      tokenize: expectedConfigB.meta.tokenize_mode
    });
    await currentConfigOpen.open(expectedConfigB);
    expect(currentConfigOpen.search("config-b-marker")).toHaveLength(1);
    await currentConfigOpen.closeAndRelease();

    // Paired positive: the expected A snapshot still authorizes an explicit
    // writer override when the live database remains A.
    const explicitOverrideFile = path.join(dbDir, "explicit-config-override.fts5.db");
    const explicitASeed = new FtsIndex({
      file: explicitOverrideFile,
      vaultRoot: "/tmp/config-override",
      tokenize: "unicode61"
    });
    await explicitASeed.open();
    explicitASeed.reindexFile("old.md", 3, "old-config-marker");
    await explicitASeed.closeAndRelease();
    const expectedExplicitA = await discoverFtsIndexConfig(explicitOverrideFile, "/tmp/config-override");
    expect(expectedExplicitA.kind).toBe("owned");
    const explicitBWriter = new FtsIndex({
      file: explicitOverrideFile,
      vaultRoot: "/tmp/config-override",
      tokenize: "trigram"
    });
    await explicitBWriter.open(expectedExplicitA);
    expect(explicitBWriter.totalChunks()).toBe(0);
    await explicitBWriter.closeAndRelease();
    const explicitBDiscovery = await discoverFtsIndexConfig(explicitOverrideFile, "/tmp/config-override");
    expect(explicitBDiscovery.kind === "owned" && explicitBDiscovery.meta.tokenize_mode).toBe("trigram");

    // Causal cleanup control: even when native close releases the handle and
    // then throws a path-bearing error, admission keeps the original bounded
    // refusal. Reusing the same FtsIndex must perform admission again rather
    // than returning from open() through a stale non-null handle.
    const closePrototype = Database.prototype as unknown as { close(): void };
    const originalClose = closePrototype.close;
    closePrototype.close = function (this: unknown) {
      originalClose.call(this);
      throw new Error(`close failed for ${dbFile}`);
    };
    const closeFailingRefusal = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault-B" });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const rejection = await closeFailingRefusal.open().then(
          () => null,
          (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(Error);
        const message = rejection instanceof Error ? rejection.message : "";
        expect(message).toMatch(/different vault root/);
        for (const value of [dbFile, "/tmp/vault-A", "/tmp/vault-B"]) {
          expect(message).not.toContain(value);
        }
      }
    } finally {
      closePrototype.close = originalClose;
    }

    // Missing root on an otherwise real FTS database is not "legacy enough to
    // initialize": absence means ownership is unproven and must fail closed.
    const missingRootFile = path.join(dbDir, "missing-root.fts5.db");
    const missingRootSeed = new FtsIndex({ file: missingRootFile, vaultRoot: "/tmp/vault-A" });
    await missingRootSeed.open();
    missingRootSeed.reindexFile("missing.md", 1001, "missing-root-marker");
    await missingRootSeed.closeAndRelease();
    const missingRootRaw = new Database(missingRootFile);
    missingRootRaw.prepare("DELETE FROM meta WHERE key = 'vault_root'").run();
    missingRootRaw.close();
    const beforeMissing = snapshot(missingRootFile, ftsQueries);
    await refusePathFree(
      new FtsIndex({ file: missingRootFile, vaultRoot: "/tmp/vault-A" }),
      [missingRootFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(missingRootFile, ftsQueries)).toEqual(beforeMissing);

    // A different Enquire SQLite class carries BLOB content. It must not be
    // admitted merely because it also has a table named `meta`.
    const wrongClassFile = path.join(dbDir, "wrong-class.fts5.db");
    const wrongClassRaw = new Database(wrongClassFile);
    wrongClassRaw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE embeddings (id TEXT PRIMARY KEY, vec BLOB NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      INSERT INTO meta VALUES ('vault_root', '/tmp/vault-A');
      INSERT INTO meta VALUES ('model_alias', 'foreign-model');
    `);
    wrongClassRaw.prepare("INSERT INTO embeddings VALUES (?, ?)").run("foreign", Buffer.from([0, 1, 2, 255]));
    wrongClassRaw.close();
    const wrongClassQueries = ["SELECT * FROM meta ORDER BY key", "SELECT * FROM embeddings ORDER BY id"];
    const beforeWrongClass = snapshot(wrongClassFile, wrongClassQueries);
    await refusePathFree(
      new FtsIndex({ file: wrongClassFile, vaultRoot: "/tmp/vault-A" }),
      [wrongClassFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(wrongClassFile, wrongClassQueries)).toEqual(beforeWrongClass);

    // Name/type inventory alone is not an FTS class proof. This regular-table
    // lookalike supplies every required object name plus exact meta/source
    // state, but `chunks` carries a foreign BLOB instead of being canonical
    // FTS5. Exact chunks SQL must reject it without touching any cell.
    const regularSpoofFile = path.join(dbDir, "regular-chunks-spoof.fts5.db");
    const regularSpoofRaw = new Database(regularSpoofFile);
    regularSpoofRaw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE chunks (content BLOB NOT NULL);
      CREATE TABLE chunks_data (id INTEGER PRIMARY KEY, block BLOB NOT NULL);
      CREATE TABLE chunks_idx (segid INTEGER, term BLOB, pgno INTEGER);
      CREATE TABLE chunks_content (id INTEGER PRIMARY KEY, c0 BLOB);
      CREATE TABLE chunks_docsize (id INTEGER PRIMARY KEY, sz BLOB);
      CREATE TABLE chunks_config (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE source_state (
        rel_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        indexed_at TEXT NOT NULL
      );
      INSERT INTO meta VALUES ('schema_version', '${FTS_SCHEMA_VERSION}');
      INSERT INTO meta VALUES ('vault_root', '/tmp/vault-A');
      INSERT INTO meta VALUES ('tokenize_mode', 'unicode61');
    `);
    regularSpoofRaw.prepare("INSERT INTO chunks VALUES (?)").run(Buffer.from([222, 173, 190, 239]));
    regularSpoofRaw.prepare("INSERT INTO chunks_data VALUES (1, ?)").run(Buffer.from("foreign-shadow"));
    regularSpoofRaw.close();
    const regularSpoofQueries = [
      "SELECT * FROM meta ORDER BY key",
      "SELECT rowid, * FROM chunks ORDER BY rowid",
      "SELECT * FROM chunks_data ORDER BY id",
      "SELECT * FROM chunks_idx ORDER BY segid, term, pgno",
      "SELECT * FROM chunks_content ORDER BY id",
      "SELECT * FROM chunks_docsize ORDER BY id",
      "SELECT * FROM chunks_config ORDER BY k",
      "SELECT * FROM source_state ORDER BY rel_path"
    ];
    const beforeRegularSpoof = snapshot(regularSpoofFile, regularSpoofQueries);
    await refusePathFree(
      new FtsIndex({ file: regularSpoofFile, vaultRoot: "/tmp/vault-A" }),
      [regularSpoofFile, "/tmp/vault-A"],
      /physical tokenizer or schema contradicts metadata/
    );
    expect(snapshot(regularSpoofFile, regularSpoofQueries)).toEqual(beforeRegularSpoof);

    // v7 — the sibling identifier-parts table is admitted with the same
    // exactness as `chunks`. This fixture is a REAL index whose chunk_parts
    // was rebuilt under the other tokenizer: every object name, the meta rows
    // and `chunks` itself are untouched, so only the chunk_parts declaration
    // can reject it. Without that check the index opens and silently searches
    // a table whose analysis contradicts its own metadata.
    const partsSpoofFile = path.join(dbDir, "chunk-parts-spoof.fts5.db");
    const partsSpoofSeed = new FtsIndex({ file: partsSpoofFile, vaultRoot: "/tmp/vault-A" });
    await partsSpoofSeed.open();
    partsSpoofSeed.reindexFile("owned.md", 1001, "call fetchDailyReport once");
    await partsSpoofSeed.closeAndRelease();
    const partsSpoofRaw = new Database(partsSpoofFile);
    partsSpoofRaw.exec(`
      DROP TABLE chunk_parts;
      CREATE VIRTUAL TABLE chunk_parts USING fts5(
        content,
        parts,
        scope_tokens,
        rel_path UNINDEXED,
        chunk_index UNINDEXED,
        line_start UNINDEXED,
        line_end UNINDEXED,
        tags UNINDEXED,
        kind UNINDEXED,
        tokenize='trigram'
      );
    `);
    partsSpoofRaw.close();
    const partsSpoofQueries = [
      "SELECT * FROM meta ORDER BY key",
      "SELECT rowid, * FROM chunks ORDER BY rowid",
      "SELECT rowid, * FROM chunk_parts ORDER BY rowid",
      "SELECT * FROM source_state ORDER BY rel_path"
    ];
    const beforePartsSpoof = snapshot(partsSpoofFile, partsSpoofQueries);
    await refusePathFree(
      new FtsIndex({ file: partsSpoofFile, vaultRoot: "/tmp/vault-A" }),
      [partsSpoofFile, "/tmp/vault-A"],
      /physical tokenizer or schema contradicts metadata/
    );
    expect(snapshot(partsSpoofFile, partsSpoofQueries)).toEqual(beforePartsSpoof);

    // v7 — the reserved sibling family is only explicable from schema 7. On a
    // legacy database its declaration is never proved, so admission must
    // REFUSE rather than let the rebuild reclaim the name: dropping an object
    // ownership never established, and then reporting success, is the one
    // outcome the cohabiting-payload fixture below exists to forbid.
    for (const [slug, ddl] of [
      ["legacy-stray-chunk-parts", "CREATE TABLE chunk_parts (payload BLOB NOT NULL)"],
      ["legacy-stray-parts-shadow", "CREATE TABLE chunk_parts_data (id INTEGER PRIMARY KEY, block BLOB)"]
    ] as const) {
      const strayFile = path.join(dbDir, `${slug}.fts5.db`);
      const straySeed = new FtsIndex({ file: strayFile, vaultRoot: "/tmp/vault-A" });
      await straySeed.open();
      straySeed.reindexFile("owned.md", 1001, "owned-marker");
      await straySeed.closeAndRelease();
      const strayRaw = new Database(strayFile);
      // Stamp the database back to the last schema without the v7 family, so
      // the rebuild path is what would otherwise run.
      strayRaw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(FTS_SCHEMA_VERSION - 1));
      strayRaw.exec("DROP TABLE chunk_parts;");
      strayRaw.exec(ddl);
      strayRaw.close();
      const strayQueries = [
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
        "SELECT * FROM meta ORDER BY key",
        "SELECT rowid, * FROM chunks ORDER BY rowid",
        "SELECT * FROM source_state ORDER BY rel_path"
      ];
      const beforeStray = snapshot(strayFile, strayQueries);
      await refusePathFree(
        new FtsIndex({ file: strayFile, vaultRoot: "/tmp/vault-A" }),
        [strayFile, "/tmp/vault-A"],
        /without valid FTS ownership metadata/
      );
      expect(snapshot(strayFile, strayQueries), slug).toEqual(beforeStray);
    }

    // Full-inventory class proof: an otherwise valid FTS database that
    // cohabits with an unowned payload table is not safe to mutate. A
    // selected-object-only guard would admit this fixture.
    const cohabitingFile = path.join(dbDir, "cohabiting-foreign-payload.fts5.db");
    const cohabitingSeed = new FtsIndex({ file: cohabitingFile, vaultRoot: "/tmp/vault-A" });
    await cohabitingSeed.open();
    cohabitingSeed.reindexFile("owned.md", 1001, "owned-marker");
    await cohabitingSeed.closeAndRelease();
    const cohabitingRaw = new Database(cohabitingFile);
    cohabitingRaw.exec("CREATE TABLE foreign_payload (id TEXT PRIMARY KEY, body BLOB NOT NULL)");
    cohabitingRaw.prepare("INSERT INTO foreign_payload VALUES (?, ?)").run("keep", Buffer.from([255, 0, 127, 1]));
    cohabitingRaw.close();
    const cohabitingQueries = [...ftsQueries, "SELECT * FROM foreign_payload ORDER BY id"];
    const beforeCohabiting = snapshot(cohabitingFile, cohabitingQueries);
    await refusePathFree(
      new FtsIndex({ file: cohabitingFile, vaultRoot: "/tmp/vault-A" }),
      [cohabitingFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(cohabitingFile, cohabitingQueries)).toEqual(beforeCohabiting);

    // Causal shadow-class control: this starts as a canonical current FTS DB,
    // then gains one foreign column/cell inside an engine-owned shadow table.
    // A name/type-only guard would classify the opposite tokenizer as an
    // authorized config rebuild and DROP the shadow with its distinctive BLOB.
    const malformedShadowFile = path.join(dbDir, "malformed-fts-shadow.fts5.db");
    const malformedShadowSeed = new FtsIndex({
      file: malformedShadowFile,
      vaultRoot: "/tmp/vault-A",
      tokenize: "unicode61"
    });
    await malformedShadowSeed.open();
    malformedShadowSeed.reindexFile("shadow.md", 1001, "shadow-class-marker");
    await malformedShadowSeed.closeAndRelease();
    const malformedShadowRaw = new Database(malformedShadowFile);
    try {
      const shadowSchema = malformedShadowRaw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_data'")
        .get<{ sql: unknown }>();
      if (typeof shadowSchema?.sql !== "string") throw new Error("missing chunks_data test schema");
      const malformedShadowSql = shadowSchema.sql.replace(/\)\s*;?\s*$/u, ", foreign_payload BLOB)");
      expect(malformedShadowSql).not.toBe(shadowSchema.sql);

      // SQLite intentionally forbids ALTER TABLE on FTS5 shadow tables. Edit
      // only this disposable fixture's parseable catalog SQL, then reopen so
      // the extra column is loaded from disk rather than the stale cache.
      malformedShadowRaw.unsafeMode(true);
      try {
        malformedShadowRaw.exec("PRAGMA writable_schema = ON");
        try {
          const schemaMutation = malformedShadowRaw
            .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'chunks_data' AND sql = ?")
            .run(malformedShadowSql, shadowSchema.sql);
          expect(schemaMutation.changes).toBe(1);
        } finally {
          malformedShadowRaw.exec("PRAGMA writable_schema = OFF");
        }
      } finally {
        malformedShadowRaw.unsafeMode(false);
      }
    } finally {
      malformedShadowRaw.close();
    }
    const malformedShadowReloaded = new Database(malformedShadowFile);
    try {
      malformedShadowReloaded.unsafeMode(true);
      try {
        const shadowMutation = malformedShadowReloaded
          .prepare("UPDATE chunks_data SET foreign_payload = ? WHERE id = (SELECT min(id) FROM chunks_data)")
          .run(Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]));
        expect(shadowMutation.changes).toBeGreaterThan(0);
      } finally {
        malformedShadowReloaded.unsafeMode(false);
      }
    } finally {
      malformedShadowReloaded.close();
    }
    const beforeMalformedShadow = snapshot(malformedShadowFile, ftsQueries);
    await refusePathFree(
      new FtsIndex({
        file: malformedShadowFile,
        vaultRoot: "/tmp/vault-A",
        tokenize: "trigram"
      }),
      [malformedShadowFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(malformedShadowFile, ftsQueries)).toEqual(beforeMalformedShadow);

    // `_` is a wildcard in LIKE, so the old `NOT LIKE 'sqlite_%'` filter
    // silently hid this legal foreign name. GLOB makes the reserved-prefix
    // exclusion literal and the foreign BLOB remains untouched on refusal.
    const likeBypassFile = path.join(dbDir, "sqlite-like-bypass.fts5.db");
    const likeBypassSeed = new FtsIndex({ file: likeBypassFile, vaultRoot: "/tmp/vault-A" });
    await likeBypassSeed.open();
    likeBypassSeed.reindexFile("owned.md", 1001, "sqlite-like-owned-marker");
    await likeBypassSeed.closeAndRelease();
    const likeBypassRaw = new Database(likeBypassFile);
    likeBypassRaw.exec("CREATE TABLE sqliteXpayload (id TEXT PRIMARY KEY, body BLOB NOT NULL)");
    likeBypassRaw.prepare("INSERT INTO sqliteXpayload VALUES (?, ?)").run("keep", Buffer.from([0, 255, 1, 127]));
    likeBypassRaw.close();
    const likeBypassQueries = [...ftsQueries, "SELECT * FROM sqliteXpayload ORDER BY id"];
    const beforeLikeBypass = snapshot(likeBypassFile, likeBypassQueries);
    await refusePathFree(
      new FtsIndex({ file: likeBypassFile, vaultRoot: "/tmp/vault-A" }),
      [likeBypassFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(likeBypassFile, likeBypassQueries)).toEqual(beforeLikeBypass);

    // Bounded-authority control: an over-cap owner value that exactly matches
    // the caller still cannot be admitted. Without the substr(cap+1) proof,
    // this would read the whole hostile cell and pass the root equality check.
    const oversizedOwnerFile = path.join(dbDir, "oversized-owner.fts5.db");
    const oversizedOwnerSeed = new FtsIndex({ file: oversizedOwnerFile, vaultRoot: "/tmp/vault-A" });
    await oversizedOwnerSeed.open();
    oversizedOwnerSeed.reindexFile("oversized.md", 1002, "oversized-owner-marker");
    await oversizedOwnerSeed.closeAndRelease();
    const oversizedOwner = "x".repeat(8_193);
    const oversizedOwnerRaw = new Database(oversizedOwnerFile);
    oversizedOwnerRaw.prepare("UPDATE meta SET value = ? WHERE key = 'vault_root'").run(oversizedOwner);
    oversizedOwnerRaw.close();
    expect(await peekFtsMetaSafe(oversizedOwnerFile, oversizedOwner)).toBeNull();
    const beforeOversizedOwner = snapshot(oversizedOwnerFile, ftsQueries);
    await refusePathFree(
      new FtsIndex({ file: oversizedOwnerFile, vaultRoot: oversizedOwner }),
      [oversizedOwnerFile],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(oversizedOwnerFile, ftsQueries)).toEqual(beforeOversizedOwner);

    // Even a convincing FTS object-name spoof is rejected when the ownership
    // table shape is not the exact Enquire key/value contract.
    const malformedFile = path.join(dbDir, "malformed-owner.fts5.db");
    const malformedRaw = new Database(malformedFile);
    malformedRaw.exec(`
      CREATE TABLE meta (key TEXT, value TEXT, extra TEXT);
      CREATE VIRTUAL TABLE chunks USING fts5(content);
      CREATE TABLE source_state (rel_path TEXT PRIMARY KEY);
      CREATE TABLE payload (id TEXT PRIMARY KEY, body BLOB NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '${FTS_SCHEMA_VERSION}', 'spoof');
      INSERT INTO meta VALUES ('vault_root', '/tmp/vault-A', 'spoof');
      INSERT INTO meta VALUES ('tokenize_mode', 'unicode61', 'spoof');
    `);
    malformedRaw.prepare("INSERT INTO payload VALUES (?, ?)").run("keep", Buffer.from("logical-marker"));
    malformedRaw.close();
    const malformedQueries = [
      "SELECT * FROM meta ORDER BY key",
      "SELECT rowid, * FROM chunks ORDER BY rowid",
      "SELECT * FROM source_state ORDER BY rel_path",
      "SELECT * FROM payload ORDER BY id"
    ];
    const beforeMalformed = snapshot(malformedFile, malformedQueries);
    await refusePathFree(
      new FtsIndex({ file: malformedFile, vaultRoot: "/tmp/vault-A" }),
      [malformedFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(malformedFile, malformedQueries)).toEqual(beforeMalformed);

    // Exact columns alone do not prove the authority-table class: this
    // current FTS database has the three canonical rows and pragma shape, but
    // an unshipped CHECK hidden in sqlite_master SQL. It must not authorize
    // bootstrap or a future destructive rebuild.
    const malformedMetaFile = path.join(dbDir, "malformed-meta-sql.fts5.db");
    const malformedMetaSeed = new FtsIndex({ file: malformedMetaFile, vaultRoot: "/tmp/vault-A" });
    await malformedMetaSeed.open();
    malformedMetaSeed.reindexFile("meta.md", 1002, "malformed-meta-marker");
    await malformedMetaSeed.closeAndRelease();
    const malformedMetaRaw = new Database(malformedMetaFile);
    malformedMetaRaw.exec(`
      DROP TABLE meta;
      CREATE TABLE meta (
        key TEXT PRIMARY KEY CHECK (length(key) > 0),
        value TEXT NOT NULL
      );
      INSERT INTO meta VALUES ('schema_version', '${FTS_SCHEMA_VERSION}');
      INSERT INTO meta VALUES ('vault_root', '/tmp/vault-A');
      INSERT INTO meta VALUES ('tokenize_mode', 'unicode61');
    `);
    malformedMetaRaw.close();
    const beforeMalformedMeta = snapshot(malformedMetaFile, ftsQueries);
    await refusePathFree(
      new FtsIndex({ file: malformedMetaFile, vaultRoot: "/tmp/vault-A" }),
      [malformedMetaFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(malformedMetaFile, ftsQueries)).toEqual(beforeMalformedMeta);

    // Causal config proof: metadata that says unicode61 over a physical
    // trigram FTS table is malformed authority, not a same-root rebuild signal.
    // A meta-only guard would admit this exact fixture without rebuilding.
    const contradictoryFile = path.join(dbDir, "contradictory-tokenizer.fts5.db");
    const contradictorySeed = new FtsIndex({
      file: contradictoryFile,
      vaultRoot: "/tmp/vault-A",
      tokenize: "trigram"
    });
    await contradictorySeed.open();
    contradictorySeed.reindexFile("contradiction.md", 1002, "physical-trigram-marker");
    await contradictorySeed.closeAndRelease();
    const contradictoryRaw = new Database(contradictoryFile);
    contradictoryRaw.prepare("UPDATE meta SET value = 'unicode61' WHERE key = 'tokenize_mode'").run();
    contradictoryRaw.close();
    const beforeContradictory = snapshot(contradictoryFile, ftsQueries);
    await refusePathFree(
      new FtsIndex({ file: contradictoryFile, vaultRoot: "/tmp/vault-A", tokenize: "unicode61" }),
      [contradictoryFile, "/tmp/vault-A"],
      /physical tokenizer or schema contradicts metadata/
    );
    expect(snapshot(contradictoryFile, ftsQueries)).toEqual(beforeContradictory);

    // Optional names are not sufficient class proof. This lookalike retains
    // the exact columns but omits the shipped kind/revision CHECK constraints
    // and WITHOUT ROWID; CREATE IF NOT EXISTS would otherwise preserve it.
    const malformedRevisionFile = path.join(dbDir, "malformed-source-revision.fts5.db");
    const malformedRevisionSeed = new FtsIndex({
      file: malformedRevisionFile,
      vaultRoot: "/tmp/vault-A"
    });
    await malformedRevisionSeed.open();
    malformedRevisionSeed.reindexFile("ledger.md", 1003, "malformed-ledger-marker");
    await malformedRevisionSeed.closeAndRelease();
    const malformedRevisionRaw = new Database(malformedRevisionFile);
    malformedRevisionRaw.exec(`
      DROP TRIGGER source_state_revision_insert;
      DROP TRIGGER source_state_revision_update;
      DROP TRIGGER source_state_revision_delete;
      DROP TRIGGER source_quarantine_revision_insert;
      DROP TRIGGER source_quarantine_revision_update;
      DROP TRIGGER source_quarantine_revision_delete;
      DROP TABLE source_revision;
      CREATE TABLE source_revision (
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (rel_path, kind)
      );
      INSERT INTO source_revision VALUES ('ledger.md', 'md', 7);
    `);
    malformedRevisionRaw.close();
    const beforeMalformedRevision = snapshot(malformedRevisionFile, ftsQueries);
    await refusePathFree(
      new FtsIndex({ file: malformedRevisionFile, vaultRoot: "/tmp/vault-A" }),
      [malformedRevisionFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(malformedRevisionFile, ftsQueries)).toEqual(beforeMalformedRevision);

    // Quote-aware normalization control: SQLite's typeof() returns lowercase
    // `integer`, so changing only this quoted literal makes the CHECK reject
    // every valid revision. A whole-string toLowerCase() normalizer would
    // incorrectly equate this table with the canonical ledger.
    const uppercaseLiteralFile = path.join(dbDir, "uppercase-revision-literal.fts5.db");
    const uppercaseLiteralSeed = new FtsIndex({
      file: uppercaseLiteralFile,
      vaultRoot: "/tmp/vault-A"
    });
    await uppercaseLiteralSeed.open();
    uppercaseLiteralSeed.reindexFile("uppercase.md", 1004, "uppercase-literal-marker");
    await uppercaseLiteralSeed.closeAndRelease();
    const uppercaseLiteralRaw = new Database(uppercaseLiteralFile);
    uppercaseLiteralRaw.exec(`
      DROP TRIGGER source_state_revision_insert;
      DROP TRIGGER source_state_revision_update;
      DROP TRIGGER source_state_revision_delete;
      DROP TRIGGER source_quarantine_revision_insert;
      DROP TRIGGER source_quarantine_revision_update;
      DROP TRIGGER source_quarantine_revision_delete;
      DELETE FROM source_state WHERE rel_path = 'uppercase.md';
      DROP TABLE source_revision;
      CREATE TABLE source_revision (
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('md', 'pdf')),
        revision INTEGER NOT NULL CHECK (
          typeof(revision) = 'INTEGER'
          AND revision BETWEEN 1 AND 9007199254740991
        ),
        PRIMARY KEY (rel_path, kind)
      ) WITHOUT ROWID;
    `);
    uppercaseLiteralRaw.close();
    const beforeUppercaseLiteral = snapshot(uppercaseLiteralFile, ftsQueries);
    await refusePathFree(
      new FtsIndex({ file: uppercaseLiteralFile, vaultRoot: "/tmp/vault-A" }),
      [uppercaseLiteralFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(uppercaseLiteralFile, ftsQueries)).toEqual(beforeUppercaseLiteral);

    // Core regular-table proof is exact as well: a table-level CHECK is
    // invisible to pragma column shape, but was never part of any shipped
    // v1-v6 source_state definition and therefore cannot authorize rebuild.
    const malformedSourceStateFile = path.join(dbDir, "malformed-source-state.fts5.db");
    const malformedSourceStateSeed = new FtsIndex({
      file: malformedSourceStateFile,
      vaultRoot: "/tmp/vault-A"
    });
    await malformedSourceStateSeed.open();
    malformedSourceStateSeed.reindexFile("state.md", 1004, "malformed-state-marker");
    await malformedSourceStateSeed.closeAndRelease();
    const malformedSourceStateRaw = new Database(malformedSourceStateFile);
    malformedSourceStateRaw.exec(`
      DROP TABLE source_state;
      CREATE TABLE source_state (
        rel_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        indexed_at TEXT NOT NULL,
        CHECK (n_chunks >= 0)
      );
      INSERT INTO source_state VALUES ('state.md', 1004, 1, 'md', 'now');
    `);
    malformedSourceStateRaw.close();
    const beforeMalformedSourceState = snapshot(malformedSourceStateFile, ftsQueries);
    await refusePathFree(
      new FtsIndex({ file: malformedSourceStateFile, vaultRoot: "/tmp/vault-A" }),
      [malformedSourceStateFile, "/tmp/vault-A"],
      /without valid FTS ownership metadata/
    );
    expect(snapshot(malformedSourceStateFile, ftsQueries)).toEqual(beforeMalformedSourceState);

    // Executable TOCTOU control: alter the live authority immediately before
    // better-sqlite3 starts the IMMEDIATE bootstrap transaction. The repeated
    // same-handle guard must reject before replacing this no-op trigger or
    // touching any marker/schema cell.
    const raceFile = path.join(dbDir, "root-race.fts5.db");
    const raceSeed = new FtsIndex({ file: raceFile, vaultRoot: "/tmp/vault-A" });
    await raceSeed.open();
    raceSeed.reindexFile("race.md", 1005, "root-race-marker");
    await raceSeed.closeAndRelease();
    const raceRaw = new Database(raceFile);
    raceRaw.exec(`
      DROP TRIGGER source_state_revision_insert;
      CREATE TRIGGER source_state_revision_insert
      AFTER INSERT ON source_state
      BEGIN
        SELECT 1;
      END;
    `);
    raceRaw.close();
    const raceQueries = ["SELECT * FROM meta WHERE key <> 'vault_root' ORDER BY key", ...ftsQueries.slice(1)];
    const beforeRace = snapshot(raceFile, raceQueries);
    type TransactionWrapper = {
      (...args: unknown[]): unknown;
      immediate(...args: unknown[]): unknown;
    };
    type TransactionMethod = (fn: (...args: unknown[]) => unknown) => TransactionWrapper;
    const databasePrototype = Database.prototype as unknown as { transaction: TransactionMethod };
    const originalTransaction = databasePrototype.transaction;
    databasePrototype.transaction = function (this: unknown, fn: (...args: unknown[]) => unknown) {
      const wrapped = originalTransaction.call(this, fn);
      const proxy = function (this: unknown, ...args: unknown[]) {
        return wrapped.apply(this, args);
      } as TransactionWrapper;
      proxy.immediate = function (this: unknown, ...args: unknown[]) {
        const mutator = new Database(raceFile);
        try {
          mutator.prepare("UPDATE meta SET value = '/tmp/vault-B' WHERE key = 'vault_root'").run();
        } finally {
          mutator.close();
        }
        return wrapped.immediate.apply(this, args);
      };
      return proxy;
    };
    try {
      await refusePathFree(
        new FtsIndex({ file: raceFile, vaultRoot: "/tmp/vault-A" }),
        [raceFile, "/tmp/vault-A", "/tmp/vault-B"],
        /different vault root|ownership changed during admission/
      );
    } finally {
      databasePrototype.transaction = originalTransaction;
    }
    expect(snapshot(raceFile, raceQueries)).toEqual(beforeRace);
    const raceAfter = new Database(raceFile, { readonly: true, fileMustExist: true });
    try {
      expect(raceAfter.prepare("SELECT value FROM meta WHERE key = 'vault_root'").get()).toEqual({
        value: "/tmp/vault-B"
      });
      expect(
        raceAfter
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
          .get("source_state_revision_insert")
      ).toMatchObject({ sql: expect.stringContaining("SELECT 1") });
      expect(raceAfter.prepare("SELECT raw_content FROM chunks WHERE rel_path = 'race.md'").get()).toEqual({
        raw_content: "root-race-marker"
      });
    } finally {
      raceAfter.close();
    }

    // Causal negative control: the snapshot is sensitive to the exact
    // pre-fix failure (dropping same-file FTS rows), so equality above is not
    // vacuous or limited to table names.
    const destructiveControl = new Database(dbFile);
    destructiveControl.prepare("DELETE FROM chunks").run();
    destructiveControl.close();
    expect(snapshot(dbFile, ftsQueries)).not.toEqual(beforeForeign);

    // Structural half: pin the same-handle two-guard order and prove the
    // detector kills both a missing transactional recheck and a deferred
    // (non-IMMEDIATE) bootstrap mutant.
    const expectedDiscoveryAssertionLine =
      "        assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);";
    const bootstrapCallLine = "        this.bootstrapSchema(initialAdmission);";
    const admissionProblems = (source: string): string[] => {
      const problems: string[] = [];
      const calls = [...source.matchAll(/this\.inspectAdmission\(\)/g)].map((match) => match.index);
      if (calls.length !== 2) problems.push("two same-handle ownership checks are required");

      const openStart = source.indexOf("  async open(expectedDiscovery?: FtsIndexDiscovery): Promise<void> {");
      const expectedDiscoveryAssertion = source.indexOf(expectedDiscoveryAssertionLine, openStart);
      const bootstrapCall = source.indexOf(bootstrapCallLine, openStart);
      const firstPersistentPragma = source.indexOf('        this.db.pragma("journal_mode = WAL");', openStart);
      if (
        openStart < 0 ||
        bootstrapCall < 0 ||
        firstPersistentPragma < 0 ||
        (calls[0] ?? Number.POSITIVE_INFINITY) > bootstrapCall ||
        bootstrapCall > firstPersistentPragma
      ) {
        problems.push("open admission must precede bootstrap and persistent PRAGMA");
      }
      if (
        expectedDiscoveryAssertion < 0 ||
        expectedDiscoveryAssertion < (calls[0] ?? Number.POSITIVE_INFINITY) ||
        expectedDiscoveryAssertion > bootstrapCall
      ) {
        problems.push("expected discovery must bind initial admission before bootstrap");
      }

      const bootstrapStart = source.indexOf("  private bootstrapSchema(initialAdmission: FtsAdmission): void {");
      const transactionStart = source.indexOf("    const txn = db.transaction(() => {", bootstrapStart);
      const firstDdl = source.indexOf("      db.exec(`", transactionStart);
      if (
        bootstrapStart < 0 ||
        transactionStart < 0 ||
        firstDdl < 0 ||
        (calls[1] ?? Number.POSITIVE_INFINITY) < transactionStart ||
        (calls[1] ?? Number.POSITIVE_INFINITY) > firstDdl
      ) {
        problems.push("transactional ownership recheck must precede DDL");
      }
      if (source.indexOf("    txn.immediate();", transactionStart) < 0) {
        problems.push("bootstrap transaction must acquire IMMEDIATE reservation");
      }
      const transactionBody = source.slice(transactionStart, source.indexOf("    txn.immediate();", transactionStart));
      if (
        !transactionBody.includes("admission.kind !== initialAdmission.kind") ||
        !transactionBody.includes("admission.signature !== initialAdmission.signature")
      ) {
        problems.push("transactional recheck must match the preflight authority snapshot");
      }
      return problems;
    };
    const source = await fs.readFile(path.resolve("src/fts5.ts"), "utf8");
    expect(admissionProblems(source)).toEqual([]);
    expect(
      admissionProblems(
        replaceExactly(
          source,
          "const admission = this.inspectAdmission();",
          "const admission = { rebuildReasons: [] };"
        )
      )
    ).toContain("two same-handle ownership checks are required");
    expect(admissionProblems(replaceExactly(source, "    txn.immediate();", "    txn();"))).toContain(
      "bootstrap transaction must acquire IMMEDIATE reservation"
    );
    expect(
      admissionProblems(replaceExactly(source, "admission.signature !== initialAdmission.signature", "false"))
    ).toContain("transactional recheck must match the preflight authority snapshot");
    expect(admissionProblems(replaceExactly(source, `${expectedDiscoveryAssertionLine}\n`, ""))).toContain(
      "expected discovery must bind initial admission before bootstrap"
    );
    expect(
      admissionProblems(
        replaceExactly(
          source,
          `${expectedDiscoveryAssertionLine}\n${bootstrapCallLine}`,
          `${bootstrapCallLine}\n${expectedDiscoveryAssertionLine}`
        )
      )
    ).toContain("expected discovery must bind initial admission before bootstrap");
  });

  it.each([
    ["LF", "\n"],
    ["U+2028", "\u2028"]
  ])(
    "refuses a current FTS schema_version with trailing %s and preserves its logical generation",
    async (_label, suffix) => {
      if (!canRunFts5) return;
      const { default: Database } = await import("better-sqlite3");
      const seed = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
      await seed.open();
      seed.reindexFile("sentinel.md", 1000, "absolute-end-schema-sentinel");
      await seed.closeAndRelease();

      const queries = [
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
        "SELECT * FROM meta ORDER BY key",
        "SELECT rowid, * FROM chunks ORDER BY rowid",
        "SELECT * FROM chunks_data ORDER BY id",
        "SELECT * FROM chunks_idx ORDER BY segid, term, pgno",
        "SELECT * FROM chunks_content ORDER BY id",
        "SELECT * FROM chunks_docsize ORDER BY id",
        "SELECT * FROM chunks_config ORDER BY k",
        "SELECT rowid, * FROM chunk_parts ORDER BY rowid",
        "SELECT * FROM chunk_parts_data ORDER BY id",
        "SELECT * FROM chunk_parts_idx ORDER BY segid, term, pgno",
        "SELECT * FROM chunk_parts_content ORDER BY id",
        "SELECT * FROM chunk_parts_docsize ORDER BY id",
        "SELECT * FROM chunk_parts_config ORDER BY k",
        "SELECT * FROM source_state ORDER BY rel_path",
        "SELECT * FROM source_quarantine ORDER BY rel_path, kind",
        "SELECT * FROM source_revision ORDER BY rel_path, kind"
      ];
      const snapshot = (): unknown[] => {
        const raw = new Database(dbFile, { readonly: true, fileMustExist: true });
        try {
          return queries.map((query) => raw.prepare(query).all());
        } finally {
          raw.close();
        }
      };
      const corrupt = new Database(dbFile);
      corrupt
        .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(`${FTS_SCHEMA_VERSION}${suffix}`);
      corrupt.close();
      const before = snapshot();

      const refused = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
      await expect(refused.open()).rejects.toThrow(/malformed ownership metadata/i);
      await refused.closeAndRelease();
      expect(snapshot()).toEqual(before);
    }
  );

  it("clears the index when tokenize mode changes (rebuild required)", async () => {
    if (!canRunFts5) return;
    // Built by joining rather than by rewriting `dbFile`: a raw `.replace` here
    // would be an unclassified transform in a file whose every such call is
    // reviewed, and the path is clearer stated than derived.
    const ruUnicodeFile = path.join(dbDir, "ru-unicode.fts5.db");
    const ruTrigramFile = path.join(dbDir, "ru-trigram.fts5.db");
    // Positive sibling for the malformed-shadow control above: canonical
    // engine-owned shadow SQL/xinfo remains eligible for a config rebuild.
    const idx1 = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v", tokenize: "unicode61" });
    await idx1.open();
    idx1.reindexFile("a.md", 1000, "tokenize-mode-marker");
    expect(idx1.totalFiles()).toBe(1);
    await idx1.closeAndRelease();

    const idx2 = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v", tokenize: "trigram" });
    await idx2.open();
    expect(idx2.totalFiles()).toBe(0);
    await idx2.closeAndRelease();

    // ── SBS-R2: what the two tokenizers actually do for an inflected language ──
    // Russian inflects the ending, so a question and a note rarely spell a word
    // the same way. Measuring this matters because "switch to trigram for
    // Russian" is the obvious move, and the measurement says something more
    // specific than that.
    const ruUnicode = new FtsIndex({ file: ruUnicodeFile, vaultRoot: "/tmp/ru", tokenize: "unicode61" });
    const ruTrigram = new FtsIndex({ file: ruTrigramFile, vaultRoot: "/tmp/ru", tokenize: "trigram" });
    await ruUnicode.open();
    await ruTrigram.open();
    try {
      const note = "Сессия сканирования завершена.";
      ruUnicode.reindexFile("ru.md", 1000, note);
      ruTrigram.reindexFile("ru.md", 1000, note);

      // POSITIVE control: both modes index the text and find its exact wording.
      expect(ruUnicode.search("сканирования").length).toBe(1);
      expect(ruTrigram.search("сканирования").length).toBe(1);

      // NEGATIVE control: neither invents a match for an absent word.
      expect(ruUnicode.search("развёртывание")).toEqual([]);
      expect(ruTrigram.search("развёртывание")).toEqual([]);

      // The finding. `unicode61` compares whole tokens, so a different ending is
      // a different word and the note is unreachable. `trigram` matches
      // substrings, so the shared STEM reaches it.
      expect(ruUnicode.search("сканирован")).toEqual([]);
      expect(ruTrigram.search("сканирован").length).toBe(1);

      // And the limit of that answer: trigram is substring matching, not
      // morphology. A different full form is not a substring of the indexed one,
      // so trigram misses it too — switching tokenizer alone does not make an
      // inflected query find an inflected note.
      expect(ruUnicode.search("сканирование")).toEqual([]);
      expect(ruTrigram.search("сканирование")).toEqual([]);
    } finally {
      await ruUnicode.closeAndRelease();
      await ruTrigram.closeAndRelease();
    }
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
      await idx.closeAndRelease();
    }
  });

  it("indexes deduplicated wikilink metadata on chunk 0 only", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      idx.reindexFile(
        "multi.md",
        1000,
        "First paragraph about gears.\n\nSecond paragraph about cogs.\n\nThird paragraph about springs.",
        ["Apollo", "Apollo"]
      );
      const hits = idx.search("Apollo", { limit: 20 });
      expect(hits.map((hit) => [hit.rel_path, hit.chunk_index])).toEqual([["multi.md", 0]]);
    } finally {
      await idx.closeAndRelease();
    }
  });

  it("rejects over-limit note metadata before replacing the prior FTS generation", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      idx.reindexFile("bounded.md", 1000, "preserved-generation-marker");

      expect(() =>
        idx.reindexFile(
          "bounded.md",
          2000,
          "replacement-marker",
          Array.from({ length: 257 }, (_, index) => `Target-${index}`)
        )
      ).toThrow(/wikilinkTargets exceeds the 256-unique-item admission limit/);
      expect(() =>
        idx.reindexFile(
          "bounded.md",
          2000,
          "replacement-marker",
          [],
          Array.from({ length: 129 }, (_, index) => `tag-${index}`)
        )
      ).toThrow(/tags exceeds the 128-unique-item admission limit/);
      expect(() => idx.reindexFile("bounded.md", 2000, "replacement-marker", ["x".repeat(1025)])).toThrow(
        /wikilinkTargets contains an item larger than 1024 UTF-8 bytes/
      );

      expect(idx.search("preserved-generation-marker").map((hit) => hit.rel_path)).toEqual(["bounded.md"]);
      expect(idx.search("replacement-marker")).toEqual([]);
    } finally {
      await idx.closeAndRelease();
    }
  });

  it("keeps exact tag filtering on later chunks at the admitted metadata boundary", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      const tags = Array.from({ length: 128 }, (_, index) => `tag-${index}`);
      idx.reindexFile(
        "tagged.md",
        1000,
        "First paragraph about gears.\n\nSecond paragraph about cogs.\n\nThird paragraph has terminal-marker.",
        [],
        tags
      );
      expect(idx.search("terminal-marker", { tag: "tag-127" }).map((hit) => hit.rel_path)).toEqual(["tagged.md"]);
      expect(idx.search("terminal-marker", { tag: "not-present" })).toEqual([]);
    } finally {
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
    }
  });

  it("folder filter restricts results to a subtree", async () => {
    if (!canRunFts5) return;
    expect(ftsFolderToken("projects/")).toBe(ftsFolderToken("projects"));
    expect(ftsFolderToken("projects")).not.toBe(ftsFolderToken("inbox"));
    expect(ftsScopeTokens("projects/nested/a.md")).toBe(ftsPathToken("projects/nested/a.md"));
    expect(ftsPathToken("projects/nested/a.md")).toMatch(/^[a-z0-9]+$/);
    expect(ftsPathToken("projects/nested/a.md")).toMatch(
      new RegExp(`^${ftsFolderToken("projects/nested").slice(0, -1)}`)
    );
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/v" });
    await idx.open();
    try {
      idx.reindexFile("projects/a.md", 1000, "common-marker in projects");
      idx.reindexFile("projects/nested/c.md", 1000, "common-marker in nested project");
      idx.reindexFile("projects-archive/d.md", 1000, "common-marker in a sibling prefix");
      idx.reindexFile("inbox/b.md", 1000, "common-marker in inbox");
      const all = idx.search("common-marker");
      expect(all.length).toBe(4);
      const projectsOnly = idx.search("common-marker", { folder: "projects" });
      expect(projectsOnly.map((h) => h.rel_path).sort()).toEqual(["projects/a.md", "projects/nested/c.md"]);
      // NEGATIVE control: the internal scope column must select rows but never
      // become user-searchable content or affect BM25 relevance.
      expect(idx.search(ftsPathToken("projects/a.md"))).toEqual([]);
    } finally {
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
    }

    await assertFailSoftQuarantineRetry();
  });

  async function assertFailSoftQuarantineRetry(): Promise<void> {
    if (!canRunFts5) return;
    const vaultRoot = path.join(dbDir, "sync-failure-vault");
    const syncFailureDbFile = path.join(dbDir, "sync-failure.fts5.db");
    await fs.mkdir(vaultRoot);
    const stalePath = path.join(vaultRoot, "stale.md");
    await fs.writeFile(stalePath, "old-sync-marker");
    await fs.writeFile(path.join(vaultRoot, "control.md"), "available-control-marker");
    const vault = new Vault(vaultRoot);
    const idx = new FtsIndex({ file: syncFailureDbFile, vaultRoot });
    await idx.open();
    try {
      await syncFtsIndex(vault, idx, { mode: "strict" });
      expect(idx.search("old-sync-marker")).toHaveLength(1);
      expect(idx.search("available-control-marker")).toHaveLength(1);

      await fs.writeFile(stalePath, "fresh-sync-marker");
      const future = new Date(Date.now() + 60_000);
      await fs.utimes(stalePath, future, future);
      const readFailure = vi.spyOn(vault, "readNote").mockRejectedValueOnce(new Error("injected read failure"));
      const failed = await syncFtsIndex(vault, idx);
      expect(failed).toMatchObject({ mode: "fail-soft", updated: 0, failed: 1, complete: false });

      // Positive control: the failing source's retained old generation cannot
      // escape. Negative control: the unchanged sibling remains available.
      expect(idx.totalFiles()).toBe(2);
      expect(idx.search("old-sync-marker")).toEqual([]);
      expect(idx.getChunk("stale.md", 0)).toBeNull();
      expect(idx.search("available-control-marker")).toHaveLength(1);

      readFailure.mockRestore();
      const healed = await syncFtsIndex(vault, idx);
      expect(healed).toMatchObject({ mode: "fail-soft", updated: 1, failed: 0 });
      const liveMtime = (await vault.listMarkdown()).find((entry) => entry.relPath === "stale.md")?.mtimeMs;
      expect(liveMtime).toBeDefined();
      expect(idx.search("old-sync-marker")).toEqual([]);
      expect(idx.searchWithReceipts("fresh-sync-marker")[0]?.indexed_mtime_ms).toBe(liveMtime);
      expect(idx.getChunkWithReceipt("stale.md", 0)?.indexed_mtime_ms).toBe(liveMtime);
      expect(idx.auditKind("md").mismatched_files).toBe(0);
    } finally {
      await idx.closeAndRelease();
    }
  }
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
      expect(idx.searchWithReceipts("Alpha").find((hit) => hit.kind === "pdf")?.indexed_mtime_ms).toBe(2000);

      // Kind-scoped quarantine hides only the failed PDF generation. The
      // markdown control remains visible, and a successful PDF reindex clears
      // the marker in the same transaction as its replacement receipt.
      idx.quarantineFile("paper.pdf", "pdf");
      expect(idx.search("Alpha").map((hit) => hit.kind)).toEqual(["md"]);
      expect(idx.getChunk("paper.pdf", 0)).toBeNull();
      expect(idx.diff([{ relPath: "paper.pdf", mtimeMs: 2000 }], "pdf").updated).toEqual(["paper.pdf"]);
      idx.reindexPdfFile("paper.pdf", 3000, [{ pageNumber: 1, text: "Alpha replacement page" }]);
      expect(idx.searchWithReceipts("Alpha").find((hit) => hit.kind === "pdf")?.indexed_mtime_ms).toBe(3000);
    } finally {
      await idx.closeAndRelease();
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
      await idx.closeAndRelease();
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
      expect(idx.auditKind("md")).toEqual({
        declared_files: 1,
        indexed_files: 1,
        declared_chunks: 1,
        indexed_chunks: 1,
        mismatched_files: 0
      });
      expect(idx.auditKind("pdf")).toEqual({
        declared_files: 1,
        indexed_files: 1,
        declared_chunks: 1,
        indexed_chunks: 1,
        mismatched_files: 0
      });
    } finally {
      await idx.closeAndRelease();
    }
  });

  it("global diff sees both kinds; auditKind independently rejects every physical-corruption class", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    try {
      idx.reindexFile("a.md", 1000, "alpha\n\nsecond");
      idx.reindexPdfFile("b.pdf", 2000, [{ pageNumber: 1, text: "beta" }]);
      // Global diff with no kind filter shows both as known.
      const all = idx.diff([
        { relPath: "a.md", mtimeMs: 1000 },
        { relPath: "b.pdf", mtimeMs: 2000 }
      ]);
      expect(all.unchanged.sort()).toEqual(["a.md", "b.pdf"]);
    } finally {
      await idx.closeAndRelease();
    }

    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(dbFile);
    const audited = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await audited.open();
    const expectMismatches = (md: number, pdf: number): void => {
      expect(audited.auditKind("md").mismatched_files).toBe(md);
      expect(audited.auditKind("pdf").mismatched_files).toBe(pdf);
    };
    const repairMarkdown = (): void => {
      audited.reindexFile("a.md", 1000, "alpha\n\nsecond");
      expectMismatches(0, 0);
    };
    try {
      // The additive revision ledger is part of physical completeness. A
      // missing exact (path, kind) row fails only that source's kind; the next
      // legitimate replacement recreates it through the source_state trigger.
      raw.prepare("DELETE FROM source_revision WHERE rel_path = 'a.md' AND kind = 'md'").run();
      expectMismatches(1, 0);
      repairMarkdown();
      const manifestBeforeInvalidRevision = audited.fingerprintKind("md");
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare("UPDATE source_revision SET revision = 0 WHERE rel_path = 'a.md' AND kind = 'md'").run();
      raw.pragma("ignore_check_constraints = OFF");
      expectMismatches(1, 0);
      expect(audited.search("alpha")).toEqual([]);
      expect(audited.fingerprintKind("md")).not.toBe(manifestBeforeInvalidRevision);
      repairMarkdown();

      // Invalid source declarations: zero/negative and non-integer counts.
      raw.prepare("UPDATE source_state SET n_chunks = 0 WHERE rel_path = 'a.md'").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE source_state SET n_chunks = 1.5 WHERE rel_path = 'a.md'").run();
      expectMismatches(1, 0);
      repairMarkdown();

      // Invalid physical indices: non-integer, negative, and gapped.
      raw.prepare("UPDATE chunks SET chunk_index = 0.5 WHERE rel_path = 'a.md' AND chunk_index = 1").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE chunks SET chunk_index = -1 WHERE rel_path = 'a.md' AND chunk_index = 1").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE chunks SET chunk_index = 2 WHERE rel_path = 'a.md' AND chunk_index = 1").run();
      expectMismatches(1, 0);
      repairMarkdown();

      // Both line columns are type-checked, and the range must be valid.
      raw.prepare("UPDATE chunks SET line_start = 1.5 WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE chunks SET line_end = 'bad' WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE chunks SET line_start = 3, line_end = 2 WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(1, 0);
      repairMarkdown();

      raw.prepare("UPDATE chunks SET raw_content = x'00' WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE chunks SET content = x'00' WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE chunks SET content = '' WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE chunks SET raw_content = '' WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(1, 0);
      repairMarkdown();
      raw.prepare("UPDATE chunks SET scope_tokens = 'wrong' WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(1, 0);
      raw
        .prepare("UPDATE chunks SET scope_tokens = ? WHERE rel_path = 'a.md' AND chunk_index = 0")
        .run(ftsScopeTokens("a.md"));
      expectMismatches(0, 0);

      // v7 — the sibling identifier-parts rows are audited and fingerprinted
      // like any other searchable state. `a.md` carries no compound
      // identifier, so this section brings its own.
      audited.reindexFile("parts.md", 3000, "call fetchDailyReport once");
      expectMismatches(0, 0);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM chunk_parts WHERE rel_path = 'parts.md'").get()).toEqual({ n: 1 });
      const manifestBeforeParts = audited.fingerprintKind("md");
      // The audit cannot recompute the split, but the manifest must still move
      // on a same-shape mutation of what the index will match against.
      raw.prepare("UPDATE chunk_parts SET parts = 'tampered' WHERE rel_path = 'parts.md'").run();
      expect(audited.fingerprintKind("md")).not.toBe(manifestBeforeParts);
      expectMismatches(0, 0);
      // What the audit DOES own: a parts row must mirror an existing chunk.
      raw.prepare("UPDATE chunk_parts SET parts = '' WHERE rel_path = 'parts.md'").run();
      expectMismatches(1, 0);
      raw.prepare("UPDATE chunk_parts SET parts = 'fetch daily report' WHERE rel_path = 'parts.md'").run();
      expectMismatches(0, 0);
      raw.prepare("UPDATE chunk_parts SET content = 'diverged copy' WHERE rel_path = 'parts.md'").run();
      expectMismatches(1, 0);
      raw.prepare("UPDATE chunk_parts SET content = 'call fetchDailyReport once' WHERE rel_path = 'parts.md'").run();
      expectMismatches(0, 0);
      raw.prepare("UPDATE chunk_parts SET line_end = 99 WHERE rel_path = 'parts.md'").run();
      expectMismatches(1, 0);
      raw.prepare("UPDATE chunk_parts SET line_end = 1 WHERE rel_path = 'parts.md'").run();
      expectMismatches(0, 0);
      // A parts row whose kind is neither 'md' nor 'pdf' belongs to no scoped
      // view, so both audits must see it — the same contract `chunks` has.
      raw.prepare("UPDATE chunk_parts SET kind = 'bogus' WHERE rel_path = 'parts.md'").run();
      expectMismatches(1, 1);
      raw.prepare("UPDATE chunk_parts SET kind = 'md' WHERE rel_path = 'parts.md'").run();
      expectMismatches(0, 0);
      // An orphan parts row for a path with no chunk row of its own.
      raw
        .prepare(
          `INSERT INTO chunk_parts
             (content, parts, scope_tokens, rel_path, chunk_index, line_start, line_end, tags, kind)
           VALUES ('orphan copy', 'orphan copy', ?, 'orphan-parts.md', 0, 1, 1, '', 'md')`
        )
        .run(ftsScopeTokens("orphan-parts.md"));
      expectMismatches(1, 0);
      raw.prepare("DELETE FROM chunk_parts WHERE rel_path = 'orphan-parts.md'").run();
      expectMismatches(0, 0);
      audited.dropFile("parts.md");
      expectMismatches(0, 0);

      // Shape guard for the comparison above. `chunks` and `chunk_parts` are
      // both FTS5 virtual tables with no index on the join columns, so the
      // natural `LEFT JOIN ... ON rel_path` is a nested scan: measured 142 s at
      // 20k x 20k rows against 0.07 s for the set-difference form. The audit
      // reads the whole index in strict evidence mode, so the form is
      // load-bearing, and `discoverScanners` cannot see an SQL string.
      const auditSource = await fs.readFile(path.resolve("src/fts5.ts"), "utf8");
      const auditBody = auditSource.slice(
        auditSource.indexOf("auditKind(kind: ChunkKind)"),
        auditSource.indexOf("fingerprintKind(kind: ChunkKind)")
      );
      expect(auditBody).not.toBe("");
      expect(auditBody).toMatch(/EXCEPT/);
      expect(auditBody).not.toMatch(/JOIN\s+chunk_parts\b/);

      const manifestBeforeMutation = audited.fingerprintKind("md");
      raw.prepare("UPDATE chunks SET tags = 'same-shape-mutation' WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(0, 0);
      expect(audited.fingerprintKind("md")).not.toBe(manifestBeforeMutation);
      raw.prepare("UPDATE chunks SET tags = '' WHERE rel_path = 'a.md' AND chunk_index = 0").run();
      expectMismatches(0, 0);
      expect(audited.fingerprintKind("md")).toBe(manifestBeforeMutation);

      // A physical row with no source declaration fails only its own kind.
      raw
        .prepare(
          `INSERT INTO chunks
             (content, title, aliases, scope_tokens, rel_path, chunk_index,
              line_start, line_end, tags, raw_content, kind)
           VALUES ('orphan', '', '', ?, 'orphan.md', 0, 1, 1, '', 'orphan', 'md')`
        )
        .run(ftsScopeTokens("orphan.md"));
      expectMismatches(1, 0);
      raw.prepare("DELETE FROM chunks WHERE rel_path = 'orphan.md'").run();
      expectMismatches(0, 0);

      // A valid-but-wrong kind on a declared path contaminates both scoped
      // views: cross-kind for markdown and orphaned physical data for PDF.
      raw
        .prepare(
          `INSERT INTO chunks
             (content, title, aliases, scope_tokens, rel_path, chunk_index,
              line_start, line_end, tags, raw_content, kind)
           VALUES ('cross', '', '', ?, 'a.md', 2, 3, 3, '', 'cross', 'pdf')`
        )
        .run(ftsScopeTokens("a.md"));
      expectMismatches(1, 1);
      raw.prepare("DELETE FROM chunks WHERE rel_path = 'a.md' AND kind = 'pdf'").run();
      expectMismatches(0, 0);

      // Unknown kinds are global integrity failures, whether the bad value
      // lives in the physical rows or only in source_state.
      raw
        .prepare(
          `INSERT INTO chunks
             (content, title, aliases, scope_tokens, rel_path, chunk_index,
              line_start, line_end, tags, raw_content, kind)
           VALUES ('bad kind', '', '', ?, 'bad-kind.md', 0, 1, 1, '', 'bad kind', 'bogus')`
        )
        .run(ftsScopeTokens("bad-kind.md"));
      expectMismatches(1, 1);
      raw.prepare("DELETE FROM chunks WHERE rel_path = 'bad-kind.md'").run();
      expectMismatches(0, 0);

      raw
        .prepare(
          `INSERT INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at)
           VALUES ('bad-state.md', 1, 1, 'bogus', 'now')`
        )
        .run();
      expectMismatches(1, 1);
      raw.prepare("DELETE FROM source_state WHERE rel_path = 'bad-state.md'").run();
      expectMismatches(0, 0);
    } finally {
      await audited.closeAndRelease();
      raw.close();
    }

    // Strict benchmark mode must abort on an empty source instead of
    // publishing the optimistic pre-sync diff counters. After removing the
    // negative control, the same real Vault/SQLite path yields exact evidence.
    const vaultRoot = path.join(dbDir, "vault");
    await fs.mkdir(vaultRoot);
    await fs.writeFile(path.join(vaultRoot, "good.md"), "indexable text");
    await fs.writeFile(path.join(vaultRoot, "empty.md"), "");
    const syncIndex = new FtsIndex({ file: path.join(dbDir, "sync.fts5.db"), vaultRoot });
    await syncIndex.open();
    try {
      await expect(syncFtsIndex(new Vault(vaultRoot), syncIndex, { mode: "strict" })).rejects.toThrow(
        /produced zero FTS chunks/
      );
      await fs.unlink(path.join(vaultRoot, "empty.md"));
      await syncIndex.clearOnDisk();
      await syncIndex.open();
      const report = await syncFtsIndex(new Vault(vaultRoot), syncIndex, { mode: "strict" });
      expect(report).toMatchObject({
        mode: "strict",
        audited: true,
        added: 1,
        total_files: 1,
        processed_files: 1,
        empty: 0,
        failed: 0,
        declared_files: 1,
        indexed_files: 1,
        mismatched_files: 0,
        complete: true
      });
      expect(report.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);

      const goodPath = path.join(vaultRoot, "good.md");
      await fs.writeFile(goodPath, "");
      const future = new Date(Date.now() + 60_000);
      await fs.utimes(goodPath, future, future);
      await expect(syncFtsIndex(new Vault(vaultRoot), syncIndex, { mode: "strict" })).rejects.toThrow(
        /produced zero FTS chunks/
      );
      // The last known-good physical row is retained for recovery, but the
      // failed refresh quarantines it from every public FTS read immediately.
      expect(syncIndex.totalFiles()).toBe(1);
      expect(syncIndex.totalChunks()).toBe(1);
      expect(syncIndex.search("indexable")).toEqual([]);
      expect(syncIndex.getChunk("good.md", 0)).toBeNull();
      expect(syncIndex.auditKind("md").mismatched_files).toBe(1);

      const failSoftAuditSpy = vi.spyOn(syncIndex, "auditKind");
      const failSoftManifestSpy = vi.spyOn(syncIndex, "fingerprintKind");
      const failSoft = await syncFtsIndex(new Vault(vaultRoot), syncIndex);
      expect(failSoft).toMatchObject({
        mode: "fail-soft",
        audited: false,
        empty: 1,
        failed: 0,
        manifest_sha256: null,
        complete: false
      });
      expect(failSoftAuditSpy).not.toHaveBeenCalled();
      expect(failSoftManifestSpy).not.toHaveBeenCalled();
      expect(syncIndex.search("indexable")).toEqual([]);
      expect(syncIndex.totalFiles()).toBe(0);
    } finally {
      await syncIndex.closeAndRelease();
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
      await idx.closeAndRelease();
    }
  });

  // AH-2 turns the old metadata-only downgrade into genuine physical v1-v5
  // fixtures. The admission map is therefore pinned to every FTS schema that
  // Enquire has actually shipped, not a current table carrying an old stamp.
  it("rebuilds all supported same-root LEGACY schemas but refuses a FUTURE schema", async () => {
    if (!canRunFts5) return;
    const { default: Database } = await import("better-sqlite3");
    const chunkColumnsFor = (version: number): string[] => [
      "content",
      ...(version >= 5 ? ["title", "aliases"] : []),
      ...(version >= 6 ? ["scope_tokens"] : []),
      "rel_path UNINDEXED",
      "chunk_index UNINDEXED",
      "line_start UNINDEXED",
      "line_end UNINDEXED",
      ...(version >= 2 ? ["tags UNINDEXED"] : []),
      ...(version >= 3 ? ["raw_content UNINDEXED"] : []),
      ...(version >= 4 ? ["kind UNINDEXED"] : [])
    ];
    for (let version = 1; version < FTS_SCHEMA_VERSION; version++) {
      const legacyFile = version === FTS_SCHEMA_VERSION - 1 ? dbFile : path.join(dbDir, `legacy-v${version}.fts5.db`);
      const legacy = new Database(legacyFile);
      legacy.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE VIRTUAL TABLE chunks USING fts5(
          ${chunkColumnsFor(version).join(",\n          ")},
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TABLE source_state (
          rel_path TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL,
          n_chunks INTEGER NOT NULL,
          ${version >= 4 ? "kind TEXT NOT NULL DEFAULT 'md'," : ""}
          indexed_at TEXT NOT NULL
        );
      `);
      legacy.prepare("INSERT INTO meta VALUES ('schema_version', ?)").run(String(version));
      legacy.prepare("INSERT INTO meta VALUES ('vault_root', '/v')").run();
      legacy.prepare("INSERT INTO meta VALUES ('tokenize_mode', 'unicode61')").run();
      legacy
        .prepare("INSERT INTO chunks (content, rel_path, chunk_index, line_start, line_end) VALUES (?, ?, 0, 1, 1)")
        .run(`legacy-v${version}-marker`, `legacy-v${version}.md`);
      if (version >= 4) {
        legacy
          .prepare(
            "INSERT INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at) VALUES (?, 1000, 1, 'md', 'now')"
          )
          .run(`legacy-v${version}.md`);
      } else {
        legacy
          .prepare("INSERT INTO source_state (rel_path, mtime_ms, n_chunks, indexed_at) VALUES (?, 1000, 1, 'now')")
          .run(`legacy-v${version}.md`);
      }
      expect(legacy.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 1 });
      legacy.close();

      const rebuilt = new FtsIndex({ file: legacyFile, vaultRoot: "/v" });
      await rebuilt.open();
      expect(rebuilt.totalChunks(), `v${version} rebuild must discard legacy rows`).toBe(0);
      await rebuilt.closeAndRelease();
      // The rebuild must materialise the v7 sibling table, not just the
      // schema stamp: an index whose `chunk_parts` is missing is refused by
      // the very next open.
      const rebuiltRaw = new Database(legacyFile, { readonly: true, fileMustExist: true });
      try {
        const partsSql = rebuiltRaw.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_parts'").get() as
          | { sql?: string }
          | undefined;
        expect(partsSql?.sql, `v${version} rebuild must recreate chunk_parts`).toMatch(/USING\s+fts5/i);
      } finally {
        rebuiltRaw.close();
      }
      expect((await peekFtsMetaSafe(legacyFile))?.schema_version).toBe(String(FTS_SCHEMA_VERSION));
    }

    const futureSeed = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await futureSeed.open();
    futureSeed.reindexFile("future-marker.md", 2000, "uniquefuturemarker content");
    await futureSeed.closeAndRelease();

    // The opposite mismatch is not a migration invitation. Opening code from
    // an older Enquire version must not destructively downgrade a future DB.
    const futureRaw = new Database(dbFile);
    futureRaw
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(FTS_SCHEMA_VERSION + 1));
    const beforeFuture = {
      schema: futureRaw
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name"
        )
        .all(),
      meta: futureRaw.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      chunks: futureRaw.prepare("SELECT rowid, * FROM chunks ORDER BY rowid").all(),
      shadows: [
        "SELECT * FROM chunks_data ORDER BY id",
        "SELECT * FROM chunks_idx ORDER BY segid, term, pgno",
        "SELECT * FROM chunks_content ORDER BY id",
        "SELECT * FROM chunks_docsize ORDER BY id",
        "SELECT * FROM chunks_config ORDER BY k"
      ].map((query) => futureRaw.prepare(query).all()),
      sourceCells: [
        "SELECT * FROM source_state ORDER BY rel_path",
        "SELECT * FROM source_quarantine ORDER BY rel_path, kind",
        "SELECT * FROM source_revision ORDER BY rel_path, kind"
      ].map((query) => futureRaw.prepare(query).all())
    };
    futureRaw.close();

    const future = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    const rejection = await future.open().then(
      () => null,
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(Error);
    const message = rejection instanceof Error ? rejection.message : "";
    expect(message).toMatch(/newer schema version/);
    expect(message).not.toContain(dbFile);
    expect(message).not.toContain("/v");

    const futureAfter = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      expect({
        schema: futureAfter
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name"
          )
          .all(),
        meta: futureAfter.prepare("SELECT key, value FROM meta ORDER BY key").all(),
        chunks: futureAfter.prepare("SELECT rowid, * FROM chunks ORDER BY rowid").all(),
        shadows: [
          "SELECT * FROM chunks_data ORDER BY id",
          "SELECT * FROM chunks_idx ORDER BY segid, term, pgno",
          "SELECT * FROM chunks_content ORDER BY id",
          "SELECT * FROM chunks_docsize ORDER BY id",
          "SELECT * FROM chunks_config ORDER BY k"
        ].map((query) => futureAfter.prepare(query).all()),
        sourceCells: [
          "SELECT * FROM source_state ORDER BY rel_path",
          "SELECT * FROM source_quarantine ORDER BY rel_path, kind",
          "SELECT * FROM source_revision ORDER BY rel_path, kind"
        ].map((query) => futureAfter.prepare(query).all())
      }).toEqual(beforeFuture);
    } finally {
      futureAfter.close();
      await future.closeAndRelease();
    }
  });

  // Matching-version PRESERVATION control (the property the old test actually
  // exercised): a reopen at the SAME schema_version keeps the data.
  it("a matching schema_version reopen PRESERVES the index (no rebuild)", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    idx.reindexFile("keep.md", 1000, "preserved content");
    expect(idx.totalChunks()).toBeGreaterThan(0);
    await idx.closeAndRelease();

    const idx2 = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx2.open();
    expect(idx2.totalChunks(), "matching schema must preserve rows").toBeGreaterThan(0);
    await idx2.closeAndRelease();
  });
});

// v3.6.2 — peekFtsMetaSafe (audit M-8 / K-1b class fix). Reads meta from
// a SQLite file without triggering bootstrapSchema's DROP-TABLE-on-mismatch
// path. We cover missing/foreign/malformed metadata, bounded exact tokenizer
// discovery, one-argument diagnostic compatibility, and never-throw cleanup.
describe("peekFtsMetaSafe (v3.6.2 — meta peek without bootstrap)", () => {
  it("distinguishes missing and genuinely empty files from populated malformed SQLite", async () => {
    if (!canRunFts5) return;
    const missing = path.join(dbDir, "nope.fts5.db");
    expect(await peekFtsMetaSafe(missing)).toBeNull();
    expect(await discoverFtsIndexConfig(missing, "/v")).toEqual({ kind: "missing" });

    // lstat success is not proof of an existing index artifact. A dangling
    // symlink must be refused before better-sqlite3 can follow it and create
    // the target as though the configured path were fresh.
    if (process.platform !== "win32") {
      const symlinkTarget = path.join(dbDir, "must-remain-missing.fts5.db");
      const symlinkFile = path.join(dbDir, "dangling-index.fts5.db");
      await fs.symlink(symlinkTarget, symlinkFile);
      expect(await discoverFtsIndexConfig(symlinkFile, "/v")).toEqual({ kind: "refused" });
      const symlinkIndex = new FtsIndex({ file: symlinkFile, vaultRoot: "/v" });
      const symlinkRejection = await symlinkIndex.open().then(
        () => null,
        (error: unknown) => error
      );
      expect(symlinkRejection).toBeInstanceOf(Error);
      const symlinkMessage = symlinkRejection instanceof Error ? symlinkRejection.message : "";
      expect(symlinkMessage).not.toContain(symlinkFile);
      expect(symlinkMessage).not.toContain(symlinkTarget);
      expect(symlinkMessage).not.toContain("/v");
      await expect(fs.lstat(symlinkTarget)).rejects.toThrow();
    }

    // A pre-existing zero-byte file is SQLite's exact empty-container edge.
    // Discovery must not collapse it into the same refusal as malformed data,
    // and the readonly probe must not materialize a database header.
    const zeroByte = path.join(dbDir, "zero-byte.fts5.db");
    await fs.writeFile(zeroByte, Buffer.alloc(0));
    expect(await discoverFtsIndexConfig(zeroByte, "/v")).toEqual({ kind: "empty" });
    expect((await fs.stat(zeroByte)).size).toBe(0);

    const { default: Database } = await import("better-sqlite3");
    const schemaEmpty = path.join(dbDir, "schema-empty.fts5.db");
    new Database(schemaEmpty).close();
    expect(await discoverFtsIndexConfig(schemaEmpty, "/v")).toEqual({ kind: "empty" });

    const logicalInventory = (file: string) => {
      const raw = new Database(file, { readonly: true, fileMustExist: true });
      try {
        return raw
          .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
          .all();
      } finally {
        raw.close();
      }
    };
    const expectDiscoveryStateRefusal = async (
      file: string,
      expected: Awaited<ReturnType<typeof discoverFtsIndexConfig>>
    ) => {
      const index = new FtsIndex({ file, vaultRoot: "/v" });
      const error = await index.open(expected).then(
        () => null,
        (caught: unknown) => caught
      );
      await index.closeAndRelease();
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toBe("FTS index configuration changed before open");
      expect(message).not.toContain(file);
      expect(message).not.toContain("/v");
    };

    // `missing` and present schema-`empty` are distinct preflight states.
    // Neither may authorize the other, and a prior `refused` result never
    // becomes bootstrap authority merely because the path later looks empty.
    const missingThenEmpty = path.join(dbDir, "missing-then-empty.fts5.db");
    const expectedMissing = await discoverFtsIndexConfig(missingThenEmpty, "/v");
    expect(expectedMissing).toEqual({ kind: "missing" });
    new Database(missingThenEmpty).close();
    await expectDiscoveryStateRefusal(missingThenEmpty, expectedMissing);
    expect(logicalInventory(missingThenEmpty)).toEqual([]);

    const emptyThenMissing = path.join(dbDir, "empty-then-missing.fts5.db");
    new Database(emptyThenMissing).close();
    const expectedEmpty = await discoverFtsIndexConfig(emptyThenMissing, "/v");
    expect(expectedEmpty).toEqual({ kind: "empty" });
    await fs.unlink(emptyThenMissing);
    await expectDiscoveryStateRefusal(emptyThenMissing, expectedEmpty);
    expect(logicalInventory(emptyThenMissing)).toEqual([]);

    const refusedThenEmpty = path.join(dbDir, "refused-then-empty.fts5.db");
    const refusedSetup = new Database(refusedThenEmpty);
    refusedSetup.exec("CREATE TABLE foreign_payload (value BLOB NOT NULL)");
    refusedSetup.close();
    const expectedRefused = await discoverFtsIndexConfig(refusedThenEmpty, "/v");
    expect(expectedRefused).toEqual({ kind: "refused" });
    const refusedCleanup = new Database(refusedThenEmpty);
    refusedCleanup.exec("DROP TABLE foreign_payload");
    refusedCleanup.close();
    await expectDiscoveryStateRefusal(refusedThenEmpty, expectedRefused);
    expect(logicalInventory(refusedThenEmpty)).toEqual([]);

    const matchingMissing = path.join(dbDir, "matching-missing.fts5.db");
    const matchingMissingDiscovery = await discoverFtsIndexConfig(matchingMissing, "/v");
    const missingInitializer = new FtsIndex({ file: matchingMissing, vaultRoot: "/v" });
    await missingInitializer.open(matchingMissingDiscovery);
    await missingInitializer.closeAndRelease();
    expect((await discoverFtsIndexConfig(matchingMissing, "/v")).kind).toBe("owned");

    const matchingEmpty = path.join(dbDir, "matching-empty.fts5.db");
    new Database(matchingEmpty).close();
    const matchingEmptyDiscovery = await discoverFtsIndexConfig(matchingEmpty, "/v");
    const emptyInitializer = new FtsIndex({ file: matchingEmpty, vaultRoot: "/v" });
    await emptyInitializer.open(matchingEmptyDiscovery);
    await emptyInitializer.closeAndRelease();
    expect((await discoverFtsIndexConfig(matchingEmpty, "/v")).kind).toBe("owned");

    // Paired negative: an existing populated non-FTS SQLite file is refused,
    // not treated as empty/defaultable, and its BLOB/schema stay untouched.
    const malformed = path.join(dbDir, "populated-malformed.fts5.db");
    const malformedRaw = new Database(malformed);
    malformedRaw.exec("CREATE TABLE foreign_payload (id TEXT PRIMARY KEY, body BLOB NOT NULL)");
    malformedRaw
      .prepare("INSERT INTO foreign_payload VALUES (?, ?)")
      .run("keep", Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]));
    const beforeMalformed = {
      schema: malformedRaw
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
        .all(),
      cells: malformedRaw.prepare("SELECT * FROM foreign_payload ORDER BY id").all()
    };
    malformedRaw.close();
    expect(await discoverFtsIndexConfig(malformed, "/v")).toEqual({ kind: "refused" });
    const malformedAfter = new Database(malformed, { readonly: true, fileMustExist: true });
    try {
      expect({
        schema: malformedAfter
          .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
          .all(),
        cells: malformedAfter.prepare("SELECT * FROM foreign_payload ORDER BY id").all()
      }).toEqual(beforeMalformed);
    } finally {
      malformedAfter.close();
    }
  });

  it("reads tokenize_mode + vault_root + schema_version from an existing db", async () => {
    if (!canRunFts5) return;
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v", tokenize: "trigram" });
    await idx.open();
    idx.reindexFile("a.md", 1000, "content");
    await idx.closeAndRelease();

    const meta = await peekFtsMetaSafe(dbFile);
    expect(meta).not.toBeNull();
    expect(meta?.tokenize_mode).toBe("trigram");
    expect(meta?.vault_root).toBe("/v");
    expect(meta?.schema_version).toBeDefined();
    expect(await peekFtsMetaSafe(dbFile, "/v")).toEqual(meta);
    expect(await peekFtsMetaSafe(dbFile, "/foreign-vault")).toBeNull();
    expect(await discoverFtsIndexConfig(dbFile, "/v")).toEqual({
      kind: "owned",
      meta: {
        schema_version: String(FTS_SCHEMA_VERSION),
        vault_root: "/v",
        tokenize_mode: "trigram"
      }
    });
    expect(await discoverFtsIndexConfig(dbFile, "/foreign-vault")).toEqual({ kind: "refused" });

    const { default: Database } = await import("better-sqlite3");
    // A native close failure must not escape either never-throw API. The legacy
    // peek keeps its bounded diagnostic result; authoritative discovery
    // invalidates an otherwise-owned classification to generic refusal.
    const closePrototype = Database.prototype as unknown as { close(): void };
    const originalClose = closePrototype.close;
    closePrototype.close = function (this: unknown) {
      originalClose.call(this);
      throw new Error(`close failed for ${dbFile}`);
    };
    try {
      expect(await peekFtsMetaSafe(dbFile, "/v")).toEqual(meta);
      expect(await discoverFtsIndexConfig(dbFile, "/v")).toEqual({ kind: "refused" });
    } finally {
      closePrototype.close = originalClose;
    }

    // Discovery reads exactly the three authority keys. A fourth/unknown key
    // must fail soft instead of being ignored and laundered into caller config.
    const raw = new Database(dbFile);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('unexpected', 'payload')").run();
    raw.close();
    expect(await peekFtsMetaSafe(dbFile, "/v")).toBeNull();
  });

  it("accepts exact unicode61 but never coerces an unknown stored or runtime tokenizer", async () => {
    if (!canRunFts5) return;
    // Positive control: an exact supported stored value round-trips.
    const idx = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    await idx.open();
    idx.reindexFile("a.md", 1000, "content");
    await idx.closeAndRelease();
    expect((await peekFtsMetaSafe(dbFile))?.tokenize_mode).toBe("unicode61");

    // Runtime input must fail synchronously, before open() can prepare a path.
    expect(
      () =>
        new FtsIndex({
          file: path.join(dbDir, "must-not-exist.fts5.db"),
          vaultRoot: "/v",
          tokenize: "porter" as TokenizeMode
        })
    ).toThrow(/unicode61.*trigram.*porter/);
    expect(
      () =>
        new FtsIndex({
          file: path.join(dbDir, "null-must-not-exist.fts5.db"),
          vaultRoot: "/v",
          tokenize: null as unknown as TokenizeMode
        })
    ).toThrow(/unicode61.*trigram/);
    await expect(fs.stat(path.join(dbDir, "must-not-exist.fts5.db"))).rejects.toThrow();
    await expect(fs.stat(path.join(dbDir, "null-must-not-exist.fts5.db"))).rejects.toThrow();

    // Stored unknown modes are fail-soft in discovery but fail-closed in the
    // authoritative same-handle open guard. Neither surface launders them to
    // unicode61, and refusal preserves the ordered logical cells.
    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(dbFile);
    raw.prepare("UPDATE meta SET value = 'porter' WHERE key = 'tokenize_mode'").run();
    const before = {
      meta: raw.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      chunks: raw.prepare("SELECT rowid, * FROM chunks ORDER BY rowid").all()
    };
    raw.close();
    expect(await peekFtsMetaSafe(dbFile)).toBeNull();

    const invalidStored = new FtsIndex({ file: dbFile, vaultRoot: "/v" });
    const rejection = await invalidStored.open().then(
      () => null,
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(Error);
    const message = rejection instanceof Error ? rejection.message : "";
    expect(message).toMatch(/unsupported stored tokenizer/);
    expect(message).not.toContain(dbFile);
    expect(message).not.toContain("/v");
    const afterRaw = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      expect({
        meta: afterRaw.prepare("SELECT key, value FROM meta ORDER BY key").all(),
        chunks: afterRaw.prepare("SELECT rowid, * FROM chunks ORDER BY rowid").all()
      }).toEqual(before);
    } finally {
      afterRaw.close();
      await invalidStored.closeAndRelease();
    }
  });
});

// ─── v3.11.6-rc.6 — alias indexing + FTS5 column weights (competitive-study C-3) ───

describe("extractAliases (v3.11.6-rc.6)", () => {
  it("reads an aliases array", () => {
    expect(extractAliases({ aliases: ["Foo", "Bar"] })).toEqual(["Foo", "Bar"]);
  });
  it("reads a singular `alias` string and a scalar `aliases`", () => {
    expect(extractAliases({ alias: "Solo" })).toEqual(["Solo"]);
    expect(extractAliases({ aliases: "Scalar" })).toEqual(["Scalar"]);
  });
  it("trims + drops empty and non-string entries", () => {
    expect(extractAliases({ aliases: ["  Keep  ", "", 42, null, "Also"] })).toEqual(["Keep", "Also"]);
  });
  it("NEGATIVE control — no aliases key yields empty (no phantom aliases)", () => {
    expect(extractAliases({ title: "x" })).toEqual([]);
    expect(extractAliases(undefined)).toEqual([]);
    expect(extractAliases(null)).toEqual([]);
  });
  // rc.12 (pre-promotion re-sweep) — Obsidian properties are case-insensitive; rc.6
  // read the keys raw, so `Aliases:`/`Alias:` notes silently got NO alias indexing
  // (a recursion of the v3.11.0-rc.13 AUD-03 frontmatter-key-PRODUCER fold class).
  it("reads case-variant keys (`Aliases:` / `Alias:`) via the folded lookup", () => {
    expect(extractAliases({ Aliases: ["Zeta"] })).toEqual(["Zeta"]);
    expect(extractAliases({ Alias: "Solo" })).toEqual(["Solo"]);
    expect(extractAliases({ ALIASES: ["Caps"] })).toEqual(["Caps"]);
  });
});

describe("deriveFtsTitle (v3.11.6-rc.6)", () => {
  it("strips the .md extension from the basename", () => {
    expect(deriveFtsTitle("Projects/Apollo Program.md")).toBe("Apollo Program");
  });
  it("NEGATIVE control — a non-.md path keeps its basename verbatim", () => {
    expect(deriveFtsTitle("Refs/paper.pdf")).toBe("paper.pdf");
  });
});

describe("FTS5 alias + title columns (v3.11.6-rc.6 C-3)", () => {
  it("finds a note by its frontmatter ALIAS even when the body lacks the term", () => {
    if (!canRunFts5) return;
    return (async () => {
      const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
      await idx.open();
      try {
        // body says nothing about "Striped Equine" — only the alias does.
        idx.reindexFile("Zebra.md", 1000, "A large animal on the savanna.", [], [], "Zebra", ["Striped Equine"]);
        idx.reindexFile("Unrelated.md", 1001, "Photosynthesis in plants.", [], [], "Unrelated", []);
        const hits = idx.search("Striped Equine");
        expect(hits.map((h) => h.rel_path)).toContain("Zebra.md");
        // NEGATIVE control — a note with no such alias is NOT surfaced.
        expect(hits.map((h) => h.rel_path)).not.toContain("Unrelated.md");
      } finally {
        await idx.closeAndRelease();
      }
    })();
  });

  it("finds a note by its TITLE even when the body lacks the term", () => {
    if (!canRunFts5) return;
    return (async () => {
      const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
      await idx.open();
      try {
        // title is "Photosynthesis"; body never says the word.
        idx.reindexFile(
          "Photosynthesis.md",
          1000,
          "Plants convert light into chemical energy.",
          [],
          [],
          "Photosynthesis",
          []
        );
        const hits = idx.search("Photosynthesis");
        expect(hits[0]?.rel_path).toBe("Photosynthesis.md");
      } finally {
        await idx.closeAndRelease();
      }
    })();
  });

  it("a TITLE match outranks a body-only mention (column weighting)", () => {
    if (!canRunFts5) return;
    return (async () => {
      const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
      await idx.open();
      try {
        // A: term ONLY in title. B: term ONLY in body. Title is weighted 10× vs content 1×.
        idx.reindexFile("Mitochondria.md", 1000, "The powerhouse of the cell lives here.", [], [], "Mitochondria", []);
        idx.reindexFile(
          "CellBiology.md",
          1001,
          "The mitochondria produces ATP for the cell.",
          [],
          [],
          "CellBiology",
          []
        );
        const hits = idx.search("mitochondria");
        expect(hits.length).toBeGreaterThanOrEqual(2);
        // The title-match note ranks first thanks to the 10× title weight.
        expect(hits[0]?.rel_path).toBe("Mitochondria.md");

        // SBS-D2' (v7) — a compound identifier is reachable by the words it is
        // spelled from, through a column of its own. The tokenizer already splits
        // `_`, so the snake_case twin always was; the camelCase one was not.
        idx.reindexFile("camel.md", 1000, "Aggregate poolDayData for the window.");
        idx.reindexFile("snake.md", 1000, "Aggregate liquidity_pool_day for the window.");
        expect(idx.search("poolDayData").map((hit) => hit.rel_path)).toEqual(["camel.md"]);
        expect(idx.search("pool day").map((hit) => hit.rel_path)).toContain("snake.md");
        expect(idx.search("pool day data").map((hit) => hit.rel_path)).toContain("camel.md");
        // Found, not ranked: the sibling table changes what is FOUND, never
        // how `chunks` RANKS. Two notes whose bodies tokenize identically (one
        // opaque lowercase token vs one camelCase identifier — same term count,
        // same row length) score identically for a query spelled from that
        // identifier's parts. A weight-0 COLUMN failed this on CI (1.03 vs
        // 1.16): bm25() normalises by the whole row's length, so the parts
        // lengthened `ident.md`. The #577 placement in `content` moved such a
        // candidate from rank 1 to 51 for the same reason.
        idx.reindexFile("plain.md", 1000, "Aggregate the daily window for the pool report. fetchdailyreport");
        idx.reindexFile("ident.md", 1000, "Aggregate the daily window for the pool report. fetchDailyReport");
        const byPath = new Map(idx.search("daily window report").map((hit) => [hit.rel_path, hit.score]));
        expect(byPath.get("plain.md")).toBe(byPath.get("ident.md"));
        // Attribution: parts belong to the chunk that carries the identifier,
        // so the hit cites that section — not chunk 0.
        const filler = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
        idx.reindexFile("deep.md", 1000, `# Top\n\n${filler}\n\n## Later\n\ncalls rebuildSearchGraph here\n`);
        const deep = idx.search("rebuild search graph").find((hit) => hit.rel_path === "deep.md");
        expect(deep?.chunk_index).toBeGreaterThan(0);
        // Bounded by truncation, never by refusal: a note with more identifiers
        // than the per-chunk cap still indexes and is still findable by its body.
        const flood = Array.from({ length: 600 }, (_, i) => `fooBar${i}Baz`).join(" ");
        idx.reindexFile("flood.md", 1000, `unmistakableBodyMarker ${flood}`);
        expect(idx.search("unmistakableBodyMarker").map((hit) => hit.rel_path)).toEqual(["flood.md"]);
        // The splitter's boundaries, pinned: upper-case runs, digit edges, NFC,
        // and single words emitting nothing.
        expect(splitIdentifierParts("call parseHTTPResponse(sha256Hash)")).toEqual([
          "parse",
          "http",
          "response",
          "sha",
          "256",
          "hash"
        ]);
        expect(splitIdentifierParts("cafe\u0301Latte")).toEqual(["café", "latte"]);
        expect(splitIdentifierParts("plain words only_here")).toEqual([]);

        // DOCUMENTED LIMIT (C3 re-sweep). FTS5 matches per ROW, and rc.6 stores
        // title/aliases on chunk 0 only, so a query pairing a title-only word
        // with a word that lives in a LATER chunk matches nothing — in either
        // pass. v7 does not change this: chunk_parts carries the chunk's
        // content copy and its identifier parts, never the note's title. This
        // is a pre-existing property of note-level attributes, not a v7
        // regression: the same query returned nothing before the parts table
        // existed. Closing it in general would need title on EVERY parts row,
        // which relocates the rc.6 candidate-set flooding into the score-0
        // tail — so the limit is documented rather than traded for that.
        const spacer = Array.from({ length: 400 }, (_, i) => `filler${i}`).join(" ");
        idx.reindexFile(
          "Ribosome.md",
          1000,
          `translation overview

${spacer}

call buildPeptideChain here`,
          [],
          [],
          "Ribosome",
          []
        );
        // POSITIVE: the title word alone finds it.
        expect(idx.search("Ribosome").map((hit) => hit.rel_path)).toContain("Ribosome.md");
        // POSITIVE: the identifier's parts alone find it, through the v7 pass.
        expect(idx.search("peptide chain").map((hit) => hit.rel_path)).toContain("Ribosome.md");
        // POSITIVE — the discriminating control: the title word ANDed with a
        // word that IS in chunk 0's own content DOES match. Without this the
        // empty assertion below would pass for any reason at all, including a
        // broken fixture or a non-AND parser.
        expect(idx.search("Ribosome translation").map((hit) => hit.rel_path)).toContain("Ribosome.md");
        // THE LIMIT: title word + a word only reachable as a later chunk's
        // identifier part. No single row holds both.
        expect(idx.search("Ribosome peptide")).toEqual([]);
      } finally {
        await idx.closeAndRelease();
      }
    })();
  });

  it("stores title on chunk 0 ONLY — a title match doesn't flood the candidate set (rc.6 re-sweep #2)", () => {
    if (!canRunFts5) return;
    return (async () => {
      const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
      await idx.open();
      try {
        // Title "Widget"; body is 3 paragraphs (→3 chunks), NONE mention "widget".
        idx.reindexFile(
          "Widget.md",
          1000,
          "First paragraph about gears.\n\nSecond paragraph about cogs.\n\nThird paragraph about springs.",
          [],
          [],
          "Widget",
          []
        );
        const hits = idx.search("Widget");
        const widgetRows = hits.filter((h) => h.rel_path === "Widget.md");
        // Pre-fix: the title was in ALL 3 chunks → 3 rows flood the candidate set.
        // Post-fix: only chunk 0 carries the title → exactly 1 candidate row.
        expect(widgetRows.length).toBe(1);
        expect(widgetRows[0]?.chunk_index).toBe(0);
      } finally {
        await idx.closeAndRelease();
      }
    })();
  });

  it("extractAliases caps count + per-alias length (rc.6 re-sweep #3)", () => {
    const many = extractAliases({ aliases: Array.from({ length: 200 }, (_, i) => `alias${i}`) });
    expect(many.length).toBe(64); // MAX_ALIASES
    const long = extractAliases({ aliases: ["x".repeat(1000)] });
    expect(long[0]?.length).toBe(256); // MAX_ALIAS_LEN clamp
  });

  it("snippet still comes from the content column, not title/aliases (no snippet pollution)", () => {
    if (!canRunFts5) return;
    return (async () => {
      const idx = new FtsIndex({ file: dbFile, vaultRoot: "/tmp/vault" });
      await idx.open();
      try {
        idx.reindexFile("Note.md", 1000, "The body text discusses productivity systems.", [], [], "Note", ["MyAlias"]);
        const hits = idx.search("productivity");
        // snippet reflects the content passage, never the title/aliases columns.
        expect(hits[0]?.snippet).toMatch(/productivity/i);
        expect(hits[0]?.snippet).not.toContain("MyAlias");
      } finally {
        await idx.closeAndRelease();
      }
    })();
  });
});
