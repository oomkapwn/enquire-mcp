# L4 — CI/CD pipeline audit

**Date**: 2026-05-15
**Auditor**: Sub-agent C4 (background)
**Scope**: `.github/workflows/*.yml`, branch protection vs ruleset alignment, GH Pages enablement, deprecation hygiene
**Repo**: `oomkapwn/enquire-mcp` (despite the local `obsidian-mcp` working directory name)

## TL;DR — 2 HIGH, 1 MEDIUM, 2 LOW, 1 INFO

| Check | Status |
|---|---|
| CI workflow triggers + permissions | ✅ |
| CI Node matrix matches engines + reality | ⚠️ — Medium drift (engines `>=20`, CI runs `[22,24]`) |
| CI action versions current (`@v6`/`@v7` floor) | ✅ |
| CI required jobs exist + names match branch protection | ✅ — 7/7 |
| Release.yml SHA-on-main verification functional | ✅ |
| Release.yml REQUIRED contexts regex matches reality | ✅ |
| Release.yml npm publish uses `--provenance --access public --tag` | ✅ — provenance attestation present on `3.6.0` |
| Release.yml dist-tag regex handles all 3 prerelease patterns | ✅ — `-rc.N`, `-beta.N`, `-alpha.N` all routed correctly |
| publish-docs.yml permissions minimal | ✅ |
| publish-docs.yml action versions current | ✅ |
| publish-docs.yml concurrency: serialize but don't cancel | ✅ |
| **publish-docs.yml: has it run successfully on main yet?** | ❌ **HIGH — 0 of 2 runs succeeded** |
| dist-tag-cleanup.yml manual-only + idempotent | ✅ |
| Branch protection (classic) vs ruleset (modern): same 7 checks | ⚠️ **HIGH — both list 7 same checks but BOTH are configured, drift risk** |
| Recent CI runs: no `set-output` / `save-state` / `node12` deprecations | ✅ |
| npm-side deprecations in install logs | ℹ️ informational (`prebuild-install`, `boolean`) |

## Detailed findings

### L4-01 (HIGH) — `publish-docs.yml` has failed every run since rc.4 introduction

