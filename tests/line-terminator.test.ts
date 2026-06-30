// v3.11.0-rc.23 (external rc.21 audit — Cursor LOW-1 / Goose FIND-1+FIND-3 / Minimax F-1).
//
// THE LINE-TERMINATOR CLASS. rc.17/rc.19 fixed CRLF heading/open-question drops by
// STRIPPING a trailing `\r`/U+2028/U+2029 from an LF-split line (`stripTrailingLineEnds`).
// But the ROOT was never fixed: `text.split("\n")` only splits on LF, so a note saved
// with bare CR (classic-Mac) or with U+2028/U+2029 as the line SEPARATOR collapsed to
// one "line" — the strip handled the trailing terminator but the split didn't isolate
// the lines at all. Consequences the external rc.21 audits surfaced:
//   • read-path (LOW): extractHeadings / getOpenQuestions / snippet line-numbers merged;
//   • write-path (MEDIUM, DATA CORRUPTION): rewriteOutsideCodeFences /
//     replaceStringOutsideCodeFences detect code fences per `split("\n")` line, so on a
//     CR/LS/PS note the whole body is ONE line, the fence regex never fires, and a
//     wikilink INSIDE a fenced code block is rewritten on rename/replace.
// The fix is `splitLines` (splits on the SAME set stripTrailingLineEnds strips:
// `\n`/`\r\n`/`\r`/U+2028/U+2029) routed through every note-content split site.

import { promises as fs, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOpenQuestions, readNote } from "../src/tools/index.js";
import { replaceStringOutsideCodeFences, rewriteOutsideCodeFences } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";
import { splitLines, splitLinesWithEnds } from "../src/wildcard-match.js";

const LS = "\u2028";
const PS = "\u2029";

describe("splitLines (rc.23) — splits on every terminator the project treats as one", () => {
  it("splits on LF / CRLF / bare CR / U+2028 / U+2029 (POSITIVE)", () => {
    expect(splitLines("a\u0085b")).toEqual(["a\u0085b"]); // NEL
    expect(splitLines("a\u000Bb")).toEqual(["a\u000Bb"]); // VT
    expect(splitLines("a\u000Cb")).toEqual(["a\u000Cb"]); // FF
    expect(splitLines(`a${LS}b`)).toEqual(["a", "b"]);
    expect(splitLines(`a${PS}b`)).toEqual(["a", "b"]);
    expect(splitLines(`# H1${LS}## H2${LS}`)).toEqual(["# H1", "## H2", ""]);
  });

  it('is byte-identical to split("\\n") for an LF-only string (no regression on the common path)', () => {
    const lf = "line1\nline2\n\nline4";
    expect(splitLines(lf)).toEqual(lf.split("\n"));
  });

  it("does NOT split on NEL/VT/FF (U+0085/U+000B/U+000C) — not Obsidian/CommonMark line breaks (NEGATIVE control)", () => {
    // The project's stripTrailingLineEnds does not strip these either; treating them as
    // breaks would diverge from how the note renders. They stay INSIDE a line.
    expect(splitLines("ab")).toEqual(["ab"]);
    expect(splitLines("ab")).toEqual(["ab"]);
    expect(splitLines("ab")).toEqual(["ab"]);
  });
});

describe("code-fence write-path (rc.23) — no corruption on CR/LS/PS notes (Goose FIND-3, MED)", () => {
  const fenced = (sep: string): string =>
    `Intro${sep}${sep}\`\`\`python${sep}[[oldlink]]${sep}\`\`\`${sep}${sep}[[oldlink]] outside${sep}`;
  const plan = new Map([["oldlink", { kind: "wikilink" as const, newRaw: "newlink" }]]);

  it("rewriteOutsideCodeFences rewrites ONLY the link outside the fence, for every separator (POSITIVE)", () => {
    for (const sep of ["\n", "\r\n", "\r", LS, PS]) {
      const r = rewriteOutsideCodeFences(fenced(sep), plan);
      expect(r.count, `separator ${JSON.stringify(sep)} must rewrite exactly 1 (the outside link)`).toBe(1);
    }
  });

  it('the pre-rc.23 split("\\n") form WOULD corrupt the in-fence link on an LS note (NEGATIVE control)', () => {
    // Reproduce the old behavior inline: split only on \n → whole LS body is one line →
    // fence regex never fires → both links rewritten (count 2).
    const content = fenced(LS);
    const oldLines = content.split("\n");
    let inFence = false;
    let count = 0;
    for (const line of oldLines) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      let idx = line.indexOf("[[oldlink]]");
      while (idx !== -1) {
        count++;
        idx = line.indexOf("[[oldlink]]", idx + 1);
      }
    }
    expect(count).toBe(2); // the bug: both links (incl. the in-fence one) counted as "outside"
    expect(rewriteOutsideCodeFences(content, plan).count).toBe(1); // the fix: only the real outside link
  });
});

describe("read-path (rc.23) — headings + open-questions on CR/LS notes (Cursor LOW-1 / Goose FIND-1)", () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-lineterm-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("readNote(format:map) returns both headings for CR- and LS-separated notes (POSITIVE)", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "cr.md"), "# Top\rbody\r## Second\r");
    await fs.writeFile(path.join(root, "ls.md"), `# Top${LS}body${LS}## Second${LS}`);
    for (const p of ["cr.md", "ls.md"]) {
      const result = await readNote(v, { path: p, format: "map" });
      if (!("format" in result)) throw new Error("expected map projection");
      expect(
        result.headings.map((h) => h.text),
        `${p} headings`
      ).toEqual(["Top", "Second"]);
    }
  });

  it("getOpenQuestions finds a question on an LS-separated note (POSITIVE — was merged pre-rc.23)", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "q.md"), `## Section${LS}body${LS}Q: What is the LS answer?${LS}`);
    const out = await getOpenQuestions(v, {});
    expect(out.map((q) => q.question)).toContain("What is the LS answer?");
  });
});

