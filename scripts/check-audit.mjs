#!/usr/bin/env node
// v3.10.0-rc.50 — scoped `npm audit` gate (replaces the bare `npm audit --audit-level`
// calls in package.json#prepublishOnly + ci.yml + release.yml).
//
// WHY: a bare `npm audit --audit-level=moderate` cannot allow a single, documented,
// can't-fix-yet advisory without lowering the bar for EVERYTHING. This wrapper keeps the
// exact same thresholds (prod ≥ moderate, dev ≥ high), audits both the source checkout
// and the graph a registry consumer resolves, and fails on every advisory EXCEPT the
// ones in the scope-specific allowlists below. A NEW advisory still fails CI.
//
// This is the project's documented-rejection pattern (CHANGELOG, since v3.5.14) applied
// to supply-chain: accept with reasoning, in a visible, reviewable place, not by
// weakening the gate.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Resolve a cross-platform executable spec for npm. Prefer the npm CLI
 * JavaScript entrypoint exposed to npm lifecycle scripts so paths containing
 * Windows shell metacharacters never pass through `cmd.exe`.
 *
 * @param {NodeJS.Platform} platform - Target platform.
 * @param {NodeJS.ProcessEnv} env - Process environment.
 * @param {string} execPath - Current Node executable.
 * @returns {{command:string,argsPrefix:string[]}} Executable and fixed argv prefix.
 */
export function npmProcessSpec(platform = process.platform, env = process.env, execPath = process.execPath) {
  if (typeof env.npm_execpath === "string" && env.npm_execpath.length > 0) {
    return { command: execPath, argsPrefix: [env.npm_execpath] };
  }
  if (platform === "win32") {
    throw new Error("npm CLI path unavailable on Windows; run this gate through `npm run check:audit`");
  }
  return { command: "npm", argsPrefix: [] };
}

/**
 * Advisories accepted with reasoning. Keyed by GHSA id. Removing an entry re-arms the
 * gate for that advisory; adding one REQUIRES a rationale + a path to resolution.
 */
export const ALLOWLIST = {
  // v3.10.0-rc.53 — GHSA-h67p-54hq-rp68 (js-yaml merge-key DoS, accepted rc.50) is now
  // RESOLVED, not allowlisted: gray-matter was dropped (it pinned the vulnerable js-yaml@3)
  // and frontmatter parsing migrated to js-yaml@4.2.0 (see src/frontmatter.ts). The tree
  // no longer contains a vulnerable js-yaml, so the entry was removed and the gate re-armed.
  // Empty = the strictest posture; add a GHSA here ONLY with a rationale + resolution path.
};

/**
 * Temporary exceptions that apply only to the dependency graph a registry
 * consumer resolves. npm ignores an installed package's `overrides`, so this
 * list is intentionally separate from the empty source-tree allowlist above.
 * Every entry must name the unreachable surface and an upstream removal trigger.
 */
export const CONSUMER_ALLOWLIST = {
  "GHSA-xcpc-8h2w-3j85":
    "transformers 4.2.0 pins onnxruntime-node 1.24.3, whose adm-zip ^0.5.16 cannot admit patched 0.6.0; enquire never accepts or extracts caller-supplied ZIP archives. Remove when https://github.com/huggingface/transformers.js/issues/1727 resolves upstream.",
  "GHSA-f88m-g3jw-g9cj":
    "transformers 4.2.0 pins sharp ^0.34.5, below patched 0.35.0; enquire uses text-only embedding/reranking and never invokes sharp's image/libvips path. Remove with the next transformers release tracked by https://github.com/huggingface/transformers.js/issues/1729."
};

const SEV_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const AUDIT_RETRY_ATTEMPTS = 3;
const AUDIT_RETRY_BACKOFF_MS = 5_000;
const RETRYABLE_AUDIT_CODES = new Set([
  "E408",
  "E425",
  "E429",
  "E500",
  "E502",
  "E503",
  "E504",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT"
]);
const RETRYABLE_AUDIT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SAFE_AUDIT_CODE = /^[A-Z][A-Z0-9_]{0,31}$/u;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAuditStatus(value) {
  if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^[1-5]\d\d$/u.test(value)) return Number(value);
  return undefined;
}

function auditErrorFields(value) {
  if (!isRecord(value)) return undefined;
  const nestedError = isRecord(value.error) ? value.error : undefined;
  const rawCode = nestedError?.code ?? value.code;
  const code = typeof rawCode === "string" && SAFE_AUDIT_CODE.test(rawCode) ? rawCode : undefined;
  const statusCode = normalizeAuditStatus(
    nestedError?.statusCode ?? nestedError?.status ?? value.statusCode ?? value.status
  );
  return { code, statusCode };
}

