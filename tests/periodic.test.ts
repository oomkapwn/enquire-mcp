import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMoment, loadPeriodicConfig, resolvePeriodicNoteName } from "../src/periodic.js";
import { readNote } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-periodic-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("formatMoment (v1.10 Moment-format → string)", () => {
  const ref = new Date(Date.UTC(2026, 0, 15, 14, 30, 0)); // Thu 2026-01-15 14:30 UTC

  it("YYYY-MM-DD", () => {
    // Date is in UTC but formatMoment uses local-time getters; we set hours
    // far enough from midnight that local time and UTC agree on the day.
    // Note: Math.floor of UTC may differ in edge timezones — assert structure.
    const out = formatMoment("YYYY-MM-DD", ref);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("YYYY-[W]ww (ISO week with literal 'W')", () => {
    const out = formatMoment("YYYY-[W]ww", ref);
    expect(out).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("YYYY-MM (year-month)", () => {
    const out = formatMoment("YYYY-MM", new Date(2026, 4, 1));
    expect(out).toBe("2026-05");
  });

  it("MMMM (full month name)", () => {
    const out = formatMoment("MMMM YYYY", new Date(2026, 4, 1));
    expect(out).toBe("May 2026");
  });

  it("MMM (abbreviated month)", () => {
    const out = formatMoment("MMM YYYY", new Date(2026, 4, 1));
    expect(out).toBe("May 2026");
  });

  it("dddd (full weekday)", () => {
    const out = formatMoment("dddd", new Date(2026, 0, 15)); // Thu Jan 15 2026
    expect(out).toBe("Thursday");
  });

  it("Q (quarter)", () => {
    expect(formatMoment("Q", new Date(2026, 0, 1))).toBe("1");
    expect(formatMoment("Q", new Date(2026, 3, 1))).toBe("2");
    expect(formatMoment("Q", new Date(2026, 6, 1))).toBe("3");
    expect(formatMoment("Q", new Date(2026, 9, 1))).toBe("4");
  });

  it("[bracket-escaped literals] pass through", () => {
    expect(formatMoment("YYYY-[Q]Q", new Date(2026, 6, 1))).toBe("2026-Q3");
    expect(formatMoment("[The year is] YYYY", new Date(2026, 0, 1))).toBe("The year is 2026");
  });

  it("unterminated bracket emits the rest as literal", () => {
    expect(formatMoment("YYYY-[unterminated", new Date(2026, 0, 1))).toBe("2026-unterminated");
  });

  it("ordinal Do produces 1st, 2nd, 3rd, 4th, 11th, 21st, 22nd, 23rd, 24th", () => {
    expect(formatMoment("Do", new Date(2026, 0, 1))).toBe("1st");
    expect(formatMoment("Do", new Date(2026, 0, 2))).toBe("2nd");
    expect(formatMoment("Do", new Date(2026, 0, 3))).toBe("3rd");
    expect(formatMoment("Do", new Date(2026, 0, 4))).toBe("4th");
    expect(formatMoment("Do", new Date(2026, 0, 11))).toBe("11th");
    expect(formatMoment("Do", new Date(2026, 0, 21))).toBe("21st");
    expect(formatMoment("Do", new Date(2026, 0, 22))).toBe("22nd");
    expect(formatMoment("Do", new Date(2026, 0, 23))).toBe("23rd");
    expect(formatMoment("Do", new Date(2026, 0, 24))).toBe("24th");
  });

  it("unknown characters pass through verbatim", () => {
    expect(formatMoment("YYYY/MM/DD", new Date(2026, 4, 6))).toBe("2026/05/06");
  });

  // v3.10.0-rc.62 (PERIODIC-WW-LOCALE-CONFLATION) — pin the DELIBERATE decision that the
  // lowercase locale-aware Moment week tokens (ww/wo/gggg) resolve IDENTICALLY to their
  // uppercase ISO-8601 counterparts (WW/Wo/GGGG). enquire ships no locale DB and ISO weeks are
  // Obsidian's Periodic-Notes default, so this is a documented contract, not silent drift.
  it("lowercase week tokens (ww/wo/gggg) resolve to ISO-8601, identical to WW/Wo/GGGG (rc.62 deliberate)", () => {
    // Thu 2026-01-15 is ISO week 03 of ISO-week-year 2026 (Jan 1 2026 is a Thursday → wk 1).
    const d = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(formatMoment("ww", d)).toBe(formatMoment("WW", d)); // locale week == ISO week (by design)
    expect(formatMoment("wo", d)).toBe(formatMoment("Wo", d)); // ordinal locale == ordinal ISO
    expect(formatMoment("gggg", d)).toBe(formatMoment("GGGG", d)); // locale week-year == ISO week-year
    // and the resolved value IS the ISO one (not a no-op equality of two unhandled tokens)
    expect(formatMoment("ww", d)).toBe("03");
    expect(formatMoment("gggg", d)).toBe("2026");
  });

  // v3.6 — branches coverage uplift. The formatToken switch has many cases
  // that aren't reached by the existing canonical-format tests; each case
  // is a branch.
  describe("v3.6 — additional formatToken cases", () => {
    it("YY (two-digit year)", () => {
      expect(formatMoment("YY", new Date(2026, 0, 1))).toBe("26");
      expect(formatMoment("YY", new Date(1999, 0, 1))).toBe("99");
    });

    it("M / D (non-padded month + day)", () => {
      expect(formatMoment("M-D", new Date(2026, 0, 5))).toBe("1-5");
      expect(formatMoment("M-D", new Date(2026, 11, 31))).toBe("12-31");
    });

    it("Mo (ordinal month)", () => {
      expect(formatMoment("Mo", new Date(2026, 0, 1))).toBe("1st");
      expect(formatMoment("Mo", new Date(2026, 1, 1))).toBe("2nd");
    });

    it("ddd (abbreviated weekday)", () => {
      expect(formatMoment("ddd", new Date(2026, 0, 15))).toBe("Thu");
    });

    it("WW / ww (padded ISO week) and Wo / wo (ordinal ISO week)", () => {
      // Pick a date with a known ISO week so the assert is exact.
      const refMid = new Date(Date.UTC(2026, 4, 13)); // 2026-05-13 → ISO week 20
      const padded = formatMoment("WW", refMid);
      expect(padded).toMatch(/^\d{2}$/);
      // Ordinal form just wraps the unpadded number.
      const ord = formatMoment("Wo", refMid);
      expect(ord).toMatch(/(st|nd|rd|th)$/);
    });

    it("gggg / GGGG (ISO week-year)", () => {
      const out = formatMoment("gggg", new Date(2026, 0, 1));
      expect(out).toMatch(/^\d{4}$/);
      const out2 = formatMoment("GGGG", new Date(2026, 0, 1));
      expect(out2).toMatch(/^\d{4}$/);
    });

    it("QQ (zero-padded quarter)", () => {
      expect(formatMoment("QQ", new Date(2026, 0, 1))).toBe("01");
      expect(formatMoment("QQ", new Date(2026, 9, 1))).toBe("04");
    });

    it("HH / H (24-hour) and hh / h (12-hour) and A / a (am/pm)", () => {
      const morning = new Date(2026, 0, 1, 9, 0, 0);
      const afternoon = new Date(2026, 0, 1, 15, 0, 0);
      expect(formatMoment("HH", morning)).toBe("09");
      expect(formatMoment("H", morning)).toBe("9");
      expect(formatMoment("hh", afternoon)).toBe("03");
      expect(formatMoment("h", afternoon)).toBe("3");
      expect(formatMoment("A", morning)).toBe("AM");
      expect(formatMoment("a", afternoon)).toBe("pm");
    });

    it("mm / m and ss / s (minute / second)", () => {
      const ref = new Date(2026, 0, 1, 0, 5, 7);
      expect(formatMoment("mm", ref)).toBe("05");
      expect(formatMoment("m", ref)).toBe("5");
      expect(formatMoment("ss", ref)).toBe("07");
      expect(formatMoment("s", ref)).toBe("7");
    });

    it("ordinal at n%100 boundaries (-1 → 'th' fallback inside ordinal())", () => {
      // The ordinal() helper has a `s[(v - 20) % 10] ?? s[v] ?? s[0]`
      // chain that's only fully exercised when v <= 3 or v >= 21.
      // Hitting day 0 isn't possible from Date, but the % 100 quirk gets
      // covered by 11/12/13 (special-case 'th') and 21/22/23 (ordinal).
      expect(formatMoment("Do", new Date(2026, 0, 12))).toBe("12th");
      expect(formatMoment("Do", new Date(2026, 0, 13))).toBe("13th");
    });
  });
});

describe("loadPeriodicConfig (v1.10)", () => {
  it("returns empty config when no plugin files exist", async () => {
    const config = await loadPeriodicConfig(root);
    expect(config).toEqual({});
  });

  it("reads .obsidian/daily-notes.json", async () => {
    await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".obsidian", "daily-notes.json"),
      JSON.stringify({ format: "YYYY-MM-DD", folder: "Daily Notes/" })
    );
    const config = await loadPeriodicConfig(root);
    expect(config.daily).toEqual({ format: "YYYY-MM-DD", folder: "Daily Notes/" });
  });

  it("reads Periodic Notes plugin config (data.json)", async () => {
    await fs.mkdir(path.join(root, ".obsidian", "plugins", "periodic-notes"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".obsidian", "plugins", "periodic-notes", "data.json"),
      JSON.stringify({
        daily: { enabled: true, format: "YYYY-MM-DD", folder: "Journal/Daily" },
        weekly: { enabled: true, format: "YYYY-[W]ww", folder: "Journal/Weekly" },
        monthly: { enabled: false, format: "YYYY-MM", folder: "Journal/Monthly" }
      })
    );
    const config = await loadPeriodicConfig(root);
    expect(config.daily?.format).toBe("YYYY-MM-DD");
    expect(config.daily?.folder).toBe("Journal/Daily/");
    expect(config.weekly?.format).toBe("YYYY-[W]ww");
    // Disabled kinds should NOT be in the config (caller falls back to default).
    expect(config.monthly).toBeUndefined();
  });

  it("survives malformed JSON without throwing", async () => {
    await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(root, ".obsidian", "daily-notes.json"), "{ this is not valid json");
    const config = await loadPeriodicConfig(root);
    expect(config).toEqual({});
  });

  it("normalizes folder to single trailing slash", async () => {
    await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".obsidian", "daily-notes.json"),
      JSON.stringify({ format: "YYYY-MM-DD", folder: "/Daily/" })
    );
    const config = await loadPeriodicConfig(root);
    expect(config.daily?.folder).toBe("Daily/");
  });
});

