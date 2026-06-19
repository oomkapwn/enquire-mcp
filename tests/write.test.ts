import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendToNote, archiveNote, createNote, renameNote, replaceInNotes } from "../src/tools/index.js";
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

  // v3.7.14 F2 — renameFile non-overwrite is atomic via link()+unlink().
  // Pre-3.7.14 vault.renameFile had the same stat-then-rename race as
  // v3.7.13 M2 fixed for writeNote. POSIX rename(2) silently replaces the
  // destination; between a stat() returning ENOENT and the rename(), a
  // parallel writer could create the destination and our rename would
  // clobber it. Now link()+unlink() — link() fails atomically on EEXIST.
  it("renameFile overwrite=false is atomic (parallel renames can't both succeed)", async () => {
    const raceRoot = path.join(root, "F2-race-root");
    await fs.mkdir(raceRoot, { recursive: true });
    const v = new Vault(raceRoot, { enableWrite: true });
    await v.ensureExists();
    // Two source files vying to land at the same destination.
    await fs.writeFile(path.join(raceRoot, "src-A.md"), "from A");
    await fs.writeFile(path.join(raceRoot, "src-B.md"), "from B");
    const results = await Promise.allSettled([
      v.renameFile("src-A.md", "dest.md"),
      v.renameFile("src-B.md", "dest.md")
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as Error).message).toMatch(/already exists/);
    // Cleanup
    await fs.rm(raceRoot, { recursive: true, force: true });
  });

  // v3.7.13 M2 — overwrite=false uses the `wx` flag for atomic exclusive
  // create. Pre-3.7.13 the path was stat-then-write: stat returned ENOENT
  // → write proceeded; if another process created the file between stat
  // and write, the overwrite-false guard was bypassed and the second
  // writer clobbered the first. With `wx`, the kernel atomically refuses
  // the open(). This integration test confirms the original-content
  // protection — both writers can't both succeed when overwrite=false.
  it("overwrite=false is atomic (parallel writers can't both succeed)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Fire two simultaneous createNote() calls (which use overwrite=false)
    // against the same path. Exactly one must succeed; the other must
    // reject with "Note already exists".
    const results = await Promise.allSettled([
      createNote(v, { path: "Race.md", content: "writer-A" }),
      createNote(v, { path: "Race.md", content: "writer-B" })
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(1);
    const rejReason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(rejReason.message).toMatch(/already exists/);
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

  it("overwrite:true does NOT lose the source when the destination backlinks the source (rc.60 WRITE-1)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Source A.md (the content that must survive) + an existing distinct destination B.md
    // that backlinks A. Pre-rc.60 the backlink-rewrite loop wrote B's PRE-rename content
    // back onto B.md AFTER the move put A's content there → A's content was silently lost.
    await fs.writeFile(path.join(root, "A.md"), "# Source A\n\nThe content that MUST survive.\n");
    await fs.writeFile(path.join(root, "B.md"), "# Dest B\n\nSee [[A]] for details.\n");
    await renameNote(v, { from: "A.md", to: "B.md", overwrite: true });
    const dest = await fs.readFile(path.join(root, "B.md"), "utf8");
    expect(dest, "destination must hold the moved SOURCE content, not B's clobbered old content").toContain(
      "The content that MUST survive."
    );
    expect(dest).not.toContain("See [[A]] for details."); // B's old content is gone (it was overwritten by the move — correct)
    expect(
      await fs
        .access(path.join(root, "A.md"))
        .then(() => true)
        .catch(() => false)
    ).toBe(false); // source moved away
  });

  it("overwrite:true to a destination that does NOT backlink the source still works (rc.60 NEGATIVE control)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "A.md"), "# Source A\n\nbody A\n");
    await fs.writeFile(path.join(root, "B.md"), "# Dest B\n\nunrelated, no link\n");
    await renameNote(v, { from: "A.md", to: "B.md", overwrite: true });
    expect(await fs.readFile(path.join(root, "B.md"), "utf8")).toContain("body A");
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

  it("rewrites self-references inside the renamed file (audit P1 v1.1)", async () => {
    // Pre-fix: a note that linked to itself stayed referencing the old name
    // after rename, leaving the renamed file with a broken self-link.
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(
      path.join(root, "Foo.md"),
      "Foo describes itself and references [[Foo]] and ![[Foo]] from inside.\n"
    );
    const out = await renameNote(v, { from: "Foo.md", to: "Bar.md" });
    expect(out.total_links_rewritten).toBe(2);
    // The renamed file's self-references must point at the new name.
    const bar = await fs.readFile(path.join(root, "Bar.md"), "utf8");
    expect(bar).toContain("[[Bar]]");
    expect(bar).toContain("![[Bar]]");
    expect(bar).not.toContain("[[Foo]]");
    // The plan response surfaces the source-file rewrite at its NEW path.
    const sourceEntry = out.files_updated.find((p) => p.path === "Bar.md");
    expect(sourceEntry?.rewrites).toBe(2);
  });

  it("self-reference rewrite respects code fences (no rewrite inside ```)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(
      path.join(root, "Doc.md"),
      "Outside [[Doc]].\n\n```\nInside fence: [[Doc]] stays.\n```\n\nMore outside [[Doc]].\n"
    );
    const out = await renameNote(v, { from: "Doc.md", to: "Manual.md" });
    expect(out.total_links_rewritten).toBe(2); // 2 outside, 1 inside-fence preserved
    const txt = await fs.readFile(path.join(root, "Manual.md"), "utf8");
    expect(txt.match(/\[\[Manual\]\]/g)?.length).toBe(2);
    expect(txt).toContain("Inside fence: [[Doc]] stays.");
  });

  it("overwrite=true: clobbers destination, source content lands at to-path", async () => {
    // Spec: overwrite=true means "replace the file at `to` with the renamed
    // source's content (and its updated wikilinks)". Existing backlinks that
    // pointed at `to` will continue to syntactically resolve to it — they now
    // point at the renamed source's content. That's the contract.
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Source.md"), "I am source linking to nothing.\n");
    await fs.writeFile(path.join(root, "Dest.md"), "I am the doomed destination.\n");
    await fs.writeFile(path.join(root, "PointsAtDest.md"), "Hello [[Dest]].\n");
    await renameNote(v, { from: "Source.md", to: "Dest.md", overwrite: true });
    // Source file gone; Dest file present with Source's content.
    expect(await fs.stat(path.join(root, "Source.md")).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, "Dest.md"), "utf8")).toContain("I am source linking to nothing");
    // PointsAtDest unchanged — its [[Dest]] still resolves (to Source's content now).
    expect(await fs.readFile(path.join(root, "PointsAtDest.md"), "utf8")).toContain("[[Dest]]");
  });

  it("self-reference + path-qualified target: [[Folder/Foo]] inside Folder/Foo.md (audit P2 v1.4)", async () => {
    // Pre-existing audit gap: a self-reference in a path-qualified form
    // (`Folder/Foo.md` containing `[[Folder/Foo]]`) was not explicitly tested.
    // After cross-folder rename, the path-qualified self-link must update its
    // path component AND its basename component.
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Inbox"), { recursive: true });
    await fs.mkdir(path.join(root, "Archive"), { recursive: true });
    await fs.writeFile(
      path.join(root, "Inbox", "Foo.md"),
      "I link to myself path-qualified [[Inbox/Foo]] and bare [[Foo]].\n"
    );
    await renameNote(v, { from: "Inbox/Foo.md", to: "Archive/Bar.md" });
    const txt = await fs.readFile(path.join(root, "Archive", "Bar.md"), "utf8");
    // Path-qualified self-link → new folder + new basename.
    expect(txt).toContain("[[Archive/Bar]]");
    // Bare self-link → new basename only (no path).
    expect(txt).toContain("[[Bar]]");
    // Old form is fully gone.
    expect(txt).not.toContain("[[Inbox/Foo]]");
    expect(txt).not.toContain("[[Foo]]");
  });
});

