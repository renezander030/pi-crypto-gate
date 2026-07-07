# pi-crypto-gate

A policy gate that sits between an AI agent and an onchain wallet.

Part of the pi-* agent-harness family (alongside [pi-gate](https://github.com/renezander030/pi-gate), which does the same job for code changes). It is designed to sit downstream of a crypto screener: the screener surfaces an opportunity, the agent proposes the trade or payment, and this gate holds it for policy and human approval before anything moves onchain.

An agent proposes a payment. The gate decides one of three things:

- **allow** — under every limit, let it through
- **needs approval** — within the limits but large enough that a human should sign off
- **block** — breaks a rule (per-transaction cap, daily cap, wrong chain, recipient not on the allowlist), so it never leaves the process

Every decision is written to an append-only receipt log, so there is an immutable record of what the agent tried to do, whether or not it went through.

The design assumption is simple: an autonomous agent will eventually propose a payment it should not make (a prompt injection, a bad tool result, a loop). The gate is the layer that assumes that will happen and refuses to broadcast until policy and, above a threshold, a human agree.

## The failing case is the point

The interesting demo is not a payment that succeeds. It is a payment that gets stopped.

```
npm run demo
```

```
# propose 0.5 ETH
⛔  BLOCK
   0.5 ETH -> 0x1111...1111 (chain 8453)
   ✓ chain-not-allowed: chain 8453 allowed
   ✓ recipient-not-allowlisted: no allowlist set
   ✗ per-tx-cap-exceeded: 0.5 ETH > cap 0.05 ETH
   ...
Result: BLOCKED as expected. No transaction left this process.
```

The demo runs the full arc on a throwaway log: a tiny payment is auto-allowed, a mid-size one is held until a human approves it, and an over-cap one is blocked. No funds move at any point.

## CLI

```
pi-crypto-gate propose --to <0xaddr> --amount <0.05eth|wei> --chain <id> [--memo <s>] [--policy <file>] [--json]
pi-crypto-gate approve <receipt-id>     # sign off on a held payment
pi-crypto-gate execute <receipt-id>     # dry-run "broadcast" of an allowed/approved payment (no funds move)
pi-crypto-gate receipts                 # the audit trail
pi-crypto-gate demo
```

Exit codes: allowed or approval-pending `0`, blocked `3`, refused `4`, usage `2`. So the gate composes into a shell pipeline or CI check: a blocked payment fails the command.

The receipt log lives at `$PI_CRYPTO_GATE_RECEIPT_LOG` or `./.pi-crypto-gate/receipts.jsonl`.

## Integrating with an agent

There is no server to run. An agent calls the CLI the same way it calls any other tool: `pi-crypto-gate propose ... --json` prints the decision as JSON and sets an exit code (allowed or approval-pending `0`, blocked `3`), so it drops straight into a tool call, a shell pipeline, or a CI gate.

## Library

```js
import { evaluate } from "pi-crypto-gate";

const decision = evaluate(
  { to: "0x1111111111111111111111111111111111111111", amount: "0.5eth", chainId: 8453 },
  { maxPerTxWei: "0.05eth", requireApprovalOverWei: "0.01eth" },
  0n, // wei already spent today
);

decision.decision; // "block"
decision.reasons;  // ["per-tx-cap-exceeded"]
```

`evaluate` is pure and deterministic: same proposal, policy, and prior spend give the same result. Amounts are handled as BigInt wei throughout, so there is no floating-point drift.

## Policy

```json
{
  "chainAllowlist": [8453, 84532],
  "recipientAllowlist": [],
  "maxPerTxWei": "0.05eth",
  "maxPerDayWei": "0.20eth",
  "requireApprovalOverWei": "0.01eth"
}
```

An empty `recipientAllowlist` or `chainAllowlist` means "no restriction on that axis". Amounts accept `eth` / `gwei` suffixes or a raw wei integer. A partial policy is merged over the defaults, so overriding one cap leaves the rest intact.

## Execution is unwired on purpose

The default executor is a dry run. It prints the transaction it would broadcast and moves nothing. Real broadcast is intentionally not implemented in `src/executor.js`; wiring it in (a viem `WalletClient` behind `PI_CRYPTO_GATE_RPC_URL` + `PI_CRYPTO_GATE_PRIVATE_KEY`) is a deliberate step, so a misconfigured agent cannot move real funds by accident.

The gate always runs before the executor. At execution time the daily cap is re-checked against live spend, so two separately-approved payments cannot both slip past it.

## Where this fits

The pattern maps directly onto agent-payment rails like x402 and Base MCP, where an agent can initiate value transfer through a tool call. The gate is the guardrail you put in front of that tool: caps, an allowlist, a human-in-the-loop threshold, and an audit log, independent of which chain or client is underneath.

## Roadmap

- **Harness-owned approval** (the pi-gate trust model): move the approve authority outside the agent's reach so approval can only originate from a human-in-the-loop gate, never from the agent itself. Today's `approve` command is a placeholder for that boundary.
- viem-backed real broadcast behind explicit env config
- ERC-20 token transfers (calldata decoding + per-token caps)
- signed receipts

## Tests

```
npm test
```

Node's built-in test runner. No build step and no runtime dependencies.
