// v3.9.0-rc.10 (overclaim #16 + canvas-OOM DoS) — OCR offline-enforcement +
// resource-bound tests. The pre-flight language-cache guard and the geometry
// helpers run BEFORE any optional dep loads, so these are fully CI-testable
// without tesseract.js / @napi-rs/canvas / pdfjs installed. Positive + NEGATIVE
// controls per the CLAUDE.md rule since v3.6.4.

import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertOcrLangsInstalled,
  clampOcrScale,
  extractPdfWithOcr,
  MAX_OCR_CANVAS_DIM,
  ocrLangIsInstalled,
  resolveOcrPageRange,
  resolveTessdataDir
} from "../src/ocr.js";

describe("resolveTessdataDir (v3.9.0-rc.10)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("honors ENQUIRE_TESSDATA_DIR override (POSITIVE)", () => {
    process.env.ENQUIRE_TESSDATA_DIR = "/custom/tessdata";
    expect(resolveTessdataDir()).toBe("/custom/tessdata");
  });
  it("falls back to XDG_CACHE_HOME/enquire-mcp/tessdata", () => {
    process.env.ENQUIRE_TESSDATA_DIR = "";
    process.env.XDG_CACHE_HOME = "/xdg";
    expect(resolveTessdataDir()).toBe(path.join("/xdg", "enquire-mcp", "tessdata"));
  });
  it("defaults to ~/.cache/enquire-mcp/tessdata", () => {
    process.env.ENQUIRE_TESSDATA_DIR = "";
    process.env.XDG_CACHE_HOME = "";
    expect(resolveTessdataDir()).toBe(path.join(os.homedir(), ".cache", "enquire-mcp", "tessdata"));
  });
});

describe("ocrLangIsInstalled + assertOcrLangsInstalled — #16 offline enforcement", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-tessdata-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ocrLangIsInstalled: false for empty dir (NEGATIVE), true once the pack exists (POSITIVE)", async () => {
    expect(ocrLangIsInstalled("eng", dir)).toBe(false);
    await fs.writeFile(path.join(dir, "eng.traineddata"), "fake");
    expect(ocrLangIsInstalled("eng", dir)).toBe(true);
  });

  it("ocrLangIsInstalled REJECTS a .gz-only pack the readOnly/gzip:false worker can't read (rc.44, NEGATIVE control)", async () => {
    // Pre-rc.44 this returned true for a `.gz`-only install, but the worker is pinned
    // gzip:false + cacheMethod:"readOnly" and reads only `<lang>.traineddata` — so the
    // pre-flight passed while createWorker then failed. Now require the uncompressed form.
    await fs.writeFile(path.join(dir, "rus.traineddata.gz"), "fake");
    expect(ocrLangIsInstalled("rus", dir)).toBe(false);
    // …and once the uncompressed pack the worker actually loads is present, true.
    await fs.writeFile(path.join(dir, "rus.traineddata"), "fake");
    expect(ocrLangIsInstalled("rus", dir)).toBe(true);
  });

  it("assertOcrLangsInstalled THROWS naming the missing pack + the install command (NEGATIVE)", () => {
    expect(() => assertOcrLangsInstalled("eng", dir)).toThrow(/not installed/i);
    expect(() => assertOcrLangsInstalled("eng", dir)).toThrow(/install-ocr-lang eng/);
  });

  it("assertOcrLangsInstalled passes once the pack exists (POSITIVE)", async () => {
    await fs.writeFile(path.join(dir, "eng.traineddata"), "fake");
    expect(() => assertOcrLangsInstalled("eng", dir)).not.toThrow();
  });

  it("multi-language (eng+rus): throws listing ONLY the missing pack", async () => {
    await fs.writeFile(path.join(dir, "eng.traineddata"), "fake"); // eng present, rus missing
    let msg = "";
    try {
      assertOcrLangsInstalled("eng+rus", dir);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/not installed/i);
    expect(msg).toContain("rus");
    expect(msg).not.toContain("eng"); // the installed lang must not appear as missing
  });
});

describe("extractPdfWithOcr offline pre-flight (#16 — the load-bearing guard)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ocr-pre-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("THROWS 'not installed' BEFORE loading any optional dep when the pack is absent (NEGATIVE)", async () => {
    // Empty langPath → the pre-flight throws before pdfjs/canvas/tesseract load.
    // This asserts the "zero outbound network calls" guarantee holds even on a
    // host without the optional deps — a missing pack can never reach the CDN.
    await expect(extractPdfWithOcr(Buffer.from("not-a-real-pdf"), { langPath: dir, langs: "eng" })).rejects.toThrow(
      /not installed/i
    );
  });
});

describe("clampOcrScale — canvas-OOM DoS guard (v3.9.0-rc.10)", () => {
  it("leaves a normal A4-ish page scale unchanged (POSITIVE)", () => {
    // ~595×842 pt (A4) at scale 2 → ~1190×1684 px, well under the cap.
    expect(clampOcrScale(595, 842, 2)).toBe(2);
    expect(clampOcrScale(100, 100, 4)).toBe(4);
  });
  it("LOWERS the scale for an adversarially huge MediaBox so px stays bounded (NEGATIVE control)", () => {
    // PDF spec max 14400×14400 pt. At scale 2 that's 28800 px → must shrink.
    const eff = clampOcrScale(14400, 14400, 2);
    expect(eff).toBeLessThan(2);
    expect(14400 * eff).toBeLessThanOrEqual(MAX_OCR_CANVAS_DIM + 1);
  });
  it("bounds the rendered side ≤ cap even for a >50,000pt MediaBox (rc.44 M2 — the 0.1 floor used to defeat the cap)", () => {
    // Pre-rc.44 `Math.max(0.1, …)` forced the scale back up to 0.1 once 5000/dim < 0.1
    // (any side > 50,000pt) → a 1,000,000pt page rendered at 0.1·1e6 = 100,000px ≈ 40GB
    // canvas → OOM. The floor is gone; the rendered side must now stay within the cap.
    const eff = clampOcrScale(1_000_000, 1_000_000, 4);
    expect(eff).toBeGreaterThan(0); // still a positive, renderable scale
    expect(1_000_000 * eff).toBeLessThanOrEqual(MAX_OCR_CANVAS_DIM + 1);
    // And the call site additionally hard-caps the final canvas pixels (defense-in-depth):
    expect(Math.min(Math.ceil(1_000_000 * eff), MAX_OCR_CANVAS_DIM)).toBeLessThanOrEqual(MAX_OCR_CANVAS_DIM);
  });
});

describe("resolveOcrPageRange (v3.9.0-rc.10)", () => {
  it("defaults to the whole document when no range given (POSITIVE)", () => {
    expect(resolveOcrPageRange(undefined, 10)).toEqual([1, 10]);
  });
  it("clamps an in-bounds range to [1, pageCount]", () => {
    expect(resolveOcrPageRange([2, 5], 10)).toEqual([2, 5]);
    expect(resolveOcrPageRange([0, 99], 10)).toEqual([1, 10]);
  });
  it("THROWS on an inverted range instead of silently returning empty (NEGATIVE control)", () => {
    expect(() => resolveOcrPageRange([5, 2], 10)).toThrow(/invalid page range/i);
  });
});
