// Execution layer. Nothing here runs until the gate says so. The default
// executor is a dry run: it prints the transaction it would broadcast and moves
// no funds. Real broadcast is left unwired on purpose — enable it only when you
// understand the key handling.
import { formatAsset } from "./assets.js";

/** Build the EVM transaction shape a real broadcaster would submit. */
export function buildTx(proposal) {
  const isAllowance = proposal.action === "allowance";
  return {
    to: proposal.to,
    // Canonical base-unit string from the gate.
    valueWei: isAllowance || proposal.token ? "0" : proposal.amount,
    amount: proposal.amount,
    chainId: proposal.chainId,
    token: proposal.token ?? null, // null => native value transfer
    action: proposal.action ?? "value_transfer",
    spender: proposal.spender ?? null,
    data: isAllowance ? "<erc20 approve calldata>" : proposal.token ? "<erc20 transfer calldata>" : "0x",
  };
}

/** Dry run: never touches a chain. Returns a preview for the receipt/log. */
export function dryRunExecute(proposal) {
  const tx = buildTx(proposal);
  const asset = proposal.asset ?? { symbol: "ETH", decimals: 18 };
  const target = proposal.action === "allowance" ? proposal.spender ?? proposal.to : proposal.to;
  const verb = proposal.action === "allowance" ? "allowance for" : "->";
  return {
    broadcast: false,
    mode: "dry-run",
    preview: `${formatAsset(proposal.amount, asset)} ${verb} ${target} on chain ${proposal.chainId}`,
    tx,
  };
}

/**
 * Real broadcast is intentionally not implemented. To wire it, add a viem
 * WalletClient here behind PI_CRYPTO_GATE_RPC_URL + PI_CRYPTO_GATE_PRIVATE_KEY
 * and gate it on both env vars being present.
 */
export function realExecute() {
  throw new Error(
    "real broadcast not enabled: this is a safety demo. Wire a viem WalletClient in src/executor.js behind PI_CRYPTO_GATE_RPC_URL + PI_CRYPTO_GATE_PRIVATE_KEY to enable.",
  );
}
