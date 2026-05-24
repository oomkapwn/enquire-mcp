#!/usr/bin/env node
// v3.8.6 — inject Schema.org JSON-LD into TypeDoc-generated index.html.
//
// Goal: make Google AI Overviews / Perplexity / Bing Copilot recognize
// enquire-mcp as a SoftwareApplication with proper metadata. JSON-LD in
// <head> is the canonical structured-data format these crawlers parse.
//
// What it does: read package.json (canonical source for name/version/desc),
// generate a JSON-LD blob, and inject it into the <head> of the file
// passed as first argument (defaults to docs/api-reference/index.html).
//
// Idempotent: looks for the `application/ld+json` marker; if already
// present, skips injection (so re-running doesn't accumulate duplicates).
//
// Run via: node scripts/inject-jsonld.mjs [docs/api-reference/index.html]
// Called from .github/workflows/publish-docs.yml after `npm run docs:api`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

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

// Schema.org SoftwareApplication schema. Fields chosen to maximize
// signal for AI search + traditional search engines:
//   - @type SoftwareApplication + applicationCategory DeveloperApplication
//   - name, description, version (from package.json — canonical source)
//   - downloadUrl + softwareHelp (npm + docs site)
//   - license URL (SPDX URL — most reliable for crawlers)
//   - author (from package.json author field)
//   - keywords (subset of npm keywords)
//   - codeRepository + programmingLanguage
//   - softwareRequirements (Node version from engines)
const jsonld = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  name: "enquire-mcp",
  description: pkg.description,
  softwareVersion: pkg.version,
  downloadUrl: `https://www.npmjs.com/package/${pkg.name}`,
  softwareHelp: {
    "@type": "CreativeWork",
    url: "https://oomkapwn.github.io/enquire-mcp/"
  },
  license: "https://spdx.org/licenses/MIT.html",
  author: {
    "@type": "Person",
    name: typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? "Alex"),
    url: "https://github.com/oomkapwn"
  },
  keywords: Array.isArray(pkg.keywords) ? pkg.keywords.slice(0, 20).join(", ") : "",
  codeRepository: pkg.repository?.url ?? `https://github.com/oomkapwn/enquire-mcp`,
  programmingLanguage: "TypeScript",
  softwareRequirements: pkg.engines?.node ?? "Node.js >=22.13.0",
  // v3.8.6 also adds offers: free
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD"
  }
};

const tag = `<script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n</script>`;

// Inject into <head>. TypeDoc-generated index.html has <head> on its own
// line; we look for it and insert the script just before </head>.
const headCloseRe = /<\/head>/i;
if (!headCloseRe.test(html)) {
  console.error(`[inject-jsonld] no </head> in ${target}; cannot inject`);
  process.exit(1);
}
const out = html.replace(headCloseRe, `${tag}\n</head>`);
writeFileSync(target, out, "utf8");
console.log(`[inject-jsonld] injected SoftwareApplication JSON-LD into ${target} (${tag.length} bytes)`);