describe("replaceInNotes (v1.9 bulk find/replace)", () => {
  it("refuses to write when vault is read-only", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "doc.md"), "alpha\n");
    await expect(replaceInNotes(v, { search: "alpha", replace: "beta" })).rejects.toThrow(/read-only/);
  });

  it("happy path: replaces every occurrence outside fenced code blocks", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(
      path.join(root, "Doc.md"),
      "Hello GPT-3.5. Refer to GPT-3.5.\n\n```\nInside fence: GPT-3.5 stays.\n```\n\nMore GPT-3.5 mentions.\n"
    );
    await fs.writeFile(path.join(root, "Other.md"), "No mention here.\n");
    const out = await replaceInNotes(v, { search: "GPT-3.5", replace: "GPT-4" });
    expect(out.dry_run).toBe(false);
    expect(out.total_replacements).toBe(3); // 3 outside-fence; 1 inside-fence preserved
    expect(out.files_updated.length).toBe(1);
    expect(out.files_updated[0]?.path).toBe("Doc.md");
    expect(out.files_updated[0]?.occurrences).toBe(3);
    const txt = await fs.readFile(path.join(root, "Doc.md"), "utf8");
    expect((txt.match(/GPT-4/g) ?? []).length).toBe(3);
    expect(txt).toContain("Inside fence: GPT-3.5 stays.");
    // Untouched file unchanged.
    expect(await fs.readFile(path.join(root, "Other.md"), "utf8")).toBe("No mention here.\n");
  });

  it("dry_run returns the plan without writing", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Live.md"), "v1 v1 v1\n");
    const out = await replaceInNotes(v, { search: "v1", replace: "v2", dry_run: true });
    expect(out.dry_run).toBe(true);
    expect(out.total_replacements).toBe(3);
    // File NOT modified.
    expect(await fs.readFile(path.join(root, "Live.md"), "utf8")).toBe("v1 v1 v1\n");
  });

  it("case_sensitive=false matches across case but inserts replace verbatim", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Mixed.md"), "API and api and Api\n");
    const out = await replaceInNotes(v, { search: "api", replace: "REST", case_sensitive: false });
    expect(out.total_replacements).toBe(3);
    const txt = await fs.readFile(path.join(root, "Mixed.md"), "utf8");
    // All three case variants replaced with literal "REST".
    expect(txt).toBe("REST and REST and REST\n");
  });

  it("case_sensitive=true (default) only matches exact case", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Mixed.md"), "API and api and Api\n");
    const out = await replaceInNotes(v, { search: "api", replace: "REST" });
    expect(out.total_replacements).toBe(1);
    const txt = await fs.readFile(path.join(root, "Mixed.md"), "utf8");
    expect(txt).toBe("API and REST and Api\n");
  });

  it("folder filter narrows the scope", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Sub"), { recursive: true });
    await fs.writeFile(path.join(root, "RootDoc.md"), "target\n");
    await fs.writeFile(path.join(root, "Sub", "SubDoc.md"), "target\n");
    const out = await replaceInNotes(v, { search: "target", replace: "hit", folder: "Sub" });
    expect(out.total_replacements).toBe(1);
    expect(out.files_updated[0]?.path).toBe(path.join("Sub", "SubDoc.md"));
    // Root file untouched.
    expect(await fs.readFile(path.join(root, "RootDoc.md"), "utf8")).toBe("target\n");
  });

  it("returns total=0 when no notes match (no error)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "anything.md"), "no relevant text\n");
    const out = await replaceInNotes(v, { search: "xyzzy", replace: "quux" });
    expect(out.total_replacements).toBe(0);
    expect(out.files_updated).toEqual([]);
    expect(out.files_scanned).toBeGreaterThan(0);
  });

  it("rejects empty search", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(replaceInNotes(v, { search: "", replace: "x" })).rejects.toThrow(/non-empty/);
  });

  it("rejects identical search and replace (no-op refused)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(replaceInNotes(v, { search: "same", replace: "same" })).rejects.toThrow(/no-op/);
  });

  it("can delete every occurrence (replace is empty string, search is non-empty)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "stripme.md"), "Hello DEPRECATED world\nDEPRECATED line\n");
    const out = await replaceInNotes(v, { search: "DEPRECATED ", replace: "" });
    expect(out.total_replacements).toBe(2);
    const txt = await fs.readFile(path.join(root, "stripme.md"), "utf8");
    expect(txt).toBe("Hello world\nline\n");
  });

  it("respects --read-paths allowlist (writes outside allowlist refused)", async () => {
    const v = new Vault(root, { enableWrite: true, readPaths: ["Public/**"] });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Public"), { recursive: true });
    await fs.mkdir(path.join(root, "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Public", "p.md"), "marker\n");
    await fs.writeFile(path.join(root, "Private", "s.md"), "marker\n");
    const out = await replaceInNotes(v, { search: "marker", replace: "hit" });
    // Only Public/p.md is visible — and updated.
    expect(out.files_updated.map((p) => p.path)).toEqual([path.join("Public", "p.md")]);
    // Private file untouched.
    expect(await fs.readFile(path.join(root, "Private", "s.md"), "utf8")).toBe("marker\n");
  });
});

