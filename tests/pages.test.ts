import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import { buildPagesArtifact, validatePagesArtifact } from "../scripts/build-pages.mjs";

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

    expect(ci).toContain("- run: npm run docs:pages");
    expect(publish).toContain("- run: npm run docs:pages");
    expect(publish).toContain("path: .pages-dist");
    expect(publish).not.toContain("path: docs/api-reference");
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

    expect(landing).toContain('<link rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">');
    expect(landing).toContain("<main");
    expect(landing).toContain("application/ld+json");
    expect(landing).toContain("FAQPage");
    expect(landing).toContain('id="install"');
    expect(landing).toContain('id="compare"');
    expect(landing).toContain("Your vault.<br>Every agent.");
    expect(landing).toContain("Complete leadership standard");
    expect(landing).toContain("Reviewed 2026-07-25");
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
