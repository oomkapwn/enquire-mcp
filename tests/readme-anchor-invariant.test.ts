// v3.11.0-rc.4 audit response — anchor-integrity invariant for the 9-language
// README surface. The rc.2 i18n batch localized section headings but left English
// nav/badge anchors in README.ru.md (3 dead links), and the canonical README.md's
// tests badge had pointed at `#trust` since the Trust section was added — but
// "🛡️ Trust" slugs to `️-trust` (a leading variation-selector + hyphen), so
// `#trust` never resolved. No existing gate caught either: docs-consistency checks
// numeric CLAIMS, not link TARGETS. This invariant asserts every in-file `(#anchor)`
// in every README resolves to a heading or an explicit HTML anchor. Heading slugs
// use `github-slugger` — the exact algorithm GitHub's own renderer applies
// (incl. unicode + emoji + VS-16 handling).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * In-file `(#...)` anchors in `markdown` that do NOT resolve to any heading slug
 * or explicit `<a id="...">` / `<a name="...">` target.
 * Only same-document `#anchor` link targets are checked; cross-file (`./x`) and
 * external (`https://`) targets are ignored. Slugs are computed with github-slugger
 * (one slugger per document, matching GitHub's per-page de-duplication semantics).
 */
function brokenInFileAnchors(markdown: string): string[] {
  const slugger = new GithubSlugger();
  const targets = new Set<string>();
  for (const line of markdown.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) targets.add(slugger.slug(m[1] as string));
    for (const anchor of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
      targets.add(anchor[1] as string);
    }
  }
  const anchors = [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] as string);
  return [...new Set(anchors)].filter((a) => !targets.has(a));
}

async function readmeFiles(): Promise<string[]> {
  return (await fs.readdir(ROOT)).filter((f) => /^README.*\.md$/.test(f)).sort();
}

describe("README anchor-integrity invariant (11-language surface)", () => {
  it("every in-file (#anchor) in every README resolves to a heading or explicit anchor", async () => {
    const files = await readmeFiles();
    expect(files.length).toBeGreaterThanOrEqual(9); // EN + zh/es/hi/ar/ru/pt/fr/ja
    const failures: string[] = [];
    for (const f of files) {
      const broken = brokenInFileAnchors(await fs.readFile(path.join(ROOT, f), "utf8"));
      if (broken.length) failures.push(`${f}: ${JSON.stringify(broken)}`);
    }
    expect(failures).toEqual([]);
  });

  it("NEGATIVE control — the detector flags an anchor with no matching heading (not vacuous)", () => {
    const md = [
      "## ⚡ Quick start",
      '<a id="stable-proof"></a>',
      "",
      "[live](#-quick-start), [explicit](#stable-proof), and [dead](#no-such-heading)"
    ].join("\n");
    const broken = brokenInFileAnchors(md);
    expect(broken).toContain("no-such-heading"); // the dead link is caught…
    expect(broken).not.toContain("-quick-start"); // …and the real one resolves
    expect(broken).not.toContain("stable-proof"); // …including explicit stable targets
  });
});
