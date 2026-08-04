/** Mutation application mode used by the release-integrity oracle. */
type ReleaseMutationMode = "first" | "all";

/** A canonical source or an earlier mutation output in the release-mutation graph. */
type ReleaseMutationValueRef =
  | { readonly kind: "source"; readonly id: string }
  | { readonly kind: "mutation"; readonly id: string };

/** A literal replacement or the complete output of an earlier mutation. */
type ReleaseMutationReplacement =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "mutation"; readonly id: string };

/**
 * A bounded positive witness that must change by an exact count across one mutation.
 *
 * The witness is deliberately separate from the mutation needle. A mutation that preserves its
 * original anchor while adding a forbidden fragment must name that added fragment as the witness.
 */
interface ReleaseMutationWitness {
  readonly kind: "token" | "line";
  readonly anchor: string;
  readonly before: number;
  readonly after: number;
}

/** One named, dependency-aware release mutation. */
interface ReleaseMutationDescriptor {
  readonly id: string;
  readonly mode: ReleaseMutationMode;
  readonly source: ReleaseMutationValueRef;
  readonly needle: string;
  readonly replacement: ReleaseMutationReplacement;
  readonly expectedOccurrences: number;
  readonly witness: ReleaseMutationWitness;
}

/** Resolver exposed only to detector callbacks after a clean preflight seal. */
type ReleaseMutationResolver = (mutationId: string) => string;

/** Synchronous assertion wrapper used to prove that a detector did more than resolve a root. */
type ReleaseMutationAssertion = (assertion: () => unknown) => void;

/** One named detector callback and the mutation outputs it makes reachable. */
interface ReleaseMutationDetectorCase {
  readonly id: string;
  readonly mutations: readonly string[];
  readonly expectedAssertions: number;
  readonly run: (resolve: ReleaseMutationResolver, assert: ReleaseMutationAssertion) => unknown;
}

/** Optional exact inventory projection for a complete mutation matrix. */
interface ReleaseMutationInventoryExpectation {
  readonly total: number;
  readonly first: number;
  readonly all: number;
}

/** Lifecycle state of a release-mutation plan. */
type ReleaseMutationPlanState = "open" | "sealing" | "sealed" | "rejected" | "executing" | "executed" | "failed";

interface PreparedMutation {
  readonly descriptor: ReleaseMutationDescriptor;
  readonly output: string;
}

interface MutationLocalValidation {
  readonly unpreparable: ReadonlySet<string>;
  readonly invalidWitness: ReadonlySet<string>;
}

const ID_PATTERN = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
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
  return value.length > 0 && /[\p{L}\p{N}_]/u.test(value);
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
    fragments.push(source.slice(cursor, offset));
    fragments.push(expandLiteralReplacement(source, needle, replacement, offset));
    cursor = offset + needle.length;
  }
  fragments.push(source.slice(cursor));
  return fragments.join("");
}

function valueRefDependency(ref: ReleaseMutationValueRef | ReleaseMutationReplacement): string | null {
  return ref.kind === "mutation" ? ref.id : null;
}

function snapshotValueRef(ref: ReleaseMutationValueRef): ReleaseMutationValueRef {
  return ref.kind === "source" ? { kind: "source", id: ref.id } : { kind: "mutation", id: ref.id };
}

function snapshotReplacement(replacement: ReleaseMutationReplacement): ReleaseMutationReplacement {
  return replacement.kind === "literal"
    ? { kind: "literal", value: replacement.value }
    : { kind: "mutation", id: replacement.id };
}

/**
 * Declarative two-phase planner for the release-integrity mutation matrix.
 *
 * Registration is open-only. `seal()` validates the complete source/descriptor/detector graph and
 * materializes mutation strings internally, but never invokes a detector. `execute()` is available
 * only after a clean seal. Successful execution invokes each registered detector exactly once in
 * registration order; the first detector violation fails the plan and prevents later callbacks.
 *
 * @example
 * const plan = new ReleaseMutationPlan({ total: 1, first: 1, all: 0 });
 * plan.registerSource("workflow.release", releaseWorkflow);
 * // Register descriptors and deferred detectors, then require `seal()` to return no diagnostics.
 */
