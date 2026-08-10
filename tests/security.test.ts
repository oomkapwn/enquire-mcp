import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultIndexFile, FtsIndex } from "../src/fts5.js";
import {
  appendToNote,
  archiveNote,
  createNote,
  listNotes,
  readLiveFtsChunk,
  readNote,
  renameNote,
  replaceInNotes,
  searchHybrid,
  searchLiveFts,
  validateNoteProposal
} from "../src/tools/index.js";
// v3.10.0-rc.22 (audit M8) — the REAL embed-hit privacy filter (was reimplemented
// inline below; now exercised so search.ts's embeddingsSearch filter is covered).
import { filterExcludedEmbedHits, filterLiveVaultHits } from "../src/tools/search.js";
import { compileGlob, MAX_GLOB_PATTERN_LEN, Vault } from "../src/vault.js";
import { restrictedVaultPathReason } from "../src/vault-path-policy.js";

let root: string;
let outsideDir: string;
// v3.9.0-rc.23 (full-audit batch 3) — capture whether symlink creation worked
// so the symlink-escape privacy tests can `ctx.skip()` VISIBLY (not silently
// `return` with zero assertions) when symlinks aren't supported, and a CI-GUARD
// can hard-fail if the precondition vanishes in CI (same fix as rc.8's T1).
let canSymlink = false;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-sec-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-outside-"));
  await fs.writeFile(path.join(root, "Inside.md"), "Safe content.\n");
  await fs.writeFile(path.join(outsideDir, "Secret.md"), "Sensitive content outside the vault.\n");
  // Create a symlink inside the vault pointing outside.
  try {
    await fs.symlink(path.join(outsideDir, "Secret.md"), path.join(root, "Secret-link.md"));
    await fs.symlink(outsideDir, path.join(root, "outside-dir-link"));
    canSymlink = true;
  } catch {
    // On Windows without dev mode, symlinks may fail — tests that depend on this skip.
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

describe("Vault — symlink safety", () => {
  // v3.9.0-rc.23 — CI-GUARD: in CI, symlink creation MUST work so the
  // symlink-escape privacy assertions below actually run. Fail loud if it
  // doesn't (rather than every dependent test silently ctx.skip-ing — that's
  // how a privacy-boundary regression could hide). No-op outside CI.
  it("CI GUARD — symlink creation works so privacy-escape tests actually run", () => {
    if (!process.env.CI) return;
    expect(canSymlink, "symlinks must be creatable in CI so the symlink-escape privacy tests execute").toBe(true);
  });

  it("does not list files reached via symlinks", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const notes = await listNotes(v, {});
    expect(notes.map((n) => n.title)).toEqual(["Inside"]);
    expect(notes.find((n) => n.title === "Secret")).toBeUndefined();
  });

  it("rejects reads of symlinked files that resolve outside vault", async (ctx) => {
    const v = new Vault(root);
    await v.ensureExists();
    const linkExists = await fs.lstat(path.join(root, "Secret-link.md")).catch(() => null);
    if (!linkExists) return ctx.skip();
    await expect(readNote(v, { path: "Secret-link.md" })).rejects.toThrow(/escapes vault root/);
  });

  it("rejects ../ traversal in resolveInside", async () => {
    const v = new Vault(root);
    expect(() => v.resolveInside("../../etc/passwd")).toThrow(/escapes vault root/);
  });
});

describe("Vault — error-message privacy (rc.45 abs-path-leak class)", () => {
  // RCA of the audit's M3 + sibling sinks: a raw fs error embeds the ABSOLUTE host path
  // (vault root = home/tmp), which reaches MCP clients via read_note / chat_thread_read /
  // rename / media. Vault.stat/readFile/readBinaryFile now sanitize: strip the root from
  // the message + .path while PRESERVING err.code and the ENOENT-shaped text callers
  // regex-match. POSITIVE + NEGATIVE controls per the rule since v3.6.4.
  it("stat/readFile/readBinaryFile on a missing note throw a vault-RELATIVE error, never the host path (NEGATIVE)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    for (const m of ["stat", "readFile", "readBinaryFile"] as const) {
      const err = (await (v[m]("Nope.md") as Promise<unknown>).then(
        () => null,
        (e) => e
      )) as NodeJS.ErrnoException | null;
      expect(err, `${m} should reject on a missing file`).not.toBeNull();
      expect(err?.message, `${m} message must not leak the absolute vault root`).not.toContain(root);
      expect(err?.code, `${m} must preserve err.code for callers that branch on ENOENT`).toBe("ENOENT");
      expect(err?.message, `${m} keeps the vault-relative filename`).toContain("Nope.md");
    }
  });

  it("readFile still returns content for a present file (POSITIVE — sanitization only fires on error)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    expect(await v.readFile("Inside.md")).toContain("Safe content");
  });

  // v3.10.0-rc.49 — re-audit CODE-1: readNote (the primary list-then-read funnel)
  // was missed by rc.45 and leaked the host abs path on a TOCTOU miss.
  it("readNote on a missing note throws a vault-RELATIVE error (rc.49 CODE-1)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const err = (await v.readNote("Ghost.md").then(
      () => null,
      (e) => e
    )) as NodeJS.ErrnoException | null;
    expect(err, "readNote should reject on a missing file").not.toBeNull();
    expect(err?.message, "readNote message must not leak the absolute vault root").not.toContain(root);
    expect(err?.code).toBe("ENOENT");
  });

  // v3.10.0-rc.49 — re-audit HIGH RC45-WRITEPATH-LEAK: rc.45 sanitized the READ
  // path but the WRITE path (writeNote/renameFile/appendNote) still threw raw fs
  // errors embedding the host abs path to any serve-http write-tool client.
  it("write-path fs errors are vault-RELATIVE, never the host path (rc.49 HIGH RC45-WRITEPATH-LEAK)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // A regular file used as a parent dir → ENOTDIR (mkdir/open under it fail raw).
    await fs.writeFile(path.join(root, "clash.md"), "x");
    const collect = async (fn: () => Promise<unknown>): Promise<NodeJS.ErrnoException | null> =>
      (await fn().then(
        () => null,
        (e) => e
      )) as NodeJS.ErrnoException | null;

    const wErr = await collect(() => v.writeNote("clash.md/child.md", "body", { overwrite: true }));
    expect(wErr, "writeNote should reject when the parent path is a file").not.toBeNull();
    expect(wErr?.message, "writeNote must not leak the absolute vault root").not.toContain(root);

    const aErr = await collect(() => v.appendNote("clash.md/child.md", "more"));
    expect(aErr, "appendNote should reject when the parent path is a file").not.toBeNull();
    expect(aErr?.message, "appendNote must not leak the absolute vault root").not.toContain(root);

    const rErr = await collect(() => v.renameFile("Ghost.md", "Dest.md"));
    expect(rErr, "renameFile should reject on a missing source").not.toBeNull();
    expect(rErr?.message, "renameFile must not leak the absolute vault root").not.toContain(root);

    await fs.unlink(path.join(root, "clash.md")).catch(() => {});
  });
});

