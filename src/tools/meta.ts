import * as path from "node:path";
import matter from "gray-matter";
import type { FtsIndex } from "../fts5.js";
import type { FileEntry, Vault } from "../vault.js";
import { getBacklinks, getRecentEdits, listTags } from "./read.js";
import { searchHybrid } from "./search.js";
import { resolveTarget, suggestSimilar } from "./write.js";

// ─── obsidian_validate_note_proposal (v0.12 anti-slop validator) ─────────────
// Closes the #1 user-pain finding: LLM-generated notes arrive structurally
// broken — bad YAML, fake wikilinks, inconsistent tags — and users spend
// minutes reformatting per note. This tool is called BEFORE create/append:
// the LLM proposes a draft, we lint it against the live vault, return
// errors/warnings/suggestions, and the LLM can fix-and-retry without ever
// writing a broken note.

export interface ValidateProposalArgs {
  /** Vault-relative path the LLM intends to write to (e.g. "Inbox/idea.md"). */
  path: string;
  /** Full proposed markdown content including any frontmatter block. */
  content: string;
  /** "create" (default) → fail if path exists. "overwrite" / "append" → ok if exists. */
  mode?: "create" | "overwrite" | "append";
}

export interface ValidateProposalResult {
  ok: boolean;
  proposed_path: string;
  mode: "create" | "overwrite" | "append";
  errors: Array<{ kind: string; message: string }>;
  warnings: Array<{ kind: string; message: string; suggestion?: string }>;
  yaml: {
    parsed: boolean;
    error: string | null;
    keys: string[];
  };
  wikilinks: Array<{
    raw: string;
    target: string;
    status: "resolved" | "broken" | "ambiguous";
    resolved_path: string | null;
    suggestions: string[];
  }>;
  tags: Array<{
    name: string;
    status: "existing" | "new";
  }>;
  collision: {
    kind: "none" | "path-exists" | "title-exists-elsewhere";
    existing_path?: string;
  };
}

