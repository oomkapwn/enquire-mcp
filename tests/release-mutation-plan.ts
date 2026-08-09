/** Mutation application mode used by the release-integrity oracle. */
export type ReleaseMutationMode = "first" | "all";

const globalObject: typeof globalThis = globalThis;
const arrayConstructor: typeof Array = Array;
const arrayPrototype = Array.prototype;
const iteratorSymbol: typeof Symbol.iterator = Symbol.iterator;
const speciesSymbol: typeof Symbol.species = Symbol.species;
const arrayEntriesIntrinsic = arrayPrototype.entries;
const arrayEveryIntrinsic = arrayPrototype.every;
const arrayFilterIntrinsic = arrayPrototype.filter;
const arrayIncludesIntrinsic = arrayPrototype.includes;
const arrayIndexOfIntrinsic = arrayPrototype.indexOf;
const arrayIteratorIntrinsic = arrayPrototype[iteratorSymbol];
const arrayJoinIntrinsic = arrayPrototype.join;
const arrayMapIntrinsic = arrayPrototype.map;
const arraySomeIntrinsic = arrayPrototype.some;
const arraySortIntrinsic = arrayPrototype.sort;
const arraySliceIntrinsic = arrayPrototype.slice;
const arrayPrototypeConstructorIntrinsic = arrayPrototype.constructor;
const isArrayIntrinsic: typeof Array.isArray = Array.isArray;
const errorConstructor: typeof Error = Error;
const mapConstructor: typeof Map = Map;
const mapPrototype = Map.prototype;
const mapGetIntrinsic = mapPrototype.get;
const mapHasIntrinsic = mapPrototype.has;
const mapIteratorIntrinsic = mapPrototype[iteratorSymbol];
const mapKeysIntrinsic = mapPrototype.keys;
const mapSetIntrinsic = mapPrototype.set;
const numberConstructor: typeof Number = Number;
const numberIsFiniteIntrinsic: typeof Number.isFinite = Number.isFinite;
const numberIsSafeIntegerIntrinsic: typeof Number.isSafeInteger = Number.isSafeInteger;
const objectConstructor: typeof Object = Object;
const defineObjectPropertyIntrinsic: typeof Object.defineProperty = Object.defineProperty;
const freezeObject: typeof Object.freeze = Object.freeze;
const getObjectPrototypeIntrinsic: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptorsIntrinsic: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectKeysIntrinsic: typeof Object.keys = Object.keys;
const objectValuesIntrinsic: typeof Object.values = Object.values;
const objectPrototype = Object.prototype;
const reflectObject: typeof Reflect = Reflect;
const ownKeysIntrinsic: typeof Reflect.ownKeys = Reflect.ownKeys;
const sealObject: typeof Object.seal = Object.seal;
const applyFunction: typeof Reflect.apply = Reflect.apply;
const pushArrayIntrinsic = arrayPrototype.push;
const setConstructor: typeof Set = Set;
const setPrototype = Set.prototype;
const setAddIntrinsic = setPrototype.add;
const setDeleteIntrinsic = setPrototype.delete;
const setHasIntrinsic = setPrototype.has;
const setIteratorIntrinsic = setPrototype[iteratorSymbol];
const setKeysIntrinsic = setPrototype.keys;
const stringConstructor: typeof String = String;
const stringPrototype = String.prototype;
const stringIndexOfIntrinsic = stringPrototype.indexOf;
const stringCharAtIntrinsic = stringPrototype.charAt;
const stringIncludesIntrinsic = stringPrototype.includes;
const stringSliceIntrinsic = stringPrototype.slice;
const stringSplitIntrinsic = stringPrototype.split;
const symbolConstructor: typeof Symbol = Symbol;
const regExpConstructor: typeof RegExp = RegExp;
const regExpPrototype = RegExp.prototype;
const execRegExpIntrinsic = regExpPrototype.exec;
const weakMapConstructor: typeof WeakMap = WeakMap;
const weakMapPrototype = WeakMap.prototype;
const weakMapGetIntrinsic = weakMapPrototype.get;
const weakMapSetIntrinsic = weakMapPrototype.set;
const weakSetConstructor: typeof WeakSet = WeakSet;
const weakSetPrototype = WeakSet.prototype;
const weakSetAddIntrinsic = weakSetPrototype.add;
const weakSetDeleteIntrinsic = weakSetPrototype.delete;
const weakSetHasIntrinsic = weakSetPrototype.has;
const arrayIteratorPrototype = getObjectPrototypeIntrinsic([][iteratorSymbol]()) as object & {
  readonly next: unknown;
};
const mapIteratorPrototype = getObjectPrototypeIntrinsic(new mapConstructor().keys()) as object & {
  readonly next: unknown;
};
const setIteratorPrototype = getObjectPrototypeIntrinsic(new setConstructor().keys()) as object & {
  readonly next: unknown;
};
const iteratorPrototype = getObjectPrototypeIntrinsic(arrayIteratorPrototype) as object & {
  readonly [iteratorSymbol]: unknown;
};
const arrayIteratorNextIntrinsic = arrayIteratorPrototype.next;
const mapIteratorNextIntrinsic = mapIteratorPrototype.next;
const setIteratorNextIntrinsic = setIteratorPrototype.next;
const iteratorSelfIntrinsic = iteratorPrototype[iteratorSymbol];
const arraySpeciesGetterIntrinsic = (
  getOwnPropertyDescriptorsIntrinsic(arrayConstructor) as Record<PropertyKey, PropertyDescriptor | undefined>
)[speciesSymbol]?.get;

const intrinsicDataProperties: readonly (readonly [object, PropertyKey, unknown])[] = [
  [globalObject, "Array", arrayConstructor],
  [globalObject, "Error", errorConstructor],
  [globalObject, "Map", mapConstructor],
  [globalObject, "Number", numberConstructor],
  [globalObject, "Object", objectConstructor],
  [globalObject, "Reflect", reflectObject],
  [globalObject, "RegExp", regExpConstructor],
  [globalObject, "Set", setConstructor],
  [globalObject, "String", stringConstructor],
  [globalObject, "Symbol", symbolConstructor],
  [globalObject, "WeakMap", weakMapConstructor],
  [globalObject, "WeakSet", weakSetConstructor],
  [arrayConstructor, "prototype", arrayPrototype],
  [arrayConstructor, "isArray", isArrayIntrinsic],
  [arrayPrototype, "constructor", arrayPrototypeConstructorIntrinsic],
  [arrayPrototype, "entries", arrayEntriesIntrinsic],
  [arrayPrototype, "every", arrayEveryIntrinsic],
  [arrayPrototype, "filter", arrayFilterIntrinsic],
  [arrayPrototype, "includes", arrayIncludesIntrinsic],
  [arrayPrototype, "indexOf", arrayIndexOfIntrinsic],
  [arrayPrototype, iteratorSymbol, arrayIteratorIntrinsic],
  [arrayPrototype, "join", arrayJoinIntrinsic],
  [arrayPrototype, "map", arrayMapIntrinsic],
  [arrayPrototype, "slice", arraySliceIntrinsic],
  [arrayPrototype, "some", arraySomeIntrinsic],
  [arrayPrototype, "sort", arraySortIntrinsic],
  [mapConstructor, "prototype", mapPrototype],
  [mapPrototype, "get", mapGetIntrinsic],
  [mapPrototype, "has", mapHasIntrinsic],
  [mapPrototype, iteratorSymbol, mapIteratorIntrinsic],
  [mapPrototype, "keys", mapKeysIntrinsic],
  [mapPrototype, "set", mapSetIntrinsic],
  [numberConstructor, "isFinite", numberIsFiniteIntrinsic],
  [numberConstructor, "isSafeInteger", numberIsSafeIntegerIntrinsic],
  [objectConstructor, "prototype", objectPrototype],
  [objectConstructor, "defineProperty", defineObjectPropertyIntrinsic],
  [objectConstructor, "getOwnPropertyDescriptors", getOwnPropertyDescriptorsIntrinsic],
  [objectConstructor, "getPrototypeOf", getObjectPrototypeIntrinsic],
  [objectConstructor, "keys", objectKeysIntrinsic],
  [objectConstructor, "values", objectValuesIntrinsic],
  [reflectObject, "apply", applyFunction],
  [reflectObject, "ownKeys", ownKeysIntrinsic],
  [regExpConstructor, "prototype", regExpPrototype],
  [regExpPrototype, "exec", execRegExpIntrinsic],
  [setConstructor, "prototype", setPrototype],
  [setPrototype, "add", setAddIntrinsic],
  [setPrototype, "delete", setDeleteIntrinsic],
  [setPrototype, "has", setHasIntrinsic],
  [setPrototype, iteratorSymbol, setIteratorIntrinsic],
  [setPrototype, "keys", setKeysIntrinsic],
  [stringConstructor, "prototype", stringPrototype],
  [stringPrototype, "charAt", stringCharAtIntrinsic],
  [stringPrototype, "includes", stringIncludesIntrinsic],
  [stringPrototype, "indexOf", stringIndexOfIntrinsic],
  [stringPrototype, "slice", stringSliceIntrinsic],
  [stringPrototype, "split", stringSplitIntrinsic],
  [symbolConstructor, "iterator", iteratorSymbol],
  [symbolConstructor, "species", speciesSymbol],
  [weakMapConstructor, "prototype", weakMapPrototype],
  [weakMapPrototype, "get", weakMapGetIntrinsic],
  [weakMapPrototype, "set", weakMapSetIntrinsic],
  [weakSetConstructor, "prototype", weakSetPrototype],
  [weakSetPrototype, "add", weakSetAddIntrinsic],
  [weakSetPrototype, "delete", weakSetDeleteIntrinsic],
  [weakSetPrototype, "has", weakSetHasIntrinsic],
  [arrayIteratorPrototype, "next", arrayIteratorNextIntrinsic],
  [mapIteratorPrototype, "next", mapIteratorNextIntrinsic],
  [setIteratorPrototype, "next", setIteratorNextIntrinsic],
  [iteratorPrototype, iteratorSymbol, iteratorSelfIntrinsic]
];

function hasIntrinsicAccessorProperty(
  owner: object,
  key: PropertyKey,
  expectedGet: (() => unknown) | undefined,
  expectedSet: ((value: unknown) => void) | undefined
): boolean {
  try {
    const descriptor = (
      getOwnPropertyDescriptorsIntrinsic(owner) as Record<PropertyKey, PropertyDescriptor | undefined>
    )[key];
    return (
      descriptor !== undefined &&
      !("value" in descriptor) &&
      descriptor.get === expectedGet &&
      descriptor.set === expectedSet
    );
  } catch {
    return false;
  }
}

function assertAmbientIntrinsics(): void {
  let dataPropertiesIntact = true;
  let inspectedOwner: object | null = null;
  let inspectedDescriptors: Record<PropertyKey, PropertyDescriptor | undefined> | null = null;
  for (let index = 0; index < intrinsicDataProperties.length; index++) {
    const entry = intrinsicDataProperties[index];
    if (entry === undefined) {
      dataPropertiesIntact = false;
      break;
    }
    if (entry[0] !== inspectedOwner) {
      inspectedOwner = entry[0];
      try {
        inspectedDescriptors = getOwnPropertyDescriptorsIntrinsic(inspectedOwner) as Record<
          PropertyKey,
          PropertyDescriptor | undefined
        >;
      } catch {
        inspectedDescriptors = null;
      }
    }
    const descriptor = inspectedDescriptors?.[entry[1]];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value !== entry[2]) {
      dataPropertiesIntact = false;
      break;
    }
  }
  if (
    !dataPropertiesIntact ||
    !hasIntrinsicAccessorProperty(arrayConstructor, speciesSymbol, arraySpeciesGetterIntrinsic, undefined) ||
    getObjectPrototypeIntrinsic(arrayIteratorPrototype) !== iteratorPrototype ||
    getObjectPrototypeIntrinsic(mapIteratorPrototype) !== iteratorPrototype ||
    getObjectPrototypeIntrinsic(setIteratorPrototype) !== iteratorPrototype ||
    getObjectPrototypeIntrinsic(iteratorPrototype) !== objectPrototype
  ) {
    throw new errorConstructor("release mutation ambient intrinsic drift");
  }
}

function pushArrayValue<T>(array: T[], value: T): number {
  return applyFunction(pushArrayIntrinsic, array, [value]) as number;
}

function testRegExp(regex: RegExp, value: string): boolean {
  return applyFunction(execRegExpIntrinsic, regex, [value]) !== null;
}

declare const RELEASE_SOURCE_HANDLE_BRAND: unique symbol;
declare const RELEASE_MUTATION_HANDLE_BRAND: unique symbol;

/** Opaque plan-owned reference to one canonical source. */
export interface ReleaseSourceHandle {
  readonly [RELEASE_SOURCE_HANDLE_BRAND]: true;
}

/** Opaque plan-owned reference to one prepared mutation output. */
export interface ReleaseMutationHandle {
  readonly [RELEASE_MUTATION_HANDLE_BRAND]: true;
}

/**
 * A bounded positive witness that must change by an exact count across one mutation.
 *
 * The witness is deliberately separate from the mutation needle. A mutation that preserves its
 * original anchor while adding a forbidden fragment must name that added fragment as the witness.
 */
export interface ReleaseMutationWitness {
  readonly kind: "token" | "line";
  readonly anchor: string;
  readonly before: number;
  readonly after: number;
}

/** Declarative input for one dependency-aware release mutation. */
export interface ReleaseMutationRegistration {
  readonly mode: ReleaseMutationMode;
  readonly source: ReleaseSourceHandle | ReleaseMutationHandle;
  readonly needle: string;
  readonly replacement: string | ReleaseMutationHandle;
  readonly expectedOccurrences: number;
  readonly witness: ReleaseMutationWitness;
}

