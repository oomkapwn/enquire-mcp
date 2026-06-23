import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileLike, DqlParseError, MAX_DQL_QUERY_LEN, MAX_LIKE_PATTERN_LEN, parseDql, runDql } from "../src/dql.js";
import { dataviewQuery, listTags } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-dql-"));
  await fs.mkdir(path.join(root, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(root, "projects", "alpha.md"),
    "---\nstatus: active\npriority: 1\ntags: [project]\n---\nAlpha project body.\n"
  );
  await fs.writeFile(
    path.join(root, "projects", "beta.md"),
    "---\nstatus: done\npriority: 2\ntags: [project, archive]\n---\nBeta project body.\n"
  );
  await fs.writeFile(path.join(root, "ideas.md"), "---\ntags: [idea]\nstatus: active\n---\nLoose idea note.\n");
  const now = Date.now();
  await fs.utimes(path.join(root, "projects", "alpha.md"), new Date(now - 60_000), new Date(now - 60_000));
  await fs.utimes(path.join(root, "projects", "beta.md"), new Date(now - 30_000), new Date(now - 30_000));
  await fs.utimes(path.join(root, "ideas.md"), new Date(now), new Date(now));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("parseDql", () => {
  it("parses LIST FROM folder", () => {
    const q = parseDql('LIST FROM "projects"');
    expect(q.kind).toBe("LIST");
    expect(q.source).toEqual({ type: "folder", path: "projects" });
    expect(q.where).toEqual([]);
  });

  it("parses TABLE with columns", () => {
    const q = parseDql('TABLE status, priority FROM "projects"');
    expect(q.kind).toBe("TABLE");
    expect(q.columns).toEqual(["status", "priority"]);
  });

  it("parses tag source", () => {
    const q = parseDql("LIST FROM #idea");
    expect(q.source).toEqual({ type: "tag", tag: "idea" });
  });

  it("parses WHERE with multiple ANDs into a single OR-group", () => {
    const q = parseDql('LIST FROM "projects" WHERE status = "active" AND priority = 1');
    expect(q.where.length).toBe(1);
    expect(q.where[0]?.length).toBe(2);
    expect(q.where[0]?.[0]).toEqual({ field: "status", op: "=", value: "active" });
    expect(q.where[0]?.[1]).toEqual({ field: "priority", op: "=", value: 1 });
  });

  it("parses WHERE with OR into separate groups", () => {
    const q = parseDql('LIST WHERE status = "active" OR status = "review"');
    expect(q.where.length).toBe(2);
    expect(q.where[0]?.[0]?.value).toBe("active");
    expect(q.where[1]?.[0]?.value).toBe("review");
  });

  it("parses mixed AND/OR (OR has lower precedence)", () => {
    const q = parseDql('LIST WHERE status = "a" AND priority = 1 OR status = "b" AND priority = 2');
    expect(q.where.length).toBe(2);
    expect(q.where[0]?.length).toBe(2);
    expect(q.where[1]?.length).toBe(2);
  });

  it("parses LIKE with wildcard", () => {
    const q = parseDql('LIST WHERE file.name like "draft*"');
    expect(q.where[0]?.[0]).toEqual({ field: "file.name", op: "like", value: "draft*" });
  });

  it("parses SORT and LIMIT", () => {
    const q = parseDql('LIST FROM "projects" SORT file.mtime DESC LIMIT 10');
    expect(q.sort).toEqual({ field: "file.mtime", dir: "DESC" });
    expect(q.limit).toBe(10);
  });

  it("rejects bad source", () => {
    expect(() => parseDql("LIST FROM oops")).toThrow(DqlParseError);
  });

  it("rejects columns on LIST", () => {
    expect(() => parseDql('LIST status FROM "projects"')).toThrow(DqlParseError);
  });

  it("rejects empty tag source 'FROM #' (audit P2-4)", () => {
    expect(() => parseDql("LIST FROM #")).toThrow(/tag name/);
  });

  it("rejects empty folder source 'FROM \"\"' (audit P2-4)", () => {
    expect(() => parseDql('LIST FROM ""')).toThrow(/not allowed/);
  });

  it("rejects trailing OR (audit P2-4)", () => {
    expect(() => parseDql('LIST WHERE status = "active" OR')).toThrow(/empty OR group|empty predicate/);
  });

  it("rejects trailing AND (audit P2-4)", () => {
    expect(() => parseDql('LIST WHERE status = "active" AND')).toThrow(/empty AND group|empty predicate/);
  });

  it("rejects duplicated OR like 'OR OR' (audit P2-4)", () => {
    expect(() => parseDql('LIST WHERE status = "a" OR OR status = "b"')).toThrow(/empty OR group/);
  });
});

describe("runDql", () => {
  it("runs LIST FROM folder", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects"'));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r["file.name"]).sort()).toEqual(["alpha", "beta"]);
  });

  it("runs LIST FROM tag", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql("LIST FROM #idea"));
    expect(rows.map((r) => r["file.name"])).toEqual(["ideas"]);
  });

  it("matches an accented TAG across NFC/NFD forms — FROM #tag (v3.11.0-rc.9, L-TAG-1 behavioral net)", async () => {
    // Behavioral ceiling for the NFC-tag class: an NFD-stored frontmatter tag must
    // resolve an NFC `FROM #tag` query. rc.8 NFC-fixed the WHERE-value comparators but
    // left the FROM-source tag path on plain .toLowerCase() until rc.9. (Catches any
    // missed tag site regardless of whether the static detector enumerates its shape.)
    const nfd = `Cafe${String.fromCodePoint(0x301)}`; // NFD tag value on disk
    const nfc = `Caf${String.fromCodePoint(0xe9)}`; // NFC tag in the query
    expect(nfc).not.toBe(nfd);
    const v2root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-dql-tagnfc-"));
    try {
      await fs.writeFile(path.join(v2root, "n.md"), `---\ntags: [${nfd}]\n---\nbody\n`);
      const v2 = new Vault(v2root);
      expect((await runDql(v2, parseDql(`LIST FROM #${nfc}`))).length, "NFC #tag resolves NFD-stored tag").toBe(1);
      expect((await runDql(v2, parseDql("LIST FROM #nonexistent"))).length, "NEGATIVE control").toBe(0);
    } finally {
      await fs.rm(v2root, { recursive: true, force: true });
    }
  });

  it("matches an accented note name across NFC/NFD forms — WHERE file.name (rc.69 round-3 re-sweep)", async () => {
    // The on-disk basename is NFD (as macOS APFS returns it); the user types the NFC literal.
    // Pre-rc.69, file.name = stripMd(basename) was raw NFD and the literal raw NFC, so
    // `file.name = "Café"` returned ZERO rows. Now both sides NFC-normalize. (bases.ts's
    // `file.name ==` twin was folded in rc.46; this DQL sink was the missed sibling.)
    const nfd = `Cafe${String.fromCodePoint(0x301)}`; // e + combining acute (NFD on-disk)
    const nfc = `Caf${String.fromCodePoint(0xe9)}`; // precomposed é (NFC literal)
    expect(nfc).not.toBe(nfd); // raw forms differ — the test is non-vacuous
    const v2root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-dql-nfc-"));
    try {
      await fs.writeFile(path.join(v2root, `${nfd}.md`), "---\ntags: [x]\n---\nbody\n");
      const v2 = new Vault(v2root);
      const rows = await runDql(v2, parseDql(`LIST WHERE file.name = "${nfc}"`));
      expect(rows.length, "NFC literal must resolve the NFD-on-disk note name").toBe(1);
      // and `contains` (substring path) + a non-matching literal (NEGATIVE control)
      expect((await runDql(v2, parseDql(`LIST WHERE file.name contains "${nfc}"`))).length).toBe(1);
      expect((await runDql(v2, parseDql(`LIST WHERE file.name = "Other"`))).length).toBe(0);
    } finally {
      await fs.rm(v2root, { recursive: true, force: true });
    }
  });

  it("matches an accented FRONTMATTER VALUE across NFC/NFD forms — WHERE <key> = / contains (v3.11.0-rc.8 pre-promotion audit)", async () => {
    // Sibling of the rc.69 file.name fix, on the arbitrary-frontmatter-value surface:
    // looseEq + the string-contains branch compared via `.toLowerCase()` WITHOUT
    // `.normalize("NFC")`, so an NFC literal silently missed an NFD-stored frontmatter
    // value. Now nfcLower folds both operands. (file.name/file.path were rc.69; this is
    // the uncovered value-equality sibling — the name-fold-invariant signature can't see it.)
    const nfd = `Cafe${String.fromCodePoint(0x301)}`; // NFD value stored in frontmatter
    const nfc = `Caf${String.fromCodePoint(0xe9)}`; // NFC literal the user types
    expect(nfc).not.toBe(nfd); // raw forms differ — non-vacuous
    const v2root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-dql-fmnfc-"));
    try {
      await fs.writeFile(path.join(v2root, "n.md"), `---\nauthor: ${nfd}\n---\nbody\n`);
      const v2 = new Vault(v2root);
      expect(
        (await runDql(v2, parseDql(`LIST WHERE author = "${nfc}"`))).length,
        "= matches an NFD-stored value via an NFC literal"
      ).toBe(1);
      expect((await runDql(v2, parseDql(`LIST WHERE author contains "${nfc}"`))).length, "contains too").toBe(1);
      expect((await runDql(v2, parseDql(`LIST WHERE author = "Nobody"`))).length, "NEGATIVE control").toBe(0);
    } finally {
      await fs.rm(v2root, { recursive: true, force: true });
    }
  });

  it("runs WHERE field equality", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE status = "active"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["alpha"]);
  });

  it("runs TABLE with columns", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('TABLE status, priority FROM "projects" SORT priority ASC'));
    expect(rows[0].status).toBe("active");
    expect(rows[0].priority).toBe(1);
    expect(rows[1].status).toBe("done");
  });

  it("respects SORT DESC + LIMIT", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" SORT priority DESC LIMIT 1'));
    expect(rows.length).toBe(1);
    expect(rows[0]["file.name"]).toBe("beta");
  });

  it("runs OR between predicate groups", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE status = "active" OR status = "done"'));
    expect(rows.map((r) => r["file.name"]).sort()).toEqual(["alpha", "beta"]);
  });

  it("runs LIKE with leading wildcard", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.name like "*lpha"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["alpha"]);
  });

  it("runs LIKE with trailing wildcard", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.name like "alp*"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["alpha"]);
  });

  it("LIKE is case-insensitive", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.name like "ALPHA"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["alpha"]);
  });

  it("LIKE escapes regex specials — 'a.b' is literal, not 'a-any-char-b' (audit fix)", async () => {
    const v = new Vault(root);
    // 'a.b' as a literal LIKE pattern must NOT match 'alpha' (or any char-in-the-middle).
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.name like "a.p"'));
    expect(rows).toEqual([]);
  });

  it("LIKE backslash-asterisk matches a literal asterisk (audit fix)", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "projects", "star.md"), '---\nlabel: "a*b"\n---\nbody');
    try {
      const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE label like "a\\*b"'));
      expect(rows.map((r) => r["file.name"])).toEqual(["star"]);
      const noMatch = await runDql(v, parseDql('LIST FROM "projects" WHERE label like "x\\*b"'));
      expect(noMatch).toEqual([]);
    } finally {
      await fs.unlink(path.join(root, "projects", "star.md")).catch(() => {});
    }
  });

  it("matches contains on tags array", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql('LIST FROM "projects" WHERE file.tags contains "archive"'));
    expect(rows.map((r) => r["file.name"])).toEqual(["beta"]);
  });
});

