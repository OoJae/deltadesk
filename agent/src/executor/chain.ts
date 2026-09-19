/**
 * The RPC surface of the executor, reconciler, webhook API and watchdog (ChainClient), over viem.
 *
 * - Primary RPC plus an optional fallback (viem `fallback` transport).
 * - Calls are block-pinned where the interface asks for it (simulation, lane views).
 * - Provider URLs carry the API key in the path, so every error leaving this module has the RPC URLs
 *   scrubbed from its message, details and stack IN PLACE: the error keeps its class, so the
 *   classifier's `err.walk()` still sees what it was.
 */

import {
  type Abi,
  BaseError,
  type ContractFunctionArgs,
  type ContractFunctionName,
  createPublicClient,
  type DecodeFunctionResultReturnType,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  fallback,
  http,
  type PublicClient,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Transport,
  toHex,
  zeroAddress,
} from "viem";
import { scrubRpcUrl } from "../config.js";
import type {
  Address,
  BlockHeader,
  ChainClient,
  ChainTx,
  Hex,
  LaneBudgets,
  LaneCaps,
  RawLog,
  TxReceipt,
} from "../types.js";
import { deskLaneAbi } from "./abi/DeskLane.js";

export type { BlockHeader, ChainClient, ChainTx, RawLog, TxReceipt } from "../types.js";

