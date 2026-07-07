import { test } from "node:test";
import assert from "node:assert/strict";
import { isAddress, parseAmount, parseUnits, formatUnits, formatEth } from "../src/money.js";

test("isAddress accepts a 20-byte hex address, rejects junk", () => {
  assert.ok(isAddress("0x1111111111111111111111111111111111111111"));
  assert.ok(!isAddress("0x123"));
  assert.ok(!isAddress("1111111111111111111111111111111111111111"));
  assert.ok(!isAddress(null));
});

test("parseAmount handles wei, eth, gwei suffixes", () => {
  assert.equal(parseAmount("0.05eth"), 50000000000000000n);
  assert.equal(parseAmount("0.05 ETH"), 50000000000000000n);
  assert.equal(parseAmount("10gwei"), 10000000000n);
  assert.equal(parseAmount("50000000000000000"), 50000000000000000n);
  assert.equal(parseAmount(1000n), 1000n);
});

test("parseUnits is exact for many decimals (no float drift)", () => {
  assert.equal(parseUnits("0.000000000000000001", 18), 1n);
  assert.equal(parseUnits("1.5", 18), 1500000000000000000n);
});

test("parseUnits rejects over-precise input", () => {
  assert.throws(() => parseUnits("0.0000000000000000001", 18));
});

test("formatUnits / formatEth round-trip and trim", () => {
  assert.equal(formatUnits(1500000000000000000n, 18), "1.5");
  assert.equal(formatUnits(50000000000000000n, 18), "0.05");
  assert.equal(formatEth(50000000000000000n), "0.05 ETH");
});
