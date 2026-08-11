#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isEntrypoint } from "./lib/entrypoint.mjs";

/**
 * Fixed workflow policy. The numeric policy exposes no helper-specific
 * environment or argv override.
 * `killGraceMs` is one inclusive termination envelope: graceful signalling,
 * forced termination, and the required platform-specific cleanup checks must fit.
 *
 * @type {Readonly<{attempts:number,attemptTimeoutMs:number,killGraceMs:number,retryDelayMs:number}>}
 * @example
 * NPM_CI_RETRY_POLICY.attempts === 3;
 * NPM_CI_RETRY_POLICY.attemptTimeoutMs === 60_000;
 * NPM_CI_RETRY_POLICY.killGraceMs === 10_000;
 * NPM_CI_RETRY_POLICY.retryDelayMs === 15_000;
 */
export const NPM_CI_RETRY_POLICY = Object.freeze({
  attempts: 3,
  attemptTimeoutMs: 60_000,
  killGraceMs: 10_000,
  retryDelayMs: 15_000
});

const NS_PER_MS = 1_000_000n;
const FORCE_EXIT_RESERVE_MS = 2_000;
const TREE_POLL_MS = 25;
const WINDOWS_TASKKILL = "C:\\Windows\\System32\\taskkill.exe";

/**
 * Resolve the npm CLI shipped beside the active Node runtime.
 *
 * @param {string} execPath - Current Node executable.
 * @param {NodeJS.Platform} platform - Target platform.
 * @returns {{command:string,args:string[]}} Fixed executable specification.
 * @example
 * npmCiProcessSpec(process.execPath, process.platform);
 */
