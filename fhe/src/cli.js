// `pi-crypto-gate fhe ...`: the sealed policy.
//
//   seal      key box: seal a token's caps and threshold into a bundle for the agent host
//   evaluate  agent host: compute a sealed verdict for a proposal, without reading the rules
//   open      key box: open the verdict (three signs), sign the decision
//   apply     agent host: record the decision, count the payment in the sealed ledger
//   status    either side: what is here, and whether anything is where it should not be
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { loadPolicy, normalizePolicy } from "../../src/policy.js";
import { readReceipts, appendEvent, defaultLogPath } from "../../src/receipts.js";
import { readKeyFile, signMessage, verifyMessage } from "../../src/signing.js";
import { approverKeyPath, isInside } from "../../src/grants.js";
import { actionHashOf } from "../../src/gate.js";
import { formatAsset } from "../../src/assets.js";
import { canonicalJson, sha256 } from "../../src/canonical.js";
import { isAddress, parseAmount } from "../../src/money.js";
import {
  generateKeys,
  ownerSession,
  evaluatorSession,
  sealValue,
  evaluateSealed,
  openVerdict,
  decide,
  noiseBudget,
  MAX_VALUE,
} from "./seal.js";
import {
  defaultKeysDir,
  defaultBundleDir,
  keysPath,
  hasKeys,
  readKeys,
  writeKeys,
  writeBundle,
  writeLedger,
  readBundle,
  utcDay,
  defaultVerdictPath,
  writeVerdict,
  readVerdict,
} from "./bundle.js";

const EXIT = { allow: 0, needs_approval: 0, block: 3, refused: 4, usage: 2 };
const GLYPH = { allow: "✅", needs_approval: "⏸", block: "⛔" };
const USAGE = `usage: pi-crypto-gate fhe seal --policy <file> --token <0xaddr> [--keys <dir>] [--bundle <dir>] [--force]
       pi-crypto-gate fhe evaluate --to <0xaddr> --amount <units> --token <0xaddr> --chain <id>
                                    [--bundle <dir>] [--log <path>] [--out <file>] [--json]
       pi-crypto-gate fhe open <verdict.json> [--keys <dir>] [--json]
       pi-crypto-gate fhe apply <verdict.json> [--bundle <dir>] [--policy <file>] [--log <path>] [--json]
       pi-crypto-gate fhe status [--bundle <dir>] [--keys <dir>]`;

function fail(msg, code = EXIT.refused) {
  console.error(msg);
  process.exit(code);
}
const str = (v) => (v === true ? undefined : v);
const gateKey = () => readKeyFile(process.env.PI_CRYPTO_GATE_SIGNING_KEY);
const policyOf = (args) => (args.policy ? loadPolicy(args.policy) : normalizePolicy({}));

export async function runFhe(args) {
  switch (args._[0]) {
    case "seal":
      return cmdSeal(args);
    case "evaluate":
      return cmdEvaluate(args);
    case "open":
      return cmdOpen(args);
    case "apply":
      return cmdApply(args);
    case "status":
      return cmdStatus(args);
    default:
      console.error(USAGE);
      process.exit(EXIT.usage);
  }
}

async function cmdSeal(args) {
  const token = str(args.token);
  if (!args.policy || !token || !isAddress(token)) fail(USAGE, EXIT.usage);
  const policy = loadPolicy(args.policy);
  const t = policy.tokens?.[token.toLowerCase()];
  if (!t) fail(`refused: policy.tokens has no entry for ${token}; the sealed numbers are that token's maxPerTx, maxPerDay and requireApprovalOver`);
  const keysDir = str(args.keys) || defaultKeysDir();
  const bundleDir = str(args.bundle) || defaultBundleDir();
  // The key stays where approval authority already lives: outside the agent's writable root.
  if (isInside(process.cwd(), keysDir)) {
    fail(
      `refused: the key box would sit inside the working directory (${keysDir}).\n` +
        "The secret key must live where the agent cannot read it, like the approval store.\n" +
        "Set PI_CRYPTO_GATE_FHE_KEYS (or --keys) to a path outside the agent's root.",
    );
  }
  let keys;
  let keysNote;
  if (hasKeys(keysDir) && args.force !== true) {
    keys = readKeys(keysDir);
    keysNote = `reusing keys in ${keysPath(keysDir)}`;
  } else {
    keys = writeKeys(keysDir, await generateKeys());
    keysNote = `new keys written to ${keysPath(keysDir)} (mode 600)`;
  }
  const session = await ownerSession(keys);
  const asset = { key: token.toLowerCase(), symbol: t.symbol ?? "units", decimals: t.decimals };
  for (const [label, v] of [["maxPerTx", t.maxPerTx], ["maxPerDay", t.maxPerDay], ["requireApprovalOver", t.requireApprovalOver]]) {
    if (v > MAX_VALUE) fail(`refused: ${label} ${v} exceeds the sealed range (2^36 - 1 base units)`);
  }
  writeBundle(bundleDir, {
    params: keys.params,
    policy: {
      token: asset.key,
      symbol: asset.symbol,
      decimals: asset.decimals,
      sealedAt: new Date().toISOString(),
      cap: sealValue(session, t.maxPerTx, "maxPerTx"),
      daily: sealValue(session, t.maxPerDay, "maxPerDay"),
      threshold: sealValue(session, t.requireApprovalOver, "requireApprovalOver"),
      zero: sealValue(session, 0n),
    },
    ledger: { spent: sealValue(session, 0n), day: utcDay(), updates: 0 },
  });
  console.log(`🔒  sealed policy for ${asset.symbol} (${asset.key}) -> ${bundleDir}`);
  console.log(`   cap ${formatAsset(t.maxPerTx, asset)}, daily ${formatAsset(t.maxPerDay, asset)}, human above ${formatAsset(t.requireApprovalOver, asset)}: sealed`);
  console.log(`   ${keysNote}`);
  console.log("   the bundle holds no key and no clear number; hand it to the agent host, keep the keys here");
}

