import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import ts from "typescript";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type MutationMode = "all" | "first";
type MutationRole = "dependency" | "root";

interface SourceOriginFile {
  readonly kind: "file";
  readonly path: string;
}

interface SourceOriginConstant {
  readonly declarationExpression: string;
  readonly kind: "constant";
}

interface SourceOriginDerived {
  readonly definitionExpression: string;
  readonly dependencies: readonly string[];
  readonly kind: "derived";
}

type SourceOrigin = SourceOriginConstant | SourceOriginDerived | SourceOriginFile;

interface SourceIdentity {
  readonly contentSha256: string;
  readonly declarativeBinding: string;
  readonly id: string;
  readonly legacyExpressions: readonly string[];
  readonly order: number;
  readonly origin: SourceOrigin;
  readonly semanticFingerprint: string;
}

interface RawResolved<T> {
  readonly raw: string;
  readonly resolved: T;
}

interface MutationExpressions {
  readonly expectedOccurrences: RawResolved<number>;
  readonly needle: RawResolved<string>;
  readonly replacement: RawResolved<string>;
  readonly source: RawResolved<string>;
}

interface IdentitySpan {
  readonly column: number;
  readonly end: number;
  readonly line: number;
  readonly sha256: string;
  readonly start: number;
}

interface MutationSource {
  readonly id: string;
  readonly kind: "mutation" | "source";
}

interface MutationWitness {
  readonly after: number;
  readonly anchor: string;
  readonly before: number;
  readonly derivation: "line-delta" | "needle" | "replacement" | "token-delta";
  readonly kind: "line" | "token";
  readonly mutantSha256: string;
  readonly sourceSha256: string;
}

interface MutationIdentity {
  readonly expressions: MutationExpressions;
  readonly id: string;
  readonly legacyOccurrence: number;
  readonly legacyOrder: number;
  readonly legacySpan: IdentitySpan;
  readonly mode: MutationMode;
  readonly order: number;
  readonly ownerRoot: string;
  readonly replacementDependency: null | string;
  readonly role: MutationRole;
  readonly semanticFingerprint: string;
  readonly source: MutationSource;
  readonly witness: MutationWitness;
}

interface InvocationIdentity {
  readonly baseline: string;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly kind: string;
  readonly mutant: string;
}

type ExpectationIdentity =
  | { readonly id: string; readonly kind: "equal" | "not-equal"; readonly value: string }
  | { readonly id: string; readonly kind: "problem"; readonly problem: string }
  | { readonly id: string; readonly kind: "regex"; readonly regex: string };

interface MatcherOperand {
  readonly raw: string;
  readonly resolved: JsonValue;
}

interface MatcherEvaluation {
  readonly assertionSpan: IdentitySpan;
  readonly matcher: "toBe" | "toContain" | "toContainEqual" | "toEqual";
  readonly negated: boolean;
  readonly operand: MatcherOperand;
}

interface CheckIdentity {
  readonly assertionSpan: IdentitySpan;
  readonly expectation: ExpectationIdentity;
  readonly invoke: InvocationIdentity;
  readonly matcherEvaluations: readonly MatcherEvaluation[];
}

interface CaseIdentity {
  readonly checks: readonly CheckIdentity[];
  readonly id: string;
  readonly order: number;
  readonly root: string;
  readonly semanticFingerprint: string;
}

interface GeneratedFrom {
  readonly commit: string;
  readonly matrixSliceSha256: string;
  readonly matrixTitle: string;
  readonly path: string;
  readonly rawExpressionShape: RawExpressionShape;
}

interface RawExpressionShape {
  readonly classifier: "outer-expression-v1";
  readonly expectedOccurrences: {
    readonly identifier: number;
    readonly integer: number;
    readonly sum: number;
  };
  readonly needle: {
    readonly concatenation: number;
    readonly identifier: number;
    readonly literal: number;
  };
  readonly replacement: {
    readonly concatenation: number;
    readonly identifier: number;
    readonly literal: number;
    readonly nestedCall: number;
  };
  readonly source: {
    readonly identifier: number;
    readonly nestedCall: number;
  };
}

interface ManifestInventory {
  readonly all: number;
  readonly cases: number;
  readonly compositeChecks: number;
  readonly dependencyOnly: number;
  readonly first: number;
  readonly logicalChecks: number;
  readonly maxDependencyDepth: number;
  readonly mutations: number;
  readonly primaryChecks: number;
  readonly rawMatcherEvaluations: number;
  readonly replacementEdges: number;
  readonly roots: number;
  readonly sourceEdges: number;
  readonly sources: number;
  readonly transactionCases: number;
}

interface IdentityManifest {
  readonly cases: readonly CaseIdentity[];
  readonly generatedFrom: GeneratedFrom;
  readonly inventory: ManifestInventory;
  readonly mutations: readonly MutationIdentity[];
  readonly normalizer: "release-matrix-balanced-v2";
  readonly schemaVersion: 2;
  readonly sources: readonly SourceIdentity[];
}

interface LegacyMutationCall {
  readonly assignedName: null | string;
  readonly expectedOccurrencesExpression: string;
  readonly mode: MutationMode;
  readonly needleExpression: string;
  readonly node: ts.CallExpression;
  readonly replacementExpression: string;
  readonly sourceExpression: string;
  readonly span: IdentitySpan;
}

interface MatrixScan {
  readonly calls: readonly LegacyMutationCall[];
  readonly matrixSlice: string;
  readonly sourceFile: ts.SourceFile;
}

const MATRIX_TITLE = "keeps release.yml wired to the shared evaluator and an exact mirrored inventory";
const SOURCE_COMMIT = "8420e2fca3ed0dac994859a9e9a30b933d5ddf9e";
const MATRIX_SOURCE_SHA256 = "3fa0b67411e2fc0f4d7c6bce6075ba91eb25edc19a210b5c2f8dd408def6e18b";
const MATRIX_SLICE_SHA256 = "caca0093c744df9f6c6cdd0e8200fd8df45052e784297079887ea48686c5e07f";
const MATRIX_START = [
  "    const releaseWorkflow = readFileSync(",
  'new URL("../.github/workflows/release.yml", import.meta.url), "utf8");'
].join("");
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MUTATION_ID_PATTERN = /^release\.m\d{3}$/u;
const CASE_ID_PATTERN = /^release\.case\.m\d{3}$/u;
const REQUIRED_PEER_ALIASES = [
  "mcpbInputs.build",
  "mcpbInputs.cli",
  "mcpbInputs.cliHelp",
  "mcpbInputs.consumer",
  "mcpbInputs.docsApi",
  "mcpbInputs.integrity",
  "mcpbInputs.manifest",
  "mcpbInputs.packageJson",
  "mcpbInputs.packageLock",
  "mcpbInputs.release",
  "mcpbInputs.releaseTransaction",
  "mcpbInputs.server",
  "mcpbInputs.versionCheck",
  "mcpbInputs.versionSync"
] as const;
interface ExpectedSourceIdentity {
  readonly binding: string;
  readonly dependencies?: readonly string[];
  readonly definitionExpression?: string;
  readonly id: string;
  readonly kind: "constant" | "derived" | "file";
  readonly legacyExpressions: readonly string[];
  readonly path?: string;
}

const EXPECTED_SOURCES: readonly ExpectedSourceIdentity[] = [
  {
    id: "document.api",
    legacyExpressions: ["mcpbInputs.docsApi"],
    binding: "docsApiSource",
    kind: "file",
    path: "docs/api.md"
  },
  {
    id: "fixture.release-workflow",
    legacyExpressions: ["workflow", "mcpbInputs.release"],
    binding: "releaseWorkflowFixtureSource",
    kind: "derived",
    definitionExpression: "releaseWorkflowFixture(releaseWorkflow, releaseTransaction)",
    dependencies: ["workflow.release-raw", "script.release-transaction"]
  },
  {
    id: "fragment.github-create-channel",
    legacyExpressions: ["rawCreateChannel"],
    binding: "githubCreateChannelSource",
    kind: "constant"
  },
  {
    id: "fragment.github-release-transaction-tail",
    legacyExpressions: ["releaseTransactionTail"],
    binding: "githubReleaseTransactionTailSource",
    kind: "constant"
  },
  {
    id: "fragment.mcpb-actions-artifact-download",
    legacyExpressions: ["MCPB_ACTIONS_ARTIFACT_DOWNLOAD"],
    binding: "mcpbActionsArtifactDownloadSource",
    kind: "constant"
  },
  {
    id: "fragment.npm-pack-command",
    legacyExpressions: ["MCPB_EXACT_NPM_PACK"],
    binding: "npmPackCommandSource",
    kind: "constant"
  },
  {
    id: "fragment.npm-provenance-audit-command",
    legacyExpressions: ["NPM_PROVENANCE_AUDIT_COMMAND"],
    binding: "npmProvenanceAuditCommandSource",
    kind: "constant"
  },
  {
    id: "fragment.npm-provenance-evaluator-command",
    legacyExpressions: ["NPM_PROVENANCE_EVALUATOR_COMMAND"],
    binding: "npmProvenanceEvaluatorCommandSource",
    kind: "constant"
  },
  {
    id: "fragment.npm-publish-command",
    legacyExpressions: ["MCPB_EXACT_NPM_PUBLISH"],
    binding: "npmPublishCommandSource",
    kind: "constant"
  },
  {
    id: "fragment.release-visibility-duplicate-guard",
    legacyExpressions: ["MCPB_RELEASE_VISIBILITY_DUPLICATE_GUARD"],
    binding: "releaseVisibilityDuplicateGuardSource",
    kind: "constant"
  },
  {
    id: "fragment.release-visibility-poll",
    legacyExpressions: ["MCPB_RELEASE_VISIBILITY_POLL"],
    binding: "releaseVisibilityPollSource",
    kind: "constant"
  },
  {
    id: "fragment.release-visibility-timeout-guard",
    legacyExpressions: ["MCPB_RELEASE_VISIBILITY_TIMEOUT_GUARD"],
    binding: "releaseVisibilityTimeoutGuardSource",
    kind: "constant"
  },
  {
    id: "fragment.release-visibility-wait",
    legacyExpressions: ["MCPB_RELEASE_VISIBILITY_WAIT"],
    binding: "releaseVisibilityWaitSource",
    kind: "constant"
  },
  {
    id: "manifest.mcpb",
    legacyExpressions: ["mcpbInputs.manifest"],
    binding: "mcpbManifestSource",
    kind: "file",
    path: "mcpb/manifest.json"
  },
  {
    id: "manifest.package-json",
    legacyExpressions: ["packageJson", "mcpbInputs.packageJson"],
    binding: "packageManifestSource",
    kind: "file",
    path: "package.json"
  },
  {
    id: "manifest.package-lock",
    legacyExpressions: ["mcpbInputs.packageLock"],
    binding: "packageLockSource",
    kind: "file",
    path: "package-lock.json"
  },
  {
    id: "script.mcpb-build",
    legacyExpressions: ["mcpbInputs.build"],
    binding: "mcpbBuildSource",
    kind: "file",
    path: "scripts/build-mcpb.mjs"
  },
  {
    id: "script.mcpb-consumer",
    legacyExpressions: ["mcpbInputs.consumer"],
    binding: "mcpbConsumerSource",
    kind: "file",
    path: "scripts/mcpb-consumer.mjs"
  },
  {
    id: "script.package-consumer",
    legacyExpressions: ["packageConsumer"],
    binding: "packageConsumerSource",
    kind: "file",
    path: "scripts/package-consumer.mjs"
  },
  {
    id: "script.protocol-conformance",
    legacyExpressions: ["protocolConformance"],
    binding: "protocolConformanceSource",
    kind: "file",
    path: "scripts/protocol-conformance.mjs"
  },
  {
    id: "script.release-integrity",
    legacyExpressions: ["mcpbInputs.integrity"],
    binding: "releaseIntegritySource",
    kind: "file",
    path: "scripts/check-release-integrity.mjs"
  },
  {
    id: "script.release-transaction",
    legacyExpressions: ["releaseTransaction", "mcpbInputs.releaseTransaction"],
    binding: "releaseTransactionSource",
    kind: "file",
    path: ".github/scripts/release-mcpb-github-transaction.sh"
  },
  {
    id: "script.version-consistency",
    legacyExpressions: ["mcpbInputs.versionCheck"],
    binding: "versionConsistencySource",
    kind: "file",
    path: "scripts/check-version-consistency.mjs"
  },
  {
    id: "script.version-sync",
    legacyExpressions: ["mcpbInputs.versionSync"],
    binding: "versionSyncSource",
    kind: "file",
    path: "scripts/sync-version.mjs"
  },
  { id: "source.cli", legacyExpressions: ["mcpbInputs.cli"], binding: "cliSource", kind: "file", path: "src/cli.ts" },
  {
    id: "source.cli-help",
    legacyExpressions: ["mcpbInputs.cliHelp"],
    binding: "cliHelpSource",
    kind: "file",
    path: "src/cli-help.ts"
  },
  {
    id: "source.server-ts",
    legacyExpressions: ["mcpbInputs.server"],
    binding: "serverSource",
    kind: "file",
    path: "src/server.ts"
  },
  {
    id: "workflow.ci",
    legacyExpressions: ["ci"],
    binding: "ciWorkflowSource",
    kind: "file",
    path: ".github/workflows/ci.yml"
  },
  {
    id: "workflow.registry-publish-step",
    legacyExpressions: ["registryRun"],
    binding: "registryPublishStepSource",
    kind: "derived",
    definitionExpression: "runBody(registryStep)",
    dependencies: ["fixture.release-workflow"]
  },
  {
    id: "workflow.release-raw",
    legacyExpressions: ["releaseWorkflow"],
    binding: "releaseWorkflowRawSource",
    kind: "file",
    path: ".github/workflows/release.yml"
  }
];
const EXPECTED_INVENTORY: ManifestInventory = {
  sources: 30,
  mutations: 560,
  first: 538,
  all: 22,
  roots: 536,
  dependencyOnly: 24,
  cases: 536,
  primaryChecks: 536,
  compositeChecks: 5,
  logicalChecks: 541,
  rawMatcherEvaluations: 546,
  sourceEdges: 6,
  replacementEdges: 18,
  maxDependencyDepth: 2,
  transactionCases: 76
};
const EXPECTED_INVOCATION_CENSUS: Readonly<Record<string, number>> = {
  "ci.node-floor": 87,
  "github.release-transaction": 129,
  "mcpb.contract": 110,
  "npm.contract.integrity": 1,
  "npm.contract.release": 1,
  "npm.evaluator": 37,
  "npm.workflow": 36,
  "registry.evaluator": 36,
  "registry.step.integrity": 1,
  "registry.step.run": 72,
  "release.poll": 22,
  "remote-gate.package-consumer": 1,
  "remote-gate.protocol-conformance": 2,
  "workflow.schema": 1
};
interface InvocationArgumentIdentity {
  readonly id?: string;
  readonly kind: "literal" | "mutant" | "source";
  readonly slot: string;
  readonly value?: JsonValue;
}

interface InvocationContract {
  readonly arguments: readonly InvocationArgumentIdentity[];
  readonly callee: string;
  readonly mutantSourceId: string;
}

