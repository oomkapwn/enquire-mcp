import { createHash } from "node:crypto";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** One canonical source or executable identity projection. */
export interface ReleaseMutationTransitionProjection {
  readonly id: string;
  readonly [key: string]: JsonValue;
}

/** The historical or current identity population presented to the transition audit. */
export interface ReleaseMutationTransitionPopulation {
  readonly fixtureSha256?: string;
  readonly identities: readonly ReleaseMutationTransitionProjection[];
  readonly schemaVersion: 2 | 3;
  readonly sources: readonly ReleaseMutationTransitionProjection[];
}

interface TransitionWitness {
  readonly from: string;
  readonly to: string;
}

interface SourceChangeAuthority {
  readonly allowedChanges: readonly string[];
  readonly id: string;
  readonly reason: string;
  readonly witness: TransitionWitness;
}

interface RetiredAuthority {
  readonly oldId: string;
  readonly reason: string;
  readonly witness: string;
}

interface SuccessorAuthority {
  readonly newId: string;
  readonly oldId: string;
  readonly reason: string;
  readonly witness: TransitionWitness;
}

interface NewAuthority {
  readonly id: string;
  readonly reason: string;
  readonly witness: string;
}

interface UnchangedAuthority {
  readonly id: string;
}

/** Reviewed schema-v3 authority connecting an immutable schema-v2 population to one current population. */
export interface ReleaseMutationTransitionAuthority {
  readonly historicalFixtureSha256: string;
  readonly identityTransitions: readonly (RetiredAuthority | SuccessorAuthority)[];
  readonly newIdentities: readonly NewAuthority[];
  readonly newSources: readonly NewAuthority[];
  readonly normalizer: "release-mutation-transition-v3";
  readonly retiredSources: readonly RetiredAuthority[];
  readonly schemaVersion: 3;
  readonly sourceChanges: readonly SourceChangeAuthority[];
  readonly sourceSuccessors: readonly SuccessorAuthority[];
  readonly unchangedIdentities: readonly UnchangedAuthority[];
  readonly unchangedSources: readonly UnchangedAuthority[];
}

/** Exhaustive identity classification emitted by the transition audit. */
export interface ReleaseMutationTransitionClassification {
  readonly changed: readonly string[];
  readonly new: readonly string[];
  readonly retired: readonly string[];
  readonly successor: readonly string[];
  readonly unchanged: readonly string[];
}

/** Complete transition-audit result. */
export interface ReleaseMutationTransitionAuditResult {
  readonly identities: ReleaseMutationTransitionClassification;
  readonly problems: readonly string[];
  readonly sources: ReleaseMutationTransitionClassification;
}

/** Data-only classification plan from which exact transition witnesses are generated. */
export interface ReleaseMutationTransitionBuildPlan {
  readonly changedSources: readonly {
    readonly allowedChanges: readonly string[];
    readonly id: string;
    readonly reason: string;
  }[];
  readonly historicalFixtureSha256: string;
  readonly identitySuccessors: readonly {
    readonly newId: string;
    readonly oldId: string;
    readonly reason: string;
  }[];
  readonly newIdentityIds: readonly { readonly id: string; readonly reason: string }[];
  readonly newSourceIds: readonly { readonly id: string; readonly reason: string }[];
  readonly retiredIdentities: readonly { readonly id: string; readonly reason: string }[];
  readonly retiredSources: readonly { readonly id: string; readonly reason: string }[];
  readonly sourceSuccessors: readonly {
    readonly newId: string;
    readonly oldId: string;
    readonly reason: string;
  }[];
  readonly unchangedIdentityIds: readonly string[];
  readonly unchangedSourceIds: readonly string[];
}

