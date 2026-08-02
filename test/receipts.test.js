import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/gate.js";
import { appendReceipt, appendEvent, readReceipts, spentToday, spentTodayWei, verifyLog } from "../src/receipts.js";
import { generateKeypair } from "../src/signing.js";
import { canonicalJson, hashOf } from "../src/canonical.js";

const TO = "0x1111111111111111111111111111111111111111";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const BASE = 8453;
const POLICY = {
  tokens: { [USDC]: { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "1000.0", requireApprovalOver: "100.0" } },
};

const logFile = () => join(mkdtempSync(join(tmpdir(), "pcg-receipts-")), "receipts.jsonl");

function seed(logPath, privateKey = null) {
  const a = evaluate({ to: TO, amount: "0.005eth", chainId: BASE, nonce: "1" });
  const ra = appendReceipt(a, { logPath, privateKey });
  appendEvent(ra.id, "executed", { logPath, proposal: a.proposal, actionHash: a.actionHash, privateKey });
  const b = evaluate({ to: TO, amount: "50.0", token: USDC, chainId: BASE, nonce: "2" }, POLICY);
  const rb = appendReceipt(b, { logPath, privateKey });
  appendEvent(rb.id, "executed", { logPath, proposal: b.proposal, actionHash: b.actionHash, privateKey });
  return { a, b };
}

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(hashOf({ b: 1, a: 2 }), hashOf({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ n: 1n }), '{"n":"1"}');
});

test("an intact log verifies", () => {
  const logPath = logFile();
  seed(logPath);
  const result = verifyLog(readReceipts(logPath));
  assert.equal(result.ok, true);
  assert.equal(result.count, 4);
  assert.equal(result.entries[0].prev ?? null, null);
});

test("every line links to the one before it", () => {
  const logPath = logFile();
  seed(logPath);
  const records = readReceipts(logPath);
  for (let i = 1; i < records.length; i++) {
    assert.equal(records[i].prev, records[i - 1].hash);
    assert.equal(records[i].seq, records[i - 1].seq + 1);
  }
});

test("editing a recorded amount is detected", () => {
  const logPath = logFile();
  seed(logPath);
  const records = readReceipts(logPath);
  records[0].proposal.amount = "999999999999999999";
  writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const result = verifyLog(readReceipts(logPath));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "content_altered");
  assert.equal(result.firstBadSeq, 0);
});

test("removing a line breaks the chain", () => {
  const logPath = logFile();
  seed(logPath);
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  lines.splice(1, 1);
  writeFileSync(logPath, lines.join("\n") + "\n");

  const result = verifyLog(readReceipts(logPath));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "chain_broken");
});

test("signed receipts verify with the gate public key and fail with a stranger's", () => {
  const logPath = logFile();
  const { privateKey, publicKey } = generateKeypair();
  const { publicKey: strangerPub } = generateKeypair();
  seed(logPath, privateKey);

  const good = verifyLog(readReceipts(logPath), { publicKey });
  assert.equal(good.ok, true);
  assert.equal(good.signed, 4);
  assert.ok(good.entries.every((e) => e.sigOk === true));

  const bad = verifyLog(readReceipts(logPath), { publicKey: strangerPub });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad_signature");
});

test("an unsigned log still chains, and reports nothing signed", () => {
  const logPath = logFile();
  seed(logPath);
  const result = verifyLog(readReceipts(logPath), { publicKey: generateKeypair().publicKey });
  assert.equal(result.ok, true);
  assert.equal(result.signed, 0);
});

test("executed spend is summed per asset", () => {
  const logPath = logFile();
  seed(logPath);
  const totals = spentToday(readReceipts(logPath));
  assert.equal(totals.native, "5000000000000000");
  assert.equal(totals[USDC], "50000000");
});

test("the native-only total ignores token spend", () => {
  const logPath = logFile();
  seed(logPath);
  assert.equal(spentTodayWei(readReceipts(logPath)), 5000000000000000n);
});

test("only executed events count toward spend", () => {
  const logPath = logFile();
  const r = evaluate({ to: TO, amount: "0.005eth", chainId: BASE, nonce: "x" });
  appendReceipt(r, { logPath });
  assert.deepEqual(spentToday(readReceipts(logPath)), {});
});

test("an executed allowance does not count as spend", () => {
  const logPath = logFile();
  const r = evaluate(
    { to: USDC, amount: "10.0", token: USDC, action: "allowance", spender: TO, chainId: BASE, nonce: "y" },
    POLICY,
  );
  const rec = appendReceipt(r, { logPath });
  appendEvent(rec.id, "executed", { logPath, proposal: r.proposal, actionHash: r.actionHash });
  assert.deepEqual(spentToday(readReceipts(logPath)), {});
});

test("spend from another UTC day is not counted", () => {
  const logPath = logFile();
  seed(logPath);
  const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000);
  assert.deepEqual(spentToday(readReceipts(logPath), tomorrow), {});
});
