import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FtsIndex } from "../src/fts5.js";
import { readChunkResource } from "../src/resource-admission.js";
import { RENAME_NOTE_INPUT_SCHEMA } from "../src/tool-input-admission.js";
import { Vault } from "../src/vault.js";

describe("tool input authority admission", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-tool-admission-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects a misspelled dry_run field instead of stripping it into a real write request", () => {
    expect(RENAME_NOTE_INPUT_SCHEMA.safeParse({ from: "A.md", to: "B.md", dry_rnu: true }).success).toBe(false);
    expect(RENAME_NOTE_INPUT_SCHEMA.safeParse({ from: "A.md", to: "B.md", dry_run: true }).success).toBe(true);
  });

  it("keeps the complete top-level tool-schema census strict", () => {
    const registrySource = readFileSync(path.resolve(__dirname, "../src/tool-registry.ts"), "utf8");
    const admissionSource = readFileSync(path.resolve(__dirname, "../src/tool-input-admission.ts"), "utf8");
    const inlineStrictCount = registrySource.match(/inputSchema:\s*z\.strictObject\(\{/gu)?.length ?? 0;
    const extractedStrictCount =
      admissionSource.match(/export const RENAME_NOTE_INPUT_SCHEMA\s*=\s*z\.strictObject\(\{/gu)?.length ?? 0;
    const strictCount = inlineStrictCount + extractedStrictCount;
    expect(strictCount).toBe(46);
    expect(registrySource).toContain("inputSchema: RENAME_NOTE_INPUT_SCHEMA");
    expect(registrySource).not.toMatch(/inputSchema:\s*z\.object\(\{/u);
    expect(admissionSource).not.toMatch(/RENAME_NOTE_INPUT_SCHEMA\s*=\s*z\.object\(\{/u);

    const mutant = registrySource.replace("inputSchema: z.strictObject({", "inputSchema: z.object({");
    expect(mutant).toMatch(/inputSchema:\s*z\.object\(\{/u);
  });

  it.each(["1junk", "1.5", "1e3", "+1", "-0", "01", "9007199254740993"])(
    "rejects non-canonical chunk index URI component %s",
    async (chunkIndex) => {
      await expect(
        readChunkResource(new Vault(root), {} as FtsIndex, new URL(`obsidian://chunk/${chunkIndex}/Note.md`), {
          chunkIndex,
          notePath: "Note.md"
        })
      ).rejects.toThrow(/Invalid chunk index/);
    }
  );

  it("accepts canonical zero and forwards that exact integer to the live chunk reader", async () => {
    const notePath = path.join(root, "Note.md");
    await fs.writeFile(notePath, "live chunk\n");
    const vault = new Vault(root);
    await vault.ensureExists();
    const stat = await vault.stat("Note.md");
    const idx = {
      getChunkWithReceipt(relPath: string, chunkIndex: number) {
        expect([relPath, chunkIndex]).toEqual(["Note.md", 0]);
        return {
          line_start: 1,
          line_end: 1,
          content: "live chunk",
          kind: "md",
          indexed_mtime_ms: stat.mtimeMs,
          indexed_revision: 1
        };
      },
      isCurrentSourceReceipt: () => true
    } as unknown as FtsIndex;
    const result = await readChunkResource(vault, idx, new URL("obsidian://chunk/0/Note.md"), {
      chunkIndex: "0",
      notePath: "Note.md"
    });
    expect(JSON.parse(result.contents[0]?.text ?? "null")).toMatchObject({
      rel_path: "Note.md",
      chunk_index: 0,
      content: "live chunk"
    });
  });
});
