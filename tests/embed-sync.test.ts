import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedDb } from "../src/embed-db.js";
import {
  type EmbedSyncCounters,
  EmbedSyncIncompleteError,
  finalizeEmbedSyncEvidence,
  syncEmbedDb,
  syncPdfEmbedDb
} from "../src/embed-sync.js";
import type { Embedder } from "../src/embeddings.js";
import { Vault } from "../src/vault.js";
import { makePdf } from "./helpers/make-pdf.js";

const DIM = 4;
const MODEL = {
  alias: "test-mock",
  hfId: "test/mock",
  dim: DIM,
  approxSizeMB: 0,
  dtype: "q8" as const,
  multilingual: true,
  maxTokens: 128
};

let root: string;
let openDbs: EmbedDb[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-sync-"));
  openDbs = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of openDbs) db.close();
  await fs.rm(root, { recursive: true, force: true });
});

function deterministicEmbedder(failNeedle?: string): Embedder {
  return {
    model: MODEL,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (failNeedle && texts.some((text) => text.includes(failNeedle))) {
        throw new Error(`synthetic embed failure for ${failNeedle}`);
      }
      return texts.map((text, index) => {
        const seed = [...text].reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), index + 1);
        const vector = new Float32Array([1, (seed % 7) + 1, (seed % 11) + 1, (seed % 13) + 1]);
        const norm = Math.sqrt([...vector].reduce((sum, value) => sum + value * value, 0));
        for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
        return vector;
      });
    }
  };
}

async function openDb(): Promise<EmbedDb> {
  const db = new EmbedDb({
    file: path.join(root, ".cache", "test.embed.db"),
    vaultRoot: root,
    modelAlias: MODEL.alias,
    dim: DIM
  });
  await db.open();
  openDbs.push(db);
  return db;
}

