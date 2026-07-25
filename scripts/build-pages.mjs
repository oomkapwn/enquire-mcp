#!/usr/bin/env node

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJsonLdGraph, FAQ_ENTRIES } from "./inject-jsonld.mjs";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");

/** @param {string} value */
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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

/**
 * Return unresolved or broken local hrefs from the built landing page.
 *
 * @param {string} html
 * @param {string} outDir
 * @returns {Promise<string[]>}
 */
async function localLinkProblems(html, outDir) {
  const problems = [];
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const hrefs = new Set([...html.matchAll(/\shref="([^"]+)"/g)].map((match) => match[1] ?? ""));

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
 * @returns {Promise<{fileCount: number, bytes: number}>}
 */
export async function validatePagesArtifact(outDir) {
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
  for (const marker of ["<main", 'rel="canonical"', "application/ld+json", 'id="install"', 'id="faq"']) {
    if (!landing.includes(marker)) throw new Error(`Landing page is missing required marker: ${marker}`);
  }
  for (const unresolved of ["<!-- ENQUIRE_JSONLD -->", "<!-- ENQUIRE_FAQ -->", "__ENQUIRE_VERSION__"]) {
    if (landing.includes(unresolved)) throw new Error(`Landing page still contains placeholder: ${unresolved}`);
  }
  if (!/enquire-mcp API reference/.test(apiIndex)) {
    throw new Error("Stable /api/ index is not the generated TypeDoc reference");
  }

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
  const jsonLd = `<script type="application/ld+json">\n${JSON.stringify(buildJsonLdGraph(pkg), null, 2)}\n</script>`;
  const landing = landingSource
    .replace("<!-- ENQUIRE_JSONLD -->", jsonLd)
    .replace("<!-- ENQUIRE_FAQ -->", renderFaq(FAQ_ENTRIES))
    .replaceAll("__ENQUIRE_VERSION__", escapeHtml(String(pkg.version)));
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

  return { outDir, ...(await validatePagesArtifact(outDir)) };
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
