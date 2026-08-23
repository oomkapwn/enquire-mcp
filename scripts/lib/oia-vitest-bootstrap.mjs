import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Receipt checked by the required CI lint job before setup-node runs. */
export const VITEST_BOOTSTRAP_MANIFEST = ".github/trusted-vitest-bootstrap.sha256";

/**
 * Exact first-party inputs that may affect dependency installation, Vitest
 * collection, or the independent OIA execution-control scan. The final entry
 * covers the full CI workflow after normalizing its one receipt-SHA carrier;
 * that normalization keeps the relationship finite rather than self-hashing.
 */
export const EXPECTED_VITEST_BOOTSTRAP_FILES = Object.freeze([
  "package-lock.json",
  "package.json",
  "scripts/lib/coverage-policy.mjs",
  "scripts/lib/entrypoint.mjs",
  "scripts/lib/oia-offline-guard.mjs",
  "scripts/lib/oia-release-claims.mjs",
  "scripts/lib/oia-vitest-bootstrap.mjs",
  "scripts/lib/oia-vitest-focus.mjs",
  "scripts/lib/oia-vitest-selection.mjs",
  "scripts/npm-ci-with-retry.mjs",
  "scripts/oia-walk.mjs",
  "scripts/scope-completeness-audit.mjs",
  "tests/setup.ts",
  "tsconfig.json",
  "vitest.config.ts",
  ".github/workflows/ci.yml"
]);

/** Exact root inputs that can implicitly alter install or Vitest startup. */
export const FORBIDDEN_VITEST_BOOTSTRAP_ROOT_INPUTS = Object.freeze([
  ".env",
  ".env.local",
  ".env.test",
  ".env.test.local",
  ".npmrc",
  "binding.gyp",
  "npm-shrinkwrap.json"
]);

const CI_WORKFLOW = ".github/workflows/ci.yml";
const MANIFEST_LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9._/-]+)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NORMALIZED_CI_RECEIPT_CARRIER = "          expected_manifest_sha=<normalized>";
const BOOTSTRAP_HINT =
  "Restore the reviewed Vitest bootstrap bytes, regenerate the exact receipt, and update its single CI carrier in the same reviewed change.";

function literalDollarBraces(body) {
  return "$" + "{" + body + "}";
}

const OIA_BOOTSTRAP_PROLOGUE = [
  'import { createHash } from "node:crypto";',
  'import { existsSync, readdirSync, readFileSync } from "node:fs";',
  'import { dirname, join, relative, resolve } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  'import { formatVitestBootstrapError, inspectRepositoryVitestBootstrap } from "./lib/oia-vitest-bootstrap.mjs";',
  "",
  "const __filename = fileURLToPath(import.meta.url);",
  "const __dirname = dirname(__filename);",
  'const repoRoot = resolve(__dirname, "..");',
  "",
  'const ALLOW_MODE = process.argv.includes("--allow");',
  "",
  "const initialVitestBootstrapFindings = inspectRepositoryVitestBootstrap(repoRoot);",
  "if (initialVitestBootstrapFindings.length > 0) {",
  "  throw new Error(formatVitestBootstrapError(initialVitestBootstrapFindings));",
  "}",
  "",
  'const { load } = await import("js-yaml");',
  'const { expectedCoverageSourceFiles, normalizeCoverageReportedPath } = await import("./lib/coverage-policy.mjs");',
  'const { inspectEmbeddingsOfflineGuards } = await import("./lib/oia-offline-guard.mjs");',
  'const { inspectReleaseProvenanceWorkflow } = await import("./lib/oia-release-claims.mjs");',
  'const { inspectRepositoryVitestFocusControls } = await import("./lib/oia-vitest-focus.mjs");',
  'const { inspectRepositoryVitestSelectionControls } = await import("./lib/oia-vitest-selection.mjs");'
].join("\n");

const OIA_BOOTSTRAP_TAIL = [
  "try {",
  "  for (const finding of inspectRepositoryVitestBootstrap(repoRoot)) {",
  "    record(finding.kind, finding.file, finding.line, finding.evidence, finding.hint);",
  "  }",
  "} catch (error) {",
  "  record(",
  '    "VITEST-BOOTSTRAP-SCAN-ERROR",',
  '    "scripts/lib/oia-vitest-bootstrap.mjs",',
  "    1,",
  "    error instanceof Error ? `" + literalDollarBraces("error.name") + ": " + literalDollarBraces("error.message") + "` : String(error),",
  '    "The trusted Vitest bootstrap re-scan did not complete. Treat this as a blocking unverified state."',
  "  );",
  "}"
].join("\n");

