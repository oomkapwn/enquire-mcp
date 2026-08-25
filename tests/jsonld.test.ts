// v3.9.0-rc.17 — structured-data (JSON-LD) discoverability tests.
//
// Validates `buildJsonLdGraph()` (the deterministic Schema.org `@graph`
// injected into the published TypeDoc site by scripts/inject-jsonld.mjs) and
// guards the FAQPage against silent drift from the canonical README FAQ.
//
// Why a test: the JSON-LD is what Google AI Overviews / Perplexity / Bing
// Copilot parse to cite enquire-mcp. A malformed graph (missing @type, broken
// targetProduct cross-ref, empty FAQ answer) ships silently otherwise — it's
// only ever rendered into HTML at publish time, never exercised by other code.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import {
  buildJsonLdGraph,
  FAQ_ENTRIES,
  injectJsonLdIntoHtml,
  inspectJsonLdScripts,
  renderEnquireJsonLdTag,
  SEO_KEYWORDS
} from "../scripts/inject-jsonld.mjs";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

describe("buildJsonLdGraph (v3.9.0-rc.17)", () => {
  const graph = buildJsonLdGraph(pkg);
  const nodes: Array<Record<string, unknown>> = graph["@graph"];

  it("emits a Schema.org @graph with the three expected nodes", () => {
    expect(graph["@context"]).toBe("https://schema.org");
    expect(Array.isArray(nodes)).toBe(true);
    const types = nodes.map((n) => n["@type"]);
    expect(types).toContain("SoftwareApplication");
    expect(types).toContain("SoftwareSourceCode");
    expect(types).toContain("FAQPage");
    expect(types).toHaveLength(3);
  });

  it("SoftwareApplication carries version, discovery metadata, factual features, and maintainer", () => {
    const app = nodes.find((n) => n["@type"] === "SoftwareApplication") as Record<string, unknown>;
    const features = app.featureList as string[];
    const featureText = features.join("\n");

    expect(app.softwareVersion).toBe(pkg.version);
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBeGreaterThanOrEqual(5);
    expect(app.maintainer).toBeDefined();
    expect(app.name).toBe("enquire-mcp");
    expect(app.url).toBe("https://oomkapwn.github.io/enquire-mcp/");
    expect(app.sameAs).toEqual([
      "https://github.com/oomkapwn/enquire-mcp",
      "https://www.npmjs.com/package/@oomkapwn/enquire-mcp"
    ]);
    expect(app.isAccessibleForFree).toBe(true);
    expect(app.keywords).toBe(SEO_KEYWORDS.join(", "));
    expect(SEO_KEYWORDS).toContain("freshness-aware AI memory");
    expect(SEO_KEYWORDS).toContain("Dataview MCP");
    expect(featureText).toContain("age_days and stale");
    expect(featureText).toContain("Read-only by default");
    expect(featureText).toContain(
      "BM25 + TF-IDF + multilingual ML embeddings + RRF + BGE reranking + HNSW/int8 vector search"
    );
    expect(featureText).toContain("Dataview-style LIST/TABLE queries");
    expect(featureText).toContain("46 MCP tools and 19 MCP prompts");
    expect(featureText).toContain("requested context is returned to the connected MCP client");
    expect(featureText).toContain("exact Origin allowlisting");

    // NEGATIVE controls: do not reintroduce the old scope/architecture shortcuts.
    expect(featureText).not.toContain("Standalone Obsidian Bases");
    expect(featureText).not.toContain("BM25 → BGE → HNSW");
  });

  it("SoftwareSourceCode.targetProduct cross-references the SoftwareApplication @id", () => {
    const app = nodes.find((n) => n["@type"] === "SoftwareApplication") as Record<string, unknown>;
    const src = nodes.find((n) => n["@type"] === "SoftwareSourceCode") as Record<string, unknown>;
    expect((src.targetProduct as Record<string, unknown>)["@id"]).toBe(app["@id"]);
    expect(src.codeRepository).toContain("github.com");
    // Repo URL must be clean (no git+ prefix or .git suffix that breaks crawlers).
    expect(src.codeRepository).not.toMatch(/^git\+|\.git$/);
  });

  it("FAQPage mainEntity mirrors FAQ_ENTRIES with non-empty Q + A (NEGATIVE control on empties)", () => {
    const faq = nodes.find((n) => n["@type"] === "FAQPage") as Record<string, unknown>;
    const entities = faq.mainEntity as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(FAQ_ENTRIES.length);
    for (const e of entities) {
      expect(e["@type"]).toBe("Question");
      expect(typeof e.name).toBe("string");
      expect((e.name as string).length).toBeGreaterThan(0);
      const ans = e.acceptedAnswer as Record<string, unknown>;
      expect(ans["@type"]).toBe("Answer");
      // NEGATIVE control: an empty answer string must NOT slip through.
      expect((ans.text as string).trim().length).toBeGreaterThan(0);
    }
    const privacy = entities.find((e) => e.name === "Is my data sent anywhere?");
    const privacyAnswer = (privacy?.acceptedAnswer as Record<string, unknown>)?.text;
    expect(privacyAnswer).toContain("zero outbound HTTP calls during serve");
    expect(privacyAnswer).toContain("MCP client you connect");
    expect(privacyAnswer).toContain("cloud clients may process that context under their own privacy policy");
    expect(privacyAnswer).toContain("hybrid-tier first-run --apply orchestrates those same acquisitions");
    expect(privacyAnswer).toContain("install-ocr-lang downloads a Tesseract language pack");
    // NEGATIVE control: a connected cloud MCP client is a real, separate data boundary.
    expect(privacyAnswer).not.toContain("your vault content never leaves your machine");
  });

  it("the JSON-LD is JSON-serializable (crawler-parseable)", () => {
    expect(() => JSON.stringify(graph)).not.toThrow();
  });
});

