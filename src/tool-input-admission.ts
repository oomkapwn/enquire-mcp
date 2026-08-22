import { z } from "zod";

/**
 * Strict top-level schema for `obsidian_rename_note`.
 *
 * Keeping this admission object outside registration boilerplate makes typo
 * rejection directly testable under coverage while the registry only wires it
 * to the handler.
 */
export const RENAME_NOTE_INPUT_SCHEMA = z.strictObject({
  from: z.string().describe("Vault-relative path of the existing note (with or without .md)"),
  to: z.string().describe("Vault-relative path of the new location (with or without .md). Different folder = move."),
  dry_run: z.boolean().optional().describe("Preview the rewrite plan without writing anything to disk (default false)"),
  overwrite: z.boolean().optional().describe("Allow overwriting an existing note at `to` (default false)")
});
