import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReceipts } from "../src/receipts.js";
import { generateKeypair, publicKeyOf, writeKeyFile } from "../src/signing.js";

const CLI = fileURLToPath(new URL("../bin/pi-crypto-gate.js", import.meta.url));
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MERCHANT = "0x3333333333333333333333333333333333333333";

let skip = false;
try {
  await import("node-seal");
} catch {
  skip = "node-seal not installed";
}

/** The agent host is the working directory (bundle, log); the key box (keys, approval store) sits outside it,
 * exactly like the approval store in the clear gate. Every command runs from the agent host. */
function world({ approverPublicKey = null } = {}) {
  const agent = mkdtempSync(join(tmpdir(), "pcg-fhe-agent-"));
  const keybox = mkdtempSync(join(tmpdir(), "pcg-fhe-keybox-"));
  const policy = join(keybox, "policy.json");
  writeFileSync(
    policy,
    JSON.stringify({
      chainAllowlist: [31337],
      tokens: { [USDC]: { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "600.0", requireApprovalOver: "100.0" } },
      approverPublicKey,
    }),
  );
  const agentPolicy = join(agent, "policy.json");
  writeFileSync(agentPolicy, JSON.stringify({ approverPublicKey }));
  return {
    agent,
    keybox,
    policy,
    agentPolicy,
    bundle: join(agent, ".pi-crypto-gate", "fhe", "bundle"),
    keys: join(keybox, "fhe-keys"),
    store: join(keybox, "approvals"),
    log: join(agent, ".pi-crypto-gate", "receipts.jsonl"),
  };
}

function run(args, w, { cwd = w.agent } = {}) {
  const env = {
    ...process.env,
    PI_CRYPTO_GATE_RECEIPT_LOG: w.log,
    PI_CRYPTO_GATE_FHE_KEYS: w.keys,
    PI_CRYPTO_GATE_FHE_BUNDLE: w.bundle,
    PI_CRYPTO_GATE_APPROVAL_DIR: w.store,
    PI_CRYPTO_GATE_APPROVER_KEY: join(w.store, "approver.key"),
  };
  delete env.PI_CRYPTO_GATE_SIGNING_KEY;
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

const seal = (w) => run(["fhe", "seal", "--policy", w.policy, "--token", USDC], w);
const evaluate = (w, amount) => run(["fhe", "evaluate", "--to", MERCHANT, "--amount", amount, "--token", USDC, "--chain", "31337", "--json"], w);
const lastVerdict = (w) => {
  const rec = readReceipts(w.log).filter((r) => r.event === "fhe-sealed").at(-1);
  return join(w.agent, ".pi-crypto-gate", "fhe", `${rec.id}.verdict.json`);
};
/** The whole round trip for one payment: evaluate on the host, open in the key box, apply on the host. */
function pay(w, amount) {
  const ev = evaluate(w, amount);
  assert.equal(ev.code, 0, ev.stderr);
  const file = lastVerdict(w);
  const opened = run(["fhe", "open", file, "--json"], w);
  assert.equal(opened.code, 0, opened.stderr);
  const applied = run(["fhe", "apply", file, "--policy", w.agentPolicy, "--json"], w);
  return { file, opened: JSON.parse(opened.stdout), applied, decision: JSON.parse(opened.stdout).decision };
}

test("fhe without a subcommand prints usage", { skip }, () => {
  const r = run(["fhe"], world());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: pi-crypto-gate fhe seal/);
});

test("seal refuses a key box inside the working directory", { skip }, () => {
  const w = world();
  const r = run(["fhe", "seal", "--policy", w.policy, "--token", USDC, "--keys", join(w.agent, "keys")], w);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /outside the agent's root/);
  assert.equal(existsSync(join(w.agent, "keys")), false);
});

test("seal writes owner-only keys and a bundle that holds no key and no clear number", { skip }, () => {
  const w = world();
  const r = seal(w);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(statSync(join(w.keys, "keys.json")).mode & 0o777, 0o600);
  const sealed = readFileSync(join(w.bundle, "policy.sealed.json"), "utf8");
  for (const clear of ["250000000", "600000000", "100000000", "secretKey", "publicKey"]) assert.doesNotMatch(sealed, new RegExp(clear));
  assert.equal(JSON.parse(sealed).token, USDC);
  const status = run(["fhe", "status", "--keys", join(w.agent, "nokeys")], w);
  assert.match(status.stdout, /cannot open anything/);
  // Sealing again reuses the keys, so an existing bundle keeps opening.
  assert.match(seal(w).stdout, /reusing keys/);
});

