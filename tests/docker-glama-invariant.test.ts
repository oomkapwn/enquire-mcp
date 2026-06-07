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
//      (b) run the `serve` subcommand, and (c) use a Node base image whose
//      major version is >= the engines.node floor in package.json. If a future
//      bump raises engines.node past the base image, the introspection image
//      would run on an unsupported runtime — this catches that.
//   2. glama.json must be valid JSON, carry a glama.ai $schema, and list the
//      repo owner as a maintainer (so Glama attributes + indexes the server).
//
// Pure analyzers (`analyzeDockerfile`, `engineNodeMajorFloor`,
// `validateGlamaConfig`) are module-local and exercised directly by the
// NEGATIVE controls with intentionally-broken input, proving each violation
// IS detected.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const OWNER = "oomkapwn";

interface DockerfileFacts {
  /** Every `FROM node:<major>...` base image major found, in order. */
  baseMajors: number[];
  /** Whether the file invokes the published bin entry (`dist/index.js`). */
  referencesBin: boolean;
  /** Whether an ENTRYPOINT/CMD exec array runs the `serve` subcommand. */
  runsServe: boolean;
}

/** Parse the facts the directory-introspection contract depends on. */
function analyzeDockerfile(text: string): DockerfileFacts {
  const baseMajors: number[] = [];
  const fromRe = /^\s*FROM\s+node:(\d+)/gim;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = fromRe.exec(text)) !== null) baseMajors.push(Number(m[1]));
  const referencesBin = /dist\/index\.js/.test(text);
  const execLines = (text.match(/^\s*(?:CMD|ENTRYPOINT)\s+\[[^\]]*\]/gim) ?? []).join(" ");
  const runsServe = /"serve"/.test(execLines);
  return { baseMajors, referencesBin, runsServe };
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
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };

  it("Dockerfile invokes the real bin and the serve subcommand", () => {
    const facts = analyzeDockerfile(dockerfile);
    expect(facts.referencesBin, "Dockerfile must run dist/index.js").toBe(true);
    expect(facts.runsServe, "Dockerfile ENTRYPOINT/CMD must run `serve`").toBe(true);
  });

  it("Dockerfile Node base image major >= engines.node floor (no unsupported-runtime drift)", () => {
    const floor = engineNodeMajorFloor(pkg);
    expect(floor, "package.json must declare engines.node").not.toBeNull();
    const facts = analyzeDockerfile(dockerfile);
    expect(facts.baseMajors.length, "Dockerfile must have >=1 `FROM node:<major>`").toBeGreaterThan(0);
    for (const major of facts.baseMajors) {
      expect(major, `base node:${major} is below engines.node floor ${floor}`).toBeGreaterThanOrEqual(floor as number);
    }
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

  it("NEGATIVE: a base image below the engines floor would fail the major-version assertion", () => {
    const stale = "FROM node:18-slim AS build\nFROM node:18-slim AS runtime\n";
    const facts = analyzeDockerfile(stale);
    const floor = engineNodeMajorFloor({ engines: { node: ">=22.13.0" } });
    expect(floor).toBe(22);
    // The real test asserts every base major >= floor; prove the stale image violates it.
    expect(facts.baseMajors.every((maj) => maj >= (floor as number))).toBe(false);
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
