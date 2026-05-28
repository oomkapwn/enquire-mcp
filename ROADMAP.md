# enquire-mcp — Roadmap

> Public roadmap for **enquire-mcp**, the long-term-memory MCP server backed by your local Obsidian vault. Updated 2026-05-25 after a full state-driven audit (code + docs + workflows) and a competitive survey of the Obsidian-MCP, AI-memory, and RAG-MCP landscapes.
>
> **North Star:** be — and confidently *stay* — the best project in its spheres (Obsidian MCP; local-first AI-memory layer) on **technology** and **reliability**. "Confidently" means every claim we make is one an external auditor or a privacy-conscious user can verify against the code.

This is the *public* roadmap. Per-release detail lives in [`CHANGELOG.md`](./CHANGELOG.md); internal methodology + audit history lives in `CLAUDE.md`.

---

## Where we are (v3.9.0-rc train, on `@rc`; stable `@latest` = v3.8.x)

Already shipped and differentiating:

- **Full hybrid retrieval** — BM25 + TF-IDF + multilingual ML embeddings, RRF-fused, with optional BGE cross-encoder reranking (**+15.5 NDCG@10 / +24.7 MRR** measured on a 60-query ablation).
- **HNSW vector index** with **in-memory live update** on file changes (search reflects edits within ~250ms) + close-time disk persistence + int8 quantization + adaptive refill under heavy privacy filtering.
- **Agentic RAG** — HyDE (Gao et al 2023) + sub-question decomposition.
- **GraphRAG-light** — Louvain community detection over the wikilink graph.
- **Standalone Obsidian Bases** `.base` query execution (no Obsidian process needed).
- **PDFs blended into search** with `[page: N]` citations + Tesseract OCR for scanned docs.
- **Process maturity** — 926 tests, 9 required CI gates, semver-bound public surface, signed npm build provenance (SLSA Build L2), 8 state-driven OIA drift checks, structural invariant suite.

## Competitive read (why the roadmap is shaped the way it is)

- **vs other Obsidian MCPs** (bitbonsai/mcpvault, jacksteamdev/obsidian-mcp-tools, …): we are technically ahead — most are CRUD + keyword; the semantic ones need the Obsidian REST plugin. We are standalone + full hybrid. The gap is **stars/discoverability**, not capability.
- **vs local-RAG MCPs** (knowledge-rag, shinpr/mcp-local-rag, …): near-parity on the hybrid stack; we lead on HNSW-live-update, Bases, HyDE, eval harness.
- **vs AI-memory frameworks** (mem0 41k★, cognee 14k★, Letta, Zep): they publish **LoCoMo / LongMemEval** numbers and have **entity knowledge graphs** + **conversational write-back**; we don't yet. Letta's finding that *filesystem memory* alone scores 74% on LoCoMo **validates our vault-as-memory thesis** — we should claim and measure it.

---

## Tier 0 — Integrity: every claim verifiable (gates v3.9.0 stable)

The audit found two brand-critical overclaims. The whole pitch is rigor, so these come first.

- [x] **#15 SLSA-3 → SLSA L2** (v3.9.0-rc.7). Badge/hero/table/package.json/llms.txt/COMPARISON corrected to "signed build provenance (SLSA Build L2)". Real **L3** (isolated builder via `slsa-framework/slsa-github-generator`) is now a tracked Tier-4 item, not a claim.
- [ ] **#16 OCR offline enforcement** (v3.9.0-rc.8). Implement the documented guarantee: pre-flight `tessdata/<lang>.traineddata` existence check that throws before `createWorker`, `langPath` wiring so a cached pack is used (no CDN), and a real `install-ocr-lang <code>` subcommand (mirrors `install-model`). Makes "zero outbound network calls in serve mode" actually true. Ships with an env-gated integration test.
- [x] **Version/RC drift** (v3.9.0-rc.7) — README/QUICKSTART/benchmarks/AGENTS synced; reranker claim corrected to the measured number.
- [ ] **Close the drift class structurally** — extend `check-version-consistency.mjs` to the README "currently vX" + QUICKSTART example strings; add an OIA check that pins its own "N checks" self-count; add an OIA "enforcement-verb" check (grep for "blocked"/"zero outbound"/"fails closed"/"throws if" → flag for code-guard verification). Closes overclaim classes #12/#13/#15/#16 permanently.

## Tier 1 — Correctness (v3.9.0-rc.9)

- [ ] **Watcher per-file serialization** (audit H1). The v3.9.0 live-update path is fire-and-forget; concurrent saves to one file can interleave `applyDiff` + the shared `rowsByLabel` mutation and drift the in-memory HNSW. Add a per-relPath promise queue + a concurrent-event test (the suite currently has none).
- [ ] **HNSW `saveTo` live count** (audit M1) — persist `getCurrentCount()`, not the stale build-time `size`.
- [ ] Minor: watcher `unlink` `kind` for `.pdf` (L2); reranker × min_signals ordering doc note (M5); frontmatter double-parse (M2); graph-boost O(n²) → inbound-count map (M3).

## Tier 2 — The #1 credibility lever: standard memory benchmarks (v3.10)

- [ ] **Adopt LoCoMo + LongMemEval.** Add a harness that runs the industry-standard long-term-memory benchmarks and publish numbers **head-to-head vs mem0 / Letta / Zep**. This is what converts "best Obsidian MCP" → "credible best local AI-memory layer." Lead the README with it + the "filesystem memory, done right" framing.

## Tier 3 — Extend the lead (pick 1–2 after Tier 2)

- [ ] **GraphRAG-full** — entity/relationship extraction from note *content* (not just wikilinks), to match cognee/Zep-class knowledge graphs while staying local.
- [ ] **Conversational / episodic write-back** — a `remember` / distill-to-vault tool that turns an agent conversation into durable markdown memory (the mem0/Zep core use-case), entering that niche directly.

## Tier 4 — Win the category (discoverability + supply-chain)

- [ ] **Listings** — punkpeye/awesome-mcp-servers (canonical), awesomeclaude.ai, abordage/awesome-mcp, mcp.so, glama.ai, smithery.ai. (Already on the official MCP Registry.)
- [ ] **Comparison vs mem0 / cognee** in COMPARISON.md (today it only compares to other Obsidian MCPs).
- [ ] **Earn real SLSA Build L3** via `slsa-framework/slsa-github-generator`; restore an L3 badge once verified on a real release.
- [ ] **Supply-chain signals** — OpenSSF Scorecard workflow, `dependency-review-action` on PRs, CycloneDX SBOM on release, `step-security/harden-runner` egress auditing.
- [ ] **OSS-health files** — CODEOWNERS, SUPPORT.md; gate `publish-docs.yml` on CI success.

## Explicit non-goals

- Multi-vault support · OAuth (bearer-only is a deliberate security-positive choice) · live Obsidian-plugin integration via Local REST API (different positioning) · multi-source cloud ingestion (vault-only is the privacy thesis) · distributed/multi-process rate-limiting.

---

*Roadmap items are intentions, not commitments or dates. The only hard gate is Tier 0: no claim ships that the code doesn't enforce.*
