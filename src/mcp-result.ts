import { types as utilTypes } from "node:util";

/**
 * Resource envelope applied before an MCP tool result is serialized.
 *
 * The 40 MiB byte ceiling is eight times the default 5 MiB note-read limit.
 * That admits the worst JSON string expansion of a default-size note (an ASCII
 * control byte can become a six-byte `\\u00xx` escape, or about 30 MiB total)
 * with room for the result envelope and pretty-print whitespace. The node and
 * depth ceilings independently bound highly fragmented or deeply nested
 * payloads whose byte representation is otherwise small.
 */
export const TEXT_RESULT_ADMISSION_LIMITS = Object.freeze({
  maxUtf8Bytes: 40 * 1024 * 1024,
  maxNodes: 250_000,
  maxDepth: 128
});

/** Limits accepted by {@link admitTextResultPayload}. */
export interface TextResultAdmissionLimits {
  /** Maximum UTF-8 bytes in the exact two-space-indented JSON representation. */
  maxUtf8Bytes: number;
  /** Maximum serialized value occurrences; repeated object aliases count repeatedly. */
  maxNodes: number;
  /** Maximum serialized value depth, where the root value has depth 1. */
  maxDepth: number;
}

/** Successful pre-serialization measurement returned by {@link admitTextResultPayload}. */
export interface TextResultAdmissionMeasurement {
  /** Exact UTF-8 bytes that `JSON.stringify(payload, null, 2)` will emit. */
  utf8Bytes: number;
  /** Number of serialized value occurrences, including the root. */
  nodes: number;
  /** Deepest serialized value occurrence, with the root at depth 1. */
  maxDepth: number;
}

/**
 * Validate and exactly meter a value before MCP result serialization.
 *
 * Only data with stable native JSON semantics is admitted: `null`, booleans,
 * finite numbers, strings, dense ordinary arrays, and plain objects (including
 * null-prototype objects) whose enumerable properties are data properties.
 * Cycles, accessors, sparse arrays, symbols, non-JSON primitives, and exotic
 * object instances fail closed. Aliased acyclic objects are deliberately
 * traversed and charged once per occurrence rather than once per identity.
 * Scalar encoded lengths are memoized so a repeated string is measured without
 * repeatedly allocating its escaped representation.
 *
 * @param payload - Candidate MCP result payload.
 * @param limits - Resource envelope; defaults to {@link TEXT_RESULT_ADMISSION_LIMITS}.
 * @returns Exact pretty-JSON byte size plus occurrence/depth measurements.
 * @throws If the payload is unsupported, cyclic, or exceeds any resource limit.
 */
