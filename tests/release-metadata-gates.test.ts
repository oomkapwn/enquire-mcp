import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its pure core.
import {
  evaluateChangelogCoverage,
  parseCoverageClaims,
  validateCoverageSummary
} from "../scripts/check-changelog-coverage.mjs";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its pure core.
import { npmPackagePipelineProblems } from "../scripts/check-npm-package-pipeline.mjs";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its pure core.
import { evaluateNpmPackageCandidateRun } from "../scripts/check-release-integrity.mjs";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its pure core.
import { checkVersionConsistency } from "../scripts/check-version-consistency.mjs";
// @ts-expect-error — .mjs artifact script has no declaration file; tests exercise its pure core.
import {
  createNpmPackageArtifactManifest,
  inspectNpmTarballInventory,
  verifyNpmPackageArtifactManifest
} from "../scripts/npm-package-artifact.mjs";
// @ts-expect-error — .mjs package consumer has no declaration file; tests exercise its pure platform selector.
import {
  OPTIONAL_DEPENDENCY_PROBES,
  optionalDependencyMayBeMissing,
  packageCliProcessSpec
} from "../scripts/package-consumer.mjs";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its injected transaction core.
import { syncVersion } from "../scripts/sync-version.mjs";

const METRICS = ["lines", "statements", "functions", "branches"] as const;
const HASHED_FILES = [
  "package.json",
  "package-lock.json",
  "src/index.ts",
  "CHANGELOG.md",
  "server.json",
  "mcpb/manifest.json"
] as const;
const scratchRoots: string[] = [];

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  header.write(encoded, offset, length, "ascii");
}

interface NpmTarFixtureEntry {
  body: Buffer | string;
  mode?: number;
  path: string;
  type?: "0" | "5" | "L" | "x";
}

function npmTarballFixture(entries: ReadonlyArray<NpmTarFixtureEntry>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body, "utf8");
    const header = Buffer.alloc(512);
    header.write(`package/${entry.path}`, 0, 100, "utf8");
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, body.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(`0${suffix}`);
  while (true) {
    const nextLength = Buffer.byteLength(`${length}${suffix}`);
    if (nextLength === length) return `${length}${suffix}`;
    length = nextLength;
  }
}

function lockSource(rootVersion: string, packageVersion = rootVersion, dependencyVersion = rootVersion): string {
  return `${JSON.stringify(
    {
      name: "release-metadata-fixture",
      version: rootVersion,
      lockfileVersion: 3,
      packages: {
        "": { name: "release-metadata-fixture", version: packageVersion },
        "node_modules/sentinel": { integrity: "sha512-do-not-touch", version: dependencyVersion }
      }
    },
    null,
    2
  )}\n`;
}

async function writeFixture(options: { packageVersion?: string; surfaceVersion?: string } = {}): Promise<string> {
  const packageVersion = options.packageVersion ?? "1.2.3";
  const surfaceVersion = options.surfaceVersion ?? packageVersion;
  const root = await mkdtemp(join(tmpdir(), "enquire-release-metadata-"));
  scratchRoots.push(root);
  await Promise.all([mkdir(join(root, "src")), mkdir(join(root, "mcpb"))]);
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "release-metadata-fixture", version: packageVersion }, null, 2)}\n`
    ),
    writeFile(join(root, "package-lock.json"), lockSource(surfaceVersion)),
    writeFile(join(root, "src/index.ts"), `export const VERSION = "${surfaceVersion}";\n`),
    writeFile(join(root, "CHANGELOG.md"), `# Changelog\n\n## [${packageVersion}] — fixture\n\n- control\n`),
    writeFile(
      join(root, "server.json"),
      `${JSON.stringify({ name: "fixture", packages: [{ version: surfaceVersion }], version: surfaceVersion }, null, 2)}\n`
    ),
    writeFile(
      join(root, "mcpb/manifest.json"),
      `${JSON.stringify({ manifest_version: "0.3", name: "fixture", version: surfaceVersion }, null, 2)}\n`
    )
  ]);
  return root;
}

function validCoverageSummary(percentage = 90): Record<string, unknown> {
  return {
    total: Object.fromEntries(METRICS.map((metric) => [metric, { pct: percentage }]))
  };
}

