// v3.2.0 — Obsidian Bases (.base) support. Tests the YAML parser, the
// listBases / readBase / queryBase pipeline, and the filter DSL subset
// against synthetic vaults. No live Obsidian needed.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundedSetAdd, listBases, MAX_WARNED_PREDICATES, parseBase, queryBase, readBase } from "../src/bases.js";
import { Vault } from "../src/vault.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bases-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("parseBase — YAML schema", () => {
  it("accepts the canonical example from Obsidian docs", async () => {
    const src = `
filters:
  or:
    - taggedWith(file.file, "tag")
    - and:
        - taggedWith(file.file, "book")
        - linksTo(file.file, "Textbook")
formulas:
  formatted_price: 'concat(price, " dollars")'
  ppu: "price / age"
properties:
  status:
    displayName: Status
views:
  - type: table
    name: "My table"
    filters:
      and:
        - 'status != "done"'
  - type: map
    name: "Example map"
    filters: "has_coords == true"
    lat: lat
    long: long
`;
    const parsed = await parseBase(src);
    expect(parsed.filters).toBeDefined();
    expect(parsed.formulas?.formatted_price).toBe('concat(price, " dollars")');
    expect(parsed.properties?.status?.displayName).toBe("Status");
    expect(parsed.views).toHaveLength(2);
    expect(parsed.views?.[0]?.type).toBe("table");
    expect(parsed.views?.[1]?.type).toBe("map");
  });

  it("accepts a minimal base (just one view, no filters)", async () => {
    const src = `
views:
  - type: table
    name: "All notes"
`;
    const parsed = await parseBase(src);
    expect(parsed.views).toHaveLength(1);
    expect(parsed.filters).toBeUndefined();
  });

  it("accepts an empty base (no fields at all)", async () => {
    const parsed = await parseBase("");
    expect(parsed.views ?? []).toEqual([]);
  });

  it("recursively validates and/or/not combinators", async () => {
    const src = `
filters:
  and:
    - 'status == "open"'
    - or:
        - 'priority == "high"'
        - not: 'tag == "ignored"'
`;
    const parsed = await parseBase(src);
    expect(parsed.filters).toBeDefined();
  });
});

async function makeBaseVault(): Promise<{ root: string; vault: Vault }> {
  const root = await fs.mkdtemp(path.join(dir, "vault-"));
  await fs.writeFile(path.join(root, "open.md"), "---\nstatus: open\npriority: high\ntags: [book]\n---\nopen book");
  await fs.writeFile(path.join(root, "done.md"), "---\nstatus: done\npriority: low\ntags: [book]\n---\nfinished book");
  await fs.writeFile(path.join(root, "untagged.md"), "---\nstatus: open\n---\nno tags here");
  await fs.mkdir(path.join(root, "Notes"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Notes", "inline.md"),
    "## Heading\n\nSome content with #inline tags here.\n#book\n"
  );
  const vault = new Vault(root);
  await vault.ensureExists();
  return { root, vault };
}

describe("listBases", () => {
  it("returns empty when vault has no .base files", async () => {
    const { vault } = await makeBaseVault();
    const out = await listBases(vault, {});
    expect(out).toEqual([]);
  });

  it("returns base file metadata + view names", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "books.base"),
      `views:
  - type: table
    name: "All books"
    filters: 'taggedWith(file.file, "book")'
`
    );
    const out = await listBases(vault, {});
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("books");
    expect(out[0]?.view_count).toBe(1);
    expect(out[0]?.view_names).toEqual(["All books"]);
    expect(out[0]?.size_bytes).toBeGreaterThan(0);
  });

  it("survives malformed .base files (size=0 counts, no crash)", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(path.join(root, "broken.base"), "this is\n  not: valid\n yaml: [");
    const out = await listBases(vault, {});
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("broken");
    expect(out[0]?.view_count).toBe(0);
    expect(out[0]?.view_names).toEqual([]);
  });

  it("returns the NEWEST `limit` bases, not a walk-order subset (rc.76 truncate-before-sort)", async () => {
    // v3.10.0-rc.76 (full-audit MEDIUM, sibling of the media.ts list bug): pre-fix the loop
    // truncated to `limit` in walk order then sorted the cut subset → not-newest result on a vault
    // with > limit .base files. Revert-verified.
    const { root, vault } = await makeBaseVault();
    const names = ["b0", "b1", "b2", "b3", "b4"];
    for (let i = 0; i < names.length; i++) {
      const p = path.join(root, `${names[i]}.base`);
      await fs.writeFile(p, "views:\n  - type: table\n");
      const t = new Date(Date.UTC(2026, 0, 1 + i)); // b0 oldest … b4 newest
      await fs.utimes(p, t, t);
    }
    const out = await listBases(vault, { limit: 2 });
    expect(out.map((b) => b.name)).toEqual(["b4", "b3"]);
  });
});

