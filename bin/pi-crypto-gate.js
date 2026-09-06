#!/usr/bin/env node
// pi-crypto-gate — a policy gate between an AI agent and an onchain wallet.
// An agent proposes an onchain action; the gate allows, holds for approval, or
// blocks it, and every decision is written to a signed append-only receipt log.
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/gate.js";
import { normalizePolicy, loadPolicy } from "../src/policy.js";
import { formatAsset } from "../src/assets.js";
import {
  appendReceipt,
  appendEvent,
  readReceipts,
  spentToday,
  verifyLog,
  defaultLogPath,
} from "../src/receipts.js";
import {
  approvalDir,
  approverKeyPath,
  issueGrant,
  claimGrant,
  listGrants,
  isInside,
} from "../src/grants.js";
import {
  generateKeypair,
  publicKeyOf,
  writeKeyFile,
  readKeyFile,
  isKeyFileExposed,
} from "../src/signing.js";
import { dryRunExecute } from "../src/executor.js";

const GLYPH = { allow: "✅", needs_approval: "⏸", block: "⛔" };
const EXIT = { allow: 0, needs_approval: 0, block: 3, refused: 4, usage: 2 };

const GRANT_HELP = {
  grant_missing: "no approval grant for this action",
  grant_expired: "the approval grant has expired",
  grant_action_mismatch: "the grant does not match this action",
  grant_unsigned: "the grant carries no approver signature",
  grant_bad_signature: "the grant signature does not match policy.approverPublicKey",
  grant_already_consumed: "that approval was already spent; a retry needs a new one",
};

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

/** Key that signs receipt lines. Absent => receipts are written unsigned. */
function gateKey() {
  return readKeyFile(process.env.PI_CRYPTO_GATE_SIGNING_KEY);
}

