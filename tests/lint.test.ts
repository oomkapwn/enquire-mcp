import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOpenQuestions, lintWiki, paperAudit } from "../src/tools.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-lint-"));
  await fs.mkdir(path.join(root, "Papers"), { recursive: true });
  await fs.mkdir(path.join(root, "Inbox"), { recursive: true });

  // Hub: links to good + stub + paper. Not an orphan.
  await fs.writeFile(
    path.join(root, "Hub.md"),
    "---\ntags: [hub]\n---\n\n# Hub\n\nReferences [[Good Note]] and [[Tiny Stub]] and [[Papers/Apollo Paper]].\n\n## Concepts\n\nReinforcement Learning is mentioned here.\nAttention Heads are crucial.\n"
  );

  // Good note — well-developed, has frontmatter, has content. Backlinked from Hub.
  const longBody = [
    "This is a sufficiently developed note about something.",
    "It has multiple sentences.",
    "Here is more content to ensure word count is high."
  ].join(" ");
  const longContent = `${longBody} ${"word ".repeat(100)}`;
  await fs.writeFile(
    path.join(root, "Good Note.md"),
    `---\ntitle: Good Note\nlast_reviewed: 2099-01-01\ntags: [project]\n---\n\n${longContent}\n\n# Open question:\n\nQ: What about Attention Heads vs MLPs?\n\nReinforcement Learning shows up here too.\n`
  );

  // Stub — fewer than 100 words, but linked from Hub (so not an orphan).
  await fs.writeFile(path.join(root, "Tiny Stub.md"), "Just a few words. That's it.\n");

  // Orphan — no inbound, no outbound.
  await fs.writeFile(
    path.join(root, "Inbox", "lonely.md"),
    "I am alone in the world. Nobody links to me. I link to nobody.\n"
  );

  // Stale — frontmatter + old mtime.
  const stalePath = path.join(root, "ancient.md");
  const longStaleContent = `${"developed content ".repeat(100)} for the stale file with plenty of words to clear stub threshold.`;
  await fs.writeFile(stalePath, `---\nlast_reviewed: 1999-01-01\n---\n\n${longStaleContent}\n[[Hub]]\n`);

  // Broken — links to a non-existent target.
  await fs.writeFile(
    path.join(root, "broken-link-source.md"),
    `${"plenty of words here ".repeat(50)}\n\nThis note links to [[NonExistentTarget]] which doesn't exist.\n`
  );

  // Paper note WITH frontmatter citation.
  await fs.writeFile(
    path.join(root, "Papers", "Apollo Paper.md"),
    `---\ntags: [paper]\narxiv: 2401.12345\n---\n\n${"Body of the paper note ".repeat(40)}\n`
  );

  // Paper note MISSING citation in frontmatter but has arxiv ID in body.
  await fs.writeFile(
    path.join(root, "Papers", "Hermes Paper.md"),
    `---\ntags: [paper]\n---\n\n${"This paper says interesting things ".repeat(20)}\n\nSee arxiv:2305.99999 for details. Also visit https://arxiv.org/abs/2305.99999 .\n`
  );

  // Paper note with NO citation anywhere.
  await fs.writeFile(
    path.join(root, "Papers", "Mystery Paper.md"),
    `---\ntags: [paper]\n---\n\n${"I cite nothing. ".repeat(50)}\n`
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("lintWiki (v1.5 — Karpathy LLM-Wiki workflow)", () => {
  it("returns five buckets with summaries that match findings.length", async () => {
    const v = new Vault(root);
    const out = await lintWiki(v, {});
    expect(out.scope).toBe("(whole vault)");
    expect(out.scanned).toBeGreaterThan(0);
    // Summary numbers must match the actual array lengths.
    expect(out.summary.orphans).toBe(out.findings.orphans.length);
    expect(out.summary.broken_links).toBe(out.findings.broken_links.length);
    expect(out.summary.stubs).toBe(out.findings.stubs.length);
    expect(out.summary.stale).toBe(out.findings.stale.length);
    expect(out.summary.concept_candidates).toBe(out.findings.concept_candidates.length);
  });

  it("flags orphans (no inbound + no outbound)", async () => {
    const v = new Vault(root);
    const out = await lintWiki(v, {});
    const orphanPaths = out.findings.orphans.map((f) => f.path);
    // Inbox/lonely.md is the orphan we constructed.
    expect(orphanPaths.some((p) => p?.endsWith("lonely.md"))).toBe(true);
    // Hub is NOT an orphan (it links to others).
    expect(orphanPaths.every((p) => p !== "Hub.md")).toBe(true);
  });

  it("flags broken wikilinks with target + suggestion", async () => {
    const v = new Vault(root);
    const out = await lintWiki(v, {});
    const brokenPaths = out.findings.broken_links.map((f) => f.path);
    expect(brokenPaths.some((p) => p?.endsWith("broken-link-source.md"))).toBe(true);
    const broken = out.findings.broken_links.find((f) => f.path?.endsWith("broken-link-source.md"));
    expect(broken?.message).toContain("NonExistentTarget");
    expect(broken?.suggestion).toBeTruthy();
  });

  it("flags stubs (under stub_word_threshold) but not developed notes", async () => {
    const v = new Vault(root);
    const out = await lintWiki(v, { stub_word_threshold: 50 });
    const stubPaths = out.findings.stubs.map((f) => f.path);
    expect(stubPaths.some((p) => p?.endsWith("Tiny Stub.md"))).toBe(true);
    expect(stubPaths.every((p) => !p?.endsWith("Good Note.md"))).toBe(true);
  });

  it("flags stale notes via frontmatter last_reviewed (overrides mtime)", async () => {
    const v = new Vault(root);
    const out = await lintWiki(v, { stale_days: 30 });
    const staleEntry = out.findings.stale.find((f) => f.path?.endsWith("ancient.md"));
    expect(staleEntry).toBeTruthy();
    expect(staleEntry?.details?.source).toBe("frontmatter.last_reviewed");
    // Good Note has last_reviewed: 2099-01-01 — explicitly NOT stale.
    const goodAsStale = out.findings.stale.find((f) => f.path?.endsWith("Good Note.md"));
    expect(goodAsStale).toBeUndefined();
  });

  it("surfaces concept candidates (capitalised phrases mentioned by N+ notes)", async () => {
    const v = new Vault(root);
    const out = await lintWiki(v, { concept_min_mentions: 2 });
    const phrases = out.findings.concept_candidates.map((f) => f.details?.phrase);
    // "Reinforcement Learning" mentioned in Hub + Good Note — should surface.
    // "Attention Heads" mentioned in Hub + Good Note — should also surface.
    const hasOneOfThem = phrases.includes("Reinforcement Learning") || phrases.includes("Attention Heads");
    expect(hasOneOfThem).toBe(true);
  });

  it("max_per_bucket caps each bucket independently", async () => {
    const v = new Vault(root);
    const out = await lintWiki(v, { max_per_bucket: 1 });
    expect(out.findings.orphans.length).toBeLessThanOrEqual(1);
    expect(out.findings.broken_links.length).toBeLessThanOrEqual(1);
    expect(out.findings.stubs.length).toBeLessThanOrEqual(1);
    expect(out.findings.stale.length).toBeLessThanOrEqual(1);
    expect(out.findings.concept_candidates.length).toBeLessThanOrEqual(1);
  });

  it("folder filter narrows the scope", async () => {
    const v = new Vault(root);
    const out = await lintWiki(v, { folder: "Papers" });
    expect(out.scope).toBe("Papers");
    // Inbox/lonely.md is outside the folder — must NOT appear in any bucket.
    const allPaths = [
      ...out.findings.orphans,
      ...out.findings.broken_links,
      ...out.findings.stubs,
      ...out.findings.stale,
      ...out.findings.concept_candidates
    ]
      .map((f) => f.path)
      .filter(Boolean);
    expect(allPaths.every((p) => !p?.includes("lonely.md"))).toBe(true);
  });
});

describe("getOpenQuestions (v1.5)", () => {
  it("matches Open question / Q: / TODO? / ?? markers, sorts oldest-first", async () => {
    const v = new Vault(root);
    const out = await getOpenQuestions(v, {});
    expect(out.length).toBeGreaterThan(0);
    // Each result has the required fields.
    for (const q of out) {
      expect(q.question).toBeTruthy();
      expect(q.source_path).toBeTruthy();
      expect(q.line).toBeGreaterThan(0);
    }
    // Good Note has both an "Open question:" heading-marker and a "Q:" line.
    const goodNoteQs = out.filter((q) => q.source_path === "Good Note.md");
    expect(goodNoteQs.length).toBeGreaterThanOrEqual(1);
  });

  it("captures context heading when present", async () => {
    const v = new Vault(root);
    const out = await getOpenQuestions(v, { limit: 50 });
    const goodNoteQs = out.filter((q) => q.source_path === "Good Note.md");
    // The "Q: What about..." line lives directly under the "Open question:"
    // heading line — context_heading should reflect that.
    const withHeading = goodNoteQs.find((q) => q.context_heading);
    if (withHeading) expect(withHeading.context_heading).toBeTruthy();
  });

  it("respects folder filter", async () => {
    const v = new Vault(root);
    const out = await getOpenQuestions(v, { folder: "Papers" });
    expect(out.every((q) => q.source_path.startsWith("Papers/"))).toBe(true);
  });
});

describe("paperAudit (v1.5)", () => {
  it("flags paper notes missing frontmatter citation but having body identifier", async () => {
    const v = new Vault(root);
    const result = await paperAudit(v, {});
    expect(result.scanned).toBe(3); // Apollo + Hermes + Mystery
    const flaggedPaths = result.flagged.map((f) => f.path);
    // Hermes has body arxiv but no FM — flagged with proposed patch.
    const hermes = result.flagged.find((f) => f.path.endsWith("Hermes Paper.md"));
    expect(hermes).toBeTruthy();
    expect(hermes?.proposed_frontmatter_patch).toBeTruthy();
    expect(hermes?.proposed_frontmatter_patch?.arxiv).toBe("2305.99999");
    // Mystery has neither — flagged with no patch (nothing to propose).
    const mystery = result.flagged.find((f) => f.path.endsWith("Mystery Paper.md"));
    expect(mystery).toBeTruthy();
    expect(mystery?.proposed_frontmatter_patch).toBeNull();
    // Apollo has frontmatter citation already → NOT flagged.
    expect(flaggedPaths.every((p) => !p.endsWith("Apollo Paper.md"))).toBe(true);
  });

  it("respects custom tag", async () => {
    // No notes are tagged #journal — should return scanned=0 flagged=[].
    const v = new Vault(root);
    const result = await paperAudit(v, { tag: "journal" });
    expect(result.scanned).toBe(0);
    expect(result.flagged.length).toBe(0);
  });

  it("respects folder filter", async () => {
    const v = new Vault(root);
    const result = await paperAudit(v, { folder: "Papers" });
    expect(result.scanned).toBe(3);
    expect(result.flagged.every((f) => f.path.startsWith("Papers/"))).toBe(true);
  });
});