async function fileHashes(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      HASHED_FILES.map(async (relativePath) => {
        const bytes = await readFile(join(root, relativePath));
        return [relativePath, createHash("sha256").update(bytes).digest("hex")];
      })
    )
  );
}

async function transactionArtifacts(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolutePath);
      else if (entry.name.includes(".sync-version-")) found.push(absolutePath);
    }
  }
  return found;
}

async function writePerFileCoverageFixture(): Promise<{
  firstSourcePath: string;
  root: string;
  scriptPath: string;
  summary: Record<string, Record<string, { pct: number }>>;
  summaryPath: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enquire-per-file-coverage-")));
  scratchRoots.push(root);
  await Promise.all([mkdir(join(root, "coverage")), mkdir(join(root, "scripts"))]);

  const scriptSource = await readFile(new URL("../scripts/check-per-file-coverage.mjs", import.meta.url), "utf8");
  const sourcePaths = [...scriptSource.matchAll(/^\s*"(src\/[^"\n]+\.ts)":\s*\{/gm)].map((match) => match[1]);
  const firstSourcePath = sourcePaths[0];
  if (!firstSourcePath) throw new Error("per-file coverage fixture found no FLOORS entries");

  const summary = Object.fromEntries(
    sourcePaths.map((sourcePath) => [
      join(root, sourcePath),
      {
        branches: { pct: 100 },
        functions: { pct: 100 },
        lines: { pct: 100 },
        statements: { pct: 100 }
      }
    ])
  );
  const scriptPath = join(root, "scripts/check-per-file-coverage.mjs");
  const summaryPath = join(root, "coverage/coverage-summary.json");
  await Promise.all([writeFile(scriptPath, scriptSource), writeFile(summaryPath, `${JSON.stringify(summary)}\n`)]);
  return { firstSourcePath, root, scriptPath, summary, summaryPath };
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("release metadata schema gates", () => {
  it("fails closed on missing coverage and canonical npm artifact drift", async () => {
    const fixture = await writePerFileCoverageFixture();
    const runGate = () => spawnSync(process.execPath, [fixture.scriptPath], { encoding: "utf8" });

    const control = runGate();
    expect(control.status, control.stderr).toBe(0);

    const absoluteSourcePath = join(fixture.root, fixture.firstSourcePath);
    const completeEntry = fixture.summary[absoluteSourcePath];
    if (!completeEntry) throw new Error("per-file coverage fixture lost its control entry");

    delete fixture.summary[absoluteSourcePath];
    await writeFile(fixture.summaryPath, `${JSON.stringify(fixture.summary)}\n`);
    const missingEntry = runGate();
    expect(missingEntry.status, missingEntry.stderr).toBe(1);
    expect(missingEntry.stderr).toContain(`no coverage entry for ${fixture.firstSourcePath}`);

    fixture.summary[absoluteSourcePath] = completeEntry;
    delete completeEntry.branches;
    await writeFile(fixture.summaryPath, `${JSON.stringify(fixture.summary)}\n`);
    const missingMetric = runGate();
    expect(missingMetric.status, missingMetric.stderr).toBe(1);
    expect(missingMetric.stderr).toContain(`${fixture.firstSourcePath}: no branches.pct`);

    const [ci, release, consumer, artifact] = await Promise.all([
      readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
      readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
      readFile(new URL("../scripts/package-consumer.mjs", import.meta.url), "utf8"),
      readFile(new URL("../scripts/npm-package-artifact.mjs", import.meta.url), "utf8")
    ]);
    const pipelineInputs = { artifact, ci, consumer, release };
    expect(npmPackagePipelineProblems(pipelineInputs)).toEqual([]);
    const mutateOnce = (source: string, needle: string, replacement: string): string => {
      expect(source.split(needle)).toHaveLength(2);
      return source.replace(needle, replacement);
    };
    const mutateBoundedOnce = (
      source: string,
      startMarker: string,
      endMarker: string,
      needle: string,
      replacement: string
    ): string => {
      const start = source.indexOf(startMarker);
      const end = source.indexOf(endMarker, start + startMarker.length);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const section = source.slice(start, end);
      expect(section.split(needle)).toHaveLength(2);
      return `${source.slice(0, start)}${section.replace(needle, replacement)}${source.slice(end)}`;
    };
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        ci: mutateOnce(
          ci,
          "          node scripts/package-consumer.mjs \\\n",
          "          npm pack --json --ignore-scripts\n          node scripts/package-consumer.mjs \\\n"
        )
      })
    ).toContain("all package-consumer OS lanes must consume the same explicit canonical tarball bytes");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        ci: mutateBoundedOnce(
          ci,
          "  package-consumer-matrix:\n",
          "  package-consumer:\n",
          "          - label: macos\n            os: macos-latest\n            arch: arm64\n",
          "          - label: macos\n            os: macos-latest\n            arch: x64\n"
        )
      })
    ).toContain("all package-consumer OS lanes must consume the same explicit canonical tarball bytes");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        release: mutateOnce(
          release,
          '          PACKAGE_TARBALL="$PWD/npm-package/enquire-mcp-npm.tgz"',
          '          npm pack --json --ignore-scripts\n          PACKAGE_TARBALL="$PWD/npm-package/enquire-mcp-npm.tgz"'
        )
      })
    ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        release: mutateOnce(release, 'npm-candidate "$SOURCE_SHA"', 'npm-candidate "$GITHUB_SHA"')
      })
    ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        release: mutateBoundedOnce(
          release,
          "  npm_publish:\n",
          "  github_release:\n",
          '"$ACTUAL_HANDOFF_DIGEST" != "$EXPECTED_HANDOFF_DIGEST"',
          '"$ACTUAL_HANDOFF_DIGEST" = "$EXPECTED_HANDOFF_DIGEST"'
        )
      })
    ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        release: mutateBoundedOnce(
          release,
          "  npm_publish:\n",
          "  github_release:\n",
          '--provenance --access public --tag "$CHANNEL" --ignore-scripts',
          '--provenance --access public --tag "$CHANNEL"'
        )
      })
    ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        release: mutateBoundedOnce(
          release,
          "  npm_publish:\n",
          "  github_release:\n",
          '--provenance --access public --tag "$CHANNEL" --ignore-scripts',
          '--access public --tag "$CHANNEL" --ignore-scripts'
        )
      })
    ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        release: mutateBoundedOnce(
          release,
          "  npm_publish:\n",
          "  github_release:\n",
          "NPM_CONFIG_PROVENANCE=true",
          "NPM_CONFIG_PROVENANCE=false"
        )
      })
    ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
    for (const carrier of ["NPM_ID_TOKEN", "SIGSTORE_ID_TOKEN", "GITLAB_CI"] as const) {
      for (const [needle, replacement] of [
        [`--unset=${carrier}`, ""],
        [`          ${carrier}: ''`, `          ${carrier}: inherited`]
      ] as const) {
        expect(
          npmPackagePipelineProblems({
            ...pipelineInputs,
            release: mutateBoundedOnce(release, "  npm_publish:\n", "  github_release:\n", needle, replacement)
          })
        ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
      }
    }
    for (const replacement of ["|npm_config_provenance_file)", "|npm_config_provenance)"]) {
      expect(
        npmPackagePipelineProblems({
          ...pipelineInputs,
          release: mutateBoundedOnce(
            release,
            "  npm_publish:\n",
            "  github_release:\n",
            "|npm_config_provenance|npm_config_provenance_file)",
            replacement
          )
        })
      ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
    }
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        release: mutateOnce(
          release,
          '"$ACTUAL_NPM_ARTIFACT_DIGEST" != "$PINNED_NPM_ARTIFACT_DIGEST"',
          '"$ACTUAL_NPM_ARTIFACT_DIGEST" = "$PINNED_NPM_ARTIFACT_DIGEST"'
        )
      })
    ).toContain("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        consumer: mutateOnce(
          consumer,
          'const shim = path.join(binDirectory, "enquire-mcp")',
          'const shim = path.join(packageRoot, "dist", "index.js")'
        )
      })
    ).toContain("package-consumer must execute the installed cross-platform npm bin shim");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        consumer: mutateOnce(
          consumer,
          "const loaded = await import(importSpecifier)",
          "const loaded = await Promise.resolve(importSpecifier)"
        )
      })
    ).toContain("package-consumer full lane must resolve and load every exact optional dependency");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        consumer: mutateOnce(consumer, "pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist")
      })
    ).toContain("package-consumer full lane must resolve and load every exact optional dependency");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        consumer: mutateOnce(
          consumer,
          'allowedMissingPlatforms: Object.freeze(["win32"])',
          'allowedMissingPlatforms: Object.freeze(["win32", "linux"])'
        )
      })
    ).toContain("package-consumer full lane must resolve and load every exact optional dependency");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        consumer: mutateOnce(
          consumer,
          "return probe.allowedMissingPlatforms?.includes(platform) === true;",
          "return probe.allowedMissingPlatforms !== undefined;"
        )
      })
    ).toContain("package-consumer full lane must resolve and load every exact optional dependency");
    expect(
      npmPackagePipelineProblems({
        ...pipelineInputs,
        artifact: mutateOnce(
          artifact,
          "const tarEntries = inspectNpmTarEntries(tarballBytes);",
          "const tarEntries = { directories: [], files: expectedInventory };"
        )
      })
    ).toContain("canonical receipt must bind the actual tar entries to the declared package allowlist");
    expect(packageCliProcessSpec("/fixture/consumer", "linux", {})).toMatchObject({
      args: ["--version"],
      command: join("/fixture/consumer", "node_modules", ".bin", "enquire-mcp"),
      cwd: join("/fixture/consumer", "node_modules", ".bin")
    });
    expect(packageCliProcessSpec("/fixture/consumer", "win32", { ComSpec: "cmd.exe" })).toMatchObject({
      args: ["/d", "/s", "/c", "enquire-mcp.cmd --version"],
      command: "cmd.exe",
      cwd: join("/fixture/consumer", "node_modules", ".bin")
    });
    expect(OPTIONAL_DEPENDENCY_PROBES.find(({ packageName }) => packageName === "pdfjs-dist")).toEqual({
      exportPaths: [["getDocument"]],
      packageName: "pdfjs-dist",
      specifier: "pdfjs-dist/legacy/build/pdf.mjs"
    });
    expect(OPTIONAL_DEPENDENCY_PROBES.find(({ packageName }) => packageName === "better-sqlite3")).toMatchObject({
      packageName: "better-sqlite3",
      probeKind: "sqlite-memory",
      specifier: "better-sqlite3"
    });
    const hnswProbe = OPTIONAL_DEPENDENCY_PROBES.find(({ packageName }) => packageName === "hnswlib-node");
    expect(hnswProbe).toMatchObject({ allowedMissingPlatforms: ["win32"], packageName: "hnswlib-node" });
    expect(optionalDependencyMayBeMissing(hnswProbe, "win32")).toBe(true);
    expect(optionalDependencyMayBeMissing(hnswProbe, "linux")).toBe(false);
    expect(
      OPTIONAL_DEPENDENCY_PROBES.filter((probe) => optionalDependencyMayBeMissing(probe, "win32")).map(
        ({ packageName }) => packageName
      )
    ).toEqual(["hnswlib-node"]);

    const tarballEntries = [
      { body: "{", path: "package.json" },
      { body: "x", path: "dist/index.js" }
    ];
    const tarballBytes = npmTarballFixture(tarballEntries);
    const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
    const sourcePackage = { files: ["dist"], name: "@oomkapwn/enquire-mcp", version: "1.2.3" };
    const packJson = [
      {
        id: "@oomkapwn/enquire-mcp@1.2.3",
        name: "@oomkapwn/enquire-mcp",
        version: "1.2.3",
        size: tarballBytes.length,
        unpackedSize: 2,
        shasum: "00".repeat(20),
        integrity,
        filename: "oomkapwn-enquire-mcp-1.2.3.tgz",
        files: [
          { path: "package.json", size: 1, mode: 420 },
          { path: "dist/index.js", size: 1, mode: 420 }
        ],
        entryCount: 2,
        bundled: []
      }
    ];
    const artifactContext = {
      sourceSha: "ab".repeat(20),
      runId: "123",
      runAttempt: "2"
    };
    const manifest = createNpmPackageArtifactManifest(packJson, tarballBytes, sourcePackage, artifactContext);
    expect(verifyNpmPackageArtifactManifest(manifest, tarballBytes, sourcePackage, artifactContext)).toMatchObject({
      bytes: tarballBytes.length,
      integrity,
      name: "@oomkapwn/enquire-mcp",
      version: "1.2.3"
    });
    expect(() =>
      verifyNpmPackageArtifactManifest(manifest, tarballBytes, sourcePackage, {
        ...artifactContext,
        sourceSha: "cd".repeat(20)
      })
    ).toThrow(/source SHA differs/);
    expect(() =>
      verifyNpmPackageArtifactManifest(manifest, tarballBytes, sourcePackage, {
        ...artifactContext,
        runId: "124"
      })
    ).toThrow(/run id differs/);
    expect(() =>
      verifyNpmPackageArtifactManifest(manifest, tarballBytes, sourcePackage, {
        ...artifactContext,
        runAttempt: "3"
      })
    ).toThrow(/run attempt differs/);
    expect(() =>
      verifyNpmPackageArtifactManifest(
        {
          ...manifest,
          tarball: { ...(manifest.tarball as Record<string, unknown>), sha256: "00".repeat(32) }
        },
        tarballBytes,
        sourcePackage,
        artifactContext
      )
    ).toThrow(/SHA-256 differs/);
    const undeclaredTarballBytes = npmTarballFixture([...tarballEntries, { body: "y", path: "dist/undeclared.js" }]);
    const undeclaredPackJson = structuredClone(packJson);
    const undeclaredMetadata = undeclaredPackJson[0];
    if (!undeclaredMetadata) throw new Error("npm tar fixture lost its metadata record");
    undeclaredMetadata.size = undeclaredTarballBytes.length;
    undeclaredMetadata.integrity = `sha512-${createHash("sha512").update(undeclaredTarballBytes).digest("base64")}`;
    expect(() =>
      createNpmPackageArtifactManifest(undeclaredPackJson, undeclaredTarballBytes, sourcePackage, artifactContext)
    ).toThrow(/actual npm tarball inventory differs from declared file metadata/);

    const canonicalPaxPath = paxRecord("path", "package/dist/index.js");
    expect(
      inspectNpmTarballInventory(
        npmTarballFixture([
          { body: "{", path: "package.json" },
          { body: canonicalPaxPath, path: "PaxHeaders/index", type: "x" },
          { body: "x", path: "placeholder" }
        ])
      )
    ).toEqual([
      { mode: 420, path: "dist/index.js", size: 1 },
      { mode: 420, path: "package.json", size: 1 }
    ]);

    const firstLongPath = Buffer.from("package/dist/first.js\0", "utf8");
    const secondLongPath = Buffer.from("package/dist/second.js\0", "utf8");
    const repeatedPathOverrides: ReadonlyArray<ReadonlyArray<NpmTarFixtureEntry>> = [
      [
        { body: paxRecord("path", "package/dist/first.js"), path: "PaxHeaders/first", type: "x" },
        { body: paxRecord("path", "package/dist/second.js"), path: "PaxHeaders/second", type: "x" }
      ],
      [
        { body: firstLongPath, path: "LongLink/first", type: "L" },
        { body: secondLongPath, path: "LongLink/second", type: "L" }
      ],
      [
        { body: paxRecord("path", "package/dist/first.js"), path: "PaxHeaders/first", type: "x" },
        { body: secondLongPath, path: "LongLink/second", type: "L" }
      ],
      [
        { body: firstLongPath, path: "LongLink/first", type: "L" },
        { body: paxRecord("path", "package/dist/second.js"), path: "PaxHeaders/second", type: "x" }
      ]
    ];
    for (const repeatedPathOverride of repeatedPathOverrides) {
      expect(() => inspectNpmTarballInventory(npmTarballFixture(repeatedPathOverride))).toThrow(
        /repeats a pending path override/
      );
    }

    for (const invalidPaxBody of [paxRecord("mtime", "0"), `${canonicalPaxPath}${paxRecord("mtime", "0")}`]) {
      expect(() =>
        inspectNpmTarballInventory(npmTarballFixture([{ body: invalidPaxBody, path: "PaxHeaders/index", type: "x" }]))
      ).toThrow(/only one canonical path record/);
    }
    expect(() =>
      inspectNpmTarballInventory(
        npmTarballFixture([
          {
            body: `${canonicalPaxPath}${paxRecord("path", "package/dist/other.js")}`,
            path: "PaxHeaders/index",
            type: "x"
          }
        ])
      )
    ).toThrow(/repeats path/);
    expect(() =>
      inspectNpmTarballInventory(npmTarballFixture([{ body: "", path: "PaxHeaders/index", type: "x" }]))
    ).toThrow(/exactly one canonical path record/);

    const nonemptyDirectoryBytes = npmTarballFixture([
      ...tarballEntries,
      { body: "payload", path: "dist/", type: "5" }
    ]);
    const nonemptyDirectoryIntegrity = `sha512-${createHash("sha512").update(nonemptyDirectoryBytes).digest("base64")}`;
    const nonemptyDirectoryManifest = {
      ...manifest,
      tarball: {
        ...(manifest.tarball as Record<string, unknown>),
        bytes: nonemptyDirectoryBytes.length,
        integrity: nonemptyDirectoryIntegrity,
        sha256: createHash("sha256").update(nonemptyDirectoryBytes).digest("hex")
      }
    };
    expect(() =>
      verifyNpmPackageArtifactManifest(
        nonemptyDirectoryManifest,
        nonemptyDirectoryBytes,
        sourcePackage,
        artifactContext
      )
    ).toThrow(/directory entry .* empty payload/);

    expect(() =>
      inspectNpmTarballInventory(
        npmTarballFixture([
          { body: "x", path: "dist" },
          { body: "y", path: "dist/index.js" }
        ])
      )
    ).toThrow(/uses file dist as an ancestor of dist\/index\.js/);
    expect(() =>
      inspectNpmTarballInventory(
        npmTarballFixture([
          { body: "x", path: "dist/Foo.js" },
          { body: "y", path: "dist/foo.js" }
        ])
      )
    ).toThrow(/ambiguous normalized entries dist\/Foo\.js and dist\/foo\.js/);
    expect(() =>
      inspectNpmTarballInventory(
        npmTarballFixture([
          { body: "x", path: "Dist" },
          { body: "", path: "dist/sub/", type: "5" }
        ])
      )
    ).toThrow(/uses file Dist as an ancestor of dist\/sub/);

    const candidateRun = {
      id: 123,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      head_sha: artifactContext.sourceSha,
      run_attempt: 2,
      status: "completed"
    };
    const candidateJob = (name: string, id: number, runAttempt: number) => ({
      id,
      name,
      status: "completed",
      conclusion: "success",
      started_at: `2026-08-21T00:00:0${id}Z`,
      run_id: candidateRun.id,
      run_attempt: runAttempt,
      head_sha: artifactContext.sourceSha,
      workflow_name: "CI"
    });
    const artifactDigest = `sha256:${"ab".repeat(32)}`;
    const npmCandidate = {
      workflowRun: candidateRun,
      expectedSourceSha: artifactContext.sourceSha,
      jobs: [candidateJob("npm-package", 1, 1), candidateJob("package-consumer", 2, 2)],
      artifacts: [{ name: "npm-package-candidate-1", expired: false, id: 44, digest: artifactDigest }]
    };
    expect(evaluateNpmPackageCandidateRun(npmCandidate)).toEqual({
      state: "selected",
      artifactId: "44",
      digest: artifactDigest,
      runAttempt: 1
    });
    expect(() => evaluateNpmPackageCandidateRun({ ...npmCandidate, pinnedRunAttempt: "2" })).toThrow(
      /producer attempt/
    );
    expect(() => evaluateNpmPackageCandidateRun({ ...npmCandidate, pinnedArtifactId: "45" })).toThrow(/artifact id/);
    expect(() =>
      evaluateNpmPackageCandidateRun({ ...npmCandidate, pinnedDigest: `sha256:${"cd".repeat(32)}` })
    ).toThrow(/artifact digest/);
  });

  it("loads the reviewed Node PDF.js entrypoint and rejects the browser-oriented root", () => {
    const legacy = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); console.log(typeof pdfjs.getDocument);'
      ],
      { encoding: "utf8" }
    );
    expect({ status: legacy.status, stderr: legacy.stderr, stdout: legacy.stdout.trim() }).toEqual({
      status: 0,
      stderr: "",
      stdout: "function"
    });

    const browserBuild = spawnSync(process.execPath, ["--input-type=module", "--eval", 'await import("pdfjs-dist");'], {
      encoding: "utf8"
    });
    expect(browserBuild.status).not.toBe(0);
    expect(browserBuild.stderr).toContain("DOMMatrix is not defined");
  });

  it("accepts eight canonical version surfaces and rejects drift", async () => {
    const root = await writeFixture();
    expect(await checkVersionConsistency(root)).toMatchObject({ ok: true, surfaceCount: 8, version: "1.2.3" });

    await writeFile(join(root, "server.json"), '{"version":"1.2.4","packages":[{"version":"1.2.3"}]}\n');
    const drift = await checkVersionConsistency(root);
    expect(drift.ok).toBe(false);
    expect(drift.errors.join("\n")).toContain("Version drift across published surfaces");
  });

  it("rejects missing, wrong-type, non-canonical, and duplicate surfaces before equality", async () => {
    const cases: { name: string; mutate: (root: string) => Promise<void>; expected: RegExp }[] = [
      {
        name: "all missing",
        expected: /missing|parent must be an object/,
        mutate: async (root) => {
          await Promise.all([
            writeFile(join(root, "package.json"), "{}\n"),
            writeFile(join(root, "package-lock.json"), '{"packages":{"":{}}}\n'),
            writeFile(join(root, "src/index.ts"), "export const OTHER = 1;\n"),
            writeFile(join(root, "CHANGELOG.md"), "# Changelog\n"),
            writeFile(join(root, "server.json"), '{"packages":[{}]}\n'),
            writeFile(join(root, "mcpb/manifest.json"), "{}\n")
          ]);
        }
      },
      {
        name: "wrong type",
        expected: /expected a string|direct double-quoted string literal/,
        mutate: async (root) => {
          await Promise.all([
            writeFile(join(root, "package.json"), '{"version":7}\n'),
            writeFile(join(root, "package-lock.json"), '{"version":7,"packages":{"":{"version":7}}}\n'),
            writeFile(join(root, "src/index.ts"), "export const VERSION = 7;\n"),
            writeFile(join(root, "CHANGELOG.md"), "## [7]\n"),
            writeFile(join(root, "server.json"), '{"version":7,"packages":[{"version":7}]}\n'),
            writeFile(join(root, "mcpb/manifest.json"), '{"version":7}\n')
          ]);
        }
      },
      {
        name: "non-canonical equal values",
        expected: /non-canonical SemVer/,
        mutate: async (root) => {
          const version = "01.2.3";
          await Promise.all([
            writeFile(join(root, "package.json"), `{"version":"${version}"}\n`),
            writeFile(
              join(root, "package-lock.json"),
              `{"version":"${version}","packages":{"":{"version":"${version}"}}}\n`
            ),
            writeFile(join(root, "src/index.ts"), `export const VERSION = "${version}";\n`),
            writeFile(join(root, "CHANGELOG.md"), `## [${version}]\n`),
            writeFile(join(root, "server.json"), `{"version":"${version}","packages":[{"version":"${version}"}]}\n`),
            writeFile(join(root, "mcpb/manifest.json"), `{"version":"${version}"}\n`)
          ]);
        }
      },
      {
        name: "duplicate JSON key",
        expected: /duplicate object key "version"/,
        mutate: (root) => writeFile(join(root, "package.json"), '{"version":"1.2.3","version":"1.2.3"}\n')
      },
      {
        name: "duplicate VERSION declaration",
        expected: /duplicated \(2 declarations\)/,
        mutate: (root) =>
          writeFile(join(root, "src/index.ts"), 'export const VERSION = "1.2.3";\nconst VERSION = "1.2.3";\n')
      },
      {
        name: "duplicate latest changelog heading",
        expected: /duplicated \(2 headings/,
        mutate: (root) => writeFile(join(root, "CHANGELOG.md"), "## [1.2.3]\n\n## [1.2.3]\n")
      }
    ];

    for (const testCase of cases) {
      const root = await writeFixture();
      await testCase.mutate(root);
      const result = await checkVersionConsistency(root);
      expect(result.ok, testCase.name).toBe(false);
      expect(result.errors.join("\n"), testCase.name).toMatch(testCase.expected);
      expect(result.errors.join("\n"), `${testCase.name} must fail schema before equality`).not.toContain(
        "Version drift across published surfaces"
      );
    }
  });

  it("requires every coverage pct to be a finite numeric value within 0..100", () => {
    expect(validateCoverageSummary(validCoverageSummary(0))).toMatchObject({
      branches: 0,
      functions: 0,
      lines: 0,
      statements: 0
    });
    expect(validateCoverageSummary(validCoverageSummary(100))).toMatchObject({
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    });

    for (const metric of METRICS) {
      for (const invalid of [undefined, "90", Number.NaN, Number.POSITIVE_INFINITY, -0.01, 100.01]) {
        const summary = validCoverageSummary();
        const total = summary.total as Record<string, { pct?: unknown }>;
        if (invalid === undefined) delete total[metric]?.pct;
        else if (total[metric]) total[metric].pct = invalid;
        expect(() => validateCoverageSummary(summary), `${metric}=${String(invalid)}`).toThrow();
      }
    }
  });

  it("accepts one genuine claim per metric but rejects duplicate and malformed claims", () => {
    const control = evaluateChangelogCoverage(
      validCoverageSummary(90),
      "## [1.2.3]\n\nlines 90% · statements 90% · functions 90% · branches 90%\n"
    );
    expect(control.errors).toEqual([]);
    expect(control.claims.size).toBe(4);

    expect(() => parseCoverageClaims("## [1.2.3]\nlines 90%\nlines 90%\n")).toThrow(/duplicated/);
    expect(() => parseCoverageClaims("## [1.2.3]\nbranches 101%\n")).toThrow(/within 0\.\.100/);
    expect(() => parseCoverageClaims("## [1.2.3]\nfunctions NaN%\n")).toThrow(/non-canonical percentage/);
  });
});

