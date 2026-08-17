// v3.7.0 PR4 — GitHub repo metadata invariant.
//
// Background. The README + npm description lead with "#1 Obsidian MCP for
// AI memory" (since v3.12.0-rc.5). The GitHub repo's About description + Topics
// were updated to match out-of-band via `gh api`. But that metadata lives
// only on GitHub — no CI check catches drift if someone (or a future
// automation) silently rewrites it. This test pulls the current state via
// `gh api repos/oomkapwn/enquire-mcp` and asserts the positioning + the
// exact 20-topic positioning set.
//
// Skip behavior. Local/offline runs without a usable `gh` session return with
// a one-line explanation. Token-bearing CI never silently skips: one cached
// probe performs the exact metadata API operation, and any exhausted auth,
// scope, rate-limit, network, CLI, or response failure is fail-closed.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const REPO = "oomkapwn/enquire-mcp";
// v3.12.0-rc.29 — the exact 20-topic set favors high-intent product discovery
// over redundant synonyms. Dataview, Bases, document intelligence, local-first,
// and read-only are verified differentiators surfaced by the 129-project
// competitive scan; broad memory, MCP, Obsidian, and primary-client routes remain.
const EXPECTED_TOPICS = [
  "agent-memory",
  "ai-memory",
  "chatgpt",
  "claude-code",
  "codex",
  "context-engineering",
  "cursor",
  "dataview",
  "document-intelligence",
  "hybrid-search",
  "local-first",
  "long-term-memory",
  "mcp-server",
  "model-context-protocol",
  "obsidian",
  "obsidian-bases",
  "obsidian-mcp",
  "read-only",
  "second-brain",
  "semantic-search"
];
// v3.12.0-rc.5 — About now leads with the explicit TOP-1 credential followed
// by the value prop. This is the live-metadata counterpart to the README,
// package and social-card positioning surfaces.
const ABOUT_LEADS_WITH = /^The #1 Obsidian MCP for AI memory\b/i;
const ABOUT_REQUIRED_TOKENS = ["freshness-aware", "cited", "local-first", "read-only", "dataview", "bases", "pdfs"];
const EXPECTED_HOMEPAGE = "https://oomkapwn.github.io/enquire-mcp/";

// v3.11.0-rc.7 introduced bounded retry for this network-backed invariant.
// The current class fix removes the redundant `gh auth status` preflight that
// raced the exact `gh api` call and discarded every diagnostic. The probe below
// executes only the asserted operation, shares its snapshot, and retries only
// failures that can recover without changing credentials or permissions.
const GH_RETRY_ATTEMPTS = 3;
const GH_RETRY_BACKOFF_MS = 750;
const GH_RETRY_MAX_DELAY_MS = 15_000;
const GH_DIAGNOSTIC_LIMIT = 400;

/** Synchronous backoff — Atomics.wait sleeps the thread without busy-spinning. */
function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Return true when `gh` has an explicit environment token worth retrying. */
function hasGhToken(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);
}

/**
 * Run `attempt` until `done` accepts a terminal success or deterministic failure.
 * If no result is terminal within the budget, return the last recoverable failure.
 * `sleep` is injected so the controls below run instantly. NOT exported (biome
 * `noExportsInTest`); tested in-file via negative and positive controls.
 */
function retryUntil<T>(
  attempt: () => T,
  done: (result: T) => boolean,
  attempts: number,
  delayMs: (result: T) => number,
  sleep: (ms: number) => void
): T {
  let last = attempt();
  for (let i = 1; i < attempts && !done(last); i++) {
    sleep(delayMs(last));
    last = attempt();
  }
  return last;
}

interface RepoMeta {
  description: string | null;
  homepage: string | null;
  topics: string[];
}

type GhFailureKind = "auth" | "scope" | "rate-limit" | "transient" | "cli" | "malformed" | "unknown";

interface IncludedResponse {
  body: string;
  headers: Record<string, string>;
  httpStatus: number | null;
}

interface GhFailureEvidence {
  detail: string;
  errorCode: string | null;
  exitCode: number | null;
  headers: Record<string, string>;
  httpStatus: number | null;
  signal: string | null;
}

interface GhProcessResult {
  error?: Error;
  signal: string | null;
  status: number | null;
  stderr: string | null | undefined;
  stdout: string | null | undefined;
}

type RepoMetaAttempt =
  | { meta: RepoMeta; ok: true }
  | ({ kind: GhFailureKind; ok: false; retryAfterMs: number | null } & Omit<GhFailureEvidence, "headers">);

