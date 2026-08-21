import {
  acquirePersistenceFamilyLease,
  acquirePersistenceNamespaceEraser
} from "../../dist/persistence-coordination.js";

const [mode, parentPath, targetPath, familyKey] = process.argv.slice(2);

if (!mode || !parentPath) {
  process.stderr.write("missing persistence coordination child arguments\n");
  process.exitCode = 2;
} else {
  try {
    let lease = null;
    if (mode === "namespace-eraser") {
      lease = await acquirePersistenceNamespaceEraser({ parentPath, gateTimeoutMs: 2_000, gatePollMs: 10 });
    } else if (targetPath && familyKey && (mode === "shared" || mode === "publisher" || mode === "eraser")) {
      lease = await acquirePersistenceFamilyLease({
        targetPath,
        familyKey,
        role: mode,
        gateTimeoutMs: 2_000,
        gatePollMs: 10
      });
    }
    if (!lease) throw new Error("invalid persistence coordination child mode");
    process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    let released = false;
    const timer = setTimeout(() => {
      process.stderr.write("persistence coordination child timed out\n");
      process.exit(3);
    }, 10_000);
    timer.unref();
    process.stdin.on("data", async (chunk) => {
      if (released || !chunk.includes("release")) return;
      released = true;
      clearTimeout(timer);
      try {
        await lease.release();
        process.stdout.write(`${JSON.stringify({ event: "released" })}\n`);
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
