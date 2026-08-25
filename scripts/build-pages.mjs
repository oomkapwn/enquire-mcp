#!/usr/bin/env node

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAQ_ENTRIES,
  inspectJsonLdScripts,
  renderEnquireJsonLdTag,
  scanActiveHtml
} from "./inject-jsonld.mjs";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");
const LANDING_COMMENT_PLACEHOLDERS = ["ENQUIRE_JSONLD", "ENQUIRE_FAQ"];
const VERSION_PLACEHOLDER = "__ENQUIRE_VERSION__";
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
const HEAD_CONTENT_ELEMENTS = new Set(["base", "link", "meta", "noscript", "script", "style", "template", "title"]);

/** @param {string} value */
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Count non-overlapping occurrences without giving String.replace a chance to
 * hide a missing or duplicated template contract.
 *
 * @param {string} source
 * @param {string} marker
 * @returns {number}
 */
function occurrenceCount(source, marker) {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = source.indexOf(marker, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + marker.length;
  }
}

/**
 * Replace only the structurally active placeholder nodes proven by
 * `assertLandingPlaceholderCardinality`. Byte-identical examples inside raw
 * text, attributes, nested comments, or inert templates are never selected.
 *
 * @param {string} source
 * @param {{jsonLd: string, faq: string, version: string}} values
 * @returns {string}
 */
function replaceActiveLandingPlaceholders(source, values) {
  const replacements = [];
  for (const node of scanActiveHtml(source)) {
    if (node.kind === "comment") {
      const name = String(node.data ?? "").trim();
      if (name === "ENQUIRE_JSONLD") {
        replacements.push({ start: node.start, end: node.end, value: values.jsonLd });
      } else if (name === "ENQUIRE_FAQ") {
        replacements.push({ start: node.start, end: node.end, value: values.faq });
      }
      continue;
    }
    if (node.kind !== "text") continue;
    const text = String(node.data ?? "");
    let offset = 0;
    while (true) {
      const found = text.indexOf(VERSION_PLACEHOLDER, offset);
      if (found < 0) break;
      replacements.push({
        start: node.start + found,
        end: node.start + found + VERSION_PLACEHOLDER.length,
        value: values.version
      });
      offset = found + VERSION_PLACEHOLDER.length;
    }
  }

  if (replacements.length !== 4) {
    throw new Error(`Landing page active replacement census changed after validation; found ${replacements.length}`);
  }
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (rendered, replacement) =>
        `${rendered.slice(0, replacement.start)}${replacement.value}${rendered.slice(replacement.end)}`,
      source
    );
}

/**
 * Fail closed before rendering if the hand-authored landing template no
 * longer exposes the exact replacement surface expected by this builder.
 *
 * @param {string} source
 * @returns {void}
 */
function assertLandingPlaceholderCardinality(source) {
  const nodes = scanActiveHtml(source);
  const malformed = nodes.filter(
    (node) =>
      ["malformedComment", "malformedMarkup", "malformedTag"].includes(String(node.kind)) ||
      (node.kind === "startTag" && node.malformed)
  );
  if (malformed.length > 0) {
    throw new Error(`Landing page template contains ${malformed.length} malformed active HTML construct(s)`);
  }
  for (const name of LANDING_COMMENT_PLACEHOLDERS) {
    const actual = nodes.filter((node) => node.kind === "comment" && String(node.data ?? "").trim() === name).length;
    if (actual !== 1) {
      throw new Error(
        `Landing page placeholder <!-- ${name} --> must occur exactly 1 time(s); found ${actual}`
      );
    }
  }
  const versionCount = nodes
    .filter((node) => node.kind === "text")
    .reduce((count, node) => count + occurrenceCount(String(node.data ?? ""), VERSION_PLACEHOLDER), 0);
  if (versionCount !== 2) {
    throw new Error(
      `Landing page placeholder ${VERSION_PLACEHOLDER} must occur exactly 2 time(s); found ${versionCount}`
    );
  }
}

/** @param {unknown} error */
function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/** @param {string} path */
async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Fail closed when TypeDoc did not emit the representative public contract.
 *
 * @param {string} apiSource
 * @returns {Promise<void>}
 */
