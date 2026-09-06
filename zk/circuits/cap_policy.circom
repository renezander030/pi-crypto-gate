pragma circom 2.0.0;

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";

// pi-crypto-gate spending-policy circuit, v1: a private per-transaction cap.
//
// The proof says: "this payment's value is within a cap the owner committed to
// in advance", without revealing the cap. It is the ERC-8366 policy circuit
// for pi-crypto-gate: the account contract (ZKSpendingPolicyAccount from the
// ERC-8366 reference implementation) builds the public inputs itself from the
// checked EIP-3009 authorization and the registered policy, then hands them to
// the Groth16 verifier generated from this circuit. The prover supplies the
// proof bytes and nothing else.
//
// Public inputs, in this exact order (the account's verifier vector):
//   [to, value, paramsCommit, account, chainId]
//
// Private witnesses: cap, salt.
//
// Constraints:
//   1. value <= cap, both range-checked to 64 bits first. LessEqThan(64) is
//      only sound when both inputs are already known to be below 2^64, and
//      circomlib does not check that for you. USDC has 6 decimals, so 64 bits
//      is ample headroom for any real cap.
//   2. paramsCommit == Poseidon([VERSION, cap, salt]). The salt blinds the
//      commitment: caps are small numbers, so without it a commitment could
//      be opened by trying every plausible cap.
//   3. to, account and chainId carry no policy meaning in v1. They are context
//      tags: Groth16 folds every public input into the verified statement, so
//      a proof made for one (to, account, chainId) does not verify for another.
//      Each is kept alive with a dummy square, otherwise the compiler would
//      optimise an unconstrained public input away.
//
// What v1 deliberately does not prove: a daily budget (needs a running total
// the chain can trust), a recipient allowlist (a Merkle root in the
// commitment), and a merchant-signed quote (the ERC-8366 example). Each is a
// version bump: VERSION is folded into the commitment, so a v1 proof cannot be
// replayed against a v2 policy.
template CapPolicy() {
    var VERSION = 1;

    // ---- Private witnesses ----
    signal input cap;
    signal input salt;

    // ---- Public inputs: [to, value, paramsCommit, account, chainId] ----
    signal input to;
    signal input value;
    signal input paramsCommit;
    signal input account;
    signal input chainId;

    // (1) value <= cap, range-checked.
    component valueBits = Num2Bits(64);
    valueBits.in <== value;
    component capBits = Num2Bits(64);
    capBits.in <== cap;
    component le = LessEqThan(64);
    le.in[0] <== value;
    le.in[1] <== cap;
    le.out === 1;

    // (2) paramsCommit opens the owner's committed policy.
    component pc = Poseidon(3);
    pc.inputs[0] <== VERSION;
    pc.inputs[1] <== cap;
    pc.inputs[2] <== salt;
    paramsCommit === pc.out;

    // (3) Context tags, kept alive.
    signal toSquared;
    toSquared <== to * to;
    signal accountSquared;
    accountSquared <== account * account;
    signal chainIdSquared;
    chainIdSquared <== chainId * chainId;
}

component main {public [to, value, paramsCommit, account, chainId]} = CapPolicy();
