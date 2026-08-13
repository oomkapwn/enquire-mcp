import { Buffer } from "node:buffer";
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

interface FrozenMatcherSpanOwnership {
  readonly remainingLegacy: boolean;
  readonly span: IdentitySpan;
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

interface ReleaseMutationIdentityAuditTelemetry {
  readonly fixturePreparations: 1;
  readonly materializedGraphEvaluations: number;
  readonly materializedGraphReuses: number;
  readonly sourceCatalogueBypasses: number;
  readonly sourceProjectionBypasses: number;
}

interface ReleaseMutationIdentityAuditor {
  /** Audits one current matrix candidate while retaining the prepared immutable fixture. */
  auditMatrix(matrixSource: string): string[];
  /** Returns a fresh immutable snapshot of execution-scoped reuse counters. */
  telemetry(): Readonly<ReleaseMutationIdentityAuditTelemetry>;
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
  readonly callback: ts.ArrowFunction;
  readonly calls: readonly LegacyMutationCall[];
  readonly declarations: ReadonlyMap<string, ts.Expression>;
  readonly matrixStart: number;
  readonly matrixSlice: string;
  readonly sourceFile: ts.SourceFile;
}

interface DeclarativeMutationIdentity {
  readonly expectedOccurrences: number;
  readonly handle: string;
  readonly id: string;
  readonly mode: MutationMode;
  readonly needle: string;
  readonly replacement: null | string;
  readonly replacementHandle: null | string;
  readonly sourceHandle: string;
  readonly witness: Pick<MutationWitness, "after" | "anchor" | "before" | "derivation" | "kind">;
}

interface DeclarativeCaseIdentity {
  readonly baselineHandle: string;
  readonly checkCount: number;
  readonly companionHandle: null | string;
  readonly companionSlot: "integrity" | null | "release" | "run";
  readonly expectationId: string;
  readonly handle: string;
  readonly id: string;
  readonly invocationKind: string;
  readonly mutantHandle: string;
  readonly problem: string;
}

interface DeclarativeInvocationIdentity {
  readonly baselineHandle: string;
  readonly companionHandle: null | string;
  readonly companionSlot: "integrity" | null | "release" | "run";
  readonly invocationKind: string;
  readonly mutantHandle: string;
}

type ReleaseOracleAdapterProperty =
  | "npmContractProblems"
  | "npmEvaluatorProblems"
  | "npmWorkflowProblems"
  | "registryEvaluatorProblems"
  | "registryStepProblems";

interface ReleaseOracleAdapterBinding {
  readonly binding:
    | "mcpRegistryEvaluatorProblems"
    | "mcpRegistryRunProblems"
    | "npmProvenanceContractProblems"
    | "npmProvenanceEvaluatorProblems"
    | "npmProvenanceWorkflowProblems";
  readonly property: ReleaseOracleAdapterProperty;
}

type DeclarativeExecutionKind = "execute" | "executeRemaining" | "executeThrough";

interface DeclarativeExecutionEvent {
  readonly anchor: number;
  readonly boundaryHandle: null | string;
  readonly kind: DeclarativeExecutionKind;
  readonly statementIndex: number;
}

interface HybridDeclarativeScan {
  readonly cases: readonly DeclarativeCaseIdentity[];
  readonly executionEvents: readonly DeclarativeExecutionEvent[];
  readonly mutations: readonly DeclarativeMutationIdentity[];
}

interface AnchoredCaseExecution {
  readonly anchor: number;
  readonly caseId: string;
  readonly rootId: string;
  readonly tieBreaker: number;
}

interface ExpandedDeclarativeCaseExecution {
  readonly anchor: number;
  readonly identityCase: DeclarativeCaseIdentity;
  readonly tieBreaker: number;
}

interface DeclarativeExecutionExpansion {
  readonly executions: readonly ExpandedDeclarativeCaseExecution[];
  readonly problems: readonly string[];
}

interface LegacyCaseExecutionAnchor {
  readonly anchor: number;
  readonly matcher: ts.CallExpression;
  readonly rootAnchor: number;
  readonly rootCall: ts.CallExpression;
}

const MATRIX_TITLE = "keeps release.yml wired to the shared evaluator and an exact mirrored inventory";
const SOURCE_COMMIT = "8420e2fca3ed0dac994859a9e9a30b933d5ddf9e";
const MATRIX_SOURCE_SHA256 = "3fa0b67411e2fc0f4d7c6bce6075ba91eb25edc19a210b5c2f8dd408def6e18b";
const MATRIX_SLICE_SHA256 = "caca0093c744df9f6c6cdd0e8200fd8df45052e784297079887ea48686c5e07f";
const CURRENT_HYBRID_SOURCE_SHA256 = "2a15da915814bdfd4baacda33c87d93ce8679d89a93fb459ac97c37d3ba8763e";
const CURRENT_HYBRID_MATRIX_SLICE_SHA256 = "398f36f2842f8770f4a8db0836e653886bd2b435169162eedb01cd1dcaa43116";
const IDENTITY_FIXTURE_SHA256 = "9ccc4d25c0051d9516c9e7795dc6499a4ad024f33f67cea34776d59d5bbe6ce3";
const MUTATION_MATCH_COUNT_NODE_SHA256 = "5e57cd7a2f1dd60cc4bda3b10c4a7e906f7e5b9604902eff5e54f20bd0c8f49d";
const NPM_PROVENANCE_PROBLEM_NODE_SHA256 = "f6f47a5f8eb309db455cf684ca187c5c1ce6dadd0443e4c11475a779a5944334";
const NPM_PROVENANCE_DETECTOR_NODE_SHA256 = "c453e6c43d71d042e8609997e13a461891e299b494d84242b02227a0b96a825f";
const NPM_PROVENANCE_WORKFLOW_DETECTOR_NODE_SHA256 = "1361143df29c345b53371ecd39f8fcc44b607a590ebb0068682303f19885c082";
const NPM_PROVENANCE_EVALUATOR_DETECTOR_NODE_SHA256 =
  "99506547faeba03621f4a30f9c2262c3873ec974df5621741e4db01fabb5ef14";
const REGISTRY_EVALUATOR_PROBLEM_NODE_SHA256 = "4c374cc179d7a95cdf25085358c62e482134824abca913b126167d3bb8397b26";
const REGISTRY_EVALUATOR_DETECTOR_NODE_SHA256 = "b45c5aed44cf1bff818d5ddac4f80e8fb805e61300f93f77afc299d3e8f0047c";
const REGISTRY_STEP_DETECTOR_NODE_SHA256 = "5dec02c19d724cf373acc0c9b65fba7309b4b3e5c4ca6cff5422ec5c64e12db6";
const REGISTRY_RUN_DETECTOR_NODE_SHA256 = "5b09ecbae41cfc47a6f66ff353e923ef511dd0007fba0a075d61de6e256935e6";
const REGISTRY_WORKFLOW_PROBLEM_NODE_SHA256 = "65bf82b0a4429d04ea16bfd0baa7b8397c0c43a945f978e0f4395e59cbcf1221";
const REGISTRY_EVALUATOR_PROBLEM =
  "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics";
const REGISTRY_WORKFLOW_PROBLEM =
  "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback";
const NPM_PROVENANCE_PROBLEM =
  "npm provenance must bind the tag-push context before the sole publish " +
  "and verify two exact attestations without credentials";
const MIGRATED_REGISTRY_EVALUATOR_IDS = [
  "release.m002",
  "release.m003",
  "release.m004",
  "release.m005",
  "release.m006",
  "release.m007",
  "release.m008",
  "release.m009",
  "release.m010",
  "release.m011",
  "release.m012",
  "release.m013",
  "release.m014",
  "release.m015",
  "release.m016",
  "release.m017",
  "release.m018",
  "release.m019",
  "release.m020",
  "release.m021",
  "release.m022",
  "release.m023",
  "release.m024",
  "release.m025",
  "release.m026",
  "release.m027",
  "release.m028",
  "release.m029",
  "release.m030",
  "release.m031",
  "release.m032",
  "release.m033",
  "release.m034",
  "release.m035",
  "release.m036",
  "release.m037"
] as const;
const MIGRATED_REGISTRY_STEP_MUTATION_IDS = ["release.m108", "release.m107", "release.m109", "release.m110"] as const;
const MIGRATED_REGISTRY_RUN_IDS = ["release.m107", "release.m109", "release.m110"] as const;
const MIGRATED_REGISTRY_STEP_INTEGRITY_IDS = ["release.m111"] as const;
const MIGRATED_NPM_CONTRACT_RELEASE_IDS = ["release.m112"] as const;
const MIGRATED_NPM_CONTRACT_INTEGRITY_IDS = ["release.m113"] as const;
const MIGRATED_NPM_WORKFLOW_PREFIX_IDS = [
  "release.m114",
  "release.m115",
  "release.m116",
  "release.m117",
  "release.m118",
  "release.m119",
  "release.m120",
  "release.m121",
  "release.m122",
  "release.m123",
  "release.m124",
  "release.m125",
  "release.m126",
  "release.m127",
  "release.m128",
  "release.m129",
  "release.m130",
  "release.m131",
  "release.m132",
  "release.m133",
  "release.m134",
  "release.m135",
  "release.m136",
  "release.m137",
  "release.m138"
] as const;
const MIGRATED_NPM_WORKFLOW_MUTATION_IDS = [
  ...MIGRATED_NPM_WORKFLOW_PREFIX_IDS,
  "release.m140",
  "release.m139",
  "release.m141",
  "release.m142",
  "release.m143",
  "release.m145",
  "release.m144",
  "release.m146",
  "release.m147",
  "release.m148",
  "release.m149",
  "release.m150",
  "release.m151"
] as const;
const MIGRATED_NPM_WORKFLOW_IDS = [
  ...MIGRATED_NPM_WORKFLOW_PREFIX_IDS,
  "release.m139",
  "release.m141",
  "release.m142",
  "release.m143",
  "release.m144",
  "release.m146",
  "release.m147",
  "release.m148",
  "release.m149",
  "release.m150",
  "release.m151"
] as const;
const MIGRATED_NPM_EVALUATOR_IDS = [
  "release.m152",
  "release.m153",
  "release.m154",
  "release.m155",
  "release.m156",
  "release.m157",
  "release.m158",
  "release.m159",
  "release.m160",
  "release.m161",
  "release.m162",
  "release.m163",
  "release.m164"
] as const;
const MIGRATED_REGISTRY_EVALUATOR_ID_SET: ReadonlySet<string> = new Set<string>(MIGRATED_REGISTRY_EVALUATOR_IDS);
const MIGRATED_REGISTRY_RUN_ID_SET: ReadonlySet<string> = new Set<string>(MIGRATED_REGISTRY_RUN_IDS);
const MIGRATED_REGISTRY_STEP_INTEGRITY_ID_SET: ReadonlySet<string> = new Set<string>(
  MIGRATED_REGISTRY_STEP_INTEGRITY_IDS
);
const MIGRATED_NPM_CONTRACT_RELEASE_ID_SET: ReadonlySet<string> = new Set<string>(MIGRATED_NPM_CONTRACT_RELEASE_IDS);
const MIGRATED_NPM_CONTRACT_INTEGRITY_ID_SET: ReadonlySet<string> = new Set<string>(
  MIGRATED_NPM_CONTRACT_INTEGRITY_IDS
);
const MIGRATED_NPM_WORKFLOW_ID_SET: ReadonlySet<string> = new Set<string>(MIGRATED_NPM_WORKFLOW_IDS);
const MIGRATED_NPM_EVALUATOR_ID_SET: ReadonlySet<string> = new Set<string>(MIGRATED_NPM_EVALUATOR_IDS);
const MIGRATED_DECLARATIVE_IDS = [
  ...MIGRATED_REGISTRY_EVALUATOR_IDS,
  ...MIGRATED_REGISTRY_STEP_MUTATION_IDS,
  ...MIGRATED_REGISTRY_STEP_INTEGRITY_IDS,
  ...MIGRATED_NPM_CONTRACT_RELEASE_IDS,
  ...MIGRATED_NPM_CONTRACT_INTEGRITY_IDS,
  ...MIGRATED_NPM_WORKFLOW_MUTATION_IDS,
  ...MIGRATED_NPM_EVALUATOR_IDS
] as const;
const MIGRATED_DECLARATIVE_ID_SET: ReadonlySet<string> = new Set<string>(MIGRATED_DECLARATIVE_IDS);
const MIGRATED_DECLARATIVE_ROOT_IDS = [
  ...MIGRATED_REGISTRY_EVALUATOR_IDS,
  ...MIGRATED_REGISTRY_RUN_IDS,
  ...MIGRATED_REGISTRY_STEP_INTEGRITY_IDS,
  ...MIGRATED_NPM_CONTRACT_RELEASE_IDS,
  ...MIGRATED_NPM_CONTRACT_INTEGRITY_IDS,
  ...MIGRATED_NPM_WORKFLOW_IDS,
  ...MIGRATED_NPM_EVALUATOR_IDS
] as const;
const MIGRATED_DECLARATIVE_ALL_IDS: ReadonlySet<string> = new Set<string>([
  "release.m009",
  "release.m018",
  "release.m034"
]);
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
    ["order", "id", "legacyExpressions", "declarativeBinding", "origin", "contentSha256", "semanticFingerprint"],
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
  const semanticKey =
    kind === "problem"
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
          ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name) || ts.isIdentifier(property.name)
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
  return expression !== undefined && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
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

function executionMultiplyingAncestor(
  node: ts.Node,
  matrixCallback: ts.ArrowFunction,
  sourceFile: ts.SourceFile
): ts.Node | null {
  const isWithin = (container: ts.Node): boolean =>
    node.getStart(sourceFile) >= container.getStart(sourceFile) && node.end <= container.end;
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor !== undefined && ancestor !== matrixCallback) {
    const isOptionalChain = "questionDotToken" in ancestor && ancestor.questionDotToken !== undefined;
    if (
      (ts.isForStatement(ancestor) && (ancestor.initializer === undefined || !isWithin(ancestor.initializer))) ||
      (ts.isForInStatement(ancestor) && !isWithin(ancestor.expression)) ||
      (ts.isForOfStatement(ancestor) && !isWithin(ancestor.expression)) ||
      ts.isWhileStatement(ancestor) ||
      ts.isDoStatement(ancestor) ||
      ts.isIfStatement(ancestor) ||
      ts.isConditionalExpression(ancestor) ||
      ts.isSwitchStatement(ancestor) ||
      ts.isTryStatement(ancestor) ||
      ts.isLabeledStatement(ancestor) ||
      ts.isWithStatement(ancestor) ||
      ts.isFunctionLike(ancestor) ||
      ts.isClassDeclaration(ancestor) ||
      ts.isClassExpression(ancestor) ||
      (ts.isBindingElement(ancestor) && ancestor.initializer !== undefined && isWithin(ancestor.initializer)) ||
      isOptionalChain ||
      (ts.isBinaryExpression(ancestor) &&
        (ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          ancestor.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          ancestor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
          ancestor.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
          ancestor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken))
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
        } else problems.push("release mutation identity audit found duplicate matrix callbacks");
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
          const multiplyingAncestor = executionMultiplyingAncestor(node, callback as ts.ArrowFunction, sourceFile);
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
    callback: callback as ts.ArrowFunction,
    sourceFile,
    calls,
    declarations: constDeclarations(sourceFile),
    matrixStart,
    matrixSlice: source.slice(matrixStart, matrixEnd)
  };
}

function exactObjectProperties(
  value: ts.Expression | undefined,
  expectedKeys: readonly string[],
  path: string,
  problems: string[]
): ReadonlyMap<string, ts.Expression> | null {
  if (value === undefined || !ts.isObjectLiteralExpression(value)) {
    problems.push(`${path} must be one literal object`);
    return null;
  }
  const properties = new Map<string, ts.Expression>();
  let structurallyValid = true;
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      structurallyValid = false;
      continue;
    }
    const name = property.name.text;
    if (properties.has(name)) structurallyValid = false;
    else properties.set(name, property.initializer);
  }
  const observedKeys = [...properties.keys()].sort();
  const exactKeys = [...expectedKeys].sort();
  if (!structurallyValid || JSON.stringify(observedKeys) !== JSON.stringify(exactKeys)) {
    problems.push(`${path} must have exact literal fields ${exactKeys.join(", ")}`);
    return null;
  }
  return properties;
}

function directTopLevelConst(statement: ts.Statement, name: string): ts.VariableDeclaration | null {
  if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return null;
  if (statement.declarationList.declarations.length !== 1) return null;
  const declaration = statement.declarationList.declarations[0];
  return declaration !== undefined && ts.isIdentifier(declaration.name) && declaration.name.text === name
    ? declaration
    : null;
}

function directPlanCall(expression: ts.Expression | undefined, method: string): ts.CallExpression | null {
  if (
    expression === undefined ||
    !ts.isCallExpression(expression) ||
    expression.questionDotToken !== undefined ||
    expression.typeArguments !== undefined ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.questionDotToken !== undefined ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== "releaseMutationPlan" ||
    expression.expression.name.text !== method
  ) {
    return null;
  }
  return expression;
}

function literalStringValue(
  value: ts.Expression | undefined,
  declarations?: ReadonlyMap<string, ts.Expression>
): string | null {
  if (value === undefined) return null;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (declarations !== undefined && ts.isIdentifier(value)) return resolveStaticString(value, declarations);
  if (
    declarations !== undefined &&
    ts.isTemplateExpression(value) &&
    value.templateSpans.every((span) => ts.isIdentifier(span.expression))
  ) {
    return resolveStaticString(value, declarations);
  }
  return null;
}

function declarativeInvocationKind(value: ts.Expression | undefined): string | null {
  if (value === undefined || !ts.isObjectLiteralExpression(value)) return null;
  const kindProperties = value.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "kind"
  );
  return kindProperties.length === 1 ? literalStringValue(kindProperties[0]?.initializer) : null;
}

function parseDeclarativeInvocation(
  value: ts.Expression | undefined,
  path: string,
  problems: string[]
): DeclarativeInvocationIdentity | null {
  const provisionalKind = declarativeInvocationKind(value);
  const companionSlot =
    provisionalKind === "npm.contract.release" || provisionalKind === "registry.step.run"
      ? "integrity"
      : provisionalKind === "npm.contract.integrity"
        ? "release"
        : provisionalKind === "registry.step.integrity"
          ? "run"
          : null;
  const expectedKeys = [
    "kind",
    "baseline",
    "mutant",
    ...(companionSlot === null ? [] : [companionSlot]),
    ...(provisionalKind === "fixture.throw" ? ["message"] : [])
  ];
  const invocation = exactObjectProperties(value, expectedKeys, path, problems);
  if (invocation === null) return null;
  const invocationKind = literalStringValue(invocation.get("kind"));
  const baseline = invocation.get("baseline");
  const mutant = invocation.get("mutant");
  const companion = companionSlot === null ? undefined : invocation.get(companionSlot);
  const message = provisionalKind === "fixture.throw" ? literalStringValue(invocation.get("message")) : null;
  if (
    invocationKind === null ||
    baseline === undefined ||
    !ts.isIdentifier(baseline) ||
    mutant === undefined ||
    !ts.isIdentifier(mutant) ||
    (companionSlot !== null && (companion === undefined || !ts.isIdentifier(companion))) ||
    (provisionalKind === "fixture.throw" && (message === null || message.length === 0))
  ) {
    problems.push(`${path} must retain exact kind-specific literal fields and direct handle bindings`);
    return null;
  }
  return {
    invocationKind,
    baselineHandle: baseline.text,
    mutantHandle: mutant.text,
    companionSlot,
    companionHandle: companion !== undefined && ts.isIdentifier(companion) ? companion.text : null
  };
}

function requiredReleaseOracleAdapterBindings(
  cases: readonly DeclarativeCaseIdentity[]
): readonly ReleaseOracleAdapterBinding[] {
  const requiresEvaluator = cases.some((identityCase) => identityCase.invocationKind === "registry.evaluator");
  const requiresStep = cases.some(
    (identityCase) =>
      identityCase.invocationKind === "registry.step.run" || identityCase.invocationKind === "registry.step.integrity"
  );
  const requiresNpmContract = cases.some(
    (identityCase) =>
      identityCase.invocationKind === "npm.contract.release" || identityCase.invocationKind === "npm.contract.integrity"
  );
  const requiresNpmEvaluator = cases.some((identityCase) => identityCase.invocationKind === "npm.evaluator");
  const requiresNpmWorkflow = cases.some((identityCase) => identityCase.invocationKind === "npm.workflow");
  const bindings: ReleaseOracleAdapterBinding[] = [];
  if (requiresEvaluator) {
    bindings.push({
      property: "registryEvaluatorProblems",
      binding: "mcpRegistryEvaluatorProblems"
    });
  }
  if (requiresStep) {
    bindings.push({ property: "registryStepProblems", binding: "mcpRegistryRunProblems" });
  }
  if (requiresNpmContract) {
    bindings.push({ property: "npmContractProblems", binding: "npmProvenanceContractProblems" });
  }
  if (requiresNpmEvaluator) {
    bindings.push({ property: "npmEvaluatorProblems", binding: "npmProvenanceEvaluatorProblems" });
  }
  if (requiresNpmWorkflow) {
    bindings.push({ property: "npmWorkflowProblems", binding: "npmProvenanceWorkflowProblems" });
  }
  return Object.freeze(bindings);
}

function exactReleaseOracleAdapterObject(
  value: ts.Expression | undefined,
  expectedBindings: readonly ReleaseOracleAdapterBinding[]
): value is ts.ObjectLiteralExpression {
  if (
    expectedBindings.length < 1 ||
    expectedBindings.length > 5 ||
    value === undefined ||
    !ts.isObjectLiteralExpression(value) ||
    value.properties.length !== expectedBindings.length
  ) {
    return false;
  }
  const expectedByProperty = new Map(expectedBindings.map((binding) => [binding.property, binding.binding]));
  const observedProperties = new Set<string>();
  for (let index = 0; index < value.properties.length; index++) {
    const property = value.properties[index];
    const expectedBinding = expectedBindings[index];
    if (
      property === undefined ||
      expectedBinding === undefined ||
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) ||
      !ts.isIdentifier(property.initializer)
    ) {
      return false;
    }
    const propertyName = property.name.text;
    if (
      observedProperties.has(propertyName) ||
      propertyName !== expectedBinding.property ||
      property.initializer.text !== expectedByProperty.get(propertyName as ReleaseOracleAdapterProperty)
    ) {
      return false;
    }
    observedProperties.add(propertyName);
  }
  return observedProperties.size === expectedBindings.length;
}

