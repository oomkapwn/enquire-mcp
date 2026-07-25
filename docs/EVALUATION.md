# Evaluating retrieval quality in enquire-mcp

enquire ships a **built-in retrieval-quality harness** so you can *measure* a change instead of guessing. This doc is the methodology + a failure-diagnosis playbook + cost guardrails. It is deliberately honest: a single number never tells the whole story — read the metrics together and by category.

> **What this measures:** *retrieval* quality — does `obsidian_search` rank the answer-bearing notes near the top? It does **not** measure answer generation (that confounds the client LLM). A retrieval number is the honest number for a retriever.

## Quick start

```bash
# 0. (repository-checkout-only smoke) run the committed golden set against the
#    repo's synthetic-vault helper; this helper is not included in the npm package —
#    examples/queries.jsonl targets THAT vault (CI-pinned), so this pair works out of the box:
node -e 'import("./scripts/synthetic-vault.mjs").then(async m => console.log(await m.createSyntheticVault()))'
enquire-mcp eval --vault <printed-path> --queries examples/queries.jsonl --per-query

# 1. build the indexes for YOUR vault (once)
enquire-mcp setup --vault <path>

# 2. write a golden set FOR YOUR VAULT (JSONL of {query, relevant, id?, category?} —
#    `relevant` paths must exist in YOUR vault; see examples/queries.jsonl for the format) and run:
enquire-mcp eval --vault <path> --queries <your-set>.jsonl --persistent-index --per-query

# 3. write a result JSON for A/B analysis
enquire-mcp eval --vault <path> --queries <your-set>.jsonl --persistent-index --output before.json
#    …make a retrieval change, rebuild…
enquire-mcp eval --vault <path> --queries <your-set>.jsonl --persistent-index --output after.json
enquire-mcp eval-compare before.json after.json    # same k/cohort only; nonzero on invalid input or material regression
```

## Golden-set format (JSONL, one query per line)

```json
{"id":"q001","query":"how to create internal links","relevant":["Linking/Internal links.md"],"category":"keyword"}
```

- `query` — the natural-language question sent to `obsidian_search`.
- `relevant` — vault-relative paths that SHOULD be retrieved (binary relevance; each is gain 1).
- `id` *(optional)* — a stable id for the per-query report.
- `category` *(optional)* — a grouping key (e.g. `keyword`, `conceptual`, `temporal-reasoning`, `knowledge-update`, `preference`). When present, the eval reports the same metrics **per category** — the highest-value diagnostic slice.

