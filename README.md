# pi-crypto-gate

**A policy gate between an AI agent and an onchain wallet.** The agent proposes a payment. The gate **allows** it, **holds** it for a human, or **blocks** it, and writes every decision to a hash-chained receipt log. Nothing reaches a chain until policy agrees.

**New: an allow can now be proven, not just logged.** With the optional zero-knowledge path, a payment the gate allows comes with a Groth16 proof that it is within a per-transaction cap the owner committed to in advance. An [ERC-8366](https://github.com/fractalyze/erc-8366) account verifies that proof on chain and releases the funds, and the chain never learns the cap. The cap moves from a check inside this process into the account itself: an attacker who takes over the agent's machine can still spend at most the cap, once per payment the owner registered.

| | the gate alone | with the zk path |
|---|---|---|
| the cap is enforced by | this process, off chain | the account contract, on chain, plus this process |
| the chain sees | the transaction | the payment and a commitment, never the cap |
| an attacker on the agent's host can spend | whatever the wallet key allows | at most the cap, once per registered payment |

The design assumption is unchanged: an autonomous agent will eventually propose a payment it should not make (a prompt injection, a bad tool result, a loop). This is the layer that assumes that and refuses, and now it can hand the chain the receipt of that refusal's opposite: a proof the allowed payment was within bounds.

## The failing case is the point

```
npx pi-crypto-gate demo
```

```
# propose 1,000,000 USDC
⛔  BLOCK
   value_transfer  1000000 USDC -> 0x1111...1111 (chain 8453)
   ✗ per-tx-cap-exceeded: amount 1000000 USDC > cap 250 USDC

Result: all three BLOCKED as expected.
Receipt log: 6 entries, chain intact, 6 signed
```

The demo runs the arc on a throwaway log: a tiny payment is auto-allowed, a mid-size one is held until a human mints a grant, and three failing cases are refused (over-cap ETH, over-cap USDC, and an unbounded ERC-20 approval to a denylisted spender). Replaying a spent approval is refused too. No funds move at any point.

## Install

```
npm install -g pi-crypto-gate     # CLI
npm install pi-crypto-gate        # library
```

Node 20+. No runtime dependencies.

## Use

```
pi-crypto-gate propose --to 0xabc... --amount 150.0 --token 0xa0b8... --chain 8453
pi-crypto-gate approve <receipt-id>     # mint a signed, single-use approval
pi-crypto-gate execute <receipt-id>     # dry-run "broadcast" (no funds move)
pi-crypto-gate verify                   # recompute the receipt chain
```

Exit codes: allowed or approval-pending `0`, blocked `3`, refused `4`, usage `2`. A blocked payment fails the command, so the gate drops into a tool call, a shell pipeline, or a CI check. Add `--json` for a machine-readable decision.

Other commands: `receipts`, `grants`, `keygen`, `demo`.

## What it checks

- **Per-asset caps.** Native amounts against the native caps; token amounts against that token's own caps and `decimals`. Daily spend is tracked per asset. An unconfigured token is refused rather than measured against an unrelated cap.
- **Action classes.** `value_transfer`, `allowance`, `trade`, `external_payment`. An allowance is screened on the spender, capped by `maxPerTx`, always held for a human, and refused when unbounded.
- **Counterparties and chains.** Deny list checked before the allow list.
- **A human-approval threshold**, above which a payment is held.

## The approval boundary

An approval is a grant bound to one exact action, valid for a bounded window, spendable once. It is signed with an Ed25519 approver key that lives outside the agent's writable root, so an agent can request an approval without being able to issue one. Of two concurrent executes exactly one proceeds.

## Execution is unwired on purpose

The default executor is a dry run. It prints the transaction it would broadcast and moves nothing. Real broadcast is intentionally not implemented in `src/executor.js`; wiring it in (a viem `WalletClient` behind `PI_CRYPTO_GATE_RPC_URL` + `PI_CRYPTO_GATE_PRIVATE_KEY`) is a deliberate step, so a misconfigured agent cannot move real funds by accident.

The gate always runs before the executor. At execution time the policy is re-checked against live per-asset spend.

## Zero-knowledge spending policy (optional)

Four commands turn an allow into a proof the chain checks, in the envelope format of ERC-8366. Nothing else in the gate changes.

```
pi-crypto-gate zk init --token <0xaddr>          # a private salt for this token's cap
pi-crypto-gate zk commit --policy policy.json    # Poseidon([1, maxPerTx, salt]) -> paramsCommit, for allowPolicy()
pi-crypto-gate propose --to 0x3333... --amount 150.0 --token <0xaddr> --chain 31337 --policy policy.json
pi-crypto-gate zk prove <receipt-id> --account <0xaddr>   # Groth16 proof + envelope for the allowed payment
pi-crypto-gate zk verify .pi-crypto-gate/zk/<receipt-id>.envelope.json
```

The owner registers `paramsCommit` on the ERC-8366 account for the payment's nonce (the receipt's action hash). Any facilitator then settles the payment with plain USDC `transferWithAuthorization(...)`, the envelope in the signature slot. The account rebuilds the public inputs `[to, value, paramsCommit, account, chainId]` itself and verifies the proof; a proof for a higher value, another recipient, another account or another chain does not exist or does not verify, and a replay dies on the USDC nonce.

