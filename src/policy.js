// Policy: the rules the gate enforces before any payment can go onchain.
import { readFileSync } from "node:fs";
import { parseAmount } from "./money.js";

/**
 * Sensible demo defaults, tuned for Base (chain 8453) + Base Sepolia (84532).
 * Every amount is stored internally as wei (BigInt).
 */
export function defaultPolicy() {
  return {
    // null/empty allowlist => any chain / any recipient allowed.
    chainAllowlist: [8453, 84532],
    recipientAllowlist: [],
    maxPerTxWei: parseAmount("0.05eth"),
    maxPerDayWei: parseAmount("0.20eth"),
    // Payments at or above this need a human to approve, even if under the caps.
    requireApprovalOverWei: parseAmount("0.01eth"),
  };
}

/**
 * Normalize a loosely-typed policy (amounts may be "0.05eth" strings or wei)
 * into the canonical BigInt-wei shape the gate consumes. Missing fields fall
 * back to defaults so a partial override is safe.
 */
export function normalizePolicy(input = {}) {
  const d = defaultPolicy();
  const amt = (v, fallback) => (v === undefined || v === null ? fallback : parseAmount(v));
  return {
    chainAllowlist: (input.chainAllowlist ?? d.chainAllowlist).map(Number),
    recipientAllowlist: (input.recipientAllowlist ?? d.recipientAllowlist).map((a) => a.toLowerCase()),
    maxPerTxWei: amt(input.maxPerTxWei, d.maxPerTxWei),
    maxPerDayWei: amt(input.maxPerDayWei, d.maxPerDayWei),
    requireApprovalOverWei: amt(input.requireApprovalOverWei, d.requireApprovalOverWei),
  };
}

/** Load + normalize a policy from a JSON file path. */
export function loadPolicy(path) {
  return normalizePolicy(JSON.parse(readFileSync(path, "utf8")));
}
