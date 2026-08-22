import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function mockPdfTextChunkPages(chunksByPage: readonly (readonly (readonly unknown[])[])[]) {
  const pageCleanups = chunksByPage.map(() => vi.fn());
  const streamCancels = chunksByPage.map(() => vi.fn());
  const streamPulls = chunksByPage.map(() => vi.fn());
  const getPage = vi.fn(async (pageNumber: number) => {
    const pageIndex = pageNumber - 1;
    const chunks = chunksByPage[pageIndex] ?? [];
    let chunkIndex = 0;
    return {
      streamTextContent: () =>
        new ReadableStream(
          {
            async pull(controller) {
              streamPulls[pageIndex]?.();
              await Promise.resolve();
              const items = chunks[chunkIndex];
              if (items === undefined) {
                controller.close();
                return;
              }
              chunkIndex += 1;
              controller.enqueue({ items });
            },
            cancel(reason) {
              streamCancels[pageIndex]?.(reason);
            }
          },
          { highWaterMark: 0 }
        ),
      cleanup: pageCleanups[pageIndex]
    };
  });
  const documentCleanup = vi.fn(async () => {});
  const loadingDestroy = vi.fn(async () => {});
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({
      numPages: chunksByPage.length,
      getPage,
      getMetadata: async () => ({ info: {} }),
      cleanup: documentCleanup
    }),
    destroy: loadingDestroy
  }));
  vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
    getDocument
  }));
  return { getDocument, getPage, pageCleanups, streamCancels, streamPulls, documentCleanup, loadingDestroy };
}

function mockPdfTextPages(itemsByPage: readonly (readonly unknown[])[]) {
  return mockPdfTextChunkPages(itemsByPage.map((items) => [items]));
}

function mockPureXfaPages(xfaByPage: readonly unknown[]) {
  const pageCleanups = xfaByPage.map(() => vi.fn());
  const streamTextContent = xfaByPage.map(() => vi.fn());
  const getXfa = xfaByPage.map((xfa) => vi.fn(async () => xfa));
  const getPage = vi.fn(async (pageNumber: number) => {
    const pageIndex = pageNumber - 1;
    return {
      isPureXfa: true,
      getXfa: getXfa[pageIndex],
      streamTextContent: streamTextContent[pageIndex],
      cleanup: pageCleanups[pageIndex]
    };
  });
  const documentCleanup = vi.fn(async () => {});
  const loadingDestroy = vi.fn(async () => {});
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({
      numPages: xfaByPage.length,
      getPage,
      getMetadata: async () => ({ info: {} }),
      cleanup: documentCleanup
    }),
    destroy: loadingDestroy
  }));
  vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument }));
  return { getDocument, getPage, getXfa, streamTextContent, pageCleanups, documentCleanup, loadingDestroy };
}

async function mockOcrTextPages(dataByPage: readonly object[]) {
  const langPath = await temporaryRoot("enquire-ocr-text-budget-lang-");
  await fs.writeFile(path.join(langPath, "eng.traineddata"), "fake");
  const pageCleanups = dataByPage.map(() => vi.fn());
  const getPage = vi.fn(async (pageNumber: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 10 * scale, height: 10 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    cleanup: pageCleanups[pageNumber - 1]
  }));
  const documentCleanup = vi.fn(async () => {});
  const loadingDestroy = vi.fn(async () => {});
  vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
    getDocument: () => ({
      promise: Promise.resolve({ numPages: dataByPage.length, getPage, cleanup: documentCleanup }),
      destroy: loadingDestroy
    })
  }));
  vi.doMock("@napi-rs/canvas", () => ({
    createCanvas: (width: number, height: number) => ({
      width,
      height,
      getContext: () => ({ fillStyle: "", fillRect: () => {} }),
      encode: async () => Buffer.from("png")
    })
  }));
  let recognitionIndex = 0;
  const recognize = vi.fn(async () => ({ data: dataByPage[recognitionIndex++] ?? { text: "", confidence: 0 } }));
  const terminate = vi.fn(async () => {});
  const createWorker = vi.fn(async () => ({ recognize, terminate }));
  vi.doMock("tesseract.js", () => ({ createWorker }));
  return { langPath, getPage, pageCleanups, createWorker, recognize, terminate, documentCleanup, loadingDestroy };
}