type RepoMetaProbe =
  | { attempts: number; meta: RepoMeta; ok: true; recovered: boolean }
  | ({ attempts: number; kind: GhFailureKind; ok: false; recovered: false; retryAfterMs: number | null } & Omit<
      GhFailureEvidence,
      "headers"
    >);

/** Parse the status, response headers, and jq-filtered body emitted by `gh api --include`. */
function parseIncludedResponse(stdout: string): IncludedResponse {
  const normalized = stdout.replace(/\r\n/g, "\n");
  const statusMatches = [...normalized.matchAll(/^HTTP\/\S+\s+(\d{3})[^\n]*$/gm)];
  const statusMatch = statusMatches.at(-1);
  if (!statusMatch || statusMatch.index === undefined) {
    return { body: normalized.trim(), headers: {}, httpStatus: null };
  }

  const statusText = statusMatch[1];
  const httpStatus = statusText ? Number.parseInt(statusText, 10) : null;
  const headerEnd = normalized.indexOf("\n\n", statusMatch.index);
  if (headerEnd < 0) return { body: "", headers: {}, httpStatus };

  const headers: Record<string, string> = {};
  const headerBlock = normalized.slice(statusMatch.index, headerEnd);
  for (const line of headerBlock.split("\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const existing = headers[name];
    headers[name] = existing ? `${existing}, ${value}` : value;
  }
  return { body: normalized.slice(headerEnd + 2).trim(), headers, httpStatus };
}

/** Redact common GitHub-token shapes, compact whitespace, and bound CI output. */
function sanitizeGhDetail(detail: string): string {
  const redacted = detail
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+)\b/g, "[REDACTED]")
    .replace(/\b((?:GH|GITHUB)_TOKEN)\s*=\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b(authorization:\s*(?:bearer|token))\s+\S+/gi, "$1 [REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return (redacted || "(no diagnostic output)").slice(0, GH_DIAGNOSTIC_LIMIT);
}

/** Derive a bounded server-requested retry delay from response headers. */
function rateLimitDelayMs(headers: Readonly<Record<string, string>>, nowMs = Date.now()): number | null {
  const retryAfterSeconds = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(GH_RETRY_MAX_DELAY_MS, Math.ceil(retryAfterSeconds * 1_000));
  }
  const resetSeconds = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
    return Math.min(GH_RETRY_MAX_DELAY_MS, Math.max(0, Math.ceil(resetSeconds * 1_000 - nowMs)));
  }
  return null;
}

/** Classify only evidence that changes retry or operator action; unknown stays fail-closed. */
function classifyGhFailure(evidence: GhFailureEvidence): GhFailureKind {
  const detail = evidence.detail.toLowerCase();
  const rateLimitRemaining = evidence.headers["x-ratelimit-remaining"];
  if (
    evidence.httpStatus === 429 ||
    evidence.headers["retry-after"] !== undefined ||
    rateLimitRemaining === "0" ||
    /(?:secondary |api )?rate limit|abuse detection/.test(detail)
  ) {
    return "rate-limit";
  }
  if (
    evidence.httpStatus === 401 ||
    evidence.exitCode === 4 ||
    /bad credentials|authentication required|not logged in/.test(detail)
  ) {
    return "auth";
  }
  if (
    evidence.httpStatus === 403 ||
    /resource not accessible|insufficient (?:permission|scope)|forbidden/.test(detail)
  ) {
    return "scope";
  }
  if (
    evidence.httpStatus === 408 ||
    (evidence.httpStatus !== null && evidence.httpStatus >= 500) ||
    ["ECONNRESET", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"].includes(evidence.errorCode ?? "") ||
    /timed? ?out|could not resolve|connection|network|socket|tls|unexpected eof/.test(detail) ||
    /error connecting to api\.github\.com/.test(detail)
  ) {
    return "transient";
  }
  if (
    evidence.signal !== null ||
    ["EACCES", "ENOENT", "ENOEXEC"].includes(evidence.errorCode ?? "") ||
    /unknown (?:command|flag)|not executable|unsupported flag/.test(detail)
  ) {
    return "cli";
  }
  return "unknown";
}

/** Validate the runtime shape returned by the GitHub repository endpoint. */
function isRepoMeta(value: unknown): value is RepoMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (typeof record.description === "string" || record.description === null) &&
    (typeof record.homepage === "string" || record.homepage === null) &&
    Array.isArray(record.topics) &&
    record.topics.every((topic) => typeof topic === "string")
  );
}