function auditErrorDiagnostic(value) {
  const fields = auditErrorFields(value);
  if (!fields) return undefined;
  const parts = [fields.code ? `code=${fields.code}` : "", fields.statusCode ? `status=${fields.statusCode}` : ""];
  const diagnostic = parts.filter(Boolean).join(" ");
  if (diagnostic) return diagnostic;
  return Object.hasOwn(value, "error") ? "structured-error" : undefined;
}

/**
 * Identify only an explicit transient npm registry/transport error payload.
 * Report-shaped, contradictory, permanent and unknown payloads are never
 * retried. npm's own JSON audit-error renderer emits a top-level
 * `statusCode`; some transport paths instead expose a normalized error code.
 *
 * @param {unknown} value - Parsed `npm audit --json` payload.
 * @returns {{code?:string,statusCode?:number}|undefined} Safe retry signal.
 * @example
 * retryableAuditError({ statusCode: 503 }); // { statusCode: 503 }
 */
export function retryableAuditError(value) {
  if (
    !isRecord(value) ||
    Object.hasOwn(value, "auditReportVersion") ||
    Object.hasOwn(value, "vulnerabilities") ||
    Object.hasOwn(value, "metadata")
  ) {
    return undefined;
  }
  const fields = auditErrorFields(value);
  if (!fields || (!fields.code && fields.statusCode === undefined)) return undefined;

  const statusFromCode =
    fields.code && /^E([1-5]\d\d)$/u.test(fields.code) ? Number(fields.code.slice(1)) : undefined;
  if (
    statusFromCode !== undefined &&
    fields.statusCode !== undefined &&
    statusFromCode !== fields.statusCode
  ) {
    return undefined;
  }
  if (fields.statusCode !== undefined && !RETRYABLE_AUDIT_STATUSES.has(fields.statusCode)) {
    return undefined;
  }

  const retryableCode = fields.code ? RETRYABLE_AUDIT_CODES.has(fields.code) : false;
  const retryableStatus =
    fields.statusCode !== undefined && RETRYABLE_AUDIT_STATUSES.has(fields.statusCode);
  if (fields.code && !retryableCode) return undefined;
  return retryableCode || retryableStatus ? fields : undefined;
}

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function advisoryTraceRank(packageName, vulnerabilities, visiting = new Set()) {
  if (visiting.has(packageName)) return undefined;
  const vulnerability = vulnerabilities[packageName];
  if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
    return undefined;
  }
  const nextVisiting = new Set(visiting).add(packageName);
  let maximum = -1;
  for (const via of vulnerability.via) {
    const rank = isRecord(via)
      ? SEV_RANK[via.severity]
      : typeof via === "string" && Object.hasOwn(vulnerabilities, via)
        ? advisoryTraceRank(via, vulnerabilities, nextVisiting)
        : undefined;
    if (rank === undefined) return undefined;
    maximum = Math.max(maximum, rank);
  }
  return maximum >= 0 ? maximum : undefined;
}

/**
 * Pure core — given an `npm audit --json` payload, return the distinct advisories at or
 * above `minSeverity` that are NOT allowlisted. Exported so the test can prove the gate
 * isn't vacuous (a real advisory id fails; the allowlisted id passes).
 * @param {object} auditJson - parsed `npm audit --json`
 * @param {{minSeverity: keyof typeof SEV_RANK, allowlist: Record<string,string>}} opts
 * @returns {Array<{id:string, severity:string, title:string, module:string}>}
 */
export function offendingAdvisories(auditJson, { minSeverity, allowlist }) {
  const floor = SEV_RANK[minSeverity] ?? 2;
  const found = new Map();
  for (const [pkg, v] of Object.entries(auditJson?.vulnerabilities ?? {})) {
    for (const via of v?.via ?? []) {
      if (via && typeof via === "object") {
        const url = typeof via.url === "string" ? via.url : "";
        const ghsa = /GHSA-[\w-]+/.exec(url)?.[0];
        const source =
          typeof via.source === "number" || typeof via.source === "string" ? `npm:${via.source}` : undefined;
        // GHSA is the stable allowlist key when present. A future non-GHSA npm
        // advisory must still fail closed instead of disappearing from the gate.
        const id = ghsa ?? source ?? (url ? `url:${url}` : `unidentified:${pkg}:${via.title ?? "advisory"}`);
        const sev = typeof (via.severity ?? v.severity) === "string" ? (via.severity ?? v.severity) : "unknown";
        const rank = SEV_RANK[sev];
        // Unknown future severities fail closed. Known severities below the
        // configured floor retain the existing scoped behavior.
        if (rank !== undefined && rank < floor) continue;
        found.set(id, { id, severity: sev, title: via.title ?? "", module: via.name ?? pkg });
      }
    }
  }
  return [...found.values()].filter((a) => !allowlist[a.id]);
}