const ANALYZER_IMPORT_PREFIX = [
  'import { createHash } from "node:crypto";',
  'import { lstatSync, readdirSync, readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  ""
].join("\n");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hash the complete CI workflow while excluding only the value of its raw
 * receipt-SHA carrier. The raw carrier remains checked separately against the
 * raw receipt, so this normalization breaks the hash cycle without leaving
 * that value unchecked.
 *
 * @param {string} source Raw `.github/workflows/ci.yml` source.
 * @returns {string} SHA-256 of the canonically normalized workflow source.
 * @throws {Error} If the workflow does not contain exactly one canonical carrier.
 * @example
 * ciWorkflowReceiptDigest("...expected_manifest_sha=<64 lowercase hex>...");
 */
export function ciWorkflowReceiptDigest(source) {
  const matches = [...source.matchAll(/^ {10}expected_manifest_sha=([0-9a-f]{64})$/gmu)];
  const match = matches[0];
  if (matches.length !== 1 || match?.index === undefined) {
    throw new Error(`expected one canonical receipt carrier, found ${matches.length}`);
  }
  const normalized =
    source.slice(0, match.index) + NORMALIZED_CI_RECEIPT_CARRIER + source.slice(match.index + match[0].length);
  return sha256(normalized);
}

function finding(kind, file, line, evidence, hint = BOOTSTRAP_HINT) {
  return { kind, file, line, evidence, hint };
}

function sourceLine(source, offset) {
  return source.slice(0, Math.max(0, offset)).split("\n").length;
}

function lstatOrUndefined(filename) {
  try {
    return lstatSync(filename);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

function physicalPathFindings(root, relativePath, leafKind = "file") {
  const out = [];
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stat = lstatOrUndefined(current);
    if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
      out.push(
        finding(
          "VITEST-BOOTSTRAP-PHYSICAL-PATH",
          relativePath,
          1,
          `${relativePath}: parent ${segment} must be a physical non-symlink directory`
        )
      );
      return out;
    }
  }
  const stat = lstatOrUndefined(join(root, relativePath));
  const validLeaf =
    stat !== undefined && !stat.isSymbolicLink() && (leafKind === "directory" ? stat.isDirectory() : stat.isFile());
  if (!validLeaf) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-PHYSICAL-PATH",
        relativePath,
        1,
        `${relativePath} must be a physical non-symlink ${leafKind}`
      )
    );
  }
  return out;
}

