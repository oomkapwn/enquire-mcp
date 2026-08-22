import {
  observeReleaseMutationTransitionPopulation,
  type ReleaseMutationTransitionObservationPlan
} from "./release-mutation-identity-audit.js";
import {
  auditReleaseMutationTransition,
  type ReleaseMutationTransitionAuthority
} from "./release-mutation-transition.js";
import {
  RELEASE_MUTATION_V3_CURRENT_MCPB_INPUTS,
  RELEASE_MUTATION_V3_EXPECTED_IDENTITY_COUNT,
  RELEASE_MUTATION_V3_EXPECTED_LEGACY_COUNT,
  RELEASE_MUTATION_V3_EXPECTED_SOURCE_COUNT,
  RELEASE_MUTATION_V3_NEW_IDENTITIES,
  RELEASE_MUTATION_V3_NEW_SOURCES,
  RELEASE_MUTATION_V3_RETIRED_SOURCES,
  RELEASE_MUTATION_V3_SUCCESSORS,
  RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS
} from "./release-mutation-transition-plan.js";

interface CurrentTransitionWitness {
  readonly declarativeCount: number;
  readonly identityCount: number;
  readonly legacyCount: number;
  readonly matrixSliceSha256: string;
  readonly matrixSourceSha256: string;
  readonly sourceCount: number;
}

interface PinnedTransitionAuthority extends ReleaseMutationTransitionAuthority {
  readonly current: CurrentTransitionWitness;
}

const HISTORICAL_FIXTURE_SHA256 = "8205d24e6d42dd4cb8986368611514131abe701434beb30150e33ea08f4b1288";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const AUTHORITY_KEYS = Object.freeze([
  "schemaVersion",
  "normalizer",
  "historicalFixtureSha256",
  "unchangedSources",
  "sourceChanges",
  "retiredSources",
  "sourceSuccessors",
  "newSources",
  "unchangedIdentities",
  "identityTransitions",
  "newIdentities",
  "current"
]);
const CURRENT_KEYS = Object.freeze([
  "matrixSourceSha256",
  "matrixSliceSha256",
  "legacyCount",
  "declarativeCount",
  "sourceCount",
  "identityCount"
]);
const OBSERVATION_PLAN: ReleaseMutationTransitionObservationPlan = Object.freeze({
  currentMcpbInputs: RELEASE_MUTATION_V3_CURRENT_MCPB_INPUTS,
  expectedIdentityCount: RELEASE_MUTATION_V3_EXPECTED_IDENTITY_COUNT,
  expectedLegacyCount: RELEASE_MUTATION_V3_EXPECTED_LEGACY_COUNT,
  expectedSourceCount: RELEASE_MUTATION_V3_EXPECTED_SOURCE_COUNT,
  successors: RELEASE_MUTATION_V3_SUCCESSORS,
  unchangedOldIds: RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS,
  retiredSourceIds: RELEASE_MUTATION_V3_RETIRED_SOURCES.map((entry) => entry.id),
  newSources: RELEASE_MUTATION_V3_NEW_SOURCES,
  newIdentities: RELEASE_MUTATION_V3_NEW_IDENTITIES
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  const expectedSet = new Set(expected);
  return actual.length === expected.length && actual.every((key) => expectedSet.has(key));
}

function parsePinnedAuthority(source: string, problems: string[]): PinnedTransitionAuthority | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    problems.push(`release mutation transition authority is not valid JSON: ${String(error)}`);
    return null;
  }
  if (!isRecord(parsed) || !exactKeys(parsed, AUTHORITY_KEYS)) {
    problems.push(`release mutation transition authority must contain exactly ${AUTHORITY_KEYS.join(", ")}`);
    return null;
  }
  const arrayKeys = [
    "unchangedSources",
    "sourceChanges",
    "retiredSources",
    "sourceSuccessors",
    "newSources",
    "unchangedIdentities",
    "identityTransitions",
    "newIdentities"
  ];
  if (arrayKeys.some((key) => !Array.isArray(parsed[key]))) {
    problems.push("release mutation transition classification fields must all be arrays");
    return null;
  }
  const current = parsed.current;
  if (!isRecord(current) || !exactKeys(current, CURRENT_KEYS)) {
    problems.push(`release mutation transition current witness must contain exactly ${CURRENT_KEYS.join(", ")}`);
    return null;
  }
  if (!SHA256_PATTERN.test(String(current.matrixSourceSha256))) {
    problems.push("release mutation transition current.matrixSourceSha256 must be lowercase SHA-256");
  }
  if (!SHA256_PATTERN.test(String(current.matrixSliceSha256))) {
    problems.push("release mutation transition current.matrixSliceSha256 must be lowercase SHA-256");
  }
  for (const key of ["legacyCount", "declarativeCount", "sourceCount", "identityCount"] as const) {
    if (typeof current[key] !== "number" || !Number.isSafeInteger(current[key]) || current[key] < 0) {
      problems.push(`release mutation transition current.${key} must be a non-negative safe integer`);
    }
  }
  return parsed as unknown as PinnedTransitionAuthority;
}