```
npm run zk:build           # compile the circuit (about 1 s; dev deps: circom2, snarkjs, circomlibjs)
npm run test:contracts     # 10 Foundry tests: the fixture proof settles on the reference account
npm run zk:e2e             # the whole flow on a local Anvil, refusals included
```

The proving key in `zk/artifacts/` is from a dev ceremony: tests and Anvil, not value. The circuit, the prover, the trust model and the v2 predicates (daily budget, recipient allowlist, merchant-signed quote) are in [`zk/README.md`](zk/README.md).

## Documentation

**[Full reference](https://github.com/renezander030/pi-crypto-gate/blob/main/docs/reference.md)**: policy keys, assets and caps, action classes, the approval boundary, receipt verification, and the library API.

**[The zk path](zk/README.md)**: the policy circuit, who can do what, the commands, the layout, and what v1 deliberately leaves to v2.

## Design notes

- **[Assume the bad transaction](https://cedricbrown.xyz/writing/assume-the-bad-transaction/)** explains how the allow, hold, and block flow, exact-action approval grants, and receipt log fit together.
- **[Refusals need receipts](https://cedricbrown.xyz/writing/refusals-need-receipts/)** makes the case for keeping durable, verifiable records of the actions a gate stops.
- **[Hold is not a third decision](https://cedricbrown.xyz/writing/hold-is-not-a-third-decision/)** follows an ERC-8354 correction from binary enforcement to richer reason codes and the release object behind a held action.

## Where this fits

The pattern maps onto agent-payment rails like x402 and Base MCP, where an agent can initiate value transfer through a tool call. The gate is the guardrail in front of that tool, independent of which chain or client is underneath.

The gate decides; it does not transport. How a transaction reaches a chain (signer, RPC, relay, mempool exposure) is the executor's concern, wired in downstream by the integrator.

Part of the pi-* agent-harness family, alongside [pi-gate](https://github.com/renezander030/pi-gate), which does the same job for code changes.

## Roadmap

- viem-backed real broadcast behind explicit env config
- calldata decoding, so an action class is derived from the transaction rather than declared
- an optional signer wrapper, so the gate sits on the signing path for SDK callers

## Tests

```
npm test                   # 100 tests on Node's built-in runner; the proving tests skip until npm run zk:build
npm run test:contracts     # Foundry, against the ERC-8366 account (git submodule update --init first)
```

The core gate still has no runtime dependencies and no build step. The zk path adds two optional peer dependencies (snarkjs, circomlibjs) that are only needed for `pi-crypto-gate zk ...`.

## License

MIT