describe("FAQ_ENTRIES ↔ README FAQ parity (v3.9.0-rc.17 drift guard)", () => {
  it("every FAQ_ENTRIES item is well-formed (q + a present)", () => {
    expect(FAQ_ENTRIES.length).toBeGreaterThan(0);
    for (const e of FAQ_ENTRIES) {
      expect(e.q.trim().length, JSON.stringify(e)).toBeGreaterThan(0);
      expect(e.a.trim().length, JSON.stringify(e)).toBeGreaterThan(0);
      expect(e.q.endsWith("?"), `FAQ question should end with '?': ${e.q}`).toBe(true);
    }
  });

  it("FAQ_ENTRIES count matches the README '## ❓ FAQ' bold-question count", () => {
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
    const faqStart = readme.indexOf("## ❓ FAQ");
    expect(faqStart, "README FAQ heading not found").toBeGreaterThan(-1);
    // Section ends at the next H2.
    const after = readme.slice(faqStart + "## ❓ FAQ".length);
    const nextH2 = after.indexOf("\n## ");
    const section = nextH2 === -1 ? after : after.slice(0, nextH2);
    // README FAQ questions are bold lines ending in "?**".
    const readmeQuestions = section.match(/\*\*[^*]+\?\*\*/g) ?? [];
    expect(
      readmeQuestions.length,
      `README FAQ has ${readmeQuestions.length} questions but FAQ_ENTRIES has ${FAQ_ENTRIES.length} — keep scripts/inject-jsonld.mjs in sync with the README FAQ`
    ).toBe(FAQ_ENTRIES.length);
  });
});

