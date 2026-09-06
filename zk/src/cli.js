// `pi-crypto-gate zk ...`: the zero-knowledge spending-policy commands.
//
//   init    write the private salt for one token's cap
//   commit  the commitment the owner registers on the account (allowPolicy)
//   prove   turn an allowed receipt into an ERC-8366 envelope
//   verify  check an envelope locally, the way the account would
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPolicy, normalizePolicy } from "../../src/policy.js";
import { readReceipts, appendEvent, defaultLogPath } from "../../src/receipts.js";
import { readKeyFile } from "../../src/signing.js";
import { formatAsset } from "../../src/assets.js";
import { sha256 } from "../../src/canonical.js";
import { paramsCommit, toBytes32 } from "./commit.js";
import { createParams, readParams, defaultParamsPath } from "./params.js";
import { assertArtifacts } from "./artifacts.js";
import { proveCapPolicy, verifyCapPolicy, proofFromCalldata, publicInputsOf } from "./prove.js";
import { buildEnvelope, parseEnvelope } from "./envelope.js";
import { isHexAddress } from "./abi.js";
import { terminate } from "./deps.js";

const EXIT = { ok: 0, usage: 2, refused: 4 };
const USAGE = `usage: pi-crypto-gate zk init --token <0xaddr> [--params <file>] [--force]
       pi-crypto-gate zk commit [--policy <file>] [--params <file>] [--json]
       pi-crypto-gate zk prove <receipt-id> --account <0xaddr> [--valid-for <seconds>]
                                [--log <path>] [--policy <file>] [--params <file>] [--out <file>] [--json]
       pi-crypto-gate zk verify <envelope.json> [--json]`;

function fail(msg, code = EXIT.refused) {
  console.error(msg);
  process.exit(code);
}

const str = (v) => (v === true ? undefined : v);
const policyOf = (args) => (args.policy ? loadPolicy(args.policy) : normalizePolicy({}));
const gateKey = () => readKeyFile(process.env.PI_CRYPTO_GATE_SIGNING_KEY);

/** The token's per-transaction cap from the gate policy: the number the proof hides. */
function capOf(policy, token) {
  const t = policy.tokens?.[token.toLowerCase()];
  if (!t) throw new Error(`policy.tokens has no entry for ${token}; the zk cap is that token's maxPerTx`);
  return { cap: t.maxPerTx, asset: { key: token.toLowerCase(), symbol: t.symbol ?? "units", decimals: t.decimals } };
}

export async function runZk(args) {
  const sub = args._[0];
  try {
    switch (sub) {
      case "init":
        return cmdInit(args);
      case "commit":
        return await cmdCommit(args);
      case "prove":
        return await cmdProve(args);
      case "verify":
        return await cmdVerify(args);
      default:
        console.error(USAGE);
        process.exit(EXIT.usage);
    }
  } finally {
    await terminate();
  }
}

function cmdInit(args) {
  const token = str(args.token);
  if (!token) fail(USAGE, EXIT.usage);
  const path = str(args.params) || defaultParamsPath();
  const params = createParams({ token, path, force: args.force === true });
  console.log(`zk params written: ${path} (mode 600)`);
  console.log(`   token ${params.token}`);
  console.log("   the salt blinds the cap commitment: whoever holds it can read the cap, nobody can raise it");
  console.log("   next: pi-crypto-gate zk commit --policy <file>");
}

async function cmdCommit(args) {
  const policy = policyOf(args);
  const params = readParams(str(args.params) || defaultParamsPath());
  const { cap, asset } = capOf(policy, params.token);
  const commit = await paramsCommit({ version: params.version, cap, salt: params.salt });
  const out = {
    version: params.version,
    token: params.token,
    cap: cap.toString(),
    capFormatted: formatAsset(cap, asset),
    paramsCommit: toBytes32(commit),
  };
  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`paramsCommit: ${out.paramsCommit}`);
  console.log(`   commits to cap ${out.capFormatted} for ${out.token} (policy maxPerTx), blinded by the salt`);
  console.log("   register it on the account for a payment's nonce: allowPolicy(nonce, paramsCommit, verifier)");
}

