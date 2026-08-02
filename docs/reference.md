# Reference

Full configuration and API detail for [pi-crypto-gate](https://github.com/renezander030/pi-crypto-gate).

## Contents

- [Assets and caps](#assets-and-caps)
- [Action classes](#action-classes)
- [The approval boundary](#the-approval-boundary)
- [Receipts](#receipts)
- [Policy keys](#policy-keys)
- [Library](#library)

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

Native amounts accept `eth` / `gwei` suffixes or a raw wei integer. Token amounts are read in that token's `decimals`, where a bare integer is base units and a decimal value is whole tokens.

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

This bounds an agent confined to its working directory. An agent with unrestricted shell access to the host can still reach the key, which is what out-of-band sign-off is for.

## Receipts

Each line carries its own hash and the hash of the line before it. Editing or removing an entry breaks every entry after it, and `verify` reports where:

```
pi-crypto-gate verify --pubkey <base64>
✅  ./.pi-crypto-gate/receipts.jsonl
   entries: 6   signed: 6
   signatures verified: 6/6
   chain intact
```

Set `PI_CRYPTO_GATE_SIGNING_KEY` (from `keygen --gate`) and every line is also signed with Ed25519, so a third party can check the log against the public key without holding anything secret. `verify` exits `4` on a broken chain, which makes it a usable CI step.

## Policy keys

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

An empty `recipientAllowlist` or `chainAllowlist` means "no restriction on that axis"; the denylist is checked first either way. A partial policy is merged over the defaults, so overriding one cap leaves the rest intact. Every decision records the `policyVersion` it was made under. See [`examples/policy.json`](../examples/policy.json).

| path | env var | default |
| --- | --- | --- |
| receipt log | `PI_CRYPTO_GATE_RECEIPT_LOG` | `./.pi-crypto-gate/receipts.jsonl` |
| approval store | `PI_CRYPTO_GATE_APPROVAL_DIR` | `~/.pi-crypto-gate/approvals` |
| approver key | `PI_CRYPTO_GATE_APPROVER_KEY` | `<approval store>/approver.key` |
| gate key | `PI_CRYPTO_GATE_SIGNING_KEY` | unset (receipts written unsigned) |

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

The decision carries `decisionId`, `actionHash`, `policyVersion`, `expiresAt`, and the per-check breakdown, so a caller can correlate a decision with the execution that followed it and tell which ruleset produced it.

Also exported: `actionHashOf`, `normalizePolicy`, `loadPolicy`, `appendReceipt`, `readReceipts`, `spentToday`, `verifyLog`, `issueGrant`, `verifyGrant`, `claimGrant`, `generateKeypair`, `signMessage`, `verifyMessage`.

## Compatibility

Native-only policies and the `evaluate(proposal, policy, spentWei)` signature keep working. The third argument now also accepts a per-asset map, and `spentTodayWei` still returns the native total.
