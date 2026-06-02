// v3.10.0-rc.1 — forgetting-aware staleness helper.
// Pure + deterministic (now injected), so age/stale verdicts are exact.

import { describe, expect, it } from "vitest";
import { computeStaleness, DEFAULT_STALE_DAYS, recencyScore } from "../src/staleness.js";

const DAY = 86_400_000;
const NOW = 1_900_000_000_000; // fixed reference (not Date.now()) → deterministic

describe("computeStaleness (v3.10 forgetting-aware staleness)", () => {
  it("a just-modified note has age_days 0 and is not stale", () => {
    expect(computeStaleness(NOW, NOW)).toEqual({ age_days: 0, stale: false });
  });

  it("age_days is whole days since mtime (floored)", () => {
    expect(computeStaleness(NOW - 400 * DAY, NOW).age_days).toBe(400);
    expect(computeStaleness(NOW - (10 * DAY + DAY / 2), NOW).age_days).toBe(10); // floored
  });

  it("stale flips at exactly DEFAULT_STALE_DAYS (>=, default 365)", () => {
    expect(DEFAULT_STALE_DAYS).toBe(365);
    expect(computeStaleness(NOW - 364 * DAY, NOW).stale).toBe(false);
    expect(computeStaleness(NOW - 365 * DAY, NOW).stale).toBe(true); // boundary inclusive
    expect(computeStaleness(NOW - 366 * DAY, NOW).stale).toBe(true);
  });

  it("honors a custom staleDays threshold", () => {
    expect(computeStaleness(NOW - 100 * DAY, NOW, 30)).toEqual({ age_days: 100, stale: true });
    expect(computeStaleness(NOW - 100 * DAY, NOW, 200)).toEqual({ age_days: 100, stale: false });
  });

  it("clamps a future-dated mtime to age_days 0 (no negative age)", () => {
    expect(computeStaleness(NOW + 10 * DAY, NOW)).toEqual({ age_days: 0, stale: false });
  });

  // NEGATIVE control: the verdict MUST discriminate — a fresh note is never
  // stale and an ancient one always is. A constant-true/false impl fails this.
  it("NEGATIVE control — fresh ≠ ancient (the verdict is not constant)", () => {
    const fresh = computeStaleness(NOW - 1 * DAY, NOW);
    const ancient = computeStaleness(NOW - 5000 * DAY, NOW);
    expect(fresh.stale).toBe(false);
    expect(ancient.stale).toBe(true);
    expect(fresh.age_days).toBeLessThan(ancient.age_days);
  });
});

describe("recencyScore (v3.10 rc.5 — opt-in recency re-ranking curve)", () => {
  it("scores 1 at age 0, 0.5 at the half-life, 0.25 at 3× the half-life", () => {
    expect(recencyScore(0, 365)).toBe(1);
    expect(recencyScore(365, 365)).toBeCloseTo(0.5, 10);
    expect(recencyScore(1095, 365)).toBeCloseTo(0.25, 10); // 365/(365+1095) = 0.25
  });

  it("is strictly decreasing in age (monotonic) and stays in (0, 1]", () => {
    const ages = [0, 1, 10, 100, 365, 1000, 100_000];
    let prev = Number.POSITIVE_INFINITY;
    for (const a of ages) {
      const s = recencyScore(a, 365);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(s).toBeLessThan(prev); // strictly less than the previous (younger) age's score
      prev = s;
    }
  });

  it("a smaller half-life decays faster (a 90-day note scores lower at staleDays=30 than 365)", () => {
    expect(recencyScore(90, 30)).toBeLessThan(recencyScore(90, 365));
  });

  it("defaults staleDays to DEFAULT_STALE_DAYS", () => {
    expect(recencyScore(365)).toBeCloseTo(recencyScore(365, DEFAULT_STALE_DAYS), 10);
  });

  it("clamps a negative / non-finite age to 0 (brand-new) and a sub-1 half-life to 1", () => {
    expect(recencyScore(-50, 365)).toBe(1); // negative age → treated as age 0
    expect(recencyScore(Number.NaN, 365)).toBe(1);
    // staleDays clamped to >=1 → no divide-by-zero, no Infinity/NaN
    expect(recencyScore(1, 0)).toBeCloseTo(0.5, 10); // half-life clamps to 1 → 1/(1+1)
    expect(Number.isFinite(recencyScore(10, -5))).toBe(true);
  });

  // NEGATIVE control: the curve MUST discriminate by age — a fresh note scores
  // strictly higher than an old one. A constant impl (always 1, or always 0.5)
  // fails this. This is what makes the re-rank blend actually move fresh notes up.
  it("NEGATIVE control — fresh outscores old (the curve is not constant)", () => {
    const fresh = recencyScore(5, 365);
    const old = recencyScore(2000, 365);
    expect(fresh).toBeGreaterThan(old);
    expect(fresh - old).toBeGreaterThan(0.3); // a meaningful gap, not a rounding wobble
  });
});
