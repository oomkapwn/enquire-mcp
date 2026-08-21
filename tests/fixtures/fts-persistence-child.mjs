import { FtsIndex } from "../../dist/fts5.js";

const [mode, file, vaultRoot] = process.argv.slice(2);

if ((mode !== "hold" && mode !== "late") || !file || !vaultRoot) {
  process.stderr.write("missing FTS persistence child arguments\n");
  process.exitCode = 2;
} else {
  const index = new FtsIndex({ file, vaultRoot });
  try {
    await index.open();
    index.reindexFile("held.md", 1, "durable-held-generation");
    process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);

    let input = "";
    let closed = false;
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", async (chunk) => {
      input += chunk;
      while (true) {
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const command = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          if (command === "close" && !closed) {
            closed = true;
            await index.closeAndRelease();
            process.stdout.write(`${JSON.stringify({ event: "closed" })}\n`);
            if (mode === "hold") process.exit(0);
          } else if (command === "mutate" && mode === "late") {
            try {
              index.reindexFile("late.md", 2, "must-not-resurrect");
              process.stdout.write(`${JSON.stringify({ event: "mutated" })}\n`);
              process.exit(4);
            } catch (error) {
              process.stdout.write(
                `${JSON.stringify({
                  event: "mutation-refused",
                  message: error instanceof Error ? error.message : String(error)
                })}\n`
              );
              process.exit(0);
            }
          }
        } catch (error) {
          process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
          process.exit(1);
        }
      }
    });
    const timeout = setTimeout(() => {
      process.stderr.write("FTS persistence child timed out\n");
      process.exit(3);
    }, 15_000);
    timeout.unref();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
