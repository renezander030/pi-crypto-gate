// Optional dependencies of the zk path. The core gate has none. The zk path
// needs snarkjs (Groth16 prover and verifier) and circomlibjs (Poseidon), both
// declared as optional peer dependencies, so they exist only when installed.
const HINT = "the zk path needs snarkjs and circomlibjs: npm install snarkjs circomlibjs";

async function load(name) {
  try {
    return await import(name);
  } catch (err) {
    if (err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND")) {
      throw new Error(`${name} is not installed; ${HINT}`);
    }
    throw err;
  }
}

export const loadSnarkjs = () => load("snarkjs");
export const loadCircomlibjs = () => load("circomlibjs");

/** Release snarkjs's worker threads so a process can exit promptly. */
export async function terminate() {
  const curve = globalThis.curve_bn128;
  if (curve && typeof curve.terminate === "function") await curve.terminate();
}