function expectedCiPrefix(manifestDigest) {
  return [
    "name: CI",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "    branches: [main]",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: ci-" + literalDollarBraces("{ github.ref }"),
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "      - name: Verify trusted Vitest bootstrap",
    "        shell: /bin/bash --noprofile --norc -p -e -o pipefail {0}",
    "        working-directory: " + literalDollarBraces("{ github.workspace }"),
    "        env:",
    '          BASH_ENV: ""',
    '          ENV: ""',
    "          LC_ALL: C",
    '          LD_PRELOAD: ""',
    "        run: |",
    "          set -u",
    `          manifest=${VITEST_BOOTSTRAP_MANIFEST}`,
    `          expected_manifest_sha=${manifestDigest}`,
    "          expected_path_sha=5581eea048d9360a3fff43c79e1d55d40492a082ee468ee74c3738f60c2f82f9",
    `          workflow=${CI_WORKFLOW}`,
    "          [[ -d .github && ! -L .github ]]",
    "          [[ -d .github/workflows && ! -L .github/workflows ]]",
    '          [[ -f "$manifest" && ! -L "$manifest" ]]',
    '          [[ -f "$workflow" && ! -L "$workflow" ]]',
    '          /usr/bin/printf \'%s  %s\\n\' "$expected_manifest_sha" "$manifest" |',
    "            /usr/bin/sha256sum --check --strict",
    '          last_byte_lf_count=$(/usr/bin/tail -c 1 "$manifest" | /usr/bin/wc -l)',
    '          [[ "$last_byte_lf_count" -eq 1 ]]',
    '          line_count=$(/usr/bin/wc -l < "$manifest")',
    '          [[ "$line_count" -eq 16 ]]',
    "          paths=()",
    "          expected_workflow_sha=",
    "          while IFS= read -r record; do",
    '            [[ "$record" =~ ^[0-9a-f]{64}\\ \\ [^[:space:]].*$ ]]',
    "            path=" + literalDollarBraces("record:66"),
    '            paths+=("$path")',
    '            if [[ "$path" == "$workflow" ]]; then',
    "              expected_workflow_sha=" + literalDollarBraces("record:0:64"),
    "            fi",
    '            [[ -f "$path" && ! -L "$path" ]]',
    "            parent=" + literalDollarBraces("path%/*"),
    '            while [[ "$parent" != "$path" ]]; do',
    '              [[ -d "$parent" && ! -L "$parent" ]]',
    "              path=$parent",
    "              parent=" + literalDollarBraces("path%/*"),
    "            done",
    '          done < "$manifest"',
    "          [[ " + literalDollarBraces("#paths[@]") + " -eq 16 ]]",
    "          actual_path_sha=$(/usr/bin/printf '%s\\n' \"" + literalDollarBraces("paths[@]") + "\" | /usr/bin/sha256sum)",
    "          actual_path_sha=" + literalDollarBraces("actual_path_sha%% *"),
    '          [[ "$actual_path_sha" == "$expected_path_sha" ]]',
    '          [[ -n "$expected_workflow_sha" ]]',
    "          carrier_count=$(/usr/bin/grep -Ec '^          expected_manifest_sha=[0-9a-f]{64}$' \"$workflow\")",
    '          [[ "$carrier_count" -eq 1 ]]',
    "          actual_workflow_sha=$(",
    "            /usr/bin/sed -E \\",
    "              's/^          expected_manifest_sha=[0-9a-f]{64}$/          expected_manifest_sha=<normalized>/' \\",
    '              "$workflow" |',
    "              /usr/bin/sha256sum",
    "          )",
    "          actual_workflow_sha=" + literalDollarBraces("actual_workflow_sha%% *"),
    '          [[ "$actual_workflow_sha" == "$expected_workflow_sha" ]]',
    "          shopt -s nullglob",
    "          configs=(vitest.config.* vitest.projects.* vitest.workspace.*)",
    "          [[ " + literalDollarBraces("#configs[@]") + ' -eq 1 && "' + literalDollarBraces("configs[0]") + '" == vitest.config.ts ]]',
    '          for forbidden in ".n""pmrc" binding.gyp "n""pm-shrinkwrap.json" .env .env.local .env.test .env.test.local; do',
    '            [[ ! -e "$forbidden" && ! -L "$forbidden" ]]',
    "          done",
    '          /usr/bin/head -n 15 "$manifest" | /usr/bin/sha256sum --check --strict',
    "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7",
    "        with:",
    "          node-version: 22",
    "          cache: npm",
    "      - name: Install deps (npm ci with retry)",
    "        # One dependency-free cross-platform runner owns the exact attempt,",
    "        # process-tree deadline, kill grace and retry policy. OIA Check 10",
    "        # requires this exact invocation instead of accepting an inline loop.",
    "        run: node scripts/npm-ci-with-retry.mjs",
    "      - run: npm run lint",
    "",
    "  test:"
  ].join("\n");
}

/**
 * Validate the canonical CI receipt carrier without importing a YAML parser.
 *
 * @param {string} source Raw `.github/workflows/ci.yml` source.
 * @param {string} manifestDigest SHA-256 of the raw receipt bytes.
 * @returns {Array<{kind: string, file: string, line: number, evidence: string, hint: string}>} Findings.
 */