/** Result of materializing a classification plan into exact projection witnesses. */
export interface ReleaseMutationTransitionBuildResult {
  readonly authority: ReleaseMutationTransitionAuthority | null;
  readonly problems: readonly string[];
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RAW_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])+)$/u;

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
    .join(",")}}`;
}

function projectionWitness(value: ReleaseMutationTransitionProjection): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function deepDiffPaths(left: JsonValue | undefined, right: JsonValue | undefined, path = ""): string[] {
  if (Object.is(left, right)) return [];
  if (
    left === undefined ||
    right === undefined ||
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return [path || "/"];
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths: string[] = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
      paths.push(...deepDiffPaths(left[index], right[index], `${path}/${index}`));
    }
    return paths;
  }
  const leftRecord = left as Readonly<Record<string, JsonValue>>;
  const rightRecord = right as Readonly<Record<string, JsonValue>>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  return keys.flatMap((key) =>
    deepDiffPaths(leftRecord[key], rightRecord[key], `${path}/${escapePointerSegment(key)}`)
  );
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function indexPopulation(
  label: string,
  projections: readonly ReleaseMutationTransitionProjection[],
  problems: string[]
): ReadonlyMap<string, ReleaseMutationTransitionProjection> {
  const ids = projections.map((projection) => projection.id);
  const repeated = duplicates(ids);
  if (repeated.length !== 0) problems.push(`${label} IDs must be unique; duplicates: ${repeated.join(", ")}`);
  const indexed = new Map<string, ReleaseMutationTransitionProjection>();
  for (const projection of projections) {
    if (!ID_PATTERN.test(projection.id)) problems.push(`${label} ID ${projection.id} is not canonical`);
    if (!indexed.has(projection.id)) indexed.set(projection.id, projection);
  }
  return indexed;
}

function exactProjectionEqual(
  left: ReleaseMutationTransitionProjection,
  right: ReleaseMutationTransitionProjection
): boolean {
  return canonical(left) === canonical(right);
}

function validateReason(reason: string, path: string, problems: string[]): void {
  if (reason.trim().length < 12 || reason !== reason.trim()) {
    problems.push(`${path}.reason must be a trimmed, specific review reason`);
  }
}

function validateWitness(value: string, path: string, problems: string[]): void {
  if (!SHA256_PATTERN.test(value)) problems.push(`${path} must be a canonical projection witness`);
}

function validateAuthorityShape(authority: ReleaseMutationTransitionAuthority, problems: string[]): void {
  if (authority.schemaVersion !== 3) problems.push("transition.schemaVersion must be exactly 3");
  if (authority.normalizer !== "release-mutation-transition-v3") {
    problems.push("transition.normalizer must be exactly release-mutation-transition-v3");
  }
  if (!RAW_SHA256_PATTERN.test(authority.historicalFixtureSha256)) {
    problems.push("transition.historicalFixtureSha256 must be lowercase SHA-256");
  }
}

function validateTransitionRows(
  label: string,
  unchanged: readonly UnchangedAuthority[],
  transitions: readonly (RetiredAuthority | SuccessorAuthority)[],
  additions: readonly NewAuthority[],
  historical: ReadonlyMap<string, ReleaseMutationTransitionProjection>,
  current: ReadonlyMap<string, ReleaseMutationTransitionProjection>,
  problems: string[]
): ReleaseMutationTransitionClassification {
  const oldIds = [...unchanged.map((entry) => entry.id), ...transitions.map((entry) => entry.oldId)];
  const duplicateOldIds = duplicates(oldIds);
  if (duplicateOldIds.length !== 0) {
    problems.push(`${label} old classifications must be unique; duplicates: ${duplicateOldIds.join(", ")}`);
  }
  const successors = transitions.filter((entry): entry is SuccessorAuthority => "newId" in entry);
  const targetIds = [...successors.map((entry) => entry.newId), ...additions.map((entry) => entry.id)];
  const duplicateTargets = duplicates(targetIds);
  if (duplicateTargets.length !== 0) {
    problems.push(`${label} current target IDs must be unique; duplicates: ${duplicateTargets.join(", ")}`);
  }

  const transitionByOld = new Map(transitions.map((entry) => [entry.oldId, entry]));
  const unchangedById = new Map(unchanged.map((entry) => [entry.id, entry]));
  const successorByNew = new Map(successors.map((entry) => [entry.newId, entry]));
  const additionById = new Map(additions.map((entry) => [entry.id, entry]));
  const unchangedIds: string[] = [];
  const retiredIds: string[] = [];
  const successorIds: string[] = [];
  const newIds: string[] = [];

  for (const entry of unchanged) {
    if (!historical.has(entry.id)) problems.push(`${label} unchanged row references unknown old ID ${entry.id}`);
  }

  for (const entry of transitions) {
    validateReason(entry.reason, `${label} transition ${entry.oldId}`, problems);
    if (!historical.has(entry.oldId)) problems.push(`${label} transition references unknown old ID ${entry.oldId}`);
    if ("newId" in entry) {
      validateWitness(entry.witness.from, `${label} successor ${entry.oldId}.witness.from`, problems);
      validateWitness(entry.witness.to, `${label} successor ${entry.oldId}.witness.to`, problems);
      if (entry.newId === entry.oldId) problems.push(`${label} successor ${entry.oldId} must use a distinct new ID`);
      if (historical.has(entry.newId)) {
        problems.push(`${label} successor ${entry.oldId} reuses historical ID ${entry.newId}`);
      }
      if (!current.has(entry.newId)) {
        problems.push(`${label} successor ${entry.oldId} target ${entry.newId} is missing`);
      }
    } else {
      validateWitness(entry.witness, `${label} retired ${entry.oldId}.witness`, problems);
    }
  }
  for (const entry of additions) {
    validateReason(entry.reason, `${label} new ${entry.id}`, problems);
    validateWitness(entry.witness, `${label} new ${entry.id}.witness`, problems);
    if (historical.has(entry.id)) problems.push(`${label} new identity reuses historical ID ${entry.id}`);
    if (!current.has(entry.id)) problems.push(`${label} declared new target ${entry.id} is missing`);
  }

  for (const [oldId, oldProjection] of historical) {
    const sameIdCurrent = current.get(oldId);
    const transition = transitionByOld.get(oldId);
    const unchangedEntry = unchangedById.get(oldId);
    if (sameIdCurrent !== undefined) {
      if (!exactProjectionEqual(oldProjection, sameIdCurrent)) {
        problems.push(`${label} historical ID ${oldId} was reused for a changed projection`);
      } else {
        unchangedIds.push(oldId);
        if (unchangedEntry === undefined) {
          problems.push(`${label} old ID ${oldId} is missing an explicit unchanged classification`);
        }
      }
      if (transition !== undefined) {
        problems.push(`${label} old ID ${oldId} remains current but is also classified by a transition row`);
      }
      continue;
    }
    if (unchangedEntry !== undefined) {
      problems.push(`${label} old ID ${oldId} is classified unchanged but is missing from current projections`);
    }
    if (transition === undefined) {
      problems.push(`${label} old ID ${oldId} is missing an explicit retired or successor classification`);
      continue;
    }
    const observedFromWitness = projectionWitness(oldProjection);
    if ("newId" in transition) {
      successorIds.push(oldId);
      if (transition.witness.from !== observedFromWitness) {
        problems.push(`${label} successor ${oldId} historical witness mismatch`);
      }
      const target = current.get(transition.newId);
      if (target !== undefined) {
        if (transition.witness.to !== projectionWitness(target)) {
          problems.push(`${label} successor ${oldId} target witness mismatch`);
        }
      }
    } else {
      retiredIds.push(oldId);
      if (transition.witness !== observedFromWitness) {
        problems.push(`${label} retired ${oldId} historical witness mismatch`);
      }
    }
  }

  for (const [currentId, currentProjection] of current) {
    if (historical.has(currentId)) continue;
    const successor = successorByNew.get(currentId);
    const addition = additionById.get(currentId);
    if (successor === undefined && addition === undefined) {
      problems.push(`${label} current ID ${currentId} is an undeclared new identity`);
      continue;
    }
    if (addition !== undefined) {
      newIds.push(currentId);
      if (addition.witness !== projectionWitness(currentProjection)) {
        problems.push(`${label} new ${currentId} witness mismatch`);
      }
    }
  }

  return Object.freeze({
    changed: Object.freeze([]),
    unchanged: Object.freeze(unchangedIds.sort()),
    retired: Object.freeze(retiredIds.sort()),
    successor: Object.freeze(successorIds.sort()),
    new: Object.freeze(newIds.sort())
  });
}

function validateSourceTransitions(
  authority: ReleaseMutationTransitionAuthority,
  historical: ReadonlyMap<string, ReleaseMutationTransitionProjection>,
  current: ReadonlyMap<string, ReleaseMutationTransitionProjection>,
  problems: string[]
): ReleaseMutationTransitionClassification {
  const changeIds = authority.sourceChanges.map((entry) => entry.id);
  const duplicateChangeIds = duplicates(changeIds);
  if (duplicateChangeIds.length !== 0) {
    problems.push(`source change IDs must be unique; duplicates: ${duplicateChangeIds.join(", ")}`);
  }
  const structuralTransitions: Array<RetiredAuthority | SuccessorAuthority> = [
    ...authority.retiredSources,
    ...authority.sourceSuccessors
  ];
  const structuralOldIds = new Set(structuralTransitions.map((entry) => entry.oldId));
  for (const change of authority.sourceChanges) {
    validateReason(change.reason, `source change ${change.id}`, problems);
    validateWitness(change.witness.from, `source change ${change.id}.witness.from`, problems);
    validateWitness(change.witness.to, `source change ${change.id}.witness.to`, problems);
    if (structuralOldIds.has(change.id)) {
      problems.push(`source ${change.id} cannot be both changed and structurally transitioned`);
    }
    const oldProjection = historical.get(change.id);
    const currentProjection = current.get(change.id);
    if (oldProjection === undefined || currentProjection === undefined) {
      problems.push(`source change ${change.id} requires both historical and current projections`);
      continue;
    }
    const allowed = [...change.allowedChanges].sort();
    if (
      allowed.length === 0 ||
      duplicates(allowed).length !== 0 ||
      allowed.some((path) => !JSON_POINTER_PATTERN.test(path))
    ) {
      problems.push(`source change ${change.id} allowedChanges must be unique exact non-root JSON pointers`);
    }
    const observed = deepDiffPaths(oldProjection, currentProjection).sort();
    if (canonical(allowed) !== canonical(observed)) {
      problems.push(
        `source change ${change.id} deep diff must equal its exact allowlist; ` +
          `allowed ${canonical(allowed)}, found ${canonical(observed)}`
      );
    }
    if (change.witness.from !== projectionWitness(oldProjection)) {
      problems.push(`source change ${change.id} historical witness mismatch`);
    }
    if (change.witness.to !== projectionWitness(currentProjection)) {
      problems.push(`source change ${change.id} current witness mismatch`);
    }
  }

  const changedIdSet = new Set(changeIds);
  const historicalWithoutChanges = new Map([...historical].filter(([id]) => !changedIdSet.has(id)));
  const currentWithoutChanges = new Map([...current].filter(([id]) => !changedIdSet.has(id)));
  const classified = validateTransitionRows(
    "source",
    authority.unchangedSources,
    structuralTransitions,
    authority.newSources,
    historicalWithoutChanges,
    currentWithoutChanges,
    problems
  );
  return Object.freeze({
    changed: Object.freeze([...changeIds].sort()),
    unchanged: classified.unchanged,
    retired: classified.retired,
    successor: classified.successor,
    new: classified.new
  });
}

/**
 * Audits one schema-v3 transition without mutating either projection population.
 *
 * Exact equality is the only implicit unchanged classification. Retirements, successors and
 * current-only identities require reviewed rows, and historical IDs can never be reused for a
 * different projection. Same-ID source byte evolution is narrower: its complete leaf-level deep
 * diff must equal an explicit allowlist and both ends must match projection witnesses.
 *
 * @param historical - Immutable schema-v2 source and executable projections.
 * @param current - Candidate schema-v3 source and executable projections.
 * @param authority - Reviewed transition classification and witness authority.
 * @returns Frozen classifications and stable diagnostics.
 */
export function auditReleaseMutationTransition(
  historical: ReleaseMutationTransitionPopulation,
  current: ReleaseMutationTransitionPopulation,
  authority: ReleaseMutationTransitionAuthority
): ReleaseMutationTransitionAuditResult {
  const problems: string[] = [];
  validateAuthorityShape(authority, problems);
  if (historical.schemaVersion !== 2) problems.push("historical population must use schemaVersion 2");
  if (current.schemaVersion !== 3) problems.push("current population must use schemaVersion 3");
  if (historical.fixtureSha256 !== authority.historicalFixtureSha256) {
    problems.push("transition authority does not bind the exact historical fixture SHA-256");
  }
  const historicalSources = indexPopulation("historical source", historical.sources, problems);
  const currentSources = indexPopulation("current source", current.sources, problems);
  const historicalIdentities = indexPopulation("historical executable identity", historical.identities, problems);
  const currentIdentities = indexPopulation("current executable identity", current.identities, problems);
  const sources = validateSourceTransitions(authority, historicalSources, currentSources, problems);
  const identities = validateTransitionRows(
    "executable identity",
    authority.unchangedIdentities,
    authority.identityTransitions,
    authority.newIdentities,
    historicalIdentities,
    currentIdentities,
    problems
  );
  return Object.freeze({
    sources,
    identities,
    problems: Object.freeze(problems)
  });
}

/**
 * Returns the canonical witness used to bind one transition projection.
 *
 * @param projection - Data-only source or executable identity projection.
 * @returns A lowercase SHA-256 witness over canonical recursively sorted JSON.
 */
export function releaseMutationTransitionProjectionWitness(projection: ReleaseMutationTransitionProjection): string {
  return projectionWitness(projection);
}

/**
 * Materializes exact from/to witnesses for a reviewed transition classification plan.
 *
 * The builder never invents a classification: every requested ID must already exist in its
 * declared historical or current population. It then runs the independent transition audit over
 * the generated authority before returning it, so generator output cannot bypass the auditor.
 *
 * @param historical - Immutable schema-v2 projection population.
 * @param current - Observed schema-v3 projection population.
 * @param plan - Human-reviewed exhaustive classification without derived digests.
 * @returns Generated authority, or null with stable diagnostics when any binding is missing.
 */
export function buildReleaseMutationTransitionAuthority(
  historical: ReleaseMutationTransitionPopulation,
  current: ReleaseMutationTransitionPopulation,
  plan: ReleaseMutationTransitionBuildPlan
): ReleaseMutationTransitionBuildResult {
  const problems: string[] = [];
  const historicalSources = indexPopulation("historical source", historical.sources, problems);
  const currentSources = indexPopulation("current source", current.sources, problems);
  const historicalIdentities = indexPopulation("historical executable identity", historical.identities, problems);
  const currentIdentities = indexPopulation("current executable identity", current.identities, problems);
  const requireProjection = (
    population: ReadonlyMap<string, ReleaseMutationTransitionProjection>,
    id: string,
    path: string
  ): ReleaseMutationTransitionProjection | null => {
    const projection = population.get(id);
    if (projection === undefined) problems.push(`${path} references missing projection ${id}`);
    return projection ?? null;
  };
  const unchangedSources = plan.unchangedSourceIds.flatMap((id) => {
    const projection = requireProjection(historicalSources, id, `unchanged source ${id}`);
    return projection === null ? [] : [{ id }];
  });
  const sourceChanges = plan.changedSources.flatMap((entry) => {
    const from = requireProjection(historicalSources, entry.id, `changed source ${entry.id}`);
    const to = requireProjection(currentSources, entry.id, `changed source ${entry.id}`);
    return from === null || to === null
      ? []
      : [
          {
            id: entry.id,
            allowedChanges: entry.allowedChanges,
            reason: entry.reason,
            witness: { from: projectionWitness(from), to: projectionWitness(to) }
          }
        ];
  });
  const retiredSources = plan.retiredSources.flatMap((entry) => {
    const projection = requireProjection(historicalSources, entry.id, `retired source ${entry.id}`);
    return projection === null
      ? []
      : [{ oldId: entry.id, reason: entry.reason, witness: projectionWitness(projection) }];
  });
  const sourceSuccessors = plan.sourceSuccessors.flatMap((entry) => {
    const from = requireProjection(historicalSources, entry.oldId, `source successor ${entry.oldId}`);
    const to = requireProjection(currentSources, entry.newId, `source successor ${entry.oldId}`);
    return from === null || to === null
      ? []
      : [
          {
            oldId: entry.oldId,
            newId: entry.newId,
            reason: entry.reason,
            witness: { from: projectionWitness(from), to: projectionWitness(to) }
          }
        ];
  });
  const newSources = plan.newSourceIds.flatMap((entry) => {
    const projection = requireProjection(currentSources, entry.id, `new source ${entry.id}`);
    return projection === null ? [] : [{ id: entry.id, reason: entry.reason, witness: projectionWitness(projection) }];
  });
  const unchangedIdentities = plan.unchangedIdentityIds.flatMap((id) => {
    const projection = requireProjection(historicalIdentities, id, `unchanged executable identity ${id}`);
    return projection === null ? [] : [{ id }];
  });
  const identityTransitions: Array<RetiredAuthority | SuccessorAuthority> = [];
  for (const entry of plan.identitySuccessors) {
    const from = requireProjection(historicalIdentities, entry.oldId, `identity successor ${entry.oldId}`);
    const to = requireProjection(currentIdentities, entry.newId, `identity successor ${entry.oldId}`);
    if (from !== null && to !== null) {
      identityTransitions.push({
        oldId: entry.oldId,
        newId: entry.newId,
        reason: entry.reason,
        witness: { from: projectionWitness(from), to: projectionWitness(to) }
      });
    }
  }
  for (const entry of plan.retiredIdentities) {
    const projection = requireProjection(historicalIdentities, entry.id, `retired executable identity ${entry.id}`);
    if (projection !== null) {
      identityTransitions.push({
        oldId: entry.id,
        reason: entry.reason,
        witness: projectionWitness(projection)
      });
    }
  }
  const newIdentities = plan.newIdentityIds.flatMap((entry) => {
    const projection = requireProjection(currentIdentities, entry.id, `new executable identity ${entry.id}`);
    return projection === null ? [] : [{ id: entry.id, reason: entry.reason, witness: projectionWitness(projection) }];
  });
  if (problems.length !== 0) return Object.freeze({ authority: null, problems: Object.freeze(problems) });
  const authority: ReleaseMutationTransitionAuthority = Object.freeze({
    schemaVersion: 3,
    normalizer: "release-mutation-transition-v3",
    historicalFixtureSha256: plan.historicalFixtureSha256,
    unchangedSources: Object.freeze(unchangedSources),
    sourceChanges: Object.freeze(sourceChanges),
    retiredSources: Object.freeze(retiredSources),
    sourceSuccessors: Object.freeze(sourceSuccessors),
    newSources: Object.freeze(newSources),
    unchangedIdentities: Object.freeze(unchangedIdentities),
    identityTransitions: Object.freeze(identityTransitions),
    newIdentities: Object.freeze(newIdentities)
  });
  const auditProblems = auditReleaseMutationTransition(historical, current, authority).problems;
  return Object.freeze({
    authority: auditProblems.length === 0 ? authority : null,
    problems: auditProblems
  });
}
