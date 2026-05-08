// v2.3.0: frontmatter atomic ops.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frontmatterGet, frontmatterSearch, frontmatterSet } from "../src/tools.js";
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
