// Execution layer. The whole point of this project is that NOTHING here runs
// until the gate says so. The default executor is a dry run: it prints the
// transaction it *would* broadcast and moves no funds. Real broadcast is left
// unwired on purpose — enable it only when you understand the key handling.
import { formatEth } from "./money.js";

/** Build the EVM transaction shape a real broadcaster would submit. */
export function buildTx(proposal) {
  return {
    to: proposal.to,
    valueWei: proposal.amount, // canonical wei string from the gate
    chainId: proposal.chainId,
    token: proposal.token ?? null, // null => native value transfer
    data: proposal.token ? "<erc20 transfer calldata>" : "0x",
  };
}

/** Dry run: never touches a chain. Returns a preview for the receipt/log. */
export function dryRunExecute(proposal) {
  const tx = buildTx(proposal);
  return {
    broadcast: false,
    mode: "dry-run",
    preview: `${formatEth(proposal.amount)} -> ${proposal.to} on chain ${proposal.chainId}`,
    tx,
  };
}

/**
 * Real broadcast is intentionally not implemented. This keeps the demo safe by
 * default: a misconfigured or over-eager agent still cannot move funds. To wire
 * it, add a viem WalletClient here behind PI_CRYPTO_GATE_RPC_URL +
 * PI_CRYPTO_GATE_PRIVATE_KEY and gate it on both env vars being present.
 */
export function realExecute() {
  throw new Error(
    "real broadcast not enabled: this is a safety demo. Wire a viem WalletClient in src/executor.js behind PI_CRYPTO_GATE_RPC_URL + PI_CRYPTO_GATE_PRIVATE_KEY to enable.",
  );
}
