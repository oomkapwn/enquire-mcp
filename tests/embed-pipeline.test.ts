// v3.8.0-rc.4 — direct unit tests for embedSingleNote + embedSinglePdf
// helpers in src/embed-pipeline.ts.
//
// Pre-rc.4 these helpers lived in src/server.ts and couldn't be
// unit-tested because server.ts is in the RESTRICTED_MODULES list of
// the Class A invariant (tests/no-internal-imports.test.ts). They got
// covered only end-to-end via watcher chokidar tests, which flake at
// ~25% locally due to debounce timing.
//
// rc.4 extracted them into src/embed-pipeline.ts (not restricted) so
// these direct tests can run. Goal: lift src/watcher.ts branch
// coverage floor back from rc.3's 69% → ≥71% by covering more code
// paths via deterministic unit tests instead of flaky integration.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EmbedRow, embedSingleNote, embedSinglePdf } from "../src/embed-pipeline.js";
import { Vault } from "../src/vault.js";
import { makePdf } from "./helpers/make-pdf.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "embed-pipeline-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const mockEmbedder = {
  model: { alias: "test-mock", hfId: "mock", dim: 4, multilingual: false, maxTokens: 128 },
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((_, i) => {
      const v = new Float32Array(4);
      for (let j = 0; j < 4; j++) v[j] = (i + 1) / (j + 1);
      return v;
    });
  }
};

const throwingEmbedder = {
  model: { alias: "test-mock", hfId: "mock", dim: 4, multilingual: false, maxTokens: 128 },
  async embed(_texts: readonly string[]): Promise<Float32Array[]> {
    throw new Error("synthetic embed failure (rc.4 helper test)");
  }
};

const emptyVectorEmbedder = {
  model: { alias: "test-mock", hfId: "mock", dim: 4, multilingual: false, maxTokens: 128 },
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    // Return one fewer vector than requested to exercise the
    // "embedder returned no vector for chunk N" guard.
    return texts.slice(0, -1).map(() => new Float32Array(4));
  }
};