export function npmCiProcessSpec(execPath = process.execPath, platform = process.platform) {
  const executableDir = path.dirname(realpathSync(execPath));
  const candidates =
    platform === "win32"
      ? [path.join(executableDir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [
          path.resolve(executableDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          path.resolve(executableDir, "..", "node_modules", "npm", "bin", "npm-cli.js")
        ];

  for (const candidate of candidates) {
    try {
      const npmCli = realpathSync(candidate);
      if (statSync(npmCli).isFile()) {
        return { command: execPath, args: [npmCli, "ci"] };
      }
    } catch {
      // Try the next layout. Absence is not authority to fall back to PATH.
    }
  }
  throw new Error(`npm CLI is not colocated with the active Node runtime (${platform})`);
}

function timer(ms, clock) {
  let timerId;
  return {
    promise: new Promise((resolve) => {
      timerId = clock.setTimeout(resolve, ms);
    }),
    cancel() {
      if (timerId !== undefined) clock.clearTimeout(timerId);
    }
  };
}

function abortEvent(signal) {
  if (!signal) return { promise: new Promise(() => {}), cancel() {} };
  let listener;
  return {
    promise: new Promise((resolve) => {
      listener = () => resolve(signal.reason ?? new Error("npm ci retry cancelled"));
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    }),
    cancel() {
      if (listener) signal.removeEventListener("abort", listener);
    }
  };
}

function deadlineAfter(nowNs, ms) {
  return nowNs() + BigInt(ms) * NS_PER_MS;
}

function remainingMs(deadlineNs, nowNs) {
  const remainingNs = deadlineNs - nowNs();
  if (remainingNs <= 0n) return 0;
  return Number((remainingNs + NS_PER_MS - 1n) / NS_PER_MS);
}

function taskkillTree(pid, force, timeoutMs, spawnSyncImpl = spawnSync) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("npm ci taskkill has no remaining termination budget");
  }
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  const result = spawnSyncImpl(WINDOWS_TASKKILL, args, {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
    timeout: timeoutMs
  });
  if (result.error) {
    throw new Error(`taskkill ${force ? "/F " : ""}/T failed`, { cause: result.error });
  }
  if (result.status !== 0 || (result.signal !== null && result.signal !== undefined)) {
    throw new Error(
      `taskkill ${force ? "/F " : ""}/T failed (status=${String(result.status)}, signal=${String(result.signal)})`
    );
  }
}

function signalPosixGroup(pid, signal, killImpl = process.kill) {
  try {
    killImpl(-pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function posixGroupExists(pid, killImpl = process.kill) {
  try {
    killImpl(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function observeAttemptExit(child, nowNs) {
  let current = null;
  const promise = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      current = { ...value, observedNs: nowNs() };
      resolve(current);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => finish({ code, signal, error: null }));
  });
  return { promise, current: () => current };
}

async function waitForConditionUntil(condition, deadlineNs, runtime, beforeCheck = () => {}) {
  while (true) {
    beforeCheck();
    if (condition()) return runtime.nowNs() <= deadlineNs;
    const remaining = remainingMs(deadlineNs, runtime.nowNs);
    if (remaining === 0) return false;
    const pause = timer(Math.min(TREE_POLL_MS, remaining), runtime);
    await pause.promise;
    pause.cancel();
  }
}

function forwardedSignal(reason) {
  if (
    reason &&
    typeof reason === "object" &&
    "forwardSignal" in reason &&
    (reason.forwardSignal === "SIGINT" || reason.forwardSignal === "SIGTERM")
  ) {
    return reason.forwardSignal;
  }
  return "SIGTERM";
}

function currentAbortReason(signal) {
  return signal?.aborted ? (signal.reason ?? new Error("npm ci retry cancelled")) : null;
}

async function terminateAttemptTree(
  pid,
  platform,
  runtime,
  observation,
  initialSignal,
  terminationDeadlineNs,
  cancellationSignal
) {
  const forceAtNs = terminationDeadlineNs - BigInt(FORCE_EXIT_RESERVE_MS) * NS_PER_MS;

  if (runtime.nowNs() > terminationDeadlineNs) {
    if (platform !== "win32") signalPosixGroup(pid, "SIGKILL", runtime.kill);
    throw new Error("npm ci termination envelope expired before tree cleanup could start");
  }

  if (platform !== "win32") {
    const complete = () => observation.current() !== null && !posixGroupExists(pid, runtime.kill);
    if (complete() && runtime.nowNs() <= terminationDeadlineNs) return observation.current();
    let cancellationForwarded = cancellationSignal?.aborted ?? false;
    signalPosixGroup(
      pid,
      cancellationForwarded ? forwardedSignal(currentAbortReason(cancellationSignal)) : initialSignal,
      runtime.kill
    );
    const forwardLateCancellation = () => {
      if (!cancellationSignal?.aborted || cancellationForwarded) return;
      cancellationForwarded = true;
      signalPosixGroup(pid, forwardedSignal(currentAbortReason(cancellationSignal)), runtime.kill);
    };
    if (await waitForConditionUntil(complete, forceAtNs, runtime, forwardLateCancellation)) {
      return observation.current();
    }
    signalPosixGroup(pid, "SIGKILL", runtime.kill);
    if (await waitForConditionUntil(complete, terminationDeadlineNs, runtime, forwardLateCancellation)) {
      return observation.current();
    }
    throw new Error("npm ci POSIX process group did not disappear inside the termination envelope");
  }

  if (observation.current() !== null) {
    throw new Error("npm ci Windows leader exited before taskkill could act on the live tree");
  }
  let gracefulError = null;
  try {
    runtime.taskkill(pid, false, remainingMs(forceAtNs, runtime.nowNs));
  } catch (error) {
    gracefulError = error;
  }
  if (gracefulError === null) {
    const exited = await waitForConditionUntil(() => observation.current() !== null, forceAtNs, runtime);
    if (exited) return observation.current();
  }

  try {
    runtime.taskkill(pid, true, remainingMs(terminationDeadlineNs, runtime.nowNs));
  } catch (error) {
    throw new Error("npm ci Windows taskkill /T /F did not complete inside the termination envelope", {
      cause: gracefulError === null ? error : new AggregateError([gracefulError, error])
    });
  }
  if (await waitForConditionUntil(() => observation.current() !== null, terminationDeadlineNs, runtime)) {
    return observation.current();
  }
  throw new Error("npm ci Windows leader did not exit inside the termination envelope");
}

/**
 * Execute one npm-ci attempt under a fixed process deadline.
 *
 * @param {{signal?:AbortSignal,platform?:NodeJS.Platform,runtime?:object}} [options] - Testable runtime seams.
 * @returns {Promise<{ok:boolean,timedOut:boolean,code:number|null,signal:string|null,error:unknown}>} Attempt result.
 * @example
 * await runNpmCiAttempt();
 */
export async function runNpmCiAttempt(options = {}) {
  const platform = options.platform ?? process.platform;
  const runtime = {
    spawn: options.runtime?.spawn ?? spawn,
    spawnSync: options.runtime?.spawnSync ?? spawnSync,
    kill: options.runtime?.kill ?? process.kill,
    setTimeout: options.runtime?.setTimeout ?? setTimeout,
    clearTimeout: options.runtime?.clearTimeout ?? clearTimeout,
    nowNs: options.runtime?.nowNs ?? (() => process.hrtime.bigint()),
    processSpec: options.runtime?.processSpec ?? npmCiProcessSpec,
    taskkill:
      options.runtime?.taskkill ??
      ((pid, force, timeoutMs) => taskkillTree(pid, force, timeoutMs, options.runtime?.spawnSync ?? spawnSync))
  };
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("npm ci retry cancelled");

  const attemptDeadlineNs = deadlineAfter(runtime.nowNs, NPM_CI_RETRY_POLICY.attemptTimeoutMs);
  const spec = runtime.processSpec();
  let child;
  try {
    child = runtime.spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      detached: platform !== "win32",
      windowsHide: true,
      shell: false
    });
  } catch (error) {
    return { ok: false, timedOut: false, code: null, signal: null, error };
  }
  // Attach the async spawn-error listener before inspecting pid. On Windows and
  // POSIX, a failed spawn commonly returns a ChildProcess with pid=undefined and
  // emits `error` on a later turn; returning first would make that error fatal.
  const observation = observeAttemptExit(child, runtime.nowNs);
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return { ok: false, timedOut: false, code: null, signal: null, error: new Error("npm ci has no safe pid") };
  }

  const deadline = timer(remainingMs(attemptDeadlineNs, runtime.nowNs), runtime);
  const abort = abortEvent(options.signal);
  const first = await Promise.race([
    observation.promise.then((result) => ({ kind: "exit", result })),
    deadline.promise.then(() => ({ kind: "timeout" })),
    abort.promise.then((reason) => ({ kind: "abort", reason }))
  ]);
  deadline.cancel();
  abort.cancel();

  if (first.kind === "exit" && first.result.observedNs < attemptDeadlineNs && options.signal?.aborted) {
    const reason = options.signal.reason ?? new Error("npm ci retry cancelled");
    if (platform === "win32") {
      throw new Error("npm ci Windows leader exited before cancellation could actuate bounded taskkill cleanup", {
        cause: reason
      });
    }
    if (posixGroupExists(child.pid, runtime.kill)) {
      const cleanupDeadlineNs = deadlineAfter(runtime.nowNs, NPM_CI_RETRY_POLICY.killGraceMs);
      await terminateAttemptTree(
        child.pid,
        platform,
        runtime,
        observation,
        forwardedSignal(reason),
        cleanupDeadlineNs,
        options.signal
      );
    }
    throw reason;
  }

  if (first.kind === "exit" && first.result.observedNs < attemptDeadlineNs) {
    // POSIX retains a queryable process-group identity after its leader exits,
    // so prove the group is empty before retry. Windows taskkill cannot act on
    // a tree through an already-dead parent PID; ordinary npm exit is therefore
    // the narrow Windows retry boundary. Timeout below remains terminal even
    // after bounded taskkill actuation and leader observation.
    if (platform !== "win32" && posixGroupExists(child.pid, runtime.kill)) {
      const cleanupDeadlineNs = deadlineAfter(runtime.nowNs, NPM_CI_RETRY_POLICY.killGraceMs);
      await terminateAttemptTree(
        child.pid,
        platform,
        runtime,
        observation,
        "SIGTERM",
        cleanupDeadlineNs,
        options.signal
      );
      const cancellation = currentAbortReason(options.signal);
      if (cancellation !== null) throw cancellation;
      return {
        ok: false,
        timedOut: false,
        code: first.result.code,
        signal: first.result.signal,
        error:
          first.result.error ?? new Error("npm ci leader exited while descendants remained in its POSIX process group")
      };
    }
    return {
      ok: first.result.error === null && first.result.code === 0,
      timedOut: false,
      code: first.result.code,
      signal: first.result.signal,
      error: first.result.error
    };
  }

  const reason = first.kind === "abort" ? first.reason : currentAbortReason(options.signal);
  const terminationDeadlineNs =
    first.kind === "abort"
      ? deadlineAfter(runtime.nowNs, NPM_CI_RETRY_POLICY.killGraceMs)
      : attemptDeadlineNs + BigInt(NPM_CI_RETRY_POLICY.killGraceMs) * NS_PER_MS;
  const result = await terminateAttemptTree(
    child.pid,
    platform,
    runtime,
    observation,
    forwardedSignal(reason),
    terminationDeadlineNs,
    options.signal
  );
  const cancellation = first.kind === "abort" ? first.reason : currentAbortReason(options.signal);
  if (cancellation !== null) throw cancellation;
  if (first.kind === "timeout" && platform === "win32") {
    // taskkill /T observes only the process tree reachable from the leader at
    // invocation time. Even a successful forced call plus leader exit cannot
    // prove that a raced, reparented or breakaway descendant released every
    // workspace resource. A fresh hosted runner is the only safe retry scope.
    throw new Error(
      "npm ci Windows timeout is terminal because taskkill cannot prove all descendants and workspace resources are gone"
    );
  }
  return {
    ok: false,
    timedOut: true,
    code: result.code,
    signal: result.signal,
    error: result.error
  };
}

function waitForRetry(ms, signal, clock = { setTimeout, clearTimeout }) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("npm ci retry cancelled"));
  const delay = timer(ms, clock);
  const abort = abortEvent(signal);
  return Promise.race([delay.promise, abort.promise.then((reason) => Promise.reject(reason))]).finally(() => {
    delay.cancel();
    abort.cancel();
  });
}