export function robinhoodChain(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: chainId === 4663 ? "Robinhood Chain" : `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** Replace every RPC URL (and its key-bearing path) in an error chain's strings, in place. */
export function scrubErrorUrls<E>(err: E, rpcUrls: readonly string[]): E {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < 16 && cur !== null && typeof cur === "object"; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const rec = cur as Record<string, unknown>;
    for (const k of ["message", "shortMessage", "details", "stack", "url"]) {
      const v = rec[k];
      if (typeof v !== "string") continue;
      let out = v;
      for (const u of rpcUrls) out = scrubRpcUrl(out, u);
      if (out !== v) {
        try {
          rec[k] = out;
        } catch {
          // non-writable (frozen) field: nothing we can do, the caller still scrubs on log
        }
      }
    }
    const metas = rec.metaMessages;
    if (Array.isArray(metas)) {
      rec.metaMessages = metas.map((m) =>
        typeof m === "string" ? rpcUrls.reduce((s, u) => scrubRpcUrl(s, u), m) : m,
      );
    }
    cur = rec.cause;
  }
  return err;
}

export interface ChainClientOptions {
  rpcUrl: string;
  fallbackUrl?: string | undefined;
  chainId: number;
  /** Per-request timeout; default 10 s. */
  timeoutMs?: number;
  /** Test seam: a custom viem transport (e.g. `custom({ request })`). */
  transport?: Transport;
}

function toRawLog(l: {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string | bigint | null;
  transactionHash: string | null;
  logIndex: string | number | null;
}): RawLog {
  return {
    address: l.address.toLowerCase() as Address,
    topics: l.topics.map((t) => t.toLowerCase() as Hex),
    data: l.data as Hex,
    blockNumber: typeof l.blockNumber === "bigint" ? l.blockNumber : BigInt(l.blockNumber ?? 0),
    transactionHash: (l.transactionHash ?? "0x").toLowerCase() as Hex,
    logIndex: typeof l.logIndex === "number" ? l.logIndex : Number(BigInt(l.logIndex ?? 0)),
  };
}

export function createChainClient(opts: ChainClientOptions): ChainClient & {
  readonly viem: PublicClient;
} {
  const timeout = opts.timeoutMs ?? 10_000;
  const urls = [opts.rpcUrl, ...(opts.fallbackUrl ? [opts.fallbackUrl] : [])];
  const transport =
    opts.transport ??
    (opts.fallbackUrl
      ? fallback([
          http(opts.rpcUrl, { timeout, retryCount: 1 }),
          http(opts.fallbackUrl, { timeout, retryCount: 1 }),
        ])
      : http(opts.rpcUrl, { timeout, retryCount: 1 }));
  const client = createPublicClient({
    chain: robinhoodChain(opts.chainId, opts.rpcUrl),
    transport,
  }) as PublicClient;

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw scrubErrorUrls(err, urls);
    }
  }

  return {
    viem: client,
    chainId: () => guarded(() => client.getChainId()),
    blockNumber: () => guarded(() => client.getBlockNumber({ cacheTime: 0 })),
    getBlock: (tag) =>
      guarded(async () => {
        const b =
          tag === "latest"
            ? await client.getBlock({ blockTag: "latest" })
            : await client.getBlock({ blockNumber: tag });
        return {
          number: b.number,
          timestamp: b.timestamp,
          hash: b.hash,
          baseFeePerGas: b.baseFeePerGas ?? null,
        } satisfies BlockHeader;
      }),
    call: (req) =>
      guarded(async () => {
        const r = await client.call({
          account: req.from,
          to: req.to,
          data: req.data,
          value: req.value,
          blockNumber: req.blockNumber,
        });
        return (r.data ?? "0x") as Hex;
      }),
    estimateGas: (req) =>
      guarded(() =>
        client.estimateGas({ account: req.from, to: req.to, data: req.data, value: req.value }),
      ),
    getTransactionCount: (address, blockTag) =>
      guarded(() => client.getTransactionCount({ address, blockTag })),
    getBalance: (address, blockNumber) =>
      guarded(() =>
        blockNumber === undefined
          ? client.getBalance({ address })
          : client.getBalance({ address, blockNumber }),
      ),
    sendRawTransaction: (raw) =>
      guarded(() => client.sendRawTransaction({ serializedTransaction: raw })),
    getTransaction: (hash) =>
      guarded(async () => {
        try {
          const tx = await client.getTransaction({ hash });
          return {
            hash: tx.hash,
            from: tx.from,
            nonce: tx.nonce,
            blockNumber: tx.blockNumber ?? null,
          } satisfies ChainTx;
        } catch (err) {
          if (err instanceof BaseError && err.walk((e) => e instanceof TransactionNotFoundError))
            return null;
          throw err;
        }
      }),
    getTransactionReceipt: (hash) =>
      guarded(async () => {
        try {
          const r = await client.getTransactionReceipt({ hash });
          return {
            transactionHash: r.transactionHash,
            status: r.status,
            blockNumber: r.blockNumber,
            gasUsed: r.gasUsed,
            effectiveGasPrice: r.effectiveGasPrice,
            logs: r.logs.map(toRawLog),
          } satisfies TxReceipt;
        } catch (err) {
          if (
            err instanceof BaseError &&
            err.walk((e) => e instanceof TransactionReceiptNotFoundError)
          )
            return null;
          throw err;
        }
      }),
    getLogs: (p) =>
      guarded(async () => {
        const logs = (await client.request({
          method: "eth_getLogs",
          params: [
            {
              address: p.address,
              fromBlock: toHex(p.fromBlock),
              toBlock: toHex(p.toBlock),
              ...(p.topics === undefined ? {} : { topics: p.topics }),
            },
          ],
        })) as Parameters<typeof toRawLog>[0][];
        return logs.map(toRawLog);
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// Read helpers over ChainClient.call (block-pinned views)

/** A typed, block-pinned view call through ChainClient (from the zero address). */
export async function readContract<
  const abi extends Abi,
  name extends ContractFunctionName<abi, "pure" | "view">,
  const args extends ContractFunctionArgs<abi, "pure" | "view", name>,
>(
  chain: Pick<ChainClient, "call">,
  p: { address: Address; abi: abi; functionName: name; args?: args; blockNumber: bigint },
): Promise<DecodeFunctionResultReturnType<abi, name, args>> {
  const data = encodeFunctionData({
    abi: p.abi,
    functionName: p.functionName,
    args: p.args,
  } as Parameters<typeof encodeFunctionData>[0]);
  const ret = await chain.call({
    from: zeroAddress,
    to: p.address,
    data,
    blockNumber: p.blockNumber,
  });
  return decodeFunctionResult({
    abi: p.abi,
    functionName: p.functionName,
    args: p.args,
    data: ret,
  } as Parameters<typeof decodeFunctionResult>[0]) as DecodeFunctionResultReturnType<
    abi,
    name,
    args
  >;
}

export interface LaneIdentity {
  owner: Address;
  operator: Address;
  guardian: Address;
  laneId: number;
  pool: Address;
  token0: Address;
  token1: Address;
  fence: Address;
  paused: boolean;
}

export interface LaneViews {
  identity(lane: Address, blockNumber: bigint): Promise<LaneIdentity>;
  caps(lane: Address, blockNumber: bigint): Promise<LaneCaps>;
  budgets(lane: Address, blockNumber: bigint): Promise<LaneBudgets>;
  positions(lane: Address, blockNumber: bigint): Promise<readonly [bigint, bigint]>;
  paused(lane: Address, blockNumber: bigint): Promise<boolean>;
  decisionUsedAt(lane: Address, decisionId: Hex, blockNumber: bigint): Promise<bigint>;
}

const lowerAddr = (a: string): Address => a.toLowerCase() as Address;

/** The lane's views, read one call at a time at a pinned block. */
export function createLaneViews(chain: Pick<ChainClient, "call">): LaneViews {
  const read = <name extends ContractFunctionName<typeof deskLaneAbi, "view">>(
    lane: Address,
    functionName: name,
    blockNumber: bigint,
    args?: ContractFunctionArgs<typeof deskLaneAbi, "view", name>,
  ) =>
    readContract(chain, {
      address: lane,
      abi: deskLaneAbi,
      functionName,
      blockNumber,
      ...(args === undefined ? {} : { args }),
    } as Parameters<typeof readContract>[1]) as Promise<unknown>;

  return {
    async identity(lane, blockNumber) {
      const [owner, operator, guardian, laneId, pool, token0, token1, fence, paused] =
        await Promise.all([
          read(lane, "owner", blockNumber),
          read(lane, "operator", blockNumber),
          read(lane, "guardian", blockNumber),
          read(lane, "laneId", blockNumber),
          read(lane, "pool", blockNumber),
          read(lane, "token0", blockNumber),
          read(lane, "token1", blockNumber),
          read(lane, "fence", blockNumber),
          read(lane, "paused", blockNumber),
        ]);
      return {
        owner: lowerAddr(owner as string),
        operator: lowerAddr(operator as string),
        guardian: lowerAddr(guardian as string),
        laneId: Number(laneId),
        pool: lowerAddr(pool as string),
        token0: lowerAddr(token0 as string),
        token1: lowerAddr(token1 as string),
        fence: lowerAddr(fence as string),
        paused: paused as boolean,
      };
    },
    async caps(lane, blockNumber) {
      return (await read(lane, "caps", blockNumber)) as LaneCaps;
    },
    async budgets(lane, blockNumber) {
      const [turnoverAvailableUsd6, reranges1hLeft, reranges24hLeft, nextRerangeAt] = (await read(
        lane,
        "budgets",
        blockNumber,
      )) as readonly [bigint, bigint, bigint, bigint];
      return { turnoverAvailableUsd6, reranges1hLeft, reranges24hLeft, nextRerangeAt };
    },
    async positions(lane, blockNumber) {
      const ids = (await read(lane, "positions", blockNumber)) as readonly bigint[];
      return [ids[0] ?? 0n, ids[1] ?? 0n] as const;
    },
    async paused(lane, blockNumber) {
      return (await read(lane, "paused", blockNumber)) as boolean;
    },
    async decisionUsedAt(lane, decisionId, blockNumber) {
      return BigInt(
        (await read(lane, "decisionUsedAt", blockNumber, [decisionId] as never)) as bigint | number,
      );
    },
  };
}
