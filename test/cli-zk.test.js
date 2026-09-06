import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReceipts } from "../src/receipts.js";
import { artifactPaths, missingArtifacts } from "../zk/src/artifacts.js";

const CLI = fileURLToPath(new URL("../bin/pi-crypto-gate.js", import.meta.url));
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MERCHANT = "0x3333333333333333333333333333333333333333";
const ACCOUNT = "0x000000000000000000000000000000000000ca9e";

const missing = missingArtifacts(artifactPaths());
const needsArtifacts = missing.length ? `zk artifacts missing (${missing.join(", ")}): npm run zk:build` : false;

function workspace({ requireApprovalOver = "250.0" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pcg-zk-"));
  const policy = join(dir, "policy.json");
  writeFileSync(
    policy,
    JSON.stringify({
      chainAllowlist: [31337],
      tokens: { [USDC]: { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "1000.0", requireApprovalOver } },
    }),
  );
  return {
    dir,
    policy,
    log: join(dir, "receipts.jsonl"),
    params: join(dir, "zk-params.json"),
    // The approval store must sit outside the working directory, as in production.
    store: mkdtempSync(join(tmpdir(), "pcg-zk-store-")),
  };
}

function run(args, ws) {
  const env = {
    ...process.env,
    PI_CRYPTO_GATE_RECEIPT_LOG: ws.log,
    PI_CRYPTO_GATE_ZK_PARAMS: ws.params,
    PI_CRYPTO_GATE_APPROVAL_DIR: ws.store,
    PI_CRYPTO_GATE_APPROVER_KEY: join(ws.store, "approver.key"),
  };
  delete env.PI_CRYPTO_GATE_SIGNING_KEY;
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", env, cwd: ws.dir, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

const lastId = (log) => readReceipts(log).at(-1).id;
const propose = (ws, amount) =>
  run(["propose", "--to", MERCHANT, "--amount", amount, "--token", USDC, "--chain", "31337", "--policy", ws.policy], ws);

test("zk without a subcommand prints usage", () => {
  const r = run(["zk"], workspace());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: pi-crypto-gate zk init/);
});

test("zk init writes owner-only params and zk commit derives a bytes32 commitment", () => {
  const ws = workspace();
  const init = run(["zk", "init", "--token", USDC], ws);
  assert.equal(init.code, 0, init.stderr);
  const params = JSON.parse(readFileSync(ws.params, "utf8"));
  assert.equal(params.version, 1);
  assert.equal(params.token, USDC);
  assert.match(params.salt, /^\d+$/);

  const again = run(["zk", "init", "--token", USDC], ws);
  assert.equal(again.code, 4);
  assert.match(again.stderr, /--force/);

  const commit = run(["zk", "commit", "--policy", ws.policy, "--json"], ws);
  assert.equal(commit.code, 0, commit.stderr);
  const out = JSON.parse(commit.stdout);
  assert.match(out.paramsCommit, /^0x[0-9a-f]{64}$/);
  assert.equal(out.cap, "250000000");
  assert.match(out.capFormatted, /^250(\.0+)? USDC$/);
  assert.equal(out.token, USDC);

  // Same salt, same cap: the commitment is stable, so it can be registered once.
  const repeat = JSON.parse(run(["zk", "commit", "--policy", ws.policy, "--json"], ws).stdout);
  assert.equal(repeat.paramsCommit, out.paramsCommit);
});

test("zk commit needs the token configured in the policy", () => {
  const ws = workspace();
  run(["zk", "init", "--token", "0x000000000000000000000000000000000000dead"], ws);
  const r = run(["zk", "commit", "--policy", ws.policy], ws);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /policy.tokens has no entry/);
});

test("zk prove refuses a blocked receipt, and needs an account", () => {
  const ws = workspace();
  run(["zk", "init", "--token", USDC], ws);
  assert.equal(propose(ws, "1000.0").code, 3);
  const id = lastId(ws.log);
  const r = run(["zk", "prove", id, "--account", ACCOUNT, "--policy", ws.policy], ws);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /BLOCKED/);
  assert.equal(run(["zk", "prove", id], ws).code, 2);
  assert.equal(run(["zk", "prove", "no-such-id", "--account", ACCOUNT], ws).code, 4);
});

test("zk prove refuses a held payment until a human approves it", () => {
  const ws = workspace({ requireApprovalOver: "100.0" });
  run(["zk", "init", "--token", USDC], ws);
  assert.equal(propose(ws, "150.0").code, 0);
  const id = lastId(ws.log);
  const held = run(["zk", "prove", id, "--account", ACCOUNT, "--policy", ws.policy], ws);
  assert.equal(held.code, 4);
  assert.match(held.stderr, /held for a human/);
  const approve = run(["approve", id, "--policy", ws.policy], ws);
  assert.equal(approve.code, 0, approve.stderr);
  const after = run(["zk", "prove", id, "--account", ACCOUNT, "--policy", ws.policy], ws);
  assert.doesNotMatch(after.stderr, /held for a human/);
});

test("zk prove turns an allowed receipt into an envelope that zk verify accepts", { skip: needsArtifacts }, () => {
  const ws = workspace();
  run(["zk", "init", "--token", USDC], ws);
  assert.equal(propose(ws, "150.0").code, 0);
  const id = lastId(ws.log);
  const out = join(ws.dir, "envelope.json");
  const proved = run(["zk", "prove", id, "--account", ACCOUNT, "--policy", ws.policy, "--out", out, "--json"], ws);
  assert.equal(proved.code, 0, proved.stderr);
  const env = JSON.parse(proved.stdout);
  assert.equal(env.value, "150000000");
  assert.equal(env.chainId, 31337);
  assert.equal(env.account, ACCOUNT);
  assert.equal(env.nonce, `0x${readReceipts(ws.log)[0].actionHash}`);
  assert.match(env.envelope, /^0x[0-9a-f]+$/);
  assert.equal(env.settle.args[6], env.envelope);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).envelope, env.envelope);

  // The receipt chain records that a proof was issued for this decision.
  const events = readReceipts(ws.log).filter((r) => r.id === id).map((r) => r.event);
  assert.deepEqual(events, ["proposed", "proved"]);
  assert.equal(run(["verify"], ws).code, 0);

  const ok = run(["zk", "verify", out], ws);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /envelope verifies/);

  // Presenting the same proof for another account: the public inputs change, the proof fails.
  const tampered = join(ws.dir, "tampered.json");
  writeFileSync(tampered, JSON.stringify({ ...env, account: "0x000000000000000000000000000000000000acc2" }));
  const bad = run(["zk", "verify", tampered], ws);
  assert.equal(bad.code, 4);
  assert.match(bad.stdout, /does not verify/);
});
