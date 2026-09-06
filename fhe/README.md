# The sealed policy

## In plain words

Your spending rules for an AI agent, the cap per payment, the daily cap, the amount above which a human must say yes, sit on the agent's computer in a locked box. That computer can add up and compare numbers *through* the box, without opening it, so it works out "is this payment inside the rules" while never seeing a rule. Only your key opens the result, and the result is three yes-or-no answers, never the numbers.

Three things that buys you:

- **The agent cannot see its own limits.** An agent that knows "a human is asked above 100" learns to propose 99. With sealed rules there is no 100 to read on that machine, and every probe is a sealed verdict plus a line in the receipt log.
- **Several agents can share one daily budget without any of them seeing how much is left.** The running total is added up inside the box, on the agent host, and stays sealed there.
- **A hacked agent computer learns nothing about your rules.** It holds sealed numbers and encryption parameters, no key.

One honest limit: a hacked computer that cannot read the rules could still *lie* about the answer, or replay an old one. That is what the receipt of proof in [`zk/`](../zk/README.md) is for, where the wallet itself refuses anything over the cap. The two combine: the box keeps the rules secret, the proof keeps the answer honest.

## How it works

Microsoft SEAL's BFV scheme (through `node-seal`) is homomorphic: anyone can add two sealed numbers, subtract them, or multiply a sealed number by a number they know, and get a sealed result, without the key. The gate's numeric checks need nothing else:

```
cap - amount              inside the per-payment cap when the sign is +
daily - (spent + amount)  inside the daily cap when the sign is +
amount - threshold        a human is needed when the sign is +
```

The agent host computes these three sealed differences and the sealed new total. Before a difference leaves the host it is multiplied by a random factor, so the key box that opens it sees only the sign. The key box answers with the decision, signed with the approver key when one is configured, and the host records it and keeps the sealed total.

Numbers live below 2^36 base units (68,719 USDC with 6 decimals); the blinding factor is below 2^12; the plaintext space is 50 bits, so a blinded difference never wraps. One sealed number is about 200 KB, a verdict takes about 15 ms, and the whole thing runs in plain Node with one optional dependency.

## Who can do what

| party | holds | can |
|---|---|---|
| key box (your approval box) | the secret key, the clear policy | seal a policy, open verdicts, sign decisions |
| agent host | sealed numbers, encryption parameters | compute verdicts and the sealed running total; read nothing |
| anyone with a sealed verdict | three blinded differences | nothing: no key, no sizes |

## Run it

```sh
npm install                       # node-seal is a dev dependency here, an optional peer for users
npm test                          # includes fhe/test and the CLI round trip
npm run fhe:demo                  # key box and agent host as two directories on this machine
```

## The commands

| command | where | does |
|---|---|---|
| `pi-crypto-gate fhe seal --policy <file> --token <0xaddr>` | key box | generates keys (or reuses them), seals the token's `maxPerTx`, `maxPerDay`, `requireApprovalOver` and a zero into a bundle for the agent host; refuses a key box inside the working directory, the same rule as the approval store |
| `pi-crypto-gate fhe evaluate --to --amount --token --chain` | agent host | seals a verdict for one proposal, writes `<log dir>/fhe/<id>.verdict.json`, appends an `fhe-sealed` receipt |
| `pi-crypto-gate fhe open <verdict.json>` | key box | opens the three signs, writes the decision (signed with the approver key when present) back into the file |
| `pi-crypto-gate fhe apply <verdict.json>` | agent host | verifies the signature when the policy names an approver key, appends an `fhe-opened` receipt, counts the payment in the sealed ledger unless blocked; exit 0 allow or held, 3 blocked |
| `pi-crypto-gate fhe status` | either | what is here, and a warning if keys sit inside the working directory |

Defaults: keys in `$PI_CRYPTO_GATE_FHE_KEYS` or `<approval store>/fhe-keys`; the bundle in `$PI_CRYPTO_GATE_FHE_BUNDLE` or `./.pi-crypto-gate/fhe/bundle`. A new UTC day starts the sealed total from the sealed zero in the bundle.

## Layout

```
fhe/
├── src/seal.js        the cryptography: parameters, keys, seal, open, the three checks, blinding
├── src/bundle.js      the files on each side
├── src/cli.js         the five commands
├── scripts/demo.sh    the walk-through above
└── test/              the checks, the equal cases, the sealed running total, blinding
```

## What v1 leaves out, on purpose

- **Allow and deny lists.** Set membership needs a lookup inside the seal, which BFV additions cannot do; a TFHE circuit or private set intersection would, at much higher cost. Lists stay clear on the host for now.
- **A verdict that opens without your key box.** Only a threshold committee or an on-chain coprocessor (Zama's fhEVM) can do that, and that is a trust assumption this path does not make.
- **A merchant's secret against your secret.** Two parties' private inputs in one check need threshold keys or multi-party computation.