async function assertTypeDocSource(apiSource) {
  const required = [
    "index.html",
    ".nojekyll",
    "assets/style.css",
    "functions/tools.searchHybrid.html",
    "interfaces/tools.SearchHybridResponse.html"
  ];
  const missing = [];
  for (const rel of required) {
    if (!(await fileExists(join(apiSource, rel)))) missing.push(rel);
  }
  if (missing.length > 0) {
    throw new Error(`TypeDoc source is incomplete; refusing Pages build: ${missing.join(", ")}`);
  }
}

/** @param {Array<{q: string, a: string}>} entries */
function renderFaq(entries) {
  return entries
    .map(
      ({ q, a }, index) => `<details${index === 0 ? " open" : ""}>
  <summary>${escapeHtml(q)}</summary>
  <p>${escapeHtml(a)}</p>
</details>`
    )
    .join("\n");
}

/** @param {Record<string, any>} node @param {string} name */
function tagAttributeValues(node, name) {
  return Array.isArray(node.attributes)
    ? node.attributes
        .filter((attribute) => attribute?.name === name)
        .map((attribute) => (typeof attribute?.value === "string" ? attribute.value : null))
    : [];
}

/** @param {Record<string, any>} node */
function tagClassTokens(node) {
  return tagAttributeValues(node, "class").flatMap((value) =>
    typeof value === "string" ? value.split(/[\t\n\f\r ]+/).filter(Boolean) : []
  );
}

/** @param {Array<Record<string, any>>} nodes @param {number} startIndex */
function matchingEndIndex(nodes, startIndex) {
  const start = nodes[startIndex];
  // In HTML syntax a self-closing slash is ignored on non-void elements
  // (`<div/>` still opens a div). Treat only the actual HTML void set as
  // incapable of owning descendants.
  if (start?.kind !== "startTag" || VOID_ELEMENTS.has(start.name)) return -1;
  let depth = 1;
  for (let index = startIndex + 1; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node?.name !== start.name) continue;
    if (node.kind === "startTag" && !VOID_ELEMENTS.has(node.name)) depth += 1;
    if (node.kind === "endTag") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

/** @param {Array<Record<string, any>>} nodes @param {string} name */
function uniqueElementRange(nodes, name) {
  const starts = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind === "startTag" && node.name === name);
  const ends = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind === "endTag" && node.name === name);
  const start = starts.length === 1 ? (starts[0]?.index ?? -1) : -1;
  const end = start < 0 ? -1 : matchingEndIndex(nodes, start);
  return { startCount: starts.length, endCount: ends.length, start, end };
}

