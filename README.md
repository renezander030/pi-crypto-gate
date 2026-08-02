# pi-crypto-gate

A policy gate that sits between an AI agent and an onchain wallet.

Part of the pi-* agent-harness family (alongside [pi-gate](https://github.com/renezander030/pi-gate), which does the same job for code changes). It is designed to sit downstream of a crypto screener: the screener surfaces an opportunity, the agent proposes the trade or payment, and this gate holds it for policy and human approval before anything moves onchain.

An agent proposes an action. The gate decides one of three things:

- **allow**: under every limit, let it through
- **needs approval**: within the limits but large enough that a human should sign off
- **block**: breaks a rule (per-asset caps, chain, counterparty, action class), so it never leaves the process

Every decision is written to a hash-chained, optionally signed append-only receipt log, so there is a verifiable record of what the agent tried to do, whether or not it went through.

The design assumption is simple: an autonomous agent will eventually propose a payment it should not make (a prompt injection, a bad tool result, a loop). The gate is the layer that assumes that will happen and refuses to broadcast until policy and, above a threshold, a human agree.

## The failing case is the point

The interesting demo is not a payment that succeeds. It is a payment that gets stopped.

```
npm run demo
```

```
# propose 1,000,000 USDC
⛔  BLOCK
   value_transfer  1000000 USDC -> 0x1111...1111 (chain 8453)
   ✓ asset-not-configured: USDC caps configured (6 decimals)
   ✓ chain-not-allowed: chain 8453 allowed
   ✗ per-tx-cap-exceeded: amount 1000000 USDC > cap 250 USDC
   ...
Result: all three BLOCKED as expected.
Receipt log: 6 entries, chain intact, 6 signed
```

The demo runs the full arc on a throwaway log: a tiny payment is auto-allowed, a mid-size one is held until a human mints a grant, and three failing cases are refused (an over-cap ETH transfer, an over-cap USDC transfer, and an unbounded ERC-20 approval to a denylisted spender). Replaying the spent approval is refused too. No funds move at any point.

## CLI

```
pi-crypto-gate propose --to <0xaddr> --amount <0.05eth|units> --chain <id>
                       [--token <0xaddr>] [--action <class>] [--spender <0xaddr>]
                       [--memo <s>] [--policy <file>] [--json]
pi-crypto-gate approve <receipt-id>      # mint a signed, single-use approval grant
pi-crypto-gate execute <receipt-id>      # dry-run "broadcast" (no funds move)
pi-crypto-gate receipts                  # the audit trail
pi-crypto-gate verify [--pubkey <b64>]   # recompute the chain and signatures
pi-crypto-gate grants                    # approval grants and their state
pi-crypto-gate keygen --approver|--gate  # create an Ed25519 key
pi-crypto-gate demo
```

Exit codes: allowed or approval-pending `0`, blocked `3`, refused `4`, usage `2`. So the gate composes into a shell pipeline or CI check: a blocked payment fails the command.

| path | env var | default |
| --- | --- | --- |
| receipt log | `PI_CRYPTO_GATE_RECEIPT_LOG` | `./.pi-crypto-gate/receipts.jsonl` |
| approval store | `PI_CRYPTO_GATE_APPROVAL_DIR` | `~/.pi-crypto-gate/approvals` |
| approver key | `PI_CRYPTO_GATE_APPROVER_KEY` | `<approval store>/approver.key` |
| gate key | `PI_CRYPTO_GATE_SIGNING_KEY` | unset (receipts written unsigned) |

## Assets and caps

Caps belong to an asset. Native amounts are compared against the native caps, and a token's base units are compared against that token's own caps using its `decimals`.

A token the policy does not configure has no caps to enforce, so the gate refuses it rather than reaching for an unrelated cap. Adding an asset is an explicit act:

```json
"tokens": {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
    "symbol": "USDC", "decimals": 6,
    "maxPerTx": "250.0", "maxPerDay": "1000.0", "requireApprovalOver": "100.0"
  }
}
```

Daily spend is tracked per asset, so a day of USDC payments leaves the ETH budget untouched. Omitting `requireApprovalOver` holds every payment in that token for a human.

## Action classes

A cap on "amount leaving the wallet" cannot see an ERC-20 approval, whose amount stays put until a spender draws on it. Each proposal is classified, and the class decides which rules apply:

| class | screened on | counts against the daily cap |
| --- | --- | --- |
| `value_transfer` | recipient | yes |
| `allowance` | spender | no |
| `trade` | recipient | yes |
| `external_payment` | recipient | yes |

An `allowance` always needs a human, its ceiling is capped by `maxPerTx`, and an unbounded approval is refused unless `allowUnlimitedAllowance` is set. Restrict the surface with `allowedActions`.

## The approval boundary

An approval is a grant: a file bound to one exact action, valid for a bounded window, spendable once.

The action is identified by `actionHash`, a digest of recipient, spender, amount, asset, chain, class and nonce. A grant carries that hash, so it cannot authorise a different payment, and each proposal gets its own nonce, so two identical payments need two approvals.

`execute` claims the grant with an exclusive create before it calls the executor. Of two concurrent executes exactly one proceeds; the other gets `grant_already_consumed`. A spent grant stays spent, so a failed broadcast needs a fresh approval rather than a retry of the old one.

Grants and the approver key live in the approval store, which belongs outside the agent's writable root. `approve` refuses to mint a grant when the store sits inside the working directory, when the approver key is readable beyond its owner, or when the key does not match `approverPublicKey`. Point `PI_CRYPTO_GATE_APPROVAL_DIR` at a path the agent cannot write, and the agent can request an approval without being able to issue one.

```
pi-crypto-gate keygen --approver          # writes the key 0600, prints the public half
# put that public key in the policy as "approverPublicKey"
```

With `approverPublicKey` set, only grants carrying a matching signature are honoured.

## Receipts you can check

Each line carries its own hash and the hash of the line before it. Editing or removing an entry breaks every entry after it, and `verify` reports where:

```
pi-crypto-gate verify --pubkey <base64>
✅  ./.pi-crypto-gate/receipts.jsonl
   entries: 6   signed: 6
   signatures verified: 6/6
   chain intact
```

Set `PI_CRYPTO_GATE_SIGNING_KEY` (from `keygen --gate`) and every line is also signed with Ed25519, so a third party can check the log against the public key without holding anything secret. `verify` exits `4` on a broken chain, which makes it a usable CI step.

## Integrating with an agent

There is no server to run. An agent calls the CLI the same way it calls any other tool: `pi-crypto-gate propose ... --json` prints the decision as JSON and sets an exit code, so it drops straight into a tool call, a shell pipeline, or a CI gate.

The JSON carries `decisionId`, `actionHash`, `policyVersion`, `expiresAt`, and the per-check breakdown, so a caller can correlate a decision with the execution that followed it and tell which ruleset produced it.

## Library

```js
import { evaluate } from "pi-crypto-gate";

const decision = evaluate(
  { to: "0x1111111111111111111111111111111111111111", amount: "1000000000000",
    token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", chainId: 8453 },
  { tokens: { "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48":
      { symbol: "USDC", decimals: 6, maxPerTx: "250.0", maxPerDay: "1000.0" } } },
  { "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "0" }, // spent today, per asset
);

decision.decision; // "block"
decision.reasons;  // ["per-tx-cap-exceeded", "daily-cap-exceeded"]
```

`evaluate` is pure and deterministic: same proposal, policy, and prior spend give the same result. Amounts are handled as BigInt base units throughout, so there is no floating-point drift. The third argument accepts a per-asset map or a bare native total.

## Policy

```json
{
  "chainAllowlist": [8453, 84532],
  "recipientAllowlist": [],
  "recipientDenylist": [],
  "maxPerTxWei": "0.05eth",
  "maxPerDayWei": "0.20eth",
  "requireApprovalOverWei": "0.01eth",
  "tokens": {},
  "allowedActions": ["value_transfer", "allowance", "trade", "external_payment"],
  "allowUnlimitedAllowance": false,
  "approvalTtlSeconds": 900,
  "approverPublicKey": null,
  "gatePublicKey": null
}
```

An empty `recipientAllowlist` or `chainAllowlist` means "no restriction on that axis"; the denylist is checked first either way. Native amounts accept `eth` / `gwei` suffixes or a raw wei integer; token amounts are read in that token's `decimals`, where a bare integer is base units and a decimal value is whole tokens. A partial policy is merged over the defaults, so overriding one cap leaves the rest intact. Every decision records the `policyVersion` it was made under. See [`examples/policy.json`](examples/policy.json).

## Execution is unwired on purpose

The default executor is a dry run. It prints the transaction it would broadcast and moves nothing. Real broadcast is intentionally not implemented in `src/executor.js`; wiring it in (a viem `WalletClient` behind `PI_CRYPTO_GATE_RPC_URL` + `PI_CRYPTO_GATE_PRIVATE_KEY`) is a deliberate step, so a misconfigured agent cannot move real funds by accident.

The gate always runs before the executor. At execution time the policy is re-checked against live per-asset spend, so an approval minted earlier cannot slip past a cap that later payments have since consumed.

## Where this fits

The pattern maps directly onto agent-payment rails like x402 and Base MCP, where an agent can initiate value transfer through a tool call. The gate is the guardrail you put in front of that tool: per-asset caps, allow and deny lists, a human-in-the-loop boundary, and a verifiable audit log, independent of which chain or client is underneath.

## Roadmap

- viem-backed real broadcast behind explicit env config
- calldata decoding, so an action class is derived from the transaction rather than declared
- an optional signer wrapper, so the gate sits on the signing path for SDK callers

## Tests

```
npm test
```

Node's built-in test runner. No build step and no runtime dependencies.
