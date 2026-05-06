import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendToNote, createNote, renameNote } from "../src/tools.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-write-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("createNote", () => {
  it("refuses to write when vault is read-only", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await expect(createNote(v, { path: "x.md", content: "hi" })).rejects.toThrow(/read-only/);
  });

  it("creates a note with frontmatter", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const out = await createNote(v, {
      path: "Inbox/Hello.md",
      content: "Body here.\n",
      frontmatter: { tags: ["foo", "bar"], title: "Hello" }
    });
    expect(out.path).toBe(path.join("Inbox", "Hello.md"));
    const text = await fs.readFile(path.join(root, "Inbox", "Hello.md"), "utf8");
    expect(text).toMatch(/^---\n/);
    expect(text).toMatch(/title: Hello/);
    expect(text).toMatch(/tags:\n {2}- foo\n {2}- bar/);
    expect(text).toMatch(/Body here\./);
  });

  it("auto-appends .md if missing", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const out = await createNote(v, { path: "no-ext-note", content: "x" });
    expect(out.path).toBe("no-ext-note.md");
  });

  it("refuses to overwrite without overwrite=true", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Twice.md", content: "first" });
    await expect(createNote(v, { path: "Twice.md", content: "second" })).rejects.toThrow(/already exists/);
  });

  it("overwrites when allowed", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Twice.md", content: "first" });
    await createNote(v, { path: "Twice.md", content: "second", overwrite: true });
    const text = await fs.readFile(path.join(root, "Twice.md"), "utf8");
    expect(text).toBe("second");
  });

  it("rejects path traversal in writes", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(createNote(v, { path: "../outside.md", content: "nope" })).rejects.toThrow(/escapes vault root/);
  });

  it("rejects writing through a symlink whose target is outside the vault (audit v0.7.3 P1)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-link-out-"));
    const outsideTarget = path.join(outside, "outside-target.md");
    await fs.writeFile(outsideTarget, "BEFORE");
    try {
      await fs.symlink(outsideTarget, path.join(root, "Link.md"));
      const linkExists = await fs.lstat(path.join(root, "Link.md")).catch(() => null);
      if (!linkExists) return;
      await expect(createNote(v, { path: "Link.md", content: "AFTER", overwrite: true })).rejects.toThrow(
        /target is a symlink/
      );
      const after = await fs.readFile(outsideTarget, "utf8");
      expect(after).toBe("BEFORE");
    } finally {
      await fs.unlink(path.join(root, "Link.md")).catch(() => {});
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects writes whose parent dir is a symlink to outside the vault", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Create a symlinked subfolder inside the vault that resolves OUTSIDE the vault.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-parent-link-"));
    try {
      await fs.symlink(outside, path.join(root, "linked-folder"));
      const linkExists = await fs.lstat(path.join(root, "linked-folder")).catch(() => null);
      if (!linkExists) return;
      await expect(
        createNote(v, { path: "linked-folder/sneaky.md", content: "should not land outside vault" })
      ).rejects.toThrow(/parent directory resolves outside vault/);
      const escaped = await fs.stat(path.join(outside, "sneaky.md")).catch(() => null);
      expect(escaped).toBeNull();
    } finally {
      await fs.unlink(path.join(root, "linked-folder")).catch(() => {});
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("write_then_append moves mtime forward", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const created = await createNote(v, { path: "MtimeCheck.md", content: "first" });
    await new Promise((r) => setTimeout(r, 12));
    const appended = await appendToNote(v, { path: "MtimeCheck.md", content: "second" });
    expect(new Date(appended.mtime).getTime()).toBeGreaterThan(new Date(created.mtime).getTime());
  });

  it("handles values that look like booleans by quoting them", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, {
      path: "Tricky.md",
      content: "body",
      frontmatter: { status: "true", note: "yes" }
    });
    const text = await fs.readFile(path.join(root, "Tricky.md"), "utf8");
    // gray-matter (js-yaml) emits single-quoted scalars by default; both
    // styles are valid YAML and round-trip the same. What matters: the values
    // are quoted, not bare (otherwise YAML would parse them back as boolean).
    expect(text).toMatch(/status: ['"]true['"]/);
    expect(text).toMatch(/note: ['"]yes['"]/);
  });

  it("renders date-like strings as strings, not as YAML timestamps (audit v0.7.6 P2)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, {
      path: "Dated.md",
      content: "body",
      frontmatter: { due: "2026-05-03" }
    });
    const round = await readNoteRaw(v, "Dated.md");
    expect(typeof round.frontmatter.due).toBe("string");
    expect(round.frontmatter.due).toBe("2026-05-03");
  });

  it("creates new note with regular file permissions, not executable (audit v0.8 P0)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Permcheck.md", content: "body" });
    const stat = await fs.stat(path.join(root, "Permcheck.md"));
    // Owner write + at least one of read; no exec bits set anywhere.
    const mode = stat.mode & 0o777;
    expect(mode & 0o600).toBeTruthy(); // user can read+write
    expect(mode & 0o111).toBe(0); // no exec bits anywhere
  });

  it("renders YAML-special strings (!important, a | b, leading @) without breaking YAML (audit v0.7.6 P2)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, {
      path: "YamlSpecial.md",
      content: "body",
      frontmatter: { bang: "!important", pipe: "a | b", at: "@mention", gt: ">arrow" }
    });
    const round = await readNoteRaw(v, "YamlSpecial.md");
    expect(round.frontmatter.bang).toBe("!important");
    expect(round.frontmatter.pipe).toBe("a | b");
    expect(round.frontmatter.at).toBe("@mention");
    expect(round.frontmatter.gt).toBe(">arrow");
  });
});

