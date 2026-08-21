import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { Vault } from "../../dist/vault.js";

const [mode, vaultRoot, cacheFile] = process.argv.slice(2);

if (!mode || !vaultRoot || !cacheFile) {
  process.stderr.write("missing Vault persistence child arguments\n");
  process.exitCode = 2;
} else {
  const pendingCommands = new Map();
  const queuedCommands = new Set();
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const command = line.trim();
    const resolve = pendingCommands.get(command);
    if (resolve) {
      pendingCommands.delete(command);
      resolve();
    } else {
      queuedCommands.add(command);
    }
  });
  const waitForCommand = (command) => {
    if (queuedCommands.delete(command)) return Promise.resolve();
    return new Promise((resolve) => pendingCommands.set(command, resolve));
  };
  const send = (event) => process.stdout.write(`${JSON.stringify({ event })}\n`);

  try {
    const vault = new Vault(vaultRoot, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    if (mode === "hold") {
      send("ready");
      await waitForCommand("close");
    } else if (mode === "pause-save") {
      await vault.readNote(path.join(vaultRoot, "Late.md"));
      const canonicalCacheFile = path.join(await fs.realpath(path.dirname(cacheFile)), path.basename(cacheFile));
      const realRename = fs.rename.bind(fs);
      let releasePublish = () => {};
      const publishGate = new Promise((resolve) => {
        releasePublish = resolve;
      });
      let paused = false;
      fs.rename = async (from, to) => {
        if (!paused && String(to) === canonicalCacheFile) {
          paused = true;
          send("publish-paused");
          await publishGate;
        }
        return realRename(from, to);
      };
      const save = vault.saveDiskCache();
      await waitForCommand("release-publish");
      releasePublish();
      await save;
      fs.rename = realRename;
      send("published");
      await waitForCommand("close");
    } else {
      throw new Error(`unknown Vault persistence child mode: ${mode}`);
    }
    await vault.closePersistence();
    send("closed");
    input.close();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    input.close();
    process.exitCode = 1;
  }
}
