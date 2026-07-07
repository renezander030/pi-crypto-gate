// Append-only receipt log. Every proposal + decision is recorded before any
// execution, so there is an immutable trail of what the agent tried to do.
import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function defaultLogPath() {
  return process.env.PI_CRYPTO_GATE_RECEIPT_LOG || `${process.cwd()}/.pi-crypto-gate/receipts.jsonl`;
}

/**
 * Append one immutable receipt for an evaluation. Returns the stored record
 * (with its generated id). `status` starts as the gate decision; a later
 * execute step appends a *new* receipt rather than mutating this one.
 */
export function appendReceipt(evaluation, { logPath = defaultLogPath(), id = randomUUID(), event = "proposed" } = {}) {
  const record = {
    id,
    event, // proposed | approved | executed | rejected
    status: evaluation.decision,
    at: evaluation.evaluatedAt,
    proposal: evaluation.proposal,
    reasons: evaluation.reasons,
  };
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + "\n");
  return record;
}

/** Append a lifecycle event (approved / executed / rejected) for an existing id. */
export function appendEvent(id, event, { logPath = defaultLogPath(), proposal, at = new Date().toISOString() } = {}) {
  const record = { id, event, at, proposal: proposal ?? null };
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + "\n");
  return record;
}

/** Read every receipt line. Returns [] if the log does not exist yet. */
export function readReceipts(logPath = defaultLogPath()) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Sum wei of payments that were actually EXECUTED on the given UTC day.
 * Executed spend, not merely proposed, is what counts against the daily cap.
 */
export function spentTodayWei(records, now = new Date()) {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  let total = 0n;
  for (const r of records) {
    if (r.event === "executed" && r.proposal && String(r.at).slice(0, 10) === day) {
      total += BigInt(r.proposal.amount);
    }
  }
  return total;
}