describe("Vault — file size limit", () => {
  it("refuses to read files larger than maxFileBytes", async () => {
    const v = new Vault(root, { maxFileBytes: 50 });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Big.md"), "x".repeat(200));
    await expect(readNote(v, { path: "Big.md" })).rejects.toThrow(/File too large/);
    await fs.unlink(path.join(root, "Big.md"));
  });
});

describe("Vault — cache cap & LRU", () => {
  it("evicts oldest entries when over maxCacheEntries", async () => {
    const v = new Vault(root, { maxCacheEntries: 2 });
    await v.ensureExists();
    for (let i = 0; i < 4; i++) {
      const p = path.join(root, `Note${i}.md`);
      await fs.writeFile(p, `Note ${i}\n`);
      await v.readNote(p);
    }
    const notes = await listNotes(v, {});
    expect(notes.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < 4; i++) {
      await fs.unlink(path.join(root, `Note${i}.md`)).catch(() => {});
    }
  });

  it("LRU bumps a re-read entry so it survives eviction", async () => {
    const v = new Vault(root, { maxCacheEntries: 2 });
    await v.ensureExists();
    const a = path.join(root, "LRU-A.md");
    const b = path.join(root, "LRU-B.md");
    const c = path.join(root, "LRU-C.md");
    await fs.writeFile(a, "A");
    await fs.writeFile(b, "B");
    await fs.writeFile(c, "C");
    await v.readNote(a); // cache: {A}
    await v.readNote(b); // cache: {A, B}
    await v.readNote(a); // LRU bump → cache: {B, A}
    await v.readNote(c); // evict head (B): cache: {A, C}

    const cache = (v as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBeLessThanOrEqual(2);
    const cached = [...cache.keys()].map((k) => path.basename(k));
    expect(cached).toContain("LRU-A.md"); // re-read entry survived
    expect(cached).toContain("LRU-C.md"); // newest entry survived
    expect(cached).not.toContain("LRU-B.md"); // untouched middle entry evicted

    await Promise.all([a, b, c].map((p) => fs.unlink(p).catch(() => {})));
  });
});

describe("Vault — internal symlinks", () => {
  it("skips symlinks even when they point inside the vault", async (ctx) => {
    const v = new Vault(root);
    await v.ensureExists();
    const target = path.join(root, "Target-internal.md");
    const link = path.join(root, "Link-internal.md");
    await fs.writeFile(target, "internal target");
    await fs.symlink(target, link).catch(() => null);
    const linkExists = await fs.lstat(link).catch(() => null);
    if (!linkExists) return ctx.skip();
    const titles = (await listNotes(v, {})).map((n) => n.title);
    expect(titles).toContain("Target-internal");
    expect(titles).not.toContain("Link-internal");
    const hiddenDir = path.join(root, ".hidden-target");
    const visibleDirAlias = path.join(root, "Visible-alias");
    const hiddenFileAlias = path.join(root, ".hidden-alias.md");
    await fs.mkdir(hiddenDir, { recursive: true });
    await fs.writeFile(path.join(hiddenDir, "Secret.md"), "hidden physical target");
    await fs.symlink(hiddenDir, visibleDirAlias);
    await fs.symlink(target, hiddenFileAlias);
    await expect(v.readNote("Visible-alias/Secret.md")).rejects.toThrow(/hidden or reserved vault path/);
    await expect(v.stat("Visible-alias/Missing.md")).rejects.toThrow(/hidden or reserved vault path/);
    await expect(v.stat("Visible-missing.md")).rejects.toThrow(/ENOENT|no such file/i);
    await expect(v.readNote(".hidden-alias.md")).rejects.toThrow(/hidden or reserved vault path/);
    const writable = new Vault(root, { enableWrite: true });
    await writable.ensureExists();
    await expect(writable.writeNote("Visible-alias/New.md", "must not write")).rejects.toThrow(
      /hidden or reserved vault path/
    );
    await expect(writable.appendNote("Visible-alias/Secret.md", "\nmust not append")).rejects.toThrow(
      /hidden or reserved vault path/
    );
    const renameSource = path.join(root, "Visible-rename-source.md");
    await fs.writeFile(renameSource, "must remain visible");
    await expect(writable.renameFile("Visible-rename-source.md", "Visible-alias/Renamed.md")).rejects.toThrow(
      /hidden or reserved vault path/
    );
    await expect(
      validateNoteProposal(writable, { path: "Visible-alias/Proposed.md", content: "must not validate" })
    ).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ kind: "path-excluded" })])
    });
    expect(await fs.readFile(renameSource, "utf8")).toBe("must remain visible");
    expect(await fs.readFile(path.join(hiddenDir, "Secret.md"), "utf8")).toBe("hidden physical target");
    await expect(writable.writeNote("Visible-control.md", "admitted control")).resolves.toMatchObject({
      relPath: "Visible-control.md"
    });
    await fs.unlink(path.join(root, "Visible-control.md"));
    await fs.unlink(renameSource);
    await fs.unlink(visibleDirAlias).catch(() => {});
    await fs.unlink(hiddenFileAlias).catch(() => {});
    await fs.rm(hiddenDir, { recursive: true, force: true });
    await fs.unlink(link).catch(() => {});
    await fs.unlink(target).catch(() => {});
  });
});

