// META-invariant: a tracked text file must never carry the residue of an
// unresolved merge or of a sloppy conflict-resolution script.
//
// Why this exists. On 2026-10-14 seven such lines reached `main` with all
// 24 CI jobs green. Every gate that reads CHANGELOG.md reads *claims*, not
// text — `check-version-consistency` reads only the first `## [` heading,
// `docs-consistency` reads the `### Tests (N)` slot — so debris sitting
// BETWEEN entries is invisible by construction. `CHANGELOG.md` is also in
// `package.json` `files`, so the debris was on its way to the npm tarball.
//
// The scan is PATTERN-based, not a list of the strings one author happened
// to leave. A first cleanup pass removed six lines and declared the tree
// clean because its grep listed what that author expected to find; it
// missed `plain# Changelog` on line 1. A scan that only looks for what you
// predicted is not a scan. Hence two families: merge markers, and the
// internal labels that ad-hoc resolvers concatenate onto their output.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");

/** Extensions whose line structure can carry a merge marker or a script label. */
const TEXT_SUFFIXES = new Set([".md", ".ts", ".tsx", ".mjs", ".cjs", ".js", ".json", ".yml", ".yaml", ".py", ".txt"]);

/** Directories that never contain tracked, reviewed content. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".git/info"]);

/**
 * One line of debris.
 *
 * `marker-tail`, `plain` and `hunk` are the internal labels an ad-hoc Python
 * conflict resolver concatenates onto its own output. They are glued to
 * something that follows: a heading (`plain# Changelog`), a merge marker
 * (`plain>>>>>>> 3308c6c …`) or the end of the line (`marker-tail`).
 *
 * The following-character class is what keeps this from flagging ordinary
 * prose. `plain English is fine` and `hunk of data` are NOT residue; requiring
 * `#`, `<`, `>` or end-of-line is the difference between a sweep and a
 * nuisance. The first cleanup pass listed only the exact strings one author
 * left, and missed `plain# Changelog` on line 1 of CHANGELOG.md while an
 * audit run caught it independently.
 *
 * A bare `=======` is deliberately NOT matched: in Markdown it is a setext
 * H2 underline, so it is legitimate content on its own. Every real conflict
 * block also opens with `<<<<<<<`, which is matched, so nothing is lost.
 */
const RESIDUE = [
  /^<<<<<<</u, // merge conflict, ours side
  /^>>>>>>>/u, // merge conflict, end side
  /^(?:plain|hunk|marker-tail)(?:#{1,6}(?:\s|$)|[<>=]|$)/u // resolver label glued to its output
];

function isTracked(relativePath: string): boolean {
  try {
    const out = execFileSync("git", ["ls-files", "--error-unmatch", relativePath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function collectTrackedTextFiles(): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(join(absolute, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const suffix = entry.name.slice(entry.name.lastIndexOf("."));
      if (!TEXT_SUFFIXES.has(suffix)) continue;
      const relativePath = relative(REPO_ROOT, join(absolute, entry.name)).split(sep).join("/");
      if (isTracked(relativePath)) found.push(relativePath);
    }
  };
  walk(REPO_ROOT);
  return found;
}

function residueLines(filePath: string): string[] {
  const hits: string[] = [];
  const lines = readFileSync(join(REPO_ROOT, filePath), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (RESIDUE.some((pattern) => pattern.test(line))) hits.push(`${index + 1}: ${line.trim()}`);
  }
  return hits;
}

describe("META-invariant: tracked files carry no merge or resolver residue", () => {
  it("every tracked text file is free of conflict markers and resolver labels", () => {
    const files = collectTrackedTextFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of residueLines(file)) offenders.push(`${file}:${hit}`);
    }
    expect(
      offenders,
      `tracked text files contain unresolved-merge or resolver residue:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("NEGATIVE: the scanner actually detects the residue that reached main", () => {
    // Without this, the sweep above would be green on a scanner that matches
    // nothing — the failure mode that let the original defect ship. Every line
    // below is one that was actually committed to main on 2026-10-14.
    const real: Array<[string, string]> = [
      ["CHANGELOG.md:1", "plain# Changelog"],
      ["CHANGELOG.md:60", "marker-tail"],
      ["CHANGELOG.md:61", "plain>>>>>>> 3308c6c (fix: an audit process crash ...)"],
      ["CHANGELOG.md:20", ">>>>>>> 0674f78 (fix: a prune that removed nothing ...)"],
      ["src/example.ts", "<<<<<<< HEAD"],
      ["src/example.ts", ">>>>>>> 9f1c2ab (feat: something)"]
    ];
    for (const [where, line] of real)
      expect(
        RESIDUE.some((p) => p.test(line)),
        `${where}: ${line}`
      ).toBe(true);
  });

  it("NEGATIVE: ordinary content that looks similar is NOT flagged", () => {
    const safe: Array<[string, string]> = [
      ["markdown heading", "# Changelog"],
      ["scoped slot", "### Tests (2321)"],
      ["prose using the word plain mid-sentence", "> **Bounded claim.** For plain surfaces the rewrite is a no-op."],
      ["prose starting a line with plain", "plain English is the goal"],
      ["prose starting a line with hunk", "hunk of data was written"],
      ["identifier at line start", "hunk = computeDiff();"],
      ["indented code", "    const plain = { marker: 1 };"],
      ["setext H2 underline — legal Markdown, deliberately not matched", "======="],
      ["table row", "| a | b |"]
    ];
    for (const [where, line] of safe)
      expect(
        RESIDUE.some((p) => p.test(line)),
        `${where}: ${line}`
      ).toBe(false);
  });
});
