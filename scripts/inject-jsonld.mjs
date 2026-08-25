#!/usr/bin/env node
// v3.8.6 — inject Schema.org JSON-LD into TypeDoc-generated index.html.
// v3.9.0-rc.17 — expanded from a single SoftwareApplication node to a
// Schema.org `@graph` with three nodes: SoftwareApplication (enriched with
// featureList + maintainer), SoftwareSourceCode (repo/runtime/targetProduct),
// and FAQPage (the README FAQ Q&A — a widely understood structured-data
// surface for search engines and AI answer systems).
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
// Idempotent for this project's graph: skips exactly one current enquire-owned
// graph, coexists with unrelated JSON-LD, and fails closed on duplicate,
// stale, or malformed enquire-owned state.
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
const ENQUIRE_JSONLD_MARKER = "graph-v1";
const RAW_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "script",
  "style",
  "template",
  "textarea",
  "title",
  "xmp"
]);
const HTML_WHITESPACE = /[\t\n\f\r ]/;
const HEAD_CONTENT_ELEMENTS = new Set(["base", "link", "meta", "noscript", "script", "style", "template", "title"]);

/** @param {string} value */
function asciiLower(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** @param {string} value */
function trimHtmlWhitespace(value) {
  return value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

/**
 * Deliberately curated discovery terms. Keeping this independent from npm's
 * package keywords lets the landing page describe the product's current wedge
 * without inheriting registry-oriented or historical terms.
 */
export const SEO_KEYWORDS = [
  "Obsidian MCP",
  "freshness-aware AI memory",
  "cited AI memory",
  "agent memory",
  "local-first RAG",
  "read-only MCP",
  "hybrid search",
  "PDF citations",
  "Dataview MCP",
  "Obsidian Bases",
  "Canvas parser",
  "document intelligence",
  "Model Context Protocol"
];

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
    a: "enquire itself sends no telemetry and makes zero outbound HTTP calls during serve. It returns requested vault context to the MCP client you connect; cloud clients may process that context under their own privacy policy. setup, build-embeddings, and install-model may explicitly download ONNX weights from Hugging Face; a hybrid-tier first-run --apply orchestrates those same acquisitions, while install-ocr-lang downloads a Tesseract language pack."
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
  const npmUrl = `https://www.npmjs.com/package/${pkg.name}`;
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
    url: docsUrl,
    sameAs: [repoUrl, npmUrl],
    isAccessibleForFree: true,
    softwareVersion: pkg.version,
    downloadUrl: npmUrl,
    softwareHelp: { "@type": "CreativeWork", url: docsUrl },
    license: "https://spdx.org/licenses/MIT.html",
    author,
    maintainer: author,
    keywords: SEO_KEYWORDS.join(", "),
    featureList: [
      "Freshness-aware cited recall with source paths plus age_days and stale metadata",
      "Read-only by default with explicit write gating and privacy filters",
      "Local Markdown/PDF retrieval: BM25 + TF-IDF + multilingual ML embeddings + RRF + BGE reranking + HNSW/int8 vector search",
      "PDF page citations and optional local Tesseract OCR",
      "Structured Obsidian tools for Canvas, Dataview-style LIST/TABLE queries, and supported Base-filter execution",
      "46 MCP tools and 19 MCP prompts for agent workflows",
      "Zero outbound HTTP initiated by enquire during serve; requested context is returned to the connected MCP client",
      "Agentic RAG: HyDE + sub-question decomposition",
      "GraphRAG-light: Louvain community detection over the wikilink graph",
      "Streamable HTTP transport with bearer auth, exact Origin allowlisting, rate limiting, and CORS"
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

/**
 * Render the single canonical enquire-owned JSON-LD script element.
 *
 * @param {Record<string, any>} pkg
 * @returns {string}
 * @example
 * renderEnquireJsonLdTag({ name: "@oomkapwn/enquire-mcp", version: "1.0.0" });
 */
export function renderEnquireJsonLdTag(pkg) {
  const opening = `<script type="application/ld+json" data-enquire-jsonld="${ENQUIRE_JSONLD_MARKER}">`;
  return `${opening}\n${JSON.stringify(buildJsonLdGraph(pkg), null, 2)}\n</script>`;
}

/**
 * Locate the end of an opening tag without mistaking a `>` inside a quoted
 * attribute for the tag boundary.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {number}
 */
function openingTagEnd(source, offset) {
  let state = "beforeAttributeName";
  let quote = "";
  for (let index = offset; index < source.length; index += 1) {
    const character = source[index];
    if (state === "quotedValue") {
      if (character === quote) quote = "";
      if (quote === "") state = "afterQuotedValue";
      continue;
    }
    if (state === "beforeAttributeValue") {
      if (HTML_WHITESPACE.test(character ?? "")) continue;
      if (character === '"' || character === "'") {
        quote = character;
        state = "quotedValue";
        continue;
      }
      if (character === ">") return index;
      state = "unquotedValue";
      continue;
    }
    if (state === "unquotedValue") {
      if (character === ">") return index;
      if (HTML_WHITESPACE.test(character ?? "")) state = "beforeAttributeName";
      continue;
    }
    if (state === "attributeName") {
      if (character === ">") return index;
      if (character === "=") state = "beforeAttributeValue";
      else if (HTML_WHITESPACE.test(character ?? "")) state = "afterAttributeName";
      else if (character === "/") state = "selfClosingStart";
      continue;
    }
    if (state === "afterAttributeName") {
      if (HTML_WHITESPACE.test(character ?? "")) continue;
      if (character === "=") state = "beforeAttributeValue";
      else if (character === ">") return index;
      else if (character === "/") state = "selfClosingStart";
      else state = "attributeName";
      continue;
    }
    if (state === "afterQuotedValue") {
      if (HTML_WHITESPACE.test(character ?? "")) state = "beforeAttributeName";
      else if (character === ">") return index;
      else if (character === "/") state = "selfClosingStart";
      else state = "attributeName";
      continue;
    }
    if (state === "selfClosingStart") {
      if (character === ">") return index;
      state = HTML_WHITESPACE.test(character ?? "") ? "beforeAttributeName" : "attributeName";
      continue;
    }
    if (HTML_WHITESPACE.test(character ?? "")) continue;
    if (character === ">") return index;
    if (character === "/") state = "selfClosingStart";
    else state = "attributeName";
  }
  return -1;
}

/**
 * Decode the character references that can change structural attribute values.
 * Numeric references are handled generically; the bounded named set covers the
 * punctuation used by MIME types, owner markers, URLs, and fragment IDs.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeAttributeReferences(value) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["colon", ":"],
    ["gt", ">"],
    ["lt", "<"],
    ["plus", "+"],
    ["quot", '"'],
    ["sol", "/"]
  ]);
  return value.replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?|&([a-z]+);/g, (reference, hex, decimal, name) => {
    if (name) return named.get(String(name)) ?? reference;
    const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "�";
    return String.fromCodePoint(codePoint);
  });
}

/**
 * Parse actual attributes from one already-delimited opening tag. Attribute-
 * looking bytes inside quoted values remain part of their owning attribute.
 *
 * @param {string} source
 * @returns {{attributes: Array<{name: string, value: string | null}>, malformed: boolean, selfClosing: boolean}}
 */
function parseAttributes(source) {
  const attributes = [];
  const names = new Set();
  let malformed = false;
  let selfClosing = false;
  let cursor = 0;
  while (cursor < source.length) {
    while (HTML_WHITESPACE.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;
    if (source[cursor] === "/") {
      if (trimHtmlWhitespace(source.slice(cursor + 1)).length === 0) {
        selfClosing = true;
        break;
      }
      malformed = true;
      cursor += 1;
      continue;
    }

    const nameStart = cursor;
    while (cursor < source.length && !/[\t\n\f\r =/>]/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor === nameStart) {
      malformed = true;
      cursor += 1;
      continue;
    }
    const rawName = source.slice(nameStart, cursor);
    const name = asciiLower(rawName);
    if (/["'<]/.test(rawName) || names.has(name)) malformed = true;
    names.add(name);
    while (HTML_WHITESPACE.test(source[cursor] ?? "")) cursor += 1;

    let value = null;
    if (source[cursor] === "=") {
      cursor += 1;
      while (HTML_WHITESPACE.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        const valueEnd = source.indexOf(quote, cursor);
        if (valueEnd < 0) {
          value = decodeAttributeReferences(source.slice(valueStart));
          malformed = true;
          cursor = source.length;
        } else {
          value = decodeAttributeReferences(source.slice(valueStart, valueEnd));
          cursor = valueEnd + 1;
        }
      } else {
        const valueStart = cursor;
        while (cursor < source.length && !/[\t\n\f\r >]/.test(source[cursor] ?? "")) cursor += 1;
        const rawValue = source.slice(valueStart, cursor);
        if (/["'<=`]/.test(rawValue)) malformed = true;
        value = decodeAttributeReferences(rawValue);
        if (value.length === 0) malformed = true;
      }
    }
    attributes.push({ name, value });
  }
  return { attributes, malformed, selfClosing };
}

/**
 * Parse one tag beginning at `start`.
 *
 * @param {string} html
 * @param {number} start
 * @returns {Record<string, any> | null}
 */
function parseTagAt(html, start) {
  const closing = html[start + 1] === "/";
  const nameStart = start + (closing ? 2 : 1);
  if (!/[A-Za-z]/.test(html[nameStart] ?? "")) return null;
  let afterName = nameStart;
  while (afterName < html.length && !/[\t\n\f\r />]/.test(html[afterName] ?? "")) afterName += 1;
  const name = asciiLower(html.slice(nameStart, afterName));
  const tagEnd = openingTagEnd(html, afterName);
  if (tagEnd < 0) {
    const nextMarkup = html.indexOf("<", afterName);
    const end = nextMarkup < 0 ? html.length : nextMarkup;
    return { kind: "malformedTag", name, closing, start, end, source: html.slice(start, end) };
  }
  const attributeSource = closing ? "" : html.slice(afterName, tagEnd);
  const parsed = parseAttributes(attributeSource);
  return {
    kind: closing ? "endTag" : "startTag",
    name,
    start,
    end: tagEnd + 1,
    selfClosing: !closing && parsed.selfClosing,
    attributes: parsed.attributes,
    malformed: parsed.malformed,
    rawText: null,
    closed: closing
  };
}

/** @param {string} html @param {string} name @param {number} offset */
function rawTextClose(html, name, offset) {
  const spelling = `</${name}`;
  let cursor = offset;
  while (cursor < html.length) {
    const candidate = html.indexOf("</", cursor);
    if (candidate < 0) return null;
    if (scriptNameTokenAt(html, candidate, spelling)) {
      const tag = parseTagAt(html, candidate);
      if (tag?.kind !== "endTag" || tag.name !== name) return null;
      return { start: tag.start, end: tag.end };
    }
    cursor = candidate + 2;
  }
  return null;
}

/** @param {string} html @param {number} offset @param {string} spelling */
function scriptNameTokenAt(html, offset, spelling) {
  if (asciiLower(html.slice(offset, offset + spelling.length)) !== spelling) return false;
  return /[\t\n\f\r />]/.test(html[offset + spelling.length] ?? "");
}

/**
 * Find the browser-significant close of a script, including the escaped and
 * double-escaped states used by legacy `<!--` wrappers. A `</script>` in the
 * double-escaped state changes state; it does not close the outer element.
 *
 * @param {string} html
 * @param {number} offset
 * @returns {{start: number, end: number} | null}
 */
function scriptClose(html, offset) {
  let state = "data";
  let cursor = offset;
  while (cursor < html.length) {
    if (state === "data" && html.startsWith("<!--", cursor)) {
      state = "escaped";
      cursor += 4;
      continue;
    }
    if (state !== "data" && html.startsWith("-->", cursor)) {
      state = "data";
      cursor += 3;
      continue;
    }
    if (html[cursor] !== "<") {
      cursor += 1;
      continue;
    }
    if (scriptNameTokenAt(html, cursor, "</script")) {
      if (state === "doubleEscaped") {
        state = "escaped";
        cursor += "</script".length;
        continue;
      }
      const tag = parseTagAt(html, cursor);
      return tag?.kind === "endTag" && tag.name === "script" ? { start: tag.start, end: tag.end } : null;
    }
    if (state === "escaped" && scriptNameTokenAt(html, cursor, "<script")) {
      state = "doubleEscaped";
      cursor += "<script".length;
      continue;
    }
    cursor += 1;
  }
  return null;
}

/**
 * Find the closing tag for an inert template without exposing content after a
 * nested template's close. Unlike actual raw-text elements, template contents
 * are tokenized HTML and templates can nest; comments, attributes, and raw
 * text inside them must not supply either opening or closing template tokens.
 *
 * @param {string} html
 * @param {number} offset
 * @returns {{start: number, end: number} | null}
 */
function templateClose(html, offset) {
  let depth = 1;
  let cursor = offset;
  while (cursor < html.length) {
    const markup = html.indexOf("<", cursor);
    if (markup < 0) return null;

    if (html.startsWith("<!--", markup)) {
      const commentEnd = html.indexOf("-->", markup + 4);
      if (commentEnd < 0) return null;
      cursor = commentEnd + 3;
      continue;
    }
    if (html.startsWith("<!", markup) || html.startsWith("<?", markup)) return null;

    const tag = parseTagAt(html, markup);
    if (!tag) {
      cursor = markup + 1;
      continue;
    }
    if (tag.kind === "malformedTag") return null;
    if (tag.name === "template") {
      if (tag.kind === "startTag") depth += 1;
      if (tag.kind === "endTag") depth -= 1;
      if (depth === 0) return { start: tag.start, end: tag.end };
      cursor = tag.end;
      continue;
    }
    if (tag.kind === "startTag" && RAW_TEXT_ELEMENTS.has(tag.name)) {
      if (tag.name === "plaintext") return null;
      const closing = tag.name === "script" ? scriptClose(html, tag.end) : rawTextClose(html, tag.name, tag.end);
      if (!closing) return null;
      cursor = closing.end;
      continue;
    }
    cursor = tag.end;
  }
  return null;
}

/**
 * Tokenize active HTML while treating script/style/title/textarea and other
 * raw or inert containers as opaque. Comments are emitted, never flattened.
 *
 * @param {string} html
 * @returns {Array<Record<string, any>>}
 * @example
 * scanActiveHtml("<head><!-- marker --></head>");
 */
export function scanActiveHtml(html) {
  const nodes = [];
  let cursor = 0;
  while (cursor < html.length) {
    const markup = html.indexOf("<", cursor);
    if (markup < 0) {
      if (cursor < html.length) nodes.push({ kind: "text", start: cursor, end: html.length, data: html.slice(cursor) });
      break;
    }
    if (markup > cursor) nodes.push({ kind: "text", start: cursor, end: markup, data: html.slice(cursor, markup) });

    if (html.startsWith("<!--", markup)) {
      const commentEnd = html.indexOf("-->", markup + 4);
      if (commentEnd < 0) {
        nodes.push({ kind: "malformedComment", start: markup, end: html.length, data: html.slice(markup + 4) });
        break;
      }
      nodes.push({ kind: "comment", start: markup, end: commentEnd + 3, data: html.slice(markup + 4, commentEnd) });
      cursor = commentEnd + 3;
      continue;
    }

    const doctype = html.slice(markup, markup + "<!doctype html>".length);
    if (asciiLower(doctype) === "<!doctype html>") {
      nodes.push({ kind: "declaration", start: markup, end: markup + doctype.length });
      cursor = markup + doctype.length;
      continue;
    }
    if (html.startsWith("<!", markup) || html.startsWith("<?", markup)) {
      nodes.push({ kind: "malformedMarkup", start: markup, end: html.length, data: html.slice(markup) });
      break;
    }

    const tag = parseTagAt(html, markup);
    if (!tag) {
      nodes.push({ kind: "text", start: markup, end: markup + 1, data: "<" });
      cursor = markup + 1;
      continue;
    }
    nodes.push(tag);
    if (tag.kind !== "startTag" || !RAW_TEXT_ELEMENTS.has(tag.name)) {
      cursor = tag.end;
      continue;
    }
    if (tag.name === "plaintext") {
      tag.rawText = html.slice(tag.end);
      tag.closed = false;
      break;
    }
    const closing =
      tag.name === "template"
        ? templateClose(html, tag.end)
        : tag.name === "script"
          ? scriptClose(html, tag.end)
          : rawTextClose(html, tag.name, tag.end);
    if (!closing) {
      tag.rawText = html.slice(tag.end);
      tag.closed = false;
      break;
    }
    tag.rawText = html.slice(tag.end, closing.start);
    tag.closed = true;
    nodes.push({ kind: "endTag", name: tag.name, start: closing.start, end: closing.end });
    cursor = closing.end;
  }
  return nodes;
}

/** @param {Array<{name: string, value: string | null}>} attributes @param {string} name */
function attributeValues(attributes, name) {
  return attributes.filter((attribute) => attribute.name === name).map((attribute) => attribute.value);
}

/** @param {Array<{name: string, value: string | null}>} attributes */
function jsonLdTypeStatus(attributes) {
  const values = attributeValues(attributes, "type").map((value) => asciiLower(trimHtmlWhitespace(value ?? "")));
  const hasJsonLdValue = values.some((value) => value.includes("application/ld+json"));
  if (values.length !== 1) return hasJsonLdValue ? "malformed" : "other";
  if (values[0] === "application/ld+json") return "jsonld";
  return hasJsonLdValue ? "malformed" : "other";
}

/** @param {Array<{name: string, value: string | null}>} attributes */
function ownerMarkerStatus(attributes) {
  const values = attributeValues(attributes, "data-enquire-jsonld");
  if (values.length === 0) return "none";
  if (values.length !== 1) return "mismatched";
  return trimHtmlWhitespace(values[0] ?? "") === ENQUIRE_JSONLD_MARKER ? "current" : "mismatched";
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} node */
function isEnquireJsonLdNode(node) {
  if (!isRecord(node)) return false;
  if (
    node["@id"] === "https://oomkapwn.github.io/enquire-mcp/#software" ||
    node["@id"] === "https://github.com/oomkapwn/enquire-mcp#source" ||
    node["@id"] === "https://oomkapwn.github.io/enquire-mcp/#faq"
  ) {
    return true;
  }
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  return node.name === "enquire-mcp" && (types.includes("SoftwareApplication") || types.includes("SoftwareSourceCode"));
}

/** @param {unknown} left @param {unknown} right */
function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
}

/** @param {unknown} document */
function looksLikeEnquireGraph(document) {
  if (Array.isArray(document)) return document.some((node) => looksLikeEnquireGraph(node));
  if (!isRecord(document)) return false;
  if (isEnquireJsonLdNode(document)) return true;
  return Object.values(document).some(
    (value) => (Array.isArray(value) || isRecord(value)) && looksLikeEnquireGraph(value)
  );
}

/**
 * Classify complete JSON-LD scripts with parseable payloads by enquire
 * ownership and currency. Text and HTML comments are deliberately ignored.
 *
 * @param {string} html
 * @param {Record<string, any>} [pkg]
 * @returns {{validCount: number, ownedCount: number, staleOwnedCount: number, unrelatedCount: number, malformedCount: number, htmlMalformedCount: number}}
 * @example
 * inspectJsonLdScripts('<script type="application/ld+json">{}</script>', {});
 */
export function inspectJsonLdScripts(html, pkg = {}) {
  const expectedGraph = JSON.parse(JSON.stringify(buildJsonLdGraph(pkg)));
  let validCount = 0;
  let ownedCount = 0;
  let staleOwnedCount = 0;
  let unrelatedCount = 0;
  let malformedCount = 0;
  let htmlMalformedCount = 0;

  for (const node of scanActiveHtml(html)) {
    if (node.kind === "malformedComment" || node.kind === "malformedMarkup") {
      htmlMalformedCount += 1;
      continue;
    }
    if (node.kind === "malformedTag") {
      const source = String(node.source ?? "").toLowerCase();
      if (
        node.name === "script" &&
        (source.includes("application/ld+json") || source.includes("data-enquire-jsonld"))
      ) {
        malformedCount += 1;
      } else {
        htmlMalformedCount += 1;
      }
      continue;
    }
    if (node.kind === "startTag" && node.malformed) {
      if (node.name === "script") {
        const status = jsonLdTypeStatus(node.attributes);
        const marker = ownerMarkerStatus(node.attributes);
        if (status !== "other" || marker !== "none") malformedCount += 1;
        else htmlMalformedCount += 1;
      } else {
        htmlMalformedCount += 1;
      }
      continue;
    }
    if (node.kind === "startTag" && node.name !== "script" && RAW_TEXT_ELEMENTS.has(node.name) && !node.closed) {
      htmlMalformedCount += 1;
      continue;
    }
    if (node.kind !== "startTag" || node.name !== "script") continue;

    const status = jsonLdTypeStatus(node.attributes);
    const marker = ownerMarkerStatus(node.attributes);
    if (!node.closed) {
      if (status === "jsonld" || status === "malformed" || marker !== "none") {
        malformedCount += 1;
      } else {
        htmlMalformedCount += 1;
      }
      continue;
    }

    if (status === "malformed") {
      malformedCount += 1;
    } else if (status === "other" && marker !== "none") {
      staleOwnedCount += 1;
    } else if (status === "jsonld") {
      const payload = String(node.rawText ?? "").trim();
      try {
        const document = JSON.parse(payload);
        if (typeof document !== "object" || document === null) throw new Error("JSON-LD must be an object or array");
        validCount += 1;
        const owned = marker !== "none" || looksLikeEnquireGraph(document);
        if (!owned) {
          unrelatedCount += 1;
        } else if (marker !== "mismatched" && sameJsonValue(document, expectedGraph)) {
          ownedCount += 1;
        } else {
          staleOwnedCount += 1;
        }
      } catch {
        malformedCount += 1;
      }
    }
  }

  return { validCount, ownedCount, staleOwnedCount, unrelatedCount, malformedCount, htmlMalformedCount };
}

/**
 * Find a real closing head tag while ignoring tag-like bytes in comments,
 * attributes, raw-text, RCDATA, and inert containers.
 *
 * @param {string} html
 * @returns {number}
 */
function headCloseIndex(html) {
  const nodes = scanActiveHtml(html);
  const headStarts = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind === "startTag" && node.name === "head");
  const headEnds = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind === "endTag" && node.name === "head");
  const bodyStarts = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind === "startTag" && node.name === "body");
  if (headStarts.length !== 1 || headEnds.length !== 1 || bodyStarts.length > 1) return -1;
  const headStart = headStarts[0]?.index ?? -1;
  const headEnd = headEnds[0]?.index ?? -1;
  if (headStart < 0 || headEnd <= headStart) return -1;
  const bodyStart = bodyStarts[0]?.index ?? -1;
  if (bodyStart >= 0 && bodyStart <= headEnd) return -1;

  for (let index = headStart + 1; index < headEnd; index += 1) {
    const node = nodes[index];
    if (node?.kind === "comment") continue;
    if (node?.kind === "text" && trimHtmlWhitespace(String(node.data ?? "")) === "") continue;
    if ((node?.kind === "startTag" || node?.kind === "endTag") && HEAD_CONTENT_ELEMENTS.has(String(node.name))) {
      continue;
    }
    return -1;
  }
  return Number(headEnds[0]?.node.start ?? -1);
}

/**
 * Inject one JSON-LD graph or report that one current enquire-owned graph made
 * the operation idempotent; unrelated structured data remains untouched.
 *
 * @param {string} html
 * @param {Record<string, any>} pkg
 * @returns {{html: string, injected: boolean, tagLength: number}}
 * @example
 * injectJsonLdIntoHtml("<html><head></head></html>", { version: "1.0.0" });
 */
export function injectJsonLdIntoHtml(html, pkg) {
  const inspection = inspectJsonLdScripts(html, pkg);
  const { ownedCount, staleOwnedCount, unrelatedCount, malformedCount, htmlMalformedCount } = inspection;
  if (htmlMalformedCount > 0) {
    throw new Error(`found ${htmlMalformedCount} malformed active HTML construct(s); refusing injection`);
  }
  if (malformedCount > 0) {
    throw new Error(`found ${malformedCount} malformed JSON-LD script(s); refusing injection`);
  }
  if (staleOwnedCount > 0) {
    throw new Error(`found ${staleOwnedCount} stale or mismatched enquire-owned JSON-LD script(s)`);
  }
  if (ownedCount > 1) {
    throw new Error(`expected at most one current enquire-owned JSON-LD script; found ${ownedCount}`);
  }
  if (ownedCount === 1) return { html, injected: false, tagLength: 0 };

  const anchor = headCloseIndex(html);
  if (anchor < 0) throw new Error("no real </head> in active HTML context; cannot inject");
  const tag = renderEnquireJsonLdTag(pkg);
  const injectedHtml = `${html.slice(0, anchor)}${tag}\n${html.slice(anchor)}`;
  const result = inspectJsonLdScripts(injectedHtml, pkg);
  if (
    result.ownedCount !== 1 ||
    result.staleOwnedCount !== 0 ||
    result.unrelatedCount !== unrelatedCount ||
    result.malformedCount !== 0 ||
    result.htmlMalformedCount !== 0
  ) {
    throw new Error("injected JSON-LD failed structural validation");
  }
  return { html: injectedHtml, injected: true, tagLength: tag.length };
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
  let result;
  try {
    result = injectJsonLdIntoHtml(html, pkg);
  } catch (error) {
    console.error(`[inject-jsonld] ${error instanceof Error ? error.message : String(error)} in ${target}`);
    process.exit(1);
  }
  if (!result.injected) {
    console.log(`[inject-jsonld] ${target} already contains exactly one current enquire-owned JSON-LD graph; skipping`);
    process.exit(0);
  }
  writeFileSync(target, result.html, "utf8");
  console.log(
    `[inject-jsonld] injected @graph JSON-LD (SoftwareApplication + SoftwareSourceCode + FAQPage, ${FAQ_ENTRIES.length} Q&A) into ${target} (${result.tagLength} bytes)`
  );
}
