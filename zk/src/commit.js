// The policy commitment. The owner registers Poseidon([VERSION, cap, salt]) on
// the account; the cap and the salt stay off chain. The circuit opens the same
// preimage, so the two Poseidon implementations (circomlibjs here, circomlib
// in the circuit) must agree to the byte. zk/test/commit.test.js pins a value
// that the circuit proved against.
import { randomBytes } from "node:crypto";
import { loadCircomlibjs } from "./deps.js";

export const POLICY_VERSION = 1;

/** BN254 scalar field order: every circuit signal lives below it. */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let poseidonPromise;
function poseidon() {
  if (!poseidonPromise) poseidonPromise = loadCircomlibjs().then((m) => m.buildPoseidon());
  return poseidonPromise;
}

/** Poseidon([version, cap, salt]) as a bigint. */
export async function paramsCommit({ version = POLICY_VERSION, cap, salt }) {
  const inputs = [BigInt(version), BigInt(cap), BigInt(salt)];
  for (const x of inputs) {
    if (x < 0n || x >= FIELD) throw new RangeError("commitment input outside the field");
  }
  const p = await poseidon();
  return p.F.toObject(p(inputs));
}

/** 248 random bits: comfortably below the field, far beyond guessing. */
export function randomSalt() {
  return BigInt("0x" + randomBytes(31).toString("hex"));
}

/** bytes32 hex of a field element, the form allowPolicy() takes. */
export function toBytes32(n) {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 256n) throw new RangeError("not representable as bytes32");
  return "0x" + v.toString(16).padStart(64, "0");
}
