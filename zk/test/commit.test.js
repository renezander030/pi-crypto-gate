import { test, after } from "node:test";
import assert from "node:assert/strict";
import { paramsCommit, randomSalt, toBytes32, FIELD } from "../src/commit.js";
import { terminate } from "../src/deps.js";

after(() => terminate());

test("paramsCommit is the circuit's Poseidon([1, cap, salt])", async () => {
  // Pinned against a proof the compiled circuit accepted for exactly this commitment.
  const commit = await paramsCommit({ cap: 250000000n, salt: 12345678901234567890n });
  assert.equal(commit, 13970878834006108594025415066323363180899427452610379609032814667882254401459n);
  assert.match(toBytes32(commit), /^0x[0-9a-f]{64}$/);
  assert.equal(BigInt(toBytes32(commit)), commit);
});

test("a different salt or cap gives a different commitment", async () => {
  const base = await paramsCommit({ cap: 250000000n, salt: 1n });
  assert.notEqual(await paramsCommit({ cap: 250000000n, salt: 2n }), base);
  assert.notEqual(await paramsCommit({ cap: 250000001n, salt: 1n }), base);
  assert.notEqual(await paramsCommit({ version: 2, cap: 250000000n, salt: 1n }), base);
});

test("inputs must lie in the field", async () => {
  await assert.rejects(paramsCommit({ cap: FIELD, salt: 1n }), /outside the field/);
  await assert.rejects(paramsCommit({ cap: -1n, salt: 1n }), /outside the field/);
});

test("randomSalt is fresh and below the field", () => {
  const s1 = randomSalt();
  const s2 = randomSalt();
  assert.notEqual(s1, s2);
  assert.ok(s1 > 0n && s1 < FIELD);
  assert.ok(s1 < 1n << 248n);
});

test("toBytes32 pads to 32 bytes and refuses overflow", () => {
  assert.equal(toBytes32(1n), "0x" + "0".repeat(63) + "1");
  assert.throws(() => toBytes32(1n << 256n), /bytes32/);
});
