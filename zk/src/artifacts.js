// Where the circuit artifacts live.
//   zk/build/cap_policy_js/cap_policy.wasm   witness generator, built locally (npm run zk:build)
//   zk/artifacts/cap_policy.zkey              proving key from the committed dev ceremony
//   zk/artifacts/verification_key.json        its verification key
// PI_CRYPTO_GATE_ZK_DIR points all three at one directory instead.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ZK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function artifactPaths(dir = process.env.PI_CRYPTO_GATE_ZK_DIR) {
  if (dir) {
    return {
      wasm: join(dir, "cap_policy.wasm"),
      zkey: join(dir, "cap_policy.zkey"),
      vkey: join(dir, "verification_key.json"),
    };
  }
  return {
    wasm: join(ZK_ROOT, "build", "cap_policy_js", "cap_policy.wasm"),
    zkey: join(ZK_ROOT, "artifacts", "cap_policy.zkey"),
    vkey: join(ZK_ROOT, "artifacts", "verification_key.json"),
  };
}

export function missingArtifacts(paths = artifactPaths()) {
  return Object.entries(paths)
    .filter(([, p]) => !existsSync(p))
    .map(([k]) => k);
}

export function assertArtifacts(paths = artifactPaths()) {
  const missing = missingArtifacts(paths);
  if (missing.length) {
    throw new Error(`zk artifacts missing (${missing.join(", ")}); build them with: npm run zk:build`);
  }
  return paths;
}
