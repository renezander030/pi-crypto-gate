// Action classes. A cap on "amount leaving the wallet" cannot see an ERC-20
// approval, whose amount stays put until a spender draws on it, so the class
// decides which rules apply.

export const ACTION_CLASSES = ["value_transfer", "allowance", "trade", "external_payment"];

/** Anything at or above this is treated as an unbounded allowance. */
export const UNLIMITED_THRESHOLD = 2n ** 255n;

/** Class of a proposal. Defaults to a plain transfer. */
export function classifyAction(proposal) {
  const declared = proposal?.action;
  if (declared && ACTION_CLASSES.includes(declared)) return declared;
  return "value_transfer";
}

/** Who ends up able to move the funds: the spender on an allowance, else the recipient. */
export function counterpartyOf(proposal, actionClass) {
  if (actionClass === "allowance" && proposal.spender) return proposal.spender;
  return proposal.to;
}

/** True when an allowance amount is effectively unbounded. */
export function isUnlimitedAllowance(amount) {
  return amount !== null && amount !== undefined && BigInt(amount) >= UNLIMITED_THRESHOLD;
}
