#!/usr/bin/env node
// v3.11.6-rc.5 (eval overhaul) — A/B compare two `enquire eval --output` result JSONs.
//
// Makes a retrieval change measurable rather than asserted: run the eval before
// a change, run it after, and diff the aggregate metrics only when k + the exact
// query cohort match. |Δ| >= 0.01 is a material-effect CI heuristic, not a
// statistical-significance test. Inspired by OHS's `eval:compare`.
//
//   npm run eval -- --vault <v> --queries <q> --output before.json
//   # ...make a retrieval change, rebuild...
//   npm run eval -- --vault <v> --queries <q> --output after.json
//   npm run eval:compare -- before.json after.json
//
// Reads the compiled dist so it shares the exact metric/format code the CLI uses.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { compareEvalResults, formatEvalComparison } = await import(path.join(root, "dist", "eval.js"));

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  process.stderr.write("usage: npm run eval:compare -- <before.json> <after.json>\n");
  process.exit(2);
}

/** A result file may be a single EvalResult or an array (matrix mode). Take the first. */
async function loadResult(p) {
  const parsed = JSON.parse(await fs.readFile(p, "utf8"));
  const r = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!r || typeof r.mean_ndcg !== "number") {
    throw new Error(`${p} is not an enquire eval result JSON (missing mean_ndcg)`);
  }
  return r;
}

const before = await loadResult(beforePath);
const after = await loadResult(afterPath);
const cmp = compareEvalResults(before, after);
process.stdout.write(`${formatEvalComparison(cmp)}\n`);

// Exit 1 if any tracked metric crosses the material regression threshold — so
// CI / a pre-commit hook can gate a retrieval change on the configured effect size.
const regressed = cmp.deltas.filter((d) => d.meaningful && d.delta < 0);
if (regressed.length > 0) {
  process.stderr.write(
    `\n${regressed.length} metric(s) crossed the material regression threshold: ${regressed
      .map((d) => d.metric)
      .join(", ")}\n`
  );
  process.exit(1);
}
