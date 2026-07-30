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
import { buildJsonLdGraph, FAQ_ENTRIES, SEO_KEYWORDS } from "../scripts/inject-jsonld.mjs";

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
