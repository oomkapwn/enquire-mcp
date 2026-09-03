import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOpenQuestions } from "../src/tools/meta.js";
import { Vault } from "../src/vault.js";

const roots: string[] = [];

async function fixture(files: Record<string, string>): Promise<{ root: string; vault: Vault }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-open-question-budget-"));
  roots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
  }
  return { root, vault: new Vault(root) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("getOpenQuestions bounded producer admission", () => {
  it("fails closed on an incomplete bounded inventory before any note read", async () => {
    const { vault } = await fixture({ "a.md": "Q: a", "b.md": "Q: b" });
    const read = vi.spyOn(vault, "readNoteUncached");

    await expect(getOpenQuestions(vault, {}, { limits: { maxNotes: 1 } })).rejects.toThrow(
      /exact results require a complete vault inventory/i
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("admits exact small UTF-8 boundaries and rejects text, line, and candidate byte cap-minus-one controls", async () => {
    const content = "Q: one";
    const { vault } = await fixture({ "one.md": content });
    const textBytes = Buffer.byteLength(content, "utf8");
    const candidateBytes = textBytes + Buffer.byteLength("one.md", "utf8") + Buffer.byteLength("one.md", "utf8");

    const exact = await getOpenQuestions(
      vault,
      {},
      {
        limits: {
          maxNotes: 1,
          maxTextUtf8Bytes: textBytes,
          maxLines: 1,
          maxLineUtf8Bytes: textBytes,
          maxCandidates: 1,
          maxCandidateUtf8Bytes: candidateBytes
        }
      }
    );
    expect(exact.map((question) => question.question)).toEqual(["one"]);

    await expect(getOpenQuestions(vault, {}, { limits: { maxTextUtf8Bytes: textBytes - 1 } })).rejects.toThrow(
      /listed note text exceeds/i
    );
    await expect(getOpenQuestions(vault, {}, { limits: { maxLineUtf8Bytes: textBytes - 1 } })).rejects.toThrow(
      /body line text exceeds/i
    );
    await expect(
      getOpenQuestions(vault, {}, { limits: { maxCandidateUtf8Bytes: candidateBytes - 1 } })
    ).rejects.toThrow(/candidate metadata exceeds/i);
  });

  it("rejects aggregate line and candidate count cap-plus-one controls", async () => {
    const { vault } = await fixture({ "two.md": "Q: one\nQ: two" });

    await expect(getOpenQuestions(vault, {}, { limits: { maxLines: 1 } })).rejects.toThrow(/body line count exceeds/i);
    await expect(getOpenQuestions(vault, {}, { limits: { maxCandidates: 1 } })).rejects.toThrow(
      /candidate count exceeds/i
    );
  });

  it("applies custom regexes through bounded sequential batches under one non-resetting deadline", async () => {
    const { vault } = await fixture({
      "questions.md": ["Q: one", "Q: two", "Q: three", "Q: four", "Q: five"].join("\n")
    });
    const batches: string[][] = [];
    const budgets: number[] = [];

    const out = await getOpenQuestions(
      vault,
      { pattern: "^Q: (.+)$", scanBudgetMs: 1000 },
      {
        limits: { maxWorkerBatchCandidates: 2, maxWorkerBatchUtf8Bytes: 32 },
        matchBatch: async (pattern, lines, budgetMs) => {
          batches.push([...lines]);
          budgets.push(budgetMs);
          const regex = new RegExp(pattern, "i");
          return lines.flatMap((line, idx) => {
            const match = regex.exec(line);
            return match?.[1] === undefined ? [] : [{ idx, q: match[1] }];
          });
        }
      }
    );

    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.flat()).toEqual(["Q: one", "Q: two", "Q: three", "Q: four", "Q: five"]);
    expect(budgets.every((budget) => budget > 0 && budget <= 1000)).toBe(true);
    expect(budgets.every((budget, index) => index === 0 || budget <= (budgets[index - 1] ?? 0))).toBe(true);
    expect(out.map((question) => question.question)).toEqual(["one", "two", "three", "four", "five"]);

    const originalRead = vault.readNoteUncached.bind(vault);
    const read = vi.spyOn(vault, "readNoteUncached").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return originalRead(...args);
    });
    try {
      const delayed = await getOpenQuestions(
        vault,
        { pattern: "^Q: (.+)$", scanBudgetMs: 80 },
        {
          limits: { maxWorkerBatchCandidates: 2, maxWorkerBatchUtf8Bytes: 32 },
          matchBatch: async (pattern, lines) => {
            const regex = new RegExp(pattern, "i");
            return lines.flatMap((line, idx) => {
              const match = regex.exec(line);
              return match?.[1] === undefined ? [] : [{ idx, q: match[1] }];
            });
          }
        }
      );
      expect(read).toHaveBeenCalled();
      expect(delayed.map((question) => question.question)).toEqual(["one", "two", "three", "four", "five"]);
    } finally {
      read.mockRestore();
    }

    // ── AUD-1: the time that is NOT matching still has an aggregate ceiling ──
    // Keeping worker startup out of the ReDoS budget was right — it rejected
    // legitimate patterns on large vaults for a reason that had nothing to do
    // with the pattern. But it left the request with no aggregate clock at all:
    // the startup bound is per WORKER, and a vault with many batches multiplies
    // it. A matcher that burns wall time while reporting no matching time is
    // exactly that shape.
    const burnWallReportNoMatching = async (
      pattern: string,
      lines: readonly string[],
      _budgetMs: number,
      onMatchingMs?: (ms: number) => void
    ): Promise<{ idx: number; q: string }[]> => {
      const until = Date.now() + 5;
      while (Date.now() < until) {
        /* occupy wall time the way thread startup does */
      }
      onMatchingMs?.(0);
      const regex = new RegExp(pattern, "i");
      return lines.flatMap((line, idx) => {
        const match = regex.exec(line);
        return match?.[1] === undefined ? [] : [{ idx, q: match[1] }];
      });
    };

    await expect(
      getOpenQuestions(
        vault,
        { pattern: "^Q: (.+)$", scanBudgetMs: 1000 },
        {
          limits: { maxWorkerBatchCandidates: 1, maxWorkerBatchUtf8Bytes: 32, maxWorkerOverheadMs: 1 },
          matchBatch: burnWallReportNoMatching
        }
      )
    ).rejects.toThrow(/aggregate budget for one request/);

    // The two failures stay distinct. Reporting scan cost as catastrophic
    // backtracking is what sends the next reader hunting a pattern bug that does
    // not exist, so the message is asserted, not just the rejection.
    const scanCostError = await getOpenQuestions(
      vault,
      { pattern: "^Q: (.+)$", scanBudgetMs: 1000 },
      {
        limits: { maxWorkerBatchCandidates: 1, maxWorkerBatchUtf8Bytes: 32, maxWorkerOverheadMs: 1 },
        matchBatch: burnWallReportNoMatching
      }
    ).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(scanCostError).toContain("scan-cost limit");
    expect(scanCostError).not.toContain("catastrophic backtracking");

    // NEGATIVE control: a matcher that reports its wall time AS matching charges
    // the ReDoS budget instead and never touches the overhead ceiling, so the
    // same tiny overhead budget does not trip.
    const reportAllAsMatching = async (
      pattern: string,
      lines: readonly string[],
      _budgetMs: number,
      onMatchingMs?: (ms: number) => void
    ): Promise<{ idx: number; q: string }[]> => {
      const started = Date.now();
      const until = started + 5;
      while (Date.now() < until) {
        /* same cost, attributed differently */
      }
      onMatchingMs?.(Date.now() - started);
      const regex = new RegExp(pattern, "i");
      return lines.flatMap((line, idx) => {
        const match = regex.exec(line);
        return match?.[1] === undefined ? [] : [{ idx, q: match[1] }];
      });
    };
    const attributed = await getOpenQuestions(
      vault,
      { pattern: "^Q: (.+)$", scanBudgetMs: 1000 },
      {
        limits: { maxWorkerBatchCandidates: 1, maxWorkerBatchUtf8Bytes: 32, maxWorkerOverheadMs: 1 },
        matchBatch: reportAllAsMatching
      }
    );
    expect(attributed.map((question) => question.question)).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("rejects an invalid batch result instead of trusting an amplified worker payload", async () => {
    const { vault } = await fixture({ "one.md": "Q: one" });

    await expect(
      getOpenQuestions(
        vault,
        { pattern: "^Q: (.+)$" },
        {
          limits: { maxWorkerBatchCandidates: 1 },
          matchBatch: async () => [
            { idx: 0, q: "one" },
            { idx: 0, q: "duplicate" }
          ]
        }
      )
    ).rejects.toThrow(/invalid match batch/i);
  });

  it("keeps the exact globally oldest top-K while retaining only K results", async () => {
    const { root, vault } = await fixture({
      "a-new.md": "Q: new",
      "b-oldest.md": "Q: oldest",
      "c-middle.md": "Q: middle"
    });
    const now = Date.now();
    await fs.utimes(path.join(root, "a-new.md"), new Date(now - 1000), new Date(now - 1000));
    await fs.utimes(path.join(root, "b-oldest.md"), new Date(now - 3000), new Date(now - 3000));
    await fs.utimes(path.join(root, "c-middle.md"), new Date(now - 2000), new Date(now - 2000));

    const out = await getOpenQuestions(vault, { limit: 2 });
    expect(out.map((question) => question.question)).toEqual(["oldest", "middle"]);
    expect(out.map((question) => question.question)).not.toContain("new");
  });

  it("fails closed when the exact top-K response cannot fit its retained-byte budget", async () => {
    const { vault } = await fixture({ "one.md": "Q: one" });
    await expect(getOpenQuestions(vault, {}, { limits: { maxResultUtf8Bytes: 1 } })).rejects.toThrow(
      /exact top-100 result exceeds/i
    );
  });
});