describe("sync-version transaction", () => {
  it("updates only owned version leaves and never re-resolves the lockfile", async () => {
    const root = await writeFixture({ packageVersion: "2.0.0", surfaceVersion: "1.9.9" });
    const packageHash = (await fileHashes(root))["package.json"];
    const changelogHash = (await fileHashes(root))["CHANGELOG.md"];
    const result = await syncVersion({ repoRoot: root });

    expect(result.changedFiles).toEqual(["src/index.ts", "server.json", "mcpb/manifest.json", "package-lock.json"]);
    expect(await readFile(join(root, "package-lock.json"), "utf8")).toBe(lockSource("2.0.0", "2.0.0", "1.9.9"));
    expect((await fileHashes(root))["package.json"]).toBe(packageHash);
    expect((await fileHashes(root))["CHANGELOG.md"]).toBe(changelogHash);
    expect(await checkVersionConsistency(root)).toMatchObject({ ok: true, version: "2.0.0" });
    expect(await transactionArtifacts(root)).toEqual([]);

    const source = await readFile(new URL("../scripts/sync-version.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:child_process|execFile|npm\s+install|package-lock-only/);
  });

  it("does not write anything when preflight validation fails", async () => {
    const root = await writeFixture({ packageVersion: "2.0.0", surfaceVersion: "1.9.9" });
    await writeFile(join(root, "mcpb/manifest.json"), '{"name":"fixture","version":3}\n');
    const before = await fileHashes(root);

    await expect(syncVersion({ repoRoot: root })).rejects.toThrow(/version must be a string/);
    expect(await fileHashes(root)).toEqual(before);
    expect(await transactionArtifacts(root)).toEqual([]);
  });

  it("rolls every file back byte-for-byte after a late injected publish failure", async () => {
    const root = await writeFixture({ packageVersion: "2.0.0", surfaceVersion: "1.9.9" });
    const before = await fileHashes(root);

    await expect(
      syncVersion({
        afterPublish: ({ publishedCount }: { publishedCount: number }) => {
          if (publishedCount === 4) throw new Error("injected late publish failure");
        },
        repoRoot: root
      })
    ).rejects.toThrow("injected late publish failure");

    expect(await fileHashes(root)).toEqual(before);
    expect(await transactionArtifacts(root)).toEqual([]);
  });
});
