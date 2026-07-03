// v3.11.0-rc.17 (rc.16 re-audit, MEDIUM correctness regression) — rc.16 split the
// combined heading regex into `/^(#{1,6})\s+(.+)$/` + linear strips, but `(.+)$`
// (no `s`/`m` flag) does NOT match a line ending in a line terminator. A line from
// `body.split("\n")` retains a trailing `\r` on a CRLF (Windows) note, so EVERY
// heading was silently dropped: readNote(format:"map") → [], obsidian_open_questions
// lost section breadcrumbs, fts5 lost heading enrichment. The pre-rc.16 combined
// form absorbed the `\r` via its trailing `\s*`. Fix: stripTrailingLineEnds() before
// the match at all 3 sites (read.ts / meta.ts / fts5.ts). The rc.16 POSITIVE test
// corpus was LF-only and could not produce the divergent shape (the recurring
// rc.36/rc.54 "differential corpus can't produce the failing shape" lesson).

import { promises as fs, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOpenQuestions, readNote } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";
import { stripTrailingLineEnds } from "../src/wildcard-match.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("stripTrailingLineEnds (rc.17) — linear trailing line-terminator strip", () => {
  it("strips trailing \\r \\n U+2028 U+2029 (POSITIVE), leaves interior + plain (control)", () => {
    expect(stripTrailingLineEnds("# Top\r")).toBe("# Top");
    expect(stripTrailingLineEnds("# Top\n")).toBe("# Top");
    expect(stripTrailingLineEnds("# Top ")).toBe("# Top");
    expect(stripTrailingLineEnds("# Top ")).toBe("# Top");
    expect(stripTrailingLineEnds("# Top\r\n")).toBe("# Top");
    expect(stripTrailingLineEnds("a\rb\r")).toBe("a\rb"); // interior \r preserved
    expect(stripTrailingLineEnds("# Top")).toBe("# Top"); // no terminator → unchanged
    expect(stripTrailingLineEnds("")).toBe("");
  });

  it("a `(.+)$` match SUCCEEDS after the strip and FAILS without it (NEGATIVE control)", () => {
    const HEAD = /^(#{1,6})\s+(.+)$/;
    expect(HEAD.exec("# Heading\r")).toBeNull(); // the bug: raw CRLF line never matches
    expect(HEAD.exec(stripTrailingLineEnds("# Heading\r"))?.[2]).toBe("Heading"); // fixed
  });
});

