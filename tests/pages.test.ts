import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import { buildPagesArtifact, validatePagesArtifact } from "../scripts/build-pages.mjs";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import { FAQ_ENTRIES, renderEnquireJsonLdTag } from "../scripts/inject-jsonld.mjs";
import { TOOL_MANIFEST } from "../src/tool-manifest.js";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

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

async function siteFixture(root: string, mutate: (source: string) => string): Promise<string> {
  const siteSource = join(root, "site");
  await cp(join(repoRoot, "site"), siteSource, { recursive: true });
  const landingPath = join(siteSource, "index.html");
  const source = await readFile(landingPath, "utf8");
  await writeFile(landingPath, mutate(source), "utf8");
  return siteSource;
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
      publishPreviewProblems(
        replaceExactly(publish, "- run: npm run render:preview", "- run: echo stale preview", 1)
      )
    ).toContain("missing remote preview render");
    const withoutPreviewRender = replaceExactly(publish, "      - run: npm run render:preview\n", "", 1);
    expect(
      publishPreviewProblems(
        replaceExactly(
          withoutPreviewRender,
          "      - run: npm run docs:pages\n",
          "      - run: npm run docs:pages\n      - run: npm run render:preview\n",
          1
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
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
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
    expect(landing).toContain('data-enquire-jsonld="graph-v1"');
    expect(landing).toContain("FAQPage");
    expect(landing.match(/<details(?: open)?>/g) ?? []).toHaveLength(FAQ_ENTRIES.length);
    for (const { q, a } of FAQ_ENTRIES) {
      expect(landing).toContain(`<summary>${q}</summary>`);
      expect(landing).toContain(`<p>${a}</p>`);
    }
    expect(landing).toContain(`<span class="terminal-version">build ${pkg.version}</span>`);
    expect(landing).toContain(`<span>Built from <code>${pkg.version}</code> · local-first · vendor-neutral</span>`);
    expect(landing).toContain('id="install"');
    expect(landing).toContain('id="compare"');
    expect(landing).toContain("Your vault.<br>Every agent.<br><em>Fresh, cited memory.</em>");
    expect(landing).toContain("Complete leadership standard");
    expect(landing).toContain("Reviewed 2026-07-30");
    expect(landing).toContain("<strong>19</strong><span>MCP prompts</span>");
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
        replaceExactly(
          landing,
          `<strong>${TOOL_MANIFEST.length}</strong><span>MCP tools</span>`,
          `<strong>${TOOL_MANIFEST.length + 1}</strong><span>MCP tools</span>`,
          1
        )
      )
    ).toContain(`missing ${TOOL_MANIFEST.length} MCP tools`);
    expect(
      proofProblems(
        replaceExactly(
          landing,
          `<strong>${promptCount}</strong><span>MCP prompts</span>`,
          `<strong>${promptCount + 1}</strong><span>MCP prompts</span>`,
          1
        )
      )
    ).toContain(`missing ${promptCount} MCP prompts`);
    expect(
      proofProblems(
        replaceExactly(
          landing,
          `<strong>${testCount.toLocaleString("en-US")}</strong><span>public tests</span>`,
          `<strong>${testCount + 1}</strong><span>public tests</span>`,
          1
        )
      )
    ).toContain(`missing ${testCount.toLocaleString("en-US")} public tests`);
    expect(
      proofProblems(
        replaceExactly(
          landing,
          `<strong>${releaseGateCount}</strong><span>release gates</span>`,
          `<strong>${releaseGateCount + 1}</strong><span>release gates</span>`,
          1
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

  it("fails closed when a required landing placeholder is missing (causal negative controls)", async () => {
    for (const [marker, expected, actual] of [
      ["<!-- ENQUIRE_JSONLD -->", 1, 0],
      ["<!-- ENQUIRE_FAQ -->", 1, 0],
      ["__ENQUIRE_VERSION__", 2, 1]
    ] as const) {
      const { apiSource, outDir, root } = await typeDocFixture();
      const siteSource = await siteFixture(root, (source) => replaceExactly(source, marker, "", expected));

      await expect(buildPagesArtifact({ repoRoot, apiSource, siteSource, outDir })).rejects.toThrow(
        `Landing page placeholder ${marker} must occur exactly ${expected} time(s); found ${actual}`
      );
    }
  });

  it("fails closed when a required landing placeholder is duplicated (causal negative controls)", async () => {
    for (const [marker, expected, actual] of [
      ["<!-- ENQUIRE_JSONLD -->", 1, 2],
      ["<!-- ENQUIRE_FAQ -->", 1, 2],
      ["__ENQUIRE_VERSION__", 2, 3]
    ] as const) {
      const { apiSource, outDir, root } = await typeDocFixture();
      const siteSource = await siteFixture(root, (source) =>
        replaceExactly(source, marker, `${marker}\n${marker}`, expected)
      );

      await expect(buildPagesArtifact({ repoRoot, apiSource, siteSource, outDir })).rejects.toThrow(
        `Landing page placeholder ${marker} must occur exactly ${expected} time(s); found ${actual}`
      );
    }
  });

  it("rejects JSON-LD and FAQ placeholders hidden inside inactive HTML contexts", async () => {
    for (const marker of ["<!-- ENQUIRE_JSONLD -->", "<!-- ENQUIRE_FAQ -->"]) {
      for (const hidden of [
        `<!-- outer ${marker} outer -->`,
        `<textarea>${marker}</textarea>`,
        `<template><template></template>${marker}</template>`,
        `<template><!x </template>${marker}</template>`,
        `<script><!--<script></script>${marker}</script>`
      ]) {
        const { apiSource, outDir, root } = await typeDocFixture();
        const siteSource = await siteFixture(root, (source) => replaceExactly(source, marker, hidden, 1));

        await expect(buildPagesArtifact({ repoRoot, apiSource, siteSource, outDir })).rejects.toThrow(
          `Landing page placeholder ${marker} must occur exactly 1 time(s); found 0`
        );
      }
    }
    for (const hidden of [
      "<!-- __ENQUIRE_VERSION__ -->",
      "<textarea>__ENQUIRE_VERSION__</textarea>",
      "<template><template></template>__ENQUIRE_VERSION__</template>",
      "<template><!x </template>__ENQUIRE_VERSION__</template>",
      "<script><!--<script></script>__ENQUIRE_VERSION__</script>"
    ]) {
      const { apiSource, outDir, root } = await typeDocFixture();
      const siteSource = await siteFixture(root, (source) =>
        replaceExactly(source, "__ENQUIRE_VERSION__", hidden, 2)
      );
      await expect(buildPagesArtifact({ repoRoot, apiSource, siteSource, outDir })).rejects.toThrow(
        "Landing page placeholder __ENQUIRE_VERSION__ must occur exactly 2 time(s); found 1"
      );
    }
    for (const marker of ["<!-- ENQUIRE_JSONLD -->", "<!-- ENQUIRE_FAQ -->", "__ENQUIRE_VERSION__"]) {
      const { apiSource, outDir, root } = await typeDocFixture();
      const expected = marker === "__ENQUIRE_VERSION__" ? 2 : 1;
      const siteSource = await siteFixture(root, (source) =>
        replaceExactly(source, marker, `<!x ${marker}>`, expected)
      );
      await expect(buildPagesArtifact({ repoRoot, apiSource, siteSource, outDir })).rejects.toThrow(
        "Landing page template contains 1 malformed active HTML construct(s)"
      );
    }
  });

  it("validates active owned JSON-LD and live FAQ nodes after rendering", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    await buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir });
    const landingPath = join(outDir, "index.html");
    const landing = await readFile(landingPath, "utf8");
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const jsonLdTag = renderEnquireJsonLdTag(pkg);
    const hiddenJsonLd = replaceExactly(landing, jsonLdTag, `<!-- ${jsonLdTag} -->`, 1);
    await writeFile(landingPath, hiddenJsonLd, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      "Landing page JSON-LD is not exactly one current active owned graph"
    );
    const nestedTemplateJsonLd = replaceExactly(
      landing,
      jsonLdTag,
      `<template><template></template>${jsonLdTag}</template>`,
      1
    );
    await writeFile(landingPath, nestedTemplateJsonLd, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      "Landing page JSON-LD is not exactly one current active owned graph"
    );

    const commentedSummary = replaceExactly(
      landing,
      `<summary>${FAQ_ENTRIES[0]?.q}</summary>`,
      `<!-- <summary>${FAQ_ENTRIES[0]?.q}</summary> -->`,
      1
    );
    await writeFile(landingPath, commentedSummary, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("Landing page FAQ is not current and live");
    const nestedTemplateSummary = replaceExactly(
      landing,
      `<summary>${FAQ_ENTRIES[0]?.q}</summary>`,
      `<template><template></template><summary>${FAQ_ENTRIES[0]?.q}</summary></template>`,
      1
    );
    await writeFile(landingPath, nestedTemplateSummary, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("Landing page FAQ is not current and live");
    const nestedElementSummary = replaceExactly(
      landing,
      `<summary>${FAQ_ENTRIES[0]?.q}</summary>`,
      `<div><summary>${FAQ_ENTRIES[0]?.q}</summary></div>`,
      1
    );
    await writeFile(landingPath, nestedElementSummary, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      "FAQ entry 1 does not have one direct <summary> child"
    );
    const nestedElementAnswer = replaceExactly(
      landing,
      `<p>${FAQ_ENTRIES[0]?.a}</p>`,
      `<div><p>${FAQ_ENTRIES[0]?.a}</p></div>`,
      1
    );
    await writeFile(landingPath, nestedElementAnswer, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      "FAQ entry 1 does not have one direct <p> child"
    );
    const hiddenDetails = replaceExactly(landing, "<details open>", "<details open hidden>", 1);
    await writeFile(landingPath, hiddenDetails, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      `live #faq has ${FAQ_ENTRIES.length - 1} details entries; expected ${FAQ_ENTRIES.length}`
    );
    const hiddenSummaryAttribute = replaceExactly(
      landing,
      `<summary>${FAQ_ENTRIES[0]?.q}</summary>`,
      `<summary hidden>${FAQ_ENTRIES[0]?.q}</summary>`,
      1
    );
    await writeFile(landingPath, hiddenSummaryAttribute, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("FAQ entry 1 has 0 live <summary> elements");
    const nestedDetails = replaceExactly(
      replaceExactly(landing, "<details open>", "<div><details open>", 1),
      "</details>",
      "</details></div>",
      FAQ_ENTRIES.length
    );
    await writeFile(landingPath, nestedDetails, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      `live #faq has ${FAQ_ENTRIES.length - 1} details entries; expected ${FAQ_ENTRIES.length}`
    );
    const unclosedWrapperSummary = replaceExactly(
      landing,
      `<summary>${FAQ_ENTRIES[0]?.q}</summary>`,
      `<div><summary>${FAQ_ENTRIES[0]?.q}</summary>`,
      1
    );
    await writeFile(landingPath, unclosedWrapperSummary, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      "FAQ entry 1 does not have one direct <summary> child"
    );
    const escapedScriptSummary = replaceExactly(
      landing,
      `<summary>${FAQ_ENTRIES[0]?.q}</summary>`,
      `<script><!--<script></script><summary>${FAQ_ENTRIES[0]?.q}</summary></script>`,
      1
    );
    await writeFile(landingPath, escapedScriptSummary, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("Landing page FAQ is not current and live");
  });

  it("requires live shell elements instead of marker text in comments or quoted attributes", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    await buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir });
    const landingPath = join(outDir, "index.html");
    const landing = await readFile(landingPath, "utf8");
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    for (const [needle, replacement, problem] of [
      [
        '<main id="main">',
        '<div data-note="<main id=\'main\'>">',
        'expected exactly one live direct <main id="main">; found 0'
      ],
      [
        '<main id="main">',
        '<!-- <main id="main"> -->',
        'expected exactly one live direct <main id="main">; found 0'
      ],
      [
        '<main id="main">',
        '<main.fake id="main">',
        'expected exactly one live direct <main id="main">; found 0'
      ],
      [
        '<main id="main">',
        '<main id="main" hidden>',
        'expected exactly one live direct <main id="main">; found 0'
      ],
      [
        '<link rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">',
        '<meta data-note=\'rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/"\'>',
        "expected exactly one live canonical link; found 0"
      ],
      [
        '<link rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">',
        '<!x <link rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">>',
        "expected exactly one live canonical link; found 0"
      ],
      [
        'id="install"',
        'data-note=\'id="install"\'',
        'expected exactly one live direct <section id="install">; found 0'
      ],
      [
        'id="faq"',
        'data-note=\'id="faq"\'',
        'expected exactly one live direct <section id="faq">; found 0'
      ]
    ] as const) {
      await writeFile(landingPath, replaceExactly(landing, needle, replacement, 1), "utf8");
      await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(problem);
    }
    const base = replaceExactly(
      landing,
      "</head>",
      '<base href="https://evil.example/">\n</head>',
      1
    );
    await writeFile(landingPath, base, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("active <base> is forbidden; found 1");

    const metaInstall = replaceExactly(
      replaceExactly(landing, 'id="install"', 'id="install-real"', 1),
      '<main id="main">',
      '<main id="main"><meta id="install">',
      1
    );
    await writeFile(landingPath, metaInstall, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      'expected exactly one live direct <section id="install">; found 0'
    );

    const selectMain = replaceExactly(
      replaceExactly(landing, '<main id="main">', '<select><main id="main">', 1),
      "</main>",
      "</main></select>",
      1
    );
    await writeFile(landingPath, selectMain, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      'expected exactly one live direct <main id="main">; found 0'
    );

    const selfClosingWrapperMain = replaceExactly(
      replaceExactly(landing, '<main id="main">', '<div/><main id="main">', 1),
      "</main>",
      "</main></div>",
      1
    );
    await writeFile(landingPath, selfClosingWrapperMain, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      'expected exactly one live direct <main id="main">; found 0'
    );

    const outsideCloseWrapperMain = replaceExactly(
      replaceExactly(landing, '<main id="main">', '<div><main id="main">', 1),
      "</body>",
      "</body></div>",
      1
    );
    await writeFile(landingPath, outsideCloseWrapperMain, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      'expected exactly one live direct <main id="main">; found 0'
    );

    const trailingMain = replaceExactly(landing, "</body>", '</body><main id="after-body"></main>', 1);
    await writeFile(landingPath, trailingMain, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      'expected exactly one live direct <main id="main">; found 1'
    );

    const trailingCanonical = replaceExactly(
      landing,
      "</body>",
      '</body><link rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">',
      1
    );
    await writeFile(landingPath, trailingCanonical, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      "expected exactly one active canonical relation; found 2"
    );

    for (const mutant of [
      replaceExactly(landing, "  <head>\n", "", 1),
      replaceExactly(landing, "  </head>\n  <body>", "  <body>\n  </head>", 1),
      replaceExactly(landing, "</head>", "<main></main>\n</head>", 1)
    ]) {
      await writeFile(landingPath, mutant, "utf8");
      await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("Landing page shell is not structurally live");
    }
  });

  it("does not count a canonical link hidden in raw-text, RCDATA, or inert containers", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    await buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir });
    const landingPath = join(outDir, "index.html");
    const landing = await readFile(landingPath, "utf8");
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const canonical = '<link rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">';
    for (const name of ["script", "style", "title", "noscript", "template"]) {
      const mutant = replaceExactly(landing, canonical, `<${name}>${canonical}</${name}>`, 1);
      await writeFile(landingPath, mutant, "utf8");
      await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
        "expected exactly one live canonical link; found 0"
      );
    }
    for (const name of ["textarea", "xmp", "iframe", "noembed", "noframes"]) {
      const mutant = replaceExactly(
        replaceExactly(landing, canonical, "", 1),
        "</body>",
        `<${name}>${canonical}</${name}></body>`,
        1
      );
      await writeFile(landingPath, mutant, "utf8");
      await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
        "expected exactly one live canonical link; found 0"
      );
    }
    const nestedTemplate = replaceExactly(
      landing,
      canonical,
      `<template><template></template>${canonical}</template>`,
      1
    );
    await writeFile(landingPath, nestedTemplate, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      "expected exactly one live canonical link; found 0"
    );
    for (const replacement of [
      `<script><!--<script></script>${canonical}</script>`,
      '<link.fake rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">',
      '<linK rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">',
      '<link rel="stylesheet" rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">',
      '<link  rel="canonical" href="https://oomkapwn.github.io/enquire-mcp/">'
    ]) {
      const mutant = replaceExactly(landing, canonical, replacement, 1);
      await writeFile(landingPath, mutant, "utf8");
      await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
        "expected exactly one live canonical link; found 0"
      );
    }
    const withoutHeadCanonical = replaceExactly(landing, canonical, "", 1);
    const bodyCanonical = replaceExactly(withoutHeadCanonical, "</body>", `${canonical}</body>`, 1);
    await writeFile(landingPath, bodyCanonical, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
      "expected exactly one live canonical link; found 0"
    );
  });

  it("does not satisfy a fragment target with an id hidden in comments or quoted attributes", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    await buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir });
    const landingPath = join(outDir, "index.html");
    const landing = await readFile(landingPath, "utf8");
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    for (const fakeTarget of [
      '<!-- id="ghost-target" -->',
      '<div data-note=\'id="ghost-target"\'></div>',
      '<script><!--<script></script><div id="ghost-target"></div></script>'
    ]) {
      const mutant = replaceExactly(
        landing,
        "</body>",
        `<a href="#ghost-target">broken</a>${fakeTarget}</body>`,
        1
      );
      await writeFile(landingPath, mutant, "utf8");
      await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow(
        "Landing page has broken local links: missing fragment target #ghost-target"
      );
    }
    const duplicateId = replaceExactly(
      landing,
      "</body>",
      '<a href="#ghost-target">broken</a><div id="different" id="ghost-target"></div></body>',
      1
    );
    await writeFile(landingPath, duplicateId, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("duplicate id attributes on <div>");
    const bogusId = replaceExactly(
      landing,
      "</body>",
      '<a href="#ghost-target">broken</a><!x <div id="ghost-target"></div>></body>',
      1
    );
    await writeFile(landingPath, bogusId, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("live <body> is not closed exactly once");
    const duplicateIdValue = replaceExactly(landing, "</body>", '<div id="main"></div></body>', 1);
    await writeFile(landingPath, duplicateIdValue, "utf8");
    await expect(validatePagesArtifact(outDir, pkg)).rejects.toThrow("duplicate id value #main");
  });

  it("ignores href lookalikes hidden in comments, quoted attributes, and inert content", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    await buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir });
    const landingPath = join(outDir, "index.html");
    const landing = await readFile(landingPath, "utf8");
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    for (const fakeLink of [
      '<!-- href="./missing-hidden/" -->',
      '<div data-note=\'href="./missing-hidden/"\'></div>',
      '<template><a href="./missing-hidden/">hidden</a></template>',
      '<script><!--<script></script><a href="./missing-hidden/">hidden</a></script>',
      '<!-- <base href="https://evil.example/"> -->',
      '<template><base href="https://evil.example/"></template>',
      '<base.fake href="https://evil.example/">'
    ]) {
      const mutant = replaceExactly(landing, "</body>", `${fakeLink}</body>`, 1);
      await writeFile(landingPath, mutant, "utf8");
      await expect(validatePagesArtifact(outDir, pkg)).resolves.toBeDefined();
    }
  });

  it("rejects a broken landing-page local link after build (negative control)", async () => {
    const { apiSource, outDir } = await typeDocFixture();
    await buildPagesArtifact({ repoRoot, apiSource, siteSource: join(repoRoot, "site"), outDir });
    const landingPath = join(outDir, "index.html");
    const landing = await readFile(landingPath, "utf8");
    await writeFile(
      landingPath,
      replaceExactly(landing, 'href="./api/"', 'href="./missing-api/"', 4),
      "utf8"
    );

    await expect(validatePagesArtifact(outDir)).rejects.toThrow(
      "Landing page has broken local links: missing local href ./missing-api/"
    );
  });
});
