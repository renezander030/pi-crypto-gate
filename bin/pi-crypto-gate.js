#!/usr/bin/env node
// pi-crypto-gate — a policy gate between an AI agent and an onchain wallet.
// An agent proposes an onchain payment; the gate allows, holds for approval,
// or blocks it, and every decision is written to an append-only receipt log.
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/gate.js";
import { normalizePolicy, loadPolicy, defaultPolicy } from "../src/policy.js";
import { formatEth } from "../src/money.js";
import {
  appendReceipt,
  appendEvent,
  readReceipts,
  spentTodayWei,
  defaultLogPath,
} from "../src/receipts.js";
import { dryRunExecute } from "../src/executor.js";

const GLYPH = { allow: "✅", needs_approval: "⏸", block: "⛔" };
const EXIT = { allow: 0, needs_approval: 0, block: 3, refused: 4, usage: 2 };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) args[key] = true;
        else {
          args[key] = next;
          i++;
        }
      }
    } else args._.push(a);
  }
  return args;
}

function resolvePolicy(args) {
  if (args.policy) return loadPolicy(args.policy);
  return normalizePolicy({});
}

function printDecision(result, { json } = {}) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label = result.decision.toUpperCase().replace("_", " ");
  console.log(`${GLYPH[result.decision] || ""}  ${label}`);
  console.log(`   ${formatEth(result.proposal.amount ?? 0n)} -> ${result.proposal.to} (chain ${result.proposal.chainId})`);
  for (const c of result.checks) {
    console.log(`   ${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  }
}

function cmdPropose(args) {
  const to = args.to;
  const amount = args.amount;
  const chainId = args.chain !== undefined ? Number(args.chain) : NaN;
  if (!to || amount === undefined || Number.isNaN(chainId)) {
    console.error("usage: pi-crypto-gate propose --to <0xaddr> --amount <0.05eth|wei> --chain <id> [--token <0xaddr>] [--memo <s>] [--policy <file>] [--json]");
    process.exit(EXIT.usage);
  }
  const logPath = args.log || defaultLogPath();
  const policy = resolvePolicy(args);
  const spent = spentTodayWei(readReceipts(logPath));
  const proposal = { to, amount, chainId, token: args.token, memo: args.memo };
  const result = evaluate(proposal, policy, spent);
  const receipt = appendReceipt(result, { logPath });
  printDecision(result, { json: args.json });
  if (!args.json) console.log(`   receipt: ${receipt.id}`);
  process.exit(EXIT[result.decision] ?? EXIT.block);
}

function cmdApprove(args) {
  const id = args._[0];
  if (!id) {
    console.error("usage: pi-crypto-gate approve <receipt-id> [--log <path>]");
    process.exit(EXIT.usage);
  }
  const logPath = args.log || defaultLogPath();
  const rec = readReceipts(logPath).find((r) => r.id === id && r.event === "proposed");
  if (!rec) {
    console.error(`no proposed receipt with id ${id}`);
    process.exit(EXIT.refused);
  }
  if (rec.status === "block") {
    console.error(`refused: receipt ${id} was BLOCKED by policy and cannot be approved`);
    process.exit(EXIT.refused);
  }
  appendEvent(id, "approved", { logPath, proposal: rec.proposal });
  console.log(`✅  approved ${id}`);
}

function cmdExecute(args) {
  const id = args._[0];
  if (!id) {
    console.error("usage: pi-crypto-gate execute <receipt-id> [--log <path>] [--json]");
    process.exit(EXIT.usage);
  }
  const logPath = args.log || defaultLogPath();
  const records = readReceipts(logPath);
  const proposed = records.find((r) => r.id === id && r.event === "proposed");
  if (!proposed) {
    console.error(`no proposed receipt with id ${id}`);
    process.exit(EXIT.refused);
  }
  const approved = records.some((r) => r.id === id && r.event === "approved");
  if (proposed.status === "block") {
    console.error(`refused: receipt ${id} was BLOCKED by policy`);
    process.exit(EXIT.refused);
  }
  if (proposed.status === "needs_approval" && !approved) {
    console.error(`refused: receipt ${id} needs a human approval first (pi-crypto-gate approve ${id})`);
    process.exit(EXIT.refused);
  }
  // Re-check against live spend at execution time (guards against two approved
  // payments both slipping past the daily cap between approval and execution).
  const spent = spentTodayWei(records);
  const recheck = evaluate(
    { ...proposed.proposal, amount: proposed.proposal.amount },
    resolvePolicy(args),
    spent,
  );
  if (recheck.decision === "block") {
    console.error(`refused: receipt ${id} would now be blocked (${recheck.reasons.join(", ")})`);
    process.exit(EXIT.refused);
  }
  const run = dryRunExecute(proposed.proposal);
  appendEvent(id, "executed", { logPath, proposal: proposed.proposal });
  if (args.json) console.log(JSON.stringify(run, null, 2));
  else console.log(`✅  executed (${run.mode}, no funds moved): ${run.preview}`);
}

function cmdReceipts(args) {
  const logPath = args.log || defaultLogPath();
  const records = readReceipts(logPath);
  if (args.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }
  if (!records.length) {
    console.log("(no receipts yet)");
    return;
  }
  for (const r of records) {
    const amt = r.proposal?.amount ? formatEth(r.proposal.amount) : "-";
    console.log(`${r.at}  ${r.event.padEnd(9)} ${(r.status || "").padEnd(14)} ${amt.padEnd(12)} ${r.id}`);
  }
}

function cmdDemo() {
  // Self-contained scripted narrative on a throwaway log. Proves the gate
  // end to end: allow -> hold-for-approval -> block, funds never move.
  const logPath = join(tmpdir(), "pi-crypto-gate-demo-receipts.jsonl");
  if (existsSync(logPath)) rmSync(logPath);
  const chain = 8453; // Base
  const alice = "0x1111111111111111111111111111111111111111";
  const p = defaultPolicy();

  const line = (s = "") => console.log(s);
  line("pi-crypto-gate demo");
  line(`policy: per-tx <= ${formatEth(p.maxPerTxWei)}, per-day <= ${formatEth(p.maxPerDayWei)}, approve >= ${formatEth(p.requireApprovalOverWei)}, chains [8453, 84532]`);
  line();

  const step = (title, proposal) => {
    const spent = spentTodayWei(readReceipts(logPath));
    const result = evaluate(proposal, {}, spent);
    const rec = appendReceipt(result, { logPath });
    line(`# ${title}`);
    printDecision(result);
    line(`   receipt: ${rec.id}`);
    line();
    return { result, id: rec.id };
  };

  line("Agent proposes a tiny tip. Under every cap -> auto-allowed.");
  step("propose 0.005 ETH", { to: alice, amount: "0.005eth", chainId: chain, memo: "api credits" });

  line("Agent proposes a mid-size payment. Under the caps but over the approval");
  line("threshold, so it is HELD until a human approves.");
  const held = step("propose 0.04 ETH", { to: alice, amount: "0.04eth", chainId: chain, memo: "contractor" });
  appendEvent(held.id, "approved", { logPath, proposal: held.result.proposal });
  const run = dryRunExecute(held.result.proposal);
  appendEvent(held.id, "executed", { logPath, proposal: held.result.proposal });
  line(`   human approved -> executed (${run.mode}, no funds moved)`);
  line();

  line("Now the failing case. The agent tries to move 0.5 ETH in one shot,");
  line("10x the per-tx cap. The gate BLOCKS it. This is the proof.");
  const blocked = step("propose 0.5 ETH", { to: alice, amount: "0.5eth", chainId: chain, memo: "oops" });
  line();
  line(`Result: ${blocked.result.decision === "block" ? "BLOCKED as expected. No transaction left this process." : "UNEXPECTED: not blocked"}`);
  line(`Full audit trail: ${logPath}`);
}

