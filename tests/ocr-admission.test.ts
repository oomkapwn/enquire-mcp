import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OCR_TIMEOUT_MS,
  MAX_CONCURRENT_OCR_CALLS,
  MAX_QUEUED_OCR_CALLS,
  OcrAdmissionController,
  OcrBusyError,
  OcrCancelledError,
  OcrTimeoutError
} from "../src/ocr-admission.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before test deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function hasOcrSignalWiring(source: string): boolean {
  const start = source.indexOf('"obsidian_ocr_pdf"');
  if (start < 0) return false;
  const tail = source.slice(start, source.indexOf("\n  );", start) + 5);
  return /async \(args, extra\)/.test(tail) && /\{ signal: extra\.signal \}/.test(tail);
}

function ocrResourceClaimProblems(security: string): string[] {
  const expected = [
    `MAX_CONCURRENT_OCR_CALLS=${MAX_CONCURRENT_OCR_CALLS}`,
    `MAX_QUEUED_OCR_CALLS=${MAX_QUEUED_OCR_CALLS}`,
    `DEFAULT_OCR_TIMEOUT_MS=${DEFAULT_OCR_TIMEOUT_MS}`,
    "including queue wait",
    "concurrency lease is held until the underlying operation settles its cleanup"
  ];
  return expected.filter((claim) => !security.includes(claim));
}

describe("OcrAdmissionController (v3.12.0-rc.8)", () => {
  it("serializes OCR work in FIFO order at the production cap", async () => {
    const controller = new OcrAdmissionController(1);
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = controller.run(async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
      return 1;
    }, 1000);
    await waitFor(() => events.length === 1);

    const second = controller.run(async () => {
      events.push("second:start");
      return 2;
    }, 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first:start"]);

    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("NEGATIVE control: a two-slot controller really admits overlap", async () => {
    const controller = new OcrAdmissionController(2);
    const gate = deferred<void>();
    let active = 0;
    let peak = 0;
    const operation = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    };

    const first = controller.run(operation, 1000);
    const second = controller.run(operation, 1000);
    await waitFor(() => peak === 2);
    gate.resolve();
    await Promise.all([first, second]);
    expect(peak).toBe(2);
  });

  it("times out the caller but keeps the slot until aborted work finishes cleanup", async () => {
    const controller = new OcrAdmissionController(1);
    const cleanupGate = deferred<void>();
    const sawAbort = deferred<void>();

    const first = controller.run(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            sawAbort.resolve();
            void cleanupGate.promise.then(resolve);
          },
          { once: true }
        );
      });
    }, 25);
    await expect(first).rejects.toBeInstanceOf(OcrTimeoutError);
    await sawAbort.promise;

    let secondStarted = false;
    const second = controller.run(async () => {
      secondStarted = true;
    }, 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondStarted).toBe(false);

    cleanupGate.resolve();
    await second;
    expect(secondStarted).toBe(true);
  });

  it("removes an expired queued request without consuming the next slot", async () => {
    const controller = new OcrAdmissionController(1);
    const firstGate = deferred<void>();
    const first = controller.run(() => firstGate.promise, 1000);

    const expired = controller.run(async () => "should-not-run", 25);
    await expect(expired).rejects.toBeInstanceOf(OcrTimeoutError);

    let thirdStarted = false;
    const third = controller.run(async () => {
      thirdStarted = true;
      return "third";
    }, 1000);
    firstGate.resolve();

    await expect(first).resolves.toBeUndefined();
    await expect(third).resolves.toBe("third");
    expect(thirdStarted).toBe(true);
  });

  it("maps an external SDK abort to a stable cancellation error", async () => {
    const controller = new OcrAdmissionController(1);
    const external = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const result = controller.run(
      async (signal) => {
        operationSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      1000,
      external.signal
    );
    await waitFor(() => operationSignal !== undefined);

    external.abort(new Error("private SDK detail"));
    await expect(result).rejects.toEqual(new OcrCancelledError());
    expect(operationSignal?.aborted).toBe(true);
  });

  it("rejects invalid bounds and fails fast when the waiting queue is full", async () => {
    expect(() => new OcrAdmissionController(0)).toThrow(/positive integer/);
    expect(() => new OcrAdmissionController(1, -1)).toThrow(/non-negative integer/);
    const controller = new OcrAdmissionController(1);
    await expect(controller.run(async () => {}, Number.POSITIVE_INFINITY)).rejects.toThrow(/finite positive/);

    const gate = deferred<void>();
    const bounded = new OcrAdmissionController(1, 1);
    const active = bounded.run(() => gate.promise, 1000);
    const queued = bounded.run(async () => "queued", 1000);
    await expect(bounded.run(async () => "overflow", 1000)).rejects.toBeInstanceOf(OcrBusyError);
    gate.resolve();
    await expect(active).resolves.toBeUndefined();
    await expect(queued).resolves.toBe("queued");
  });
});