export function ciVitestBootstrapProblems(source, manifestDigest) {
  const out = [];
  if (!SHA256.test(manifestDigest)) {
    out.push(finding("VITEST-BOOTSTRAP-CI-CARRIER", CI_WORKFLOW, 1, "manifest digest is not lowercase SHA-256"));
    return out;
  }
  if (source.includes("\r") || source.includes("\t")) {
    out.push(
      finding("VITEST-BOOTSTRAP-CI-SHAPE", CI_WORKFLOW, 1, "CI receipt carrier must remain LF-only and tab-free")
    );
  }
  const columnZeroLines = source
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(" ") && !line.startsWith("#"));
  const expectedColumnZeroLines = ["name: CI", "on:", "permissions:", "concurrency:", "jobs:"];
  if (JSON.stringify(columnZeroLines) !== JSON.stringify(expectedColumnZeroLines)) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-CI-SHAPE",
        CI_WORKFLOW,
        1,
        `CI column-zero census is ${JSON.stringify(columnZeroLines)}`
      )
    );
  }
  const twoSpaceMappings = source.split("\n").filter((line) => /^ {2}\S/u.test(line) && !/^ {2}#/u.test(line));
  if (twoSpaceMappings.some((line) => !/^ {2}[A-Za-z][A-Za-z0-9_-]*:\s*(?:[^&*].*)?$/u.test(line))) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-CI-SHAPE",
        CI_WORKFLOW,
        1,
        "CI two-space mappings must use only canonical unquoted keys without YAML tags, anchors, or aliases"
      )
    );
  }
  const jobsCount = [...source.matchAll(/^jobs:\s*$/gmu)].length;
  const lintCount = [...source.matchAll(/^ {2}lint:\s*$/gmu)].length;
  if (jobsCount !== 1 || lintCount !== 1 || /(^|\s)<<:|^[ \t]*\?/mu.test(source)) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-CI-SHAPE",
        CI_WORKFLOW,
        1,
        `CI must retain one lexical jobs/lint carrier without merge or explicit-key syntax; jobs=${jobsCount}, lint=${lintCount}`
      )
    );
  }
  const carrierMatches = [...source.matchAll(/^ {10}expected_manifest_sha=([0-9a-f]{64})$/gmu)];
  const carrier = carrierMatches[0]?.[1];
  if (carrierMatches.length !== 1 || carrier !== manifestDigest) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-CI-CARRIER",
        CI_WORKFLOW,
        carrierMatches[0] === undefined ? 1 : sourceLine(source, carrierMatches[0].index ?? 0),
        `expected one carrier equal to ${manifestDigest}; received ${carrierMatches.length === 1 ? carrier : `${carrierMatches.length} carriers`}`
      )
    );
  }
  const expectedPrefix = expectedCiPrefix(manifestDigest);
  if (!source.startsWith(`${expectedPrefix}\n`)) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-CI-SHAPE",
        CI_WORKFLOW,
        1,
        "CI root prefix and lint checkout -> receipt -> setup -> install -> lint chain must remain byte-canonical"
      )
    );
  }
  return out;
}

/**
 * Ensure the bootstrap analyzer itself stays dependency-free and cannot exit
 * before returning its evidence.
 *
 * @param {string} source Analyzer source text.
 * @returns {string[]} Problems.
 */
