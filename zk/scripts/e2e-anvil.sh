#!/bin/sh
# End to end on a local Anvil chain: the gate allows a USDC payment, proves it
# is within a private cap, and the ERC-8366 account settles it as a plain
# transferWithAuthorization. Then the refusals: a replay, a payment over the
# cap, and a proof attempt above the cap.
#
#   npm run zk:e2e
#
# Needs Foundry (anvil, forge, cast) and the built circuit (npm run zk:build).
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLI="node $ROOT/bin/pi-crypto-gate.js"
RPC=http://127.0.0.1:8545
# Anvil's published developer accounts. Test keys only.
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
FACILITATOR_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
MERCHANT=0x3333333333333333333333333333333333333333

for tool in anvil forge cast node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing: $tool (Foundry: https://getfoundry.sh)"; exit 2; }
done
[ -f "$ROOT/zk/build/cap_policy_js/cap_policy.wasm" ] || (cd "$ROOT" && npm run -s zk:build)

# Read one field out of the JSON object on stdin. forge prints its --json
# object pretty-printed, sometimes after a status line, so take the object
# out of the whole text.
json() {
  node -e '
    const s = require("fs").readFileSync(0, "utf8");
    const m = s.match(/\{[\s\S]*\}/);
    if (m === null) { console.error("no JSON object in:\n" + s); process.exit(1); }
    console.log(process.argv[1].split(".").reduce((o, k) => o[k], JSON.parse(m[0])));
  ' "$1"
}
step() { printf '\n== %s\n' "$1"; }

WORK=$(mktemp -d)
export PI_CRYPTO_GATE_RECEIPT_LOG="$WORK/receipts.jsonl"
export PI_CRYPTO_GATE_ZK_PARAMS="$WORK/zk-params.json"
export PI_CRYPTO_GATE_APPROVAL_DIR="$WORK/approvals"

anvil --silent --port 8545 >/dev/null 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT INT TERM
i=0
until cast chain-id --rpc-url $RPC >/dev/null 2>&1; do
  i=$((i + 1)); [ $i -lt 50 ] || { echo "anvil did not come up"; exit 1; }; sleep 0.2
done

step "1. deploy: USDC test double, the Groth16 verifier, the ERC-8366 account (owner = anvil account 0)"
cd "$ROOT/zk/contracts"
USDC=$(forge create lib/erc-8366/src/MockUSDCV2_2.sol:MockUSDCV2_2 --rpc-url $RPC --private-key $OWNER_KEY --broadcast --json 2>&1 | json deployedTo)
VERIFIER=$(forge create src/CapPolicyVerifier.sol:Groth16Verifier --rpc-url $RPC --private-key $OWNER_KEY --broadcast --json 2>&1 | json deployedTo)
# --constructor-args swallows every argument after it, so it goes last.
ACCOUNT=$(forge create lib/erc-8366/src/ZKSpendingPolicyAccount.sol:ZKSpendingPolicyAccount --rpc-url $RPC --private-key $OWNER_KEY --broadcast --json --constructor-args "$USDC" "$OWNER" 2>&1 | json deployedTo)
cast send "$USDC" "mint(address,uint256)" "$ACCOUNT" 1000000000 --rpc-url $RPC --private-key $OWNER_KEY >/dev/null
echo "   usdc $USDC"
echo "   verifier $VERIFIER"
echo "   account $ACCOUNT holds 1000 USDC"

step "2. gate policy: per-tx cap 250 USDC on this token, chain 31337 (the cap is what the proof will hide)"
POLICY="$WORK/policy.json"
node -e 'const [usdc, out] = process.argv.slice(1); require("fs").writeFileSync(out, JSON.stringify({ chainAllowlist: [31337], tokens: { [usdc.toLowerCase()]: { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "1000.0", requireApprovalOver: "250.0" } } }, null, 2))' "$USDC" "$POLICY"
$CLI zk init --token "$USDC" | sed 's/^/   /'
COMMIT=$($CLI zk commit --policy "$POLICY" --json | json paramsCommit)
echo "   paramsCommit $COMMIT"

step "3. the agent proposes 150 USDC to the merchant; the gate allows it"
$CLI propose --to $MERCHANT --amount 150.0 --token "$USDC" --chain 31337 --policy "$POLICY" | sed 's/^/   /'
ID=$(node -e 'const l=require("fs").readFileSync(process.env.PI_CRYPTO_GATE_RECEIPT_LOG,"utf8").trim().split("\n"); console.log(JSON.parse(l[l.length-1]).id)')
NONCE=0x$(node -e 'const l=require("fs").readFileSync(process.env.PI_CRYPTO_GATE_RECEIPT_LOG,"utf8").trim().split("\n"); console.log(JSON.parse(l[l.length-1]).actionHash)')

step "4. the owner registers the commitment for this payment's nonce (the receipt's action hash)"
cast send "$ACCOUNT" "allowPolicy(bytes32,bytes32,address)" "$NONCE" "$COMMIT" "$VERIFIER" --rpc-url $RPC --private-key $OWNER_KEY >/dev/null
echo "   allowPolicy($NONCE, $COMMIT, $VERIFIER)"

step "5. the gate proves the allowed payment is within the cap"
$CLI zk prove "$ID" --account "$ACCOUNT" --policy "$POLICY" --out "$WORK/envelope.json" | sed 's/^/   /'
ENVELOPE=$(json envelope <"$WORK/envelope.json")
VALID_BEFORE=$(json validBefore <"$WORK/envelope.json")
$CLI zk verify "$WORK/envelope.json" | sed 's/^/   /'

step "6. any facilitator (anvil account 1) settles it: transferWithAuthorization with the proof as the signature"
cast send "$USDC" "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" \
  "$ACCOUNT" $MERCHANT 150000000 0 "$VALID_BEFORE" "$NONCE" "$ENVELOPE" --rpc-url $RPC --private-key $FACILITATOR_KEY >/dev/null
BAL=$(cast call "$USDC" "balanceOf(address)(uint256)" $MERCHANT --rpc-url $RPC | cut -d' ' -f1)
[ "$BAL" = "150000000" ] || { echo "   merchant balance is $BAL, expected 150000000"; exit 1; }
echo "   merchant received 150 USDC; the chain saw the payment and a commitment, never the cap"

step "7. the refusals"
if cast send "$USDC" "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" \
  "$ACCOUNT" $MERCHANT 150000000 0 "$VALID_BEFORE" "$NONCE" "$ENVELOPE" --rpc-url $RPC --private-key $FACILITATOR_KEY >/dev/null 2>&1; then
  echo "   replay was accepted (bug)"; exit 1
fi
echo "   replay of the same envelope: refused (authorization used)"
set +e
$CLI propose --to $MERCHANT --amount 1000.0 --token "$USDC" --chain 31337 --policy "$POLICY" >/dev/null 2>&1
code=$?
set -e
[ "$code" -eq 3 ] || { echo "   over-cap proposal exit $code, expected 3"; exit 1; }
echo "   1000 USDC proposal: blocked by the gate (exit 3), nothing to prove"
ABOVE=$(node --input-type=module -e '
  const { proveCapPolicy, artifactPaths, readParams, paramsCommit, terminate } = await import(process.argv[1] + "/zk/src/index.js");
  const p = readParams(process.env.PI_CRYPTO_GATE_ZK_PARAMS);
  const cap = 250000000n;
  const commit = await paramsCommit({ cap, salt: p.salt });
  try {
    await proveCapPolicy({ cap, salt: p.salt, to: process.argv[2], value: 250000001n, paramsCommit: commit, account: process.argv[3], chainId: 31337 }, artifactPaths());
    console.log("PROVED");
  } catch (e) {
    console.log(/no proof exists/.test(e.message) ? "REFUSED" : "ERROR " + e.message);
  }
  await terminate();
  process.exit(0);
' "$ROOT" $MERCHANT "$ACCOUNT" 2>&1 | tail -1)
[ "$ABOVE" = "REFUSED" ] || { echo "   proof attempt above the cap: $ABOVE (expected REFUSED)"; exit 1; }
echo "   250.000001 USDC with the real salt: no proof exists above the cap"

step "8. the receipt chain records the decision and the proof"
$CLI verify | sed 's/^/   /'
$CLI receipts | sed 's/^/   /'

printf '\nall good: gate allow -> proof -> onchain settlement, with the cap private.\n'