/** Closed data-only invocation inventory for the release-mutation oracle. */
export type ReleaseOracleInvocation =
  | {
      readonly kind: "fixture.text";
      readonly baseline: ReleaseSourceHandle | ReleaseMutationHandle;
      readonly mutant: ReleaseMutationHandle;
    }
  | {
      readonly kind: "fixture.throw";
      readonly baseline: ReleaseSourceHandle | ReleaseMutationHandle;
      readonly mutant: ReleaseMutationHandle;
      readonly message: string;
    }
  | {
      readonly kind: "registry.evaluator";
      readonly baseline: ReleaseSourceHandle | ReleaseMutationHandle;
      readonly mutant: ReleaseMutationHandle;
    }
  | {
      readonly kind: "registry.step.run";
      readonly baseline: ReleaseSourceHandle | ReleaseMutationHandle;
      readonly mutant: ReleaseMutationHandle;
      readonly integrity: ReleaseSourceHandle;
    }
  | {
      readonly kind: "registry.step.integrity";
      readonly baseline: ReleaseSourceHandle | ReleaseMutationHandle;
      readonly mutant: ReleaseMutationHandle;
      readonly run: ReleaseSourceHandle;
    }
  | {
      readonly kind: "npm.contract.release";
      readonly baseline: ReleaseSourceHandle | ReleaseMutationHandle;
      readonly mutant: ReleaseMutationHandle;
      readonly integrity: ReleaseSourceHandle;
    }
  | {
      readonly kind: "npm.contract.integrity";
      readonly baseline: ReleaseSourceHandle | ReleaseMutationHandle;
      readonly mutant: ReleaseMutationHandle;
      readonly release: ReleaseSourceHandle;
    };

/** Exact problem identities emitted by the closed fixtures and execution adapters. */
export type ReleaseProblemIdentity =
  | "fixture.mutant-threw"
  | "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics"
  | "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback"
  | "npm provenance must bind the tag-push context before the sole publish and verify two exact attestations without credentials";

type RegistryEvaluatorProblemsAdapter = (source: string) => readonly string[];
type RegistryStepProblemsAdapter = (run: string, integrity: string) => readonly string[];
type NpmContractProblemsAdapter = (release: string, integrity: string) => readonly string[];

/**
 * Closed execution-only adapters used to evaluate planner-materialized production sources.
 *
 * @example
 * plan.execute({ registryEvaluatorProblems: evaluateRegistrySource });
 */
export interface ReleaseOracleAdapters {
  /**
   * Evaluate one exact release-integrity source.
   *
   * @param source - Planner-materialized baseline or mutant source bytes.
   * @returns Closed problem identities observed for those exact bytes.
   */
  readonly registryEvaluatorProblems?: RegistryEvaluatorProblemsAdapter;

  /**
   * Evaluate one exact MCP Registry publication-step run body with one exact integrity script.
   *
   * @param run - Planner-materialized clean companion or baseline/mutant workflow step run bytes.
   * @param integrity - Planner-materialized clean companion or baseline/mutant release-integrity bytes.
   * @returns Closed problem identities observed for those exact bytes.
   */
  readonly registryStepProblems?: RegistryStepProblemsAdapter;

  /**
   * Evaluate one exact release workflow together with one exact release-integrity script.
   *
   * @param release - Planner-materialized clean companion or baseline/mutant release-workflow bytes.
   * @param integrity - Planner-materialized clean companion or baseline/mutant release-integrity bytes.
   * @returns Closed problem identities observed for those exact bytes.
   */
  readonly npmContractProblems?: NpmContractProblemsAdapter;
}

/** Named, allowlisted regular expressions available to closed expectations. */
export type ReleaseNamedRegexIdentity = "fixture.omega-token";

/** Closed, plain-data expectation inventory applied by the release-mutation engine. */
export type ReleaseExpectation =
  | { readonly id: string; readonly kind: "problem"; readonly problem: ReleaseProblemIdentity }
  | { readonly id: string; readonly kind: "equal"; readonly value: string }
  | { readonly id: string; readonly kind: "not-equal"; readonly value: string }
  | { readonly id: string; readonly kind: "regex"; readonly regex: ReleaseNamedRegexIdentity };

/** One ordered, data-only oracle check with an exact invocation/expectation pairing. */
export interface ReleaseMutationCheck {
  readonly invoke: ReleaseOracleInvocation;
  readonly expectation: ReleaseExpectation;
}

/** One named, data-only oracle case containing one or more ordered checks. */
export interface ReleaseMutationCase {
  readonly id: string;
  readonly root: ReleaseMutationHandle;
  readonly checks: readonly ReleaseMutationCheck[];
}

/** Optional exact mutation-only or full-topology projection for a complete mutation matrix. */
export type ReleaseMutationInventoryExpectation =
  | {
      readonly total: number;
      readonly first: number;
      readonly all: number;
    }
  | {
      readonly total: number;
      readonly first: number;
      readonly all: number;
      readonly cases: number;
      readonly expectations: number;
      readonly roots: number;
      readonly dependencyOnly: number;
    };

/** Lifecycle state of a release-mutation plan. */
export type ReleaseMutationPlanState =
  | "open"
  | "sealing"
  | "sealed"
  | "rejected"
  | "executing"
  | "partially-executed"
  | "executed"
  | "failed";

type HandleKind = "source" | "mutation";

interface HandleMetadata {
  readonly owner: object;
  readonly kind: HandleKind;
  readonly id: string;
}

interface RegisteredSource {
  readonly handle: ReleaseSourceHandle;
  readonly id: unknown;
  readonly value: unknown;
}

interface RegisteredMutation {
  readonly handle: ReleaseMutationHandle;
  readonly id: unknown;
  readonly registration: unknown;
}

interface RegisteredCase {
  readonly registration: unknown;
}

interface SourceValidation {
  readonly byHandle: ReadonlyMap<ReleaseSourceHandle, RegisteredSource>;
  readonly invalid: ReadonlySet<ReleaseSourceHandle>;
}

interface MutationAnalysis {
  readonly id: string;
  readonly mode: ReleaseMutationMode | null;
  readonly source: ReleaseSourceHandle | ReleaseMutationHandle | null;
  readonly needle: string | null;
  readonly replacement: string | ReleaseMutationHandle | null;
  readonly expectedOccurrences: number | null;
  readonly witness: ReleaseMutationWitness | null;
  readonly unpreparable: boolean;
}

type ReleaseOracleObservation =
  | { readonly kind: "fixture.text"; readonly baseline: string; readonly mutant: string }
  | {
      readonly kind: "fixture.throw";
      readonly baseline: string;
      readonly problems: readonly ReleaseProblemIdentity[];
    }
  | {
      readonly kind: "registry.evaluator";
      readonly baselineProblems: readonly ReleaseProblemIdentity[];
      readonly mutantProblems: readonly ReleaseProblemIdentity[];
    }
  | {
      readonly kind: "registry.step.run";
      readonly baselineProblems: readonly ReleaseProblemIdentity[];
      readonly mutantProblems: readonly ReleaseProblemIdentity[];
    }
  | {
      readonly kind: "registry.step.integrity";
      readonly baselineProblems: readonly ReleaseProblemIdentity[];
      readonly mutantProblems: readonly ReleaseProblemIdentity[];
    }
  | {
      readonly kind: "npm.contract.release";
      readonly baselineProblems: readonly ReleaseProblemIdentity[];
      readonly mutantProblems: readonly ReleaseProblemIdentity[];
    }
  | {
      readonly kind: "npm.contract.integrity";
      readonly baselineProblems: readonly ReleaseProblemIdentity[];
      readonly mutantProblems: readonly ReleaseProblemIdentity[];
    };

type PreparedExpectation = ReleaseExpectation;

interface CaseAnalysis {
  readonly id: string;
  readonly root: ReleaseMutationHandle | null;
  readonly checks: readonly PreparedCheck[];
  readonly valid: boolean;
}

interface InvocationAnalysis {
  readonly kind: ReleaseOracleInvocation["kind"] | null;
  readonly invocation: ReleaseOracleInvocation | null;
}

interface PreparedMutation {
  readonly output: string;
}

interface PreparedCheck {
  readonly invocation: ReleaseOracleInvocation;
  readonly expectation: PreparedExpectation;
}

interface PreparedCase {
  readonly id: string;
  readonly root: ReleaseMutationHandle;
  readonly checks: readonly PreparedCheck[];
}

interface StagedExecution {
  readonly adapters: ReleaseOracleAdapters | undefined;
  readonly expectedNextCaseIndex: number;
  readonly preparedCaseCount: number;
}

type RegistrationProblem = (code: string, path: string, detail: string) => void;

interface SnapshotBudget {
  remainingObjects: number;
  reportedExhaustion: boolean;
}

const HANDLE_METADATA = new weakMapConstructor<object, HandleMetadata>();
const ID_PATTERN = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;
const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_ENTRIES = 10_000;
const MAX_SNAPSHOT_OBJECTS = 50_000;
const MCP_REGISTRY_EVALUATOR_PROBLEM: ReleaseProblemIdentity =
  "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics";
const MCP_REGISTRY_WORKFLOW_PROBLEM: ReleaseProblemIdentity =
  "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback";
const NPM_PROVENANCE_CONTRACT_PROBLEM: ReleaseProblemIdentity =
  "npm provenance must bind the tag-push context before the sole publish and verify two exact attestations without credentials";

function isPositiveSafeInteger(value: number): boolean {
  return numberIsSafeIntegerIntrinsic(value) && value > 0;
}

function displayIdentity(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function objectValue(value: unknown): object | null {
  return typeof value === "object" && value !== null ? value : null;
}

function handleMetadata(value: unknown): HandleMetadata | undefined {
  const object = objectValue(value);
  return object === null
    ? undefined
    : (applyFunction(weakMapGetIntrinsic, HANDLE_METADATA, [object]) as HandleMetadata | undefined);
}

function createHandle<T extends ReleaseSourceHandle | ReleaseMutationHandle>(
  owner: object,
  kind: HandleKind,
  id: string
): T {
  const handle = freezeObject({}) as object;
  applyFunction(weakMapSetIntrinsic, HANDLE_METADATA, [handle, { owner, kind, id }]);
  return handle as unknown as T;
}

function isArrayIndex(key: string): boolean {
  if (!testRegExp(/^(0|[1-9]\d*)$/u, key)) return false;
  const value = numberConstructor(key);
  return numberIsSafeIntegerIntrinsic(value) && value >= 0 && value < 4_294_967_295;
}

function snapshotPlainData(
  value: unknown,
  path: string,
  problem: RegistrationProblem,
  ancestors = new weakSetConstructor<object>(),
  depth = 0,
  budget: SnapshotBudget = { remainingObjects: MAX_SNAPSHOT_OBJECTS, reportedExhaustion: false }
): unknown {
  const metadata = handleMetadata(value);
  if (metadata !== undefined) return value;
  if (depth > MAX_SNAPSHOT_DEPTH) {
    problem("data.depth", path, `release-mutation data exceeds maximum depth ${MAX_SNAPSHOT_DEPTH}`);
    return undefined;
  }
  if (typeof value === "number" && !numberIsFiniteIntrinsic(value)) {
    problem("data.number", path, "non-finite numbers are not valid release-mutation data");
    return undefined;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "function") {
    problem("data.function", path, "functions are not valid release-mutation data");
    return undefined;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    problem("data.primitive", path, `${typeof value} values are not valid release-mutation data`);
    return undefined;
  }

  const object = objectValue(value);
  if (object === null) {
    problem("data.primitive", path, "unsupported release-mutation data");
    return undefined;
  }
  if (budget.remainingObjects === 0) {
    if (!budget.reportedExhaustion) {
      problem("data.size", path, `release-mutation data exceeds ${MAX_SNAPSHOT_OBJECTS} inspected objects`);
      budget.reportedExhaustion = true;
    }
    return undefined;
  }
  budget.remainingObjects--;
  if (applyFunction(weakSetHasIntrinsic, ancestors, [object]) as boolean) {
    problem("data.cycle", path, "cyclic release-mutation data is not allowed");
    return undefined;
  }

  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  let isArray: boolean;
  try {
    isArray = isArrayIntrinsic(object);
    prototype = getObjectPrototypeIntrinsic(object) as object | null;
    descriptors = getOwnPropertyDescriptorsIntrinsic(object) as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    problem("data.inspect", path, "release-mutation data must support deterministic structural inspection");
    return undefined;
  }

  if (isArray) {
    if (prototype !== arrayPrototype) {
      problem("data.prototype", path, "arrays must use the built-in Array prototype");
      return undefined;
    }
    applyFunction(weakSetAddIntrinsic, ancestors, [object]);
    const snapshot: unknown[] = [];
    const lengthDescriptor = descriptors.length;
    const length: unknown = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (
      typeof length !== "number" ||
      !numberIsSafeIntegerIntrinsic(length) ||
      length < 0 ||
      length > MAX_SNAPSHOT_ENTRIES
    ) {
      problem(
        "data.array",
        path,
        `array length must be a non-negative safe integer no greater than ${MAX_SNAPSHOT_ENTRIES}`
      );
      applyFunction(weakSetDeleteIntrinsic, ancestors, [object]);
      return freezeObject(snapshot);
    }
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[stringConstructor(index)];
      if (descriptor === undefined) {
        problem("data.array", `${path}[${index}]`, "sparse arrays are not valid release-mutation data");
        pushArrayValue(snapshot, undefined);
      } else if (!("value" in descriptor)) {
        problem("data.accessor", `${path}[${index}]`, "getters and setters are not valid release-mutation data");
        pushArrayValue(snapshot, undefined);
      } else if (!descriptor.enumerable) {
        problem("data.property", `${path}[${index}]`, "non-enumerable properties are not valid release-mutation data");
        pushArrayValue(snapshot, undefined);
      } else {
        pushArrayValue(
          snapshot,
          snapshotPlainData(descriptor.value, `${path}[${index}]`, problem, ancestors, depth + 1, budget)
        );
      }
    }
    const descriptorKeys = ownKeysIntrinsic(descriptors);
    for (let keyIndex = 0; keyIndex < descriptorKeys.length; keyIndex++) {
      const key = descriptorKeys[keyIndex];
      if (key === undefined) continue;
      if (typeof key === "symbol") {
        problem("data.symbol", path, "symbol properties are not valid release-mutation data");
      } else if (key !== "length" && !isArrayIndex(key)) {
        problem("data.array", `${path}.${key}`, "custom array properties are not valid release-mutation data");
      }
    }
    applyFunction(weakSetDeleteIntrinsic, ancestors, [object]);
    return freezeObject(snapshot);
  }

  if (prototype !== objectPrototype) {
    problem("data.prototype", path, "only plain objects and arrays are valid release-mutation data");
    return undefined;
  }

  const descriptorKeys = ownKeysIntrinsic(descriptors);
  if (descriptorKeys.length > MAX_SNAPSHOT_ENTRIES) {
    problem("data.size", path, `plain objects may contain at most ${MAX_SNAPSHOT_ENTRIES} own properties`);
    return undefined;
  }

  applyFunction(weakSetAddIntrinsic, ancestors, [object]);
  const snapshot: Record<string, unknown> = {};
  for (let keyIndex = 0; keyIndex < descriptorKeys.length; keyIndex++) {
    const key = descriptorKeys[keyIndex];
    if (key === undefined) continue;
    if (typeof key === "symbol") {
      problem("data.symbol", path, "symbol properties are not valid release-mutation data");
      continue;
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      problem("data.accessor", `${path}.${key}`, "getters and setters are not valid release-mutation data");
      continue;
    }
    if (!descriptor.enumerable) {
      problem("data.property", `${path}.${key}`, "non-enumerable properties are not valid release-mutation data");
      continue;
    }
    if (key === "then" && typeof descriptor.value === "function") {
      problem("data.thenable", `${path}.then`, "thenables are not valid release-mutation data");
      continue;
    }
    defineObjectPropertyIntrinsic(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: snapshotPlainData(descriptor.value, `${path}.${key}`, problem, ancestors, depth + 1, budget),
      writable: false
    });
  }
  applyFunction(weakSetDeleteIntrinsic, ancestors, [object]);
  return freezeObject(snapshot);
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  const object = objectValue(value);
  if (object === null || isArrayIntrinsic(object) || getObjectPrototypeIntrinsic(object) !== objectPrototype) {
    return null;
  }
  return object as Readonly<Record<string, unknown>>;
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = objectKeysIntrinsic(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function containsHandle(value: unknown, visited = new weakSetConstructor<object>()): boolean {
  if (handleMetadata(value) !== undefined) return true;
  const object = objectValue(value);
  if (object === null || visited.has(object)) return false;
  visited.add(object);
  if (isArrayIntrinsic(object)) {
    const entries = object as readonly unknown[];
    return entries.some((entry) => containsHandle(entry, visited));
  }
  if (getObjectPrototypeIntrinsic(object) !== objectPrototype) return false;
  return objectValuesIntrinsic(object as Readonly<Record<string, unknown>>).some((entry) =>
    containsHandle(entry, visited)
  );
}

function countOccurrences(source: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const offset = source.indexOf(needle, cursor);
    if (offset === -1) return count;
    count++;
    cursor = offset + needle.length;
  }
}

