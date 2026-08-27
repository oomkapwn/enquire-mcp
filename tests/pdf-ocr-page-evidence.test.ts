import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const MODEL = {
  alias: "page-evidence-test",
  hfId: "test/page-evidence",
  dim: 4,
  approxSizeMB: 0,
  dtype: "q8" as const,
  multilingual: true,
  maxTokens: 128
};

const embedder = {
  model: MODEL,
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  }
};

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  vi.doUnmock("@napi-rs/canvas");
  vi.doUnmock("tesseract.js");
  vi.doUnmock("../src/pdf.js");
  vi.doUnmock("../src/ocr.js");
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("PDF page evidence", () => {
  it("distinguishes failed, genuinely empty, and successful pages and always cleans acquired pages", async () => {
    const pageCleanups = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const documentCleanup = vi.fn(async () => {});
    const loadingDestroy = vi.fn(async () => {});
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 4,
          getPage: async (pageNumber: number) => {
            if (pageNumber === 4) throw new Error("private /Users/alex/page-load-secret");
            return {
              streamTextContent: () =>
                new ReadableStream({
                  start(controller) {
                    if (pageNumber === 1) {
                      controller.error(new Error("private /Users/alex/secret.pdf parser detail"));
                      return;
                    }
                    controller.enqueue(pageNumber === 2 ? { items: [] } : { items: [{ str: "proved text" }] });
                    controller.close();
                  }
                }),
              cleanup: pageCleanups[pageNumber - 1]
            };
          },
          getMetadata: async () => ({ info: {} }),
          cleanup: documentCleanup
        }),
        destroy: loadingDestroy
      })
    }));

    const { assertPdfPagesComplete, extractPdfText, PdfPageExtractionError } = await import("../src/pdf.js");
    const result = await extractPdfText(Buffer.from("mock PDF bytes"));

    expect(result.pages).toEqual([
      {
        pageNumber: 1,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        failure: {
          code: "PDF_TEXT_EXTRACTION_FAILED",
          detail: "PDF page text could not be extracted"
        }
      },
      { pageNumber: 2, text: "", status: "empty", isEmpty: true, charCount: 0 },
      { pageNumber: 3, text: "proved text", status: "ok", isEmpty: false, charCount: 11 },
      {
        pageNumber: 4,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        failure: { code: "PDF_PAGE_LOAD_FAILED", detail: "PDF page could not be loaded" }
      }
    ]);
    expect(result).toMatchObject({ hasText: true, complete: false, fullText: "proved text" });
    expect(JSON.stringify(result.pages[0])).not.toContain("/Users/alex");
    expect(Buffer.byteLength(result.pages[0]?.failure?.detail ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(() => assertPdfPagesComplete(result.pages)).toThrow(PdfPageExtractionError);
    for (const cleanup of pageCleanups.slice(0, 3)) expect(cleanup).toHaveBeenCalledTimes(1);
    expect(pageCleanups[3]).not.toHaveBeenCalled();
    expect(documentCleanup).toHaveBeenCalledTimes(1);
    expect(loadingDestroy).toHaveBeenCalledTimes(1);
  });

  it("rejects non-finite/non-safe numeric options before parsing and rejects a range beyond the document", async () => {
    const documentCleanup = vi.fn(async () => {});
    const loadingDestroy = vi.fn(async () => {});
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async () => ({
          streamTextContent: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue({ items: [] });
                controller.close();
              }
            }),
          cleanup: () => {}
        }),
        getMetadata: async () => ({ info: {} }),
        cleanup: documentCleanup
      }),
      destroy: loadingDestroy
    }));
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument }));
    const { extractPdfText } = await import("../src/pdf.js");

    const invalidOptions = [
      { pageRange: { from: Number.NaN, to: 1 } },
      { pageRange: { from: 1, to: Number.POSITIVE_INFINITY } },
      { pageRange: { from: 1.5, to: 2 } },
      { pageRange: { from: 0, to: 1 } },
      { pageRange: { from: 2, to: 1 } },
      { maxPages: Number.NaN },
      { maxPages: Number.POSITIVE_INFINITY },
      { maxPages: 1.5 },
      { maxPages: 0 },
      { maxPages: Number.MAX_SAFE_INTEGER + 1 }
    ];
    for (const options of invalidOptions) {
      await expect(extractPdfText(Buffer.from("unused"), options)).rejects.toThrow(/safe integer|invalid page range/);
    }
    expect(getDocument).not.toHaveBeenCalled();

    await expect(extractPdfText(Buffer.from("mock PDF bytes"), { pageRange: { from: 3, to: 3 } })).rejects.toThrow(
      /beyond the document/
    );
    expect(documentCleanup).toHaveBeenCalledTimes(1);
    expect(loadingDestroy).toHaveBeenCalledTimes(1);
  });
});