/** @param {Array<Record<string, any>>} nodes @param {number} headStart @param {number} headEnd */
function headContentIsMetadataOnly(nodes, headStart, headEnd) {
  for (let index = headStart + 1; index < headEnd; index += 1) {
    const node = nodes[index];
    if (node?.kind === "comment") continue;
    if (node?.kind === "text" && /^[\t\n\f\r ]*$/.test(String(node.data ?? ""))) continue;
    if (
      (node?.kind === "startTag" || node?.kind === "endTag") &&
      HEAD_CONTENT_ELEMENTS.has(String(node.name))
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Determine whether an element is a direct child of a bounded parent element.
 * Any earlier still-open element inside the parent makes the candidate nested.
 *
 * @param {Array<Record<string, any>>} nodes
 * @param {number} parentStart
 * @param {number} parentEnd
 * @param {number} childIndex
 */
function isDirectElementChild(nodes, parentStart, parentEnd, childIndex) {
  if (childIndex <= parentStart || childIndex >= parentEnd) return false;
  for (let index = parentStart + 1; index < childIndex; index += 1) {
    const node = nodes[index];
    if (node?.kind !== "startTag" || VOID_ELEMENTS.has(node.name)) continue;
    const end = matchingEndIndex(nodes, index);
    if (end < 0) return false;
    // A wrapper is still open at the candidate even when its malformed close
    // occurs outside the bounded parent. Such a close must not manufacture a
    // false direct-child relationship.
    if (end > childIndex) return false;
  }
  return true;
}

/** @param {string} value */
function decodeRenderedText(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

/** @param {Array<Record<string, any>>} nodes @param {number} startIndex @param {number} endIndex */
function elementText(nodes, startIndex, endIndex) {
  return decodeRenderedText(
    nodes
      .slice(startIndex + 1, endIndex)
      .filter((node) => node.kind === "text")
      .map((node) => String(node.data ?? ""))
      .join("")
      .trim()
  );
}

/**
 * Return structural problems for the active FAQ section. Commented, template,
 * and raw-text lookalikes never enter the active token stream.
 *
 * @param {string} html
 * @returns {string[]}
 */
function liveFaqProblems(html) {
  const nodes = scanActiveHtml(html);
  const body = uniqueElementRange(nodes, "body");
  const validBody = body.startCount === 1 && body.endCount === 1 && body.start >= 0 && body.end > body.start;
  const faqStarts = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node, index }) => {
      const ids = tagAttributeValues(node, "id");
      return (
        validBody &&
        index > body.start &&
        index < body.end &&
        node.kind === "startTag" &&
        ids.length === 1 &&
        ids[0] === "faq"
      );
    });
  if (faqStarts.length !== 1) return [`expected exactly one live #faq section; found ${faqStarts.length}`];

  const faqStart = faqStarts[0]?.index ?? -1;
  const faqEnd = matchingEndIndex(nodes, faqStart);
  if (faqEnd < 0) return ["live #faq section is not closed"];
  const allFaqLists = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind === "startTag" && tagClassTokens(node).includes("faq-list"));
  const faqLists = allFaqLists.filter(({ node, index }) => {
    const classes = tagAttributeValues(node, "class");
    return (
      node.name === "div" &&
      !node.malformed &&
      index > faqStart &&
      index < faqEnd &&
      classes.length === 1 &&
      tagAttributeValues(node, "hidden").length === 0
    );
  });
  if (allFaqLists.length !== 1 || faqLists.length !== 1) {
    return [`expected exactly one live .faq-list container; found ${faqLists.length}`];
  }
  const faqListStart = faqLists[0]?.index ?? -1;
  const faqListEnd = matchingEndIndex(nodes, faqListStart);
  if (faqListEnd < 0 || faqListEnd > faqEnd) return ["live .faq-list container is not closed inside #faq"];
  const details = nodes
    .map((node, index) => ({ node, index }))
    .filter(
      ({ node, index }) =>
        index > faqListStart &&
        index < faqListEnd &&
        node.kind === "startTag" &&
        node.name === "details" &&
        tagAttributeValues(node, "hidden").length === 0 &&
        isDirectElementChild(nodes, faqListStart, faqListEnd, index)
    );
  if (details.length !== FAQ_ENTRIES.length) {
    return [`live #faq has ${details.length} details entries; expected ${FAQ_ENTRIES.length}`];
  }

  const problems = [];
  for (let index = 0; index < details.length; index += 1) {
    const detailStart = details[index]?.index ?? -1;
    const detailEnd = matchingEndIndex(nodes, detailStart);
    const expected = FAQ_ENTRIES[index];
    if (detailEnd < 0 || !expected) {
      problems.push(`FAQ entry ${index + 1} is not structurally complete`);
      continue;
    }
    for (const [name, expectedText] of [
      ["summary", expected.q],
      ["p", expected.a]
    ]) {
      const matches = nodes
        .map((node, nodeIndex) => ({ node, nodeIndex }))
        .filter(
          ({ node, nodeIndex }) =>
            nodeIndex > detailStart &&
            nodeIndex < detailEnd &&
            node.kind === "startTag" &&
            node.name === name &&
            tagAttributeValues(node, "hidden").length === 0
        );
      if (matches.length !== 1) {
        problems.push(`FAQ entry ${index + 1} has ${matches.length} live <${name}> elements`);
        continue;
      }
      const childStart = matches[0]?.nodeIndex ?? -1;
      if (!isDirectElementChild(nodes, detailStart, detailEnd, childStart)) {
        problems.push(`FAQ entry ${index + 1} does not have one direct <${name}> child`);
        continue;
      }
      const childEnd = matchingEndIndex(nodes, childStart);
      const actualText = childEnd < 0 || childEnd > detailEnd ? "" : elementText(nodes, childStart, childEnd);
      if (actualText !== expectedText) problems.push(`FAQ entry ${index + 1} has stale ${name} text`);
    }
  }
  return problems;
}

