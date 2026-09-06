#!/bin/sh
# The sealed policy, end to end on one machine with two directories:
#   key box    holds the keys and the clear policy, outside the agent's working
#              directory, exactly like the approval store
#   agent host the working directory: bundle, receipts, verdicts; never a key
#
#   npm run fhe:demo
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLI="node $ROOT/bin/pi-crypto-gate.js"
USDC=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
MERCHANT=0x3333333333333333333333333333333333333333
KEYBOX=$(mktemp -d)
AGENT=$(mktemp -d)
export PI_CRYPTO_GATE_FHE_KEYS="$KEYBOX/fhe-keys"
export PI_CRYPTO_GATE_APPROVAL_DIR="$KEYBOX/approvals"
export PI_CRYPTO_GATE_FHE_BUNDLE="$AGENT/bundle"
export PI_CRYPTO_GATE_RECEIPT_LOG="$AGENT/receipts.jsonl"

step() { printf '\n== %s\n' "$1"; }
ms() { node -e 'console.log(Date.now())'; }
elapsed() { printf '   (%s ms)\n' "$(( $(ms) - $1 ))"; }

pay() {
  who=$1; amount=$2
  t=$(ms)
  (cd "$AGENT" && $CLI fhe evaluate --to $MERCHANT --amount "$amount" --token $USDC --chain 31337 --json > "$AGENT/last.json")
  FILE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).verdict)' "$AGENT/last.json")
  (cd "$AGENT" && $CLI fhe open "$FILE" >/dev/null)
  set +e
  (cd "$AGENT" && $CLI fhe apply "$FILE" | sed "s/^/   agent $who: /")
  set -e
  elapsed "$t"
}

step "1. the key box seals the policy: cap 250 USDC per payment, 1000 USDC per day, a human above 100 USDC"
cat > "$KEYBOX/policy.json" <<EOF
{ "chainAllowlist": [31337],
  "tokens": { "$USDC": { "symbol": "USDC", "decimals": 6, "maxPerTx": "250.0", "maxPerDay": "1000.0", "requireApprovalOver": "100.0" } } }
EOF
(cd "$AGENT" && $CLI fhe seal --policy "$KEYBOX/policy.json" --token $USDC | sed 's/^/   /')

step "2. what the agent host received: sealed numbers, no key"
printf '   files: %s\n' "$(ls "$AGENT/bundle" | tr '\n' ' ')"
printf '   the sealed cap begins: %s...\n' "$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(p.cap.slice(0,48))' "$AGENT/bundle/policy.sealed.json")"
printf '   clear numbers in the bundle: %s\n' "$(grep -c '250000000\|1000000000\|100000000' "$AGENT/bundle/policy.sealed.json" || true)"
(cd "$AGENT" && $CLI fhe status | sed 's/^/   /')

step "3. the agent proposes 150 USDC; the host seals a verdict it cannot read; the key box opens three signs"
pay A 150.0

step "4. the agent feels for the human threshold: 99 passes, 100 is held; the seam shows only as verdicts and receipts, never as a number"
pay A 99.0
pay A 100.0

step "5. over the cap: refused, and the cap was never on this machine"
pay A 300.0

step "6. two agents share the daily budget; neither ever sees the running total"
pay A 200.0
pay B 200.0
pay A 250.0
pay B 2.0
printf '   sealed ledger: %s payments counted today, the total itself still sealed\n' "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).updates)' "$AGENT/bundle/ledger.sealed.json")"
printf '   receipts so far: %s lines\n' "$(wc -l < "$AGENT/receipts.jsonl" | tr -d ' ')"

step "7. the receipt chain"
(cd "$AGENT" && $CLI verify | sed 's/^/   /')
(cd "$AGENT" && $CLI receipts | sed 's/^/   /' | tail -8)

printf '\nall good: the rules stayed sealed on the agent host; only the key box ever saw a verdict, and only as yes or no.\n'