describe("resolvePeriodicNoteName (v1.10)", () => {
  const refDate = new Date(2026, 4, 6); // 2026-05-06

  it("daily/today resolves with default format when no config", () => {
    const out = resolvePeriodicNoteName("today", {}, refDate);
    expect(out).toEqual({ kind: "daily", relPath: "2026-05-06" });
  });

  it("daily honors user folder + format from config", () => {
    const out = resolvePeriodicNoteName("daily", { daily: { format: "DD-MM-YYYY", folder: "Daily Notes/" } }, refDate);
    expect(out).toEqual({ kind: "daily", relPath: "Daily Notes/06-05-2026" });
  });

  it("weekly with [W] literal", () => {
    const out = resolvePeriodicNoteName("weekly", {}, refDate);
    expect(out?.kind).toBe("weekly");
    expect(out?.relPath).toMatch(/^2026-W\d{2}$/);
  });

  it("monthly default", () => {
    const out = resolvePeriodicNoteName("monthly", {}, refDate);
    expect(out).toEqual({ kind: "monthly", relPath: "2026-05" });
  });

  it("quarterly default", () => {
    const out = resolvePeriodicNoteName("quarterly", {}, refDate);
    expect(out).toEqual({ kind: "quarterly", relPath: "2026-Q2" });
  });

  it("yearly default", () => {
    const out = resolvePeriodicNoteName("yearly", {}, refDate);
    expect(out).toEqual({ kind: "yearly", relPath: "2026" });
  });

  it("unknown alias returns null", () => {
    expect(resolvePeriodicNoteName("foo", {}, refDate)).toBeNull();
    expect(resolvePeriodicNoteName("yesterday", {}, refDate)).toBeNull();
  });
});