const INVOCATION_CONTRACTS: Readonly<Record<string, InvocationContract>> = {
  "ci.node-floor": {
    callee: "nodeFloorCiProblems",
    mutantSourceId: "workflow.ci",
    arguments: [
      { kind: "mutant", slot: "ci" },
      { kind: "literal", slot: "nodeEngine", value: ">=22.13.0" }
    ]
  },
  "github.release-transaction": {
    callee: "githubReleaseTransactionProblems",
    mutantSourceId: "fixture.release-workflow",
    arguments: [{ kind: "mutant", slot: "release" }]
  },
  "npm.contract.integrity": {
    callee: "npmProvenanceContractProblems",
    mutantSourceId: "script.release-integrity",
    arguments: [
      { kind: "source", slot: "release", id: "fixture.release-workflow" },
      { kind: "mutant", slot: "integrity" }
    ]
  },
  "npm.contract.release": {
    callee: "npmProvenanceContractProblems",
    mutantSourceId: "fixture.release-workflow",
    arguments: [
      { kind: "mutant", slot: "release" },
      { kind: "source", slot: "integrity", id: "script.release-integrity" }
    ]
  },
  "npm.evaluator": {
    callee: "npmProvenanceEvaluatorProblems",
    mutantSourceId: "script.release-integrity",
    arguments: [{ kind: "mutant", slot: "integrity" }]
  },
  "npm.workflow": {
    callee: "npmProvenanceWorkflowProblems",
    mutantSourceId: "fixture.release-workflow",
    arguments: [{ kind: "mutant", slot: "release" }]
  },
  "registry.evaluator": {
    callee: "mcpRegistryEvaluatorProblems",
    mutantSourceId: "script.release-integrity",
    arguments: [{ kind: "mutant", slot: "integrity" }]
  },
  "registry.step.integrity": {
    callee: "mcpRegistryStepProblems",
    mutantSourceId: "script.release-integrity",
    arguments: [
      { kind: "source", slot: "run", id: "workflow.registry-publish-step" },
      { kind: "mutant", slot: "integrity" }
    ]
  },
  "registry.step.run": {
    callee: "mcpRegistryStepProblems",
    mutantSourceId: "workflow.registry-publish-step",
    arguments: [
      { kind: "mutant", slot: "run" },
      { kind: "source", slot: "integrity", id: "script.release-integrity" }
    ]
  },
  "release.poll": {
    callee: "releasePollProblems",
    mutantSourceId: "fixture.release-workflow",
    arguments: [{ kind: "mutant", slot: "release" }]
  },
  "remote-gate.package-consumer": {
    callee: "remoteGateScriptProblems",
    mutantSourceId: "script.package-consumer",
    arguments: [
      { kind: "mutant", slot: "packageConsumer" },
      { kind: "source", slot: "protocolConformance", id: "script.protocol-conformance" }
    ]
  },
  "remote-gate.protocol-conformance": {
    callee: "remoteGateScriptProblems",
    mutantSourceId: "script.protocol-conformance",
    arguments: [
      { kind: "source", slot: "packageConsumer", id: "script.package-consumer" },
      { kind: "mutant", slot: "protocolConformance" }
    ]
  },
  "workflow.schema": {
    callee: "githubWorkflowSchemaProblems",
    mutantSourceId: "workflow.release-raw",
    arguments: [{ kind: "mutant", slot: "workflow" }]
  }
};
const MCPB_SOURCE_SLOTS: ReadonlyArray<readonly [slot: string, id: string]> = [
  ["manifest", "manifest.mcpb"],
  ["cli", "source.cli"],
  ["cliHelp", "source.cli-help"],
  ["server", "source.server-ts"],
  ["build", "script.mcpb-build"],
  ["consumer", "script.mcpb-consumer"],
  ["docsApi", "document.api"],
  ["integrity", "script.release-integrity"],
  ["packageLock", "manifest.package-lock"],
  ["packageJson", "manifest.package-json"],
  ["release", "fixture.release-workflow"],
  ["releaseTransaction", "script.release-transaction"],
  ["versionCheck", "script.version-consistency"],
  ["versionSync", "script.version-sync"]
];
const MCPB_MUTANT_SLOT_CENSUS: Readonly<Record<string, number>> = {
  build: 4,
  consumer: 6,
  docsApi: 1,
  integrity: 16,
  manifest: 2,
  packageJson: 1,
  release: 76,
  releaseTransaction: 2,
  server: 1,
  versionSync: 1
};
const EXPECTED_SOURCE_DEPENDENCY_EDGES = [
  "release.m108->release.m107",
  "release.m228->release.m229",
  "release.m229->release.m230",
  "release.m291->release.m290",
  "release.m490->release.m491",
  "release.m496->release.m497"
] as const;
const EXPECTED_REPLACEMENT_DEPENDENCY_EDGES = [
  "release.m140->release.m139",
  "release.m145->release.m144",
  "release.m237->release.m236",
  "release.m239->release.m238",
  "release.m242->release.m241",
  "release.m244->release.m243",
  "release.m246->release.m245",
  "release.m248->release.m247",
  "release.m250->release.m249",
  "release.m257->release.m256",
  "release.m263->release.m262",
  "release.m265->release.m264",
  "release.m384->release.m383",
  "release.m428->release.m427",
  "release.m430->release.m429",
  "release.m433->release.m432",
  "release.m435->release.m434",
  "release.m438->release.m437"
] as const;
const EXPECTED_CARDINALITY_CONSTANTS: Readonly<Record<string, number>> = {
  GH_READ_GUARD_COUNT: 6,
  GH_READ_HELPER_COUNT: 7,
  RELEASE_DEADLINE_ENV_BINDING_COUNT: 7,
  RELEASE_FIXTURE_GH_CONFIG_COUNT: 6,
  RELEASE_FIXTURE_PROXY_UNSET_COUNT: 9,
  RELEASE_HARDENED_ENV_COUNT: 8,
  RELEASE_HARDENED_SHELL_COUNT: 8,
  RELEASE_RESERVE_GUARD_COUNT: 4,
  RELEASE_SINGLETON_DECODER_COUNT: 2,
  RELEASE_TLS_PIN_COUNT: 7
};
const EXPECTED_RAW_EXPRESSION_SHAPE: RawExpressionShape = {
  classifier: "outer-expression-v1",
  source: { identifier: 558, nestedCall: 2 },
  needle: { literal: 479, identifier: 62, concatenation: 19 },
  replacement: { literal: 498, concatenation: 41, nestedCall: 18, identifier: 3 },
  expectedOccurrences: { integer: 544, identifier: 15, sum: 1 }
};
const NAMED_REGEX_OPERANDS: Readonly<Record<string, string>> = {
  "workflow.schema.case-insensitive-env":
    "expect.stringMatching(/case-insensitive duplicate NPM_CONFIG_REGISTRY\\/npm_config_registry/)"
};
const TRANSACTION_PROBLEM_RUNS: ReadonlyArray<readonly [problem: string, count: number]> = [
  ["token-bearing shells must clear inherited shell, loader, network, CA, Node, and GitHub config injection", 2],
  ["GitHub Release transaction must execute only one exact hash-pinned in-memory script snapshot", 5],
  ["token-bearing shells must clear inherited shell, loader, network, CA, Node, and GitHub config injection", 10],
  ["GitHub Release transaction must execute only one exact hash-pinned in-memory script snapshot", 2],
  ["GitHub latest-release absence must be one strict HTTP identity, never stderr text", 6],
  ["every release snapshot must bind the exact canonical title and CHANGELOG body", 1],
  ["token-bearing shells must clear inherited shell, loader, network, CA, Node, and GitHub config injection", 1],
  ["draft creation must be one bounded write followed by exact readback without replay", 6],
  ["token-bearing shells must clear inherited shell, loader, network, CA, Node, and GitHub config injection", 1],
  ["draft creation must be one bounded write followed by exact readback without replay", 2],
  ["every release snapshot must bind the exact canonical title and CHANGELOG body", 1],
  ["each missing release asset must use one retry-free POST and exact no-replay reconciliation", 16],
  ["the exact six-asset identity and bytes must remain frozen across publication", 1],
  ["release publication must be one bounded PATCH followed by exact-ID convergence without replay", 15],
  ["GitHub Release recovery must expose no delete, clobber, or transport-replay path", 7]
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function semanticFingerprint(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isJsonValue(entry));
}

function exactRecord(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
  problems: string[]
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`);
    return null;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(`${path} must have exact keys ${expected.join(", ")}; found ${actual.join(", ")}`);
    return null;
  }
  return value;
}

function nonemptyString(record: Record<string, unknown>, key: string, path: string, problems: string[]): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`${path}.${key} must be a non-empty string`);
    return null;
  }
  return value;
}

function integer(
  record: Record<string, unknown>,
  key: string,
  path: string,
  problems: string[],
  minimum = 0
): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    problems.push(`${path}.${key} must be a safe integer >= ${minimum}`);
    return null;
  }
  return value;
}

function stringArray(value: unknown, path: string, problems: string[], allowEmpty = false): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    problems.push(`${path} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings`);
    return null;
  }
  return value as string[];
}

function parseSpan(value: unknown, path: string, problems: string[]): IdentitySpan | null {
  const record = exactRecord(value, path, ["start", "end", "line", "column", "sha256"], problems);
  if (record === null) return null;
  const start = integer(record, "start", path, problems);
  const end = integer(record, "end", path, problems, 1);
  const line = integer(record, "line", path, problems, 1);
  const column = integer(record, "column", path, problems, 1);
  const hash = nonemptyString(record, "sha256", path, problems);
  if (hash !== null && !SHA256_PATTERN.test(hash)) problems.push(`${path}.sha256 must be lowercase SHA-256`);
  return start === null || end === null || line === null || column === null || hash === null
    ? null
    : { start, end, line, column, sha256: hash };
}

function parseOrigin(value: unknown, path: string, problems: string[]): SourceOrigin | null {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`);
    return null;
  }
  if (value.kind === "file") {
    const record = exactRecord(value, path, ["kind", "path"], problems);
    const filePath = record === null ? null : nonemptyString(record, "path", path, problems);
    return filePath === null ? null : { kind: "file", path: filePath };
  }
  if (value.kind === "constant") {
    const record = exactRecord(value, path, ["kind", "declarationExpression"], problems);
    const declarationExpression =
      record === null ? null : nonemptyString(record, "declarationExpression", path, problems);
    return declarationExpression === null ? null : { kind: "constant", declarationExpression };
  }
  if (value.kind === "derived") {
    const record = exactRecord(value, path, ["kind", "definitionExpression", "dependencies"], problems);
    if (record === null) return null;
    const definitionExpression = nonemptyString(record, "definitionExpression", path, problems);
    const dependencies = stringArray(record.dependencies, `${path}.dependencies`, problems, true);
    return definitionExpression === null || dependencies === null
      ? null
      : { kind: "derived", definitionExpression, dependencies };
  }
  problems.push(`${path}.kind must be file, constant, or derived`);
  return null;
}

function parseSource(value: unknown, index: number, problems: string[]): SourceIdentity | null {
  const path = `manifest.sources[${index}]`;
  const record = exactRecord(
    value,
    path,
    [
      "order",
      "id",
      "legacyExpressions",
      "declarativeBinding",
      "origin",
      "contentSha256",
      "semanticFingerprint"
    ],
    problems
  );
  if (record === null) return null;
  const order = integer(record, "order", path, problems, 1);
  const id = nonemptyString(record, "id", path, problems);
  const legacyExpressions = stringArray(record.legacyExpressions, `${path}.legacyExpressions`, problems);
  const declarativeBinding = nonemptyString(record, "declarativeBinding", path, problems);
  const origin = parseOrigin(record.origin, `${path}.origin`, problems);
  const contentSha256 = nonemptyString(record, "contentSha256", path, problems);
  const semanticFingerprint = nonemptyString(record, "semanticFingerprint", path, problems);
  if (contentSha256 !== null && !SHA256_PATTERN.test(contentSha256)) {
    problems.push(`${path}.contentSha256 must be lowercase SHA-256`);
  }
  if (semanticFingerprint !== null && !FINGERPRINT_PATTERN.test(semanticFingerprint)) {
    problems.push(`${path}.semanticFingerprint must be one sha256 identity`);
  }
  return order === null ||
    id === null ||
    legacyExpressions === null ||
    declarativeBinding === null ||
    origin === null ||
    contentSha256 === null ||
    semanticFingerprint === null
    ? null
    : { order, id, legacyExpressions, declarativeBinding, origin, contentSha256, semanticFingerprint };
}

function parseRawResolved<T>(
  value: unknown,
  path: string,
  problems: string[],
  guard: (candidate: unknown) => candidate is T
): RawResolved<T> | null {
  const record = exactRecord(value, path, ["raw", "resolved"], problems);
  if (record === null) return null;
  const raw = nonemptyString(record, "raw", path, problems);
  if (!isJsonValue(record.resolved) || !guard(record.resolved)) {
    problems.push(`${path}.resolved has the wrong JSON type`);
    return null;
  }
  return raw === null ? null : { raw, resolved: record.resolved };
}

function parseMutationSource(value: unknown, path: string, problems: string[]): MutationSource | null {
  const record = exactRecord(value, path, ["kind", "id"], problems);
  if (record === null) return null;
  const kind = nonemptyString(record, "kind", path, problems);
  const id = nonemptyString(record, "id", path, problems);
  if (kind !== "source" && kind !== "mutation") problems.push(`${path}.kind must be source or mutation`);
  return id === null || (kind !== "source" && kind !== "mutation") ? null : { kind, id };
}

function parseWitness(value: unknown, path: string, problems: string[]): MutationWitness | null {
  const record = exactRecord(
    value,
    path,
    ["kind", "anchor", "before", "after", "derivation", "sourceSha256", "mutantSha256"],
    problems
  );
  if (record === null) return null;
  const kind = nonemptyString(record, "kind", path, problems);
  const anchor = nonemptyString(record, "anchor", path, problems);
  const before = integer(record, "before", path, problems);
  const after = integer(record, "after", path, problems);
  const derivation = nonemptyString(record, "derivation", path, problems);
  const sourceSha256 = nonemptyString(record, "sourceSha256", path, problems);
  const mutantSha256 = nonemptyString(record, "mutantSha256", path, problems);
  if (kind !== "token" && kind !== "line") problems.push(`${path}.kind must be token or line`);
  if (
    derivation !== "needle" &&
    derivation !== "replacement" &&
    derivation !== "line-delta" &&
    derivation !== "token-delta"
  ) {
    problems.push(`${path}.derivation is not allowlisted`);
  }
  for (const [label, hash] of [
    ["sourceSha256", sourceSha256],
    ["mutantSha256", mutantSha256]
  ] as const) {
    if (hash !== null && !SHA256_PATTERN.test(hash)) problems.push(`${path}.${label} must be lowercase SHA-256`);
  }
  return anchor === null ||
    before === null ||
    after === null ||
    sourceSha256 === null ||
    mutantSha256 === null ||
    (kind !== "token" && kind !== "line") ||
    (derivation !== "needle" &&
      derivation !== "replacement" &&
      derivation !== "line-delta" &&
      derivation !== "token-delta")
    ? null
    : { kind, anchor, before, after, derivation, sourceSha256, mutantSha256 };
}

function parseMutation(value: unknown, index: number, problems: string[]): MutationIdentity | null {
  const path = `manifest.mutations[${index}]`;
  const record = exactRecord(
    value,
    path,
    [
      "order",
      "legacyOrder",
      "id",
      "mode",
      "role",
      "legacyOccurrence",
      "expressions",
      "source",
      "replacementDependency",
      "ownerRoot",
      "witness",
      "legacySpan",
      "semanticFingerprint"
    ],
    problems
  );
  if (record === null) return null;
  const order = integer(record, "order", path, problems, 1);
  const legacyOrder = integer(record, "legacyOrder", path, problems, 1);
  const id = nonemptyString(record, "id", path, problems);
  const mode = nonemptyString(record, "mode", path, problems);
  const role = nonemptyString(record, "role", path, problems);
  const legacyOccurrence = integer(record, "legacyOccurrence", path, problems, 1);
  const expressionRecord = exactRecord(
    record.expressions,
    `${path}.expressions`,
    ["source", "needle", "replacement", "expectedOccurrences"],
    problems
  );
  const stringGuard = (candidate: unknown): candidate is string => typeof candidate === "string";
  const numberGuard = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
  const sourceExpression =
    expressionRecord === null
      ? null
      : parseRawResolved(expressionRecord.source, `${path}.expressions.source`, problems, stringGuard);
  const needle =
    expressionRecord === null
      ? null
      : parseRawResolved(expressionRecord.needle, `${path}.expressions.needle`, problems, stringGuard);
  const replacement =
    expressionRecord === null
      ? null
      : parseRawResolved(expressionRecord.replacement, `${path}.expressions.replacement`, problems, stringGuard);
  const expectedOccurrences =
    expressionRecord === null
      ? null
      : parseRawResolved(
          expressionRecord.expectedOccurrences,
          `${path}.expressions.expectedOccurrences`,
          problems,
          numberGuard
        );
  const source = parseMutationSource(record.source, `${path}.source`, problems);
  const replacementDependency = record.replacementDependency;
  if (
    replacementDependency !== null &&
    (typeof replacementDependency !== "string" || replacementDependency.length === 0)
  ) {
    problems.push(`${path}.replacementDependency must be null or a non-empty string`);
  }
  const ownerRoot = nonemptyString(record, "ownerRoot", path, problems);
  const witness = parseWitness(record.witness, `${path}.witness`, problems);
  const legacySpan = parseSpan(record.legacySpan, `${path}.legacySpan`, problems);
  const semanticFingerprint = nonemptyString(record, "semanticFingerprint", path, problems);
  if (mode !== "first" && mode !== "all") problems.push(`${path}.mode must be first or all`);
  if (role !== "root" && role !== "dependency") problems.push(`${path}.role must be root or dependency`);
  if (semanticFingerprint !== null && !FINGERPRINT_PATTERN.test(semanticFingerprint)) {
    problems.push(`${path}.semanticFingerprint must be one sha256 identity`);
  }
  return order === null ||
    legacyOrder === null ||
    id === null ||
    (mode !== "first" && mode !== "all") ||
    (role !== "root" && role !== "dependency") ||
    legacyOccurrence === null ||
    sourceExpression === null ||
    needle === null ||
    replacement === null ||
    expectedOccurrences === null ||
    source === null ||
    (replacementDependency !== null && typeof replacementDependency !== "string") ||
    ownerRoot === null ||
    witness === null ||
    legacySpan === null ||
    semanticFingerprint === null
    ? null
    : {
        order,
        legacyOrder,
        id,
        mode,
        role,
        legacyOccurrence,
        expressions: { source: sourceExpression, needle, replacement, expectedOccurrences },
        source,
        replacementDependency,
        ownerRoot,
        witness,
        legacySpan,
        semanticFingerprint
      };
}

