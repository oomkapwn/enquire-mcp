// Daily / Periodic Notes plugin awareness (v1.10).
//
// Reads two Obsidian plugin configs at vault root:
//   • `.obsidian/daily-notes.json` — the core Daily Notes plugin
//   • `.obsidian/plugins/periodic-notes/data.json` — Periodic Notes plugin
//                                                   (daily/weekly/monthly/...)
//
// If the user has either configured, we honor the user's `format` (Moment.js
// pattern) and `folder` so `obsidian_read_note({title:"today"})` lands on
// their actual file (e.g. `Daily Notes/2026-W18.md` with `YYYY-[W]ww`).
// Otherwise we fall back to the defaults that v0.11 hard-coded.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { stripSurroundingSlashes } from "./wildcard-match.js";

export type PeriodicKind = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export interface PeriodicSpec {
  /** Moment.js format string, e.g. "YYYY-MM-DD" or "YYYY-[W]ww". */
  format: string;
  /** Vault-relative folder, e.g. "Daily Notes/" or "" for vault root. */
  folder: string;
}

export interface PeriodicConfig {
  daily?: PeriodicSpec;
  weekly?: PeriodicSpec;
  monthly?: PeriodicSpec;
  quarterly?: PeriodicSpec;
  yearly?: PeriodicSpec;
}

const DEFAULTS: Record<PeriodicKind, PeriodicSpec> = {
  daily: { format: "YYYY-MM-DD", folder: "" },
  weekly: { format: "YYYY-[W]ww", folder: "" },
  monthly: { format: "YYYY-MM", folder: "" },
  quarterly: { format: "YYYY-[Q]Q", folder: "" },
  yearly: { format: "YYYY", folder: "" }
};

/** Read .obsidian/daily-notes.json + .obsidian/plugins/periodic-notes/data.json
 *  if they exist. Returns a unified PeriodicConfig where each key may be
 *  populated from one config or the other. Both configs are best-effort —
 *  missing files / malformed JSON are silently ignored (we fall back to
 *  defaults).
 *
 *  v2.0.0-beta.2 P1 sec DiD: optional `isExcluded` predicate lets the caller
 *  enforce `--read-paths` / `--exclude-glob` over the `.obsidian/` config
 *  reads. Without this, the `.obsidian/` directory was implicitly exempted
 *  from the user's privacy filter — a strict allowlist user got their
 *  config read regardless. Now the resolver falls back to hard-coded
 *  defaults when the user's filter would have blocked the read. */
export async function loadPeriodicConfig(
  vaultRoot: string,
  isExcluded?: (relPath: string) => boolean
): Promise<PeriodicConfig> {
  const out: PeriodicConfig = {};

  // Core Daily Notes plugin: { format, folder, template, autorun }
  const dailyJsonRel = ".obsidian/daily-notes.json";
  const dailyJsonPath = path.join(vaultRoot, dailyJsonRel);
  if (!isExcluded?.(dailyJsonRel)) {
    try {
      const raw = await fs.readFile(dailyJsonPath, "utf8");
      const json = JSON.parse(raw) as { format?: unknown; folder?: unknown };
      if (typeof json.format === "string" || typeof json.folder === "string") {
        out.daily = {
          format: typeof json.format === "string" && json.format ? json.format : DEFAULTS.daily.format,
          folder: normaliseFolder(typeof json.folder === "string" ? json.folder : "")
        };
      }
    } catch {
      /* missing or malformed — leave undefined */
    }
  }

  // Periodic Notes community plugin: { daily: {...}, weekly: {...}, ... }
  const periodicJsonRel = ".obsidian/plugins/periodic-notes/data.json";
  const periodicJsonPath = path.join(vaultRoot, periodicJsonRel);
  if (isExcluded?.(periodicJsonRel)) {
    return out;
  }
  try {
    const raw = await fs.readFile(periodicJsonPath, "utf8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    for (const kind of ["daily", "weekly", "monthly", "quarterly", "yearly"] as const) {
      const block = json[kind];
      if (!block || typeof block !== "object") continue;
      const b = block as { enabled?: unknown; format?: unknown; folder?: unknown };
      // Periodic Notes stores `enabled: false` for kinds the user disabled —
      // we honor that by NOT setting a config (so the alias falls through to
      // the default rather than producing a path the user explicitly disabled).
      if (b.enabled === false) continue;
      out[kind] = {
        format: typeof b.format === "string" && b.format ? b.format : DEFAULTS[kind].format,
        folder: normaliseFolder(typeof b.folder === "string" ? b.folder : "")
      };
    }
  } catch {
    /* missing or malformed — leave defaults intact */
  }

  return out;
}

function normaliseFolder(folder: string): string {
  // Strip leading/trailing slashes, normalize backslashes, then re-add a
  // single trailing slash if non-empty so callers can concatenate cleanly.
  const stripped = stripSurroundingSlashes(folder.replace(/\\/g, "/"));
  return stripped ? `${stripped}/` : "";
}

/** Resolve a periodic alias ("today" / "daily" / "weekly" / "monthly" /
 *  "quarterly" / "yearly") to the vault-relative basename (without `.md`)
 *  that the user's config implies. The caller still has to look the file up
 *  in the vault — this just produces the expected path stem. */