afterEach(async () => {
  vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  vi.doUnmock("@napi-rs/canvas");
  vi.doUnmock("tesseract.js");
  vi.doUnmock("../src/pdf.js");
  vi.doUnmock("../src/ocr.js");
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("PDF decompressed text admission", () => {
  it("rejects widened and non-finite limits before loading the PDF document", async () => {
    const mocks = mockPdfTextPages([[{ str: "unreachable" }]]);
    const { DEFAULT_PDF_TEXT_EXTRACTION_LIMITS, extractPdfText } = await import("../src/pdf.js");

    await expect(
      extractPdfText(Buffer.from("tiny"), {
        textLimits: {
          maxAggregateTextUtf8Bytes: DEFAULT_PDF_TEXT_EXTRACTION_LIMITS.maxAggregateTextUtf8Bytes + 1
        }
      })
    ).rejects.toThrow(/no greater than/);
    await expect(
      extractPdfText(Buffer.from("tiny"), { textLimits: { maxTextItemUtf8Bytes: Number.NaN } })
    ).rejects.toThrow(/positive safe integer/);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("accepts exact item/node/page/aggregate UTF-8 boundaries and builds one exact aggregate", async () => {
    const mocks = mockPdfTextPages([[{ str: "ab" }, { str: "cd" }], [{ str: "ef" }]]);
    const { extractPdfText } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny compressed input"), {
      textLimits: {
        maxTextItemUtf8Bytes: 2,
        maxTextItemsPerPage: 2,
        maxTextItemsTotal: 3,
        maxPageResults: 2,
        maxPageTextUtf8Bytes: 5,
        maxAggregateTextUtf8Bytes: 9
      }
    });

    expect(result.pages.map((page) => page.text)).toEqual(["ab cd", "ef"]);
    expect(result.fullText).toBe("ab cd\n\nef");
    expect(result).toMatchObject({ hasText: true, complete: true });
    expect(mocks.getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2]);
    for (const cleanup of mocks.pageCleanups) expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves item order across a normal asynchronous multi-chunk text stream", async () => {
    const mocks = mockPdfTextChunkPages([
      [[{ str: "Alpha" }], [{ str: "Beta" }], [{ type: "beginMarkedContent" }], [{ str: "Gamma" }]]
    ]);
    const { extractPdfText } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny"));

    expect(result.pages).toEqual([
      { pageNumber: 1, text: "Alpha Beta Gamma", status: "ok", isEmpty: false, charCount: 16 }
    ]);
    expect(result.fullText).toBe("Alpha Beta Gamma");
    expect(mocks.streamPulls[0]).toHaveBeenCalledTimes(5);
    expect(mocks.streamCancels[0]).not.toHaveBeenCalled();
    expect(mocks.pageCleanups[0]).toHaveBeenCalledTimes(1);
  });

  it("preserves pure-XFA text order through a bounded public-tree traversal", async () => {
    const excludedChildrenRead = vi.fn(() => [{ name: "#text", value: "must-not-appear" }]);
    const excludedControl = Object.defineProperty({ name: "textarea" }, "children", {
      configurable: true,
      enumerable: true,
      get: excludedChildrenRead
    });
    const mocks = mockPureXfaPages([
      {
        name: "div",
        children: [
          { name: "#text", value: "Alpha" },
          { name: "span", attributes: { textContent: "Beta" } },
          excludedControl,
          { name: "span", value: "Gamma" }
        ]
      }
    ]);
    const { extractPdfText } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny"), {
      textLimits: {
        maxTextItemUtf8Bytes: 5,
        maxTextItemsPerPage: 5,
        maxTextItemsTotal: 5,
        maxPageResults: 1,
        maxPageTextUtf8Bytes: 16,
        maxAggregateTextUtf8Bytes: 16
      }
    });

    expect(result.pages).toEqual([
      { pageNumber: 1, text: "Alpha Beta Gamma", status: "ok", isEmpty: false, charCount: 16 }
    ]);
    expect(result).toMatchObject({ fullText: "Alpha Beta Gamma", hasText: true, complete: true });
    expect(excludedChildrenRead).not.toHaveBeenCalled();
    expect(mocks.getXfa[0]).toHaveBeenCalledTimes(1);
    expect(mocks.streamTextContent[0]).not.toHaveBeenCalled();
    expect(mocks.pageCleanups[0]).toHaveBeenCalledTimes(1);
    expect(mocks.documentCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.loadingDestroy).toHaveBeenCalledTimes(1);
  });

  it("fails pure-XFA at node cap+1 before reading the later node or loading a later page", async () => {
    const laterNodeRead = vi.fn(() => ({ name: "#text", value: "must-not-be-read" }));
    const children: unknown[] = [{ name: "#text", value: "ok" }];
    Object.defineProperty(children, 1, {
      configurable: true,
      enumerable: true,
      get: laterNodeRead
    });
    const mocks = mockPureXfaPages([
      { name: "div", children },
      { name: "div", children: [{ name: "#text", value: "later page" }] }
    ]);
    const { extractPdfText } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny"), {
      textLimits: { maxTextItemsPerPage: 2 }
    });

    expect(result.pages).toEqual([
      expect.objectContaining({
        pageNumber: 1,
        status: "failed",
        failure: { code: "PDF_TEXT_BUDGET_EXCEEDED", detail: expect.any(String) }
      })
    ]);
    expect(result).toMatchObject({ fullText: "", hasText: false, complete: false });
    expect(laterNodeRead).not.toHaveBeenCalled();
    expect(mocks.getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1]);
    expect(mocks.getXfa[0]).toHaveBeenCalledTimes(1);
    expect(mocks.getXfa[1]).not.toHaveBeenCalled();
    expect(mocks.streamTextContent[0]).not.toHaveBeenCalled();
    expect(mocks.streamTextContent[1]).not.toHaveBeenCalled();
    expect(mocks.pageCleanups[0]).toHaveBeenCalledTimes(1);
    expect(mocks.pageCleanups[1]).not.toHaveBeenCalled();
    expect(mocks.documentCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.loadingDestroy).toHaveBeenCalledTimes(1);
  });

  it("cancels an asynchronous stream at aggregate cap+1 without pulling or inspecting later items", async () => {
    const firstItemRead = vi.fn(() => "ab");
    const overflowItemRead = vi.fn(() => "cd");
    const unseenItemRead = vi.fn(() => "must-not-be-read");
    const mocks = mockPdfTextChunkPages([
      [
        [Object.defineProperty({}, "str", { get: firstItemRead })],
        [Object.defineProperty({}, "str", { get: overflowItemRead })],
        [Object.defineProperty({}, "str", { get: unseenItemRead })]
      ],
      [[{ str: "later page" }]]
    ]);
    const { extractPdfText } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny"), {
      textLimits: { maxAggregateTextUtf8Bytes: 4 }
    });

    expect(result.pages).toEqual([
      expect.objectContaining({
        pageNumber: 1,
        status: "failed",
        failure: { code: "PDF_TEXT_BUDGET_EXCEEDED", detail: expect.any(String) }
      })
    ]);
    expect(firstItemRead).toHaveBeenCalledTimes(1);
    expect(overflowItemRead).toHaveBeenCalledTimes(1);
    expect(unseenItemRead).not.toHaveBeenCalled();
    expect(mocks.streamPulls[0]).toHaveBeenCalledTimes(2);
    expect(mocks.streamCancels[0]).toHaveBeenCalledTimes(1);
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
    expect(mocks.pageCleanups[0]).toHaveBeenCalledTimes(1);
  });

  it("marks a per-item cap+1 as failed and touches neither later items nor later pages", async () => {
    const laterItemRead = vi.fn(() => "must-not-be-read");
    const laterItem = Object.defineProperty({}, "str", { get: laterItemRead });
    const mocks = mockPdfTextPages([[{ str: "abc" }, laterItem], [{ str: "later page" }]]);
    const { assertPdfPagesComplete, extractPdfText, PdfPageExtractionError } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny"), {
      textLimits: { maxTextItemUtf8Bytes: 2 }
    });

    expect(result.pages).toEqual([
      {
        pageNumber: 1,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        failure: {
          code: "PDF_TEXT_BUDGET_EXCEEDED",
          detail: "PDF page text exceeded the extraction safety budget"
        }
      }
    ]);
    expect(result).toMatchObject({ fullText: "", hasText: false, complete: false });
    expect(laterItemRead).not.toHaveBeenCalled();
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
    expect(() => assertPdfPagesComplete(result.pages)).toThrow(PdfPageExtractionError);
  });

  it("rejects page-node cap+1 before reading any item and stops before the next page", async () => {
    const firstItemRead = vi.fn(() => "one");
    const items = [Object.defineProperty({}, "str", { get: firstItemRead }), { str: "two" }];
    const mocks = mockPdfTextPages([items, [{ str: "later page" }]]);
    const { extractPdfText } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny"), {
      textLimits: { maxTextItemsPerPage: 1 }
    });

    expect(result.pages[0]).toMatchObject({ status: "failed", failure: { code: "PDF_TEXT_BUDGET_EXCEEDED" } });
    expect(firstItemRead).not.toHaveBeenCalled();
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
  });

  it("fails a requested page-result node cap+1 before loading any page", async () => {
    const mocks = mockPdfTextPages([[{ str: "one" }], [{ str: "two" }]]);
    const { extractPdfText } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny"), {
      textLimits: { maxPageResults: 1 }
    });

    expect(result.pages).toEqual([
      expect.objectContaining({
        pageNumber: 1,
        status: "failed",
        failure: { code: "PDF_TEXT_BUDGET_EXCEEDED", detail: expect.any(String) }
      })
    ]);
    expect(mocks.getPage).not.toHaveBeenCalled();
  });

  it("turns aggregate cap+1 into failed evidence and preserves the admitted prefix without page 3 work", async () => {
    const mocks = mockPdfTextPages([[{ str: "ab" }], [{ str: "cd" }], [{ str: "ef" }]]);
    const { extractPdfText } = await import("../src/pdf.js");

    const result = await extractPdfText(Buffer.from("tiny"), {
      textLimits: { maxAggregateTextUtf8Bytes: 5 }
    });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({ text: "ab", status: "ok" });
    expect(result.pages[1]).toMatchObject({
      text: "",
      status: "failed",
      failure: { code: "PDF_TEXT_BUDGET_EXCEEDED" }
    });
    expect(result.fullText).toBe("ab");
    expect(result.complete).toBe(false);
    expect(mocks.getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2]);
  });
});