async function cmdEvaluate(args) {
  const to = str(args.to);
  const amountInput = str(args.amount);
  const token = str(args.token);
  const chainId = args.chain !== undefined ? Number(args.chain) : NaN;
  if (!to || amountInput === undefined || !token || Number.isNaN(chainId)) fail(USAGE, EXIT.usage);
  if (!isAddress(to)) fail(`refused: not an address: ${to}`);
  if (!Number.isInteger(chainId)) fail(`refused: chainId not an integer: ${args.chain}`);
  const bundle = readBundle(str(args.bundle) || defaultBundleDir());
  if (String(token).toLowerCase() !== bundle.policy.token) fail(`refused: the bundle is sealed for ${bundle.policy.token}, not ${token}`);
  const asset = { key: bundle.policy.token, symbol: bundle.policy.symbol, decimals: bundle.policy.decimals };
  let amount;
  try {
    amount = parseAmount(amountInput, asset.decimals);
  } catch {
    fail(`refused: not a valid amount: ${amountInput}`);
  }
  if (amount <= 0n) fail("refused: amount must be positive");
  if (amount > MAX_VALUE) fail(`refused: amount exceeds the sealed range (2^36 - 1 base units)`);

  // A new UTC day starts from the sealed zero the key box provided.
  const day = utcDay();
  const spent = bundle.ledger.day === day ? bundle.ledger.spent : bundle.policy.zero;
  const session = await evaluatorSession({ params: bundle.params });
  const sealed = evaluateSealed(session, { cap: bundle.policy.cap, daily: bundle.policy.daily, threshold: bundle.policy.threshold, spent }, amount);

  const logPath = str(args.log) || defaultLogPath();
  const id = randomUUID();
  const proposal = {
    to,
    spender: null,
    amount: amount.toString(),
    amountInput: String(amountInput),
    chainId,
    token: asset.key,
    action: "value_transfer",
    asset,
    nonce: id,
    memo: null,
  };
  const actionHash = actionHashOf(proposal, { assetKey: asset.key, actionClass: "value_transfer", amount });
  const verdict = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    proposal,
    actionHash,
    ledger: { day, updates: bundle.ledger.day === day ? bundle.ledger.updates : 0 },
    sealed,
  };
  const outPath = str(args.out) || defaultVerdictPath(logPath, id);
  writeVerdict(outPath, verdict);
  const verdictSha256 = sha256(canonicalJson(sealed));
  appendEvent(id, "fhe-sealed", { logPath, proposal, actionHash, detail: { verdictSha256, bundle: bundle.policy.token }, privateKey: gateKey() });
  if (args.json) {
    console.log(JSON.stringify({ id, actionHash, verdict: outPath, verdictSha256, proposal }, null, 2));
    return;
  }
  console.log(`🔒  sealed verdict for ${formatAsset(amount, asset)} -> ${to} (chain ${chainId})`);
  console.log(`   this host computed three sealed differences and the sealed running total; it read none of the rules`);
  console.log(`   receipt: ${id}`);
  console.log(`   written: ${outPath}`);
  console.log(`   the key box opens it: pi-crypto-gate fhe open ${outPath}`);
}

async function cmdOpen(args) {
  const file = args._[1];
  if (!file) fail(USAGE, EXIT.usage);
  const verdict = readVerdict(file);
  const keysDir = str(args.keys) || defaultKeysDir();
  const keys = readKeys(keysDir);
  const session = await ownerSession(keys);
  const checks = openVerdict(session, verdict.sealed);
  const { decision, reasons } = decide(checks);
  const opened = {
    id: verdict.id,
    actionHash: verdict.actionHash,
    at: new Date().toISOString(),
    decision,
    reasons,
    checks,
    noiseBudgetBits: noiseBudget(session, verdict.sealed.dDay),
  };
  const approverKey = readKeyFile(approverKeyPath());
  const signature = approverKey ? signMessage(canonicalJson(opened), approverKey) : null;
  writeVerdict(file, { ...verdict, opened: { ...opened, signature } });
  if (args.json) {
    console.log(JSON.stringify({ ...opened, signature }, null, 2));
    return;
  }
  const asset = verdict.proposal.asset;
  console.log(`${GLYPH[decision]}  ${decision.toUpperCase().replace("_", " ")}: ${formatAsset(verdict.proposal.amount, asset)} -> ${verdict.proposal.to}`);
  console.log(`   opened three signs: within cap ${checks.withinCap ? "yes" : "no"}, within daily cap ${checks.withinDay ? "yes" : "no"}, above human threshold ${checks.hold ? "yes" : "no"}`);
  console.log(`   ${signature ? "decision signed with the approver key" : "decision unsigned (no approver key here)"}; written back into ${file}`);
  console.log(`   the agent host records it: pi-crypto-gate fhe apply ${file}`);
}

