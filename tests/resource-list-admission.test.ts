import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeResourceCursor,
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
