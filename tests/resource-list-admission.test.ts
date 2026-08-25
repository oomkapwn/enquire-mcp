import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listVaultNoteResources, vaultResourceInfo } from "../src/resource-admission.js";
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

  it("preserves the small-vault resource contract through a bounded, deterministic walk", async () => {
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
