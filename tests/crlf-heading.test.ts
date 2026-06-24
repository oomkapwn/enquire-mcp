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

import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readNote } from "../src/tools/index.js";
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

describe("CRLF heading (rc.17) — every heading-exec site strips line ends (inventory guard)", () => {
  // Each file's `/^(#{1,6})\s+(.+)$/` heading capture MUST run on a line-end-stripped
  // line. A 4th site (or a regression that drops the strip) fails CI here.
  const SITES = ["src/tools/read.ts", "src/tools/meta.ts", "src/fts5.ts"];
  const HEAD_EXEC = /\/\^\(#\{1,6\}\)\\s\+\(\.\+\)\$\/\.exec\(([^)]*)\)/g;

  it("the 3 known heading-exec sites wrap their line in stripTrailingLineEnds (POSITIVE)", () => {
    const offenders: string[] = [];
    for (const rel of SITES) {
      const src = readFileSync(path.join(repoRoot, rel), "utf8");
      let m: RegExpExecArray | null = HEAD_EXEC.exec(src);
      let found = 0;
      while (m !== null) {
        found++;
        if (!/stripTrailingLineEnds\(/.test(m[1] ?? "")) offenders.push(`${rel}: exec(${m[1]}) not line-end-stripped`);
        m = HEAD_EXEC.exec(src);
      }
      if (found === 0) offenders.push(`${rel}: heading-exec site not found (moved? update SITES)`);
      HEAD_EXEC.lastIndex = 0;
    }
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