/**
 * Audits the current release mutation matrix through the immutable v2-to-v3 transition authority.
 *
 * The complete source and balanced matrix slice are pinned in addition to the logical transition
 * witnesses. This keeps representation-neutral unchanged rows honest while successor, new and
 * changed-source rows remain independently checked by the transition auditor.
 *
 * @param matrixSource - Complete current release-integrity test source.
 * @param historicalFixtureSource - Byte-exact schema-v2 historical fixture.
 * @param transitionAuthoritySource - Reviewed schema-v3 transition authority JSON bytes.
 * @returns Stable diagnostics; empty only for the exact frozen population and classification.
 */
export function releaseMutationVersionedTransitionAuditProblems(
  matrixSource: string,
  historicalFixtureSource: string,
  transitionAuthoritySource: string
): string[] {
  const problems: string[] = [];
  const authority = parsePinnedAuthority(transitionAuthoritySource, problems);
  if (authority === null) return problems;
  const observation = observeReleaseMutationTransitionPopulation(
    matrixSource,
    historicalFixtureSource,
    HISTORICAL_FIXTURE_SHA256,
    OBSERVATION_PLAN
  );
  problems.push(...observation.problems);
  if (observation.sourceSha256 !== authority.current.matrixSourceSha256) {
    problems.push(
      `release mutation transition current matrix source witness mismatch; expected ` +
        `${authority.current.matrixSourceSha256}, found ${observation.sourceSha256}`
    );
  }
  if (observation.matrixSliceSha256 !== authority.current.matrixSliceSha256) {
    problems.push(
      `release mutation transition current matrix slice witness mismatch; expected ` +
        `${authority.current.matrixSliceSha256}, found ${observation.matrixSliceSha256 ?? "unavailable"}`
    );
  }
  if (observation.legacyCount !== authority.current.legacyCount) {
    problems.push(
      `release mutation transition legacy count mismatch; expected ${authority.current.legacyCount}, ` +
        `found ${observation.legacyCount}`
    );
  }
  if (observation.declarativeCount !== authority.current.declarativeCount) {
    problems.push(
      `release mutation transition declarative count mismatch; expected ${authority.current.declarativeCount}, ` +
        `found ${observation.declarativeCount}`
    );
  }
  if (observation.historical === null || observation.current === null) return problems;
  if (observation.current.sources.length !== authority.current.sourceCount) {
    problems.push(
      `release mutation transition source count mismatch; expected ${authority.current.sourceCount}, ` +
        `found ${observation.current.sources.length}`
    );
  }
  if (observation.current.identities.length !== authority.current.identityCount) {
    problems.push(
      `release mutation transition identity count mismatch; expected ${authority.current.identityCount}, ` +
        `found ${observation.current.identities.length}`
    );
  }
  try {
    problems.push(...auditReleaseMutationTransition(observation.historical, observation.current, authority).problems);
  } catch (error: unknown) {
    problems.push(`release mutation transition authority is structurally invalid: ${String(error)}`);
  }
  return problems;
}
