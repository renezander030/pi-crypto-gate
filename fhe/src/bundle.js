// Files of the sealed policy.
//
//   key box (outside the agent's root, next to the approval store)
//     <keys>/keys.json           parameters, secret key, public key   mode 600
//
//   agent host
//     <bundle>/params.txt        the encryption parameters
//     <bundle>/policy.sealed.json  token, decimals, and the sealed cap, daily cap, threshold, a sealed zero
//     <bundle>/ledger.sealed.json  the sealed running total for the current UTC day
//     <log dir>/fhe/<id>.verdict.json  one sealed verdict per proposal
//
// The bundle carries no key and no clear number beyond the token and its decimals.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { approvalDir } from "../../src/grants.js";

export const BUNDLE_VERSION = 1;

export function defaultKeysDir() {
  return process.env.PI_CRYPTO_GATE_FHE_KEYS || join(approvalDir(), "fhe-keys");
}

export function defaultBundleDir() {
  return process.env.PI_CRYPTO_GATE_FHE_BUNDLE || join(process.cwd(), ".pi-crypto-gate", "fhe", "bundle");
}

function writeJson(path, value, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode });
}

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`no ${what} at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function keysPath(dir = defaultKeysDir()) {
  return join(dir, "keys.json");
}

export function writeKeys(dir, keys) {
  const record = { version: BUNDLE_VERSION, createdAt: new Date().toISOString(), ...keys };
  writeJson(keysPath(dir), record, 0o600);
  return record;
}

export function readKeys(dir = defaultKeysDir()) {
  const k = readJson(keysPath(dir), "sealed-policy keys (create them with: pi-crypto-gate fhe seal)");
  if (k.version !== BUNDLE_VERSION || !k.params || !k.secretKey || !k.publicKey) throw new Error(`${keysPath(dir)}: not a keys file`);
  return k;
}

export function hasKeys(dir = defaultKeysDir()) {
  return existsSync(keysPath(dir));
}

export function writeBundle(dir, { params, policy, ledger }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "params.txt"), params + "\n");
  writeJson(join(dir, "policy.sealed.json"), { version: BUNDLE_VERSION, ...policy });
  writeLedger(dir, ledger);
}

export function writeLedger(dir, ledger) {
  writeJson(join(dir, "ledger.sealed.json"), { version: BUNDLE_VERSION, ...ledger });
}

export function readBundle(dir = defaultBundleDir()) {
  const paramsPath = join(dir, "params.txt");
  if (!existsSync(paramsPath)) throw new Error(`no sealed-policy bundle at ${dir} (the key box creates one with: pi-crypto-gate fhe seal)`);
  const params = readFileSync(paramsPath, "utf8").trim();
  const policy = readJson(join(dir, "policy.sealed.json"), "sealed policy");
  const ledger = readJson(join(dir, "ledger.sealed.json"), "sealed ledger");
  for (const k of ["cap", "daily", "threshold", "zero"]) {
    if (typeof policy[k] !== "string") throw new Error(`policy.sealed.json: missing sealed ${k}`);
  }
  if (typeof ledger.spent !== "string") throw new Error("ledger.sealed.json: missing sealed total");
  return { dir, params, policy, ledger };
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function defaultVerdictPath(logPath, id) {
  return join(dirname(logPath), "fhe", `${id}.verdict.json`);
}

export function writeVerdict(path, verdict) {
  writeJson(path, verdict, 0o600);
}

export function readVerdict(path) {
  const v = readJson(path, "sealed verdict");
  if (v.version !== BUNDLE_VERSION || !v.sealed || !v.proposal) throw new Error(`${path}: not a sealed verdict`);
  return v;
}
