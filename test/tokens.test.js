import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/gate.js";
import { normalizePolicy } from "../src/policy.js";
import { parseAmount } from "../src/money.js";

const TO = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const BASE = 8453;
const MAX_UINT256 = (2n ** 256n - 1n).toString();

// USDC at 6 decimals: 250 per tx, 1000 per day, approve >= 100.
const POLICY = {
  tokens: {
    [USDC]: { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "1000.0", requireApprovalOver: "100.0" },
  },
};

test("a token amount is measured against that token's cap, not the native cap", () => {
  // 1,000,000 USDC in base units is numerically far below the 0.05 ETH wei cap.
  const r = evaluate({ to: TO, amount: "1000000000000", token: USDC, chainId: BASE }, POLICY);
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("per-tx-cap-exceeded"));
});

test("the same base-unit figure is fine for native ETH", () => {
  const r = evaluate({ to: TO, amount: "1000000000000", chainId: BASE });
  assert.equal(r.decision, "allow");
});

test("a token with no policy entry has no caps to enforce -> block", () => {
  const r = evaluate({ to: TO, amount: "1.0", token: DAI, chainId: BASE }, POLICY);
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("asset-not-configured"));
});

test("native caps do not carry over to an unconfigured token", () => {
  // Well under 0.05 ETH numerically, still refused: the asset is unpriceable.
  const r = evaluate({ to: TO, amount: "1", token: DAI, chainId: BASE }, POLICY);
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("asset-not-configured"));
});

test("a token payment under every cap and threshold -> allow", () => {
  const r = evaluate({ to: TO, amount: "50.0", token: USDC, chainId: BASE }, POLICY);
  assert.equal(r.decision, "allow");
  assert.equal(r.proposal.asset.symbol, "USDC");
  assert.equal(r.proposal.amount, "50000000");
});

test("a token payment over its approval threshold -> needs_approval", () => {
  const r = evaluate({ to: TO, amount: "150.0", token: USDC, chainId: BASE }, POLICY);
  assert.equal(r.decision, "needs_approval");
});

test("daily spend is tracked per asset, so USDC spend does not consume the ETH cap", () => {
  const spent = { [USDC]: parseAmount("900.0", 6).toString() };
  const native = evaluate({ to: TO, amount: "0.005eth", chainId: BASE }, POLICY, spent);
  assert.equal(native.decision, "allow");

  const token = evaluate({ to: TO, amount: "200.0", token: USDC, chainId: BASE }, POLICY, spent);
  assert.equal(token.decision, "block");
  assert.ok(token.reasons.includes("daily-cap-exceeded"));
});

test("a native spend total does not leak into a token evaluation", () => {
  const r = evaluate({ to: TO, amount: "50.0", token: USDC, chainId: BASE }, POLICY, parseAmount("0.19eth"));
  assert.equal(r.decision, "allow");
});

test("omitting requireApprovalOver holds every payment in that token", () => {
  const policy = { tokens: { [USDC]: { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "1000.0" } } };
  const r = evaluate({ to: TO, amount: "0.000001", token: USDC, chainId: BASE }, policy);
  assert.equal(r.decision, "needs_approval");
});

test("a token entry without decimals is a policy error", () => {
  assert.throws(
    () => normalizePolicy({ tokens: { [USDC]: { maxPerTx: "1.0", maxPerDay: "1.0" } } }),
    /decimals must be an integer/,
  );
});

test("a token entry without caps is a policy error", () => {
  assert.throws(() => normalizePolicy({ tokens: { [USDC]: { decimals: 6 } } }), /maxPerTx is required/);
});

test("an unbounded allowance is blocked", () => {
  const r = evaluate(
    { to: USDC, amount: MAX_UINT256, token: USDC, action: "allowance", spender: SPENDER, chainId: BASE },
    POLICY,
  );
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("unlimited-allowance"));
});