export function resolvePeriodicNoteName(
  alias: string,
  config: PeriodicConfig,
  now: Date = new Date()
): { kind: PeriodicKind; relPath: string } | null {
  const lower = alias.trim().toLowerCase();
  let kind: PeriodicKind | null = null;
  if (lower === "today" || lower === "daily") kind = "daily";
  else if (lower === "weekly") kind = "weekly";
  else if (lower === "monthly") kind = "monthly";
  else if (lower === "quarterly") kind = "quarterly";
  else if (lower === "yearly") kind = "yearly";
  if (!kind) return null;
  const spec = config[kind] ?? DEFAULTS[kind];
  const formatted = formatMoment(spec.format, now);
  return { kind, relPath: `${spec.folder}${formatted}` };
}

/** Tiny Moment.js → string formatter. Supports the tokens periodic-note
 *  configs actually use. Anything else falls through verbatim — in practice
 *  most users stick to YYYY/MM/DD/ww/MMMM/Q. */
export function formatMoment(format: string, date: Date): string {
  // Bracket-escape literals: anything inside [ ] passes through.
  // Build a tokenizer that emits either a literal slice or a format token.
  const out: string[] = [];
  let i = 0;
  while (i < format.length) {
    const ch = format[i];
    if (ch === "[") {
      const end = format.indexOf("]", i + 1);
      if (end === -1) {
        // unterminated escape — emit the rest verbatim
        out.push(format.slice(i + 1));
        break;
      }
      out.push(format.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    // Try to consume a known token (longest-match first).
    let matched = false;
    for (const tok of TOKENS) {
      if (format.startsWith(tok, i)) {
        out.push(formatToken(tok, date));
        i += tok.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Unknown character — pass through (handles `-`, ` `, etc.)
      if (ch !== undefined) out.push(ch);
      i += 1;
    }
  }
  return out.join("");
}

const TOKENS = [
  "YYYY",
  "YY",
  "MMMM",
  "MMM",
  "MM",
  "DD",
  "Do",
  "Mo",
  "dddd",
  "ddd",
  "WW",
  "ww",
  "Wo",
  "wo",
  "gggg",
  "GGGG",
  "QQ",
  "Q",
  "M",
  "D",
  "HH",
  "H",
  "hh",
  "h",
  "mm",
  "m",
  "ss",
  "s",
  "A",
  "a"
];

const MONTH_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// v3.10.0-rc.62 (PERIODIC-WW-LOCALE-CONFLATION) — DELIBERATE: the lowercase Moment.js week tokens
// (`ww`/`wo`/`gggg`) are LOCALE-aware in Moment (locale-dependent week start + week-numbering
// system), while the uppercase ones (`WW`/`Wo`/`GGGG`) are ISO-8601. This formatter intentionally
// resolves BOTH cases to ISO-8601 week semantics (`isoWeek`/`isoWeekYear`): enquire ships no locale
// database, Obsidian's Periodic Notes / Daily Notes plugins use ISO weeks by default, and ISO is the
// correct, locale-independent week numbering for filename templates. So a user whose vault is
// configured for a non-ISO locale week start would see ISO week numbers — accepted, not a bug.
// Pinned by `tests/periodic.test.ts` so this conflation is a documented contract, not silent drift.
function formatToken(tok: string, d: Date): string {
  switch (tok) {
    case "YYYY":
      return String(d.getFullYear());
    case "YY":
      return String(d.getFullYear()).slice(-2);
    case "MMMM":
      return MONTH_FULL[d.getMonth()] ?? "";
    case "MMM":
      return MONTH_ABBR[d.getMonth()] ?? "";
    case "MM":
      return String(d.getMonth() + 1).padStart(2, "0");
    case "M":
      return String(d.getMonth() + 1);
    case "Mo":
      return ordinal(d.getMonth() + 1);
    case "DD":
      return String(d.getDate()).padStart(2, "0");
    case "D":
      return String(d.getDate());
    case "Do":
      return ordinal(d.getDate());
    case "dddd":
      return DAY_FULL[d.getDay()] ?? "";
    case "ddd":
      return DAY_ABBR[d.getDay()] ?? "";
    case "WW":
    case "ww":
      return isoWeek(d, true);
    case "Wo":
    case "wo":
      return ordinal(parseInt(isoWeek(d, false), 10));
    case "gggg":
    case "GGGG":
      return String(isoWeekYear(d));
    case "Q":
      return String(Math.floor(d.getMonth() / 3) + 1);
    case "QQ":
      return String(Math.floor(d.getMonth() / 3) + 1).padStart(2, "0");
    case "HH":
      return String(d.getHours()).padStart(2, "0");
    case "H":
      return String(d.getHours());
    case "hh":
      return String(((d.getHours() + 11) % 12) + 1).padStart(2, "0");
    case "h":
      return String(((d.getHours() + 11) % 12) + 1);
    case "mm":
      return String(d.getMinutes()).padStart(2, "0");
    case "m":
      return String(d.getMinutes());
    case "ss":
      return String(d.getSeconds()).padStart(2, "0");
    case "s":
      return String(d.getSeconds());
    case "A":
      return d.getHours() < 12 ? "AM" : "PM";
    case "a":
      return d.getHours() < 12 ? "am" : "pm";
    default:
      return tok;
  }
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function isoWeek(d: Date, padded: boolean): string {
  // ISO 8601 week. Compute via Thursday of the same ISO week.
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.valueOf() - yearStart.valueOf()) / 86400000 + 1) / 7);
  return padded ? String(weekNo).padStart(2, "0") : String(weekNo);
}

function isoWeekYear(d: Date): number {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  return target.getUTCFullYear();
}
