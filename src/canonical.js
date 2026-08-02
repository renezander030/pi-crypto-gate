// Deterministic JSON + hashing. Two parties must derive byte-identical bytes
// from the same record, so key order is sorted and BigInt is rendered as a
// decimal string.
import { createHash } from "node:crypto";

/**
 * Stable JSON: object keys sorted, no insignificant whitespace, BigInt as a
 * decimal string, `undefined` object members dropped.
 * Sorted-key JSON, not RFC 8785 — number formatting follows JSON.stringify.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "bigint") return JSON.stringify(value.toString());
  if (t === "number" || t === "boolean") return JSON.stringify(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  // undefined / function / symbol
  return "null";
}

/** sha256 hex of a string or Buffer. */
export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** sha256 hex over the canonical form of a value. */
export function hashOf(value) {
  return sha256(canonicalJson(value));
}