describe("readBase", () => {
  it("returns parsed structure with normalized view names", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "tasks.base"),
      `filters: 'status != "done"'
views:
  - type: table
    name: "Open tasks"
    filters: 'priority == "high"'
  - type: cards
`
    );
    const out = await readBase(vault, { path: "tasks.base" });
    expect(out.path).toBe("tasks.base");
    expect(out.name).toBe("tasks");
    expect(out.filters).toBe('status != "done"');
    expect(out.views).toHaveLength(2);
    expect(out.views[0]?.name).toBe("Open tasks");
    expect(out.views[1]?.name).toBeNull(); // unnamed view
  });

  it("rejects path outside the vault (privacy boundary)", async () => {
    const { vault } = await makeBaseVault();
    await expect(readBase(vault, { path: "../etc/passwd" })).rejects.toThrow();
  });

  // v3.7.12 H2 — path normalization parity with readCanvas/readPdf.
  describe("v3.7.12 H2 path normalization", () => {
    it("auto-appends .base extension when missing", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(path.join(root, "books.base"), "filters: 'tag == \"x\"'\nviews:\n  - type: table\n");
      // Caller passes "books" without extension — should resolve to "books.base".
      const out = await readBase(vault, { path: "books" });
      expect(out.path).toBe("books.base"); // canonical form returned
      expect(out.name).toBe("books");
    });

    it("auto-appends .base on subfolder-qualified path", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.mkdir(path.join(root, "Bases"), { recursive: true });
      await fs.writeFile(path.join(root, "Bases", "tasks.base"), "views:\n  - type: table\n");
      // Caller passes "Bases/tasks" without extension — should resolve.
      const out = await readBase(vault, { path: "Bases/tasks" });
      expect(out.path).toBe("Bases/tasks.base");
      expect(out.name).toBe("tasks");
    });

    it("rejects non-.base extensions (no accidental .md reads)", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(path.join(root, "note.md"), "# hi\n");
      await expect(readBase(vault, { path: "note.md" })).rejects.toThrow(/only accepts \.base/i);
    });

    it("rejects empty path", async () => {
      const { vault } = await makeBaseVault();
      await expect(readBase(vault, { path: "" })).rejects.toThrow(/path is required/i);
    });

    // ── Negative-control: removing the path normalization breaks the test
    //    above (it would either succeed on "note.md" by reading the markdown
    //    file as YAML, or fail with a confusing parse error instead of the
    //    explicit "only accepts .base" message). The "auto-append" test is
    //    the positive control; this one ensures the round-trip invariant
    //    queryBase relies on actually holds.
    it("queryBase round-trips the canonical base_path returned by readBase", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "round.base"),
        `filters: 'tag == "book"'
views:
  - type: table
`
      );
      // Caller passes "round" without extension.
      const queried = await queryBase(vault, { path: "round" });
      // Returned base_path should be the canonical "round.base" form, NOT
      // the user's input "round". This is what lets agents re-issue the
      // same base_path back into obsidian_read_base without re-normalizing.
      expect(queried.base_path).toBe("round.base");
      // And feeding it back works.
      const refetched = await readBase(vault, { path: queried.base_path });
      expect(refetched.name).toBe("round");
    });
  });
});

