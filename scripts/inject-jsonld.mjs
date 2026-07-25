#!/usr/bin/env node
// v3.8.6 — inject Schema.org JSON-LD into TypeDoc-generated index.html.
// v3.9.0-rc.17 — expanded from a single SoftwareApplication node to a
// Schema.org `@graph` with three nodes: SoftwareApplication (enriched with
// featureList + maintainer), SoftwareSourceCode (repo/runtime/targetProduct),
// and FAQPage (the README FAQ Q&A — the highest AI-citation structured-data
// type for Google AI Overviews / Perplexity / Bing Copilot).
//
// Goal: make AI search engines recognize enquire-mcp as a SoftwareApplication
// with proper metadata AND surface the FAQ answers directly. v3.12.0-rc.15's
// Pages builder imports the pure graph generator for the acquisition landing;
// the CLI injection form remains useful for standalone generated HTML.
//
// What it does: read package.json (canonical source for name/version/desc),
// generate a JSON-LD `@graph` blob, and inject it into the <head> of the file
// passed as first argument (defaults to docs/api-reference/index.html).
//
// Idempotent: looks for the `application/ld+json` marker; if already
// present, skips injection (so re-running doesn't accumulate duplicates).
//
// `buildJsonLdGraph(pkg)` + `FAQ_ENTRIES` are exported for unit testing
// (tests/jsonld.test.ts) — the output is deterministic (no dates / RNG) so
// the structure can be asserted exactly.
//
// Run standalone via: node scripts/inject-jsonld.mjs [path/to/index.html]
// The production Pages path is `npm run docs:pages`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

/**
 * FAQ Q&A pairs for the FAQPage node. These mirror the README "## ❓ FAQ"
 * section — README is the canonical source, and
 * `tests/docs-consistency.test.ts` asserts every question here appears in
 * README.md so the two never silently drift.
 */
export const FAQ_ENTRIES = [
  {
    q: "Do I need Obsidian installed?",
    a: "No. enquire-mcp reads .md, .canvas, and .pdf files directly from disk and works against any Obsidian-format vault — the Obsidian desktop app does not need to be running."
  },
  {
    q: "Will it write to my vault?",
    a: "Not unless you pass --enable-write. All 7 write tools are gated behind that flag, and the destructive ones support a dry_run preview."
  },
  {
    q: "Is my data sent anywhere?",
    a: "Only on `enquire-mcp install-model`, which downloads ONNX model weights from HuggingFace one time. Serve mode makes zero outbound HTTP calls — embeddings and the reranker run on CPU locally, so your vault content never leaves your machine."
  },
  {
    q: "What is the query performance?",
    a: "Performance depends on vault size, hardware, model, and enabled retrieval layers. The public evidence includes a production report of 50–100ms BM25 top-10 at 1,771 chunks / 368 files and a reproducible synthetic benchmark showing 37–103x FTS5 speedup over linear scan at 100–1,000 notes. Run the built-in evaluation on your own vault before setting a latency SLO."
  },
  {
    q: "What languages are supported?",
    a: "The default paraphrase-multilingual-MiniLM-L12-v2 embedder covers 50+ languages and was validated end-to-end on bilingual Russian + English vaults. The default cross-encoder reranker is rerank-bge (English-only; the only catalog alias verified end-to-end); multilingual reranker aliases currently fail their transformers.js tokenizer compatibility check. CJK/Thai/Khmer tokenization uses Intl.Segmenter."
  },
  {
    q: "Can I run it remotely?",
    a: "Yes — `serve-http` exposes the same server over Streamable HTTP. Front it with Tailscale Funnel or Cloudflare Tunnel for HTTPS. It works with claude.ai web, ChatGPT custom GPTs, Cursor HTTP mode, and mobile MCP clients."
  }
];

/**
 * Build the Schema.org `@graph` from package.json. Pure + deterministic
 * (no Date / RNG) so the output is unit-testable. Returns the object that
 * gets JSON.stringify'd into the <script type="application/ld+json"> tag.
 *
 * @param {Record<string, any>} pkg - Parsed package.json.
 * @returns {Record<string, any>} The JSON-LD `@graph` document.
 */