describe("OCR request cancellation wiring", () => {
  it("passes the MCP SDK signal into ocrPdf", async () => {
    const source = await fs.readFile(new URL("../src/tool-registry.ts", import.meta.url), "utf8");
    expect(hasOcrSignalWiring(source)).toBe(true);
    expect(source).toContain("DEFAULT_OCR_TIMEOUT_MS / 60_000");
    const security = await fs.readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
    expect(ocrResourceClaimProblems(security)).toEqual([]);
  });

  it("NEGATIVE control: detects a handler that drops the SDK signal", async () => {
    const source = await fs.readFile(new URL("../src/tool-registry.ts", import.meta.url), "utf8");
    const mutated = source.replace(", { signal: extra.signal }", "");
    expect(hasOcrSignalWiring(mutated)).toBe(false);
    const security = await fs.readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
    expect(
      ocrResourceClaimProblems(security.replace("DEFAULT_OCR_TIMEOUT_MS=600000", "DEFAULT_OCR_TIMEOUT_MS=1"))
    ).toEqual(["DEFAULT_OCR_TIMEOUT_MS=600000"]);
  });
});

describe("extractPdfWithOcr resource cancellation", () => {
  afterEach(() => {
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
    vi.doUnmock("@napi-rs/canvas");
    vi.doUnmock("tesseract.js");
    vi.resetModules();
  });

  it("cancels render and awaits worker/PDF cleanup on timeout", async () => {
    const langPath = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ocr-timeout-"));
    await fs.writeFile(path.join(langPath, "eng.traineddata"), "fake");
    let rejectRender!: (reason: unknown) => void;
    const renderPromise = new Promise<void>((_resolve, reject) => {
      rejectRender = reject;
    });
    const renderCancel = vi.fn(() => rejectRender(new Error("render cancelled")));
    const pageCleanup = vi.fn();
    const docCleanup = vi.fn(async () => {});
    const loadingDestroy = vi.fn(async () => {});
    const workerTerminate = vi.fn(async () => {});

    vi.resetModules();
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 100 * scale }),
            render: () => ({ promise: renderPromise, cancel: renderCancel }),
            cleanup: pageCleanup
          }),
          cleanup: docCleanup
        }),
        destroy: loadingDestroy
      })
    }));
    vi.doMock("@napi-rs/canvas", () => ({
      createCanvas: (width: number, height: number) => ({
        width,
        height,
        getContext: () => ({ fillStyle: "", fillRect: () => {} }),
        encode: async () => Buffer.from("png")
      })
    }));
    vi.doMock("tesseract.js", () => ({
      createWorker: async () => ({
        recognize: async () => ({ data: { text: "unreachable", confidence: 99 } }),
        terminate: workerTerminate
      })
    }));

    try {
      const { extractPdfWithOcr } = await import("../src/ocr.js");
      await expect(
        extractPdfWithOcr(Buffer.from("fake-pdf"), {
          langPath,
          langs: "eng",
          timeoutMs: 25
        })
      ).rejects.toMatchObject({ name: "OcrTimeoutError", message: expect.stringMatching(/timed out/) });

      expect(renderCancel).toHaveBeenCalledTimes(1);
      expect(pageCleanup).toHaveBeenCalledTimes(1);
      expect(workerTerminate).toHaveBeenCalledTimes(1);
      expect(docCleanup).toHaveBeenCalledTimes(1);
      expect(loadingDestroy).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(langPath, { recursive: true, force: true });
    }
  });

  it("destroys a pdfjs loading task when document acquisition rejects", async () => {
    const langPath = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ocr-load-fail-"));
    await fs.writeFile(path.join(langPath, "eng.traineddata"), "fake");
    const loadingDestroy = vi.fn(async () => {});
    const createWorker = vi.fn(async () => ({
      recognize: async () => ({ data: { text: "", confidence: 0 } }),
      terminate: async () => {}
    }));

    vi.resetModules();
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      getDocument: () => ({
        promise: Promise.reject(new Error("invalid PDF fixture")),
        destroy: loadingDestroy
      })
    }));
    vi.doMock("@napi-rs/canvas", () => ({
      createCanvas: () => {
        throw new Error("canvas must not be reached");
      }
    }));
    vi.doMock("tesseract.js", () => ({ createWorker }));

    try {
      const { extractPdfWithOcr } = await import("../src/ocr.js");
      await expect(
        extractPdfWithOcr(Buffer.from("invalid"), {
          langPath,
          langs: "eng",
          timeoutMs: 1000
        })
      ).rejects.toThrow(/invalid PDF fixture/);
      expect(loadingDestroy).toHaveBeenCalledTimes(1);
      expect(createWorker).not.toHaveBeenCalled();
    } finally {
      await fs.rm(langPath, { recursive: true, force: true });
    }
  });

  it("NEGATIVE control: successful OCR cleans resources without cancelling render", async () => {
    const langPath = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-ocr-success-"));
    await fs.writeFile(path.join(langPath, "eng.traineddata"), "fake");
    const renderCancel = vi.fn();
    const pageCleanup = vi.fn(() => {
      throw new Error("page cleanup failure must not corrupt the OCR result");
    });
    const docCleanup = vi.fn(async () => {});
    const loadingDestroy = vi.fn(async () => {});
    const workerTerminate = vi.fn(async () => {});

    vi.resetModules();
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 100 * scale }),
            render: () => ({ promise: Promise.resolve(), cancel: renderCancel }),
            cleanup: pageCleanup
          }),
          cleanup: docCleanup
        }),
        destroy: loadingDestroy
      })
    }));
    vi.doMock("@napi-rs/canvas", () => ({
      createCanvas: (width: number, height: number) => ({
        width,
        height,
        getContext: () => ({ fillStyle: "", fillRect: () => {} }),
        encode: async () => Buffer.from("png")
      })
    }));
    vi.doMock("tesseract.js", () => ({
      createWorker: async () => ({
        recognize: async () => ({ data: { text: " readable scan ", confidence: 88 } }),
        terminate: workerTerminate
      })
    }));

    try {
      const { extractPdfWithOcr } = await import("../src/ocr.js");
      const result = await extractPdfWithOcr(Buffer.from("fake-pdf"), {
        langPath,
        langs: "eng",
        timeoutMs: 1000
      });

      expect(result.fullText).toBe("readable scan");
      expect(result.meanConfidence).toBe(88);
      expect(result.pages).toHaveLength(1);
      expect(renderCancel).not.toHaveBeenCalled();
      expect(pageCleanup).toHaveBeenCalledTimes(1);
      expect(workerTerminate).toHaveBeenCalledTimes(1);
      expect(docCleanup).toHaveBeenCalledTimes(1);
      expect(loadingDestroy).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(langPath, { recursive: true, force: true });
    }
  });
});