describe("dataviewQuery (tool wrapper)", () => {
  it("returns query echo + rows", async () => {
    const v = new Vault(root);
    const result = await dataviewQuery(v, { query: 'LIST FROM "projects" WHERE status = "done"' });
    expect(result.query).toContain("done");
    expect(result.rows.map((r) => r["file.name"])).toEqual(["beta"]);
  });

  it("treats SQL keywords inside quoted strings as data, not clauses", async () => {
    // The string contains "SORT", "WHERE", and "LIMIT" — none should split clauses.
    const q = parseDql('LIST WHERE status = "active sort limit where or"');
    expect(q.where.length).toBe(1);
    expect(q.where[0]?.[0]?.value).toBe("active sort limit where or");
    expect(q.sort).toBeUndefined();
    expect(q.limit).toBeUndefined();
  });

  it("treats AND/OR inside quoted strings as data, not predicate join", async () => {
    const q = parseDql('LIST WHERE status = "first AND second" OR priority = 1');
    expect(q.where.length).toBe(2);
    expect(q.where[0]?.[0]?.value).toBe("first AND second");
    expect(q.where[1]?.[0]?.value).toBe(1);
  });
});

describe("listTags", () => {
  it("aggregates tag counts across frontmatter and inline", async () => {
    const v = new Vault(root);
    const tags = await listTags(v, {});
    const projectTag = tags.find((t) => t.tag === "project");
    expect(projectTag?.count).toBe(2);
    expect(projectTag?.frontmatter_count).toBe(2);
    expect(tags.find((t) => t.tag === "idea")?.count).toBe(1);
  });

  it("respects min_count", async () => {
    const v = new Vault(root);
    const tags = await listTags(v, { min_count: 2 });
    expect(tags.every((t) => t.count >= 2)).toBe(true);
  });
});

