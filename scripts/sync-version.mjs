#!/usr/bin/env node
// Run by `npm version <patch|minor|major>` (via the `version` lifecycle hook)
// to keep all version surfaces in sync. npm itself bumps package.json; this
// script:
//
//   1. Mirrors the new version into the `VERSION` constant in `src/index.ts`
//      (otherwise the binary's `--version` lies and `version-consistency` CI
//      fails).
//   2. Regenerates `package-lock.json` so the lockfile root + packages[""]
//      match the new version.
//   3. Warns (without failing) if `CHANGELOG.md` doesn't have a matching
//      `## [<version>]` heading yet — that's a manual content step.
//
// After this script runs, `npm version` stages the listed files, commits
// them, and creates the `v<version>` git tag automatically.

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

// 2. Regenerate package-lock.json (npm install with --package-lock-only is
//    fast and updates root + packages[""].version to match package.json).
process.stdout.write("sync-version: regenerating package-lock.json\n");
execFileSync("npm", ["install", "--package-lock-only"], { stdio: "inherit", cwd: repoRoot });

// 3. CHANGELOG content check (warn-only — content is human work).
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
