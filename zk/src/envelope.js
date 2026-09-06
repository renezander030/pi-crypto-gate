// The ERC-8366 envelope: what goes into the `signature` slot of
// transferWithAuthorization(). Any facilitator can carry it; the account
// decodes it, recomputes the EIP-712 digest from the cleartext authorization,
// looks up the policy registered for the nonce, and verifies the proof.
import {
  encodeProof,
  encodeAuthorization,
  encodeBytesPair,
  decodeBytesPair,
  decodeProof,
  decodeAuthorization,
  toHex,
  fromHex,
} from "./abi.js";

export function buildEnvelope({ a, b, c, to, value, validAfter = 0, validBefore, nonce }) {
  const proof = encodeProof({ a, b, c });
  const authorization = encodeAuthorization({ to, value, validAfter, validBefore, nonce });
  return {
    proof: toHex(proof),
    authorization: toHex(authorization),
    envelope: toHex(encodeBytesPair(proof, authorization)),
  };
}

/** Inverse of buildEnvelope: the (a, b, c) and the authorization fields. */
export function parseEnvelope(hex) {
  const [proof, authorization] = decodeBytesPair(fromHex(hex));
  return { ...decodeProof(proof), ...decodeAuthorization(authorization) };
}
