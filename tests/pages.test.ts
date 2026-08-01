import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import { buildPagesArtifact, validatePagesArtifact } from "../scripts/build-pages.mjs";
import { TOOL_MANIFEST } from "../src/tool-manifest.js";

const repoRoot = resolve(__dirname, "..");
const tempRoots: string[] = [];

async function writeFixtureFile(root: string, rel: string, content = ""): Promise<void> {
  const target = join(root, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function typeDocFixture(): Promise<{ apiSource: string; outDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "enquire-pages-test-"));
  tempRoots.push(root);
  const apiSource = join(root, "typedoc");
  const outDir = join(root, "artifact");
  await writeFixtureFile(
    apiSource,
    "index.html",
    "<!doctype html><html><head><title>enquire-mcp API reference</title></head><body>TypeDoc</body></html>"
  );
  await writeFixtureFile(apiSource, ".nojekyll");
  await writeFixtureFile(apiSource, "assets/style.css", "body{}");
  await writeFixtureFile(apiSource, "functions/tools.searchHybrid.html", "<html>searchHybrid</html>");
  await writeFixtureFile(apiSource, "interfaces/tools.SearchHybridResponse.html", "<html>SearchHybridResponse</html>");
  return { apiSource, outDir, root };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitHub Pages artifact", () => {
  it("gates the same composite artifact in PR CI and the main deploy workflow", async () => {
    const ci = await readFile(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const publish = await readFile(join(repoRoot, ".github/workflows/publish-docs.yml"), "utf8");
    const publishPreviewProblems = (candidate: string): string[] => {
      const render = candidate.indexOf("- run: npm run render:preview");
      const diff = candidate.indexOf("- run: git diff --exit-code -- assets/social-preview.png");
      const docs = candidate.indexOf("- run: npm run docs:pages");
      const problems: string[] = [];
      if (render < 0) problems.push("missing remote preview render");
      if (diff < 0) problems.push("missing preview byte gate");
      if (render >= diff || diff >= docs) problems.push("preview gate must precede Pages build");
      return problems;
    };

    expect(ci).toContain("- run: npm run docs:pages");
    expect(publish).toContain("- run: npm run docs:pages");
    expect(publish).toContain("path: .pages-dist");
    expect(publish).not.toContain("path: docs/api-reference");
    expect(publishPreviewProblems(publish)).toEqual([]);
    expect(
      publishPreviewProblems(publish.replace("- run: npm run render:preview", "- run: echo stale preview"))
    ).toContain("missing remote preview render");
    expect(
      publishPreviewProblems(
        publish
          .replace("      - run: npm run render:preview\n", "")
          .replace(
            "      - run: npm run docs:pages\n",
            "      - run: npm run docs:pages\n      - run: npm run render:preview\n"
          )
      )
    ).toContain("preview gate must precede Pages build");
  });

  it("builds a crawlable root while preserving legacy and /api/ TypeDoc URLs", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    const result = await buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir });

    expect(result.fileCount).toBeGreaterThan(15);
    expect(result.bytes).toBeGreaterThan(100_000);

    const landing = await readFile(join(outDir, "index.html"), "utf8");
    const legacySymbol = await readFile(join(outDir, "functions/tools.searchHybrid.html"), "utf8");
    const stableApiSymbol = await readFile(join(outDir, "api/functions/tools.searchHybrid.html"), "utf8");
    const manifest = JSON.parse(await readFile(join(outDir, "manifest.webmanifest"), "utf8"));
    const promptSource = await readFile(join(repoRoot, "src/prompts.ts"), "utf8");
    const promptCount = new Set([...promptSource.matchAll(/registerPrompt\(\s*"([^"]+)"/g)].map((match) => match[1]))
      .size;
    const testFiles = (await readdir(join(repoRoot, "tests"))).filter((file) => file.endsWith(".test.ts"));
    let testCount = 0;
    for (const file of testFiles) {
      const source = await readFile(join(repoRoot, "tests", file), "utf8");
      testCount += (source.match(/^\s*it\(/gm) ?? []).length;
    }
    const releaseWorkflow = await readFile(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const releaseGateCount = (/REQUIRED="([^"]+)"/.exec(releaseWorkflow)?.[1] ?? "").split("|").filter(Boolean).length;
    const proofProblems = (candidate: string): string[] => {
      const problems: string[] = [];
      for (const [count, label] of [
        [TOOL_MANIFEST.length.toLocaleString("en-US"), "MCP tools"],
        [promptCount.toLocaleString("en-US"), "MCP prompts"],
        [testCount.toLocaleString("en-US"), "public tests"],
        [releaseGateCount.toLocaleString("en-US"), "release gates"]
      ] as const) {
        if (!candidate.includes(`<strong>${count}</strong><span>${label}</span>`)) {
          problems.push(`missing ${count} ${label}`);
        }
      }
      return problems;
    };

    expect(landing).toContain('<link rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">');
    expect(landing).toContain("<main");
    expect(landing).toContain("application/ld+json");
    expect(landing).toContain("FAQPage");
    expect(landing).toContain('id="install"');
    expect(landing).toContain('id="compare"');
    expect(landing).toContain("Your vault.<br>Every agent.<br><em>Fresh, cited memory.</em>");
    expect(landing).toContain("Complete leadership standard");
    expect(landing).toContain("Reviewed 2026-07-30");
    expect(landing).toContain("<strong>19</strong><span>MCP prompts</span>");
    expect(landing).toContain("<strong>1,807</strong><span>public tests</span>");
    expect(landing).toContain("<strong>50+</strong><span>embedder languages</span>");
    expect(landing).toContain("BM25 + TF-IDF + ML + RRF + BGE + HNSW/int8");
    expect(landing).toContain("Dataview-style LIST/TABLE queries");
    expect(landing).toContain("age_days/stale freshness signals");
    expect(landing).toContain("enquire outbound during serve: 0");
    expect(landing).toContain("SECURITY.md#privacy-policy");
    expect(landing).toContain('name="twitter:image:alt"');
    expect(landing).toContain("exact Origin allowlisting");
    expect(landing).toContain("cloud clients may process that context under their own privacy policy");
    expect(proofProblems(landing)).toEqual([]);

    // NEGATIVE controls for previously misleading or stale landing-page claims.
    expect(landing).not.toContain("Install in 30 seconds");
    expect(landing).not.toContain("in 30 seconds.");
    expect(landing).not.toContain("0.94 confidence");
    expect(landing).not.toContain("<strong>1,720</strong>");
    expect(landing).not.toContain("<span>agent workflows</span>");
    expect(landing).not.toContain("Full BM25 → BGE → HNSW retrieval ladder");
    expect(landing).not.toContain("your vault content never leaves your machine");
    expect(
      proofProblems(
        landing.replace(
          `<strong>${TOOL_MANIFEST.length}</strong><span>MCP tools</span>`,
          `<strong>${TOOL_MANIFEST.length + 1}</strong><span>MCP tools</span>`
        )
      )
    ).toContain(`missing ${TOOL_MANIFEST.length} MCP tools`);
    expect(
      proofProblems(
        landing.replace(
          `<strong>${promptCount}</strong><span>MCP prompts</span>`,
          `<strong>${promptCount + 1}</strong><span>MCP prompts</span>`
        )
      )
    ).toContain(`missing ${promptCount} MCP prompts`);
    expect(
      proofProblems(
        landing.replace(
          `<strong>${testCount.toLocaleString("en-US")}</strong><span>public tests</span>`,
          `<strong>${testCount + 1}</strong><span>public tests</span>`
        )
      )
    ).toContain(`missing ${testCount.toLocaleString("en-US")} public tests`);
    expect(
      proofProblems(
        landing.replace(
          `<strong>${releaseGateCount}</strong><span>release gates</span>`,
          `<strong>${releaseGateCount + 1}</strong><span>release gates</span>`
        )
      )
    ).toContain(`missing ${releaseGateCount} release gates`);
    expect(landing).toContain('href="./api/"');
    expect(landing).not.toContain("__ENQUIRE_VERSION__");
    expect(legacySymbol).toContain("searchHybrid");
    expect(stableApiSymbol).toBe(legacySymbol);
    expect(manifest.start_url).toBe("./");
    expect(await validatePagesArtifact(outDir)).toEqual({
      bytes: result.bytes,
      fileCount: result.fileCount
    });
  });

  it("fails closed when the generated TypeDoc contract is incomplete (negative control)", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    await rm(join(apiSource, "interfaces/tools.SearchHybridResponse.html"));

    await expect(
      buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir })
    ).rejects.toThrow("TypeDoc source is incomplete; refusing Pages build: interfaces/tools.SearchHybridResponse.html");
  });

  it("rejects a broken landing-page local link after build (negative control)", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    await buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir });
    const landingPath = join(outDir, "index.html");
    const landing = await readFile(landingPath, "utf8");
    await writeFile(landingPath, landing.replace('href="./api/"', 'href="./missing-api/"'), "utf8");

    await expect(validatePagesArtifact(outDir)).rejects.toThrow(
      "Landing page has broken local links: missing local href ./missing-api/"
    );
  });
});
