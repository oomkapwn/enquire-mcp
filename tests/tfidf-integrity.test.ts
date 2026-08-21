import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTfidfIndex,
  DEFAULT_TFIDF_BUILD_LIMITS,
  semanticSearch,
  TfidfCapacityError
} from "../src/tools/search.js";
import { Vault } from "../src/vault.js";

const scratchRoots: string[] = [];

async function scratchVault(files: Readonly<Record<string, string>>): Promise<{ root: string; vault: Vault }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-tfidf-integrity-"));
  scratchRoots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const file = path.join(root, relPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return { root, vault: new Vault(root) };
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("TF-IDF exact-overlap contract and generation admission", () => {
  it("returns no OOV or synonym-only documents even when min_score is zero", async () => {
    const { vault } = await scratchVault({ "Concept.md": "A car has wheels and an engine.\n" });

    const oov = await semanticSearch(vault, { query: "xyzzy", min_score: 0 });
    const synonymOnly = await semanticSearch(vault, { query: "automobile", min_score: 0 });
    const exactControl = await semanticSearch(vault, { query: "car", min_score: 0 });

    expect(oov.matches).toEqual([]);
    expect(synonymOnly.matches).toEqual([]);
    expect(exactControl.matches.map((hit) => hit.path)).toEqual(["Concept.md"]);
  });

  it("invalidates an alpha→bravo replacement with identical size and restored mtime", async () => {
    const { root, vault } = await scratchVault({ "Mutable.md": "alpha\n" });
    const target = path.join(root, "Mutable.md");
    const replacement = path.join(root, "Mutable.next.md");
    const fixedTime = new Date("2024-01-02T03:04:05.000Z");
    await fs.utimes(target, fixedTime, fixedTime);
    const beforeListing = await vault.listFilesByExtensionsBounded([".md"], 10, 100);
    const beforeState = await vault.sourceState("Mutable.md");
    expect(beforeListing.entries[0]?.sourceRevision).toBe(beforeState.sourceRevision);
    expect(beforeState.sourceRevision).toMatch(/^fs-v1:[a-f0-9]{64}$/u);

    const alpha = await semanticSearch(vault, { query: "alpha", min_score: 0 });
    expect(alpha.matches.map((hit) => hit.path)).toEqual(["Mutable.md"]);

    await fs.writeFile(replacement, "bravo\n");
    await fs.utimes(replacement, fixedTime, fixedTime);
    await fs.rename(replacement, target);
    const replaced = await fs.stat(target);
    expect(replaced.size).toBe(Buffer.byteLength("alpha\n"));
    expect(replaced.mtimeMs).toBe(fixedTime.getTime());
    expect((await vault.sourceState("Mutable.md")).sourceRevision).not.toBe(beforeState.sourceRevision);

    const bravo = await semanticSearch(vault, { query: "bravo", min_score: 0 });
    const staleAlpha = await semanticSearch(vault, { query: "alpha", min_score: 0 });
    expect(bravo.matches.map((hit) => hit.path)).toEqual(["Mutable.md"]);
    expect(staleAlpha.matches).toEqual([]);
  });

  it("drops a candidate replaced after snippet bytes are read but before terminal admission", async () => {
    const { root } = await scratchVault({ "Race.md": "alpha\n" });
    const target = path.join(root, "Race.md");
    const fixedTime = new Date("2024-02-03T04:05:06.000Z");
    await fs.utimes(target, fixedTime, fixedTime);

    class SwapAfterCandidateReadVault extends Vault {
      private reads = 0;

      override async readNoteUncached(relOrAbs: string, knownMtimeMs?: number) {
        const note = await super.readNoteUncached(relOrAbs, knownMtimeMs);
        this.reads += 1;
        if (this.reads === 2) {
          const replacement = path.join(root, "Race.next.md");
          await fs.writeFile(replacement, "bravo\n");
          await fs.utimes(replacement, fixedTime, fixedTime);
          await fs.rename(replacement, target);
        }
        return note;
      }
    }

    const vault = new SwapAfterCandidateReadVault(root);
    await expect(semanticSearch(vault, { query: "alpha", min_score: 0 })).rejects.toMatchObject({
      code: "TFIDF_GENERATION_CHANGED"
    });

    const current = await semanticSearch(vault, { query: "bravo", min_score: 0 });
    expect(current.matches.map((hit) => hit.path)).toEqual(["Race.md"]);
  });

  it("refuses an OOV empty result when a non-candidate generation changes before return", async () => {
    const { root } = await scratchVault({ "Race.md": "alpha\n" });
    const target = path.join(root, "Race.md");
    const fixedTime = new Date("2024-03-04T05:06:07.000Z");
    await fs.utimes(target, fixedTime, fixedTime);

    class SwapAfterIndexBuildVault extends Vault {
      private listings = 0;

      override async listFilesByExtensionsBounded(
        extensions: readonly string[],
        maxFiles: number,
        maxVisitedEntries: number,
        folder?: string
      ) {
        const listing = await super.listFilesByExtensionsBounded(extensions, maxFiles, maxVisitedEntries, folder);
        this.listings += 1;
        if (this.listings === 2) {
          const replacement = path.join(root, "Race.next.md");
          await fs.writeFile(replacement, "bravo\n");
          await fs.utimes(replacement, fixedTime, fixedTime);
          await fs.rename(replacement, target);
        }
        return listing;
      }
    }

    const vault = new SwapAfterIndexBuildVault(root);
    await expect(semanticSearch(vault, { query: "not-in-either-document", min_score: 0 })).rejects.toMatchObject({
      code: "TFIDF_GENERATION_CHANGED"
    });
  });

  it("scopes discovery and IDF to folder instead of building the global corpus", async () => {
    const { vault } = await scratchVault({
      "Inside/Hit.md": "alpha scoped corpus\n",
      "Outside/Noise.md": "outside noise vocabulary\n"
    });

    const result = await semanticSearch(vault, { query: "alpha", folder: "Inside", min_score: 0 });
    expect(result.total_docs).toBe(1);
    expect(result.matches.map((hit) => hit.path)).toEqual(["Inside/Hit.md"]);
  });
});

describe("TF-IDF resource envelope", () => {
  it.each([
    ["document_bytes", { maxDocumentBytes: 5 }],
    ["aggregate_bytes", { maxAggregateBytes: 5 }],
    ["document_tokens", { maxTokensPerDocument: 2 }],
    ["aggregate_tokens", { maxAggregateTokens: 2 }],
    ["document_distinct_terms", { maxDistinctTermsPerDocument: 2 }],
    ["aggregate_distinct_terms", { maxAggregateDistinctTerms: 2 }],
    ["aggregate_term_entries", { maxAggregateTermEntries: 2 }]
  ] as const)("fails closed on the %s budget", async (dimension, override) => {
    const { vault } = await scratchVault({ "Terms.md": "alpha beta gamma\n" });
    let error: unknown;
    try {
      await buildTfidfIndex(vault, undefined, override);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TfidfCapacityError);
    expect(error).toMatchObject({ code: "TFIDF_CAPACITY_EXCEEDED", dimension });
  });

  it("fails closed before retaining a prefix when document discovery is over budget", async () => {
    const { vault } = await scratchVault({ "A.md": "alpha\n", "B.md": "bravo\n" });
    await expect(buildTfidfIndex(vault, undefined, { maxDocuments: 1 })).rejects.toMatchObject({
      dimension: "documents"
    });
  });

  it("fails closed when the directory-entry inspection budget is exhausted", async () => {
    const { vault } = await scratchVault({ "A.md": "alpha\n", "B.md": "bravo\n" });
    await expect(buildTfidfIndex(vault, undefined, { maxVisitedEntries: 1 })).rejects.toMatchObject({
      dimension: "visited_entries"
    });
  });

  it("accepts the same fixture under the documented default envelope (negative control)", async () => {
    const { vault } = await scratchVault({ "Terms.md": "alpha beta gamma\n" });
    const built = await buildTfidfIndex(vault, undefined, { ...DEFAULT_TFIDF_BUILD_LIMITS });
    expect(built.docs).toHaveLength(1);
    expect(built.idf.has("alpha")).toBe(true);
  });

  it("allows injected limits to lower but not raise the production safety envelope", async () => {
    const { vault } = await scratchVault({ "Terms.md": "alpha beta gamma\n" });
    await expect(
      buildTfidfIndex(vault, undefined, { maxDocuments: DEFAULT_TFIDF_BUILD_LIMITS.maxDocuments + 1 })
    ).rejects.toThrow(/may lower but not exceed/u);
  });

  it("evicts the oldest folder index when the per-Vault scope cache is full", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`Folder${index}/Note.md`, `token${index} shared\n`])
    );
    const { root } = await scratchVault(files);
    class CountingVault extends Vault {
      reads = 0;

      override async readNoteUncached(relOrAbs: string, knownMtimeMs?: number) {
        this.reads += 1;
        return super.readNoteUncached(relOrAbs, knownMtimeMs);
      }
    }
    const vault = new CountingVault(root);
    for (let index = 0; index < 5; index += 1) await buildTfidfIndex(vault, `Folder${index}`);
    expect(vault.reads).toBe(5);

    await buildTfidfIndex(vault, "Folder0");
    expect(vault.reads, "the fifth scope must evict the oldest completed index").toBe(6);
  });
});
