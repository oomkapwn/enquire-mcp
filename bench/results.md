# enquire benchmarks

Latency per tool, measured on a synthetic vault. 5 runs after a warmup; each cell is `p50 / p99` in milliseconds. Run: `node scripts/bench.mjs`.

Smaller is better. Times include the read-cache warmup hit; cold first-call latency is captured on the warmup run and excluded from the samples (so these numbers reflect what an interactive agent will see on the second-and-later calls).

Hardware: `Apple A18 Pro`, Node v25.9.0.

| Tool | 1000 notes (p50 / p99 ms) | 10000 notes (p50 / p99 ms) |
|---|---|---|
| `list_notes (no filter)` | 21 / 22 | 104 / 105 |
| `list_notes (tag=project)` | 29 / 29 | 108 / 120 |
| `search_text (linear)` | 30 / 33 | 536 / 542 |
| `search_text (common)` | 29 / 29 | 541 / 697 |
| `get_recent_edits` | 11 / 12 | 100 / 102 |
| `get_backlinks (Hub)` | 54 / 55 | 1145 / 1154 |
| `list_tags` | 44 / 45 | 1037 / 1076 |
| `find_similar` | 45 / 49 | 1065 / 1120 |
| `get_note_neighbors` | 76 / 81 | 2002 / 2279 |
| `vault_stats` | 45 / 45 | 1058 / 1319 |
| `validate_note_proposal` | 79 / 80 | 1353 / 1459 |