describe("runDql — row cap", () => {
  it("applies the default row cap when no LIMIT is given", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql("LIST"), { defaultLimit: 1 });
    expect(rows.length).toBe(1);
  });

  it("an explicit LIMIT overrides the default cap", async () => {
    const v = new Vault(root);
    const rows = await runDql(v, parseDql("LIST LIMIT 2"), { defaultLimit: 1 });
    expect(rows.length).toBe(2);
  });
});

describe("DQL — quote-preserving whitespace (audit v0.7.6 P2)", () => {
  it("preserves repeated whitespace inside quoted FROM folder", () => {
    const q = parseDql('LIST FROM "Two  Spaces"');
    expect(q.source).toEqual({ type: "folder", path: "Two  Spaces" });
  });

  it("preserves repeated whitespace inside quoted WHERE value", () => {
    const q = parseDql('LIST WHERE status = "in  progress"');
    expect(q.where[0]?.[0]).toEqual({ field: "status", op: "=", value: "in  progress" });
  });

  it("still collapses unquoted runs of whitespace as syntax separators", () => {
    // Multiple spaces between keywords/values must still parse.
    const q = parseDql("LIST    FROM    #idea");
    expect(q.source).toEqual({ type: "tag", tag: "idea" });
  });
});

describe("DQL — `contains` for arrays = membership, not substring (v0.8 BREAKING)", () => {
  it("matches exact tag membership, not substring", async () => {
    const v = new Vault(root);
    // beta.md has tags: [project, archive] — `contains "archive"` should match.
    const archiveRows = await runDql(v, parseDql('LIST WHERE file.tags contains "archive"'));
    expect(archiveRows.map((r) => r["file.name"]).sort()).toEqual(["beta"]);
    // Substring `arch` should NOT match the tag `archive` under membership semantics.
    const partialRows = await runDql(v, parseDql('LIST WHERE file.tags contains "arch"'));
    expect(partialRows.length).toBe(0);
  });

  it("string `contains` retains substring semantics for non-array fields", async () => {
    const v = new Vault(root);
    // `status` is a string field; `contains "act"` should match status="active".
    const rows = await runDql(v, parseDql('LIST WHERE status contains "act"'));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("DQL — `!=` on missing fields treats absent as not-equal (audit v0.8 P0)", () => {
  it("returns rows whose field is missing when comparing with !=", async () => {
    const v = new Vault(root);
    // ideas.md has no `priority` field → `priority != "1"` should match.
    const rows = await runDql(v, parseDql('LIST WHERE priority != "1"'));
    const names = rows.map((r) => r["file.name"]);
    expect(names).toContain("ideas");
    expect(names).toContain("beta");
    expect(names).not.toContain("alpha"); // alpha has priority: 1
  });
});

describe("DQL — LIMIT must be a positive integer (audit v0.7.6 P4)", () => {
  it("rejects non-integer LIMIT", () => {
    expect(() => parseDql("LIST LIMIT 1.5")).toThrow(/positive integer/);
  });
  it("rejects scientific notation that's not integral", () => {
    expect(() => parseDql("LIST LIMIT 1.5e2")).not.toThrow(); // 150 is integral
    expect(() => parseDql("LIST LIMIT 1.55e1")).toThrow(/positive integer/); // 15.5
  });
  it("still accepts plain positive integers", () => {
    expect(parseDql("LIST LIMIT 50").limit).toBe(50);
  });
});

describe("compileLike length cap (v3.9.0-rc.9 audit — defensive CPU bound)", () => {
  it("compiles and matches a normal LIKE pattern (POSITIVE control)", () => {
    const m = compileLike("foo*bar");
    expect(m.test("fooXYZbar")).toBe(true);
    expect(m.test("nope")).toBe(false);
  });
  it("passes a pattern exactly at the cap (boundary POSITIVE control)", () => {
    expect(() => compileLike("a".repeat(MAX_LIKE_PATTERN_LEN))).not.toThrow();
  });
  it("throws on an over-long pattern (NEGATIVE control)", () => {
    expect(() => compileLike("a".repeat(MAX_LIKE_PATTERN_LEN + 1))).toThrow(/too long/i);
  });
});

// v3.10.0-rc.71 (post-rc.66 re-sweep, ReDoS class) — `likeToRegex` compiled `*`->`.*`
// and (rc.63) collapsed only ADJACENT `*` runs. A LIKE value with wildcards SEPARATED
// BY LITERALS (`*a*a*...` -> `^.*a.*a...$`) was still catastrophic (measured 110 s for
// `*a`x14), since the catastrophe scales with the SUBJECT length and so cannot be
// bounded by any wildcard count cap. `compileLike` now matches via a NON-backtracking
// DP (no `RegExp`). The full matcher unit + behavior-differential + linear-budget
// guards live in tests/wildcard-match.test.ts; these are the DQL-sink-level smokes.
describe("compileLike ReDoS-safe matching (rc.71 — DQL sink)", () => {
  it("preserves SQL-LIKE semantics (POSITIVE/NEGATIVE controls)", () => {
    expect(compileLike("****").test("anything at all")).toBe(true);
    expect(compileLike("****").test("")).toBe(true);
    expect(compileLike("*foo*").test("xxfooyy")).toBe(true);
    expect(compileLike("*foo*").test("bar")).toBe(false);
    expect(compileLike("a**b").test("aXYZb")).toBe(true);
    expect(compileLike("a**b").test("ab")).toBe(true); // `*` matches empty
    expect(compileLike("a**b").test("aXc")).toBe(false);
    // an ESCAPED \* stays a LITERAL asterisk, not a wildcard
    expect(compileLike("a\\*\\*b").test("a**b")).toBe(true);
    expect(compileLike("a\\*\\*b").test("aXYb")).toBe(false);
  });

  it("is linear on the literal-separated shapes that hung V8 pre-rc.71", () => {
    // `*a`x40 -> pre-rc.71 `^.*a.*a...$`; against a long all-`a` non-matching subject this
    // backtracked for minutes. The DP matcher must finish well under a second.
    const subject = `${"a".repeat(3000)}b`; // non-matching (trailing b)
    const t0 = Date.now();
    for (const pat of [`${"*a".repeat(40)}`, `a${"*".repeat(60)}b`, `${"*x".repeat(30)}y`]) {
      const m = compileLike(pat);
      for (let r = 0; r < 5; r++) m.test(subject);
    }
    expect(Date.now() - t0, "literal-separated LIKE must not hang").toBeLessThan(500);
  });
});

describe("parseDql query length cap (rc.57 DQL-PARSE-QUADRATIC-DOS)", () => {
  it("rejects an over-length query fail-closed, in O(1) — the DoS-closure proof", () => {
    // Pre-rc.57 a long query fed the O(n²) clause tokenizer on the main event loop.
    // A 2 MB pathological string (all whitespace → keyword-scan at every position) must be
    // rejected by the length cap WITHOUT ever entering the tokenizer — i.e. near-instant.
    const huge = " ".repeat(2_000_000);
    const start = process.hrtime.bigint();
    expect(() => parseDql(huge)).toThrow(/too long/i);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms, `over-length reject must be O(1), took ${ms.toFixed(1)}ms`).toBeLessThan(50);
  });

  it("a maximally-pathological query AT the cap still parses in well under a budget (linear tokenizer)", () => {
    // All single-char whitespace-separated tokens forces the per-boundary keyword scan at
    // every position — the worst case for the (now linearized) splitClauses. At the 4096 cap
    // this must be fast; pre-linearization it was O(n²) per boundary (slice+upcase whole tail).
    const atCap = `LIST WHERE ${"a ".repeat((MAX_DQL_QUERY_LEN - 11) / 2)}`.slice(0, MAX_DQL_QUERY_LEN);
    const start = process.hrtime.bigint();
    // It may parse or throw a normal DqlParseError (malformed predicate) — must NOT be "too long"
    // and must NOT hang.
    try {
      parseDql(atCap);
    } catch (e) {
      expect(e).toBeInstanceOf(DqlParseError);
      expect((e as Error).message).not.toMatch(/too long/i);
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms, `at-cap pathological parse must be fast, took ${ms.toFixed(1)}ms`).toBeLessThan(250);
  });

  it("a valid query just under the cap parses normally (NEGATIVE control — not over-capping)", () => {
    const folder = "a".repeat(MAX_DQL_QUERY_LEN - 20); // well-formed LIST FROM "<folder>", < cap
    const q = parseDql(`LIST FROM "${folder}"`);
    expect(q.kind).toBe("LIST");
    expect(q.source).toBeDefined();
  });
});