/** Convert a successful transport body into metadata or a fail-closed malformed result. */
function parseRepoMetaBody(
  body: string,
  evidence: Pick<GhFailureEvidence, "errorCode" | "exitCode" | "httpStatus" | "signal">
): RepoMetaAttempt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    parsed = undefined;
  }
  if (isRepoMeta(parsed)) return { meta: parsed, ok: true };
  return {
    detail: sanitizeGhDetail(`gh api returned malformed repository metadata: ${body}`),
    errorCode: evidence.errorCode,
    exitCode: evidence.exitCode,
    httpStatus: evidence.httpStatus,
    kind: "malformed",
    ok: false,
    retryAfterMs: null,
    signal: evidence.signal
  };
}

/** Convert one raw CLI result into the exact production retry/admission result. */
function attemptFromGhResult(res: GhProcessResult): RepoMetaAttempt {
  const response = parseIncludedResponse(res.stdout ?? "");
  const errorCode =
    res.error && "code" in res.error && typeof res.error.code === "string" ? res.error.code : null;
  const evidence: GhFailureEvidence = {
    detail: [res.error?.message, res.stderr, response.body].filter((part) => Boolean(part)).join(" | "),
    errorCode,
    exitCode: res.status,
    headers: response.headers,
    httpStatus: response.httpStatus,
    signal: res.signal
  };

  if (res.status !== 0 || (response.httpStatus !== null && response.httpStatus >= 400)) {
    const kind = classifyGhFailure(evidence);
    return {
      detail: sanitizeGhDetail(evidence.detail),
      errorCode,
      exitCode: evidence.exitCode,
      httpStatus: evidence.httpStatus,
      kind,
      ok: false,
      retryAfterMs: kind === "rate-limit" ? rateLimitDelayMs(response.headers) : null,
      signal: evidence.signal
    };
  }
  return parseRepoMetaBody(response.body, evidence);
}

/** One exact repository-metadata operation with structured, sanitized failure evidence. */
function probeRepoMetaOnce(): RepoMetaAttempt {
  const res = spawnSync("gh", ["api", "--include", `repos/${REPO}`, "--jq", "{description, homepage, topics}"], {
    encoding: "utf8",
    timeout: 15_000
  });
  return attemptFromGhResult(res);
}

/** True for a successful probe or a deterministic failure that retries cannot fix. */
function isProbeTerminal(attempt: RepoMetaAttempt): boolean {
  return attempt.ok || (attempt.kind !== "transient" && attempt.kind !== "rate-limit");
}

/** Honor bounded server retry timing; ordinary transient failures use the short backoff. */
function probeRetryDelayMs(attempt: RepoMetaAttempt): number {
  return attempt.ok ? 0 : (attempt.retryAfterMs ?? GH_RETRY_BACKOFF_MS);
}

/** Run and cache one exact metadata probe; only transient/rate-limit failures retry. */
function probeRepoMeta(
  attempt: () => RepoMetaAttempt = probeRepoMetaOnce,
  tokenAvailable = hasGhToken(),
  sleep: (ms: number) => void = sleepMs
): RepoMetaProbe {
  let attempts = 0;
  const finalAttempt = retryUntil(
    () => {
      attempts++;
      return attempt();
    },
    isProbeTerminal,
    tokenAvailable ? GH_RETRY_ATTEMPTS : 1,
    probeRetryDelayMs,
    sleep
  );
  if (finalAttempt.ok) {
    return { attempts, meta: finalAttempt.meta, ok: true, recovered: attempts > 1 };
  }
  return { ...finalAttempt, attempts, recovered: false };
}

/** Stable fail-closed diagnostic for token-bearing CI assertions. */
function formatProbeFailure(probe: Extract<RepoMetaProbe, { ok: false }>): string {
  return [
    "exact gh api metadata probe failed",
    `kind=${probe.kind}`,
    `attempts=${probe.attempts}`,
    `http=${probe.httpStatus ?? "none"}`,
    `exit=${probe.exitCode ?? "none"}`,
    `signal=${probe.signal ?? "none"}`,
    `error=${probe.errorCode ?? "none"}`,
    `detail=${probe.detail}`
  ].join("; ");
}

/** Return the shared snapshot, fail token-bearing CI, or preserve local no-token skip semantics. */
function repoMetaForAssertion(
  probe: RepoMetaProbe,
  failClosed = Boolean(process.env.CI && hasGhToken()),
  warn: (message: string) => void = console.warn
): RepoMeta | null {
  if (probe.ok) return probe.meta;
  const diagnostic = formatProbeFailure(probe);
  if (failClosed) throw new Error(diagnostic);
  warn(`[github-metadata] ${diagnostic}; skipping live metadata assertion`);
  return null;
}