/**
 * Run the fixed at-most-three-attempt npm-ci policy.
 *
 * @param {{signal?:AbortSignal,attemptRunner?:Function,wait?:Function,log?:Console}} [options] - Test seams.
 * @returns {Promise<number>} One-based successful attempt number.
 * @example
 * await runNpmCiWithRetry();
 */
export async function runNpmCiWithRetry(options = {}) {
  const attemptRunner = options.attemptRunner ?? runNpmCiAttempt;
  const wait = options.wait ?? waitForRetry;
  const log = options.log ?? console;
  let lastResult;

  for (let attempt = 1; attempt <= NPM_CI_RETRY_POLICY.attempts; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("npm ci retry cancelled");
    log.log(`npm ci attempt ${attempt}/${NPM_CI_RETRY_POLICY.attempts}`);
    lastResult = await attemptRunner({ signal: options.signal });
    // Cancellation is a permanent latch. If child exit and AbortSignal settle
    // in the same turn, never let an exit-zero observation resume the workflow.
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("npm ci retry cancelled");
    if (lastResult.ok) return attempt;
    if (attempt === NPM_CI_RETRY_POLICY.attempts) break;
    const reason = lastResult.timedOut ? "timed out" : "failed";
    log.warn(`npm ci attempt ${attempt} ${reason}; retrying in ${NPM_CI_RETRY_POLICY.retryDelayMs / 1000}s`);
    await wait(NPM_CI_RETRY_POLICY.retryDelayMs, options.signal);
  }

  const detail = lastResult?.timedOut
    ? "timed out"
    : lastResult?.error instanceof Error
      ? lastResult.error.message
      : `exit=${String(lastResult?.code)} signal=${String(lastResult?.signal)}`;
  throw new Error(`npm ci failed after ${NPM_CI_RETRY_POLICY.attempts} attempts (${detail})`);
}

async function main() {
  if (process.argv.length !== 2) throw new Error("usage: node scripts/npm-ci-with-retry.mjs");
  const controller = new AbortController();
  let signalExitCode = 1;
  const cancelForSignal = (signal, exitCode) => {
    if (controller.signal.aborted) return;
    signalExitCode = exitCode;
    const reason = new Error(`npm ci retry cancelled by ${signal}`);
    Object.defineProperty(reason, "forwardSignal", { value: signal, enumerable: true });
    controller.abort(reason);
  };
  const handlers = new Map([
    [
      "SIGINT",
      () => {
        cancelForSignal("SIGINT", 130);
      }
    ],
    [
      "SIGTERM",
      () => {
        cancelForSignal("SIGTERM", 143);
      }
    ]
  ]);
  // Keep both handlers installed until cleanup completes. Using `once` restores
  // Node's default termination after the first signal, so a repeated runner
  // signal could otherwise kill this controller before its child tree is gone.
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    await runNpmCiWithRetry({ signal: controller.signal });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = controller.signal.aborted ? signalExitCode : 1;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

if (isEntrypoint(import.meta.url)) await main();