describe("queryBase — DSL execution", () => {
  it('filters by tag equality (`tag == "book"`)', async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'tag == "book"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    // open.md + done.md (frontmatter tag) AND Notes/inline.md (inline #book)
    expect(out.matches.map((m) => m.path).sort()).toEqual(["Notes/inline.md", "done.md", "open.md"]);
    expect(out.unevaluated_predicates).toEqual([]);
  });

  it("filters by taggedWith(file.file, ...)", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'taggedWith(file.file, "book")'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches.map((m) => m.path).sort()).toContain("open.md");
    expect(out.matches.map((m) => m.path).sort()).toContain("done.md");
  });

  it("filters by frontmatter equality", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'status == "open"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    const paths = out.matches.map((m) => m.path).sort();
    expect(paths).toContain("open.md");
    expect(paths).toContain("untagged.md");
    expect(paths).not.toContain("done.md");
  });

  it("filters via and-of-clauses", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  and:
    - 'status == "open"'
    - 'priority == "high"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.path).toBe("open.md");
  });

  it("filters via or-of-clauses", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  or:
    - 'priority == "high"'
    - 'priority == "low"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    const paths = out.matches.map((m) => m.path).sort();
    expect(paths).toEqual(["done.md", "open.md"]);
  });

  it("filters via not", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  not: 'status == "done"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    const paths = out.matches.map((m) => m.path).sort();
    expect(paths).toContain("open.md");
    expect(paths).toContain("untagged.md");
    expect(paths).not.toContain("done.md");
  });

  // v3.10.0-rc.38 (audit #5) — `not:` must NOT invert the v3.6.2 HN-2 fail-closed
  // semantics. An UNEVALUATED child (unknown/typo/unparseable, incl. `inDate(...)`)
  // fail-closes to `false` = "exclude"; pre-rc.38 `not` negated that to `true` and
  // returned EVERY row — the exact over-inclusion HN-2 prevents, via negation.
  // (The "filters via not" test above is the positive control: a KNOWN predicate
  // under `not` still negates normally.)
  it("v3.10.0-rc.38 (#5): `not:` over an unevaluated `inDate(...)` fail-closes (excludes all)", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  not: 'inDate("2026-01-01")'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches).toHaveLength(0); // fail-closed: not(unevaluable) → exclude, NOT include-all
    expect(out.unevaluated_predicates).toContain('inDate("2026-01-01")');
  });

  it("v3.10.0-rc.38 (#5): `not:` over a typo'd predicate also fail-closes", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  not: 'taggedWWith(file.file, "book")'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches).toHaveLength(0);
    expect(out.unevaluated_predicates).toContain('taggedWWith(file.file, "book")');
  });

  it("filters via path predicates", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'path startsWith "Notes/"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.path).toBe("Notes/inline.md");
  });

  it("resolves an accented path across NFC/NFD forms — path/file.path startsWith+contains (rc.73 round-3 re-sweep)", async () => {
    // v3.10.0-rc.73 (post-rc.70 re-sweep, NFC sibling of rc.69): the on-disk folder is NFD (as
    // macOS APFS returns it); the user types the NFC literal in the `.base` filter. Pre-rc.73,
    // ctx.path was raw NFD and the literal raw NFC, so `path startsWith "Café/"` returned ZERO
    // matches. The `file.name ==` twin was folded in rc.46/rc.69; this path/file.path branch was
    // the missed sibling. Both operands now NFC-normalize (NFC-only — path is case-sensitive).
    const nfd = `Cafe${String.fromCodePoint(0x301)}`; // e + combining acute (NFD on disk)
    const nfc = `Caf${String.fromCodePoint(0xe9)}`; // precomposed é (NFC literal)
    expect(nfc).not.toBe(nfd); // raw forms differ — the test is non-vacuous
    const vroot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bases-nfc-"));
    try {
      await fs.mkdir(path.join(vroot, nfd), { recursive: true });
      await fs.writeFile(path.join(vroot, nfd, "note.md"), "---\ntag: x\n---\nbody\n");
      const v = new Vault(vroot);
      const run = async (filter: string): Promise<number> => {
        await fs.writeFile(path.join(vroot, "q.base"), `filters: '${filter}'\nviews:\n  - type: table\n`);
        return (await queryBase(v, { path: "q.base" })).matches.length;
      };
      expect(await run(`path startsWith "${nfc}/"`), "NFC literal must resolve the NFD-on-disk path").toBe(1);
      expect(await run(`file.path startsWith "${nfc}/"`)).toBe(1);
      expect(await run(`file.path contains "${nfc}"`)).toBe(1);
      // NEGATIVE control: a non-matching accented prefix returns nothing.
      expect(await run(`path startsWith "Other${String.fromCodePoint(0xe9)}/"`)).toBe(0);
    } finally {
      await fs.rm(vroot, { recursive: true, force: true });
    }
  });

  it("resolves an accented TAG + frontmatter VALUE across NFC/NFD forms (v3.11.0-rc.9, L-TAG-1 + value sibling)", async () => {
    // v3.11.0-rc.9 (external re-audit): `.base` `tag ==`/`taggedWith` were NFC-blind
    // (foldTag now), and `<key> ==`/`contains` frontmatter-value compares were NFC-blind
    // too (nfc now — case PRESERVED, mirroring Bases' case-sensitive semantics + the
    // rc.73 path fix). An NFD-stored accented tag/value must resolve an NFC `.base` literal.
    const nfd = `Cafe${String.fromCodePoint(0x301)}`; // NFD on disk
    const nfc = `Caf${String.fromCodePoint(0xe9)}`; // NFC in the .base filter
    expect(nfc).not.toBe(nfd);
    const vroot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bases-tagnfc-"));
    try {
      await fs.writeFile(path.join(vroot, "note.md"), `---\ntags: [${nfd}]\nstatus: ${nfd}\n---\nbody\n`);
      const v = new Vault(vroot);
      const run = async (filter: string): Promise<number> => {
        await fs.writeFile(path.join(vroot, "q.base"), `filters: '${filter}'\nviews:\n  - type: table\n`);
        return (await queryBase(v, { path: "q.base" })).matches.length;
      };
      expect(await run(`tag == "${nfc}"`), "NFC tag literal resolves NFD-stored tag").toBe(1);
      expect(await run(`taggedWith(file.file, "${nfc}")`), "taggedWith NFC resolves NFD tag").toBe(1);
      expect(await run(`status == "${nfc}"`), "NFC value literal resolves NFD-stored frontmatter value").toBe(1);
      expect(await run(`status contains "${nfc}"`), "NFC contains resolves NFD-stored value").toBe(1);
      // NEGATIVE control: a non-matching accented literal returns nothing.
      expect(await run(`status == "Other${String.fromCodePoint(0xe9)}"`)).toBe(0);
    } finally {
      await fs.rm(vroot, { recursive: true, force: true });
    }
  });

  it("merges global filter AND view filter when view is specified", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'tag == "book"'
views:
  - type: table
    name: "Open books"
    filters: 'status == "open"'
  - type: table
    name: "All books"
`
    );
    const openBooks = await queryBase(vault, { path: "q.base", view: "Open books" });
    expect(openBooks.matches).toHaveLength(1);
    expect(openBooks.matches[0]?.path).toBe("open.md");
    expect(openBooks.view).toBe("Open books");

    const allBooks = await queryBase(vault, { path: "q.base", view: "All books" });
    // open.md + done.md (frontmatter) + Notes/inline.md (inline #book)
    expect(allBooks.matches).toHaveLength(3);
    expect(allBooks.view).toBe("All books");
  });

  // v3.5.0 — linksTo() is now evaluated (no longer in unevaluated_predicates).
  // We keep this test to lock in the closed deferral.
  it("v3.5.0 evaluates linksTo() (no longer unevaluated)", async () => {
    const { root, vault } = await makeBaseVault();
    // Add a note that explicitly links to Textbook + a Textbook target.
    await fs.writeFile(
      path.join(root, "links-textbook.md"),
      "---\nstatus: open\ntags: [book]\n---\nsee [[Textbook]] for details\n"
    );
    await fs.writeFile(path.join(root, "Textbook.md"), "the textbook\n");
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  and:
    - 'tag == "book"'
    - 'linksTo(file.file, "Textbook")'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.unevaluated_predicates).toEqual([]); // linksTo is now evaluated
    const paths = out.matches.map((m) => m.path);
    expect(paths).toContain("links-textbook.md");
    // open.md has tag=book but does NOT link to Textbook → excluded.
    expect(paths).not.toContain("open.md");
  });

  it("collects inline #tags from body for taggedWith() matching", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'taggedWith(file.file, "inline")'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches.map((m) => m.path)).toEqual(["Notes/inline.md"]);
  });

  it("throws on unknown view name", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `views:
  - type: table
    name: "Real view"
`
    );
    await expect(queryBase(vault, { path: "q.base", view: "Ghost view" })).rejects.toThrow(/view not found/);
  });

  it("respects limit", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base", limit: 2 });
    expect(out.matches.length).toBeLessThanOrEqual(2);
  });

  // v3.5.0 — newly-supported predicates. Lock in closed deferrals.
  describe("v3.5.0 — linksTo + file.path/file.name", () => {
    it("linksTo is case-insensitive and strips .md / sections / blocks", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "linker.md"),
        "links to [[TEXTBOOK#chapter-1]] and [[textbook.md|alias]] and [[textbook^block]]\n"
      );
      await fs.writeFile(path.join(root, "Textbook.md"), "the book");
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'linksTo(file.file, "Textbook")'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      expect(out.matches.map((m) => m.path)).toContain("linker.md");
    });

    it("linksTo returns false when no outbound link to target", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'linksTo(file.file, "NonExistentTarget")'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      expect(out.matches).toHaveLength(0);
    });

    it("file.path startsWith is an alias for path startsWith", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'file.path startsWith "Notes/"'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      expect(out.matches.map((m) => m.path)).toEqual(["Notes/inline.md"]);
    });

    it("file.path contains is an alias for path contains", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'file.path contains "inline"'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      expect(out.matches.map((m) => m.path)).toEqual(["Notes/inline.md"]);
    });

    it("file.name == matches basename case-insensitively (no .md)", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'file.name == "Inline"'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      expect(out.matches.map((m) => m.path)).toEqual(["Notes/inline.md"]);
    });

    it("file.name != excludes the basename", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'file.name != "open"'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      const paths = out.matches.map((m) => m.path);
      expect(paths).not.toContain("open.md");
      expect(paths).toContain("done.md");
    });
  });

  // v3.6 — branches coverage uplift. Hit predicate branches the existing
  // tests don't exercise: `tag != "x"`, boolean literals, contains on an
  // array-valued frontmatter, and the SKIP / unevaluated paths.
  describe("v3.6 — extra predicate branches", () => {
    it('`tag != "book"` returns notes without the tag', async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'tag != "book"'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      const paths = out.matches.map((m) => m.path).sort();
      // untagged.md has no tags; the rest are #book.
      expect(paths).toContain("untagged.md");
      expect(paths).not.toContain("open.md");
      expect(paths).not.toContain("done.md");
    });

    it("boolean literal `true` matches every note; `false` matches nothing", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "true.base"),
        `filters: 'true'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "true.base" });
      expect(out.matches.length).toBeGreaterThan(0);

      await fs.writeFile(
        path.join(root, "false.base"),
        `filters: 'false'
views:
  - type: table
`
      );
      const empty = await queryBase(vault, { path: "false.base" });
      expect(empty.matches).toHaveLength(0);
    });

    it("`<key> contains` matches arrays element-wise (frontmatter tags array)", async () => {
      const { root, vault } = await makeBaseVault();
      // The default makeBaseVault notes have `tags: [book]` as an array
      // frontmatter, so `tags contains "boo"` exercises the
      // Array.isArray(v) branch of fmContains.
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'tags contains "boo"'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      const paths = out.matches.map((m) => m.path).sort();
      expect(paths).toContain("open.md");
      expect(paths).toContain("done.md");
      // untagged.md has no tags array → contains returns false.
      expect(paths).not.toContain("untagged.md");
    });

    it("`<key> contains` returns false on missing key (no array, no string)", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'notakey contains "anything"'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      expect(out.matches).toHaveLength(0);
      // The expr is parsed by the `contains` regex, so it's NOT
      // unevaluated — just always false.
      expect(out.unevaluated_predicates).toEqual([]);
    });

    it("v3.6.2 HN-2 — unparseable RHS literal excludes row + listed as unevaluated (strict mode)", async () => {
      const { root, vault } = await makeBaseVault();
      // `status == bare-identifier` doesn't match `parseLiteral` (no quotes,
      // not a number, not a bool/null) so it returns SKIP. v3.6.2 HN-2:
      // strict mode → row is excluded (was: permissive `true`).
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'status == something-unquoted'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      // v3.6.2: strict mode → no matches (was: all notes matched).
      expect(out.matches).toHaveLength(0);
      expect(out.unevaluated_predicates).toContain("status == something-unquoted");
    });

    it("v3.6.2 HN-2 — syntactically unknown predicate excludes row + listed as unevaluated (strict mode)", async () => {
      const { root, vault } = await makeBaseVault();
      // `customFunc(...)` doesn't match any predicate regex — falls to the
      // ctx.unevaluated.add(expr) branch at the end of evalPredicate.
      // v3.6.2: strict mode → row excluded (was: permissive `true`).
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'customFunc("x")'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base" });
      expect(out.matches).toHaveLength(0);
      expect(out.unevaluated_predicates).toContain('customFunc("x")');
    });
  });

  // v3.6.2 HN-1 — `total_matched` reports the full count, not the slice.
  describe("v3.6.2 — total_matched + truncated reflect full vault scan", () => {
    it("reports total_matched as the full match count even when limit truncates", async () => {
      const { root, vault } = await makeBaseVault();
      // 4 notes in the vault (open.md, done.md, untagged.md, Notes/inline.md);
      // a permissive `true` filter matches every one.
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'true'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base", limit: 2 });
      // Pre-3.6.2: total_matched would have been 2 (post-cap). Now it's 4.
      expect(out.total_matched).toBe(4);
      expect(out.matches).toHaveLength(2);
      expect(out.truncated).toBe(true);
    });

    it("truncated is false when limit doesn't actually cap the results", async () => {
      const { root, vault } = await makeBaseVault();
      await fs.writeFile(
        path.join(root, "q.base"),
        `filters: 'true'
views:
  - type: table
`
      );
      const out = await queryBase(vault, { path: "q.base", limit: 100 });
      expect(out.total_matched).toBe(4);
      expect(out.matches).toHaveLength(4);
      expect(out.truncated).toBe(false);
    });
  });
});

describe("boundedSetAdd — warn-once dedup cap (v3.9.0-rc.15)", () => {
  it("adds a new value under the cap and reports true (POSITIVE)", () => {
    const s = new Set<string>();
    expect(boundedSetAdd(s, "a", 3)).toBe(true);
    expect(boundedSetAdd(s, "b", 3)).toBe(true);
    expect(s.size).toBe(2);
  });
  it("returns false for a duplicate without growing the set", () => {
    const s = new Set<string>(["a"]);
    expect(boundedSetAdd(s, "a", 3)).toBe(false);
    expect(s.size).toBe(1);
  });
  it("refuses to grow past the cap and reports false (NEGATIVE control)", () => {
    const s = new Set<string>(["a", "b", "c"]);
    expect(boundedSetAdd(s, "d", 3)).toBe(false);
    expect(s.size).toBe(3); // unbounded growth prevented
  });
  it("MAX_WARNED_PREDICATES is a sane positive cap", () => {
    expect(MAX_WARNED_PREDICATES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_WARNED_PREDICATES)).toBe(true);
  });
});