/** @param {string} html */
function landingShellProblems(html) {
  const nodes = scanActiveHtml(html);
  const tags = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind === "startTag");
  const head = uniqueElementRange(nodes, "head");
  const body = uniqueElementRange(nodes, "body");
  const validHead =
    head.startCount === 1 &&
    head.endCount === 1 &&
    head.start >= 0 &&
    head.end > head.start &&
    headContentIsMetadataOnly(nodes, head.start, head.end);
  const validBody =
    body.startCount === 1 &&
    body.endCount === 1 &&
    body.start > head.end &&
    body.end > body.start;
  const allMains = tags.filter(({ node }) => node.name === "main");
  const mains = allMains.filter(({ node, index }) => {
    const ids = tagAttributeValues(node, "id");
    return (
      validBody &&
      index > body.start &&
      index < body.end &&
      !node.malformed &&
      ids.length === 1 &&
      ids[0] === "main" &&
      tagAttributeValues(node, "hidden").length === 0 &&
      isDirectElementChild(nodes, body.start, body.end, index)
    );
  });
  const mainStart = mains.length === 1 && allMains.length === 1 ? (mains[0]?.index ?? -1) : -1;
  const mainEnd = mainStart < 0 ? -1 : matchingEndIndex(nodes, mainStart);
  const allInstalls = tags.filter(({ node }) => tagAttributeValues(node, "id").includes("install"));
  const installs = allInstalls.filter(({ node, index }) => {
    const ids = tagAttributeValues(node, "id");
    return (
      node.name === "section" &&
      !node.malformed &&
      mainEnd > mainStart &&
      index > mainStart &&
      index < mainEnd &&
      ids.length === 1 &&
      ids[0] === "install" &&
      tagAttributeValues(node, "hidden").length === 0 &&
      isDirectElementChild(nodes, mainStart, mainEnd, index)
    );
  });
  const allFaqs = tags.filter(({ node }) => tagAttributeValues(node, "id").includes("faq"));
  const faqs = allFaqs.filter(({ node, index }) => {
    const ids = tagAttributeValues(node, "id");
    return (
      node.name === "section" &&
      !node.malformed &&
      mainEnd > mainStart &&
      index > mainStart &&
      index < mainEnd &&
      ids.length === 1 &&
      ids[0] === "faq" &&
      tagAttributeValues(node, "hidden").length === 0 &&
      isDirectElementChild(nodes, mainStart, mainEnd, index)
    );
  });
  const allCanonicals = tags.filter(({ node }) => {
    const relValues = tagAttributeValues(node, "rel");
    const rels = relValues
      .flatMap((value) => (value ?? "").split(/[\t\n\f\r ]+/))
      .map((value) => value.toLowerCase());
    return node.name === "link" && rels.includes("canonical");
  });
  const canonicals = allCanonicals.filter(({ node, index }) => {
    const relValues = tagAttributeValues(node, "rel");
    const rels = relValues
      .flatMap((value) => (value ?? "").split(/[\t\n\f\r ]+/))
      .map((value) => value.toLowerCase());
    const hrefs = tagAttributeValues(node, "href");
    return (
      node.name === "link" &&
      validHead &&
      index > head.start &&
      index < head.end &&
      relValues.length === 1 &&
      rels.includes("canonical") &&
      hrefs.length === 1 &&
      hrefs[0] === "https://oomkapwn.github.io/enquire-mcp/"
    );
  });
  const bases = tags.filter(({ node }) => node.name === "base");
  const problems = [];
  if (allMains.length !== 1 || mains.length !== 1 || mainEnd < 0) {
    problems.push(`expected exactly one live direct <main id="main">; found ${mains.length}`);
  }
  if (allInstalls.length !== 1 || installs.length !== 1) {
    problems.push(`expected exactly one live direct <section id="install">; found ${installs.length}`);
  }
  if (allFaqs.length !== 1 || faqs.length !== 1) {
    problems.push(`expected exactly one live direct <section id="faq">; found ${faqs.length}`);
  }
  if (head.startCount !== 1) problems.push(`expected exactly one live <head>; found ${head.startCount}`);
  if (head.startCount === 1 && (head.endCount !== 1 || head.end < 0)) problems.push("live <head> is not closed exactly once");
  if (head.startCount === 1 && head.end >= 0 && !headContentIsMetadataOnly(nodes, head.start, head.end)) {
    problems.push("live <head> contains body-content markup");
  }
  if (body.startCount !== 1) problems.push(`expected exactly one live <body>; found ${body.startCount}`);
  if (body.startCount === 1 && (body.endCount !== 1 || body.end < 0)) problems.push("live <body> is not closed exactly once");
  if (head.end >= body.start && body.start >= 0) problems.push("live <head> must close before <body>");
  if (bases.length > 0) problems.push(`active <base> is forbidden; found ${bases.length}`);
  if (canonicals.length !== 1) problems.push(`expected exactly one live canonical link; found ${canonicals.length}`);
  if (allCanonicals.length !== 1) {
    problems.push(`expected exactly one active canonical relation; found ${allCanonicals.length}`);
  }
  return problems;
}

