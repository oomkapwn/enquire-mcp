// v3.8.0-rc.5 K-3 invariant — NEGATIVE fixture (WRITE without write handler).
//
// This is the inverse bug shape: a tool annotated WRITE but whose
// handler doesn't actually call any known write helper. Symptoms:
//   - User sees "destructive" badge in MCP client → expects confirmation
//   - Tool actually does nothing OR only reads → confirmation noise
//   - Worse: tool was supposed to write but the implementation was
//     refactored to read-only and the annotation wasn't updated
//
// scanRegistry must detect this so the inverse drift class is also
// guarded.
//
// FIXTURE: do NOT add a write handler call below — it's intentionally
// missing.

declare const WRITE: { readOnlyHint: false; destructiveHint: true };
declare const vault: unknown;
declare const server: {
  registerTool: (name: string, config: object, handler: (args: object) => Promise<object>) => void;
};
declare const readNote: (vault: unknown, args: object) => Promise<object>;
declare const textResult: (x: object) => object;

// 💥 BUG SHAPE: annotated WRITE but handler calls readNote (not a write).
server.registerTool(
  "obsidian_write_no_handler_BAD",
  {
    title: "Write but really read (BAD fixture)",
    description: "Annotated as WRITE but the handler is read-only.",
    annotations: { ...WRITE, title: "Write but read" }
  },
  async (args) => textResult(await readNote(vault, args))
);