test("an unbounded allowance passes only when policy opts in", () => {
  const r = evaluate(
    { to: USDC, amount: MAX_UINT256, token: USDC, action: "allowance", spender: SPENDER, chainId: BASE },
    { ...POLICY, allowUnlimitedAllowance: true, tokens: { [USDC]: { symbol: "USDC", decimals: 6, maxPerTx: MAX_UINT256, maxPerDay: "1000.0" } } },
  );
  assert.equal(r.decision, "needs_approval");
});

test("an allowance ceiling above the per-tx cap is blocked", () => {
  const r = evaluate(
    { to: USDC, amount: "500.0", token: USDC, action: "allowance", spender: SPENDER, chainId: BASE },
    POLICY,
  );
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("per-tx-cap-exceeded"));
});

test("a bounded allowance under the cap still needs a human", () => {
  const r = evaluate(
    { to: USDC, amount: "10.0", token: USDC, action: "allowance", spender: SPENDER, chainId: BASE },
    POLICY,
  );
  assert.equal(r.decision, "needs_approval");
});

test("a zero allowance is a revocation, not a malformed amount", () => {
  const r = evaluate(
    { to: USDC, amount: "0", token: USDC, action: "allowance", spender: SPENDER, chainId: BASE },
    POLICY,
  );
  assert.equal(r.decision, "needs_approval");
  assert.ok(!r.reasons.includes("invalid-amount"));
});

test("an allowance is screened on the spender, not the token contract", () => {
  const policy = { ...POLICY, recipientDenylist: [SPENDER] };
  const r = evaluate(
    { to: USDC, amount: "10.0", token: USDC, action: "allowance", spender: SPENDER, chainId: BASE },
    policy,
  );
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("recipient-denylisted"));
});

test("an allowance moves nothing today, so it never consumes the daily cap", () => {
  const spent = { [USDC]: parseAmount("990.0", 6).toString() };
  const r = evaluate(
    { to: USDC, amount: "10.0", token: USDC, action: "allowance", spender: SPENDER, chainId: BASE },
    POLICY,
    spent,
  );
  assert.ok(!r.reasons.includes("daily-cap-exceeded"));
});

test("a denylisted recipient is blocked even when the allowlist is empty", () => {
  const r = evaluate({ to: SPENDER, amount: "0.005eth", chainId: BASE }, { recipientDenylist: [SPENDER] });
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("recipient-denylisted"));
});

test("an action class outside policy.allowedActions is blocked", () => {
  const r = evaluate(
    { to: TO, amount: "10.0", token: USDC, action: "trade", chainId: BASE },
    { ...POLICY, allowedActions: ["value_transfer"] },
  );
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("action-not-allowed"));
});

test("a malformed spender is rejected before any cap comparison", () => {
  const r = evaluate(
    { to: USDC, amount: "10.0", token: USDC, action: "allowance", spender: "nope", chainId: BASE },
    POLICY,
  );
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("invalid-spender"));
});

test("a decision carries its policy version and a hash of the exact action", () => {
  const r = evaluate({ to: TO, amount: "50.0", token: USDC, chainId: BASE, nonce: "n1" }, POLICY);
  assert.match(r.policyVersion, /^v[0-9a-f]{12}$/);
  assert.match(r.actionHash, /^[0-9a-f]{64}$/);
  assert.ok(r.decisionId);

  const same = evaluate({ to: TO, amount: "50.0", token: USDC, chainId: BASE, nonce: "n1" }, POLICY);
  assert.equal(same.actionHash, r.actionHash);

  const other = evaluate({ to: TO, amount: "50.0", token: USDC, chainId: BASE, nonce: "n2" }, POLICY);
  assert.notEqual(other.actionHash, r.actionHash);
});

test("a held decision carries an expiry", () => {
  const r = evaluate({ to: TO, amount: "0.04eth", chainId: BASE }, { approvalTtlSeconds: 60 });
  assert.equal(r.decision, "needs_approval");
  const window = Date.parse(r.expiresAt) - Date.parse(r.evaluatedAt);
  assert.equal(window, 60_000);
});
