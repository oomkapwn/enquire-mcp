// v2.15.0 — late-chunking context windowing for embeddings.
//
// Coverage:
//   • contextChars=0 → legacy v2.1.0 form (breadcrumb + chunk text)
//   • contextChars > 0 → doc title + breadcrumb + neighbor tails/heads
//   • Edge cases: first chunk has no prev, last chunk has no next
//   • Word-boundary trimming on neighbor slices
//   • Tolerates missing breadcrumb / docTitle

import { describe, expect, it } from "vitest";
import { MAX_EMBED_CHARS } from "../src/embed-pipeline.js";
import { buildEmbedText } from "../src/index.js";

describe("buildEmbedText (v2.15.0 late-chunking context windowing)", () => {
  const chunks = [
    { text: "Alpha quick brown fox", breadcrumb: "Heading 1" },
    { text: "Beta the lazy dog", breadcrumb: "Heading 1 > Sub" },
    { text: "Gamma jumps over", breadcrumb: "Heading 1 > Sub" }
  ];

  it("contextChars=0 returns legacy form (breadcrumb + chunk text)", () => {
    const out = buildEmbedText(chunks, 1, { docTitle: "Doc", contextChars: 0 });
    // Legacy v2.1.0 form: breadcrumb \n\n chunk
    expect(out).toBe("Heading 1 > Sub\n\nBeta the lazy dog");
    // No doc title or neighbor context.
    expect(out).not.toContain("[doc:");
    expect(out).not.toContain("Alpha");
    expect(out).not.toContain("Gamma");
  });

  it("contextChars=0 omits breadcrumb when chunk has none", () => {
    const out = buildEmbedText([{ text: "Plain text" }], 0, { contextChars: 0 });
    expect(out).toBe("Plain text");
  });

  it("contextChars > 0 includes doc title + breadcrumb + neighbor tails", () => {
    const out = buildEmbedText(chunks, 1, { docTitle: "MyDoc", contextChars: 50 });
    expect(out).toContain("[doc: MyDoc]");
    expect(out).toContain("Heading 1 > Sub");
    expect(out).toContain("Beta the lazy dog");
    // Word-boundary trim drops the first word of the prev tail and the
    // last word of the next head — the rest survives.
    expect(out).toContain("brown fox"); // prev-tail (after dropping "Alpha")
    expect(out).toContain("Gamma jumps"); // next-head (before dropping "over")
    // Order: title, breadcrumb, prev-tail, this, next-head
    const titleIdx = out.indexOf("[doc:");
    const breadcrumbIdx = out.indexOf("Heading 1 > Sub");
    const prevIdx = out.indexOf("brown fox");
    const thisIdx = out.indexOf("Beta");
    const nextIdx = out.indexOf("Gamma");
    expect(titleIdx).toBeLessThan(breadcrumbIdx);
    expect(breadcrumbIdx).toBeLessThan(prevIdx);
    expect(prevIdx).toBeLessThan(thisIdx);
    expect(thisIdx).toBeLessThan(nextIdx);
  });

  it("first chunk has no prev — only this + next-head", () => {
    const out = buildEmbedText(chunks, 0, { docTitle: "MyDoc", contextChars: 50 });
    expect(out).toContain("Alpha quick brown fox");
    expect(out).toContain("Beta the lazy"); // next-head (before dropping "dog")
    expect(out).not.toMatch(/…\s+[A-Z]/); // no leading prev-tail marker
  });

  it("last chunk has no next — only prev-tail + this", () => {
    const out = buildEmbedText(chunks, 2, { docTitle: "MyDoc", contextChars: 50 });
    expect(out).toContain("the lazy dog"); // prev-tail (after dropping "Beta")
    expect(out).toContain("Gamma jumps over");
    expect(out).not.toMatch(/[a-z]\s+…$/); // no trailing next-head marker
  });

  it("word-boundary trims neighbor slices (no half-words)", () => {
    // Long prev — slice "internationalization concerns" so the tail
    // would land mid-word; we should trim at the next word boundary.
    const longChunks = [
      { text: "long preamble about internationalization concerns" },
      { text: "current chunk content" }
    ];
    const out = buildEmbedText(longChunks, 1, { contextChars: 20 });
    // The slice .slice(-20) is "ionalization concerns". After
    // .replace(/^\S*\s/, "") that becomes "concerns".
    // Should NOT contain the partial word "ionalization".
    expect(out).not.toContain("ionalization");
    // Should contain the trimmed-to-word-boundary slice.
    expect(out).toContain("concerns");
  });

  it("ignores undefined docTitle (no [doc:] line)", () => {
    const out = buildEmbedText(chunks, 1, { contextChars: 50 });
    expect(out).not.toContain("[doc:");
    expect(out).toContain("Heading 1 > Sub");
    expect(out).toContain("Beta the lazy dog");
  });

  it("returns empty string when index is out of range", () => {
    expect(buildEmbedText(chunks, 10, { contextChars: 0 })).toBe("");
    expect(buildEmbedText([], 0, { contextChars: 100 })).toBe("");
  });

  // v3.9.0-rc.28 (external-audit M-2) — clamp pathological assembled text.
  describe("MAX_EMBED_CHARS clamp", () => {
    const big = "word ".repeat(6000); // ~30K chars per chunk
    const huge = [
      { text: big, breadcrumb: "H > Prev" },
      // Marker at the START of the chunk so it survives the head-of-core clamp.
      { text: `CORECHUNK ${big}`, breadcrumb: "H > Mid" },
      { text: big, breadcrumb: "H > Next" }
    ];

    it("clamps an oversized assembled context to <= MAX_EMBED_CHARS and keeps the core chunk", () => {
      const out = buildEmbedText(huge, 1, { contextChars: 20000, docTitle: "Doc" });
      expect(out.length).toBeLessThanOrEqual(MAX_EMBED_CHARS);
      // The core chunk text must survive the clamp (neighbor context is dropped first).
      expect(out).toContain("CORECHUNK");
    });

    it("(NEGATIVE control) does NOT clamp normal-size assembled text", () => {
      // A modest context window stays well under the cap → returned verbatim,
      // INCLUDING the neighbor context (proves the clamp only fires when over budget).
      const out = buildEmbedText(chunks, 1, { contextChars: 50, docTitle: "Doc" });
      expect(out.length).toBeLessThan(MAX_EMBED_CHARS);
      expect(out).toContain("[doc: Doc]");
      expect(out).toContain("…"); // neighbor context present (not the clamp fallback)
    });
  });
});