describe("OCR page evidence", () => {
  it("surfaces every OCR page phase, preserves genuine empty, nulls invalid confidence, and cleans acquired pages", async () => {
    const langPath = await temporaryRoot("enquire-ocr-evidence-");
    await fs.writeFile(path.join(langPath, "eng.traineddata"), "fake");
    const pageCleanups = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const documentCleanup = vi.fn(async () => {});
    const loadingDestroy = vi.fn(async () => {});
    const workerTerminate = vi.fn(async () => {});
    let canvasCall = 0;
    let recognitionCall = 0;

    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 6,
          getPage: async (pageNumber: number) => {
            if (pageNumber === 1) throw new Error("private /Users/alex/load-secret");
            return {
              getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 80 * scale }),
              render: () => ({
                promise:
                  pageNumber === 2 ? Promise.reject(new Error("private /Users/alex/render-secret")) : Promise.resolve(),
                cancel: vi.fn()
              }),
              cleanup: pageCleanups[pageNumber - 1]
            };
          },
          cleanup: documentCleanup
        }),
        destroy: loadingDestroy
      })
    }));
    vi.doMock("@napi-rs/canvas", () => ({
      createCanvas: (width: number, height: number) => {
        canvasCall += 1;
        const currentCanvas = canvasCall;
        return {
          width,
          height,
          getContext: () => ({ fillStyle: "", fillRect: () => {} }),
          encode: async () => {
            if (currentCanvas === 2) throw new Error("private /Users/alex/encode-secret");
            return Buffer.from("png");
          }
        };
      }
    }));
    vi.doMock("tesseract.js", () => ({
      createWorker: async () => ({
        recognize: async () => {
          recognitionCall += 1;
          if (recognitionCall === 1) throw new Error("private /Users/alex/recognition-secret");
          return recognitionCall === 2
            ? { data: { text: "", confidence: 0 } }
            : { data: { text: "recognized text", confidence: Number.POSITIVE_INFINITY } };
        },
        terminate: workerTerminate
      })
    }));

    const { assertOcrPagesComplete, extractPdfWithOcr, OcrPageExtractionError } = await import("../src/ocr.js");
    const result = await extractPdfWithOcr(Buffer.from("mock PDF bytes"), {
      langPath,
      langs: "eng",
      timeoutMs: 1_000
    });

    expect(result.pages).toEqual([
      {
        pageNumber: 1,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        confidence: null,
        failure: { code: "OCR_PAGE_LOAD_FAILED", detail: "OCR source page could not be loaded" }
      },
      {
        pageNumber: 2,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        confidence: null,
        failure: { code: "OCR_PAGE_RENDER_FAILED", detail: "OCR source page could not be rendered" }
      },
      {
        pageNumber: 3,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        confidence: null,
        failure: { code: "OCR_PAGE_ENCODE_FAILED", detail: "OCR page bitmap could not be encoded" }
      },
      {
        pageNumber: 4,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        confidence: null,
        failure: { code: "OCR_PAGE_RECOGNITION_FAILED", detail: "OCR recognition failed for the page" }
      },
      { pageNumber: 5, text: "", status: "empty", isEmpty: true, charCount: 0, confidence: 0 },
      {
        pageNumber: 6,
        text: "recognized text",
        status: "ok",
        isEmpty: false,
        charCount: 15,
        confidence: null
      }
    ]);
    expect(result).toMatchObject({ complete: false, hasText: true, meanConfidence: null });
    expect(JSON.stringify(result.pages[0])).not.toContain("/Users/alex");
    expect(() => assertOcrPagesComplete(result.pages)).toThrow(OcrPageExtractionError);
    expect(pageCleanups[0]).not.toHaveBeenCalled();
    for (const cleanup of pageCleanups.slice(1)) expect(cleanup).toHaveBeenCalledTimes(1);
    expect(workerTerminate).toHaveBeenCalledTimes(1);
    expect(documentCleanup).toHaveBeenCalledTimes(1);
    expect(loadingDestroy).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed numeric bounds without loading OCR dependencies", async () => {
    const pdfLoad = vi.fn();
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: pdfLoad }));
    vi.doMock("@napi-rs/canvas", () => ({ createCanvas: vi.fn() }));
    vi.doMock("tesseract.js", () => ({ createWorker: vi.fn() }));
    const { clampOcrScale, extractPdfWithOcr, resolveOcrPageRange } = await import("../src/ocr.js");

    for (const maxPages of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(extractPdfWithOcr(Buffer.from("unused"), { maxPages })).rejects.toThrow(/positive safe integer/);
    }
    for (const scale of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      await expect(extractPdfWithOcr(Buffer.from("unused"), { scale })).rejects.toThrow(/finite positive/);
    }
    for (const pages of [
      [Number.NaN, 1],
      [1, Number.POSITIVE_INFINITY],
      [1.5, 2],
      [0, 1],
      [2, 1]
    ]) {
      await expect(extractPdfWithOcr(Buffer.from("unused"), { pages: pages as [number, number] })).rejects.toThrow(
        /safe integer|greater than/
      );
    }
    expect(pdfLoad).not.toHaveBeenCalled();
    expect(() => resolveOcrPageRange([3, 3], 2)).toThrow(/beyond the document/);
    expect(() => resolveOcrPageRange([1, 1], Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
    expect(() => clampOcrScale(Number.NaN, 100, 2)).toThrow(/finite positive/);
    expect(() => clampOcrScale(100, 100, Number.POSITIVE_INFINITY)).toThrow(/finite positive/);
  });

  it("keeps the public OCR envelope JSON-safe when confidence is unavailable", async () => {
    const root = await temporaryRoot("enquire-ocr-envelope-");
    await fs.writeFile(path.join(root, "scan.pdf"), "mock scan bytes");
    vi.doMock("../src/ocr.js", () => ({
      extractPdfWithOcr: vi.fn(async () => ({
        pages: [
          {
            pageNumber: 1,
            text: "",
            status: "failed",
            isEmpty: true,
            charCount: 0,
            confidence: null,
            failure: { code: "OCR_PAGE_RENDER_FAILED", detail: "OCR source page could not be rendered" }
          }
        ],
        fullText: "",
        pageCount: 1,
        hasText: false,
        complete: false,
        meanConfidence: null,
        langs: "eng"
      }))
    }));
    const [{ Vault }, { ocrPdf }] = await Promise.all([import("../src/vault.js"), import("../src/tools/media.js")]);

    const result = await ocrPdf(new Vault(root), { path: "scan.pdf" });

    expect(result).toMatchObject({ complete: false, mean_confidence: null });
    expect(result.pages[0]).toMatchObject({ status: "failed", confidence: null });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

async function mockPdfExtraction(status: "failed" | "empty"): Promise<void> {
  vi.doMock("../src/pdf.js", async () => {
    const actual = await vi.importActual<typeof import("../src/pdf.js")>("../src/pdf.js");
    const pages =
      status === "failed"
        ? [
            { pageNumber: 1, text: "partial new text", status: "ok" as const, isEmpty: false, charCount: 16 },
            {
              pageNumber: 2,
              text: "",
              status: "failed" as const,
              isEmpty: true,
              charCount: 0,
              failure: {
                code: "PDF_TEXT_EXTRACTION_FAILED" as const,
                detail: "PDF page text could not be extracted"
              }
            }
          ]
        : [{ pageNumber: 1, text: "", status: "empty" as const, isEmpty: true, charCount: 0 }];
    return {
      ...actual,
      extractPdfText: vi.fn(async () => ({
        pages,
        fullText: status === "failed" ? "partial new text" : "",
        pageCount: pages.length,
        hasText: status === "failed",
        complete: status === "empty",
        metadata: {}
      }))
    };
  });
}

async function seedPdfEmbedRow(db: import("../src/embed-db.js").EmbedDb, relPath: string): Promise<void> {
  db.upsertNote(
    relPath,
    1,
    [
      {
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 1,
        textPreview: "prior semantic evidence",
        vector: new Float32Array([1, 0, 0, 0])
      }
    ],
    "pdf"
  );
}

describe("durable PDF generation admission", () => {
  it("server sync, embed sync, and watcher preserve prior FTS/embed/HNSW generations on any failed page", async () => {
    await mockPdfExtraction("failed");
    const root = await temporaryRoot("enquire-pdf-generation-fail-");
    const relPath = "paper.pdf";
    const absPath = path.join(root, relPath);
    await fs.writeFile(absPath, "mock changed PDF bytes");

    const [
      { Vault },
      { FtsIndex },
      { EmbedDb },
      { syncPdfFtsIndex },
      { syncPdfEmbedDb },
      { VaultWatcher },
      { readPdf }
    ] = await Promise.all([
      import("../src/vault.js"),
      import("../src/fts5.js"),
      import("../src/embed-db.js"),
      import("../src/fts5.js"),
      import("../src/embed-sync.js"),
      import("../src/watcher.js"),
      import("../src/tools/media.js")
    ]);
    const vault = new Vault(root);
    await vault.ensureExists();
    const fts = new FtsIndex({ file: path.join(root, ".cache", "test.fts5.db"), vaultRoot: root });
    await fts.open();
    const db = new EmbedDb({
      file: path.join(root, ".cache", "test.embed.db"),
      vaultRoot: root,
      modelAlias: MODEL.alias,
      dim: MODEL.dim
    });
    await db.open();
    fts.reindexPdfFile(relPath, 1, [{ pageNumber: 1, text: "prior lexical evidence" }]);
    await seedPdfEmbedRow(db, relPath);
    const ftsReindex = vi.spyOn(fts, "reindexPdfFile");
    const ftsDrop = vi.spyOn(fts, "dropFile");
    const embedUpsert = vi.spyOn(db, "upsertNote");
    const embedDelete = vi.spyOn(db, "deleteNote");

    try {
      await expect(readPdf(vault, { path: relPath })).resolves.toMatchObject({
        complete: false,
        has_text: true,
        pages: [
          { status: "ok" },
          {
            status: "failed",
            failure: { code: "PDF_TEXT_EXTRACTION_FAILED", detail: "PDF page text could not be extracted" }
          }
        ]
      });
      const ftsReport = await syncPdfFtsIndex(vault, fts);
      expect(ftsReport).toMatchObject({ updated: 0, skipped: 0, failed: 1, total_chunks: 1, complete: false });
      expect(ftsReindex).not.toHaveBeenCalled();
      expect(ftsDrop).not.toHaveBeenCalled();
      expect(fts.totalChunks()).toBe(1);

      const embedReport = await syncPdfEmbedDb(vault, db, embedder);
      expect(embedReport).toMatchObject({ failed: 1, empty: 0, complete: false });
      expect(embedUpsert).not.toHaveBeenCalled();
      expect(embedDelete).not.toHaveBeenCalled();
      expect(db.getSourceStates("pdf")).toEqual([{ rel_path: relPath, mtime_ms: 1 }]);
      expect(db.getQuarantinedPaths("pdf")).toEqual([relPath]);

      // Heal the bulk-sync quarantine without changing the prior generation,
      // then prove the watcher itself re-quarantines that same preserved row.
      fts.reindexPdfFile(relPath, 1, [{ pageNumber: 1, text: "prior lexical evidence" }]);
      await seedPdfEmbedRow(db, relPath);
      expect(db.getQuarantinedPaths("pdf")).toEqual([]);
      ftsReindex.mockClear();
      embedUpsert.mockClear();
      embedDelete.mockClear();
      const applyDiff = vi.fn();
      const watcher = new VaultWatcher({
        vault,
        ftsIndex: fts,
        includePdfs: true,
        embedDb: db,
        embedder,
        silent: true
      });
      watcher.attachHnsw({ applyDiff } as never, new Map());
      const canonicalAbsPath = vault.resolveInside(relPath);
      await (
        watcher as unknown as {
          handleExactPath(absPath: string, kind: "change"): Promise<void>;
        }
      ).handleExactPath(canonicalAbsPath, "change");
      expect(ftsReindex).not.toHaveBeenCalled();
      expect(embedUpsert).not.toHaveBeenCalled();
      expect(embedDelete).not.toHaveBeenCalled();
      expect(applyDiff).not.toHaveBeenCalled();
      expect(fts.totalChunks()).toBe(1);
      expect(db.getSourceStates("pdf")).toEqual([{ rel_path: relPath, mtime_ms: 1 }]);
      await watcher.close();
    } finally {
      db.close();
      await fts.closeAndRelease();
    }
  });

  it("genuine complete-empty evidence remains an authoritative control that clears stale rows", async () => {
    await mockPdfExtraction("empty");
    const root = await temporaryRoot("enquire-pdf-generation-empty-");
    const relPath = "blank.pdf";
    await fs.writeFile(path.join(root, relPath), "mock blank PDF bytes");
    const [{ Vault }, { FtsIndex }, { EmbedDb }, { syncPdfFtsIndex }, { syncPdfEmbedDb }] = await Promise.all([
      import("../src/vault.js"),
      import("../src/fts5.js"),
      import("../src/embed-db.js"),
      import("../src/fts5.js"),
      import("../src/embed-sync.js")
    ]);
    const vault = new Vault(root);
    await vault.ensureExists();
    const fts = new FtsIndex({ file: path.join(root, ".cache", "test.fts5.db"), vaultRoot: root });
    await fts.open();
    const db = new EmbedDb({
      file: path.join(root, ".cache", "test.embed.db"),
      vaultRoot: root,
      modelAlias: MODEL.alias,
      dim: MODEL.dim
    });
    await db.open();
    fts.reindexPdfFile(relPath, 1, [{ pageNumber: 1, text: "stale lexical evidence" }]);
    await seedPdfEmbedRow(db, relPath);

    try {
      await expect(syncPdfFtsIndex(vault, fts)).resolves.toMatchObject({
        updated: 0,
        skipped: 1,
        failed: 0,
        total_chunks: 0,
        complete: true
      });
      await expect(syncPdfEmbedDb(vault, db, embedder)).resolves.toMatchObject({ empty: 1, failed: 0 });
      expect(fts.totalChunks()).toBe(0);
      expect(db.getSourceStates("pdf")).toEqual([]);
      expect(db.getQuarantinedPaths("pdf")).toEqual([]);
    } finally {
      db.close();
      await fts.closeAndRelease();
    }
  });

  it("watcher OCR staging quarantines a failed OCR page without committing replacement FTS/embed/HNSW rows", async () => {
    await mockPdfExtraction("empty");
    vi.doMock("../src/ocr.js", async () => {
      const actual = await vi.importActual<typeof import("../src/ocr.js")>("../src/ocr.js");
      return {
        ...actual,
        extractPdfWithOcr: vi.fn(async () => ({
          pages: [
            {
              pageNumber: 1,
              text: "",
              status: "failed" as const,
              isEmpty: true,
              charCount: 0,
              confidence: null,
              failure: {
                code: "OCR_PAGE_RECOGNITION_FAILED" as const,
                detail: "OCR recognition failed for the page"
              }
            }
          ],
          fullText: "",
          pageCount: 1,
          hasText: false,
          complete: false,
          meanConfidence: null,
          langs: "eng"
        }))
      };
    });
    const root = await temporaryRoot("enquire-ocr-generation-fail-");
    const relPath = "scan.pdf";
    const absPath = path.join(root, relPath);
    await fs.writeFile(absPath, "mock changed scan bytes");
    const [{ Vault }, { FtsIndex }, { EmbedDb }, { VaultWatcher }] = await Promise.all([
      import("../src/vault.js"),
      import("../src/fts5.js"),
      import("../src/embed-db.js"),
      import("../src/watcher.js")
    ]);
    const vault = new Vault(root);
    await vault.ensureExists();
    const fts = new FtsIndex({ file: path.join(root, ".cache", "ocr-test.fts5.db"), vaultRoot: root });
    await fts.open();
    const db = new EmbedDb({
      file: path.join(root, ".cache", "ocr-test.embed.db"),
      vaultRoot: root,
      modelAlias: MODEL.alias,
      dim: MODEL.dim
    });
    await db.open();
    fts.reindexPdfFile(relPath, 1, [{ pageNumber: 1, text: "prior OCR lexical evidence" }]);
    await seedPdfEmbedRow(db, relPath);
    const ftsReindex = vi.spyOn(fts, "reindexPdfFile");
    const embedUpsert = vi.spyOn(db, "upsertNote");
    const embedDelete = vi.spyOn(db, "deleteNote");
    const applyDiff = vi.fn();
    const watcher = new VaultWatcher({
      vault,
      ftsIndex: fts,
      includePdfs: true,
      embedDb: db,
      embedder,
      silent: true
    });
    watcher.setOcrPdfs(true, "eng", 2);
    watcher.attachHnsw({ applyDiff } as never, new Map());
    const canonicalAbsPath = vault.resolveInside(relPath);

    try {
      await (
        watcher as unknown as {
          handleExactPath(absPath: string, kind: "change"): Promise<void>;
        }
      ).handleExactPath(canonicalAbsPath, "change");
      expect(ftsReindex).not.toHaveBeenCalled();
      expect(embedUpsert).not.toHaveBeenCalled();
      expect(embedDelete).not.toHaveBeenCalled();
      expect(applyDiff).not.toHaveBeenCalled();
      expect(fts.totalChunks()).toBe(1);
      expect(db.getSourceStates("pdf")).toEqual([{ rel_path: relPath, mtime_ms: 1 }]);
      expect(db.getQuarantinedPaths("pdf")).toEqual([relPath]);
      await watcher.close();
    } finally {
      db.close();
      await fts.closeAndRelease();
    }
  });
});
