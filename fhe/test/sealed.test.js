import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeys,
  ownerSession,
  evaluatorSession,
  sealValue,
  openValue,
  evaluateSealed,
  openVerdict,
  decide,
  noiseBudget,
  MAX_VALUE,
  BLIND_BITS,
} from "../src/seal.js";

let keys;
let owner;
let evaluator;
let skip = false;
try {
  keys = await generateKeys();
  owner = await ownerSession(keys);
  // The evaluator is built from the serialized parameters alone: no key ever reaches it.
  evaluator = await evaluatorSession({ params: keys.params });
} catch (err) {
  if (/node-seal is not installed/.test(err.message)) skip = "node-seal not installed";
  else throw err;
}

const USDC = (n) => BigInt(Math.round(n * 1e6));
const seal = (v) => sealValue(owner, v);
const policy = (spent = 0n) => ({ cap: seal(USDC(250)), daily: seal(USDC(600)), threshold: seal(USDC(100)), spent: seal(spent) });
const verdictOf = (sealed, amount, opts) => openVerdict(owner, evaluateSealed(evaluator, sealed, amount, opts));

test("a sealed number opens to itself, inside the range", { skip }, () => {
  for (const v of [0n, 1n, USDC(150), MAX_VALUE]) assert.equal(openValue(owner, seal(v)), v);
  assert.throws(() => seal(MAX_VALUE + 1n), RangeError);
  assert.throws(() => seal(-1n), RangeError);
});

test("the evaluator computes the three checks without a key, equal cases included", { skip }, () => {
  const cases = [
    [USDC(50), { withinCap: true, withinDay: true, hold: false }, "allow"],
    [USDC(100), { withinCap: true, withinDay: true, hold: true }, "needs_approval"],
    [USDC(250), { withinCap: true, withinDay: true, hold: true }, "needs_approval"],
    [USDC(250) + 1n, { withinCap: false, withinDay: true, hold: true }, "block"],
    [USDC(1000), { withinCap: false, withinDay: false, hold: true }, "block"],
  ];
  const sealed = policy();
  for (const [amount, expected, decision] of cases) {
    const checks = verdictOf(sealed, amount);
    assert.deepEqual(checks, expected, `amount ${amount}`);
    assert.equal(decide(checks).decision, decision, `amount ${amount}`);
  }
  // With 500 already spent, 100 more is exactly the daily cap, 100.000001 is over it.
  const late = policy(USDC(500));
  assert.equal(decide(verdictOf(late, USDC(100))).decision, "needs_approval");
  const over = decide(verdictOf(late, USDC(100) + 1n));
  assert.equal(over.decision, "block");
  assert.deepEqual(over.reasons, ["daily-cap-exceeded"]);
});

test("the running total accumulates inside the seal and nobody opened it on the way", { skip }, () => {
  let sealed = policy();
  for (const amount of [USDC(200), USDC(200), USDC(200)]) {
    const out = evaluateSealed(evaluator, sealed, amount);
    assert.equal(openVerdict(owner, out).withinDay, true);
    sealed = { ...sealed, spent: out.spentNext };
  }
  assert.equal(openValue(owner, sealed.spent), USDC(600));
  assert.equal(verdictOf(sealed, 1n).withinDay, false);
  assert.ok(noiseBudget(owner, sealed.spent) > 20, "noise budget after 3 additions");
});

test("blinding scales the difference by the factor and keeps the sign", { skip }, () => {
  const sealed = policy();
  const out = evaluateSealed(evaluator, sealed, USDC(150), { blind: () => 3n });
  assert.equal(openValue(owner, out.dCap), 3n * (USDC(250) - USDC(150)));
  assert.equal(openValue(owner, out.dHold), 3n * (USDC(150) - USDC(100)));
  assert.throws(() => evaluateSealed(evaluator, sealed, USDC(150), { blind: () => 0n }), RangeError);
  assert.throws(() => evaluateSealed(evaluator, sealed, USDC(150), { blind: () => (1n << BigInt(BLIND_BITS)) + 1n }), RangeError);
  // Random blinding: the sign survives every time, at both extremes of the range.
  for (let i = 0; i < 20; i++) {
    const amount = i % 2 ? USDC(250) + BigInt(i) : USDC(250) - BigInt(i);
    const checks = verdictOf(sealed, amount);
    assert.equal(checks.withinCap, amount <= USDC(250), `amount ${amount}`);
  }
  const big = { ...sealed, cap: seal(MAX_VALUE) };
  assert.equal(verdictOf(big, MAX_VALUE).withinCap, true);
  assert.equal(verdictOf({ ...sealed, cap: seal(0n) }, MAX_VALUE).withinCap, false);
});

test("the evaluator refuses amounts outside the sealed range", { skip }, () => {
  assert.throws(() => evaluateSealed(evaluator, policy(), MAX_VALUE + 1n), RangeError);
  assert.throws(() => evaluateSealed(evaluator, policy(), -1n), RangeError);
});