async function cmdApply(args) {
  const file = args._[1];
  if (!file) fail(USAGE, EXIT.usage);
  const verdict = readVerdict(file);
  if (!verdict.opened) fail(`refused: ${file} has not been opened by the key box yet`);
  const policy = policyOf(args);
  const { signature, ...opened } = verdict.opened;
  if (policy.approverPublicKey) {
    if (!signature) fail("refused: the policy requires a signed decision and this one is unsigned");
    if (!verifyMessage(canonicalJson(opened), signature, policy.approverPublicKey)) fail("refused: the decision signature does not match policy.approverPublicKey");
  }
  if (opened.id !== verdict.id || opened.actionHash !== verdict.actionHash) fail("refused: the opened decision does not belong to this verdict");
  const logPath = str(args.log) || defaultLogPath();
  const records = readReceipts(logPath);
  if (records.some((r) => r.id === verdict.id && r.event === "fhe-opened")) fail(`refused: verdict ${verdict.id} was already applied`);
  if (!records.some((r) => r.id === verdict.id && r.event === "fhe-sealed")) fail(`refused: no fhe-sealed receipt for ${verdict.id} in ${logPath}`);
  const bundleDir = str(args.bundle) || defaultBundleDir();
  const bundle = readBundle(bundleDir);
  const counted = opened.decision !== "block";
  if (counted) {
    const day = utcDay();
    const updates = bundle.ledger.day === day ? bundle.ledger.updates + 1 : 1;
    writeLedger(bundleDir, { spent: verdict.sealed.spentNext, day, updates });
  }
  appendEvent(verdict.id, "fhe-opened", {
    logPath,
    proposal: verdict.proposal,
    actionHash: verdict.actionHash,
    detail: { decision: opened.decision, reasons: opened.reasons, checks: opened.checks, signed: Boolean(signature), counted },
    privateKey: gateKey(),
  });
  if (args.json) {
    console.log(JSON.stringify({ id: verdict.id, decision: opened.decision, reasons: opened.reasons, counted, signed: Boolean(signature) }, null, 2));
  } else {
    const asset = verdict.proposal.asset;
    console.log(`${GLYPH[opened.decision]}  ${opened.decision.toUpperCase().replace("_", " ")} recorded for ${formatAsset(verdict.proposal.amount, asset)} -> ${verdict.proposal.to}`);
    console.log(`   ${counted ? "counted in the sealed daily total (still sealed)" : "not counted: blocked"}${opened.reasons.length ? `; reasons: ${opened.reasons.join(", ")}` : ""}`);
    if (opened.decision === "needs_approval") console.log("   held for a human: an approval grant releases it, as for any held payment");
  }
  process.exit(EXIT[opened.decision] ?? EXIT.block);
}

async function cmdStatus(args) {
  const bundleDir = str(args.bundle) || defaultBundleDir();
  const keysDir = str(args.keys) || defaultKeysDir();
  const out = { bundle: null, keysHere: hasKeys(keysDir), keysDir, keysInsideCwd: hasKeys(keysDir) && isInside(process.cwd(), keysDir) };
  if (existsSync(bundleDir)) {
    const b = readBundle(bundleDir);
    out.bundle = {
      dir: bundleDir,
      token: b.policy.token,
      symbol: b.policy.symbol,
      decimals: b.policy.decimals,
      sealedAt: b.policy.sealedAt,
      ledgerDay: b.ledger.day,
      ledgerUpdates: b.ledger.updates,
      sealedNumberBytes: Buffer.from(b.policy.cap, "base64").length,
    };
  }
  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (out.bundle) {
    console.log(`bundle ${out.bundle.dir}`);
    console.log(`   ${out.bundle.symbol} (${out.bundle.token}), ${out.bundle.decimals} decimals, sealed ${out.bundle.sealedAt}`);
    console.log(`   sealed daily total: day ${out.bundle.ledgerDay}, ${out.bundle.ledgerUpdates} payments counted; one sealed number is ${Math.round(out.bundle.sealedNumberBytes / 1024)} KB`);
  } else console.log(`no bundle at ${bundleDir}`);
  console.log(out.keysHere ? `keys present at ${keysPath(keysDir)}: this is the key box` : `no keys at ${keysDir}: this is an evaluator, it cannot open anything`);
  if (out.keysInsideCwd) console.log("⚠️  the keys sit inside the working directory; an agent running here could read the rules");
}