export function buildJsonLdGraph(pkg) {
  const repoUrl = (pkg.repository?.url ?? "https://github.com/oomkapwn/enquire-mcp")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  const docsUrl = "https://oomkapwn.github.io/enquire-mcp/";
  const author = {
    "@type": "Person",
    name: typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? "Alex"),
    url: "https://github.com/oomkapwn"
  };
  const softwareApplication = {
    "@type": "SoftwareApplication",
    "@id": `${docsUrl}#software`,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Model Context Protocol (MCP) server",
    operatingSystem: "macOS, Linux, Windows",
    name: "enquire-mcp",
    description: pkg.description,
    softwareVersion: pkg.version,
    downloadUrl: `https://www.npmjs.com/package/${pkg.name}`,
    softwareHelp: { "@type": "CreativeWork", url: docsUrl },
    license: "https://spdx.org/licenses/MIT.html",
    author,
    maintainer: author,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords.slice(0, 20).join(", ") : "",
    featureList: [
      "Hybrid retrieval: BM25 + TF-IDF + multilingual ML embeddings, RRF-fused",
      "BGE cross-encoder reranking (+15.5 NDCG@10 / +24.7 MRR measured)",
      "HNSW vector index with int8 quantization + in-memory live update",
      "Agentic RAG: HyDE + sub-question decomposition",
      "GraphRAG-light: Louvain community detection over the wikilink graph",
      "Standalone Obsidian Bases (.base) query execution",
      "PDFs blended into search with [page: N] citations + Tesseract OCR",
      "Streamable HTTP transport with bearer auth, rate-limit, CORS"
    ],
    codeRepository: repoUrl,
    programmingLanguage: "TypeScript",
    softwareRequirements: pkg.engines?.node ?? "Node.js >=22.13.0",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }
  };
  const softwareSourceCode = {
    "@type": "SoftwareSourceCode",
    "@id": `${repoUrl}#source`,
    name: "enquire-mcp",
    description: pkg.description,
    codeRepository: repoUrl,
    programmingLanguage: "TypeScript",
    runtimePlatform: pkg.engines?.node ?? "Node.js >=22.13.0",
    license: "https://spdx.org/licenses/MIT.html",
    author,
    targetProduct: { "@id": `${docsUrl}#software` }
  };
  const faqPage = {
    "@type": "FAQPage",
    "@id": `${docsUrl}#faq`,
    mainEntity: FAQ_ENTRIES.map((e) => ({
      "@type": "Question",
      name: e.q,
      acceptedAnswer: { "@type": "Answer", text: e.a }
    }))
  };
  return {
    "@context": "https://schema.org",
    "@graph": [softwareApplication, softwareSourceCode, faqPage]
  };
}

// ─── CLI behavior (skipped when imported by tests) ──────────────────────────
if (isEntrypoint(import.meta.url)) {
  const target = resolve(repoRoot, process.argv[2] ?? "docs/api-reference/index.html");
  if (!existsSync(target)) {
    console.error(`[inject-jsonld] target not found: ${target}`);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const html = readFileSync(target, "utf8");
  if (html.includes("application/ld+json")) {
    console.log(`[inject-jsonld] ${target} already contains JSON-LD; skipping`);
    process.exit(0);
  }
  const jsonld = buildJsonLdGraph(pkg);
  const tag = `<script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n</script>`;
  const headCloseRe = /<\/head>/i;
  if (!headCloseRe.test(html)) {
    console.error(`[inject-jsonld] no </head> in ${target}; cannot inject`);
    process.exit(1);
  }
  writeFileSync(target, html.replace(headCloseRe, `${tag}\n</head>`), "utf8");
  console.log(
    `[inject-jsonld] injected @graph JSON-LD (SoftwareApplication + SoftwareSourceCode + FAQPage, ${FAQ_ENTRIES.length} Q&A) into ${target} (${tag.length} bytes)`
  );
}
