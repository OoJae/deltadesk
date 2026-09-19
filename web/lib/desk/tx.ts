// Vault-signed transactions from the browser: simulate against the chain first (so custom errors decode before the
// user signs anything), then send through the Dynamic embedded wallet and wait for the receipt.
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { deskLaneAbi } from "./abi/DeskLane";
import { deskLaneFactoryAbi } from "./abi/DeskLaneFactory";
import { CHAIN_ID, publicClient, robinhood } from "./chain";

/** What the desk needs from a Dynamic EVM wallet (EthereumWallet satisfies this structurally). */
export interface EthereumWallet {
  address: string;
  getNetwork(): Promise<string | number | undefined>;
  switchNetwork(chainId: number | string): Promise<void>;
  getWalletClient(chainId?: string): Promise<WalletClient<Transport, Chain, Account>>;
  signMessage(message: string): Promise<string | undefined>;
}

const ERR_ABI = [...deskLaneAbi, ...deskLaneFactoryAbi].filter((x) => x.type === "error") as Abi;

const FENCE_CODES: Record<number, string> = {
  1: "unknown token",
  2: "price feed stale or dead",
  3: "oracle paused",
  4: "corporate-action window",
  5: "market closed (weekend window)",
  6: "stablecoin depeg",
  7: "price feed reverted",
  100: "lane paused",
  101: "closed-until flag active",
};
export const fenceCodeLabel = (code: number) => FENCE_CODES[code] ?? `code ${code}`;

const CAP_FIELDS = ["maxDeployUsd6", "turnoverUsd6PerDay", "placeBandBps", "maxTickDelta", "minWidthTicks", "maxWidthTicks", "reranges1h", "reranges24h", "minRerangeInterval", "maxDeadlineAhead", "maxRanges"];

function describeCustom(name: string, args: readonly unknown[] = []): string {
  switch (name) {
    case "NotOwner":
      return "Only the Vault (the lane owner) can do this.";
    case "NotAuthorized":
      return "This wallet is not allowed to call that function.";
    case "Expired":
      return "The action's deadline passed before it landed. Try again and confirm a little faster.";
    case "DeadlineTooFar":
      return "Deadline is further ahead than the lane allows.";
    case "DecisionUsed":
      return "That decision id was already used. Try again.";
    case "BadSlot":
      return `Position slot ${String(args[0])} is empty.`;
    case "OperatorIsOwner":
    case "OperatorInvalid":
      return "The Operator must be a different, non-zero wallet from the Vault.";
    case "CapsAboveCeiling":
      return `Cap "${CAP_FIELDS[Number(args[0])] ?? args[0]}" is above the factory ceiling.`;
    case "UnknownKind":
      return "The factory has no DeskLaneV3 implementation registered yet.";
    case "PoolNotAllowed":
      return "The factory has not allowed the NVDA/USDG pool yet.";
    case "PoolMismatch":
      return "Pool does not match the Uniswap v3 factory.";
    case "MarketClosed":
      return `Risk-adding is closed: ${fenceCodeLabel(Number(args[0]))}.`;
    case "TimelockActive":
      return "A 24 h timelock is still running.";
    case "NoPending":
      return "Nothing pending to apply.";
    case "IsPaused":
      return "The lane is paused.";
    default:
      return `${name}${args.length ? `(${args.map(String).join(", ")})` : ""}`;
  }
}

/** A short, human reason for any failure along the simulate -> sign -> send -> receipt path. */
export function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "Cancelled in the wallet.";
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) return describeCustom(reverted.data.errorName, reverted.data.args);
    const withData = e.walk((x) => typeof (x as { data?: unknown }).data === "string");
    const data = (withData as { data?: unknown } | null)?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: ERR_ABI, data: data as Hex });
        return describeCustom(d.errorName, d.args);
      } catch {
        /* not one of ours */
      }
    }
    if (/insufficient funds/i.test(e.message)) return "Not enough ETH for gas in this wallet.";
    return e.shortMessage || e.message;
  }
  if (e instanceof Error) {
    if (/reject|denied|cancel/i.test(e.message)) return "Cancelled in the wallet.";
    return e.message;
  }
  return String(e);
}

async function onRobinhood(wallet: EthereumWallet) {
  try {
    const net = await wallet.getNetwork();
    if (Number(net) !== CHAIN_ID) await wallet.switchNetwork(CHAIN_ID);
  } catch {
    /* embedded wallets pick the chain from getWalletClient(chainId) below */
  }
}

export type SentTx = { hash: Hash; receipt: TransactionReceipt };

/**
 * Simulate `data` from the wallet, send it, wait for the receipt. `onHash` fires as soon as the tx is broadcast so the
 * UI can link it while it confirms. Throws with a decodable error on revert.
 */
export async function sendFromWallet(wallet: EthereumWallet, to: Address, data: Hex, onHash?: (h: Hash) => void): Promise<SentTx> {
  const account = wallet.address as Address;
  await publicClient.call({ account, to, data });
  const gas = await publicClient.estimateGas({ account, to, data });
  await onRobinhood(wallet);
  const wc = await wallet.getWalletClient(String(CHAIN_ID));
  const hash = await wc.sendTransaction({ account: wc.account, chain: robinhood, to, data, gas: (gas * BigInt(125)) / BigInt(100) });
  onHash?.(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("The transaction reverted on-chain. Open it in the explorer for details.");
  return { hash, receipt };
}