describe("OCR decompressed text admission", () => {
  it("rejects widened and non-finite limits before document or worker admission", async () => {
    const mocks = await mockOcrTextPages([{ text: "unreachable", confidence: 50 }]);
    const { DEFAULT_OCR_TEXT_EXTRACTION_LIMITS, extractPdfWithOcr } = await import("../src/ocr.js");

    await expect(
      extractPdfWithOcr(Buffer.from("tiny"), {
        langPath: mocks.langPath,
        textLimits: {
          maxAggregateTextUtf8Bytes: DEFAULT_OCR_TEXT_EXTRACTION_LIMITS.maxAggregateTextUtf8Bytes + 1
        }
      })
    ).rejects.toThrow(/no greater than/);
    await expect(
      extractPdfWithOcr(Buffer.from("tiny"), {
        langPath: mocks.langPath,
        textLimits: { maxTextItemUtf8Bytes: Number.NaN }
      })
    ).rejects.toThrow(/positive safe integer/);
    expect(mocks.createWorker).not.toHaveBeenCalled();
    expect(mocks.getPage).not.toHaveBeenCalled();
  });

  it("accepts exact boundaries, requests text-only Tesseract output, and returns finite exact aggregates", async () => {
    const mocks = await mockOcrTextPages([
      { text: "ab", confidence: 50 },
      { text: "cd", confidence: 70 }
    ]);
    const { extractPdfWithOcr } = await import("../src/ocr.js");

    const result = await extractPdfWithOcr(Buffer.from("tiny compressed input"), {
      langPath: mocks.langPath,
      langs: "eng",
      timeoutMs: 1000,
      textLimits: {
        maxTextItemUtf8Bytes: 2,
        maxTextItemsPerPage: 1,
        maxTextItemsTotal: 2,
        maxPageResults: 2,
        maxPageTextUtf8Bytes: 2,
        maxAggregateTextUtf8Bytes: 6
      }
    });

    expect(result.pages.map((page) => page.text)).toEqual(["ab", "cd"]);
    expect(result).toMatchObject({ fullText: "ab\n\ncd", hasText: true, complete: true, meanConfidence: 60 });
    expect(Number.isFinite(result.meanConfidence)).toBe(true);
    expect(mocks.recognize).toHaveBeenCalledTimes(2);
    const output = mocks.recognize.mock.calls[0]?.[2] as Record<string, boolean> | undefined;
    expect(output).toMatchObject({ text: true, blocks: false, layoutBlocks: false, pdf: false, imageColor: false });
    expect(Object.entries(output ?? {}).filter(([key, enabled]) => key !== "text" && enabled)).toEqual([]);
  });

  it("marks OCR per-item cap+1 as failed and stops before requesting page 2", async () => {
    const mocks = await mockOcrTextPages([
      { text: "abc", confidence: 50 },
      { text: "later", confidence: 50 }
    ]);
    const { assertOcrPagesComplete, extractPdfWithOcr, OcrPageExtractionError } = await import("../src/ocr.js");

    const result = await extractPdfWithOcr(Buffer.from("tiny"), {
      langPath: mocks.langPath,
      timeoutMs: 1000,
      textLimits: { maxTextItemUtf8Bytes: 2 }
    });

    expect(result.pages[0]).toMatchObject({
      status: "failed",
      confidence: null,
      failure: {
        code: "OCR_TEXT_BUDGET_EXCEEDED",
        detail: "OCR page text exceeded the extraction safety budget"
      }
    });
    expect(result).toMatchObject({ fullText: "", hasText: false, complete: false, meanConfidence: null });
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
    expect(() => assertOcrPagesComplete(result.pages)).toThrow(OcrPageExtractionError);
  });

  it("fails a requested OCR page-result node cap+1 before creating page or recognition work", async () => {
    const mocks = await mockOcrTextPages([
      { text: "one", confidence: 50 },
      { text: "two", confidence: 50 }
    ]);
    const { extractPdfWithOcr } = await import("../src/ocr.js");

    const result = await extractPdfWithOcr(Buffer.from("tiny"), {
      langPath: mocks.langPath,
      timeoutMs: 1000,
      textLimits: { maxPageResults: 1 }
    });

    expect(result.pages).toEqual([
      expect.objectContaining({
        pageNumber: 1,
        status: "failed",
        failure: { code: "OCR_TEXT_BUDGET_EXCEEDED", detail: expect.any(String) }
      })
    ]);
    expect(mocks.getPage).not.toHaveBeenCalled();
    expect(mocks.recognize).not.toHaveBeenCalled();
    expect(mocks.terminate).not.toHaveBeenCalled();
  });

  it("enforces the aggregate cap and text-node total before later OCR text/page access", async () => {
    const secondTextRead = vi.fn(() => "cd");
    const secondData = Object.defineProperty({ confidence: 50 }, "text", { get: secondTextRead });
    const mocks = await mockOcrTextPages([
      { text: "ab", confidence: 50 },
      secondData,
      { text: "later", confidence: 50 }
    ]);
    const { extractPdfWithOcr } = await import("../src/ocr.js");

    const result = await extractPdfWithOcr(Buffer.from("tiny"), {
      langPath: mocks.langPath,
      timeoutMs: 1000,
      textLimits: { maxTextItemsTotal: 1, maxAggregateTextUtf8Bytes: 5 }
    });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({ text: "ab", status: "ok" });
    expect(result.pages[1]).toMatchObject({ status: "failed", failure: { code: "OCR_TEXT_BUDGET_EXCEEDED" } });
    expect(result.fullText).toBe("ab");
    expect(secondTextRead).not.toHaveBeenCalled();
    expect(mocks.getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1]);
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
  });

  it("turns aggregate full-text cap+1 into failed evidence and skips page 3", async () => {
    const mocks = await mockOcrTextPages([
      { text: "ab", confidence: 50 },
      { text: "cd", confidence: 50 },
      { text: "ef", confidence: 50 }
    ]);
    const { extractPdfWithOcr } = await import("../src/ocr.js");

    const result = await extractPdfWithOcr(Buffer.from("tiny"), {
      langPath: mocks.langPath,
      timeoutMs: 1000,
      textLimits: { maxAggregateTextUtf8Bytes: 5 }
    });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]).toMatchObject({ status: "failed", failure: { code: "OCR_TEXT_BUDGET_EXCEEDED" } });
    expect(result).toMatchObject({ fullText: "ab", complete: false, meanConfidence: 50 });
    expect(mocks.getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2]);
  });
});

