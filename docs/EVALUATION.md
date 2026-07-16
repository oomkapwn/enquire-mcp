# Evaluating retrieval quality in enquire-mcp

enquire ships a **built-in retrieval-quality harness** so you can *measure* a change instead of guessing. This doc is the methodology + a failure-diagnosis playbook + cost guardrails. It is deliberately honest: a single number never tells the whole story — read the metrics together and by category.

> **What this measures:** *retrieval* quality — does `obsidian_search` rank the answer-bearing notes near the top? It does **not** measure answer generation (that confounds the client LLM). A retrieval number is the honest number for a retriever.

## Quick start

```bash
# 1. build the indexes for your vault (once)
enquire-mcp setup --vault <path>

# 2. run the eval against a golden set (JSONL of {query, relevant, id?, category?})
enquire-mcp eval --vault <path> --queries examples/queries.jsonl --persistent-index --per-query

# 3. write a result JSON for A/B analysis
enquire-mcp eval --vault <path> --queries <q>.jsonl --persistent-index --output before.json
#    …make a retrieval change, rebuild…
enquire-mcp eval --vault <path> --queries <q>.jsonl --persistent-index --output after.json
npm run eval:compare -- before.json after.json     # delta table; exits 1 on a meaningful regression
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

Rules of thumb: nDCG@5 **0.9+ excellent, 0.7+ good, <0.5 poor**. A `|Δ| ≥ 0.01` between two runs is meaningful at ~50+ queries; below that is noise. Fewer than 50 queries → treat conclusions as directional.

## How to interpret failures

Start with `summary`, then `by_category` (weakest nDCG first), then the worst `per_query` rows (`missed_paths` + `top_paths`):

- **Low `Hit@1`, high `Hit@k`/`Recall@k`** → the answer is retrieved but ranked below distractors. Look at scoring fusion (RRF), the reranker, and exact entity/date boosts.
- **Low `Recall@k`, many `missed_paths`** → the answer note isn't retrieved at all. Look at chunking, the embedding model, query expansion (HyDE / multi-query), and whether metadata (dates) should be indexed more explicitly.
- **Weak `temporal-reasoning` / `knowledge-update`** → stale evidence outranks newer corrective notes. This is exactly what enquire's **freshness-aware recency ranking** (`--recency-weight` / `--stale-days`) targets — run the eval with it **on vs off** and compare.
- **Weak `preference`** → short, stable preference statements get drowned out by longer context.
- **A query in the `error` failure bucket** → `obsidian_search` threw (infra, not relevance); the means are deflated — re-run before publishing.

## Failure buckets

Every query is classified (zero extra cost, derived from the scored top-k): `hit_rank_1`, `hit_top_k`, `miss`, `no_labels`, `error`. The aggregate counts appear under `diagnostics.failure_buckets`.

## Publishing a number responsibly

If you publish a headline number (e.g. against a peer's LongMemEval protocol), the bar is **measured, reproducible, reviewed — never a placeholder**:

1. Pin the corpus, query set, relevance judgments, `k`, embedding model, and cold/warm state; publish the exact command + raw per-query outputs.
2. **Disclose the embedding backend** (local on-device vs a cloud/OpenAI-compatible model) — they are not comparable.
3. **Disclose the scope** — a per-question scoped haystack is not a global vault search; say which you ran.
4. Report the `by_category` breakdown, not just the aggregate — and lead with the categories your differentiators address.
5. If you can't match a peer's exact protocol, publish as **two independent measurements**, not a head-to-head.

## LongMemEval-S peer-protocol comparison (vs obsidian-hybrid-search)

`scripts/bench-longmemeval.mjs` runs the **same public protocol** the closest peer (`flowing-abyss/obsidian-hybrid-search`, "OHS") publishes: **scope-per-question** (each question materializes its OWN LongMemEval haystack as a temp vault, so search is scoped to that mini-vault — NOT one global search over all ~22k notes) at **k=10**, reporting **nDCG@5, nDCG@10, MRR, Hit@1, Hit@5, Recall@10, AllRel@10** grouped by LongMemEval `question_type`.

```bash
# 1. download the dataset (NOT committed — size + licensing):
#    https://github.com/xiaowu0162/LongMemEval  (longmemeval_s)
# 2. run the peer protocol (local embeddings; add --recency-compare for the differentiator):
npm run build
node scripts/bench-longmemeval.mjs --dataset longmemeval_s.json --k 10 --embeddings \
  --recency-compare --output eval/results/longmemeval-s.json
```

**Categories** (from LongMemEval `question_type`): `single-session-user` / `single-session-assistant` / `single-session-preference` / `multi-session` / `temporal-reasoning` / `knowledge-update`. Diagnose by `by_category` weakest-first; `multi-session` (low AllRel@10 = only part of the evidence found), `temporal-reasoning`, and `knowledge-update` are where a static retriever is weakest.

**The freshness differentiator (`--recency-compare`):** runs each question with `--recency-weight` OFF then ON and reports the per-category Δ. Lead the write-up with this — enquire's `--recency-weight` is designed to help exactly the `temporal-reasoning` / `knowledge-update` / `preference` categories a timeless store ignores (the Memora frontier). This is a story no static-retriever peer can tell.

### Honest publishing (mandatory disclosure)

- **Disclose the embedding backend.** This harness runs **local on-device** embeddings (transformers.js) by default. **OHS's headline 0.895 uses a CLOUD model (`bge-m3` via OpenRouter)** — that is a *different measurement*, not directly comparable to a local number. Our local-first result and a cloud result are two independent points; say which you ran.
- **Disclose the scope.** This is scoped-per-question retrieval (the peer's protocol), NOT a global unscoped search across the whole corpus — say so.
- **It measures retrieval, not QA.** Ranking the answer-bearing session near the top; answer generation is the calling agent's job.
- Publish the `--output` JSON (raw per-category) + the exact command. A credible local-first, scope-disclosed number beats an unauditable headline.

## Cost / re-indexing guardrails

The full LongMemEval-S vault is ~22k notes; indexing it (especially with a cloud embedding model) is slow and can cost API budget. **Run the full eval once, keep the JSON, and analyze it** — don't re-run just to inspect. Re-run only after an intentional model or retrieval-code change. `enquire-mcp eval` reuses the persistent per-vault index (incremental), so a re-run over an unchanged vault + model is fast.

## Files

- `src/eval.ts` — pure metrics (`ndcgAtK`/`recallAtK`/`reciprocalRank`/`hitAtK`/`allRelevantAtK`), `groupByCategory`, `compareEvalResults`, `runEval`, formatters.
- `scripts/eval-compare.mjs` — A/B delta tool (`npm run eval:compare`).
- `scripts/bench-longmemeval.mjs` — LongMemEval retrieval harness.
- `examples/queries.jsonl` — a small categorized golden set for the synthetic/quick-start vault.
