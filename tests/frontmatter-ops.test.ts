// v2.3.0: frontmatter atomic ops.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frontmatterGet, frontmatterSearch, frontmatterSet } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-fm-"));
  await fs.writeFile(path.join(root, "draft.md"), "---\nstatus: draft\ntags: [project, idea]\n---\n\nDraft body.\n");
  await fs.writeFile(path.join(root, "no-fm.md"), "Just a body, no frontmatter.\n");
  await fs.writeFile(
    path.join(root, "published.md"),
    "---\nstatus: published\ntags: [project]\n---\n\nPublished body.\n"
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("frontmatter_get", () => {
  it("returns full frontmatter object without `key`", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const result = await frontmatterGet(v, { path: "draft.md" });
    expect(result.frontmatter).toEqual({ status: "draft", tags: ["project", "idea"] });
    expect(result.value).toBeUndefined();
  });

  it("returns single-key value with `key`", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const result = await frontmatterGet(v, { path: "draft.md", key: "status" });
    expect(result.value).toBe("draft");
  });

  it("returns empty frontmatter for note without one", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const result = await frontmatterGet(v, { path: "no-fm.md" });
    expect(result.frontmatter).toEqual({});
  });
});

describe("frontmatter_set", () => {
  it("sets a key, returns before/after diff", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const result = await frontmatterSet(v, { path: "draft.md", set: { status: "published" } });
    expect(result.changed_keys).toContain("~status");
    expect(result.before.status).toBe("draft");
    expect(result.after.status).toBe("published");
    expect(result.dry_run).toBe(false);
    // Verify on disk
    const body = await fs.readFile(path.join(root, "draft.md"), "utf8");
    expect(body).toContain("status: published");
    expect(body).toContain("Draft body.");
  });

  it("removes a key when value is null", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const result = await frontmatterSet(v, { path: "draft.md", set: { status: null } });
    expect(result.changed_keys).toContain("-status");
    expect(result.after.status).toBeUndefined();
  });

  it("dry_run shows diff without writing", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    const result = await frontmatterSet(v, {
      path: "draft.md",
      set: { status: "published" },
      dry_run: true
    });
    expect(result.dry_run).toBe(true);
    expect(result.changed_keys).toContain("~status");
    // Disk untouched.
    const body = await fs.readFile(path.join(root, "draft.md"), "utf8");
    expect(body).toContain("status: draft");
  });

  it("rejects empty `set` object", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    await expect(frontmatterSet(v, { path: "draft.md", set: {} })).rejects.toThrow(/non-empty/);
  });

  // v3.10.0-rc.48 (roundtrip-serialization-fidelity) — a frontmatter-only edit must
  // not alter the body's trailing-newline state. `matter.stringify` always appends a
  // "\n"; pre-rc.48 that silently added one to a body saved without it.
  it("preserves the body's trailing-newline state", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // No trailing newline → must NOT gain one.
    await fs.writeFile(path.join(root, "no-nl.md"), "---\nstatus: draft\n---\nBody no newline");
    await frontmatterSet(v, { path: "no-nl.md", set: { status: "done" } });
    const noNl = await fs.readFile(path.join(root, "no-nl.md"), "utf8");
    expect(noNl.endsWith("Body no newline")).toBe(true);
    expect(noNl.endsWith("\n")).toBe(false); // NEGATIVE: no spurious newline introduced
    expect(noNl).toContain("status: done");
    // Single trailing newline → must stay exactly one (not doubled).
    await fs.writeFile(path.join(root, "one-nl.md"), "---\nstatus: draft\n---\nBody with newline\n");
    await frontmatterSet(v, { path: "one-nl.md", set: { status: "done" } });
    const oneNl = await fs.readFile(path.join(root, "one-nl.md"), "utf8");
    expect(oneNl.endsWith("Body with newline\n")).toBe(true);
    expect(oneNl.endsWith("\n\n")).toBe(false);
  });

  it("refuses to edit a note whose existing frontmatter is malformed YAML (rc.61 WRITE-2)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // TAB-indented frontmatter — js-yaml@5 rejects it, so parseNote falls back to whole-file
    // body. Pre-rc.61 frontmatterSet blindly prepended a 2nd `---` block, doubling/corrupting it.
    const malformed = "---\nstatus: draft\n\tbad: indent\n---\n# Title\n\nBody.\n";
    await fs.writeFile(path.join(root, "bad-fm.md"), malformed);
    await expect(frontmatterSet(v, { path: "bad-fm.md", set: { reviewed: true } })).rejects.toThrow(/not valid YAML/i);
    // File must be untouched (no doubled `---` block written).
    const after = await fs.readFile(path.join(root, "bad-fm.md"), "utf8");
    expect(after).toBe(malformed);
    expect(after.match(/^---$/gm)?.length).toBe(2); // still exactly one frontmatter block (2 fences)
  });

  it("still ADDS frontmatter to a clean no-frontmatter note (rc.61 NEGATIVE control — not over-refusing)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // no-fm.md (created in beforeEach) has NO frontmatter → parses cleanly → adding is allowed.
    await frontmatterSet(v, { path: "no-fm.md", set: { status: "new" } });
    const out = await fs.readFile(path.join(root, "no-fm.md"), "utf8");
    expect(out).toMatch(/^---\nstatus: new\n---/);
  });

  it("refuses to edit a note whose frontmatter is a valid-YAML NON-MAPPING (rc.64 round-3 audit)", async () => {
    const v = new Vault(root, { enableWrite: true });
    await v.ensureExists();
    // A sequence frontmatter block is valid YAML but not a mapping. Pre-rc.64 frontmatterSet
    // saw note.parsed.frontmatter={} (coerced), built after={...set}, and REPLACED the block —
    // destroying the sequence while reporting before:{} (a phantom success).
    const seqNote = "---\n- important item 1\n- important item 2\n---\nBody text.\n";
    await fs.writeFile(path.join(root, "seq-fm.md"), seqNote);
    await expect(frontmatterSet(v, { path: "seq-fm.md", set: { status: "done" } })).rejects.toThrow(
      /not a YAML mapping/i
    );
    // File must be BYTE-unchanged (the sequence survives).
    expect(await fs.readFile(path.join(root, "seq-fm.md"), "utf8")).toBe(seqNote);

    // A bare-scalar frontmatter block is the same class.
    const scalarNote = "---\njust a scalar\n---\nBody.\n";
    await fs.writeFile(path.join(root, "scalar-fm.md"), scalarNote);
    await expect(frontmatterSet(v, { path: "scalar-fm.md", set: { x: 1 } })).rejects.toThrow(/not a YAML mapping/i);
    expect(await fs.readFile(path.join(root, "scalar-fm.md"), "utf8")).toBe(scalarNote);
  });
});

describe("frontmatter_search", () => {
  it("`equals` finds notes with exact value match", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const result = await frontmatterSearch(v, { key: "status", equals: "draft" });
    expect(result.total_matches).toBe(1);
    expect(result.matches[0]?.path).toBe("draft.md");
  });

  it("`exists: true` finds all notes that have the key set", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const result = await frontmatterSearch(v, { key: "status", exists: true });
    expect(result.total_matches).toBe(2);
  });

  it("`contains` finds array-typed values that contain the target", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const result = await frontmatterSearch(v, { key: "tags", contains: "idea" });
    expect(result.total_matches).toBe(1);
    expect(result.matches[0]?.path).toBe("draft.md");
  });

  it("rejects 0 or 2+ predicates", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await expect(frontmatterSearch(v, { key: "status" })).rejects.toThrow(/exactly one/);
    await expect(frontmatterSearch(v, { key: "status", equals: "draft", exists: true })).rejects.toThrow(/exactly one/);
  });
});
