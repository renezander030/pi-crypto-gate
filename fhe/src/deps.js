// The sealed-policy path needs one optional peer dependency: node-seal, the
// WebAssembly build of Microsoft SEAL. The core gate has no dependencies.
const HINT = "the sealed-policy path needs node-seal: npm install node-seal";

let sealPromise;

/** The SEAL runtime, loaded once per process. */
export function loadSeal() {
  if (!sealPromise) {
    sealPromise = import("node-seal")
      .then((m) => (typeof m.default === "function" ? m.default() : m()))
      .catch((err) => {
        sealPromise = undefined;
        if (err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND")) {
          throw new Error(`node-seal is not installed; ${HINT}`);
        }
        throw err;
      });
  }
  return sealPromise;
}