function isTokenCharacter(value: string): boolean {
  return value.length > 0 && testRegExp(/[\p{L}\p{N}_]/u, value);
}

function countWitnessOccurrences(source: string, witness: ReleaseMutationWitness): number {
  if (witness.anchor.length === 0) return 0;
  if (witness.kind === "line") {
    return source.split("\n").filter((line) => line === witness.anchor).length;
  }
  let count = 0;
  let cursor = 0;
  const anchorStartsWithToken = isTokenCharacter(witness.anchor.charAt(0));
  const anchorEndsWithToken = isTokenCharacter(witness.anchor.charAt(witness.anchor.length - 1));
  while (true) {
    const offset = source.indexOf(witness.anchor, cursor);
    if (offset === -1) return count;
    const before = offset > 0 ? source.charAt(offset - 1) : "";
    const after = source.charAt(offset + witness.anchor.length);
    if ((!anchorStartsWithToken || !isTokenCharacter(before)) && (!anchorEndsWithToken || !isTokenCharacter(after))) {
      count++;
    }
    cursor = offset + witness.anchor.length;
  }
}

function expandLiteralReplacement(source: string, needle: string, replacement: string, offset: number): string {
  let expanded = "";
  for (let index = 0; index < replacement.length; index++) {
    const current = replacement.charAt(index);
    if (current !== "$") {
      expanded += current;
      continue;
    }
    const next = replacement.charAt(index + 1);
    if (next === "$") expanded += "$";
    else if (next === "&") expanded += needle;
    else if (next === "`") expanded += source.slice(0, offset);
    else if (next === "'") expanded += source.slice(offset + needle.length);
    else {
      expanded += "$";
      continue;
    }
    index++;
  }
  return expanded;
}

function applyLiteralMutation(source: string, needle: string, replacement: string, mode: ReleaseMutationMode): string {
  if (mode === "first") {
    const offset = source.indexOf(needle);
    if (offset === -1) return source;
    const expanded = expandLiteralReplacement(source, needle, replacement, offset);
    return [source.slice(0, offset), expanded, source.slice(offset + needle.length)].join("");
  }

  const fragments: string[] = [];
  let cursor = 0;
  while (true) {
    const offset = source.indexOf(needle, cursor);
    if (offset === -1) break;
    pushArrayValue(fragments, source.slice(cursor, offset));
    pushArrayValue(fragments, expandLiteralReplacement(source, needle, replacement, offset));
    cursor = offset + needle.length;
  }
  pushArrayValue(fragments, source.slice(cursor));
  return fragments.join("");
}

function assertNever(value: never): never {
  void value;
  throw new errorConstructor("unreachable closed release oracle variant");
}

function releaseNamedRegex(identity: ReleaseNamedRegexIdentity): RegExp {
  switch (identity) {
    case "fixture.omega-token":
      return /\bomega\b/u;
    default:
      return assertNever(identity);
  }
}

function fixtureTextProbe(value: string): string {
  return value;
}

function fixtureThrowProbe(value: string, message: string): string {
  if (testRegExp(releaseNamedRegex("fixture.omega-token"), value)) throw new errorConstructor(message);
  return value;
}

function materializeOracleValue(
  handle: ReleaseSourceHandle | ReleaseMutationHandle,
  sourceValues: ReadonlyMap<ReleaseSourceHandle, string>,
  prepared: ReadonlyMap<ReleaseMutationHandle, PreparedMutation>
): string {
  const metadata = handleMetadata(handle);
  const value =
    metadata?.kind === "source"
      ? sourceValues.get(handle as ReleaseSourceHandle)
      : prepared.get(handle as ReleaseMutationHandle)?.output;
  if (value === undefined) {
    throw new errorConstructor("closed release oracle invocation contains an unmaterialized handle");
  }
  return value;
}

interface ReleaseOracleAdapterRequirements {
  readonly npmContractProblems: boolean;
  readonly registryEvaluatorProblems: boolean;
  readonly registryStepProblems: boolean;
}

function releaseOracleAdapterRequirements(cases: readonly PreparedCase[]): ReleaseOracleAdapterRequirements {
  let npmContractProblems = false;
  let registryEvaluatorProblems = false;
  let registryStepProblems = false;
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    const releaseCase = cases[caseIndex];
    if (releaseCase === undefined) {
      throw new errorConstructor(`release mutation prepared case ${caseIndex} is missing`);
    }
    for (let checkIndex = 0; checkIndex < releaseCase.checks.length; checkIndex++) {
      const check = releaseCase.checks[checkIndex];
      if (check === undefined) {
        throw new errorConstructor(`release mutation prepared check ${caseIndex}:${checkIndex} is missing`);
      }
      switch (check.invocation.kind) {
        case "registry.evaluator":
          registryEvaluatorProblems = true;
          break;
        case "registry.step.run":
        case "registry.step.integrity":
          registryStepProblems = true;
          break;
        case "npm.contract.release":
        case "npm.contract.integrity":
          npmContractProblems = true;
          break;
        case "fixture.text":
        case "fixture.throw":
          break;
        default:
          assertNever(check.invocation);
      }
    }
  }
  return freezeObject({ npmContractProblems, registryEvaluatorProblems, registryStepProblems });
}

function releaseOracleAdapterShapeMessage(requirements: ReleaseOracleAdapterRequirements): string {
  if (requirements.npmContractProblems) {
    if (requirements.registryEvaluatorProblems && requirements.registryStepProblems) {
      return (
        "release oracle adapters must contain exactly enumerable npmContractProblems, " +
        "registryEvaluatorProblems, and registryStepProblems data functions"
      );
    }
    if (requirements.registryEvaluatorProblems) {
      return (
        "release oracle adapters must contain exactly enumerable npmContractProblems " +
        "and registryEvaluatorProblems data functions"
      );
    }
    if (requirements.registryStepProblems) {
      return (
        "release oracle adapters must contain exactly enumerable npmContractProblems " +
        "and registryStepProblems data functions"
      );
    }
    return "release oracle adapters must contain only an enumerable npmContractProblems data function";
  }
  if (requirements.registryEvaluatorProblems && requirements.registryStepProblems) {
    return (
      "release oracle adapters must contain exactly enumerable registryEvaluatorProblems " +
      "and registryStepProblems data functions"
    );
  }
  if (requirements.registryEvaluatorProblems) {
    return "release oracle adapters must contain only an enumerable registryEvaluatorProblems data function";
  }
  if (requirements.registryStepProblems) {
    return "release oracle adapters must contain only an enumerable registryStepProblems data function";
  }
  return "release oracle adapters must be omitted when the sealed plan requires none";
}

function validateReleaseOracleAdapters(
  value: unknown,
  requirements: ReleaseOracleAdapterRequirements
): ReleaseOracleAdapters | undefined {
  if (value === undefined) {
    if (
      !requirements.npmContractProblems &&
      !requirements.registryEvaluatorProblems &&
      !requirements.registryStepProblems
    ) {
      return undefined;
    }
    if (requirements.npmContractProblems) {
      if (requirements.registryEvaluatorProblems && requirements.registryStepProblems) {
        throw new errorConstructor(
          "registry evaluator, step, and npm contract cases require exact release oracle adapters at execute"
        );
      }
      if (requirements.registryEvaluatorProblems) {
        throw new errorConstructor(
          "registry evaluator and npm contract cases require exact release oracle adapters at execute"
        );
      }
      if (requirements.registryStepProblems) {
        throw new errorConstructor(
          "registry step and npm contract cases require exact release oracle adapters at execute"
        );
      }
      throw new errorConstructor("npm.contract cases require exact release oracle adapters at execute");
    }
    if (requirements.registryEvaluatorProblems && !requirements.registryStepProblems) {
      throw new errorConstructor("registry.evaluator cases require exact release oracle adapters at execute");
    }
    if (!requirements.registryEvaluatorProblems && requirements.registryStepProblems) {
      throw new errorConstructor("registry.step cases require exact release oracle adapters at execute");
    }
    throw new errorConstructor("registry evaluator and step cases require exact release oracle adapters at execute");
  }
  if (
    !requirements.npmContractProblems &&
    !requirements.registryEvaluatorProblems &&
    !requirements.registryStepProblems
  ) {
    throw new errorConstructor(releaseOracleAdapterShapeMessage(requirements));
  }
  const object = objectValue(value);
  if (object === null) {
    throw new errorConstructor("release oracle adapters must be an exact plain object");
  }

  let isArray: boolean;
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    isArray = isArrayIntrinsic(object);
    prototype = getObjectPrototypeIntrinsic(object) as object | null;
    descriptors = getOwnPropertyDescriptorsIntrinsic(object) as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    throw new errorConstructor("release oracle adapters must support deterministic structural inspection");
  }
  if (isArray || prototype !== objectPrototype) {
    throw new errorConstructor("release oracle adapters must be an exact plain object");
  }

  const keys = ownKeysIntrinsic(descriptors);
  let expectedCount = 0;
  if (requirements.npmContractProblems) expectedCount++;
  if (requirements.registryEvaluatorProblems) expectedCount++;
  if (requirements.registryStepProblems) expectedCount++;
  let exactKeys = keys.length === expectedCount;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (
      key === undefined ||
      (key !== "npmContractProblems" && key !== "registryEvaluatorProblems" && key !== "registryStepProblems") ||
      (key === "npmContractProblems" && !requirements.npmContractProblems) ||
      (key === "registryEvaluatorProblems" && !requirements.registryEvaluatorProblems) ||
      (key === "registryStepProblems" && !requirements.registryStepProblems)
    ) {
      exactKeys = false;
    }
  }

  const npmDescriptor = descriptors.npmContractProblems;
  const evaluatorDescriptor = descriptors.registryEvaluatorProblems;
  const stepDescriptor = descriptors.registryStepProblems;
  const exactNpm =
    !requirements.npmContractProblems ||
    (npmDescriptor !== undefined &&
      "value" in npmDescriptor &&
      npmDescriptor.enumerable &&
      typeof npmDescriptor.value === "function");
  const exactEvaluator =
    !requirements.registryEvaluatorProblems ||
    (evaluatorDescriptor !== undefined &&
      "value" in evaluatorDescriptor &&
      evaluatorDescriptor.enumerable &&
      typeof evaluatorDescriptor.value === "function");
  const exactStep =
    !requirements.registryStepProblems ||
    (stepDescriptor !== undefined &&
      "value" in stepDescriptor &&
      stepDescriptor.enumerable &&
      typeof stepDescriptor.value === "function");
  if (!exactKeys || !exactNpm || !exactEvaluator || !exactStep) {
    throw new errorConstructor(releaseOracleAdapterShapeMessage(requirements));
  }

  const closed: {
    npmContractProblems?: NpmContractProblemsAdapter;
    registryEvaluatorProblems?: RegistryEvaluatorProblemsAdapter;
    registryStepProblems?: RegistryStepProblemsAdapter;
  } = {};
  if (requirements.npmContractProblems && npmDescriptor !== undefined && "value" in npmDescriptor) {
    defineObjectPropertyIntrinsic(closed, "npmContractProblems", {
      configurable: false,
      enumerable: true,
      value: npmDescriptor.value as NpmContractProblemsAdapter,
      writable: false
    });
  }
  if (requirements.registryEvaluatorProblems && evaluatorDescriptor !== undefined && "value" in evaluatorDescriptor) {
    defineObjectPropertyIntrinsic(closed, "registryEvaluatorProblems", {
      configurable: false,
      enumerable: true,
      value: evaluatorDescriptor.value as RegistryEvaluatorProblemsAdapter,
      writable: false
    });
  }
  if (requirements.registryStepProblems && stepDescriptor !== undefined && "value" in stepDescriptor) {
    defineObjectPropertyIntrinsic(closed, "registryStepProblems", {
      configurable: false,
      enumerable: true,
      value: stepDescriptor.value as RegistryStepProblemsAdapter,
      writable: false
    });
  }
  return freezeObject(closed);
}

