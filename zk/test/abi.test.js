import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeProof,
  decodeProof,
  encodeAuthorization,
  decodeAuthorization,
  encodeBytesPair,
  decodeBytesPair,
  toHex,
  fromHex,
} from "../src/abi.js";

// Reference vectors produced with `cast abi-encode`.
const PROOF_VECTOR = "0x" + [1, 2, 3, 4, 5, 6, 7, 8].map((n) => n.toString(16).padStart(64, "0")).join("");
const AUTH_VECTOR =
  "0x0000000000000000000000003333333333333333333333333333333333333333" +
  "0000000000000000000000000000000000000000000000000000000008f0d180" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000070dbd880" +
  "0101010101010101010101010101010101010101010101010101010101010101";
const PAIR_VECTOR =
  "0x0000000000000000000000000000000000000000000000000000000000000040" +
  "0000000000000000000000000000000000000000000000000000000000000080" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "aa00000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "bbcc000000000000000000000000000000000000000000000000000000000000";

const AUTH = {
  to: "0x3333333333333333333333333333333333333333",
  value: 150000000n,
  validAfter: 0n,
  validBefore: 1893456000n,
  nonce: "0x0101010101010101010101010101010101010101010101010101010101010101",
};

test("encodeProof matches abi.encode(uint256[2],uint256[2][2],uint256[2])", () => {
  const enc = encodeProof({ a: [1, 2], b: [[3, 4], [5, 6]], c: [7, 8] });
  assert.equal(toHex(enc), PROOF_VECTOR);
  assert.deepEqual(decodeProof(enc), {
    a: [toHex(Buffer.alloc(31)) + "01", toHex(Buffer.alloc(31)) + "02"],
    b: [
      [toHex(Buffer.alloc(31)) + "03", toHex(Buffer.alloc(31)) + "04"],
      [toHex(Buffer.alloc(31)) + "05", toHex(Buffer.alloc(31)) + "06"],
    ],
    c: [toHex(Buffer.alloc(31)) + "07", toHex(Buffer.alloc(31)) + "08"],
  });
});

test("encodeAuthorization matches cast abi-encode", () => {
  const enc = encodeAuthorization(AUTH);
  assert.equal(toHex(enc), AUTH_VECTOR);
  assert.deepEqual(decodeAuthorization(enc), AUTH);
});

test("encodeBytesPair matches abi.encode(bytes,bytes)", () => {
  const enc = encodeBytesPair(fromHex("0xaa"), fromHex("0xbbcc"));
  assert.equal(toHex(enc), PAIR_VECTOR);
  const [x, y] = decodeBytesPair(enc);
  assert.equal(toHex(x), "0xaa");
  assert.equal(toHex(y), "0xbbcc");
});

test("a proof and an authorization round-trip through the pair encoding", () => {
  const proof = encodeProof({ a: [11, 12], b: [[13, 14], [15, 16]], c: [17, 18] });
  const auth = encodeAuthorization(AUTH);
  const [p, q] = decodeBytesPair(encodeBytesPair(proof, auth));
  assert.equal(toHex(p), toHex(proof));
  assert.equal(toHex(q), toHex(auth));
  assert.equal(encodeBytesPair(proof, auth).length, 64 + 32 + 256 + 32 + 160);
});

test("malformed input is refused", () => {
  assert.throws(() => encodeProof({ a: [1], b: [[3, 4], [5, 6]], c: [7, 8] }), /a\[2\]/);
  assert.throws(() => encodeAuthorization({ ...AUTH, to: "0x1234" }), /not an address/);
  assert.throws(() => encodeAuthorization({ ...AUTH, nonce: "0x01" }), /not bytes32/);
  assert.throws(() => encodeAuthorization({ ...AUTH, value: -1n }), /outside uint256/);
  assert.throws(() => encodeAuthorization({ ...AUTH, value: 1n << 256n }), /outside uint256/);
  assert.throws(() => decodeProof(Buffer.alloc(255)), /256 bytes/);
  assert.throws(() => decodeBytesPair(Buffer.alloc(10)), /too short/);
  const pair = encodeBytesPair(fromHex("0xaa"), fromHex("0xbbcc"));
  assert.throws(() => decodeBytesPair(pair.subarray(0, 100)), /truncated/);
  assert.throws(() => fromHex("0xabc"), /not hex/);
});
