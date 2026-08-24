// v3.10.0-rc.27 — Docker / Glama discoverability invariant.
//
// Background. MCP directories (Glama, and through Glama the awesome-mcp-servers
// listing) introspect a server by BUILDING its Dockerfile and completing an MCP
// handshake + `tools/list` over stdio. This was a borrowed lesson: seeklink's
// commit history shows awesome-mcp-servers now requires listed servers to pass
// Glama checks, which need a Docker-startable MCP server. enquire shipped
// glama.json long ago but had no Dockerfile, so the directory check could not
// build it.
//
// This invariant pins the two files that feed that check against drift:
//   1. The Dockerfile must (a) invoke the real bin (`dist/index.js`),
//      (b) run the `serve` subcommand, (c) use a Node base image whose major
//      version is >= the engines.node floor in package.json, and (d) pin both
//      stages to the reviewed official multi-arch manifest digest. If a future
//      bump raises engines.node past the base image, or a moving tag reappears,
//      the introspection image would lose its reviewed runtime identity.
//   2. glama.json must be valid JSON, carry a glama.ai $schema, and list the
//      repo owner as a maintainer (so Glama attributes + indexes the server).
//
// Pure analyzers (`analyzeDockerfile`, `engineNodeMajorFloor`,
// `validateGlamaConfig`) are module-local and exercised directly by the
// NEGATIVE controls with intentionally-broken input, proving each violation
// IS detected.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
// @ts-expect-error — the release checker is an executable .mjs module without declarations; this test uses its pure core.
import { evaluateReleaseChecks, REQUIRED_RELEASE_CHECKS } from "../scripts/check-release-integrity.mjs";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

const repoRoot = path.resolve(__dirname, "..");
const OWNER = "oomkapwn";
const NODE_22_SLIM_MANIFEST_DIGEST = "sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436";
const PINNED_NODE_22_SLIM_REFERENCE = `node:22-slim@${NODE_22_SLIM_MANIFEST_DIGEST}`;
const DOCKER_BASE_PIN_PROBLEM = "both Docker stages must use the exact node:22-slim multi-arch manifest digest";
const DOCKER_RELEASE_GATE_PROBLEM =
  "docker must be one fail-capable exact release-required context evaluated before publication";
const MACOS_ARCHITECTURE_PROBLEM =
  "macOS-bearing CI lanes must bind and execute the exact expected Node architecture assertion";

type YamlMapping = Record<string, unknown>;

function yamlMapping(value: unknown): YamlMapping | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as YamlMapping) : null;
}

function yamlSteps(job: YamlMapping | null): YamlMapping[] {
  const steps = job?.steps;
  return Array.isArray(steps) ? steps.map(yamlMapping).filter((step): step is YamlMapping => step !== null) : [];
}

function namedSteps(job: YamlMapping | null, name: string): YamlMapping[] {
  return yamlSteps(job).filter((step) => step.name === name);
}

function hasExactNeeds(job: YamlMapping | null, expected: readonly string[]): boolean {
  const needs = job?.needs;
  if (!Array.isArray(needs) || !needs.every((need): need is string => typeof need === "string")) return false;
  return JSON.stringify([...needs].sort()) === JSON.stringify([...expected].sort());
}

const EXPECTED_ARCHITECTURE_RUN = [
  "node -e '",
  "  const expected = process.env.EXPECTED_ARCH;",
  '  if (!["x64", "arm64"].includes(expected) || process.arch !== expected) {',
  ["    throw new Error(`expected Node architecture $", "{expected}; received $", "{process.arch}`);"].join(""),
  "  }",
  "'"
].join("\n");

function isExactArchitectureAssertion(step: YamlMapping | undefined, expectedBinding: string): boolean {
  const env = yamlMapping(step?.env);
  return (
    step?.name === "Assert expected runner architecture" &&
    JSON.stringify(Object.keys(step).sort()) === JSON.stringify(["env", "name", "run"]) &&
    env !== null &&
    JSON.stringify(Object.keys(env)) === JSON.stringify(["EXPECTED_ARCH"]) &&
    env.EXPECTED_ARCH === expectedBinding &&
    typeof step.run === "string" &&
    step.run.trimEnd() === EXPECTED_ARCHITECTURE_RUN &&
    !("if" in step) &&
    !("continue-on-error" in step)
  );
}