async function cmdProve(args) {
  const id = args._[1];
  const account = str(args.account);
  if (!id || !isHexAddress(account ?? "")) fail(USAGE, EXIT.usage);
  const logPath = str(args.log) || defaultLogPath();
  const policy = policyOf(args);
  const params = readParams(str(args.params) || defaultParamsPath());
  const validFor = Number(str(args["valid-for"]) ?? 3600);
  if (!Number.isInteger(validFor) || validFor <= 0) fail("--valid-for must be a positive integer (seconds)", EXIT.usage);

  const records = readReceipts(logPath);
  const rec = records.find((r) => r.id === id && r.event === "proposed");
  if (!rec) fail(`no proposed receipt with id ${id}`);
  const approved = records.some((r) => r.id === id && r.event === "approved");
  if (rec.status === "block") fail(`refused: receipt ${id} was BLOCKED by policy; nothing to prove`);
  if (rec.status === "needs_approval" && !approved) fail(`refused: receipt ${id} is held for a human; approve it first`);
  const p = rec.proposal;
  if (!p.token || p.token.toLowerCase() !== params.token) {
    fail(`refused: receipt ${id} moves ${p.token ?? "the native asset"}; the zk params are for ${params.token}`);
  }
  if (p.action !== "value_transfer" && p.action !== "external_payment") fail(`refused: ${p.action} is not a payment`);
  if (p.amount === null || p.amount === undefined) fail("refused: the receipt carries no parsed amount");

  const { cap, asset } = capOf(policy, params.token);
  const value = BigInt(p.amount);
  if (value > cap) fail(`refused: ${formatAsset(value, asset)} is above the cap ${formatAsset(cap, asset)}; no proof exists for it`);

  const paths = assertArtifacts();
  const commit = await paramsCommit({ version: params.version, cap, salt: params.salt });
  const chainId = p.chainId;
  const nonce = `0x${rec.actionHash}`;
  const proved = await proveCapPolicy({ cap, salt: params.salt, to: p.to, value, paramsCommit: commit, account, chainId }, paths);
  const ok = await verifyCapPolicy({ vkey: paths.vkey, publicSignals: proved.publicSignals, proof: proved.proof });
  if (!ok) fail("internal: the fresh proof does not verify against the verification key");

  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + validFor;
  const env = buildEnvelope({ a: proved.a, b: proved.b, c: proved.c, to: p.to, value, validAfter, validBefore, nonce });
  const out = {
    receiptId: id,
    actionHash: rec.actionHash,
    account: account.toLowerCase(),
    chainId,
    to: p.to,
    value: value.toString(),
    valueFormatted: formatAsset(value, asset),
    token: params.token,
    paramsCommit: toBytes32(commit),
    nonce,
    validAfter,
    validBefore,
    publicSignals: proved.publicSignals,
    proof: { a: proved.a, b: proved.b, c: proved.c },
    proofBytes: env.proof,
    authorization: env.authorization,
    envelope: env.envelope,
    settle: {
      function:
        "transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
      args: [account.toLowerCase(), p.to, value.toString(), String(validAfter), String(validBefore), nonce, env.envelope],
    },
  };
  const outPath = str(args.out) || join(dirname(logPath), "zk", `${id}.envelope.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  appendEvent(id, "proved", {
    logPath,
    proposal: p,
    actionHash: rec.actionHash,
    detail: { account: out.account, chainId, nonce, paramsCommit: out.paramsCommit, envelopeSha256: sha256(env.envelope) },
    privateKey: gateKey(),
  });
  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`✅  proved: ${out.valueFormatted} -> ${p.to} is within the committed cap (the cap stays private)`);
  console.log(`   account ${out.account}  chain ${chainId}  nonce ${nonce}`);
  console.log(`   envelope ${(env.envelope.length - 2) / 2} bytes, valid until ${new Date(validBefore * 1000).toISOString()}`);
  console.log(`   written: ${outPath}`);
  console.log("   settle with: usdc.transferWithAuthorization(account, to, value, 0, validBefore, nonce, envelope)");
}

async function cmdVerify(args) {
  const file = args._[1];
  if (!file) fail(USAGE, EXIT.usage);
  const env = JSON.parse(readFileSync(file, "utf8"));
  const paths = assertArtifacts();
  const parsed = parseEnvelope(env.envelope);
  const mismatched = [];
  if (parsed.to.toLowerCase() !== String(env.to).toLowerCase()) mismatched.push("to");
  if (parsed.value !== BigInt(env.value)) mismatched.push("value");
  if (parsed.nonce.toLowerCase() !== String(env.nonce).toLowerCase()) mismatched.push("nonce");
  if (parsed.validBefore !== BigInt(env.validBefore)) mismatched.push("validBefore");
  // Rebuild the public inputs from the envelope the way the account does:
  // to and value from the authorization, the rest from what was registered.
  const publicSignals = publicInputsOf({
    to: parsed.to,
    value: parsed.value,
    paramsCommit: env.paramsCommit,
    account: env.account,
    chainId: env.chainId,
  });
  const proofOk = await verifyCapPolicy({ vkey: paths.vkey, publicSignals, proof: proofFromCalldata(parsed) });
  const ok = proofOk && mismatched.length === 0;
  const out = { ok, proofOk, mismatched, publicSignals };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else if (ok) console.log(`✅  envelope verifies: value ${parsed.value} -> ${parsed.to} is within the committed policy`);
  else console.log(`⛔  envelope does not verify (proof ${proofOk ? "ok" : "invalid"}${mismatched.length ? `, fields differ: ${mismatched.join(", ")}` : ""})`);
  process.exit(ok ? EXIT.ok : EXIT.refused);
}
