# pi-crypto-gate

A policy gate that sits between an AI agent and an onchain wallet.

An agent proposes an action. The gate **allows** it, **holds** it for a human, or **blocks** it, and writes every decision to a hash-chained receipt log. Nothing reaches a chain until policy agrees.

The design assumption: an autonomous agent will eventually propose a payment it should not make (a prompt injection, a bad tool result, a loop). This is the layer that assumes that and refuses.

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

## Documentation

**[Full reference](https://github.com/renezander030/pi-crypto-gate/blob/main/docs/reference.md)**: policy keys, assets and caps, action classes, the approval boundary, receipt verification, and the library API.

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
npm test
```

76 tests on Node's built-in runner. No build step.

## License

MIT