type ProblemOracleInvocationKind =
  | "registry.evaluator"
  | "registry.step.run"
  | "registry.step.integrity"
  | "npm.contract.release"
  | "npm.contract.integrity";

function snapshotOracleProblems(
  value: unknown,
  invocationKind: ProblemOracleInvocationKind,
  sourceKind: "baseline" | "mutant",
  expectedProblem: ReleaseProblemIdentity
): readonly ReleaseProblemIdentity[] {
  const structuralProblems: string[] = [];
  const snapshot = snapshotPlainData(value, `${invocationKind} ${sourceKind} result`, (code, path, detail) => {
    pushArrayValue(structuralProblems, `[${code}] ${path}: ${detail}`);
  });
  if (structuralProblems.length > 0) {
    const details = applyFunction(arrayJoinIntrinsic, structuralProblems, ["; "]) as string;
    throw new errorConstructor(
      `${invocationKind} ${sourceKind} result must be a dense built-in string array (${details})`
    );
  }
  if (!isArrayIntrinsic(snapshot)) {
    throw new errorConstructor(`${invocationKind} ${sourceKind} result must be a dense built-in string array`);
  }

  const entries = snapshot as readonly unknown[];
  const problems: ReleaseProblemIdentity[] = [];
  const seen = new setConstructor<ReleaseProblemIdentity>();
  for (let index = 0; index < entries.length; index++) {
    const problem = entries[index];
    if (problem !== expectedProblem) {
      throw new errorConstructor(`${invocationKind} ${sourceKind} result contains an unknown problem identity`);
    }
    if (applyFunction(setHasIntrinsic, seen, [problem]) as boolean) {
      throw new errorConstructor(`${invocationKind} ${sourceKind} result contains a duplicate problem identity`);
    }
    applyFunction(setAddIntrinsic, seen, [problem]);
    pushArrayValue(problems, problem);
  }
  return freezeObject(problems);
}

function executeReleaseOracleInvocation(
  invocation: ReleaseOracleInvocation,
  sourceValues: ReadonlyMap<ReleaseSourceHandle, string>,
  prepared: ReadonlyMap<ReleaseMutationHandle, PreparedMutation>,
  adapters: ReleaseOracleAdapters | undefined
): ReleaseOracleObservation {
  switch (invocation.kind) {
    case "fixture.text": {
      const baseline = fixtureTextProbe(materializeOracleValue(invocation.baseline, sourceValues, prepared));
      const mutant = fixtureTextProbe(materializeOracleValue(invocation.mutant, sourceValues, prepared));
      if (baseline === mutant) {
        throw new errorConstructor("fixture.text clean baseline must differ from its mutant");
      }
      return { kind: "fixture.text", baseline, mutant };
    }
    case "fixture.throw": {
      const baseline = fixtureThrowProbe(
        materializeOracleValue(invocation.baseline, sourceValues, prepared),
        invocation.message
      );
      const problems: ReleaseProblemIdentity[] = [];
      try {
        void fixtureThrowProbe(materializeOracleValue(invocation.mutant, sourceValues, prepared), invocation.message);
      } catch (error) {
        const observedMessage = errorMessage(error);
        if (observedMessage !== invocation.message) {
          throw new errorConstructor("fixture.throw mutant produced an unexpected error identity");
        }
        pushArrayValue(problems, "fixture.mutant-threw");
      }
      return { kind: "fixture.throw", baseline, problems: freezeObject(problems) };
    }
    case "registry.evaluator": {
      const registryEvaluatorProblems = adapters?.registryEvaluatorProblems;
      if (registryEvaluatorProblems === undefined) {
        throw new errorConstructor("registry.evaluator invocation requires exact release oracle adapters");
      }
      const baseline = materializeOracleValue(invocation.baseline, sourceValues, prepared);
      const mutant = materializeOracleValue(invocation.mutant, sourceValues, prepared);
      if (baseline === mutant) {
        throw new errorConstructor("registry.evaluator clean baseline must differ from its mutant");
      }

      const baselineResult: unknown = applyFunction(registryEvaluatorProblems, undefined, [baseline]);
      assertAmbientIntrinsics();
      const baselineProblems = snapshotOracleProblems(
        baselineResult,
        "registry.evaluator",
        "baseline",
        MCP_REGISTRY_EVALUATOR_PROBLEM
      );
      assertAmbientIntrinsics();
      const mutantResult: unknown = applyFunction(registryEvaluatorProblems, undefined, [mutant]);
      assertAmbientIntrinsics();
      const mutantProblems = snapshotOracleProblems(
        mutantResult,
        "registry.evaluator",
        "mutant",
        MCP_REGISTRY_EVALUATOR_PROBLEM
      );
      assertAmbientIntrinsics();
      return freezeObject({
        kind: "registry.evaluator",
        baselineProblems,
        mutantProblems
      });
    }
    case "registry.step.run": {
      const registryStepProblems = adapters?.registryStepProblems;
      if (registryStepProblems === undefined) {
        throw new errorConstructor("registry.step.run invocation requires exact release oracle adapters");
      }
      const baseline = materializeOracleValue(invocation.baseline, sourceValues, prepared);
      const mutant = materializeOracleValue(invocation.mutant, sourceValues, prepared);
      const integrity = materializeOracleValue(invocation.integrity, sourceValues, prepared);
      if (baseline === mutant) {
        throw new errorConstructor("registry.step.run clean baseline must differ from its mutant");
      }

      const baselineResult: unknown = applyFunction(registryStepProblems, undefined, [baseline, integrity]);
      assertAmbientIntrinsics();
      const baselineProblems = snapshotOracleProblems(
        baselineResult,
        "registry.step.run",
        "baseline",
        MCP_REGISTRY_WORKFLOW_PROBLEM
      );
      assertAmbientIntrinsics();
      const mutantResult: unknown = applyFunction(registryStepProblems, undefined, [mutant, integrity]);
      assertAmbientIntrinsics();
      const mutantProblems = snapshotOracleProblems(
        mutantResult,
        "registry.step.run",
        "mutant",
        MCP_REGISTRY_WORKFLOW_PROBLEM
      );
      assertAmbientIntrinsics();
      return freezeObject({ kind: "registry.step.run", baselineProblems, mutantProblems });
    }
    case "registry.step.integrity": {
      const registryStepProblems = adapters?.registryStepProblems;
      if (registryStepProblems === undefined) {
        throw new errorConstructor("registry.step.integrity invocation requires exact release oracle adapters");
      }
      const run = materializeOracleValue(invocation.run, sourceValues, prepared);
      const baseline = materializeOracleValue(invocation.baseline, sourceValues, prepared);
      const mutant = materializeOracleValue(invocation.mutant, sourceValues, prepared);
      if (baseline === mutant) {
        throw new errorConstructor("registry.step.integrity clean baseline must differ from its mutant");
      }

      const baselineResult: unknown = applyFunction(registryStepProblems, undefined, [run, baseline]);
      assertAmbientIntrinsics();
      const baselineProblems = snapshotOracleProblems(
        baselineResult,
        "registry.step.integrity",
        "baseline",
        MCP_REGISTRY_WORKFLOW_PROBLEM
      );
      assertAmbientIntrinsics();
      const mutantResult: unknown = applyFunction(registryStepProblems, undefined, [run, mutant]);
      assertAmbientIntrinsics();
      const mutantProblems = snapshotOracleProblems(
        mutantResult,
        "registry.step.integrity",
        "mutant",
        MCP_REGISTRY_WORKFLOW_PROBLEM
      );
      assertAmbientIntrinsics();
      return freezeObject({ kind: "registry.step.integrity", baselineProblems, mutantProblems });
    }
    case "npm.contract.release": {
      const npmContractProblems = adapters?.npmContractProblems;
      if (npmContractProblems === undefined) {
        throw new errorConstructor("npm.contract.release invocation requires exact release oracle adapters");
      }
      const baseline = materializeOracleValue(invocation.baseline, sourceValues, prepared);
      const mutant = materializeOracleValue(invocation.mutant, sourceValues, prepared);
      const integrity = materializeOracleValue(invocation.integrity, sourceValues, prepared);
      if (baseline === mutant) {
        throw new errorConstructor("npm.contract.release clean baseline must differ from its mutant");
      }

      const baselineResult: unknown = applyFunction(npmContractProblems, undefined, [baseline, integrity]);
      assertAmbientIntrinsics();
      const baselineProblems = snapshotOracleProblems(
        baselineResult,
        "npm.contract.release",
        "baseline",
        NPM_PROVENANCE_CONTRACT_PROBLEM
      );
      assertAmbientIntrinsics();
      const mutantResult: unknown = applyFunction(npmContractProblems, undefined, [mutant, integrity]);
      assertAmbientIntrinsics();
      const mutantProblems = snapshotOracleProblems(
        mutantResult,
        "npm.contract.release",
        "mutant",
        NPM_PROVENANCE_CONTRACT_PROBLEM
      );
      assertAmbientIntrinsics();
      return freezeObject({ kind: "npm.contract.release", baselineProblems, mutantProblems });
    }
    case "npm.contract.integrity": {
      const npmContractProblems = adapters?.npmContractProblems;
      if (npmContractProblems === undefined) {
        throw new errorConstructor("npm.contract.integrity invocation requires exact release oracle adapters");
      }
      const release = materializeOracleValue(invocation.release, sourceValues, prepared);
      const baseline = materializeOracleValue(invocation.baseline, sourceValues, prepared);
      const mutant = materializeOracleValue(invocation.mutant, sourceValues, prepared);
      if (baseline === mutant) {
        throw new errorConstructor("npm.contract.integrity clean baseline must differ from its mutant");
      }

      const baselineResult: unknown = applyFunction(npmContractProblems, undefined, [release, baseline]);
      assertAmbientIntrinsics();
      const baselineProblems = snapshotOracleProblems(
        baselineResult,
        "npm.contract.integrity",
        "baseline",
        NPM_PROVENANCE_CONTRACT_PROBLEM
      );
      assertAmbientIntrinsics();
      const mutantResult: unknown = applyFunction(npmContractProblems, undefined, [release, mutant]);
      assertAmbientIntrinsics();
      const mutantProblems = snapshotOracleProblems(
        mutantResult,
        "npm.contract.integrity",
        "mutant",
        NPM_PROVENANCE_CONTRACT_PROBLEM
      );
      assertAmbientIntrinsics();
      return freezeObject({ kind: "npm.contract.integrity", baselineProblems, mutantProblems });
    }
    default:
      return assertNever(invocation);
  }
}

function expectationSemanticIdentity(expectation: ReleaseExpectation): string {
  switch (expectation.kind) {
    case "problem":
      return `${expectation.kind}\u0000${expectation.problem}`;
    case "equal":
    case "not-equal":
      return `${expectation.kind}\u0000${expectation.value}`;
    case "regex":
      return `${expectation.kind}\u0000${expectation.regex}`;
    default:
      return assertNever(expectation);
  }
}

function sameOracleInvocation(left: ReleaseOracleInvocation, right: ReleaseOracleInvocation): boolean {
  if (left.kind !== right.kind || left.baseline !== right.baseline || left.mutant !== right.mutant) return false;
  switch (left.kind) {
    case "fixture.throw":
      return right.kind === "fixture.throw" && left.message === right.message;
    case "fixture.text":
      return right.kind === "fixture.text";
    case "registry.evaluator":
      return right.kind === "registry.evaluator";
    case "registry.step.run":
      return right.kind === "registry.step.run" && left.integrity === right.integrity;
    case "registry.step.integrity":
      return right.kind === "registry.step.integrity" && left.run === right.run;
    case "npm.contract.release":
      return right.kind === "npm.contract.release" && left.integrity === right.integrity;
    case "npm.contract.integrity":
      return right.kind === "npm.contract.integrity" && left.release === right.release;
    default:
      return assertNever(left);
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    try {
      const descriptor = getOwnPropertyDescriptorsIntrinsic(error).message;
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") {
        return descriptor.value;
      }
    } catch {
      return "uninspectable thrown value";
    }
  }
  return stringConstructor(error);
}

/**
 * Closed, two-phase planner for the release-integrity mutation matrix.
 *
 * Registration is open-only. `seal()` validates and internally materializes the complete mutation
 * graph without executing a case. `execute()` runs every ordered check. `executeThrough()` instead
 * validates and pins the exact adapter set for the complete sealed graph before the first detector,
 * runs an inclusive case-root prefix, and leaves `executeRemaining()` to consume the pinned suffix.
 * Handles carry no public id or value.
 *
 * @example
 * const plan = new ReleaseMutationPlan({ total: 1, first: 1, all: 0 });
 * const source = plan.registerSource("fixture.source", "alpha");
 * const mutation = plan.registerMutation("fixture.alpha-to-omega", {
 *   mode: "first",
 *   source,
 *   needle: "alpha",
 *   replacement: "omega",
 *   expectedOccurrences: 1,
 *   witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
 * });
 * plan.registerCase({
 *   id: "fixture.detects-omega",
 *   root: mutation,
 *   checks: [{
 *     invoke: { kind: "fixture.text", baseline: source, mutant: mutation },
 *     expectation: { id: "fixture.equals-omega", kind: "equal", value: "omega" }
 *   }]
 * });
 */
