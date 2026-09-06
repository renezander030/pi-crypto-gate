// The private half of a policy: the salt that blinds the cap commitment, and
// the token the cap belongs to. Whoever holds the salt can read the cap;
// nobody can raise it. The file is written owner-only, like the keys.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { POLICY_VERSION, randomSalt, FIELD } from "./commit.js";
import { isHexAddress } from "./abi.js";

export function defaultParamsPath() {
  return process.env.PI_CRYPTO_GATE_ZK_PARAMS || join(process.cwd(), ".pi-crypto-gate", "zk-params.json");
}

export function createParams({ token, path = defaultParamsPath(), force = false, salt = randomSalt() } = {}) {
  if (!isHexAddress(token)) throw new TypeError(`not a token address: ${token}`);
  if (existsSync(path) && !force) {
    throw new Error(`${path} exists; pass --force to replace it (a new salt is a new commitment to register)`);
  }
  const params = {
    version: POLICY_VERSION,
    token: token.toLowerCase(),
    salt: BigInt(salt).toString(),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(params, null, 2) + "\n", { mode: 0o600 });
  return params;
}

export function readParams(path = defaultParamsPath()) {
  if (!existsSync(path)) {
    throw new Error(`no zk params at ${path}; create them with: pi-crypto-gate zk init --token <0xaddr>`);
  }
  const p = JSON.parse(readFileSync(path, "utf8"));
  if (p.version !== POLICY_VERSION) throw new Error(`zk params version ${p.version} is not ${POLICY_VERSION}`);
  if (!isHexAddress(p.token)) throw new Error("zk params: token is not an address");
  let salt;
  try {
    salt = BigInt(p.salt);
  } catch {
    throw new Error("zk params: salt is not an integer");
  }
  if (salt < 0n || salt >= FIELD) throw new Error("zk params: salt outside the field");
  return { ...p, token: p.token.toLowerCase(), salt: salt.toString() };
}