describe('line-terminator inventory (rc.23) — no raw split("\\n") on note content', () => {
  const SRC = path.resolve(__dirname, "..", "src");
  // Allowlisted: the helper itself defines splitLines; eval.ts splits an internal JSONL
  // dataset (not vault note content), so it legitimately uses split("\n").
  const ALLOW = new Set(["wildcard-match.ts", "eval.ts"]);

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) out.push(...tsFiles(full));
      else if (e.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  // Pure detector — strip comments, then find a code-level LF-only line op: `.split("\n")`
  // (the splitting form) OR `.match(/\n/g)` (the COUNTING form, v3.11.0-rc.25). Both are
  // CR/LS/PS-blind; note content must go through splitLines() / countLineBreaks().
  function rawLineOpOffenders(source: string): boolean {
    const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
    return noBlock
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "")) // drop line comments
      .some((l) => /\.split\(\s*["']\\n["']\s*\)/.test(l) || /\.match\(\/\\n\/g\)/.test(l));
  }

  it("every note-content line op goes through splitLines / countLineBreaks (POSITIVE)", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(SRC)) {
      if (ALLOW.has(path.basename(f))) continue;
      if (rawLineOpOffenders(readFileSync(f, "utf8"))) {
        offenders.push(
          `${path.relative(SRC, f)} uses a raw .split("\\n") or .match(/\\n/g) — route note content through splitLines()/countLineBreaks()`
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the detector fires on a raw split AND a raw match-count, ignores comments / helper calls (NEGATIVE control)", () => {
    expect(rawLineOpOffenders('const lines = body.split("\\n");')).toBe(true);
    expect(rawLineOpOffenders("const n = (body.match(/\\n/g) ?? []).length;")).toBe(true); // rc.25 counting form
    expect(rawLineOpOffenders('// a comment about body.split("\\n") is fine')).toBe(false);
    expect(rawLineOpOffenders("const lines = splitLines(body);")).toBe(false);
    expect(rawLineOpOffenders("const n = countLineBreaks(body);")).toBe(false);
    expect(rawLineOpOffenders('/* block: body.split("\\n") */')).toBe(false);
  });
});

// v3.11.4-rc.2 (full-audit CRLF-WRITEBACK-1, MED) — the WRITE-PATH terminator-PRESERVATION leg.
// rc.23 routed the write rewriters through the terminator-aware splitLines() (fixing fence
// detection on CR/LS/PS notes) BUT they rejoined with a hard-coded out.join("\n") — so a single
// replace_in_notes / rename_note on a CRLF (Windows) note silently flattened EVERY line ending to
// LF, producing a whole-file spurious diff. Fix: split with splitLinesWithEnds (captures each
// line's own terminator) and rejoin line+terminator. These behavioral round-trips are the durable
// guard the inventory invariant (split-only) couldn't give — a future regression to join("\n") fails.
describe("write-path rewriters PRESERVE the original line terminator (v3.11.4-rc.2 CRLF-WRITEBACK-1)", () => {
  it("splitLinesWithEnds.lines is byte-identical to splitLines (no read-path regression)", () => {
    for (const s of ["a\nb\nc", "a\r\nb\r\n", "a\rb", "x y z", "", "abc", "a\nb\n"]) {
      expect(splitLinesWithEnds(s).lines).toEqual(splitLines(s));
    }
  });

  it("replaceStringOutsideCodeFences keeps CRLF / CR / U+2028 (POSITIVE), LF unchanged", () => {
    const crlf = replaceStringOutsideCodeFences("alpha foo\r\nbeta\r\ngamma\r\n", "foo", "bar", false);
    expect(crlf.content).toBe("alpha bar\r\nbeta\r\ngamma\r\n");
    expect(crlf.count).toBe(1);
    expect(replaceStringOutsideCodeFences("a\rb\rc", "b", "B", false).content).toBe("a\rB\rc");
    expect(replaceStringOutsideCodeFences("p q r", "q", "Q", false).content).toBe("p Q r");
    // common path: LF-only note is byte-identical to the old behavior
    expect(replaceStringOutsideCodeFences("a\nb\nc", "b", "B", false).content).toBe("a\nB\nc");
  });

  it("rewriteOutsideCodeFences (rename backlinks) keeps CRLF (POSITIVE)", () => {
    const r = rewriteOutsideCodeFences(
      "see [[Old]]\r\nand [[Old]] again\r\n",
      new Map([["Old", { kind: "wikilink", newRaw: "New" }]])
    );
    expect(r.content).toBe("see [[New]]\r\nand [[New]] again\r\n");
    expect(r.count).toBe(2);
  });

  it('NEGATIVE control: a bare out.join("\\n") rejoin would FLATTEN CRLF — proving the test discriminates', () => {
    // Simulate the pre-fix rejoin (split-aware, join LF) and assert it loses the terminator,
    // so the POSITIVE tests above are non-vacuous (they only pass because the real code preserves it).
    const flattened = splitLinesWithEnds("a\r\nb\r\n").lines.join("\n");
    expect(flattened.includes("\r\n")).toBe(false);
    expect(flattened).toBe("a\nb\n");
  });
});