function printDecision(result, { json } = {}) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label = result.decision.toUpperCase().replace("_", " ");
  const asset = result.proposal.asset;
  const target = result.proposal.action === "allowance" ? result.proposal.spender ?? result.proposal.to : result.proposal.to;
  console.log(`${GLYPH[result.decision] || ""}  ${label}`);
  console.log(
    `   ${result.proposal.action}  ${formatAsset(result.proposal.amount ?? 0n, asset)} -> ${target} (chain ${result.proposal.chainId})`,
  );
  for (const c of result.checks) {
    console.log(`   ${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  }
}

function cmdPropose(args) {
  const to = args.to;
  const amount = args.amount;
  const chainId = args.chain !== undefined ? Number(args.chain) : NaN;
  if (!to || amount === undefined || Number.isNaN(chainId)) {
    console.error(
      "usage: pi-crypto-gate propose --to <0xaddr> --amount <0.05eth|units> --chain <id>\n" +
        "                             [--token <0xaddr>] [--action value_transfer|allowance|trade|external_payment]\n" +
        "                             [--spender <0xaddr>] [--memo <s>] [--policy <file>] [--json]",
    );
    process.exit(EXIT.usage);
  }
  const logPath = args.log || defaultLogPath();
  const policy = resolvePolicy(args);
  const records = readReceipts(logPath);
  // The nonce makes two otherwise identical proposals distinct actions, so an
  // approval for one can never authorise the other.
  const nonce = `${Date.now()}-${records.length}`;
  const proposal = {
    to,
    amount,
    chainId,
    token: args.token === true ? undefined : args.token,
    action: args.action === true ? undefined : args.action,
    spender: args.spender === true ? undefined : args.spender,
    memo: args.memo === true ? undefined : args.memo,
    nonce,
  };
  const result = evaluate(proposal, policy, spentToday(records));
  const receipt = appendReceipt(result, { logPath, privateKey: gateKey() });
  printDecision(result, { json: args.json });
  if (!args.json) {
    console.log(`   receipt: ${receipt.id}`);
    if (result.decision === "needs_approval") {
      console.log(`   approve with: pi-crypto-gate approve ${receipt.id}`);
      console.log(`   grant valid until: ${result.expiresAt}`);
    }
  }
  process.exit(EXIT[result.decision] ?? EXIT.block);
}

function cmdApprove(args) {
  const id = args._[0];
  if (!id) {
    console.error("usage: pi-crypto-gate approve <receipt-id> [--log <path>] [--policy <file>] [--approver <name>]");
    process.exit(EXIT.usage);
  }
  const logPath = args.log || defaultLogPath();
  const policy = resolvePolicy(args);
  const rec = readReceipts(logPath).find((r) => r.id === id && r.event === "proposed");
  if (!rec) {
    console.error(`no proposed receipt with id ${id}`);
    process.exit(EXIT.refused);
  }
  if (rec.status === "block") {
    console.error(`refused: receipt ${id} was BLOCKED by policy and cannot be approved`);
    process.exit(EXIT.refused);
  }
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) {
    console.error(`refused: receipt ${id} passed its approval window (${rec.expiresAt})`);
    process.exit(EXIT.refused);
  }

  // Approval authority must not sit where the agent can reach it.
  const keyPath = approverKeyPath();
  const dir = approvalDir();
  if (isInside(process.cwd(), dir) || isInside(process.cwd(), keyPath)) {
    console.error(
      `refused: the approval store is inside the working directory (${dir}).\n` +
        "Approval authority must live outside the agent's writable root.\n" +
        "Set PI_CRYPTO_GATE_APPROVAL_DIR to a path the agent cannot write.",
    );
    process.exit(EXIT.refused);
  }
  const privateKey = readKeyFile(keyPath);
  if (policy.approverPublicKey && !privateKey) {
    console.error(
      `refused: policy requires a signed approval but no approver key at ${keyPath}.\n` +
        "Create one with: pi-crypto-gate keygen --approver",
    );
    process.exit(EXIT.refused);
  }
  if (privateKey && isKeyFileExposed(keyPath)) {
    console.error(`refused: approver key ${keyPath} is readable beyond its owner; chmod 600 it`);
    process.exit(EXIT.refused);
  }
  if (privateKey && policy.approverPublicKey && publicKeyOf(privateKey) !== policy.approverPublicKey) {
    console.error("refused: the approver key does not match policy.approverPublicKey");
    process.exit(EXIT.refused);
  }

  const grant = issueGrant({
    actionHash: rec.actionHash,
    decisionId: rec.decisionId,
    policyVersion: rec.policyVersion,
    ttlSeconds: policy.approvalTtlSeconds,
    approver: args.approver === true || !args.approver ? "human" : args.approver,
    privateKey,
  });
  appendEvent(id, "approved", {
    logPath,
    proposal: rec.proposal,
    actionHash: rec.actionHash,
    detail: { approver: grant.approver, expiresAt: grant.expiresAt, signed: Boolean(grant.signature) },
    privateKey: gateKey(),
  });
  console.log(`✅  approved ${id}`);
  console.log(`   action:  ${rec.actionHash}`);
  console.log(`   expires: ${grant.expiresAt}`);
  console.log(`   signed:  ${grant.signature ? "yes" : "no (no approver key configured)"}`);
}

function cmdExecute(args) {
  const id = args._[0];
  if (!id) {
    console.error("usage: pi-crypto-gate execute <receipt-id> [--log <path>] [--policy <file>] [--json]");
    process.exit(EXIT.usage);
  }
  const logPath = args.log || defaultLogPath();
  const policy = resolvePolicy(args);
  const records = readReceipts(logPath);
  const proposed = records.find((r) => r.id === id && r.event === "proposed");
  if (!proposed) {
    console.error(`no proposed receipt with id ${id}`);
    process.exit(EXIT.refused);
  }
  if (proposed.status === "block") {
    console.error(`refused: receipt ${id} was BLOCKED by policy`);
    process.exit(EXIT.refused);
  }
  if (records.some((r) => r.id === id && r.event === "executed")) {
    console.error(`refused: receipt ${id} was already executed`);
    process.exit(EXIT.refused);
  }

  // Re-check against live spend, so an approval granted earlier cannot slip past
  // a cap that later payments have since consumed.
  const recheck = evaluate({ ...proposed.proposal }, policy, spentToday(records));
  if (recheck.decision === "block") {
    console.error(`refused: receipt ${id} would now be blocked (${recheck.reasons.join(", ")})`);
    process.exit(EXIT.refused);
  }

  // A held payment needs a valid grant, spent here and never reusable.
  if (proposed.status === "needs_approval") {
    const claim = claimGrant({
      actionHash: proposed.actionHash,
      approverPublicKey: policy.approverPublicKey,
    });
    if (!claim.ok) {
      console.error(`refused: ${GRANT_HELP[claim.reason] ?? claim.reason} (${claim.reason})`);
      process.exit(EXIT.refused);
    }
  }

  const run = dryRunExecute(proposed.proposal);
  appendEvent(id, "executed", {
    logPath,
    proposal: proposed.proposal,
    actionHash: proposed.actionHash,
    privateKey: gateKey(),
  });
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
    const amt = r.proposal?.amount ? formatAsset(r.proposal.amount, r.proposal.asset) : "-";
    console.log(
      `${String(r.seq ?? "").padStart(3)}  ${r.at}  ${r.event.padEnd(9)} ${(r.status || "").padEnd(14)} ${amt.padEnd(16)} ${r.id}`,
    );
  }
}

function cmdVerify(args) {
  const logPath = args.log || defaultLogPath();
  const records = readReceipts(logPath);
  const policy = resolvePolicy(args);
  const publicKey = args.pubkey && args.pubkey !== true ? args.pubkey : policy.gatePublicKey ?? null;
  const result = verifyLog(records, { publicKey });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : EXIT.refused);
  }
  console.log(`${result.ok ? "✅" : "⛔"}  ${logPath}`);
  console.log(`   entries: ${result.count}   signed: ${result.signed}`);
  if (publicKey) {
    const verified = result.entries.filter((e) => e.sigOk === true).length;
    console.log(`   signatures verified: ${verified}/${result.signed}`);
  } else if (result.signed) {
    console.log("   signatures present but no public key given (--pubkey <base64>)");
  }
  if (!result.ok) {
    console.log(`   FAILED at seq ${result.firstBadSeq}: ${result.reason}`);
    process.exit(EXIT.refused);
  }
  console.log("   chain intact");
}

function cmdKeygen(args) {
  const wantGate = Boolean(args.gate);
  const wantApprover = Boolean(args.approver) || !wantGate;
  const { privateKey, publicKey } = generateKeypair();
  const path =
    args.out && args.out !== true
      ? args.out
      : wantGate
        ? process.env.PI_CRYPTO_GATE_SIGNING_KEY || join(approvalDir(), "gate.key")
        : approverKeyPath();
  if (existsSync(path) && !args.force) {
    console.error(`refused: ${path} exists (pass --force to replace)`);
    process.exit(EXIT.refused);
  }
  writeKeyFile(path, privateKey);
  console.log(`✅  ${wantGate ? "gate" : "approver"} key written to ${path} (0600)`);
  console.log(`   public key: ${publicKey}`);
  if (wantApprover) console.log(`   add to your policy as "approverPublicKey"`);
  else console.log(`   verify receipts with: pi-crypto-gate verify --pubkey ${publicKey}`);
}

function cmdGrants(args) {
  const grants = listGrants();
  if (args.json) {
    console.log(JSON.stringify(grants, null, 2));
    return;
  }
  if (!grants.length) {
    console.log(`(no grants in ${approvalDir()})`);
    return;
  }
  for (const g of grants) {
    const state = g.consumed ? "consumed" : Date.parse(g.expiresAt) <= Date.now() ? "expired" : "valid";
    console.log(`${g.issuedAt}  ${state.padEnd(9)} ${g.signature ? "signed  " : "unsigned"} ${g.actionHash}`);
  }
}

function cmdDemo() {
  // Self-contained narrative on a throwaway log and approval store.
  const root = mkdtempSync(join(tmpdir(), "pi-crypto-gate-demo-"));
  const logPath = join(root, "receipts.jsonl");
  const store = join(root, "approvals");
  process.env.PI_CRYPTO_GATE_APPROVAL_DIR = store;
  if (existsSync(logPath)) rmSync(logPath);

  const chain = 8453; // Base
  const alice = "0x1111111111111111111111111111111111111111";
  const drainer = "0x2222222222222222222222222222222222222222";
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

  const { privateKey: approverKey, publicKey: approverPub } = generateKeypair();
  const { privateKey: gatePriv, publicKey: gatePub } = generateKeypair();
  const policy = normalizePolicy({
    recipientDenylist: [drainer],
    tokens: { [usdc]: { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "1000.0", requireApprovalOver: "100.0" } },
    approverPublicKey: approverPub,
    approvalTtlSeconds: 900,
  });

  const line = (s = "") => console.log(s);
  line("pi-crypto-gate demo");
  line(`native:  per-tx <= ${formatAsset(policy.maxPerTxWei, { symbol: "ETH", decimals: 18 })}, per-day <= ${formatAsset(policy.maxPerDayWei, { symbol: "ETH", decimals: 18 })}`);
  line(`USDC:    per-tx <= 250 USDC, per-day <= 1000 USDC, approve >= 100 USDC`);
  line(`chains:  [8453, 84532]   denylist: 1   approver key: configured`);
  line();

  let n = 0;
  const step = (title, proposal) => {
    const records = readReceipts(logPath);
    const result = evaluate({ ...proposal, nonce: `demo-${n++}` }, policy, spentToday(records));
    const rec = appendReceipt(result, { logPath, privateKey: gatePriv });
    line(`# ${title}`);
    printDecision(result);
    line();
    return { result, id: rec.id };
  };

  line("A tiny tip, under every cap.");
  step("propose 0.005 ETH", { to: alice, amount: "0.005eth", chainId: chain, memo: "api credits" });

  line("Over the approval threshold, so it is held. A human mints a grant bound");
  line("to this exact action; executing spends the grant.");
  const held = step("propose 0.04 ETH", { to: alice, amount: "0.04eth", chainId: chain, memo: "contractor" });
  const grant = issueGrant({
    actionHash: held.result.actionHash,
    decisionId: held.result.decisionId,
    policyVersion: held.result.policyVersion,
    ttlSeconds: policy.approvalTtlSeconds,
    privateKey: approverKey,
  }, { dir: store });
  line(`   human approved -> grant ${grant.signature ? "signed" : "unsigned"}, expires ${grant.expiresAt}`);
  const claim = claimGrant({ actionHash: held.result.actionHash, approverPublicKey: approverPub, dir: store });
  const run = dryRunExecute(held.result.proposal);
  appendEvent(held.id, "executed", { logPath, proposal: held.result.proposal, actionHash: held.result.actionHash, privateKey: gatePriv });
  line(`   executed (${run.mode}, no funds moved), grant claimed: ${claim.ok}`);
  const replay = claimGrant({ actionHash: held.result.actionHash, approverPublicKey: approverPub, dir: store });
  line(`   replaying that same approval -> ${replay.reason}`);
  line();

  line("The failing cases. Nothing below leaves this process.");
  line();

  line("1. Ten times the per-tx cap in native ETH.");
  const blockedEth = step("propose 0.5 ETH", { to: alice, amount: "0.5eth", chainId: chain, memo: "oops" });

  line("2. A million USDC. Caps are per asset, so token units are measured");
  line("   against the token's own cap.");
  const blockedUsdc = step("propose 1,000,000 USDC", { to: alice, amount: "1000000.0", token: usdc, chainId: chain, memo: "oops" });

  line("3. An unbounded ERC-20 approval to a denylisted spender.");
  const blockedAllowance = step("propose unlimited allowance", {
    to: usdc,
    amount: (2n ** 256n - 1n).toString(),
    token: usdc,
    action: "allowance",
    spender: drainer,
    chainId: chain,
    memo: "approve(spender, MAX_UINT256)",
  });

  const verdict = verifyLog(readReceipts(logPath), { publicKey: gatePub });
  const allBlocked = [blockedEth, blockedUsdc, blockedAllowance].every((s) => s.result.decision === "block");
  line(`Result: ${allBlocked ? "all three BLOCKED as expected." : "UNEXPECTED: something was not blocked"}`);
  line(`Receipt log: ${verdict.count} entries, chain ${verdict.ok ? "intact" : "BROKEN"}, ${verdict.signed} signed`);
  line(`Full audit trail: ${logPath}`);
}

