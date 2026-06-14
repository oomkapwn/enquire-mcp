// v3.10.0-rc.43 (G1) — findBestMatch (the wikilink / find_path resolver) must match
// across Unicode normalization forms. macOS APFS returns filenames in NFD (decomposed),
// while a `[[café]]` link an agent types is typically NFC (composed); `"café"` (NFC) !==
// `"café"` (NFD) even after toLowerCase(), so without NFC-folding the link silently fails
// to resolve. foldKey() now normalizes both index keys and queries to NFC. POSITIVE +
// NEGATIVE controls per the CLAUDE.md rule since v3.6.4.

import { describe, expect, it } from "vitest";
import { findBestMatch } from "../src/tools/index.js";

type FE = { relPath: string; basename: string; absPath: string; mtimeMs: number };
function entry(relPath: string): FE {
  const basename = relPath.split("/").pop() ?? relPath;
  return { relPath, basename, absPath: `/vault/${relPath}`, mtimeMs: 0 };
}
// biome-ignore lint/suspicious/noExplicitAny: findBestMatch's FileEntry is structurally satisfied by FE
const find = (entries: FE[], target: string, from?: string) => findBestMatch(entries as any, target, from);

const NFC = "café"; // "café" — single composed é (U+00E9)
const NFD = "café"; // "café" — e + combining acute (U+0065 U+0301)

describe("findBestMatch — Unicode NFC/NFD normalization (rc.43 G1)", () => {
  it("resolves an NFC wikilink target to an NFD-named file (POSITIVE — the macOS case)", () => {
    expect(NFC).not.toBe(NFD); // sanity: the two byte sequences genuinely differ
    const m = find([entry(`${NFD}.md`)], NFC);
    expect(m?.relPath).toBe(`${NFD}.md`);
  });

  it("resolves an NFD wikilink target to an NFC-named file (POSITIVE — the reverse)", () => {
    const m = find([entry(`${NFC}.md`)], NFD);
    expect(m?.relPath).toBe(`${NFC}.md`);
  });

  it("still matches plain ASCII basenames (POSITIVE regression — fold must not change ASCII)", () => {
    expect(find([entry("Foo.md")], "Foo")?.relPath).toBe("Foo.md");
    expect(find([entry("notes/Bar.md")], "Bar")?.relPath).toBe("notes/Bar.md");
  });

  it("does NOT match a genuinely different name (NEGATIVE control — folding isn't over-permissive)", () => {
    expect(find([entry(`${NFD}.md`)], "latte")).toBeNull();
  });
});