describe("injectJsonLdIntoHtml", () => {
  const emptyInspection = {
    validCount: 0,
    ownedCount: 0,
    staleOwnedCount: 0,
    unrelatedCount: 0,
    malformedCount: 0,
    htmlMalformedCount: 0
  };

  it("injects exactly one real JSON-LD script when the MIME type appears only in text or comments", () => {
    const source = `<!doctype html><html><head>
<!-- example only: <script type="application/ld+json">{}</script> -->
<!-- outer <script type="application/ld+json">{"hidden":true}</script> outer -->
<meta data-example="<script type='application/ld+json'>{}</script>">
<script data-note='type="application/ld+json" data-enquire-jsonld="graph-v1"'>{"ignored":true}</script>
<script>const mimeExample = "application/ld+json";</script>
</head><body>
<script-example type="application/ld+json">{}</script-example>
<script_fake type="application/ld+json">{}</script_fake>
<script.fake type="application/ld+json">{}</script.fake>
<script  type="application/ld+json">{}</script >
application/ld+json
</body></html>`;

    expect(inspectJsonLdScripts(source, pkg)).toEqual(emptyInspection);
    const result = injectJsonLdIntoHtml(source, pkg);

    expect(result.injected).toBe(true);
    expect(inspectJsonLdScripts(result.html, pkg)).toEqual({
      ...emptyInspection,
      validCount: 1,
      ownedCount: 1
    });
    expect(result.html).toContain('data-enquire-jsonld="graph-v1"');
    expect(result.html).toContain('<!-- example only: <script type="application/ld+json">{}</script> -->');
    expect(result.html).toContain("application/ld+json");
    expect(result.html).toContain(`"softwareVersion": "${pkg.version}"`);
  });

  it("injects alongside unrelated valid JSON-LD instead of treating it as idempotency authority", () => {
    const unrelated = `<script type="application/ld+json" data-note='data-enquire-jsonld="graph-v1" type="fake"'>
{"@context":"https://schema.org","@type":"Thing","note":"<!-- literal payload bytes -->"}
</script>`;
    const namedThing =
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"enquire-mcp"}</script>';
    const source = `<html><head>${unrelated}${unrelated}${namedThing}</head><body></body></html>`;

    expect(inspectJsonLdScripts(source, pkg)).toEqual({
      ...emptyInspection,
      validCount: 3,
      unrelatedCount: 3
    });
    const result = injectJsonLdIntoHtml(source, pkg);
    expect(result.injected).toBe(true);
    expect(inspectJsonLdScripts(result.html, pkg)).toEqual({
      ...emptyInspection,
      validCount: 4,
      ownedCount: 1,
      unrelatedCount: 3
    });
  });

  it("ignores owned lookalikes hidden in raw-text, RCDATA, and inert containers", () => {
    const canonical = renderEnquireJsonLdTag(pkg);
    const hidden = ["style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript", "template"]
      .map((name) => `<${name}>${canonical}</${name}>`)
      .join("");
    const nestedTemplate = `<template><template></template>${canonical}</template>`;
    const escapedScript = `<script><!--<script></script>${canonical}</script>`;
    const source = `<html><head></head><body>${hidden}${nestedTemplate}${escapedScript}</body></html>`;

    expect(inspectJsonLdScripts(source, pkg)).toEqual(emptyInspection);
    const result = injectJsonLdIntoHtml(source, pkg);
    expect(result.injected).toBe(true);
    expect(inspectJsonLdScripts(result.html, pkg)).toEqual({
      ...emptyInspection,
      validCount: 1,
      ownedCount: 1
    });
  });

  it("skips one current owned graph, including the structural legacy fallback", () => {
    const marked = `<html><head>${renderEnquireJsonLdTag(pkg)}</head><body></body></html>`;
    const legacy = replaceExactly(marked, ' data-enquire-jsonld="graph-v1"', "", 1);
    const decimalType = replaceExactly(marked, "application/ld+json", "application/ld&#43;json", 1);
    const hexadecimalType = replaceExactly(marked, "application/ld+json", "application/ld&#x2b;json", 1);
    const namedType = replaceExactly(marked, "application/ld+json", "application/ld&plus;json", 1);
    const encodedOwner = replaceExactly(marked, "graph-v1", "graph&#45;v1", 1);
    const minimalPackage = { name: "@oomkapwn/enquire-mcp", version: "1.0.0" };
    const minimal = `<html><head>${renderEnquireJsonLdTag(minimalPackage)}</head><body></body></html>`;
    const ownedTag = renderEnquireJsonLdTag(pkg);
    const escapedReturnsToData = `<html><head><script><!--<script>--><script></script>${ownedTag}</script></head><body></body></html>`;
    const attributedScriptClose = `<html><head><script>ignored</script x>${ownedTag}</script></head><body></body></html>`;
    const slashedScriptClose = `<html><head><script>ignored</script/>${ownedTag}</script></head><body></body></html>`;
    const attributedStyleClose = `<html><head><style>ignored</style x>${ownedTag}</head><body></body></html>`;

    for (const source of [
      marked,
      legacy,
      decimalType,
      hexadecimalType,
      namedType,
      encodedOwner,
      escapedReturnsToData,
      attributedScriptClose,
      slashedScriptClose,
      attributedStyleClose
    ]) {
      expect(inspectJsonLdScripts(source, pkg)).toEqual({
        ...emptyInspection,
        validCount: 1,
        ownedCount: 1
      });
      expect(injectJsonLdIntoHtml(source, pkg)).toEqual({ html: source, injected: false, tagLength: 0 });
    }
    expect(inspectJsonLdScripts(minimal, minimalPackage)).toEqual({
      ...emptyInspection,
      validCount: 1,
      ownedCount: 1
    });
    expect(injectJsonLdIntoHtml(minimal, minimalPackage)).toEqual({ html: minimal, injected: false, tagLength: 0 });
  });

  it("rejects duplicate current owned graphs instead of silently skipping (causal negative control)", () => {
    const tag = renderEnquireJsonLdTag(pkg);
    const source = `<html><head>${tag}${tag}</head><body></body></html>`;

    expect(inspectJsonLdScripts(source, pkg)).toEqual({
      ...emptyInspection,
      validCount: 2,
      ownedCount: 2
    });
    expect(() => injectJsonLdIntoHtml(source, pkg)).toThrow(
      "expected at most one current enquire-owned JSON-LD script; found 2"
    );
  });

  it("fails closed on stale or mismatched owned graphs (causal negative controls)", () => {
    const current = renderEnquireJsonLdTag(pkg);
    const staleVersion = replaceExactly(
      current,
      `"softwareVersion": "${pkg.version}"`,
      '"softwareVersion": "0.0.0-stale"',
      1
    );
    const staleLegacy = replaceExactly(staleVersion, ' data-enquire-jsonld="graph-v1"', "", 1);
    const mismatchedMarker =
      '<script type="application/ld+json" data-enquire-jsonld="graph-v1">{"@type":"Thing"}</script>';
    const wrongMarker = replaceExactly(
      current,
      'data-enquire-jsonld="graph-v1"',
      'data-enquire-jsonld="graph-v0"',
      1
    );
    const wrongMime = replaceExactly(current, 'type="application/ld+json"', 'type="text/javascript"', 1);
    const doubleEncodedMime = replaceExactly(
      current,
      "application/ld+json",
      "application/ld&#38;plus;json",
      1
    );
    const currentGraph = buildJsonLdGraph(pkg);
    const software = currentGraph["@graph"][0];
    const topLevelNode = `<script type="application/ld+json">${JSON.stringify(software)}</script>`;
    const topLevelArray = `<script type="application/ld+json">${JSON.stringify([software])}</script>`;
    const nestedGraphArray = `<script type="application/ld+json">${JSON.stringify([{ "@graph": [software] }])}</script>`;
    const arrayTypeNode = `<script type="application/ld+json">${JSON.stringify({
      "@type": ["Thing", "SoftwareApplication"],
      name: "enquire-mcp"
    })}</script>`;

    for (const [tag, validCount] of [
      [staleVersion, 1],
      [staleLegacy, 1],
      [mismatchedMarker, 1],
      [wrongMarker, 1],
      [wrongMime, 0],
      [doubleEncodedMime, 0],
      [topLevelNode, 1],
      [topLevelArray, 1],
      [nestedGraphArray, 1],
      [arrayTypeNode, 1]
    ] as const) {
      const source = `<html><head>${tag}</head><body></body></html>`;
      expect(inspectJsonLdScripts(source, pkg)).toEqual({
        ...emptyInspection,
        validCount,
        staleOwnedCount: 1
      });
      expect(() => injectJsonLdIntoHtml(source, pkg)).toThrow(
        "found 1 stale or mismatched enquire-owned JSON-LD script(s)"
      );
    }
  });

  it("uses the real head close outside comments and script raw-text as the injection anchor", () => {
    const hiddenHeadCloses = [
      "script",
      "style",
      "title",
      "noscript",
      "template"
    ]
      .map((name) => `<${name}>fake </head></${name}>`)
      .join("");
    const nestedTemplateHeadClose = "<template><template></template>fake </head></template>";
    const escapedScriptHeadClose = "<script><!--<script></script>fake </head></script>";
    const source = `<html><head><!-- fake </head> -->${hiddenHeadCloses}${nestedTemplateHeadClose}${escapedScriptHeadClose}
<meta name="proof" data-fake="</head>" content="after fake closes"></head><body></body></html>`;
    const result = injectJsonLdIntoHtml(source, pkg);

    expect(result.injected).toBe(true);
    expect(result.html).toContain('<!-- fake </head> -->');
    expect(result.html.indexOf('data-enquire-jsonld="graph-v1"')).toBeGreaterThan(
      result.html.indexOf('<meta name="proof" data-fake="</head>" content="after fake closes">')
    );
    expect(result.html).toContain("<style>fake </head></style><title>fake </head></title>");
    expect(result.html).toContain("<noscript>fake </head></noscript><template>fake </head></template>");
    expect(result.html).toContain("</script>\n</head><body>");

    for (const malformedHead of [
      "<html></head><body></body></html>",
      "<html><head><body></head></body></html>",
      "<html><head><main></main></head><body></body></html>",
      "<html><head>body text</head><body></body></html>",
      "<html><head><!-- outer <!-- hidden --> active tail --></head><body></body></html>",
      "<html><head></head><body></body><body></body></html>"
    ]) {
      expect(() => injectJsonLdIntoHtml(malformedHead, pkg), malformedHead).toThrow(
        "no real </head> in active HTML context; cannot inject"
      );
    }
  });

  it("fails closed on malformed JSON-LD script candidates (causal negative controls)", () => {
    const malformed = [
      '<html><head><script type="application/ld+json">not-json</script></head></html>',
      '<html><head><script type="application/ld+json">"scalar-json"</script></head></html>',
      '<html><head><script type="application/ld+json">{"x":<!--bad-->1}</script></head></html>',
      '<html><head><script type="application/ld+json">{"open":true}</head></html>',
      '<html><head><script type="application/ld+json"</head><body></body></html>',
      '<html><head><script type="application/ld+json" type="text/javascript">{}</script></head></html>',
      `<html><head>${replaceExactly(renderEnquireJsonLdTag(pkg), "<script type=", "<script / type=", 1)}</head></html>`
    ];

    for (const source of malformed) {
      expect(inspectJsonLdScripts(source, pkg), source).toEqual({ ...emptyInspection, malformedCount: 1 });
      expect(() => injectJsonLdIntoHtml(source, pkg), source).toThrow(
        "found 1 malformed JSON-LD script(s); refusing injection"
      );
    }

    const owned = renderEnquireJsonLdTag(pkg);
    for (const source of [
      `<html><head><!x ${owned}></head><body></body></html>`,
      `<html><head><?x ${owned}></head><body></body></html>`,
      `<html><head><!-->${owned}</head><body></body></html>`,
      `<!doctype html "><script type="application/ld+json">${JSON.stringify(buildJsonLdGraph(pkg))}</script><x "><html><head></head><body></body></html>`,
      `<html><head><!-- unclosed ${owned}</head><body></body></html>`,
      `<html><head><template><!x </template>${owned}</template></head><body></body></html>`
    ]) {
      expect(inspectJsonLdScripts(source, pkg), source).toEqual({ ...emptyInspection, htmlMalformedCount: 1 });
      expect(() => injectJsonLdIntoHtml(source, pkg), source).toThrow(
        "found 1 malformed active HTML construct(s); refusing injection"
      );
    }

    const strayQuotedAttribute = `<html><head><div ">${owned}</head><body></body></html>`;
    expect(inspectJsonLdScripts(strayQuotedAttribute, pkg)).toEqual({
      ...emptyInspection,
      validCount: 1,
      ownedCount: 1,
      htmlMalformedCount: 1
    });
    expect(() => injectJsonLdIntoHtml(strayQuotedAttribute, pkg)).toThrow(
      "found 1 malformed active HTML construct(s); refusing injection"
    );
  });
});
