// v3.8.0-rc.5 K-3 invariant — positive fixture.
//
// Demonstrates the canonical READ_ONLY + WRITE patterns from
// src/tool-registry.ts. The scanRegistry function in
// tests/k3-readonly-hint-invariant.test.ts must classify both tools
// below as valid (READ_ONLY without write refs, WRITE with one write ref).
//
// FIXTURE: do NOT remove the patterns below — they're the positive
// control that proves scanRegistry RECOGNIZES correct wiring.

// Stub declarations — fixture doesn't compile-link to production.
// File uses `.fixture.ts` extension so it's not picked up as a test.
declare const READ_ONLY: { readOnlyHint: true; idempotentHint: true; openWorldHint: false };
declare const WRITE: { readOnlyHint: false; destructiveHint: true; idempotentHint: false; openWorldHint: false };
declare const vault: unknown;
declare const server: {
  registerTool: (
    name: string,
    config: { title: string; description: string; annotations: object; inputSchema?: object },
    handler: (args: object) => Promise<object>
  ) => void;
};
declare const readNote: (vault: unknown, args: object) => Promise<object>;
declare const createNote: (vault: unknown, args: object) => Promise<object>;
declare const textResult: (x: object) => object;

// Canonical READ_ONLY tool — handler does NOT call any write helper.
server.registerTool(
  "obsidian_read_note_GOOD",
  {
    title: "Read note (GOOD fixture)",
    description: "Reads a note from the vault.",
    annotations: { ...READ_ONLY, title: "Read note" }
  },
  async (args) => textResult(await readNote(vault, args))
);

// Canonical WRITE tool — handler calls a known write helper.
server.registerTool(
  "obsidian_create_note_GOOD",
  {
    title: "Create note (GOOD fixture)",
    description: "Creates a new note.",
    annotations: { ...WRITE, title: "Create note" }
  },
  async (args) => textResult(await createNote(vault, args))
);
