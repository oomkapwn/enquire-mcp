import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquirePersistenceLease, resolvePersistenceLeaseScope } from "../../dist/persistence-lease.js";

const [targetPath, familyKey, role] = process.argv.slice(2);

if (!targetPath || !familyKey || !role) {
  process.stderr.write("missing persistence lease child arguments\n");
  process.exitCode = 2;
} else {
  try {
    if (role === "candidate") {
      const scope = await resolvePersistenceLeaseScope({ targetPath, familyKey });
      const nonce = randomBytes(16).toString("hex");
      const hostDigest = createHash("sha256").update(`host\0${os.hostname()}`, "utf8").digest("hex");
      const markerId = `.candidate.${hostDigest}.${process.pid}.${nonce}`;
      const markerPath = path.join(scope.directory, markerId);
      const file = await fs.open(markerPath, "wx", 0o600);
      await file.writeFile("{", "utf8");
      await file.sync();
      process.stdout.write(`${JSON.stringify({ event: "ready", markerId })}\n`);
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.on("data", async (chunk) => {
        if (!chunk.includes("release")) return;
        await file.close();
        await fs.unlink(markerPath);
        process.stdout.write(`${JSON.stringify({ event: "released" })}\n`);
        process.exit(0);
      });
      setTimeout(() => process.exit(3), 10_000).unref();
    } else {
      const lease = await acquirePersistenceLease({
        targetPath,
        familyKey,
        role,
        gateTimeoutMs: 2_000,
        gatePollMs: 10
      });
      process.stdout.write(`${JSON.stringify({ event: "ready", markerId: lease.marker.id })}\n`);
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      let released = false;
      const timer = setTimeout(() => {
        process.stderr.write("persistence lease child timed out\n");
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
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
