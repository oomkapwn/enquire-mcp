import { EmbedDb } from "../../dist/embed-db.js";

const [mode, file] = process.argv.slice(2);
if ((mode !== "db" && mode !== "context") || !file) {
  process.stderr.write("missing EmbedDb persistence child arguments\n");
  process.exitCode = 2;
} else {
  const db = new EmbedDb({ file, vaultRoot: "/vault/embed-coordination", modelAlias: "multilingual", dim: 4 });
  try {
    await db.open();
    db.upsertNote("held.md", 1, [
      {
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 1,
        textPreview: "durable-held-generation",
        vector: new Float32Array([1, 0, 0, 0])
      }
    ]);
    const contextLifetime = mode === "context" ? await db.acquireSharedPersistenceLifetime() : null;
    if (contextLifetime) await db.closeAndRelease();
    process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);

    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", async (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      try {
        if (contextLifetime) await contextLifetime.release();
        else await db.closeAndRelease();
        process.stdout.write(`${JSON.stringify({ event: "closed" })}\n`);
        process.exit(0);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
      }
    });
    const timeout = setTimeout(() => process.exit(3), 15_000);
    timeout.unref();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