const HELP = `pi-crypto-gate — a policy gate between an AI agent and an onchain wallet

An agent proposes an onchain payment; the gate allows it, holds it for human
approval, or blocks it. Every decision is written to an append-only log.
Pairs with pi-gate; designed to sit downstream of a crypto screener.

Usage:
  pi-crypto-gate demo                     Run the end-to-end demo (allow -> hold -> block)
  pi-crypto-gate propose --to <0xaddr> --amount <0.05eth|wei> --chain <id>
                                          [--token <0xaddr>] [--memo <s>] [--policy <file>] [--json]
  pi-crypto-gate approve <receipt-id>     Approve a payment that the gate held
  pi-crypto-gate execute <receipt-id>     Dry-run "broadcast" an allowed/approved payment (no funds move)
  pi-crypto-gate receipts [--json]        Show the audit trail
  pi-crypto-gate help

Exit codes: allow/approval-pending = 0, blocked = 3, refused = 4, usage = 2.
Log path: $PI_CRYPTO_GATE_RECEIPT_LOG or ./.pi-crypto-gate/receipts.jsonl`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "propose": return cmdPropose(args);
    case "approve": return cmdApprove(args);
    case "execute": return cmdExecute(args);
    case "receipts": return cmdReceipts(args);
    case "demo": return cmdDemo();
    case "help": case "--help": case "-h": case undefined:
      console.log(HELP); return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(EXIT.usage);
  }
}

main();