describe("Vault — listMarkdown(folder) symlink-out (audit P2-1)", () => {
  it("returns empty when folder argument is a symlink to outside the vault", async (ctx) => {
    const v = new Vault(root);
    await v.ensureExists();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-fold-out-"));
    await fs.writeFile(path.join(outside, "Secret.md"), "should NOT be enumerated");
    try {
      await fs.symlink(outside, path.join(root, "linked-out"));
      const linkExists = await fs.lstat(path.join(root, "linked-out")).catch(() => null);
      if (!linkExists) return ctx.skip();
      const out = await listNotes(v, { folder: "linked-out" });
      expect(out).toEqual([]);
    } finally {
      await fs.unlink(path.join(root, "linked-out")).catch(() => {});
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("parseNote — malformed input", () => {
  it("falls back gracefully on broken YAML", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Broken.md"), "---\nthis is: : not: : valid: yaml\n---\n\nbody here\n");
    const out = await readNote(v, { path: "Broken.md" });
    expect(typeof out.content).toBe("string");
    expect(out.frontmatter).toEqual({});
    await fs.unlink(path.join(root, "Broken.md"));
  });

  it("handles Unicode titles and tags", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Заметка.md"), "---\ntags: [идея]\n---\n\n#русский тег.\n");
    const out = await readNote(v, { title: "Заметка" });
    expect(out.title).toBe("Заметка");
    expect(out.tags).toContain("идея");
    await fs.unlink(path.join(root, "Заметка.md"));
  });
});

describe("compileGlob (v0.11 — privacy filter)", () => {
  it("`**` matches across path separators", () => {
    expect(compileGlob("Personal/**").test("Personal/Inbox/x.md")).toBe(true);
    expect(compileGlob("Personal/**").test("Other/Inbox/x.md")).toBe(false);
  });
  it("`*` matches within a single segment only", () => {
    expect(compileGlob("private/*.md").test("private/x.md")).toBe(true);
    expect(compileGlob("private/*.md").test("private/sub/x.md")).toBe(false);
  });
  it("`?` matches exactly one non-slash char", () => {
    expect(compileGlob("?_temp.md").test("x_temp.md")).toBe(true);
    expect(compileGlob("?_temp.md").test("xx_temp.md")).toBe(false);
    expect(compileGlob("?_temp.md").test("/_temp.md")).toBe(false);
  });
  it("treats regex specials in literal segments as literals (no regex compilation)", () => {
    expect(compileGlob("(parens)/x.md").test("(parens)/x.md")).toBe(true);
    expect(compileGlob("dot.path/x.md").test("dot.path/x.md")).toBe(true);
    expect(compileGlob("dot.path/x.md").test("dotXpath/x.md")).toBe(false);
  });

  // v3.10.0-rc.71 (post-rc.66 re-sweep, ReDoS class — closes the rc.68 globToRegex sibling).
  // rc.68 collapsed only ADJACENT unbounded quantifiers; a glob with wildcards SEPARATED BY
  // LITERALS (`*a*a*...` -> `^[^/]*a[^/]*a...$`, or `**a**a...`) was still catastrophic, and the
  // catastrophe scales with the matched PATH length (paths can be 100+ chars deep) so a wildcard
  // count cap is not structurally safe. compileGlob now matches via a NON-backtracking DP (no
  // RegExp). The full matcher unit + behavior-differential guards live in
  // tests/wildcard-match.test.ts; these are the privacy-filter-sink-level smokes.
  it("is linear on the literal-separated globstar/segstar shapes that hung V8 pre-rc.71", () => {
    // Pre-rc.71 `**a**a...` and `*a*a...` against a long non-matching path hung V8 for seconds.
    const subject = `${"a".repeat(2000)}/${"a".repeat(2000)}`; // non-matching for the trailing-X patterns
    const t0 = Date.now();
    for (const pat of [`${"**a".repeat(30)}X`, `${"*a".repeat(40)}X`, `${"**".repeat(20)}Z`]) {
      const m = compileGlob(pat);
      for (let r = 0; r < 5; r++) m.test(subject);
    }
    expect(
      Date.now() - t0,
      "literal-separated globs must not hang (generous ceiling — rc.24 widened from 500ms for parallel-CI-load immunity)"
    ).toBeLessThan(3000);
  });

  it("preserves globstar semantics (POSITIVE/NEGATIVE controls)", () => {
    expect(compileGlob("**").test("any/deep/path.md")).toBe(true);
    expect(compileGlob("a/**/b").test("a/b")).toBe(true); // globstar eats the slash
    expect(compileGlob("a/**/b").test("a/x/y/b")).toBe(true);
    expect(compileGlob("a/**/**/b").test("a/x/b")).toBe(true); // redundant globstars
    expect(compileGlob("Personal/**").test("Work/x.md")).toBe(false); // NEGATIVE
  });

  it("throws on an over-long glob (MAX_GLOB_PATTERN_LEN cap, NEGATIVE control)", () => {
    expect(() => compileGlob("a".repeat(MAX_GLOB_PATTERN_LEN))).not.toThrow();
    expect(() => compileGlob("a".repeat(MAX_GLOB_PATTERN_LEN + 1))).toThrow(/too long/i);
  });
});

describe("Vault — --exclude-glob privacy filter (v0.11 P1)", () => {
  let vroot: string;
  beforeEach(async () => {
    vroot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-exclude-"));
    await fs.mkdir(path.join(vroot, "Personal"), { recursive: true });
    await fs.mkdir(path.join(vroot, "Work"), { recursive: true });
    await fs.writeFile(path.join(vroot, "Personal", "diary.md"), "private");
    await fs.writeFile(path.join(vroot, "Work", "project.md"), "work");
    await fs.writeFile(path.join(vroot, "INDEX.md"), "index");
  });
  afterEach(async () => {
    await fs.rm(vroot, { recursive: true, force: true });
  });

  it("listNotes hides paths matching --exclude-glob", async () => {
    await fs.mkdir(path.join(vroot, ".private"), { recursive: true });
    await fs.mkdir(path.join(vroot, "Node_Modules"), { recursive: true });
    await fs.writeFile(path.join(vroot, ".secret.md"), "root hidden");
    await fs.writeFile(path.join(vroot, ".private", "nested.md"), "nested hidden");
    await fs.writeFile(path.join(vroot, "Node_Modules", "package.md"), "reserved hidden");
    const defaultV = new Vault(vroot);
    await defaultV.ensureExists();
    const defaultListed = (await defaultV.listMarkdown()).map((entry) => entry.relPath);
    expect(defaultListed).not.toContain(".secret.md");
    expect(defaultListed).not.toContain(".private/nested.md");
    expect(defaultListed).not.toContain("Node_Modules/package.md");
    expect(await defaultV.listMarkdown(".private")).toEqual([]);
    expect(await defaultV.listFilesByExtension(".md", "Node_Modules")).toEqual([]);
    await expect(defaultV.readFile(".secret.md")).rejects.toThrow(/hidden or reserved vault path/);

    const v = new Vault(vroot, { excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    const out = await listNotes(v, {});
    const paths = out.map((n) => n.path).sort();
    expect(paths).toEqual(["INDEX.md", "Work/project.md"]);
    expect(paths).not.toContain("Personal/diary.md");
  });

  it("readNote refuses to surface excluded content even by direct path", async () => {
    await fs.mkdir(path.join(vroot, ".private"), { recursive: true });
    await fs.mkdir(path.join(vroot, "Node_Modules"), { recursive: true });
    await fs.mkdir(path.join(vroot, "Project.v2"), { recursive: true });
    await fs.writeFile(path.join(vroot, ".secret.md"), "root hidden");
    await fs.writeFile(path.join(vroot, ".private", "nested.md"), "nested hidden");
    await fs.writeFile(path.join(vroot, "Node_Modules", "package.md"), "reserved hidden");
    await fs.writeFile(path.join(vroot, "Thumbs.db"), "system metadata");
    await fs.writeFile(path.join(vroot, "Project.v2", "note.v2.md"), "visible dotted names");
    const v = new Vault(vroot, { excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    await expect(readNote(v, { path: "Personal/diary.md" })).rejects.toThrow(/excluded by --exclude-glob/);
    for (const hidden of [".secret.md", ".private/nested.md", "Node_Modules/package.md"]) {
      await expect(readNote(v, { path: hidden })).rejects.toThrow(/excluded by hidden or reserved vault path/);
    }
    await expect(v.readFile(".secret.md")).rejects.toThrow(/hidden or reserved vault path/);
    await expect(v.readBinaryFile("Thumbs.db")).rejects.toThrow(/hidden or reserved vault path/);
    await expect(v.stat(".missing.md")).rejects.toThrow(/hidden or reserved vault path/);

    const listed = (await v.listMarkdown()).map((entry) => entry.relPath);
    expect(listed).not.toContain(".secret.md");
    expect(listed).not.toContain(".private/nested.md");
    expect(listed).not.toContain("Node_Modules/package.md");
    expect(listed).toContain("Project.v2/note.v2.md");
    await expect(readNote(v, { path: "Project.v2/note.v2.md" })).resolves.toMatchObject({
      path: "Project.v2/note.v2.md"
    });

    expect(restrictedVaultPathReason("Nested\\.Secrets\\note.md")).toBe("hidden or reserved vault path");
    expect(restrictedVaultPathReason("Nested/.Git./config")).toBe("hidden or reserved vault path");
    expect(restrictedVaultPathReason("nested/THUMBS.DB ")).toBe("hidden or reserved vault path");
    expect(restrictedVaultPathReason("Project.v2/my-node_modules-notes.md")).toBeNull();
    const longWindowsSuffix = `${".".repeat(4096)}${" ".repeat(4096)}`;
    expect(restrictedVaultPathReason(`nested/THUMBS.DB${longWindowsSuffix}`)).toBe("hidden or reserved vault path");
    expect(restrictedVaultPathReason(`nested/public${longWindowsSuffix}`)).toBeNull();
  });

  it("multiple exclude patterns AND'd correctly (any match → excluded)", async () => {
    const v = new Vault(vroot, { excludeGlobs: ["Personal/**", "INDEX.md"] });
    await v.ensureExists();
    const out = await listNotes(v, {});
    expect(out.map((n) => n.path)).toEqual(["Work/project.md"]);
  });

  it("listMarkdown(folder) of an excluded folder returns empty", async () => {
    const v = new Vault(vroot, { excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    const out = await listNotes(v, { folder: "Personal" });
    expect(out).toEqual([]);
  });

  // v2.0.0-beta.1 P0 fix: writeNote was bypassing isExcluded(), so
  // `obsidian_create_note` with `--read-paths "Public/**"` allowed creating
  // (and overwriting!) `Private/secret.md`. External audit reproduced this
  // as a privacy/contract violation — the SECURITY.md model claims allowlist
  // and denylist gate write paths.
  it("createNote refuses to write to a path excluded by --exclude-glob", async () => {
    const v = new Vault(vroot, { enableWrite: true, excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    await expect(createNote(v, { path: "Personal/leak.md", content: "leaked" })).rejects.toThrow(
      /excluded by --exclude-glob/
    );
  });

  it("createNote refuses to write to a path outside --read-paths allowlist", async () => {
    const v = new Vault(vroot, { enableWrite: true, readPaths: ["Public/**"] });
    await v.ensureExists();
    await expect(createNote(v, { path: "Private/leak.md", content: "leaked" })).rejects.toThrow(
      /excluded by --read-paths allowlist/
    );
  });

  it("createNote(overwrite=true) on an excluded existing path STILL refused (no clobber-bypass)", async () => {
    // Pre-fix: an attacker who knew the path could overwrite an excluded note.
    await fs.writeFile(path.join(vroot, "Personal", "diary.md"), "private");
    const v = new Vault(vroot, { enableWrite: true, excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    await expect(createNote(v, { path: "Personal/diary.md", content: "overwritten", overwrite: true })).rejects.toThrow(
      /excluded by --exclude-glob/
    );
    // Verify the original content still on disk.
    const after = await fs.readFile(path.join(vroot, "Personal", "diary.md"), "utf8");
    expect(after).toBe("private");
  });

  it("createNote rejects empty / dot-only / whitespace path (no silent .md creation)", async () => {
    const v = new Vault(vroot, { enableWrite: true });
    await v.ensureExists();
    // The MCP-tool schema enforces min(1) at the JSON-RPC boundary, but the
    // vault method must also reject so direct callers (tests, scripts) can't
    // sneak by. Pre-fix, `path: ""` created `.md` (hidden by walker — silent).
    await expect(createNote(v, { path: "", content: "x" })).rejects.toThrow(/empty or dot-only/);
    await expect(createNote(v, { path: "   ", content: "x" })).rejects.toThrow(/empty or dot-only/);
    await expect(createNote(v, { path: ".md", content: "x" })).rejects.toThrow(/empty or dot-only/);
    for (const hidden of [".secret", "nested/.secret", "NODE_MODULES/package", ".git./config", "nested\\.private"]) {
      await expect(createNote(v, { path: hidden, content: "x" })).rejects.toThrow(
        /excluded by hidden or reserved vault path/
      );
    }
    await expect(fs.stat(path.join(vroot, ".secret.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(vroot, "NODE_MODULES"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(createNote(v, { path: "Project.v2/note.v2", content: "visible" })).resolves.toMatchObject({
      path: "Project.v2/note.v2.md"
    });
  });
});

// v2.0.0-beta.2 P1 fix: extend the privacy-bypass regression coverage to ALL
// write tools (not just createNote) AND to the read tools that go through
// persistent indexes (FTS5, EmbedDb). Pre-fix, every test asserting the
// privacy boundary instantiated Vault with `enableWrite: false` OR exercised
// a single tool. The test agent flagged this as the same shape of gap that
// hid the writeNote bug for ~6 months.
describe("Vault — write-tool privacy boundary (v2.0.0-beta.2)", () => {
  let wroot: string;
  beforeEach(async () => {
    wroot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-write-priv-"));
    await fs.mkdir(path.join(wroot, "Personal"), { recursive: true });
    await fs.mkdir(path.join(wroot, "Public"), { recursive: true });
    await fs.writeFile(path.join(wroot, "Personal", "diary.md"), "private content");
    await fs.writeFile(path.join(wroot, "Public", "p.md"), "public content");
  });
  afterEach(async () => {
    await fs.rm(wroot, { recursive: true, force: true });
  });

  // appendToNote — already routed through resolveSafePath which gates,
  // but no test asserted it before v2.0.0-beta.2.
  it("appendToNote refuses excluded path (--exclude-glob)", async () => {
    await fs.writeFile(path.join(wroot, ".append.md"), "do not change");
    const v = new Vault(wroot, { enableWrite: true, excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    await expect(appendToNote(v, { path: "Personal/diary.md", content: "leak" })).rejects.toThrow(
      /excluded by --exclude-glob/
    );
    await expect(appendToNote(v, { path: ".append.md", content: "leak" })).rejects.toThrow(
      /hidden or reserved vault path/
    );
    expect(await fs.readFile(path.join(wroot, ".append.md"), "utf8")).toBe("do not change");
  });

  it("appendToNote refuses path outside --read-paths allowlist", async () => {
    const v = new Vault(wroot, { enableWrite: true, readPaths: ["Public/**"] });
    await v.ensureExists();
    await expect(appendToNote(v, { path: "Personal/diary.md", content: "leak" })).rejects.toThrow(
      /excluded by --read-paths/
    );
  });

  // archiveNote — delegates to renameNote; tests that BOTH source and
  // destination paths are gated.
  it("archiveNote refuses excluded source", async () => {
    const v = new Vault(wroot, { enableWrite: true, excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    await expect(archiveNote(v, { path: "Personal/diary.md" })).rejects.toThrow(/excluded/);
  });

  it("archiveNote refuses when archive_folder leaves --read-paths allowlist", async () => {
    const v = new Vault(wroot, { enableWrite: true, readPaths: ["Public/**"] });
    await v.ensureExists();
    await expect(archiveNote(v, { path: "Public/p.md", archive_folder: "Archive" })).rejects.toThrow(/excluded/);
  });

  // renameNote — source-side gate via resolveSafePath; destination-side
  // gate explicit in renameFile (we just fixed it to distinguish allowlist).
  it("renameNote refuses excluded source", async () => {
    await fs.writeFile(path.join(wroot, ".source.md"), "hidden source");
    const v = new Vault(wroot, { enableWrite: true, excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    await expect(renameNote(v, { from: "Personal/diary.md", to: "Public/d.md" })).rejects.toThrow(/excluded/);
    await expect(renameNote(v, { from: ".source.md", to: "Public/source.md" })).rejects.toThrow(
      /hidden or reserved vault path/
    );
    expect(await fs.readFile(path.join(wroot, ".source.md"), "utf8")).toBe("hidden source");
    await expect(fs.stat(path.join(wroot, "Public", "source.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renameNote destination-side error names --read-paths when allowlist rejects", async () => {
    // The v2.0.0-beta.2 fix in renameFile distinguishes allowlist vs denylist
    // in the error message (writeNote already did this; renameFile didn't).
    const v = new Vault(wroot, { enableWrite: true, readPaths: ["Public/**"] });
    await v.ensureExists();
    await expect(renameNote(v, { from: "Public/p.md", to: "Private/p.md" })).rejects.toThrow(/--read-paths allowlist/);
    await expect(renameNote(v, { from: "Public/p.md", to: ".private/p.md" })).rejects.toThrow(
      /hidden or reserved vault path/
    );
    expect(await fs.readFile(path.join(wroot, "Public", "p.md"), "utf8")).toBe("public content");
    await expect(fs.stat(path.join(wroot, ".private"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // replaceInNotes — denylist case (v2.0.0-beta.1 only tested allowlist).
  it("replaceInNotes silently scopes out excluded folders even with explicit folder=", async () => {
    const v = new Vault(wroot, { enableWrite: true, excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    await fs.writeFile(path.join(wroot, "Personal", "diary.md"), "marker\n");
    // v2.0.0-beta.2: the function now refuses explicitly when folder= is excluded.
    await expect(replaceInNotes(v, { search: "marker", replace: "hit", folder: "Personal" })).rejects.toThrow(
      /excluded by privacy filter/
    );
    // Source still untouched.
    expect(await fs.readFile(path.join(wroot, "Personal", "diary.md"), "utf8")).toBe("marker\n");
  });
});

// v2.0.0-beta.2 P0 fix: persistent FTS5 + embed indexes were not consulting
// isExcluded() at search time. After a config flip (e.g. user adds
// --exclude-glob between two server runs), excluded chunks would leak via
// `obsidian_full_text_search`, `obsidian_embeddings_search`, `obsidian_search`
// (hybrid), and the `obsidian://chunk/{n}/{path}` resource.
describe("Persistent indexes — search-time privacy filter (v2.0.0-beta.2)", () => {
  let proot: string;
  beforeEach(async () => {
    proot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-persist-priv-"));
    await fs.mkdir(path.join(proot, "Personal"), { recursive: true });
    await fs.mkdir(path.join(proot, "Public"), { recursive: true });
    await fs.writeFile(path.join(proot, "Personal", "diary.md"), "secret diary entry about authentication tokens");
    await fs.writeFile(path.join(proot, "Public", "auth.md"), "public OAuth authentication notes");
  });
  afterEach(async () => {
    await fs.rm(proot, { recursive: true, force: true });
  });

  it("searchHybrid filters excluded paths from BM25 hits even when FTS5 db has stale entries", async () => {
    // Build the FTS5 index WITHOUT exclusion flags (simulates index built
    // before the user enabled --exclude-glob).
    const vBuild = new Vault(proot);
    await vBuild.ensureExists();
    const idx = new FtsIndex({ file: defaultIndexFile(proot), vaultRoot: proot });
    await idx.open();
    try {
      for (const e of await vBuild.listMarkdown()) {
        const note = await vBuild.readNote(e.absPath, e.mtimeMs);
        const targets = note.parsed.wikilinks.map((w) => w.target).filter((t) => t.length > 0);
        idx.reindexFile(e.relPath, e.mtimeMs, note.content, targets, note.parsed.tags);
      }
      idx.reindexFile(".secret.md", 1000, "ultrasecret hidden index row", [], []);
      const hiddenTarget = path.join(proot, ".hidden-target");
      const visibleAlias = path.join(proot, "VisibleAlias");
      await fs.mkdir(hiddenTarget, { recursive: true });
      await fs.writeFile(path.join(hiddenTarget, "note.md"), "hidden physical target");
      const aliasCreated = await fs
        .symlink(hiddenTarget, visibleAlias)
        .then(() => true)
        .catch(() => false);
      if (process.env.CI) expect(aliasCreated, "CI must exercise stale chunk physical admission").toBe(true);
      idx.reindexFile("VisibleAlias/note.md", 1000, "stale visible alias row", [], []);
      const replacedPath = path.join(proot, "Replaced.md");
      await fs.writeFile(replacedPath, "once a regular indexed file");
      idx.reindexFile("Replaced.md", 1000, "stale replaced file row", [], []);
      await fs.unlink(replacedPath);
      await fs.mkdir(replacedPath);
      expect(idx.search("ultrasecret", { limit: 10 }).some((hit) => hit.rel_path === ".secret.md")).toBe(true);
      expect(idx.search("replaced", { limit: 10 }).some((hit) => hit.rel_path === "Replaced.md")).toBe(true);
      if (aliasCreated) {
        expect(idx.search("stale", { limit: 10 }).some((hit) => hit.rel_path === "VisibleAlias/note.md")).toBe(true);
      }

      // Now serve the SAME .fts5.db with exclusion flags — Personal/ should
      // be invisible to obsidian_search even though FTS5 db still has it.
      const vServe = new Vault(proot, { excludeGlobs: ["Personal/**"] });
      await vServe.ensureExists();
      const callFts = (query: string) => searchLiveFts(vServe, idx, { query, limit: 10 });
      const publicFts = await callFts("authentication");
      expect(publicFts.some((match) => match.rel_path === "Public/auth.md")).toBe(true);
      expect(publicFts.every((match) => !match.rel_path.startsWith("Personal/"))).toBe(true);
      expect(await callFts("ultrasecret")).toEqual([]);
      expect(await callFts("replaced")).toEqual([]);
      if (aliasCreated) expect(await callFts("stale")).toEqual([]);

      const result = await searchHybrid(
        vServe,
        { query: "authentication tokens", limit: 10 },
        { ftsIndex: idx, embedFile: path.join(proot, "nonexistent.embed.db") }
      );
      // No hit from Personal/, even though FTS5 db has the chunk.
      expect(result.matches.every((m) => !m.path.startsWith("Personal/"))).toBe(true);
      // Public/auth.md should still appear.
      expect(result.matches.some((m) => m.path === "Public/auth.md")).toBe(true);
      const hiddenResult = await searchHybrid(
        vServe,
        { query: "ultrasecret", limit: 10 },
        { ftsIndex: idx, embedFile: path.join(proot, "nonexistent.embed.db") }
      );
      expect(hiddenResult.matches.every((m) => m.path !== ".secret.md")).toBe(true);
      const replacedResult = await searchHybrid(
        vServe,
        { query: "replaced", limit: 10 },
        { ftsIndex: idx, embedFile: path.join(proot, "nonexistent.embed.db") }
      );
      expect(replacedResult.matches.every((match) => match.path !== "Replaced.md")).toBe(true);
      if (aliasCreated) {
        const aliasResult = await searchHybrid(
          vServe,
          { query: "stale", limit: 10 },
          { ftsIndex: idx, embedFile: path.join(proot, "nonexistent.embed.db") }
        );
        expect(aliasResult.matches.every((match) => match.path !== "VisibleAlias/note.md")).toBe(true);
      }

      const publicChunk = await readLiveFtsChunk(vServe, idx, "Public/auth.md", 0);
      expect(publicChunk.content).toContain("public OAuth authentication notes");
      await expect(readLiveFtsChunk(vServe, idx, ".secret.md", 0)).rejects.toThrow(/Chunk not found/);
      await expect(readLiveFtsChunk(vServe, idx, "Replaced.md", 0)).rejects.toThrow(/Chunk not found/);
      if (aliasCreated) {
        await expect(readLiveFtsChunk(vServe, idx, "VisibleAlias/note.md", 0)).rejects.toThrow(/Chunk not found/);
      }
    } finally {
      idx.close();
    }
  });

  it("embeddingsSearch filters excluded paths post-result (when stale .embed.db has them)", async () => {
    // We don't load the real ML model — instead we manually construct the
    // .embed.db with synthetic vectors, then verify the filter applies.
    const { EmbedDb } = await import("../src/embed-db.js");
    const dim = 4;
    const file = path.join(proot, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: proot, modelAlias: "multilingual", dim });
    await db.open();
    const l2 = (v: number[]) => {
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return new Float32Array(v.map((x) => x / (n || 1)));
    };
    db.upsertNote("Personal/diary.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "secret diary", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("Public/auth.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "public auth", vector: l2([0.99, 0.14, 0, 0]) }
    ]);
    db.upsertNote(".secret.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hidden row", vector: l2([1, 0, 0, 0]) }
    ]);
    const hiddenTarget = path.join(proot, ".hidden-embed-target");
    const visibleAlias = path.join(proot, "VisibleEmbedAlias");
    await fs.mkdir(hiddenTarget, { recursive: true });
    await fs.writeFile(path.join(hiddenTarget, "note.md"), "hidden physical target");
    const aliasCreated = await fs
      .symlink(hiddenTarget, visibleAlias)
      .then(() => true)
      .catch(() => false);
    if (process.env.CI) expect(aliasCreated, "CI must exercise stale embed physical admission").toBe(true);
    db.upsertNote("VisibleEmbedAlias/note.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "stale alias row", vector: l2([1, 0, 0, 0]) }
    ]);
    await fs.mkdir(path.join(proot, "Replaced.md"));
    db.upsertNote("Replaced.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "stale directory row", vector: l2([1, 0, 0, 0]) }
    ]);
    db.close();

    // Vault with exclusion. embeddingsSearch should NOT return Personal/.
    // The function loads embedDb internally; we patch dim to match.
    // Since embeddingsSearch loads the real model, we can't easily test it
    // here without a model. Instead test the EmbedDb-level isExcluded filter
    // is applied via the vault layer.
    const vServe = new Vault(proot, { excludeGlobs: ["Personal/**"] });
    await vServe.ensureExists();
    // Direct EmbedDb.search would return both rows — that's expected; we
    // filter at the embeddingsSearch layer (vault.isExcluded post-filter).
    const db2 = new EmbedDb({ file, vaultRoot: proot, modelAlias: "multilingual", dim });
    await db2.open();
    try {
      const rawHits = db2.search(l2([1, 0, 0, 0]), 10);
      expect(rawHits.length).toBe(5); // public, two hidden classes, physical-hidden alias, stale directory
      // v3.10.0-rc.22 (audit M8) — call the ACTUAL helper embeddingsSearch
      // applies (search.ts:~1100/1106), not an inline reimplementation. If the
      // real filter regresses, this now fails (it was vacuous theater before).
      const filtered = filterExcludedEmbedHits(rawHits, (p) => vServe.isExcluded(p));
      expect(filtered.map((hit) => hit.rel_path).sort()).toEqual([
        "Public/auth.md",
        "Replaced.md",
        "VisibleEmbedAlias/note.md"
      ]);
      const liveFiltered = await filterLiveVaultHits(vServe, filtered, (hit) => hit.rel_path, 10);
      expect(liveFiltered.map((hit) => hit.rel_path)).toEqual(["Public/auth.md"]);
    } finally {
      db2.close();
    }
  });
});

// v2.0.0-beta.2 P1 sec DiD test
describe("Vault constructor — privacy fail-closed (v2.0.0-beta.2)", () => {
  let r: string;
  beforeEach(async () => {
    r = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-failclosed-"));
  });
  afterEach(async () => {
    await fs.rm(r, { recursive: true, force: true });
  });

  it("refuses to construct when --read-paths produces no valid regexes (silent disable guard)", () => {
    expect(() => new Vault(r, { readPaths: [""] })).toThrow(/refusing to start/);
  });

  it("refuses to construct when --exclude-glob produces no valid regexes", () => {
    expect(() => new Vault(r, { excludeGlobs: [""] })).toThrow(/refusing to start/);
  });

  it("constructs cleanly with valid patterns (control)", () => {
    expect(() => new Vault(r, { readPaths: ["Public/**"] })).not.toThrow();
  });
});

// v1.11.1 audit fix: resolveTarget's periodic-alias codepath used to silently
// swallow exclusion errors and fall through to the legacy alias resolver +
// findByTitle, which could surface a different (visible) basename match —
// returning the WRONG note. The path-based codepath already preserved
// exclusion errors via lastErr; both should now behave consistently.
describe("Vault — periodic-alias resolver respects exclusions (v1.11.1)", () => {
  let vroot: string;
  beforeEach(async () => {
    vroot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-periodic-exclude-"));
    await fs.mkdir(path.join(vroot, ".obsidian"), { recursive: true });
    await fs.mkdir(path.join(vroot, "Daily Notes"), { recursive: true });
    // Periodic Notes plugin config — points "today" / "daily" at the
    // Daily Notes/ folder.
    await fs.writeFile(
      path.join(vroot, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Daily Notes", format: "YYYY-MM-DD" })
    );
    // Today's daily note exists but is excluded by the user's filter.
    // The periodic-alias resolver in src/periodic.ts uses LOCAL date
    // methods (getFullYear/getMonth/getDate), not UTC. Test must match
    // that to be timezone-stable — pre-fix used `toISOString().slice(0, 10)`
    // which is UTC and flakes during the few hours per day when local
    // and UTC dates disagree.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await fs.writeFile(path.join(vroot, "Daily Notes", `${today}.md`), "private daily entry");
  });
  afterEach(async () => {
    await fs.rm(vroot, { recursive: true, force: true });
  });

  it("readNote(title:'today') surfaces exclusion error instead of falling through", async () => {
    const defaultV = new Vault(vroot);
    await defaultV.ensureExists();
    await expect(readNote(defaultV, { title: "today" })).resolves.toMatchObject({
      path: expect.stringMatching(/^Daily Notes\/\d{4}-\d{2}-\d{2}\.md$/u)
    });

    const v = new Vault(vroot, { excludeGlobs: ["Daily Notes/**"] });
    await v.ensureExists();
    // Pre-1.11.1: bare catch{} swallowed the exclusion error and fell through
    // to legacy alias + findByTitle, returning "No note found" (or worse, a
    // visible basename collision). Post-fix: we surface "excluded by..."
    // consistently with the path-based lookup.
    await expect(readNote(v, { title: "today" })).rejects.toThrow(/excluded by --exclude-glob/);
  });

  it("readNote(title:'daily') keeps periodic config private, then authorizes the public default target", async () => {
    // Pre-v2.0.0-beta.2: `.obsidian/daily-notes.json` was read regardless of
    // `--read-paths`, so the periodic resolver produced `Daily Notes/<today>.md`
    // and `vault.stat()` surfaced "excluded by --read-paths". That technically
    // worked but leaked the fact that the user had a Daily Notes plugin
    // configured (an attacker could time the difference between "no periodic
    // config" and "config but excluded").
    //
    // The trusted internal config read still respects the explicit user
    // allowlist, so resolution falls back to the public root-date default.
    // Authorization now runs before existence: the derived target is rejected
    // consistently without exposing the configured "Daily Notes" folder.
    const v = new Vault(vroot, { readPaths: ["Work/**"] });
    await v.ensureExists();
    const error = await readNote(v, { title: "daily" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected Error");
    expect(error.message).toMatch(/Path is excluded by --read-paths allowlist/);
    expect(error.message).toMatch(/\d{4}-\d{2}-\d{2}\.md$/u);
    expect(error.message).not.toContain("Daily Notes");
  });
});
