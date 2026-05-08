// v2.2.0: chat-thread tools — note-tethered AI conversations.
// Stored as `## Chat: <title>` block with `### <role> · <timestamp>`
// message headings.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatThreadAppend, chatThreadRead } from "../src/tools.js";
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
