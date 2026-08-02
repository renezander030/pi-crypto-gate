// The gate: given a proposed action + policy + what has already been spent
// today, decide allow / needs_approval / block. Pure and deterministic.
import { randomUUID } from "node:crypto";
import { isAddress } from "./money.js";
import { normalizePolicy } from "./policy.js";
import { NATIVE, resolveAsset, parseAssetAmount, formatAsset } from "./assets.js";
import { classifyAction, counterpartyOf, isUnlimitedAllowance } from "./actions.js";
import { hashOf } from "./canonical.js";

/** @typedef {"allow"|"needs_approval"|"block"} Decision */

/** Classes where the amount leaves the wallet now and counts against spend caps. */
const VALUE_MOVING = new Set(["value_transfer", "trade", "external_payment"]);

/**
 * Spend already recorded for one asset. Accepts a bare native total (bigint,
 * number or string) or a per-asset map keyed by asset.
 */
function resolveSpent(spentToday, assetKey) {
  if (spentToday === null || spentToday === undefined) return 0n;
  const t = typeof spentToday;
  if (t === "bigint" || t === "number" || t === "string") {
    return assetKey === NATIVE ? BigInt(spentToday) : 0n;
  }
  if (spentToday instanceof Map) return BigInt(spentToday.get(assetKey) ?? 0n);
  return BigInt(spentToday[assetKey] ?? 0n);
}

/**
 * Stable identifier for one exact action. An approval grant is bound to this,
 * so it cannot authorise a different payment. Include `proposal.nonce` to make
 * two otherwise identical proposals distinct.
 */
export function actionHashOf(proposal, { assetKey, actionClass, amount } = {}) {
  return hashOf({
    to: String(proposal.to ?? "").toLowerCase(),
    spender: proposal.spender ? String(proposal.spender).toLowerCase() : null,
    amount: amount === null || amount === undefined ? null : amount.toString(),
    asset: assetKey ?? NATIVE,
    chainId: proposal.chainId ?? null,
    action: actionClass ?? classifyAction(proposal),
    nonce: proposal.nonce ?? null,
  });
}

/**
 * Evaluate one proposed action against a policy.
 * @param {{to:string, amount:string|bigint, chainId:number, token?:string, action?:string, spender?:string, nonce?:string, memo?:string}} proposal
 * @param {object} [policy] loose or normalized policy
 * @param {bigint|string|object|Map} [spentToday=0n] already-executed spend, native total or per-asset
 * @returns {object} decision record
 */
