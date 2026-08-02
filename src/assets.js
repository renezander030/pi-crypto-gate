// Asset resolution. Every cap belongs to exactly one asset: caps configured in
// native units never apply to a token, and a token's base units are only
// meaningful alongside its `decimals`.
import { parseAmount, formatUnits } from "./money.js";
import { UNLIMITED_THRESHOLD } from "./actions.js";

export const NATIVE = "native";

/** Canonical asset key for a proposal: "native" or the lowercased token address. */
export function assetKeyOf(proposal) {
  const t = proposal?.token;
  if (t === undefined || t === null || t === "") return NATIVE;
  return String(t).toLowerCase();
}

/**
 * Resolve the asset a proposal moves, together with the caps that govern it.
 * `known:false` means the policy configures no caps for this asset — the gate
 * treats that as unpriceable and refuses rather than reaching for native caps.
 */
export function resolveAsset(proposal, policy) {
  const key = assetKeyOf(proposal);
  if (key === NATIVE) {
    return {
      key: NATIVE,
      symbol: "ETH",
      decimals: 18,
      known: true,
      maxPerTx: policy.maxPerTxWei,
      maxPerDay: policy.maxPerDayWei,
      requireApprovalOver: policy.requireApprovalOverWei,
    };
  }
  const t = policy.tokens?.[key];
  if (!t) return { key, symbol: null, decimals: null, known: false };
  return {
    key,
    symbol: t.symbol ?? key.slice(0, 8),
    decimals: t.decimals,
    known: true,
    maxPerTx: t.maxPerTx,
    maxPerDay: t.maxPerDay,
    requireApprovalOver: t.requireApprovalOver,
  };
}

/** Parse a proposal amount in the asset's own base units. */
export function parseAssetAmount(input, asset) {
  return parseAmount(input, asset.decimals ?? 18);
}

/** "50 USDC" / "0.5 ETH" for logs and receipts. */
export function formatAsset(value, asset) {
  if (value === null || value === undefined) return "-";
  const decimals = asset?.decimals ?? 18;
  const symbol = asset?.symbol ?? "units";
  // An uint256-max allowance is a ceiling, not a quantity anyone reads.
  if (BigInt(value) >= UNLIMITED_THRESHOLD) return `unlimited ${symbol}`;
  return `${formatUnits(value, decimals)} ${symbol}`;
}
