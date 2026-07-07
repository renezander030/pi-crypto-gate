import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReceipts } from "../src/receipts.js";

const CLI = fileURLToPath(new URL("../bin/pi-crypto-gate.js", import.meta.url));
const TO = "0x1111111111111111111111111111111111111111";

function run(args, { log } = {}) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: log ? { ...process.env, PI_CRYPTO_GATE_RECEIPT_LOG: log } : process.env,
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

function freshLog() {
  return join(mkdtempSync(join(tmpdir(), "pcg-cli-")), "receipts.jsonl");
}

function lastId(log) {
  return readReceipts(log).at(-1).id;
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
  run(["propose", "--to", TO, "--amount", "0.04eth", "--chain", "8453"], { log }); // needs_approval
  const id = lastId(log);
  assert.equal(run(["approve", id], { log }).code, 0);
  const exec = run(["execute", id], { log });
  assert.equal(exec.code, 0);
  assert.match(exec.stdout, /no funds moved/);
});

test("demo runs end to end and reports the block", () => {
  const r = run(["demo"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /BLOCKED as expected/);
});
