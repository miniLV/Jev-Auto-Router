import { createHash } from "node:crypto";

/** Values accepted by the repository's canonical JSON representation. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encode(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not accept non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("canonical JSON accepts only JSON values");
  if (seen.has(value)) throw new TypeError("canonical JSON does not accept cycles");
  seen.add(value);

  let result: string;
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("canonical JSON does not accept sparse arrays");
      values.push(encode(value[index], seen));
    }
    result = `[${values.join(",")}]`;
  } else {
    if (!isPlainObject(value)) throw new TypeError("canonical JSON accepts only plain objects");
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("canonical JSON does not accept symbol keys");
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new TypeError("canonical JSON does not accept accessors or non-enumerable properties");
      }
    }
    result = `{${names.sort().map((name) => `${JSON.stringify(name)}:${encode((value as Record<string, unknown>)[name], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

/**
 * Encode a JSON value deterministically. Object keys are sorted; array order
 * is preserved because arrays are semantic contracts in this repository.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new WeakSet<object>());
}

/** SHA-256 of the UTF-8 canonical JSON representation. */
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
