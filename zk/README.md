# The zero-knowledge spending policy

The gate decides off chain. This folder turns one of its decisions, **allow**, into something a chain can check: a Groth16 proof that the payment is within a per-transaction cap the owner committed to in advance, without the cap ever appearing on chain.

It reuses the [ERC-8366 reference implementation](https://github.com/fractalyze/erc-8366) (Zero-Knowledge Spending Policies) unchanged, as a git submodule: the escrow account, its ERC-1271 check, the USDC test double, the envelope format. What pi-crypto-gate adds is the policy circuit (its cap), the prover side (a receipt in, an envelope out) and the wiring to the receipt log. No new protocol.

## What the proof says

```
public   [to, value, paramsCommit, account, chainId]
private  cap, salt

value <= cap                                   both range-checked to 64 bits
paramsCommit == Poseidon([1, cap, salt])       the owner's registered commitment
```

`to`, `account` and `chainId` carry no policy meaning in v1; they are folded into the statement so a proof made for one payment on one account on one chain verifies nowhere else. The account builds all five public inputs itself, from the checked EIP-3009 authorization and the registered policy. The prover hands it proof bytes and nothing else.

`cap` is the gate policy's own `maxPerTx` for the token. The salt blinds it: caps are small numbers, so without the salt the commitment could be opened by trying every plausible cap.

## Who can do what

| party | holds | can |
|---|---|---|
| owner | the account's owner key | register a commitment for a payment's nonce (`allowPolicy`), revoke it, sweep |
| gate / agent host | the policy, the salt, the circuit | prove any payment **at or below the cap**, once per registered nonce |
| facilitator (anyone) | the envelope | settle it: `transferWithAuthorization` with the envelope as the signature |
| the chain, observers | the payment, the commitment | nothing about the cap |

So an attacker who takes over the agent's machine, salt and all, can spend at most the cap, once per nonce the owner registered. Without the zk path that attacker holds whatever the wallet key allows. The salt is a privacy secret (whoever has it can read the cap), not a spending secret (nobody can raise the cap with it).

## Run it

```sh
git submodule update --init      # forge-std and erc-8366, once
npm install                      # dev tooling: circom2, circomlib, snarkjs, circomlibjs
npm run zk:build                 # compile the circuit to its witness generator (about 1 s)
npm test                         # the JS suite, proving included
npm run test:contracts           # 10 Foundry tests: the fixture proof settles on the ERC-8366 account
npm run zk:e2e                   # the whole flow on a local Anvil (needs Foundry)
```

The end-to-end script does what an integration does: deploy the USDC test double, the verifier and the account; write a gate policy with a 250 USDC cap; `zk init` a salt; `zk commit`; let the agent `propose` 150 USDC (allowed); register the commitment for that receipt's nonce; `zk prove`; settle with `transferWithAuthorization` from a third account; then show a replay refused, a 1,000 USDC proposal blocked by the gate, and a proof attempt at 250.000001 USDC that has no witness.

## The commands

| command | does |
|---|---|
| `pi-crypto-gate zk init --token <0xaddr>` | writes `zk-params.json` (mode 600): the token and a fresh 248-bit salt |
| `pi-crypto-gate zk commit --policy <file>` | `Poseidon([1, maxPerTx, salt])` as bytes32, the value for `allowPolicy(nonce, paramsCommit, verifier)` |
| `pi-crypto-gate zk prove <receipt-id> --account <0xaddr>` | proves an allowed (or approved) receipt, writes `<log dir>/zk/<id>.envelope.json`, appends a `proved` event to the receipt log |
| `pi-crypto-gate zk verify <envelope.json>` | decodes the envelope and verifies the proof against the verification key, rebuilding the public inputs the way the account does |

The nonce is the receipt's `actionHash`, so the on-chain policy registration names the gate decision it releases. `--valid-for` (default 3600 s) sets `validBefore`; `validAfter` is 0.

## Layout

```
zk/
├── circuits/cap_policy.circom         the policy circuit (v1: private per-tx cap)
├── src/                               prover side, no runtime dependencies beyond the two optional peers
│   ├── abi.js                          the ERC-8366 envelope encoding, vectors checked against cast
│   ├── commit.js                       Poseidon commitment, salt
│   ├── prove.js                        Groth16 prove / verify, Solidity-ordered (a, b, c)
│   ├── envelope.js                     proof + authorization -> signature bytes
│   ├── params.js                       zk-params.json
│   ├── artifacts.js                    where the wasm / zkey / vkey live
│   └── cli.js                          the `zk` subcommands
├── scripts/build.mjs                  compile; with --ceremony also a dev Groth16 setup, verifier, fixture
├── scripts/e2e-anvil.sh               the flow above, on Anvil
├── artifacts/                         committed dev ceremony outputs (see its README)
├── contracts/                         Foundry project
│   ├── lib/erc-8366                    submodule: account, interface, USDC double
│   ├── lib/forge-std                   submodule
│   ├── src/CapPolicyVerifier.sol       generated by snarkjs (GPL-3.0 header, as snarkjs emits it)
│   └── test/CapPolicy.t.sol            settles the fixture proof; refusals for value, recipient, replay, account, chain, revocation
└── test/                              JS tests: encoding vectors, commitment, proving
```

## What v1 does not prove, on purpose

- **A daily budget.** Needs a running total the chain can trust; the gate keeps that total off chain today.
- **A recipient allowlist.** A Merkle root in the commitment and a membership path in the witness.
- **A merchant-signed quote.** The ERC-8366 example policy; binds `value` and `to` to something the payee signed.

Each is a version bump. `VERSION` is folded into the commitment, so a v1 proof cannot be replayed against a v2 policy, and the account registers the verifier next to the commitment, so versions coexist.

## Trust notes

- The committed proving key comes from a single-contributor dev ceremony run by `npm run zk:ceremony` on one machine. Tests and Anvil, not value. See `artifacts/README.md`.
- `CapPolicyVerifier.sol` is generated code under the GPL-3.0 header snarkjs emits; the ERC-8366 sources are CC0-1.0 (account, interface) and MIT (USDC double), untouched in the submodule.
- The gate's other checks (allow and deny lists, action classes, the daily cap, the human-approval threshold) keep running off chain exactly as before. The proof adds an on-chain cap; it removes nothing.