function isExactReleaseOracleAdapterReference(
  identifier: ts.Identifier,
  expectedBindings: readonly ReleaseOracleAdapterBinding[]
): boolean {
  const property = identifier.parent;
  if (
    !ts.isPropertyAssignment(property) ||
    property.initializer !== identifier ||
    (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
  ) {
    return false;
  }
  const propertyName = property.name.text;
  const expectedBinding = expectedBindings.find((binding) => binding.property === propertyName);
  if (expectedBinding === undefined || expectedBinding.binding !== identifier.text) return false;
  const object = property.parent;
  if (!exactReleaseOracleAdapterObject(object, expectedBindings)) return false;
  const call = object.parent;
  if (!ts.isCallExpression(call)) return false;
  const fullCall = directPlanCall(call, "execute");
  if (fullCall !== null) {
    return fullCall.arguments.length === 1 && fullCall.arguments[0] === object;
  }
  const stagedCall = directPlanCall(call, "executeThrough");
  return stagedCall !== null && stagedCall.arguments.length === 2 && stagedCall.arguments[1] === object;
}

function positiveIntegerLiteral(value: ts.Expression | undefined): number | null {
  if (value === undefined || !ts.isNumericLiteral(value)) return null;
  const observed = Number(value.text);
  return Number.isSafeInteger(observed) && observed > 0 ? observed : null;
}

function nonNegativeIntegerLiteral(value: ts.Expression | undefined): number | null {
  if (value === undefined || !ts.isNumericLiteral(value)) return null;
  const observed = Number(value.text);
  return Number.isSafeInteger(observed) && observed >= 0 ? observed : null;
}

function exactExpectMatcher(
  statement: ts.Statement | undefined,
  matcherName: string
): { readonly actual: ts.Expression; readonly expected: ts.Expression } | null {
  if (statement === undefined || !ts.isExpressionStatement(statement)) return null;
  const matcherCall = ts.isCallExpression(statement.expression) ? statement.expression : null;
  const matcher =
    matcherCall !== null &&
    matcherCall.questionDotToken === undefined &&
    ts.isPropertyAccessExpression(matcherCall.expression)
      ? matcherCall.expression
      : null;
  const expectCall =
    matcher !== null && matcher.questionDotToken === undefined && ts.isCallExpression(matcher.expression)
      ? matcher.expression
      : null;
  const actual = expectCall?.arguments[0];
  const expected = matcherCall?.arguments[0];
  if (
    matcherCall === null ||
    matcherCall.arguments.length !== 1 ||
    matcherCall.typeArguments !== undefined ||
    matcher === null ||
    matcher.name.text !== matcherName ||
    expectCall === null ||
    expectCall.questionDotToken !== undefined ||
    expectCall.typeArguments !== undefined ||
    !ts.isIdentifier(expectCall.expression) ||
    expectCall.expression.text !== "expect" ||
    expectCall.arguments.length !== 1 ||
    actual === undefined ||
    expected === undefined
  ) {
    return null;
  }
  return { actual, expected };
}

function exactPlanStatusAccess(value: ts.Expression, property: string): boolean {
  return (
    ts.isPropertyAccessExpression(value) &&
    value.questionDotToken === undefined &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "releaseMutationPlan" &&
    value.name.text === property
  );
}

function expandDeclarativeExecutionEvents(
  cases: readonly DeclarativeCaseIdentity[],
  events: readonly DeclarativeExecutionEvent[]
): DeclarativeExecutionExpansion {
  const executions: ExpandedDeclarativeCaseExecution[] = [];
  const problems: string[] = [];
  let cursor = 0;
  let state: "complete" | "initial" | "prefix" = "initial";
  const appendThrough = (event: DeclarativeExecutionEvent, lastIndex: number): void => {
    for (let index = cursor; index <= lastIndex; index++) {
      const identityCase = cases[index];
      if (identityCase === undefined) continue;
      executions.push({ anchor: event.anchor, identityCase, tieBreaker: index });
    }
    cursor = lastIndex + 1;
  };

  for (const event of events) {
    if (state === "complete") {
      problems.push(
        `release mutation hybrid declarative ${event.kind} at ${event.anchor} cannot replay a completed plan`
      );
      continue;
    }
    if (event.kind === "execute") {
      if (state !== "initial") {
        problems.push(
          `release mutation hybrid declarative execute at ${event.anchor} must be the first and only execution event`
        );
        continue;
      }
      if (cases.length === 0) {
        problems.push(`release mutation hybrid declarative execute at ${event.anchor} cannot replay an empty plan`);
        continue;
      }
      appendThrough(event, cases.length - 1);
      state = "complete";
      continue;
    }

    if (event.kind === "executeRemaining") {
      if (state !== "prefix") {
        problems.push(
          `release mutation hybrid declarative executeRemaining at ${event.anchor} must follow ` +
            "one exact executeThrough prefix"
        );
        continue;
      }
      appendThrough(event, cases.length - 1);
      state = "complete";
      continue;
    }

    if (state !== "initial") {
      problems.push(
        `release mutation hybrid declarative executeThrough at ${event.anchor} cannot repeat or replay a staged prefix`
      );
      continue;
    }
    const boundaryIndexes = cases.flatMap((identityCase, index) =>
      identityCase.handle === event.boundaryHandle ? [index] : []
    );
    if (event.boundaryHandle === null || boundaryIndexes.length !== 1) {
      problems.push(
        `release mutation hybrid declarative executeThrough at ${event.anchor} must name one exact root handle; ` +
          `found ${event.boundaryHandle ?? "<invalid>"} with ${boundaryIndexes.length} match(es)`
      );
      continue;
    }
    const boundaryIndex = boundaryIndexes[0];
    if (boundaryIndex === undefined) continue;
    appendThrough(event, boundaryIndex);
    state = cursor === cases.length ? "complete" : "prefix";
  }

  if (problems.length === 0 && (state !== "complete" || cursor !== cases.length)) {
    problems.push(
      `release mutation hybrid declarative execution schedule must terminate complete at cursor ${cases.length}; ` +
        `found ${state} at ${cursor}`
    );
  }

  return {
    executions: Object.freeze(executions),
    problems: Object.freeze(problems)
  };
}

function validateDeclarativeExecutionExpansionSemantics(problems: string[]): void {
  const cases: DeclarativeCaseIdentity[] = ["001", "002", "003"].map((suffix) => ({
    baselineHandle: "baseline",
    checkCount: 1,
    companionHandle: null,
    companionSlot: null,
    expectationId: `expectation.${suffix}`,
    handle: `root${suffix}`,
    id: `case.${suffix}`,
    invocationKind: "fixture.text",
    mutantHandle: `root${suffix}`,
    problem: "problem"
  }));
  const full = expandDeclarativeExecutionEvents(cases, [
    { anchor: 10, boundaryHandle: null, kind: "execute", statementIndex: 10 }
  ]);
  const staged = expandDeclarativeExecutionEvents(cases, [
    { anchor: 10, boundaryHandle: "root002", kind: "executeThrough", statementIndex: 10 },
    { anchor: 20, boundaryHandle: null, kind: "executeRemaining", statementIndex: 20 }
  ]);
  const invalidBoundary = expandDeclarativeExecutionEvents(cases, [
    { anchor: 10, boundaryHandle: "missing", kind: "executeThrough", statementIndex: 10 }
  ]);
  const remainingFirst = expandDeclarativeExecutionEvents(cases, [
    { anchor: 10, boundaryHandle: null, kind: "executeRemaining", statementIndex: 10 }
  ]);
  const repeatedPrefix = expandDeclarativeExecutionEvents(cases, [
    { anchor: 10, boundaryHandle: "root001", kind: "executeThrough", statementIndex: 10 },
    { anchor: 20, boundaryHandle: "root002", kind: "executeThrough", statementIndex: 20 }
  ]);
  const replayAfterFull = expandDeclarativeExecutionEvents(cases, [
    { anchor: 10, boundaryHandle: null, kind: "execute", statementIndex: 10 },
    { anchor: 20, boundaryHandle: null, kind: "executeRemaining", statementIndex: 20 }
  ]);
  const missingAllExecution = expandDeclarativeExecutionEvents(cases, []);
  const missingRemaining = expandDeclarativeExecutionEvents(cases, [
    { anchor: 10, boundaryHandle: "root002", kind: "executeThrough", statementIndex: 10 }
  ]);
  const executionIds = (expansion: DeclarativeExecutionExpansion): readonly string[] =>
    expansion.executions.map((execution) => execution.identityCase.id);
  if (
    full.problems.length !== 0 ||
    JSON.stringify(executionIds(full)) !== JSON.stringify(["case.001", "case.002", "case.003"]) ||
    staged.problems.length !== 0 ||
    JSON.stringify(executionIds(staged)) !== JSON.stringify(["case.001", "case.002", "case.003"]) ||
    JSON.stringify(staged.executions.map((execution) => execution.anchor)) !== JSON.stringify([10, 10, 20]) ||
    invalidBoundary.problems.length !== 1 ||
    !invalidBoundary.problems[0]?.includes("must name one exact root handle") ||
    remainingFirst.problems.length !== 1 ||
    !remainingFirst.problems[0]?.includes("must follow one exact executeThrough prefix") ||
    repeatedPrefix.problems.length !== 1 ||
    !repeatedPrefix.problems[0]?.includes("cannot repeat or replay a staged prefix") ||
    replayAfterFull.problems.length !== 1 ||
    !replayAfterFull.problems[0]?.includes("cannot replay a completed plan") ||
    missingAllExecution.problems.length !== 1 ||
    !missingAllExecution.problems[0]?.includes("must terminate complete at cursor 3; found initial at 0") ||
    missingRemaining.problems.length !== 1 ||
    !missingRemaining.problems[0]?.includes("must terminate complete at cursor 3; found prefix at 2")
  ) {
    problems.push(
      "release mutation declarative execution expansion must preserve full, staged, " +
        "invalid-boundary and replay semantics"
    );
  }
}

function syntheticConstInitializer(source: string): ts.Expression | undefined {
  const sourceFile = ts.createSourceFile(
    "release-mutation-identity-helper-control.ts",
    `const candidate = ${source};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const statement = sourceFile.statements[0];
  if (
    statement === undefined ||
    !ts.isVariableStatement(statement) ||
    statement.declarationList.declarations.length !== 1
  ) {
    return undefined;
  }
  return statement.declarationList.declarations[0]?.initializer;
}

function validateDeclarativeInvocationParsingSemantics(problems: string[]): void {
  const parse = (
    source: string
  ): { readonly problems: readonly string[]; readonly value: DeclarativeInvocationIdentity | null } => {
    const localProblems: string[] = [];
    const value = parseDeclarativeInvocation(
      syntheticConstInitializer(source),
      "declarative invocation helper control",
      localProblems
    );
    return { problems: localProblems, value };
  };
  const run = parse(
    '{ kind: "registry.step.run", baseline: registryPublishStepSource, mutant: releaseMutationM043, ' +
      "integrity: releaseIntegritySource }"
  );
  const integrity = parse(
    '{ kind: "registry.step.integrity", baseline: releaseIntegritySource, mutant: releaseMutationM111, ' +
      "run: registryPublishStepSource }"
  );
  const npmRelease = parse(
    '{ kind: "npm.contract.release", baseline: releaseWorkflowFixtureSource, mutant: releaseMutationM112, ' +
      "integrity: releaseIntegritySource }"
  );
  const npmIntegrity = parse(
    '{ kind: "npm.contract.integrity", baseline: releaseIntegritySource, mutant: releaseMutationM113, ' +
      "release: releaseWorkflowFixtureSource }"
  );
  const npmWorkflow = parse(
    '{ kind: "npm.workflow", baseline: releaseWorkflowFixtureSource, mutant: releaseMutationM114 }'
  );
  const evaluator = parse(
    '{ kind: "registry.evaluator", baseline: releaseIntegritySource, mutant: releaseMutationM002 }'
  );
  const reversedRunCompanion = parse(
    '{ kind: "registry.step.run", baseline: registryPublishStepSource, mutant: releaseMutationM043, ' +
      "run: releaseIntegritySource }"
  );
  const reversedIntegrityCompanion = parse(
    '{ kind: "registry.step.integrity", baseline: releaseIntegritySource, mutant: releaseMutationM111, ' +
      "integrity: registryPublishStepSource }"
  );
  const nonbindingCompanion = parse(
    '{ kind: "registry.step.run", baseline: registryPublishStepSource, mutant: releaseMutationM043, ' +
      'integrity: "releaseIntegritySource" }'
  );
  const reversedNpmReleaseCompanion = parse(
    '{ kind: "npm.contract.release", baseline: releaseWorkflowFixtureSource, mutant: releaseMutationM112, ' +
      "release: releaseIntegritySource }"
  );
  const reversedNpmIntegrityCompanion = parse(
    '{ kind: "npm.contract.integrity", baseline: releaseIntegritySource, mutant: releaseMutationM113, ' +
      "integrity: releaseWorkflowFixtureSource }"
  );
  const npmWorkflowWithCompanion = parse(
    '{ kind: "npm.workflow", baseline: releaseWorkflowFixtureSource, mutant: releaseMutationM114, ' +
      "integrity: releaseIntegritySource }"
  );
  if (
    run.problems.length !== 0 ||
    run.value?.companionSlot !== "integrity" ||
    run.value?.companionHandle !== "releaseIntegritySource" ||
    integrity.problems.length !== 0 ||
    integrity.value?.companionSlot !== "run" ||
    integrity.value?.companionHandle !== "registryPublishStepSource" ||
    evaluator.problems.length !== 0 ||
    evaluator.value?.companionSlot !== null ||
    evaluator.value?.companionHandle !== null ||
    npmRelease.problems.length !== 0 ||
    npmRelease.value?.companionSlot !== "integrity" ||
    npmRelease.value?.companionHandle !== "releaseIntegritySource" ||
    npmIntegrity.problems.length !== 0 ||
    npmIntegrity.value?.companionSlot !== "release" ||
    npmIntegrity.value?.companionHandle !== "releaseWorkflowFixtureSource" ||
    npmWorkflow.problems.length !== 0 ||
    npmWorkflow.value?.companionSlot !== null ||
    npmWorkflow.value?.companionHandle !== null ||
    reversedRunCompanion.value !== null ||
    reversedRunCompanion.problems.length === 0 ||
    reversedIntegrityCompanion.value !== null ||
    reversedIntegrityCompanion.problems.length === 0 ||
    reversedNpmReleaseCompanion.value !== null ||
    reversedNpmReleaseCompanion.problems.length === 0 ||
    reversedNpmIntegrityCompanion.value !== null ||
    reversedNpmIntegrityCompanion.problems.length === 0 ||
    npmWorkflowWithCompanion.value !== null ||
    npmWorkflowWithCompanion.problems.length === 0 ||
    nonbindingCompanion.value !== null ||
    nonbindingCompanion.problems.length === 0
  ) {
    problems.push(
      "release mutation declarative invocation parser must preserve exact evaluator and bidirectional " +
        "Registry/NPM companions"
    );
  }
}

function syntheticAdapterReferencesAreExact(
  source: string,
  expectedBindings: readonly ReleaseOracleAdapterBinding[]
): boolean {
  if (expectedBindings.length < 1 || expectedBindings.length > 5) return false;
  const sourceFile = ts.createSourceFile(
    "release-mutation-adapter-helper-control.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const references = new Map(expectedBindings.map((binding) => [binding.binding, [] as ts.Identifier[]]));
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      references.get(node.text as ReleaseOracleAdapterBinding["binding"])?.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return expectedBindings.every((binding) => {
    const candidates = references.get(binding.binding) ?? [];
    return (
      candidates.length === 1 &&
      candidates.every((candidate) => isExactReleaseOracleAdapterReference(candidate, expectedBindings))
    );
  });
}

function validateReleaseOracleAdapterReferenceSemantics(problems: string[]): void {
  const evaluator: readonly ReleaseOracleAdapterBinding[] = [
    { property: "registryEvaluatorProblems", binding: "mcpRegistryEvaluatorProblems" }
  ];
  const step: readonly ReleaseOracleAdapterBinding[] = [
    { property: "registryStepProblems", binding: "mcpRegistryRunProblems" }
  ];
  const npm: readonly ReleaseOracleAdapterBinding[] = [
    { property: "npmContractProblems", binding: "npmProvenanceContractProblems" }
  ];
  const npmEvaluator: readonly ReleaseOracleAdapterBinding[] = [
    { property: "npmEvaluatorProblems", binding: "npmProvenanceEvaluatorProblems" }
  ];
  const npmWorkflow: readonly ReleaseOracleAdapterBinding[] = [
    { property: "npmWorkflowProblems", binding: "npmProvenanceWorkflowProblems" }
  ];
  const combined: readonly ReleaseOracleAdapterBinding[] = [
    ...evaluator,
    ...step,
    ...npm,
    ...npmEvaluator,
    ...npmWorkflow
  ];
  const combinedObject =
    "{ registryEvaluatorProblems: mcpRegistryEvaluatorProblems, registryStepProblems: mcpRegistryRunProblems, " +
    "npmContractProblems: npmProvenanceContractProblems, npmEvaluatorProblems: npmProvenanceEvaluatorProblems, " +
    "npmWorkflowProblems: npmProvenanceWorkflowProblems }";
  if (
    !syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ registryEvaluatorProblems: mcpRegistryEvaluatorProblems });",
      evaluator
    ) ||
    !syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.executeThrough(root, { registryStepProblems: mcpRegistryRunProblems });",
      step
    ) ||
    !syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ npmContractProblems: npmProvenanceContractProblems });",
      npm
    ) ||
    !syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ npmWorkflowProblems: npmProvenanceWorkflowProblems });",
      npmWorkflow
    ) ||
    !syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ npmEvaluatorProblems: npmProvenanceEvaluatorProblems });",
      npmEvaluator
    ) ||
    !syntheticAdapterReferencesAreExact(`releaseMutationPlan.execute(${combinedObject});`, combined) ||
    !syntheticAdapterReferencesAreExact(`releaseMutationPlan.executeThrough(root, ${combinedObject});`, combined) ||
    syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ registryEvaluatorProblems: mcpRegistryRunProblems, " +
        "registryStepProblems: mcpRegistryEvaluatorProblems, " +
        "npmContractProblems: npmProvenanceContractProblems, " +
        "npmEvaluatorProblems: npmProvenanceEvaluatorProblems, " +
        "npmWorkflowProblems: npmProvenanceWorkflowProblems });",
      combined
    ) ||
    syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ npmContractProblems: mcpRegistryRunProblems });",
      npm
    ) ||
    syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ npmWorkflowProblems: npmProvenanceContractProblems });",
      npmWorkflow
    ) ||
    syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ npmEvaluatorProblems: npmProvenanceWorkflowProblems });",
      npmEvaluator
    ) ||
    syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ registryEvaluatorProblems: mcpRegistryEvaluatorProblems });",
      combined
    ) ||
    syntheticAdapterReferencesAreExact(
      "releaseMutationPlan.execute({ npmWorkflowProblems: npmProvenanceWorkflowProblems, " +
        "registryEvaluatorProblems: mcpRegistryEvaluatorProblems, registryStepProblems: mcpRegistryRunProblems, " +
        "npmContractProblems: npmProvenanceContractProblems, " +
        "npmEvaluatorProblems: npmProvenanceEvaluatorProblems });",
      combined
    ) ||
    syntheticAdapterReferencesAreExact("releaseMutationPlan.execute({});", []) ||
    syntheticAdapterReferencesAreExact(`releaseMutationPlan.executeThrough(${combinedObject}, root);`, combined)
  ) {
    problems.push(
      "release mutation adapter reference helper must admit only exact one- through five-adapter " +
        "execute/executeThrough objects"
    );
  }
}

function exactM151TokenDeltaWitnessAnchor(
  id: string,
  value: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  declarations: ReadonlyMap<string, ts.Expression>
): Pick<MutationWitness, "anchor" | "derivation"> | null {
  if (
    id !== "release.m151" ||
    value === undefined ||
    value.getText(sourceFile) !== "MCPB_EXACT_NPM_PUBLISH.slice(0, 512)" ||
    !ts.isCallExpression(value) ||
    value.questionDotToken !== undefined ||
    value.typeArguments !== undefined ||
    value.arguments.length !== 2 ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.questionDotToken !== undefined
  ) {
    return null;
  }
  const receiver = value.expression.expression;
  const start = value.arguments[0];
  const end = value.arguments[1];
  if (
    !ts.isIdentifier(receiver) ||
    receiver.text !== "MCPB_EXACT_NPM_PUBLISH" ||
    value.expression.name.text !== "slice" ||
    start === undefined ||
    !ts.isNumericLiteral(start) ||
    start.text !== "0" ||
    end === undefined ||
    !ts.isNumericLiteral(end) ||
    end.text !== "512"
  ) {
    return null;
  }
  const source = resolveStaticString(receiver, declarations);
  return source === null ? null : { anchor: source.slice(0, 512), derivation: "token-delta" };
}

function exactDeclarativeWitnessProvenance(
  id: string,
  value: ts.Expression | undefined,
  needle: string,
  replacement: string | null,
  sourceFile: ts.SourceFile,
  declarations: ReadonlyMap<string, ts.Expression>
): Pick<MutationWitness, "anchor" | "derivation"> | null {
  if (id === "release.m151") {
    return exactM151TokenDeltaWitnessAnchor(id, value, sourceFile, declarations);
  }
  const anchor = literalStringValue(value, declarations);
  if (anchor === null) return null;
  const matchesNeedle = anchor === needle;
  const matchesReplacement = replacement !== null && anchor === replacement;
  if (matchesNeedle === matchesReplacement) return null;
  return { anchor, derivation: matchesNeedle ? "needle" : "replacement" };
}

function validateDeclarativeWitnessProvenanceSemantics(problems: string[]): void {
  const sourceText = [
    'const MCPB_EXACT_NPM_PUBLISH = "x".repeat(866);',
    "const witness = MCPB_EXACT_NPM_PUBLISH.slice(0, 512);"
  ].join("\n");
  const sourceFile = ts.createSourceFile("witness.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = constDeclarations(sourceFile);
  const value = declarations.get("witness");
  const exact = exactDeclarativeWitnessProvenance(
    "release.m151",
    value,
    "x".repeat(866),
    `${"x".repeat(866)}\n${"x".repeat(866)}`,
    sourceFile,
    declarations
  );
  const drifted = [
    "MCPB_EXACT_NPM_PUBLISH_RUN.slice(0, 512)",
    "MCPB_EXACT_NPM_PUBLISH.slice(1, 512)",
    "MCPB_EXACT_NPM_PUBLISH.slice(0, 511)",
    "MCPB_EXACT_NPM_PUBLISH.slice(0, 5_12)",
    "MCPB_EXACT_NPM_PUBLISH.substring(0, 512)",
    "MCPB_EXACT_NPM_PUBLISH"
  ];
  const driftedAccepted = drifted.some((expression) => {
    const candidate = ts.createSourceFile(
      "witness-drift.ts",
      `const MCPB_EXACT_NPM_PUBLISH = "x".repeat(866);\nconst witness = ${expression};`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const candidateDeclarations = constDeclarations(candidate);
    return (
      exactDeclarativeWitnessProvenance(
        "release.m151",
        candidateDeclarations.get("witness"),
        "x".repeat(866),
        `${"x".repeat(866)}\n${"x".repeat(866)}`,
        candidate,
        candidateDeclarations
      ) !== null
    );
  });
  const transplanted = exactDeclarativeWitnessProvenance(
    "release.m150",
    value,
    "different needle",
    "different replacement",
    sourceFile,
    declarations
  );
  const ambiguousSource = ts.createSourceFile(
    "witness-ambiguous.ts",
    'const witness = "same";',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const ambiguousDeclarations = constDeclarations(ambiguousSource);
  const ambiguous = exactDeclarativeWitnessProvenance(
    "release.m109",
    ambiguousDeclarations.get("witness"),
    "same",
    "same",
    ambiguousSource,
    ambiguousDeclarations
  );
  if (
    exact?.anchor !== "x".repeat(512) ||
    exact.derivation !== "token-delta" ||
    driftedAccepted ||
    transplanted !== null ||
    ambiguous !== null
  ) {
    problems.push(
      "release mutation declarative witness provenance must admit only the exact m151 512-byte slice and reject receiver/start/end/spelling/method/direct/ID drift"
    );
  }
}

function scanHybridDeclarativeMatrix(matrix: MatrixScan, problems: string[]): HybridDeclarativeScan {
  const callbackBody = matrix.callback.body;
  if (!ts.isBlock(callbackBody)) {
    problems.push("release mutation hybrid callback must remain one literal block");
    return { mutations: [], cases: [], executionEvents: [] };
  }
  const statements = callbackBody.statements;
  const mutations: DeclarativeMutationIdentity[] = [];
  const cases: DeclarativeCaseIdentity[] = [];
  const executionEvents: DeclarativeExecutionEvent[] = [];
  const executionCalls: ts.CallExpression[] = [];
  let aliasCount = 0;
  let planCount = 0;
  let sourceCount = 0;
  let planDeclarationIdentifier: ts.Identifier | null = null;
  let planStatementIndex = -1;
  let aliasStatementIndex = -1;
  let sourceStatementIndex = -1;
  let registrySourceStatementIndex = -1;
  let releaseWorkflowSourceStatementIndex = -1;
  let lastRegistrationIndex = -1;
  let sealStatementIndex = -1;
  let topLevelRegisterMutationCalls = 0;
  let topLevelRegisterCaseCalls = 0;
  let topLevelRegisterSourceCalls = 0;
  let sealCount = 0;
  const registrationSequence: string[] = [];
  const registrationStatementIndexes: number[] = [];

  for (let statementIndex = 0; statementIndex < statements.length; statementIndex++) {
    const statement = statements[statementIndex];
    if (statement === undefined || statement.getStart(matrix.sourceFile) < matrix.matrixStart) continue;

    const alias = directTopLevelConst(statement, "releaseIntegrityText");
    if (alias !== null) {
      aliasCount++;
      aliasStatementIndex = statementIndex;
      const initializer = alias.initializer;
      if (
        initializer === undefined ||
        !ts.isPropertyAccessExpression(initializer) ||
        initializer.questionDotToken !== undefined ||
        !ts.isIdentifier(initializer.expression) ||
        initializer.expression.text !== "mcpbInputs" ||
        initializer.name.text !== "integrity"
      ) {
        problems.push("release mutation hybrid alias must be exact const releaseIntegrityText = mcpbInputs.integrity");
      }
    }

    const plan = directTopLevelConst(statement, "releaseMutationPlan");
    if (plan !== null) {
      planCount++;
      planDeclarationIdentifier = plan.name as ts.Identifier;
      planStatementIndex = statementIndex;
      const initializer = plan.initializer;
      if (
        initializer === undefined ||
        !ts.isNewExpression(initializer) ||
        !ts.isIdentifier(initializer.expression) ||
        initializer.expression.text !== "ReleaseMutationPlan" ||
        initializer.typeArguments !== undefined ||
        initializer.arguments === undefined ||
        initializer.arguments.length !== 1
      ) {
        problems.push("release mutation hybrid plan must be one direct ReleaseMutationPlan construction");
      } else {
        const inventory = exactObjectProperties(
          initializer.arguments[0],
          ["total", "first", "all", "cases", "expectations", "roots", "dependencyOnly"],
          "release mutation hybrid plan inventory",
          problems
        );
        const expectedInventory = {
          total: 94,
          first: 91,
          all: 3,
          cases: 91,
          expectations: 91,
          roots: 91,
          dependencyOnly: 3
        } as const;
        if (inventory !== null) {
          for (const [key, expected] of Object.entries(expectedInventory)) {
            const observed = positiveIntegerLiteral(inventory.get(key));
            if (observed !== expected) {
              problems.push(`release mutation hybrid plan inventory ${key} must equal ${expected}`);
            }
          }
        }
      }
    }

    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const sourceCall = directPlanCall(declaration.initializer, "registerSource");
        if (sourceCall !== null) {
          topLevelRegisterSourceCalls++;
          lastRegistrationIndex = statementIndex;
          registrationSequence.push(
            `source:${literalStringValue(sourceCall.arguments[0]) ?? "<unknown>"}:${declaration.name.text}`
          );
          registrationStatementIndexes.push(statementIndex);
          const sourceId = literalStringValue(sourceCall.arguments[0]);
          const sourceValue = sourceCall.arguments[1];
          const exactReleaseIntegritySource =
            declaration.name.text === "releaseIntegritySource" &&
            sourceCall.arguments.length === 2 &&
            sourceId === "script.release-integrity" &&
            sourceValue !== undefined &&
            ts.isIdentifier(sourceValue) &&
            sourceValue.text === "releaseIntegrityText";
          const exactRegistryPublishStepSource =
            declaration.name.text === "registryPublishStepSource" &&
            sourceCall.arguments.length === 2 &&
            sourceId === "workflow.registry-publish-step" &&
            sourceValue !== undefined &&
            ts.isIdentifier(sourceValue) &&
            sourceValue.text === "registryRun";
          const exactReleaseWorkflowFixtureSource =
            declaration.name.text === "releaseWorkflowFixtureSource" &&
            sourceCall.arguments.length === 2 &&
            sourceId === "fixture.release-workflow" &&
            sourceValue !== undefined &&
            ts.isPropertyAccessExpression(sourceValue) &&
            sourceValue.questionDotToken === undefined &&
            ts.isIdentifier(sourceValue.expression) &&
            sourceValue.expression.text === "mcpbInputs" &&
            sourceValue.name.text === "release";
          const exactNpmProvenanceAuditCommandSource =
            declaration.name.text === "npmProvenanceAuditCommandSource" &&
            sourceCall.arguments.length === 2 &&
            sourceId === "fragment.npm-provenance-audit-command" &&
            sourceValue !== undefined &&
            ts.isIdentifier(sourceValue) &&
            sourceValue.text === "NPM_PROVENANCE_AUDIT_COMMAND";
          const exactNpmProvenanceEvaluatorCommandSource =
            declaration.name.text === "npmProvenanceEvaluatorCommandSource" &&
            sourceCall.arguments.length === 2 &&
            sourceId === "fragment.npm-provenance-evaluator-command" &&
            sourceValue !== undefined &&
            ts.isIdentifier(sourceValue) &&
            sourceValue.text === "NPM_PROVENANCE_EVALUATOR_COMMAND";
          if (exactReleaseIntegritySource) {
            sourceCount++;
            sourceStatementIndex = statementIndex;
          } else if (exactRegistryPublishStepSource) {
            sourceCount++;
            registrySourceStatementIndex = statementIndex;
          } else if (exactReleaseWorkflowFixtureSource) {
            sourceCount++;
            releaseWorkflowSourceStatementIndex = statementIndex;
          } else if (exactNpmProvenanceAuditCommandSource) {
            sourceCount++;
          } else if (exactNpmProvenanceEvaluatorCommandSource) {
            sourceCount++;
          } else {
            problems.push(
              "release mutation hybrid sources must bind releaseIntegritySource/script.release-integrity and " +
                "registryPublishStepSource/workflow.registry-publish-step and " +
                "releaseWorkflowFixtureSource/fixture.release-workflow and " +
                "npmProvenanceAuditCommandSource/fragment.npm-provenance-audit-command and " +
                "npmProvenanceEvaluatorCommandSource/fragment.npm-provenance-evaluator-command to their exact source bytes"
            );
          }
        }

        const mutationCall = directPlanCall(declaration.initializer, "registerMutation");
        if (mutationCall === null) continue;
        topLevelRegisterMutationCalls++;
        lastRegistrationIndex = statementIndex;
        const id = literalStringValue(mutationCall.arguments[0]);
        registrationSequence.push(`mutation:${id ?? "<unknown>"}`);
        registrationStatementIndexes.push(statementIndex);
        const descriptor = exactObjectProperties(
          mutationCall.arguments[1],
          ["mode", "source", "needle", "replacement", "expectedOccurrences", "witness"],
          `release mutation hybrid descriptor ${id ?? "<unknown>"}`,
          problems
        );
        if (mutationCall.arguments.length !== 2 || id === null || descriptor === null) continue;
        const mode = literalStringValue(descriptor.get("mode"));
        const sourceHandle = descriptor.get("source");
        const needle = literalStringValue(descriptor.get("needle"), matrix.declarations);
        const replacementExpression = descriptor.get("replacement");
        const replacement =
          replacementExpression !== undefined && ts.isIdentifier(replacementExpression)
            ? null
            : literalStringValue(replacementExpression, matrix.declarations);
        const replacementHandle =
          replacement === null &&
          replacementExpression !== undefined &&
          ts.isIdentifier(replacementExpression) &&
          mutations.some((mutation) => mutation.handle === replacementExpression.text)
            ? replacementExpression.text
            : null;
        const expectedOccurrences = positiveIntegerLiteral(descriptor.get("expectedOccurrences"));
        const witness = exactObjectProperties(
          descriptor.get("witness"),
          ["kind", "anchor", "before", "after"],
          `release mutation hybrid descriptor ${id} witness`,
          problems
        );
        const witnessKind = literalStringValue(witness?.get("kind"));
        const witnessProvenance =
          needle === null
            ? null
            : exactDeclarativeWitnessProvenance(
                id,
                witness?.get("anchor"),
                needle,
                replacement,
                matrix.sourceFile,
                matrix.declarations
              );
        const witnessBefore = nonNegativeIntegerLiteral(witness?.get("before"));
        const witnessAfter = nonNegativeIntegerLiteral(witness?.get("after"));
        if (
          (mode !== "first" && mode !== "all") ||
          sourceHandle === undefined ||
          !ts.isIdentifier(sourceHandle) ||
          needle === null ||
          (replacement === null) === (replacementHandle === null) ||
          expectedOccurrences === null ||
          (witnessKind !== "token" && witnessKind !== "line") ||
          witnessProvenance === null ||
          witnessBefore === null ||
          witnessAfter === null ||
          witnessBefore === witnessAfter
        ) {
          problems.push(`release mutation hybrid descriptor ${id} must contain exact literal passive values`);
          continue;
        }
        mutations.push({
          id,
          handle: declaration.name.text,
          mode,
          sourceHandle: sourceHandle.text,
          needle,
          replacement,
          replacementHandle,
          expectedOccurrences,
          witness: {
            kind: witnessKind,
            anchor: witnessProvenance.anchor,
            before: witnessBefore,
            after: witnessAfter,
            derivation: witnessProvenance.derivation
          }
        });
      }
    }

    if (ts.isExpressionStatement(statement)) {
      const caseCall = directPlanCall(statement.expression, "registerCase");
      if (caseCall !== null) {
        topLevelRegisterCaseCalls++;
        lastRegistrationIndex = statementIndex;
        const identityCase = exactObjectProperties(
          caseCall.arguments[0],
          ["id", "root", "checks"],
          "release mutation hybrid case",
          problems
        );
        const id = literalStringValue(identityCase?.get("id"));
        registrationSequence.push(`case:${id ?? "<unknown>"}`);
        registrationStatementIndexes.push(statementIndex);
        if (caseCall.arguments.length !== 1 || identityCase === null) continue;
        const root = identityCase.get("root");
        const checks = identityCase.get("checks");
        if (
          id === null ||
          root === undefined ||
          !ts.isIdentifier(root) ||
          checks === undefined ||
          !ts.isArrayLiteralExpression(checks) ||
          checks.elements.length !== 1
        ) {
          problems.push("release mutation hybrid case must have literal id/root and exactly one check");
          continue;
        }
        const checkElement = checks.elements[0];
        const check =
          checkElement !== undefined && !ts.isSpreadElement(checkElement)
            ? exactObjectProperties(
                checkElement,
                ["invoke", "expectation"],
                `release mutation hybrid case ${id}`,
                problems
              )
            : null;
        if (check === null) continue;
        const invocation = parseDeclarativeInvocation(
          check.get("invoke"),
          `release mutation hybrid case ${id} invocation`,
          problems
        );
        const expectation = exactObjectProperties(
          check.get("expectation"),
          ["id", "kind", "problem"],
          `release mutation hybrid case ${id} expectation`,
          problems
        );
        if (invocation === null || expectation === null) continue;
        const expectationId = literalStringValue(expectation.get("id"));
        const expectationKind = literalStringValue(expectation.get("kind"));
        const problem = literalStringValue(expectation.get("problem"));
        if (expectationId === null || expectationKind !== "problem" || problem === null) {
          problems.push(`release mutation hybrid case ${id} must contain one exact literal problem check`);
          continue;
        }
        cases.push({
          id,
          handle: root.text,
          invocationKind: invocation.invocationKind,
          baselineHandle: invocation.baselineHandle,
          companionHandle: invocation.companionHandle,
          companionSlot: invocation.companionSlot,
          checkCount: checks.elements.length,
          mutantHandle: invocation.mutantHandle,
          expectationId,
          problem
        });
      }

      for (const kind of ["execute", "executeThrough", "executeRemaining"] as const) {
        const executionCall = directPlanCall(statement.expression, kind);
        if (executionCall === null) continue;
        const boundary = executionCall.arguments[0];
        const boundaryHandle =
          kind === "executeThrough" && boundary !== undefined && ts.isIdentifier(boundary) ? boundary.text : null;
        executionEvents.push({
          anchor: executionCall.getStart(matrix.sourceFile),
          boundaryHandle,
          kind,
          statementIndex
        });
        executionCalls.push(executionCall);
      }
    }

    const seal = directTopLevelConst(statement, "releaseMutationProblems");
    const sealCall = seal === null ? null : directPlanCall(seal.initializer, "seal");
    if (sealCall !== null) {
      sealCount++;
      sealStatementIndex = statementIndex;
      if (sealCall.arguments.length !== 0) {
        problems.push("release mutation hybrid seal must be one direct zero-argument call");
      }
    }
  }

  let allRegisterMutationCalls = 0;
  let allRegisterCaseCalls = 0;
  let allRegisterSourceCalls = 0;
  let allSealCalls = 0;
  let allExecutionMemberReferences = 0;
  let computedPlanMemberReferences = 0;
  let indirectPlanReferences = 0;
  const executionMethodNames = new Set<DeclarativeExecutionKind>(["execute", "executeRemaining", "executeThrough"]);
  const visitRegistrations = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "releaseMutationPlan") {
      const parent = node.parent;
      if (node === planDeclarationIdentifier) {
        // The one reviewed declaration is the only allowed bare plan identifier.
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (executionMethodNames.has(parent.name.text as DeclarativeExecutionKind)) {
          allExecutionMemberReferences++;
        }
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        computedPlanMemberReferences++;
      } else {
        indirectPlanReferences++;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      if (ts.isIdentifier(receiver) && receiver.text === "releaseMutationPlan") {
        if (node.expression.name.text === "registerMutation") allRegisterMutationCalls++;
        if (node.expression.name.text === "registerCase") allRegisterCaseCalls++;
        if (node.expression.name.text === "registerSource") allRegisterSourceCalls++;
        if (node.expression.name.text === "seal") allSealCalls++;
      }
    }
    ts.forEachChild(node, visitRegistrations);
  };
  visitRegistrations(matrix.callback.body);
  if (
    allRegisterMutationCalls !== topLevelRegisterMutationCalls ||
    allRegisterCaseCalls !== topLevelRegisterCaseCalls ||
    allRegisterSourceCalls !== topLevelRegisterSourceCalls
  ) {
    problems.push("release mutation hybrid registrations must all be direct top-level straight-line statements");
  }
  if (
    allExecutionMemberReferences !== executionEvents.length ||
    computedPlanMemberReferences !== 0 ||
    indirectPlanReferences !== 0
  ) {
    problems.push("release mutation hybrid execution events must be exact direct top-level property calls");
  }
  if (aliasCount !== 1 || planCount !== 1 || sourceCount !== 5) {
    problems.push(
      `release mutation hybrid prelude requires one exact alias/plan and five exact sources; ` +
        `found ${aliasCount}/${planCount}/${sourceCount}`
    );
  }
  const expectedRegistrationSequence = [
    "source:script.release-integrity:releaseIntegritySource",
    ...MIGRATED_REGISTRY_EVALUATOR_IDS.flatMap((id) => [
      `mutation:${id}`,
      `case:${id.replace("release.", "release.case.")}`
    ]),
    "source:workflow.registry-publish-step:registryPublishStepSource",
    "mutation:release.m108",
    ...[...MIGRATED_REGISTRY_RUN_IDS, ...MIGRATED_REGISTRY_STEP_INTEGRITY_IDS].flatMap((id) => [
      `mutation:${id}`,
      `case:${id.replace("release.", "release.case.")}`
    ]),
    "source:fixture.release-workflow:releaseWorkflowFixtureSource",
    ...[
      ...MIGRATED_NPM_CONTRACT_RELEASE_IDS,
      ...MIGRATED_NPM_CONTRACT_INTEGRITY_IDS,
      ...MIGRATED_NPM_WORKFLOW_PREFIX_IDS
    ].flatMap((id) => [`mutation:${id}`, `case:${id.replace("release.", "release.case.")}`]),
    "source:fragment.npm-provenance-audit-command:npmProvenanceAuditCommandSource",
    "mutation:release.m140",
    "mutation:release.m139",
    "case:release.case.m139",
    "mutation:release.m141",
    "case:release.case.m141",
    "mutation:release.m142",
    "case:release.case.m142",
    "mutation:release.m143",
    "case:release.case.m143",
    "source:fragment.npm-provenance-evaluator-command:npmProvenanceEvaluatorCommandSource",
    "mutation:release.m145",
    "mutation:release.m144",
    "case:release.case.m144",
    "mutation:release.m146",
    "case:release.case.m146",
    "mutation:release.m147",
    "case:release.case.m147",
    "mutation:release.m148",
    "case:release.case.m148",
    "mutation:release.m149",
    "case:release.case.m149",
    "mutation:release.m150",
    "case:release.case.m150",
    "mutation:release.m151",
    "case:release.case.m151",
    "mutation:release.m152",
    "case:release.case.m152",
    "mutation:release.m153",
    "case:release.case.m153",
    "mutation:release.m154",
    "case:release.case.m154",
    "mutation:release.m155",
    "case:release.case.m155",
    "mutation:release.m156",
    "case:release.case.m156",
    "mutation:release.m157",
    "case:release.case.m157",
    "mutation:release.m158",
    "case:release.case.m158",
    "mutation:release.m159",
    "case:release.case.m159",
    "mutation:release.m160",
    "case:release.case.m160",
    "mutation:release.m161",
    "case:release.case.m161",
    "mutation:release.m162",
    "case:release.case.m162",
    "mutation:release.m163",
    "case:release.case.m163",
    "mutation:release.m164",
    "case:release.case.m164"
  ];
  const evaluatorRegistrationCount = 1 + MIGRATED_REGISTRY_EVALUATOR_IDS.length * 2;
  const registryStepRegistrationCount =
    2 + (MIGRATED_REGISTRY_RUN_IDS.length + MIGRATED_REGISTRY_STEP_INTEGRITY_IDS.length) * 2;
  const npmRegistrationCount =
    1 +
    (MIGRATED_NPM_CONTRACT_RELEASE_IDS.length +
      MIGRATED_NPM_CONTRACT_INTEGRITY_IDS.length +
      MIGRATED_NPM_WORKFLOW_PREFIX_IDS.length) *
      2 +
    52;
  const straightLineEvaluatorRegistrations = registrationStatementIndexes
    .slice(0, evaluatorRegistrationCount)
    .every((statementIndex, index) => statementIndex === sourceStatementIndex + index);
  const straightLineRegistryStepRegistrations = registrationStatementIndexes
    .slice(evaluatorRegistrationCount, evaluatorRegistrationCount + registryStepRegistrationCount)
    .every((statementIndex, index) => statementIndex === registrySourceStatementIndex + index);
  const straightLineNpmRegistrations = registrationStatementIndexes
    .slice(evaluatorRegistrationCount + registryStepRegistrationCount)
    .every((statementIndex, index) => statementIndex === releaseWorkflowSourceStatementIndex + index);
  const straightLineRegistrations =
    registrationStatementIndexes.length ===
      evaluatorRegistrationCount + registryStepRegistrationCount + npmRegistrationCount &&
    straightLineEvaluatorRegistrations &&
    straightLineRegistryStepRegistrations &&
    straightLineNpmRegistrations;
  const registrationSequenceMismatch = registrationSequence.findIndex(
    (entry, index) => entry !== expectedRegistrationSequence[index]
  );
  const registrationSequenceExact =
    registrationSequenceMismatch === -1 && registrationSequence.length === expectedRegistrationSequence.length;
  if (!registrationSequenceExact || !straightLineRegistrations) {
    const mismatchIndex =
      registrationSequenceMismatch === -1
        ? Math.min(registrationSequence.length, expectedRegistrationSequence.length)
        : registrationSequenceMismatch;
    const expectedEntry = expectedRegistrationSequence[mismatchIndex] ?? "<none>";
    const observedEntry = registrationSequence[mismatchIndex] ?? "<none>";
    problems.push(
      "release mutation hybrid registrations must be exact contiguous source/m002-m037 and " +
        "source/m108 dependency/m107,m109-m111 mutation/case and source/m112-m138 mutation/case then " +
        "fragment source/m140 dependency/m139 mutation/case then m141-m143 mutation/case and " +
        "fragment source/m145 dependency/m144 mutation/case then m146-m164 mutation/case sequences; " +
        `first mismatch ${mismatchIndex + 1}: expected ${expectedEntry}, found ${observedEntry}`
    );
  }
  if (
    planStatementIndex < 0 ||
    aliasStatementIndex < 0 ||
    sourceStatementIndex < 0 ||
    aliasStatementIndex + 1 !== planStatementIndex ||
    planStatementIndex + 1 !== sourceStatementIndex
  ) {
    problems.push("release mutation hybrid prelude must be the exact contiguous alias, plan, source sequence");
  }
  const baselineAssertion = exactExpectMatcher(statements[aliasStatementIndex - 1], "toEqual");
  const baselineDetector = baselineAssertion?.actual;
  const baselineInput =
    baselineDetector !== undefined && ts.isCallExpression(baselineDetector) ? baselineDetector.arguments[0] : undefined;
  const exactBaselineAssertion =
    baselineAssertion !== null &&
    baselineDetector !== undefined &&
    ts.isCallExpression(baselineDetector) &&
    baselineDetector.questionDotToken === undefined &&
    baselineDetector.typeArguments === undefined &&
    ts.isIdentifier(baselineDetector.expression) &&
    baselineDetector.expression.text === "mcpRegistryEvaluatorProblems" &&
    baselineDetector.arguments.length === 1 &&
    baselineInput !== undefined &&
    ts.isPropertyAccessExpression(baselineInput) &&
    baselineInput.questionDotToken === undefined &&
    ts.isIdentifier(baselineInput.expression) &&
    baselineInput.expression.text === "mcpbInputs" &&
    baselineInput.name.text === "integrity" &&
    ts.isArrayLiteralExpression(baselineAssertion.expected) &&
    baselineAssertion.expected.elements.length === 0;
  if (!exactBaselineAssertion) {
    problems.push("release mutation hybrid prelude must start with one exact clean registry evaluator assertion");
  }
  const exactMcpbInput = (value: ts.Expression | undefined, property: string): boolean =>
    value !== undefined &&
    ts.isPropertyAccessExpression(value) &&
    value.questionDotToken === undefined &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "mcpbInputs" &&
    value.name.text === property;
  const npmEvaluatorBaselineAssertion = exactExpectMatcher(statements[aliasStatementIndex - 2], "toEqual");
  const npmEvaluatorBaselineDetector = npmEvaluatorBaselineAssertion?.actual;
  const npmEvaluatorIntegrityInput =
    npmEvaluatorBaselineDetector !== undefined && ts.isCallExpression(npmEvaluatorBaselineDetector)
      ? npmEvaluatorBaselineDetector.arguments[0]
      : undefined;
  const exactNpmEvaluatorBaselineAssertion =
    npmEvaluatorBaselineAssertion !== null &&
    npmEvaluatorBaselineDetector !== undefined &&
    ts.isCallExpression(npmEvaluatorBaselineDetector) &&
    npmEvaluatorBaselineDetector.questionDotToken === undefined &&
    npmEvaluatorBaselineDetector.typeArguments === undefined &&
    ts.isIdentifier(npmEvaluatorBaselineDetector.expression) &&
    npmEvaluatorBaselineDetector.expression.text === "npmProvenanceEvaluatorProblems" &&
    npmEvaluatorBaselineDetector.arguments.length === 1 &&
    exactMcpbInput(npmEvaluatorIntegrityInput, "integrity") &&
    ts.isArrayLiteralExpression(npmEvaluatorBaselineAssertion.expected) &&
    npmEvaluatorBaselineAssertion.expected.elements.length === 0;
  if (!exactNpmEvaluatorBaselineAssertion) {
    problems.push("release mutation hybrid prelude must retain one exact clean npm provenance evaluator assertion");
  }
  const npmBaselineAssertion = exactExpectMatcher(statements[aliasStatementIndex - 3], "toEqual");
  const npmBaselineDetector = npmBaselineAssertion?.actual;
  const npmReleaseInput =
    npmBaselineDetector !== undefined && ts.isCallExpression(npmBaselineDetector)
      ? npmBaselineDetector.arguments[0]
      : undefined;
  const npmIntegrityInput =
    npmBaselineDetector !== undefined && ts.isCallExpression(npmBaselineDetector)
      ? npmBaselineDetector.arguments[1]
      : undefined;
  const exactNpmBaselineAssertion =
    npmBaselineAssertion !== null &&
    npmBaselineDetector !== undefined &&
    ts.isCallExpression(npmBaselineDetector) &&
    npmBaselineDetector.questionDotToken === undefined &&
    npmBaselineDetector.typeArguments === undefined &&
    ts.isIdentifier(npmBaselineDetector.expression) &&
    npmBaselineDetector.expression.text === "npmProvenanceContractProblems" &&
    npmBaselineDetector.arguments.length === 2 &&
    exactMcpbInput(npmReleaseInput, "release") &&
    exactMcpbInput(npmIntegrityInput, "integrity") &&
    ts.isArrayLiteralExpression(npmBaselineAssertion.expected) &&
    npmBaselineAssertion.expected.elements.length === 0;
  if (!exactNpmBaselineAssertion) {
    problems.push("release mutation hybrid prelude must retain one exact clean npm provenance contract assertion");
  }
  const registryBaselineAssertion = exactExpectMatcher(statements[registrySourceStatementIndex - 1], "toEqual");
  const registryBaselineDetector = registryBaselineAssertion?.actual;
  const exactRegistryBaselineAssertion =
    registryBaselineAssertion !== null &&
    registryBaselineDetector !== undefined &&
    ts.isCallExpression(registryBaselineDetector) &&
    registryBaselineDetector.questionDotToken === undefined &&
    registryBaselineDetector.typeArguments === undefined &&
    ts.isIdentifier(registryBaselineDetector.expression) &&
    registryBaselineDetector.expression.text === "mcpRegistryRunProblems" &&
    registryBaselineDetector.arguments.length === 2 &&
    registryBaselineDetector.arguments[0] !== undefined &&
    ts.isIdentifier(registryBaselineDetector.arguments[0]) &&
    registryBaselineDetector.arguments[0].text === "registryRun" &&
    registryBaselineDetector.arguments[1] !== undefined &&
    ts.isPropertyAccessExpression(registryBaselineDetector.arguments[1]) &&
    registryBaselineDetector.arguments[1].questionDotToken === undefined &&
    ts.isIdentifier(registryBaselineDetector.arguments[1].expression) &&
    registryBaselineDetector.arguments[1].expression.text === "mcpbInputs" &&
    registryBaselineDetector.arguments[1].name.text === "integrity" &&
    ts.isArrayLiteralExpression(registryBaselineAssertion.expected) &&
    registryBaselineAssertion.expected.elements.length === 0;
  if (!exactRegistryBaselineAssertion) {
    problems.push(
      "release mutation hybrid Registry-step source must immediately follow one exact clean registry run assertion"
    );
  }

  const sealAssertion = exactExpectMatcher(statements[sealStatementIndex + 1], "toEqual");
  const exactSealAssertion =
    sealAssertion !== null &&
    ts.isIdentifier(sealAssertion.actual) &&
    sealAssertion.actual.text === "releaseMutationProblems" &&
    ts.isArrayLiteralExpression(sealAssertion.expected) &&
    sealAssertion.expected.elements.length === 0;
  const exactPhaseAt = (statementIndex: number, phase: string): boolean => {
    const assertion = exactExpectMatcher(statements[statementIndex], "toBe");
    return (
      assertion !== null &&
      exactPlanStatusAccess(assertion.actual, "phase") &&
      literalStringValue(assertion.expected) === phase
    );
  };
  const exactExecutionCountAt = (statementIndex: number, property: string, expected: number): boolean => {
    const assertion = exactExpectMatcher(statements[statementIndex], "toBe");
    return (
      assertion !== null &&
      exactPlanStatusAccess(assertion.actual, property) &&
      positiveIntegerLiteral(assertion.expected) === expected
    );
  };

  let hasClosedInvocationKinds = true;
  let requiresRegistryEvaluatorProblems = false;
  let requiresRegistryStepProblems = false;
  let requiresNpmContractProblems = false;
  let requiresNpmEvaluatorProblems = false;
  let requiresNpmWorkflowProblems = false;
  for (const identityCase of cases) {
    switch (identityCase.invocationKind) {
      case "registry.evaluator":
        requiresRegistryEvaluatorProblems = true;
        break;
      case "registry.step.integrity":
      case "registry.step.run":
        requiresRegistryStepProblems = true;
        break;
      case "npm.contract.integrity":
      case "npm.contract.release":
        requiresNpmContractProblems = true;
        break;
      case "npm.evaluator":
        requiresNpmEvaluatorProblems = true;
        break;
      case "npm.workflow":
        requiresNpmWorkflowProblems = true;
        break;
      case "fixture.text":
      case "fixture.throw":
        break;
      default:
        hasClosedInvocationKinds = false;
        problems.push(
          `release mutation hybrid case ${identityCase.id} invocation kind must belong to the closed adapter inventory`
        );
    }
  }
  const requiredAdapterBindings = requiredReleaseOracleAdapterBindings(cases);
  const requiredAdapterKeys = requiredAdapterBindings.map((binding) => binding.property);
  const exactExecutionArguments = (
    call: ts.CallExpression,
    kind: DeclarativeExecutionKind,
    adapterArgumentIndex: number
  ): boolean => {
    const expectedArgumentCount = adapterArgumentIndex + (requiredAdapterKeys.length === 0 ? 0 : 1);
    let exact = call.arguments.length === expectedArgumentCount;
    if (kind === "executeThrough") {
      const boundary = call.arguments[0];
      exact = exact && boundary !== undefined && ts.isIdentifier(boundary);
    }
    if (requiredAdapterKeys.length === 0) {
      if (!exact) {
        problems.push(`release mutation hybrid ${kind} event must use the exact staged execution argument shape`);
      }
      return exact;
    }

    const adapters = exactObjectProperties(
      call.arguments[adapterArgumentIndex],
      requiredAdapterKeys,
      `release mutation hybrid ${kind} adapters`,
      problems
    );
    exact = exact && exactReleaseOracleAdapterObject(call.arguments[adapterArgumentIndex], requiredAdapterBindings);
    if (requiresRegistryEvaluatorProblems) {
      const adapter = adapters?.get("registryEvaluatorProblems");
      const exactAdapter =
        adapter !== undefined && ts.isIdentifier(adapter) && adapter.text === "mcpRegistryEvaluatorProblems";
      if (!exactAdapter) {
        problems.push(
          "release mutation hybrid execute adapter must bind registryEvaluatorProblems exactly to " +
            "mcpRegistryEvaluatorProblems"
        );
      }
      exact = exact && exactAdapter;
    }
    if (requiresRegistryStepProblems) {
      const adapter = adapters?.get("registryStepProblems");
      const exactAdapter =
        adapter !== undefined && ts.isIdentifier(adapter) && adapter.text === "mcpRegistryRunProblems";
      if (!exactAdapter) {
        problems.push(
          "release mutation hybrid execute adapter must bind registryStepProblems exactly to mcpRegistryRunProblems"
        );
      }
      exact = exact && exactAdapter;
    }
    if (requiresNpmContractProblems) {
      const adapter = adapters?.get("npmContractProblems");
      const exactAdapter =
        adapter !== undefined && ts.isIdentifier(adapter) && adapter.text === "npmProvenanceContractProblems";
      if (!exactAdapter) {
        problems.push(
          "release mutation hybrid execute adapter must bind npmContractProblems exactly to " +
            "npmProvenanceContractProblems"
        );
      }
      exact = exact && exactAdapter;
    }
    if (requiresNpmEvaluatorProblems) {
      const adapter = adapters?.get("npmEvaluatorProblems");
      const exactAdapter =
        adapter !== undefined && ts.isIdentifier(adapter) && adapter.text === "npmProvenanceEvaluatorProblems";
      if (!exactAdapter) {
        problems.push(
          "release mutation hybrid execute adapter must bind npmEvaluatorProblems exactly to " +
            "npmProvenanceEvaluatorProblems"
        );
      }
      exact = exact && exactAdapter;
    }
    if (requiresNpmWorkflowProblems) {
      const adapter = adapters?.get("npmWorkflowProblems");
      const exactAdapter =
        adapter !== undefined && ts.isIdentifier(adapter) && adapter.text === "npmProvenanceWorkflowProblems";
      if (!exactAdapter) {
        problems.push(
          "release mutation hybrid execute adapter must bind npmWorkflowProblems exactly to " +
            "npmProvenanceWorkflowProblems"
        );
      }
      exact = exact && exactAdapter;
    }
    if (!exact) {
      problems.push(`release mutation hybrid ${kind} event must use the exact staged execution argument shape`);
    }
    return exact;
  };
  const exactExecuteRemainingArguments = (call: ts.CallExpression): boolean => {
    const exact = call.arguments.length === 0;
    if (!exact) {
      problems.push(
        "release mutation hybrid executeRemaining event must use the exact staged execution argument shape"
      );
    }
    return exact;
  };

  const totalCaseCount = cases.length;
  const totalExpectationCount = cases.reduce((total, identityCase) => total + identityCase.checkCount, 0);
  const lifecycleStart = sealStatementIndex + 2;
  const commonLifecycle =
    sealCount === 1 && allSealCalls === 1 && sealStatementIndex === lastRegistrationIndex + 1 && exactSealAssertion;

  let exactStagedLifecycle = false;
  if (executionEvents.length === 2 && executionCalls.length === 2) {
    const prefixEvent = executionEvents[0];
    const remainingEvent = executionEvents[1];
    const prefixCall = executionCalls[0];
    const remainingCall = executionCalls[1];
    if (
      prefixEvent !== undefined &&
      remainingEvent !== undefined &&
      prefixCall !== undefined &&
      remainingCall !== undefined &&
      prefixEvent.kind === "executeThrough" &&
      remainingEvent.kind === "executeRemaining"
    ) {
      const boundaryIndexes = cases.flatMap((identityCase, index) =>
        identityCase.handle === prefixEvent.boundaryHandle ? [index] : []
      );
      const boundaryIndex = boundaryIndexes.length === 1 ? boundaryIndexes[0] : undefined;
      const prefixCaseCount = boundaryIndex === undefined ? 0 : boundaryIndex + 1;
      const prefixExpectationCount =
        boundaryIndex === undefined
          ? 0
          : cases.slice(0, boundaryIndex + 1).reduce((total, identityCase) => total + identityCase.checkCount, 0);
      const remainingStatementIndex = remainingEvent.statementIndex;
      exactStagedLifecycle =
        boundaryIndex !== undefined &&
        boundaryIndex < cases.length - 1 &&
        prefixEvent.boundaryHandle === "releaseMutationM037" &&
        prefixEvent.statementIndex === lifecycleStart &&
        remainingStatementIndex > lifecycleStart + 3 &&
        exactExecutionArguments(prefixCall, "executeThrough", 1) &&
        exactExecuteRemainingArguments(remainingCall) &&
        exactPhaseAt(lifecycleStart + 1, "partially-executed") &&
        exactExecutionCountAt(lifecycleStart + 2, "caseExecutions", prefixCaseCount) &&
        exactExecutionCountAt(lifecycleStart + 3, "expectationExecutions", prefixExpectationCount) &&
        exactPhaseAt(remainingStatementIndex + 1, "executed") &&
        exactExecutionCountAt(remainingStatementIndex + 2, "caseExecutions", totalCaseCount) &&
        exactExecutionCountAt(remainingStatementIndex + 3, "expectationExecutions", totalExpectationCount);
    }
  }

  if (!commonLifecycle || !hasClosedInvocationKinds || !exactStagedLifecycle) {
    problems.push(
      "release mutation hybrid lifecycle must be one clean seal followed by the exact m037 " +
        "executeThrough/executeRemaining pair with derived phase and execution censuses"
    );
  }
  return { mutations, cases, executionEvents };
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
  if (JSON.stringify(manifest.generatedFrom.rawExpressionShape) !== JSON.stringify(EXPECTED_RAW_EXPRESSION_SHAPE)) {
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

function validateRawExpressionShape(matrix: MatrixScan, problems: string[], requireFrozenCensus = true): void {
  const observed = {
    classifier: "outer-expression-v1" as const,
    source: { identifier: 0, nestedCall: 0 },
    needle: { literal: 0, identifier: 0, concatenation: 0 },
    replacement: { literal: 0, concatenation: 0, nestedCall: 0, identifier: 0 },
    expectedOccurrences: { integer: 0, identifier: 0, sum: 0 }
  };
  const isBindingReference = (expression: ts.Expression): boolean =>
    ts.isIdentifier(expression) ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.questionDotToken === undefined &&
      isBindingReference(expression.expression));
  const isStringTemplateForm = (expression: ts.Expression): boolean =>
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isTemplateExpression(expression);
  const isConcatenation = (expression: ts.Expression): boolean =>
    ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const isNestedMutationCall = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression) &&
    expression.questionDotToken === undefined &&
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === "replaceExactly" || expression.expression.text === "replaceAllExactly");
  for (const call of matrix.calls) {
    const source = call.node.arguments[0];
    if (source !== undefined && isBindingReference(source)) observed.source.identifier++;
    else if (source !== undefined && isNestedMutationCall(source)) observed.source.nestedCall++;
    else problems.push(`legacy source expression at ${call.span.start} is outside outer-expression-v1`);

    const needle = call.node.arguments[1];
    if (needle !== undefined && isStringTemplateForm(needle)) {
      observed.needle.literal++;
    } else if (needle !== undefined && ts.isIdentifier(needle)) {
      observed.needle.identifier++;
    } else if (needle !== undefined && isConcatenation(needle)) {
      observed.needle.concatenation++;
    } else {
      problems.push(`legacy needle expression at ${call.span.start} is outside outer-expression-v1`);
    }

    const replacement = call.node.arguments[2];
    if (replacement !== undefined && isStringTemplateForm(replacement)) {
      observed.replacement.literal++;
    } else if (replacement !== undefined && ts.isIdentifier(replacement)) {
      observed.replacement.identifier++;
    } else if (replacement !== undefined && isNestedMutationCall(replacement)) {
      observed.replacement.nestedCall++;
    } else if (replacement !== undefined && isConcatenation(replacement)) {
      observed.replacement.concatenation++;
    } else {
      problems.push(`legacy replacement expression at ${call.span.start} is outside outer-expression-v1`);
    }

    const occurrences = call.node.arguments[3];
    if (occurrences === undefined || ts.isNumericLiteral(occurrences)) observed.expectedOccurrences.integer++;
    else if (ts.isIdentifier(occurrences)) observed.expectedOccurrences.identifier++;
    else if (ts.isBinaryExpression(occurrences) && occurrences.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      observed.expectedOccurrences.sum++;
    } else {
      problems.push(`legacy expectedOccurrences at ${call.span.start} is outside outer-expression-v1`);
    }
  }
  if (requireFrozenCensus && JSON.stringify(observed) !== JSON.stringify(EXPECTED_RAW_EXPRESSION_SHAPE)) {
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
  const declarations = matrix.declarations;
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

  if (!ts.isBlock(matrix.callback.body)) {
    problems.push("release mutation hybrid matrix callback must retain its exact block body");
    return false;
  }

  const mcpbInputProperties = new Set<string>();
  let mcpbInputDeclarations = 0;
  let exactFrozenMcpbInputObjects = 0;
  let mcpbInputPropertyNodes = 0;
  let unsupportedMcpbInputProperties = 0;
  let exactIntegrityReads = 0;
  for (const statement of matrix.callback.body.statements) {
    const declaration = directTopLevelConst(statement, "mcpbInputs");
    if (declaration === null) continue;
    mcpbInputDeclarations++;
    const initializer = declaration.initializer;
    const freezeCall =
      initializer !== undefined &&
      ts.isCallExpression(initializer) &&
      initializer.questionDotToken === undefined &&
      initializer.typeArguments === undefined &&
      ts.isPropertyAccessExpression(initializer.expression) &&
      initializer.expression.questionDotToken === undefined &&
      ts.isIdentifier(initializer.expression.expression) &&
      initializer.expression.expression.text === "Object" &&
      initializer.expression.name.text === "freeze" &&
      initializer.arguments.length === 1
        ? initializer
        : null;
    const object = freezeCall?.arguments[0];
    if (object === undefined || !ts.isObjectLiteralExpression(object)) continue;
    exactFrozenMcpbInputObjects++;
    for (const property of object.properties) {
      mcpbInputPropertyNodes++;
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
        if (key === null) {
          unsupportedMcpbInputProperties++;
          continue;
        }
        mcpbInputProperties.add(`mcpbInputs.${key}`);
        if (
          key === "integrity" &&
          ts.isPropertyAssignment(property) &&
          property.initializer.getText(matrix.sourceFile) ===
            'readFileSync(new URL("../scripts/check-release-integrity.mjs", import.meta.url), "utf8")'
        ) {
          exactIntegrityReads++;
        }
      } else unsupportedMcpbInputProperties++;
    }
  }
  const requiredMcpbInputProperties: ReadonlySet<string> = new Set(REQUIRED_PEER_ALIASES);
  const missingMcpbInputProperties = REQUIRED_PEER_ALIASES.filter((peer) => !mcpbInputProperties.has(peer));
  const unexpectedMcpbInputProperties = [...mcpbInputProperties].filter(
    (peer) => !requiredMcpbInputProperties.has(peer)
  );
  if (
    mcpbInputDeclarations !== 1 ||
    exactFrozenMcpbInputObjects !== 1 ||
    mcpbInputPropertyNodes !== REQUIRED_PEER_ALIASES.length ||
    unsupportedMcpbInputProperties !== 0 ||
    exactIntegrityReads !== 1
  ) {
    problems.push(
      `release mutation hybrid mcpbInputs must be one exact frozen source object with ` +
        `${REQUIRED_PEER_ALIASES.length} direct reviewed properties and one direct integrity file read; found ` +
        `${mcpbInputDeclarations}/${exactFrozenMcpbInputObjects}/${mcpbInputPropertyNodes}/` +
        `${unsupportedMcpbInputProperties}/${exactIntegrityReads}`
    );
  }
  if (
    mcpbInputProperties.size !== REQUIRED_PEER_ALIASES.length ||
    missingMcpbInputProperties.length !== 0 ||
    unexpectedMcpbInputProperties.length !== 0
  ) {
    problems.push(
      `release matrix mcpbInputs peer inventory must contain the exact ${REQUIRED_PEER_ALIASES.length} reviewed ` +
        `properties; found ${mcpbInputProperties.size}, missing ${missingMcpbInputProperties.join(", ") || "none"}, ` +
        `unexpected ${unexpectedMcpbInputProperties.join(", ") || "none"}`
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
  const declarations = matrix.declarations;
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
    .join(`\${{ github.repository }}`)
    .split("$MCPB_RELEASE_CHANNEL")
    .join(`\${{ steps.dist_tag.outputs.tag }}`);
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
  const declarations = matrix.declarations;
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
      value =
        declarationName === undefined ? null : resolveStaticString(declarations.get(declarationName), declarations);
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
    JSON.stringify(proofCounts(rawWorkflow, `\${{ github.repository }}`)) !== JSON.stringify([8, 4, 4, 4, 4])
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
    JSON.stringify(proofCounts(combinedWorkflow, `\${{ github.repository }}`)) !== JSON.stringify([10, 5, 5, 5, 5])
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
    if ((!startsToken || !isWitnessTokenCharacter(before)) && (!endsToken || !isWitnessTokenCharacter(after))) {
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

function exactM151TokenDeltaWitnessSemantics(mutation: MutationIdentity, needle: string): boolean {
  return (
    mutation.id === "release.m151" &&
    mutation.witness.derivation === "token-delta" &&
    mutation.witness.kind === "token" &&
    mutation.witness.anchor === needle.slice(0, 512) &&
    Buffer.byteLength(mutation.witness.anchor, "utf8") === 512 &&
    mutation.witness.before === 1 &&
    mutation.witness.after === 2
  );
}

function validateMaterializedMutationValues(
  manifest: IdentityManifest,
  sourceValues: ReadonlyMap<string, string>,
  problems: string[]
): void {
  const mutationValues = new Map<string, string>();
  for (const mutation of manifest.mutations) {
    const sourceValue =
      mutation.source.kind === "source" ? sourceValues.get(mutation.source.id) : mutationValues.get(mutation.source.id);
    const replacement =
      mutation.replacementDependency === null
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
    if (mutation.id === "release.m151" && !exactM151TokenDeltaWitnessSemantics(mutation, needle)) {
      problems.push(
        "manifest mutation release.m151 token-delta witness must retain the exact 512-byte needle prefix and 1->2 counts"
      );
    }
  }
}

function validateMaterializedMutations(manifest: IdentityManifest, matrix: MatrixScan, problems: string[]): void {
  const sourceValues = materializeSourceValues(manifest, matrix, problems);
  validateMaterializedMutationValues(manifest, sourceValues, problems);
}

function validateMutationGraph(
  manifest: IdentityManifest,
  matrix: MatrixScan,
  sourceCatalogueValid: boolean,
  problems: string[]
): void {
  validateCardinalityConstants(matrix, problems);
  const numericDeclarations = matrix.declarations;
  const stringDeclarations = matrix.declarations;
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
        } else
          problems.push(`nested legacy mutation at ${child.span.start} must occupy source or replacement argument`);
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
      } else if (dependency.order >= mutation.order) {
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
      if (observedReplacement === null || observedReplacement !== mutation.expressions.replacement.resolved) {
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
    const expected =
      edge.argument === 0
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
  if (JSON.stringify(observedReplacementEdges) !== JSON.stringify([...EXPECTED_REPLACEMENT_DEPENDENCY_EDGES].sort())) {
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

function invocationArgument(value: unknown, path: string, problems: string[]): InvocationArgumentIdentity | null {
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
    problems.push(`${path}.baseline must equal ${check.invoke.kind} mutant source ${contract.mutantSourceId}`);
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
  readonly bindings: readonly ts.Symbol[];
  readonly references: ReadonlySet<ts.Symbol>;
}

interface VariableBindingGraph {
  readonly checker: ts.TypeChecker;
  readonly downstreamBindings: ReadonlyMap<ts.Symbol, readonly ts.Symbol[]>;
}

function lexicalTypeChecker(sourceFile: ts.SourceFile): ts.TypeChecker {
  const host: ts.CompilerHost = {
    fileExists: (filename) => filename === sourceFile.fileName,
    getCanonicalFileName: (filename) => filename,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (filename) => (filename === sourceFile.fileName ? sourceFile : undefined),
    readFile: (filename) => (filename === sourceFile.fileName ? sourceFile.text : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined
  };
  return ts
    .createProgram([sourceFile.fileName], { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest }, host)
    .getTypeChecker();
}

function bindingSymbols(name: ts.BindingName, checker: ts.TypeChecker): readonly ts.Symbol[] {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    return symbol === undefined ? [] : [symbol];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingSymbols(element.name, checker)
  );
}

function referencedSymbols(node: ts.Node, checker: ts.TypeChecker): ReadonlySet<ts.Symbol> {
  const references = new Set<ts.Symbol>();
  const collect = (candidate: ts.Node): void => {
    if (ts.isIdentifier(candidate)) {
      const symbol = checker.getSymbolAtLocation(candidate);
      if (symbol !== undefined) references.add(symbol);
    }
    ts.forEachChild(candidate, collect);
  };
  collect(node);
  return references;
}

function downstreamBindingsForFlows<T>(
  flows: readonly { readonly bindings: readonly T[]; readonly references: ReadonlySet<T> }[]
): ReadonlyMap<T, readonly T[]> {
  const mutableDownstreamBindings = new Map<T, Set<T>>();
  for (const flow of flows) {
    for (const reference of flow.references) {
      const bindings = mutableDownstreamBindings.get(reference) ?? new Set<T>();
      for (const binding of flow.bindings) bindings.add(binding);
      mutableDownstreamBindings.set(reference, bindings);
    }
  }
  const downstreamBindings = new Map<T, readonly T[]>();
  for (const [reference, bindings] of mutableDownstreamBindings) {
    downstreamBindings.set(reference, Object.freeze([...bindings]));
  }
  return downstreamBindings;
}

function variableBindingFlows(sourceFile: ts.SourceFile): VariableBindingGraph {
  const checker = lexicalTypeChecker(sourceFile);
  const flows: VariableBindingFlow[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      flows.push({
        bindings: bindingSymbols(node.name, checker),
        references: referencedSymbols(node.initializer, checker)
      });
    }
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
      flows.push({
        bindings: node.initializer.declarations.flatMap((declaration) => bindingSymbols(declaration.name, checker)),
        references: referencedSymbols(node.expression, checker)
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { checker, downstreamBindings: downstreamBindingsForFlows(flows) };
}

function transitiveClosure<T>(seeds: Iterable<T>, downstream: ReadonlyMap<T, readonly T[]>): ReadonlySet<T> {
  const reached = new Set(seeds);
  const pending = [...reached];
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index];
    if (current === undefined) continue;
    for (const next of downstream.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      pending.push(next);
    }
  }
  return reached;
}

function validateBindingClosureSemantics(problems: string[]): void {
  const downstream = downstreamBindingsForFlows([
    { references: new Set(["root", "alternate"]), bindings: ["level-1", "shared"] },
    { references: new Set(["root"]), bindings: ["shared"] },
    { references: new Set(["level-1"]), bindings: ["level-2"] },
    { references: new Set(["level-2"]), bindings: ["root"] },
    { references: new Set(["unrelated"]), bindings: ["unreachable"] }
  ]);
  const forward = [...transitiveClosure(["root"], downstream)].sort();
  const alternate = [...transitiveClosure(["alternate"], downstream)].sort();
  const unrelated = [...transitiveClosure(["unrelated"], downstream)].sort();
  const rootEdges = downstream.get("root") ?? [];
  if (
    rootEdges.length !== 2 ||
    !rootEdges.includes("level-1") ||
    !rootEdges.includes("shared") ||
    JSON.stringify(forward) !== JSON.stringify(["level-1", "level-2", "root", "shared"]) ||
    JSON.stringify(alternate) !== JSON.stringify(["alternate", "level-1", "level-2", "root", "shared"]) ||
    JSON.stringify(unrelated) !== JSON.stringify(["unreachable", "unrelated"])
  ) {
    problems.push("release mutation binding graph must preserve directed, deduplicated, multi-hop and cyclic identity");
  }
}

function rootBindingSymbols(call: ts.CallExpression, graph: VariableBindingGraph): ReadonlySet<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  let ancestor: ts.Node | undefined = call.parent;
  while (ancestor !== undefined) {
    if (ts.isVariableDeclaration(ancestor)) {
      for (const symbol of bindingSymbols(ancestor.name, graph.checker)) symbols.add(symbol);
    }
    if (
      (ts.isForOfStatement(ancestor) || ts.isForInStatement(ancestor)) &&
      call.getStart() >= ancestor.expression.getStart() &&
      call.end <= ancestor.expression.end &&
      ts.isVariableDeclarationList(ancestor.initializer)
    ) {
      for (const declaration of ancestor.initializer.declarations) {
        for (const symbol of bindingSymbols(declaration.name, graph.checker)) symbols.add(symbol);
      }
    }
    ancestor = ancestor.parent;
  }
  return transitiveClosure(symbols, graph.downstreamBindings);
}

function nodeContainsBinding(node: ts.Node, bindings: ReadonlySet<ts.Symbol>, checker: ts.TypeChecker): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(candidate)) {
      const symbol = checker.getSymbolAtLocation(candidate);
      if (symbol !== undefined && bindings.has(symbol)) {
        found = true;
        return;
      }
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
  graph: VariableBindingGraph
): boolean {
  if (rootCall.getStart(sourceFile) >= assertion.getStart(sourceFile) && rootCall.end <= assertion.end) {
    return true;
  }
  const bindings = rootBindingSymbols(rootCall, graph);
  return bindings.size !== 0 && nodeContainsBinding(assertion, bindings, graph.checker);
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

function validateCases(manifest: IdentityManifest, matrixSource: string, matrix: MatrixScan, problems: string[]): void {
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
  const mutationByLegacyOrder = new Map(manifest.mutations.map((mutation) => [mutation.legacyOrder, mutation]));
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
  const declarations = matrix.declarations;
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
        validatePrimaryInvocation(check, `${identityCase.id}.checks[${checkIndex}].invoke`, mcpbMutantSlots, problems);
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
          problems.push(`manifest case ${identityCase.id} check ${checkIndex} uses an unknown named-regex identity`);
        }
        for (const matcher of check.matcherEvaluations) {
          if (matcher.operand.resolved !== check.expectation.regex || matcher.operand.raw !== expectedOperand) {
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
      if (checkIndex === 0) {
        invocationCensus.set(check.invoke.kind, (invocationCensus.get(check.invoke.kind) ?? 0) + 1);
      }
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
    m191.expectation.problem !== "protocol-conformance must pin slash-preserving note resource URIs on every host"
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
    m001.matcherEvaluations[0]?.operand.raw !== NAMED_REGEX_OPERANDS["workflow.schema.case-insensitive-env"]
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
    const observedProfile = auxiliary?.matcherEvaluations.map((matcher) => [matcher.matcher, matcher.negated] as const);
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

function validateFrozenProvenance(manifest: IdentityManifest, problems: string[]): void {
  if (manifest.generatedFrom.commit !== SOURCE_COMMIT) {
    problems.push(`manifest.generatedFrom.commit must pin exact source ${SOURCE_COMMIT}`);
  }
  if (manifest.generatedFrom.path !== "tests/release-integrity.test.ts") {
    problems.push("manifest.generatedFrom.path must name tests/release-integrity.test.ts");
  }
  if (manifest.generatedFrom.matrixTitle !== MATRIX_TITLE) {
    problems.push("manifest.generatedFrom.matrixTitle must equal the exact matrix title");
  }
  if (manifest.generatedFrom.matrixSliceSha256 !== MATRIX_SLICE_SHA256) {
    problems.push(`manifest provenance must pin reviewed matrix SHA-256 ${MATRIX_SLICE_SHA256}`);
  }
  if (JSON.stringify(manifest.generatedFrom.rawExpressionShape) !== JSON.stringify(EXPECTED_RAW_EXPRESSION_SHAPE)) {
    problems.push("manifest.generatedFrom.rawExpressionShape must equal the exact reviewed outer-expression census");
  }
}

function validateFrozenManifestMutationTopology(manifest: IdentityManifest, problems: string[]): void {
  if (manifest.mutations.length !== EXPECTED_INVENTORY.mutations) {
    problems.push(`manifest mutations must contain exactly 560 entries; found ${manifest.mutations.length}`);
  }
  const sourceIds = new Set(manifest.sources.map((source) => source.id));
  const sourceByAlias = new Map<string, string>();
  for (const source of manifest.sources) {
    for (const alias of source.legacyExpressions) sourceByAlias.set(alias, source.id);
  }
  const mutationById = new Map(manifest.mutations.map((mutation) => [mutation.id, mutation]));
  const duplicateMutationIds = duplicateValues(manifest.mutations.map((mutation) => mutation.id));
  if (duplicateMutationIds.length !== 0) {
    problems.push(`manifest mutation IDs must be unique; duplicates: ${duplicateMutationIds.join(", ")}`);
  }
  const duplicateLegacyOrders = duplicateValues(manifest.mutations.map((mutation) => String(mutation.legacyOrder)));
  if (duplicateLegacyOrders.length !== 0) {
    problems.push(`manifest legacy orders must be unique; duplicates: ${duplicateLegacyOrders.join(", ")}`);
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
  let first = 0;
  let all = 0;
  let roots = 0;
  let dependencies = 0;
  let sourceEdges = 0;
  let replacementEdges = 0;
  for (let index = 0; index < manifest.mutations.length; index++) {
    const mutation = manifest.mutations[index];
    if (mutation === undefined) continue;
    if (mutation.order !== index + 1) {
      problems.push(`manifest mutation order must be contiguous; index ${index} declares ${mutation.order}`);
    }
    const expectedId = `release.m${String(mutation.legacyOrder).padStart(3, "0")}`;
    if (!MUTATION_ID_PATTERN.test(mutation.id) || mutation.id !== expectedId) {
      problems.push(`manifest mutation ${mutation.id} must equal legacy identity ${expectedId}`);
    }
    if (mutation.mode === "first") first++;
    else all++;
    if (mutation.role === "root") roots++;
    else dependencies++;
    if (mutation.source.kind === "source") {
      if (!sourceIds.has(mutation.source.id)) {
        problems.push(`manifest mutation ${mutation.id} has unknown source ${mutation.source.id}`);
      }
      if (sourceByAlias.get(mutation.expressions.source.raw) !== mutation.source.id) {
        problems.push(`manifest mutation ${mutation.id} source identity does not match exact frozen alias`);
      }
    } else {
      sourceEdges++;
      const dependency = mutationById.get(mutation.source.id);
      if (dependency === undefined) {
        problems.push(`manifest mutation ${mutation.id} has unknown source mutation ${mutation.source.id}`);
      } else if (dependency.order >= mutation.order) {
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
        `manifest mutation ${mutation.id} resolved replacement must equal dependency ${mutation.replacementDependency}`
      );
    }
    if (mutation.expressions.expectedOccurrences.resolved <= 0) {
      problems.push(`manifest mutation ${mutation.id} expectedOccurrences must be positive`);
    }
    if (mutation.witness.before === mutation.witness.after) {
      problems.push(`manifest mutation ${mutation.id} witness must prove an exact positive delta`);
    }
    if (mutation.witness.sourceSha256 === mutation.witness.mutantSha256) {
      problems.push(`manifest mutation ${mutation.id} source and mutant digests must differ`);
    }
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
  if (JSON.stringify(observedReplacementEdges) !== JSON.stringify([...EXPECTED_REPLACEMENT_DEPENDENCY_EDGES].sort())) {
    problems.push("manifest replacement-dependency identities disagree with the exact 18 reviewed edges");
  }

  let maximumDepth = 0;
  for (const mutation of manifest.mutations) {
    const shouldBeRoot = !parentByDependency.has(mutation.id);
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
}

function validateFrozenCaseTopology(manifest: IdentityManifest, problems: string[]): void {
  if (manifest.cases.length !== EXPECTED_INVENTORY.cases) {
    problems.push(`manifest cases must contain exactly 536 entries; found ${manifest.cases.length}`);
  }
  const mutationById = new Map(manifest.mutations.map((mutation) => [mutation.id, mutation]));
  const roots = new Set(
    manifest.mutations.filter((mutation) => mutation.role === "root").map((mutation) => mutation.id)
  );
  const caseIds = manifest.cases.map((identityCase) => identityCase.id);
  const caseRoots = manifest.cases.map((identityCase) => identityCase.root);
  for (const [label, values] of [
    ["IDs", caseIds],
    ["roots", caseRoots],
    ["semantic fingerprints", manifest.cases.map((identityCase) => identityCase.semanticFingerprint)]
  ] as const) {
    const duplicates = duplicateValues(values);
    if (duplicates.length !== 0) {
      problems.push(`manifest case ${label} must be unique; duplicates: ${duplicates.join(", ")}`);
    }
  }
  const invocationCensus = new Map<string, number>();
  const expectationCensus = new Map<string, number>();
  const mcpbMutantSlots = new Map<string, number>();
  let logicalChecks = 0;
  let rawMatchers = 0;
  let compositeChecks = 0;
  const compositeProfiles: number[] = [];
  const transactionChecks: Array<{ readonly problem: string; readonly spanKey: string }> = [];
  const ultimateSource = (mutationId: string): string | null => {
    const visited = new Set<string>();
    let mutation = mutationById.get(mutationId);
    while (mutation !== undefined && mutation.source.kind === "mutation") {
      if (visited.has(mutation.id)) return null;
      visited.add(mutation.id);
      mutation = mutationById.get(mutation.source.id);
    }
    return mutation?.source.kind === "source" ? mutation.source.id : null;
  };
  for (let caseIndex = 0; caseIndex < manifest.cases.length; caseIndex++) {
    const identityCase = manifest.cases[caseIndex];
    if (identityCase === undefined) continue;
    if (identityCase.order !== caseIndex + 1) {
      problems.push(`manifest case order must be contiguous; index ${caseIndex} declares ${identityCase.order}`);
    }
    const expectedCaseId = identityCase.root.replace("release.", "release.case.");
    if (!CASE_ID_PATTERN.test(identityCase.id) || identityCase.id !== expectedCaseId) {
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
      if (check.invoke.mutant !== identityCase.root) {
        problems.push(
          `manifest case ${identityCase.id} check ${checkIndex} mutant must equal root ${identityCase.root}`
        );
      }
      const expectedBaseline = ultimateSource(identityCase.root);
      if (check.invoke.baseline !== expectedBaseline) {
        problems.push(
          `manifest case ${identityCase.id} check ${checkIndex} baseline must be ultimate source ` +
            `${expectedBaseline ?? "missing"}`
        );
      }
      if (checkIndex === 0) {
        validatePrimaryInvocation(check, `${identityCase.id}.checks[0].invoke`, mcpbMutantSlots, problems);
        invocationCensus.set(check.invoke.kind, (invocationCensus.get(check.invoke.kind) ?? 0) + 1);
        if (check.matcherEvaluations.length !== 1) {
          problems.push(`manifest case ${identityCase.id} primary check must have exactly one matcher leaf`);
        }
      } else {
        validateCompositeInvocation(check, identityCase.root, `${identityCase.id}.checks[1].invoke`, problems);
        compositeChecks++;
        compositeProfiles.push(check.matcherEvaluations.length);
      }
      rawMatchers += check.matcherEvaluations.length;
      expectationCensus.set(check.expectation.kind, (expectationCensus.get(check.expectation.kind) ?? 0) + 1);
      if (checkIndex === 0 && check.expectation.kind === "problem") {
        const leaf = check.matcherEvaluations[0];
        if (leaf?.operand.resolved !== check.expectation.problem) {
          problems.push(`manifest case ${identityCase.id} problem identity does not equal its exact matcher operand`);
        }
      }
      if (check.expectation.kind === "regex") {
        const expectedOperand = NAMED_REGEX_OPERANDS[check.expectation.regex];
        if (expectedOperand === undefined) {
          problems.push(`manifest case ${identityCase.id} check ${checkIndex} uses an unknown named-regex identity`);
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
  if (logicalChecks !== 541 || compositeChecks !== 5 || rawMatchers !== 546) {
    problems.push(
      "manifest frozen case topology must be 541 checks / 5 composite / 546 leaves; " +
        `found ${logicalChecks} / ${compositeChecks} / ${rawMatchers}`
    );
  }
  if (JSON.stringify(compositeProfiles) !== JSON.stringify([2, 1, 2, 3, 2])) {
    problems.push(`manifest composite profiles must be exactly 2/1/2/3/2; found ${compositeProfiles.join("/")}`);
  }
  const observedExpectationCensus = Object.fromEntries(
    [...expectationCensus].sort(([left], [right]) => left.localeCompare(right))
  );
  if (JSON.stringify(observedExpectationCensus) !== JSON.stringify({ equal: 5, problem: 535, regex: 1 })) {
    problems.push(`manifest expectation identity census is wrong: ${JSON.stringify(observedExpectationCensus)}`);
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
}

function expectedMutationHandle(id: string): string {
  const suffix = id.slice("release.m".length);
  return `releaseMutationM${suffix}`;
}

function matchesFrozenDeclarativeInvocation(
  manifest: IdentityManifest,
  observed: DeclarativeInvocationIdentity,
  rootId: string,
  frozenCheck: CheckIdentity
): boolean {
  const contract = INVOCATION_CONTRACTS[frozenCheck.invoke.kind];
  const inputs = frozenCheck.invoke.inputs;
  const frozenInputArguments = inputs.arguments;
  if (
    contract === undefined ||
    inputs.callee !== contract.callee ||
    !Array.isArray(frozenInputArguments) ||
    frozenCheck.invoke.mutant !== rootId
  ) {
    return false;
  }
  const argumentProblems: string[] = [];
  const frozenArguments = frozenInputArguments
    .map((argument, index) => invocationArgument(argument, `frozen invocation argument ${index}`, argumentProblems))
    .filter((argument): argument is InvocationArgumentIdentity => argument !== null);
  if (argumentProblems.length !== 0 || JSON.stringify(frozenArguments) !== JSON.stringify(contract.arguments)) {
    return false;
  }
  const sourceBindingById = new Map(manifest.sources.map((source) => [source.id, source.declarativeBinding]));
  const expectedBaselineHandle = sourceBindingById.get(frozenCheck.invoke.baseline);
  if (
    expectedBaselineHandle === undefined ||
    observed.invocationKind !== frozenCheck.invoke.kind ||
    observed.baselineHandle !== expectedBaselineHandle ||
    observed.mutantHandle !== expectedMutationHandle(rootId)
  ) {
    return false;
  }
  const frozenCompanions = frozenArguments.filter(
    (argument): argument is InvocationArgumentIdentity & { readonly id: string; readonly kind: "source" } =>
      argument.kind === "source"
  );
  if (frozenCompanions.length === 0) {
    return frozenCompanions.length === 0 && observed.companionSlot === null && observed.companionHandle === null;
  }
  const frozenCompanion = frozenCompanions.length === 1 ? frozenCompanions[0] : undefined;
  const expectedCompanionHandle = frozenCompanion === undefined ? undefined : sourceBindingById.get(frozenCompanion.id);
  return (
    frozenCompanion !== undefined &&
    expectedCompanionHandle !== undefined &&
    observed.companionSlot === frozenCompanion.slot &&
    observed.companionHandle === expectedCompanionHandle
  );
}

function validateFrozenDeclarativeInvocationMatchingSemantics(manifest: IdentityManifest, problems: string[]): void {
  const caseByRoot = new Map(manifest.cases.map((identityCase) => [identityCase.root, identityCase]));
  const matches = (rootId: string, observed: DeclarativeInvocationIdentity): boolean => {
    const check = caseByRoot.get(rootId)?.checks[0];
    return check !== undefined && matchesFrozenDeclarativeInvocation(manifest, observed, rootId, check);
  };
  const evaluator: DeclarativeInvocationIdentity = {
    invocationKind: "registry.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM002",
    companionSlot: null,
    companionHandle: null
  };
  const run: DeclarativeInvocationIdentity = {
    invocationKind: "registry.step.run",
    baselineHandle: "registryPublishStepSource",
    mutantHandle: "releaseMutationM043",
    companionSlot: "integrity",
    companionHandle: "releaseIntegritySource"
  };
  const integrity: DeclarativeInvocationIdentity = {
    invocationKind: "registry.step.integrity",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM111",
    companionSlot: "run",
    companionHandle: "registryPublishStepSource"
  };
  const npmRelease: DeclarativeInvocationIdentity = {
    invocationKind: "npm.contract.release",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM112",
    companionSlot: "integrity",
    companionHandle: "releaseIntegritySource"
  };
  const npmIntegrity: DeclarativeInvocationIdentity = {
    invocationKind: "npm.contract.integrity",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM113",
    companionSlot: "release",
    companionHandle: "releaseWorkflowFixtureSource"
  };
  const npmWorkflowM114: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM114",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM115: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM115",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM116: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM116",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM117: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM117",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM118: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM118",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM119: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM119",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM120: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM120",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM121: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM121",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM122: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM122",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM123: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM123",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM124: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM124",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM125: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM125",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM126: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM126",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM127: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM127",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM128: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM128",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM129: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM129",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM130: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM130",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM131: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM131",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM132: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM132",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM133: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM133",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM134: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM134",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM135: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM135",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM136: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM136",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM137: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM137",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM138: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM138",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM139: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM139",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM141: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM141",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM142: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM142",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM143: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM143",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM144: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM144",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM146: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM146",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM147: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM147",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM148: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM148",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM149: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM149",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM150: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM150",
    companionSlot: null,
    companionHandle: null
  };
  const npmWorkflowM151: DeclarativeInvocationIdentity = {
    invocationKind: "npm.workflow",
    baselineHandle: "releaseWorkflowFixtureSource",
    mutantHandle: "releaseMutationM151",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM152: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM152",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM153: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM153",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM154: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM154",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM155: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM155",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM156: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM156",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM157: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM157",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM158: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM158",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM159: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM159",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM160: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM160",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM161: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM161",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM162: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM162",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM163: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM163",
    companionSlot: null,
    companionHandle: null
  };
  const npmEvaluatorM164: DeclarativeInvocationIdentity = {
    invocationKind: "npm.evaluator",
    baselineHandle: "releaseIntegritySource",
    mutantHandle: "releaseMutationM164",
    companionSlot: null,
    companionHandle: null
  };
  if (
    !matches("release.m002", evaluator) ||
    !matches("release.m043", run) ||
    !matches("release.m111", integrity) ||
    !matches("release.m112", npmRelease) ||
    !matches("release.m113", npmIntegrity) ||
    !matches("release.m114", npmWorkflowM114) ||
    !matches("release.m115", npmWorkflowM115) ||
    !matches("release.m116", npmWorkflowM116) ||
    !matches("release.m117", npmWorkflowM117) ||
    !matches("release.m118", npmWorkflowM118) ||
    !matches("release.m119", npmWorkflowM119) ||
    !matches("release.m120", npmWorkflowM120) ||
    !matches("release.m121", npmWorkflowM121) ||
    !matches("release.m122", npmWorkflowM122) ||
    !matches("release.m123", npmWorkflowM123) ||
    !matches("release.m124", npmWorkflowM124) ||
    !matches("release.m125", npmWorkflowM125) ||
    !matches("release.m126", npmWorkflowM126) ||
    !matches("release.m127", npmWorkflowM127) ||
    !matches("release.m128", npmWorkflowM128) ||
    !matches("release.m129", npmWorkflowM129) ||
    !matches("release.m130", npmWorkflowM130) ||
    !matches("release.m131", npmWorkflowM131) ||
    !matches("release.m132", npmWorkflowM132) ||
    !matches("release.m133", npmWorkflowM133) ||
    !matches("release.m134", npmWorkflowM134) ||
    !matches("release.m135", npmWorkflowM135) ||
    !matches("release.m136", npmWorkflowM136) ||
    !matches("release.m137", npmWorkflowM137) ||
    !matches("release.m138", npmWorkflowM138) ||
    !matches("release.m139", npmWorkflowM139) ||
    !matches("release.m141", npmWorkflowM141) ||
    !matches("release.m142", npmWorkflowM142) ||
    !matches("release.m143", npmWorkflowM143) ||
    !matches("release.m144", npmWorkflowM144) ||
    !matches("release.m146", npmWorkflowM146) ||
    !matches("release.m147", npmWorkflowM147) ||
    !matches("release.m148", npmWorkflowM148) ||
    !matches("release.m149", npmWorkflowM149) ||
    !matches("release.m150", npmWorkflowM150) ||
    !matches("release.m151", npmWorkflowM151) ||
    !matches("release.m152", npmEvaluatorM152) ||
    !matches("release.m153", npmEvaluatorM153) ||
    !matches("release.m154", npmEvaluatorM154) ||
    !matches("release.m155", npmEvaluatorM155) ||
    !matches("release.m156", npmEvaluatorM156) ||
    !matches("release.m157", npmEvaluatorM157) ||
    !matches("release.m158", npmEvaluatorM158) ||
    !matches("release.m159", npmEvaluatorM159) ||
    !matches("release.m160", npmEvaluatorM160) ||
    !matches("release.m161", npmEvaluatorM161) ||
    !matches("release.m162", npmEvaluatorM162) ||
    !matches("release.m163", npmEvaluatorM163) ||
    !matches("release.m164", npmEvaluatorM164) ||
    matches("release.m035", { ...integrity, mutantHandle: "releaseMutationM035" }) ||
    matches("release.m111", { ...evaluator, mutantHandle: "releaseMutationM111" }) ||
    matches("release.m043", { ...run, companionSlot: "run" }) ||
    matches("release.m043", { ...run, companionHandle: "registryPublishStepSource" }) ||
    matches("release.m111", { ...integrity, companionSlot: "integrity" }) ||
    matches("release.m111", { ...integrity, companionHandle: "releaseIntegritySource" }) ||
    matches("release.m112", { ...npmRelease, invocationKind: "npm.contract.integrity" }) ||
    matches("release.m112", { ...npmRelease, companionSlot: "release" }) ||
    matches("release.m112", { ...npmRelease, companionHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m113", { ...npmIntegrity, invocationKind: "npm.contract.release" }) ||
    matches("release.m113", { ...npmIntegrity, companionSlot: "integrity" }) ||
    matches("release.m113", { ...npmIntegrity, companionHandle: "releaseIntegritySource" }) ||
    matches("release.m114", { ...npmWorkflowM114, invocationKind: "npm.contract.release" }) ||
    matches("release.m114", {
      ...npmWorkflowM114,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m114", { ...npmWorkflowM114, mutantHandle: "releaseMutationM115" }) ||
    matches("release.m115", { ...npmWorkflowM115, mutantHandle: "releaseMutationM114" }) ||
    matches("release.m115", { ...npmWorkflowM115, mutantHandle: "releaseMutationM116" }) ||
    matches("release.m116", { ...npmWorkflowM116, mutantHandle: "releaseMutationM115" }) ||
    matches("release.m116", { ...npmWorkflowM116, mutantHandle: "releaseMutationM117" }) ||
    matches("release.m117", { ...npmWorkflowM117, mutantHandle: "releaseMutationM116" }) ||
    matches("release.m117", { ...npmWorkflowM117, mutantHandle: "releaseMutationM118" }) ||
    matches("release.m118", { ...npmWorkflowM118, mutantHandle: "releaseMutationM117" }) ||
    matches("release.m118", { ...npmWorkflowM118, mutantHandle: "releaseMutationM119" }) ||
    matches("release.m119", { ...npmWorkflowM119, mutantHandle: "releaseMutationM118" }) ||
    matches("release.m119", { ...npmWorkflowM119, mutantHandle: "releaseMutationM120" }) ||
    matches("release.m120", { ...npmWorkflowM120, mutantHandle: "releaseMutationM119" }) ||
    matches("release.m120", { ...npmWorkflowM120, mutantHandle: "releaseMutationM121" }) ||
    matches("release.m121", { ...npmWorkflowM121, mutantHandle: "releaseMutationM120" }) ||
    matches("release.m121", { ...npmWorkflowM121, mutantHandle: "releaseMutationM122" }) ||
    matches("release.m122", { ...npmWorkflowM122, mutantHandle: "releaseMutationM121" }) ||
    matches("release.m122", { ...npmWorkflowM122, mutantHandle: "releaseMutationM123" }) ||
    matches("release.m123", { ...npmWorkflowM123, mutantHandle: "releaseMutationM122" }) ||
    matches("release.m123", { ...npmWorkflowM123, mutantHandle: "releaseMutationM124" }) ||
    matches("release.m124", { ...npmWorkflowM124, mutantHandle: "releaseMutationM123" }) ||
    matches("release.m124", { ...npmWorkflowM124, mutantHandle: "releaseMutationM125" }) ||
    matches("release.m125", { ...npmWorkflowM125, mutantHandle: "releaseMutationM124" }) ||
    matches("release.m125", { ...npmWorkflowM125, mutantHandle: "releaseMutationM126" }) ||
    matches("release.m126", { ...npmWorkflowM126, mutantHandle: "releaseMutationM125" }) ||
    matches("release.m126", { ...npmWorkflowM126, mutantHandle: "releaseMutationM127" }) ||
    matches("release.m127", { ...npmWorkflowM127, mutantHandle: "releaseMutationM126" }) ||
    matches("release.m127", { ...npmWorkflowM127, mutantHandle: "releaseMutationM128" }) ||
    matches("release.m128", { ...npmWorkflowM128, mutantHandle: "releaseMutationM127" }) ||
    matches("release.m128", { ...npmWorkflowM128, mutantHandle: "releaseMutationM129" }) ||
    matches("release.m129", { ...npmWorkflowM129, mutantHandle: "releaseMutationM128" }) ||
    matches("release.m129", { ...npmWorkflowM129, mutantHandle: "releaseMutationM130" }) ||
    matches("release.m130", { ...npmWorkflowM130, mutantHandle: "releaseMutationM129" }) ||
    matches("release.m130", { ...npmWorkflowM130, mutantHandle: "releaseMutationM131" }) ||
    matches("release.m131", { ...npmWorkflowM131, mutantHandle: "releaseMutationM130" }) ||
    matches("release.m131", { ...npmWorkflowM131, mutantHandle: "releaseMutationM132" }) ||
    matches("release.m132", { ...npmWorkflowM132, mutantHandle: "releaseMutationM131" }) ||
    matches("release.m132", { ...npmWorkflowM132, mutantHandle: "releaseMutationM133" }) ||
    matches("release.m133", { ...npmWorkflowM133, mutantHandle: "releaseMutationM132" }) ||
    matches("release.m133", { ...npmWorkflowM133, mutantHandle: "releaseMutationM134" }) ||
    matches("release.m134", { ...npmWorkflowM134, mutantHandle: "releaseMutationM133" }) ||
    matches("release.m134", { ...npmWorkflowM134, mutantHandle: "releaseMutationM135" }) ||
    matches("release.m135", { ...npmWorkflowM135, mutantHandle: "releaseMutationM134" }) ||
    matches("release.m135", { ...npmWorkflowM135, mutantHandle: "releaseMutationM136" }) ||
    matches("release.m136", { ...npmWorkflowM136, mutantHandle: "releaseMutationM135" }) ||
    matches("release.m136", { ...npmWorkflowM136, mutantHandle: "releaseMutationM137" }) ||
    matches("release.m137", { ...npmWorkflowM137, mutantHandle: "releaseMutationM136" }) ||
    matches("release.m137", { ...npmWorkflowM137, mutantHandle: "releaseMutationM138" }) ||
    matches("release.m138", { ...npmWorkflowM138, mutantHandle: "releaseMutationM137" }) ||
    matches("release.m138", { ...npmWorkflowM138, mutantHandle: "releaseMutationM139" }) ||
    matches("release.m139", { ...npmWorkflowM139, mutantHandle: "releaseMutationM138" }) ||
    matches("release.m139", { ...npmWorkflowM139, mutantHandle: "releaseMutationM140" }) ||
    matches("release.m139", { ...npmWorkflowM139, mutantHandle: "releaseMutationM141" }) ||
    matches("release.m141", { ...npmWorkflowM141, mutantHandle: "releaseMutationM139" }) ||
    matches("release.m141", { ...npmWorkflowM141, mutantHandle: "releaseMutationM142" }) ||
    matches("release.m142", { ...npmWorkflowM142, mutantHandle: "releaseMutationM141" }) ||
    matches("release.m142", { ...npmWorkflowM142, mutantHandle: "releaseMutationM143" }) ||
    matches("release.m143", { ...npmWorkflowM143, mutantHandle: "releaseMutationM142" }) ||
    matches("release.m143", { ...npmWorkflowM143, mutantHandle: "releaseMutationM144" }) ||
    matches("release.m144", { ...npmWorkflowM144, mutantHandle: "releaseMutationM143" }) ||
    matches("release.m144", { ...npmWorkflowM144, mutantHandle: "releaseMutationM145" }) ||
    matches("release.m144", { ...npmWorkflowM144, mutantHandle: "releaseMutationM146" }) ||
    matches("release.m146", { ...npmWorkflowM146, mutantHandle: "releaseMutationM144" }) ||
    matches("release.m146", { ...npmWorkflowM146, mutantHandle: "releaseMutationM147" }) ||
    matches("release.m147", { ...npmWorkflowM147, mutantHandle: "releaseMutationM146" }) ||
    matches("release.m147", { ...npmWorkflowM147, mutantHandle: "releaseMutationM148" }) ||
    matches("release.m148", { ...npmWorkflowM148, mutantHandle: "releaseMutationM147" }) ||
    matches("release.m148", { ...npmWorkflowM148, mutantHandle: "releaseMutationM149" }) ||
    matches("release.m149", { ...npmWorkflowM149, mutantHandle: "releaseMutationM148" }) ||
    matches("release.m149", { ...npmWorkflowM149, mutantHandle: "releaseMutationM150" }) ||
    matches("release.m150", { ...npmWorkflowM150, mutantHandle: "releaseMutationM149" }) ||
    matches("release.m150", { ...npmWorkflowM150, mutantHandle: "releaseMutationM151" }) ||
    matches("release.m151", { ...npmWorkflowM151, mutantHandle: "releaseMutationM150" }) ||
    matches("release.m151", { ...npmWorkflowM151, mutantHandle: "releaseMutationM152" }) ||
    matches("release.m152", { ...npmEvaluatorM152, mutantHandle: "releaseMutationM151" }) ||
    matches("release.m152", { ...npmEvaluatorM152, mutantHandle: "releaseMutationM153" }) ||
    matches("release.m153", { ...npmEvaluatorM153, mutantHandle: "releaseMutationM152" }) ||
    matches("release.m153", { ...npmEvaluatorM153, mutantHandle: "releaseMutationM154" }) ||
    matches("release.m154", { ...npmEvaluatorM154, mutantHandle: "releaseMutationM153" }) ||
    matches("release.m154", { ...npmEvaluatorM154, mutantHandle: "releaseMutationM155" }) ||
    matches("release.m155", { ...npmEvaluatorM155, mutantHandle: "releaseMutationM154" }) ||
    matches("release.m155", { ...npmEvaluatorM155, mutantHandle: "releaseMutationM156" }) ||
    matches("release.m156", { ...npmEvaluatorM156, mutantHandle: "releaseMutationM155" }) ||
    matches("release.m156", { ...npmEvaluatorM156, mutantHandle: "releaseMutationM157" }) ||
    matches("release.m157", { ...npmEvaluatorM157, mutantHandle: "releaseMutationM156" }) ||
    matches("release.m157", { ...npmEvaluatorM157, mutantHandle: "releaseMutationM158" }) ||
    matches("release.m158", { ...npmEvaluatorM158, mutantHandle: "releaseMutationM157" }) ||
    matches("release.m158", { ...npmEvaluatorM158, mutantHandle: "releaseMutationM159" }) ||
    matches("release.m159", { ...npmEvaluatorM159, mutantHandle: "releaseMutationM158" }) ||
    matches("release.m159", { ...npmEvaluatorM159, mutantHandle: "releaseMutationM160" }) ||
    matches("release.m160", { ...npmEvaluatorM160, mutantHandle: "releaseMutationM159" }) ||
    matches("release.m160", { ...npmEvaluatorM160, mutantHandle: "releaseMutationM161" }) ||
    matches("release.m161", { ...npmEvaluatorM161, mutantHandle: "releaseMutationM160" }) ||
    matches("release.m161", { ...npmEvaluatorM161, mutantHandle: "releaseMutationM162" }) ||
    matches("release.m162", { ...npmEvaluatorM162, mutantHandle: "releaseMutationM161" }) ||
    matches("release.m162", { ...npmEvaluatorM162, mutantHandle: "releaseMutationM163" }) ||
    matches("release.m163", { ...npmEvaluatorM163, mutantHandle: "releaseMutationM162" }) ||
    matches("release.m163", { ...npmEvaluatorM163, mutantHandle: "releaseMutationM164" }) ||
    matches("release.m164", { ...npmEvaluatorM164, mutantHandle: "releaseMutationM163" }) ||
    matches("release.m164", { ...npmEvaluatorM164, mutantHandle: "releaseMutationM165" }) ||
    matches("release.m115", { ...npmWorkflowM115, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m115", { ...npmWorkflowM115, invocationKind: "npm.contract.release" }) ||
    matches("release.m115", {
      ...npmWorkflowM115,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m116", { ...npmWorkflowM116, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m116", { ...npmWorkflowM116, invocationKind: "npm.contract.release" }) ||
    matches("release.m116", {
      ...npmWorkflowM116,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m117", { ...npmWorkflowM117, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m117", { ...npmWorkflowM117, invocationKind: "npm.contract.release" }) ||
    matches("release.m117", {
      ...npmWorkflowM117,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m118", { ...npmWorkflowM118, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m118", { ...npmWorkflowM118, invocationKind: "npm.contract.release" }) ||
    matches("release.m118", {
      ...npmWorkflowM118,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m119", { ...npmWorkflowM119, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m119", { ...npmWorkflowM119, invocationKind: "npm.contract.release" }) ||
    matches("release.m119", {
      ...npmWorkflowM119,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m120", { ...npmWorkflowM120, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m120", { ...npmWorkflowM120, invocationKind: "npm.contract.release" }) ||
    matches("release.m120", {
      ...npmWorkflowM120,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m121", { ...npmWorkflowM121, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m121", { ...npmWorkflowM121, invocationKind: "npm.contract.release" }) ||
    matches("release.m121", {
      ...npmWorkflowM121,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m122", { ...npmWorkflowM122, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m122", { ...npmWorkflowM122, invocationKind: "npm.contract.release" }) ||
    matches("release.m122", {
      ...npmWorkflowM122,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m123", { ...npmWorkflowM123, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m123", { ...npmWorkflowM123, invocationKind: "npm.contract.release" }) ||
    matches("release.m123", {
      ...npmWorkflowM123,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m124", { ...npmWorkflowM124, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m124", { ...npmWorkflowM124, invocationKind: "npm.contract.release" }) ||
    matches("release.m124", {
      ...npmWorkflowM124,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m125", { ...npmWorkflowM125, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m125", { ...npmWorkflowM125, invocationKind: "npm.contract.release" }) ||
    matches("release.m125", {
      ...npmWorkflowM125,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m126", { ...npmWorkflowM126, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m126", { ...npmWorkflowM126, invocationKind: "npm.contract.release" }) ||
    matches("release.m126", {
      ...npmWorkflowM126,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m127", { ...npmWorkflowM127, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m127", { ...npmWorkflowM127, invocationKind: "npm.contract.release" }) ||
    matches("release.m127", {
      ...npmWorkflowM127,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m128", { ...npmWorkflowM128, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m128", { ...npmWorkflowM128, invocationKind: "npm.contract.release" }) ||
    matches("release.m128", {
      ...npmWorkflowM128,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m129", { ...npmWorkflowM129, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m129", { ...npmWorkflowM129, invocationKind: "npm.contract.release" }) ||
    matches("release.m129", {
      ...npmWorkflowM129,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m130", { ...npmWorkflowM130, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m130", { ...npmWorkflowM130, invocationKind: "npm.contract.release" }) ||
    matches("release.m130", {
      ...npmWorkflowM130,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m131", { ...npmWorkflowM131, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m131", { ...npmWorkflowM131, invocationKind: "npm.contract.release" }) ||
    matches("release.m131", {
      ...npmWorkflowM131,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m132", { ...npmWorkflowM132, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m132", { ...npmWorkflowM132, invocationKind: "npm.contract.release" }) ||
    matches("release.m132", {
      ...npmWorkflowM132,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m133", { ...npmWorkflowM133, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m133", { ...npmWorkflowM133, invocationKind: "npm.contract.release" }) ||
    matches("release.m133", {
      ...npmWorkflowM133,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m134", { ...npmWorkflowM134, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m134", { ...npmWorkflowM134, invocationKind: "npm.contract.release" }) ||
    matches("release.m134", {
      ...npmWorkflowM134,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m135", { ...npmWorkflowM135, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m135", { ...npmWorkflowM135, invocationKind: "npm.contract.release" }) ||
    matches("release.m135", {
      ...npmWorkflowM135,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m136", { ...npmWorkflowM136, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m136", { ...npmWorkflowM136, invocationKind: "npm.contract.release" }) ||
    matches("release.m136", {
      ...npmWorkflowM136,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m137", { ...npmWorkflowM137, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m137", { ...npmWorkflowM137, invocationKind: "npm.contract.release" }) ||
    matches("release.m137", {
      ...npmWorkflowM137,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m138", { ...npmWorkflowM138, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m138", { ...npmWorkflowM138, invocationKind: "npm.contract.release" }) ||
    matches("release.m138", {
      ...npmWorkflowM138,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m139", { ...npmWorkflowM139, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m139", { ...npmWorkflowM139, invocationKind: "npm.contract.release" }) ||
    matches("release.m139", {
      ...npmWorkflowM139,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m141", { ...npmWorkflowM141, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m141", { ...npmWorkflowM141, invocationKind: "npm.contract.release" }) ||
    matches("release.m141", {
      ...npmWorkflowM141,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m142", { ...npmWorkflowM142, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m142", { ...npmWorkflowM142, invocationKind: "npm.contract.release" }) ||
    matches("release.m142", {
      ...npmWorkflowM142,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m143", { ...npmWorkflowM143, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m143", { ...npmWorkflowM143, invocationKind: "npm.contract.release" }) ||
    matches("release.m143", {
      ...npmWorkflowM143,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m144", { ...npmWorkflowM144, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m144", { ...npmWorkflowM144, invocationKind: "npm.contract.release" }) ||
    matches("release.m144", {
      ...npmWorkflowM144,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m146", { ...npmWorkflowM146, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m146", { ...npmWorkflowM146, invocationKind: "npm.contract.release" }) ||
    matches("release.m146", {
      ...npmWorkflowM146,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m147", { ...npmWorkflowM147, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m147", { ...npmWorkflowM147, invocationKind: "npm.contract.release" }) ||
    matches("release.m147", {
      ...npmWorkflowM147,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m148", { ...npmWorkflowM148, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m148", { ...npmWorkflowM148, invocationKind: "npm.contract.release" }) ||
    matches("release.m148", {
      ...npmWorkflowM148,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m149", { ...npmWorkflowM149, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m149", { ...npmWorkflowM149, invocationKind: "npm.contract.release" }) ||
    matches("release.m149", {
      ...npmWorkflowM149,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m150", { ...npmWorkflowM150, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m150", { ...npmWorkflowM150, invocationKind: "npm.contract.release" }) ||
    matches("release.m150", {
      ...npmWorkflowM150,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m151", { ...npmWorkflowM151, baselineHandle: "releaseIntegritySource" }) ||
    matches("release.m151", { ...npmWorkflowM151, invocationKind: "npm.contract.release" }) ||
    matches("release.m151", {
      ...npmWorkflowM151,
      companionSlot: "integrity",
      companionHandle: "releaseIntegritySource"
    }) ||
    matches("release.m152", { ...npmEvaluatorM152, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m152", { ...npmEvaluatorM152, invocationKind: "registry.evaluator" }) ||
    matches("release.m152", { ...npmEvaluatorM152, invocationKind: "npm.workflow" }) ||
    matches("release.m152", {
      ...npmEvaluatorM152,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m153", { ...npmEvaluatorM153, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m153", { ...npmEvaluatorM153, invocationKind: "registry.evaluator" }) ||
    matches("release.m153", { ...npmEvaluatorM153, invocationKind: "npm.workflow" }) ||
    matches("release.m153", {
      ...npmEvaluatorM153,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m154", { ...npmEvaluatorM154, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m154", { ...npmEvaluatorM154, invocationKind: "registry.evaluator" }) ||
    matches("release.m154", { ...npmEvaluatorM154, invocationKind: "npm.workflow" }) ||
    matches("release.m154", {
      ...npmEvaluatorM154,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m155", { ...npmEvaluatorM155, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m155", { ...npmEvaluatorM155, invocationKind: "registry.evaluator" }) ||
    matches("release.m155", { ...npmEvaluatorM155, invocationKind: "npm.workflow" }) ||
    matches("release.m155", {
      ...npmEvaluatorM155,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m156", { ...npmEvaluatorM156, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m156", { ...npmEvaluatorM156, invocationKind: "registry.evaluator" }) ||
    matches("release.m156", { ...npmEvaluatorM156, invocationKind: "npm.workflow" }) ||
    matches("release.m156", {
      ...npmEvaluatorM156,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m157", { ...npmEvaluatorM157, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m157", { ...npmEvaluatorM157, invocationKind: "registry.evaluator" }) ||
    matches("release.m157", { ...npmEvaluatorM157, invocationKind: "npm.workflow" }) ||
    matches("release.m157", {
      ...npmEvaluatorM157,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m158", { ...npmEvaluatorM158, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m158", { ...npmEvaluatorM158, invocationKind: "registry.evaluator" }) ||
    matches("release.m158", { ...npmEvaluatorM158, invocationKind: "npm.workflow" }) ||
    matches("release.m158", {
      ...npmEvaluatorM158,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m159", { ...npmEvaluatorM159, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m159", { ...npmEvaluatorM159, invocationKind: "registry.evaluator" }) ||
    matches("release.m159", { ...npmEvaluatorM159, invocationKind: "npm.workflow" }) ||
    matches("release.m159", {
      ...npmEvaluatorM159,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m160", { ...npmEvaluatorM160, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m160", { ...npmEvaluatorM160, invocationKind: "registry.evaluator" }) ||
    matches("release.m160", { ...npmEvaluatorM160, invocationKind: "npm.workflow" }) ||
    matches("release.m160", {
      ...npmEvaluatorM160,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m161", { ...npmEvaluatorM161, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m161", { ...npmEvaluatorM161, invocationKind: "registry.evaluator" }) ||
    matches("release.m161", { ...npmEvaluatorM161, invocationKind: "npm.workflow" }) ||
    matches("release.m161", {
      ...npmEvaluatorM161,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m162", { ...npmEvaluatorM162, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m162", { ...npmEvaluatorM162, invocationKind: "registry.evaluator" }) ||
    matches("release.m162", { ...npmEvaluatorM162, invocationKind: "npm.workflow" }) ||
    matches("release.m162", {
      ...npmEvaluatorM162,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m163", { ...npmEvaluatorM163, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m163", { ...npmEvaluatorM163, invocationKind: "registry.evaluator" }) ||
    matches("release.m163", { ...npmEvaluatorM163, invocationKind: "npm.workflow" }) ||
    matches("release.m163", {
      ...npmEvaluatorM163,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    }) ||
    matches("release.m164", { ...npmEvaluatorM164, baselineHandle: "releaseWorkflowFixtureSource" }) ||
    matches("release.m164", { ...npmEvaluatorM164, invocationKind: "registry.evaluator" }) ||
    matches("release.m164", { ...npmEvaluatorM164, invocationKind: "npm.workflow" }) ||
    matches("release.m164", {
      ...npmEvaluatorM164,
      companionSlot: "release",
      companionHandle: "releaseWorkflowFixtureSource"
    })
  ) {
    problems.push(
      "release mutation frozen declarative invocation matching must preserve exact Registry/NPM oracle families " +
        "and all companion directions"
    );
  }
}

function validateHybridPartition(
  manifest: IdentityManifest,
  matrix: MatrixScan,
  declarative: HybridDeclarativeScan,
  problems: string[]
): ReadonlyMap<string, LegacyMutationCall> {
  const mutationById = new Map(manifest.mutations.map((mutation) => [mutation.id, mutation]));
  const caseByRoot = new Map(manifest.cases.map((identityCase) => [identityCase.root, identityCase]));
  const sourceBindingById = new Map(manifest.sources.map((source) => [source.id, source.declarativeBinding]));
  const observedDeclarativeIds = declarative.mutations.map((mutation) => mutation.id);
  if (JSON.stringify(observedDeclarativeIds) !== JSON.stringify(MIGRATED_DECLARATIVE_IDS)) {
    problems.push(
      `release mutation hybrid declarative allowlist must be exact ${MIGRATED_DECLARATIVE_IDS.join(", ")}; ` +
        `found ${observedDeclarativeIds.join(", ")}`
    );
  }
  const duplicateDeclarativeIds = duplicateValues(observedDeclarativeIds);
  if (duplicateDeclarativeIds.length !== 0) {
    problems.push(`release mutation hybrid declarative IDs must be unique: ${duplicateDeclarativeIds.join(", ")}`);
  }
  const handleToId = new Map<string, string>();
  let declarativeFirst = 0;
  let declarativeAll = 0;
  for (const observed of declarative.mutations) {
    const frozen = mutationById.get(observed.id);
    if (frozen === undefined) {
      problems.push(`release mutation hybrid descriptor ${observed.id} has no frozen identity`);
      continue;
    }
    handleToId.set(observed.handle, observed.id);
    const expectedHandle = expectedMutationHandle(observed.id);
    if (observed.handle !== expectedHandle) {
      problems.push(`release mutation hybrid descriptor ${observed.id} handle must be ${expectedHandle}`);
    }
    if (observed.mode === "first") declarativeFirst++;
    else declarativeAll++;
    if (observed.mode !== frozen.mode) {
      problems.push(`release mutation hybrid descriptor ${observed.id} mode disagrees with frozen identity`);
    }
    const frozenSourceHandle =
      frozen.source.kind === "source"
        ? sourceBindingById.get(frozen.source.id)
        : expectedMutationHandle(frozen.source.id);
    const exactFrozenTopology =
      frozen.id === "release.m108"
        ? frozen.role === "dependency" && frozen.ownerRoot === "release.m107" && frozen.replacementDependency === null
        : frozen.id === "release.m140"
          ? frozen.role === "dependency" && frozen.ownerRoot === "release.m139" && frozen.replacementDependency === null
          : frozen.id === "release.m139"
            ? frozen.role === "root" &&
              frozen.ownerRoot === frozen.id &&
              frozen.replacementDependency === "release.m140"
            : frozen.id === "release.m145"
              ? frozen.role === "dependency" &&
                frozen.ownerRoot === "release.m144" &&
                frozen.replacementDependency === null
              : frozen.id === "release.m144"
                ? frozen.role === "root" &&
                  frozen.ownerRoot === frozen.id &&
                  frozen.replacementDependency === "release.m145"
                : frozen.role === "root" && frozen.ownerRoot === frozen.id && frozen.replacementDependency === null;
    const frozenReplacementHandle =
      frozen.replacementDependency === null ? null : expectedMutationHandle(frozen.replacementDependency);
    const exactWitnessDerivation =
      (frozen.witness.derivation === "needle" && frozen.witness.anchor === frozen.expressions.needle.resolved) ||
      (frozen.witness.derivation === "replacement" &&
        frozen.witness.anchor === frozen.expressions.replacement.resolved) ||
      exactM151TokenDeltaWitnessSemantics(frozen, frozen.expressions.needle.resolved);
    if (
      frozenSourceHandle === undefined ||
      observed.sourceHandle !== frozenSourceHandle ||
      (frozen.source.kind === "mutation" && handleToId.get(observed.sourceHandle) !== frozen.source.id) ||
      observed.needle !== frozen.expressions.needle.resolved ||
      (frozen.replacementDependency === null
        ? observed.replacement !== frozen.expressions.replacement.resolved || observed.replacementHandle !== null
        : observed.replacement !== null ||
          observed.replacementHandle !== frozenReplacementHandle ||
          (observed.replacementHandle !== null &&
            handleToId.get(observed.replacementHandle) !== frozen.replacementDependency)) ||
      observed.expectedOccurrences !== frozen.expressions.expectedOccurrences.resolved ||
      observed.witness.kind !== frozen.witness.kind ||
      observed.witness.anchor !== frozen.witness.anchor ||
      observed.witness.before !== frozen.witness.before ||
      observed.witness.after !== frozen.witness.after ||
      observed.witness.derivation !== frozen.witness.derivation ||
      !exactWitnessDerivation ||
      !exactFrozenTopology
    ) {
      problems.push(`release mutation hybrid descriptor ${observed.id} disagrees with its exact frozen semantics`);
    }
  }
  const observedAllIds = declarative.mutations
    .filter((mutation) => mutation.mode === "all")
    .map((mutation) => mutation.id);
  if (
    declarative.mutations.length !== 94 ||
    declarativeFirst !== 91 ||
    declarativeAll !== 3 ||
    JSON.stringify(observedAllIds) !== JSON.stringify([...MIGRATED_DECLARATIVE_ALL_IDS])
  ) {
    problems.push(
      `release mutation hybrid migrated modes must be 94 total / 91 first / exact all m009,m018,m034; ` +
        `found ${declarative.mutations.length} / ${declarativeFirst} / ${observedAllIds.join(",")}`
    );
  }

  const observedCaseIds = declarative.cases.map((identityCase) => identityCase.id);
  const expectedCaseIds = MIGRATED_DECLARATIVE_ROOT_IDS.map((id) => id.replace("release.", "release.case."));
  if (JSON.stringify(observedCaseIds) !== JSON.stringify(expectedCaseIds)) {
    problems.push(
      `release mutation hybrid case allowlist must be exact ${expectedCaseIds.join(", ")}; ` +
        `found ${observedCaseIds.join(", ")}`
    );
  }
  for (const observed of declarative.cases) {
    const rootId = handleToId.get(observed.handle);
    const frozen = rootId === undefined ? undefined : caseByRoot.get(rootId);
    const frozenCheck = frozen?.checks[0];
    const exactInvocation =
      rootId !== undefined &&
      frozenCheck !== undefined &&
      matchesFrozenDeclarativeInvocation(manifest, observed, rootId, frozenCheck);
    const expectedInvocationKind =
      rootId !== undefined && MIGRATED_REGISTRY_EVALUATOR_ID_SET.has(rootId)
        ? "registry.evaluator"
        : rootId !== undefined && MIGRATED_REGISTRY_RUN_ID_SET.has(rootId)
          ? "registry.step.run"
          : rootId !== undefined && MIGRATED_REGISTRY_STEP_INTEGRITY_ID_SET.has(rootId)
            ? "registry.step.integrity"
            : rootId !== undefined && MIGRATED_NPM_CONTRACT_RELEASE_ID_SET.has(rootId)
              ? "npm.contract.release"
              : rootId !== undefined && MIGRATED_NPM_CONTRACT_INTEGRITY_ID_SET.has(rootId)
                ? "npm.contract.integrity"
                : rootId !== undefined && MIGRATED_NPM_EVALUATOR_ID_SET.has(rootId)
                  ? "npm.evaluator"
                  : rootId !== undefined && MIGRATED_NPM_WORKFLOW_ID_SET.has(rootId)
                    ? "npm.workflow"
                    : null;
    if (!exactInvocation) {
      problems.push(
        `release mutation hybrid case ${observed.id} invocation must retain its exact frozen oracle adapter`
      );
    }
    const expectedProblem =
      expectedInvocationKind === "registry.evaluator"
        ? REGISTRY_EVALUATOR_PROBLEM
        : expectedInvocationKind === "registry.step.run" || expectedInvocationKind === "registry.step.integrity"
          ? REGISTRY_WORKFLOW_PROBLEM
          : expectedInvocationKind === "npm.contract.release" ||
              expectedInvocationKind === "npm.contract.integrity" ||
              expectedInvocationKind === "npm.evaluator"
            ? NPM_PROVENANCE_PROBLEM
            : expectedInvocationKind === "npm.workflow"
              ? NPM_PROVENANCE_PROBLEM
              : null;
    if (
      rootId === undefined ||
      frozen === undefined ||
      observed.id !== frozen.id ||
      observed.handle !== expectedMutationHandle(rootId) ||
      frozenCheck === undefined ||
      !exactInvocation ||
      observed.invocationKind !== expectedInvocationKind ||
      frozenCheck.invoke.kind !== expectedInvocationKind ||
      observed.expectationId !== frozenCheck.expectation.id ||
      frozenCheck.expectation.kind !== "problem" ||
      observed.problem !== frozenCheck.expectation.problem ||
      observed.problem !== expectedProblem ||
      frozen.checks.length !== 1 ||
      frozenCheck.matcherEvaluations.length !== 1
    ) {
      problems.push(`release mutation hybrid case ${observed.id} disagrees with its exact frozen identity`);
    }
  }
  if (declarative.cases.length !== 91) {
    problems.push(`release mutation hybrid migrated cases must equal 91; found ${declarative.cases.length}`);
  }

  const frozenLegacyOrder = [...manifest.mutations].sort((left, right) => left.legacyOrder - right.legacyOrder);
  const expectedLegacy = frozenLegacyOrder.filter((mutation) => !MIGRATED_DECLARATIVE_ID_SET.has(mutation.id));
  const legacyById = new Map<string, LegacyMutationCall>();
  const numericDeclarations = matrix.declarations;
  const stringDeclarations = matrix.declarations;
  if (matrix.calls.length !== 466) {
    problems.push(`release mutation hybrid remaining legacy calls must equal 466; found ${matrix.calls.length}`);
  }
  const comparableLength = Math.min(expectedLegacy.length, matrix.calls.length);
  for (let index = 0; index < comparableLength; index++) {
    const frozen = expectedLegacy[index];
    const current = matrix.calls[index];
    if (frozen === undefined || current === undefined) continue;
    if (current.mode !== frozen.mode || current.span.sha256 !== frozen.legacySpan.sha256) {
      problems.push(
        `release mutation hybrid remaining legacy order ${index + 1} must retain ${frozen.id} exact node-text identity`
      );
    } else {
      // `legacyOccurrence` is keyed by the raw expression tuple, not by AST-node hash.
      // Once an earlier tuple peer migrates, only the exact filtered legacy order can preserve
      // the immutable ID-to-node relation without conflating those two ordinal domains.
      legacyById.set(frozen.id, current);
    }
    const currentExpressions = {
      source: current.sourceExpression,
      needle: current.needleExpression,
      replacement: current.replacementExpression,
      expectedOccurrences: current.expectedOccurrencesExpression
    };
    for (const key of ["source", "needle", "replacement", "expectedOccurrences"] as const) {
      if (frozen.expressions[key].raw !== currentExpressions[key]) {
        problems.push(`manifest mutation ${frozen.id} ${key} raw expression disagrees with exact AST identity`);
      }
    }
    const observedNeedle = resolveStaticString(current.node.arguments[1], stringDeclarations);
    if (observedNeedle === null || observedNeedle !== frozen.expressions.needle.resolved) {
      problems.push(`manifest mutation ${frozen.id} resolved needle disagrees with independent AST evaluation`);
    }
    if (frozen.replacementDependency === null) {
      const observedReplacement = resolveStaticString(current.node.arguments[2], stringDeclarations);
      if (observedReplacement === null || observedReplacement !== frozen.expressions.replacement.resolved) {
        problems.push(`manifest mutation ${frozen.id} resolved replacement disagrees with independent AST evaluation`);
      }
    }
    const observedExpectedOccurrences = resolveStaticInteger(current.node.arguments[3], numericDeclarations) ?? 1;
    if (observedExpectedOccurrences !== frozen.expressions.expectedOccurrences.resolved) {
      problems.push(
        `manifest mutation ${frozen.id} resolved expectedOccurrences must be ${observedExpectedOccurrences}; ` +
          `found ${frozen.expressions.expectedOccurrences.resolved}`
      );
    }
  }
  const legacyFirst = expectedLegacy.filter((mutation) => mutation.mode === "first").length;
  const legacyAll = expectedLegacy.filter((mutation) => mutation.mode === "all").length;
  const legacyRoots = expectedLegacy.filter((mutation) => mutation.role === "root").length;
  const legacyDependencies = expectedLegacy.filter((mutation) => mutation.role === "dependency").length;
  const legacyCases = manifest.cases.filter((identityCase) => !MIGRATED_DECLARATIVE_ID_SET.has(identityCase.root));
  const legacyChecks = legacyCases.reduce((total, identityCase) => total + identityCase.checks.length, 0);
  const legacyLeaves = legacyCases.reduce(
    (total, identityCase) =>
      total + identityCase.checks.reduce((caseTotal, check) => caseTotal + check.matcherEvaluations.length, 0),
    0
  );
  if (
    expectedLegacy.length !== 466 ||
    legacyFirst !== 447 ||
    legacyAll !== 19 ||
    legacyRoots !== 445 ||
    legacyDependencies !== 21 ||
    legacyCases.length !== 445 ||
    legacyChecks !== 450 ||
    legacyLeaves !== 455
  ) {
    problems.push(
      `release mutation hybrid frozen partition must retain 466=447/19, 445 roots/cases, 21 dependencies, ` +
        `450 checks and 455 leaves; found ${expectedLegacy.length}=${legacyFirst}/${legacyAll}, ` +
        `${legacyRoots}/${legacyCases.length}, ${legacyDependencies}, ${legacyChecks}, ${legacyLeaves}`
    );
  }

  const declarativeCounts = new Map<string, number>();
  for (const mutation of declarative.mutations) {
    declarativeCounts.set(mutation.id, (declarativeCounts.get(mutation.id) ?? 0) + 1);
  }
  const exactLegacyKey = (mode: MutationMode, hash: string): string => `${mode}:${hash}`;
  const observedLegacyMultiplicity = new Map<string, number>();
  for (const call of matrix.calls) {
    const key = exactLegacyKey(call.mode, call.span.sha256);
    observedLegacyMultiplicity.set(key, (observedLegacyMultiplicity.get(key) ?? 0) + 1);
  }
  const expectedLegacyMultiplicity = new Map<string, number>();
  for (const mutation of expectedLegacy) {
    const key = exactLegacyKey(mutation.mode, mutation.legacySpan.sha256);
    expectedLegacyMultiplicity.set(key, (expectedLegacyMultiplicity.get(key) ?? 0) + 1);
  }
  for (const mutation of manifest.mutations) {
    const migrated = MIGRATED_DECLARATIVE_ID_SET.has(mutation.id);
    const key = exactLegacyKey(mutation.mode, mutation.legacySpan.sha256);
    const observedMultiplicity = observedLegacyMultiplicity.get(key) ?? 0;
    const expectedMultiplicity = expectedLegacyMultiplicity.get(key) ?? 0;
    const legacyCount = migrated
      ? Math.max(0, observedMultiplicity - expectedMultiplicity)
      : Number(legacyById.has(mutation.id));
    const declarativeCount = declarativeCounts.get(mutation.id) ?? 0;
    if (legacyCount + declarativeCount !== 1) {
      problems.push(
        `release mutation hybrid frozen ID ${mutation.id} must exist in exactly one legacy XOR declarative ` +
          `representation; found ${legacyCount}/${declarativeCount}`
      );
    }
    const dependencies = [
      mutation.source.kind === "mutation" ? mutation.source.id : null,
      mutation.replacementDependency
    ].filter((value): value is string => value !== null);
    for (const dependency of dependencies) {
      if (MIGRATED_DECLARATIVE_ID_SET.has(dependency) !== migrated) {
        problems.push(
          `release mutation hybrid dependency edge ${dependency}->${mutation.id} crosses the freeze boundary`
        );
      }
    }
    if (MIGRATED_DECLARATIVE_ID_SET.has(mutation.ownerRoot) !== migrated) {
      problems.push(
        `release mutation hybrid owner root ${mutation.ownerRoot} for ${mutation.id} crosses the freeze boundary`
      );
    }
  }
  return legacyById;
}

function matcherCallsByNodeSha(matrix: MatrixScan): ReadonlyMap<string, readonly ts.CallExpression[]> {
  const calls = new Map<string, ts.CallExpression[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.getStart(matrix.sourceFile) >= matrix.matrixStart &&
      node.end <= matrix.callback.body.end
    ) {
      const hash = sha256(node.getText(matrix.sourceFile));
      const entries = calls.get(hash) ?? [];
      entries.push(node);
      calls.set(hash, entries);
    }
    ts.forEachChild(node, visit);
  };
  visit(matrix.callback.body);
  return calls;
}

function expectedPhysicalMatcherCountsByHash(
  ownerships: Iterable<FrozenMatcherSpanOwnership>
): ReadonlyMap<string, number> {
  const remainingFrozenSpansByHash = new Map<string, Set<string>>();
  for (const ownership of ownerships) {
    const hash = ownership.span.sha256;
    const spans = remainingFrozenSpansByHash.get(hash) ?? new Set<string>();
    remainingFrozenSpansByHash.set(hash, spans);
    if (ownership.remainingLegacy) {
      spans.add(`${ownership.span.start}:${ownership.span.end}:${hash}`);
    }
  }
  const expectedCountsByHash = new Map<string, number>();
  for (const [hash, spans] of remainingFrozenSpansByHash) {
    expectedCountsByHash.set(hash, spans.size);
  }
  return expectedCountsByHash;
}

function validateMatcherMultiplicitySemantics(problems: string[]): void {
  const span = (start: number, end: number, hash: string): IdentitySpan => ({
    start,
    end,
    line: 1,
    column: 1,
    sha256: hash
  });
  const sharedSpan = span(10, 20, "shared");
  const observed = expectedPhysicalMatcherCountsByHash([
    { remainingLegacy: true, span: sharedSpan },
    { remainingLegacy: true, span: sharedSpan },
    { remainingLegacy: false, span: sharedSpan },
    { remainingLegacy: false, span: span(30, 40, "migrated-only") },
    { remainingLegacy: true, span: span(50, 60, "identical-text-twins") },
    { remainingLegacy: true, span: span(70, 80, "identical-text-twins") }
  ]);
  if (
    observed.size !== 3 ||
    observed.get("shared") !== 1 ||
    observed.get("migrated-only") !== 0 ||
    observed.get("identical-text-twins") !== 2
  ) {
    problems.push(
      "release mutation matcher multiplicity must preserve mixed ownership, migrated zeroes and distinct spans"
    );
  }
}

function rootBoundToCurrentMatcher(
  rootCall: ts.CallExpression,
  matcherCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
  graph: VariableBindingGraph
): boolean {
  return rootIsBoundToAssertion(rootCall, matcherCall, sourceFile, graph);
}

interface SharedLegacyPrimaryOwner {
  readonly caseId: string;
  readonly frozenRootAnchor: number;
  readonly rootCall: ts.CallExpression;
}

const SHARED_REGISTRY_PRIMARY_MATCHER_SHA256 = "5e2815d5e91972642e0cdafbaab958423ce7403d42923787ef09ba6cb4377f45";
const SHARED_RELEASE_TRANSACTION_PRIMARY_MATCHER_SHA256 =
  "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f";
const SHARED_TAG_IDENTITY_PRIMARY_MATCHER_SHA256 = "2392196bed7b80a20f9390166f389991da7ed6decb2db2073652fc860633666f";
const SHARED_REGISTRY_OWNERLESS_PREFIX_SHA256 = Object.freeze([
  "d72a02a11e021ddd52c7b8d2e4c6b23324f827b475f25b6bce1e1c428f5ce753",
  "4bc602a330dceb4e0cbf4d49611d34f24de797de1e5e6e6bc3786d302ce85abe",
  "dfefccf9dd2d5d0427555f71e8fec6ef7fcd107e27551d0af9c64e577600827b",
  "739836016c0078b5b91102dac1f12c74f59029d1c18dd7b86f3bd6ca02e691c6"
]);

type SharedTopologyProjection =
  | { readonly kind: "identity" }
  | { readonly index: number; readonly kind: "tuple"; readonly length: number }
  | {
      readonly expectedProblemProperty: string;
      readonly kind: "transaction-object";
      readonly mutantProperty: string;
    };

function unwrapTopologyExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function symbolIdentifiers(root: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker): readonly ts.Identifier[] {
  const identifiers: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) identifiers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return identifiers;
}

function exactNamedTopologyArray(
  identifier: ts.Identifier,
  use: ts.Identifier,
  matrix: MatrixScan,
  graph: VariableBindingGraph
): ts.ArrayLiteralExpression | null {
  const symbol = graph.checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration;
  if (
    symbol === undefined ||
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined
  ) {
    return null;
  }
  const declarationList = declaration.parent;
  const statement = ts.isVariableDeclarationList(declarationList) ? declarationList.parent : undefined;
  const array = unwrapTopologyExpression(declaration.initializer);
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    declarationList.declarations.length !== 1 ||
    (declarationList.flags & ts.NodeFlags.Const) === 0 ||
    statement === undefined ||
    !ts.isVariableStatement(statement) ||
    statement.parent !== matrix.callback.body ||
    statement.getStart(matrix.sourceFile) >= use.getStart(matrix.sourceFile) ||
    !ts.isArrayLiteralExpression(array)
  ) {
    return null;
  }
  const references = symbolIdentifiers(matrix.callback.body, symbol, graph.checker);
  return references.length === 2 && references.includes(declaration.name) && references.includes(use) ? array : null;
}

function denseTopologyArray(array: ts.ArrayLiteralExpression): boolean {
  return array.elements.every((element) => !ts.isOmittedExpression(element) && !ts.isSpreadElement(element));
}

function exactRegistryStepWrapperArgument(
  expression: ts.Expression,
  matrix: MatrixScan,
  graph: VariableBindingGraph
): ts.Expression | null {
  const value = unwrapTopologyExpression(expression);
  if (
    !ts.isCallExpression(value) ||
    value.questionDotToken !== undefined ||
    value.typeArguments !== undefined ||
    value.arguments.length !== 1 ||
    !ts.isIdentifier(value.expression) ||
    value.expression.text !== "registryStepWithRun"
  ) {
    return null;
  }
  const symbol = graph.checker.getSymbolAtLocation(value.expression);
  const declaration = symbol?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== "registryStepWithRun" ||
    declaration.initializer === undefined ||
    !ts.isArrowFunction(declaration.initializer)
  ) {
    return null;
  }
  const declarationList = declaration.parent;
  const statement = ts.isVariableDeclarationList(declarationList) ? declarationList.parent : undefined;
  const arrow = declaration.initializer;
  const parameter = arrow.parameters[0];
  const arrowBody = arrow.body;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    declarationList.declarations.length !== 1 ||
    (declarationList.flags & ts.NodeFlags.Const) === 0 ||
    statement === undefined ||
    !ts.isVariableStatement(statement) ||
    statement.parent !== matrix.callback.body ||
    statement.getStart(matrix.sourceFile) >= value.getStart(matrix.sourceFile) ||
    (arrow.modifiers?.length ?? 0) !== 0 ||
    (arrow.typeParameters?.length ?? 0) !== 0 ||
    arrow.parameters.length !== 1 ||
    parameter === undefined ||
    parameter.dotDotDotToken !== undefined ||
    parameter.initializer !== undefined ||
    !ts.isIdentifier(parameter.name) ||
    parameter.name.text !== "run" ||
    ts.isBlock(arrowBody)
  ) {
    return null;
  }
  const body = unwrapTopologyExpression(arrowBody);
  if (!ts.isObjectLiteralExpression(body) || body.properties.length !== 2) return null;
  const registrySpread = body.properties[0];
  const runProperty = body.properties[1];
  if (
    registrySpread === undefined ||
    !ts.isSpreadAssignment(registrySpread) ||
    !ts.isIdentifier(registrySpread.expression) ||
    registrySpread.expression.text !== "registryStep" ||
    runProperty === undefined ||
    !ts.isShorthandPropertyAssignment(runProperty) ||
    runProperty.objectAssignmentInitializer !== undefined ||
    runProperty.name.text !== "run" ||
    graph.checker.getSymbolAtLocation(parameter.name) === undefined ||
    graph.checker.getSymbolAtLocation(parameter.name) !== graph.checker.getShorthandAssignmentValueSymbol(runProperty)
  ) {
    return null;
  }
  return value.arguments[0] ?? null;
}

function exactDirectTopologyCarrierRoot(
  identifier: ts.Identifier,
  rootCall: ts.CallExpression,
  matrix: MatrixScan,
  graph: VariableBindingGraph
): boolean {
  const symbol = graph.checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined ||
    unwrapTopologyExpression(declaration.initializer) !== rootCall
  ) {
    return false;
  }
  const declarationList = declaration.parent;
  const statement = ts.isVariableDeclarationList(declarationList) ? declarationList.parent : undefined;
  return (
    ts.isVariableDeclarationList(declarationList) &&
    declarationList.declarations.length === 1 &&
    (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    statement !== undefined &&
    ts.isVariableStatement(statement) &&
    statement.parent === matrix.callback.body &&
    statement.getStart(matrix.sourceFile) < identifier.getStart(matrix.sourceFile)
  );
}

function rootIsExactSharedTopologyValue(
  rootCall: ts.CallExpression,
  projected: ts.Expression,
  matcherHash: string,
  matrix: MatrixScan,
  graph: VariableBindingGraph
): boolean {
  const value = unwrapTopologyExpression(projected);
  if (matcherHash !== SHARED_REGISTRY_PRIMARY_MATCHER_SHA256) return value === rootCall;
  const wrapped = exactRegistryStepWrapperArgument(value, matrix, graph);
  if (wrapped === null) return false;
  const run = unwrapTopologyExpression(wrapped);
  return run === rootCall || (ts.isIdentifier(run) && exactDirectTopologyCarrierRoot(run, rootCall, matrix, graph));
}

function exactSharedTopologyMatcher(
  matcher: ts.CallExpression
): { readonly actual: ts.Expression; readonly expected: ts.Expression } | null {
  if (
    matcher.questionDotToken !== undefined ||
    matcher.typeArguments !== undefined ||
    matcher.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(matcher.expression) ||
    matcher.expression.questionDotToken !== undefined ||
    matcher.expression.name.text !== "toContain" ||
    !ts.isCallExpression(matcher.expression.expression)
  ) {
    return null;
  }
  const expectCall = matcher.expression.expression;
  const actual = expectCall.arguments[0];
  const expected = matcher.arguments[0];
  if (
    expectCall.questionDotToken !== undefined ||
    expectCall.typeArguments !== undefined ||
    !ts.isIdentifier(expectCall.expression) ||
    expectCall.expression.text !== "expect" ||
    (expectCall.arguments.length !== 1 && expectCall.arguments.length !== 2) ||
    actual === undefined ||
    expected === undefined
  ) {
    return null;
  }
  return { actual, expected };
}

function exactPlainBindingIdentifier(
  element: ts.ArrayBindingElement | ts.BindingElement | undefined,
  name: string
): ts.Identifier | null {
  return element !== undefined &&
    !ts.isOmittedExpression(element) &&
    element.dotDotDotToken === undefined &&
    element.propertyName === undefined &&
    element.initializer === undefined &&
    ts.isIdentifier(element.name) &&
    element.name.text === name
    ? element.name
    : null;
}

function bindingUsedExactly(
  identifier: ts.Identifier,
  node: ts.Node,
  checker: ts.TypeChecker,
  expectedOccurrences: number
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol !== undefined && symbolIdentifiers(node, symbol, checker).length === expectedOccurrences;
}

function exactForOfProjection(
  name: ts.BindingName,
  matcher: ts.CallExpression,
  matcherHash: string,
  graph: VariableBindingGraph
): SharedTopologyProjection | null {
  const matcherParts = exactSharedTopologyMatcher(matcher);
  if (matcherParts === null) return null;
  if (ts.isIdentifier(name)) {
    return bindingUsedExactly(name, matcherParts.actual, graph.checker, 1) &&
      bindingUsedExactly(name, matcher, graph.checker, 1)
      ? { kind: "identity" }
      : null;
  }
  if (
    matcherHash !== SHARED_TAG_IDENTITY_PRIMARY_MATCHER_SHA256 ||
    !ts.isArrayBindingPattern(name) ||
    name.elements.length !== 2
  ) {
    return null;
  }
  const label = exactPlainBindingIdentifier(name.elements[0], "label");
  const weakenedRelease = exactPlainBindingIdentifier(name.elements[1], "weakenedRelease");
  if (
    label === null ||
    weakenedRelease === null ||
    !bindingUsedExactly(weakenedRelease, matcherParts.actual, graph.checker, 1) ||
    !bindingUsedExactly(weakenedRelease, matcher, graph.checker, 1) ||
    !bindingUsedExactly(label, matcher, graph.checker, 1)
  ) {
    return null;
  }
  return { index: 1, kind: "tuple", length: 2 };
}

function exactObjectPropertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  const matching = object.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
  );
  return matching.length === 1 ? (matching[0]?.initializer ?? null) : null;
}

function projectSharedTopologyElement(
  element: ts.Expression,
  projection: SharedTopologyProjection
): ts.Expression | null {
  const unwrapped = unwrapTopologyExpression(element);
  if (projection.kind === "identity") return unwrapped;
  if (projection.kind === "tuple") {
    const label = ts.isArrayLiteralExpression(unwrapped) ? unwrapped.elements[0] : undefined;
    if (
      !ts.isArrayLiteralExpression(unwrapped) ||
      !denseTopologyArray(unwrapped) ||
      unwrapped.elements.length !== projection.length ||
      label === undefined ||
      ts.isOmittedExpression(label) ||
      ts.isSpreadElement(label) ||
      (!ts.isStringLiteral(label) && !ts.isNoSubstitutionTemplateLiteral(label))
    ) {
      return null;
    }
    const projected = unwrapped.elements[projection.index];
    return projected === undefined || ts.isOmittedExpression(projected) || ts.isSpreadElement(projected)
      ? null
      : unwrapTopologyExpression(projected);
  }
  if (!ts.isObjectLiteralExpression(unwrapped) || unwrapped.properties.length !== 2) return null;
  const mutant = exactObjectPropertyInitializer(unwrapped, projection.mutantProperty);
  const expectedProblem = exactObjectPropertyInitializer(unwrapped, projection.expectedProblemProperty);
  return mutant !== null && expectedProblem !== null && ts.isStringLiteralLike(expectedProblem)
    ? unwrapTopologyExpression(mutant)
    : null;
}

function exactSharedRootProjection(
  array: ts.ArrayLiteralExpression,
  owners: readonly SharedLegacyPrimaryOwner[],
  matcherHash: string,
  projection: SharedTopologyProjection,
  matrix: MatrixScan,
  graph: VariableBindingGraph
): boolean {
  if (!denseTopologyArray(array)) return false;
  const ownerlessPrefix =
    matcherHash === SHARED_REGISTRY_PRIMARY_MATCHER_SHA256 ? SHARED_REGISTRY_OWNERLESS_PREFIX_SHA256 : [];
  if (array.elements.length !== owners.length + ownerlessPrefix.length) return false;
  const expected = [...owners].sort((left, right) => left.frozenRootAnchor - right.frozenRootAnchor);
  for (let index = 0; index < array.elements.length; index++) {
    const element = array.elements[index];
    if (element === undefined || ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return false;
    const projected = projectSharedTopologyElement(element, projection);
    if (projected === null) return false;
    const matches = owners.filter((owner) =>
      rootIsExactSharedTopologyValue(owner.rootCall, projected, matcherHash, matrix, graph)
    );
    if (index < ownerlessPrefix.length) {
      const expectedPrefixHash = ownerlessPrefix[index];
      if (
        matches.length !== 0 ||
        expectedPrefixHash === undefined ||
        sha256(element.getText(matrix.sourceFile)) !== expectedPrefixHash
      ) {
        return false;
      }
      continue;
    }
    const expectedOwner = expected[index - ownerlessPrefix.length];
    if (matches.length !== 1 || expectedOwner === undefined || matches[0]?.caseId !== expectedOwner.caseId) {
      return false;
    }
  }
  return true;
}

function exactForOfSharedTopology(
  loop: ts.ForOfStatement,
  matcher: ts.CallExpression,
  owners: readonly SharedLegacyPrimaryOwner[],
  matcherHash: string,
  matrix: MatrixScan,
  graph: VariableBindingGraph
): boolean {
  if (
    loop.awaitModifier !== undefined ||
    !ts.isVariableDeclarationList(loop.initializer) ||
    loop.initializer.declarations.length !== 1 ||
    (loop.initializer.flags & ts.NodeFlags.Const) === 0 ||
    loop.initializer.declarations[0]?.initializer !== undefined ||
    !ts.isBlock(loop.statement) ||
    loop.statement.statements.length !== 1
  ) {
    return false;
  }
  const matcherStatement = loop.statement.statements[0];
  if (
    matcherStatement === undefined ||
    !ts.isExpressionStatement(matcherStatement) ||
    matcherStatement.expression !== matcher
  ) {
    return false;
  }
  const declaration = loop.initializer.declarations[0];
  if (declaration === undefined) return false;
  const projection = exactForOfProjection(declaration.name, matcher, matcherHash, graph);
  if (projection === null) return false;

  const iterable = unwrapTopologyExpression(loop.expression);
  const array = ts.isArrayLiteralExpression(iterable)
    ? iterable
    : ts.isIdentifier(iterable)
      ? exactNamedTopologyArray(iterable, iterable, matrix, graph)
      : null;
  return array !== null && exactSharedRootProjection(array, owners, matcherHash, projection, matrix, graph);
}

function sameSymbol(left: ts.Identifier, right: ts.Identifier, checker: ts.TypeChecker): boolean {
  const leftSymbol = checker.getSymbolAtLocation(left);
  return leftSymbol !== undefined && leftSymbol === checker.getSymbolAtLocation(right);
}

function exactNumericSharedTopology(
  loop: ts.ForStatement,
  matcher: ts.CallExpression,
  owners: readonly SharedLegacyPrimaryOwner[],
  matcherHash: string,
  matrix: MatrixScan,
  graph: VariableBindingGraph
): boolean {
  const initializer = loop.initializer;
  if (
    initializer === undefined ||
    !ts.isVariableDeclarationList(initializer) ||
    initializer.declarations.length !== 1 ||
    (initializer.flags & ts.NodeFlags.Let) === 0 ||
    !ts.isBlock(loop.statement) ||
    loop.statement.statements.length !== 2
  ) {
    return false;
  }
  const indexDeclaration = initializer.declarations[0];
  const indexInitializer = indexDeclaration?.initializer;
  if (
    indexDeclaration === undefined ||
    !ts.isIdentifier(indexDeclaration.name) ||
    indexInitializer === undefined ||
    !ts.isNumericLiteral(indexInitializer) ||
    indexInitializer.text !== "0"
  ) {
    return false;
  }
  const condition = loop.condition;
  const incrementor = loop.incrementor;
  if (
    condition === undefined ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(condition.left) ||
    !sameSymbol(indexDeclaration.name, condition.left, graph.checker) ||
    !ts.isNumericLiteral(condition.right) ||
    incrementor === undefined ||
    !ts.isPostfixUnaryExpression(incrementor) ||
    incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
    !ts.isIdentifier(incrementor.operand) ||
    !sameSymbol(indexDeclaration.name, incrementor.operand, graph.checker)
  ) {
    return false;
  }

  const bindingStatement = loop.statement.statements[0];
  const matcherStatement = loop.statement.statements[1];
  if (
    bindingStatement === undefined ||
    matcherStatement === undefined ||
    !ts.isVariableStatement(bindingStatement) ||
    bindingStatement.declarationList.declarations.length !== 1 ||
    (bindingStatement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isExpressionStatement(matcherStatement) ||
    matcherStatement.expression !== matcher
  ) {
    return false;
  }
  const binding = bindingStatement.declarationList.declarations[0];
  const bindingInitializer = binding?.initializer;
  const indexed = bindingInitializer === undefined ? null : unwrapTopologyExpression(bindingInitializer);
  const matcherParts = exactSharedTopologyMatcher(matcher);
  if (
    binding === undefined ||
    !ts.isObjectBindingPattern(binding.name) ||
    binding.name.elements.length !== 2 ||
    matcherHash !== SHARED_RELEASE_TRANSACTION_PRIMARY_MATCHER_SHA256 ||
    matcherParts === null ||
    indexed === null ||
    !ts.isElementAccessExpression(indexed) ||
    !ts.isIdentifier(indexed.expression) ||
    indexed.argumentExpression === undefined ||
    !ts.isIdentifier(indexed.argumentExpression) ||
    !sameSymbol(indexDeclaration.name, indexed.argumentExpression, graph.checker)
  ) {
    return false;
  }
  const mutant = exactPlainBindingIdentifier(binding.name.elements[0], "mutant");
  const expectedProblem = exactPlainBindingIdentifier(binding.name.elements[1], "expectedProblem");
  if (
    mutant === null ||
    expectedProblem === null ||
    !bindingUsedExactly(mutant, matcherParts.actual, graph.checker, 1) ||
    !bindingUsedExactly(mutant, matcher, graph.checker, 1) ||
    !bindingUsedExactly(expectedProblem, matcherParts.expected, graph.checker, 1) ||
    !bindingUsedExactly(expectedProblem, matcher, graph.checker, 1)
  ) {
    return false;
  }
  const array = exactNamedTopologyArray(indexed.expression, indexed.expression, matrix, graph);
  const projection: SharedTopologyProjection = {
    expectedProblemProperty: "expectedProblem",
    kind: "transaction-object",
    mutantProperty: "mutant"
  };
  return (
    array !== null &&
    Number(condition.right.text) === array.elements.length &&
    exactSharedRootProjection(array, owners, matcherHash, projection, matrix, graph)
  );
}

function enclosingSharedExecutionLoop(
  matcher: ts.CallExpression,
  callback: ts.ArrowFunction
): ts.ForOfStatement | ts.ForStatement | null {
  let current: ts.Node | undefined = matcher.parent;
  while (current !== undefined && current !== callback) {
    if (ts.isForOfStatement(current) || ts.isForStatement(current)) return current;
    current = current.parent;
  }
  return null;
}

function validateMatrixCallbackNoReturns(matrix: MatrixScan, problems: string[]): void {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  visit(matrix.callback.body);
  for (const statement of returns) {
    const position = matrix.sourceFile.getLineAndCharacterOfPosition(statement.getStart(matrix.sourceFile));
    problems.push(
      "release mutation hybrid matrix callback must not return before all case executions; " +
        `found return at ${position.line + 1}:${position.character + 1}`
    );
  }
}

function validateSharedLegacyPrimaryTopologies(
  manifest: IdentityManifest,
  matrix: MatrixScan,
  anchors: Map<string, LegacyCaseExecutionAnchor>,
  graph: VariableBindingGraph,
  problems: string[]
): void {
  const mutationById = new Map(manifest.mutations.map((mutation) => [mutation.id, mutation]));
  const ownersByMatcher = new Map<ts.CallExpression, SharedLegacyPrimaryOwner[]>();
  for (const identityCase of manifest.cases) {
    const anchor = anchors.get(identityCase.id);
    const frozenRoot = mutationById.get(identityCase.root);
    if (anchor === undefined || frozenRoot === undefined) continue;
    const owners = ownersByMatcher.get(anchor.matcher) ?? [];
    owners.push({
      caseId: identityCase.id,
      frozenRootAnchor: frozenRoot.legacySpan.start,
      rootCall: anchor.rootCall
    });
    ownersByMatcher.set(anchor.matcher, owners);
  }

  for (const [matcher, owners] of ownersByMatcher) {
    if (owners.length < 2) continue;
    const matcherHash = sha256(matcher.getText(matrix.sourceFile));
    const loop = enclosingSharedExecutionLoop(matcher, matrix.callback);
    const valid =
      loop !== null &&
      loop.parent === matrix.callback.body &&
      (ts.isForOfStatement(loop)
        ? exactForOfSharedTopology(loop, matcher, owners, matcherHash, matrix, graph)
        : exactNumericSharedTopology(loop, matcher, owners, matcherHash, matrix, graph));
    if (valid) continue;
    problems.push(
      `release mutation hybrid shared primary matcher ${matcherHash} must retain one exact closed ` +
        `iterable/runtime topology for ${owners.length} frozen root(s)`
    );
    for (const owner of owners) anchors.delete(owner.caseId);
  }
}

function validateRemainingLegacyMatchers(
  manifest: IdentityManifest,
  matrix: MatrixScan,
  legacyById: ReadonlyMap<string, LegacyMutationCall>,
  problems: string[]
): ReadonlyMap<string, LegacyCaseExecutionAnchor> {
  const callsByHash = matcherCallsByNodeSha(matrix);
  const bindingGraph = variableBindingFlows(matrix.sourceFile);
  const executionAnchors = new Map<string, LegacyCaseExecutionAnchor>();
  let cases = 0;
  let checks = 0;
  let leaves = 0;
  for (const identityCase of manifest.cases) {
    if (MIGRATED_DECLARATIVE_ID_SET.has(identityCase.root)) continue;
    cases++;
    const rootCall = legacyById.get(identityCase.root)?.node;
    if (rootCall === undefined) {
      problems.push(`release mutation hybrid legacy case ${identityCase.id} has no remaining root call`);
      continue;
    }
    let exactCaseMatchers = true;
    let primaryMatcher: ts.CallExpression | undefined;
    for (let checkIndex = 0; checkIndex < identityCase.checks.length; checkIndex++) {
      const check = identityCase.checks[checkIndex];
      if (check === undefined) continue;
      checks++;
      const matched: ts.CallExpression[] = [];
      let previousStart = -1;
      for (let matcherIndex = 0; matcherIndex < check.matcherEvaluations.length; matcherIndex++) {
        const matcher = check.matcherEvaluations[matcherIndex];
        if (matcher === undefined) continue;
        leaves++;
        const candidates = (callsByHash.get(matcher.assertionSpan.sha256) ?? []).filter(
          (candidate) =>
            candidate.getStart(matrix.sourceFile) > previousStart &&
            rootBoundToCurrentMatcher(rootCall, candidate, matrix.sourceFile, bindingGraph)
        );
        if (candidates.length !== 1) {
          exactCaseMatchers = false;
          problems.push(
            `release mutation hybrid legacy case ${identityCase.id} check ${checkIndex} leaf ${matcherIndex} ` +
              `must have one exact node-text/root-bound matcher; found ${candidates.length}`
          );
          continue;
        }
        const candidate = candidates[0];
        if (candidate !== undefined) {
          if (checkIndex === 0 && matcherIndex === 0) primaryMatcher = candidate;
          matched.push(candidate);
          previousStart = candidate.getStart(matrix.sourceFile);
        }
      }
      const firstMatcher = matched[0];
      const lastMatcher = matched.at(-1);
      if (
        matched.length === check.matcherEvaluations.length &&
        firstMatcher !== undefined &&
        lastMatcher !== undefined
      ) {
        const currentCheckHash = sha256(
          matrix.sourceFile.text.slice(firstMatcher.getStart(matrix.sourceFile), lastMatcher.end)
        );
        if (currentCheckHash !== check.assertionSpan.sha256) {
          exactCaseMatchers = false;
          problems.push(
            `release mutation hybrid legacy case ${identityCase.id} check ${checkIndex} ordered matcher range drifted`
          );
        }
      } else {
        exactCaseMatchers = false;
      }
    }
    if (exactCaseMatchers && primaryMatcher !== undefined) {
      executionAnchors.set(identityCase.id, {
        anchor: primaryMatcher.getStart(matrix.sourceFile),
        matcher: primaryMatcher,
        rootAnchor: rootCall.getStart(matrix.sourceFile),
        rootCall
      });
    }
  }
  if (cases !== 445 || checks !== 450 || leaves !== 455) {
    problems.push(
      `release mutation hybrid remaining matcher census must be 445 cases / 450 checks / 455 leaves; ` +
        `found ${cases} / ${checks} / ${leaves}`
    );
  }
  // One physical loop matcher can represent many frozen cases, including a hash whose
  // logical owners straddle the legacy/declarative boundary. Frozen span identity
  // distinguishes two physical calls with identical node text without comparing stale
  // historical offsets to the shifted current AST.
  const expectedCountsByHash = expectedPhysicalMatcherCountsByHash(
    manifest.cases.flatMap((identityCase) =>
      identityCase.checks.flatMap((check) =>
        check.matcherEvaluations.map((matcher) => ({
          remainingLegacy: !MIGRATED_DECLARATIVE_ID_SET.has(identityCase.root),
          span: matcher.assertionSpan
        }))
      )
    )
  );
  for (const [hash, expected] of expectedCountsByHash) {
    const actual = (callsByHash.get(hash) ?? []).length;
    if (actual !== expected) {
      problems.push(
        `release mutation hybrid matcher ${hash} physical multiplicity must equal ${expected} ` +
          `distinct remaining frozen assertion span(s); found ${actual}`
      );
    }
  }
  validateSharedLegacyPrimaryTopologies(manifest, matrix, executionAnchors, bindingGraph, problems);
  return executionAnchors;
}

function validateGlobalCaseExecutionOrder(
  manifest: IdentityManifest,
  declarative: HybridDeclarativeScan,
  legacyExecutionAnchors: ReadonlyMap<string, LegacyCaseExecutionAnchor>,
  problems: string[]
): void {
  const legacyCases = manifest.cases.filter((identityCase) => !MIGRATED_DECLARATIVE_ID_SET.has(identityCase.root));
  // Matcher validation already owns missing or ambiguous legacy anchors. Do not
  // turn one binding failure into a second, misleading order failure.
  if (legacyExecutionAnchors.size !== legacyCases.length) return;

  const expansion = expandDeclarativeExecutionEvents(declarative.cases, declarative.executionEvents);
  problems.push(...expansion.problems);
  if (expansion.problems.length !== 0) return;

  const rootByHandle = new Map<string, string>();
  for (const mutation of declarative.mutations) {
    if (rootByHandle.has(mutation.handle)) return;
    rootByHandle.set(mutation.handle, mutation.id);
  }
  const observed: AnchoredCaseExecution[] = [];
  for (const execution of expansion.executions) {
    const rootId = rootByHandle.get(execution.identityCase.handle);
    if (rootId === undefined) return;
    observed.push({
      anchor: execution.anchor,
      caseId: execution.identityCase.id,
      rootId,
      tieBreaker: execution.tieBreaker
    });
  }
  for (const identityCase of legacyCases) {
    const executionAnchor = legacyExecutionAnchors.get(identityCase.id);
    if (executionAnchor === undefined) return;
    observed.push({
      anchor: executionAnchor.anchor,
      caseId: identityCase.id,
      rootId: identityCase.root,
      tieBreaker: executionAnchor.rootAnchor
    });
  }
  observed.sort(
    (left, right) =>
      left.anchor - right.anchor || left.tieBreaker - right.tieBreaker || left.caseId.localeCompare(right.caseId)
  );
  const mutationById = new Map(manifest.mutations.map((mutation) => [mutation.id, mutation]));
  const expectedAnchored: AnchoredCaseExecution[] = [];
  for (const identityCase of manifest.cases) {
    const frozenPrimaryMatcher = identityCase.checks[0]?.matcherEvaluations[0];
    const frozenRoot = mutationById.get(identityCase.root);
    if (frozenPrimaryMatcher === undefined || frozenRoot === undefined) return;
    expectedAnchored.push({
      anchor: frozenPrimaryMatcher.assertionSpan.start,
      caseId: identityCase.id,
      rootId: identityCase.root,
      tieBreaker: frozenRoot.legacySpan.start
    });
  }
  expectedAnchored.sort(
    (left, right) =>
      left.anchor - right.anchor || left.tieBreaker - right.tieBreaker || left.caseId.localeCompare(right.caseId)
  );
  const expected = expectedAnchored.map(({ caseId, rootId }) => ({ caseId, rootId }));
  const observedIdentity = observed.map(({ caseId, rootId }) => ({ caseId, rootId }));
  if (JSON.stringify(observedIdentity) === JSON.stringify(expected)) return;

  const comparableLength = Math.max(expected.length, observedIdentity.length);
  let mismatchIndex = 0;
  while (
    mismatchIndex < comparableLength &&
    JSON.stringify(expected[mismatchIndex]) === JSON.stringify(observedIdentity[mismatchIndex])
  ) {
    mismatchIndex++;
  }
  const render = (identity: { readonly caseId: string; readonly rootId: string } | undefined): string =>
    identity === undefined ? "<missing>" : `${identity.caseId}(${identity.rootId})`;
  problems.push(
    "release mutation hybrid global case execution order must equal exact frozen primary-oracle order; " +
      `first mismatch ${mismatchIndex + 1}: expected ${render(expected[mismatchIndex])}, ` +
      `found ${render(observedIdentity[mismatchIndex])}; census ${observedIdentity.length}/${expected.length}`
  );
}

function assignmentTargetContainsIdentifier(value: ts.Expression, identifier: string): boolean {
  if (ts.isIdentifier(value)) return value.text === identifier;
  if (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    return assignmentTargetContainsIdentifier(value.expression, identifier);
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return assignmentTargetContainsIdentifier(value.expression, identifier);
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) => !ts.isOmittedExpression(element) && assignmentTargetContainsIdentifier(element, identifier)
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return property.name.text === identifier;
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetContainsIdentifier(property.initializer, identifier);
      }
      return ts.isSpreadAssignment(property) && assignmentTargetContainsIdentifier(property.expression, identifier);
    });
  }
  if (ts.isSpreadElement(value)) return assignmentTargetContainsIdentifier(value.expression, identifier);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentTargetContainsIdentifier(value.left, identifier);
  }
  return false;
}

const ORACLE_BINDING_ASSIGNMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);

function validateReleaseOraclePins(matrix: MatrixScan, declarative: HybridDeclarativeScan, problems: string[]): void {
  const functionHashes = new Map<string, string[]>();
  const npmProblemConstantHashes: string[] = [];
  const evaluatorProblemConstantHashes: string[] = [];
  const workflowProblemConstantHashes: string[] = [];
  for (const statement of matrix.sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      const entries = functionHashes.get(statement.name.text) ?? [];
      entries.push(sha256(statement.getText(matrix.sourceFile)));
      functionHashes.set(statement.name.text, entries);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "NPM_PROVENANCE_CONTRACT_PROBLEM") {
          npmProblemConstantHashes.push(sha256(statement.getText(matrix.sourceFile)));
        }
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "MCP_REGISTRY_EVALUATOR_CONTRACT_PROBLEM") {
          evaluatorProblemConstantHashes.push(sha256(statement.getText(matrix.sourceFile)));
        }
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM") {
          workflowProblemConstantHashes.push(sha256(statement.getText(matrix.sourceFile)));
        }
      }
    }
  }
  const exactNodeHash = (name: string, expected: string): void => {
    const observed = functionHashes.get(name) ?? [];
    if (observed.length !== 1 || observed[0] !== expected) {
      problems.push(`release mutation hybrid pinned ${name} AST node must retain exact SHA-256 ${expected}`);
    }
  };
  exactNodeHash("mutationMatchCount", MUTATION_MATCH_COUNT_NODE_SHA256);
  exactNodeHash("npmProvenanceContractProblems", NPM_PROVENANCE_DETECTOR_NODE_SHA256);
  exactNodeHash("npmProvenanceEvaluatorProblems", NPM_PROVENANCE_EVALUATOR_DETECTOR_NODE_SHA256);
  exactNodeHash("npmProvenanceWorkflowProblems", NPM_PROVENANCE_WORKFLOW_DETECTOR_NODE_SHA256);
  exactNodeHash("mcpRegistryEvaluatorProblems", REGISTRY_EVALUATOR_DETECTOR_NODE_SHA256);
  exactNodeHash("mcpRegistryStepProblems", REGISTRY_STEP_DETECTOR_NODE_SHA256);
  exactNodeHash("mcpRegistryRunProblems", REGISTRY_RUN_DETECTOR_NODE_SHA256);
  if (npmProblemConstantHashes.length !== 1 || npmProblemConstantHashes[0] !== NPM_PROVENANCE_PROBLEM_NODE_SHA256) {
    problems.push(
      "release mutation hybrid pinned npm provenance problem AST node must retain exact SHA-256 " +
        NPM_PROVENANCE_PROBLEM_NODE_SHA256
    );
  }
  if (
    evaluatorProblemConstantHashes.length !== 1 ||
    evaluatorProblemConstantHashes[0] !== REGISTRY_EVALUATOR_PROBLEM_NODE_SHA256
  ) {
    problems.push(
      "release mutation hybrid pinned registry problem AST node must retain exact SHA-256 " +
        REGISTRY_EVALUATOR_PROBLEM_NODE_SHA256
    );
  }
  if (
    workflowProblemConstantHashes.length !== 1 ||
    workflowProblemConstantHashes[0] !== REGISTRY_WORKFLOW_PROBLEM_NODE_SHA256
  ) {
    problems.push(
      "release mutation hybrid pinned registry workflow problem AST node must retain exact SHA-256 " +
        REGISTRY_WORKFLOW_PROBLEM_NODE_SHA256
    );
  }

  let directBindings = 0;
  let shadowBindings = 0;
  let aliases = 0;
  let writes = 0;
  let otherReferences = 0;
  let npmDirectBindings = 0;
  let npmShadowBindings = 0;
  let npmAliases = 0;
  let npmWrites = 0;
  let npmOtherReferences = 0;
  let npmWorkflowDirectBindings = 0;
  let npmWorkflowShadowBindings = 0;
  let npmWorkflowAliases = 0;
  let npmWorkflowWrites = 0;
  let npmWorkflowOtherReferences = 0;
  let npmEvaluatorDirectBindings = 0;
  let npmEvaluatorShadowBindings = 0;
  let npmEvaluatorAliases = 0;
  let npmEvaluatorWrites = 0;
  let npmEvaluatorOtherReferences = 0;
  let runDirectBindings = 0;
  let runShadowBindings = 0;
  let runAliases = 0;
  let runWrites = 0;
  let runOtherReferences = 0;
  let stepDirectBindings = 0;
  let stepShadowBindings = 0;
  let stepAliases = 0;
  let stepWrites = 0;
  let stepOtherReferences = 0;
  let matchCountDirectBindings = 0;
  let matchCountShadowBindings = 0;
  let matchCountAliases = 0;
  let matchCountWrites = 0;
  let matchCountOtherReferences = 0;
  let mcpbInputWrites = 0;
  const requiredAdapterBindings = requiredReleaseOracleAdapterBindings(declarative.cases);
  const recordShadowBinding = (name: ts.BindingName | ts.Identifier): void => {
    if (ts.isIdentifier(name)) {
      if (name.text === "mcpRegistryEvaluatorProblems") shadowBindings++;
      if (name.text === "npmProvenanceContractProblems") npmShadowBindings++;
      if (name.text === "npmProvenanceEvaluatorProblems") npmEvaluatorShadowBindings++;
      if (name.text === "npmProvenanceWorkflowProblems") npmWorkflowShadowBindings++;
      if (name.text === "mcpRegistryStepProblems") stepShadowBindings++;
      if (name.text === "mcpRegistryRunProblems") runShadowBindings++;
      if (name.text === "mutationMatchCount") matchCountShadowBindings++;
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) recordShadowBinding(element.name);
    }
  };
  const unwrappedIdentifier = (expression: ts.Expression): ts.Identifier | null => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return ts.isIdentifier(current) ? current : null;
  };
  const visitRuntimeIdentity = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const importClause = node.importClause;
      if (importClause === undefined || importClause.isTypeOnly) return;
      if (importClause.name !== undefined) recordShadowBinding(importClause.name);
      const bindings = importClause.namedBindings;
      if (bindings === undefined) return;
      if (ts.isNamespaceImport(bindings)) recordShadowBinding(bindings.name);
      else {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) recordShadowBinding(element.name);
        }
      }
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "mcpRegistryEvaluatorProblems") {
      if (node.parent === matrix.sourceFile) directBindings++;
      else shadowBindings++;
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === "npmProvenanceContractProblems") {
      if (node.parent === matrix.sourceFile) npmDirectBindings++;
      else npmShadowBindings++;
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === "npmProvenanceEvaluatorProblems") {
      if (node.parent === matrix.sourceFile) npmEvaluatorDirectBindings++;
      else npmEvaluatorShadowBindings++;
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === "npmProvenanceWorkflowProblems") {
      if (node.parent === matrix.sourceFile) npmWorkflowDirectBindings++;
      else npmWorkflowShadowBindings++;
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === "mcpRegistryStepProblems") {
      if (node.parent === matrix.sourceFile) stepDirectBindings++;
      else stepShadowBindings++;
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === "mcpRegistryRunProblems") {
      if (node.parent === matrix.sourceFile) runDirectBindings++;
      else runShadowBindings++;
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === "mutationMatchCount") {
      if (node.parent === matrix.sourceFile) matchCountDirectBindings++;
      else matchCountShadowBindings++;
    } else if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      recordShadowBinding(node.name);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      if (node.name !== undefined && ts.isIdentifier(node.name)) recordShadowBinding(node.name);
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const initializer = unwrappedIdentifier(node.initializer);
      if (initializer?.text === "mcpRegistryEvaluatorProblems") aliases++;
      if (initializer?.text === "npmProvenanceContractProblems") npmAliases++;
      if (initializer?.text === "npmProvenanceEvaluatorProblems") npmEvaluatorAliases++;
      if (initializer?.text === "npmProvenanceWorkflowProblems") npmWorkflowAliases++;
      if (initializer?.text === "mcpRegistryStepProblems") stepAliases++;
      if (initializer?.text === "mcpRegistryRunProblems") runAliases++;
      if (initializer?.text === "mutationMatchCount") matchCountAliases++;
    }
    if (
      ts.isBinaryExpression(node) &&
      ORACLE_BINDING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetContainsIdentifier(node.left, "mcpRegistryEvaluatorProblems")
    ) {
      writes++;
    }
    if (
      ts.isBinaryExpression(node) &&
      ORACLE_BINDING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetContainsIdentifier(node.left, "npmProvenanceContractProblems")
    ) {
      npmWrites++;
    }
    if (
      ts.isBinaryExpression(node) &&
      ORACLE_BINDING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetContainsIdentifier(node.left, "npmProvenanceEvaluatorProblems")
    ) {
      npmEvaluatorWrites++;
    }
    if (
      ts.isBinaryExpression(node) &&
      ORACLE_BINDING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetContainsIdentifier(node.left, "npmProvenanceWorkflowProblems")
    ) {
      npmWorkflowWrites++;
    }
    if (
      ts.isBinaryExpression(node) &&
      ORACLE_BINDING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetContainsIdentifier(node.left, "mcpRegistryStepProblems")
    ) {
      stepWrites++;
    }
    if (
      ts.isBinaryExpression(node) &&
      ORACLE_BINDING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetContainsIdentifier(node.left, "mcpRegistryRunProblems")
    ) {
      runWrites++;
    }
    if (
      ts.isBinaryExpression(node) &&
      ORACLE_BINDING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetContainsIdentifier(node.left, "mutationMatchCount")
    ) {
      matchCountWrites++;
    }
    if (
      ts.isBinaryExpression(node) &&
      ORACLE_BINDING_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetContainsIdentifier(node.left, "mcpbInputs")
    ) {
      mcpbInputWrites++;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsIdentifier(node.operand, "mcpRegistryEvaluatorProblems")
    ) {
      writes++;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsIdentifier(node.operand, "npmProvenanceContractProblems")
    ) {
      npmWrites++;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsIdentifier(node.operand, "npmProvenanceEvaluatorProblems")
    ) {
      npmEvaluatorWrites++;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsIdentifier(node.operand, "npmProvenanceWorkflowProblems")
    ) {
      npmWorkflowWrites++;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsIdentifier(node.operand, "mcpRegistryStepProblems")
    ) {
      stepWrites++;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsIdentifier(node.operand, "mcpRegistryRunProblems")
    ) {
      runWrites++;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsIdentifier(node.operand, "mutationMatchCount")
    ) {
      matchCountWrites++;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsIdentifier(node.operand, "mcpbInputs")
    ) {
      mcpbInputWrites++;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsIdentifier(node.initializer, "mcpRegistryEvaluatorProblems")
    ) {
      writes++;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsIdentifier(node.initializer, "npmProvenanceContractProblems")
    ) {
      npmWrites++;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsIdentifier(node.initializer, "npmProvenanceEvaluatorProblems")
    ) {
      npmEvaluatorWrites++;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsIdentifier(node.initializer, "npmProvenanceWorkflowProblems")
    ) {
      npmWorkflowWrites++;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsIdentifier(node.initializer, "mcpRegistryStepProblems")
    ) {
      stepWrites++;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsIdentifier(node.initializer, "mcpRegistryRunProblems")
    ) {
      runWrites++;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsIdentifier(node.initializer, "mutationMatchCount")
    ) {
      matchCountWrites++;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsIdentifier(node.initializer, "mcpbInputs")
    ) {
      mcpbInputWrites++;
    }
    if (ts.isDeleteExpression(node) && assignmentTargetContainsIdentifier(node.expression, "mcpbInputs")) {
      mcpbInputWrites++;
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] !== undefined &&
      assignmentTargetContainsIdentifier(node.arguments[0], "mcpbInputs") &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ((node.expression.expression.text === "Object" &&
        ["assign", "defineProperties", "defineProperty", "setPrototypeOf"].includes(node.expression.name.text)) ||
        (node.expression.expression.text === "Reflect" &&
          ["defineProperty", "set", "setPrototypeOf"].includes(node.expression.name.text)))
    ) {
      mcpbInputWrites++;
    }
    if (ts.isIdentifier(node) && node.text === "mcpRegistryEvaluatorProblems") {
      const parent = node.parent;
      const exactDeclaration =
        ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === matrix.sourceFile;
      const exactDirectCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        parent.typeArguments === undefined &&
        parent.arguments.length === 1;
      if (
        !exactDeclaration &&
        !exactDirectCall &&
        !isExactReleaseOracleAdapterReference(node, requiredAdapterBindings)
      ) {
        otherReferences++;
      }
    }
    if (ts.isIdentifier(node) && node.text === "npmProvenanceContractProblems") {
      const parent = node.parent;
      const exactDeclaration =
        ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === matrix.sourceFile;
      const exactDirectCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        parent.typeArguments === undefined &&
        parent.arguments.length === 2;
      if (
        !exactDeclaration &&
        !exactDirectCall &&
        !isExactReleaseOracleAdapterReference(node, requiredAdapterBindings)
      ) {
        npmOtherReferences++;
      }
    }
    if (ts.isIdentifier(node) && node.text === "npmProvenanceWorkflowProblems") {
      const parent = node.parent;
      const exactDeclaration =
        ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === matrix.sourceFile;
      const exactDirectCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        parent.typeArguments === undefined &&
        parent.arguments.length === 1;
      if (
        !exactDeclaration &&
        !exactDirectCall &&
        !isExactReleaseOracleAdapterReference(node, requiredAdapterBindings)
      ) {
        npmWorkflowOtherReferences++;
      }
    }
    if (ts.isIdentifier(node) && node.text === "npmProvenanceEvaluatorProblems") {
      const parent = node.parent;
      const exactDeclaration =
        ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === matrix.sourceFile;
      const exactDirectCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        parent.typeArguments === undefined &&
        parent.arguments.length === 1;
      if (
        !exactDeclaration &&
        !exactDirectCall &&
        !isExactReleaseOracleAdapterReference(node, requiredAdapterBindings)
      ) {
        npmEvaluatorOtherReferences++;
      }
    }
    if (ts.isIdentifier(node) && node.text === "mcpRegistryStepProblems") {
      const parent = node.parent;
      const exactDeclaration =
        ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === matrix.sourceFile;
      const exactDirectCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        parent.typeArguments === undefined &&
        parent.arguments.length === 2;
      if (!exactDeclaration && !exactDirectCall) stepOtherReferences++;
    }
    if (ts.isIdentifier(node) && node.text === "mcpRegistryRunProblems") {
      const parent = node.parent;
      const exactDeclaration =
        ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === matrix.sourceFile;
      const exactDirectCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        parent.typeArguments === undefined &&
        parent.arguments.length === 2;
      if (
        !exactDeclaration &&
        !exactDirectCall &&
        !isExactReleaseOracleAdapterReference(node, requiredAdapterBindings)
      ) {
        runOtherReferences++;
      }
    }
    if (ts.isIdentifier(node) && node.text === "mutationMatchCount") {
      const parent = node.parent;
      const exactDeclaration =
        ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === matrix.sourceFile;
      const exactDirectCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        parent.typeArguments === undefined &&
        parent.arguments.length === 2;
      if (!exactDeclaration && !exactDirectCall) matchCountOtherReferences++;
    }
    ts.forEachChild(node, visitRuntimeIdentity);
  };
  visitRuntimeIdentity(matrix.sourceFile);
  if (directBindings !== 1 || shadowBindings !== 0) {
    problems.push(
      `release mutation hybrid registry evaluator binding must have one top-level declaration and no runtime ` +
        `shadows; found ${directBindings}/${shadowBindings}`
    );
  }
  if (aliases !== 0 || writes !== 0 || otherReferences !== 0) {
    problems.push(
      `release mutation hybrid registry evaluator binding must have no aliases, writes, or indirect references; ` +
        `found ${aliases}/${writes}/${otherReferences}`
    );
  }
  if (npmDirectBindings !== 1 || npmShadowBindings !== 0) {
    problems.push(
      `release mutation hybrid npm contract binding must have one top-level declaration and no runtime ` +
        `shadows; found ${npmDirectBindings}/${npmShadowBindings}`
    );
  }
  if (npmAliases !== 0 || npmWrites !== 0 || npmOtherReferences !== 0) {
    problems.push(
      `release mutation hybrid npm contract binding must have no aliases, writes, or indirect references; ` +
        `found ${npmAliases}/${npmWrites}/${npmOtherReferences}`
    );
  }
  if (npmWorkflowDirectBindings !== 1 || npmWorkflowShadowBindings !== 0) {
    problems.push(
      `release mutation hybrid npm workflow binding must have one top-level declaration and no runtime ` +
        `shadows; found ${npmWorkflowDirectBindings}/${npmWorkflowShadowBindings}`
    );
  }
  if (npmEvaluatorDirectBindings !== 1 || npmEvaluatorShadowBindings !== 0) {
    problems.push(
      `release mutation hybrid npm evaluator binding must have one top-level declaration and no runtime ` +
        `shadows; found ${npmEvaluatorDirectBindings}/${npmEvaluatorShadowBindings}`
    );
  }
  if (npmEvaluatorAliases !== 0 || npmEvaluatorWrites !== 0 || npmEvaluatorOtherReferences !== 0) {
    problems.push(
      `release mutation hybrid npm evaluator binding must have no aliases, writes, or indirect references; ` +
        `found ${npmEvaluatorAliases}/${npmEvaluatorWrites}/${npmEvaluatorOtherReferences}`
    );
  }
  if (npmWorkflowAliases !== 0 || npmWorkflowWrites !== 0 || npmWorkflowOtherReferences !== 0) {
    problems.push(
      `release mutation hybrid npm workflow binding must have no aliases, writes, or indirect references; ` +
        `found ${npmWorkflowAliases}/${npmWorkflowWrites}/${npmWorkflowOtherReferences}`
    );
  }
  if (stepDirectBindings !== 1 || stepShadowBindings !== 0) {
    problems.push(
      `release mutation hybrid registry step binding must have one top-level declaration and no runtime ` +
        `shadows; found ${stepDirectBindings}/${stepShadowBindings}`
    );
  }
  if (stepAliases !== 0 || stepWrites !== 0 || stepOtherReferences !== 0) {
    problems.push(
      `release mutation hybrid registry step binding must have no aliases, writes, or indirect references; ` +
        `found ${stepAliases}/${stepWrites}/${stepOtherReferences}`
    );
  }
  if (runDirectBindings !== 1 || runShadowBindings !== 0) {
    problems.push(
      `release mutation hybrid registry run binding must have one top-level declaration and no runtime ` +
        `shadows; found ${runDirectBindings}/${runShadowBindings}`
    );
  }
  if (runAliases !== 0 || runWrites !== 0 || runOtherReferences !== 0) {
    problems.push(
      `release mutation hybrid registry run binding must have no aliases, writes, or indirect references; ` +
        `found ${runAliases}/${runWrites}/${runOtherReferences}`
    );
  }
  if (matchCountDirectBindings !== 1 || matchCountShadowBindings !== 0) {
    problems.push(
      `release mutation hybrid mutationMatchCount binding must have one top-level declaration and no runtime ` +
        `shadows; found ${matchCountDirectBindings}/${matchCountShadowBindings}`
    );
  }
  if (matchCountAliases !== 0) {
    problems.push(
      `release mutation hybrid mutationMatchCount must have no aliases; found ${matchCountAliases} alias initializer(s)`
    );
  }
  if (matchCountWrites !== 0) {
    problems.push(
      `release mutation hybrid mutationMatchCount binding must never be reassigned; found ${matchCountWrites} write(s)`
    );
  }
  if (matchCountOtherReferences !== 0) {
    problems.push(
      `release mutation hybrid mutationMatchCount may only be called directly with two arguments; ` +
        `found ${matchCountOtherReferences} other reference(s)`
    );
  }
  if (mcpbInputWrites !== 0) {
    problems.push(
      "release mutation hybrid mcpbInputs release-oracle sources must remain immutable; " +
        `found ${mcpbInputWrites} write(s)`
    );
  }

  let baselineAssertions = 0;
  let npmBaselineAssertions = 0;
  let npmEvaluatorBaselineAssertions = 0;
  let registryRunBaselineAssertions = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toEqual"
    ) {
      const expectCall = ts.isCallExpression(node.expression.expression) ? node.expression.expression : null;
      const detector = expectCall?.arguments[0];
      const expected = node.arguments[0];
      if (
        expectCall !== null &&
        ts.isIdentifier(expectCall.expression) &&
        expectCall.expression.text === "expect" &&
        detector !== undefined &&
        ts.isCallExpression(detector) &&
        ts.isIdentifier(detector.expression) &&
        detector.expression.text === "mcpRegistryEvaluatorProblems" &&
        detector.arguments.length === 1 &&
        detector.arguments[0] !== undefined &&
        ts.isPropertyAccessExpression(detector.arguments[0]) &&
        ts.isIdentifier(detector.arguments[0].expression) &&
        detector.arguments[0].expression.text === "mcpbInputs" &&
        detector.arguments[0].name.text === "integrity" &&
        expected !== undefined &&
        ts.isArrayLiteralExpression(expected) &&
        expected.elements.length === 0
      ) {
        baselineAssertions++;
      }
      if (
        expectCall !== null &&
        ts.isIdentifier(expectCall.expression) &&
        expectCall.expression.text === "expect" &&
        detector !== undefined &&
        ts.isCallExpression(detector) &&
        ts.isIdentifier(detector.expression) &&
        detector.expression.text === "npmProvenanceContractProblems" &&
        detector.arguments.length === 2 &&
        detector.arguments[0] !== undefined &&
        ts.isPropertyAccessExpression(detector.arguments[0]) &&
        ts.isIdentifier(detector.arguments[0].expression) &&
        detector.arguments[0].expression.text === "mcpbInputs" &&
        detector.arguments[0].name.text === "release" &&
        detector.arguments[1] !== undefined &&
        ts.isPropertyAccessExpression(detector.arguments[1]) &&
        ts.isIdentifier(detector.arguments[1].expression) &&
        detector.arguments[1].expression.text === "mcpbInputs" &&
        detector.arguments[1].name.text === "integrity" &&
        expected !== undefined &&
        ts.isArrayLiteralExpression(expected) &&
        expected.elements.length === 0
      ) {
        npmBaselineAssertions++;
      }
      if (
        expectCall !== null &&
        ts.isIdentifier(expectCall.expression) &&
        expectCall.expression.text === "expect" &&
        detector !== undefined &&
        ts.isCallExpression(detector) &&
        ts.isIdentifier(detector.expression) &&
        detector.expression.text === "npmProvenanceEvaluatorProblems" &&
        detector.arguments.length === 1 &&
        detector.arguments[0] !== undefined &&
        ts.isPropertyAccessExpression(detector.arguments[0]) &&
        ts.isIdentifier(detector.arguments[0].expression) &&
        detector.arguments[0].expression.text === "mcpbInputs" &&
        detector.arguments[0].name.text === "integrity" &&
        expected !== undefined &&
        ts.isArrayLiteralExpression(expected) &&
        expected.elements.length === 0
      ) {
        npmEvaluatorBaselineAssertions++;
      }
      if (
        expectCall !== null &&
        ts.isIdentifier(expectCall.expression) &&
        expectCall.expression.text === "expect" &&
        detector !== undefined &&
        ts.isCallExpression(detector) &&
        ts.isIdentifier(detector.expression) &&
        detector.expression.text === "mcpRegistryRunProblems" &&
        detector.arguments.length === 2 &&
        detector.arguments[0] !== undefined &&
        ts.isIdentifier(detector.arguments[0]) &&
        detector.arguments[0].text === "registryRun" &&
        detector.arguments[1] !== undefined &&
        ts.isPropertyAccessExpression(detector.arguments[1]) &&
        ts.isIdentifier(detector.arguments[1].expression) &&
        detector.arguments[1].expression.text === "mcpbInputs" &&
        detector.arguments[1].name.text === "integrity" &&
        expected !== undefined &&
        ts.isArrayLiteralExpression(expected) &&
        expected.elements.length === 0
      ) {
        registryRunBaselineAssertions++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(matrix.callback.body);
  if (baselineAssertions !== 1) {
    problems.push(
      `release mutation hybrid registry evaluator requires one exact clean baseline assertion; ` +
        `found ${baselineAssertions}`
    );
  }
  if (npmBaselineAssertions !== 1) {
    problems.push(
      `release mutation hybrid npm contract requires one exact clean baseline assertion; ` +
        `found ${npmBaselineAssertions}`
    );
  }
  if (npmEvaluatorBaselineAssertions !== 1) {
    problems.push(
      `release mutation hybrid npm evaluator requires one exact clean baseline assertion; ` +
        `found ${npmEvaluatorBaselineAssertions}`
    );
  }
  if (registryRunBaselineAssertions !== 1) {
    problems.push(
      `release mutation hybrid registry run requires one exact clean baseline assertion; ` +
        `found ${registryRunBaselineAssertions}`
    );
  }
}

interface PreparedReleaseMutationManifest {
  readonly caseTopologyProblems: readonly string[];
  readonly fingerprintProblems: readonly string[];
  readonly fixtureIdentityProblems: readonly string[];
  readonly inventoryProblems: readonly string[];
  readonly manifest: IdentityManifest | null;
  readonly mutationTopologyProblems: readonly string[];
  readonly parseProblems: readonly string[];
  readonly provenanceProblems: readonly string[];
  readonly witnessProblems: readonly string[];
}

function collectProblems(validate: (problems: string[]) => void): readonly string[] {
  const problems: string[] = [];
  validate(problems);
  return Object.freeze(problems);
}

function deepFreezePlainJson<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreezePlainJson(descriptor.value);
  }
  Object.freeze(value);
  return value;
}

function prepareReleaseMutationManifest(manifestSource: string): PreparedReleaseMutationManifest {
  const witnessProblems = collectProblems((problems) => {
    validateWitnessCounterSemantics(problems);
    validateProjectionComparatorSemantics(problems);
    validateBindingClosureSemantics(problems);
    validateMatcherMultiplicitySemantics(problems);
    validateDeclarativeExecutionExpansionSemantics(problems);
    validateDeclarativeInvocationParsingSemantics(problems);
    validateReleaseOracleAdapterReferenceSemantics(problems);
    validateDeclarativeWitnessProvenanceSemantics(problems);
  });
  const mutableParseProblems: string[] = [];
  const parsedManifest = parseManifest(manifestSource, mutableParseProblems);
  const parseProblems = Object.freeze(mutableParseProblems);
  if (parsedManifest === null) {
    return {
      manifest: null,
      witnessProblems,
      parseProblems,
      fixtureIdentityProblems: Object.freeze([]),
      provenanceProblems: Object.freeze([]),
      inventoryProblems: Object.freeze([]),
      mutationTopologyProblems: Object.freeze([]),
      caseTopologyProblems: Object.freeze([]),
      fingerprintProblems: Object.freeze([])
    };
  }
  const manifest = deepFreezePlainJson(parsedManifest);
  return {
    manifest,
    witnessProblems,
    parseProblems,
    fixtureIdentityProblems: collectProblems((problems) => {
      if (sha256(manifestSource) !== IDENTITY_FIXTURE_SHA256) {
        problems.push(`release mutation identity fixture must remain byte-exact SHA-256 ${IDENTITY_FIXTURE_SHA256}`);
      }
    }),
    provenanceProblems: collectProblems((problems) => validateFrozenProvenance(manifest, problems)),
    inventoryProblems: collectProblems((problems) => validateInventory(manifest, problems)),
    mutationTopologyProblems: collectProblems((problems) => validateFrozenManifestMutationTopology(manifest, problems)),
    caseTopologyProblems: collectProblems((problems) => {
      validateFrozenCaseTopology(manifest, problems);
      validateFrozenDeclarativeInvocationMatchingSemantics(manifest, problems);
    }),
    fingerprintProblems: collectProblems((problems) => validateSemanticFingerprints(manifest, problems))
  };
}

function exactSourceProjection(sourceValues: ReadonlyMap<string, string>): readonly string[] | null {
  const projection: string[] = [];
  for (const source of EXPECTED_SOURCES) {
    const value = sourceValues.get(source.id);
    if (value === undefined) return null;
    projection.push(value);
  }
  return Object.freeze(projection);
}

function projectionsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateProjectionComparatorSemantics(problems: string[]): void {
  const baseline = EXPECTED_SOURCES.map((source, index) => `${index}:${source.id}`);
  if (!projectionsEqual(baseline, [...baseline]) || projectionsEqual(baseline, baseline.slice(0, -1))) {
    problems.push("release mutation source projection comparator must preserve exact length and equality");
    return;
  }
  for (let index = 0; index < baseline.length; index++) {
    const candidate = [...baseline];
    const current = candidate[index];
    if (current === undefined) continue;
    candidate[index] = `${current}#byte-drift`;
    if (projectionsEqual(baseline, candidate)) {
      problems.push(
        `release mutation source projection comparator must distinguish all ${EXPECTED_SOURCES.length} exact slots`
      );
      return;
    }
  }
}

/**
 * Creates an execution-scoped auditor for repeated matrix checks against one immutable fixture.
 *
 * Fixture parsing and manifest-only topology are prepared once. Every matrix candidate still gets
 * a fresh TypeScript AST, matrix-only validation and complete cross-axis validation. The expensive
 * materialized mutation graph is reused only after all 30 independently materialized source byte
 * strings compare exactly with the clean projection captured by this auditor instance.
 *
 * @param manifestSource - Immutable generated schema-v2 manifest JSON bytes.
 * @returns An opaque auditor whose cache cannot escape this explicit execution scope.
 * @example
 * const auditor = createReleaseMutationIdentityAuditor(fixtureSource);
 * const problems = auditor.auditMatrix(matrixSource);
 */
export function createReleaseMutationIdentityAuditor(manifestSource: string): ReleaseMutationIdentityAuditor {
  const prepared = prepareReleaseMutationManifest(manifestSource);
  let cachedProjection: readonly string[] | null = null;
  let cachedGraphProblems: readonly string[] = Object.freeze([]);
  let materializedGraphEvaluations = 0;
  let materializedGraphReuses = 0;
  let sourceCatalogueBypasses = 0;
  let sourceProjectionBypasses = 0;

  return Object.freeze({
    auditMatrix(matrixSource: string): string[] {
      const problems: string[] = [...prepared.witnessProblems];
      const observedHybridSourceSha256 = sha256(matrixSource);
      if (observedHybridSourceSha256 !== CURRENT_HYBRID_SOURCE_SHA256) {
        problems.push(
          `release mutation hybrid current source must retain exact SHA-256 ` +
            `${CURRENT_HYBRID_SOURCE_SHA256}; found ${observedHybridSourceSha256}`
        );
      }
      problems.push(...prepared.parseProblems);
      const manifest = prepared.manifest;
      if (manifest === null) return problems;
      problems.push(...prepared.fixtureIdentityProblems);

      const matrix = scanMatrix(matrixSource, problems);
      if (matrix === null) return problems;
      const observedHybridMatrixSha256 = sha256(matrix.matrixSlice);
      if (observedHybridMatrixSha256 !== CURRENT_HYBRID_MATRIX_SLICE_SHA256) {
        problems.push(
          `release mutation hybrid current matrix slice must retain exact SHA-256 ` +
            `${CURRENT_HYBRID_MATRIX_SLICE_SHA256}; found ${observedHybridMatrixSha256}`
        );
      }

      validateRawExpressionShape(matrix, problems, false);
      problems.push(...prepared.provenanceProblems);
      problems.push(...prepared.inventoryProblems);
      const sourceCatalogueValid = validateSources(manifest, matrix, problems);
      validateCardinalityConstants(matrix, problems);
      problems.push(...prepared.mutationTopologyProblems);
      if (!sourceCatalogueValid) {
        sourceCatalogueBypasses++;
      } else {
        const sourceProblems: string[] = [];
        const sourceValues = materializeSourceValues(manifest, matrix, sourceProblems);
        problems.push(...sourceProblems);
        const projection = sourceProblems.length === 0 ? exactSourceProjection(sourceValues) : null;
        if (projection !== null && cachedProjection !== null && projectionsEqual(projection, cachedProjection)) {
          materializedGraphReuses++;
          problems.push(...cachedGraphProblems);
        } else {
          if (cachedProjection !== null) sourceProjectionBypasses++;
          const graphProblems: string[] = [];
          validateMaterializedMutationValues(manifest, sourceValues, graphProblems);
          materializedGraphEvaluations++;
          problems.push(...graphProblems);
          if (cachedProjection === null && projection !== null && graphProblems.length === 0) {
            cachedProjection = projection;
            cachedGraphProblems = Object.freeze([...graphProblems]);
          }
        }
      }
      problems.push(...prepared.caseTopologyProblems);
      problems.push(...prepared.fingerprintProblems);

      validateMatrixCallbackNoReturns(matrix, problems);
      const declarative = scanHybridDeclarativeMatrix(matrix, problems);
      const legacyById = validateHybridPartition(manifest, matrix, declarative, problems);
      const legacyExecutionAnchors = validateRemainingLegacyMatchers(manifest, matrix, legacyById, problems);
      validateGlobalCaseExecutionOrder(manifest, declarative, legacyExecutionAnchors, problems);
      validateReleaseOraclePins(matrix, declarative, problems);
      return problems;
    },
    telemetry(): Readonly<ReleaseMutationIdentityAuditTelemetry> {
      return Object.freeze({
        fixturePreparations: 1,
        materializedGraphEvaluations,
        materializedGraphReuses,
        sourceCatalogueBypasses,
        sourceProjectionBypasses
      });
    }
  });
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
export function releaseMutationExactLegacyIdentityAuditProblems(
  matrixSource: string,
  manifestSource: string
): string[] {
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

/**
 * Audits the immutable schema-v2 identity fixture against the reviewed hybrid migration boundary.
 *
 * The frozen fixture remains byte-identical authority. Current source offsets may move, while
 * separately reviewed digests pin the complete test source and mixed matrix slice at each migration
 * boundary. Every frozen mutation must remain in exactly one representation: its exact legacy node
 * text or the literal declarative Registry and npm provenance oracle projections.
 *
 * @param matrixSource - Complete current `tests/release-integrity.test.ts` source text.
 * @param manifestSource - Immutable generated schema-v2 manifest JSON bytes.
 * @returns Stable diagnostics; empty only for the exact staged m002-m037 plus topological m108->m107,
 * m109-m138, replacement-dependent m140->m139, m141-m143, m145->m144, m146-m151, and m152-m164 hybrid boundary.
 */
export function releaseMutationIdentityAuditProblems(matrixSource: string, manifestSource: string): string[] {
  return createReleaseMutationIdentityAuditor(manifestSource).auditMatrix(matrixSource);
}
