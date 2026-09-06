// Public API of the zk path. Everything here is additive to the gate: the
// gate decides exactly as before, and this turns an allow into a proof the
// chain can check without seeing the policy.
export { POLICY_VERSION, FIELD, paramsCommit, randomSalt, toBytes32 } from "./commit.js";
export { proveCapPolicy, verifyCapPolicy, proofFromCalldata, publicInputsOf, PUBLIC_INPUTS } from "./prove.js";
export { buildEnvelope, parseEnvelope } from "./envelope.js";
export { defaultParamsPath, createParams, readParams } from "./params.js";
export { ZK_ROOT, artifactPaths, missingArtifacts, assertArtifacts } from "./artifacts.js";
export { terminate } from "./deps.js";
export {
  encodeProof,
  decodeProof,
  encodeAuthorization,
  decodeAuthorization,
  encodeBytesPair,
  decodeBytesPair,
  toHex,
  fromHex,
  isHexAddress,
  isHexBytes32,
} from "./abi.js";