export class ReleaseMutationPlan {
  private readonly sources: Array<readonly [string, string]> = [];
  private readonly mutations: ReleaseMutationDescriptor[] = [];
  private readonly detectors: ReleaseMutationDetectorCase[] = [];
  private readonly prepared = new Map<string, PreparedMutation>();
  private readonly problems: string[] = [];
  private readonly expectedInventory: ReleaseMutationInventoryExpectation | undefined;
  private state: ReleaseMutationPlanState = "open";
  private executedDetectors = 0;

  /**
   * Create a planner, optionally pinning the final first/all inventory.
   *
   * @param expectedInventory - Exact complete-matrix totals, or undefined for a focused fixture.
   */
  constructor(expectedInventory?: ReleaseMutationInventoryExpectation) {
    this.expectedInventory = expectedInventory === undefined ? undefined : { ...expectedInventory };
  }

  /** @returns Current lifecycle state, exposed for invariant controls. */
  get phase(): ReleaseMutationPlanState {
    return this.state;
  }

  /** @returns Number of detector callbacks invoked by this plan. */
  get detectorExecutions(): number {
    return this.executedDetectors;
  }

  /** @returns Stable aggregate diagnostics produced by the last seal attempt. */
  get diagnostics(): readonly string[] {
    return [...this.problems];
  }

  /**
   * Register one canonical named source.
   *
   * @param id - Stable source identity.
   * @param value - Exact source bytes used by descriptors.
   * @returns This plan for fluent fixture construction.
   * @throws If registration has already closed.
   */
  registerSource(id: string, value: string): this {
    this.requireOpen("register source");
    this.sources.push([id, value]);
    return this;
  }

  /**
   * Register one named mutation descriptor.
   *
   * @param descriptor - Named descriptor and its bounded positive witness.
   * @returns This plan for fluent fixture construction.
   * @throws If registration has already closed.
   */
  registerMutation(descriptor: ReleaseMutationDescriptor): this {
    this.requireOpen("register mutation");
    this.mutations.push({
      id: descriptor.id,
      mode: descriptor.mode,
      source: snapshotValueRef(descriptor.source),
      needle: descriptor.needle,
      replacement: snapshotReplacement(descriptor.replacement),
      expectedOccurrences: descriptor.expectedOccurrences,
      witness: { ...descriptor.witness }
    });
    return this;
  }

  /**
   * Register one detector callback and its reachable mutation roots.
   *
   * @param detector - Named deferred detector case.
   * @returns This plan for fluent fixture construction.
   * @throws If registration has already closed.
   */
  registerDetector(detector: ReleaseMutationDetectorCase): this {
    this.requireOpen("register detector");
    this.detectors.push({
      id: detector.id,
      mutations: [...detector.mutations],
      expectedAssertions: detector.expectedAssertions,
      run: detector.run
    });
    return this;
  }