**Class**: workflow committed but prerequisite repo-level config not enabled. Workflow has run twice on main since rc.4 shipped GH Pages auto-publish (PR #68 merge + PR #69 merge) and failed both times. The TypeDoc-generated site at https://oomkapwn.github.io/enquire-mcp/ that README + audit plan reference does not exist.

**Evidence**:
- `gh run list --workflow=publish-docs.yml` → 2 runs, both `failure`:
  - `25917950064` (rc.4 merge, 2026-05-15T12:32:36Z): failed at `actions/configure-pages@v6`
  - `25918407027` (v3.6.0 stable merge, 2026-05-15T12:43:23Z): failed at `actions/configure-pages@v6`
- Failure message (run 25918407027, build job, line `Run actions/configure-pages@v6`):
  > `##[error]Get Pages site failed. Please verify that the repository has Pages enabled and configured to build using GitHub Actions, or consider exploring the `enablement` parameter for this action. Error: Not Found`
- `gh api repos/oomkapwn/enquire-mcp/pages` → HTTP 404 (`Not Found`)
- `gh api repos/oomkapwn/enquire-mcp | jq .has_pages` → `false`
- Workflow body (`.github/workflows/publish-docs.yml:42`): `- uses: actions/configure-pages@v6` — no `with: enablement: true`, so it expects Pages to already be on.

**Impact**: 
- The `Publish API docs` job has shown red ✘ next to every main-branch run since rc.4. Anyone visiting the Actions tab sees this as "CI is broken on main" even though the 7 required jobs all pass.
- The README and `v3.6.0-system-audit-plan.md` both reference TypeDoc pages at `oomkapwn.github.io/enquire-mcp/` that don't exist.
- The rc.4 CHANGELOG (line 4 of `publish-docs.yml`) advertises auto-publish of API reference — currently a no-op.

**Cross-cutting check**:
- Is GH Pages mentioned elsewhere as available?
  - `README.md` — check needed in L6 audit (TypeDoc badge / link)
  - `docs/audits/v3.6.0-system-audit-plan.md` line 5–10 references `github.io` site
  - `package.json` doesn't add a `homepage` pointing to pages (it points to GitHub repo `#readme`)
  - The `publish-docs.yml` workflow header comment (line 6) says "lives at https://oomkapwn.github.io/enquire-mcp/" — not yet true.

**Suggested class fix** (one of):
1. **Enable Pages once**: `gh api -X POST repos/oomkapwn/enquire-mcp/pages -f source.branch=main -f build_type=workflow` then re-run the workflow via `gh workflow run publish-docs.yml`. After first successful deploy, future runs will work.
2. **Set `enablement: true` on configure-pages**: `actions/configure-pages@v6` accepts a `with: enablement: true` input that auto-enables Pages on first run. Requires the `pages: write` permission already present.
3. **Don't merge this workflow until Pages is enabled** (already too late, but flag in pre-merge checklist for future workflows that depend on repo features).

**Per-instance backfill**: enable Pages + manually rerun `publish-docs.yml` workflow_dispatch → confirms first green run → README/audit-plan claims become true.

**Severity rationale**: HIGH because (a) workflow is shipping red status checks on every main push, polluting the dashboard; (b) public-facing claim (TypeDoc site live) is false; (c) trivial fix (one API call or one YAML line).

---

### L4-02 (HIGH) — Branch protection: both legacy "branch protection" AND modern "ruleset" are configured, duplicate state

**Class**: GitHub has two ways to require status checks — `branches/main/protection` (legacy, classic) and `rulesets/15878550` (modern). Both endpoints return the same 7 required checks today, but having both configured means any future change must be made in two places or they will drift.

**Evidence**:
- `gh api repos/oomkapwn/enquire-mcp/branches/main/protection`:
  ```
  contexts: ["lint","test (22)","test (24)","smoke","audit","coverage","version-consistency"]
  ```
- `gh api repos/oomkapwn/enquire-mcp/rulesets/15878550`:
  ```
  required_status_checks: [lint, test (22), test (24), smoke, audit, coverage, version-consistency]
  enforcement: active
  bypass_actors: [{actor_id:5, actor_type:RepositoryRole, bypass_mode:pull_request}]
  ```
- Both APIs return the same 7 contexts. No drift today.
- Ruleset was last `updated_at: 2026-05-13T14:59:26` (the v3.5.11 Node-20 drop) — recent maintenance shows the maintainer remembers to update it.
- The legacy branch-protection API ALSO has dismiss-stale-reviews / restrictions that the ruleset doesn't seem to mirror. Suggests both are independently active.

**Impact**: 
- Low impact today (both lists agree).
- Class risk: when the next CI job is added or renamed, the maintainer needs to update BOTH places. The audit plan only mentions checking the ruleset URL (`rulesets/15878550`) — would miss drift on the legacy `branches/main/protection` side.
- The release.yml regex `lint|test \(22\)|test \(24\)|smoke|audit|coverage|version-consistency` (release.yml:56) is implicitly the third source of truth — three places must stay synchronized.

**Cross-cutting check**:
- `release.yml:56` `REQUIRED="lint|test \(22\)|test \(24\)|smoke|audit|coverage|version-consistency"` — matches today.
- `release.yml:66` `REQ_COUNT=7` — matches today.
- `README.md` line referencing "7 required" — matches today (confirmed earlier).
- Total: 4 sources of truth (branch-protection contexts, ruleset required_status_checks, release.yml REQUIRED regex, release.yml REQ_COUNT, README badge text). All currently agree.

**Suggested class fix** (one of):
1. **Pick one**: GitHub recommends migrating off legacy branch protection to rulesets. Delete the legacy protection (`gh api -X DELETE repos/oomkapwn/enquire-mcp/branches/main/protection`) and rely on the ruleset alone. After deletion, only 1 GitHub-side source of truth.
2. **Document the dual-config in CLAUDE.md**: add a "when adding a CI job" checklist that mentions BOTH endpoints + release.yml regex + REQ_COUNT.
3. **Lint at audit time**: simple shell script that diffs the 4 sources of truth — could live in `scripts/check-required-checks-consistency.mjs` and become a 5th invariant gate. Class fix in the spirit of L-1 from prior audits.

**Per-instance backfill**: no drift today → no backfill needed. Just close the class.

**Severity rationale**: HIGH because the class is real (4 sources of truth that the maintainer must keep in sync by hand) and the audit plan in section "Branch protection vs ruleset alignment" explicitly flagged this as a check. Currently green; staying green requires either consolidation or an automated invariant.

---

### L4-03 (MEDIUM) — `package.json#engines.node` says `>=20` but CI dropped Node 20 in v3.5.11

**Class**: `engines` field in package.json drifts from what's actually CI-verified. Users on Node 20 may install successfully but hit untested code paths.

**Evidence**:
- `package.json:149-151`:
  ```json
  "engines": {
    "node": ">=20"
  }
  ```
- `.github/workflows/ci.yml:45`: `matrix.node-version: [22, 24]` — Node 20 dropped.
- `CHANGELOG.md` v3.5.11 entry (lines 483, 501) explicitly says this is INTENTIONAL:
  > "Engines `>=20` UNCHANGED for non-PDF users on prebuilt dist."
  > "end users on Node 20 installing from the npm registry get the prebuilt `dist/` (no local tsc) and the PDF feature simply degrades to 'not available'"

**Impact**: 
- Documented and intentional decision, NOT a bug per the CHANGELOG.
- But: users on Node 20 are running prebuilt code that was never CI-tested against Node 20. Drift risk: anything that landed after v3.5.11 (rc.1..stable) may use a Node 22+ API and silently break on Node 20 with no CI gate to catch it.
- Specifically `engines` doesn't have `engine-strict`, so npm won't refuse install on Node 20.

**Cross-cutting check**:
- `README.md` Node requirement section: check needed in L6 audit (does the README clearly say "Node 22+ required for PDF feature, Node 20 supported for non-PDF"?).
- `STABILITY.md` — would need to be checked for an explicit "Node 20 support tier" stability claim.
- `docs/QUICKSTART.md` — does it mention Node 22 requirement?

**Suggested class fix** (one of):
1. **Bump engines to `>=22`** to match reality. Aligns with EOL of Node 20 (2026-04). One-line change.
2. **Add a periodic Node 20 advisory job** (mirroring the existing test-macos pattern: `continue-on-error: true`, not required by branch protection, but catches regressions). Cheapest if maintaining Node 20 support is genuinely valuable.
3. **Document the tier explicitly in README** ("Node 22+ required for full feature set; Node 20 prebuilt-binary install path supported best-effort, not CI-tested").

**Per-instance backfill**: not blocking. Most users are already on Node ≥22 (per the npm distribution data). The risk is hypothetical until a real Node 20-incompatible API gets used.

**Severity rationale**: MEDIUM because it's a documented, intentional decision but adds technical debt (drift surface) every release. The CHANGELOG comment in v3.5.11 admits this is a deferred decision.

---

### L4-04 (LOW) — `dist-tag-cleanup.yml` is a one-shot that has not run

**Class**: workflow committed for a one-time cleanup but never executed; lives on as orphan code.

**Evidence**:
- `.github/workflows/dist-tag-cleanup.yml:1-48`: one-shot cleanup to remove stale `alpha` + `beta` dist-tags pointing at v2.0 prerelease versions.
- `npm view @oomkapwn/enquire-mcp dist-tags` → `{'latest': '3.6.0', 'rc': '3.6.0-rc.4'}` — only `latest` and `rc` exist today. No stale `alpha` or `beta`.
- Either (a) the cleanup ran via `workflow_dispatch` outside the audit window, or (b) the tags self-cleared somehow, or (c) the tags were never set on this scope after the package rename — checking via `npm view @oomkapwn/enquire-mcp@beta` would clarify but it's not critical.

**Impact**: 
- Zero runtime impact (file just sits there).
- Repository hygiene: dead workflow file. If the cleanup already ran, the file should be deleted.
- `permissions: id-token: write` (line 22) is requested for OIDC but the actual cleanup commands don't need it (`npm dist-tag rm` uses `NPM_TOKEN`). Slightly over-broad permission.

**Cross-cutting check**:
- No other one-shot workflows in `.github/workflows/`.
- The file has the right safety pattern (`confirm: REMOVE` input) so even if accidentally triggered, it's gated.

**Suggested class fix**:
1. **Verify cleanup state**: `npm view @oomkapwn/enquire-mcp@beta version` — if 404, cleanup is done.
2. **Remove the workflow file** if cleanup is done. One commit, audit trail in CHANGELOG.
3. **OR if kept "in case"**: drop `id-token: write` to `contents: read` only — the file doesn't use OIDC.

**Per-instance backfill**: trivial cleanup or no-op decision. Low severity, low priority.

---

### L4-05 (LOW) — `coverage` job in `ci.yml` is NOT in `needs:` chain of `smoke`/`audit` (already by design, but worth a note)

**Class**: parallel job dependency graph — `coverage` runs after `test` (line 80 `needs: test`), but `audit` (line 120) and `version-consistency` (line 139) have no `needs:` so they run in parallel with everything else.

**Evidence**:
- `ci.yml:80`: `coverage` has `needs: test`
- `ci.yml:102`: `smoke` has `needs: test`
- `ci.yml:120`: `audit` — no `needs`, runs in parallel
- `ci.yml:139`: `version-consistency` — no `needs`, runs in parallel

**Impact**: 
- This is actually CORRECT for fast-fail behavior — `audit` (npm audit) and `version-consistency` (script check) don't depend on test results, so running them in parallel saves wall-clock time and surfaces unrelated regressions independently.
- No actual bug here.

**Cross-cutting check**: none needed.

**Suggested class fix**: none — current setup is optimal. Filed as informational.

**Severity rationale**: LOW (effectively INFO) — the audit plan asked to verify all required jobs exist + reference correct check names; both confirmed. The parallel dependency graph is intentional and good.

---

### L4-06 (INFO) — npm-side deprecation noise in `npm ci` logs (not GH Actions deprecations)

**Class**: transitive deps emit `npm warn deprecated` lines in every CI install. Cosmetic, not blocking.

**Evidence** (from runs 25918411923, 25918407052, 25917953901, 25911650374):
```
npm warn deprecated prebuild-install@7.1.3: No longer maintained...
npm warn deprecated boolean@3.2.0: Package no longer supported...
```
- `prebuild-install` is a transitive dep of `better-sqlite3` / native modules. No newer version exists.
- `boolean` is a transitive dep (likely from one of the embeddings/HF tooling chains).

**No GH Actions deprecation warnings found**:
- Searched 4 recent CI runs (3 layers x 7 jobs each = 28 job logs) for `deprecat`. Only npm warnings. No `set-output`, `save-state`, `node12`, or other Action-runner deprecations.
- All actions are `@v6` or `@v7` floor — current major versions.
  - `actions/checkout@v6` ← upstream latest `v6.0.2` ✓
  - `actions/setup-node@v6` ← upstream latest `v6.4.0` ✓
  - `actions/upload-artifact@v7` ← upstream latest `v7.0.1` ✓
  - `actions/configure-pages@v6` ← upstream latest `v6.0.0` ✓
  - `actions/upload-pages-artifact@v5` ← upstream latest `v5.0.0` ✓
  - `actions/deploy-pages@v5` ← upstream latest `v5.0.0` ✓

**Impact**: cosmetic log noise only. Not a hygiene issue.

**Cross-cutting check**: none.

**Suggested class fix**: none — wait for upstream maintainers of `prebuild-install` / `boolean` to update their packages or for native deps to switch to a different prebuild tool. Out of our control.

**Severity rationale**: INFO — proactive note that the deprecation hygiene check passed cleanly. Recorded for traceability.

---

## Workflow-by-workflow summary

### `.github/workflows/ci.yml` (148 lines)

| Aspect | Status | Notes |
|---|---|---|
| Trigger events (line 3–7) | ✅ | `push` + `pull_request` on `main`. Correct. |
| Permissions (line 9–10) | ✅ | `contents: read` only. Minimal. |
| Concurrency (line 12–14) | ✅ | `ci-${{github.ref}}`, cancel-in-progress. Standard. |
| Job: `lint` (line 17–27) | ✅ | Single-node 22, biome check, 5min timeout. |
| Job: `test` matrix (line 29–55) | ⚠️ | `[22, 24]` — matches v3.5.11 decision. Drift from `engines: >=20` (see L4-03). |
| Job: `test-macos` (line 57–75) | ✅ | Advisory only, `continue-on-error: true`. |
| Job: `coverage` (line 77–97) | ✅ | `needs: test`, includes `check:changelog-coverage` gate (line 92), uploads coverage artifact (`upload-artifact@v7`). |
| Job: `smoke` (line 99–118) | ✅ | `needs: test`, scan + FTS5 paths covered. |
| Job: `audit` (line 120–137) | ✅ | Prod `--audit-level=moderate`, dev `--audit-level=high`. |
| Job: `version-consistency` (line 139–147) | ✅ | Runs `scripts/check-version-consistency.mjs`. |
| Required-check names | ✅ | All 7 (`lint`, `test (22)`, `test (24)`, `smoke`, `audit`, `coverage`, `version-consistency`) appear in `check-runs` API. Match branch-protection list exactly. |
| Action versions | ✅ | All `@v6`/`@v7` floor. Match current upstream majors. |

### `.github/workflows/release.yml` (120 lines)

| Aspect | Status | Notes |
|---|---|---|
| Triggers (line 3–12) | ✅ | Tag push `v*` + `workflow_dispatch`. |
| Permissions (line 14–16) | ✅ | `contents: read` + `id-token: write` for OIDC provenance. |
| Checkout with `fetch-depth: 0` (line 28) | ✅ | Required for `git merge-base --is-ancestor`. |
| SHA-on-main verification (line 35–47) | ✅ | `git fetch origin main --depth=200` + `git merge-base --is-ancestor`. Tested green on v3.6.0 release. |
| Required-CI-checks verification (line 48–77) | ✅ | Regex `lint\|test \(22\)\|test \(24\)\|smoke\|audit\|coverage\|version-consistency` matches all 7 ruleset entries. `REQ_COUNT=7` matches. Polls up to 5min for in-flight CI. |
| Pre-publish gates (line 84–96) | ✅ | `npm ci`, lint, build, test, version-consistency, audit, smoke (scan + FTS5). Triple-redundant with the SHA-on-main verification — belt + suspenders. |
| Dist-tag derivation (line 97–115) | ✅ | Regex `/^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/` correctly routes: `3.6.0-rc.4 → rc`, `2.0.0-beta.4 → beta`, `2.0.0-alpha.0 → alpha`, `3.6.0 → latest`. All 3 prerelease patterns we've used handled. Edge cases (build metadata `+`, no `.N` suffix) also handled per the v2.0.0-beta.2 P0 comment. |
| Publish step (line 116–119) | ✅ | `npm publish --provenance --access public --tag "${tag}"`. Verified: `npm view @oomkapwn/enquire-mcp@3.6.0` has `dist.attestations.provenance` populated with `predicateType: https://slsa.dev/provenance/v1`. SLSA-3 claim valid. |

### `.github/workflows/publish-docs.yml` (57 lines)

| Aspect | Status | Notes |
|---|---|---|
| Triggers (line 9–14) | ✅ | `push: branches: [main]` + `workflow_dispatch`. |
| Permissions (line 19–22) | ✅ | `contents: read` + `pages: write` + `id-token: write`. Minimum for GH Pages OIDC deploy. No over-broad scope. |
| Concurrency (line 26–28) | ✅ | `group: pages`, `cancel-in-progress: false`. Serializes deploys (good — aborted upload would corrupt site state). |
| Build job (line 30–45) | ✅ structure / ❌ runtime | YAML correct; fails at runtime because Pages is not enabled (see L4-01). |
| Deploy job (line 47–57) | ❌ runtime | Cannot run; depends on failed build job. |
| Action versions | ✅ | `actions/checkout@v6`, `actions/setup-node@v6`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`. All match latest upstream majors. |

### `.github/workflows/dist-tag-cleanup.yml` (48 lines)

| Aspect | Status | Notes |
|---|---|---|
| Triggers (line 12–18) | ✅ | `workflow_dispatch` only, requires confirm input `REMOVE`. Cannot fire accidentally. |
| Permissions (line 20–22) | ⚠️ | `contents: read` + `id-token: write`. The `id-token` is unused — `npm dist-tag rm` authenticates via `NPM_TOKEN` env var. Slightly over-broad. |
| Guard (line 28) | ✅ | `if: ${{ inputs.confirm == 'REMOVE' }}`. |
| Idempotency (line 42, 46) | ✅ | `|| true` after each `npm dist-tag rm` — re-running on already-removed tag is safe. |
| Worth keeping? | ⚠️ | One-shot purpose served (no stale tags exist today). See L4-04. |

## Sign-off

L4 verdict: **YELLOW (2 HIGH for v3.6.1 patch)**.

- **L4-01** (HIGH, publish-docs not enabled): trivial fix, prevents red status on every main push, makes README claim true. Recommend fixing as part of v3.6.1.
- **L4-02** (HIGH, dual branch-protection state): no drift today, but class fix (consolidate to ruleset OR add invariant script) prevents future silent drift. Recommend v3.6.1 or v3.6.2.
- **L4-03** (MEDIUM, engines drift): defer to v3.7 or document tier explicitly.
- **L4-04**, **L4-05** (LOW): housekeeping, defer to v3.7.
- **L4-06** (INFO): clean bill of health on Actions-runner deprecations.

Pipeline is structurally sound. Release path is multi-gated (SHA-on-main + check-run verification + in-job re-run of lint/test/audit/smoke + provenance). The one shipping bug is GH Pages, which is repo-level config rather than workflow YAML.
