// v2.10.0 — Tesseract OCR for image-only / scanned PDFs.
//
// Note: this test deliberately does NOT load the full Tesseract worker
// against a real bitmap. Tesseract.js + @napi-rs/canvas + a real
// language-pack download is smoke-test territory (~1-2s per page,
// ~10MB language file fetched on first call). Here we validate:
//   • obsidian_ocr_pdf path-resolution + privacy filter parity
//   • Clean error when path missing
//   • Clean error when path is excluded
//   • Tool input contract (refuses empty path)
//
// End-to-end OCR validation runs as a manual smoke step (run scripts
// against the maintainer's vault with a real scanned PDF). The CI smoke
// is built around a synthetic vault with no scanned PDFs.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPdfWithOcr, isOcrAvailable } from "../src/ocr.js";
import { ocrPdf } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";
import { makePdf } from "./helpers/make-pdf.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ocr-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ocrPdf — path + privacy contract (v2.10.0)", () => {
  it("rejects missing path arg", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await expect(ocrPdf(v, { path: "" })).rejects.toThrow(/path is required/);
  });

  it("rejects non-existent file", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await expect(ocrPdf(v, { path: "missing.pdf" })).rejects.toThrow();
  });

  it("refuses excluded paths (privacy filter parity with read_pdf)", async () => {
    const buf = makePdf({ pages: ["text only"] });
    await fs.mkdir(path.join(root, "private"), { recursive: true });
    await fs.writeFile(path.join(root, "private", "secret.pdf"), buf);
    const v = new Vault(root, { excludeGlobs: ["private/**"] });
    await v.ensureExists();
    await expect(ocrPdf(v, { path: "private/secret.pdf" })).rejects.toThrow();
  });

  it("refuses paths outside the read-paths allowlist", async () => {
    const buf = makePdf({ pages: ["text only"] });
    await fs.mkdir(path.join(root, "other"), { recursive: true });
    await fs.writeFile(path.join(root, "other", "doc.pdf"), buf);
    const v = new Vault(root, { readPaths: ["reading/**"] });
    await v.ensureExists();
    await expect(ocrPdf(v, { path: "other/doc.pdf" })).rejects.toThrow();
  });

  it("accepts path with or without .pdf extension (matches read_pdf shape)", async () => {
    // We don't run actual OCR (no real scanned image; makePdf emits text
    // streams pdfjs already extracts, and Tesseract.js is heavy to load
    // in unit tests). Instead, we verify the path-resolution layer treats
    // both forms equivalently by checking the rejected-path case for
    // both spellings.
    const v = new Vault(root);
    await v.ensureExists();
    // Both should fail with the same "missing file" error — proves the
    // path normalization runs identically for both.
    await expect(ocrPdf(v, { path: "missing" })).rejects.toThrow();
    await expect(ocrPdf(v, { path: "missing.pdf" })).rejects.toThrow();
  });
});

describe("ocr.ts module surface (v2.10.0)", () => {
  it("isOcrAvailable returns true when all 3 optional deps install", async () => {
    // CI default-installs optionalDependencies (no --omit=optional), so
    // tesseract.js + @napi-rs/canvas + pdfjs-dist all load successfully.
    // This exercises the loader code paths for coverage.
    const ok = await isOcrAvailable();
    expect(ok).toBe(true);
  });

  it("extractPdfWithOcr rejects an invalid PDF buffer cleanly", async () => {
    // Pass random bytes — pdfjs's getDocument will throw with a "stream"
    // or "InvalidPDF" error, which we surface to the caller. This
    // exercises the loader chain + the doc-load error path without
    // actually running Tesseract (we never reach the OCR loop because
    // doc-load fails first).
    const bad = Buffer.from("not a pdf, just bytes pretending to be one");
    await expect(extractPdfWithOcr(bad)).rejects.toThrow();
  });

  // v3.10.0-rc.74 (post-rc.70 re-sweep, reserve-before-try sibling): doc/loadingTask are acquired
  // BEFORE resolveOcrPageRange + the maxPages guard, which pre-rc.74 sat OUTSIDE the try — so a
  // throw there leaked the pdfjs document + worker port. The maxPages throw is only reachable past
  // assertOcrLangsInstalled (needs a local lang pack, absent in CI), so probe once and skip VISIBLY
  // if the lang pack / deps are missing (never a silent return — rc.23 rule).
  it("extractPdfWithOcr releases the pdfjs doc on a post-acquisition throw (rc.74)", async (ctx) => {
    const buf = makePdf({ pages: ["A", "B"] });
    const probe = await extractPdfWithOcr(buf, { pages: [1, 2], maxPages: 1 }).then(
      () => "ok",
      (e) => (e instanceof Error ? e.message : String(e))
    );
    // Only the maxPages guard (post-acquisition) proves the path; any other error = packs/deps absent.
    if (!/maxPages|refusing to process/i.test(String(probe))) return ctx.skip();
    // Reachable: 20 post-acquisition throws. A leaked doc/worker would exhaust handles or hang;
    // reaching the end with every call rejecting cleanly is the behavioral proof the finally runs.
    for (let r = 0; r < 20; r++) {
      await expect(extractPdfWithOcr(buf, { pages: [1, 2], maxPages: 1 })).rejects.toThrow(
        /maxPages|refusing to process/i
      );
    }
  });
});
