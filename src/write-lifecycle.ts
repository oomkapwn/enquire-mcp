/**
 * Cancellation mode for a write request tracked by {@link WriteRequestTracker}.
 *
 * `rollback` operations promise to restore every committed effect when their
 * signal aborts. `finish` operations are atomic/single-effect writes that must
 * be allowed to finish rather than being cut off after an HTTP drain timeout.
 */
export type WriteCancellationMode = "rollback" | "finish";

/**
 * Error thrown when a write operation observes a cancelled request.
 */
export class WriteRequestAbortedError extends Error {
  /**
   * Build a stable, client-safe cancellation error.
   *
   * @param message - Human-readable cancellation reason.
   * @param cause - Optional lower-level abort reason.
   */
  constructor(message: string = "Write request cancelled", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WriteRequestAbortedError";
  }
}

/**
 * Throw a stable cancellation error when `signal` is already aborted.
 *
 * @param signal - Optional request cancellation signal.
 * @throws {WriteRequestAbortedError} When the request was cancelled.
 */
export function throwIfWriteAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new WriteRequestAbortedError("Write request cancelled", signal.reason);
}

interface ActiveWrite {
  controller: AbortController;
  done: Promise<void>;
  mode: WriteCancellationMode;
}

/**
 * Per-MCP-session registry of active persistent mutations.
 *
 * The HTTP lifecycle uses this registry after its ordinary request-drain
 * deadline. Rollback-capable batch mutations receive an explicit abort and are
 * awaited through their rollback. Atomic/single-effect writes are reported as
 * `finish` operations so DELETE can return retryable `409 session busy` rather
 * than closing their response channel mid-effect.
 */
export class WriteRequestTracker {
  private readonly active = new Set<ActiveWrite>();
  private admissionClosedReason: WriteRequestAbortedError | undefined;
  private rollbackAdmissionAbortReason: WriteRequestAbortedError | undefined;

  /**
   * Number of write callbacks that have entered the session registry and have
   * not settled yet, including callbacks waiting for the shared vault lane.
   *
   * @returns Current active write count.
   */
  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Whether at least one active mutation must finish instead of being aborted.
   *
   * @returns True when a `finish` operation is active.
   */
  get hasFinishOnly(): boolean {
    for (const item of this.active) {
      if (item.mode === "finish") return true;
    }
    return false;
  }

  /**
   * Track one write callback and compose SDK cancellation with a lifecycle
   * controller owned by the stateful HTTP session.
   *
   * @param requestId - JSON-RPC request id, reserved for lifecycle diagnostics.
   * @param sdkSignal - Cancellation signal supplied by the MCP SDK.
   * @param mode - Whether cancellation rolls back or the effect must finish.
   * @param operation - Write callback receiving the composed signal.
   * @returns The callback result.
   */
  async run<T>(
    requestId: unknown,
    sdkSignal: AbortSignal,
    mode: WriteCancellationMode,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    void requestId;
    if (this.admissionClosedReason) {
      throw new WriteRequestAbortedError("Write request cancelled before mutation", this.admissionClosedReason);
    }
    if (mode === "rollback" && this.rollbackAdmissionAbortReason) {
      throw new WriteRequestAbortedError("Write request cancelled before mutation", this.rollbackAdmissionAbortReason);
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([sdkSignal, controller.signal]);
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const item: ActiveWrite = { controller, done, mode };
    this.active.add(item);
    try {
      throwIfWriteAborted(signal);
      return await operation(signal);
    } finally {
      this.active.delete(item);
      resolveDone?.();
    }
  }

  /**
   * Abort rollback-capable writes present at call time and wait until each has
   * restored its effects or surfaced a rollback failure. Also latches the
   * cancellation so an already-accepted HTTP request whose callback dispatches
   * late is rejected before its first effect.
   *
   * `finish` operations are deliberately left alone. The caller must keep the
   * transport alive (DELETE returns 409) or await them during process shutdown.
   *
   * @param reason - Stable reason exposed through the composed signal.
   * @returns Counts observed after rollback-capable operations settle.
   */
  async abortRollbackSafe(
    reason: string = "Stateful session deletion exceeded the request-drain deadline"
  ): Promise<{ aborted: number; remaining: number; finishOnly: number }> {
    this.rollbackAdmissionAbortReason = new WriteRequestAbortedError(reason);
    const rollbackItems = [...this.active].filter((item) => item.mode === "rollback");
    for (const item of rollbackItems) {
      item.controller.abort(this.rollbackAdmissionAbortReason);
    }
    await Promise.allSettled(rollbackItems.map((item) => item.done));
    let finishOnly = 0;
    for (const item of this.active) {
      if (item.mode === "finish") finishOnly += 1;
    }
    return { aborted: rollbackItems.length, remaining: this.active.size, finishOnly };
  }

  /**
   * Re-open rollback-capable admission after every write HTTP request present
   * at the DELETE deadline has delivered its response.
   *
   * @returns Nothing.
   */
  clearRollbackAbort(): void {
    this.rollbackAdmissionAbortReason = undefined;
  }

  /**
   * Terminally reject callbacks that have not entered before process shutdown.
   *
   * Active finish-only writes still complete; active rollback-safe writes are
   * cancelled separately by {@link abortRollbackSafe}.
   *
   * @param reason - Stable shutdown reason for late callbacks.
   * @returns Nothing.
   */
  closeAdmission(reason: string = "Server shutdown closed persistent-write admission"): void {
    this.admissionClosedReason = new WriteRequestAbortedError(reason);
  }

  /**
   * Wait for every write currently registered, including writes that were
   * queued before session shutdown closed admission.
   *
   * @returns When the registry becomes empty.
   */
  async waitForAll(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active].map((item) => item.done));
    }
  }
}

const writeLanes = new WeakMap<object, Promise<void>>();

/**
 * Serialize MCP write callbacks that share one persistence owner.
 *
 * Rollback must never clobber a later write from another session. The HTTP
 * server shares one `Vault` (and one feedback store) across its per-session
 * MCP servers, so a process-wide weak-keyed lane provides the required order
 * without retaining those owners after shutdown. A queued request checks its
 * signal only after the prior owner releases the lane and therefore cannot
 * begin mutating after it was cancelled.
 *
 * @param owner - Shared persistence owner (`Vault` or `FeedbackStore`).
 * @param signal - Composed request cancellation signal.
 * @param operation - Mutation to run exclusively.
 * @returns The mutation result.
 */
export async function runSerializedWrite<T>(
  owner: object,
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  const previous = writeLanes.get(owner) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  writeLanes.set(owner, tail);

  await previous.catch(() => {});
  try {
    throwIfWriteAborted(signal);
    return await operation();
  } finally {
    release?.();
    if (writeLanes.get(owner) === tail) writeLanes.delete(owner);
  }
}