/**
 * Return unresolved or broken local hrefs from the built landing page.
 *
 * @param {string} html
 * @param {string} outDir
 * @returns {Promise<string[]>}
 */
async function localLinkProblems(html, outDir) {
  const problems = [];
  const tags = scanActiveHtml(html).filter((node) => node.kind === "startTag");
  const ids = new Set();
  for (const tag of tags) {
    const values = tagAttributeValues(tag, "id");
    if (values.length > 1) {
      problems.push(`duplicate id attributes on <${String(tag.name)}>`);
      continue;
    }
    const value = values[0];
    if (typeof value === "string") {
      if (ids.has(value)) problems.push(`duplicate id value #${value}`);
      ids.add(value);
    }
  }
  const hrefs = new Set(
    tags.flatMap((node) => tagAttributeValues(node, "href")).filter((value) => typeof value === "string")
  );

  for (const href of hrefs) {
    if (/^(?:https?:|mailto:|tel:)/.test(href)) continue;
    if (href.startsWith("#")) {
      if (!ids.has(href.slice(1))) problems.push(`missing fragment target ${href}`);
      continue;
    }
    const withoutSuffix = href.split(/[?#]/, 1)[0] ?? "";
    if (!withoutSuffix) continue;
    const normalized = withoutSuffix.replace(/^\.\//, "");
    const target = resolve(
      outDir,
      normalized === "" || normalized.endsWith("/") ? join(normalized, "index.html") : normalized
    );
    const rel = relative(outDir, target);
    if (rel.startsWith(`..${sep}`) || rel === "..") {
      problems.push(`href escapes artifact: ${href}`);
      continue;
    }
    if (!(await fileExists(target))) problems.push(`missing local href ${href}`);
  }
  return problems;
}

/**
 * Validate the user-facing root, the stable `/api/` copy, and legacy TypeDoc
 * symbol URLs before an artifact can be uploaded.
 *
 * @param {string} outDir
 * @param {Record<string, any>} [expectedPackage]
 * @returns {Promise<{fileCount: number, bytes: number}>}
 */
export async function validatePagesArtifact(outDir, expectedPackage) {
  const required = [
    "index.html",
    "site.css",
    "site.js",
    "manifest.webmanifest",
    "robots.txt",
    "sitemap.xml",
    "llms.txt",
    "llms-ctx.txt",
    "social-preview.png",
    ".nojekyll",
    "api/index.html",
    "api/assets/style.css",
    "api/functions/tools.searchHybrid.html",
    "functions/tools.searchHybrid.html",
    "interfaces/tools.SearchHybridResponse.html"
  ];
  const missing = [];
  for (const rel of required) {
    if (!(await fileExists(join(outDir, rel)))) missing.push(rel);
  }
  if (missing.length > 0) throw new Error(`Pages artifact is incomplete: ${missing.join(", ")}`);

  const landing = await readFile(join(outDir, "index.html"), "utf8");
  const apiIndex = await readFile(join(outDir, "api/index.html"), "utf8");
  for (const unresolved of ["<!-- ENQUIRE_JSONLD -->", "<!-- ENQUIRE_FAQ -->", "__ENQUIRE_VERSION__"]) {
    if (landing.includes(unresolved)) throw new Error(`Landing page still contains placeholder: ${unresolved}`);
  }
  if (!/enquire-mcp API reference/.test(apiIndex)) {
    throw new Error("Stable /api/ index is not the generated TypeDoc reference");
  }

  const shellProblems = landingShellProblems(landing);
  if (shellProblems.length > 0) {
    throw new Error(`Landing page shell is not structurally live: ${shellProblems.join(", ")}`);
  }

  const pkg =
    expectedPackage ?? JSON.parse(await readFile(join(defaultRepoRoot, "package.json"), "utf8"));
  const jsonLd = inspectJsonLdScripts(landing, pkg);
  if (
    jsonLd.ownedCount !== 1 ||
    jsonLd.staleOwnedCount !== 0 ||
    jsonLd.malformedCount !== 0 ||
    jsonLd.htmlMalformedCount !== 0
  ) {
    throw new Error(
      `Landing page JSON-LD is not exactly one current active owned graph: ${JSON.stringify(jsonLd)}`
    );
  }
  const faqProblems = liveFaqProblems(landing);
  if (faqProblems.length > 0) throw new Error(`Landing page FAQ is not current and live: ${faqProblems.join(", ")}`);

  const linkProblems = await localLinkProblems(landing, outDir);
  if (linkProblems.length > 0) throw new Error(`Landing page has broken local links: ${linkProblems.join(", ")}`);

  let fileCount = 0;
  let bytes = 0;
  const pending = [outDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile()) {
        fileCount += 1;
        bytes += (await stat(path)).size;
      }
    }
  }
  return { fileCount, bytes };
}

/**
 * Build the deterministic GitHub Pages artifact.
 *
 * TypeDoc is copied twice intentionally:
 * 1. at the artifact root, preserving every historical symbol URL;
 * 2. under `/api/`, providing the stable API front door.
 * The human/AI landing source then replaces only the root `index.html`.
 *
 * @param {{
 *   repoRoot?: string,
 *   apiSource?: string,
 *   siteSource?: string,
 *   outDir?: string
 * }} [options]
 */
export async function buildPagesArtifact(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const apiSource = resolve(options.apiSource ?? join(repoRoot, "docs/api-reference"));
  const siteSource = resolve(options.siteSource ?? join(repoRoot, "site"));
  const outDir = resolve(options.outDir ?? join(repoRoot, ".pages-dist"));

  await assertTypeDocSource(apiSource);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await cp(apiSource, outDir, { recursive: true });
  await cp(apiSource, join(outDir, "api"), { recursive: true });
  await cp(siteSource, outDir, { recursive: true });
  await Promise.all([
    cp(join(repoRoot, "llms.txt"), join(outDir, "llms.txt")),
    cp(join(repoRoot, "llms-ctx.txt"), join(outDir, "llms-ctx.txt")),
    cp(join(repoRoot, "assets/social-preview.png"), join(outDir, "social-preview.png"))
  ]);

  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const landingPath = join(outDir, "index.html");
  const landingSource = await readFile(landingPath, "utf8");
  assertLandingPlaceholderCardinality(landingSource);
  const jsonLd = renderEnquireJsonLdTag(pkg);
  const landing = replaceActiveLandingPlaceholders(landingSource, {
    jsonLd,
    faq: renderFaq(FAQ_ENTRIES),
    version: escapeHtml(String(pkg.version))
  });
  await writeFile(landingPath, landing, "utf8");

  const canonical = "https://oomkapwn.github.io/enquire-mcp/";
  await writeFile(join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${canonical}sitemap.xml\n`, "utf8");
  await writeFile(
    join(outDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${canonical}</loc><priority>1.0</priority></url>\n  <url><loc>${canonical}api/</loc><priority>0.8</priority></url>\n  <url><loc>${canonical}llms.txt</loc><priority>0.7</priority></url>\n  <url><loc>${canonical}llms-ctx.txt</loc><priority>0.6</priority></url>\n</urlset>\n`,
    "utf8"
  );
  await writeFile(
    join(outDir, "manifest.webmanifest"),
    `${JSON.stringify(
      {
        name: "enquire-mcp — AI memory for Obsidian",
        short_name: "enquire-mcp",
        description: pkg.description,
        start_url: "./",
        display: "standalone",
        background_color: "#090b13",
        theme_color: "#0b0d17"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return { outDir, ...(await validatePagesArtifact(outDir, pkg)) };
}

if (isEntrypoint(import.meta.url)) {
  try {
    const result = await buildPagesArtifact();
    console.log(
      `[pages] built ${result.fileCount} files / ${(result.bytes / 1024 / 1024).toFixed(2)} MiB at ${result.outDir}`
    );
    console.log("[pages] root landing + /api/ TypeDoc + legacy symbol URLs validated");
  } catch (error) {
    console.error(`[pages] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
