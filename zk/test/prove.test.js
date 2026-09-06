import { test, after } from "node:test";
import assert from "node:assert/strict";
import { paramsCommit } from "../src/commit.js";
import { proveCapPolicy, verifyCapPolicy, proofFromCalldata, publicInputsOf } from "../src/prove.js";
import { buildEnvelope, parseEnvelope } from "../src/envelope.js";
import { artifactPaths, missingArtifacts } from "../src/artifacts.js";
import { terminate } from "../src/deps.js";

after(() => terminate());

const paths = artifactPaths();
const missing = missingArtifacts(paths);
const skip = missing.length ? `zk artifacts missing (${missing.join(", ")}): npm run zk:build` : false;

const P = {
  cap: 250000000n,
  salt: 424242424242424242424242n,
  to: "0x3333333333333333333333333333333333333333",
  value: 150000000n,
  account: "0x000000000000000000000000000000000000ca9e",
  chainId: 31337,
};
const NONCE = "0x" + "ab".repeat(32);

async function prove(overrides = {}) {
  const input = { ...P, ...overrides };
  const commit = input.paramsCommit ?? (await paramsCommit({ cap: input.cap, salt: input.salt }));
  return proveCapPolicy({ ...input, paramsCommit: commit }, paths);
}

test("a payment under the cap proves and verifies", { skip }, async () => {
  const proved = await prove();
  assert.equal(proved.publicSignals.length, 5);
  assert.deepEqual(
    proved.publicSignals,
    publicInputsOf({ ...P, paramsCommit: await paramsCommit({ cap: P.cap, salt: P.salt }) }),
  );
  assert.equal(await verifyCapPolicy({ vkey: paths.vkey, publicSignals: proved.publicSignals, proof: proved.proof }), true);
});

test("a payment exactly at the cap proves", { skip }, async () => {
  const proved = await prove({ value: P.cap });
  assert.equal(await verifyCapPolicy({ vkey: paths.vkey, publicSignals: proved.publicSignals, proof: proved.proof }), true);
});

test("no proof exists above the cap", { skip }, async () => {
  await assert.rejects(prove({ value: P.cap + 1n }), /no proof exists/);
});

test("the salt must open the commitment", { skip }, async () => {
  const wrong = await paramsCommit({ cap: P.cap, salt: P.salt + 1n });
  await assert.rejects(prove({ paramsCommit: wrong }), /does not satisfy the circuit/);
});

test("tampering with a public input breaks verification", { skip }, async () => {
  const proved = await prove();
  const tampered = [...proved.publicSignals];
  tampered[1] = (BigInt(tampered[1]) + 1n).toString(); // value
  assert.equal(await verifyCapPolicy({ vkey: paths.vkey, publicSignals: tampered, proof: proved.proof }), false);
  const otherAccount = [...proved.publicSignals];
  otherAccount[3] = "43690"; // 0xaaaa
  assert.equal(await verifyCapPolicy({ vkey: paths.vkey, publicSignals: otherAccount, proof: proved.proof }), false);
});

test("the Solidity-ordered proof converts back to a verifiable snarkjs proof", { skip }, async () => {
  const proved = await prove();
  const back = proofFromCalldata({ a: proved.a, b: proved.b, c: proved.c });
  assert.equal(await verifyCapPolicy({ vkey: paths.vkey, publicSignals: proved.publicSignals, proof: back }), true);
});

test("the envelope round-trips and verifies from its own fields", { skip }, async () => {
  const proved = await prove();
  const env = buildEnvelope({ ...proved, to: P.to, value: P.value, validAfter: 0, validBefore: 1893456000, nonce: NONCE });
  const parsed = parseEnvelope(env.envelope);
  assert.equal(parsed.to, P.to);
  assert.equal(parsed.value, P.value);
  assert.equal(parsed.validBefore, 1893456000n);
  assert.equal(parsed.nonce, NONCE);
  const commit = await paramsCommit({ cap: P.cap, salt: P.salt });
  const publicSignals = publicInputsOf({ to: parsed.to, value: parsed.value, paramsCommit: commit, account: P.account, chainId: P.chainId });
  assert.equal(await verifyCapPolicy({ vkey: paths.vkey, publicSignals, proof: proofFromCalldata(parsed) }), true);
});