async function readNoteRaw(v: Vault, rel: string): Promise<{ frontmatter: Record<string, unknown> }> {
  const note = await v.readNote(path.join(v.root, rel));
  return { frontmatter: note.parsed.frontmatter as Record<string, unknown> };
}

describe("appendToNote", () => {
  it("appends to an existing note with default separator", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Log.md", content: "first entry" });
    const out = await appendToNote(v, { path: "Log.md", content: "second entry" });
    expect(out.appended_bytes).toBeGreaterThan(0);
    const text = await fs.readFile(path.join(root, "Log.md"), "utf8");
    expect(text).toBe("first entry\n\nsecond entry");
  });

  it("supports custom separator", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Log.md", content: "first" });
    await appendToNote(v, { path: "Log.md", content: "second", separator: "\n---\n" });
    const text = await fs.readFile(path.join(root, "Log.md"), "utf8");
    expect(text).toBe("first\n---\nsecond");
  });

  it("can resolve target by title", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await createNote(v, { path: "Daily.md", content: "morning" });
    const out = await appendToNote(v, { title: "Daily", content: "evening" });
    expect(out.path).toBe("Daily.md");
  });

  it("refuses appends in read-only mode", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Read.md"), "x");
    await expect(appendToNote(v, { path: "Read.md", content: "y" })).rejects.toThrow(/read-only/);
  });
});