/**
 * Reject npm error payloads and malformed/truncated output before advisory
 * extraction. npm may exit non-zero with JSON for either real findings or a
 * registry/network failure; only an audit report is safe to inspect.
 *
 * @param {unknown} value - Parsed npm JSON output.
 * @returns {object} Valid npm audit report.
 */
export function validateAuditReport(value) {
  if (
    !isRecord(value) ||
    value.auditReportVersion !== 2 ||
    Object.hasOwn(value, "error") ||
    !isRecord(value.vulnerabilities) ||
    !isRecord(value.metadata) ||
    !isRecord(value.metadata.vulnerabilities)
  ) {
    const diagnostic = auditErrorDiagnostic(value);
    const suffix = diagnostic ? ` (${diagnostic})` : "";
    throw new Error(`npm audit returned an error or malformed report${suffix}; refusing to treat it as clean`);
  }
  const vulnerabilityNames = Object.keys(value.vulnerabilities);
  const severityCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  let traceIsValid = true;
  for (const name of vulnerabilityNames) {
    const vulnerability = value.vulnerabilities[name];
    const declaredRank = isRecord(vulnerability) ? SEV_RANK[vulnerability.severity] : undefined;
    if (declaredRank === undefined || advisoryTraceRank(name, value.vulnerabilities) !== declaredRank) {
      traceIsValid = false;
      break;
    }
    severityCounts[vulnerability.severity] += 1;
  }
  const metadataMatches =
    Number.isInteger(value.metadata.vulnerabilities.total) &&
    value.metadata.vulnerabilities.total === vulnerabilityNames.length &&
    Object.entries(severityCounts).every(([severity, count]) => value.metadata.vulnerabilities[severity] === count);
  if (!traceIsValid || !metadataMatches) {
    throw new Error("npm audit returned an incomplete advisory trace; refusing to treat it as clean");
  }
  return value;
}

/**
 * Validate an npm audit report, retrying only narrowly recognized transient
 * registry/transport payloads. Invalid JSON, schema drift, real reports and
 * permanent/unknown errors are evaluated once and fail closed.
 *
 * @param {() => unknown} attempt - Produce one already-parsed npm payload.
 * @param {object} options - Retry controls; injection points keep tests fast.
 * @param {number} [options.attempts=3] - Maximum payload attempts.
 * @param {number} [options.backoffMs=5000] - Linear backoff unit.
 * @param {(ms:number) => void} [options.sleep] - Synchronous delay function.
 * @param {(event:object) => void} [options.onRetry] - Sanitized retry observer.
 * @param {string} [options.label="audit"] - Fixed non-secret scope label.
 * @returns {object} A validated npm audit report.
 * @example
 * validateAuditReportWithRetry(() => cleanReport, { attempts: 1 });
 */
export function validateAuditReportWithRetry(
  attempt,
  {
    attempts = AUDIT_RETRY_ATTEMPTS,
    backoffMs = AUDIT_RETRY_BACKOFF_MS,
    sleep = sleepMs,
    onRetry = () => {},
    label = "audit"
  } = {}
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("npm audit retry attempts must be a positive integer");
  }
  for (let number = 1; number <= attempts; number++) {
    const value = attempt();
    const transient = retryableAuditError(value);
    if (!transient) return validateAuditReport(value);

    const diagnostic = auditErrorDiagnostic(value) ?? "transient-error";
    if (number === attempts) {
      throw new Error(
        `npm audit ${label} returned a retryable registry/transport error after ${attempts} attempts ` +
          `(${diagnostic}); refusing to treat it as clean`
      );
    }
    const delayMs = backoffMs * number;
    onRetry({ number, attempts, delayMs, diagnostic });
    sleep(delayMs);
  }
  throw new Error("unreachable npm audit retry state");
}

/**
 * Build a clean consumer manifest that installs the actual packed artifact.
 * All resolution-affecting fields come from that tarball's package.json;
 * the consumer root contributes no overrides.
 *
 * @param {string} packageName - Name reported by `npm pack --json`.
 * @param {string} tarballSpec - Absolute file: URL for the tarball.
 * @returns {object} A private clean-consumer manifest.
 */