test("the host seals a verdict it cannot open; the key box opens it; the host records it", { skip }, () => {
  const w = world();
  seal(w);
  const ev = evaluate(w, "150.0");
  assert.equal(ev.code, 0, ev.stderr);
  const info = JSON.parse(ev.stdout);
  assert.equal(info.proposal.amount, "150000000");
  const verdict = JSON.parse(readFileSync(info.verdict, "utf8"));
  assert.equal(verdict.opened, undefined);
  for (const k of ["dCap", "dDay", "dHold", "spentNext"]) assert.match(verdict.sealed[k], /^[A-Za-z0-9+/=]+$/);

  const noKeys = run(["fhe", "open", info.verdict, "--keys", join(w.agent, "nokeys")], w);
  assert.equal(noKeys.code, 4);
  assert.match(noKeys.stderr, /no sealed-policy keys/);

  const opened = run(["fhe", "open", info.verdict, "--json"], w);
  assert.equal(opened.code, 0, opened.stderr);
  const decision = JSON.parse(opened.stdout);
  assert.equal(decision.decision, "needs_approval");
  assert.deepEqual(decision.checks, { withinCap: true, withinDay: true, hold: true });
  assert.equal(decision.signature, null);

  const applied = run(["fhe", "apply", info.verdict, "--json"], w);
  assert.equal(applied.code, 0, applied.stderr);
  const events = readReceipts(w.log).filter((r) => r.id === info.id).map((r) => r.event);
  assert.deepEqual(events, ["fhe-sealed", "fhe-opened"]);
  assert.equal(JSON.parse(readFileSync(join(w.bundle, "ledger.sealed.json"), "utf8")).updates, 1);
  assert.equal(run(["verify"], w).code, 0);
  const again = run(["fhe", "apply", info.verdict], w);
  assert.equal(again.code, 4);
  assert.match(again.stderr, /already applied/);
});

test("the daily cap holds across payments while the total stays sealed", { skip }, () => {
  const w = world();
  seal(w);
  assert.equal(pay(w, "200.0").decision, "needs_approval");
  assert.equal(pay(w, "200.0").decision, "needs_approval");
  assert.equal(pay(w, "200.0").decision, "needs_approval");
  const fourth = pay(w, "100.0");
  assert.equal(fourth.decision, "block");
  assert.deepEqual(fourth.opened.reasons, ["daily-cap-exceeded"]);
  assert.equal(fourth.applied.code, 3);
  assert.equal(JSON.parse(readFileSync(join(w.bundle, "ledger.sealed.json"), "utf8")).updates, 3);
  const ledger = readFileSync(join(w.bundle, "ledger.sealed.json"), "utf8");
  assert.doesNotMatch(ledger, /600000000/);
});

test("over the cap is blocked without the host ever holding the cap", { skip }, () => {
  const w = world();
  seal(w);
  const r = pay(w, "300.0");
  assert.equal(r.decision, "block");
  assert.deepEqual(r.opened.reasons, ["per-tx-cap-exceeded"]);
  const small = pay(w, "50.0");
  assert.equal(small.decision, "allow");
  assert.equal(small.applied.code, 0);
});

test("a policy that names the approver key refuses a tampered or unsigned decision", { skip }, () => {
  const pair = generateKeypair();
  const priv = typeof pair === "string" ? pair : pair.privateKey ?? pair.secretKey;
  const w = world({ approverPublicKey: publicKeyOf(priv) });
  writeKeyFile(join(w.store, "approver.key"), priv);
  seal(w);
  const honest = pay(w, "50.0");
  assert.equal(honest.applied.code, 0, honest.applied.stderr);
  assert.notEqual(honest.opened.signature, null);

  // A held payment, forged into an allow: the signature no longer matches the decision.
  const ev = evaluate(w, "150.0");
  const file = lastVerdict(w);
  run(["fhe", "open", file], w);
  const v = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(v.opened.decision, "needs_approval");
  writeFileSync(file, JSON.stringify({ ...v, opened: { ...v.opened, decision: "allow", reasons: [] } }));
  const forged = run(["fhe", "apply", file, "--policy", w.agentPolicy], w);
  assert.equal(forged.code, 4);
  assert.match(forged.stderr, /signature/);
  writeFileSync(file, JSON.stringify({ ...v, opened: { ...v.opened, signature: null } }));
  const unsigned = run(["fhe", "apply", file, "--policy", w.agentPolicy], w);
  assert.equal(unsigned.code, 4);
  assert.match(unsigned.stderr, /unsigned/);
  assert.equal(ev.code, 0);
});
