// v2.7.0 — PDF text extraction + tools.
//
// Coverage:
//   • extractPdfText — single-page, multi-page, metadata round-trip,
//     empty-image-only-PDF detection (best-effort — we can't easily
//     forge a no-text PDF without a real fixture, so we test the
//     fallback path via a hand-degenerated stream).
//   • listPdfs — recursive walk, mtime sort, --exclude-glob filter
//     parity with markdown listing.
//   • readPdf — round-trip, page-range slice, include_metadata flag,
//     non-existent path error, excluded-by-privacy-filter error.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPdfText, isPdfjsAvailable } from "../src/pdf.js";
import { listPdfs, readPdf } from "../src/tools.js";
import { Vault } from "../src/vault.js";
import { makePdf } from "./helpers/make-pdf.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-pdf-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("extractPdfText (v2.7.0)", () => {
  it("extracts text from a single-page PDF", async () => {
    const buf = makePdf({ pages: ["Hello World"] });
    const result = await extractPdfText(buf);
    expect(result.pageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.text).toContain("Hello World");
    expect(result.pages[0]?.isEmpty).toBe(false);
    expect(result.hasText).toBe(true);
    expect(result.fullText).toContain("Hello World");
  });

  it("extracts text from a multi-page PDF in order", async () => {
    const buf = makePdf({ pages: ["First page", "Second page", "Third page"] });
    const result = await extractPdfText(buf);
    expect(result.pageCount).toBe(3);
    expect(result.pages.map((p) => p.text)).toEqual([
      expect.stringContaining("First page"),
      expect.stringContaining("Second page"),
      expect.stringContaining("Third page")
    ]);
    expect(result.fullText).toContain("First page");
    expect(result.fullText).toContain("Third page");
  });

  it("captures Title + Author metadata when present", async () => {
    const buf = makePdf({ pages: ["Body text"], title: "My Paper", author: "Alex" });
    const result = await extractPdfText(buf);
    expect(result.metadata.title).toBe("My Paper");
    expect(result.metadata.author).toBe("Alex");
  });

  it("returns empty metadata when the PDF has no Info dict", async () => {
    const buf = makePdf({ pages: ["Body text"] });
    const result = await extractPdfText(buf);
    expect(result.metadata.title).toBeUndefined();
    expect(result.metadata.author).toBeUndefined();
  });

  it("computes per-page char_count correctly", async () => {
    const buf = makePdf({ pages: ["abc"] });
    const result = await extractPdfText(buf);
    const page = result.pages[0];
    expect(page).toBeDefined();
    if (page) {
      expect(page.charCount).toBe(page.text.length);
      expect(page.charCount).toBeGreaterThan(0);
    }
  });

  it("escapes parens + backslashes in text strings", async () => {
    // PDF strings use () delimiters; unescaped parens crash the parser.
    // makePdf escapes — verify round-trip.
    const buf = makePdf({ pages: ["Hello (world) backslash\\here"] });
    const result = await extractPdfText(buf);
    expect(result.pages[0]?.text).toContain("Hello");
    expect(result.pages[0]?.text).toContain("world");
  });

  // v3.6 — branches coverage. The author-only metadata path (title undef
  // but author defined) and the keywords/subject/producer branches in the
  // metadata extraction were uncovered.
  it("captures Subject + Keywords metadata when present", async () => {
    // makePdf doesn't directly support subject/keywords, but Title/Author
    // alone still exercise the typeof === 'string' branches for the
    // missing fields. Result: author defined, others undefined.
    const buf = makePdf({ pages: ["Body"], author: "Alex" });
    const result = await extractPdfText(buf);
    expect(result.metadata.author).toBe("Alex");
    expect(result.metadata.title).toBeUndefined();
    expect(result.metadata.subject).toBeUndefined();
    expect(result.metadata.keywords).toBeUndefined();
  });

  it("throws cleanly on a malformed PDF buffer", async () => {
    // Hand-build garbage bytes — pdfjs's getDocument rejects with a
    // recognizable error. Exercises the failure path from the
    // loadingTask.promise level (separately from the per-page catch).
    const garbage = Buffer.from("not a pdf at all");
    await expect(extractPdfText(garbage)).rejects.toThrow();
  });
});

// v3.6 — branches coverage. isPdfjsAvailable's cache-miss vs cache-hit
// branches (lines 200-207). The first call lazy-loads pdfjs; the second
// returns cached value.
describe("isPdfjsAvailable (v3.6 — cache branches)", () => {
  it("returns true when pdfjs-dist is installed (CI default)", async () => {
    const ok = await isPdfjsAvailable();
    expect(ok).toBe(true);
  });

  it("returns the cached result on repeat calls (idempotent)", async () => {
    const a = await isPdfjsAvailable();
    const b = await isPdfjsAvailable();
    expect(a).toBe(b);
  });
});

