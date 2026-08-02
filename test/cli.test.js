import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReceipts } from "../src/receipts.js";

const CLI = fileURLToPath(new URL("../bin/pi-crypto-gate.js", import.meta.url));
const TO = "0x1111111111111111111111111111111111111111";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function run(args, { log, store, gateKey, cwd } = {}) {
  const env = { ...process.env };
  if (log) env.PI_CRYPTO_GATE_RECEIPT_LOG = log;
  // Keep every run's approval store off the real home directory.
  env.PI_CRYPTO_GATE_APPROVAL_DIR = store ?? mkdtempSync(join(tmpdir(), "pcg-store-"));
  env.PI_CRYPTO_GATE_APPROVER_KEY = join(env.PI_CRYPTO_GATE_APPROVAL_DIR, "approver.key");
  if (gateKey) env.PI_CRYPTO_GATE_SIGNING_KEY = gateKey;
  else delete env.PI_CRYPTO_GATE_SIGNING_KEY;
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", env, cwd });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

function freshLog() {
  return join(mkdtempSync(join(tmpdir(), "pcg-cli-")), "receipts.jsonl");
}

function freshStore() {
  return mkdtempSync(join(tmpdir(), "pcg-store-"));
}

function lastId(log) {
  return readReceipts(log).at(-1).id;
}

function tokenPolicy(dir) {
  const path = join(dir, "policy.json");
  writeFileSync(
    path,
    JSON.stringify({
      chainAllowlist: [8453],
      tokens: { [USDC]: { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "1000.0", requireApprovalOver: "100.0" } },
    }),
  );
  return path;
}

test("propose over the cap exits nonzero and prints BLOCK", () => {
  const log = freshLog();
  const r = run(["propose", "--to", TO, "--amount", "0.5eth", "--chain", "8453"], { log });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /BLOCK/);
});

test("propose under the cap exits zero and prints ALLOW", () => {
  const log = freshLog();
  const r = run(["propose", "--to", TO, "--amount", "0.005eth", "--chain", "8453"], { log });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ALLOW/);
});

test("execute refuses a blocked receipt", () => {
  const log = freshLog();
  run(["propose", "--to", TO, "--amount", "0.5eth", "--chain", "8453"], { log });
  const r = run(["execute", lastId(log)], { log });
  assert.equal(r.code, 4);
});

test("approve + execute path moves an allowed payment to executed (dry run)", () => {
  const log = freshLog();
  const store = freshStore();
  run(["propose", "--to", TO, "--amount", "0.04eth", "--chain", "8453"], { log, store }); // needs_approval
  const id = lastId(log);
  assert.equal(run(["approve", id], { log, store }).code, 0);
  const exec = run(["execute", id], { log, store });
  assert.equal(exec.code, 0);
  assert.match(exec.stdout, /no funds moved/);
});

test("a held payment cannot execute without an approval", () => {
  const log = freshLog();
  const store = freshStore();
  run(["propose", "--to", TO, "--amount", "0.04eth", "--chain", "8453"], { log, store });
  const r = run(["execute", lastId(log)], { log, store });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /grant_missing/);
});

test("an approval is spent once; the same execute cannot run twice", () => {
  const log = freshLog();
  const store = freshStore();
  run(["propose", "--to", TO, "--amount", "0.04eth", "--chain", "8453"], { log, store });
  const id = lastId(log);
  run(["approve", id], { log, store });
  assert.equal(run(["execute", id], { log, store }).code, 0);
  const replay = run(["execute", id], { log, store });
  assert.equal(replay.code, 4);
});

test("approve refuses when the approval store sits inside the working directory", () => {
  const log = freshLog();
  const cwd = mkdtempSync(join(tmpdir(), "pcg-agentroot-"));
  const store = join(cwd, ".approvals");
  run(["propose", "--to", TO, "--amount", "0.04eth", "--chain", "8453"], { log, store, cwd });
  const r = run(["approve", lastId(log)], { log, store, cwd });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /outside the agent's writable root/);
});

test("a token payment over the token cap is blocked through the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcg-tok-"));
  const log = join(dir, "receipts.jsonl");
  const r = run(
    ["propose", "--to", TO, "--amount", "1000000000000", "--token", USDC, "--chain", "8453", "--policy", tokenPolicy(dir)],
    { log },
  );
  assert.equal(r.code, 3);
  assert.match(r.stdout, /per-tx-cap-exceeded/);
  assert.match(r.stdout, /1000000 USDC/);
});

test("an unbounded allowance is blocked through the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcg-allow-"));
  const log = join(dir, "receipts.jsonl");
  const r = run(
    [
      "propose", "--to", USDC, "--amount", (2n ** 256n - 1n).toString(),
      "--token", USDC, "--action", "allowance", "--spender", TO,
      "--chain", "8453", "--policy", tokenPolicy(dir),
    ],
    { log },
  );
  assert.equal(r.code, 3);
  assert.match(r.stdout, /unlimited-allowance/);
});

test("keygen writes a key and prints its public half", () => {
  const store = freshStore();
  const r = run(["keygen", "--approver"], { store });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /public key: [A-Za-z0-9+/=]{40,}/);
  assert.match(readFileSync(join(store, "approver.key"), "utf8"), /^[A-Za-z0-9+/=]+$/m);
});

test("verify reports an intact chain and fails on an edited log", () => {
  const log = freshLog();
  const store = freshStore();
  run(["propose", "--to", TO, "--amount", "0.005eth", "--chain", "8453"], { log, store });
  const ok = run(["verify"], { log, store });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /chain intact/);

  writeFileSync(log, readFileSync(log, "utf8").replace('"5000000000000000"', '"9000000000000000"'));
  const bad = run(["verify"], { log, store });
  assert.equal(bad.code, 4);
  assert.match(bad.stdout, /content_altered/);
});

test("grants lists a minted grant and marks it consumed after execute", () => {
  const log = freshLog();
  const store = freshStore();
  run(["propose", "--to", TO, "--amount", "0.04eth", "--chain", "8453"], { log, store });
  const id = lastId(log);
  run(["approve", id], { log, store });
  assert.match(run(["grants"], { log, store }).stdout, /valid/);
  run(["execute", id], { log, store });
  assert.match(run(["grants"], { log, store }).stdout, /consumed/);
});

test("demo runs end to end and reports the block", () => {
  const r = run(["demo"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /BLOCKED as expected/);
});