describe("renameNote (v1.1)", () => {
  it("refuses to rename when vault is read-only", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Foo.md"), "body");
    await expect(renameNote(v, { from: "Foo.md", to: "Bar.md" })).rejects.toThrow(/read-only/);
  });

  it("happy path: renames file + rewrites every wikilink to the new name", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Apollo.md"), "Apollo body.\n");
    await fs.writeFile(path.join(root, "Hub.md"), "See [[Apollo]] for details.\n");
    await fs.writeFile(path.join(root, "Daily.md"), "Today: [[Apollo]] and [[Apollo|the project]].\n");
    const out = await renameNote(v, { from: "Apollo.md", to: "Apollo Project.md" });
    expect(out.from).toBe("Apollo.md");
    expect(out.to).toBe("Apollo Project.md");
    expect(out.dry_run).toBe(false);
    expect(out.total_links_rewritten).toBe(3);
    expect(out.files_updated.map((p) => p.path).sort()).toEqual(["Daily.md", "Hub.md"]);
    // File was renamed.
    expect(await fs.stat(path.join(root, "Apollo Project.md")).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(root, "Apollo.md")).catch(() => null)).toBeNull();
    // Wikilinks rewritten correctly.
    const hub = await fs.readFile(path.join(root, "Hub.md"), "utf8");
    expect(hub).toContain("[[Apollo Project]]");
    expect(hub).not.toContain("[[Apollo]]");
    const daily = await fs.readFile(path.join(root, "Daily.md"), "utf8");
    expect(daily).toContain("[[Apollo Project]]");
    expect(daily).toContain("[[Apollo Project|the project]]");
  });

  it("preserves alias / section / block in the rewritten target", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Old.md"), "## Heading\n\n^block-id\nBody.\n");
    await fs.writeFile(
      path.join(root, "Caller.md"),
      "[[Old]] [[Old|alias]] [[Old#Heading]] [[Old#Heading|H]] [[Old^block-id]]\n"
    );
    await renameNote(v, { from: "Old.md", to: "New.md" });
    const txt = await fs.readFile(path.join(root, "Caller.md"), "utf8");
    expect(txt).toContain("[[New]]");
    expect(txt).toContain("[[New|alias]]");
    expect(txt).toContain("[[New#Heading]]");
    expect(txt).toContain("[[New#Heading|H]]");
    expect(txt).toContain("[[New^block-id]]");
    expect(txt).not.toContain("[[Old");
  });

  it("rewrites embeds (![[...]]) too", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Embedded.md"), "embed body");
    await fs.writeFile(path.join(root, "Page.md"), "Here is ![[Embedded]] and [[Embedded]].\n");
    const out = await renameNote(v, { from: "Embedded.md", to: "Renamed Embed.md" });
    expect(out.total_links_rewritten).toBe(2);
    const page = await fs.readFile(path.join(root, "Page.md"), "utf8");
    expect(page).toContain("![[Renamed Embed]]");
    expect(page).toContain("[[Renamed Embed]]");
  });

  it("dry_run returns the plan without touching disk", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Source.md"), "x");
    await fs.writeFile(path.join(root, "Caller.md"), "Sees [[Source]] here.\n");
    const out = await renameNote(v, { from: "Source.md", to: "Target.md", dry_run: true });
    expect(out.dry_run).toBe(true);
    expect(out.total_links_rewritten).toBe(1);
    expect(out.files_updated[0]?.path).toBe("Caller.md");
    // File NOT renamed.
    expect(await fs.stat(path.join(root, "Source.md")).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(root, "Target.md")).catch(() => null)).toBeNull();
    // Caller NOT modified.
    const caller = await fs.readFile(path.join(root, "Caller.md"), "utf8");
    expect(caller).toContain("[[Source]]");
  });

  it("supports moving across folders (rename to a different directory)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Inbox"), { recursive: true });
    await fs.mkdir(path.join(root, "Archive"), { recursive: true });
    await fs.writeFile(path.join(root, "Inbox", "Note.md"), "body");
    // Bare-basename caller — should rewrite to bare-basename target.
    await fs.writeFile(path.join(root, "Bare.md"), "Bare ref [[Note]]\n");
    // Path-qualified caller — should rewrite to a path-qualified target pointing at the new folder.
    await fs.writeFile(path.join(root, "Qualified.md"), "Qualified [[Inbox/Note]]\n");
    await renameNote(v, { from: "Inbox/Note.md", to: "Archive/Note.md" });
    const bare = await fs.readFile(path.join(root, "Bare.md"), "utf8");
    expect(bare).toContain("[[Note]]"); // bare stays bare
    const qual = await fs.readFile(path.join(root, "Qualified.md"), "utf8");
    expect(qual).toContain("[[Archive/Note]]"); // path-qualified updated
  });

  it("does NOT rewrite wikilinks inside fenced code blocks", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Foo.md"), "body");
    await fs.writeFile(
      path.join(root, "Doc.md"),
      "Outside ref [[Foo]].\n\n```\nInside code [[Foo]] should stay verbatim.\n```\n\nAnother outside [[Foo]].\n"
    );
    const out = await renameNote(v, { from: "Foo.md", to: "Bar.md" });
    expect(out.total_links_rewritten).toBe(2); // 2 outside-fence, 1 inside-fence preserved
    const doc = await fs.readFile(path.join(root, "Doc.md"), "utf8");
    expect(doc).toContain("Outside ref [[Bar]]");
    expect(doc).toContain("Inside code [[Foo]] should stay verbatim"); // preserved
    expect(doc).toContain("Another outside [[Bar]]");
  });

  it("refuses if `to` already exists (without overwrite)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "A.md"), "a");
    await fs.writeFile(path.join(root, "B.md"), "b");
    await expect(renameNote(v, { from: "A.md", to: "B.md" })).rejects.toThrow(/already exists/);
    // Both files still present.
    expect(await fs.readFile(path.join(root, "A.md"), "utf8")).toBe("a");
    expect(await fs.readFile(path.join(root, "B.md"), "utf8")).toBe("b");
  });

  it("refuses if `from` does not exist", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(renameNote(v, { from: "MissingSource.md", to: "AnyName.md" })).rejects.toThrow();
  });

  it("auto-appends .md to from/to when missing", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "WithExt.md"), "x");
    const out = await renameNote(v, { from: "WithExt", to: "Renamed" });
    expect(out.from).toBe("WithExt.md");
    expect(out.to).toBe("Renamed.md");
  });

  it("rejects from == to as a no-op error (don't silently succeed)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Same.md"), "x");
    await expect(renameNote(v, { from: "Same.md", to: "Same.md" })).rejects.toThrow(/same path/);
  });
});
