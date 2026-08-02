// Append-only receipt log. Every decision is recorded before any execution.
//
// Each line carries its own hash and the hash of the line before it, so the log
// is a chain: altering or removing an entry breaks every entry after it. With a
// gate key configured each line is also signed, and `verifyLog` reports both.
import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hashOf } from "./canonical.js";
import { signMessage, verifyMessage } from "./signing.js";
import { NATIVE } from "./assets.js";

export function defaultLogPath() {
  return process.env.PI_CRYPTO_GATE_RECEIPT_LOG || `${process.cwd()}/.pi-crypto-gate/receipts.jsonl`;
}

/** Read every receipt line. Returns [] if the log does not exist yet. */
export function readReceipts(logPath = defaultLogPath()) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Chain-link, hash, sign and append one record. */
function writeRecord(logPath, base, privateKey) {
  const records = readReceipts(logPath);
  const last = records.length ? records[records.length - 1] : null;
  const body = {
    seq: last ? (Number.isInteger(last.seq) ? last.seq : records.length - 1) + 1 : 0,
    prev: last ? last.hash ?? null : null,
    ...base,
  };
  const hash = hashOf(body);
  const record = { ...body, hash, sig: privateKey ? signMessage(hash, privateKey) : null };
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + "\n");
  return record;
}

/**
 * Append one receipt for an evaluation. A later lifecycle step appends a new
 * receipt rather than mutating this one.
 */
export function appendReceipt(
  evaluation,
  { logPath = defaultLogPath(), id = randomUUID(), event = "proposed", privateKey = null } = {},
) {
  return writeRecord(
    logPath,
    {
      id,
      event, // proposed | approved | executed | rejected
      status: evaluation.decision,
      at: evaluation.evaluatedAt,
      actionHash: evaluation.actionHash ?? null,
      decisionId: evaluation.decisionId ?? null,
      policyVersion: evaluation.policyVersion ?? null,
      expiresAt: evaluation.expiresAt ?? null,
      proposal: evaluation.proposal,
      reasons: evaluation.reasons,
    },
    privateKey,
  );
}

/** Append a lifecycle event (approved / executed / rejected) for an existing id. */
export function appendEvent(
  id,
  event,
  {
    logPath = defaultLogPath(),
    proposal,
    at = new Date().toISOString(),
    actionHash = null,
    detail = null,
    privateKey = null,
  } = {},
) {
  return writeRecord(
    logPath,
    { id, event, at, actionHash, detail, proposal: proposal ?? null },
    privateKey,
  );
}

/** Asset key a record's proposal moved. Records without one are native. */
function assetKeyOfRecord(record) {
  return record?.proposal?.asset?.key ?? (record?.proposal?.token ? String(record.proposal.token).toLowerCase() : NATIVE);
}

/**
 * Executed spend for the given UTC day, per asset. Executed spend, not merely
 * proposed, is what counts against a daily cap.
 * @returns {Record<string,string>} asset key -> base-unit total
 */
export function spentToday(records, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const totals = {};
  for (const r of records) {
    if (r.event !== "executed" || !r.proposal || String(r.at).slice(0, 10) !== day) continue;
    // An allowance moves nothing, so it never counts against a spend cap.
    if (r.proposal.action && r.proposal.action === "allowance") continue;
    if (r.proposal.amount === null || r.proposal.amount === undefined) continue;
    const key = assetKeyOfRecord(r);
    totals[key] = ((totals[key] ? BigInt(totals[key]) : 0n) + BigInt(r.proposal.amount)).toString();
  }
  return totals;
}

/** Native-only total for the given UTC day. */
export function spentTodayWei(records, now = new Date()) {
  return BigInt(spentToday(records, now)[NATIVE] ?? 0n);
}

/**
 * Recompute the chain and every signature.
 * @returns {{ok:boolean, count:number, signed:number, entries:Array, firstBadSeq:number|null, reason:string|null}}
 */
export function verifyLog(records, { publicKey = null } = {}) {
  const entries = [];
  let ok = true;
  let signed = 0;
  let firstBadSeq = null;
  let reason = null;
  let expectedPrev = null;

  records.forEach((record, i) => {
    const { hash, sig, ...body } = record;
    const recomputed = hashOf(body);
    const hashOk = recomputed === hash;
    const chainOk = (body.prev ?? null) === expectedPrev;
    const sigOk = sig ? (publicKey ? verifyMessage(hash, sig, publicKey) : null) : null;
    if (sig) signed += 1;
    const entryOk = hashOk && chainOk && sigOk !== false;
    if (!entryOk && ok) {
      ok = false;
      firstBadSeq = Number.isInteger(body.seq) ? body.seq : i;
      reason = !hashOk ? "content_altered" : !chainOk ? "chain_broken" : "bad_signature";
    }
    entries.push({ seq: body.seq ?? i, id: body.id, event: body.event, hashOk, chainOk, sigOk });
    expectedPrev = hash ?? null;
  });

  return { ok, count: records.length, signed, entries, firstBadSeq, reason };
}
