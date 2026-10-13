import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeNotePath,
  decodeResourceCursor,
  encodeNotePath,
  encodeResourceCursor,
  listVaultNoteResources,
  pageVaultResources,
  RESOURCE_PAGE_LIMIT,
  ResourceCursorError,
  vaultResourceInfo
} from "../src/resource-admission.js";
import { Vault } from "../src/vault.js";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

describe("resource inventory admission", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-resource-list-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves the small-vault contract and pages a large one with an opaque cursor (AH-6)", async () => {
    await fs.writeFile(path.join(root, "Z.md"), "# Z\n");
    await fs.writeFile(path.join(root, "A.md"), "# A\n");
    const vault = new Vault(root);
    const bounded = vi.spyOn(vault, "listFilesByExtensionsBounded");
    vi.spyOn(vault, "listMarkdown").mockRejectedValue(new Error("legacy unbounded listing must not run"));

    await expect(listVaultNoteResources(vault)).resolves.toEqual([
      {
        uri: "obsidian://note/A.md",
        name: "A",
        description: "A.md",
        mimeType: "text/markdown"
      },
      {
        uri: "obsidian://note/Z.md",
        name: "Z",
        description: "Z.md",
        mimeType: "text/markdown"
      }
    ]);
    await expect(vaultResourceInfo(vault, "test-version")).resolves.toMatchObject({
      note_count: 2,
      version: "test-version"
    });
    expect(bounded).toHaveBeenNthCalledWith(1, [".md"], 10_000, 100_000);
    expect(bounded).toHaveBeenNthCalledWith(2, [".md"], 10_000, 100_000);

    // Page 1 carries the static vault-info entry; every page's note entries
    // carry the template metadata merged the way the SDK merges it, so the
    // wire shape is unchanged for a vault that fits in one page.
    const pagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ah6-"));
    try {
      for (let i = 0; i < RESOURCE_PAGE_LIMIT + 7; i += 1) {
        await fs.writeFile(path.join(pagedRoot, `note-${String(i).padStart(4, "0")}.md`), "body");
      }
      const pagedVault = new Vault(pagedRoot);
      const first = await pageVaultResources(pagedVault);
      expect(first.resources[0]).toMatchObject({ uri: "obsidian://vault/info", name: "vault-info" });
      expect(first.resources).toHaveLength(RESOURCE_PAGE_LIMIT + 1);
      expect(first.nextCursor, "a vault beyond one page must offer a continuation").toBeTypeOf("string");
      // Every note entry keeps the template title the SDK used to merge in.
      expect(first.resources[1]).toMatchObject({ title: "Vault notes", mimeType: "text/markdown" });

      const second = await pageVaultResources(pagedVault, first.nextCursor);
      expect(second.nextCursor, "the remainder fits in one more page").toBeUndefined();
      // The pages partition the listing exactly once: no duplicate, no gap.
      const uris = [...first.resources, ...second.resources].map((r) => r.uri as string);
      expect(new Set(uris).size).toBe(uris.length);
      expect(uris.filter((u) => u.startsWith("obsidian://note/"))).toHaveLength(RESOURCE_PAGE_LIMIT + 7);

      // A cursor this server did not mint is refused, never silently restarted.
      await expect(pageVaultResources(pagedVault, "not-a-cursor")).rejects.toBeInstanceOf(ResourceCursorError);
      // NEGATIVE control — the empty string is a LEGAL cursor value per the
      // spec, so it must be decoded like any other token and refused as
      // unmintable, not mistaken for "start from the beginning".
      await expect(pageVaultResources(pagedVault, "")).rejects.toBeInstanceOf(ResourceCursorError);
      expect(decodeResourceCursor(encodeResourceCursor("a/b.md"))).toBe("a/b.md");

      // AH-6b — the page no longer rides on the exhaustive inventory, so a
      // vault the exhaustive walk REFUSES is still fully enumerable. Proven
      // against the real refusal rather than a mocked one: the same vault is
      // asserted to fail listVaultNoteResources and to page to completion.
      const dense = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ah6b-"));
      try {
        for (let i = 0; i < 40; i += 1) {
          await fs.mkdir(path.join(dense, `d${String(i).padStart(2, "0")}`));
          for (let j = 0; j < 30; j += 1) {
            const dir = path.join(dense, `d${String(i).padStart(2, "0")}`);
            await fs.writeFile(path.join(dir, `n${String(j).padStart(2, "0")}.md`), "x");
          }
        }
        const denseVault = new Vault(dense);
        // The exhaustive path refuses this vault under a small budget…
        await expect(denseVault.listFilesByExtensionsBounded([".md"], 100, 10_000)).resolves.toMatchObject({
          complete: false
        });
        // …while the resumable page walks it to the end, in ascending order.
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const p2 = await pageVaultResources(denseVault, cursor);
          const notes = p2.resources.filter((r) => r.uri.startsWith("obsidian://note/"));
          seen.push(...notes.map((r) => r.description ?? ""));
          cursor = p2.nextCursor;
          if (cursor === undefined) break;
        }
        expect(seen).toHaveLength(1200);
        expect(new Set(seen).size).toBe(1200);
        expect([...seen]).toEqual([...seen].sort());
      } finally {
        await fs.rm(dense, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(pagedRoot, { recursive: true, force: true });
    }
  });

  it("fails both exhaustive resource contracts when the traversal receipt is incomplete", async () => {
    const vault = new Vault(root);
    vi.spyOn(vault, "listFilesByExtensionsBounded").mockResolvedValue({
      entries: [],
      visitedEntries: 100_001,
      complete: false
    });
    await expect(listVaultNoteResources(vault)).rejects.toThrow(/resource inventory is incomplete/i);
    await expect(vaultResourceInfo(vault, "test-version")).rejects.toThrow(/resource inventory is incomplete/i);
  });

  it("keeps a structural negative control for cumulative response bytes", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/resource-admission.ts"), "utf8");
    expect(source).toContain("resourceBytes > MAX_RESOURCE_LIST_UTF8_BYTES - serializedBytes");
    const mutant = replaceExactly(
      source,
      "resourceBytes > MAX_RESOURCE_LIST_UTF8_BYTES - serializedBytes",
      "resourceBytes < 0"
    );
    expect(mutant).not.toContain("resourceBytes > MAX_RESOURCE_LIST_UTF8_BYTES - serializedBytes");
  });
});

