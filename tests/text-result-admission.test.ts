import { afterEach, describe, expect, it, vi } from "vitest";
import { admitTextResultPayload, type TextResultAdmissionLimits, textResult } from "../src/mcp-result.js";

const GENEROUS_LIMITS: TextResultAdmissionLimits = {
  maxUtf8Bytes: 1_000_000,
  maxNodes: 1_000,
  maxDepth: 32
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("text-result pre-serialization admission", () => {
  it("preserves the exact established pretty JSON for ordinary payloads", () => {
    const payload = {
      title: "line\nПривет",
      count: -0,
      ok: true,
      nested: [null, { slash: "\\" }]
    };
    const expected = JSON.stringify(payload, null, 2);

    const measured = admitTextResultPayload(payload);
    const result = textResult(payload);

    expect(result.content[0]?.text).toBe(expected);
    expect(measured).toEqual({
      utf8Bytes: Buffer.byteLength(expected, "utf8"),
      nodes: 8,
      maxDepth: 4
    });
  });

  it("accepts repeated aliases and distinct-equal objects while charging every occurrence", () => {
    const shared = { value: "same" };
    const aliased = { left: shared, right: shared };
    const distinct = { left: { value: "same" }, right: { value: "same" } };

    expect(admitTextResultPayload(aliased, GENEROUS_LIMITS).nodes).toBe(5);
    expect(admitTextResultPayload(distinct, GENEROUS_LIMITS).nodes).toBe(5);
    expect(textResult(aliased).content[0]?.text).toBe(JSON.stringify(distinct, null, 2));
  });

  it("rejects a self-cycle but does not confuse an acyclic alias with a cycle", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => admitTextResultPayload(cyclic, GENEROUS_LIMITS)).toThrow(/cycle/i);

    const shared = { ok: true };
    expect(() => admitTextResultPayload([shared, shared], GENEROUS_LIMITS)).not.toThrow();
  });

  it("charges a repeated subtree at the node boundary and rejects occurrence cap + 1", () => {
    const shared = {};
    const limits = { ...GENEROUS_LIMITS, maxNodes: 4 };

    expect(admitTextResultPayload([shared, shared, shared], limits).nodes).toBe(4);
    expect(() => admitTextResultPayload([shared, shared, shared, shared], limits)).toThrow(
      /exceeds 4 serialized nodes/
    );
  });

  it("admits exact depth/node boundaries and rejects one below each", () => {
    const payload = { outer: { leaf: true } };

    expect(admitTextResultPayload(payload, { ...GENEROUS_LIMITS, maxNodes: 3, maxDepth: 3 })).toMatchObject({
      nodes: 3,
      maxDepth: 3
    });
    expect(() => admitTextResultPayload(payload, { ...GENEROUS_LIMITS, maxNodes: 2 })).toThrow(
      /exceeds 2 serialized nodes/
    );
    expect(() => admitTextResultPayload(payload, { ...GENEROUS_LIMITS, maxDepth: 2 })).toThrow(/exceeds depth 2/);
  });

  it("meters the exact UTF-8 boundary, including escaping and indentation", () => {
    const payload = { escaped: '\u0000\n"\\', unicode: "é🧸" };
    const exactBytes = Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8");

    expect(admitTextResultPayload(payload, { ...GENEROUS_LIMITS, maxUtf8Bytes: exactBytes }).utf8Bytes).toBe(
      exactBytes
    );
    expect(() => admitTextResultPayload(payload, { ...GENEROUS_LIMITS, maxUtf8Bytes: exactBytes - 1 })).toThrow(
      /UTF-8 bytes/
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite number %s", (value) => {
    expect(() => admitTextResultPayload({ value }, GENEROUS_LIMITS)).toThrow(/non-finite/i);
  });

  it("rejects exotic objects and accessors before general serialization", () => {
    expect(() => textResult({ omittedByNativeJson: undefined })).toThrow(/unsupported undefined/i);
    expect(() => admitTextResultPayload({ value: new Date(0) }, GENEROUS_LIMITS)).toThrow(/exotic object/i);
    expect(() => admitTextResultPayload(new Proxy({ ok: true }, {}), GENEROUS_LIMITS)).toThrow(/proxy/i);

    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "hidden"
    });
    expect(() => admitTextResultPayload(accessor, GENEROUS_LIMITS)).toThrow(/accessor/i);

    const customized = Object.defineProperty({}, "toJSON", {
      value: () => ({ hidden: true }),
      enumerable: false
    });
    expect(() => admitTextResultPayload(customized, GENEROUS_LIMITS)).toThrow(/custom toJSON/i);
  });

  it("preflights repeated scalar aliases without calling JSON.stringify", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const shared = { value: "same" };

    admitTextResultPayload([shared, shared, shared], GENEROUS_LIMITS);

    expect(stringify).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["all controls", Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join("")],
    ["quote and reverse solidus", '"\\'],
    ["BMP boundaries", "\u007f\u0080\u07ff\u0800\u2028\u2029\uffff"],
    ["astral pairs", "\ud800\udc00🧸\udbff\udfff"],
    ["lone high surrogates", "\ud800x\udbff"],
    ["lone low surrogates", "\udc00x\udfff"],
    ["misordered surrogates", "\udc00\ud800"]
  ])("matches JSON.stringify UTF-8 bytes for %s", (_label, value) => {
    const expected = JSON.stringify(value);
    expect(admitTextResultPayload(value, GENEROUS_LIMITS).utf8Bytes).toBe(Buffer.byteLength(expected, "utf8"));

    const keyed = { [`key:${value}`]: value };
    const expectedKeyed = JSON.stringify(keyed, null, 2);
    expect(admitTextResultPayload(keyed, GENEROUS_LIMITS).utf8Bytes).toBe(Buffer.byteLength(expectedKeyed, "utf8"));
  });

  it("rejects an oversized scalar before preflight calls JSON.stringify", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const payload = "\u0000".repeat(64);

    expect(() => admitTextResultPayload(payload, { ...GENEROUS_LIMITS, maxUtf8Bytes: 1 })).toThrow(/UTF-8 bytes/);
    expect(stringify).not.toHaveBeenCalled();
  });

  it("never calls JSON.stringify(payload) after preflight failure, with a passing control", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const rejectedPayload = { value: Number.POSITIVE_INFINITY };
    const acceptedPayload = { value: 1 };

    expect(() => textResult(rejectedPayload)).toThrow(/non-finite/i);
    expect(stringify.mock.calls.some(([value]) => value === rejectedPayload)).toBe(false);

    expect(() => textResult(acceptedPayload)).not.toThrow();
    expect(stringify.mock.calls.some(([value]) => value === acceptedPayload)).toBe(true);
  });
});
