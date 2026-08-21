import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ParserCapacityError, parseNote, scanWikilinkInners, stripCodeAndInline } from "../src/parser.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TERMINATORS = ["\n", "\r\n", "\r", "\u2028", "\u2029"] as const;

function legacyRepeatedSuffixWork(text: string): number {
  let work = 0;
  let from = 0;
  for (;;) {
    let open = -1;
    for (let index = from; index + 1 < text.length; index += 1) {
      work += 1;
      if (text[index] === "[" && text[index + 1] === "[") {
        open = index;
        break;
      }
    }
    if (open < 0) return work;
    const innerStart = open + 2;
    let bracket = -1;
    for (let index = innerStart; index < text.length; index += 1) {
      work += 1;
      if (text[index] === "]") {
        bracket = index;
        break;
      }
    }
    if (bracket < 0) return work;
    let newline = -1;
    for (let index = innerStart; index < bracket; index += 1) {
      work += 1;
      if (text[index] === "\n") {
        newline = index;
        break;
      }
    }
    if (newline < 0) return work;
    from = newline + 1;
  }
}

function legacyInlineSuffixWork(text: string): number {
  let work = 0;
  let cursor = 0;
  while (cursor < text.length) {
    work += 1;
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let openerEnd = cursor;
    while (text[openerEnd] === "`") {
      openerEnd += 1;
      work += 1;
    }
    const runLength = openerEnd - cursor;
    let search = openerEnd;
    let found = false;
    while (search < text.length) {
      work += 1;
      if (text[search] !== "`") {
        search += 1;
        continue;
      }
      let end = search;
      while (text[end] === "`") {
        end += 1;
        work += 1;
      }
      if (end - search === runLength) {
        cursor = end;
        found = true;
        break;
      }
      search = end;
    }
    if (!found) cursor = openerEnd;
  }
  return work;
}

describe("parser scanners — canonical terminators and deterministic linear work", () => {
  it("terminates wikilink candidates at LF / CRLF / CR / LS / PS and resumes after each boundary", () => {
    for (const terminator of TERMINATORS) {
      const text = `[[crosses${terminator}[[kept]]`;
      expect(scanWikilinkInners(text), JSON.stringify(terminator)).toEqual(["kept"]);
    }
  });

  it("uses monotonic work on the repeated-newline suffix shape (m=8), while the prior shape rescans", () => {
    const text = `${"[[a\n".repeat(8)}]]`;
    const counter = { operations: 0 };
    expect(scanWikilinkInners(text, false, { operationCounter: counter })).toEqual([]);
    expect(counter.operations).toBeLessThanOrEqual(text.length * 2);
    expect(legacyRepeatedSuffixWork(text)).toBeGreaterThan(counter.operations * 2);
  });

  it("has no suffix-search primitive in either scanner (structural causal control)", () => {
    const source = readFileSync(path.join(repoRoot, "src/parser.ts"), "utf8");
    const wikilinkScanner = source.slice(
      source.indexOf("function scanWikilinkOccurrences("),
      source.indexOf("/**\n * Extract all `[[wikilinks]]`")
    );
    const inlineScanner = source.slice(
      source.indexOf("function stripInlineCodeRange("),
      source.indexOf("function nextLineBounds(")
    );
    expect(wikilinkScanner).not.toContain("indexOf(");
    expect(inlineScanner).not.toContain("indexOf(");
    expect(wikilinkScanner.indexOf("budget.reserveOccurrence")).toBeLessThan(wikilinkScanner.indexOf("onMatch("));
    expect(inlineScanner.indexOf("budget.reserveOccurrence")).toBeLessThan(inlineScanner.indexOf("runs.push("));
  });
});