export function vitestBootstrapAnalyzerSourceProblems(source) {
  const problems = [];
  if (!source.startsWith(ANALYZER_IMPORT_PREFIX)) {
    problems.push("bootstrap analyzer must retain its exact Node-builtins-only static import prefix");
  }
  const importStarts = [...source.matchAll(/^[ \t]*import\b/gmu)].length;
  const importHeaderEnd = source.indexOf("\n\n/** Receipt");
  const importHeader = importHeaderEnd < 0 ? source : source.slice(0, importHeaderEnd);
  const fromSpecifiers = [...importHeader.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]);
  if (
    importStarts !== 3 ||
    JSON.stringify(fromSpecifiers) !== JSON.stringify(["node:crypto", "node:fs", "node:path"]) ||
    /^[ \t]*import\s*["']/mu.test(source)
  ) {
    problems.push("bootstrap analyzer may statically import only its three reviewed Node builtin modules");
  }
  const documentedImportCallTokens = [...source.matchAll(/\bimport\s*\(/gu)].length;
  if (
    documentedImportCallTokens !== 7 ||
    /\brequire\s*\(|\bprocess\.(?:exit|abort)\s*\(|^[ \t]*export\s+(?:\*|\{)/mu.test(source)
  ) {
    problems.push("bootstrap analyzer may not dynamically load code or force process termination");
  }
  return problems;
}

/**
 * Pin OIA's executable bootstrap prologue before every other repository or
 * third-party module import, plus the post-walk drift re-scan.
 *
 * @param {string} source OIA source text.
 * @returns {string[]} Problems.
 */
export function oiaVitestBootstrapWiringProblems(source) {
  const problems = [];
  const prologueIndex = source.indexOf(OIA_BOOTSTRAP_PROLOGUE);
  const prologueCount = source.split(OIA_BOOTSTRAP_PROLOGUE).length - 1;
  const beforePrologue = prologueIndex < 0 ? "" : source.slice(0, prologueIndex);
  const preludeLines = beforePrologue.split("\n");
  const canonicalPrelude =
    preludeLines[0] === "#!/usr/bin/env node" &&
    preludeLines.slice(1).every((line) => line === "" || line.startsWith("//"));
  const staticImportStarts = [...source.matchAll(/^import\b.*$/gmu)].map((match) => match[0]);
  const importRegionEnd = prologueIndex < 0 ? -1 : source.indexOf("\n\nconst __filename", prologueIndex);
  const importRegion = importRegionEnd < 0 ? "" : source.slice(prologueIndex, importRegionEnd);
  const fromSpecifiers = [...importRegion.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]);
  const expectedStaticImportStarts = [
    'import { createHash } from "node:crypto";',
    'import { existsSync, readdirSync, readFileSync } from "node:fs";',
    'import { dirname, join, relative, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { formatVitestBootstrapError, inspectRepositoryVitestBootstrap } from "./lib/oia-vitest-bootstrap.mjs";'
  ];
  const expectedFromSpecifiers = ["node:crypto", "node:fs", "node:path", "node:url", "./lib/oia-vitest-bootstrap.mjs"];
  if (
    prologueCount !== 1 ||
    !canonicalPrelude ||
    JSON.stringify(staticImportStarts) !== JSON.stringify(expectedStaticImportStarts) ||
    JSON.stringify(fromSpecifiers) !== JSON.stringify(expectedFromSpecifiers) ||
    /^[ \t]*import\s*["']/mu.test(source) ||
    /^[ \t]+import\b|^[ \t]*export\b/mu.test(source)
  ) {
    problems.push("OIA must retain one exact builtins-only bootstrap prologue before dynamic imports");
  }
  const firstStaticImport = source.indexOf('import { createHash } from "node:crypto";');
  const firstDynamicImport = source.indexOf("await import(");
  const earlyInspection = source.indexOf("const initialVitestBootstrapFindings = inspectRepositoryVitestBootstrap");
  if (
    firstStaticImport < 0 ||
    earlyInspection < firstStaticImport ||
    firstDynamicImport < earlyInspection ||
    source.slice(firstStaticImport, firstDynamicImport).includes("process.exit")
  ) {
    problems.push("OIA bootstrap inspection must execute before any dynamic import or forced exit");
  }
  const tailReceipt = `${OIA_BOOTSTRAP_TAIL}\n\n// ─── Report ─`;
  const tailCount = source.split(tailReceipt).length - 1;
  if (tailCount !== 1) {
    problems.push("OIA must retain one exact fail-closed post-walk bootstrap re-scan");
  }
  return problems;
}

/**
 * Inspect the CI-anchored Vitest bootstrap receipt and every current implicit
 * startup input. The manifest intentionally does not hash itself.
 *
 * @param {string} root Repository root.
 * @returns {Array<{kind: string, file: string, line: number, evidence: string, hint: string}>} Findings.
 */
export function inspectRepositoryVitestBootstrap(root) {
  const out = [];
  out.push(...physicalPathFindings(root, VITEST_BOOTSTRAP_MANIFEST));
  for (const relativePath of EXPECTED_VITEST_BOOTSTRAP_FILES) {
    out.push(...physicalPathFindings(root, relativePath));
  }

  let manifestBytes;
  try {
    manifestBytes = readFileSync(join(root, VITEST_BOOTSTRAP_MANIFEST));
  } catch (error) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-MANIFEST",
        VITEST_BOOTSTRAP_MANIFEST,
        1,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      )
    );
    return out;
  }
  const manifestSource = manifestBytes.toString("utf8");
  const rawLines = manifestSource.split("\n");
  const lines = manifestSource.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
  if (
    manifestSource.includes("\r") ||
    !manifestSource.endsWith("\n") ||
    lines.length !== EXPECTED_VITEST_BOOTSTRAP_FILES.length
  ) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-MANIFEST",
        VITEST_BOOTSTRAP_MANIFEST,
        1,
        `receipt must be LF-only with one final LF and exactly ${EXPECTED_VITEST_BOOTSTRAP_FILES.length} lines; found ${lines.length}`
      )
    );
  }
  const entries = lines.map((line, index) => {
    const match = MANIFEST_LINE.exec(line);
    if (match === null) {
      out.push(
        finding(
          "VITEST-BOOTSTRAP-MANIFEST",
          VITEST_BOOTSTRAP_MANIFEST,
          index + 1,
          "receipt line must be lowercase SHA-256, two spaces, and one canonical relative path"
        )
      );
      return undefined;
    }
    return { digest: match[1], path: match[2], line: index + 1 };
  });
  const actualPaths = entries.map((entry) => entry?.path ?? "<invalid>");
  if (JSON.stringify(actualPaths) !== JSON.stringify(EXPECTED_VITEST_BOOTSTRAP_FILES)) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-CENSUS",
        VITEST_BOOTSTRAP_MANIFEST,
        1,
        `receipt path census is ${JSON.stringify(actualPaths)}`
      )
    );
  }
  for (const relativePath of EXPECTED_VITEST_BOOTSTRAP_FILES) {
    const matching = entries.filter((entry) => entry?.path === relativePath);
    if (matching.length !== 1) continue;
    const entry = matching[0];
    if (entry === undefined) continue;
    try {
      const actualDigest =
        relativePath === CI_WORKFLOW
          ? ciWorkflowReceiptDigest(readFileSync(join(root, relativePath), "utf8"))
          : sha256(readFileSync(join(root, relativePath)));
      if (actualDigest !== entry.digest) {
        out.push(
          finding(
            "VITEST-BOOTSTRAP-DIGEST",
            relativePath,
            1,
            `${relativePath}: receipt=${entry.digest}, actual=${actualDigest}`
          )
        );
      }
    } catch (error) {
      out.push(
        finding(
          "VITEST-BOOTSTRAP-DIGEST",
          relativePath,
          1,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        )
      );
    }
  }

  let rootEntries = [];
  try {
    rootEntries = readdirSync(root);
  } catch (error) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-PHYSICAL-PATH",
        ".",
        1,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      )
    );
  }
  const configs = rootEntries.filter((name) => /^vitest\.(?:config|projects|workspace)\./u.test(name)).sort();
  if (JSON.stringify(configs) !== JSON.stringify(["vitest.config.ts"])) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-CONFIG-CENSUS",
        ".",
        1,
        `expected only vitest.config.ts; found ${JSON.stringify(configs)}`
      )
    );
  }
  for (const name of FORBIDDEN_VITEST_BOOTSTRAP_ROOT_INPUTS) {
    if (lstatOrUndefined(join(root, name)) !== undefined) {
      out.push(
        finding(
          "VITEST-BOOTSTRAP-ROOT-INPUT",
          name,
          1,
          `${name} is an unreviewed implicit install or Vitest startup input`
        )
      );
    }
  }

  try {
    const ciSource = readFileSync(join(root, CI_WORKFLOW), "utf8");
    out.push(...ciVitestBootstrapProblems(ciSource, sha256(manifestBytes)));
  } catch (error) {
    out.push(
      finding(
        "VITEST-BOOTSTRAP-CI-SHAPE",
        CI_WORKFLOW,
        1,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      )
    );
  }
  try {
    const analyzerSource = readFileSync(join(root, "scripts/lib/oia-vitest-bootstrap.mjs"), "utf8");
    for (const problem of vitestBootstrapAnalyzerSourceProblems(analyzerSource)) {
      out.push(finding("VITEST-BOOTSTRAP-ANALYZER", "scripts/lib/oia-vitest-bootstrap.mjs", 1, problem));
    }
  } catch {
    // Physical and digest findings above already identify this unreadable input.
  }
  try {
    const oiaSource = readFileSync(join(root, "scripts/oia-walk.mjs"), "utf8");
    for (const problem of oiaVitestBootstrapWiringProblems(oiaSource)) {
      out.push(finding("VITEST-BOOTSTRAP-OIA-WIRING", "scripts/oia-walk.mjs", 1, problem));
    }
  } catch {
    // Physical and digest findings above already identify this unreadable input.
  }
  return out;
}

/**
 * Format early bootstrap findings for a single fail-closed thrown error.
 *
 * @param {ReturnType<typeof inspectRepositoryVitestBootstrap>} findings Findings.
 * @returns {string} Multiline diagnostic.
 */
export function formatVitestBootstrapError(findings) {
  const lines = ["[oia-walk] trusted Vitest bootstrap failed before other repository/third-party imports:"];
  for (const item of findings) {
    lines.push(`  • [${item.kind}] ${item.file}:${item.line}`);
    lines.push(`    > ${item.evidence}`);
    lines.push(`    hint: ${item.hint}`);
  }
  lines.push("[oia-walk] bootstrap findings are non-overridable; --allow cannot suppress them.");
  return lines.join("\n");
}
