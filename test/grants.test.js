import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { issueGrant, verifyGrant, claimGrant, consumeGrant, readGrant, isInside } from "../src/grants.js";
import { generateKeypair } from "../src/signing.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

const store = () => mkdtempSync(join(tmpdir(), "pcg-grants-"));

test("a signed grant verifies against the approver public key", () => {
  const dir = store();
  const { privateKey, publicKey } = generateKeypair();
  const grant = issueGrant({ actionHash: HASH, ttlSeconds: 60, privateKey }, { dir });
  assert.ok(grant.signature);
  assert.deepEqual(verifyGrant(grant, { actionHash: HASH, approverPublicKey: publicKey }), {
    valid: true,
    reason: null,
  });
});

test("a grant for one action cannot authorise another", () => {
  const dir = store();
  const { privateKey, publicKey } = generateKeypair();
  const grant = issueGrant({ actionHash: HASH, ttlSeconds: 60, privateKey }, { dir });
  const verdict = verifyGrant(grant, { actionHash: OTHER, approverPublicKey: publicKey });
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "grant_action_mismatch");
});

test("a grant signed by a different key is rejected", () => {
  const dir = store();
  const { privateKey } = generateKeypair();
  const { publicKey: strangerPub } = generateKeypair();
  const grant = issueGrant({ actionHash: HASH, ttlSeconds: 60, privateKey }, { dir });
  assert.equal(verifyGrant(grant, { actionHash: HASH, approverPublicKey: strangerPub }).reason, "grant_bad_signature");
});

test("an edited grant fails verification", () => {
  const dir = store();
  const { privateKey, publicKey } = generateKeypair();
  const grant = issueGrant({ actionHash: HASH, ttlSeconds: 60, privateKey }, { dir });
  const tampered = { ...grant, approver: "someone-else" };
  assert.equal(verifyGrant(tampered, { actionHash: HASH, approverPublicKey: publicKey }).reason, "grant_bad_signature");
});

test("an unsigned grant is rejected when the policy names an approver key", () => {
  const dir = store();
  const { publicKey } = generateKeypair();
  const grant = issueGrant({ actionHash: HASH, ttlSeconds: 60 }, { dir });
  assert.equal(grant.signature, null);
  assert.equal(verifyGrant(grant, { actionHash: HASH, approverPublicKey: publicKey }).reason, "grant_unsigned");
});

test("a grant expires", () => {
  const dir = store();
  const { privateKey, publicKey } = generateKeypair();
  const grant = issueGrant({ actionHash: HASH, ttlSeconds: 60, privateKey }, { dir });
  const later = new Date(Date.parse(grant.expiresAt) + 1000);
  assert.equal(verifyGrant(grant, { actionHash: HASH, approverPublicKey: publicKey, now: later }).reason, "grant_expired");
});

test("a missing grant is refused, not assumed", () => {
  assert.equal(verifyGrant(null, { actionHash: HASH }).reason, "grant_missing");
});

test("a grant is single use", () => {
  const dir = store();
  const { privateKey, publicKey } = generateKeypair();
  issueGrant({ actionHash: HASH, ttlSeconds: 60, privateKey }, { dir });

  const first = claimGrant({ actionHash: HASH, approverPublicKey: publicKey, dir });
  assert.equal(first.ok, true);

  const second = claimGrant({ actionHash: HASH, approverPublicKey: publicKey, dir });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "grant_already_consumed");
});

test("a spent grant stays spent even though the grant file is still readable", () => {
  const dir = store();
  const { privateKey, publicKey } = generateKeypair();
  issueGrant({ actionHash: HASH, ttlSeconds: 60, privateKey }, { dir });
  claimGrant({ actionHash: HASH, approverPublicKey: publicKey, dir });
  assert.ok(readGrant(HASH, { dir }));
  assert.equal(claimGrant({ actionHash: HASH, approverPublicKey: publicKey, dir }).reason, "grant_already_consumed");
});

test("concurrent processes claiming one grant: exactly one wins", async () => {
  const dir = store();
  const { privateKey } = generateKeypair();
  issueGrant({ actionHash: HASH, ttlSeconds: 60, privateKey }, { dir });

  const runner = join(dir, "claim.mjs");
  writeFileSync(
    runner,
    `import { consumeGrant } from ${JSON.stringify(join(ROOT, "src", "grants.js"))};\n` +
      `const r = consumeGrant(${JSON.stringify(HASH)}, { dir: ${JSON.stringify(dir)} });\n` +
      `process.stdout.write(r.ok ? "ok" : r.reason);\n`,
  );

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", () => resolve(out));
      }),
    ),
  );

  assert.equal(results.filter((r) => r === "ok").length, 1);
  assert.equal(results.filter((r) => r === "grant_already_consumed").length, 7);
});

test("consuming a grant twice in one process is refused", () => {
  const dir = store();
  assert.equal(consumeGrant(HASH, { dir }).ok, true);
  assert.equal(consumeGrant(HASH, { dir }).reason, "grant_already_consumed");
});

test("isInside recognises a store nested in the agent root", () => {
  assert.equal(isInside("/home/agent/project", "/home/agent/project/.pi-crypto-gate"), true);
  assert.equal(isInside("/home/agent/project", "/home/agent/project"), true);
  assert.equal(isInside("/home/agent/project", "/home/agent/approvals"), false);
  assert.equal(isInside("/home/agent/project", "/home/agent/project-other"), false);
});