export async function validateNoteProposal(vault: Vault, args: ValidateProposalArgs): Promise<ValidateProposalResult> {
  await vault.ensureExists();
  const mode = args.mode ?? "create";
  const errors: Array<{ kind: string; message: string }> = [];
  const warnings: Array<{ kind: string; message: string; suggestion?: string }> = [];

  // 1. Path sanity. resolveInside throws on traversal — capture as error,
  //    don't let it propagate as a generic exception (the validator should
  //    return a structured result for ANY input).
  let normalizedPath = args.path.toLowerCase().endsWith(".md") ? args.path : `${args.path}.md`;
  let absPath: string | null = null;
  try {
    absPath = vault.resolveInside(normalizedPath);
    normalizedPath = vault.toRel(absPath);
  } catch (err) {
    errors.push({
      kind: "path-traversal",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  // 2. YAML parse via gray-matter (the same parser used at write time).
  const yamlReport = { parsed: false, error: null as string | null, keys: [] as string[] };
  let bodyAfterFm = args.content;
  try {
    const parsed = matter(args.content);
    yamlReport.parsed = true;
    yamlReport.keys = Object.keys(parsed.data ?? {});
    bodyAfterFm = parsed.content;
  } catch (err) {
    yamlReport.error = err instanceof Error ? err.message : String(err);
    errors.push({ kind: "yaml-invalid", message: `YAML frontmatter could not be parsed: ${yamlReport.error}` });
  }

  // 3. Wikilink resolution against the live vault.
  const all = await vault.listMarkdown();
  const wikilinkRe = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
  const wikilinks: ValidateProposalResult["wikilinks"] = [];
  for (const m of bodyAfterFm.matchAll(wikilinkRe)) {
    const raw = m[0];
    const inner = (m[1] ?? "").trim();
    if (!inner) continue;
    // Strip alias / section / block to get the bare target name.
    const beforePipe = inner.split("|")[0] ?? "";
    const beforeHash = beforePipe.split("#")[0] ?? "";
    const target = beforeHash.split("^")[0]?.trim() ?? "";
    if (!target) continue;
    const match = findBestMatch(all, target, normalizedPath);
    if (match) {
      wikilinks.push({
        raw,
        target,
        status: "resolved",
        resolved_path: match.relPath,
        suggestions: []
      });
    } else {
      const suggestions = await suggestSimilar(vault, target);
      wikilinks.push({
        raw,
        target,
        status: "broken",
        resolved_path: null,
        suggestions
      });
      warnings.push({
        kind: "broken-wikilink",
        message: `[[${target}]] does not resolve to any existing note`,
        suggestion: suggestions.length ? `Closest matches: ${suggestions.join(", ")}` : undefined
      });
    }
  }

  // 4. Tag pre-classification (existing vs new).
  const existingTags = new Set((await listTags(vault, {})).map((t) => t.tag.toLowerCase()));
  const proposedTagsRaw = new Set<string>();
  // Frontmatter tags.
  const fmData = yamlReport.parsed ? matter(args.content).data : {};
  const fmTags = fmData.tags ?? fmData.tag;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === "string" && t) proposedTagsRaw.add(t.replace(/^#/, ""));
  } else if (typeof fmTags === "string" && fmTags) {
    for (const t of fmTags.split(/[\s,]+/)) if (t) proposedTagsRaw.add(t.replace(/^#/, ""));
  }
  // Inline tags.
  const inlineTagRe = /(?:^|[\s([{>])#([\p{L}][\p{L}\p{N}_/-]*)/gu;
  for (const m of bodyAfterFm.matchAll(inlineTagRe)) {
    if (m[1]) proposedTagsRaw.add(m[1]);
  }
  const tags: ValidateProposalResult["tags"] = [];
  for (const t of proposedTagsRaw) {
    const status = existingTags.has(t.toLowerCase()) ? "existing" : "new";
    tags.push({ name: t, status });
    if (status === "new") {
      warnings.push({
        kind: "new-tag",
        message: `#${t} is new — won't fork an existing tag (case-insensitive check)`
      });
    }
  }

  // 5. Path collision check.
  let collision: ValidateProposalResult["collision"] = { kind: "none" };
  if (absPath) {
    try {
      await vault.stat(absPath);
      // Path exists.
      if (mode === "create") {
        errors.push({
          kind: "path-collision",
          message: `Note already exists at ${normalizedPath} (mode="create" refuses overwrite)`
        });
      }
      collision = { kind: "path-exists", existing_path: normalizedPath };
    } catch {
      // Path doesn't exist — try title collision (an existing note at a different path).
      const titleFromBasename = stripMd(path.basename(normalizedPath));
      const existing = await vault.findByTitle(titleFromBasename);
      if (existing && existing.relPath !== normalizedPath) {
        warnings.push({
          kind: "title-collision",
          message: `A note titled "${titleFromBasename}" already exists at ${existing.relPath} — proceeding will create a same-titled file at a different path`,
          suggestion: existing.relPath
        });
        collision = { kind: "title-exists-elsewhere", existing_path: existing.relPath };
      }
    }
  }

  return {
    ok: errors.length === 0,
    proposed_path: normalizedPath,
    mode,
    errors,
    warnings,
    yaml: yamlReport,
    wikilinks,
    tags,
    collision
  };
}

// ─── obsidian_lint_wiki (v1.5 — Karpathy LLM-Wiki lint workflow) ─────────────
// Karpathy's gist (gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
// names three workflows for an LLM-maintained wiki: ingest, query, lint. We had
// the ingest+query primitives (create_note + search/find_similar/etc.) since
// 0.13. lint completes the trio in one tool call: orphans, broken links, stub
// pages, stale claims, and "concept mentioned in N+ notes but missing its own
// page." Each finding is shaped so the agent can fix it via existing tools
// (validate_note_proposal → create_note / append_to_note / rename_note).

export interface LintWikiArgs {
  /** Folder to restrict the lint to (default: whole vault). */
  folder?: string;
  /** Word count below which a note is considered a "stub". Default 100. */
  stub_word_threshold?: number;
  /** A note is "stale" if its frontmatter `last_reviewed` (or mtime if missing)
   *  is older than this many days. Default 365. */
  stale_days?: number;
  /** A capitalised n-gram mentioned by ≥ N distinct notes but not having its
   *  own page is flagged as a concept candidate. Default 3. */
  concept_min_mentions?: number;
  /** Cap on each finding-bucket so the response stays bounded. Default 50. */
  max_per_bucket?: number;
}

export interface LintWikiFinding {
  kind: "orphan" | "broken-link" | "stub" | "stale" | "concept-without-page";
  path?: string;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface LintWikiResult {
  scope: string;
  scanned: number;
  generated_at: string;
  summary: {
    orphans: number;
    broken_links: number;
    stubs: number;
    stale: number;
    concept_candidates: number;
  };
  findings: {
    orphans: LintWikiFinding[];
    broken_links: LintWikiFinding[];
    stubs: LintWikiFinding[];
    stale: LintWikiFinding[];
    concept_candidates: LintWikiFinding[];
  };
}

export async function lintWiki(vault: Vault, args: LintWikiArgs): Promise<LintWikiResult> {
  await vault.ensureExists();
  const stubThreshold = args.stub_word_threshold ?? 100;
  const staleDays = args.stale_days ?? 365;
  const conceptMinMentions = args.concept_min_mentions ?? 3;
  const cap = args.max_per_bucket ?? 50;

  const entries = await vault.listMarkdown(args.folder);
  const allEntries = await vault.listMarkdown();
  const staleMs = Date.now() - staleDays * 24 * 3600 * 1000;

  // Single pass: collect inbound counts, outbound presence, broken links,
  // word counts, last-reviewed times, capitalised-phrase mentions.
  const inbound = new Map<string, number>();
  const outboundPresence = new Set<string>();
  const broken: LintWikiFinding[] = [];
  const stubs: LintWikiFinding[] = [];
  const stale: LintWikiFinding[] = [];
  const titleSet = new Set<string>();
  for (const e of allEntries) titleSet.add(stripMd(e.basename).toLowerCase());

  // Capitalised-phrase mentions across the whole vault. A phrase is 1-3
  // CapitalCase tokens (e.g. "Reinforcement Learning", "Attention Heads").
  // Stop-words: dropped when they appear at the start of a phrase.
  const conceptStopwords = new Set([
    "The",
    "A",
    "An",
    "This",
    "That",
    "These",
    "Those",
    "If",
    "When",
    "While",
    "But",
    "And",
    "Or"
  ]);
  const capPhraseRe = /\b((?:[A-Z][a-z][a-z]+(?:\s+[A-Z][a-z][a-z]+){0,2}))\b/g;
  const conceptMentions = new Map<string, Set<string>>(); // phrase → set of source paths

  for (const e of entries) {
    const { parsed, mtimeMs } = await vault.readNote(e.absPath, e.mtimeMs);

    // Outbound + broken pass.
    if (parsed.wikilinks.length > 0) outboundPresence.add(e.relPath);
    for (const link of parsed.wikilinks) {
      const m = findBestMatch(allEntries, link.target, e.relPath);
      if (m) {
        inbound.set(m.relPath, (inbound.get(m.relPath) ?? 0) + 1);
      } else if (broken.length < cap) {
        broken.push({
          kind: "broken-link",
          path: e.relPath,
          message: `[[${link.target}]] in ${e.relPath} doesn't resolve`,
          suggestion: "create the missing note, fix the link, or remove it",
          details: { target: link.target, raw: link.raw }
        });
      }
    }

    // Stub pass.
    const wordCount = parsed.body.trim() ? parsed.body.trim().split(/\s+/).length : 0;
    if (wordCount < stubThreshold && stubs.length < cap) {
      stubs.push({
        kind: "stub",
        path: e.relPath,
        message: `${e.relPath} is ${wordCount} words (threshold ${stubThreshold})`,
        suggestion: "develop, merge into a hub, or archive",
        details: { word_count: wordCount, mtime: new Date(mtimeMs).toISOString() }
      });
    }

    // Stale pass — frontmatter `last_reviewed` overrides mtime if present.
    // gray-matter (js-yaml) parses ISO dates into Date objects automatically,
    // so we accept Date | string | number.
    const lastReviewedRaw = parsed.frontmatter?.last_reviewed ?? parsed.frontmatter?.["last-reviewed"];
    let lastTouchedMs = mtimeMs;
    if (lastReviewedRaw instanceof Date) {
      const t = lastReviewedRaw.getTime();
      if (Number.isFinite(t)) lastTouchedMs = t;
    } else if (typeof lastReviewedRaw === "string") {
      const t = Date.parse(lastReviewedRaw);
      if (Number.isFinite(t)) lastTouchedMs = t;
    } else if (typeof lastReviewedRaw === "number" && Number.isFinite(lastReviewedRaw)) {
      lastTouchedMs = lastReviewedRaw;
    }
    if (lastTouchedMs < staleMs && stale.length < cap) {
      stale.push({
        kind: "stale",
        path: e.relPath,
        message: `${e.relPath} not touched since ${new Date(lastTouchedMs).toISOString().slice(0, 10)}`,
        suggestion: "review for accuracy or archive",
        details: {
          last_touched: new Date(lastTouchedMs).toISOString(),
          source: lastReviewedRaw !== undefined ? "frontmatter.last_reviewed" : "mtime"
        }
      });
    }

    // Concept-mention pass — capitalised phrases in the body that aren't
    // already a wikilink target. Cap at 30 unique phrases per source to
    // bound memory, but loose enough that real concepts in long notes don't
    // get truncated.
    const seenInThisNote = new Set<string>();
    for (const m of parsed.body.matchAll(capPhraseRe)) {
      const phrase = m[1];
      if (!phrase) continue;
      const firstWord = phrase.split(/\s+/)[0];
      if (firstWord !== undefined && conceptStopwords.has(firstWord)) continue;
      if (seenInThisNote.has(phrase)) continue;
      if (seenInThisNote.size >= 30) break;
      // Skip phrases that are already a vault note (basename match).
      if (titleSet.has(phrase.toLowerCase())) continue;
      seenInThisNote.add(phrase);
      const set = conceptMentions.get(phrase) ?? new Set<string>();
      set.add(e.relPath);
      conceptMentions.set(phrase, set);
    }
  }

  // Orphan findings (no inbound AND no outbound).
  const orphans: LintWikiFinding[] = [];
  for (const e of entries) {
    if (orphans.length >= cap) break;
    if (!inbound.get(e.relPath) && !outboundPresence.has(e.relPath)) {
      orphans.push({
        kind: "orphan",
        path: e.relPath,
        message: `${e.relPath} has no inbound or outbound wikilinks`,
        suggestion: "link from a hub note, archive, or delete",
        details: { mtime: new Date(e.mtimeMs).toISOString() }
      });
    }
  }

  // Concept candidates — phrases mentioned by ≥ N distinct notes.
  const conceptCandidates: LintWikiFinding[] = [];
  const ranked = [...conceptMentions.entries()]
    .filter(([, sources]) => sources.size >= conceptMinMentions)
    .sort((a, b) => b[1].size - a[1].size);
  for (const [phrase, sources] of ranked) {
    if (conceptCandidates.length >= cap) break;
    conceptCandidates.push({
      kind: "concept-without-page",
      message: `"${phrase}" is mentioned by ${sources.size} notes but has no page of its own`,
      suggestion: `create a page \`${phrase}.md\` and refile the most-developed mentions into it`,
      details: { phrase, mention_count: sources.size, sources: [...sources].slice(0, 5) }
    });
  }

  return {
    scope: args.folder ?? "(whole vault)",
    scanned: entries.length,
    generated_at: new Date().toISOString(),
    summary: {
      orphans: orphans.length,
      broken_links: broken.length,
      stubs: stubs.length,
      stale: stale.length,
      concept_candidates: conceptCandidates.length
    },
    findings: {
      orphans,
      broken_links: broken,
      stubs,
      stale,
      concept_candidates: conceptCandidates
    }
  };
}

// ─── obsidian_open_questions (v1.5 — surface unresolved threads) ─────────────
// Karpathy and other ML PKM workflows use "Open question:" / "Q:" / "TODO?" /
// "??" lines as deferred-thinking markers. This tool returns every such line
// across the vault with source + context heading + age, sorted oldest-first.

export interface OpenQuestion {
  question: string;
  source_path: string;
  source_title: string;
  context_heading: string | null;
  line: number;
  age_days: number;
  mtime: string;
}

export async function getOpenQuestions(
  vault: Vault,
  args: { folder?: string; limit?: number; pattern?: string }
): Promise<OpenQuestion[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  // Default pattern: "Open question:" / "Open question -" / "Q:" / "TODO?" / "??"
  // followed by space + question text. Anchored at line start (with optional
  // list-bullet / quote / heading prefix).
  // Default pattern matches deferred-thinking markers at line start (with
  // optional list-bullet / quote / heading prefix). Single-line `i` flag —
  // we apply it line-by-line below.
  const defaultPat = "^\\s*(?:[#\\->\\*\\d\\.]+\\s+)?(?:open\\s+question|q|todo\\?|\\?\\?)\\s*[:\\-]?\\s*(.+)$";
  const re = new RegExp(args.pattern ?? defaultPat, "i");

  const entries = await vault.listMarkdown(args.folder);
  const out: OpenQuestion[] = [];
  const now = Date.now();
  for (const e of entries) {
    if (out.length >= limit) break;
    const { parsed, mtimeMs } = await vault.readNote(e.absPath, e.mtimeMs);
    // Scan parsed.body so frontmatter lines (which can contain "Q:" -ish
    // tokens) don't pollute results.
    const lines = parsed.body.split("\n");
    let currentHeading: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (headingMatch?.[2]) {
        currentHeading = headingMatch[2];
        // A heading line itself isn't a question hit — skip the regex match.
        continue;
      }
      const m = re.exec(line);
      if (!m?.[1]) continue;
      out.push({
        question: m[1].trim(),
        source_path: e.relPath,
        source_title: stripMd(e.basename),
        context_heading: currentHeading,
        line: i + 1,
        age_days: Math.round((now - mtimeMs) / (24 * 3600 * 1000)),
        mtime: new Date(mtimeMs).toISOString()
      });
      if (out.length >= limit) break;
    }
  }
  // Sort oldest-first so things aging out surface first.
  out.sort((a, b) => b.age_days - a.age_days);
  return out;
}

// ─── obsidian_paper_audit (v1.5 — verify #paper notes have citations) ────────
// For each note tagged #paper (configurable), verify frontmatter has at least
// one of arxiv/doi/url/isbn. Also flag notes whose body contains an arxiv ID
// (e.g. "arxiv:2401.12345") but doesn't carry it in frontmatter — common after
// quick-capture from a chat.

export interface PaperAuditFinding {
  path: string;
  title: string;
  has_frontmatter_citation: boolean;
  found_in_body: { arxiv: string[]; doi: string[]; url: string[] };
  proposed_frontmatter_patch: Record<string, string> | null;
  message: string;
}

export async function paperAudit(
  vault: Vault,
  args: { tag?: string; folder?: string; limit?: number }
): Promise<{ scanned: number; flagged: PaperAuditFinding[] }> {
  await vault.ensureExists();
  const tag = (args.tag ?? "paper").replace(/^#+/, "").toLowerCase();
  const limit = args.limit ?? 100;
  const entries = await vault.listMarkdown(args.folder);

  const arxivRe = /\barxiv[:\s]*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\b/gi;
  const doiRe = /\bdoi[:\s]*(10\.\d{4,9}\/[\w\-._;()/:]+)/gi;
  const urlRe = /\bhttps?:\/\/[^\s<>")\]]+/g;

  let scanned = 0;
  const flagged: PaperAuditFinding[] = [];
  for (const e of entries) {
    if (flagged.length >= limit) break;
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const tagsLower = parsed.tags.map((t) => t.toLowerCase());
    if (!tagsLower.includes(tag)) continue;
    scanned += 1;

    const fm = parsed.frontmatter ?? {};
    const fmKeys = new Set(Object.keys(fm).map((k) => k.toLowerCase()));
    const hasFmCitation = fmKeys.has("arxiv") || fmKeys.has("doi") || fmKeys.has("url") || fmKeys.has("isbn");

    // Scan parsed.body so the frontmatter's own arxiv/doi keys don't get
    // re-detected as "found in body".
    const body = parsed.body;
    const arxivIds = [...body.matchAll(arxivRe)].map((m) => m[1]).filter((v): v is string => !!v);
    const doiIds = [...body.matchAll(doiRe)].map((m) => m[1]).filter((v): v is string => !!v);
    const urls = [...body.matchAll(urlRe)].map((m) => m[0]);
    const foundInBody = {
      arxiv: [...new Set(arxivIds)],
      doi: [...new Set(doiIds)],
      url: [...new Set(urls)].slice(0, 3)
    };

    const bodyHasAnyId = foundInBody.arxiv.length > 0 || foundInBody.doi.length > 0 || foundInBody.url.length > 0;
    // Clean ⇒ has a frontmatter citation. The body might cite OTHER papers,
    // but this note itself is properly identified.
    if (hasFmCitation) continue;

    let proposed: Record<string, string> | null = null;
    if (bodyHasAnyId) {
      proposed = {};
      if (foundInBody.arxiv[0]) proposed.arxiv = foundInBody.arxiv[0];
      if (foundInBody.doi[0]) proposed.doi = foundInBody.doi[0];
      if (foundInBody.url[0] && !proposed.arxiv && !proposed.doi) proposed.url = foundInBody.url[0];
    }

    const msg = bodyHasAnyId
      ? `${e.relPath} has identifiers in body (${[
          ...foundInBody.arxiv.map((v) => `arxiv:${v}`),
          ...foundInBody.doi.map((v) => `doi:${v}`)
        ]
          .slice(0, 2)
          .join(", ")}) but missing frontmatter`
      : `${e.relPath} has #${tag} but no arxiv/doi/url anywhere — citation missing`;

    flagged.push({
      path: e.relPath,
      title: stripMd(e.basename),
      has_frontmatter_citation: hasFmCitation,
      found_in_body: foundInBody,
      proposed_frontmatter_patch: proposed,
      message: msg
    });
  }
  return { scanned, flagged };
}

// ─── obsidian_find_path (v1.6 multi-hop graph traversal) ────────────────────
// BFS over the wikilink graph from `from` to `to`, returning the shortest path
// (sequence of notes connected by wikilinks) up to `max_depth` hops. Closes
// the gap aaronsb's plugin opened: "find paths between concepts" was the
// most-praised graph feature in the competitive audit. We use the shared
// EntryIndex memo so repeat calls in a session reuse the basename index for
// O(1) target resolution.

export interface PathStep {
  path: string;
  title: string;
  /** Wikilink raw text (`[[…]]` content) used to traverse FROM the previous
   *  step to this one. Empty on the source step. */
  via: string;
}

export interface FindPathResult {
  from: string;
  to: string;
  found: boolean;
  path: PathStep[];
  hops: number;
  /** Up to 10 same-length alternatives, only when include_alternatives=true. */
  alternatives?: PathStep[][];
}

export async function findPath(
  vault: Vault,
  args: {
    from?: string;
    from_title?: string;
    to?: string;
    to_title?: string;
    max_depth?: number;
    include_alternatives?: boolean;
    follow_embeds?: boolean;
  }
): Promise<FindPathResult> {
  await vault.ensureExists();
  const maxDepth = args.max_depth ?? 5;
  const includeAlts = args.include_alternatives === true;
  const followEmbeds = args.follow_embeds !== false;

  const fromArgs: { path?: string; title?: string } = {};
  if (args.from !== undefined) fromArgs.path = args.from;
  else if (args.from_title !== undefined) fromArgs.title = args.from_title;
  const fromEntry = await resolveTarget(vault, fromArgs);

  const toArgs: { path?: string; title?: string } = {};
  if (args.to !== undefined) toArgs.path = args.to;
  else if (args.to_title !== undefined) toArgs.title = args.to_title;
  const toEntry = await resolveTarget(vault, toArgs);

  if (fromEntry.absPath === toEntry.absPath) {
    return {
      from: fromEntry.relPath,
      to: toEntry.relPath,
      found: true,
      hops: 0,
      path: [{ path: fromEntry.relPath, title: stripMd(fromEntry.basename), via: "" }]
    };
  }

  const entries = await vault.listMarkdown();

  // BFS layer-by-layer. visited tracks shortest-known-depth so we don't
  // revisit at greater depths. We continue collecting at the depth where
  // we first hit the target IF include_alternatives is set.
  // v1.8.1 perf fix: build a relPath → entry map ONCE before the BFS loop.
  // Pre-fix: entries.find((e) => e.relPath === node.rel) was O(N) per visited
  // node, making the whole BFS O(N²) on large vaults.
  const byRel = new Map<string, FileEntry>();
  for (const e of entries) byRel.set(e.relPath, e);

  type FrontierEntry = { rel: string; trail: PathStep[] };
  const visited = new Set<string>([fromEntry.relPath]);
  let frontier: FrontierEntry[] = [
    { rel: fromEntry.relPath, trail: [{ path: fromEntry.relPath, title: stripMd(fromEntry.basename), via: "" }] }
  ];
  const found: PathStep[][] = [];
  let foundDepth = -1;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: FrontierEntry[] = [];
    for (const node of frontier) {
      const entry = byRel.get(node.rel);
      if (!entry) continue;
      const { parsed } = await vault.readNote(entry.absPath, entry.mtimeMs);
      const links = followEmbeds ? [...parsed.wikilinks, ...parsed.embeds] : parsed.wikilinks;
      for (const link of links) {
        const m = findBestMatch(entries, link.target, entry.relPath);
        if (!m) continue;
        if (visited.has(m.relPath) && m.absPath !== toEntry.absPath) continue;
        const newTrail: PathStep[] = [...node.trail, { path: m.relPath, title: stripMd(m.basename), via: link.raw }];
        if (m.absPath === toEntry.absPath) {
          if (foundDepth === -1) foundDepth = depth + 1;
          if (foundDepth === depth + 1) {
            found.push(newTrail);
            if (!includeAlts) {
              return {
                from: fromEntry.relPath,
                to: toEntry.relPath,
                found: true,
                hops: foundDepth,
                path: newTrail
              };
            }
          }
        } else {
          visited.add(m.relPath);
          next.push({ rel: m.relPath, trail: newTrail });
        }
      }
    }
    if (foundDepth !== -1 && depth + 1 === foundDepth) break;
    frontier = next;
  }

  if (found.length > 0) {
    found.sort((a, b) => a.length - b.length || (a[0]?.path ?? "").localeCompare(b[0]?.path ?? ""));
    const first = found[0];
    if (!first) {
      return { from: fromEntry.relPath, to: toEntry.relPath, found: false, hops: -1, path: [] };
    }
    const result: FindPathResult = {
      from: fromEntry.relPath,
      to: toEntry.relPath,
      found: true,
      hops: foundDepth,
      path: first
    };
    if (includeAlts) result.alternatives = found.slice(0, 10);
    return result;
  }

  return { from: fromEntry.relPath, to: toEntry.relPath, found: false, hops: -1, path: [] };
}

// ─── obsidian_open_in_ui (v1.6 cyanheads pattern) ───────────────────────────
// Returns an obsidian:// URI for hand-off to the desktop app. No filesystem or
// network side effect — the URI emission lets the agent say "open this in
// Obsidian" without enquire-mcp needing to coordinate with the running app.

export interface OpenInUiResult {
  uri: string;
  vault_name: string;
  path: string;
  title: string;
}

export async function openInUi(
  vault: Vault,
  args: { path?: string; title?: string; new_pane?: boolean }
): Promise<OpenInUiResult> {
  await vault.ensureExists();
  const target = await resolveTarget(vault, args);
  // Vault name = leaf of the vault root path. obsidian:// matches by name OR
  // by the file's absolute path; if the user opened the vault from a
  // different name in Obsidian, the file argument still resolves correctly.
  const vaultName = path.basename(vault.root);
  const noteRel = stripMd(target.relPath);
  const params = new URLSearchParams({ vault: vaultName, file: noteRel });
  if (args.new_pane) params.set("newpane", "true");
  return {
    uri: `obsidian://open?${params.toString()}`,
    vault_name: vaultName,
    path: target.relPath,
    title: stripMd(target.basename)
  };
}

// ─── obsidian_context_pack (v2.2.0 — token-budgeted vault context export) ───
// Smart Connections' "Send to Smart Context" pattern, MCP-native. Takes a
// query, runs hybrid retrieval, gathers note bodies + 1-line backlink
// summaries + recent daily notes, deduplicates, packs to a token budget,
// returns one ready-to-paste markdown string. The agent doesn't have to
// orchestrate 5 separate tool calls — one tool, one context blob.
//
// Why MCP-native > Obsidian-only: Smart Context only works inside Obsidian.
// This tool works in Claude Code, Cursor, Codex, anywhere — copy the result
// into ANY chat.

export interface ContextPackArgs {
  /** Topic / question to gather context for. */
  query: string;
  /** Approximate token budget for the bundle. ~4 chars/token assumption. Default 4000. */
  budget_tokens?: number;
  /** Restrict retrieval to this folder. */
  folder?: string;
  /** Include backlinks of top-K notes (1-line each)? Default true. */
  include_backlinks?: boolean;
  /** Include the last N daily notes? Default 0 (off). Set to 3 for "what was I doing recently". */
  recent_dailies?: number;
}

export interface ContextPackResult {
  query: string;
  /** The packed markdown bundle ready to paste into an AI chat. */
  bundle: string;
  /** Approximate token count (chars / 4). */
  estimated_tokens: number;
  budget_tokens: number;
  /** Per-section byte counts for observability. */
  sections: {
    notes: number;
    backlinks: number;
    dailies: number;
  };
  /** Top-K hit paths included in the bundle. */
  included_notes: string[];
}

export async function contextPack(
  vault: Vault,
  args: ContextPackArgs,
  ctx: { ftsIndex: FtsIndex | null; embedFile: string }
): Promise<ContextPackResult> {
  await vault.ensureExists();
  if (!args.query?.trim()) throw new Error("context_pack: `query` is required");
  const budget = args.budget_tokens ?? 4000;
  const charBudget = budget * 4; // ~4 chars/token
  const includeBacklinks = args.include_backlinks !== false;
  const recentN = Math.max(0, args.recent_dailies ?? 0);

  // 1) Hybrid retrieval — top-K notes
  const search = await searchHybrid(
    vault,
    { query: args.query, folder: args.folder, limit: 10 },
    { ftsIndex: ctx.ftsIndex, embedFile: ctx.embedFile }
  );

  const sections: string[] = [`# Context for: ${args.query}\n`];
  const includedNotes: string[] = [];
  let charsUsed = sections[0]?.length ?? 0;
  let notesBytes = 0;
  let backlinksBytes = 0;
  let dailiesBytes = 0;

  // 2) Pack note bodies until budget exhausted
  sections.push("## Top notes");
  for (const m of search.matches) {
    if (charsUsed >= charBudget) break;
    try {
      const note = await vault.readNote(vault.resolveInside(m.path), undefined);
      const body = note.parsed.body.trim();
      const headerLen = m.path.length + 5;
      const remaining = charBudget - charsUsed;
      // Truncate body to fit remaining budget for THIS note (~50% of remainder
      // so we leave room for backlinks + dailies).
      const noteCap = Math.min(body.length, Math.max(500, Math.floor(remaining * 0.5)));
      const trimmed = body.length <= noteCap ? body : `${body.slice(0, noteCap)}\n\n[…truncated…]`;
      const block = `### ${m.path}\n\n${trimmed}\n`;
      sections.push(block);
      charsUsed += block.length + headerLen;
      notesBytes += block.length;
      includedNotes.push(m.path);
    } catch {
      // skip unreadable notes
    }
  }

  // 3) 1-line backlink summaries for top-3
  if (includeBacklinks && includedNotes.length > 0 && charsUsed < charBudget) {
    sections.push("## Backlinks");
    let backlinksAdded = 0;
    for (const notePath of includedNotes.slice(0, 3)) {
      if (charsUsed >= charBudget) break;
      try {
        const links = await getBacklinks(vault, { path: notePath, limit: 5 });
        if (links.length > 0) {
          const block = `### → ${notePath}\n${links.map((l) => `- ${l.path} : ${(l.snippets[0] ?? "").slice(0, 80)}`).join("\n")}\n`;
          sections.push(block);
          charsUsed += block.length;
          backlinksBytes += block.length;
          backlinksAdded += links.length;
        }
      } catch {
        // skip
      }
    }
    if (backlinksAdded === 0) sections.pop(); // remove empty heading
  }

  // 4) Recent daily notes
  if (recentN > 0 && charsUsed < charBudget) {
    try {
      const recent = await getRecentEdits(vault, { since_minutes: 60 * 24 * 7, limit: recentN, folder: args.folder });
      const dailies = recent.filter((r) => /\d{4}-\d{2}-\d{2}/.test(r.path));
      if (dailies.length > 0) {
        sections.push(`## Recent (${dailies.length} dailies, last 7 days)`);
        for (const d of dailies) {
          if (charsUsed >= charBudget) break;
          const block = `- ${d.path} (${d.mtime})`;
          sections.push(block);
          charsUsed += block.length;
          dailiesBytes += block.length;
        }
      }
    } catch {
      // skip
    }
  }

  const bundle = sections.join("\n");
  return {
    query: args.query,
    bundle,
    estimated_tokens: Math.ceil(bundle.length / 4),
    budget_tokens: budget,
    sections: { notes: notesBytes, backlinks: backlinksBytes, dailies: dailiesBytes },
    included_notes: includedNotes
  };
}

// ─── small set / string helpers shared by find_similar / get_note_neighbors ─

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

export function ngrams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  if (s.length < n) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

// Per-entries-array memo for the lookup indices findBestMatch needs. Keyed by
// the entries array reference so a fresh listMarkdown() result rebuilds the
// indices, but a hot loop calling findBestMatch repeatedly with the same
// `entries` argument shares one index. Closes the v1.2 bench finding that
// findBestMatch was the dominant cost in find_similar / get_note_neighbors /
// vault_stats / rename_note at 10k vaults (~2-3s p50 → ~50-200ms post-fix).
interface EntryIndex {
  byBasename: Map<string, FileEntry[]>;
  byRelPath: Map<string, FileEntry>;
}
const entryIndexCache = new WeakMap<FileEntry[], EntryIndex>();

export function indexFor(entries: FileEntry[]): EntryIndex {
  const cached = entryIndexCache.get(entries);
  if (cached) return cached;
  const byBasename = new Map<string, FileEntry[]>();
  const byRelPath = new Map<string, FileEntry>();
  for (const e of entries) {
    const key = stripMd(e.basename).toLowerCase();
    const slot = byBasename.get(key);
    if (slot) slot.push(e);
    else byBasename.set(key, [e]);
    byRelPath.set(stripMd(e.relPath).toLowerCase(), e);
  }
  const idx: EntryIndex = { byBasename, byRelPath };
  entryIndexCache.set(entries, idx);
  return idx;
}

export function findBestMatch(entries: FileEntry[], target: string, fromNote?: string): FileEntry | null {
  const idx = indexFor(entries);

  if (target.startsWith("./") || target.startsWith("../") || target.includes("/../")) {
    if (fromNote) {
      const fromDir = path.dirname(fromNote);
      const joined = path.posix.normalize(path.posix.join(fromDir.split(path.sep).join("/"), target));
      const lower = stripMd(joined).toLowerCase();
      const rel = idx.byRelPath.get(lower);
      if (rel) return rel;
    }
  }
  const norm = stripMd(target).toLowerCase();
  const exact = idx.byBasename.get(norm) ?? [];
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1 && fromNote) {
    const fromDir = path.dirname(fromNote);
    const sameDir = exact.find((e) => path.dirname(e.relPath) === fromDir);
    if (sameDir) return sameDir;
  }
  if (exact.length > 0) return exact[0] ?? null;
  if (target.includes("/")) {
    const lower = stripMd(target).toLowerCase();
    const path1 = idx.byRelPath.get(lower);
    if (path1) return path1;
    // endsWith match — falls back to a scan, but only for path-qualified
    // targets that don't exact-match (rare).
    for (const e of entries) {
      if (stripMd(e.relPath).toLowerCase().endsWith(`/${lower}`)) return e;
    }
  }
  return null;
}

export function stripMd(name: string): string {
  return name.replace(/\.md$/i, "");
}

export function normalizeTag(t: string): string {
  return t.replace(/^#+/, "").toLowerCase();
}