describe("parser inline-code scanner — whole-text CommonMark delimiter runs", () => {
  it("shields links and tags in multiline spans for every canonical line terminator", () => {
    for (const terminator of TERMINATORS) {
      const note = parseNote(`before \`code${terminator}[[hidden]] #hidden${terminator}end\` after [[shown]] #shown`);
      expect(
        note.wikilinks.map((link) => link.target),
        JSON.stringify(terminator)
      ).toEqual(["shown"]);
      expect(note.tags, JSON.stringify(terminator)).toEqual(["shown"]);
    }
  });

  it("pairs only equal maximal runs, while later runs remain eligible after an unmatched opener", () => {
    const exact = parseNote("`` alpha ` [[hidden]]\n beta `` [[shown]] #shown");
    expect(exact.wikilinks.map((link) => link.target)).toEqual(["shown"]);

    const unmatchedThenPair = parseNote("` literal ``[[hidden]]`` [[shown]] #shown");
    expect(unmatchedThenPair.wikilinks.map((link) => link.target)).toEqual(["shown"]);
    expect(unmatchedThenPair.tags).toEqual(["shown"]);

    const unmatchedOnly = parseNote("` literal\n[[visible]] #visible");
    expect(unmatchedOnly.wikilinks.map((link) => link.target)).toEqual(["visible"]);
    expect(unmatchedOnly.tags).toEqual(["visible"]);
  });

  it("applies backslash escaping only while outside a span", () => {
    const escaped = parseNote("\\`[[visible]] #visible\\` [[shown]] #shown");
    expect(escaped.wikilinks.map((link) => link.target)).toEqual(["visible", "shown"]);
    expect(escaped.tags).toEqual(["visible", "shown"]);

    // The first of two backticks is escaped; the residual one opens and the
    // final single run closes. Backslashes inside the span do not escape a close.
    const residual = parseNote("\\``[[hidden]]` [[shown]] #shown");
    expect(residual.wikilinks.map((link) => link.target)).toEqual(["shown"]);
    expect(residual.tags).toEqual(["shown"]);
  });

  it("preserves exact terminators inside removed multiline spans", () => {
    for (const terminator of TERMINATORS) {
      expect(stripCodeAndInline(`left \`hidden${terminator}code\` right`)).toBe(`left ${terminator} right`);
    }
  });

  it("avoids repeated suffix work for eight distinct unmatched run lengths", () => {
    const text = Array.from({ length: 8 }, (_, index) => `${"`".repeat(index + 1)}x`).join("");
    const counter = { operations: 0 };
    expect(stripCodeAndInline(text, { maxOccurrences: 8, operationCounter: counter })).toBe(text);
    expect(counter.operations).toBeLessThanOrEqual(text.length * 3);
    expect(legacyInlineSuffixWork(text)).toBeGreaterThan(counter.operations);
  });
});

describe("parser-wide fail-closed budgets — modest cap=8 controls", () => {
  it("admits exactly eight occurrences and rejects the ninth across parser phases", () => {
    const eight = "[[x]]".repeat(8);
    expect(parseNote(eight, { maxOccurrences: 8 }).wikilinks).toHaveLength(8);
    expect(() => parseNote(`${eight}![[x]]`, { maxOccurrences: 8 })).toThrow(ParserCapacityError);

    // Negative control: raising the lower cap by one admits the same ninth item.
    const admitted = parseNote(`${eight}![[x]]`, { maxOccurrences: 9 });
    expect(admitted.wikilinks).toHaveLength(8);
    expect(admitted.embeds).toHaveLength(1);
  });

  it("checks UTF-8 source and capture bytes, including multibyte boundaries", () => {
    expect(parseNote("éééé", { maxSourceUtf8Bytes: 8 }).body).toBe("éééé");
    expect(() => parseNote("ééééa", { maxSourceUtf8Bytes: 8 })).toThrow(ParserCapacityError);

    expect(scanWikilinkInners("[[éééé]]", false, { maxCapturedUtf8Bytes: 8 })).toEqual(["éééé"]);
    expect(() => scanWikilinkInners("[[ééééa]]", false, { maxCapturedUtf8Bytes: 8 })).toThrow(ParserCapacityError);

    expect(parseNote("[[éé]]", { maxCapturedUtf8Bytes: 8 }).wikilinks[0]?.target).toBe("éé");
    expect(() => parseNote("[[ééa]]", { maxCapturedUtf8Bytes: 8 })).toThrow(ParserCapacityError);
  });

  it("bounds the code-run inventory before its ninth push", () => {
    const eightRuns = Array.from({ length: 8 }, (_, index) => `${"`".repeat(index + 1)}x`).join("");
    const nineRuns = `${eightRuns}${"`".repeat(9)}x`;
    expect(stripCodeAndInline(eightRuns, { maxOccurrences: 8 })).toBe(eightRuns);
    expect(() => stripCodeAndInline(nineRuns, { maxOccurrences: 8 })).toThrow(ParserCapacityError);
    expect(stripCodeAndInline(nineRuns, { maxOccurrences: 9 })).toBe(nineRuns);
  });
});
