// Policy: the rules the gate enforces before any payment can go onchain.
// Data only — it knows nothing about signing or execution.
import { readFileSync } from "node:fs";
import { parseAmount } from "./money.js";
import { ACTION_CLASSES } from "./actions.js";
import { hashOf } from "./canonical.js";

/** Raw defaults, before normalization. Tuned for Base (8453) + Base Sepolia (84532). */
function baseDefaults() {
  return {
    // Empty allowlist => any chain / any recipient allowed.
    chainAllowlist: [8453, 84532],
    recipientAllowlist: [],
    recipientDenylist: [],
    maxPerTxWei: "0.05eth",
    maxPerDayWei: "0.20eth",
    // Payments at or above this need a human, even when under the caps.
    requireApprovalOverWei: "0.01eth",
    // Tokens are opt-in: an asset with no entry here has no caps to enforce.
    tokens: {},
    allowedActions: ACTION_CLASSES,
    allowUnlimitedAllowance: false,
    // How long an approval grant stays valid.
    approvalTtlSeconds: 900,
    // Base64 spki Ed25519 key. When set, only grants it signed are honoured.
    approverPublicKey: null,
    // Base64 spki Ed25519 key `verify` checks receipt signatures against.
    gatePublicKey: null,
  };
}

/**
 * Demo defaults in the canonical BigInt shape.
 * Native amounts are wei; token amounts are that token's base units.
 */
export function defaultPolicy() {
  return normalizePolicy({});
}

/**
 * Normalize a loosely-typed policy into the canonical BigInt shape the gate
 * consumes. Missing fields fall back to defaults so a partial override is safe.
 *
 * Token entries require `decimals`, `maxPerTx` and `maxPerDay`. Omitting
 * `requireApprovalOver` holds every payment in that token for a human.
 */
export function normalizePolicy(input = {}) {
  const d = baseDefaults();
  const src = { ...d, ...input };
  const amt = (v, fallback) => parseAmount(v === undefined || v === null ? fallback : v);

  const tokens = {};
  for (const [addr, raw] of Object.entries(src.tokens ?? {})) {
    const key = String(addr).toLowerCase();
    if (raw === null || typeof raw !== "object") {
      throw new Error(`policy.tokens["${addr}"]: expected an object`);
    }
    const { decimals } = raw;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`policy.tokens["${addr}"]: decimals must be an integer 0-36`);
    }
    for (const required of ["maxPerTx", "maxPerDay"]) {
      if (raw[required] === undefined || raw[required] === null) {
        throw new Error(`policy.tokens["${addr}"]: ${required} is required`);
      }
    }
    tokens[key] = {
      symbol: raw.symbol ?? null,
      decimals,
      maxPerTx: parseAmount(raw.maxPerTx, decimals),
      maxPerDay: parseAmount(raw.maxPerDay, decimals),
      requireApprovalOver:
        raw.requireApprovalOver === undefined || raw.requireApprovalOver === null
          ? 0n
          : parseAmount(raw.requireApprovalOver, decimals),
    };
  }

  const allowedActions = (src.allowedActions ?? d.allowedActions).map(String);
  for (const a of allowedActions) {
    if (!ACTION_CLASSES.includes(a)) {
      throw new Error(`policy.allowedActions: unknown action class "${a}"`);
    }
  }

  const normalized = {
    chainAllowlist: (src.chainAllowlist ?? d.chainAllowlist).map(Number),
    recipientAllowlist: (src.recipientAllowlist ?? d.recipientAllowlist).map((a) => String(a).toLowerCase()),
    recipientDenylist: (src.recipientDenylist ?? d.recipientDenylist).map((a) => String(a).toLowerCase()),
    maxPerTxWei: amt(input.maxPerTxWei, d.maxPerTxWei),
    maxPerDayWei: amt(input.maxPerDayWei, d.maxPerDayWei),
    requireApprovalOverWei: amt(input.requireApprovalOverWei, d.requireApprovalOverWei),
    tokens,
    allowedActions,
    allowUnlimitedAllowance: Boolean(src.allowUnlimitedAllowance),
    approvalTtlSeconds: Number(src.approvalTtlSeconds ?? d.approvalTtlSeconds),
    approverPublicKey: src.approverPublicKey ?? null,
    gatePublicKey: src.gatePublicKey ?? null,
  };

  // Identifies the exact ruleset a decision was made under.
  normalized.version = input.version ?? `v${hashOf(normalized).slice(0, 12)}`;
  return normalized;
}

/** Load + normalize a policy from a JSON file path. */
export function loadPolicy(path) {
  return normalizePolicy(JSON.parse(readFileSync(path, "utf8")));
}
