# pi-crypto-gate

**A policy gate between an AI agent and an onchain wallet.** A prompt injection, a bad tool result, or a retry loop can cause an agent to propose a payment the wallet owner never intended. The gate **allows**, **holds for approval**, or **blocks** each proposal and records its reasons in a hash-chained receipt log.

## Safety approach

1. The gate checks the proposal against the owner's per-asset spending caps, chain and counterparty rules, and allowed action classes.
2. A held proposal can proceed after approval. With an approver public key configured, the gate requires a signed grant bound to the exact action. The grant expires and can be spent once. The approver keeps the signing key outside the agent's writable environment.
3. The CLI rechecks policy and recorded spend before execution. Receipt verification checks the hash chain and can verify signatures with the gate's public key.

Two optional paths cover different parts of the payment flow.

- **Zero-knowledge proof.** A compatible ERC-8366 account can verify that a registered payment is within an owner-committed per-transaction cap without learning the cap. See the [proof and trust model](zk/README.md).
- **Sealed policy.** The agent host evaluates encrypted limits and a running daily total. The owner's separate key box opens the resulting comparisons and signs the decision. See the [sealed policy and key handling](fhe/README.md).

## Limitations

- **Signer integration.** The bundled executor is a dry run. Real enforcement requires every signing path in scope to go through the gate and the owner to control the signer, policy, and approver credentials. Direct access to a wallet key can bypass the offchain gate. Action classes are currently supplied by the caller.
- **Policy changes.** Execution rechecks hard blocks against current policy and recorded spend. The approval requirement comes from the original proposal.
- **Receipt storage.** The hash chain checks internal consistency, and signatures authenticate signed entries. Detecting a truncated or rolled-back log requires a trusted copy or checkpoint outside the agent host.
- **Proof and sealed policy.** The proof covers the per-transaction cap. Daily budget, recipient rules, and approval thresholds remain offchain. The bundled proving key is for development. The sealed policy protects the confidentiality of configured limits and requires a trusted key box and evaluation flow. The two demos exercise separate flows.

## Reviewer demo

```sh
npm run demo
```

```
# propose 1,000,000 USDC
⛔  BLOCK
   value_transfer  1000000 USDC -> 0x1111...1111 (chain 8453)
   ✗ per-tx-cap-exceeded: amount 1000000 USDC > cap 250 USDC

Result: all three BLOCKED as expected.
Receipt log: 6 entries, chain intact, 6 signed
```

Run this from a checkout with Node.js 20 or later. The demo uses generated keys and a temporary log. It shows an allowed payment, a held payment released with a single-use approval, and a rejected replay. It also blocks three unsafe proposals and verifies the signed receipt chain. All execution is simulated. See [Tests](#tests) for the automated checks.

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

An approval is a grant bound to one exact action, valid for a bounded window, and spendable once. Configure an Ed25519 approver public key to require signatures, and keep the matching private key outside the agent's writable root. Only one concurrent attempt can claim the same grant.

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

## Sealed rulebook (optional)

Five commands, two directories: the key box (your approval box) and the agent host. The host holds sealed numbers and no key.

```
pi-crypto-gate fhe seal --policy policy.json --token <0xaddr>            # key box: seal maxPerTx, maxPerDay, requireApprovalOver
pi-crypto-gate fhe evaluate --to 0x3333... --amount 150.0 --token <0xaddr> --chain 31337   # host: a sealed verdict
pi-crypto-gate fhe open .pi-crypto-gate/fhe/<id>.verdict.json           # key box: three signs, one signed decision
pi-crypto-gate fhe apply .pi-crypto-gate/fhe/<id>.verdict.json          # host: record it, count it in the sealed daily total
pi-crypto-gate fhe status
```

`npm run fhe:demo` walks through it: a 150 USDC payment held for a human, two agents sharing a 600 USDC day without seeing the total, a 300 USDC payment refused by a cap that was never on the machine, and two probes for the threshold that only produce receipts. About 15 ms per verdict, one optional dependency (`node-seal`, Microsoft SEAL). The scheme, who can do what, and what v1 leaves out are in [`fhe/README.md`](fhe/README.md).

## Documentation

**[Full reference](https://github.com/renezander030/pi-crypto-gate/blob/main/docs/reference.md)**: policy keys, assets and caps, action classes, the approval boundary, receipt verification, and the library API.

**[The zk path](zk/README.md)**: the policy circuit, who can do what, the commands, the layout, and what v1 deliberately leaves to v2.

**[The sealed policy](fhe/README.md)**: the sealed rulebook in plain words, how the checks run on sealed numbers, the commands, and the honest limits.

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

```sh
npm ci
npm run zk:build
npm test
```

The suite covers policy blocks, unsigned and replayed grants, receipt tampering, private-cap proofs, and the sealed-policy flow. Building the circuit first enables the proof tests.

- [Onchain tests](zk/README.md) cover settlement and rejection cases in a reference ERC-8366 account using Foundry.
- [Sealed-policy demo](fhe/README.md) exercises encrypted budget checks with a separate owner key box.

The core gate still has no runtime dependencies and no build step. The zk path adds two optional peer dependencies (snarkjs, circomlibjs) for `pi-crypto-gate zk ...`, the sealed policy one (node-seal) for `pi-crypto-gate fhe ...`.

## License

MIT
