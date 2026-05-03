import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendToNote, createNote } from "../src/tools.js";
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
    expect(text).toMatch(/status: "true"/);
    expect(text).toMatch(/note: "yes"/);
  });
});

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