export class ReleaseMutationPlan {
  readonly #owner = freezeObject({});
  readonly #sources: RegisteredSource[] = [];
  readonly #mutations: RegisteredMutation[] = [];
  readonly #cases: RegisteredCase[] = [];
  readonly #sourceValues = new mapConstructor<ReleaseSourceHandle, string>();
  readonly #prepared = new mapConstructor<ReleaseMutationHandle, PreparedMutation>();
  readonly #preparedCases: PreparedCase[] = [];
  readonly #problems: string[] = [];
  readonly #expectedInventory: unknown;
  #state: ReleaseMutationPlanState = "open";
  #registrationActive = false;
  #nextCaseIndex = 0;
  #stagedExecution: StagedExecution | undefined;
  #executedCases = 0;
  #executedExpectations = 0;

  /**
   * Create a planner, optionally pinning the mutation modes or complete graph topology.
   *
   * @param expectedInventory - Exact mutation-only or complete-topology totals, or undefined for a focused fixture.
   */
  constructor(expectedInventory?: ReleaseMutationInventoryExpectation) {
    assertAmbientIntrinsics();
    this.#expectedInventory =
      expectedInventory === undefined
        ? undefined
        : snapshotPlainData(expectedInventory, "inventory", (code, path, detail) => {
            this.#addProblem(code, "plan", `${path}: ${detail}`);
          });
    assertAmbientIntrinsics();
    sealObject(this);
  }

  /** @returns Current lifecycle state, exposed for invariant controls. */
  get phase(): ReleaseMutationPlanState {
    return this.#state;
  }

  /** @returns Number of cases whose first ordered check began execution. */
  get caseExecutions(): number {
    return this.#executedCases;
  }

  /** @returns Number of ordered checks whose single expectation evaluation began. */
  get expectationExecutions(): number {
    return this.#executedExpectations;
  }

