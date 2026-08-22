import { describe, expect, it, vi } from "vitest";
import { type FtsIndex, syncFtsIndex, syncPdfFtsIndex } from "../src/fts5.js";
import {
  type BoundedFileListing,
  MAX_INDEX_SYNC_FILES,
  MAX_INDEX_SYNC_VISITED_ENTRIES,
  type Vault
} from "../src/vault.js";

function fakeVault(receipt: BoundedFileListing): {
  vault: Vault;
  list: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn(async () => receipt);
  return {
    vault: { listFilesByExtensionsBounded: list } as unknown as Vault,
    list
  };
}

function fakeIndex(retainedPath: string): {
  index: FtsIndex;
  retained: Set<string>;
  diff: ReturnType<typeof vi.fn>;
  dropFile: ReturnType<typeof vi.fn>;
} {
  const retained = new Set([retainedPath]);
  const diff = vi.fn(() => ({
    added: [],
    updated: [],
    deleted: retained.has(retainedPath) ? [retainedPath] : [],
    unchanged: []
  }));
  const dropFile = vi.fn((relPath: string) => {
    retained.delete(relPath);
  });
  return {
    index: {
      diff,
      dropFile,
      totalChunks: () => retained.size
    } as unknown as FtsIndex,
    retained,
    diff,
    dropFile
  };
}

describe("FTS destructive-diff inventory receipts", () => {
  it.each(["unreadable subtree", "depth refusal", "entry-cap refusal"])(
    "preserves retained Markdown and PDF rows on an incomplete %s receipt",
    async () => {
      const receipt: BoundedFileListing = { entries: [], visitedEntries: 7, complete: false };
      const markdownVault = fakeVault(receipt);
      const markdownIndex = fakeIndex("retained.md");
      const pdfVault = fakeVault(receipt);
      const pdfIndex = fakeIndex("retained.pdf");

      await expect(syncFtsIndex(markdownVault.vault, markdownIndex.index)).rejects.toThrow(
        /Markdown source inventory is incomplete/
      );
      await expect(syncPdfFtsIndex(pdfVault.vault, pdfIndex.index)).rejects.toThrow(
        /PDF source inventory is incomplete/
      );

      expect(markdownVault.list).toHaveBeenCalledWith([".md"], MAX_INDEX_SYNC_FILES, MAX_INDEX_SYNC_VISITED_ENTRIES);
      expect(pdfVault.list).toHaveBeenCalledWith([".pdf"], MAX_INDEX_SYNC_FILES, MAX_INDEX_SYNC_VISITED_ENTRIES);
      expect(markdownIndex.diff).not.toHaveBeenCalled();
      expect(pdfIndex.diff).not.toHaveBeenCalled();
      expect(markdownIndex.dropFile).not.toHaveBeenCalled();
      expect(pdfIndex.dropFile).not.toHaveBeenCalled();
      expect(markdownIndex.retained).toEqual(new Set(["retained.md"]));
      expect(pdfIndex.retained).toEqual(new Set(["retained.pdf"]));
    }
  );

  it("allows a complete empty inventory to commit and accurately report deletions", async () => {
    const receipt: BoundedFileListing = { entries: [], visitedEntries: 0, complete: true };
    const markdownVault = fakeVault(receipt);
    const markdownIndex = fakeIndex("removed.md");
    const pdfVault = fakeVault(receipt);
    const pdfIndex = fakeIndex("removed.pdf");

    await expect(syncFtsIndex(markdownVault.vault, markdownIndex.index)).resolves.toMatchObject({
      added: 0,
      updated: 0,
      deleted: 1,
      unchanged: 0,
      failed: 0
    });
    await expect(syncPdfFtsIndex(pdfVault.vault, pdfIndex.index)).resolves.toEqual({
      added: 0,
      updated: 0,
      deleted: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      total_chunks: 0,
      complete: true
    });

    expect(markdownIndex.retained.size).toBe(0);
    expect(pdfIndex.retained.size).toBe(0);
    expect(markdownIndex.dropFile).toHaveBeenCalledOnce();
    expect(pdfIndex.dropFile).toHaveBeenCalledOnce();
  });
});