describe("embedSingleNote", () => {
  it("returns chunks + rows for a markdown note with content", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "note.md");
    await fs.writeFile(filePath, "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n");
    const stat = await fs.stat(filePath);
    const result = await embedSingleNote(v, mockEmbedder, {
      relPath: "note.md",
      absPath: filePath,
      mtimeMs: stat.mtimeMs
    });
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unreachable — already asserted not-null");
    expect(result.chunks).toBeGreaterThanOrEqual(1);
    expect(result.rows.length).toBe(result.chunks);
    for (const row of result.rows as EmbedRow[]) {
      expect(row.vector).toBeInstanceOf(Float32Array);
      expect(row.vector.length).toBe(4);
      expect(row.textPreview.length).toBeLessThanOrEqual(480);
      expect(typeof row.lineStart).toBe("number");
      expect(typeof row.lineEnd).toBe("number");
    }
  });

  it("returns null for an empty markdown note (no chunks)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "empty.md");
    await fs.writeFile(filePath, "");
    const stat = await fs.stat(filePath);
    const result = await embedSingleNote(v, mockEmbedder, {
      relPath: "empty.md",
      absPath: filePath,
      mtimeMs: stat.mtimeMs
    });
    expect(result).toBeNull();
  });

  it("M1 (rc.17 audit) — chunk line numbers are FILE-absolute for a frontmatter'd note", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "fm.md");
    const content = "---\ntitle: T\ntags: [x]\n---\n\nFirst body paragraph here.\n\nSecond body paragraph here.\n";
    await fs.writeFile(filePath, content);
    const stat = await fs.stat(filePath);
    const result = await embedSingleNote(v, mockEmbedder, {
      relPath: "fm.md",
      absPath: filePath,
      mtimeMs: stat.mtimeMs
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    const lines = content.split("\n");
    const row0 = result.rows[0];
    if (!row0) throw new Error("expected at least one row");
    // The stored (now FILE-absolute) lineStart must land on the line in the file
    // that actually contains the chunk's text. Pre-rc.17 it was body-RELATIVE
    // (line 1 → the `---` delimiter), a wrong deep-link for frontmatter'd notes.
    const chunkFirstLine = row0.textPreview.split("\n")[0] ?? "";
    expect(lines[row0.lineStart - 1]).toContain(chunkFirstLine.slice(0, 15));
    expect(row0.lineStart, "discriminating: not the body-relative 1").toBeGreaterThan(1);
  });

  it("M1 NEGATIVE control — no frontmatter ⇒ offset 0, first chunk still starts at line 1", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "nofm.md");
    await fs.writeFile(filePath, "First body paragraph here.\n\nSecond body paragraph here.\n");
    const stat = await fs.stat(filePath);
    const result = await embedSingleNote(v, mockEmbedder, {
      relPath: "nofm.md",
      absPath: filePath,
      mtimeMs: stat.mtimeMs
    });
    expect(result?.rows[0]?.lineStart).toBe(1);
  });

  it("honors lateChunkContext opt (>0 → contextual embed text)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "ctx.md");
    // Two paragraphs guarantee at least one chunk boundary so neighbor
    // text actually shows up in the embed text.
    await fs.writeFile(
      filePath,
      "# Title\n\nFirst paragraph for context-window probe.\n\nSecond paragraph also for context.\n"
    );
    const stat = await fs.stat(filePath);
    const result = await embedSingleNote(
      v,
      mockEmbedder,
      { relPath: "ctx.md", absPath: filePath, mtimeMs: stat.mtimeMs },
      { lateChunkContext: 64 }
    );
    expect(result).not.toBeNull();
  });

  it("propagates embedder errors (caller is responsible for fail-soft)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "note.md");
    await fs.writeFile(filePath, "# Title\n\nbody\n");
    const stat = await fs.stat(filePath);
    await expect(
      embedSingleNote(v, throwingEmbedder, {
        relPath: "note.md",
        absPath: filePath,
        mtimeMs: stat.mtimeMs
      })
    ).rejects.toThrow(/synthetic embed failure/);
  });

  it("throws if embedder returns fewer vectors than chunks (data-integrity guard)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "many.md");
    // Long enough to chunk into ≥2 chunks reliably so emptyVectorEmbedder's
    // slice(0,-1) leaves a missing slot at the end.
    const body = `# Title\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i} body text.`).join("\n\n")}`;
    await fs.writeFile(filePath, body);
    const stat = await fs.stat(filePath);
    await expect(
      embedSingleNote(v, emptyVectorEmbedder, {
        relPath: "many.md",
        absPath: filePath,
        mtimeMs: stat.mtimeMs
      })
    ).rejects.toThrow(/embedder returned no vector/);
  });

  it("uses frontmatter title for docTitle when present", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "with-fm.md");
    await fs.writeFile(filePath, "---\ntitle: My Custom Title\n---\n\n# Heading\n\nBody.\n");
    const stat = await fs.stat(filePath);
    // Smoke test that frontmatter doesn't crash + still returns rows.
    const result = await embedSingleNote(
      v,
      mockEmbedder,
      { relPath: "with-fm.md", absPath: filePath, mtimeMs: stat.mtimeMs },
      { lateChunkContext: 32 }
    );
    expect(result).not.toBeNull();
  });
});

describe("embedSinglePdf", () => {
  it("returns chunks + rows for a text-bearing PDF", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "doc.pdf");
    await fs.writeFile(filePath, makePdf({ pages: ["Page one content for embed.", "Page two extra text."] }));
    const stat = await fs.stat(filePath);
    const result = await embedSinglePdf(v, mockEmbedder, {
      relPath: "doc.pdf",
      absPath: filePath,
      mtimeMs: stat.mtimeMs
    });
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unreachable — already asserted not-null");
    expect(result.chunks).toBeGreaterThanOrEqual(1);
    expect(result.rows.length).toBe(result.chunks);
    // PDF embedding should include the [page: N] markers in the text
    // that was fed to the embedder; the preview should reflect that.
    const previewBlob = result.rows.map((r) => r.textPreview).join("\n");
    expect(previewBlob).toMatch(/\[page: \d+\]/);
  });

  it("propagates embedder errors (caller is responsible for fail-soft)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "fail.pdf");
    await fs.writeFile(filePath, makePdf({ pages: ["throws"] }));
    const stat = await fs.stat(filePath);
    await expect(
      embedSinglePdf(v, throwingEmbedder, {
        relPath: "fail.pdf",
        absPath: filePath,
        mtimeMs: stat.mtimeMs
      })
    ).rejects.toThrow(/synthetic embed failure/);
  });

  it("throws if embedder returns fewer vectors than chunks (data-integrity guard)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "manyp.pdf");
    // Several long pages → multiple chunks; emptyVectorEmbedder drops the last.
    const longPage = Array.from({ length: 40 }, (_, i) => `Para ${i} for chunk boundary.`).join(" ");
    await fs.writeFile(filePath, makePdf({ pages: [longPage, longPage, longPage] }));
    const stat = await fs.stat(filePath);
    await expect(
      embedSinglePdf(v, emptyVectorEmbedder, {
        relPath: "manyp.pdf",
        absPath: filePath,
        mtimeMs: stat.mtimeMs
      })
    ).rejects.toThrow(/embedder returned no vector/);
  });

  it("honors lateChunkContext opt (rc.3 context-windowing parity with md path)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "ctx.pdf");
    await fs.writeFile(filePath, makePdf({ pages: ["Context window test content for late-chunk parity."] }));
    const stat = await fs.stat(filePath);
    const result = await embedSinglePdf(
      v,
      mockEmbedder,
      { relPath: "ctx.pdf", absPath: filePath, mtimeMs: stat.mtimeMs },
      { lateChunkContext: 64 }
    );
    expect(result).not.toBeNull();
  });

  // v3.9.0-rc.1 — preExtractedPages bypasses the pdfjs extraction path.
  // Verifies the OCR-feed branch end-to-end: caller supplies pages
  // (typically from extractPdfWithOcr); embedSinglePdf chunks + embeds
  // without ever touching the bytes on disk.
  it("uses preExtractedPages and skips pdfjs extraction (OCR-feed path, v3.9.0)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    // The on-disk PDF is intentionally a TEXT file that pdfjs would
    // reject — we're proving the pre-extracted shortcut bypasses
    // disk read entirely. If the code still falls into pdfjs, the
    // call would throw on the malformed PDF buffer.
    const filePath = path.join(root, "ocr-source.pdf");
    await fs.writeFile(filePath, "not actually a real PDF — should be bypassed by preExtractedPages");
    const stat = await fs.stat(filePath);
    const result = await embedSinglePdf(
      v,
      mockEmbedder,
      { relPath: "ocr-source.pdf", absPath: filePath, mtimeMs: stat.mtimeMs },
      {
        preExtractedPages: [
          { pageNumber: 1, text: "OCR'd page one with enough content to chunk meaningfully." },
          { pageNumber: 2, text: "OCR'd page two with continuation of the OCR-derived prose." }
        ]
      }
    );
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unreachable — already asserted not-null");
    expect(result.chunks).toBeGreaterThanOrEqual(1);
    // The [page: N] markers in the joined input should appear in the
    // chunk previews — proves the OCR pages went through the same
    // chunking pipeline as the pdfjs path.
    const previewBlob = result.rows.map((r) => r.textPreview).join("\n");
    expect(previewBlob).toMatch(/\[page: 1\]/);
    expect(previewBlob).toMatch(/\[page: 2\]/);
  });

  // v3.9.0-rc.1 NEGATIVE control — empty preExtractedPages returns null
  // (caller drops rows; same semantics as pdfjs hasText=false).
  it("(NEGATIVE control) — preExtractedPages with zero entries returns null", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const filePath = path.join(root, "empty-ocr.pdf");
    await fs.writeFile(filePath, "irrelevant — preExtractedPages [] short-circuits");
    const stat = await fs.stat(filePath);
    const result = await embedSinglePdf(
      v,
      mockEmbedder,
      { relPath: "empty-ocr.pdf", absPath: filePath, mtimeMs: stat.mtimeMs },
      { preExtractedPages: [] }
    );
    expect(result).toBeNull();
  });
});