Blank lines and `//` comment lines are tolerated. Keep the golden set **committed** (it's the contract every run shares); keep the generated result JSON **gitignored**.

## Metrics — read them together

| Metric | Measures | Read it when |
|---|---|---|
| **nDCG@k** *(primary; @5 + @10)* | ranking quality — is the most relevant result near the top? | comparing overall ranking |
| **MRR** | rank of the *first* relevant result | the user clicks the first hit and stops |
| **Hit@1 / Hit@k** | is *any* relevant doc at rank 1 / in top-k? (binary) | "did we surface it at all?" |
| **Recall@k** (= `evidence_coverage_k`) | fraction of *all* relevant docs found in top-k | diagnosing retrieval vs ranking |
| **AllRel@k** | fraction of queries where *every* relevant doc is in top-k | multi-evidence questions |

Rules of thumb: nDCG@5 **0.9+ excellent, 0.7+ good, <0.5 poor**. The compare tool uses `|Δ| ≥ 0.01` as a fixed **material-effect CI threshold**, not a significance test; smaller changes may still be real. Use 50+ queries for a more stable directional estimate, and use paired uncertainty analysis before making a statistical claim.

## Per-hit ranking explanation (`explain`)

To debug a *single* result's ranking (not an aggregate), call `obsidian_search` with `explain: true`. Every hit then carries an `explain` object exposing each re-rank stage's contribution **and the rank movement it caused** — the thing the aggregate metrics can't show:

- `rrf` — the fused rank/score right after RRF, **before** any re-rank stage (the three ranker arms are in the hit's `per_signal`).
- `graph_boost` — wikilink `in_degree` among the top-K + the `score_delta` added (present only when a hit was boosted).
- `reranker` — the cross-encoder score + `rank_before`/`rank_after` (present only with `--enable-reranker`).
- `recency` / `feedback` — the note's age / recency score / feedback score + `rank_before`/`rank_after` (present only when `--recency-weight` / `--feedback-weight` are active).
- `final_rank` — the hit's 0-based position in the returned results.

This is the concrete way to **validate that the opt-in `--recency-weight` and `--feedback-weight` re-ranks actually change the order** (both are otherwise evidence-poor): if `rank_before === rank_after` for every hit, that stage did nothing for this query. Diagnostic-only, single-query, privacy-safe (scores/ranks/ages, no extra content); omit it (the default) and the response is byte-identical.

## How to interpret failures

Start with `summary`, then `by_category` (weakest nDCG first), then the worst `per_query` rows (`missed_paths` + `top_paths`):

- **Low `Hit@1`, high `Hit@k`/`Recall@k`** → the answer is retrieved but ranked below distractors. Look at scoring fusion (RRF), the reranker, and exact entity/date boosts.
- **Low `Recall@k`, many `missed_paths`** → the answer note isn't retrieved at all. Look at chunking, the embedding model, query expansion (HyDE / multi-query), and whether metadata (dates) should be indexed more explicitly.
- **Weak `temporal-reasoning` / `knowledge-update`** → stale evidence outranks newer corrective notes. This is exactly what enquire's **freshness-aware recency ranking** (`--recency-weight` / `--stale-days`) targets — run the eval with it **on vs off** and compare.
- **Weak `preference`** → short, stable preference statements get drowned out by longer context.
- **A query in the `error` failure bucket** → `obsidian_search` threw or reported a requested retrieval signal failure (for example, a reranker/model error). This is infrastructure/configuration, not relevance; the query scores zero and the run is invalid for publication until re-run cleanly.

## Failure buckets

Every query is classified (zero extra cost, derived from the scored top-k): `hit_rank_1`, `hit_top_k`, `miss`, `no_labels`, `error`. The aggregate counts appear under `diagnostics.failure_buckets`. Matrix rows with any query error are labeled `INVALID` and excluded from “best” selection; A/B comparison rejects either input when `query_errors > 0`, and also rejects different `k`, query counts, or canonical query-cohort fingerprints.

## Publishing a number responsibly

If you publish a headline number (e.g. against a peer's LongMemEval protocol), the bar is **measured, reproducible, reviewed — never a placeholder**:

1. Pin the corpus, query set, relevance judgments, `k`, embedding model, and cold/warm state; publish the exact command + raw per-query outputs.
2. **Disclose the embedding backend** (local on-device vs a cloud/OpenAI-compatible model) — they are not comparable.
3. **Disclose the scope** — a per-question scoped haystack is not a global vault search; say which you ran.
4. Report the `by_category` breakdown, not just the aggregate — and lead with the categories your differentiators address.
5. If you can't match a peer's exact protocol, publish as **two independent measurements**, not a head-to-head.

## LongMemEval-S peer-protocol comparison (vs obsidian-hybrid-search)

> **Repository checkout only:** the benchmark helper below is contributor tooling and is not included in the npm package.

`scripts/bench-longmemeval.mjs` reproduces the closest peer's public
**global-index + scope-per-question** shape at its evidence-pinned commit
`c0922d955f5bf5abaad14a11cbb3e11303cd6036`: every non-abstention question is
materialized under its own folder, one index is built over the selected cohort,
and each query is folder-scoped to its own haystack. This preserves global
BM25/TF-IDF corpus statistics without turning the task into an unscoped search.
At the required **k=10**, it reports **nDCG@5, nDCG@10, MRR, Hit@1, Hit@5,
Recall@10, AllRel@10** overall, by `question_type`, and per query.

```bash
# 1. Download the official cleaned LongMemEval-S dataset (NOT committed):
curl -fL \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json \
  -o longmemeval_s_cleaned.json
# 2. Run the global-index/scoped protocol. `--limit N` is diagnostic-only;
#    omit it from a publishable full-cohort run.
npm run build
node scripts/bench-longmemeval.mjs \
  --dataset longmemeval_s_cleaned.json \
  --dataset-source https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json \
  --k 10 --embeddings --recency-compare \
  --output eval/results/longmemeval-s.json
```

The current canonical cohort is content-pinned at 277,383,467 bytes,
SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`,
and 500 instances. Any different bytes or selected subset remains a
`diagnostic-partial` artifact even when its filename looks official.

**Categories** (from LongMemEval `question_type`): `single-session-user` / `single-session-assistant` / `single-session-preference` / `multi-session` / `temporal-reasoning` / `knowledge-update`. Diagnose by `by_category` weakest-first; `multi-session` (low AllRel@10 = only part of the evidence found), `temporal-reasoning`, and `knowledge-update` are where a static retriever is weakest.

**The freshness differentiator (`--recency-compare`):** runs each question with
`--recency-weight` OFF then ON and reports the per-category delta. Source
session dates become file mtimes by preserving each session's age relative to
its question date and normalizing that age after indexing, immediately before
search. That makes the
production mtime-based re-ranker meaningful without letting the benchmark
calendar date change the result.

### Honest publishing (mandatory disclosure)

- **Disclose the embedding backend.** `--embeddings` runs the default **local
  on-device** transformers.js model; without the flag the artifact explicitly
  says BM25 + TF-IDF only. **OHS's pinned 0.895 artifact uses `baai/bge-m3`**,
  which is a different model measurement; do not turn the two numbers into a
  model-controlled head-to-head.
- **Disclose the scope.** This is scoped-per-question retrieval (the peer's protocol), NOT a global unscoped search across the whole corpus — say so.
- **It measures retrieval, not QA.** Ranking the answer-bearing session near the top; answer generation is the calling agent's job.
- Publish the `--output` JSON + exact command. The artifact records dataset
  SHA-256/bytes/source declaration, implementation commit + dirty state,
  privacy-safe hardware/runtime metadata, phase timings/peak RSS, summaries,
  categories, and raw per-query paths/metrics. Any `--limit` run is stamped
  `diagnostic-partial`; a full canonical run from a dirty or unresolvable Git
  state is stamped `diagnostic-untrusted`. Only `status: complete` with
  `publishable: true` may be used as the headline.

## Cost / re-indexing guardrails

The full LongMemEval-S vault is ~22k notes. The dedicated harness builds one
temporary global index per invocation and removes it afterward, so a full dense
run remains expensive even though it no longer rebuilds per question. Use a
small `--limit` canary first; then **run the full cohort once, keep its JSON, and
analyze that artifact**. The general `enquire-mcp eval` command has a separate
persistent-index workflow for user-owned vaults.

## Repository source map

The source paths below are useful in a repository checkout. The supported packaged comparison entrypoint is `enquire-mcp eval-compare`.

- `src/eval.ts` — pure metrics (`ndcgAtK`/`recallAtK`/`reciprocalRank`/`hitAtK`/`allRelevantAtK`), `groupByCategory`, `compareEvalResults`, `runEval`, formatters.
- `enquire-mcp eval-compare` — packaged A/B delta command; `npm run eval:compare -- …` is its source-checkout alias.
- `scripts/bench-longmemeval.mjs` — repository-checkout-only LongMemEval retrieval harness (not included in the npm package).
- `examples/queries.jsonl` — a small categorized golden set targeting the repo's SYNTHETIC quick-start vault (`scripts/synthetic-vault.mjs`); every `relevant` path is CI-pinned to that vault by `tests/eval-goldenset-contract.test.ts`. For your own vault, write your own set in the same format.
