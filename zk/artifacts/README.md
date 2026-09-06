# zk/artifacts

Outputs of the **dev** Groth16 ceremony for `zk/circuits/cap_policy.circom`, produced by `npm run zk:ceremony`:

| file | what |
|---|---|
| `cap_policy.zkey` | proving key. One contributor (the machine that ran the script); its toxic waste lived in that process. Fine for tests and a local Anvil, not for value. |
| `verification_key.json` | the matching verification key; `zk verify` and the tests use it |
| `build-info.json` | when it was built and the circuit's constraint count; `npm run zk:build` warns when the circuit drifts from it |

Two more files belong to the same ceremony and change with it: the Solidity verifier `zk/contracts/src/CapPolicyVerifier.sol` and the proof fixture `zk/contracts/test/fixtures/cap-fixture.json`. All of them are regenerated together, never one at a time.

The witness generator (`zk/build/cap_policy_js/cap_policy.wasm`) is not committed; `npm run zk:build` compiles it in about a second.

Deploying for real means running your own ceremony (a public Powers of Tau for phase 1, your own phase 2 contribution) and deploying the verifier that produces.
