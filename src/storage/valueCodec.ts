/**
 * @fileoverview Tagged lossless value codec for binary, URLs, and complex message payloads.
 * @packageDocumentation
 */

/**
 * Tagged discriminated union of JSON-serializable representations for arbitrary JavaScript values.
 */
export type EncodedValue =
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "nan" }
  | { readonly type: "infinity" }
  | { readonly type: "negativeInfinity" }
  | { readonly type: "negativeZero" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "null" }
  | { readonly type: "undefined" }
  | { readonly type: "buffer"; readonly base64: string }
  | { readonly type: "uint8array"; readonly base64: string }
  | { readonly type: "url"; readonly href: string }
  | { readonly type: "array"; readonly items: readonly EncodedValue[] }
  | { readonly type: "object"; readonly entries: Record<string, EncodedValue> }
  | { readonly type: "binary"; readonly base64: string }; // Legacy backward compatibility

/**
 * Encodes an arbitrary JavaScript value into a lossless tagged JSON-safe representation.
 *
 * Supports primitives, special numbers (NaN, Infinity, -Infinity, -0), Buffer, Uint8Array,
 * URL, arrays, and plain objects. Rejects circular references, functions, symbols, bigint,
 * and unsupported prototypes fail-closed with a TypeError.
 *
 * @param value - Any JavaScript value.
 * @param seen - Internal Set of traversed objects to detect circular references.
 * @returns Lossless tagged EncodedValue.
 * @throws {TypeError} When value contains functions, symbols, bigint, circular references, or unsupported prototypes.
 */
export function encodeValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): EncodedValue {
  if (value === null) {
    return { type: "null" };
  }
  if (value === undefined) {
    return { type: "undefined" };
  }

  if (typeof value === "string") {
    return { type: "string", value };
  }
  if (typeof value === "boolean") {
    return { type: "boolean", value };
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return { type: "nan" };
    }
    if (value === Infinity) {
      return { type: "infinity" };
    }
    if (value === -Infinity) {
      return { type: "negativeInfinity" };
    }
    if (Object.is(value, -0)) {
      return { type: "negativeZero" };
    }
    return { type: "number", value };
  }

  if (typeof value === "bigint") {
    throw new TypeError("Cannot encode value: bigint is not supported.");
  }
  if (typeof value === "symbol") {
    throw new TypeError("Cannot encode value: symbols are not serializable.");
  }
  if (typeof value === "function") {
    throw new TypeError("Cannot encode value: functions are not serializable.");
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new TypeError("Cannot encode value: circular reference detected.");
    }
    seen.add(value);

    if (Buffer.isBuffer(value)) {
      return {
        type: "buffer",
        base64: value.toString("base64"),
      };
    }

    if (value instanceof Uint8Array) {
      const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      return {
        type: "uint8array",
        base64: buffer.toString("base64"),
      };
    }

    if (value instanceof URL) {
      return {
        type: "url",
        href: value.href,
      };
    }

    if (Array.isArray(value)) {
      return {
        type: "array",
        items: value.map((item) => encodeValue(item, seen)),
      };
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `Cannot encode value: unsupported prototype "${proto?.constructor?.name ?? "unknown"}".`,
      );
    }

    const entries: Record<string, EncodedValue> = {};
    for (const [k, v] of Object.entries(value)) {
      entries[k] = encodeValue(v, seen);
    }
    return { type: "object", entries };
  }

  throw new TypeError(`Cannot encode value: unsupported type "${typeof value}".`);
}

/**
 * Decodes a tagged EncodedValue back to its original JavaScript form.
 *
 * @param encoded - The EncodedValue.
 * @returns Restored original JavaScript value.
 */
export function decodeValue(encoded: EncodedValue): unknown {
  switch (encoded.type) {
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "string":
    case "number":
    case "boolean":
      return encoded.value;
    case "nan":
      return NaN;
    case "infinity":
      return Infinity;
    case "negativeInfinity":
      return -Infinity;
    case "negativeZero":
      return -0;
    case "buffer":
    case "binary":
      return Buffer.from(encoded.base64, "base64");
    case "uint8array": {
      const buf = Buffer.from(encoded.base64, "base64");
      return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    case "url":
      return new URL(encoded.href);
    case "array":
      return encoded.items.map(decodeValue);
    case "object": {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(encoded.entries)) {
        result[k] = decodeValue(v);
      }
      return result;
    }
  }
}