function releasePlatformGateProblems(ciText: string, releaseText: string, requiredChecks: readonly string[]): string[] {
  const problems: string[] = [];
  let ci: YamlMapping | null = null;
  let release: YamlMapping | null = null;
  try {
    ci = yamlMapping(load(ciText));
  } catch {
    problems.push("ci.yml must remain valid YAML");
  }
  try {
    release = yamlMapping(load(releaseText));
  } catch {
    problems.push("release.yml must remain valid YAML");
  }
  const jobs = yamlMapping(ci?.jobs);
  const docker = yamlMapping(jobs?.docker);
  const dockerSteps = yamlSteps(docker);
  const releaseJobs = yamlMapping(release?.jobs);
  const verifyJob = yamlMapping(releaseJobs?.verify);
  const verifySteps = yamlSteps(verifyJob);
  const releaseGates = namedSteps(verifyJob, "Assert tag is on main and required CI checks passed");
  const releaseGate = releaseGates[0];
  const releaseGateRun = typeof releaseGate?.run === "string" ? releaseGate.run : "";
  const privilegedJobs = [
    { id: "npm_publish", needs: ["verify"], condition: null },
    { id: "github_release", needs: ["verify", "npm_publish"], condition: null },
    {
      id: "mcp_registry",
      needs: ["verify", "npm_publish", "github_release"],
      condition: ["$", "{{ needs.verify.outputs.channel == 'latest' }}"].join("")
    }
  ] as const;
  const privilegedChainIsExact = privilegedJobs.every(({ id, needs, condition }) => {
    const job = yamlMapping(releaseJobs?.[id]);
    const steps = yamlSteps(job);
    return (
      job !== null &&
      hasExactNeeds(job, needs) &&
      (condition === null ? !("if" in job) : job.if === condition) &&
      !("continue-on-error" in job) &&
      steps.length > 0 &&
      !steps.some((step) => "if" in step || "continue-on-error" in step)
    );
  });
  const mirror = /REQUIRED="([^"]+)"/u.exec(releaseGateRun)?.[1];
  const mirroredChecks = (mirror ?? "")
    .split("|")
    .filter(Boolean)
    .map((name) => name.replaceAll("\\(", "(").replaceAll("\\)", ")"));
  const declaredCount = Number.parseInt(/REQ_COUNT=(\d+)/u.exec(releaseGateRun)?.[1] ?? "", 10);
  if (
    requiredChecks.filter((name) => name === "docker").length !== 1 ||
    mirroredChecks.filter((name) => name === "docker").length !== 1 ||
    JSON.stringify(mirroredChecks) !== JSON.stringify(requiredChecks) ||
    declaredCount !== requiredChecks.length ||
    docker === null ||
    docker["runs-on"] !== "ubuntu-latest" ||
    "if" in docker ||
    "needs" in docker ||
    "strategy" in docker ||
    "continue-on-error" in docker ||
    dockerSteps.length === 0 ||
    dockerSteps.some((step) => "if" in step || "continue-on-error" in step) ||
    verifyJob === null ||
    "if" in (verifyJob ?? {}) ||
    "needs" in (verifyJob ?? {}) ||
    "continue-on-error" in (verifyJob ?? {}) ||
    verifySteps.some((step) => "if" in step || "continue-on-error" in step) ||
    releaseGates.length !== 1 ||
    "if" in (releaseGate ?? {}) ||
    "continue-on-error" in (releaseGate ?? {}) ||
    releaseGateRun.split('node scripts/check-release-integrity.mjs checks "$SHA"').length !== 2 ||
    !privilegedChainIsExact
  ) {
    problems.push(DOCKER_RELEASE_GATE_PROBLEM);
  }

  const testMacos = yamlMapping(jobs?.["test-macos"]);
  const standaloneAssertions = namedSteps(testMacos, "Assert expected runner architecture");
  if (
    testMacos === null ||
    testMacos["runs-on"] !== "macos-latest" ||
    testMacos["continue-on-error"] !== true ||
    standaloneAssertions.length !== 1 ||
    !isExactArchitectureAssertion(standaloneAssertions[0], "arm64")
  ) {
    problems.push(MACOS_ARCHITECTURE_PROBLEM);
  }

  const expectedRows = [
    { label: "linux", os: "ubuntu-latest", arch: "x64" },
    { label: "windows", os: "windows-2025", arch: "x64" },
    { label: "macos", os: "macos-latest", arch: "arm64" }
  ];
  for (const jobId of ["package-consumer-matrix", "mcpb-basic-matrix"]) {
    const job = yamlMapping(jobs?.[jobId]);
    const rowsValue = yamlMapping(yamlMapping(job?.strategy)?.matrix)?.include;
    const rows = Array.isArray(rowsValue)
      ? rowsValue
          .map(yamlMapping)
          .filter((row): row is YamlMapping => row !== null)
          .map((row) => ({ label: row.label, os: row.os, arch: row.arch }))
      : [];
    const assertions = namedSteps(job, "Assert expected runner architecture");
    if (
      job === null ||
      JSON.stringify(rows) !== JSON.stringify(expectedRows) ||
      "if" in job ||
      "continue-on-error" in job ||
      yamlSteps(job).some((step) => "if" in step || "continue-on-error" in step) ||
      assertions.length !== 1 ||
      !isExactArchitectureAssertion(assertions[0], ["$", "{{ matrix.arch }}"].join(""))
    ) {
      problems.push(MACOS_ARCHITECTURE_PROBLEM);
    }
  }
  return [...new Set(problems)];
}