  /** @returns Stable aggregate diagnostics produced by registration and the last seal attempt. */
  get diagnostics(): readonly string[] {
    return [...this.#problems];
  }

  /**
   * Register one canonical named source.
   *
   * @param id - Stable source identity.
   * @param value - Exact source bytes used by descriptors.
   * @returns An opaque plan-owned source handle.
   * @throws If registration has already closed.
   */
  registerSource(id: string, value: string): ReleaseSourceHandle {
    this.#requireOpen("register source");
    this.#registrationActive = true;
    try {
      const rawId: unknown = id;
      const rawValue: unknown = value;
      const displayId = displayIdentity(rawId, `<source-${this.#sources.length + 1}>`);
      const handle = createHandle<ReleaseSourceHandle>(this.#owner, "source", displayId);
      const snapshot = snapshotPlainData(rawValue, `source ${displayId}`, (code, path, detail) => {
        this.#addProblem(code, displayId, `${path}: ${detail}`);
      });
      pushArrayValue(this.#sources, { handle, id: rawId, value: snapshot });
      return handle;
    } finally {
      this.#registrationActive = false;
      assertAmbientIntrinsics();
    }
  }

  /**
   * Register one named mutation descriptor.
   *
   * @param id - Stable mutation identity.
   * @param registration - Literal mutation and its bounded positive witness.
   * @returns An opaque plan-owned mutation handle.
   * @throws If registration has already closed.
   */
  registerMutation(id: string, registration: ReleaseMutationRegistration): ReleaseMutationHandle {
    this.#requireOpen("register mutation");
    this.#registrationActive = true;
    try {
      const rawId: unknown = id;
      const displayId = displayIdentity(rawId, `<mutation-${this.#mutations.length + 1}>`);
      const handle = createHandle<ReleaseMutationHandle>(this.#owner, "mutation", displayId);
      const snapshot = snapshotPlainData(registration, `mutation ${displayId}`, (code, path, detail) => {
        this.#addProblem(code, displayId, `${path}: ${detail}`);
      });
      pushArrayValue(this.#mutations, { handle, id: rawId, registration: snapshot });
      return handle;
    } finally {
      this.#registrationActive = false;
      assertAmbientIntrinsics();
    }
  }

  /**
   * Register one closed data-only oracle case.
   *
   * @param registration - Named root and non-empty ordered inventory of closed invocation/expectation checks.
   * @returns This plan for fluent case registration.
   * @throws If registration has already closed.
   */
  registerCase(registration: ReleaseMutationCase): this {
    this.#requireOpen("register case");
    this.#registrationActive = true;
    try {
      const caseNumber = this.#cases.length + 1;
      const snapshot = snapshotPlainData(registration, `case ${caseNumber}`, (code, path, detail) => {
        this.#addProblem(code, `<case-${caseNumber}>`, `${path}: ${detail}`);
      });
      pushArrayValue(this.#cases, { registration: snapshot });
      return this;
    } finally {
      this.#registrationActive = false;
      assertAmbientIntrinsics();
    }
  }

  /**
   * Aggregate-preflight the complete graph and seal it only when every diagnostic is clean.
   *
   * @returns Stable diagnostics. An empty array means execution is now permitted.
   * @throws If the plan is not open or validation aborts unexpectedly.
   */
  seal(): readonly string[] {
    this.#requireOpen("seal");
    this.#state = "sealing";
    try {
      this.#validateInventory();
      const sourceValidation = this.#validateSources();
      const mutationRecords = this.#validateMutationIdentities();
      const mutationAnalyses = this.#validateMutationDescriptors(sourceValidation, mutationRecords);
      const caseAnalyses = this.#validateCases(mutationRecords);
      const cyclicMutations = this.#validateCycles(mutationAnalyses);
      this.#prepareMutations(sourceValidation, mutationAnalyses, cyclicMutations);
      const executableRoots = this.#validatePreparedCaseValues(caseAnalyses);
      this.#validateReachability(mutationAnalyses, executableRoots);
      assertAmbientIntrinsics();
      if (this.#problems.length === 0) {
        for (const analysis of caseAnalyses) {
          if (analysis.valid && analysis.root !== null && analysis.checks.length > 0) {
            pushArrayValue(
              this.#preparedCases,
              freezeObject({
                id: analysis.id,
                root: analysis.root,
                checks: freezeObject(
                  analysis.checks.map((check) =>
                    freezeObject({ invocation: check.invocation, expectation: check.expectation })
                  )
                )
              })
            );
          }
        }
      }
      this.#state = this.#problems.length === 0 ? "sealed" : "rejected";
      return this.diagnostics;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  /**
   * Execute every closed case after a clean aggregate seal.
   *
   * @param adapters - Exact execution-only adapters required by production invocation kinds.
   * @returns Nothing. Successful completion moves the plan to `executed`.
   * @throws If preflight was not clean, an invocation throws unexpectedly, or an expectation fails.
   */
  execute(adapters?: ReleaseOracleAdapters): void {
    assertAmbientIntrinsics();
    if (this.#state !== "sealed") {
      throw new errorConstructor(`release mutation plan execute requires sealed state; found ${this.#state}`);
    }
    this.#state = "executing";
    try {
      const requirements = releaseOracleAdapterRequirements(this.#preparedCases);
      const closedAdapters = validateReleaseOracleAdapters(adapters, requirements);
      assertAmbientIntrinsics();
      this.#executePreparedCasesThrough(this.#preparedCases.length, closedAdapters);
      assertAmbientIntrinsics();
      this.#state = "executed";
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  /**
   * Execute an inclusive case-root prefix while atomically pinning all adapters needed by the sealed graph.
   *
   * @param root - Exact plan-owned case root that terminates the prefix.
   * @param adapters - Exact complete adapter set required by every prepared case, including the deferred suffix.
   * @returns Nothing. A remaining suffix moves the plan to `partially-executed`.
   * @throws Before adapter inspection if the boundary is foreign, forged, a source, or dependency-only.
   */
  executeThrough(root: ReleaseMutationHandle, adapters?: ReleaseOracleAdapters): void {
    assertAmbientIntrinsics();
    if (this.#state !== "sealed") {
      throw new errorConstructor(`release mutation plan executeThrough requires sealed state; found ${this.#state}`);
    }
    this.#state = "executing";
    try {
      const boundaryIndex = this.#executionBoundaryIndex(root);
      const requirements = releaseOracleAdapterRequirements(this.#preparedCases);
      const closedAdapters = validateReleaseOracleAdapters(adapters, requirements);
      assertAmbientIntrinsics();
      const stagedExecution = freezeObject({
        adapters: closedAdapters,
        expectedNextCaseIndex: boundaryIndex + 1,
        preparedCaseCount: this.#preparedCases.length
      });
      this.#stagedExecution = stagedExecution;
      this.#executePreparedCasesThrough(boundaryIndex + 1, closedAdapters);
      assertAmbientIntrinsics();
      if (
        this.#stagedExecution !== stagedExecution ||
        this.#nextCaseIndex !== stagedExecution.expectedNextCaseIndex ||
        this.#preparedCases.length !== stagedExecution.preparedCaseCount
      ) {
        throw new errorConstructor("release mutation staged execution capsule drifted during prefix execution");
      }
      if (this.#nextCaseIndex === this.#preparedCases.length) {
        this.#stagedExecution = undefined;
        this.#state = "executed";
      } else {
        this.#state = "partially-executed";
      }
    } catch (error) {
      this.#stagedExecution = undefined;
      this.#state = "failed";
      throw error;
    }
  }

  /**
   * Execute the suffix after a successful `executeThrough()` using only its frozen adapter references.
   *
   * @returns Nothing. Successful completion moves the plan to `executed`.
   * @throws If no prefix is pending, a detector fails, or an expectation fails.
   */
  executeRemaining(): void {
    assertAmbientIntrinsics();
    if (this.#state !== "partially-executed") {
      throw new errorConstructor(
        `release mutation plan executeRemaining requires partially-executed state; found ${this.#state}`
      );
    }
    this.#state = "executing";
    try {
      const stagedExecution = this.#stagedExecution;
      if (
        stagedExecution === undefined ||
        this.#nextCaseIndex !== stagedExecution.expectedNextCaseIndex ||
        this.#preparedCases.length !== stagedExecution.preparedCaseCount
      ) {
        throw new errorConstructor("release mutation executeRemaining requires one intact staged execution capsule");
      }
      this.#executePreparedCasesThrough(stagedExecution.preparedCaseCount, stagedExecution.adapters);
      assertAmbientIntrinsics();
      if (this.#stagedExecution !== stagedExecution || this.#nextCaseIndex !== stagedExecution.preparedCaseCount) {
        throw new errorConstructor("release mutation staged execution capsule drifted during suffix execution");
      }
      this.#stagedExecution = undefined;
      this.#state = "executed";
    } catch (error) {
      this.#stagedExecution = undefined;
      this.#state = "failed";
      throw error;
    }
  }

  #executionBoundaryIndex(value: unknown): number {
    const metadata = handleMetadata(value);
    if (metadata === undefined) {
      throw new errorConstructor(
        "release mutation executeThrough boundary must be an unforgeable plan-owned case root"
      );
    }
    if (metadata.owner !== this.#owner) {
      throw new errorConstructor(
        `release mutation executeThrough boundary uses a foreign-plan ${metadata.kind} handle`
      );
    }
    if (metadata.kind !== "mutation") {
      throw new errorConstructor("release mutation executeThrough boundary must not use a canonical source handle");
    }
    for (let index = 0; index < this.#preparedCases.length; index++) {
      if (this.#preparedCases[index]?.root === value) return index;
    }
    throw new errorConstructor(
      "release mutation executeThrough boundary must be a case root, not a dependency-only mutation"
    );
  }

  #executePreparedCasesThrough(end: number, adapters: ReleaseOracleAdapters | undefined): void {
    for (let caseIndex = this.#nextCaseIndex; caseIndex < end; caseIndex++) {
      const releaseCase = this.#preparedCases[caseIndex];
      if (releaseCase === undefined) {
        throw new errorConstructor(`release mutation prepared case ${caseIndex} is missing`);
      }
      this.#executedCases++;
      for (let checkIndex = 0; checkIndex < releaseCase.checks.length; checkIndex++) {
        const check = releaseCase.checks[checkIndex];
        if (check === undefined) {
          throw new errorConstructor(`release mutation prepared check ${caseIndex}:${checkIndex} is missing`);
        }
        const observation = executeReleaseOracleInvocation(
          check.invocation,
          this.#sourceValues,
          this.#prepared,
          adapters
        );
        this.#executedExpectations++;
        this.#applyExpectation(releaseCase.id, check.expectation, observation);
      }
      this.#nextCaseIndex = caseIndex + 1;
    }
  }

  #requireOpen(action: string): void {
    assertAmbientIntrinsics();
    if (this.#state !== "open") {
      throw new errorConstructor(`cannot ${action} after release mutation plan entered ${this.#state} state`);
    }
    if (this.#registrationActive) {
      throw new errorConstructor(`cannot ${action} during release mutation registration`);
    }
  }

  #addProblem(code: string, id: string, detail: string): void {
    pushArrayValue(this.#problems, `[${code}] ${id}: ${detail}`);
  }

  #validateInventory(): void {
    if (this.#mutations.length === 0) {
      this.#addProblem("inventory.empty", "plan", "plan must register at least one mutation");
    }
    if (this.#expectedInventory === undefined) return;
    const inventory = plainRecord(this.#expectedInventory);
    const mutationKeys = ["total", "first", "all"] as const;
    const topologyKeys = ["total", "first", "all", "cases", "expectations", "roots", "dependencyOnly"] as const;
    const hasMutationInventory = inventory !== null && hasExactKeys(inventory, mutationKeys);
    const hasTopologyInventory = inventory !== null && hasExactKeys(inventory, topologyKeys);
    if (inventory === null || (!hasMutationInventory && !hasTopologyInventory)) {
      this.#addProblem(
        "inventory.invalid",
        "plan",
        "expected inventory must be one exact total/first/all record with either zero or all topology fields"
      );
      return;
    }
    const total = inventory.total;
    const expectedFirst = inventory.first;
    const expectedAll = inventory.all;
    if (
      typeof total !== "number" ||
      !isPositiveSafeInteger(total) ||
      typeof expectedFirst !== "number" ||
      !numberIsSafeIntegerIntrinsic(expectedFirst) ||
      expectedFirst < 0 ||
      typeof expectedAll !== "number" ||
      !numberIsSafeIntegerIntrinsic(expectedAll) ||
      expectedAll < 0 ||
      expectedFirst + expectedAll !== total
    ) {
      this.#addProblem("inventory.invalid", "plan", "expected inventory must be coherent safe integers");
      return;
    }
    const expectedCases = inventory.cases;
    const expectedExpectations = inventory.expectations;
    const expectedRoots = inventory.roots;
    const expectedDependencyOnly = inventory.dependencyOnly;
    if (
      hasTopologyInventory &&
      (typeof expectedCases !== "number" ||
        !isPositiveSafeInteger(expectedCases) ||
        typeof expectedExpectations !== "number" ||
        !isPositiveSafeInteger(expectedExpectations) ||
        typeof expectedRoots !== "number" ||
        !isPositiveSafeInteger(expectedRoots) ||
        typeof expectedDependencyOnly !== "number" ||
        !numberIsSafeIntegerIntrinsic(expectedDependencyOnly) ||
        expectedDependencyOnly < 0 ||
        expectedCases !== expectedRoots ||
        expectedExpectations < expectedCases ||
        expectedRoots + expectedDependencyOnly !== total)
    ) {
      this.#addProblem("inventory.invalid", "plan", "expected topology inventory must be coherent safe integers");
      return;
    }
    let first = 0;
    let all = 0;
    for (const mutation of this.#mutations) {
      const registration = plainRecord(mutation.registration);
      if (registration?.mode === "first") first++;
      if (registration?.mode === "all") all++;
    }
    let cases = 0;
    let expectations = 0;
    const roots = new setConstructor<ReleaseMutationHandle>();
    let rootCount = 0;
    const mutationHandles = new setConstructor(this.#mutations.map((mutation) => mutation.handle));
    for (const registeredCase of this.#cases) {
      cases++;
      const registration = plainRecord(registeredCase.registration);
      if (isArrayIntrinsic(registration?.checks)) expectations += registration.checks.length;
      const root = registration?.root;
      const metadata = handleMetadata(root);
      if (
        metadata?.owner === this.#owner &&
        metadata.kind === "mutation" &&
        mutationHandles.has(root as ReleaseMutationHandle) &&
        !roots.has(root as ReleaseMutationHandle)
      ) {
        roots.add(root as ReleaseMutationHandle);
        rootCount++;
      }
    }
    const dependencyOnly = this.#mutations.length - rootCount;
    const mutationMismatch = this.#mutations.length !== total || first !== expectedFirst || all !== expectedAll;
    const topologyMismatch =
      hasTopologyInventory &&
      (cases !== expectedCases ||
        expectations !== expectedExpectations ||
        rootCount !== expectedRoots ||
        dependencyOnly !== expectedDependencyOnly);
    if (!mutationMismatch && !topologyMismatch) return;
    const expectedMutation = `${total} total (${expectedFirst} first / ${expectedAll} all)`;
    const foundMutation = `${this.#mutations.length} total (${first} first / ${all} all)`;
    const expectedTopology = hasTopologyInventory
      ? `, ${expectedCases} cases / ${expectedExpectations} expectations / ${expectedRoots} roots / ${expectedDependencyOnly} dependency-only`
      : "";
    const foundTopology = hasTopologyInventory
      ? `, ${cases} cases / ${expectations} expectations / ${rootCount} roots / ${dependencyOnly} dependency-only`
      : "";
    this.#addProblem(
      "inventory.mismatch",
      "plan",
      `expected ${expectedMutation}${expectedTopology}, found ${foundMutation}${foundTopology}`
    );
  }

  #validateSources(): SourceValidation {
    const byHandle = new mapConstructor<ReleaseSourceHandle, RegisteredSource>();
    const byId = new mapConstructor<string, RegisteredSource>();
    const invalid = new setConstructor<ReleaseSourceHandle>();
    if (this.#sources.length === 0) {
      this.#addProblem("source.none", "plan", "plan must register at least one canonical source");
    }
    for (const source of this.#sources) {
      byHandle.set(source.handle, source);
      const id = source.id;
      const displayId = handleMetadata(source.handle)?.id ?? "<source>";
      if (typeof id !== "string" || !testRegExp(ID_PATTERN, id)) {
        this.#addProblem("source.id", displayId, "id must be one lowercase token path without repeated separators");
        invalid.add(source.handle);
      } else if (byId.has(id)) {
        this.#addProblem("source.duplicate", id, "source id is registered more than once");
        invalid.add(source.handle);
      } else {
        byId.set(id, source);
      }
      if (typeof source.value !== "string") {
        this.#addProblem("source.type", displayId, "canonical source must be a string");
        invalid.add(source.handle);
      } else if (source.value.length === 0) {
        this.#addProblem("source.empty", displayId, "canonical source must not be empty");
        invalid.add(source.handle);
      } else {
        this.#sourceValues.set(source.handle, source.value);
      }
    }
    return { byHandle, invalid };
  }

  #validateMutationIdentities(): ReadonlyMap<ReleaseMutationHandle, RegisteredMutation> {
    const byHandle = new mapConstructor<ReleaseMutationHandle, RegisteredMutation>();
    const byId = new mapConstructor<string, RegisteredMutation>();
    for (const mutation of this.#mutations) {
      byHandle.set(mutation.handle, mutation);
      const id = mutation.id;
      const displayId = handleMetadata(mutation.handle)?.id ?? "<mutation>";
      if (typeof id !== "string" || !testRegExp(ID_PATTERN, id)) {
        this.#addProblem("mutation.id", displayId, "id must be one lowercase token path without repeated separators");
      } else if (byId.has(id)) {
        this.#addProblem("mutation.duplicate", id, "mutation id is registered more than once");
      } else {
        byId.set(id, mutation);
      }
    }
    return byHandle;
  }

  #validateMutationDescriptors(
    sources: SourceValidation,
    mutations: ReadonlyMap<ReleaseMutationHandle, RegisteredMutation>
  ): ReadonlyMap<ReleaseMutationHandle, MutationAnalysis> {
    const analyses = new mapConstructor<ReleaseMutationHandle, MutationAnalysis>();
    for (const mutation of this.#mutations) {
      const id = handleMetadata(mutation.handle)?.id ?? "<mutation>";
      const registration = plainRecord(mutation.registration);
      let valid = true;
      if (
        registration === null ||
        !hasExactKeys(registration, ["mode", "source", "needle", "replacement", "expectedOccurrences", "witness"])
      ) {
        this.#addProblem("mutation.shape", id, "registration must contain only the six declared mutation fields");
        valid = false;
      }

      const mode = registration?.mode === "first" || registration?.mode === "all" ? registration.mode : null;
      if (mode === null) {
        this.#addProblem("mutation.mode", id, "mode must be first or all");
        valid = false;
      }

      const source = this.#validateValueHandle(registration?.source, id, "source", sources.byHandle, mutations);
      if (source === null) valid = false;

      const needle = typeof registration?.needle === "string" ? registration.needle : null;
      if (needle === null) {
        this.#addProblem("mutation.needle", id, "needle must be a string");
        valid = false;
      } else if (needle.length === 0) {
        this.#addProblem("mutation.needle", id, "needle must not be empty");
        valid = false;
      }

      let replacement: string | ReleaseMutationHandle | null = null;
      if (typeof registration?.replacement === "string") {
        replacement = registration.replacement;
      } else {
        replacement = this.#validateMutationHandle(registration?.replacement, id, "replacement", mutations);
        if (replacement === null) valid = false;
      }

      const expectedOccurrences =
        typeof registration?.expectedOccurrences === "number" ? registration.expectedOccurrences : null;
      if (expectedOccurrences === null || !isPositiveSafeInteger(expectedOccurrences)) {
        this.#addProblem("mutation.count", id, "expectedOccurrences must be a positive safe integer");
        valid = false;
      }

      const witnessRecord = plainRecord(registration?.witness);
      let witness: ReleaseMutationWitness | null = null;
      if (witnessRecord === null || !hasExactKeys(witnessRecord, ["kind", "anchor", "before", "after"])) {
        this.#addProblem("witness.shape", id, "witness must contain only kind/anchor/before/after");
        valid = false;
      } else {
        const kind = witnessRecord.kind;
        const anchor = witnessRecord.anchor;
        const before = witnessRecord.before;
        const after = witnessRecord.after;
        let witnessValid = true;
        if (kind !== "token" && kind !== "line") {
          this.#addProblem("witness.kind", id, "positive witness kind must be token or line");
          witnessValid = false;
        }
        if (typeof anchor !== "string" || anchor.length === 0) {
          this.#addProblem("witness.anchor", id, "positive witness anchor must be a non-empty string");
          witnessValid = false;
        }
        if (
          typeof before !== "number" ||
          !numberIsSafeIntegerIntrinsic(before) ||
          before < 0 ||
          typeof after !== "number" ||
          !numberIsSafeIntegerIntrinsic(after) ||
          after < 0 ||
          before === after
        ) {
          this.#addProblem("witness.count", id, "witness counts must be different non-negative safe integers");
          witnessValid = false;
        }
        if (witnessValid) {
          witness = freezeObject({
            kind: kind as ReleaseMutationWitness["kind"],
            anchor: anchor as string,
            before: before as number,
            after: after as number
          });
        } else {
          valid = false;
        }
      }

      if (
        source !== null &&
        handleMetadata(source)?.kind === "source" &&
        sources.invalid.has(source as ReleaseSourceHandle)
      ) {
        this.#addProblem("mutation.blocked", id, "source handle refers to an invalid canonical source");
        valid = false;
      }

      analyses.set(mutation.handle, {
        id,
        mode,
        source,
        needle,
        replacement,
        expectedOccurrences,
        witness,
        unpreparable: !valid
      });
    }
    return analyses;
  }

  #validateValueHandle(
    value: unknown,
    id: string,
    field: string,
    sources: ReadonlyMap<ReleaseSourceHandle, RegisteredSource>,
    mutations: ReadonlyMap<ReleaseMutationHandle, RegisteredMutation>
  ): ReleaseSourceHandle | ReleaseMutationHandle | null {
    const metadata = handleMetadata(value);
    if (metadata === undefined) {
      this.#addProblem("dependency.handle", id, `${field} must be an unforgeable plan-owned handle`);
      return null;
    }
    if (metadata.owner !== this.#owner) {
      this.#addProblem("dependency.handle", id, `${field} uses a foreign-plan ${metadata.kind} handle`);
      return null;
    }
    if (metadata.kind === "source") {
      const handle = value as ReleaseSourceHandle;
      if (!sources.has(handle)) {
        this.#addProblem("dependency.source", id, `${field} refers to an unknown source handle`);
        return null;
      }
      return handle;
    }
    const handle = value as ReleaseMutationHandle;
    if (!mutations.has(handle)) {
      this.#addProblem("dependency.mutation", id, `${field} refers to an unknown mutation handle`);
      return null;
    }
    return handle;
  }

  #validateMutationHandle(
    value: unknown,
    id: string,
    field: string,
    mutations: ReadonlyMap<ReleaseMutationHandle, RegisteredMutation>
  ): ReleaseMutationHandle | null {
    const metadata = handleMetadata(value);
    if (metadata === undefined) {
      this.#addProblem("dependency.handle", id, `${field} must be an unforgeable plan-owned mutation handle`);
      return null;
    }
    if (metadata.owner !== this.#owner) {
      this.#addProblem("dependency.handle", id, `${field} uses a foreign-plan ${metadata.kind} handle`);
      return null;
    }
    if (metadata.kind !== "mutation") {
      this.#addProblem("dependency.kind", id, `${field} must be a mutation handle, found source handle`);
      return null;
    }
    const handle = value as ReleaseMutationHandle;
    if (!mutations.has(handle)) {
      this.#addProblem("dependency.mutation", id, `${field} refers to an unknown mutation handle`);
      return null;
    }
    return handle;
  }

  #validateCases(mutations: ReadonlyMap<ReleaseMutationHandle, RegisteredMutation>): readonly CaseAnalysis[] {
    const analyses: CaseAnalysis[] = [];
    const caseIds = new setConstructor<string>();
    const expectationIds = new setConstructor<string>();
    const rootedBy = new mapConstructor<ReleaseMutationHandle, string>();
    if (this.#cases.length === 0) {
      this.#addProblem("case.none", "plan", "plan must register at least one closed case");
    }
    for (const [caseIndex, registered] of this.#cases.entries()) {
      const registration = plainRecord(registered.registration);
      const fallbackId = `<case-${caseIndex + 1}>`;
      const rawId = registration?.id;
      const id = displayIdentity(rawId, fallbackId);
      let valid = true;
      if (registration === null || !hasExactKeys(registration, ["id", "root", "checks"])) {
        this.#addProblem("case.shape", id, "case must contain only id/root/checks");
        valid = false;
      }
      if (typeof rawId !== "string" || !testRegExp(ID_PATTERN, rawId)) {
        this.#addProblem("case.id", id, "id must be one lowercase token path without repeated separators");
        valid = false;
      } else if (caseIds.has(rawId)) {
        this.#addProblem("case.duplicate", rawId, "case id is registered more than once");
        valid = false;
      } else {
        caseIds.add(rawId);
      }

      const root = this.#validateCaseRoot(registration?.root, id, "root", mutations);
      if (root === null) {
        valid = false;
      } else {
        const previous = rootedBy.get(root);
        if (previous !== undefined) {
          this.#addProblem("case.root", id, `mutation root is already owned by case ${previous}`);
          valid = false;
        } else {
          rootedBy.set(root, id);
        }
      }

      const checksValue = registration?.checks;
      const checks: PreparedCheck[] = [];
      if (!isArrayIntrinsic(checksValue) || checksValue.length === 0) {
        this.#addProblem("expectation.none", id, "case must register at least one expectation");
        valid = false;
      } else {
        for (const [checkIndex, value] of checksValue.entries()) {
          const check = plainRecord(value);
          if (check === null || !hasExactKeys(check, ["invoke", "expectation"])) {
            this.#addProblem("check.shape", id, `check ${checkIndex + 1} must contain only invoke/expectation`);
            valid = false;
          }

          const invocation = this.#validateCaseInvocation(check?.invoke, id, root, mutations);
          const expectation = this.#validateExpectation(check?.expectation, id, checkIndex, expectationIds);
          if (invocation.invocation === null || expectation === null) {
            valid = false;
          } else {
            const closedInvocation = invocation.invocation;
            switch (closedInvocation.kind) {
              case "fixture.text":
                if (expectation.kind === "problem") {
                  this.#addProblem("expectation.type", id, "fixture.text requires value expectations");
                  valid = false;
                }
                break;
              case "fixture.throw":
                if (expectation.kind !== "problem") {
                  this.#addProblem("expectation.type", id, "fixture.throw requires exact problem expectations");
                  valid = false;
                } else if (expectation.problem !== "fixture.mutant-threw") {
                  this.#addProblem(
                    "expectation.problem",
                    id,
                    "fixture.throw requires its exact fixture problem identity"
                  );
                  valid = false;
                }
                break;
              case "registry.evaluator":
                if (expectation.kind !== "problem") {
                  this.#addProblem("expectation.type", id, "registry.evaluator requires exact problem expectations");
                  valid = false;
                } else if (expectation.problem !== MCP_REGISTRY_EVALUATOR_PROBLEM) {
                  this.#addProblem(
                    "expectation.problem",
                    id,
                    "registry.evaluator requires its exact MCP Registry problem identity"
                  );
                  valid = false;
                }
                break;
              case "registry.step.run":
              case "registry.step.integrity":
                if (expectation.kind !== "problem") {
                  this.#addProblem(
                    "expectation.type",
                    id,
                    `${closedInvocation.kind} requires exact problem expectations`
                  );
                  valid = false;
                } else if (expectation.problem !== MCP_REGISTRY_WORKFLOW_PROBLEM) {
                  this.#addProblem(
                    "expectation.problem",
                    id,
                    `${closedInvocation.kind} requires its exact MCP Registry workflow problem identity`
                  );
                  valid = false;
                }
                break;
              case "npm.contract.release":
              case "npm.contract.integrity":
                if (expectation.kind !== "problem") {
                  this.#addProblem(
                    "expectation.type",
                    id,
                    `${closedInvocation.kind} requires exact problem expectations`
                  );
                  valid = false;
                } else if (expectation.problem !== NPM_PROVENANCE_CONTRACT_PROBLEM) {
                  this.#addProblem(
                    "expectation.problem",
                    id,
                    `${closedInvocation.kind} requires its exact npm provenance problem identity`
                  );
                  valid = false;
                }
                break;
              default:
                assertNever(closedInvocation);
            }

            const semanticIdentity = expectationSemanticIdentity(expectation);
            if (
              checks.some(
                (preparedCheck) =>
                  sameOracleInvocation(preparedCheck.invocation, closedInvocation) &&
                  expectationSemanticIdentity(preparedCheck.expectation) === semanticIdentity
              )
            ) {
              this.#addProblem(
                "expectation.redundant",
                id,
                `expectation ${expectation.id} duplicates another expectation in the same case`
              );
              valid = false;
            }
            pushArrayValue(checks, freezeObject({ invocation: closedInvocation, expectation }));
          }
        }
      }
      pushArrayValue(analyses, {
        id,
        root,
        checks: freezeObject(checks),
        valid
      });
    }
    return analyses;
  }

  #validateCaseInvocation(
    value: unknown,
    id: string,
    root: ReleaseMutationHandle | null,
    mutations: ReadonlyMap<ReleaseMutationHandle, RegisteredMutation>
  ): InvocationAnalysis {
    const invocation = plainRecord(value);
    const kind =
      invocation?.kind === "fixture.text" ||
      invocation?.kind === "fixture.throw" ||
      invocation?.kind === "registry.evaluator" ||
      invocation?.kind === "registry.step.run" ||
      invocation?.kind === "registry.step.integrity" ||
      invocation?.kind === "npm.contract.release" ||
      invocation?.kind === "npm.contract.integrity"
        ? invocation.kind
        : null;
    let valid = true;
    if (kind === null) {
      this.#addProblem(
        "invocation.kind",
        id,
        "invocation kind must be fixture.text, fixture.throw, registry.evaluator, registry.step.run, " +
          "registry.step.integrity, npm.contract.release, or npm.contract.integrity"
      );
      valid = false;
    } else {
      let expectedKeys: readonly string[] = ["kind", "baseline", "mutant"];
      if (kind === "fixture.throw") expectedKeys = ["kind", "baseline", "mutant", "message"];
      else if (kind === "registry.step.run") expectedKeys = ["kind", "baseline", "mutant", "integrity"];
      else if (kind === "registry.step.integrity") expectedKeys = ["kind", "baseline", "mutant", "run"];
      else if (kind === "npm.contract.release") expectedKeys = ["kind", "baseline", "mutant", "integrity"];
      else if (kind === "npm.contract.integrity") expectedKeys = ["kind", "baseline", "mutant", "release"];
      if (invocation === null || !hasExactKeys(invocation, expectedKeys)) {
        this.#addProblem("invocation.shape", id, `${kind} invocation has unexpected or missing fields`);
        valid = false;
      }
    }

    const invocationRoot = this.#validateCaseRoot(invocation?.mutant, id, "invocation mutant", mutations);
    if (invocationRoot === null) {
      valid = false;
    } else if (root !== null && invocationRoot !== root) {
      this.#addProblem("case.root", id, "invocation must contain the case's exact explicit root handle");
      valid = false;
    }
    const baseline = this.#validateCaseBaseline(invocation?.baseline, id, mutations);
    if (baseline === null) {
      valid = false;
    } else if (root !== null) {
      if (baseline === root) {
        this.#addProblem("case.baseline", id, "clean baseline must not be the mutant root handle");
        valid = false;
      } else if (!this.#rootBaselineClosure(root, mutations).has(baseline)) {
        this.#addProblem("case.baseline", id, "clean baseline must belong to the root source lineage");
        valid = false;
      }
    }

    const integrity =
      kind === "registry.step.run" || kind === "npm.contract.release"
        ? this.#validateCaseCompanionSource(invocation?.integrity, id, "integrity")
        : null;
    if ((kind === "registry.step.run" || kind === "npm.contract.release") && integrity === null) valid = false;
    const run =
      kind === "registry.step.integrity" ? this.#validateCaseCompanionSource(invocation?.run, id, "run") : null;
    if (kind === "registry.step.integrity" && run === null) valid = false;
    const release =
      kind === "npm.contract.integrity" ? this.#validateCaseCompanionSource(invocation?.release, id, "release") : null;
    if (kind === "npm.contract.integrity" && release === null) valid = false;

    let message: string | null = null;
    if (kind === "fixture.throw") {
      if (typeof invocation?.message !== "string" || invocation.message.length === 0) {
        this.#addProblem("invocation.message", id, "fixture.throw message must be a non-empty string");
        valid = false;
      } else {
        message = invocation.message;
      }
    }

    let closedInvocation: ReleaseOracleInvocation | null = null;
    if (valid && baseline !== null && invocationRoot !== null && kind === "fixture.text") {
      closedInvocation = freezeObject({ kind, baseline, mutant: invocationRoot });
    } else if (valid && baseline !== null && invocationRoot !== null && kind === "fixture.throw" && message !== null) {
      closedInvocation = freezeObject({ kind, baseline, mutant: invocationRoot, message });
    } else if (valid && baseline !== null && invocationRoot !== null && kind === "registry.evaluator") {
      closedInvocation = freezeObject({ kind, baseline, mutant: invocationRoot });
    } else if (
      valid &&
      baseline !== null &&
      invocationRoot !== null &&
      kind === "registry.step.run" &&
      integrity !== null
    ) {
      closedInvocation = freezeObject({ kind, baseline, mutant: invocationRoot, integrity });
    } else if (
      valid &&
      baseline !== null &&
      invocationRoot !== null &&
      kind === "registry.step.integrity" &&
      run !== null
    ) {
      closedInvocation = freezeObject({ kind, baseline, mutant: invocationRoot, run });
    } else if (
      valid &&
      baseline !== null &&
      invocationRoot !== null &&
      kind === "npm.contract.release" &&
      integrity !== null
    ) {
      closedInvocation = freezeObject({ kind, baseline, mutant: invocationRoot, integrity });
    } else if (
      valid &&
      baseline !== null &&
      invocationRoot !== null &&
      kind === "npm.contract.integrity" &&
      release !== null
    ) {
      closedInvocation = freezeObject({ kind, baseline, mutant: invocationRoot, release });
    }
    return freezeObject({ kind, invocation: closedInvocation });
  }

  #validateCaseRoot(
    value: unknown,
    id: string,
    field: string,
    mutations: ReadonlyMap<ReleaseMutationHandle, RegisteredMutation>
  ): ReleaseMutationHandle | null {
    const metadata = handleMetadata(value);
    if (metadata === undefined) {
      this.#addProblem("case.root", id, `${field} must be an unforgeable plan-owned mutation handle`);
      return null;
    }
    if (metadata.owner !== this.#owner) {
      this.#addProblem("case.root", id, `${field} uses a foreign-plan ${metadata.kind} handle`);
      return null;
    }
    if (metadata.kind !== "mutation") {
      this.#addProblem("case.root", id, `${field} must not use a canonical source handle`);
      return null;
    }
    const handle = value as ReleaseMutationHandle;
    if (!mutations.has(handle)) {
      this.#addProblem("case.root", id, `${field} refers to an unknown mutation handle`);
      return null;
    }
    return handle;
  }

  #validateCaseBaseline(
    value: unknown,
    id: string,
    mutations: ReadonlyMap<ReleaseMutationHandle, RegisteredMutation>
  ): ReleaseSourceHandle | ReleaseMutationHandle | null {
    const metadata = handleMetadata(value);
    if (metadata === undefined) {
      this.#addProblem("case.baseline", id, "baseline must be an unforgeable plan-owned source or mutation handle");
      return null;
    }
    if (metadata.owner !== this.#owner) {
      this.#addProblem("case.baseline", id, `baseline uses a foreign-plan ${metadata.kind} handle`);
      return null;
    }
    if (metadata.kind === "source") {
      const handle = value as ReleaseSourceHandle;
      if (!this.#sources.some((source) => source.handle === handle)) {
        this.#addProblem("case.baseline", id, "baseline refers to an unknown source handle");
        return null;
      }
      return handle;
    }
    const handle = value as ReleaseMutationHandle;
    if (!mutations.has(handle)) {
      this.#addProblem("case.baseline", id, "baseline refers to an unknown mutation handle");
      return null;
    }
    return handle;
  }

  #validateCaseCompanionSource(value: unknown, id: string, field: string): ReleaseSourceHandle | null {
    const metadata = handleMetadata(value);
    if (metadata === undefined) {
      this.#addProblem(
        "invocation.companion",
        id,
        `${field} must be an unforgeable plan-owned canonical source handle`
      );
      return null;
    }
    if (metadata.owner !== this.#owner) {
      this.#addProblem("invocation.companion", id, `${field} uses a foreign-plan ${metadata.kind} handle`);
      return null;
    }
    if (metadata.kind !== "source") {
      this.#addProblem("invocation.companion", id, `${field} must be a canonical source handle, found mutation handle`);
      return null;
    }
    const handle = value as ReleaseSourceHandle;
    if (!this.#sources.some((source) => source.handle === handle)) {
      this.#addProblem("invocation.companion", id, `${field} refers to an unknown canonical source handle`);
      return null;
    }
    return handle;
  }

  #rootBaselineClosure(
    root: ReleaseMutationHandle,
    mutations: ReadonlyMap<ReleaseMutationHandle, RegisteredMutation>
  ): ReadonlySet<ReleaseSourceHandle | ReleaseMutationHandle> {
    const closure = new setConstructor<ReleaseSourceHandle | ReleaseMutationHandle>();
    const visiting = new setConstructor<ReleaseMutationHandle>();
    const visit = (handle: ReleaseMutationHandle): void => {
      if (visiting.has(handle)) return;
      visiting.add(handle);
      const registration = plainRecord(mutations.get(handle)?.registration);
      const source = registration?.source;
      const sourceMetadata = handleMetadata(source);
      if (sourceMetadata?.owner === this.#owner) {
        if (sourceMetadata.kind === "source") {
          closure.add(source as ReleaseSourceHandle);
        } else {
          const sourceMutation = source as ReleaseMutationHandle;
          closure.add(sourceMutation);
          visit(sourceMutation);
        }
      }
    };
    visit(root);
    closure.delete(root);
    return closure;
  }

  #validateExpectation(value: unknown, caseId: string, index: number, ids: Set<string>): PreparedExpectation | null {
    const expectation = plainRecord(value);
    const rawId = expectation?.id;
    const id = displayIdentity(rawId, `<expectation-${index + 1}>`);
    let valid = true;
    if (containsHandle(value)) {
      this.#addProblem("expectation.handle", caseId, `${id} must not contain a source or mutation handle`);
      valid = false;
    }
    if (typeof rawId !== "string" || !testRegExp(ID_PATTERN, rawId)) {
      this.#addProblem("expectation.id", caseId, `${id} must be one lowercase token path without repeated separators`);
      valid = false;
    } else if (ids.has(rawId)) {
      this.#addProblem("expectation.duplicate", caseId, `expectation id ${rawId} is registered more than once`);
      valid = false;
    } else {
      ids.add(rawId);
    }

    const kind = expectation?.kind;
    if (kind !== "problem" && kind !== "equal" && kind !== "not-equal" && kind !== "regex") {
      this.#addProblem("expectation.kind", caseId, `${id} has an unknown expectation kind`);
      return null;
    }

    if (kind === "problem") {
      if (expectation === null || !hasExactKeys(expectation, ["id", "kind", "problem"])) {
        this.#addProblem("expectation.shape", caseId, `${id} has unexpected or missing fields`);
        valid = false;
      }
      if (
        expectation?.problem !== "fixture.mutant-threw" &&
        expectation?.problem !== MCP_REGISTRY_EVALUATOR_PROBLEM &&
        expectation?.problem !== MCP_REGISTRY_WORKFLOW_PROBLEM &&
        expectation?.problem !== NPM_PROVENANCE_CONTRACT_PROBLEM
      ) {
        this.#addProblem("expectation.problem", caseId, `${id} has an unknown exact problem identity`);
        valid = false;
      }
      return valid
        ? freezeObject({ id: rawId as string, kind, problem: expectation?.problem as ReleaseProblemIdentity })
        : null;
    }

    if (kind === "equal" || kind === "not-equal") {
      if (expectation === null || !hasExactKeys(expectation, ["id", "kind", "value"])) {
        this.#addProblem("expectation.shape", caseId, `${id} has unexpected or missing fields`);
        valid = false;
      }
      if (handleMetadata(expectation?.value) !== undefined) {
        this.#addProblem("expectation.handle", caseId, `${id} must not contain a source or mutation handle`);
        valid = false;
      }
      if (typeof expectation?.value !== "string") {
        this.#addProblem("expectation.value", caseId, `${id} value must be a string`);
        valid = false;
      }
      return valid ? freezeObject({ id: rawId as string, kind, value: expectation?.value as string }) : null;
    }

    if (expectation === null || !hasExactKeys(expectation, ["id", "kind", "regex"])) {
      this.#addProblem("expectation.shape", caseId, `${id} has unexpected or missing fields`);
      valid = false;
    }
    if (expectation?.regex !== "fixture.omega-token") {
      this.#addProblem("expectation.regex", caseId, `${id} has an unknown named regex identity`);
      valid = false;
    }
    return valid
      ? freezeObject({ id: rawId as string, kind, regex: expectation?.regex as ReleaseNamedRegexIdentity })
      : null;
  }

  #validateCycles(mutations: ReadonlyMap<ReleaseMutationHandle, MutationAnalysis>): ReadonlySet<ReleaseMutationHandle> {
    const visiting = new setConstructor<ReleaseMutationHandle>();
    const visited = new setConstructor<ReleaseMutationHandle>();
    const cyclic = new setConstructor<ReleaseMutationHandle>();
    const visit = (handle: ReleaseMutationHandle, path: readonly ReleaseMutationHandle[]): void => {
      if (visited.has(handle)) return;
      if (visiting.has(handle)) {
        const cycleStart = path.indexOf(handle);
        const cycle = cycleStart === -1 ? [...path, handle] : [...path.slice(cycleStart), handle];
        for (const cycleHandle of cycle) cyclic.add(cycleHandle);
        const names = cycle.map((cycleHandle) => mutations.get(cycleHandle)?.id ?? "<mutation>");
        this.#addProblem("dependency.cycle", mutations.get(handle)?.id ?? "<mutation>", `cycle ${names.join(" -> ")}`);
        return;
      }
      const mutation = mutations.get(handle);
      if (mutation === undefined) return;
      visiting.add(handle);
      for (const dependency of this.#mutationDependencies(mutation)) visit(dependency, [...path, handle]);
      visiting.delete(handle);
      visited.add(handle);
    };
    for (const handle of mutations.keys()) visit(handle, []);
    return cyclic;
  }

  #mutationDependencies(mutation: MutationAnalysis): readonly ReleaseMutationHandle[] {
    const dependencies: ReleaseMutationHandle[] = [];
    if (mutation.source !== null && handleMetadata(mutation.source)?.kind === "mutation") {
      pushArrayValue(dependencies, mutation.source as ReleaseMutationHandle);
    }
    if (mutation.replacement !== null && typeof mutation.replacement !== "string") {
      pushArrayValue(dependencies, mutation.replacement);
    }
    return dependencies;
  }

  #prepareMutations(
    sources: SourceValidation,
    mutations: ReadonlyMap<ReleaseMutationHandle, MutationAnalysis>,
    cyclic: ReadonlySet<ReleaseMutationHandle>
  ): void {
    const preparing = new setConstructor<ReleaseMutationHandle>();
    const failed = new setConstructor<ReleaseMutationHandle>(cyclic);
    for (const [handle, mutation] of mutations) {
      if (mutation.unpreparable) failed.add(handle);
    }

    const prepare = (handle: ReleaseMutationHandle): PreparedMutation | null => {
      const alreadyPrepared = this.#prepared.get(handle);
      if (alreadyPrepared !== undefined) return alreadyPrepared;
      if (failed.has(handle) || preparing.has(handle)) return null;
      const mutation = mutations.get(handle);
      if (
        mutation === undefined ||
        mutation.mode === null ||
        mutation.source === null ||
        mutation.needle === null ||
        mutation.replacement === null ||
        mutation.expectedOccurrences === null ||
        mutation.witness === null
      ) {
        failed.add(handle);
        return null;
      }
      preparing.add(handle);

      let source: string | undefined;
      const sourceMetadata = handleMetadata(mutation.source);
      if (sourceMetadata?.kind === "source") {
        const sourceRecord = sources.byHandle.get(mutation.source as ReleaseSourceHandle);
        source = typeof sourceRecord?.value === "string" ? sourceRecord.value : undefined;
      } else {
        source = prepare(mutation.source as ReleaseMutationHandle)?.output;
      }
      const replacement =
        typeof mutation.replacement === "string" ? mutation.replacement : prepare(mutation.replacement)?.output;

      if (source === undefined || replacement === undefined) {
        const blockedBy = this.#mutationDependencies(mutation)
          .filter((dependency) => failed.has(dependency))
          .map((dependency) => mutations.get(dependency)?.id ?? "<mutation>");
        const detail =
          blockedBy.length > 0
            ? `blocked by failed mutation(s) ${[...new setConstructor(blockedBy)].join(", ")}`
            : "blocked by an invalid source or unresolved dependency";
        this.#addProblem("mutation.blocked", mutation.id, detail);
        failed.add(handle);
        preparing.delete(handle);
        return null;
      }

      const actualOccurrences = countOccurrences(source, mutation.needle);
      if (actualOccurrences !== mutation.expectedOccurrences) {
        this.#addProblem(
          "mutation.cardinality",
          mutation.id,
          `needle expected ${mutation.expectedOccurrences} occurrence(s), found ${actualOccurrences}`
        );
        failed.add(handle);
        preparing.delete(handle);
        return null;
      }

      const output = applyLiteralMutation(source, mutation.needle, replacement, mutation.mode);
      if (output === source) {
        this.#addProblem("mutation.noop", mutation.id, "replacement did not change its source");
        failed.add(handle);
        preparing.delete(handle);
        return null;
      }

      const before = countWitnessOccurrences(source, mutation.witness);
      const after = countWitnessOccurrences(output, mutation.witness);
      if (before !== mutation.witness.before || after !== mutation.witness.after) {
        this.#addProblem(
          "witness.boundary",
          mutation.id,
          `anchor expected ${mutation.witness.before} -> ${mutation.witness.after}, found ${before} -> ${after}`
        );
        failed.add(handle);
        preparing.delete(handle);
        return null;
      }

      const prepared = freezeObject({ output });
      this.#prepared.set(handle, prepared);
      preparing.delete(handle);
      return prepared;
    };

    for (const handle of mutations.keys()) prepare(handle);
  }

  #validatePreparedCaseValues(cases: readonly CaseAnalysis[]): ReadonlySet<ReleaseMutationHandle> {
    const executableRoots = new setConstructor<ReleaseMutationHandle>();
    for (const releaseCase of cases) {
      if (!releaseCase.valid || releaseCase.root === null || releaseCase.checks.length === 0) continue;
      const mutant = this.#materializeValue(releaseCase.root);
      let executable = mutant !== undefined;
      for (const check of releaseCase.checks) {
        const baseline = this.#materializeValue(check.invocation.baseline);
        const companion =
          check.invocation.kind === "registry.step.run" || check.invocation.kind === "npm.contract.release"
            ? this.#materializeValue(check.invocation.integrity)
            : check.invocation.kind === "registry.step.integrity"
              ? this.#materializeValue(check.invocation.run)
              : check.invocation.kind === "npm.contract.integrity"
                ? this.#materializeValue(check.invocation.release)
                : "not-required";
        if (baseline === undefined || mutant === undefined) {
          executable = false;
        } else if (companion === undefined) {
          executable = false;
        } else if (baseline === mutant) {
          this.#addProblem("case.baseline", releaseCase.id, "clean baseline materializes to the mutant root output");
          executable = false;
        }
      }
      if (executable) {
        executableRoots.add(releaseCase.root);
      }
    }
    return executableRoots;
  }

  #validateReachability(
    mutations: ReadonlyMap<ReleaseMutationHandle, MutationAnalysis>,
    executableRoots: ReadonlySet<ReleaseMutationHandle>
  ): void {
    const reachable = new setConstructor<ReleaseMutationHandle>();
    const mark = (handle: ReleaseMutationHandle): void => {
      if (reachable.has(handle)) return;
      const mutation = mutations.get(handle);
      if (mutation === undefined) return;
      reachable.add(handle);
      for (const dependency of this.#mutationDependencies(mutation)) mark(dependency);
    };
    for (const root of executableRoots) mark(root);
    for (const [handle, mutation] of mutations) {
      if (!reachable.has(handle)) {
        this.#addProblem("mutation.orphan", mutation.id, "mutation is unreachable from every closed case");
      }
    }
  }

  #materializeValue(handle: ReleaseSourceHandle | ReleaseMutationHandle): string | undefined {
    const metadata = handleMetadata(handle);
    return metadata?.kind === "source"
      ? this.#sourceValues.get(handle as ReleaseSourceHandle)
      : this.#prepared.get(handle as ReleaseMutationHandle)?.output;
  }

  #applyExpectation(caseId: string, expectation: PreparedExpectation, observation: ReleaseOracleObservation): void {
    if (expectation.kind === "problem") {
      switch (observation.kind) {
        case "fixture.throw":
          if (
            expectation.problem !== "fixture.mutant-threw" ||
            !(applyFunction(arrayIncludesIntrinsic, observation.problems, [expectation.problem]) as boolean)
          ) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} missed an exact problem`
            );
          }
          return;
        case "registry.evaluator":
          if (expectation.problem !== MCP_REGISTRY_EVALUATOR_PROBLEM) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} observed an incompatible problem identity`
            );
          }
          if (observation.baselineProblems.length !== 0) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} found a problem in the clean baseline`
            );
          }
          if (observation.mutantProblems.length !== 1 || observation.mutantProblems[0] !== expectation.problem) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} missed the exact mutant problem`
            );
          }
          return;
        case "registry.step.run":
        case "registry.step.integrity":
          if (expectation.problem !== MCP_REGISTRY_WORKFLOW_PROBLEM) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} observed an incompatible problem identity`
            );
          }
          if (observation.baselineProblems.length !== 0) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} found a problem in the clean baseline`
            );
          }
          if (observation.mutantProblems.length !== 1 || observation.mutantProblems[0] !== expectation.problem) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} missed the exact mutant problem`
            );
          }
          return;
        case "npm.contract.release":
        case "npm.contract.integrity":
          if (expectation.problem !== NPM_PROVENANCE_CONTRACT_PROBLEM) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} observed an incompatible problem identity`
            );
          }
          if (observation.baselineProblems.length !== 0) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} found a problem in the clean baseline`
            );
          }
          if (observation.mutantProblems.length !== 1 || observation.mutantProblems[0] !== expectation.problem) {
            throw new errorConstructor(
              `release mutation case ${caseId} expectation ${expectation.id} missed the exact mutant problem`
            );
          }
          return;
        case "fixture.text":
          throw new errorConstructor(
            `release mutation case ${caseId} expectation ${expectation.id} observed an incompatible result`
          );
        default:
          assertNever(observation);
      }
    }
    if (observation.kind !== "fixture.text") {
      throw new errorConstructor(
        `release mutation case ${caseId} expectation ${expectation.id} observed an incompatible result`
      );
    }
    const baseline = observation.baseline;
    const mutant = observation.mutant;
    let passed = false;
    switch (expectation.kind) {
      case "equal":
        passed = baseline !== expectation.value && mutant === expectation.value;
        break;
      case "not-equal":
        passed = baseline === expectation.value && mutant !== expectation.value;
        break;
      case "regex": {
        const regex = releaseNamedRegex(expectation.regex);
        passed = !testRegExp(regex, baseline) && testRegExp(regex, mutant);
        break;
      }
      default:
        assertNever(expectation);
    }
    if (!passed) {
      throw new errorConstructor(
        `release mutation case ${caseId} expectation ${expectation.id} failed (${expectation.kind})`
      );
    }
  }
}

freezeObject(ReleaseMutationPlan.prototype);
freezeObject(ReleaseMutationPlan);
