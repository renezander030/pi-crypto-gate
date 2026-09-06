// Groth16 proving and verification for the cap policy circuit.
//
// The public-input vector is the one ZKSpendingPolicyAccount builds itself:
//   [to, value, paramsCommit, account, chainId]
// The prover never hands the account a public input, only the proof bytes.
import { readFileSync } from "node:fs";
import { loadSnarkjs } from "./deps.js";
import { toUint256 } from "./abi.js";

export const PUBLIC_INPUTS = ["to", "value", "paramsCommit", "account", "chainId"];

/** The five public signals, as decimal strings, in verifier order. */
export function publicInputsOf({ to, value, paramsCommit, account, chainId }) {
  return [
    BigInt(to).toString(),
    toUint256(value, "value").toString(),
    BigInt(paramsCommit).toString(),
    BigInt(account).toString(),
    BigInt(chainId).toString(),
  ];
}

/**
 * Prove that `value` is within `cap` for the policy committed as
 * `paramsCommit`, bound to (to, account, chainId).
 * Returns the snarkjs proof plus the Solidity-ordered (a, b, c).
 */
export async function proveCapPolicy({ cap, salt, to, value, paramsCommit, account, chainId }, { wasm, zkey }) {
  const v = toUint256(value, "value");
  const c = toUint256(cap, "cap");
  if (v > c) throw new Error(`no proof exists: value ${v} is above the committed cap ${c}`);
  const snarkjs = await loadSnarkjs();
  const input = {
    cap: c.toString(),
    salt: BigInt(salt).toString(),
    to: BigInt(to).toString(),
    value: v.toString(),
    paramsCommit: BigInt(paramsCommit).toString(),
    account: BigInt(account).toString(),
    chainId: BigInt(chainId).toString(),
  };
  let proved;
  try {
    proved = await snarkjs.groth16.fullProve(input, wasm, zkey);
  } catch (err) {
    throw new Error(`the witness does not satisfy the circuit (does the salt open paramsCommit?): ${err?.message ?? err}`);
  }
  const { proof, publicSignals } = proved;
  // exportSolidityCallData swaps the G2 coordinates into the order the
  // generated verifier expects; parse its output rather than re-deriving it.
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, cc] = JSON.parse(`[${calldata}]`);
  return { proof, publicSignals, a, b, c: cc };
}

/** Rebuild a snarkjs proof object from Solidity-ordered (a, b, c). */
export function proofFromCalldata({ a, b, c }) {
  const d = (x) => BigInt(x).toString();
  return {
    protocol: "groth16",
    curve: "bn128",
    pi_a: [d(a[0]), d(a[1]), "1"],
    pi_b: [
      [d(b[0][1]), d(b[0][0])],
      [d(b[1][1]), d(b[1][0])],
      ["1", "0"],
    ],
    pi_c: [d(c[0]), d(c[1]), "1"],
  };
}

/** Verify a proof against the verification key (path or parsed JSON). */
export async function verifyCapPolicy({ vkey, publicSignals, proof }) {
  const snarkjs = await loadSnarkjs();
  const key = typeof vkey === "string" ? JSON.parse(readFileSync(vkey, "utf8")) : vkey;
  return snarkjs.groth16.verify(key, publicSignals.map((s) => BigInt(s).toString()), proof);
}