export function evaluate(proposal, policy, spentToday = 0n) {
  const p = policy && policy.version ? policy : normalizePolicy(policy);
  const checks = [];
  const reasons = [];
  let decision = "allow";

  const block = (name, detail) => {
    checks.push({ name, pass: false, detail });
    reasons.push(name);
    decision = "block";
  };
  const pass = (name, detail) => checks.push({ name, pass: true, detail });

  const actionClass = classifyAction(proposal);
  const asset = resolveAsset(proposal, p);
  const spent = resolveSpent(spentToday, asset.key);

  // 1. Structural validity. A malformed proposal never reaches a chain.
  let amount;
  try {
    amount = parseAssetAmount(proposal.amount, asset);
  } catch {
    amount = null;
  }
  // A zero allowance is a revocation, so only value-moving actions need > 0.
  const amountOk = amount !== null && (actionClass === "allowance" ? amount >= 0n : amount > 0n);
  if (!isAddress(proposal.to)) block("invalid-recipient", `not an address: ${proposal.to}`);
  if (!amountOk) block("invalid-amount", `not a valid amount for ${actionClass}: ${proposal.amount}`);
  if (!Number.isInteger(proposal.chainId)) block("invalid-chain", `chainId not an integer: ${proposal.chainId}`);
  if (proposal.spender !== undefined && proposal.spender !== null && !isAddress(proposal.spender)) {
    block("invalid-spender", `not an address: ${proposal.spender}`);
  }

  if (decision === "block") {
    return finalize({ decision, reasons, checks, proposal, amount, spent, asset, actionClass, policy: p });
  }

  // 2. The asset must have caps. An unconfigured token is unpriceable here, and
  // native caps do not carry over to it.
  if (!asset.known) {
    block("asset-not-configured", `token ${asset.key} has no caps in policy.tokens`);
    return finalize({ decision, reasons, checks, proposal, amount, spent, asset, actionClass, policy: p });
  }
  pass("asset-not-configured", `${asset.symbol} caps configured (${asset.decimals} decimals)`);

  // 3. Action class allowlist.
  if (!p.allowedActions.includes(actionClass)) {
    block("action-not-allowed", `${actionClass} not in [${p.allowedActions.join(", ")}]`);
  } else pass("action-not-allowed", `${actionClass} allowed`);

  // 4. Chain allowlist.
  if (p.chainAllowlist.length && !p.chainAllowlist.includes(proposal.chainId)) {
    block("chain-not-allowed", `chain ${proposal.chainId} not in [${p.chainAllowlist.join(", ")}]`);
  } else pass("chain-not-allowed", `chain ${proposal.chainId} allowed`);

  // 5. Counterparty. On an allowance that is the spender, who gains the standing
  // authority; on a transfer it is the recipient.
  const counterparty = String(counterpartyOf(proposal, actionClass) ?? "").toLowerCase();
  if (p.recipientDenylist.includes(counterparty)) {
    block("recipient-denylisted", `${counterparty} is on the denylist`);
  } else pass("recipient-denylisted", p.recipientDenylist.length ? "counterparty not on denylist" : "no denylist set");

  if (p.recipientAllowlist.length && !p.recipientAllowlist.includes(counterparty)) {
    block("recipient-not-allowlisted", `${counterparty} not on the allowlist`);
  } else pass("recipient-not-allowlisted", p.recipientAllowlist.length ? "counterparty on allowlist" : "no allowlist set");

  // 6. Unbounded allowances.
  if (actionClass === "allowance") {
    if (isUnlimitedAllowance(amount) && !p.allowUnlimitedAllowance) {
      block("unlimited-allowance", `unbounded approval to ${counterparty}`);
    } else {
      pass(
        "unlimited-allowance",
        isUnlimitedAllowance(amount) ? "unbounded approval explicitly permitted" : "bounded approval",
      );
    }
  }

  // 7. Per-transaction cap. On an allowance this caps the standing ceiling.
  if (amount > asset.maxPerTx) {
    const what = actionClass === "allowance" ? "allowance ceiling" : "amount";
    block("per-tx-cap-exceeded", `${what} ${formatAsset(amount, asset)} > cap ${formatAsset(asset.maxPerTx, asset)}`);
  } else pass("per-tx-cap-exceeded", `${formatAsset(amount, asset)} <= cap ${formatAsset(asset.maxPerTx, asset)}`);

  // 8. Rolling daily cap, per asset. An allowance moves nothing today.
  if (VALUE_MOVING.has(actionClass)) {
    if (spent + amount > asset.maxPerDay) {
      block("daily-cap-exceeded", `${formatAsset(spent + amount, asset)} today > cap ${formatAsset(asset.maxPerDay, asset)}`);
    } else {
      pass("daily-cap-exceeded", `${formatAsset(spent + amount, asset)} today <= cap ${formatAsset(asset.maxPerDay, asset)}`);
    }
  } else {
    pass("daily-cap-exceeded", `${actionClass} moves no funds today`);
  }

  // 9. Human-approval threshold. An allowance always needs a human.
  const needsHuman = amount >= asset.requireApprovalOver || actionClass === "allowance";
  const why =
    actionClass === "allowance"
      ? "an allowance grants standing authority"
      : `${formatAsset(amount, asset)} >= ${formatAsset(asset.requireApprovalOver, asset)}`;
  if (decision !== "block" && needsHuman) {
    decision = "needs_approval";
    reasons.push("approval-required-over-threshold");
    checks.push({ name: "approval-required-over-threshold", pass: false, detail: `${why} — needs a human` });
  } else if (needsHuman) {
    pass("approval-required-over-threshold", `moot: already blocked (${why})`);
  } else {
    pass("approval-required-over-threshold", `${formatAsset(amount, asset)} < ${formatAsset(asset.requireApprovalOver, asset)}`);
  }

  return finalize({ decision, reasons, checks, proposal, amount, spent, asset, actionClass, policy: p });
}

function finalize({ decision, reasons, checks, proposal, amount, spent, asset, actionClass, policy }) {
  const evaluatedAt = new Date().toISOString();
  const expiresAt =
    decision === "needs_approval"
      ? new Date(Date.parse(evaluatedAt) + policy.approvalTtlSeconds * 1000).toISOString()
      : null;
  return {
    decisionId: randomUUID(),
    policyVersion: policy.version,
    actionHash: actionHashOf(proposal, { assetKey: asset.key, actionClass, amount }),
    decision,
    reasons,
    checks,
    proposal: {
      to: proposal.to,
      spender: proposal.spender ?? null,
      // Canonical base-unit string so receipts are summable; null if unparseable.
      amount: amount === null || amount === undefined ? null : amount.toString(),
      amountInput: String(proposal.amount),
      chainId: proposal.chainId,
      token: proposal.token ?? null,
      action: actionClass,
      asset: { key: asset.key, symbol: asset.symbol, decimals: asset.decimals },
      nonce: proposal.nonce ?? null,
      memo: proposal.memo ?? null,
    },
    // Spend for this proposal's asset. Native-only field kept for compatibility.
    spentToday: spent.toString(),
    spentTodayWei: asset.key === NATIVE ? spent.toString() : "0",
    // Callers may override for deterministic snapshots.
    evaluatedAt,
    expiresAt,
  };
}
