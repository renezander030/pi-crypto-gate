import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/gate.js";
import { parseAmount } from "../src/money.js";

const TO = "0x1111111111111111111111111111111111111111";
const BASE = 8453;
// Small policy: 0.05 per tx, 0.20 per day, approve >= 0.01, Base only.

test("under all caps and below approval threshold -> allow", () => {
  const r = evaluate({ to: TO, amount: "0.005eth", chainId: BASE });
  assert.equal(r.decision, "allow");
  assert.equal(r.reasons.length, 0);
  assert.equal(r.proposal.amount, parseAmount("0.005eth").toString());
});

test("over the per-tx cap -> block (the headline failing case)", () => {
  const r = evaluate({ to: TO, amount: "0.5eth", chainId: BASE });
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("per-tx-cap-exceeded"));
});

test("under caps but at/above approval threshold -> needs_approval", () => {
  const r = evaluate({ to: TO, amount: "0.04eth", chainId: BASE });
  assert.equal(r.decision, "needs_approval");
  assert.ok(r.reasons.includes("approval-required-over-threshold"));
});

test("daily cap trips once prior spend is high enough", () => {
  const spent = parseAmount("0.18eth");
  const r = evaluate({ to: TO, amount: "0.04eth", chainId: BASE }, {}, spent);
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("daily-cap-exceeded"));
});

test("recipient allowlist blocks a non-listed address", () => {
  const policy = { recipientAllowlist: ["0x2222222222222222222222222222222222222222"] };
  const r = evaluate({ to: TO, amount: "0.005eth", chainId: BASE }, policy);
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("recipient-not-allowlisted"));
});

test("recipient allowlist permits a listed address", () => {
  const policy = { recipientAllowlist: [TO] };
  const r = evaluate({ to: TO, amount: "0.005eth", chainId: BASE }, policy);
  assert.equal(r.decision, "allow");
});

test("chain not on the allowlist -> block", () => {
  const r = evaluate({ to: TO, amount: "0.005eth", chainId: 1 });
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("chain-not-allowed"));
});

test("malformed recipient -> block invalid, no cap comparison leaks through", () => {
  const r = evaluate({ to: "not-an-address", amount: "0.005eth", chainId: BASE });
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("invalid-recipient"));
});

test("zero / negative amount -> block invalid", () => {
  const r = evaluate({ to: TO, amount: "0", chainId: BASE });
  assert.equal(r.decision, "block");
  assert.ok(r.reasons.includes("invalid-amount"));
});

test("block wins over needs_approval when both would fire", () => {
  // 0.5 eth is over the per-tx cap AND over the approval threshold.
  const r = evaluate({ to: TO, amount: "0.5eth", chainId: BASE });
  assert.equal(r.decision, "block");
});

test("partial policy override keeps other defaults", () => {
  // Raise both caps; 0.5 now passes per-tx and daily, but requireApprovalOverWei
  // is untouched (default 0.01), so it still needs a human.
  const r = evaluate({ to: TO, amount: "0.5eth", chainId: BASE }, { maxPerTxWei: "1eth", maxPerDayWei: "1eth" });
  assert.equal(r.decision, "needs_approval");
});
