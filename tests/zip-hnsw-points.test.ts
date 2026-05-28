// v3.9.0-rc.11 (audit) — the `-1` sentinel-label corruption guard. The watcher
// pre-rc.11 zipped embed-db rows with `newIds[i] ?? -1`, which silently
// inserted a vector under label -1 on any row/id length mismatch — corrupting
// the in-memory HNSW index, the shared rowsByLabel map, AND the persisted
// sidecar. `zipHnswAddPoints` now throws fail-closed instead. Positive +
// NEGATIVE controls per the CLAUDE.md rule since v3.6.4.

import { describe, expect, it } from "vitest";
import { zipHnswAddPoints } from "../src/watcher.js";

const row = (n: number) => ({
  vector: new Float32Array([n, n, n, n]),
  chunkIndex: n,
  lineStart: n * 10,
  lineEnd: n * 10 + 5,
  textPreview: `row ${n}`
});

describe("zipHnswAddPoints — -1 sentinel-label corruption guard (v3.9.0-rc.11)", () => {
  it("zips matched rows + ids into add-points with the correct ids (POSITIVE)", () => {
    const points = zipHnswAddPoints([row(1), row(2)], [10, 20]);
    expect(points.map((p) => p.id)).toEqual([10, 20]);
    expect(points[0]?.chunkIndex).toBe(1);
    expect(points[1]?.textPreview).toBe("row 2");
    expect(points[0]?.vector).toBeInstanceOf(Float32Array);
  });

  it("handles the empty case", () => {
    expect(zipHnswAddPoints([], [])).toEqual([]);
  });

  it("THROWS on too-few ids instead of inserting a -1 sentinel (NEGATIVE control)", () => {
    expect(() => zipHnswAddPoints([row(1), row(2)], [10])).toThrow(/sentinel label|refusing/i);
  });

  it("THROWS on too-many ids (NEGATIVE control)", () => {
    expect(() => zipHnswAddPoints([row(1)], [10, 20])).toThrow(/sentinel label|refusing/i);
  });

  it("never emits the -1 corrupt sentinel for any matched input", () => {
    const points = zipHnswAddPoints([row(1), row(2), row(3)], [5, 6, 7]);
    expect(points.every((p) => p.id !== -1)).toBe(true);
    expect(points.map((p) => p.id)).toEqual([5, 6, 7]);
  });
});
