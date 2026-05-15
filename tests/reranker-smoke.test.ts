import { describe, expect, it } from "vitest";
import { loadReranker, RERANKER_MODELS } from "../src/embeddings.js";

// v3.6.0-rc.4 P0 regression test — class smoke.
//
// Background: the pipeline-based reranker in src/embeddings.ts (v2.9.0
// through v3.6.0-rc.3) was a NO-OP for all 5 catalog models. The
// `text-classification` pipeline softmax'es over the model's
// classification head; BGE-style cross-encoders have a SINGLE output
// class (relevance logit), and softmax over 1 class = 1.0 by
// definition. Pipeline returned `score: 1.0` for every input.
//
// `tests/reranker.test.ts` uses a mock `rerankerOverride` with hand-
// authored score functions, so the bug never surfaced. THIS file
// exercises the REAL model path so future regressions in
// `loadReranker()` get caught.
//
// Gated behind `ENQUIRE_LOAD_RERANKER_SMOKE=1` because:
//   - first run downloads ~30-280 MB of model weights from HuggingFace
//     (depending on alias) — adds 10-60s to a cold CI run
//   - subsequent runs are ~1-2s but still slower than the rest of the
//     test suite which is sub-10s total
//
// **Manual smoke before major releases**:
//   ENQUIRE_LOAD_RERANKER_SMOKE=1 npm test -- tests/reranker-smoke.test.ts
//
// CI smoke (release.yml only — not on every PR): same.

const SMOKE_ENABLED = process.env.ENQUIRE_LOAD_RERANKER_SMOKE === "1";

// All 5 catalog models — every one has to discriminate. If ANY returns
// flat 1.0 for both passages, the same class of bug as v2.9.0..v3.6.0-rc.3
// has crept back in.
const ALIASES_TO_SMOKE = Object.keys(RERANKER_MODELS) as readonly string[];

describe("loadReranker real-model smoke (v3.6.0-rc.4 P0 regression catch)", () => {
  if (!SMOKE_ENABLED) {
    it.skip("(skipped) set ENQUIRE_LOAD_RERANKER_SMOKE=1 to run with real model weights", () => {
      // Placeholder so the describe block isn't empty when skipped.
    });
    return;
  }

  for (const alias of ALIASES_TO_SMOKE) {
    it(`${alias}: scores a RAG-relevant passage HIGHER than an off-topic Tokyo passage`, async () => {
      const reranker = await loadReranker(alias);
      const query = "retrieval augmented generation RAG";
      const passages = [
        "RAG (retrieval-augmented generation) fuses an external knowledge base with a language model to ground answers in retrieved evidence.",
        "Tokyo is the capital of Japan and home to over 13 million people across 23 special wards."
      ];

      const scores = await reranker.score(query, passages);
      expect(scores).toHaveLength(2);

      const ragScore = scores[0];
      const tokyoScore = scores[1];

      // Class regression check #1: scores must not be flat. If both
      // passages get the same score, the pipeline softmax bug is back.
      expect(
        ragScore,
        `Both passages scored identically (${ragScore}) — pipeline softmax bug class is back. ` +
          "Reranker is NOT discriminating between relevant and irrelevant content."
      ).not.toBe(tokyoScore);

      // Class regression check #2: relevant passage must score higher.
      // If this flips, the model is loaded but its output is being
      // interpreted incorrectly (e.g., logit-vs-probability mix-up).
      expect(
        ragScore,
        `${alias}: RAG passage scored ${ragScore} but off-topic Tokyo scored ${tokyoScore}. ` +
          "Either the model is broken or sigmoid/argmax direction is wrong."
      ).toBeGreaterThan(tokyoScore ?? -Infinity);

      // Class regression check #3: scores must be in (0, 1) — sigmoid
      // output. If they're 0/1 binary or outside [0,1], the
      // post-processing is wrong.
      expect(ragScore).toBeGreaterThan(0);
      expect(ragScore).toBeLessThan(1);
      expect(tokyoScore).toBeGreaterThan(0);
      expect(tokyoScore).toBeLessThan(1);
    }, 120_000);
  }
});