describe("public PDF/OCR envelopes reuse the extractor's bounded aggregate", () => {
  it("passes internal limits through and does not recompute full_text from page strings", async () => {
    const root = await temporaryRoot("enquire-pdf-ocr-media-budget-");
    await fs.writeFile(path.join(root, "doc.pdf"), "tiny fake PDF");
    const pdfExtract = vi.fn(async () => ({
      pages: [{ pageNumber: 1, text: "page-only PDF text", status: "ok" as const, isEmpty: false, charCount: 18 }],
      fullText: "bounded PDF aggregate sentinel",
      pageCount: 1,
      hasText: true,
      complete: true,
      metadata: {}
    }));
    const ocrExtract = vi.fn(async () => ({
      pages: [
        {
          pageNumber: 1,
          text: "page-only OCR text",
          status: "ok" as const,
          isEmpty: false,
          charCount: 18,
          confidence: 80
        }
      ],
      fullText: "bounded OCR aggregate sentinel",
      pageCount: 1,
      hasText: true,
      complete: true,
      meanConfidence: 80,
      langs: "eng"
    }));
    vi.doMock("../src/pdf.js", () => ({ extractPdfText: pdfExtract }));
    vi.doMock("../src/ocr.js", () => ({ extractPdfWithOcr: ocrExtract }));
    const [{ Vault }, { ocrPdf, readPdf }] = await Promise.all([
      import("../src/vault.js"),
      import("../src/tools/media.js")
    ]);
    const vault = new Vault(root);
    const pdfLimits = { maxAggregateTextUtf8Bytes: 123 };
    const ocrLimits = { maxAggregateTextUtf8Bytes: 456 };

    const pdf = await readPdf(vault, { path: "doc.pdf" }, { textLimits: pdfLimits });
    const ocr = await ocrPdf(vault, { path: "doc.pdf" }, { textLimits: ocrLimits });

    expect(pdf.full_text).toBe("bounded PDF aggregate sentinel");
    expect(pdf.full_text).not.toBe(pdf.pages[0]?.text);
    expect(ocr.full_text).toBe("bounded OCR aggregate sentinel");
    expect(ocr.full_text).not.toBe(ocr.pages[0]?.text);
    expect(pdfExtract).toHaveBeenCalledWith(expect.any(Buffer), { textLimits: pdfLimits });
    expect(ocrExtract).toHaveBeenCalledWith(expect.any(Buffer), { textLimits: ocrLimits });
  });
});
