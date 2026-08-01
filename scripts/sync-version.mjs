#!/usr/bin/env node
// Run by `npm version --no-git-tag-version <version>` (via the `version`
// lifecycle hook) to keep all version surfaces in sync without creating a tag
// on a pre-merge topic commit. npm itself bumps package.json; this script:
//
//   1. Mirrors the new version into the `VERSION` constant in `src/index.ts`
//      (otherwise the binary's `--version` lies and `version-consistency` CI
//      fails).
//   2. Mirrors it into server.json and mcpb/manifest.json.
//   3. Regenerates `package-lock.json` so the lockfile root + packages[""]
//      match the new version.
//   4. Warns (without failing) if `CHANGELOG.md` doesn't have a matching
//      `## [<version>]` heading yet — that's a manual content step.
//
// After this script runs, review the staged files in the topic PR. Create the
// annotated `v<version>` tag only on the final squash-merge SHA on main; the
// release preflight rejects lightweight and pre-merge tags.

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const version = pkg.version;
if (!version) {
  process.stderr.write("sync-version: no version field in package.json — aborting\n");
  process.exit(1);
}

// 1. Sync src/index.ts VERSION constant.
const indexPath = path.join(repoRoot, "src/index.ts");
const indexSrc = await readFile(indexPath, "utf8");
const versionRe = /const VERSION = "([^"]+)"/;
const match = versionRe.exec(indexSrc);
if (!match) {
  process.stderr.write(`sync-version: could not find VERSION constant in ${indexPath} — aborting\n`);
  process.exit(1);
}
if (match[1] === version) {
  process.stdout.write(`sync-version: src/index.ts already at ${version}\n`);
} else {
  const updated = indexSrc.replace(versionRe, `const VERSION = "${version}"`);
  await writeFile(indexPath, updated);
  process.stdout.write(`sync-version: src/index.ts ${match[1]} → ${version}\n`);
}

// 2. Sync registry and MCPB manifests.
const serverPath = path.join(repoRoot, "server.json");
const serverManifest = JSON.parse(await readFile(serverPath, "utf8"));
if (!Array.isArray(serverManifest.packages) || !serverManifest.packages[0]) {
  process.stderr.write("sync-version: server.json packages[0] is missing — aborting\n");
  process.exit(1);
}
const previousServerVersion = serverManifest.version;
serverManifest.version = version;
serverManifest.packages[0].version = version;
await writeFile(serverPath, `${JSON.stringify(serverManifest, null, 2)}\n`);
process.stdout.write(`sync-version: server.json ${previousServerVersion} → ${version}\n`);

const mcpbPath = path.join(repoRoot, "mcpb", "manifest.json");
const mcpbManifest = JSON.parse(await readFile(mcpbPath, "utf8"));
if (typeof mcpbManifest.name !== "string" || mcpbManifest.name.length === 0) {
  process.stderr.write("sync-version: mcpb/manifest.json identity is missing — aborting\n");
  process.exit(1);
}
const previousMcpbVersion = mcpbManifest.version;
mcpbManifest.version = version;
await writeFile(mcpbPath, `${JSON.stringify(mcpbManifest, null, 2)}\n`);
process.stdout.write(`sync-version: mcpb/manifest.json ${previousMcpbVersion} → ${version}\n`);

// 3. Regenerate package-lock.json (npm install with --package-lock-only is
//    fast and updates root + packages[""].version to match package.json).
process.stdout.write("sync-version: regenerating package-lock.json\n");
execFileSync("npm", ["install", "--package-lock-only"], { stdio: "inherit", cwd: repoRoot });

// 4. CHANGELOG content check (warn-only — content is human work).
const changelog = await readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
// Escape every regex special — version strings should never contain them in
// practice (semver is constrained), but CodeQL flags incomplete-sanitization
// regardless and a complete escape is the same one-liner.
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingRe = new RegExp(`^## \\[${escapedVersion}\\]`, "m");
if (!headingRe.test(changelog)) {
  process.stderr.write(
    `sync-version: WARN — CHANGELOG.md is missing a "## [${version}]" heading. Add one before pushing the tag.\n`
  );
} else {
  process.stdout.write(`sync-version: CHANGELOG.md has a heading for ${version} OK\n`);
}