export function admitTextResultPayload(
  payload: unknown,
  limits: TextResultAdmissionLimits = TEXT_RESULT_ADMISSION_LIMITS
): TextResultAdmissionMeasurement {
  const { maxUtf8Bytes, maxNodes, maxDepth } = limits;
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0) {
    throw new TypeError("text-result maxUtf8Bytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new TypeError("text-result maxNodes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new TypeError("text-result maxDepth must be a positive safe integer");
  }

  let utf8Bytes = 0;
  let nodes = 0;
  let deepest = 0;
  const active = new WeakSet<object>();
  const stringByteLengths = new Map<string, number>();
  const numberByteLengths = new Map<number, number>();

  const addBytes = (additional: number): void => {
    if (!Number.isSafeInteger(additional) || additional < 0 || additional > maxUtf8Bytes - utf8Bytes) {
      throw new Error(`MCP text result exceeds ${maxUtf8Bytes} UTF-8 bytes`);
    }
    utf8Bytes += additional;
  };

  const encodedStringBytes = (value: string): number => {
    const cached = stringByteLengths.get(value);
    if (cached !== undefined) return cached;
    const remaining = maxUtf8Bytes - utf8Bytes;
    // JSON quotes are always emitted, even for an empty string.
    let bytes = 2;
    if (bytes > remaining) throw new Error(`MCP text result exceeds ${maxUtf8Bytes} UTF-8 bytes`);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      let additional: number;
      if (
        code === 0x22 || // quotation mark -> \"
        code === 0x5c || // reverse solidus -> \\
        code === 0x08 || // backspace -> \b
        code === 0x09 || // tab -> \t
        code === 0x0a || // line feed -> \n
        code === 0x0c || // form feed -> \f
        code === 0x0d // carriage return -> \r
      ) {
        additional = 2;
      } else if (code <= 0x1f) {
        additional = 6; // Remaining controls use \u00xx.
      } else if (code <= 0x7f) {
        additional = 1;
      } else if (code <= 0x7ff) {
        additional = 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          additional = 4;
          index += 1;
        } else {
          additional = 6; // Well-formed JSON escapes a lone high surrogate.
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        additional = 6; // Well-formed JSON escapes a lone low surrogate.
      } else {
        additional = 3;
      }
      if (additional > remaining - bytes) {
        throw new Error(`MCP text result exceeds ${maxUtf8Bytes} UTF-8 bytes`);
      }
      bytes += additional;
    }
    stringByteLengths.set(value, bytes);
    return bytes;
  };

  const encodedNumberBytes = (value: number): number => {
    const cached = numberByteLengths.get(value);
    if (cached !== undefined) return cached;
    // For finite primitives, JSON's Number serialization is the canonical
    // Number-to-string form (`-0` included). Its representation is tiny and ASCII.
    const bytes = String(value).length;
    numberByteLengths.set(value, bytes);
    return bytes;
  };

  const enterNode = (depth: number): void => {
    if (depth > maxDepth) throw new Error(`MCP text result exceeds depth ${maxDepth}`);
    if (nodes >= maxNodes) throw new Error(`MCP text result exceeds ${maxNodes} serialized nodes`);
    nodes += 1;
    if (depth > deepest) deepest = depth;
  };

  const visit = (value: unknown, depth: number): void => {
    enterNode(depth);
    if (value === null) {
      addBytes(4);
      return;
    }

    switch (typeof value) {
      case "string":
        addBytes(encodedStringBytes(value));
        return;
      case "boolean":
        addBytes(value ? 4 : 5);
        return;
      case "number":
        if (!Number.isFinite(value)) throw new Error("MCP text result contains a non-finite number");
        addBytes(encodedNumberBytes(value));
        return;
      case "undefined":
      case "bigint":
      case "symbol":
      case "function":
        throw new Error(`MCP text result contains unsupported ${typeof value}`);
      case "object":
        break;
    }

    if (active.has(value)) throw new Error("MCP text result contains a cycle");
    if (utilTypes.isProxy(value)) throw new Error("MCP text result contains an exotic proxy");
    const toJsonDescriptor = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (toJsonDescriptor && (!("value" in toJsonDescriptor) || typeof toJsonDescriptor.value === "function")) {
      throw new Error("MCP text result contains custom toJSON behavior");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("MCP text result contains a symbol-keyed property");
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          throw new Error("MCP text result contains an exotic array");
        }
        if (value.length > maxNodes - nodes) {
          throw new Error(`MCP text result exceeds ${maxNodes} serialized nodes`);
        }
        addBytes(1);
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor) throw new Error("MCP text result contains a sparse array");
          if (!("value" in descriptor)) throw new Error("MCP text result contains an array accessor");
          addBytes(index === 0 ? 1 + depth * 2 : 2 + depth * 2);
          visit(descriptor.value, depth + 1);
        }
        if (value.length > 0) addBytes(1 + (depth - 1) * 2);
        addBytes(1);
        return;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("MCP text result contains an exotic object");
      }
      const keys = Object.keys(value);
      if (keys.length > maxNodes - nodes) {
        throw new Error(`MCP text result exceeds ${maxNodes} serialized nodes`);
      }
      addBytes(1);
      for (const [index, key] of keys.entries()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("MCP text result contains an object accessor");
        }
        addBytes(index === 0 ? 1 + depth * 2 : 2 + depth * 2);
        addBytes(encodedStringBytes(key));
        addBytes(2);
        visit(descriptor.value, depth + 1);
      }
      if (keys.length > 0) addBytes(1 + (depth - 1) * 2);
      addBytes(1);
    } finally {
      active.delete(value);
    }
  };

  visit(payload, 1);
  return { utf8Bytes, nodes, maxDepth: deepest };
}

/**
 * Convert an admitted tool payload into the MCP text-content envelope.
 *
 * @param payload - Plain JSON-domain payload to validate and serialize.
 * @returns MCP text content containing the established two-space-indented JSON.
 */
export function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  admitTextResultPayload(payload);
  const text = JSON.stringify(payload, null, 2);
  if (text === undefined) throw new Error("MCP text result serialization produced no JSON text");
  return {
    content: [{ type: "text", text }]
  };
}
