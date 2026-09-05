#!/usr/bin/env node
// Apply a CI-emitted release-mutation transition authority to the working tree.
//
// The docs job uploads `emitted-release-mutation-transition` on every run (see
// ci.yml). Registering a reviewed source change means taking that artifact and
// writing three things: the fixture itself, its digest pin in
// meta-invariant-coverage.test.ts, and — when the matrix source moved — the
// CURRENT_HYBRID_SOURCE_SHA256 pin in release-mutation-identity-audit.ts.
//
// This script does exactly that, and refuses unless the artifact passes the
// same controls a reviewer applies by hand:
//   - byte format is the generator's (JSON.stringify(x, null, 2) + LF);
//   - the set of source ids is unchanged and no `witness.from` moved;
//   - the ids whose `witness.to` moved are exactly the ones named in --allow;
//   - the six inventory arrays keep their lengths;
//   - `current` differs only in matrixSourceSha256 / matrixSliceSha256;
//   - each pin being rewritten still equals the committed value (a stale tree
//     is refused rather than silently repinned).
//
// Usage:
//   gh run download <run-id> -n emitted-release-mutation-transition -D <dir>
//   node scripts/apply-transition-artifact.mjs <dir> --allow workflow.ci,manifest.package-lock [--dry-run]
//
// Pure Node built-ins; no dependencies, no network.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests/fixtures/release-mutation-transition.v3.json");
const META = path.join(ROOT, "tests/meta-invariant-coverage.test.ts");
const AUDIT = path.join(ROOT, "tests/release-mutation-identity-audit.ts");
const INVENTORIES = [
  "unchangedSources",
  "newSources",
  "retiredSources",
  "identityTransitions",
  "unchangedIdentities",
  "newIdentities"
];

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const fail = (message) => {
  console.error(`apply-transition-artifact: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) fail("usage: apply-transition-artifact.mjs <artifact-dir> [--allow id,id] [--dry-run]");
const dryRun = args.includes("--dry-run");
const allowArg = args.find((a) => a.startsWith("--allow="))?.slice("--allow=".length) ?? "";
const allowed = new Set(
  allowArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const artifactText = readFileSync(path.join(dir, "release-mutation-transition.v3.json"), "utf8");
const committedText = readFileSync(FIXTURE, "utf8");
const artifact = JSON.parse(artifactText);
const committed = JSON.parse(committedText);

// ── controls ────────────────────────────────────────────────────────────────
if (`${JSON.stringify(artifact, null, 2)}\n` !== artifactText) {
  fail("artifact is not in the generator's byte format (JSON.stringify(x, null, 2) + LF)");
}
const witnesses = (doc) => new Map(doc.sourceChanges.map((c) => [c.id, c.witness]));
const aw = witnesses(artifact);
const fw = witnesses(committed);
const ids = [...fw.keys()].sort();
if (JSON.stringify(ids) !== JSON.stringify([...aw.keys()].sort())) {
  fail("the set of sourceChanges ids differs from the committed fixture");
}
const movedFrom = ids.filter((id) => aw.get(id).from !== fw.get(id).from);
if (movedFrom.length) fail(`historical witness moved for ${movedFrom.join(", ")} — never expected`);
const moved = ids.filter((id) => aw.get(id).to !== fw.get(id).to);
const unexpected = moved.filter((id) => !allowed.has(id));
if (unexpected.length) {
  fail(`witness.to moved for ${unexpected.join(", ")}; name each intended id with --allow=`);
}
const notMoved = [...allowed].filter((id) => !moved.includes(id));
if (notMoved.length) fail(`--allow named ${notMoved.join(", ")} but it did not move`);
for (const key of INVENTORIES) {
  if (artifact[key].length !== committed[key].length) {
    fail(`${key} length changed ${committed[key].length} → ${artifact[key].length}; not a witness-only transition`);
  }
}
const currentDiff = Object.keys(artifact.current).filter((k) => artifact.current[k] !== committed.current[k]);
const allowedCurrent = new Set(["matrixSourceSha256", "matrixSliceSha256"]);
if (currentDiff.some((k) => !allowedCurrent.has(k))) {
  fail(`current changed in ${currentDiff.join(", ")}; only the matrix digests may move`);
}
if (moved.length === 0 && currentDiff.length === 0) {
  console.log("artifact equals the committed fixture — nothing to apply");
  process.exit(0);
}

const meta = readFileSync(META, "utf8");
const pinMatch = /const RELEASE_MUTATION_TRANSITION_FIXTURE_SHA256 = "([0-9a-f]{64})";/.exec(meta);
if (!pinMatch) fail("fixture digest pin not found in meta-invariant-coverage.test.ts");
if (pinMatch[1] !== sha256(committedText)) {
  fail("the committed fixture digest pin does not match the committed fixture; the tree is already stale");
}
let audit = readFileSync(AUDIT, "utf8");
const hybridMatch = /const CURRENT_HYBRID_SOURCE_SHA256 = "([0-9a-f]{64})";/.exec(audit);
if (!hybridMatch) fail("CURRENT_HYBRID_SOURCE_SHA256 not found in release-mutation-identity-audit.ts");
if (hybridMatch[1] !== committed.current.matrixSourceSha256) {
  fail("CURRENT_HYBRID_SOURCE_SHA256 does not match the committed fixture's matrixSourceSha256");
}

// ── apply ───────────────────────────────────────────────────────────────────
const plan = [
  `fixture: witness.to moved for ${moved.length ? moved.join(", ") : "(none)"}`,
  `fixture digest pin: ${pinMatch[1].slice(0, 12)} → ${sha256(artifactText).slice(0, 12)}`,
  currentDiff.includes("matrixSourceSha256")
    ? `CURRENT_HYBRID_SOURCE_SHA256: ${hybridMatch[1].slice(0, 12)} → ${artifact.current.matrixSourceSha256.slice(0, 12)}`
    : "CURRENT_HYBRID_SOURCE_SHA256: unchanged"
];
console.log(plan.join("\n"));
if (dryRun) process.exit(0);

writeFileSync(FIXTURE, artifactText);
writeFileSync(META, meta.replace(pinMatch[1], sha256(artifactText)));
if (currentDiff.includes("matrixSourceSha256")) {
  audit = audit.replace(hybridMatch[1], artifact.current.matrixSourceSha256);
  writeFileSync(AUDIT, audit);
}
console.log("applied");