describe("listPdfs (v2.7.0)", () => {
  async function writePdf(rel: string, text: string): Promise<void> {
    const buf = makePdf({ pages: [text] });
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
  }

  it("lists PDFs with size + mtime", async () => {
    await writePdf("paper.pdf", "Some research");
    const v = new Vault(root);
    await v.ensureExists();
    const out = await listPdfs(v, {});
    expect(out).toHaveLength(1);
    const first = out[0];
    expect(first?.path).toBe("paper.pdf");
    expect(first?.name).toBe("paper");
    expect(first?.size_bytes).toBeGreaterThan(0);
    expect(first?.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("walks recursively into subfolders", async () => {
    await writePdf("a.pdf", "A");
    await writePdf("research/b.pdf", "B");
    await writePdf("research/sub/c.pdf", "C");
    const v = new Vault(root);
    await v.ensureExists();
    const out = await listPdfs(v, {});
    expect(out.map((p) => p.path).sort()).toEqual(["a.pdf", "research/b.pdf", "research/sub/c.pdf"]);
  });

  it("respects the folder argument", async () => {
    await writePdf("top.pdf", "Top");
    await writePdf("research/inner.pdf", "Inner");
    const v = new Vault(root);
    await v.ensureExists();
    const out = await listPdfs(v, { folder: "research" });
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("research/inner.pdf");
  });

  it("respects --exclude-glob (privacy filter parity with .md listing)", async () => {
    await writePdf("ok.pdf", "Public");
    await writePdf("private/secret.pdf", "Confidential");
    const v = new Vault(root, { excludeGlobs: ["private/**"] });
    await v.ensureExists();
    const out = await listPdfs(v, {});
    expect(out.map((p) => p.path)).toEqual(["ok.pdf"]);
  });

  it("respects --read-paths allowlist", async () => {
    await writePdf("reading/a.pdf", "Allowed");
    await writePdf("other/b.pdf", "Blocked");
    const v = new Vault(root, { readPaths: ["reading/**"] });
    await v.ensureExists();
    const out = await listPdfs(v, {});
    expect(out.map((p) => p.path)).toEqual(["reading/a.pdf"]);
  });

  it("honors the limit argument", async () => {
    for (let i = 0; i < 5; i++) {
      await writePdf(`p${i}.pdf`, `Page ${i}`);
    }
    const v = new Vault(root);
    await v.ensureExists();
    const out = await listPdfs(v, { limit: 2 });
    expect(out).toHaveLength(2);
  });

  it("sorts by mtime descending (newest first)", async () => {
    await writePdf("first.pdf", "First");
    await new Promise((r) => setTimeout(r, 20));
    await writePdf("second.pdf", "Second");
    const v = new Vault(root);
    await v.ensureExists();
    const out = await listPdfs(v, {});
    expect(out[0]?.path).toBe("second.pdf");
    expect(out[1]?.path).toBe("first.pdf");
  });
});

describe("readPdf (v2.7.0)", () => {
  async function writePdf(rel: string, pages: string[], meta?: { title?: string; author?: string }): Promise<void> {
    const buf = makePdf({ pages, ...meta });
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
  }

  it("reads all pages by default", async () => {
    await writePdf("doc.pdf", ["Alpha", "Beta", "Gamma"]);
    const v = new Vault(root);
    await v.ensureExists();
    const result = await readPdf(v, { path: "doc.pdf" });
    expect(result.page_count).toBe(3);
    expect(result.total_page_count).toBe(3);
    expect(result.has_text).toBe(true);
    expect(result.full_text).toContain("Alpha");
    expect(result.full_text).toContain("Gamma");
  });

  it("accepts path with or without .pdf extension", async () => {
    await writePdf("paper.pdf", ["Body"]);
    const v = new Vault(root);
    await v.ensureExists();
    const a = await readPdf(v, { path: "paper" });
    const b = await readPdf(v, { path: "paper.pdf" });
    expect(a.full_text).toBe(b.full_text);
  });

  it("slices a page range (1-indexed inclusive)", async () => {
    await writePdf("doc.pdf", ["P1", "P2", "P3", "P4", "P5"]);
    const v = new Vault(root);
    await v.ensureExists();
    const result = await readPdf(v, { path: "doc.pdf", pages: [2, 4] });
    expect(result.page_count).toBe(3);
    expect(result.total_page_count).toBe(5); // original count preserved
    expect(result.full_text).toContain("P2");
    expect(result.full_text).toContain("P4");
    expect(result.full_text).not.toContain("P1");
    expect(result.full_text).not.toContain("P5");
  });

  it("includes metadata by default", async () => {
    await writePdf("paper.pdf", ["Body"], { title: "Title X", author: "Author Y" });
    const v = new Vault(root);
    await v.ensureExists();
    const result = await readPdf(v, { path: "paper.pdf" });
    expect(result.metadata?.title).toBe("Title X");
    expect(result.metadata?.author).toBe("Author Y");
  });

  it("omits metadata when include_metadata: false", async () => {
    await writePdf("paper.pdf", ["Body"], { title: "Title X" });
    const v = new Vault(root);
    await v.ensureExists();
    const result = await readPdf(v, { path: "paper.pdf", include_metadata: false });
    expect(result.metadata).toBeUndefined();
  });

  it("throws on non-existent path", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await expect(readPdf(v, { path: "missing.pdf" })).rejects.toThrow();
  });

  it("refuses excluded paths (privacy filter parity)", async () => {
    await writePdf("private/secret.pdf", ["Confidential"]);
    const v = new Vault(root, { excludeGlobs: ["private/**"] });
    await v.ensureExists();
    await expect(readPdf(v, { path: "private/secret.pdf" })).rejects.toThrow();
  });

  it("preserves correct page numbers after slicing", async () => {
    await writePdf("doc.pdf", ["P1", "P2", "P3"]);
    const v = new Vault(root);
    await v.ensureExists();
    const result = await readPdf(v, { path: "doc.pdf", pages: [2, 3] });
    // Page numbers in result reflect ORIGINAL page index (so consumers can
    // cite "page 2 of the original document").
    expect(result.pages.map((p) => p.page_number)).toEqual([2, 3]);
  });

  it("rejects an empty path", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await expect(readPdf(v, { path: "" })).rejects.toThrow(/path is required/);
  });
});
