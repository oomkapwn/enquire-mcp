# Evaluation plan — enquire-mcp

**Status:** pre-registered methodology · **no scores in this document by design.**
**Issued:** 2026-06-29 · **Scope:** how we will measure enquire-mcp's quality, what
counts as a pass/fail, and the bar a number must clear before it appears in the
README, `docs/benchmarks.md`, or any public claim.

This is a *plan*, committed **before** the headline runs, so the method can be
reviewed without front-running a result. It exists because the project's core
brand is **"every claim an auditor can verify"** — and a pre-registered protocol
is how you make a benchmark falsifiable instead of a marketing artifact.

---

## 0. Principles (the bar every number must clear)

1. **Measured — never asserted or estimated.** A figure is published only after it
   is produced by a committed, reproducible harness. No placeholders, no "~", no
   borrowed competitor numbers.
2. **Reproducible.** Every reported number ships with the exact command, the
   harness, the dataset pointer (or a synthetic generator), and a determinism
   contract (fixed bodies, fixed mtimes, pinned model alias).
3. **Reviewed.** Headline numbers (LongMemEval, context-efficiency, any
   cross-tool comparison) go through a maintainer **reference-hardware run +
   sign-off** before they leave `benchmarks.md` for the README hero.
4. **Scoped to what we are.** enquire-mcp is a **retriever / memory layer**, not an
   answer-generating assistant. We report **retrieval quality**, not end-to-end QA
   accuracy — reporting a QA number for a retriever would be an overclaim (the
   answer is the calling agent's job).
5. **Zero result = FAIL, not "n/a".** A query that returns nothing for a question
   that has a ground-truth answer scores 0 and is counted, never silently dropped.
6. **Disclose weaknesses.** Per-class breakdowns report where recall is *weaker*
   (e.g. OCR'd PDF vs native markdown), because honest failure disclosure raises
   credibility — it does not lower it.

---

## 1. Dimensions we measure

| dimension | what it answers | harness | metric |
|---|---|---|---|
| **Retrieval quality** | does the right note rank highly? | `scripts/run-benchmarks.mjs` (`bench:retrieval`) | MRR · NDCG@10 · Recall@10 |
| **Long-term memory** | does recall hold over long, multi-session histories? | `scripts/bench-longmemeval.mjs` (`bench:longmemeval`) | recall@k / MRR / NDCG@k of the answer-bearing session(s) |
| **Context efficiency** | how much less context vs read-every-hit? | `scripts/bench-context.mjs` (`bench:context`) | token ratio (baseline-read ÷ pack) |
| **Freshness awareness** | is a stale fact flagged as stale? | `src/staleness.ts` + `age_days`/`stale` on every hit | stale-flag precision/recall (planned) |
| **Reranker contribution** | does the cross-encoder help? | the ablation in `run-benchmarks.mjs` | Δ NDCG@10 / Δ MRR (fusion → fusion+rerank) |

The **single-source-of-truth metric implementations** live in
[`src/eval.ts`](https://github.com/oomkapwn/enquire-mcp/blob/main/src/eval.ts)
(`recallAtK` / `ndcgAtK` / `reciprocalRank`, dedup-safe), used identically by
every harness and the `enquire-mcp eval` CLI subcommand — so a number cannot drift
between the bench and the shipped tool.

---

## 2. Datasets & conditions

- **Synthetic vault** (committed generators) — deterministic, for the ablation +
  the context-efficiency *method* demonstration. Numbers from it are illustrative,
  never the headline (see §4).
- **LongMemEval** ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813)) — the
  standard long-term-memory benchmark; `longmemeval_s / _m / _oracle`. Not
  committed (size + licensing); downloaded per the `benchmarks.md` instructions.
  Conditions reported separately by `question_type` (single-session, multi-session,
  temporal-reasoning, knowledge-update, abstention).
- **LoCoMo** (planned) — a second long-conversation memory set, to avoid
  over-fitting the protocol to one benchmark's quirks.
- **Representative real vault** — for the context-efficiency headline only, run on
  a real (private) vault on reference hardware; only the *ratio* is reported, never
  vault content.

---

## 3. Grading protocol

- **Retrieval metrics** are computed directly from the ground-truth relevant set
  (no LLM judge needed) — deterministic and exactly reproducible.
- **LLM-as-judge** (only where a judgment is unavoidable, e.g. answer-bearing-span
  relevance that isn't in the labels): use a fixed judge model + temperature,
  **swap the position** of the two items being compared and average both orders to
  cancel position bias, and report inter-run agreement. A judgment that flips on
  the swap is recorded as "uncertain", not silently resolved.
- **Token efficiency** reports **two ratios** — capped-pack vs (a) full-body reads
  of the same hits and (b) a naive whole-folder read baseline — so the number is
  bounded, not a single best-case scenario.
- **Abstention** (`*_abs`) questions are scored separately: the correct behavior is
  *no confident hit*, so they are not folded into recall.

---

## 4. Publication gate (what reaches the README)

A number moves from "the harness can produce it" to "published" only when **all**
hold:

1. produced by the committed harness with the determinism contract met;
2. run on **reference hardware** against a **representative** dataset (not the
   synthetic vault, for any headline);
3. method **reviewed** + the figure **signed off** by the maintainer;
4. pinned by a structural guard where a count/claim is involved (the
   `docs-consistency` / OIA invariants), so it can't silently drift later.

Until then, the harness + its pure-function tests ship, `benchmarks.md` documents
the **method**, and the README does **not** assert the figure. Current
maintainer-gated headlines awaiting a reference run: **LongMemEval retrieval** and
**context-efficiency ("Nx less context")**.

---

## 5. Deliberately out of scope

- **End-to-end QA accuracy** — that measures the *generating agent*, not the memory
  layer. We report retrieval, and let the agent's own evals own the answer.
- **Borrowed metrics** — no competitor's figure is ever restated as ours.
- **Single best-case scenarios** as the headline — every efficiency claim is
  reported as a bounded ratio with the baseline named.

---

## Related

- [`docs/benchmarks.md`](./benchmarks.md) — the live results + full methodology +
  reproducibility contract.
- [`src/eval.ts`](https://github.com/oomkapwn/enquire-mcp/blob/main/src/eval.ts) —
  the metric implementations shared by every harness.
- `scripts/run-benchmarks.mjs` · `scripts/bench-longmemeval.mjs` ·
  `scripts/bench-context.mjs` — the harnesses.