async function writeNote(relPath: string, content: string): Promise<string> {
  const absPath = path.join(root, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
  return absPath;
}

function seedPriorRow(db: EmbedDb, relPath: string, mtimeMs = 1, kind: "md" | "pdf" = "md"): void {
  db.upsertNote(
    relPath,
    mtimeMs,
    [
      {
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 1,
        textPreview: "prior canonical row",
        vector: new Float32Array([1, 0, 0, 0])
      }
    ],
    kind
  );
}

function expectPriorRowPreserved(
  db: EmbedDb,
  relPath: string,
  kind: "md" | "pdf" = "md",
  quarantined = false
): void {
  expect(db.getSourceStates(kind).find((state) => state.rel_path === relPath)).toEqual({
    rel_path: relPath,
    mtime_ms: 1
  });
  const hit = db.search(new Float32Array([1, 0, 0, 0]), 5).find((row) => row.rel_path === relPath);
  if (quarantined) {
    expect(hit).toBeUndefined();
    expect(db.getQuarantinedPaths(kind)).toContain(relPath);
  } else {
    expect(hit).toEqual(
      expect.objectContaining({
        rel_path: relPath,
        chunk_index: 0,
        text_preview: "prior canonical row",
        kind
      })
    );
    expect(db.getQuarantinedPaths(kind)).not.toContain(relPath);
  }
}

describe("bulk embedding synchronization evidence", () => {
  it("strict Markdown sync returns exact complete evidence across add, update, unchanged, and delete", async () => {
    const alphaPath = await writeNote("alpha.md", "Alpha body with searchable context.\n");
    await writeNote("beta.md", "Beta body with other searchable context.\n");
    const vault = new Vault(root);
    const db = await openDb();
    seedPriorRow(db, "paper.pdf", 1, "pdf");

    const first = await syncEmbedDb(vault, db, deterministicEmbedder(), { mode: "strict" });
    expect(first).toEqual({
      mode: "strict",
      audited: true,
      added: 2,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      total_chunks: 3,
      total_files: 2,
      processed_files: 2,
      empty: 0,
      failed: 0,
      indexed_files: 2,
      declared_chunks: 2,
      indexed_chunks: 2,
      mismatched_files: 0,
      invalid_vectors: 0,
      manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      complete: true
    });
    expectPriorRowPreserved(db, "paper.pdf", "pdf");

    const unchanged = await syncEmbedDb(vault, db, deterministicEmbedder(), { mode: "strict" });
    expect(unchanged).toMatchObject({
      added: 0,
      updated: 0,
      deleted: 0,
      unchanged: 2,
      total_files: 2,
      processed_files: 2,
      complete: true
    });

    await fs.unlink(path.join(root, "beta.md"));
    await fs.writeFile(alphaPath, "Alpha body changed after the first strict sync.\n");
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(alphaPath, future, future);
    const changed = await syncEmbedDb(vault, db, deterministicEmbedder(), { mode: "strict" });
    expect(changed).toMatchObject({
      added: 0,
      updated: 1,
      deleted: 1,
      unchanged: 0,
      total_chunks: 2,
      total_files: 1,
      processed_files: 1,
      indexed_files: 1,
      declared_chunks: 1,
      indexed_chunks: 1,
      mismatched_files: 0,
      complete: true
    });
    expectPriorRowPreserved(db, "paper.pdf", "pdf");
  });

  it("default fail-soft mode records an injected failure and continues with the next note", async () => {
    await writeNote("a-failing.md", "FAIL_NEEDLE must make this note fail.\n");
    await writeNote("z-sibling.md", "The later sibling must still be embedded.\n");
    const db = await openDb();
    const auditSpy = vi.spyOn(db, "auditKind");
    const vectorAuditSpy = vi.spyOn(db, "auditVectorHealth");
    const manifestSpy = vi.spyOn(db, "fingerprintKind");

    const report = await syncEmbedDb(new Vault(root), db, deterministicEmbedder("FAIL_NEEDLE"));

    expect(report).toEqual({
      mode: "fail-soft",
      audited: false,
      added: 1,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      total_chunks: 1,
      total_files: 2,
      processed_files: 2,
      empty: 0,
      failed: 1,
      indexed_files: 0,
      declared_chunks: 0,
      indexed_chunks: 0,
      mismatched_files: 0,
      invalid_vectors: 0,
      manifest_sha256: null,
      complete: false
    });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(vectorAuditSpy).not.toHaveBeenCalled();
    expect(manifestSpy).not.toHaveBeenCalled();
    expect(db.getSourceStates("md")).toEqual([
      expect.objectContaining({
        rel_path: "z-sibling.md"
      })
    ]);
    expect(db.getQuarantinedPaths("md")).toEqual(["a-failing.md"]);
  });

  it("strict injected failure rejects without a report and preserves the bad note's prior rows and state", async () => {
    await writeNote("a-failing.md", "FAIL_NEEDLE must reject strict synchronization.\n");
    await writeNote("z-unreached.md", "Strict fail-fast must not reach this sibling.\n");
    const db = await openDb();
    seedPriorRow(db, "a-failing.md");

    let result: unknown;
    let caught: unknown;
    try {
      result = await syncEmbedDb(new Vault(root), db, deterministicEmbedder("FAIL_NEEDLE"), { mode: "strict" });
    } catch (error) {
      caught = error;
    }

    expect(result).toBeUndefined();
    expect(caught).toBeInstanceOf(EmbedSyncIncompleteError);
    if (!(caught instanceof EmbedSyncIncompleteError)) throw new Error("expected strict sync rejection");
    expect(caught.report).toBeNull();
    expect(caught.message).toContain("a-failing.md");
    expect(caught.cause).toBeInstanceOf(Error);
    expectPriorRowPreserved(db, "a-failing.md", "md", true);
    expect(db.getSourceStates("md").some((state) => state.rel_path === "z-unreached.md")).toBe(false);
  });

  it("strict frontmatter-only rejection preserves a prior canonical row instead of deleting it", async () => {
    await writeNote("metadata-only.md", "---\ntitle: Metadata only\n---\n");
    const db = await openDb();
    seedPriorRow(db, "metadata-only.md");

    const sync = syncEmbedDb(new Vault(root), db, deterministicEmbedder(), { mode: "strict" });
    await expect(sync).rejects.toThrow("note has no embeddable chunks");

    expectPriorRowPreserved(db, "metadata-only.md", "md", true);

    await assertSameMtimeMarkdownQuarantineRetry();
  });

  async function assertSameMtimeMarkdownQuarantineRetry(): Promise<void> {
    const scenarioRoot = path.join(root, "same-mtime-quarantine-retry");
    await fs.mkdir(scenarioRoot, { recursive: true });
    const absPath = path.join(scenarioRoot, "retry.md");
    await fs.writeFile(absPath, "Healthy content must be embedded on the forced retry.\n");
    const stat = await fs.stat(absPath);
    const db = new EmbedDb({
      file: path.join(scenarioRoot, ".cache", "test.embed.db"),
      vaultRoot: scenarioRoot,
      modelAlias: MODEL.alias,
      dim: DIM
    });
    await db.open();
    openDbs.push(db);
    seedPriorRow(db, "retry.md", stat.mtimeMs);
    db.quarantineSource("retry.md", "md");
    const embedder = deterministicEmbedder();
    const embedSpy = vi.spyOn(embedder, "embed");

    const report = await syncEmbedDb(new Vault(scenarioRoot), db, embedder);

    expect(embedSpy).toHaveBeenCalled();
    expect(report).toMatchObject({ updated: 1, unchanged: 0, failed: 0 });
    expect(db.getQuarantinedPaths("md")).toEqual([]);
    expect(db.search(new Float32Array([1, 0, 0, 0]), 5).some((hit) => hit.rel_path === "retry.md")).toBe(true);
  }

  it("strict PDF sync uses the same complete evidence contract for a text PDF", async () => {
    await fs.writeFile(path.join(root, "paper.pdf"), makePdf({ pages: ["Evidence-grade PDF body"] }));
    const db = await openDb();
    seedPriorRow(db, "note.md");

    const report = await syncPdfEmbedDb(new Vault(root), db, deterministicEmbedder(), { mode: "strict" });

    expect(report).toEqual({
      mode: "strict",
      audited: true,
      added: 1,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      total_chunks: 2,
      total_files: 1,
      processed_files: 1,
      empty: 0,
      failed: 0,
      indexed_files: 1,
      declared_chunks: 1,
      indexed_chunks: 1,
      mismatched_files: 0,
      invalid_vectors: 0,
      manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      complete: true
    });
    expect(db.getSourceStates("pdf")).toEqual([expect.objectContaining({ rel_path: "paper.pdf" })]);
    expectPriorRowPreserved(db, "note.md");
  });

  it("PDF fail-soft continues after an embed error while strict mode preserves the failed file", async () => {
    await fs.writeFile(path.join(root, "0-empty.pdf"), makePdf({ pages: [""] }));
    await fs.writeFile(path.join(root, "a-failing.pdf"), makePdf({ pages: ["FAIL_NEEDLE in this PDF"] }));
    await fs.writeFile(path.join(root, "z-sibling.pdf"), makePdf({ pages: ["A healthy sibling PDF"] }));
    const db = await openDb();
    seedPriorRow(db, "0-empty.pdf", 1, "pdf");
    seedPriorRow(db, "a-failing.pdf", 1, "pdf");

    await expect(
      syncPdfEmbedDb(new Vault(root), db, deterministicEmbedder("FAIL_NEEDLE"), { mode: "strict" })
    ).rejects.toThrow("strict PDF embed sync rejected 0-empty.pdf");
    expectPriorRowPreserved(db, "0-empty.pdf", "pdf", true);

    const failSoft = await syncPdfEmbedDb(new Vault(root), db, deterministicEmbedder("FAIL_NEEDLE"));
    expect(failSoft).toMatchObject({
      mode: "fail-soft",
      added: 1,
      empty: 1,
      failed: 1,
      total_files: 3,
      processed_files: 3,
      indexed_files: 0,
      mismatched_files: 0,
      complete: false
    });
    expect(db.getSourceStates("pdf").some((state) => state.rel_path === "0-empty.pdf")).toBe(false);
    expectPriorRowPreserved(db, "a-failing.pdf", "pdf", true);
    expect(db.getSourceStates("pdf").some((state) => state.rel_path === "z-sibling.pdf")).toBe(true);

    await fs.unlink(path.join(root, "0-empty.pdf"));
    await expect(
      syncPdfEmbedDb(new Vault(root), db, deterministicEmbedder("FAIL_NEEDLE"), { mode: "strict" })
    ).rejects.toThrow("strict PDF embed sync rejected a-failing.pdf");
    expectPriorRowPreserved(db, "a-failing.pdf", "pdf", true);

    await assertMarkerOnlyEmptyPdfHealing();
  });

  async function assertMarkerOnlyEmptyPdfHealing(): Promise<void> {
    const scenarioRoot = path.join(root, "marker-only-pdf-retry");
    await fs.mkdir(scenarioRoot, { recursive: true });
    await fs.writeFile(path.join(scenarioRoot, "marker-only.pdf"), makePdf({ pages: [""] }));
    const db = new EmbedDb({
      file: path.join(scenarioRoot, ".cache", "test.embed.db"),
      vaultRoot: scenarioRoot,
      modelAlias: MODEL.alias,
      dim: DIM
    });
    await db.open();
    openDbs.push(db);
    db.quarantineSource("marker-only.pdf", "pdf");
    expect(db.getSourceStates("pdf")).toEqual([]);
    expect(db.getQuarantinedPaths("pdf")).toEqual(["marker-only.pdf"]);

    const report = await syncPdfEmbedDb(new Vault(scenarioRoot), db, deterministicEmbedder());

    expect(report).toMatchObject({ added: 0, updated: 0, empty: 1, failed: 0, mismatched_files: 0 });
    expect(db.getSourceStates("pdf")).toEqual([]);
    expect(db.getQuarantinedPaths("pdf")).toEqual([]);
  }

  it("(negative control) strict mode rejects a forged final physical audit with its evidence attached", async () => {
    await writeNote("note.md", "A valid note whose final audit will be replaced.\n");
    const db = await openDb();
    vi.spyOn(db, "auditKind").mockReturnValue({
      indexed_files: 1,
      declared_chunks: 1,
      indexed_chunks: 0,
      mismatched_files: 1
    });

    let caught: unknown;
    try {
      await syncEmbedDb(new Vault(root), db, deterministicEmbedder(), { mode: "strict" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EmbedSyncIncompleteError);
    if (!(caught instanceof EmbedSyncIncompleteError)) throw new Error("expected final strict audit rejection");
    expect(caught.report).toMatchObject({
      indexed_files: 1,
      declared_chunks: 1,
      indexed_chunks: 0,
      mismatched_files: 1,
      complete: false
    });
    expect(db.totalChunks()).toBe(1);
  });
});

describe("finalizeEmbedSyncEvidence", () => {
  const counters: EmbedSyncCounters = {
    added: 2,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    totalFiles: 2,
    processedFiles: 2,
    empty: 0,
    failed: 0
  };
  const audit = {
    indexed_files: 2,
    declared_chunks: 3,
    indexed_chunks: 3,
    mismatched_files: 0
  };
  const integrity = {
    audited: true,
    invalidVectors: 0,
    manifestSha256: "a".repeat(64)
  };

  it("derives a complete report from mutually consistent raw counters and audit rows", () => {
    expect(finalizeEmbedSyncEvidence("strict", counters, audit, 3, integrity)).toEqual({
      mode: "strict",
      audited: true,
      added: 2,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      total_chunks: 3,
      total_files: 2,
      processed_files: 2,
      empty: 0,
      failed: 0,
      indexed_files: 2,
      declared_chunks: 3,
      indexed_chunks: 3,
      mismatched_files: 0,
      invalid_vectors: 0,
      manifest_sha256: "a".repeat(64),
      complete: true
    });
  });

  it("(negative controls) recomputes completeness instead of trusting forged counters or audit fields", () => {
    const forgedCounters = {
      ...counters,
      added: 1,
      complete: true
    };
    expect(finalizeEmbedSyncEvidence("strict", forgedCounters, audit, 3, integrity).complete).toBe(false);

    const forgedAudit = {
      ...audit,
      indexed_chunks: 2,
      complete: true
    };
    expect(finalizeEmbedSyncEvidence("strict", counters, forgedAudit, 3, integrity).complete).toBe(false);

    expect(
      finalizeEmbedSyncEvidence(
        "strict",
        counters,
        {
          ...audit,
          mismatched_files: 1
        },
        3,
        integrity
      ).complete
    ).toBe(false);

    expect(
      finalizeEmbedSyncEvidence(
        "strict",
        {
          ...counters,
          added: 3,
          unchanged: -1
        },
        audit,
        3,
        integrity
      ).complete
    ).toBe(false);
    expect(finalizeEmbedSyncEvidence("strict", counters, audit, Number.MAX_SAFE_INTEGER + 1, integrity).complete).toBe(
      false
    );
    expect(
      finalizeEmbedSyncEvidence("strict", counters, audit, 3, {
        ...integrity,
        invalidVectors: 1
      }).complete
    ).toBe(false);
    expect(
      finalizeEmbedSyncEvidence("strict", counters, audit, 3, {
        ...integrity,
        manifestSha256: null
      }).complete
    ).toBe(false);
  });
});