export function packedConsumerManifest(packageName, tarballSpec) {
  return {
    name: "enquire-mcp-published-consumer-audit",
    version: "0.0.0",
    private: true,
    dependencies: { [packageName]: tarballSpec }
  };
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Resolve the npm dist-tag from a strict SemVer package version.
 *
 * A prerelease identifier named `latest` is rejected rather than allowed to
 * alias npm's stable channel. The release workflow imports this same resolver,
 * keeping publication routing and consumer-exception policy in one semantic
 * space.
 *
 * @param {string} version - Packed or source package version.
 * @returns {string} `latest` for stable versions, otherwise the first prerelease identifier.
 */
export function releaseChannelForVersion(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`invalid package version in packed artifact: ${version}`);
  const prerelease = match[4];
  if (!prerelease) return "latest";
  const channel = prerelease.split(".")[0];
  if (channel === "latest") {
    throw new Error(`prerelease version cannot target the stable npm channel: ${version}`);
  }
  return channel;
}

/**
 * Consumer exceptions are permitted only on the explicit `rc` prerelease
 * channel. Stable versions and other prerelease channels receive an empty
 * effective allowlist, so neither a version bump nor a dist-tag-shaped
 * prerelease can promote a known advisory to npm `latest`.
 *
 * @param {string} version - Packed package version.
 * @param {Record<string,string>} allowlist - Configured RC-only exceptions.
 * @returns {Record<string,string>} Effective allowlist for this release channel.
 */
export function consumerAllowlistForVersion(version, allowlist) {
  return releaseChannelForVersion(version) === "rc" ? allowlist : {};
}

/**
 * Find exceptions whose advisory has disappeared from the resolved graph.
 *
 * @param {Array<{id:string}>} advisories - Current thresholded advisories.
 * @param {Record<string,string>} allowlist - Expected temporary exceptions.
 * @returns {string[]} Stale GHSA ids that must be removed.
 */
export function staleAllowlistEntries(advisories, allowlist) {
  const observed = new Set(advisories.map((advisory) => advisory.id));
  return Object.keys(allowlist).filter((id) => !observed.has(id));
}

/**
 * Find exceptions missing either a removal instruction or upstream tracker URL.
 *
 * @param {Record<string,string>} allowlist - Temporary exception policy.
 * @returns {string[]} Invalid GHSA ids.
 */
export function invalidAllowlistEntries(allowlist) {
  return Object.entries(allowlist)
    .filter(([, reason]) => {
      const hasRemovalInstruction = /\bRemove\b/.test(reason);
      const hasGitHubIssue = (reason.match(/https:\/\/\S+/g) ?? []).some((candidate) => {
        try {
          const tracker = new URL(candidate.replace(/[),.;]+$/, ""));
          const segments = tracker.pathname.split("/").filter(Boolean);
          return (
            tracker.origin === "https://github.com" &&
            tracker.username === "" &&
            tracker.password === "" &&
            segments.length === 4 &&
            segments[2] === "issues" &&
            /^\d+$/.test(segments[3] ?? "")
          );
        } catch {
          return false;
        }
      });
      return !hasRemovalInstruction || !hasGitHubIssue;
    })
    .map(([id]) => id);
}

function runNpm(args, options) {
  const { command, argsPrefix } = npmProcessSpec();
  return execFileSync(command, [...argsPrefix, ...args], {
    ...options,
    // `npm publish --dry-run` exports npm_config_dry_run=true to child
    // processes. The audit's throwaway pack/install must still materialize.
    env: { ...process.env, ...options?.env, npm_config_dry_run: "false" }
  });
}

