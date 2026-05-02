import { describe, expect, it } from "vitest";
import { parsePositiveInt } from "../src/index.js";

describe("parsePositiveInt — CLI numeric flag validation (audit P2-2)", () => {
  it("accepts a positive integer string", () => {
    expect(parsePositiveInt("100", "--max-file-bytes")).toBe(100);
  });

  it("accepts a large integer", () => {
    expect(parsePositiveInt("5242880", "--max-file-bytes")).toBe(5242880);
  });

  it("rejects NaN literal", () => {
    expect(() => parsePositiveInt("NaN", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects Infinity literal", () => {
    expect(() => parsePositiveInt("Infinity", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects -Infinity literal", () => {
    expect(() => parsePositiveInt("-Infinity", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects non-numeric strings", () => {
    expect(() => parsePositiveInt("abc", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects empty string", () => {
    expect(() => parsePositiveInt("", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects zero", () => {
    expect(() => parsePositiveInt("0", "--cache-size")).toThrow(/positive integer/);
  });

  it("rejects negative", () => {
    expect(() => parsePositiveInt("-1", "--cache-size")).toThrow(/positive integer/);
  });

  it("rejects non-integer floats", () => {
    expect(() => parsePositiveInt("1.5", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("includes the flag name in the error", () => {
    expect(() => parsePositiveInt("oops", "--cache-size")).toThrow(/--cache-size/);
  });
});