/**
 * v3.7.4 — extracted assertion helpers for negative-control coverage.
 * Per CLAUDE.md anti-pattern "Invariant test without negative-control —
 * Rule since v3.6.4": every invariant test must have a sibling that
 * fails when the invariant is violated. v3.7.0 shipped this invariant
 * with assertions inlined, which made negative-control impossible.
 * v3.7.4 extracts the logic so we can prove the analyzer flags drift.
 */
function validateAboutLeadsWith(description: string): boolean {
  return ABOUT_LEADS_WITH.test(description ?? "");
}
function findAboutTokenDrift(description: string): string[] {
  const normalized = (description ?? "").toLowerCase();
  return ABOUT_REQUIRED_TOKENS.filter((token) => !normalized.includes(token));
}
function findTopicDrift(topics: string[]): { missing: string[]; unexpected: string[] } {
  const set = new Set(topics ?? []);
  const expected = new Set(EXPECTED_TOPICS);
  return {
    missing: EXPECTED_TOPICS.filter((t) => !set.has(t)),
    unexpected: [...set].filter((t) => !expected.has(t)).sort()
  };
}

// v3.9.0-rc.31 — SLSA-overclaim guard for the repo About description.
//
// Background: overclaim #15 (rc.7) downgraded an unenforced "SLSA-3" claim to
// the accurate "SLSA L2" across README/package.json/llms.txt/COMPARISON/
// STABILITY (release.yml only runs `npm publish --provenance` = SLSA Build L2;
// L3 needs the isolated slsa-framework/slsa-github-generator). OIA Check 4d
// then structurally guards every in-repo claim file + the social-preview SVG.
// But the GitHub repo About string lives ONLY on GitHub — no file, no OIA
// scope — so the stale "SLSA-3" survived there for ~23 RCs until a state-driven
// repo-page check (rc.31) caught it. This analyzer closes that gap: the About
// description must NOT assert a SLSA level above L2.
//
// Returns the offending substring (e.g. "SLSA-3") or null if the claim is
// absent / correctly stated as L2. Matches "SLSA-3", "SLSA 3", "SLSA-4",
// "SLSA Build L3", "SLSA Level 3", "SLSA L3"; tolerant of separators/case.
// "SLSA L2" / "SLSA-2" / "SLSA Build L2" pass.
const SLSA_OVERCLAIM_RE = /SLSA[\s-]*(?:Build[\s-]*)?(?:Level[\s-]*|L)?\s*([34])\b/i;
function findSlsaOverclaim(description: string): string | null {
  const m = SLSA_OVERCLAIM_RE.exec(description ?? "");
  return m ? m[0] : null;
}