function readAuditPayload(scopeFlag, cwd) {
  let output;
  try {
    output = runNpm(["audit", scopeFlag, "--json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (err) {
    // npm audit exits non-zero when vulns exist; the JSON is still on stdout.
    output = err?.stdout?.toString() ?? "";
    if (!output.trim()) throw new Error(`npm audit produced no JSON: ${err?.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    throw new Error(`npm audit produced invalid JSON: ${err?.message ?? err}`);
  }
  return parsed;
}

function runAudit(scopeFlag, cwd = REPO_ROOT, label = "audit") {
  return validateAuditReportWithRetry(() => readAuditPayload(scopeFlag, cwd), {
    label,
    onRetry: ({ number, attempts, delayMs, diagnostic }) => {
      console.error(
        `[check-audit] WARN — ${label} ${diagnostic}; retrying after ${delayMs} ms (${number}/${attempts})`
      );
    }
  });
}

function runPublishedConsumerAudit() {
  const dir = mkdtempSync(path.join(tmpdir(), "enquire-consumer-audit-"));
  try {
    const packed = JSON.parse(
      runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", dir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    )?.[0];
    if (
      !packed ||
      typeof packed.name !== "string" ||
      typeof packed.version !== "string" ||
      typeof packed.filename !== "string" ||
      path.basename(packed.filename) !== packed.filename ||
      !packed.filename.endsWith(".tgz")
    ) {
      throw new Error("npm pack returned an invalid artifact description");
    }
    const tarballPath = path.join(dir, packed.filename);
    const consumerDir = path.join(dir, "consumer");
    mkdirSync(consumerDir);
    writeFileSync(
      path.join(consumerDir, "package.json"),
      `${JSON.stringify(packedConsumerManifest(packed.name, pathToFileURL(tarballPath).href), null, 2)}\n`
    );
    runNpm(["install", "--package-lock-only", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: consumerDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { audit: runAudit("--omit=dev", consumerDir, "published-consumer"), version: packed.version };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isEntrypoint(import.meta.url)) {
  // Same thresholds as the bare gate this replaces: prod ≥ moderate, dev ≥ high.
  const prodAudit = runAudit("--omit=dev", REPO_ROOT, "source-prod");
  const devAudit = runAudit("--include=dev", REPO_ROOT, "source-dev");
  const prodAll = offendingAdvisories(prodAudit, { minSeverity: "moderate", allowlist: {} });
  const devAll = offendingAdvisories(devAudit, { minSeverity: "high", allowlist: {} });
  const prod = offendingAdvisories(prodAudit, { minSeverity: "moderate", allowlist: ALLOWLIST });
  const dev = offendingAdvisories(devAudit, { minSeverity: "high", allowlist: ALLOWLIST });
  const { audit: consumerAudit, version: consumerVersion } = runPublishedConsumerAudit();
  const consumerAll = offendingAdvisories(consumerAudit, { minSeverity: "moderate", allowlist: {} });
  const effectiveConsumerAllowlist = consumerAllowlistForVersion(consumerVersion, CONSUMER_ALLOWLIST);
  const consumer = offendingAdvisories(consumerAudit, {
    minSeverity: "moderate",
    allowlist: effectiveConsumerAllowlist
  });
  const offenders = [...new Map([...prod, ...dev, ...consumer].map((a) => [a.id, a])).values()];
  const allowed = Object.keys(effectiveConsumerAllowlist);
  const sourceAll = [...new Map([...prodAll, ...devAll].map((a) => [a.id, a])).values()];
  const staleSourceAllowlist = staleAllowlistEntries(sourceAll, ALLOWLIST);
  const staleConsumerAllowlist = staleAllowlistEntries(consumerAll, CONSUMER_ALLOWLIST);
  const invalidSourceAllowlist = invalidAllowlistEntries(ALLOWLIST);
  const invalidConsumerAllowlist = invalidAllowlistEntries(CONSUMER_ALLOWLIST);
  if (offenders.length > 0) {
    console.error("[check-audit] FAIL — advisories not in the documented allowlist:");
    for (const a of offenders) console.error(`  ${a.id} (${a.severity}) ${a.module} — ${a.title}`);
    console.error(
      "\nFix the dependency, or add the advisory ID to the source allowlist or RC-only consumer allowlist."
    );
    process.exit(1);
  }
  if (staleSourceAllowlist.length > 0 || staleConsumerAllowlist.length > 0) {
    console.error(
      `[check-audit] FAIL — stale allowlist entries (upstream is now clean): ` +
        [
          staleSourceAllowlist.length ? `source=${staleSourceAllowlist.join(",")}` : "",
          staleConsumerAllowlist.length ? `consumer=${staleConsumerAllowlist.join(",")}` : ""
        ]
          .filter(Boolean)
          .join(" ")
    );
    console.error("Remove the resolved exception instead of carrying a silent permanent waiver.");
    process.exit(1);
  }
  if (invalidSourceAllowlist.length > 0 || invalidConsumerAllowlist.length > 0) {
    console.error(
      `[check-audit] FAIL — exceptions lack a removal instruction or upstream URL: ` +
        [
          invalidSourceAllowlist.length ? `source=${invalidSourceAllowlist.join(",")}` : "",
          invalidConsumerAllowlist.length ? `consumer=${invalidConsumerAllowlist.join(",")}` : ""
        ]
          .filter(Boolean)
          .join(" ")
    );
    process.exit(1);
  }
  console.log(
    `[check-audit] OK — source tree and published-consumer resolution have no un-allowlisted advisories ` +
      `(prod ≥ moderate, dev ≥ high). Temporary consumer-only upstream exceptions: ${allowed.join(", ")}.`
  );
}