// F02 — a POSIX filename may legally contain a backslash. `toVaultSlashPath`
// normalizes `\` to `/` only where `\` IS a separator (Windows); elsewhere it
// left the name alone. Every `.replace(/\\/g, "/")` at the relPath call sites
// undid that guard, splitting one file into two identities.
//
// These controls discriminate only where the two spellings are genuinely two
// different files — Linux ext4 and macOS APFS, which is where hosted CI runs
// the POSIX half. On Windows there is no backslash-in-a-name identity to
// preserve, so the same invariant is asserted against the host's real two-
// segment path rather than skipped: there, `a/b.md` IS what is on disk and
// the assertion passes for the host's own semantics instead of for a fact the
// test never checked.
describe("F02: POSIX literal-backslash filename keeps one identity (AH-4 surface)", () => {
  const LITERAL = process.platform !== "win32";
  /** What the file is actually called on this host. */
  const REL = LITERAL ? "a\\b.md" : "a/b.md";
  /** What the old unconditional `.replace(/\\/g, "/")` would have claimed. */
  const SPLIT_REL = "a/b.md";

  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-f02-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Write the one name that means different things per platform. */
  async function writeTheNote(target = root): Promise<void> {
    if (LITERAL) {
      await fs.writeFile(path.join(target, "a\\b.md"), "# body-a-b\n");
      return;
    }
    await fs.mkdir(path.join(target, "a"), { recursive: true });
    await fs.writeFile(path.join(target, "a", "b.md"), "# body-a-b\n");
  }

  it("advertises the note under the name that is actually on disk", async () => {
    await writeTheNote();
    const vault = new Vault(root);
    const resources = await listVaultNoteResources(vault);
    expect(resources).toHaveLength(1);
    expect(resources[0].description).toBe(REL);
    expect(resources[0].uri).toBe(`obsidian://note/${encodeNotePath(REL)}`);
    if (LITERAL) {
      // The old code advertised `a/b.md` — a path that addresses NOTHING in
      // this vault, because no `a/` directory exists. That is the defect.
      expect(resources[0].description).not.toBe(SPLIT_REL);
      expect(resources[0].uri).not.toBe("obsidian://note/a/b.md");
    }
  });

  it("round-trips the emitted URI back to the same note", async () => {
    await writeTheNote();
    const vault = new Vault(root);
    const [resource] = await listVaultNoteResources(vault);
    const uriPath = resource.uri.slice("obsidian://note/".length);
    expect(decodeNotePath(uriPath)).toBe(REL);
    // Not merely "the string round-trips" — the decoded identity reads the
    // same body the inventory advertises.
    const note = await vault.readNote(decodeNotePath(uriPath));
    expect(note.content).toContain("body-a-b");
  });

  it("keeps a name whose tail only LOOKS reserved public", async () => {
    // `x\.git.md` is one ordinary filename on POSIX. Splitting it yielded the
    // segments `x` and `.git.md`, and the second starts with a dot, so
    // the note was excluded from the entire public surface.
    if (!LITERAL) return;
    await fs.writeFile(path.join(root, "x\\.git.md"), "# not-a-git-dir\n");
    const vault = new Vault(root);
    expect(vault.exclusionReason("x\\.git.md")).toBeNull();
    const resources = await listVaultNoteResources(vault);
    expect(resources.map((r) => r.description)).toEqual(["x\\.git.md"]);
  });

  it("still excludes a REAL reserved segment after normalization", async () => {
    // Negative control: dropping normalization must not disable the reserved
    // set. The backslash here is a genuine separator on every platform.
    await fs.mkdir(path.join(root, "sub", ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(root, "sub", ".obsidian", "cfg.md"), "# secret\n");
    await fs.writeFile(path.join(root, "sub", "ok.md"), "# fine\n");
    const vault = new Vault(root);
    const resources = await listVaultNoteResources(vault);
    expect(resources.map((r) => r.description)).toEqual(["sub/ok.md"]);
    expect(vault.exclusionReason("sub/.obsidian/cfg.md")).toBe("hidden or reserved vault path");
  });

  it("pages partition exactly the exhaustive admitted identities", async () => {
    const paged = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-f02-page-"));
    try {
      await writeTheNote(paged);
      await fs.writeFile(path.join(paged, "x\\.git.md"), "# not-a-git-dir\n");
      for (let i = 0; i < RESOURCE_PAGE_LIMIT + 5; i += 1) {
        await fs.writeFile(path.join(paged, `note-${String(i).padStart(4, "0")}.md`), "body");
      }
      const vault = new Vault(paged);
      const exhaustive = (await listVaultNoteResources(vault)).map((r) => r.description);

      const pagedIdentities: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await pageVaultResources(vault, cursor);
        for (const r of page.resources) {
          if (r.uri === "obsidian://vault/info") continue;
          pagedIdentities.push(r.description);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      // No duplicate, no gap, and the exotic names survived pagination.
      expect(new Set(pagedIdentities).size).toBe(pagedIdentities.length);
      expect([...pagedIdentities].sort()).toEqual([...exhaustive].sort());
      expect(pagedIdentities).toContain(REL);
      if (LITERAL) expect(pagedIdentities).toContain("x\\.git.md");
    } finally {
      await fs.rm(paged, { recursive: true, force: true });
    }
  });
});