function parseExpectation(value: unknown, path: string, problems: string[]): ExpectationIdentity | null {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`);
    return null;
  }
  const kind = value.kind;
  const semanticKey = kind === "problem"
    ? "problem"
    : kind === "regex"
      ? "regex"
      : kind === "equal" || kind === "not-equal"
        ? "value"
        : null;
  if (semanticKey === null) {
    problems.push(`${path}.kind must be problem, regex, equal, or not-equal`);
    return null;
  }
  const record = exactRecord(value, path, ["id", "kind", semanticKey], problems);
  if (record === null) return null;
  const id = nonemptyString(record, "id", path, problems);
  const semanticValue = nonemptyString(record, semanticKey, path, problems);
  if (id === null || semanticValue === null) return null;
  if (kind === "problem") return { id, kind, problem: semanticValue };
  if (kind === "regex") return { id, kind, regex: semanticValue };
  return { id, kind, value: semanticValue };
}

function parseInvocation(value: unknown, path: string, problems: string[]): InvocationIdentity | null {
  const record = exactRecord(value, path, ["kind", "baseline", "mutant", "inputs"], problems);
  if (record === null) return null;
  const kind = nonemptyString(record, "kind", path, problems);
  const baseline = nonemptyString(record, "baseline", path, problems);
  const mutant = nonemptyString(record, "mutant", path, problems);
  let inputs: Readonly<Record<string, JsonValue>> | null = null;
  if (kind === "registry.composite") {
    const inputRecord = exactRecord(record.inputs, `${path}.inputs`, ["profile"], problems);
    if (inputRecord !== null && Array.isArray(inputRecord.profile) && isJsonValue(inputRecord.profile)) {
      inputs = { profile: inputRecord.profile };
    } else if (inputRecord !== null) {
      problems.push(`${path}.inputs.profile must be a JSON array`);
    }
  } else {
    const inputRecord = exactRecord(record.inputs, `${path}.inputs`, ["callee", "arguments"], problems);
    if (
      inputRecord !== null &&
      typeof inputRecord.callee === "string" &&
      inputRecord.callee.length > 0 &&
      Array.isArray(inputRecord.arguments) &&
      isJsonValue(inputRecord.arguments)
    ) {
      inputs = { callee: inputRecord.callee, arguments: inputRecord.arguments };
    } else if (inputRecord !== null) {
      problems.push(`${path}.inputs must contain a non-empty callee and JSON arguments array`);
    }
  }
  return kind === null || baseline === null || mutant === null
    ? null
    : inputs === null
      ? null
      : { kind, baseline, mutant, inputs };
}

function parseMatcher(value: unknown, path: string, problems: string[]): MatcherEvaluation | null {
  const record = exactRecord(value, path, ["matcher", "negated", "operand", "assertionSpan"], problems);
  if (record === null) return null;
  const matcher = nonemptyString(record, "matcher", path, problems);
  if (matcher !== "toBe" && matcher !== "toContain" && matcher !== "toContainEqual" && matcher !== "toEqual") {
    problems.push(`${path}.matcher is not allowlisted`);
  }
  if (typeof record.negated !== "boolean") problems.push(`${path}.negated must be boolean`);
  const operandRecord = exactRecord(record.operand, `${path}.operand`, ["raw", "resolved"], problems);
  const raw = operandRecord === null ? null : nonemptyString(operandRecord, "raw", `${path}.operand`, problems);
  if (operandRecord !== null && !isJsonValue(operandRecord.resolved)) {
    problems.push(`${path}.operand.resolved must be JSON`);
  }
  const assertionSpan = parseSpan(record.assertionSpan, `${path}.assertionSpan`, problems);
  return raw === null ||
    operandRecord === null ||
    !isJsonValue(operandRecord.resolved) ||
    assertionSpan === null ||
    typeof record.negated !== "boolean" ||
    (matcher !== "toBe" && matcher !== "toContain" && matcher !== "toContainEqual" && matcher !== "toEqual")
    ? null
    : {
        matcher,
        negated: record.negated,
        operand: { raw, resolved: operandRecord.resolved },
        assertionSpan
      };
}

function parseCheck(value: unknown, path: string, problems: string[]): CheckIdentity | null {
  const record = exactRecord(value, path, ["invoke", "expectation", "matcherEvaluations", "assertionSpan"], problems);
  if (record === null) return null;
  const invoke = parseInvocation(record.invoke, `${path}.invoke`, problems);
  const expectation = parseExpectation(record.expectation, `${path}.expectation`, problems);
  const assertionSpan = parseSpan(record.assertionSpan, `${path}.assertionSpan`, problems);
  const matcherValues = record.matcherEvaluations;
  if (!Array.isArray(matcherValues) || matcherValues.length === 0) {
    problems.push(`${path}.matcherEvaluations must be a non-empty array`);
    return null;
  }
  const matcherEvaluations = matcherValues
    .map((entry, index) => parseMatcher(entry, `${path}.matcherEvaluations[${index}]`, problems))
    .filter((entry): entry is MatcherEvaluation => entry !== null);
  return invoke === null ||
    expectation === null ||
    assertionSpan === null ||
    matcherEvaluations.length !== matcherValues.length
    ? null
    : { invoke, expectation, matcherEvaluations, assertionSpan };
}

function parseCase(value: unknown, index: number, problems: string[]): CaseIdentity | null {
  const path = `manifest.cases[${index}]`;
  const record = exactRecord(value, path, ["order", "id", "root", "checks", "semanticFingerprint"], problems);
  if (record === null) return null;
  const order = integer(record, "order", path, problems, 1);
  const id = nonemptyString(record, "id", path, problems);
  const root = nonemptyString(record, "root", path, problems);
  const semanticFingerprint = nonemptyString(record, "semanticFingerprint", path, problems);
  if (semanticFingerprint !== null && !FINGERPRINT_PATTERN.test(semanticFingerprint)) {
    problems.push(`${path}.semanticFingerprint must be one sha256 identity`);
  }
  const checkValues = record.checks;
  if (!Array.isArray(checkValues) || checkValues.length === 0) {
    problems.push(`${path}.checks must be a non-empty array`);
    return null;
  }
  const checks = checkValues
    .map((entry, checkIndex) => parseCheck(entry, `${path}.checks[${checkIndex}]`, problems))
    .filter((entry): entry is CheckIdentity => entry !== null);
  return order === null ||
    id === null ||
    root === null ||
    semanticFingerprint === null ||
    checks.length !== checkValues.length
    ? null
    : { order, id, root, checks, semanticFingerprint };
}

function parseGeneratedFrom(value: unknown, problems: string[]): GeneratedFrom | null {
  const path = "manifest.generatedFrom";
  const record = exactRecord(
    value,
    path,
    ["commit", "path", "matrixTitle", "matrixSliceSha256", "rawExpressionShape"],
    problems
  );
  if (record === null) return null;
  const commit = nonemptyString(record, "commit", path, problems);
  const sourcePath = nonemptyString(record, "path", path, problems);
  const matrixTitle = nonemptyString(record, "matrixTitle", path, problems);
  const matrixSliceSha256 = nonemptyString(record, "matrixSliceSha256", path, problems);
  const shapePath = `${path}.rawExpressionShape`;
  const shapeRecord = exactRecord(
    record.rawExpressionShape,
    shapePath,
    ["classifier", "source", "needle", "replacement", "expectedOccurrences"],
    problems
  );
  const sourceShape =
    shapeRecord === null
      ? null
      : exactRecord(shapeRecord.source, `${shapePath}.source`, ["identifier", "nestedCall"], problems);
  const needleShape =
    shapeRecord === null
      ? null
      : exactRecord(shapeRecord.needle, `${shapePath}.needle`, ["literal", "identifier", "concatenation"], problems);
  const replacementShape =
    shapeRecord === null
      ? null
      : exactRecord(
          shapeRecord.replacement,
          `${shapePath}.replacement`,
          ["literal", "concatenation", "nestedCall", "identifier"],
          problems
        );
  const occurrenceShape =
    shapeRecord === null
      ? null
      : exactRecord(
          shapeRecord.expectedOccurrences,
          `${shapePath}.expectedOccurrences`,
          ["integer", "identifier", "sum"],
          problems
        );
  const rawExpressionShape: RawExpressionShape | null =
    shapeRecord?.classifier === "outer-expression-v1" &&
    sourceShape !== null &&
    needleShape !== null &&
    replacementShape !== null &&
    occurrenceShape !== null
      ? {
          classifier: "outer-expression-v1",
          source: {
            identifier: integer(sourceShape, "identifier", `${shapePath}.source`, problems) ?? -1,
            nestedCall: integer(sourceShape, "nestedCall", `${shapePath}.source`, problems) ?? -1
          },
          needle: {
            literal: integer(needleShape, "literal", `${shapePath}.needle`, problems) ?? -1,
            identifier: integer(needleShape, "identifier", `${shapePath}.needle`, problems) ?? -1,
            concatenation: integer(needleShape, "concatenation", `${shapePath}.needle`, problems) ?? -1
          },
          replacement: {
            literal: integer(replacementShape, "literal", `${shapePath}.replacement`, problems) ?? -1,
            concatenation: integer(replacementShape, "concatenation", `${shapePath}.replacement`, problems) ?? -1,
            nestedCall: integer(replacementShape, "nestedCall", `${shapePath}.replacement`, problems) ?? -1,
            identifier: integer(replacementShape, "identifier", `${shapePath}.replacement`, problems) ?? -1
          },
          expectedOccurrences: {
            integer: integer(occurrenceShape, "integer", `${shapePath}.expectedOccurrences`, problems) ?? -1,
            identifier: integer(occurrenceShape, "identifier", `${shapePath}.expectedOccurrences`, problems) ?? -1,
            sum: integer(occurrenceShape, "sum", `${shapePath}.expectedOccurrences`, problems) ?? -1
          }
        }
      : null;
  if (shapeRecord !== null && shapeRecord.classifier !== "outer-expression-v1") {
    problems.push(`${shapePath}.classifier must be outer-expression-v1`);
  }
  if (commit !== null && !/^[0-9a-f]{40}$/u.test(commit)) problems.push(`${path}.commit must be a lowercase Git SHA`);
  if (matrixSliceSha256 !== null && !SHA256_PATTERN.test(matrixSliceSha256)) {
    problems.push(`${path}.matrixSliceSha256 must be lowercase SHA-256`);
  }
  return commit === null ||
    sourcePath === null ||
    matrixTitle === null ||
    matrixSliceSha256 === null ||
    rawExpressionShape === null ||
    Object.values(rawExpressionShape.source).some((entry) => entry < 0) ||
    Object.values(rawExpressionShape.needle).some((entry) => entry < 0) ||
    Object.values(rawExpressionShape.replacement).some((entry) => entry < 0) ||
    Object.values(rawExpressionShape.expectedOccurrences).some((entry) => entry < 0)
    ? null
    : { commit, path: sourcePath, matrixTitle, matrixSliceSha256, rawExpressionShape };
}

function parseInventory(value: unknown, problems: string[]): ManifestInventory | null {
  const path = "manifest.inventory";
  const keys = Object.keys(EXPECTED_INVENTORY) as Array<keyof ManifestInventory>;
  const record = exactRecord(value, path, keys, problems);
  if (record === null) return null;
  const parsed: Partial<Record<keyof ManifestInventory, number>> = {};
  for (const key of keys) {
    const valueAtKey = integer(record, key, path, problems);
    if (valueAtKey !== null) parsed[key] = valueAtKey;
  }
  return keys.every((key) => parsed[key] !== undefined) ? (parsed as ManifestInventory) : null;
}

function parseManifest(source: string, problems: string[]): IdentityManifest | null {
  const jsonAst = ts.parseJsonText("release-mutation-identity.v2.json", source);
  const visitJson = (node: ts.Node, path: string): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key =
          ts.isStringLiteral(property.name) ||
          ts.isNumericLiteral(property.name) ||
          ts.isIdentifier(property.name)
            ? property.name.text
            : property.name.getText(jsonAst);
        if (seen.has(key)) problems.push(`${path} contains duplicate JSON key ${key}`);
        seen.add(key);
        visitJson(property.initializer, `${path}.${key}`);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (let index = 0; index < node.elements.length; index++) {
        const element = node.elements[index];
        if (element !== undefined) visitJson(element, `${path}[${index}]`);
      }
      return;
    }
    ts.forEachChild(node, (child) => visitJson(child, path));
  };
  visitJson(jsonAst, "manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    problems.push(`release mutation identity manifest is not valid JSON: ${String(error)}`);
    return null;
  }
  const record = exactRecord(
    parsed,
    "manifest",
    ["schemaVersion", "normalizer", "generatedFrom", "inventory", "sources", "mutations", "cases"],
    problems
  );
  if (record === null) return null;
  if (record.schemaVersion !== 2) problems.push("manifest.schemaVersion must be exactly 2");
  if (record.normalizer !== "release-matrix-balanced-v2") {
    problems.push("manifest.normalizer must be exactly release-matrix-balanced-v2");
  }
  const generatedFrom = parseGeneratedFrom(record.generatedFrom, problems);
  const inventory = parseInventory(record.inventory, problems);
  if (!Array.isArray(record.sources)) problems.push("manifest.sources must be an array");
  if (!Array.isArray(record.mutations)) problems.push("manifest.mutations must be an array");
  if (!Array.isArray(record.cases)) problems.push("manifest.cases must be an array");
  if (!Array.isArray(record.sources) || !Array.isArray(record.mutations) || !Array.isArray(record.cases)) return null;
  const sources = record.sources
    .map((entry, index) => parseSource(entry, index, problems))
    .filter((entry): entry is SourceIdentity => entry !== null);
  const mutations = record.mutations
    .map((entry, index) => parseMutation(entry, index, problems))
    .filter((entry): entry is MutationIdentity => entry !== null);
  const cases = record.cases
    .map((entry, index) => parseCase(entry, index, problems))
    .filter((entry): entry is CaseIdentity => entry !== null);
  return record.schemaVersion !== 2 ||
    record.normalizer !== "release-matrix-balanced-v2" ||
    generatedFrom === null ||
    inventory === null ||
    sources.length !== record.sources.length ||
    mutations.length !== record.mutations.length ||
    cases.length !== record.cases.length
    ? null
    : {
        schemaVersion: 2,
        normalizer: "release-matrix-balanced-v2",
        generatedFrom,
        inventory,
        sources,
        mutations,
        cases
      };
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function staticString(expression: ts.Expression | undefined): string | null {
  return expression !== undefined &&
    (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : null;
}

function sourceParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  const internalView = sourceFile as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  };
  return internalView.parseDiagnostics ?? [];
}

function directConstHandle(call: ts.CallExpression): string | null {
  const declaration = ts.isVariableDeclaration(call.parent) && call.parent.initializer === call ? call.parent : null;
  const list = declaration !== null && ts.isVariableDeclarationList(declaration.parent) ? declaration.parent : null;
  const statement = list !== null && ts.isVariableStatement(list.parent) ? list.parent : null;
  return declaration !== null &&
    ts.isIdentifier(declaration.name) &&
    list !== null &&
    (list.flags & ts.NodeFlags.Const) !== 0 &&
    statement !== null
    ? declaration.name.text
    : null;
}

function identitySpan(sourceFile: ts.SourceFile, node: ts.Node): IdentitySpan {
  const start = node.getStart(sourceFile);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    start,
    end: node.end,
    line: position.line + 1,
    column: position.character + 1,
    sha256: sha256(sourceFile.text.slice(start, node.end))
  };
}

function executionMultiplyingAncestor(node: ts.Node, matrixCallback: ts.ArrowFunction): ts.Node | null {
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor !== undefined && ancestor !== matrixCallback) {
    if (
      ts.isForStatement(ancestor) ||
      ts.isForInStatement(ancestor) ||
      ts.isForOfStatement(ancestor) ||
      ts.isWhileStatement(ancestor) ||
      ts.isDoStatement(ancestor) ||
      ts.isFunctionLike(ancestor)
    ) {
      return ancestor;
    }
    ancestor = ancestor.parent;
  }
  return null;
}

function scanMatrix(source: string, problems: string[]): MatrixScan | null {
  const sourceFile = ts.createSourceFile(
    "release-integrity.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const diagnostics = sourceParseDiagnostics(sourceFile);
  if (diagnostics.length !== 0) {
    problems.push(`release mutation matrix must be parse-clean; found ${diagnostics.length} diagnostic(s)`);
    return null;
  }
  let callback: ts.ArrowFunction | null = null;
  let matrixEnd = -1;
  const locate = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "it" &&
      staticString(node.arguments[0]) === MATRIX_TITLE
    ) {
      const candidate = node.arguments[1];
      if (candidate !== undefined && ts.isArrowFunction(candidate) && ts.isBlock(candidate.body)) {
        if (callback === null) {
          callback = candidate;
          matrixEnd = ts.isExpressionStatement(node.parent) ? node.parent.end : node.end;
        }
        else problems.push("release mutation identity audit found duplicate matrix callbacks");
      }
    }
    ts.forEachChild(node, locate);
  };
  locate(sourceFile);
  if (callback === null) {
    problems.push("release mutation identity audit could not locate the exact matrix callback");
    return null;
  }
  const matrixStartOccurrences = source.split(MATRIX_START).length - 1;
  if (matrixStartOccurrences !== 1) {
    problems.push(`release mutation identity audit expected one exact matrix start; found ${matrixStartOccurrences}`);
    return null;
  }
  const matrixStart = source.indexOf(MATRIX_START);
  const callbackBody = (callback as ts.ArrowFunction).body;
  if (
    !ts.isBlock(callbackBody) ||
    matrixStart <= callbackBody.getStart(sourceFile) ||
    matrixStart >= callbackBody.end
  ) {
    problems.push("release mutation identity matrix start must be inside its exact callback");
    return null;
  }
  const calls: LegacyMutationCall[] = [];
  let executionMultiplyingSites = 0;
  const visit = (node: ts.Node): void => {
    const start = node.getStart(sourceFile);
    if (start < matrixStart || start >= callbackBody.end) {
      ts.forEachChild(node, visit);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "replaceExactly" || node.expression.text === "replaceAllExactly")
    ) {
      if (node.arguments.length !== 3 && node.arguments.length !== 4) {
        problems.push(`release mutation helper at ${start} must have exactly three or four arguments`);
      } else {
        const sourceExpression = node.arguments[0];
        const needleExpression = node.arguments[1];
        const replacementExpression = node.arguments[2];
        if (sourceExpression !== undefined && needleExpression !== undefined && replacementExpression !== undefined) {
          const multiplyingAncestor = executionMultiplyingAncestor(node, callback as ts.ArrowFunction);
          if (multiplyingAncestor !== null) executionMultiplyingSites++;
          calls.push({
            node,
            mode: node.expression.text === "replaceAllExactly" ? "all" : "first",
            sourceExpression: sourceExpression.getText(sourceFile),
            needleExpression: needleExpression.getText(sourceFile),
            replacementExpression: replacementExpression.getText(sourceFile),
            expectedOccurrencesExpression: node.arguments[3]?.getText(sourceFile) ?? "1",
            assignedName: directConstHandle(node),
            span: identitySpan(sourceFile, node)
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callbackBody);
  calls.sort((left, right) => left.span.start - right.span.start);
  if (executionMultiplyingSites !== 0) {
    problems.push(
      `matrix AST execution-multiplying mutation helper sites must be zero; found ${executionMultiplyingSites}`
    );
  }
  return {
    sourceFile,
    calls,
    matrixSlice: source.slice(matrixStart, matrixEnd)
  };
}

function validateProvenance(manifest: IdentityManifest, matrix: MatrixScan, problems: string[]): void {
  if (manifest.generatedFrom.commit !== SOURCE_COMMIT) {
    problems.push(`manifest.generatedFrom.commit must pin exact source ${SOURCE_COMMIT}`);
  }
  if (manifest.generatedFrom.path !== "tests/release-integrity.test.ts") {
    problems.push("manifest.generatedFrom.path must name tests/release-integrity.test.ts");
  }
  if (manifest.generatedFrom.matrixTitle !== MATRIX_TITLE) {
    problems.push("manifest.generatedFrom.matrixTitle must equal the exact matrix title");
  }
  if (
    JSON.stringify(manifest.generatedFrom.rawExpressionShape) !== JSON.stringify(EXPECTED_RAW_EXPRESSION_SHAPE)
  ) {
    problems.push("manifest.generatedFrom.rawExpressionShape must equal the exact reviewed outer-expression census");
  }
  const observedMatrixSliceSha256 = sha256(matrix.matrixSlice);
  if (observedMatrixSliceSha256 !== MATRIX_SLICE_SHA256) {
    problems.push(`reviewed matrix slice must remain exact SHA-256 ${MATRIX_SLICE_SHA256}`);
  }
  if (manifest.generatedFrom.matrixSliceSha256 !== MATRIX_SLICE_SHA256) {
    problems.push(`manifest provenance must pin reviewed matrix SHA-256 ${MATRIX_SLICE_SHA256}`);
  }
  if (observedMatrixSliceSha256 !== manifest.generatedFrom.matrixSliceSha256) {
    problems.push(
      "manifest.generatedFrom.matrixSliceSha256 must be " +
        `${observedMatrixSliceSha256}; found ${manifest.generatedFrom.matrixSliceSha256}`
    );
  }
}

function validateRawExpressionShape(matrix: MatrixScan, problems: string[]): void {
  const observed = {
    classifier: "outer-expression-v1" as const,
    source: { identifier: 0, nestedCall: 0 },
    needle: { literal: 0, identifier: 0, concatenation: 0 },
    replacement: { literal: 0, concatenation: 0, nestedCall: 0, identifier: 0 },
    expectedOccurrences: { integer: 0, identifier: 0, sum: 0 }
  };
  for (const call of matrix.calls) {
    const source = call.node.arguments[0];
    if (source !== undefined && ts.isIdentifier(source)) observed.source.identifier++;
    else if (source !== undefined && ts.isCallExpression(source)) observed.source.nestedCall++;
    else problems.push(`legacy source expression at ${call.span.start} is outside outer-expression-v1`);

    const needle = call.node.arguments[1];
    if (needle !== undefined && (ts.isStringLiteral(needle) || ts.isNoSubstitutionTemplateLiteral(needle))) {
      observed.needle.literal++;
    } else if (needle !== undefined && ts.isIdentifier(needle)) {
      observed.needle.identifier++;
    } else {
      observed.needle.concatenation++;
    }

    const replacement = call.node.arguments[2];
    if (
      replacement !== undefined &&
      (ts.isStringLiteral(replacement) || ts.isNoSubstitutionTemplateLiteral(replacement))
    ) {
      observed.replacement.literal++;
    } else if (replacement !== undefined && ts.isIdentifier(replacement)) {
      observed.replacement.identifier++;
    } else if (replacement !== undefined && ts.isCallExpression(replacement)) {
      observed.replacement.nestedCall++;
    } else {
      observed.replacement.concatenation++;
    }

    const occurrences = call.node.arguments[3];
    if (occurrences === undefined || ts.isNumericLiteral(occurrences)) observed.expectedOccurrences.integer++;
    else if (ts.isIdentifier(occurrences)) observed.expectedOccurrences.identifier++;
    else if (
      ts.isBinaryExpression(occurrences) &&
      occurrences.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      observed.expectedOccurrences.sum++;
    } else {
      problems.push(`legacy expectedOccurrences at ${call.span.start} is outside outer-expression-v1`);
    }
  }
  if (JSON.stringify(observed) !== JSON.stringify(EXPECTED_RAW_EXPRESSION_SHAPE)) {
    problems.push(`matrix outer-expression census disagrees with reviewed shape: ${JSON.stringify(observed)}`);
  }
}

function validateSources(manifest: IdentityManifest, matrix: MatrixScan, problems: string[]): boolean {
  const initialProblemCount = problems.length;
  if (manifest.sources.length !== EXPECTED_INVENTORY.sources) {
    problems.push(
      `manifest sources must contain exactly ${EXPECTED_INVENTORY.sources} entries; found ${manifest.sources.length}`
    );
  }
  const ids = manifest.sources.map((source) => source.id);
  const aliases = manifest.sources.flatMap((source) => source.legacyExpressions);
  const bindings = manifest.sources.map((source) => source.declarativeBinding);
  for (const [label, values] of [
    ["IDs", ids],
    ["legacy expressions", aliases],
    ["declarative bindings", bindings],
    ["semantic fingerprints", manifest.sources.map((source) => source.semanticFingerprint)]
  ] as const) {
    const duplicates = duplicateValues(values);
    if (duplicates.length !== 0) {
      problems.push(`manifest source ${label} must be unique; duplicates: ${duplicates.join(", ")}`);
    }
  }
  const declarations = constDeclarations(matrix.sourceFile);
  for (let index = 0; index < manifest.sources.length; index++) {
    const source = manifest.sources[index];
    const expected = EXPECTED_SOURCES[index];
    if (source !== undefined && source.order !== index + 1) {
      problems.push(`manifest source order must be contiguous; index ${index} declares ${source.order}`);
    }
    if (source !== undefined && expected !== undefined) {
      let expectedOrigin: SourceOrigin | null = null;
      if (expected.kind === "file" && expected.path !== undefined) {
        expectedOrigin = { kind: "file", path: expected.path };
      } else if (
        expected.kind === "derived" &&
        expected.definitionExpression !== undefined &&
        expected.dependencies !== undefined
      ) {
        expectedOrigin = {
          kind: "derived",
          definitionExpression: expected.definitionExpression,
          dependencies: expected.dependencies
        };
      } else if (expected.kind === "constant") {
        const declarationName = expected.legacyExpressions[0];
        const initializer = declarationName === undefined ? undefined : declarations.get(declarationName);
        if (initializer === undefined) {
          problems.push(`reviewed constant source ${expected.id} has no exact AST declaration`);
        } else {
          expectedOrigin = { kind: "constant", declarationExpression: initializer.getText(matrix.sourceFile) };
        }
      }
      const observedIdentity = {
        order: source.order,
        id: source.id,
        legacyExpressions: source.legacyExpressions,
        declarativeBinding: source.declarativeBinding,
        origin: source.origin
      };
      const expectedIdentity = {
        order: index + 1,
        id: expected.id,
        legacyExpressions: expected.legacyExpressions,
        declarativeBinding: expected.binding,
        origin: expectedOrigin
      };
      if (JSON.stringify(observedIdentity) !== JSON.stringify(expectedIdentity)) {
        problems.push(`manifest source row ${index + 1} disagrees with the exact reviewed catalogue identity`);
      }
    }
    if (source !== undefined) {
      const expectedFingerprint = semanticFingerprint({
        normalizer: "release-matrix-balanced-v2",
        source: {
          order: source.order,
          id: source.id,
          legacyExpressions: source.legacyExpressions,
          declarativeBinding: source.declarativeBinding,
          origin: source.origin,
          contentSha256: source.contentSha256
        }
      });
      if (source.semanticFingerprint !== expectedFingerprint) {
        problems.push(`manifest source ${source.id} semanticFingerprint must be ${expectedFingerprint}`);
      }
    }
  }
  for (const peer of REQUIRED_PEER_ALIASES) {
    if (!aliases.includes(peer)) problems.push(`manifest source inventory omits exact mcpb peer ${peer}`);
  }
  const aliasesById = new Map(manifest.sources.map((source) => [source.id, source.legacyExpressions]));
  const exactCriticalAliases: Readonly<Record<string, readonly string[]>> = {
    "fixture.release-workflow": ["workflow", "mcpbInputs.release"],
    "manifest.package-json": ["packageJson", "mcpbInputs.packageJson"],
    "script.release-transaction": ["releaseTransaction", "mcpbInputs.releaseTransaction"],
    "workflow.release-raw": ["releaseWorkflow"]
  };
  for (const [id, expectedAliases] of Object.entries(exactCriticalAliases)) {
    if (JSON.stringify(aliasesById.get(id)) !== JSON.stringify(expectedAliases)) {
      problems.push(`manifest source ${id} must preserve exact byte-identity aliases ${expectedAliases.join(", ")}`);
    }
  }

  const mcpbInputProperties = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "mcpbInputs" &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
          if (key !== null) mcpbInputProperties.add(`mcpbInputs.${key}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(matrix.sourceFile);
  if (mcpbInputProperties.size !== REQUIRED_PEER_ALIASES.length) {
    problems.push(
      "release matrix mcpbInputs peer inventory must contain " +
        `${REQUIRED_PEER_ALIASES.length} properties; found ${mcpbInputProperties.size}`
    );
  }
  for (const peer of mcpbInputProperties) {
    if (!aliases.includes(peer)) problems.push(`manifest sources do not represent baseline peer ${peer}`);
  }

  const sourceIds = new Set(ids);
  for (const source of manifest.sources) {
    if (source.origin.kind !== "derived") continue;
    const duplicates = duplicateValues(source.origin.dependencies);
    if (duplicates.length !== 0) {
      problems.push(`manifest source ${source.id} has duplicate derived dependencies: ${duplicates.join(", ")}`);
    }
    for (const dependency of source.origin.dependencies) {
      if (!sourceIds.has(dependency)) {
        problems.push(`manifest source ${source.id} has unknown dependency ${dependency}`);
      }
      if (dependency === source.id) problems.push(`manifest source ${source.id} cannot depend on itself`);
    }
  }
  return problems.length === initialProblemCount;
}

