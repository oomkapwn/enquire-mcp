/**
 * Default wall-clock budget for one OCR request, including time spent waiting
 * for the shared OCR slot. The existing 200-page cap is documented as taking
 * roughly 5-10 minutes on an M1 CPU, so ten minutes preserves that supported
 * envelope while bounding malformed or stalled work.
 */
export const DEFAULT_OCR_TIMEOUT_MS = 10 * 60_000;

/**
 * Process-wide cap for expensive OCR pipelines. One active pipeline can hold
 * roughly 100 MiB for a maximum-size RGBA canvas before PNG and Tesseract
 * buffers, so serial admission is the safe cross-platform default.
 */
export const MAX_CONCURRENT_OCR_CALLS = 1;

/**
 * Maximum calls waiting behind the active OCR pipeline. Each queued library
 * call retains its PDF buffer, so the queue itself must be bounded as well as
 * active workers.
 */
export const MAX_QUEUED_OCR_CALLS = 4;

/** Stable error returned when an OCR call exceeds its wall-clock budget. */
export class OcrTimeoutError extends Error {
  /**
   * Create a timeout error without exposing lower-level worker state.
   *
   * @param timeoutMs - Configured wall-clock budget in milliseconds.
   */
  constructor(timeoutMs: number) {
    super(`enquire OCR: timed out after ${timeoutMs}ms; retry with a narrower page range`);
    this.name = "OcrTimeoutError";
  }
}

/** Stable error returned when the MCP client cancels an OCR request. */
export class OcrCancelledError extends Error {
  /** Create a client-safe cancellation error. */
  constructor() {
    super("enquire OCR: request cancelled");
    this.name = "OcrCancelledError";
  }
}

/** Stable fail-fast error returned when the bounded OCR queue is full. */
export class OcrBusyError extends Error {
  /**
   * Create an overload error with a retry hint.
   *
   * @param maxQueued - Configured waiting-call cap.
   */
  constructor(maxQueued: number) {
    super(`enquire OCR: busy (${maxQueued} requests already queued); retry later`);
    this.name = "OcrBusyError";
  }
}

interface AdmissionWaiter {
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

/**
 * Throw the stable OCR cancellation/timeout reason carried by `signal`.
 *
 * @param signal - Composed OCR request signal.
 * @throws {OcrTimeoutError} When the request budget expired.
 * @throws {OcrCancelledError} When the client cancelled the request.
 */
export function throwIfOcrAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof OcrTimeoutError || reason instanceof OcrCancelledError) throw reason;
  throw new OcrCancelledError();
}

/**
 * FIFO admission controller for expensive OCR pipelines.
 *
 * A timed-out/cancelled caller is rejected immediately, but an already-started
 * operation keeps its slot until its promise settles. This is deliberate: a
 * JavaScript timeout cannot prove that native/WASM work stopped, so releasing
 * early could admit a second worker and silently violate the concurrency cap.
 * The operation receives a composed signal and is responsible for cancelling
 * active render/worker resources before it settles.
 */
export class OcrAdmissionController {
  private active = 0;
  private readonly waiters: AdmissionWaiter[] = [];

  /**
   * Create an admission controller.
   *
   * @param maxConcurrent - Maximum simultaneously unsettled OCR operations.
   * @param maxQueued - Maximum waiting operations before fail-fast overload.
   */
  constructor(
    private readonly maxConcurrent: number = MAX_CONCURRENT_OCR_CALLS,
    private readonly maxQueued: number = MAX_QUEUED_OCR_CALLS
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("OCR maxConcurrent must be a positive integer");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("OCR maxQueued must be a non-negative integer");
    }
  }

  /**
   * Run one operation under FIFO concurrency and wall-clock limits.
   *
   * The timeout includes queue wait. A queued request that expires is removed
   * without consuming a slot. Once admitted, the slot remains leased through
   * operation cleanup even if the caller has already received a timeout.
   *
   * @param operation - OCR operation receiving the composed cancellation signal.
   * @param timeoutMs - Finite positive wall-clock budget in milliseconds.
   * @param externalSignal - Optional MCP/request cancellation signal.
   * @returns The operation result.
   */
  async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number = DEFAULT_OCR_TIMEOUT_MS,
    externalSignal?: AbortSignal
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("OCR timeoutMs must be a finite positive number");
    }

    const controller = new AbortController();
    const forwardCancellation = (): void => {
      if (!controller.signal.aborted) controller.abort(new OcrCancelledError());
    };
    if (externalSignal?.aborted) {
      forwardCancellation();
    } else {
      externalSignal?.addEventListener("abort", forwardCancellation, { once: true });
    }

    const timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new OcrTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref();

    try {
      await this.acquire(controller.signal);
      const operationPromise = Promise.resolve()
        .then(() => {
          throwIfOcrAborted(controller.signal);
          return operation(controller.signal);
        })
        .finally(() => {
          this.release();
        });

      return await this.observe(operationPromise, controller.signal);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", forwardCancellation);
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    throwIfOcrAborted(signal);
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueued) throw new OcrBusyError(this.maxQueued);

    return new Promise<void>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(this.abortReason(signal));
        }
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private release(): void {
    this.active -= 1;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(this.abortReason(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve();
      break;
    }
  }

  private observe<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(this.abortReason(signal));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      operation.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  private abortReason(signal: AbortSignal): OcrTimeoutError | OcrCancelledError {
    const reason = signal.reason;
    return reason instanceof OcrTimeoutError || reason instanceof OcrCancelledError ? reason : new OcrCancelledError();
  }
}