const HELP = `pi-crypto-gate — a policy gate between an AI agent and an onchain wallet

An agent proposes an onchain action; the gate allows it, holds it for human
approval, or blocks it. Every decision is written to a signed append-only log.
Pairs with pi-gate; designed to sit downstream of a crypto screener.

Usage:
  pi-crypto-gate demo                     Run the end-to-end demo
  pi-crypto-gate propose --to <0xaddr> --amount <0.05eth|units> --chain <id>
                                          [--token <0xaddr>] [--action <class>] [--spender <0xaddr>]
                                          [--memo <s>] [--policy <file>] [--json]
  pi-crypto-gate approve <receipt-id>     Mint a signed, single-use approval grant
  pi-crypto-gate execute <receipt-id>     Dry-run "broadcast" an allowed/approved action (no funds move)
  pi-crypto-gate receipts [--json]        Show the audit trail
  pi-crypto-gate verify [--pubkey <b64>]  Recompute the receipt chain and signatures
  pi-crypto-gate grants [--json]          Show approval grants and their state
  pi-crypto-gate keygen --approver|--gate Create an Ed25519 key
  pi-crypto-gate zk init --token <0xaddr>  Create the private salt behind the cap commitment
  pi-crypto-gate zk commit [--policy <f>]  Commitment to the token's per-tx cap, for allowPolicy()
  pi-crypto-gate zk prove <receipt-id> --account <0xaddr> [--valid-for <s>] [--out <file>] [--json]
                                          Groth16 proof that an allowed payment is within the cap
  pi-crypto-gate zk verify <envelope.json> Check a proof envelope locally
  pi-crypto-gate help

Action classes: value_transfer, allowance, trade, external_payment.

Exit codes: allow/approval-pending = 0, blocked = 3, refused = 4, usage = 2.
Receipt log:    $PI_CRYPTO_GATE_RECEIPT_LOG or ./.pi-crypto-gate/receipts.jsonl
Approval store: $PI_CRYPTO_GATE_APPROVAL_DIR or ~/.pi-crypto-gate/approvals
Approver key:   $PI_CRYPTO_GATE_APPROVER_KEY   Gate key: $PI_CRYPTO_GATE_SIGNING_KEY
ZK params:      $PI_CRYPTO_GATE_ZK_PARAMS or ./.pi-crypto-gate/zk-params.json (optional zk path)`;

/**
 * Zero-knowledge spending policy (ERC-8366). Optional: needs the snarkjs and
 * circomlibjs peer dependencies and the built circuit (npm run zk:build).
 */
function cmdZk(args) {
  return import("../zk/src/cli.js")
    .then(({ runZk }) => runZk(args))
    .then(() => process.exit(EXIT.allow))
    .catch((err) => {
      console.error(`zk: ${err?.message ?? err}`);
      process.exit(EXIT.refused);
    });
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "propose": return cmdPropose(args);
    case "approve": return cmdApprove(args);
    case "execute": return cmdExecute(args);
    case "receipts": return cmdReceipts(args);
    case "verify": return cmdVerify(args);
    case "grants": return cmdGrants(args);
    case "keygen": return cmdKeygen(args);
    case "demo": return cmdDemo();
    case "zk": return cmdZk(args);
    case "help": case "--help": case "-h": case undefined:
      console.log(HELP); return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(EXIT.usage);
  }
}

main();