describe("GitHub repo metadata invariant (v3.7.0 + v3.7.4 negative-control)", () => {
  // Always use `it` (not `it.skip`) so the total `it()` count is constant
  // across local-with-gh-auth and CI-without-gh-auth environments. The
  // `tests/docs-consistency.test.ts` regex counts `^\s*it\(` declarations
  // for its test-count claim. Local no-token failures return after a visible
  // warning; token-bearing CI throws before any live assertion can no-op.
  const probe = probeRepoMeta();

  // v3.9.0-rc.26 (rc.25-audit MED-1) — CI-GUARD tripwire. The two metadata
  // invariants retain local no-token behavior, but the exact shared API probe
  // hard-fails when CI provides a token. Jobs intentionally without a token
  // (for example coverage) do not become network-dependent release gates.
  it("CI GUARD — when CI provides a token, the exact metadata API probe succeeds", () => {
    if (!process.env.CI || !hasGhToken()) return;
    expect(repoMetaForAssertion(probe)).not.toBeNull();
  });

  it("repo About description leads with 'The #1 Obsidian MCP for AI memory'", () => {
    const meta = repoMetaForAssertion(probe);
    if (!meta) return;
    expect(meta.description ?? "").toMatch(ABOUT_LEADS_WITH);
    expect(
      findAboutTokenDrift(meta.description ?? ""),
      "repo About must expose the freshness, evidence, local-first, read-only, and Obsidian-native acquisition wedge"
    ).toEqual([]);
    expect(meta.homepage).toBe(EXPECTED_HOMEPAGE);
    // v3.9.0-rc.31 — the About string must not carry a SLSA-level overclaim
    // (release.yml earns SLSA Build L2; "SLSA-3"/L3 would be unenforced).
    const slsa = findSlsaOverclaim(meta.description ?? "");
    expect(
      slsa,
      `repo About claims an unenforced SLSA level (${slsa}); release.yml earns SLSA Build L2 — fix via \`gh repo edit ${REPO} --description ...\` to say "SLSA L2"`
    ).toBeNull();
  });

  it("repo Topics exactly match the intentional 20-topic discoverability set", () => {
    const meta = repoMetaForAssertion(probe);
    if (!meta) return;
    const drift = findTopicDrift(meta.topics);
    expect(
      drift,
      `Topic drift — missing: ${drift.missing.join(", ") || "(none)"}; unexpected: ${drift.unexpected.join(", ") || "(none)"}`
    ).toEqual({ missing: [], unexpected: [] });
  });

  // v3.7.4 — NEGATIVE-CONTROL siblings. The 2 production tests above pass
  // when gh metadata matches the expected positioning. Without the negative
  // control, if `ABOUT_LEADS_WITH` regex or `REQUIRED_TOPICS` array broke,
  // the production tests would silent-pass even on bad input. These tests
  // call the extracted pure functions on KNOWN-BAD inputs and assert the
  // analyzer correctly flags them.
  //
  // Per CLAUDE.md anti-pattern "Invariant test without negative-control —
  // Rule since v3.6.4". v3.7.0 shipped this invariant without negative-
  // control (oversight); v3.7.4 closes the gap.
  describe("NEGATIVE-CONTROL: analyzers detect drift on synthetic bad inputs (v3.7.4)", () => {
    it("validateAboutLeadsWith rejects descriptions that don't lead with the canonical phrase", () => {
      // v3.12.0-rc.5 — canonical About lead is now the explicit TOP-1 phrase.
      const canonical =
        "The #1 Obsidian MCP for AI memory — freshness-aware, cited, local-first and read-only. Dataview, Bases, PDFs.";
      expect(validateAboutLeadsWith(canonical)).toBe(true);
      expect(findAboutTokenDrift(canonical)).toEqual([]);
      // Case-insensitive — same canonical phrase, lowercase.
      expect(validateAboutLeadsWith("the #1 obsidian mcp for ai memory — built")).toBe(true);
      // Negative cases — analyzer MUST flag these.
      expect(validateAboutLeadsWith("Memory layer for AI agents — built on Obsidian.")).toBe(false);
      expect(validateAboutLeadsWith("The most advanced Obsidian MCP — long-term memory")).toBe(false);
      expect(validateAboutLeadsWith("The most advanced MCP server for Obsidian vaults.")).toBe(false); // "MCP server for Obsidian" ≠ "Obsidian MCP"
      expect(validateAboutLeadsWith("")).toBe(false);
      expect(validateAboutLeadsWith("Long-term memory for AI agents")).toBe(false);
      expect(findAboutTokenDrift("The #1 Obsidian MCP for AI memory — cited.")).toEqual([
        "freshness-aware",
        "local-first",
        "read-only",
        "dataview",
        "bases",
        "pdfs"
      ]);
    });

    it("findTopicDrift returns all expected topics when given empty input", () => {
      const drift = findTopicDrift([]);
      expect(drift.missing.length).toBe(EXPECTED_TOPICS.length);
      expect(drift.unexpected).toEqual([]);
      for (const expected of EXPECTED_TOPICS) {
        expect(drift.missing).toContain(expected);
      }
    });

    it("findTopicDrift reports missing and unexpected topics together", () => {
      // Pass only 3 expected topics plus a stale client topic. Both directions
      // of drift must be visible; a missing-only analyzer would accept extras.
      const partial = [...EXPECTED_TOPICS.slice(0, 3), "aider"];
      const drift = findTopicDrift(partial);
      expect(drift.missing.length).toBe(EXPECTED_TOPICS.length - 3);
      expect(drift.unexpected).toEqual(["aider"]);
      // The 3 we passed must NOT be in missing.
      for (const passed of EXPECTED_TOPICS.slice(0, 3)) {
        expect(drift.missing).not.toContain(passed);
      }
    });

    it("findTopicDrift returns no drift only for the exact set (positive control)", () => {
      expect(findTopicDrift([...EXPECTED_TOPICS].reverse())).toEqual({ missing: [], unexpected: [] });
      expect(findTopicDrift([...EXPECTED_TOPICS, "extra-topic"]).unexpected).toEqual(["extra-topic"]);
    });

    it("findSlsaOverclaim flags SLSA-3/L3/L4 and passes SLSA L2 (v3.9.0-rc.31)", () => {
      // NEGATIVE — every shape of the overclaim must be caught.
      expect(findSlsaOverclaim("MCP-native, MIT, SLSA-3.")).toBe("SLSA-3");
      expect(findSlsaOverclaim("... SLSA 3 ...")).toBeTruthy();
      expect(findSlsaOverclaim("built with SLSA Build L3")).toBeTruthy();
      expect(findSlsaOverclaim("SLSA Level 3 provenance")).toBeTruthy();
      expect(findSlsaOverclaim("SLSA L3")).toBeTruthy();
      expect(findSlsaOverclaim("SLSA-4")).toBe("SLSA-4");
      // POSITIVE — the accurate claim (and no-claim) must NOT be flagged.
      expect(findSlsaOverclaim("MCP-native, MIT, SLSA L2.")).toBeNull();
      expect(findSlsaOverclaim("... SLSA-2 ...")).toBeNull();
      expect(findSlsaOverclaim("SLSA Build L2")).toBeNull();
      expect(findSlsaOverclaim("The #1 Obsidian MCP for AI memory — no provenance mention")).toBeNull();
      // Guard against false-positive on unrelated digits near "SLSA"-free text.
      expect(findSlsaOverclaim("Supports 3 transports and L3 caching")).toBeNull();
    });

    it("classifies exact-probe failures, retries only recoverable causes, and redacts diagnostics", () => {
      const noSleep = (): void => {};
      const evidence = (overrides: Partial<GhFailureEvidence> = {}): GhFailureEvidence => ({
        detail: "",
        errorCode: null,
        exitCode: 1,
        headers: {},
        httpStatus: null,
        signal: null,
        ...overrides
      });
      const failure = (kind: GhFailureKind): RepoMetaAttempt => ({
        detail: `synthetic ${kind}`,
        errorCode: null,
        exitCode: 1,
        httpStatus: null,
        kind,
        ok: false,
        retryAfterMs: null,
        signal: null
      });
      const meta: RepoMeta = { description: "canonical", homepage: EXPECTED_HOMEPAGE, topics: [] };
      const rawResult = (overrides: Partial<GhProcessResult> = {}): GhProcessResult => ({
        signal: null,
        status: 1,
        stderr: "",
        stdout: "",
        ...overrides
      });
      const included = (
        status: number,
        headers: Readonly<Record<string, string>> = {},
        body = "{}"
      ): string =>
        [
          `HTTP/2.0 ${status} synthetic`,
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          "",
          body
        ].join("\r\n");
      const successEvidence = { errorCode: null, exitCode: 0, httpStatus: 200, signal: null };

      expect(parseRepoMetaBody(JSON.stringify(meta), successEvidence)).toEqual({ meta, ok: true });
      expect(
        parseRepoMetaBody(JSON.stringify({ description: null, homepage: null, topics: ["obsidian"] }), successEvidence)
      ).toMatchObject({ ok: true });
      const wrongShape = parseRepoMetaBody(
        JSON.stringify({ description: "canonical", homepage: EXPECTED_HOMEPAGE, topics: [42] }),
        successEvidence
      );
      expect(wrongShape.ok).toBe(false);
      if (wrongShape.ok) throw new Error("wrong-shape control unexpectedly produced metadata");
      expect(wrongShape.kind).toBe("malformed");

      // Raw spawn-result controls traverse the same converter as production,
      // binding stdout/headers/status/signal/error to classification and delay.
      expect(
        attemptFromGhResult(rawResult({ status: 0, stdout: included(200, {}, JSON.stringify(meta)) }))
      ).toEqual({ meta, ok: true });
      const rawAuth = attemptFromGhResult(rawResult({ stdout: included(401) }));
      expect(rawAuth).toMatchObject({ httpStatus: 401, kind: "auth", ok: false });
      const rawScope = attemptFromGhResult(rawResult({ stdout: included(403) }));
      expect(rawScope).toMatchObject({ httpStatus: 403, kind: "scope", ok: false });
      const rawRetryAfter = attemptFromGhResult(
        rawResult({ stdout: included(200, { "retry-after": "2" }) })
      );
      expect(rawRetryAfter).toMatchObject({ kind: "rate-limit", ok: false, retryAfterMs: 2_000 });
      expect(
        attemptFromGhResult(rawResult({ stdout: included(200, { "x-ratelimit-remaining": "0" }) }))
      ).toMatchObject({ kind: "rate-limit", ok: false });
      expect(attemptFromGhResult(rawResult({ stdout: included(429) }))).toMatchObject({
        kind: "rate-limit",
        ok: false
      });
      expect(
        attemptFromGhResult(rawResult({ status: null, signal: "SIGABRT" }))
      ).toMatchObject({ kind: "cli", ok: false, signal: "SIGABRT" });
      expect(
        attemptFromGhResult(
          rawResult({
            error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }),
            signal: "SIGTERM",
            status: null
          })
        )
      ).toMatchObject({ errorCode: "ETIMEDOUT", kind: "transient", ok: false, signal: "SIGTERM" });
      expect(
        attemptFromGhResult(
          rawResult({ error: Object.assign(new Error("missing gh"), { code: "ENOENT" }), status: null })
        )
      ).toMatchObject({ errorCode: "ENOENT", kind: "cli", ok: false });
      expect(attemptFromGhResult(rawResult({ status: 0, stdout: included(200, {}, "not-json") }))).toMatchObject({
        kind: "malformed",
        ok: false
      });

      expect(classifyGhFailure(evidence({ httpStatus: 401 }))).toBe("auth");
      const scopeFailure = evidence({
        detail: "HTTP 403: Resource not accessible by integration",
        httpStatus: 403
      });
      expect(classifyGhFailure(scopeFailure)).toBe("scope");
      for (const errorCode of ["EACCES", "ENOENT", "ENOEXEC"]) {
        expect(classifyGhFailure(evidence({ errorCode }))).toBe("cli");
      }
      expect(classifyGhFailure(evidence({ detail: "unknown flag: --broken" }))).toBe("cli");
      expect(classifyGhFailure(evidence({ signal: "SIGABRT" }))).toBe("cli");
      expect(classifyGhFailure(evidence({ errorCode: "ETIMEDOUT", signal: "SIGTERM" }))).toBe("transient");
      expect(classifyGhFailure(evidence({ detail: "error connecting to api.github.com" }))).toBe("transient");
      expect(classifyGhFailure(evidence({ httpStatus: 503 }))).toBe("transient");
      expect(classifyGhFailure(evidence({ detail: "unclassified gh failure" }))).toBe("unknown");

      const rateLimited = parseIncludedResponse(
        "HTTP/2.0 403 Forbidden\r\nx-ratelimit-remaining: 0\r\nretry-after: 2\r\n\r\n{\"message\":\"rate limited\"}"
      );
      expect(rateLimited.httpStatus).toBe(403);
      expect(rateLimited.headers["retry-after"]).toBe("2");
      expect(rateLimited.body).toBe('{"message":"rate limited"}');
      expect(rateLimitDelayMs(rateLimited.headers, 0)).toBe(2_000);
      expect(rateLimitDelayMs({ "x-ratelimit-reset": "3" }, 1_000)).toBe(2_000);
      expect(rateLimitDelayMs({ "retry-after": "60" }, 0)).toBe(GH_RETRY_MAX_DELAY_MS);

      // Each independent signal must classify rate limiting without another
      // branch masking its removal. A bare 403 remains a deterministic scope failure.
      expect(classifyGhFailure(evidence({ httpStatus: 429 }))).toBe("rate-limit");
      expect(classifyGhFailure(evidence({ headers: { "retry-after": "2" } }))).toBe("rate-limit");
      expect(classifyGhFailure(evidence({ headers: { "x-ratelimit-remaining": "0" } }))).toBe("rate-limit");
      expect(classifyGhFailure(evidence({ detail: "secondary rate limit" }))).toBe("rate-limit");
      expect(classifyGhFailure(evidence({ httpStatus: 403 }))).toBe("scope");

      // Deterministic causes are terminal immediately; retrying cannot repair
      // credentials, repository permission, a missing CLI, or malformed JSON.
      for (const kind of ["auth", "scope", "cli", "malformed", "unknown"] as const) {
        expect(isProbeTerminal(failure(kind)), `${kind} must not retry`).toBe(true);
      }
      expect(isProbeTerminal(failure("transient"))).toBe(false);
      expect(isProbeTerminal(failure("rate-limit"))).toBe(false);

      let authCalls = 0;
      const auth = retryUntil(
        () => {
          authCalls++;
          return failure("auth");
        },
        isProbeTerminal,
        3,
        () => 0,
        noSleep
      );
      expect(auth.ok).toBe(false);
      expect(authCalls, "auth failure must fail closed without wasted retries").toBe(1);

      // POSITIVE — a transient blip (fails attempts 1-2, succeeds on 3)
      // recovers, while the same failure on every attempt remains fail-closed.
      let transientCalls = 0;
      const transient = retryUntil(
        (): RepoMetaAttempt => {
          transientCalls++;
          return transientCalls >= 3 ? { meta, ok: true } : failure("transient");
        },
        isProbeTerminal,
        3,
        () => 0,
        noSleep
      );
      expect(transient.ok, "a recoverable blip must yield the real metadata snapshot").toBe(true);
      expect(transientCalls).toBe(3);

      let persistentCalls = 0;
      const persistent = retryUntil(
        () => {
          persistentCalls++;
          return failure("transient");
        },
        isProbeTerminal,
        3,
        () => 0,
        noSleep
      );
      expect(persistent.ok, "exhausted transient failures must not become metadata").toBe(false);
      expect(persistentCalls).toBe(3);

      expect(hasGhToken({})).toBe(false);
      expect(hasGhToken({ GH_TOKEN: "synthetic" })).toBe(true);
      expect(hasGhToken({ GITHUB_TOKEN: "synthetic" })).toBe(true);

      const budgetSleeps: number[] = [];
      let budgetCalls = 0;
      const tokenProbe = probeRepoMeta(
        () => {
          budgetCalls++;
          return budgetCalls >= 3 ? { meta, ok: true } : failure("transient");
        },
        true,
        (ms) => budgetSleeps.push(ms)
      );
      expect(tokenProbe).toMatchObject({ attempts: 3, meta, ok: true, recovered: true });
      expect(budgetSleeps).toEqual([GH_RETRY_BACKOFF_MS, GH_RETRY_BACKOFF_MS]);

      let tokenlessCalls = 0;
      const tokenlessProbe = probeRepoMeta(
        () => {
          tokenlessCalls++;
          return failure("transient");
        },
        false,
        noSleep
      );
      expect(tokenlessProbe).toMatchObject({ attempts: 1, kind: "transient", ok: false });
      expect(tokenlessCalls).toBe(1);

      const previousGhToken = process.env.GH_TOKEN;
      process.env.GH_TOKEN = "synthetic-default-binding";
      try {
        let defaultBindingCalls = 0;
        const defaultBoundProbe = probeRepoMeta(
          () => {
            defaultBindingCalls++;
            return defaultBindingCalls >= 3 ? { meta, ok: true } : failure("transient");
          },
          undefined,
          noSleep
        );
        expect(defaultBoundProbe).toMatchObject({ attempts: 3, ok: true, recovered: true });
      } finally {
        if (previousGhToken === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = previousGhToken;
      }

      const rateLimitSleeps: number[] = [];
      let rateLimitCalls = 0;
      const rateLimitRecovery = probeRepoMeta(
        () => {
          rateLimitCalls++;
          return rateLimitCalls >= 3 ? { meta, ok: true } : rawRetryAfter;
        },
        true,
        (ms) => rateLimitSleeps.push(ms)
      );
      expect(rateLimitRecovery).toMatchObject({ attempts: 3, meta, ok: true, recovered: true });
      expect(rateLimitSleeps).toEqual([2_000, 2_000]);

      const failedProbe: RepoMetaProbe = { ...failure("auth"), attempts: 1, recovered: false };
      expect(repoMetaForAssertion({ attempts: 1, meta, ok: true, recovered: false }, true)).toBe(meta);
      expect(() => repoMetaForAssertion(failedProbe, true, noSleep)).toThrow(/kind=auth; attempts=1/);
      const warnings: string[] = [];
      expect(repoMetaForAssertion(failedProbe, false, (warning) => warnings.push(warning))).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/skipping live metadata assertion/);

      const bareToken = "ghp_baretoken0123456789";
      const environmentToken = "opaque-environment-secret";
      const authorizationToken = "opaque-authorization-secret";
      const sanitized = sanitizeGhDetail(
        [
          bareToken,
          `GH_TOKEN=${environmentToken}`,
          `Authorization: Bearer ${authorizationToken}`,
          "diagnostic ".repeat(80)
        ].join("\n")
      );
      expect(sanitized).not.toContain(bareToken);
      expect(sanitized).not.toContain(environmentToken);
      expect(sanitized).not.toContain(authorizationToken);
      expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(3);
      expect(sanitized.length).toBeLessThanOrEqual(GH_DIAGNOSTIC_LIMIT);
    });
  });
});
