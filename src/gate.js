// The gate: given a proposed payment + policy + how much was already spent
// today, decide allow / needs_approval / block. Pure and deterministic.
import { isAddress, parseAmount, formatEth } from "./money.js";
import { normalizePolicy } from "./policy.js";

/** @typedef {"allow"|"needs_approval"|"block"} Decision */

/**
 * Evaluate one proposed payment against a policy.
 * @param {{to:string, amount:string|bigint, chainId:number, token?:string, memo?:string}} proposal
 * @param {object} [policy] loose or normalized policy
 * @param {string|bigint} [spentTodayWei=0n] wei already executed today
 * @returns {{decision:Decision, reasons:string[], checks:Array, proposal:object, spentTodayWei:string, evaluatedAt:string}}
 */
export function evaluate(proposal, policy, spentTodayWei = 0n) {
  const p = normalizePolicy(policy);
  const spent = BigInt(spentTodayWei ?? 0n);
  const checks = [];
  const reasons = [];
  let decision = "allow";

  const block = (name, detail) => {
    checks.push({ name, pass: false, detail });
    reasons.push(name);
    decision = "block";
  };
  const pass = (name, detail) => checks.push({ name, pass: true, detail });

  // 1. Structural validity. A malformed proposal never reaches a chain.
  let amount;
  try {
    amount = parseAmount(proposal.amount);
  } catch {
    amount = null;
  }
  if (!isAddress(proposal.to)) block("invalid-recipient", `not an address: ${proposal.to}`);
  if (amount === null || amount <= 0n) block("invalid-amount", `not a positive wei amount: ${proposal.amount}`);
  if (!Number.isInteger(proposal.chainId)) block("invalid-chain", `chainId not an integer: ${proposal.chainId}`);

  // If structurally broken, stop here — later checks would compare garbage.
  if (decision === "block") {
    return finalize({ decision, reasons, checks, proposal, amount, spent });
  }

  // 2. Chain allowlist.
  if (p.chainAllowlist.length && !p.chainAllowlist.includes(proposal.chainId)) {
    block("chain-not-allowed", `chain ${proposal.chainId} not in [${p.chainAllowlist.join(", ")}]`);
  } else pass("chain-not-allowed", `chain ${proposal.chainId} allowed`);

  // 3. Recipient allowlist (only enforced when the list is non-empty).
  const to = proposal.to.toLowerCase();
  if (p.recipientAllowlist.length && !p.recipientAllowlist.includes(to)) {
    block("recipient-not-allowlisted", `${proposal.to} not on the allowlist`);
  } else pass("recipient-not-allowlisted", p.recipientAllowlist.length ? "recipient on allowlist" : "no allowlist set");

  // 4. Per-transaction cap.
  if (amount > p.maxPerTxWei) {
    block("per-tx-cap-exceeded", `${formatEth(amount)} > cap ${formatEth(p.maxPerTxWei)}`);
  } else pass("per-tx-cap-exceeded", `${formatEth(amount)} <= cap ${formatEth(p.maxPerTxWei)}`);

  // 5. Rolling daily cap (already-spent + this payment).
  if (spent + amount > p.maxPerDayWei) {
    block("daily-cap-exceeded", `${formatEth(spent + amount)} today > cap ${formatEth(p.maxPerDayWei)}`);
  } else pass("daily-cap-exceeded", `${formatEth(spent + amount)} today <= cap ${formatEth(p.maxPerDayWei)}`);

  // 6. Human-approval threshold — only if nothing already blocked it.
  if (decision !== "block" && amount >= p.requireApprovalOverWei) {
    decision = "needs_approval";
    reasons.push("approval-required-over-threshold");
    checks.push({
      name: "approval-required-over-threshold",
      pass: false,
      detail: `${formatEth(amount)} >= ${formatEth(p.requireApprovalOverWei)} needs a human`,
    });
  } else if (amount >= p.requireApprovalOverWei) {
    // Would need approval, but a hard rule already blocked it — say so truthfully.
    pass("approval-required-over-threshold", `moot: already blocked (${formatEth(amount)} >= ${formatEth(p.requireApprovalOverWei)})`);
  } else {
    pass("approval-required-over-threshold", `${formatEth(amount)} < ${formatEth(p.requireApprovalOverWei)}`);
  }

  return finalize({ decision, reasons, checks, proposal, amount, spent });
}

function finalize({ decision, reasons, checks, proposal, amount, spent }) {
  return {
    decision,
    reasons,
    checks,
    proposal: {
      to: proposal.to,
      // Canonical wei string so receipts are summable; null if unparseable.
      amount: amount === null || amount === undefined ? null : amount.toString(),
      amountInput: String(proposal.amount),
      chainId: proposal.chainId,
      token: proposal.token ?? null,
      memo: proposal.memo ?? null,
    },
    spentTodayWei: spent.toString(),
    // ISO date; callers may override for deterministic snapshots.
    evaluatedAt: new Date().toISOString(),
  };
}