function numericConstDeclarations(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const declarations = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function resolveStaticInteger(
  expression: ts.Expression | undefined,
  declarations: ReadonlyMap<string, ts.Expression>,
  active = new Set<string>()
): number | null {
  if (expression === undefined) return null;
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return resolveStaticInteger(expression.expression, declarations, active);
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = resolveStaticInteger(expression.operand, declarations, active);
    if (operand === null) return null;
    if (expression.operator === ts.SyntaxKind.PlusToken) return operand;
    if (expression.operator === ts.SyntaxKind.MinusToken) return -operand;
    return null;
  }
  if (ts.isIdentifier(expression)) {
    if (active.has(expression.text)) return null;
    const initializer = declarations.get(expression.text);
    if (initializer === undefined) return null;
    const nextActive = new Set(active);
    nextActive.add(expression.text);
    return resolveStaticInteger(initializer, declarations, nextActive);
  }
  if (ts.isBinaryExpression(expression)) {
    const left = resolveStaticInteger(expression.left, declarations, active);
    const right = resolveStaticInteger(expression.right, declarations, active);
    if (left === null || right === null) return null;
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    if (expression.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
    if (expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
  }
  return null;
}

function validateCardinalityConstants(matrix: MatrixScan, problems: string[]): void {
  const declarations = numericConstDeclarations(matrix.sourceFile);
  for (const [name, expected] of Object.entries(EXPECTED_CARDINALITY_CONSTANTS)) {
    const resolved = resolveStaticInteger(declarations.get(name), declarations);
    if (resolved !== expected) {
      problems.push(
        `release mutation cardinality constant ${name} must independently resolve to ${expected}; found ${resolved}`
      );
    }
  }
  const summedCalls = matrix.calls.filter((call) => call.expectedOccurrencesExpression.includes("+"));
  if (
    summedCalls.length !== 1 ||
    summedCalls[0]?.expectedOccurrencesExpression !== "GH_READ_GUARD_COUNT + RELEASE_RESERVE_GUARD_COUNT"
  ) {
    problems.push("release mutation matrix must retain one exact guard-plus-reserve cardinality expression");
  }
}

function constDeclarations(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const declarations = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function resolveStaticString(
  expression: ts.Expression | undefined,
  declarations: ReadonlyMap<string, ts.Expression>,
  active = new Set<string>()
): string | null {
  if (expression === undefined) return null;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return resolveStaticString(expression.expression, declarations, active);
  if (ts.isNumericLiteral(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    if (expression.text === "releaseTransactionSha256") {
      const transaction = readFileSync(
        new URL("../.github/scripts/release-mcpb-github-transaction.sh", import.meta.url),
        "utf8"
      );
      return sha256(transaction.slice(0, -1));
    }
    if (active.has(expression.text)) return null;
    const initializer = declarations.get(expression.text);
    if (initializer === undefined) return null;
    const nextActive = new Set(active);
    nextActive.add(expression.text);
    return resolveStaticString(initializer, declarations, nextActive);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticString(expression.left, declarations, active);
    const right = resolveStaticString(expression.right, declarations, active);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const resolved = resolveStaticString(span.expression, declarations, active);
      if (resolved === null) return null;
      value += resolved + span.literal.text;
    }
    return value;
  }
  if (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(expression.expression.expression)
  ) {
    const separator = resolveStaticString(expression.arguments[0], declarations, active);
    if (separator === null) return null;
    const values: string[] = [];
    for (const element of expression.expression.expression.elements) {
      if (ts.isSpreadElement(element)) return null;
      const resolved = resolveStaticString(element, declarations, active);
      if (resolved === null) return null;
      values.push(resolved);
    }
    return values.join(separator);
  }
  if (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "repeat"
  ) {
    const value = resolveStaticString(expression.expression.expression, declarations, active);
    const count = resolveStaticInteger(expression.arguments[0], declarations);
    return value === null || count === null || count < 0 ? null : value.repeat(count);
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "rawClockGuard" &&
    expression.arguments.length === 1
  ) {
    const guard = resolveStaticString(expression.arguments[0], declarations, active);
    return guard === null ? null : `          ${guard.split("\n").join("\n          ")}`;
  }
  return null;
}

function yamlRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function releaseWorkflowFixtureIdentity(workflow: string, transaction: string): string | null {
  if (!transaction.endsWith("\n") || transaction.endsWith("\n\n") || transaction.includes("${{")) return null;
  if (!transaction.includes("$MCPB_RELEASE_REPOSITORY") || !transaction.includes("$MCPB_RELEASE_CHANNEL")) return null;
  const normalized = transaction
    .slice(0, -1)
    .split("$MCPB_RELEASE_REPOSITORY")
    .join("${{ github.repository }}")
    .split("$MCPB_RELEASE_CHANNEL")
    .join("${{ steps.dist_tag.outputs.tag }}");
  const fixture = normalized
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");
  return `${workflow.trimEnd()}\nx-enquire-release-transaction-script-under-test: |\n${fixture}\n`;
}

function registryRunIdentity(workflow: string): string | null {
  let loaded: unknown;
  try {
    loaded = load(workflow);
  } catch {
    return null;
  }
  const document = yamlRecord(loaded);
  const jobs = yamlRecord(document?.jobs);
  const publish = yamlRecord(jobs?.publish);
  const steps = publish?.steps;
  if (!Array.isArray(steps)) return null;
  for (const stepValue of steps) {
    const step = yamlRecord(stepValue);
    if (step?.name === "Publish to MCP Registry (stable only)" && typeof step.run === "string") return step.run;
  }
  return null;
}

function materializeSourceValues(
  manifest: IdentityManifest,
  matrix: MatrixScan,
  problems: string[]
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const declarations = constDeclarations(matrix.sourceFile);
  const sourceById = new Map(manifest.sources.map((source) => [source.id, source]));
  const expectedById = new Map(EXPECTED_SOURCES.map((source) => [source.id, source]));
  const resolve = (id: string, active = new Set<string>()): string | null => {
    const known = values.get(id);
    if (known !== undefined) return known;
    if (active.has(id)) return null;
    const source = sourceById.get(id);
    const expected = expectedById.get(id);
    if (source === undefined || expected === undefined) return null;
    const nextActive = new Set(active);
    nextActive.add(id);
    let value: string | null = null;
    if (expected.kind === "file" && expected.path !== undefined) {
      try {
        value = readFileSync(new URL(`../${expected.path}`, import.meta.url), "utf8");
      } catch (error: unknown) {
        problems.push(`reviewed source ${id} could not be read from its pinned path: ${String(error)}`);
        return null;
      }
    } else if (expected.kind === "constant") {
      const declarationName = expected.legacyExpressions[0];
      value = declarationName === undefined
        ? null
        : resolveStaticString(declarations.get(declarationName), declarations);
    } else if (expected.kind === "derived" && expected.dependencies !== undefined) {
      const dependencies = expected.dependencies.map((dependency) => resolve(dependency, nextActive));
      if (dependencies.some((dependency) => dependency === null)) return null;
      const resolvedDependencies = dependencies as string[];
      if (id === "fixture.release-workflow" && resolvedDependencies.length === 2) {
        value = releaseWorkflowFixtureIdentity(resolvedDependencies[0] ?? "", resolvedDependencies[1] ?? "");
      } else if (id === "workflow.registry-publish-step" && resolvedDependencies.length === 1) {
        value = registryRunIdentity(resolvedDependencies[0] ?? "");
      } else {
        problems.push(
          `reviewed source ${id} uses an unsupported pinned derived definition ${expected.definitionExpression}`
        );
        return null;
      }
    } else {
      problems.push(`reviewed source ${id} has an incomplete pinned origin`);
      return null;
    }
    if (value === null) {
      problems.push(`manifest source ${id} cannot be independently materialized from its declared origin`);
      return null;
    }
    values.set(id, value);
    const observedContentSha256 = sha256(value);
    if (source.contentSha256 !== observedContentSha256) {
      problems.push(
        `manifest source ${id} contentSha256 must identify exact materialized bytes ${observedContentSha256}`
      );
    }
    return value;
  };
  for (const source of EXPECTED_SOURCES) resolve(source.id);
  const rawWorkflow = values.get("workflow.release-raw");
  const transaction = values.get("script.release-transaction");
  const combinedWorkflow = values.get("fixture.release-workflow");
  const proofCounts = (source: string, repository: string): readonly number[] =>
    [
      `"repos/${repository}/git/ref/tags/$TAG"`,
      `"repos/${repository}/git/tags/$TAG_OBJECT_SHA"`,
      ".sha == $tag_object_sha and .tag == $tag",
      '.type == "commit" and .sha == $sha',
      '.type == "tag" and .sha == $sha'
    ].map((needle) => mutationMatchCount(source, needle));
  if (
    rawWorkflow !== undefined &&
    JSON.stringify(proofCounts(rawWorkflow, "${{ github.repository }}")) !== JSON.stringify([8, 4, 4, 4, 4])
  ) {
    problems.push("raw release workflow tag-proof identity must remain exactly 8/4/4/4/4");
  }
  if (
    transaction !== undefined &&
    JSON.stringify(proofCounts(transaction, "$MCPB_RELEASE_REPOSITORY")) !== JSON.stringify([2, 1, 1, 1, 1])
  ) {
    problems.push("release transaction tag-proof identity must remain exactly 2/1/1/1/1");
  }
  if (
    combinedWorkflow !== undefined &&
    JSON.stringify(proofCounts(combinedWorkflow, "${{ github.repository }}")) !== JSON.stringify([10, 5, 5, 5, 5])
  ) {
    problems.push("combined release fixture tag-proof identity must remain exactly 10/5/5/5/5");
  }
  return values;
}

function mutationMatchCount(source: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = source.indexOf(needle, offset);
    if (found === -1) return count;
    count++;
    offset = found + needle.length;
  }
}

function replacementValue(source: string, needle: string, replacement: string, offset: number): string {
  let value = "";
  for (let index = 0; index < replacement.length; index++) {
    const character = replacement[index];
    const next = replacement[index + 1];
    if (character !== "$" || next === undefined) {
      value += character;
      continue;
    }
    if (next === "$") value += "$";
    else if (next === "&") value += needle;
    else if (next === "`") value += source.slice(0, offset);
    else if (next === "'") value += source.slice(offset + needle.length);
    else {
      value += "$";
      continue;
    }
    index++;
  }
  return value;
}

function applyMutation(source: string, needle: string, replacement: string, mode: MutationMode): string {
  let output = "";
  let cursor = 0;
  let replacements = 0;
  while (true) {
    const found = source.indexOf(needle, cursor);
    if (found === -1 || (mode === "first" && replacements > 0)) return output + source.slice(cursor);
    output += source.slice(cursor, found) + replacementValue(source, needle, replacement, found);
    cursor = found + needle.length;
    replacements++;
  }
}

function isWitnessTokenCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function tokenWitnessCount(value: string, anchor: string): number {
  if (anchor.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  const startsToken = isWitnessTokenCharacter(anchor[0]);
  const endsToken = isWitnessTokenCharacter(anchor.at(-1));
  while (true) {
    const offset = value.indexOf(anchor, cursor);
    if (offset === -1) return count;
    const before = offset > 0 ? value[offset - 1] : undefined;
    const after = offset + anchor.length < value.length ? value[offset + anchor.length] : undefined;
    if (
      (!startsToken || !isWitnessTokenCharacter(before)) &&
      (!endsToken || !isWitnessTokenCharacter(after))
    ) {
      count++;
    }
    cursor = offset + anchor.length;
  }
}

function witnessCount(value: string, witness: MutationWitness): number {
  if (witness.kind === "token") return tokenWitnessCount(value, witness.anchor);
  return value.split("\n").filter((line) => line === witness.anchor).length;
}

function validateWitnessCounterSemantics(problems: string[]): void {
  if (
    tokenWitnessCount("limit=20 limit=200 xlimit=20 limit=20x", "limit=20") !== 1 ||
    tokenWitnessCount("alpha alpha2 _alpha alpha_", "alpha") !== 1
  ) {
    problems.push("release mutation token witness counter must preserve exact Unicode token boundaries");
  }
  const lineWitness: MutationWitness = {
    kind: "line",
    anchor: "exact",
    before: 2,
    after: 0,
    derivation: "line-delta",
    sourceSha256: "0".repeat(64),
    mutantSha256: "0".repeat(64)
  };
  if (witnessCount("exact\ninexact\nexact", lineWitness) !== 2) {
    problems.push("release mutation line witness counter must preserve exact whole-line identity");
  }
}

function validateMaterializedMutations(
  manifest: IdentityManifest,
  matrix: MatrixScan,
  problems: string[]
): void {
  const sourceValues = materializeSourceValues(manifest, matrix, problems);
  const mutationValues = new Map<string, string>();
  for (const mutation of manifest.mutations) {
    const sourceValue =
      mutation.source.kind === "source"
        ? sourceValues.get(mutation.source.id)
        : mutationValues.get(mutation.source.id);
    const replacement = mutation.replacementDependency === null
      ? mutation.expressions.replacement.resolved
      : mutationValues.get(mutation.replacementDependency);
    if (sourceValue === undefined || replacement === undefined) {
      problems.push(`manifest mutation ${mutation.id} cannot materialize dependency bytes in order`);
      continue;
    }
    const needle = mutation.expressions.needle.resolved;
    const observedOccurrences = mutationMatchCount(sourceValue, needle);
    if (observedOccurrences !== mutation.expressions.expectedOccurrences.resolved) {
      problems.push(
        `manifest mutation ${mutation.id} exact source has ${observedOccurrences} needle occurrence(s), ` +
          `expected ${mutation.expressions.expectedOccurrences.resolved}`
      );
      continue;
    }
    const mutant = applyMutation(sourceValue, needle, replacement, mutation.mode);
    mutationValues.set(mutation.id, mutant);
    if (sha256(sourceValue) !== mutation.witness.sourceSha256) {
      problems.push(`manifest mutation ${mutation.id} witness sourceSha256 disagrees with exact before bytes`);
    }
    if (sha256(mutant) !== mutation.witness.mutantSha256) {
      problems.push(`manifest mutation ${mutation.id} witness mutantSha256 disagrees with exact after bytes`);
    }
    const before = witnessCount(sourceValue, mutation.witness);
    const after = witnessCount(mutant, mutation.witness);
    if (before !== mutation.witness.before || after !== mutation.witness.after) {
      problems.push(
        `manifest mutation ${mutation.id} witness count must be exact ${before}->${after}; ` +
          `found ${mutation.witness.before}->${mutation.witness.after}`
      );
    }
    if (mutation.witness.derivation === "needle" && mutation.witness.anchor !== needle) {
      problems.push(`manifest mutation ${mutation.id} needle-derived witness must use the exact resolved needle`);
    }
    if (mutation.witness.derivation === "replacement" && mutation.witness.anchor !== replacement) {
      problems.push(`manifest mutation ${mutation.id} replacement-derived witness must use the exact replacement`);
    }
  }
}

function validateMutationGraph(
  manifest: IdentityManifest,
  matrix: MatrixScan,
  sourceCatalogueValid: boolean,
  problems: string[]
): void {
  validateCardinalityConstants(matrix, problems);
  const numericDeclarations = numericConstDeclarations(matrix.sourceFile);
  const stringDeclarations = constDeclarations(matrix.sourceFile);
  if (manifest.mutations.length !== EXPECTED_INVENTORY.mutations) {
    problems.push(`manifest mutations must contain exactly 560 entries; found ${manifest.mutations.length}`);
  }
  if (matrix.calls.length !== EXPECTED_INVENTORY.mutations) {
    problems.push(`matrix AST must contain exactly 560 mutation calls; found ${matrix.calls.length}`);
  }
  const astFirst = matrix.calls.filter((call) => call.mode === "first").length;
  const astAll = matrix.calls.filter((call) => call.mode === "all").length;
  if (astFirst !== 538 || astAll !== 22) {
    problems.push(`matrix AST mutation modes must be exact 538 first / 22 all; found ${astFirst} / ${astAll}`);
  }
  const sourceByAlias = new Map<string, string>();
  for (const source of manifest.sources) {
    for (const alias of source.legacyExpressions) sourceByAlias.set(alias, source.id);
  }
  const sourceIds = new Set(manifest.sources.map((source) => source.id));
  const mutationById = new Map(manifest.mutations.map((mutation) => [mutation.id, mutation]));
  const duplicateMutationIds = duplicateValues(manifest.mutations.map((mutation) => mutation.id));
  if (duplicateMutationIds.length !== 0) {
    problems.push(`manifest mutation IDs must be unique; duplicates: ${duplicateMutationIds.join(", ")}`);
  }
  const duplicateMutationFingerprints = duplicateValues(
    manifest.mutations.map((mutation) => mutation.semanticFingerprint)
  );
  if (duplicateMutationFingerprints.length !== 0) {
    problems.push(
      `manifest mutation semantic identities must be unique; duplicates: ${duplicateMutationFingerprints.join(", ")}`
    );
  }
  const parentByDependency = new Map<string, { readonly argument: 0 | 2; readonly parent: string }>();
  const legacyOccurrenceByKey = new Map<string, number>();
  let first = 0;
  let all = 0;
  let roots = 0;
  let dependencies = 0;
  let sourceEdges = 0;
  let replacementEdges = 0;

  const nestedParentByCall = new Map<
    LegacyMutationCall,
    { readonly argument: 0 | 2; readonly parent: LegacyMutationCall }
  >();
  for (const child of matrix.calls) {
    let ancestor: ts.Node | undefined = child.node.parent;
    while (ancestor !== undefined) {
      const parent = matrix.calls.find((candidate) => candidate.node === ancestor);
      if (parent !== undefined) {
        const argumentIndex = parent.node.arguments.findIndex(
          (argument) =>
            child.node.getStart(matrix.sourceFile) >= argument.getStart(matrix.sourceFile) &&
            child.node.end <= argument.end
        );
        if (argumentIndex === 0 || argumentIndex === 2) {
          nestedParentByCall.set(child, { parent, argument: argumentIndex });
        }
        else problems.push(`nested legacy mutation at ${child.span.start} must occupy source or replacement argument`);
        break;
      }
      ancestor = ancestor.parent;
    }
  }
  const assignedCalls = new Map<string, LegacyMutationCall>();
  for (const call of matrix.calls) {
    if (call.assignedName !== null) assignedCalls.set(call.assignedName, call);
  }
  for (const parent of matrix.calls) {
    const sourceArgument = parent.node.arguments[0];
    if (sourceArgument === undefined || !ts.isIdentifier(sourceArgument)) continue;
    const child = assignedCalls.get(sourceArgument.text);
    if (child !== undefined && !nestedParentByCall.has(child)) nestedParentByCall.set(child, { parent, argument: 0 });
  }
  const mutationIdByCall = new Map<LegacyMutationCall, string>();
  for (let index = 0; index < manifest.mutations.length; index++) {
    const mutation = manifest.mutations[index];
    const call = matrix.calls[mutation?.legacyOrder === undefined ? -1 : mutation.legacyOrder - 1];
    if (mutation === undefined) continue;
    if (mutation.order !== index + 1) {
      problems.push(`manifest mutation order must be contiguous; index ${index} declares ${mutation.order}`);
    }
    const expectedId = `release.m${String(mutation.legacyOrder).padStart(3, "0")}`;
    if (!MUTATION_ID_PATTERN.test(mutation.id) || mutation.id !== expectedId) {
      problems.push(`manifest mutation ${mutation.id} must equal legacy identity ${expectedId}`);
    }
    if (call === undefined) {
      problems.push(`manifest mutation ${mutation.id} has no AST call at legacy order ${mutation.legacyOrder}`);
      continue;
    }
    mutationIdByCall.set(call, mutation.id);
    const expectedExpressions = {
      source: call.sourceExpression,
      needle: call.needleExpression,
      replacement: call.replacementExpression,
      expectedOccurrences: call.expectedOccurrencesExpression
    };
    for (const key of ["source", "needle", "replacement", "expectedOccurrences"] as const) {
      if (mutation.expressions[key].raw !== expectedExpressions[key]) {
        problems.push(`manifest mutation ${mutation.id} ${key} raw expression disagrees with exact AST identity`);
      }
    }
    if (mutation.mode !== call.mode) problems.push(`manifest mutation ${mutation.id} mode disagrees with AST helper`);
    if (JSON.stringify(mutation.legacySpan) !== JSON.stringify(call.span)) {
      problems.push(`manifest mutation ${mutation.id} legacySpan disagrees with exact AST span`);
    }
    const occurrenceKey = JSON.stringify([
      call.mode,
      call.sourceExpression,
      call.needleExpression,
      call.replacementExpression,
      call.expectedOccurrencesExpression
    ]);
    const occurrence = (legacyOccurrenceByKey.get(occurrenceKey) ?? 0) + 1;
    legacyOccurrenceByKey.set(occurrenceKey, occurrence);
    if (mutation.legacyOccurrence !== occurrence) {
      problems.push(`manifest mutation ${mutation.id} legacyOccurrence must be ${occurrence}`);
    }
    if (mutation.mode === "first") first++;
    else all++;
    if (mutation.role === "root") roots++;
    else dependencies++;
    if (mutation.source.kind === "source") {
      if (!sourceIds.has(mutation.source.id)) {
        problems.push(`manifest mutation ${mutation.id} has unknown source ${mutation.source.id}`);
      }
    } else {
      sourceEdges++;
      const dependency = mutationById.get(mutation.source.id);
      if (dependency === undefined) {
        problems.push(`manifest mutation ${mutation.id} has unknown source mutation ${mutation.source.id}`);
      }
      else if (dependency.order >= mutation.order) {
        problems.push(`manifest source dependency ${dependency.id} -> ${mutation.id} is not topologically ordered`);
      }
      if (parentByDependency.has(mutation.source.id)) {
        problems.push(`manifest dependency ${mutation.source.id} has more than one parent`);
      }
      parentByDependency.set(mutation.source.id, { parent: mutation.id, argument: 0 });
    }
    if (mutation.replacementDependency !== null) {
      replacementEdges++;
      const dependency = mutationById.get(mutation.replacementDependency);
      if (dependency === undefined) {
        problems.push(
          `manifest mutation ${mutation.id} has unknown replacement dependency ${mutation.replacementDependency}`
        );
      } else if (dependency.order >= mutation.order) {
        problems.push(
          `manifest replacement dependency ${dependency.id} -> ${mutation.id} is not topologically ordered`
        );
      }
      if (parentByDependency.has(mutation.replacementDependency)) {
        problems.push(`manifest dependency ${mutation.replacementDependency} has more than one parent`);
      }
      parentByDependency.set(mutation.replacementDependency, { parent: mutation.id, argument: 2 });
    }
    if (mutation.expressions.source.resolved !== mutation.source.id) {
      problems.push(`manifest mutation ${mutation.id} resolved source must equal ${mutation.source.id}`);
    }
    if (
      mutation.replacementDependency !== null &&
      mutation.expressions.replacement.resolved !== mutation.replacementDependency
    ) {
      problems.push(
        `manifest mutation ${mutation.id} resolved replacement must equal dependency ` +
          `${mutation.replacementDependency}`
      );
    }
    const sourceAlias = sourceByAlias.get(call.sourceExpression);
    if (mutation.source.kind === "source" && sourceAlias !== mutation.source.id) {
      problems.push(`manifest mutation ${mutation.id} source identity does not match exact legacy alias`);
    }
    if (mutation.expressions.expectedOccurrences.resolved <= 0) {
      problems.push(`manifest mutation ${mutation.id} expectedOccurrences must be positive`);
    }
    const observedNeedle = resolveStaticString(call.node.arguments[1], stringDeclarations);
    if (observedNeedle === null || observedNeedle !== mutation.expressions.needle.resolved) {
      problems.push(`manifest mutation ${mutation.id} resolved needle disagrees with independent AST evaluation`);
    }
    if (mutation.replacementDependency === null) {
      const observedReplacement = resolveStaticString(call.node.arguments[2], stringDeclarations);
      if (
        observedReplacement === null ||
        observedReplacement !== mutation.expressions.replacement.resolved
      ) {
        problems.push(
          `manifest mutation ${mutation.id} resolved replacement disagrees with independent AST evaluation`
        );
      }
    }
    const observedExpectedOccurrences = resolveStaticInteger(call.node.arguments[3], numericDeclarations) ?? 1;
    if (mutation.expressions.expectedOccurrences.resolved !== observedExpectedOccurrences) {
      problems.push(
        `manifest mutation ${mutation.id} resolved expectedOccurrences must be ${observedExpectedOccurrences}; ` +
          `found ${mutation.expressions.expectedOccurrences.resolved}`
      );
    }
    if (mutation.witness.before === mutation.witness.after) {
      problems.push(`manifest mutation ${mutation.id} witness must prove an exact positive delta`);
    }
    if (mutation.witness.sourceSha256 === mutation.witness.mutantSha256) {
      problems.push(`manifest mutation ${mutation.id} source and mutant digests must differ`);
    }
  }

  for (const [childCall, edge] of nestedParentByCall) {
    const childId = mutationIdByCall.get(childCall);
    const parentId = mutationIdByCall.get(edge.parent);
    if (childId === undefined || parentId === undefined) continue;
    const parent = mutationById.get(parentId);
    if (parent === undefined) continue;
    const expected = edge.argument === 0
      ? parent.source.kind === "mutation"
        ? parent.source.id
        : null
      : parent.replacementDependency;
    if (expected !== childId) {
      problems.push(`manifest dependency edge ${childId} -> ${parentId} argument ${edge.argument} disagrees with AST`);
    }
  }
  if (nestedParentByCall.size !== EXPECTED_INVENTORY.dependencyOnly) {
    problems.push(`matrix AST dependency topology must contain 24 edges; found ${nestedParentByCall.size}`);
  }

  const observedSourceEdges = manifest.mutations
    .filter((mutation) => mutation.source.kind === "mutation")
    .map((mutation) => `${mutation.source.id}->${mutation.id}`)
    .sort();
  const observedReplacementEdges = manifest.mutations
    .filter((mutation) => mutation.replacementDependency !== null)
    .map((mutation) => `${mutation.replacementDependency}->${mutation.id}`)
    .sort();
  if (JSON.stringify(observedSourceEdges) !== JSON.stringify([...EXPECTED_SOURCE_DEPENDENCY_EDGES].sort())) {
    problems.push("manifest source-dependency identities disagree with the exact six reviewed edges");
  }
  if (
    JSON.stringify(observedReplacementEdges) !==
    JSON.stringify([...EXPECTED_REPLACEMENT_DEPENDENCY_EDGES].sort())
  ) {
    problems.push("manifest replacement-dependency identities disagree with the exact 18 reviewed edges");
  }

  let maximumDepth = 0;
  for (const mutation of manifest.mutations) {
    const parent = parentByDependency.get(mutation.id);
    const shouldBeRoot = parent === undefined;
    if ((mutation.role === "root") !== shouldBeRoot) {
      problems.push(`manifest mutation ${mutation.id} role disagrees with dependency topology`);
    }
    let current = mutation.id;
    let depth = 0;
    const visited = new Set<string>();
    while (parentByDependency.has(current)) {
      if (visited.has(current)) {
        problems.push(`manifest dependency cycle includes ${mutation.id}`);
        break;
      }
      visited.add(current);
      current = parentByDependency.get(current)?.parent ?? current;
      depth++;
    }
    maximumDepth = Math.max(maximumDepth, depth);
    if (mutation.ownerRoot !== current) {
      problems.push(`manifest mutation ${mutation.id} ownerRoot must be ${current}; found ${mutation.ownerRoot}`);
    }
  }
  if (first !== 538 || all !== 22) {
    problems.push(`manifest mutation modes must be 538 first / 22 all; found ${first} / ${all}`);
  }
  if (roots !== 536 || dependencies !== 24) {
    problems.push(`manifest mutation roles must be 536 root / 24 dependency; found ${roots} / ${dependencies}`);
  }
  if (sourceEdges !== 6 || replacementEdges !== 18) {
    problems.push(
      `manifest dependency edges must be 6 source / 18 replacement; found ${sourceEdges} / ${replacementEdges}`
    );
  }
  if (maximumDepth !== 2) problems.push(`manifest maximum dependency depth must be 2; found ${maximumDepth}`);
  if (sourceCatalogueValid) validateMaterializedMutations(manifest, matrix, problems);
}

function validateSpanAgainstSource(span: IdentitySpan, matrixSource: string, path: string, problems: string[]): void {
  if (span.start >= span.end || span.end > matrixSource.length) {
    problems.push(`${path} is outside release-integrity.test.ts`);
    return;
  }
  const slice = matrixSource.slice(span.start, span.end);
  if (sha256(slice) !== span.sha256) problems.push(`${path}.sha256 does not identify its exact source slice`);
  const prefix = matrixSource.slice(0, span.start);
  const lines = prefix.split("\n");
  const line = lines.length;
  const column = (lines[lines.length - 1]?.length ?? 0) + 1;
  if (span.line !== line || span.column !== column) {
    problems.push(`${path} line/column disagrees with exact source position`);
  }
}

function callExpressionsBySpan(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.CallExpression> {
  const calls = new Map<string, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.set(`${node.getStart(sourceFile)}:${node.end}`, node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function resolveStaticJson(
  expression: ts.Expression | undefined,
  declarations: ReadonlyMap<string, ts.Expression>,
  active = new Set<string>()
): JsonValue | null | undefined {
  if (expression === undefined) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return resolveStaticJson(expression.expression, declarations, active);
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    const value = resolveStaticJson(expression.operand, declarations, active);
    if (typeof value !== "number") return undefined;
    if (expression.operator === ts.SyntaxKind.PlusToken) return value;
    if (expression.operator === ts.SyntaxKind.MinusToken) return -value;
    return undefined;
  }
  if (ts.isIdentifier(expression)) {
    if (active.has(expression.text)) return undefined;
    const initializer = declarations.get(expression.text);
    if (initializer === undefined) return undefined;
    const nextActive = new Set(active);
    nextActive.add(expression.text);
    return resolveStaticJson(initializer, declarations, nextActive);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: JsonValue[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) return undefined;
      const value = resolveStaticJson(element, declarations, active);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const value: Record<string, JsonValue> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
      const key =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
          ? property.name.text
          : null;
      if (key === null || Object.hasOwn(value, key)) return undefined;
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      const resolved = resolveStaticJson(initializer, declarations, active);
      if (resolved === undefined) return undefined;
      value[key] = resolved;
    }
    return value;
  }
  return undefined;
}

function validateMatcherAst(
  matcher: MatcherEvaluation,
  sourceFile: ts.SourceFile,
  callsBySpan: ReadonlyMap<string, ts.CallExpression>,
  declarations: ReadonlyMap<string, ts.Expression>,
  expectedCallee: string,
  path: string,
  problems: string[]
): void {
  const call = callsBySpan.get(`${matcher.assertionSpan.start}:${matcher.assertionSpan.end}`) ?? null;
  if (call === null || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) {
    problems.push(`${path} must span one direct expect matcher call`);
    return;
  }
  const access = call.expression;
  let expectExpression: ts.Expression = access.expression;
  let negated = false;
  if (ts.isPropertyAccessExpression(expectExpression) && expectExpression.name.text === "not") {
    negated = true;
    expectExpression = expectExpression.expression;
  }
  if (
    access.name.text !== matcher.matcher ||
    negated !== matcher.negated ||
    !ts.isCallExpression(expectExpression) ||
    !ts.isIdentifier(expectExpression.expression) ||
    expectExpression.expression.text !== "expect"
  ) {
    problems.push(`${path} matcher callee, negation, or expect binding disagrees with its AST span`);
  }
  const detector = ts.isCallExpression(expectExpression) ? expectExpression.arguments[0] : undefined;
  if (
    detector === undefined ||
    !ts.isCallExpression(detector) ||
    !ts.isIdentifier(detector.expression) ||
    detector.expression.text !== expectedCallee
  ) {
    problems.push(`${path} must observe exact detector callee ${expectedCallee}`);
  }
  const operand = call.arguments[0];
  if (operand === undefined || operand.getText(sourceFile) !== matcher.operand.raw) {
    problems.push(`${path} operand.raw disagrees with its exact AST argument`);
    return;
  }
  const resolved = resolveStaticJson(operand, declarations);
  if (resolved !== undefined && JSON.stringify(resolved) !== JSON.stringify(matcher.operand.resolved)) {
    problems.push(`${path} operand.resolved disagrees with independent static evaluation`);
  }
  if (typeof matcher.operand.resolved === "string") {
    const namedRegexOperand = NAMED_REGEX_OPERANDS[matcher.operand.resolved];
    if (namedRegexOperand !== undefined && operand.getText(sourceFile) !== namedRegexOperand) {
      problems.push(`${path} named-regex operand must be exact ${namedRegexOperand}`);
    }
  }
}

function expectationSemantic(expectation: ExpectationIdentity): string {
  if (expectation.kind === "problem") return expectation.problem;
  if (expectation.kind === "regex") return expectation.regex;
  return expectation.value;
}

function invocationArgument(
  value: unknown,
  path: string,
  problems: string[]
): InvocationArgumentIdentity | null {
  if (!isRecord(value)) {
    problems.push(`${path} must be an invocation argument object`);
    return null;
  }
  if (value.kind === "mutant") {
    const record = exactRecord(value, path, ["kind", "slot"], problems);
    const slot = record === null ? null : nonemptyString(record, "slot", path, problems);
    return slot === null ? null : { kind: "mutant", slot };
  }
  if (value.kind === "source") {
    const record = exactRecord(value, path, ["kind", "slot", "id"], problems);
    if (record === null) return null;
    const slot = nonemptyString(record, "slot", path, problems);
    const id = nonemptyString(record, "id", path, problems);
    return slot === null || id === null ? null : { kind: "source", slot, id };
  }
  if (value.kind === "literal") {
    const record = exactRecord(value, path, ["kind", "slot", "value"], problems);
    if (record === null) return null;
    const slot = nonemptyString(record, "slot", path, problems);
    if (!isJsonValue(record.value)) {
      problems.push(`${path}.value must be exact JSON`);
      return null;
    }
    return slot === null ? null : { kind: "literal", slot, value: record.value };
  }
  problems.push(`${path}.kind must be mutant, source, or literal`);
  return null;
}

function validatePrimaryInvocation(
  check: CheckIdentity,
  path: string,
  mcpbMutantSlots: Map<string, number>,
  problems: string[]
): void {
  if (check.invoke.kind === "mcpb.contract") {
    const inputs = exactRecord(check.invoke.inputs, `${path}.inputs`, ["callee", "arguments"], problems);
    if (inputs === null) return;
    if (inputs.callee !== "mcpbContractProblems") {
      problems.push(`${path}.inputs.callee must be mcpbContractProblems`);
    }
    if (!Array.isArray(inputs.arguments) || inputs.arguments.length !== 1) {
      problems.push(`${path}.inputs.arguments must contain one exact source-map argument`);
      return;
    }
    const sourceMap = exactRecord(
      inputs.arguments[0],
      `${path}.inputs.arguments[0]`,
      ["kind", "slot", "mutantSlot", "companions"],
      problems
    );
    if (sourceMap === null) return;
    const mutantSlot = nonemptyString(sourceMap, "mutantSlot", `${path}.inputs.arguments[0]`, problems);
    if (sourceMap.kind !== "source-map" || sourceMap.slot !== "inputs") {
      problems.push(`${path}.inputs source-map must have exact kind source-map and slot inputs`);
    }
    if (mutantSlot === null || MCPB_MUTANT_SLOT_CENSUS[mutantSlot] === undefined) {
      problems.push(`${path}.inputs source-map has a non-mutable MCPB slot`);
      return;
    }
    const mutantSourceId = MCPB_SOURCE_SLOTS.find(([slot]) => slot === mutantSlot)?.[1];
    if (check.invoke.baseline !== mutantSourceId) {
      problems.push(`${path}.baseline must equal MCPB mutant-slot source ${mutantSourceId ?? "missing"}`);
    }
    mcpbMutantSlots.set(mutantSlot, (mcpbMutantSlots.get(mutantSlot) ?? 0) + 1);
    if (!Array.isArray(sourceMap.companions)) {
      problems.push(`${path}.inputs source-map companions must be an ordered array`);
      return;
    }
    const observedCompanions = sourceMap.companions
      .map((entry, index) => invocationArgument(entry, `${path}.inputs.companions[${index}]`, problems))
      .filter((entry): entry is InvocationArgumentIdentity => entry !== null);
    const expectedCompanions = MCPB_SOURCE_SLOTS.filter(([slot]) => slot !== mutantSlot).map(([slot, id]) => ({
      kind: "source" as const,
      slot,
      id
    }));
    if (JSON.stringify(observedCompanions) !== JSON.stringify(expectedCompanions)) {
      problems.push(`${path}.inputs source-map companions must preserve the exact other 13 MCPB sources in order`);
    }
    return;
  }
  const contract = INVOCATION_CONTRACTS[check.invoke.kind];
  if (contract === undefined) {
    problems.push(`${path}.kind ${check.invoke.kind} is not a closed primary invocation`);
    return;
  }
  if (check.invoke.baseline !== contract.mutantSourceId) {
    problems.push(
      `${path}.baseline must equal ${check.invoke.kind} mutant source ${contract.mutantSourceId}`
    );
  }
  const inputs = exactRecord(check.invoke.inputs, `${path}.inputs`, ["callee", "arguments"], problems);
  if (inputs === null) return;
  if (inputs.callee !== contract.callee) problems.push(`${path}.inputs.callee must be ${contract.callee}`);
  if (!Array.isArray(inputs.arguments)) {
    problems.push(`${path}.inputs.arguments must be an ordered array`);
    return;
  }
  const observedArguments = inputs.arguments
    .map((entry, index) => invocationArgument(entry, `${path}.inputs.arguments[${index}]`, problems))
    .filter((entry): entry is InvocationArgumentIdentity => entry !== null);
  if (JSON.stringify(observedArguments) !== JSON.stringify(contract.arguments)) {
    problems.push(`${path}.inputs.arguments disagree with the exact ${check.invoke.kind} detector signature`);
  }
}

function validateCompositeInvocation(check: CheckIdentity, root: string, path: string, problems: string[]): void {
  if (check.invoke.kind !== "registry.composite") {
    problems.push(`${path}.kind must be registry.composite`);
    return;
  }
  const inputs = exactRecord(check.invoke.inputs, `${path}.inputs`, ["profile"], problems);
  if (inputs === null || !Array.isArray(inputs.profile)) {
    problems.push(`${path}.inputs.profile must be an ordered array`);
    return;
  }
  const expectedCallees: Readonly<Record<string, readonly string[]>> = {
    "release.m038": ["hasForbiddenRegistryWriteArguments", "canonicalLogicalShellIdentifierInventory"],
    "release.m039": ["canonicalLogicalShellIdentifierInventory"],
    "release.m040": ["canonicalLogicalShellIdentifierInventory", "rawLogicalNodeTokenInventory"],
    "release.m041": [
      "hasForbiddenRegistryWriteArguments",
      "canonicalLogicalShellIdentifierInventory",
      "hasExactEmptyEnvironmentReference"
    ],
    "release.m042": ["rawLogicalNodeTokenInventory", "hasExactEmptyEnvironmentReference"]
  };
  const runArgument: InvocationArgumentIdentity = { kind: "mutant", slot: "run" };
  const curlArgument: InvocationArgumentIdentity = { kind: "literal", slot: "identifier", value: "CURL_BIN" };
  const nodeArgument: InvocationArgumentIdentity = { kind: "literal", slot: "identifier", value: "NODE_BIN" };
  const environmentArgument: InvocationArgumentIdentity = {
    kind: "literal",
    slot: "environment",
    value: { BASH_ENV: "", GH_HOST: "github.com" }
  };
  const expectedArguments: Readonly<Record<string, readonly (readonly InvocationArgumentIdentity[])[]>> = {
    "release.m038": [[runArgument], [runArgument, curlArgument]],
    "release.m039": [[runArgument, nodeArgument]],
    "release.m040": [[runArgument, nodeArgument], [runArgument]],
    "release.m041": [[runArgument], [runArgument, curlArgument], [runArgument, environmentArgument]],
    "release.m042": [[runArgument], [runArgument, environmentArgument]]
  };
  const expected = expectedCallees[root];
  if (expected === undefined || inputs.profile.length !== expected.length) {
    problems.push(`${path}.inputs.profile has the wrong reviewed composite arity`);
    return;
  }
  for (let index = 0; index < inputs.profile.length; index++) {
    const entryPath = `${path}.inputs.profile[${index}]`;
    const entry = exactRecord(
      inputs.profile[index],
      entryPath,
      ["callee", "arguments", "matcher", "negated", "operand"],
      problems
    );
    const matcher = check.matcherEvaluations[index];
    if (entry === null || matcher === undefined) continue;
    if (entry.callee !== expected[index]) problems.push(`${entryPath}.callee must be ${expected[index]}`);
    if (!Array.isArray(entry.arguments)) {
      problems.push(`${entryPath}.arguments must be an ordered array`);
    } else {
      const observedArguments = entry.arguments
        .map((argument, argumentIndex) =>
          invocationArgument(argument, `${entryPath}.arguments[${argumentIndex}]`, problems)
        )
        .filter((argument): argument is InvocationArgumentIdentity => argument !== null);
      if (JSON.stringify(observedArguments) !== JSON.stringify(expectedArguments[root]?.[index])) {
        problems.push(`${entryPath}.arguments disagree with the exact reviewed composite detector signature`);
      }
    }
    if (
      entry.matcher !== matcher.matcher ||
      entry.negated !== matcher.negated ||
      JSON.stringify(entry.operand) !== JSON.stringify(matcher.operand)
    ) {
      problems.push(`${entryPath} must preserve its exact matcher, polarity, and operand identity`);
    }
  }
}

interface VariableBindingFlow {
  readonly name: string;
  readonly references: ReadonlySet<string>;
}

function variableBindingFlows(sourceFile: ts.SourceFile): readonly VariableBindingFlow[] {
  const flows: VariableBindingFlow[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const references = new Set<string>();
      const collect = (candidate: ts.Node): void => {
        if (ts.isIdentifier(candidate)) references.add(candidate.text);
        ts.forEachChild(candidate, collect);
      };
      collect(node.initializer);
      flows.push({ name: node.name.text, references });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return flows;
}

function rootBindingNames(
  call: ts.CallExpression,
  flows: readonly VariableBindingFlow[]
): ReadonlySet<string> {
  const names = new Set<string>();
  let ancestor: ts.Node | undefined = call.parent;
  while (ancestor !== undefined) {
    if (ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name)) names.add(ancestor.name.text);
    ancestor = ancestor.parent;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const flow of flows) {
      let referencesKnownName = false;
      for (const reference of flow.references) {
        if (names.has(reference)) {
          referencesKnownName = true;
          break;
        }
      }
      if (!names.has(flow.name) && referencesKnownName) {
        names.add(flow.name);
        changed = true;
      }
    }
  }
  return names;
}

function nodeContainsName(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(candidate) && names.has(candidate.text)) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function rootIsBoundToAssertion(
  rootCall: ts.CallExpression,
  assertion: ts.CallExpression,
  sourceFile: ts.SourceFile,
  flows: readonly VariableBindingFlow[]
): boolean {
  if (
    rootCall.getStart(sourceFile) >= assertion.getStart(sourceFile) &&
    rootCall.end <= assertion.end
  ) {
    return true;
  }
  let rootAncestor: ts.Node | undefined = rootCall.parent;
  while (rootAncestor !== undefined && !ts.isFunctionLike(rootAncestor)) {
    if (
      (ts.isForStatement(rootAncestor) ||
        ts.isForOfStatement(rootAncestor) ||
        ts.isForInStatement(rootAncestor)) &&
      assertion.getStart(sourceFile) >= rootAncestor.getStart(sourceFile) &&
      assertion.end <= rootAncestor.end
    ) {
      return true;
    }
    rootAncestor = rootAncestor.parent;
  }
  const names = rootBindingNames(rootCall, flows);
  if (names.size === 0) return false;
  if (nodeContainsName(assertion, names)) return true;
  let ancestor: ts.Node | undefined = assertion.parent;
  while (ancestor !== undefined && !ts.isFunctionLike(ancestor)) {
    if (
      (ts.isForStatement(ancestor) || ts.isForOfStatement(ancestor) || ts.isForInStatement(ancestor)) &&
      nodeContainsName(ancestor, names)
    ) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function literalExpectedProblemForRoot(rootCall: ts.CallExpression): string | null {
  let ancestor: ts.Node | undefined = rootCall.parent;
  while (ancestor !== undefined) {
    if (ts.isObjectLiteralExpression(ancestor)) {
      const properties = new Map<string, ts.Expression>();
      for (const property of ancestor.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
        if (name !== null) properties.set(name, property.initializer);
      }
      const mutant = properties.get("mutant");
      const expectedProblem = properties.get("expectedProblem");
      if (
        mutant !== undefined &&
        rootCall.getStart() >= mutant.getStart() &&
        rootCall.end <= mutant.end &&
        expectedProblem !== undefined &&
        ts.isStringLiteral(expectedProblem)
      ) {
        return expectedProblem.text;
      }
    }
    ancestor = ancestor.parent;
  }
  return null;
}

function validateCases(
  manifest: IdentityManifest,
  matrixSource: string,
  matrix: MatrixScan,
  problems: string[]
): void {
  const matrixSourceFile = matrix.sourceFile;
  if (manifest.cases.length !== 536) {
    problems.push(`manifest cases must contain exactly 536 entries; found ${manifest.cases.length}`);
  }
  const roots = new Set(
    manifest.mutations.filter((mutation) => mutation.role === "root").map((mutation) => mutation.id)
  );
  const sourceIds = new Set(manifest.sources.map((source) => source.id));
  const caseIds = manifest.cases.map((identityCase) => identityCase.id);
  const caseRoots = manifest.cases.map((identityCase) => identityCase.root);
  const mutationByLegacyOrder = new Map(
    manifest.mutations.map((mutation) => [mutation.legacyOrder, mutation])
  );
  const expectedCaseRoots = matrix.calls
    .map((_call, index) => mutationByLegacyOrder.get(index + 1))
    .filter((mutation): mutation is MutationIdentity => mutation?.role === "root")
    .map((mutation) => mutation.id);
  if (JSON.stringify(caseRoots) !== JSON.stringify(expectedCaseRoots)) {
    problems.push("manifest cases must preserve exact legacy root order after dependency exclusion");
  }
  const checkIds = manifest.cases.flatMap((identityCase) => identityCase.checks.map((check) => check.expectation.id));
  for (const [label, values] of [
    ["case IDs", caseIds],
    ["case roots", caseRoots],
    ["expectation IDs", checkIds],
    ["case semantic fingerprints", manifest.cases.map((identityCase) => identityCase.semanticFingerprint)]
  ] as const) {
    const duplicates = duplicateValues(values);
    if (duplicates.length !== 0) {
      problems.push(`manifest ${label} must be unique; duplicates: ${duplicates.join(", ")}`);
    }
  }
  let logicalChecks = 0;
  let rawMatchers = 0;
  let compositeChecks = 0;
  const compositeProfiles: number[] = [];
  const transactionChecks: Array<{
    readonly problem: string;
    readonly spanKey: string;
  }> = [];
  const invocationCensus = new Map<string, number>();
  const expectationCensus = new Map<string, number>();
  const mutationById = new Map(manifest.mutations.map((mutation) => [mutation.id, mutation]));
  const mcpbMutantSlots = new Map<string, number>();
  const declarations = constDeclarations(matrixSourceFile);
  const callsBySpan = callExpressionsBySpan(matrixSourceFile);
  const bindingFlows = variableBindingFlows(matrixSourceFile);
  const ultimateSource = (mutationId: string): string | null => {
    const visited = new Set<string>();
    let current = mutationById.get(mutationId);
    while (current !== undefined && current.source.kind === "mutation") {
      if (visited.has(current.id)) return null;
      visited.add(current.id);
      current = mutationById.get(current.source.id);
    }
    return current?.source.kind === "source" ? current.source.id : null;
  };
  for (let index = 0; index < manifest.cases.length; index++) {
    const identityCase = manifest.cases[index];
    if (identityCase === undefined) continue;
    if (identityCase.order !== index + 1) {
      problems.push(`manifest case order must be contiguous; index ${index} declares ${identityCase.order}`);
    }
    if (!CASE_ID_PATTERN.test(identityCase.id)) problems.push(`manifest case ${identityCase.id} has invalid identity`);
    const expectedCaseId = identityCase.root.replace("release.", "release.case.");
    if (identityCase.id !== expectedCaseId) {
      problems.push(`manifest case for ${identityCase.root} must use exact identity ${expectedCaseId}`);
    }
    if (!roots.has(identityCase.root)) {
      problems.push(`manifest case ${identityCase.id} references non-root ${identityCase.root}`);
    }
    if (identityCase.checks.length !== 1 && identityCase.checks.length !== 2) {
      problems.push(`manifest case ${identityCase.id} must contain one primary and at most one composite check`);
    }
    logicalChecks += identityCase.checks.length;
    for (let checkIndex = 0; checkIndex < identityCase.checks.length; checkIndex++) {
      const check = identityCase.checks[checkIndex];
      if (check === undefined) continue;
      const expectedExpectationId = `${identityCase.root.replace("release.", "release.expectation.")}.${
        checkIndex === 0 ? "primary" : "composition"
      }`;
      if (check.expectation.id !== expectedExpectationId) {
        problems.push(
          `manifest case ${identityCase.id} check ${checkIndex} expectation ID must be ${expectedExpectationId}`
        );
      }
      if (checkIndex === 0) {
        validatePrimaryInvocation(
          check,
          `${identityCase.id}.checks[${checkIndex}].invoke`,
          mcpbMutantSlots,
          problems
        );
      } else {
        validateCompositeInvocation(
          check,
          identityCase.root,
          `${identityCase.id}.checks[${checkIndex}].invoke`,
          problems
        );
      }
      const rootMutation = mutationById.get(identityCase.root);
      const rootCall = rootMutation === undefined ? undefined : matrix.calls[rootMutation.legacyOrder - 1]?.node;
      const matcherCall = callsBySpan.get(
        `${check.matcherEvaluations[0]?.assertionSpan.start}:${check.matcherEvaluations[0]?.assertionSpan.end}`
      );
      if (
        rootCall === undefined ||
        matcherCall === undefined ||
        !rootIsBoundToAssertion(rootCall, matcherCall, matrixSourceFile, bindingFlows)
      ) {
        problems.push(
          `manifest case ${identityCase.id} check ${checkIndex} is not AST-bound to its exact root mutation`
        );
      }
      if (checkIndex === 0 && check.expectation.kind === "problem" && rootCall !== undefined) {
        const literalProblem = literalExpectedProblemForRoot(rootCall);
        if (literalProblem !== null && literalProblem !== check.expectation.problem) {
          problems.push(`manifest case ${identityCase.id} borrows the wrong literal expectedProblem identity`);
        }
      }
      if (check.invoke.mutant !== identityCase.root) {
        problems.push(
          `manifest case ${identityCase.id} check ${checkIndex} mutant must equal root ${identityCase.root}`
        );
      }
      expectationCensus.set(check.expectation.kind, (expectationCensus.get(check.expectation.kind) ?? 0) + 1);
      if (check.expectation.kind === "regex") {
        const expectedOperand = NAMED_REGEX_OPERANDS[check.expectation.regex];
        if (expectedOperand === undefined) {
          problems.push(
            `manifest case ${identityCase.id} check ${checkIndex} uses an unknown named-regex identity`
          );
        }
        for (const matcher of check.matcherEvaluations) {
          if (
            matcher.operand.resolved !== check.expectation.regex ||
            matcher.operand.raw !== expectedOperand
          ) {
            problems.push(
              `manifest case ${identityCase.id} check ${checkIndex} named-regex operand ` +
                "disagrees with its exact AST catalogue"
            );
          }
        }
      }
      if (!sourceIds.has(check.invoke.baseline)) {
        problems.push(
          `manifest case ${identityCase.id} check ${checkIndex} has unknown baseline ${check.invoke.baseline}`
        );
      }
      const expectedBaseline = ultimateSource(identityCase.root);
      if (check.invoke.baseline !== expectedBaseline) {
        problems.push(
          `manifest case ${identityCase.id} check ${checkIndex} baseline must be ultimate source ` +
            `${expectedBaseline ?? "missing"}`
        );
      }
      invocationCensus.set(
        check.invoke.kind,
        (invocationCensus.get(check.invoke.kind) ?? 0) + (checkIndex === 0 ? 1 : 0)
      );
      validateSpanAgainstSource(
        check.assertionSpan,
        matrixSource,
        `${identityCase.id}.checks[${checkIndex}].assertionSpan`,
        problems
      );
      const firstMatcherSpan = check.matcherEvaluations[0]?.assertionSpan;
      const lastMatcherSpan = check.matcherEvaluations.at(-1)?.assertionSpan;
      if (firstMatcherSpan !== undefined && lastMatcherSpan !== undefined) {
        const expectedCheckSpan: IdentitySpan = {
          start: firstMatcherSpan.start,
          end: lastMatcherSpan.end,
          line: firstMatcherSpan.line,
          column: firstMatcherSpan.column,
          sha256: sha256(matrixSource.slice(firstMatcherSpan.start, lastMatcherSpan.end))
        };
        if (JSON.stringify(check.assertionSpan) !== JSON.stringify(expectedCheckSpan)) {
          problems.push(
            `manifest case ${identityCase.id} check ${checkIndex} assertionSpan must exactly bound ` +
              "its ordered matcher leaves"
          );
        }
      }
      rawMatchers += check.matcherEvaluations.length;
      if (checkIndex === 0 && check.matcherEvaluations.length !== 1) {
        problems.push(`manifest case ${identityCase.id} primary check must have exactly one matcher leaf`);
      }
      if (checkIndex === 1) {
        compositeChecks++;
        compositeProfiles.push(check.matcherEvaluations.length);
      }
      for (let matcherIndex = 0; matcherIndex < check.matcherEvaluations.length; matcherIndex++) {
        const matcher = check.matcherEvaluations[matcherIndex];
        if (matcher === undefined) continue;
        validateSpanAgainstSource(
          matcher.assertionSpan,
          matrixSource,
          `${identityCase.id}.checks[${checkIndex}].matcherEvaluations[${matcherIndex}].assertionSpan`,
          problems
        );
        const profileValue = check.invoke.inputs.profile;
        const profileEntry = Array.isArray(profileValue) ? profileValue[matcherIndex] : undefined;
        const expectedMatcherCallee =
          checkIndex === 0
            ? check.invoke.kind === "mcpb.contract"
              ? "mcpbContractProblems"
              : (INVOCATION_CONTRACTS[check.invoke.kind]?.callee ?? "")
            : isRecord(profileEntry) && typeof profileEntry.callee === "string"
              ? profileEntry.callee
              : "";
        validateMatcherAst(
          matcher,
          matrixSourceFile,
          callsBySpan,
          declarations,
          expectedMatcherCallee,
          `${identityCase.id}.checks[${checkIndex}].matcherEvaluations[${matcherIndex}]`,
          problems
        );
        const assertionText = matrixSource.slice(matcher.assertionSpan.start, matcher.assertionSpan.end);
        if (!assertionText.includes(`.${matcher.matcher}(`) || !assertionText.includes(matcher.operand.raw)) {
          problems.push(
            `manifest case ${identityCase.id} matcher ${matcherIndex} identity disagrees with exact assertion source`
          );
        }
        if (matcher.negated !== assertionText.includes(".not.")) {
          problems.push(
            `manifest case ${identityCase.id} matcher ${matcherIndex} negation disagrees with exact assertion source`
          );
        }
      }
      if (checkIndex === 0) {
        const leaf = check.matcherEvaluations[0];
        if (leaf !== undefined) {
          const semantic = expectationSemantic(check.expectation);
          if (check.expectation.kind === "problem" && typeof leaf.operand.resolved !== "string") {
            problems.push(`manifest case ${identityCase.id} problem matcher operand must resolve to a string`);
          } else if (check.expectation.kind === "problem" && semantic !== leaf.operand.resolved) {
            problems.push(`manifest case ${identityCase.id} problem identity does not equal its exact matcher operand`);
          }
          if (check.expectation.kind === "regex" && semantic !== leaf.operand.resolved) {
            problems.push(`manifest case ${identityCase.id} regex identity does not equal its exact matcher operand`);
          }
        }
      } else {
        const profile = check.invoke.inputs.profile;
        if (!Array.isArray(profile) || profile.length !== check.matcherEvaluations.length) {
          problems.push(
            `manifest case ${identityCase.id} composite invocation profile must preserve every ordered matcher leaf`
          );
        }
        if (check.expectation.kind !== "equal") {
          problems.push(`manifest case ${identityCase.id} composite expectation must be exact equality`);
        } else if (JSON.stringify(profile) !== check.expectation.value) {
          problems.push(
            `manifest case ${identityCase.id} composite expectation must equal canonical ordered profile JSON`
          );
        }
      }
      if (check.invoke.kind === "github.release-transaction" && checkIndex === 0) {
        if (check.expectation.kind !== "problem") {
          problems.push(`manifest transaction case ${identityCase.id} must select an exact problem identity`);
        } else {
          transactionChecks.push({
            problem: check.expectation.problem,
            spanKey: `${check.assertionSpan.start}:${check.assertionSpan.end}`
          });
        }
      }
    }
  }
  for (const root of roots) {
    if (!caseRoots.includes(root)) problems.push(`manifest root ${root} has no exact case`);
  }
  if (logicalChecks !== 541 || checkIds.length !== 541) {
    problems.push(`manifest logical check topology must equal 541; found ${logicalChecks}`);
  }
  if (compositeChecks !== 5 || JSON.stringify(compositeProfiles) !== JSON.stringify([2, 1, 2, 3, 2])) {
    problems.push(`manifest composite profiles must be exactly 2/1/2/3/2; found ${compositeProfiles.join("/")}`);
  }
  if (rawMatchers !== 546) problems.push(`manifest raw matcher topology must equal 546; found ${rawMatchers}`);
  const observedExpectationCensus = Object.fromEntries(
    [...expectationCensus].sort(([left], [right]) => left.localeCompare(right))
  );
  if (JSON.stringify(observedExpectationCensus) !== JSON.stringify({ equal: 5, problem: 535, regex: 1 })) {
    problems.push(
      "manifest expectation identities must be 535 problem / 1 regex / 5 equal; found " +
        JSON.stringify(observedExpectationCensus)
    );
  }
  const observedInvocationCensus = Object.fromEntries(
    [...invocationCensus].sort(([left], [right]) => left.localeCompare(right))
  );
  const expectedInvocationCensus = Object.fromEntries(
    Object.entries(EXPECTED_INVOCATION_CENSUS).sort(([left], [right]) => left.localeCompare(right))
  );
  if (JSON.stringify(observedInvocationCensus) !== JSON.stringify(expectedInvocationCensus)) {
    problems.push(
      "manifest primary invocation census disagrees with the exact 536-root adapter split: " +
        JSON.stringify(observedInvocationCensus)
    );
  }
  const observedMcpbMutantSlots = Object.fromEntries(
    [...mcpbMutantSlots].sort(([left], [right]) => left.localeCompare(right))
  );
  const expectedMcpbMutantSlots = Object.fromEntries(
    Object.entries(MCPB_MUTANT_SLOT_CENSUS).sort(([left], [right]) => left.localeCompare(right))
  );
  if (JSON.stringify(observedMcpbMutantSlots) !== JSON.stringify(expectedMcpbMutantSlots)) {
    problems.push(`manifest MCPB mutable-slot profile is wrong: ${JSON.stringify(observedMcpbMutantSlots)}`);
  }
  const expectedTransactionProblems = TRANSACTION_PROBLEM_RUNS.flatMap(([problem, count]) =>
    Array.from({ length: count }, () => problem)
  );
  const transactionSpanCounts = new Map<string, number>();
  for (const check of transactionChecks) {
    transactionSpanCounts.set(check.spanKey, (transactionSpanCounts.get(check.spanKey) ?? 0) + 1);
  }
  const transactionSpans = [...transactionSpanCounts].filter(([, count]) => count === 76);
  const exactTransactionSpan = transactionSpans[0]?.[0];
  if (transactionSpans.length !== 1) {
    problems.push(`manifest must have one exact 76-case transaction assertion span; found ${transactionSpans.length}`);
  }
  const transactionProblems = transactionChecks
    .filter((check) => check.spanKey === exactTransactionSpan)
    .map((check) => check.problem);
  if (JSON.stringify(transactionProblems) !== JSON.stringify(expectedTransactionProblems)) {
    problems.push("manifest transaction profile must preserve the exact ordered 76 problem identities");
  }
  const m191 = manifest.cases.find((identityCase) => identityCase.root === "release.m191")?.checks[0];
  if (
    m191?.invoke.kind !== "remote-gate.protocol-conformance" ||
    m191.expectation.kind !== "problem" ||
    m191.expectation.problem !==
      "protocol-conformance must pin slash-preserving note resource URIs on every host"
  ) {
    problems.push(
      "release.m191 must retain the slash-preserving protocol-conformance detector and exact problem identity"
    );
  }
  const m001 = manifest.cases.find((identityCase) => identityCase.root === "release.m001")?.checks[0];
  if (
    m001?.expectation.kind !== "regex" ||
    m001.expectation.regex !== "workflow.schema.case-insensitive-env" ||
    m001.matcherEvaluations[0]?.matcher !== "toContainEqual" ||
    m001.matcherEvaluations[0]?.negated !== false ||
    m001.matcherEvaluations[0]?.operand.resolved !== "workflow.schema.case-insensitive-env" ||
    m001.matcherEvaluations[0]?.operand.raw !==
      NAMED_REGEX_OPERANDS["workflow.schema.case-insensitive-env"]
  ) {
    problems.push("release.m001 must retain the exact case-insensitive workflow-schema named-regex identity");
  }
  const expectedAuxiliaryProfiles: Readonly<Record<string, readonly (readonly [string, boolean])[]>> = {
    "release.m038": [
      ["toBe", false],
      ["toEqual", true]
    ],
    "release.m039": [["toEqual", true]],
    "release.m040": [
      ["toEqual", false],
      ["toEqual", true]
    ],
    "release.m041": [
      ["toBe", false],
      ["toEqual", false],
      ["toBe", false]
    ],
    "release.m042": [
      ["toEqual", false],
      ["toBe", false]
    ]
  };
  for (const [root, expectedProfile] of Object.entries(expectedAuxiliaryProfiles)) {
    const auxiliary = manifest.cases.find((identityCase) => identityCase.root === root)?.checks[1];
    const observedProfile = auxiliary?.matcherEvaluations.map(
      (matcher) => [matcher.matcher, matcher.negated] as const
    );
    if (JSON.stringify(observedProfile) !== JSON.stringify(expectedProfile)) {
      problems.push(`${root} must preserve its exact ordered auxiliary matcher and polarity profile`);
    }
  }
}

function validateInventory(manifest: IdentityManifest, problems: string[]): void {
  for (const key of Object.keys(EXPECTED_INVENTORY) as Array<keyof ManifestInventory>) {
    if (manifest.inventory[key] !== EXPECTED_INVENTORY[key]) {
      problems.push(`manifest.inventory.${key} must be ${EXPECTED_INVENTORY[key]}; found ${manifest.inventory[key]}`);
    }
  }
}

function validateSemanticFingerprints(manifest: IdentityManifest, problems: string[]): void {
  const caseFingerprintByRoot = new Map<string, string>();
  for (const identityCase of manifest.cases) {
    const expectedFingerprint = semanticFingerprint({
      normalizer: "release-matrix-balanced-v2",
      case: {
        order: identityCase.order,
        id: identityCase.id,
        root: identityCase.root,
        checks: identityCase.checks
      }
    });
    if (identityCase.semanticFingerprint !== expectedFingerprint) {
      problems.push(`manifest case ${identityCase.id} semanticFingerprint must be ${expectedFingerprint}`);
    }
    caseFingerprintByRoot.set(identityCase.root, identityCase.semanticFingerprint);
  }
  for (const mutation of manifest.mutations) {
    const ownerCaseFingerprint = caseFingerprintByRoot.get(mutation.ownerRoot);
    if (ownerCaseFingerprint === undefined) {
      problems.push(`manifest mutation ${mutation.id} has no owner-case fingerprint`);
      continue;
    }
    const expectedFingerprint = semanticFingerprint({
      normalizer: "release-matrix-balanced-v2",
      mutation: {
        order: mutation.order,
        legacyOrder: mutation.legacyOrder,
        id: mutation.id,
        mode: mutation.mode,
        role: mutation.role,
        legacyOccurrence: mutation.legacyOccurrence,
        expressions: mutation.expressions,
        source: mutation.source,
        replacementDependency: mutation.replacementDependency,
        ownerRoot: mutation.ownerRoot,
        legacySpan: mutation.legacySpan,
        witness: mutation.witness
      },
      ownerCaseFingerprint
    });
    if (mutation.semanticFingerprint !== expectedFingerprint) {
      problems.push(`manifest mutation ${mutation.id} semanticFingerprint must be ${expectedFingerprint}`);
    }
  }
}

/**
 * Audits a generated schema-v2 release mutation identity manifest against the exact legacy matrix AST.
 *
 * This implementation deliberately does not import the generator and does not share its normalizer.
 * It parses JSON fail-closed, independently re-censuses the TypeScript call graph and assertion spans,
 * and pins source, mutation, case, check, matcher, dependency, witness, and transaction identities.
 *
 * @param matrixSource - Complete `tests/release-integrity.test.ts` source text.
 * @param manifestSource - Complete generated schema-v2 manifest JSON bytes.
 * @returns Stable diagnostics; empty only for the reviewed exact identity graph.
 */
export function releaseMutationIdentityAuditProblems(matrixSource: string, manifestSource: string): string[] {
  const problems: string[] = [];
  validateWitnessCounterSemantics(problems);
  if (sha256(matrixSource) !== MATRIX_SOURCE_SHA256) {
    problems.push(`release-integrity source must remain exact reviewed SHA-256 ${MATRIX_SOURCE_SHA256}`);
  }
  const manifest = parseManifest(manifestSource, problems);
  if (manifest === null) return problems;
  const matrix = scanMatrix(matrixSource, problems);
  if (matrix === null) return problems;
  validateRawExpressionShape(matrix, problems);
  validateProvenance(manifest, matrix, problems);
  validateInventory(manifest, problems);
  const sourceCatalogueValid = validateSources(manifest, matrix, problems);
  validateMutationGraph(manifest, matrix, sourceCatalogueValid, problems);
  validateCases(manifest, matrixSource, matrix, problems);
  validateSemanticFingerprints(manifest, problems);
  return problems;
}
