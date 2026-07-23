import { describe, expect, it } from "vitest";
import { runSerializedWrite, WriteRequestAbortedError, WriteRequestTracker } from "../src/write-lifecycle.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

describe("WriteRequestTracker", () => {
  it("aborts and drains rollback-capable mutations after the ordinary request deadline", async () => {
    const tracker = new WriteRequestTracker();
    const sdk = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const operation = tracker
      .run(7, sdk.signal, "rollback", async (signal) => {
        observedSignal = signal;
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    await Promise.resolve();
    expect(tracker.activeCount).toBe(1);
    const result = await tracker.abortRollbackSafe("deadline");
    expect(result).toEqual({ aborted: 1, remaining: 0, finishOnly: 0 });
    expect(observedSignal?.aborted).toBe(true);
    expect(await operation).toBeInstanceOf(WriteRequestAbortedError);

    // A rollback callback accepted by HTTP but dispatched only after the
    // deadline must be rejected before its first effect, not missed because it
    // was absent from the active set at abort time.
    let lateMutationRan = false;
    await expect(
      tracker.run(9, sdk.signal, "rollback", async () => {
        lateMutationRan = true;
      })
    ).rejects.toBeInstanceOf(WriteRequestAbortedError);
    expect(lateMutationRan).toBe(false);
    tracker.clearRollbackAbort();
    await tracker.run(10, new AbortController().signal, "rollback", async () => {
      lateMutationRan = true;
    });
    expect(lateMutationRan).toBe(true);
  });

  it("(negative-control) never aborts a finish-only atomic mutation", async () => {
    const tracker = new WriteRequestTracker();
    const gate = deferred();
    let observedSignal: AbortSignal | undefined;
    const operation = tracker.run(8, new AbortController().signal, "finish", async (signal) => {
      observedSignal = signal;
      await gate.promise;
      return "committed";
    });

    await Promise.resolve();
    const result = await tracker.abortRollbackSafe("deadline");
    expect(result).toEqual({ aborted: 0, remaining: 1, finishOnly: 1 });
    expect(observedSignal?.aborted).toBe(false);
    gate.resolve();
    expect(await operation).toBe("committed");
    expect(tracker.activeCount).toBe(0);

    tracker.closeAdmission("shutdown");
    let lateFinishRan = false;
    await expect(
      tracker.run(11, new AbortController().signal, "finish", async () => {
        lateFinishRan = true;
      })
    ).rejects.toBeInstanceOf(WriteRequestAbortedError);
    expect(lateFinishRan).toBe(false);
  });
});

describe("runSerializedWrite", () => {
  it("serializes two sessions sharing one persistence owner and rejects a cancelled waiter before mutation", async () => {
    const owner = {};
    const firstGate = deferred();
    const firstStarted = deferred();
    const order: string[] = [];
    const first = runSerializedWrite(owner, new AbortController().signal, async () => {
      order.push("first:start");
      firstStarted.resolve();
      await firstGate.promise;
      order.push("first:end");
    });
    await firstStarted.promise;

    const secondAbort = new AbortController();
    const second = runSerializedWrite(owner, secondAbort.signal, async () => {
      order.push("second:mutated");
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    secondAbort.abort(new Error("cancel queued write"));
    firstGate.resolve();

    await first;
    expect(await second).toBeInstanceOf(WriteRequestAbortedError);
    expect(order).toEqual(["first:start", "first:end"]);
  });

  it("(negative-control) distinct persistence owners do not share a lane", async () => {
    const firstGate = deferred();
    const secondStarted = deferred();
    const first = runSerializedWrite({}, new AbortController().signal, async () => {
      await firstGate.promise;
    });
    const second = runSerializedWrite({}, new AbortController().signal, async () => {
      secondStarted.resolve();
    });

    await secondStarted.promise;
    firstGate.resolve();
    await Promise.all([first, second]);
  });
});
