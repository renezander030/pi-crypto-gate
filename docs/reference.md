# Reference

Full configuration and API detail for [pi-crypto-gate](https://github.com/renezander030/pi-crypto-gate).

## Contents

- [Assets and caps](#assets-and-caps)
- [Action classes](#action-classes)
- [The approval boundary](#the-approval-boundary)
- [Receipts](#receipts)
- [Policy keys](#policy-keys)
- [Zero-knowledge spending policy](#zero-knowledge-spending-policy)
- [Sealed policy](#sealed-policy)
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

## Zero-knowledge spending policy

Optional. The gate's `allow` for a token payment can be turned into a Groth16 proof that the amount is within that token's `maxPerTx`, without revealing the cap, in the envelope format of [ERC-8366](https://github.com/fractalyze/erc-8366). The circuit, trust model and Foundry tests live under [`zk/`](../zk/README.md).

| command | does |
|---|---|
| `zk init --token <0xaddr> [--params <file>] [--force]` | writes the params file (mode 600): `version`, `token`, a fresh salt |
| `zk commit [--policy <file>] [--json]` | `paramsCommit = Poseidon([1, maxPerTx, salt])` as bytes32, for `allowPolicy(nonce, paramsCommit, verifier)` |
| `zk prove <receipt-id> --account <0xaddr> [--valid-for <s>] [--out <file>] [--json]` | proves an allowed or approved receipt; writes the envelope file; appends a `proved` event to the receipt log |
| `zk verify <envelope.json> [--json]` | decodes the envelope, rebuilds the public inputs as the account does, verifies the proof |

The flow: `propose` (the gate allows) → the owner registers the commitment for the receipt's nonce, `0x` + `actionHash` → `zk prove` → any facilitator calls USDC `transferWithAuthorization(account, to, value, 0, validBefore, nonce, envelope)`.

The proof binds `to`, `value`, `paramsCommit`, `account`, `chainId`; it hides `cap` and `salt`. `zk prove` refuses a blocked receipt, a held receipt without an approval, a receipt in another token, and any value above the cap (exit 4). The `proved` receipt event carries `account`, `chainId`, `nonce`, `paramsCommit` and the sha256 of the envelope, so the audit trail names the proof that left the gate.

The envelope file holds `envelope` (the signature bytes), the `proof` (Solidity-ordered `a`, `b`, `c`), the `authorization` fields, `publicSignals`, and a `settle` block with the exact `transferWithAuthorization` arguments.

| path | env var | default |
| --- | --- | --- |
| zk params (salt) | `PI_CRYPTO_GATE_ZK_PARAMS` | `./.pi-crypto-gate/zk-params.json` |
| circuit artifacts | `PI_CRYPTO_GATE_ZK_DIR` | `zk/build` (wasm) and `zk/artifacts` (zkey, vkey) |

Dependencies: `snarkjs` and `circomlibjs`, optional peers; `npm run zk:build` needs `circom2` and `circomlib` (dev). The committed proving key is a dev ceremony, see `zk/artifacts/README.md`.

## Sealed policy

Optional. The token's `maxPerTx`, `maxPerDay` and `requireApprovalOver` are sealed with homomorphic encryption (Microsoft SEAL, BFV, via `node-seal`) by a key box, and the agent host checks a payment against them without holding a key or a clear number. In plain words and with the trust model: [`fhe/README.md`](../fhe/README.md).

| command | where | does |
|---|---|---|
| `fhe seal --policy <file> --token <0xaddr> [--keys <dir>] [--bundle <dir>] [--force]` | key box | keys (created once, reused after), then the sealed cap, daily cap, threshold and a sealed zero into the bundle; refuses a key box inside the working directory |
| `fhe evaluate --to <0xaddr> --amount <units> --token <0xaddr> --chain <id> [--bundle <dir>] [--log <path>] [--out <file>] [--json]` | agent host | three blinded sealed differences and the sealed next total; writes the verdict file; `fhe-sealed` receipt |
| `fhe open <verdict.json> [--keys <dir>] [--json]` | key box | opens the signs, decides with the gate's reason codes, signs the decision with the approver key when present, writes it into the file |
| `fhe apply <verdict.json> [--bundle <dir>] [--policy <file>] [--log <path>] [--json]` | agent host | checks the signature against `policy.approverPublicKey` when set, `fhe-opened` receipt, counts the payment in the sealed ledger unless blocked; exit 0 allow or held, 3 blocked, 4 refused |
| `fhe status [--bundle <dir>] [--keys <dir>] [--json]` | either | bundle metadata, whether keys are present, a warning when keys sit inside the working directory |

Decisions and reason codes are the gate's: `allow`, `needs_approval` (`approval-required-over-threshold`), `block` (`per-tx-cap-exceeded`, `daily-cap-exceeded`). Equal amounts behave as in the clear gate: at the cap is allowed, at the threshold is held. Values are limited to 2^36 - 1 base units; a new UTC day restarts the sealed total from the sealed zero. Allow and deny lists are not sealed in v1 and stay with the clear gate.

| path | env var | default |
| --- | --- | --- |
| keys (key box) | `PI_CRYPTO_GATE_FHE_KEYS` | `<approval store>/fhe-keys` |
| bundle (agent host) | `PI_CRYPTO_GATE_FHE_BUNDLE` | `./.pi-crypto-gate/fhe/bundle` |
| verdicts | | `<log dir>/fhe/<id>.verdict.json` |

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
