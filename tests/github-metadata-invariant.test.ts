// v3.7.0 PR4 — GitHub repo metadata invariant.
//
// Background. The README + npm description lead with "long-term memory for
// AI agents" (since v3.6.3). The GitHub repo's About description + Topics
// were updated to match out-of-band via `gh api`. But that metadata lives
// only on GitHub — no CI check catches drift if someone (or a future
// automation) silently rewrites it. This test pulls the current state via
// `gh api repos/oomkapwn/enquire-mcp` and asserts the positioning + the
// presence of the 8 hype topics shipped with v3.6.3.
//
// Skip behavior. The test runs only when:
//   1. `gh` is on PATH and authenticated (typically: in CI via GITHUB_TOKEN,
//      or local devs who ran `gh auth login`).
//   2. Network is reachable.
// Otherwise the test gracefully `it.skip`s with a one-line explanation.
// This avoids local devs / offline CI variants failing on auth they don't
// have. The skip is INTENTIONALLY non-failing — see the v3.6.4 method note
// "Invariant test without negative-control" for why we wouldn't accept a
// silent always-pass; here the skip is explicit, the assertion is real.

import { execSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const REPO = "oomkapwn/enquire-mcp";
// v3.7.9 — REQUIRED_TOPICS updated to reflect the v3.7.8 positioning calibration:
//   - openclaw added (restored after v3.6.3 dropped it to fit hype keywords)
//   - context-engineering removed (swapped for openclaw in v3.7.8 Topics rebalance)
// Per round-11 audit: the test was carrying the v3.7.0 8-topic shortlist
// while the v3.7.8 metadata had moved on. Bringing the invariant up to date.
// v3.11.2 (codebase-memory-mcp competitive study — agent-SEO) — pin the broadened
// agent-community targeting so a future Topics rebalance can't silently drop it. The
// repo is at GitHub's 20-topic cap, so these 4 replaced the redundant retrieval cluster
// (agentic-rag / hybrid-search / semantic-search — "rag" kept as the umbrella) + generic
// "claude" (we keep the targeted claude-code / claude-memory). Each surfaces enquire in
// that client community's GitHub topic search; we are client-agnostic over MCP by design.
const REQUIRED_TOPICS = [
  "ai-memory",
  "agent-memory",
  "llm-memory",
  "long-term-memory",
  "claude-memory",
  "second-brain",
  "openclaw",
  "obsidian-mcp",
  "aider",
  "windsurf",
  "zed",
  "gemini-cli"
];
// v3.7.8 — About now leads with "The most advanced Obsidian MCP" credential
// followed by the value prop. v3.7.9 invariant matches this new lead phrase
// (the v3.7.0 invariant matched "Memory layer for AI agents"; v3.7.8 changed
// the About copy out-of-band via gh api, and round-11 caught the test drift).
const ABOUT_LEADS_WITH = /^The most advanced Obsidian MCP/i;

// v3.11.0-rc.7 — flake hardening for the (network-y) gh auth/API calls. On
// 2026-06-23 the CI-GUARD below flaked: `gh auth status` makes a network call to
// validate the token, and it transiently failed on a main-push run (the identical
// commit had PASSED on the PR run minutes earlier). That failed CI and BLOCKED the
// v3.11.0-rc.6 release (release.yml's "assert CI green on main" guard correctly
// refused to publish). Same flake-blocks-a-release class as the rc.20 npm-ci
// incident (fixed there with a bounded retry). Fix: a short bounded retry around
// the gh calls so a momentary blip doesn't fail — WITHOUT masking a genuine auth
// failure (every attempt must fail before we conclude "unavailable").
const GH_RETRY_ATTEMPTS = 3;
const GH_RETRY_BACKOFF_MS = 750;

/** Synchronous backoff — Atomics.wait sleeps the thread without busy-spinning. */
function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry only in a CI/token context — there a gh failure is plausibly a transient
 * GitHub-API/network blip. Pure local dev WITHOUT a token fails fast (1 attempt,
 * no backoff) so `npm test` isn't slowed on every run by a genuine "no auth".
 */
function shouldRetryGh(): boolean {
  return Boolean(process.env.CI || process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
}

/**
 * Run `attempt` up to `attempts` times, returning the FIRST result for which `ok`
 * is true. If no attempt satisfies `ok`, returns the LAST result — so a genuine
 * failure (gh truly unauthenticated: every attempt fails) is NOT masked, while a
 * transient blip (one attempt fails, a later one succeeds) recovers. `sleep` is
 * injected so the control tests below run instantly. NOT exported (biome
 * `noExportsInTest`); tested in-file via the negative/positive controls.
 */
function retryUntil<T>(
  attempt: () => T,
  ok: (r: T) => boolean,
  attempts: number,
  backoffMs: number,
  sleep: (ms: number) => void
): T {
  let last = attempt();
  for (let i = 1; i < attempts && !ok(last); i++) {
    sleep(backoffMs);
    last = attempt();
  }
  return last;
}

/** One `gh auth status` probe — exits 0 iff authenticated. */
function ghAuthStatusOnce(): boolean {
  try {
    // `gh auth status` exits 0 when authenticated, non-zero otherwise. We
    // pipe stderr → /dev/null to keep the test output clean.
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ghIsAvailable(): boolean {
  // Retry the auth probe in CI/token context so a transient blip doesn't read as
  // "unauthenticated"; a genuine no-auth still fails (every attempt returns false).
  return retryUntil(ghAuthStatusOnce, (b) => b, shouldRetryGh() ? GH_RETRY_ATTEMPTS : 1, GH_RETRY_BACKOFF_MS, sleepMs);
}

interface RepoMeta {
  description: string;
  topics: string[];
}

function fetchRepoMetaOnce(): RepoMeta | null {
  const res = spawnSync("gh", ["api", `repos/${REPO}`, "--jq", "{description, topics}"], {
    encoding: "utf8",
    timeout: 15_000
  });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout) as RepoMeta;
  } catch {
    return null;
  }
}

function fetchRepoMeta(): RepoMeta | null {
  // Same flake hardening: retry the `gh api` call on a transient null (network /
  // rate-limit blip) in CI/token context. A persistent failure still returns null
  // → the production About/Topics tests then fail loud (correct, not masked).
  return retryUntil(
    fetchRepoMetaOnce,
    (m) => m !== null,
    shouldRetryGh() ? GH_RETRY_ATTEMPTS : 1,
    GH_RETRY_BACKOFF_MS,
    sleepMs
  );
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
function findMissingTopics(topics: string[]): string[] {
  const set = new Set(topics ?? []);
  return REQUIRED_TOPICS.filter((t) => !set.has(t));
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
  // for its test-count claim; conditional `it.skip` would fluctuate the
  // count. Instead, each test early-returns when `gh` isn't available —
  // the test "passes" without asserting (treated as a no-op skip).
  const available = ghIsAvailable();

  // v3.9.0-rc.26 (rc.25-audit MED-1) — CI-GUARD tripwire. The two metadata
  // invariants below early-return when `gh` isn't authenticated, which is correct
  // for local dev but would let them SILENTLY no-op in CI if the `GH_TOKEN` the
  // `test` job sets ever lost its scope or the gh CLI regressed. This tripwire
  // hard-fails in CI WHEN A TOKEN IS PROVIDED, so a broken-auth regression on the
  // token-bearing job surfaces. (Jobs that intentionally omit GH_TOKEN — e.g.
  // `coverage` — are not asserted against; the `&& GH_TOKEN` gate skips them.)
  it("CI GUARD — when CI provides GH_TOKEN, gh is actually authenticated (metadata invariants run)", () => {
    if (!process.env.CI || !process.env.GH_TOKEN) return;
    // Reuse the `available` computed once above (it already applied the bounded
    // retry) — re-calling ghIsAvailable() would just repeat the retried probe.
    // v3.11.0-rc.7: this now fails only after the retry is exhausted (a genuine
    // broken-token regression), not on a single transient GitHub-API blip.
    expect(
      available,
      "GH_TOKEN is set in CI but `gh auth status` failed across retries — the About/Topics invariants would silently no-op"
    ).toBe(true);
  });

  it("repo About description leads with 'The most advanced Obsidian MCP'", () => {
    if (!available) {
      // v3.7.13 L4 — CI now sets `GH_TOKEN: ${{ github.token }}` so this
      // branch only fires in local dev without auth. Production CI runs
      // assert against the live repo and would fail loud on drift.
      console.warn("[github-metadata] `gh` not authenticated; skipping (set GH_TOKEN env or GITHUB_TOKEN for CI).");
      return;
    }
    const meta = fetchRepoMeta();
    // v3.7.13 L4 — fail loud on API failure when `gh` is available. Pre-3.7.13
    // we no-op'd here, which let CI count this as "passed" even if rate-limit
    // / network / token-scope blocked the fetch. If `gh` is available but the
    // API fails, that's a real signal worth surfacing.
    expect(
      meta,
      "gh api call failed despite gh being available — check rate limit / network / token scope"
    ).not.toBeNull();
    if (!meta) return;
    expect(meta.description ?? "").toMatch(ABOUT_LEADS_WITH);
    // v3.9.0-rc.31 — the About string must not carry a SLSA-level overclaim
    // (release.yml earns SLSA Build L2; "SLSA-3"/L3 would be unenforced).
    const slsa = findSlsaOverclaim(meta.description ?? "");
    expect(
      slsa,
      `repo About claims an unenforced SLSA level (${slsa}); release.yml earns SLSA Build L2 — fix via \`gh repo edit ${REPO} --description ...\` to say "SLSA L2"`
    ).toBeNull();
  });

  it("repo Topics include the 8 required memory/positioning keywords", () => {
    if (!available) {
      console.warn("[github-metadata] `gh` not authenticated; skipping (set GH_TOKEN env or GITHUB_TOKEN for CI).");
      return;
    }
    const meta = fetchRepoMeta();
    expect(
      meta,
      "gh api call failed despite gh being available — check rate limit / network / token scope"
    ).not.toBeNull();
    if (!meta) return;
    const missing = findMissingTopics(meta.topics);
    expect(missing, `Missing topics: ${missing.join(", ")}`).toEqual([]);
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
      // v3.7.9 — canonical About lead is now "The most advanced Obsidian MCP"
      // (was "Memory layer for AI agents" before v3.7.8). Update positive +
      // negative cases accordingly.
      expect(validateAboutLeadsWith("The most advanced Obsidian MCP — long-term memory for AI agents")).toBe(true);
      // Case-insensitive — same canonical phrase, lowercase.
      expect(validateAboutLeadsWith("the most advanced obsidian mcp — built")).toBe(true);
      // Negative cases — analyzer MUST flag these.
      expect(validateAboutLeadsWith("Memory layer for AI agents — built on Obsidian.")).toBe(false);
      expect(validateAboutLeadsWith("The most advanced MCP server for Obsidian vaults.")).toBe(false); // "MCP server for Obsidian" ≠ "Obsidian MCP"
      expect(validateAboutLeadsWith("")).toBe(false);
      expect(validateAboutLeadsWith("Long-term memory for AI agents")).toBe(false); // pre-v3.7.8 phrasing
    });

    it("findMissingTopics returns all required topics when given empty input", () => {
      const missing = findMissingTopics([]);
      expect(missing.length).toBe(REQUIRED_TOPICS.length);
      // Spot-check that each required topic is in the missing list.
      for (const required of REQUIRED_TOPICS) {
        expect(missing).toContain(required);
      }
    });

    it("findMissingTopics returns subset when given partial topic list", () => {
      // Pass only 3 of 8 required → 5 should be reported missing.
      const partial = REQUIRED_TOPICS.slice(0, 3);
      const missing = findMissingTopics(partial);
      expect(missing.length).toBe(REQUIRED_TOPICS.length - 3);
      // The 3 we passed must NOT be in missing.
      for (const passed of partial) {
        expect(missing).not.toContain(passed);
      }
    });

    it("findMissingTopics returns [] when all required topics are present (positive control)", () => {
      // Mix required topics with some unrelated extras — analyzer should
      // ignore the extras and report no missing.
      const full = [...REQUIRED_TOPICS, "extra-1", "extra-2"];
      expect(findMissingTopics(full)).toEqual([]);
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
      expect(findSlsaOverclaim("The most advanced Obsidian MCP — no provenance mention")).toBeNull();
      // Guard against false-positive on unrelated digits near "SLSA"-free text.
      expect(findSlsaOverclaim("Supports 3 transports and L3 caching")).toBeNull();
    });

    it("retryUntil recovers a transient blip but still fails a genuine no-auth (v3.11.0-rc.7 flake hardening)", () => {
      const noSleep = (): void => {};
      // NEGATIVE control — a GENUINE failure (every attempt fails) is NOT masked:
      // returns false only AFTER exhausting all attempts (so a truly-unauthenticated
      // gh still reads as unavailable and the CI-GUARD still fails loudly).
      let genuineCalls = 0;
      const genuine = retryUntil(
        () => {
          genuineCalls++;
          return false;
        },
        (b) => b,
        3,
        0,
        noSleep
      );
      expect(genuine, "a truly-unauthenticated gh must still read as unavailable").toBe(false);
      expect(genuineCalls, "must exhaust all retries before concluding failure").toBe(3);

      // POSITIVE — a TRANSIENT blip (fails attempts 1-2, succeeds on 3) recovers to true.
      let transientCalls = 0;
      const transient = retryUntil(
        () => {
          transientCalls++;
          return transientCalls >= 3;
        },
        (b) => b,
        3,
        0,
        noSleep
      );
      expect(transient, "a momentary blip that recovers must read as available").toBe(true);
      expect(transientCalls).toBe(3);

      // POSITIVE — first-try success makes NO wasted retries (healthy gh probed once).
      let okCalls = 0;
      const fast = retryUntil(
        () => {
          okCalls++;
          return true;
        },
        (b) => b,
        3,
        0,
        noSleep
      );
      expect(fast).toBe(true);
      expect(okCalls, "a healthy gh is probed exactly once — no backoff penalty").toBe(1);
    });
  });
});