describe("readNote map (rc.17) — CRLF notes keep their headings", () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-crlf-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("a CRLF-saved note returns its headings (POSITIVE — was [] before rc.17)", async () => {
    const v = new Vault(root);
    // Authored with Windows CRLF line endings.
    await fs.writeFile(path.join(root, "Crlf.md"), "# Top Heading\r\nbody\r\n## Second\r\n### Deep\r\n");
    const result = await readNote(v, { path: "Crlf.md", format: "map" });
    if (!("format" in result)) throw new Error("expected map projection");
    expect(result.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`)).toEqual([
      "# Top Heading",
      "## Second",
      "### Deep"
    ]);
  });

  it("the LF sibling is identical (control — the fix is a no-op on LF notes)", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "Lf.md"), "# Top Heading\nbody\n## Second\n### Deep\n");
    const result = await readNote(v, { path: "Lf.md", format: "map" });
    if (!("format" in result)) throw new Error("expected map projection");
    expect(result.headings.map((h) => h.text)).toEqual(["Top Heading", "Second", "Deep"]);
  });
});

describe("CRLF heading (rc.17) — the heading-exec site strips line ends (inventory guard)", () => {
  // The ATX-heading capture `/^(#{1,6})\s+(.+)$/` MUST run on a line-end-stripped line.
  // v3.11.6-rc.2 — read.ts / meta.ts / fts5.ts stopped hand-rolling this; the ONE heading
  // parse now lives in src/structure.ts (`HEADING_RE.exec(stripTrailingLineEnds(t))`), so the
  // single-authority consolidation shrank this guard's SITES from 3 walkers to 1 module. A
  // regression that drops the strip — or a NEW file that re-hand-rolls the exec un-stripped —
  // fails CI here (the detector matches BOTH the inline literal and the named `HEADING_RE` form).
  // The ATX-heading exec as the inline literal `/^(#{1,6})\s+(.+)$/.exec(x)` OR the named
  // `HEADING_RE.exec(x)` (structure.ts). `\b` before HEADING_RE excludes unrelated regexes whose
  // name merely ENDS in it (e.g. CHAT_HEADING_RE — a `### role · ts` parser whose `\s*$` already
  // absorbs a trailing `\r`, so it is NOT the CRLF-vulnerable `(.+)$` shape).
  const HEAD_EXEC = /(?:\/\^\(#\{1,6\}\)\\s\+\(\.\+\)\$\/|\bHEADING_RE)\.exec\(([^)]*)\)/g;

  it("EVERY heading-exec across src/ wraps its line in stripTrailingLineEnds (POSITIVE)", () => {
    const offenders: string[] = [];
    let total = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
          continue;
        }
        if (!e.name.endsWith(".ts")) continue;
        const src = readFileSync(full, "utf8");
        const rel = path.relative(repoRoot, full);
        HEAD_EXEC.lastIndex = 0;
        let m: RegExpExecArray | null = HEAD_EXEC.exec(src);
        while (m !== null) {
          total++;
          if (!/stripTrailingLineEnds\(/.test(m[1] ?? ""))
            offenders.push(`${rel}: exec(${m[1]}) not line-end-stripped`);
          m = HEAD_EXEC.exec(src);
        }
      }
    };
    walk(path.join(repoRoot, "src"));
    // Non-vacuous: the ATX-heading parse must exist somewhere (it lives in src/structure.ts since rc.2).
    expect(total, "no heading-exec found in src/ (renamed? the parse lives in structure.ts)").toBeGreaterThan(0);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the guard fires on an un-stripped heading exec (NEGATIVE control)", () => {
    const probe = "const m = /^(#{1,6})\\s+(.+)$/.exec(line);";
    HEAD_EXEC.lastIndex = 0;
    const m = HEAD_EXEC.exec(probe);
    HEAD_EXEC.lastIndex = 0;
    expect(m).not.toBeNull();
    expect(/stripTrailingLineEnds\(/.test(m?.[1] ?? "")).toBe(false); // would be flagged
  });
});

describe("CRLF open_questions (rc.19) — getOpenQuestions matches on CRLF candidate lines", () => {
  // The 4th `(.+)$`-over-a-`split("\n")`-line site the rc.17 heading fix missed: the
  // open-questions matcher ran the default/caller pattern on raw `c.line` candidates,
  // so a CRLF note's `Q: …` lines (trailing `\r`) never matched. rc.19 strips
  // `lineTexts` before matching. (Cursor MED-1.)
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-crlf-oq-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("a CRLF note's open question is found (POSITIVE — was silently dropped pre-rc.19)", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "Crlf.md"), "## Section\r\nbody\r\nQ: What is the CRLF answer?\r\n");
    const out = await getOpenQuestions(v, {});
    expect(out.map((q) => q.question)).toContain("What is the CRLF answer?");
  });

  it("the LF sibling is found too (control)", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "Lf.md"), "## Section\nbody\nQ: What is the LF answer?\n");
    const out = await getOpenQuestions(v, {});
    expect(out.map((q) => q.question)).toContain("What is the LF answer?");
  });

  it("getOpenQuestions builds `lineTexts` through stripTrailingLineEnds (inventory guard + NEGATIVE control)", () => {
    const src = readFileSync(path.join(repoRoot, "src/tools/meta.ts"), "utf8");
    const m = /const lineTexts = candidates\.map\(([^;]*)\)/.exec(src);
    expect(m, "lineTexts candidate map not found in meta.ts (moved? update the guard)").not.toBeNull();
    expect(/stripTrailingLineEnds\(/.test(m?.[1] ?? "")).toBe(true);
    // NEGATIVE control — the pre-rc.19 raw form would NOT contain the strip.
    expect(/stripTrailingLineEnds\(/.test("candidates.map((c) => c.line)")).toBe(false);
  });
});
