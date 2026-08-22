#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HISTORICAL_FIXTURE_PATH = join(ROOT, "tests/fixtures/release-mutation-identity.v2.json");
const CURRENT_MATRIX_PATH = join(ROOT, "tests/release-integrity.test.ts");
const HISTORICAL_FIXTURE_SHA256 = "8205d24e6d42dd4cb8986368611514131abe701434beb30150e33ea08f4b1288";

function fail(message) {
  throw new Error(`release mutation transition generator: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function historicalSourceProjection(source) {
  return {
    id: source.id,
    legacyExpressions: source.legacyExpressions,
    declarativeBinding: source.declarativeBinding,
    origin: source.origin,
    contentSha256: source.contentSha256
  };
}

function historicalCaseProjection(identityCase) {
  return {
    id: identityCase.id,
    root: identityCase.root,
    checks: identityCase.checks.map((check) => ({
      invoke: {
        kind: check.invoke.kind,
        baseline: check.invoke.baseline,
        mutant: check.invoke.mutant
      },
      expectation: check.expectation,
      matcherEvaluations: check.matcherEvaluations.map((matcher) => ({
        matcher: matcher.matcher,
        negated: matcher.negated,
        operand: matcher.operand
      }))
    }))
  };
}

function historicalIdentityProjection(mutation, ownerCase) {
  return {
    id: mutation.id,
    mode: mutation.mode,
    role: mutation.role,
    source: mutation.source,
    replacementDependency: mutation.replacementDependency,
    ownerRoot: mutation.ownerRoot,
    legacyOccurrence: mutation.legacyOccurrence,
    expressions: mutation.expressions,
    witness: {
      kind: mutation.witness.kind,
      anchor: mutation.witness.anchor,
      before: mutation.witness.before,
      after: mutation.witness.after,
      derivation: mutation.witness.derivation
    },
    ownerCase: historicalCaseProjection(ownerCase)
  };
}

function historicalPopulation(fixtureSource) {
  let fixture;
  try {
    fixture = JSON.parse(fixtureSource);
  } catch (error) {
    fail(`historical fixture is not valid JSON: ${String(error)}`);
  }
  if (fixture.schemaVersion !== 2 || !Array.isArray(fixture.sources) || !Array.isArray(fixture.mutations)) {
    fail("historical fixture must be the exact schema-v2 identity manifest");
  }
  const caseByRoot = new Map(fixture.cases.map((identityCase) => [identityCase.root, identityCase]));
  return {
    schemaVersion: 2,
    fixtureSha256: HISTORICAL_FIXTURE_SHA256,
    sources: fixture.sources.map((source) => historicalSourceProjection(source)),
    identities: fixture.mutations.map((mutation) => {
      const ownerCase = caseByRoot.get(mutation.ownerRoot);
      if (ownerCase === undefined) fail(`historical mutation ${mutation.id} has no owner case`);
      return historicalIdentityProjection(mutation, ownerCase);
    })
  };
}

function transitionPlan(planModule) {
  return {
    historicalFixtureSha256: HISTORICAL_FIXTURE_SHA256,
    unchangedSourceIds: planModule.RELEASE_MUTATION_V3_UNCHANGED_SOURCES,
    changedSources: planModule.RELEASE_MUTATION_V3_CHANGED_SOURCES,
    retiredSources: planModule.RELEASE_MUTATION_V3_RETIRED_SOURCES,
    sourceSuccessors: [],
    newSourceIds: planModule.RELEASE_MUTATION_V3_NEW_SOURCES.map(({ id, reason }) => ({ id, reason })),
    unchangedIdentityIds: planModule.RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS,
    identitySuccessors: planModule.RELEASE_MUTATION_V3_SUCCESSORS,
    retiredIdentities: [],
    newIdentityIds: planModule.RELEASE_MUTATION_V3_NEW_IDENTITIES.map(({ id, reason }) => ({ id, reason }))
  };
}

function planSummary(planModule) {
  return {
    schemaVersion: 3,
    normalizer: "release-mutation-transition-v3-plan",
    status: "source-frozen",
    historical: {
      path: "tests/fixtures/release-mutation-identity.v2.json",
      schemaVersion: 2,
      sha256: HISTORICAL_FIXTURE_SHA256
    },
    inventory: {
      oldSources: 30,
      unchangedSources: planModule.RELEASE_MUTATION_V3_UNCHANGED_SOURCES.length,
      changedSources: planModule.RELEASE_MUTATION_V3_CHANGED_SOURCES.length,
      retiredSources: planModule.RELEASE_MUTATION_V3_RETIRED_SOURCES.length,
      newSources: planModule.RELEASE_MUTATION_V3_NEW_SOURCES.length,
      currentSources: planModule.RELEASE_MUTATION_V3_EXPECTED_SOURCE_COUNT,
      oldIdentities: 560,
      unchangedIdentities: planModule.RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS.length,
      successorIdentities: planModule.RELEASE_MUTATION_V3_SUCCESSORS.length,
      retiredIdentities: 0,
      newIdentities: planModule.RELEASE_MUTATION_V3_NEW_IDENTITIES.length,
      currentIdentities: planModule.RELEASE_MUTATION_V3_EXPECTED_IDENTITY_COUNT
    },
    classifications: {
      sources: {
        unchanged: planModule.RELEASE_MUTATION_V3_UNCHANGED_SOURCES,
        changed: planModule.RELEASE_MUTATION_V3_CHANGED_SOURCES,
        retired: planModule.RELEASE_MUTATION_V3_RETIRED_SOURCES,
        new: planModule.RELEASE_MUTATION_V3_NEW_SOURCES
      },
      identities: {
        unchanged: planModule.RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS,
        retired: [],
        successor: planModule.RELEASE_MUTATION_V3_SUCCESSORS,
        new: planModule.RELEASE_MUTATION_V3_NEW_IDENTITIES
      }
    }
  };
}

const args = process.argv.slice(2);
if (args.length !== 1 && !(args.length === 2 && args[0] === "--authority")) {
  fail("usage: --plan, --projection-current, --authority-current or --authority <current-projection.json>");
}
if (args.length === 1 && !["--plan", "--projection-current", "--authority-current"].includes(args[0])) {
  fail("usage: --plan, --projection-current, --authority-current or --authority <current-projection.json>");
}

const historicalFixtureSource = readFileSync(HISTORICAL_FIXTURE_PATH, "utf8");
if (sha256(historicalFixtureSource) !== HISTORICAL_FIXTURE_SHA256) {
  fail(`historical schema-v2 fixture must remain byte-exact SHA-256 ${HISTORICAL_FIXTURE_SHA256}`);
}

const vite = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true }
});
try {
  const [planModule, transitionModule, auditModule] = await Promise.all([
    vite.ssrLoadModule("/tests/release-mutation-transition-plan.ts"),
    vite.ssrLoadModule("/tests/release-mutation-transition.ts"),
    vite.ssrLoadModule("/tests/release-mutation-identity-audit.ts")
  ]);
  if (args[0] === "--plan") {
    process.stdout.write(`${JSON.stringify(planSummary(planModule), null, 2)}\n`);
  } else {
    let current;
    let historical = historicalPopulation(historicalFixtureSource);
    let currentWitness = null;
    if (args[0] === "--authority") {
      const projectionPath = resolve(ROOT, args[1]);
      try {
        current = JSON.parse(readFileSync(projectionPath, "utf8"));
      } catch (error) {
        fail(`current projection is unavailable or invalid: ${String(error)}`);
      }
    } else {
      const matrixSource = readFileSync(CURRENT_MATRIX_PATH, "utf8");
      const observation = auditModule.observeReleaseMutationTransitionPopulation(
        matrixSource,
        historicalFixtureSource,
        HISTORICAL_FIXTURE_SHA256,
        {
          currentMcpbInputs: planModule.RELEASE_MUTATION_V3_CURRENT_MCPB_INPUTS,
          expectedIdentityCount: planModule.RELEASE_MUTATION_V3_EXPECTED_IDENTITY_COUNT,
          expectedLegacyCount: planModule.RELEASE_MUTATION_V3_EXPECTED_LEGACY_COUNT,
          expectedSourceCount: planModule.RELEASE_MUTATION_V3_EXPECTED_SOURCE_COUNT,
          successors: planModule.RELEASE_MUTATION_V3_SUCCESSORS,
          unchangedOldIds: planModule.RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS,
          retiredSourceIds: planModule.RELEASE_MUTATION_V3_RETIRED_SOURCES.map((entry) => entry.id),
          newSources: planModule.RELEASE_MUTATION_V3_NEW_SOURCES,
          newIdentities: planModule.RELEASE_MUTATION_V3_NEW_IDENTITIES
        }
      );
      if (observation.historical === null || observation.current === null || observation.problems.length !== 0) {
        fail(observation.problems.join("; "));
      }
      historical = observation.historical;
      current = observation.current;
      currentWitness = {
        matrixSourceSha256: observation.sourceSha256,
        matrixSliceSha256: observation.matrixSliceSha256,
        legacyCount: observation.legacyCount,
        declarativeCount: observation.declarativeCount,
        sourceCount: observation.current.sources.length,
        identityCount: observation.current.identities.length
      };
    }
    if (args[0] === "--projection-current") {
      process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
      process.exitCode = 0;
    } else {
      const generated = transitionModule.buildReleaseMutationTransitionAuthority(
        historical,
        current,
        transitionPlan(planModule)
      );
      if (generated.authority === null) fail(generated.problems.join("; "));
      const authority =
        currentWitness === null ? generated.authority : { ...generated.authority, current: currentWitness };
      process.stdout.write(`${JSON.stringify(authority, null, 2)}\n`);
    }
  }
} finally {
  await vite.close();
}