  /**
   * Aggregate-preflight the complete graph and seal it only when every diagnostic is clean.
   *
   * @returns Stable diagnostics. An empty array means execution is now permitted.
   * @throws If the plan is not open or validation aborts unexpectedly.
   */
  seal(): readonly string[] {
    this.requireOpen("seal");
    this.state = "sealing";
    try {
      this.validateInventory();
      const sourceMap = this.validateSources();
      const mutationMap = this.validateMutationIdentities();
      const detectorMap = this.validateDetectorIdentities();
      const localValidation = this.validateMutationDescriptors();
      this.validateDependencies(sourceMap, mutationMap);
      const cyclicMutations = this.validateCycles(mutationMap);
      this.prepareMutations(sourceMap, mutationMap, localValidation, cyclicMutations);
      this.validateReachability(mutationMap, detectorMap);
      this.state = this.problems.length === 0 ? "sealed" : "rejected";
      return this.diagnostics;
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  /**
   * Execute every deferred detector after a clean seal.
   *
   * @returns Nothing. Successful completion moves the plan to `executed`.
   * @throws If preflight was not clean; a detector violates scope, synchronous-return, root-use or
   * assertion-count contracts; or a wrapped assertion fails.
   */
  execute(): void {
    if (this.state !== "sealed") {
      throw new Error(`release mutation plan execute requires sealed state; found ${this.state}`);
    }
    this.state = "executing";
    try {
      for (const detector of this.detectors) {
        const allowed = new Set<string>();
        const declaredRoots = new Set(detector.mutations);
        const requestedRoots = new Set<string>();
        let assertionExecutions = 0;
        let violationDetected = false;
        let stickyViolation: unknown;
        const recordViolation = (error: unknown): void => {
          if (violationDetected) return;
          violationDetected = true;
          stickyViolation = error;
        };
        const fail = (error: unknown): never => {
          recordViolation(error);
          throw stickyViolation;
        };
        const violate = (message: string): never => fail(new Error(message));
        const markAllowed = (mutationId: string): void => {
          if (allowed.has(mutationId)) return;
          const mutation = this.prepared.get(mutationId);
          if (mutation === undefined) return;
          allowed.add(mutationId);
          const sourceDependency = valueRefDependency(mutation.descriptor.source);
          const replacementDependency = valueRefDependency(mutation.descriptor.replacement);
          if (sourceDependency !== null) markAllowed(sourceDependency);
          if (replacementDependency !== null) markAllowed(replacementDependency);
        };
        for (const mutationId of detector.mutations) markAllowed(mutationId);
        const resolve: ReleaseMutationResolver = (mutationId) => {
          if (!allowed.has(mutationId)) {
            return violate(`release mutation detector ${detector.id} requested undeclared output ${mutationId}`);
          }
          const mutation = this.prepared.get(mutationId);
          if (mutation === undefined) {
            return violate(`release mutation detector requested unknown output ${mutationId}`);
          }
          if (declaredRoots.has(mutationId)) requestedRoots.add(mutationId);
          return mutation.output;
        };
        const assert: ReleaseMutationAssertion = (assertion) => {
          assertionExecutions++;
          try {
            const result = assertion();
            if (result !== undefined) {
              void Promise.resolve(result).catch(() => undefined);
              violate(`release mutation detector ${detector.id} assertions must return undefined synchronously`);
            }
          } catch (error) {
            fail(error);
          }
        };
        this.executedDetectors++;
        let result: unknown;
        try {
          result = detector.run(resolve, assert);
        } catch (error) {
          fail(error);
        }
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined);
          recordViolation(new Error(`release mutation detector ${detector.id} must return undefined synchronously`));
        }
        if (violationDetected) throw stickyViolation;
        const unusedRoots = detector.mutations.filter((mutationId) => !requestedRoots.has(mutationId));
        if (unusedRoots.length > 0) {
          throw new Error(
            `release mutation detector ${detector.id} did not request declared root(s): ${unusedRoots.join(", ")}`
          );
        }
        if (assertionExecutions !== detector.expectedAssertions) {
          const assertionSummary = [`${detector.expectedAssertions} expected`, `${assertionExecutions} executed`].join(
            ", "
          );
          throw new Error(`release mutation detector ${detector.id} assertion count mismatch: ${assertionSummary}`);
        }
      }
      this.state = "executed";
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  private requireOpen(action: string): void {
    if (this.state !== "open") {
      throw new Error(`cannot ${action} after release mutation plan entered ${this.state} state`);
    }
  }

  private addProblem(code: string, id: string, detail: string): void {
    this.problems.push(`[${code}] ${id}: ${detail}`);
  }

  private validateInventory(): void {
    if (this.mutations.length === 0) {
      this.addProblem("inventory.empty", "plan", "plan must register at least one mutation");
    }
    if (this.expectedInventory === undefined) return;
    const first = this.mutations.filter((descriptor) => descriptor.mode === "first").length;
    const all = this.mutations.length - first;
    if (
      !isPositiveSafeInteger(this.expectedInventory.total) ||
      !Number.isSafeInteger(this.expectedInventory.first) ||
      this.expectedInventory.first < 0 ||
      !Number.isSafeInteger(this.expectedInventory.all) ||
      this.expectedInventory.all < 0 ||
      this.expectedInventory.first + this.expectedInventory.all !== this.expectedInventory.total
    ) {
      this.addProblem("inventory.invalid", "plan", "expected inventory must be coherent safe integers");
      return;
    }
    if (
      this.mutations.length !== this.expectedInventory.total ||
      first !== this.expectedInventory.first ||
      all !== this.expectedInventory.all
    ) {
      const expected = [
        `${this.expectedInventory.total} total`,
        `(${this.expectedInventory.first} first / ${this.expectedInventory.all} all)`
      ].join(" ");
      const found = `${this.mutations.length} total (${first} first / ${all} all)`;
      this.addProblem("inventory.mismatch", "plan", `expected ${expected}, found ${found}`);
    }
  }

  private validateSources(): Map<string, string> {
    const sourceMap = new Map<string, string>();
    if (this.sources.length === 0) {
      this.addProblem("source.none", "plan", "plan must register at least one canonical source");
    }
    for (const [id, value] of this.sources) {
      if (!ID_PATTERN.test(id)) {
        this.addProblem(
          "source.id",
          id || "<empty>",
          "id must be one lowercase token path without repeated separators"
        );
      }
      if (sourceMap.has(id)) {
        this.addProblem("source.duplicate", id || "<empty>", "source id is registered more than once");
        continue;
      }
      sourceMap.set(id, value);
      if (value.length === 0) this.addProblem("source.empty", id || "<empty>", "canonical source must not be empty");
    }
    return sourceMap;
  }

  private validateMutationIdentities(): Map<string, ReleaseMutationDescriptor> {
    const mutationMap = new Map<string, ReleaseMutationDescriptor>();
    for (const descriptor of this.mutations) {
      if (!ID_PATTERN.test(descriptor.id)) {
        this.addProblem(
          "mutation.id",
          descriptor.id || "<empty>",
          "id must be one lowercase token path without repeated separators"
        );
      }
      if (mutationMap.has(descriptor.id)) {
        this.addProblem("mutation.duplicate", descriptor.id || "<empty>", "mutation id is registered more than once");
        continue;
      }
      mutationMap.set(descriptor.id, descriptor);
    }
    return mutationMap;
  }

  private validateDetectorIdentities(): Map<string, ReleaseMutationDetectorCase> {
    const detectorMap = new Map<string, ReleaseMutationDetectorCase>();
    if (this.detectors.length === 0) {
      this.addProblem("detector.none", "plan", "plan must register at least one detector");
    }
    for (const detector of this.detectors) {
      if (!ID_PATTERN.test(detector.id)) {
        this.addProblem(
          "detector.id",
          detector.id || "<empty>",
          "id must be one lowercase token path without repeated separators"
        );
      }
      if (detectorMap.has(detector.id)) {
        this.addProblem("detector.duplicate", detector.id || "<empty>", "detector id is registered more than once");
        continue;
      }
      detectorMap.set(detector.id, detector);
      if (detector.mutations.length === 0) {
        this.addProblem("detector.empty", detector.id || "<empty>", "detector must reach at least one mutation");
      }
      if (!isPositiveSafeInteger(detector.expectedAssertions)) {
        this.addProblem(
          "detector.assertions",
          detector.id || "<empty>",
          "expectedAssertions must be a positive safe integer"
        );
      }
    }
    return detectorMap;
  }

  private validateDependencies(
    sourceMap: ReadonlyMap<string, string>,
    mutationMap: ReadonlyMap<string, ReleaseMutationDescriptor>
  ): void {
    for (const descriptor of this.mutations) {
      if (descriptor.source.kind === "source") {
        if (!sourceMap.has(descriptor.source.id)) {
          this.addProblem("dependency.source", descriptor.id, `unknown canonical source ${descriptor.source.id}`);
        }
      } else if (!mutationMap.has(descriptor.source.id)) {
        this.addProblem("dependency.mutation", descriptor.id, `unknown source mutation ${descriptor.source.id}`);
      }
      const replacementDependency = valueRefDependency(descriptor.replacement);
      if (replacementDependency !== null && !mutationMap.has(replacementDependency)) {
        this.addProblem("dependency.mutation", descriptor.id, `unknown replacement mutation ${replacementDependency}`);
      }
    }
    for (const detector of this.detectors) {
      const seen = new Set<string>();
      for (const mutationId of detector.mutations) {
        if (seen.has(mutationId)) {
          this.addProblem("detector.reference", detector.id, `duplicate mutation reference ${mutationId}`);
        }
        seen.add(mutationId);
        if (!mutationMap.has(mutationId)) {
          this.addProblem("detector.reference", detector.id, `unknown mutation ${mutationId}`);
        }
      }
    }
  }

  private validateMutationDescriptors(): MutationLocalValidation {
    const unpreparable = new Set<string>();
    const invalidWitness = new Set<string>();
    for (const descriptor of this.mutations) {
      let mutationValid = true;
      let witnessValid = true;
      if (descriptor.mode !== "first" && descriptor.mode !== "all") {
        this.addProblem("mutation.mode", descriptor.id, "mode must be first or all");
        mutationValid = false;
      }
      if (descriptor.needle.length === 0) {
        this.addProblem("mutation.needle", descriptor.id, "needle must not be empty");
        mutationValid = false;
      }
      if (!isPositiveSafeInteger(descriptor.expectedOccurrences)) {
        this.addProblem("mutation.count", descriptor.id, "expectedOccurrences must be a positive safe integer");
        mutationValid = false;
      }
      if (descriptor.witness.kind !== "token" && descriptor.witness.kind !== "line") {
        this.addProblem("witness.kind", descriptor.id, "positive witness kind must be token or line");
        witnessValid = false;
      }
      if (descriptor.witness.anchor.length === 0) {
        this.addProblem("witness.anchor", descriptor.id, "positive witness anchor must not be empty");
        witnessValid = false;
      }
      if (
        !Number.isSafeInteger(descriptor.witness.before) ||
        descriptor.witness.before < 0 ||
        !Number.isSafeInteger(descriptor.witness.after) ||
        descriptor.witness.after < 0 ||
        descriptor.witness.before === descriptor.witness.after
      ) {
        this.addProblem("witness.count", descriptor.id, "witness counts must be different non-negative safe integers");
        witnessValid = false;
      }
      if (!mutationValid) unpreparable.add(descriptor.id);
      if (!witnessValid) invalidWitness.add(descriptor.id);
    }
    return { unpreparable, invalidWitness };
  }

  private validateCycles(mutationMap: ReadonlyMap<string, ReleaseMutationDescriptor>): Set<string> {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cyclic = new Set<string>();
    const visit = (id: string, path: readonly string[]): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        const cycleStart = path.indexOf(id);
        const cycle = cycleStart === -1 ? [...path, id] : [...path.slice(cycleStart), id];
        for (const cycleId of cycle) cyclic.add(cycleId);
        this.addProblem("dependency.cycle", id, `cycle ${cycle.join(" -> ")}`);
        return;
      }
      const descriptor = mutationMap.get(id);
      if (descriptor === undefined) return;
      visiting.add(id);
      const dependencies = [valueRefDependency(descriptor.source), valueRefDependency(descriptor.replacement)].filter(
        (dependency): dependency is string => dependency !== null
      );
      for (const dependency of dependencies) visit(dependency, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of mutationMap.keys()) visit(id, []);
    return cyclic;
  }

  private prepareMutations(
    sourceMap: ReadonlyMap<string, string>,
    mutationMap: ReadonlyMap<string, ReleaseMutationDescriptor>,
    localValidation: MutationLocalValidation,
    cyclicMutations: ReadonlySet<string>
  ): void {
    const preparing = new Set<string>();
    const failed = new Set([...localValidation.unpreparable, ...cyclicMutations]);
    const prepare = (id: string): PreparedMutation | null => {
      const alreadyPrepared = this.prepared.get(id);
      if (alreadyPrepared !== undefined) return alreadyPrepared;
      if (failed.has(id)) return null;
      if (preparing.has(id)) return null;
      const descriptor = mutationMap.get(id);
      if (descriptor === undefined) return null;
      preparing.add(id);
      const source =
        descriptor.source.kind === "source"
          ? sourceMap.get(descriptor.source.id)
          : prepare(descriptor.source.id)?.output;
      const replacement =
        descriptor.replacement.kind === "literal"
          ? descriptor.replacement.value
          : prepare(descriptor.replacement.id)?.output;
      if (source === undefined || replacement === undefined) {
        const blockedBy = [
          descriptor.source.kind === "mutation" && failed.has(descriptor.source.id) ? descriptor.source.id : null,
          descriptor.replacement.kind === "mutation" && failed.has(descriptor.replacement.id)
            ? descriptor.replacement.id
            : null
        ].filter((dependency): dependency is string => dependency !== null);
        const uniqueBlockedBy = [...new Set(blockedBy)];
        if (uniqueBlockedBy.length > 0) {
          this.addProblem(
            "mutation.blocked",
            descriptor.id,
            `blocked by failed mutation(s) ${uniqueBlockedBy.join(", ")}`
          );
        }
        failed.add(id);
        preparing.delete(id);
        return null;
      }

      const actualOccurrences = countOccurrences(source, descriptor.needle);
      if (actualOccurrences !== descriptor.expectedOccurrences) {
        this.addProblem(
          "mutation.cardinality",
          descriptor.id,
          `needle expected ${descriptor.expectedOccurrences} occurrence(s), found ${actualOccurrences}`
        );
        failed.add(id);
        preparing.delete(id);
        return null;
      }

      const output = applyLiteralMutation(source, descriptor.needle, replacement, descriptor.mode);
      if (output === source) {
        this.addProblem("mutation.noop", descriptor.id, "replacement did not change its source");
      }
      if (!localValidation.invalidWitness.has(descriptor.id)) {
        const before = countWitnessOccurrences(source, descriptor.witness);
        const after = countWitnessOccurrences(output, descriptor.witness);
        if (before !== descriptor.witness.before || after !== descriptor.witness.after) {
          this.addProblem(
            "witness.boundary",
            descriptor.id,
            `anchor expected ${descriptor.witness.before} -> ${descriptor.witness.after}, found ${before} -> ${after}`
          );
        }
      }
      const prepared = { descriptor, output } satisfies PreparedMutation;
      this.prepared.set(id, prepared);
      preparing.delete(id);
      return prepared;
    };
    for (const id of mutationMap.keys()) prepare(id);
  }

  private validateReachability(
    mutationMap: ReadonlyMap<string, ReleaseMutationDescriptor>,
    detectorMap: ReadonlyMap<string, ReleaseMutationDetectorCase>
  ): void {
    const reachable = new Set<string>();
    const mark = (id: string): void => {
      if (reachable.has(id)) return;
      const descriptor = mutationMap.get(id);
      if (descriptor === undefined) return;
      reachable.add(id);
      const sourceDependency = valueRefDependency(descriptor.source);
      const replacementDependency = valueRefDependency(descriptor.replacement);
      if (sourceDependency !== null) mark(sourceDependency);
      if (replacementDependency !== null) mark(replacementDependency);
    };
    for (const detector of detectorMap.values()) {
      for (const mutationId of detector.mutations) mark(mutationId);
    }
    for (const id of mutationMap.keys()) {
      if (!reachable.has(id)) this.addProblem("mutation.orphan", id, "mutation is unreachable from every detector");
    }
  }
}
