// BigInt-safe amount + address helpers. No floats, no deps.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** True if `s` looks like a 20-byte hex EVM address. */
export function isAddress(s) {
  return typeof s === "string" && ADDRESS_RE.test(s);
}

/**
 * Parse a human amount into an integer number of base units (wei), using BigInt
 * so no precision is lost. Accepts:
 *   "50000000000000000"        -> raw wei
 *   "0.05eth" / "0.05 ETH"     -> 18 decimals
 *   "10gwei" / "10 gwei"       -> 9 decimals
 *   "0.05" (with decimals arg) -> given decimals
 * @param {string|number|bigint} input
 * @param {number} [decimals=18] used when no unit suffix is present
 * @returns {bigint}
 */
export function parseAmount(input, decimals = 18) {
  if (typeof input === "bigint") return input;
  if (typeof input === "number") {
    if (!Number.isInteger(input)) {
      throw new Error(`parseAmount: number ${input} is not an integer wei value; pass a string like "${input}eth"`);
    }
    return BigInt(input);
  }
  if (typeof input !== "string") throw new Error("parseAmount: expected string");

  let s = input.trim().toLowerCase().replace(/_/g, "");
  const units = { wei: 0, gwei: 9, eth: 18, ether: 18 };
  let unitDecimals = null;
  // Longest suffix first, so "gwei" wins over "wei" and "ether" over "eth".
  for (const name of Object.keys(units).sort((a, b) => b.length - a.length)) {
    if (s.endsWith(name)) {
      s = s.slice(0, -name.length).trim();
      unitDecimals = units[name];
      break;
    }
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`parseAmount: cannot parse "${input}"`);

  // With a unit suffix, scale by that unit's decimals.
  if (unitDecimals !== null) return parseUnits(s, unitDecimals);
  // No suffix: a bare integer is already base units (wei); a decimal value is
  // interpreted in `decimals` units (eth by default). This keeps wei strings
  // stored in receipts round-tripping exactly.
  if (s.includes(".")) return parseUnits(s, decimals);
  return BigInt(s);
}

/** "1.5", 18 -> 1500000000000000000n. Rejects more fractional digits than `decimals`. */
export function parseUnits(decimalString, decimals) {
  const [whole, frac = ""] = String(decimalString).split(".");
  if (frac.length > decimals) {
    throw new Error(`parseUnits: "${decimalString}" has more than ${decimals} fractional digits`);
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** 1500000000000000000n, 18 -> "1.5". Trims trailing zeros. */
export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

/** Pretty-print a wei value as "x.y ETH" for logs/receipts. */
export function formatEth(weiValue) {
  return `${formatUnits(weiValue, 18)} ETH`;
}
