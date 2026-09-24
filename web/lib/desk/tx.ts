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
import { priceFenceAbi } from "./abi/PriceFence";
import { CHAIN_ID, publicClient, robinhood } from "./chain";
import { short } from "./format";

/** What the desk needs from a Dynamic EVM wallet (EthereumWallet satisfies this structurally). */
export interface EthereumWallet {
  address: string;
  getNetwork(): Promise<string | number | undefined>;
  switchNetwork(chainId: number | string): Promise<void>;
  getWalletClient(chainId?: string): Promise<WalletClient<Transport, Chain, Account>>;
  signMessage(message: string): Promise<string | undefined>;
}

// Every custom error the desk can hit: the lane, the factory and the fence (interfaces plus contracts/abi/extras.json).
const ERR_ABI = [...deskLaneAbi, ...deskLaneFactoryAbi, ...priceFenceAbi].filter((x) => x.type === "error") as Abi;

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

/** IDeskTypes.Caps in struct order: CapsAboveCeiling(field) indexes this. */
const CAP_FIELDS = ["maxDeployUsd6", "turnoverUsd6PerDay", "placeBandBps", "maxTickDelta", "minWidthTicks", "maxWidthTicks", "reranges1h", "reranges24h", "minRerangeInterval", "maxDeadlineAhead", "maxRanges"];
/** CapsLib.MIN_FIELDS: floors (larger is tighter), so the factory's "ceiling" for these is a minimum. */
const MIN_CAP_FIELDS = new Set([4, 8]);
const capOutsideCeiling = (field: unknown) => {
  const i = Number(field);
  const name = CAP_FIELDS[i] ?? String(field);
  return MIN_CAP_FIELDS.has(i) ? `Cap "${name}" is below the factory's minimum.` : `Cap "${name}" is above the factory ceiling.`;
};
const BUCKETS = ["daily turnover", "hourly rerange", "daily rerange"];
const CONFIG_CODES: Record<number, string> = { 1: "a zero address", 2: "caps of the wrong shape", 3: "caps above the ceilings", 4: "unsupported token decimals", 5: "the wrong position manager" };

const when = (unix: unknown) => new Date(Number(unix) * 1000).toLocaleString();
const usd6 = (x: unknown) => `$${(Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** One human sentence per custom error of the lane, the factory and the fence. `a` holds the decoded arguments. */
const ERRORS: Record<string, (a: readonly unknown[]) => string> = {
  // lane
  NotOwner: () => "Only the Vault (the lane owner) can do this.",
  NotAuthorized: () => "This wallet is not allowed to call that function.",
  NotFactory: () => "Only the factory can initialize a lane.",
  AlreadyInitialized: () => "This lane is already initialized.",
  IsPaused: () => "The lane is paused.",
  ZeroDecision: () => "The action has an empty decision id.",
  DecisionUsed: () => "That decision id was already used. Try again.",
  Expired: () => "The action's deadline passed before it landed. Try again and confirm a little faster.",
  DeadlineTooFar: () => "Deadline is further ahead than the lane allows.",
  TooSoon: (a) => `Too soon after the last rerange: the next one is allowed at ${when(a[0])}.`,
  BucketEmpty: (a) => `The ${BUCKETS[Number(a[0])] ?? "rate-limit"} budget is used up for now.`,
  TooManyRanges: (a) => `${String(a[0])} ranges is more than the lane allows.`,
  BadRange: (a) => `Range ${String(a[0])} is invalid (off the tick spacing, inverted, or outside the width caps).`,
  SharesExceed: () => "The ranges ask for more than 100% of the idle balances.",
  RangeOutsideFence: (a) => `Range ${String(a[0])} sits outside the Chainlink placement band.`,
  PoolTickMoved: (a) => `The pool moved more than ${String(a[2])} ticks since the plan.`,
  TickDeltaAboveCap: (a) => `The tick tolerance asked for is above the lane's cap of ${String(a[1])}.`,
  MarketClosed: (a) => `Risk-adding is closed: ${fenceCodeLabel(Number(a[0]))}.`,
  ClosedUntilActive: (a) => `Risk-adding is closed until ${when(a[0])}.`,
  DeployCapExceeded: (a) => `That deploys ${usd6(a[0])}, above the ${usd6(a[1])} per-rerange cap.`,
  TimelockActive: (a) => `A 24 h timelock is still running${a.length ? ` (until ${when(a[0])})` : ""}.`,
  NoPending: () => "Nothing pending to apply.",
  InvalidConfig: (a) => `The lane configuration is invalid: ${CONFIG_CODES[Number(a[0])] ?? `code ${String(a[0])}`}.`,
  BadSlot: (a) => `Position slot ${String(a[0])} is empty.`,
  OperatorIsOwner: () => "The Operator must be a different, non-zero wallet from the Vault.",
  ReentrancyGuardReentrantCall: () => "The lane refused a re-entrant call.",
  SafeERC20FailedOperation: (a) => `A token transfer failed (token ${short(String(a[0]))}); it may be paused or blocklisting the lane.`,
  // factory
  NotAdmin: () => "Only the factory admin can do this.",
  UnknownKind: () => "The factory has no DeskLaneV3 implementation registered yet.",
  PoolNotAllowed: () => "The factory has not allowed the NVDA/USDG pool yet.",
  PoolMismatch: () => "Pool does not match the Uniswap v3 factory.",
  CapsAboveCeiling: (a) => capOutsideCeiling(a[0]),
  OperatorInvalid: () => "The Operator must be a different, non-zero wallet from the Vault.",
  LaneExists: (a) => `A lane with these exact settings already exists (${short(String(a[0]))}) and is already listed, so nothing was created.`,
  ImplementationTimelocked: (a) => `The replacement lane implementation is timelocked until ${when(a[1])}.`,
  NoPendingImplementation: () => "No replacement lane implementation is pending.",
  ZeroAddress: () => "An address is zero or has no code.",
  BadCeilings: () => "The caps ceilings are inconsistent.",
  CloneArgumentsTooLong: () => "The lane's clone arguments are too long.",
  Create2EmptyBytecode: () => "The lane clone had no bytecode to deploy.",
  FailedDeployment: () => "The lane clone could not be deployed.",
  InsufficientBalance: () => "The factory lacks the balance for this deployment.",
  // fence
  BadConfig: (a) => `The price fence's configuration entry ${String(a[0])} is invalid.`,
};

/** "Human sentence (ErrorName)", so the exact revert stays visible for support and the explorer. */
function describeCustom(name: string, args: readonly unknown[] = []): string {
  const sentence = ERRORS[name];
  if (sentence) return `${sentence(args)} (${name})`;
  return `${name}${args.length ? `(${args.map(String).join(", ")})` : ""}`;
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
/** A plain native-ETH transfer from the wallet (no calldata), waited to its receipt. */
export async function sendValueFromWallet(wallet: EthereumWallet, to: Address, value: bigint, onHash?: (h: Hash) => void): Promise<SentTx> {
  await onRobinhood(wallet);
  const wc = await wallet.getWalletClient(String(CHAIN_ID));
  const hash = await wc.sendTransaction({ account: wc.account, chain: robinhood, to, value, gas: BigInt(21000) });
  onHash?.(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("The transfer reverted on-chain. Open it in the explorer for details.");
  return { hash, receipt };
}

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
