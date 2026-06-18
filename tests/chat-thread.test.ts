// v2.2.0: chat-thread tools — note-tethered AI conversations.
// Stored as `## Chat: <title>` block with `### <role> · <timestamp>`
// message headings.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatThreadAppend, chatThreadRead } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-chat-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("chat_thread_append (v2.2.0)", () => {
  it("creates a new note with title heading + chat block when path doesn't exist", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await chatThreadAppend(v, {
      note_path: "Threads/research.md",
      role: "user",
      content: "What did I write last week about RLHF?",
      thread_title: "RLHF research"
    });
    const body = await fs.readFile(path.join(root, "Threads", "research.md"), "utf8");
    expect(body).toContain("# RLHF research");
    expect(body).toContain("## Chat: RLHF research");
    expect(body).toContain("### user · ");
    expect(body).toContain("What did I write last week about RLHF?");
  });

  it("appends to existing thread without duplicating heading", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await chatThreadAppend(v, { note_path: "session.md", role: "user", content: "first message" });
    await chatThreadAppend(v, { note_path: "session.md", role: "assistant", content: "first reply" });
    await chatThreadAppend(v, { note_path: "session.md", role: "user", content: "second message" });
    const body = await fs.readFile(path.join(root, "session.md"), "utf8");
    // Exactly ONE thread heading.
    const threadHeadings = body.match(/^## Chat: /gm) ?? [];
    expect(threadHeadings.length).toBe(1);
    // Three role headings.
    const roleHeadings = body.match(/^### (user|assistant) · /gm) ?? [];
    expect(roleHeadings.length).toBe(3);
  });

  it("reports line_start/line_end within the written file even with trailing blank lines (rc.50 CODE-2)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Existing thread note WITH trailing blank lines — the drift trigger. Pre-rc.50
    // line_start counted newlines in the un-stripped body while the write strips
    // them, so line_end pointed PAST EOF.
    await fs.writeFile(path.join(root, "t.md"), "# t\n\n## Chat: t\n\n### user · 2026-01-01T00:00:00Z\n\nhi\n\n\n\n");
    const res = await chatThreadAppend(v, { note_path: "t.md", role: "assistant", content: "reply" });
    const totalLines = (await fs.readFile(path.join(root, "t.md"), "utf8")).split("\n").length;
    expect(res.line_start).toBeGreaterThan(0);
    expect(res.line_end).toBeGreaterThanOrEqual(res.line_start);
    expect(res.line_start, "line_start must be within the written file").toBeLessThanOrEqual(totalLines);
    expect(res.line_end, "line_end must not point past EOF").toBeLessThanOrEqual(totalLines);
  });

  it("line_start lands exactly on the `### role` heading for all 3 branches (rc.55 CT-LINE-OFFBY1)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Returns the 0-based content of the reported line_start line in the written file.
    const headingAt = async (file: string, lineStart: number) =>
      (await fs.readFile(path.join(root, file), "utf8")).split("\n")[lineStart - 1] ?? "";

    // Branch C — new note from scratch (pre-rc.55 hardcoded line_start=4, which is the
    // blank line; the heading is line 5).
    const a = await chatThreadAppend(v, { note_path: "new.md", role: "user", content: "hello" });
    expect(await headingAt("new.md", a.line_start)).toMatch(/^### user · /);

    // Branch B — existing note WITHOUT a chat heading (adds the heading).
    await fs.writeFile(path.join(root, "plain.md"), "# Plain note\n\nSome body text.\n");
    const b = await chatThreadAppend(v, { note_path: "plain.md", role: "assistant", content: "added" });
    expect(await headingAt("plain.md", b.line_start)).toMatch(/^### assistant · /);

    // Branch A — existing thread (just appends a message; pre-rc.55 pointed one line
    // before the new heading).
    const c = await chatThreadAppend(v, { note_path: "new.md", role: "system", content: "follow-up" });
    expect(await headingAt("new.md", c.line_start)).toMatch(/^### system · /);
    // line_end still within the file (rc.50 invariant preserved).
    const total = (await fs.readFile(path.join(root, "new.md"), "utf8")).split("\n").length;
    expect(c.line_end).toBeLessThanOrEqual(total);
  });

  it("line_start is collision-proof when content embeds a heading-like line (rc.58 CT-LASTINDEXOF-COLLISION)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // Content that embeds a line shaped like the `### role · ts` heading. Pre-rc.58
    // `newBody.lastIndexOf(headingMarker)` could match the copy INSIDE the content →
    // line_start past EOF. The fix anchors to the appended block (first occurrence = the
    // real heading, which always precedes the content copy).
    const res = await chatThreadAppend(v, {
      note_path: "collide.md",
      role: "user",
      content: "quoting an old heading:\n### user · 2020-01-01T00:00:00Z"
    });
    const lines = (await fs.readFile(path.join(root, "collide.md"), "utf8")).split("\n");
    // line_start must land on the REAL appended heading and be within the file.
    expect(lines[res.line_start - 1] ?? "").toMatch(/^### user · /);
    expect(res.line_end, "line_end must not point past EOF").toBeLessThanOrEqual(lines.length);
  });

  it("rejects empty path / content", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(chatThreadAppend(v, { note_path: "", role: "user", content: "x" })).rejects.toThrow(/required/);
    await expect(chatThreadAppend(v, { note_path: "x.md", role: "user", content: "" })).rejects.toThrow(/required/);
  });

  it("respects vault read-only — refuses without --enable-write", async () => {
    const v = new Vault(root, { enableWrite: false });
    await v.ensureExists();
    await expect(chatThreadAppend(v, { note_path: "x.md", role: "user", content: "hi" })).rejects.toThrow(/read-only/);
  });
});

describe("chat_thread_read (v2.2.0)", () => {
  it("parses messages out of a chat note", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await chatThreadAppend(v, {
      note_path: "log.md",
      role: "user",
      content: "What's in my project notes?",
      thread_title: "log"
    });
    await chatThreadAppend(v, { note_path: "log.md", role: "assistant", content: "Three notes." });
    const result = await chatThreadRead(v, { note_path: "log.md" });
    expect(result.thread_title).toBe("log");
    expect(result.message_count).toBe(2);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toBe("What's in my project notes?");
    expect(result.messages[1]?.role).toBe("assistant");
    expect(result.messages[1]?.content).toBe("Three notes.");
    // Each message has line range.
    expect(result.messages[0]?.line_start).toBeGreaterThan(0);
    expect(result.messages[0]?.line_end).toBeGreaterThan(result.messages[0]?.line_start ?? 0);
  });

  it("returns empty messages on a note without `## Chat:` block", async () => {
    await fs.writeFile(path.join(root, "regular.md"), "# Just a regular note\n\nNo chat here.\n");
    const v = new Vault(root);
    await v.ensureExists();
    const result = await chatThreadRead(v, { note_path: "regular.md" });
    expect(result.thread_title).toBeNull();
    expect(result.message_count).toBe(0);
  });

  it("handles multi-line message content correctly (preserves markdown)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await chatThreadAppend(v, {
      note_path: "multi.md",
      role: "assistant",
      content: "Line 1\n\nLine 3 after blank\n- bullet 1\n- bullet 2"
    });
    const result = await chatThreadRead(v, { note_path: "multi.md" });
    expect(result.message_count).toBe(1);
    expect(result.messages[0]?.content).toContain("Line 1");
    expect(result.messages[0]?.content).toContain("Line 3 after blank");
    expect(result.messages[0]?.content).toContain("- bullet 1");
  });
});