function mutateYaml(source: string, mutate: (document: YamlMapping) => void): string {
  const document = yamlMapping(load(source));
  if (document === null) throw new Error("workflow mutation fixture must be one YAML mapping");
  mutate(document);
  return JSON.stringify(document);
}

function replaceUnique(source: string, needle: string, replacement: string): string {
  return replaceExactly(source, needle, replacement);
}

interface DockerfileFacts {
  /** Every base-image reference from a `FROM` instruction, in order. */
  baseReferences: string[];
  /** Every `FROM node:<major>...` base image major found, in order. */
  baseMajors: number[];
  /** Whether the file invokes the published bin entry (`dist/index.js`). */
  referencesBin: boolean;
  /** Whether an ENTRYPOINT/CMD exec array runs the `serve` subcommand. */
  runsServe: boolean;
  /** Whether any instruction copies the complete build context. */
  copiesWholeContext: boolean;
  /** Normalized local sources named by build-stage COPY instructions. */
  localCopySources: string[];
}

/** Parse the facts the directory-introspection contract depends on. */
function analyzeDockerfile(text: string): DockerfileFacts {
  const baseReferences: string[] = [];
  const baseMajors: number[] = [];
  const fromRe = /^\s*FROM\s+([^\s]+)/gim;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = fromRe.exec(text)) !== null) {
    const reference = m[1];
    if (reference === undefined) continue;
    baseReferences.push(reference);
    const nodeMajor = /^node:(\d+)/iu.exec(reference)?.[1];
    if (nodeMajor !== undefined) baseMajors.push(Number(nodeMajor));
  }
  const referencesBin = /dist\/index\.js/.test(text);
  const execLines = (text.match(/^\s*(?:CMD|ENTRYPOINT)\s+\[[^\]]*\]/gim) ?? []).join(" ");
  const runsServe = /"serve"/.test(execLines);
  const localCopySources: string[] = [];
  let copiesWholeContext = false;
  for (const line of text.match(/^\s*COPY\s+[^\n]+/gim) ?? []) {
    if (/^\s*COPY\s+--from=/i.test(line)) continue;
    const body = line.replace(/^\s*COPY\s+/i, "").trim();
    if (body.startsWith("[")) continue;
    const words = body.split(/\s+/u);
    for (const source of words.slice(0, -1)) {
      if (source === "." || source === "./") copiesWholeContext = true;
      localCopySources.push(source.replace(/^\.\//u, "").replace(/\/$/u, ""));
    }
  }
  return { baseReferences, baseMajors, referencesBin, runsServe, copiesWholeContext, localCopySources };
}

/** Require both stages to resolve through one reviewed official multi-arch index. */
function validateDockerBasePins(facts: DockerfileFacts): string[] {
  return facts.baseReferences.length === 2 &&
    facts.baseReferences.every((reference) => reference === PINNED_NODE_22_SLIM_REFERENCE)
    ? []
    : [DOCKER_BASE_PIN_PROBLEM];
}

/** Exact client-context policy paired with the Dockerfile's local COPY set. */
function validateDockerContextPolicy(text: string): string[] {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const expected = [
    "*",
    "!Dockerfile",
    "!.dockerignore",
    "!package.json",
    "!package-lock.json",
    "!tsconfig.json",
    "!src/",
    "!src/**"
  ];
  return JSON.stringify(lines) === JSON.stringify(expected)
    ? []
    : [".dockerignore must be the exact closed-world Docker context allowlist"];
}

/** Extract the major version floor from an `engines.node` semver range. */
function engineNodeMajorFloor(pkg: { engines?: { node?: string } }): number | null {
  const node = pkg.engines?.node;
  if (!node) return null;
  const m = node.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

interface GlamaCheck {
  ok: boolean;
  issues: string[];
}

/** Validate glama.json against the minimal directory contract. */
function validateGlamaConfig(jsonText: string, owner: string): GlamaCheck {
  let parsed: { $schema?: unknown; maintainers?: unknown };
  try {
    parsed = JSON.parse(jsonText) as typeof parsed;
  } catch {
    return { ok: false, issues: ["glama.json is not valid JSON"] };
  }
  const issues: string[] = [];
  if (typeof parsed.$schema !== "string" || !parsed.$schema.includes("glama.ai")) {
    issues.push("glama.json missing a glama.ai $schema");
  }
  if (!Array.isArray(parsed.maintainers) || !parsed.maintainers.includes(owner)) {
    issues.push(`glama.json maintainers must include "${owner}"`);
  }
  return { ok: issues.length === 0, issues };
}

describe("Docker / Glama discoverability invariant (v3.10.0-rc.27)", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const release = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };

  it("Dockerfile invokes the real bin and release gates consume the exact Docker conclusion", () => {
    const facts = analyzeDockerfile(dockerfile);
    expect(facts.referencesBin, "Dockerfile must run dist/index.js").toBe(true);
    expect(facts.runsServe, "Dockerfile ENTRYPOINT/CMD must run `serve`").toBe(true);
    expect(releasePlatformGateProblems(ci, release, REQUIRED_RELEASE_CHECKS)).toEqual([]);

    const sourceSha = "a".repeat(40);
    const workflowRun = {
      id: 1,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      head_sha: sourceSha,
      run_attempt: 1,
      status: "completed"
    };
    const jobs = REQUIRED_RELEASE_CHECKS.map((name: string, index: number) => ({
      id: index + 1,
      name,
      status: "completed",
      conclusion: name === "docker" ? "failure" : "success",
      run_id: workflowRun.id,
      run_attempt: workflowRun.run_attempt,
      head_sha: sourceSha,
      workflow_name: workflowRun.name
    }));
    expect(evaluateReleaseChecks(jobs, workflowRun, sourceSha)).toMatchObject({
      state: "failed",
      failed: [{ name: "docker", conclusion: "failure" }]
    });
    expect(
      evaluateReleaseChecks(
        jobs.filter((job: { name: string }) => job.name !== "docker"),
        workflowRun,
        sourceSha
      )
    ).toMatchObject({
      state: "pending",
      missing: ["docker"]
    });
  });

  it("Docker build inputs are an exact closed-world source set", () => {
    const facts = analyzeDockerfile(dockerfile);
    expect(facts.copiesWholeContext, "Dockerfile must not use COPY . .").toBe(false);
    expect(facts.localCopySources.sort()).toEqual(["package-lock.json", "package.json", "src", "tsconfig.json"].sort());
    const contextPolicy = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
    expect(validateDockerContextPolicy(contextPolicy)).toEqual([]);
  });

  it("Dockerfile Node base image major >= engines.node floor (no unsupported-runtime drift)", () => {
    const floor = engineNodeMajorFloor(pkg);
    expect(floor, "package.json must declare engines.node").not.toBeNull();
    const facts = analyzeDockerfile(dockerfile);
    expect(facts.baseMajors.length, "Dockerfile must have >=1 `FROM node:<major>`").toBeGreaterThan(0);
    for (const major of facts.baseMajors) {
      expect(major, `base node:${major} is below engines.node floor ${floor}`).toBeGreaterThanOrEqual(floor as number);
    }
    expect(validateDockerBasePins(facts)).toEqual([]);
  });

  it("glama.json is valid and lists the repo owner as a maintainer", () => {
    const glama = readFileSync(path.join(repoRoot, "glama.json"), "utf8");
    const res = validateGlamaConfig(glama, OWNER);
    expect(res.ok, res.issues.join("; ")).toBe(true);
  });

  // ---- NEGATIVE controls: prove each analyzer actually detects a violation ----

  it("NEGATIVE: analyzeDockerfile flags a Dockerfile that never runs the bin or serve", () => {
    const bad = 'FROM node:22-slim\nCMD ["node", "-e", "console.log(1)"]\n';
    const facts = analyzeDockerfile(bad);
    expect(facts.referencesBin).toBe(false);
    expect(facts.runsServe).toBe(false);
  });

  it("NEGATIVE: broad COPY and a denylist context are rejected", () => {
    const facts = analyzeDockerfile("FROM node:22-slim\nCOPY . .\n");
    expect(facts.copiesWholeContext).toBe(true);
    expect(validateDockerContextPolicy("node_modules\n.git\n")).toContain(
      ".dockerignore must be the exact closed-world Docker context allowlist"
    );

    expect(
      releasePlatformGateProblems(
        ci,
        release,
        REQUIRED_RELEASE_CHECKS.filter((name: string) => name !== "docker")
      )
    ).toContain(DOCKER_RELEASE_GATE_PROBLEM);
    expect(releasePlatformGateProblems(ci, replaceUnique(release, '|docker"', '"'), REQUIRED_RELEASE_CHECKS)).toContain(
      DOCKER_RELEASE_GATE_PROBLEM
    );
    expect(
      releasePlatformGateProblems(ci, replaceUnique(release, "REQ_COUNT=13", "REQ_COUNT=12"), REQUIRED_RELEASE_CHECKS)
    ).toContain(DOCKER_RELEASE_GATE_PROBLEM);
    const releaseWithoutGate = mutateYaml(release, (document) => {
      const verify = yamlMapping(yamlMapping(document.jobs)?.verify);
      if (verify === null) throw new Error("release verify mutation fixture is missing");
      verify.steps = yamlSteps(verify).filter(
        (step) => step.name !== "Assert tag is on main and required CI checks passed"
      );
    });
    expect(releasePlatformGateProblems(ci, releaseWithoutGate, REQUIRED_RELEASE_CHECKS)).toContain(
      DOCKER_RELEASE_GATE_PROBLEM
    );
    const advisoryDocker = mutateYaml(ci, (document) => {
      const docker = yamlMapping(yamlMapping(document.jobs)?.docker);
      if (docker === null) throw new Error("docker mutation fixture is missing");
      docker["continue-on-error"] = true;
    });
    expect(releasePlatformGateProblems(advisoryDocker, release, REQUIRED_RELEASE_CHECKS)).toContain(
      DOCKER_RELEASE_GATE_PROBLEM
    );
    const detachedNpmPublish = mutateYaml(release, (document) => {
      const npmPublish = yamlMapping(yamlMapping(document.jobs)?.npm_publish);
      if (npmPublish === null) throw new Error("npm publish mutation fixture is missing");
      npmPublish.needs = [];
    });
    expect(releasePlatformGateProblems(ci, detachedNpmPublish, REQUIRED_RELEASE_CHECKS)).toContain(
      DOCKER_RELEASE_GATE_PROBLEM
    );
    const advisoryGithubRelease = mutateYaml(release, (document) => {
      const githubRelease = yamlMapping(yamlMapping(document.jobs)?.github_release);
      if (githubRelease === null) throw new Error("GitHub release mutation fixture is missing");
      githubRelease["continue-on-error"] = true;
    });
    expect(releasePlatformGateProblems(ci, advisoryGithubRelease, REQUIRED_RELEASE_CHECKS)).toContain(
      DOCKER_RELEASE_GATE_PROBLEM
    );
    const missingArchitectureAssertion = mutateYaml(ci, (document) => {
      const testMacos = yamlMapping(yamlMapping(document.jobs)?.["test-macos"]);
      if (testMacos === null) throw new Error("test-macos mutation fixture is missing");
      testMacos.steps = yamlSteps(testMacos).filter((step) => step.name !== "Assert expected runner architecture");
    });
    expect(releasePlatformGateProblems(missingArchitectureAssertion, release, REQUIRED_RELEASE_CHECKS)).toContain(
      MACOS_ARCHITECTURE_PROBLEM
    );
    const advisoryMacosConsumer = mutateYaml(ci, (document) => {
      const matrix = yamlMapping(yamlMapping(document.jobs)?.["package-consumer-matrix"]);
      const assertion = namedSteps(matrix, "Assert expected runner architecture")[0];
      if (assertion === undefined) throw new Error("package-consumer architecture mutation fixture is missing");
      assertion["continue-on-error"] = true;
    });
    expect(releasePlatformGateProblems(advisoryMacosConsumer, release, REQUIRED_RELEASE_CHECKS)).toContain(
      MACOS_ARCHITECTURE_PROBLEM
    );
  });

  it("NEGATIVE: a base image below the engines floor would fail the major-version assertion", () => {
    const stale = "FROM node:18-slim AS build\nFROM node:18-slim AS runtime\n";
    const facts = analyzeDockerfile(stale);
    const floor = engineNodeMajorFloor({ engines: { node: ">=22.13.0" } });
    expect(floor).toBe(22);
    // The real test asserts every base major >= floor; prove the stale image violates it.
    expect(facts.baseMajors.every((maj) => maj >= (floor as number))).toBe(false);

    const tagOnly = analyzeDockerfile("FROM node:22-slim AS build\nFROM node:22-slim AS runtime\n");
    expect(validateDockerBasePins(tagOnly)).toContain(DOCKER_BASE_PIN_PROBLEM);

    const differentDigest = `node:22-slim@sha256:${"0".repeat(64)}`;
    const wrong = analyzeDockerfile(`FROM ${differentDigest} AS build\nFROM ${differentDigest} AS runtime\n`);
    expect(validateDockerBasePins(wrong)).toContain(DOCKER_BASE_PIN_PROBLEM);
  });

  it("NEGATIVE: engineNodeMajorFloor returns null when engines.node is absent", () => {
    expect(engineNodeMajorFloor({})).toBeNull();
  });

  it("NEGATIVE: validateGlamaConfig rejects invalid JSON", () => {
    const res = validateGlamaConfig("{ not json", OWNER);
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toMatch(/valid JSON/);
  });

  it("NEGATIVE: validateGlamaConfig rejects a config missing the owner / $schema", () => {
    const res = validateGlamaConfig(JSON.stringify({ maintainers: ["someone-else"] }), OWNER);
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toMatch(/maintainers must include/);
    expect(res.issues.join(" ")).toMatch(/glama\.ai \$schema/);
  });
});