describe("archiveNote (v1.11)", () => {
  it("refuses to write when vault is read-only", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Old.md"), "x");
    await expect(archiveNote(v, { path: "Old.md" })).rejects.toThrow(/read-only/);
  });

  it("moves a note to the default Archive/ folder + bare backlinks stay valid", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Old.md"), "Body\n");
    // Bare wikilink — under rename_note's preserved-convention rules, a bare
    // basename target stays bare (and findBestMatch still resolves it after
    // the move because `Old.md` is unique by basename in the vault).
    await fs.writeFile(path.join(root, "Hub.md"), "Bare ref: [[Old]]\n");
    // Path-qualified wikilink — should be rewritten to point at the new path.
    await fs.writeFile(path.join(root, "Direct.md"), "Direct ref: [[Old]]\n");
    await fs.writeFile(path.join(root, "Qualified.md"), "Qualified: [[Old]]\n");
    // Add a path-qualified caller specifically.
    await fs.writeFile(path.join(root, "PathRef.md"), "From root: [[Old.md]]\n");
    const out = await archiveNote(v, { path: "Old.md" });
    expect(out.from).toBe("Old.md");
    expect(out.to).toBe(path.join("Archive", "Old.md"));
    expect(await fs.stat(path.join(root, "Archive", "Old.md")).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(root, "Old.md")).catch(() => null)).toBeNull();
    // Bare wikilink stays bare — still resolves via findBestMatch basename match.
    const hub = await fs.readFile(path.join(root, "Hub.md"), "utf8");
    expect(hub).toContain("[[Old]]");
  });

  it("supports custom archive_folder + strips a leading folder from source", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Inbox"), { recursive: true });
    await fs.writeFile(path.join(root, "Inbox", "Stale.md"), "x\n");
    // Source is in Inbox/; archive folder is Archive/2026/. Result should be
    // Archive/2026/Stale.md (basename only, not Archive/2026/Inbox/Stale.md).
    const out = await archiveNote(v, { path: "Inbox/Stale.md", archive_folder: "Archive/2026" });
    expect(out.to).toBe(path.join("Archive", "2026", "Stale.md"));
    expect(await fs.stat(path.join(root, "Archive", "2026", "Stale.md")).catch(() => null)).not.toBeNull();
  });

  it("dry_run previews without touching disk", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Live.md"), "x\n");
    const out = await archiveNote(v, { path: "Live.md", dry_run: true });
    expect(out.dry_run).toBe(true);
    // File NOT moved.
    expect(await fs.stat(path.join(root, "Live.md")).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(root, "Archive", "Live.md")).catch(() => null)).toBeNull();
  });

  it("refuses if the archive destination already exists (overwrite=false)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.mkdir(path.join(root, "Archive"), { recursive: true });
    await fs.writeFile(path.join(root, "Dup.md"), "live\n");
    await fs.writeFile(path.join(root, "Archive", "Dup.md"), "already-archived\n");
    await expect(archiveNote(v, { path: "Dup.md" })).rejects.toThrow(/already exists/);
  });

  it("rejects empty path", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(archiveNote(v, { path: "" })).rejects.toThrow(/required/);
  });

  it("trailing slash on archive_folder is normalized away", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Note.md"), "x\n");
    const out = await archiveNote(v, { path: "Note.md", archive_folder: "Archive///" });
    expect(out.to).toBe(path.join("Archive", "Note.md"));
  });
});
