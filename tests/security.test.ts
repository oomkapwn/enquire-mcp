import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNote, listNotes, readNote } from "../src/tools.js";
import { globToRegex, Vault } from "../src/vault.js";

let root: string;
let outsideDir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-sec-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-outside-"));
  await fs.writeFile(path.join(root, "Inside.md"), "Safe content.\n");
  await fs.writeFile(path.join(outsideDir, "Secret.md"), "Sensitive content outside the vault.\n");
  // Create a symlink inside the vault pointing outside.
  try {
    await fs.symlink(path.join(outsideDir, "Secret.md"), path.join(root, "Secret-link.md"));
    await fs.symlink(outsideDir, path.join(root, "outside-dir-link"));
  } catch {
    // On Windows without dev mode, symlinks may fail — tests that depend on this skip.
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

describe("Vault — symlink safety", () => {
  it("does not list files reached via symlinks", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const notes = await listNotes(v, {});
    expect(notes.map((n) => n.title)).toEqual(["Inside"]);
    expect(notes.find((n) => n.title === "Secret")).toBeUndefined();
  });

  it("rejects reads of symlinked files that resolve outside vault", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const linkExists = await fs.lstat(path.join(root, "Secret-link.md")).catch(() => null);
    if (!linkExists) return;
    await expect(readNote(v, { path: "Secret-link.md" })).rejects.toThrow(/escapes vault root/);
  });

  it("rejects ../ traversal in resolveInside", async () => {
    const v = new Vault(root);
    expect(() => v.resolveInside("../../etc/passwd")).toThrow(/escapes vault root/);
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
  it("skips symlinks even when they point inside the vault", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const target = path.join(root, "Target-internal.md");
    const link = path.join(root, "Link-internal.md");
    await fs.writeFile(target, "internal target");
    await fs.symlink(target, link).catch(() => null);
    const linkExists = await fs.lstat(link).catch(() => null);
    if (!linkExists) return;
    const titles = (await listNotes(v, {})).map((n) => n.title);
    expect(titles).toContain("Target-internal");
    expect(titles).not.toContain("Link-internal");
    await fs.unlink(link).catch(() => {});
    await fs.unlink(target).catch(() => {});
  });
});

describe("Vault — listMarkdown(folder) symlink-out (audit P2-1)", () => {
  it("returns empty when folder argument is a symlink to outside the vault", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-fold-out-"));
    await fs.writeFile(path.join(outside, "Secret.md"), "should NOT be enumerated");
    try {
      await fs.symlink(outside, path.join(root, "linked-out"));
      const linkExists = await fs.lstat(path.join(root, "linked-out")).catch(() => null);
      if (!linkExists) return;
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

describe("globToRegex (v0.11 — privacy filter)", () => {
  it("`**` matches across path separators", () => {
    expect(globToRegex("Personal/**").test("Personal/Inbox/x.md")).toBe(true);
    expect(globToRegex("Personal/**").test("Other/Inbox/x.md")).toBe(false);
  });
  it("`*` matches within a single segment only", () => {
    expect(globToRegex("private/*.md").test("private/x.md")).toBe(true);
    expect(globToRegex("private/*.md").test("private/sub/x.md")).toBe(false);
  });
  it("`?` matches exactly one non-slash char", () => {
    expect(globToRegex("?_temp.md").test("x_temp.md")).toBe(true);
    expect(globToRegex("?_temp.md").test("xx_temp.md")).toBe(false);
    expect(globToRegex("?_temp.md").test("/_temp.md")).toBe(false);
  });
  it("escapes regex specials in literal segments", () => {
    expect(globToRegex("(parens)/x.md").test("(parens)/x.md")).toBe(true);
    expect(globToRegex("dot.path/x.md").test("dot.path/x.md")).toBe(true);
    expect(globToRegex("dot.path/x.md").test("dotXpath/x.md")).toBe(false);
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
    const v = new Vault(vroot, { excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    const out = await listNotes(v, {});
    const paths = out.map((n) => n.path).sort();
    expect(paths).toEqual(["INDEX.md", "Work/project.md"]);
    expect(paths).not.toContain("Personal/diary.md");
  });

  it("readNote refuses to surface excluded content even by direct path", async () => {
    const v = new Vault(vroot, { excludeGlobs: ["Personal/**"] });
    await v.ensureExists();
    await expect(readNote(v, { path: "Personal/diary.md" })).rejects.toThrow(/excluded by --exclude-glob/);
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
    const today = new Date().toISOString().slice(0, 10);
    await fs.writeFile(path.join(vroot, "Daily Notes", `${today}.md`), "private daily entry");
  });
  afterEach(async () => {
    await fs.rm(vroot, { recursive: true, force: true });
  });

  it("readNote(title:'today') surfaces exclusion error instead of falling through", async () => {
    const v = new Vault(vroot, { excludeGlobs: ["Daily Notes/**"] });
    await v.ensureExists();
    // Pre-1.11.1: bare catch{} swallowed the exclusion error and fell through
    // to legacy alias + findByTitle, returning "No note found" (or worse, a
    // visible basename collision). Post-fix: we surface "excluded by..."
    // consistently with the path-based lookup.
    await expect(readNote(v, { title: "today" })).rejects.toThrow(/excluded by --exclude-glob/);
  });

  it("readNote(title:'daily') with --read-paths allowlist surfaces allowlist rejection", async () => {
    const v = new Vault(vroot, { readPaths: ["Work/**"] });
    await v.ensureExists();
    await expect(readNote(v, { title: "daily" })).rejects.toThrow(/excluded by --read-paths/);
  });
});
