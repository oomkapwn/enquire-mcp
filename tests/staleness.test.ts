// v3.10.0-rc.1 — forgetting-aware staleness helper.
// Pure + deterministic (now injected), so age/stale verdicts are exact.

import { describe, expect, it } from "vitest";
import { computeStaleness, DEFAULT_STALE_DAYS } from "../src/staleness.js";

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