describe("readNote with periodic alias + plugin config (integration)", () => {
  it("read_note({title:'today'}) lands on user-configured Daily Notes folder", async () => {
    // Set up plugin config: Daily Notes/<format>.md
    await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".obsidian", "daily-notes.json"),
      JSON.stringify({ format: "YYYY-MM-DD", folder: "Daily Notes" })
    );
    // Create today's daily note in the configured folder.
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const todayName = `${yyyy}-${mm}-${dd}`;
    await fs.mkdir(path.join(root, "Daily Notes"), { recursive: true });
    await fs.writeFile(path.join(root, "Daily Notes", `${todayName}.md`), "today's body\n");

    const v = new Vault(root);
    const out = await readNote(v, { title: "today" });
    expect(out.title).toBe(todayName);
    expect(out.path).toBe(path.join("Daily Notes", `${todayName}.md`));
  });

  it("falls back to legacy default format when no plugin config", async () => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const todayName = `${yyyy}-${mm}-${dd}`;
    // No .obsidian config; just create the file at vault root with the
    // legacy default name.
    await fs.writeFile(path.join(root, `${todayName}.md`), "fallback body\n");

    const v = new Vault(root);
    const out = await readNote(v, { title: "today" });
    expect(out.title).toBe(todayName);
  });
});
