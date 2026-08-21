import { FeedbackStore } from "../../dist/feedback.js";

const [file, relPath, nowIso] = process.argv.slice(2);

if (!file || !relPath || !nowIso) {
  process.stderr.write("missing feedback child arguments\n");
  process.exitCode = 2;
} else {
  try {
    const store = await FeedbackStore.open(file);
    process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    let started = false;
    const timer = setTimeout(() => {
      process.stderr.write("feedback child timed out\n");
      process.exit(3);
    }, 10_000);
    timer.unref();
    process.stdin.on("data", async (chunk) => {
      if (started || !chunk.includes("record")) return;
      started = true;
      try {
        const recorded = await store.record([relPath], true, nowIso);
        const size = store.size();
        await store.close();
        clearTimeout(timer);
        process.stdout.write(`${JSON.stringify({ event: "done", recorded, size })}\n`);
        process.exit(0);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
      }
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
