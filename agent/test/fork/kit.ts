/**
 * Fork e2e kit: drive the real desk (sensor, strategy, regime, critic, guard, write-ahead executor,
 * local operator signature, reconcilers) against DeskLane contracts deployed on an anvil fork of
 * Robinhood Chain with contracts/script/Deploy.s.sol.
 *
 * What is real on the fork: the NVDA/USDG pool and its liquidity, the NPM, the ERC-8056 NVDA token,
 * Multicall3, Chainlink ETH/USD, and our fence/factory/lane. What is steered:
 * - Chainlink NVDA/USD and USDG/USD: a MockFeed (test/fork/MockFeed.sol) is installed over each proxy
 *   with anvil_setCode, always as fresh as the block, so warping to a weekday session cannot kill
 *   the feed (the real rounds are frozen over weekends and die after 26 h).
 * - The pool price: moved by REAL swaps through SwapRouter02 with a sqrtPriceLimit, by a swapper
 *   funded with `deal` (storage writes: USDG balances at slot 1, NVDA in OpenZeppelin's ERC-7201
 *   ERC20 namespace), so tick crossings and fee growth stay consistent.
 * - Off-chain references (HL, RH, the engine) are fakes that follow the pool unless told otherwise.
 * - Time: the chain is warped to a weekday regular session; ChainClock follows the chain.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Abi,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  maxUint256,
  type PublicClient,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDRESSES_4663, NVDA_USDG_POOL } from "../../src/addresses.js";
import type { AppConfig } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";
import { createDaemon, type Daemon, type DaemonDeps, type LaneRuntime } from "../../src/daemon.js";
import { deskLaneAbi } from "../../src/executor/abi/DeskLane.js";
import { createBroadcaster } from "../../src/executor/broadcaster.js";
import { createCalldataBuilder } from "../../src/executor/calldata.js";
import { createChainClient, createLaneViews, robinhoodChain } from "../../src/executor/chain.js";
import { rhExecutorFromConfig } from "../../src/executor/wire.js";
import { silentLogger } from "../../src/log.js";
import { preflightLane } from "../../src/main.js";
import { regimeAt } from "../../src/market/calendar.js";
import { decodeLaneAction, LANE_ACTION_TOPIC } from "../../src/reconcile/lane-actions.js";
import { createAttemptResolver } from "../../src/reconcile/startup.js";
import { createChainReader } from "../../src/sense/chain.js";
import { createSensor } from "../../src/sense/index.js";
import { DEFAULT_LANE_CAPS } from "../../src/sense/mock.js";
import { createLocalSigner } from "../../src/signer/local.js";
import { type DeskDbHandle, openDb } from "../../src/state/db.js";
import type {
  Address,
  ApprovalGate,
  BasisK,
  ChainClient,
  Clock,
  CorpActionsState,
  DeskNotification,
  EngineSource,
  Hex,
  HlFeed,
  HlQuote,
  HourRecord,
  LaneActionEvent,
  RhFeed,
  RhQuote,
  TxSigner,
  UnsignedTx,
} from "../../src/types.js";
import { getSqrtRatioAtTick } from "../../src/units.js";

// anvil's default accounts (funded with 10 000 ETH on the fork); loopback only.
export const KEYS = {
  operator: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
  intruder: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
  swapper: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
  deployer: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // #9
} as const satisfies Record<string, Hex>;

export const addressOf = (key: Hex): Address =>
  privateKeyToAccount(key).address.toLowerCase() as Address;

const A = ADDRESSES_4663;
/** The agent's generated factory ABI is view-only (it never creates lanes): createLane comes from the
 * frozen snapshot the contracts package publishes. */
const factoryAbi: Abi = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(
    readFileSync(resolve(here, "../../../contracts/abi/IDeskLaneFactory.json"), "utf8"),
  ) as unknown;
  return (Array.isArray(raw) ? raw : (raw as { abi: Abi }).abi) as Abi;
})();
/** OpenZeppelin ERC20Upgradeable ERC-7201 namespace (the NVDA token's balances live here). */
const OZ_ERC20_NAMESPACE: Hex =
  "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const npm = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
]);
const pool = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
const router = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

/** USD per NVDA at a pool tick (token0 USDG 6 dec, token1 NVDA 18 dec). */
export function nvdaUsdAtTick(tick: number): number {
  return 1e12 / 1.0001 ** tick;
}

// ---------------------------------------------------------------------------------------------

export class Fork {
  readonly pub: PublicClient;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    this.pub = createPublicClient({ chain: robinhoodChain(4663, url), transport: http(url) });
  }

  async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  snapshot = () => this.rpc<Hex>("evm_snapshot");
  async revert(id: Hex): Promise<void> {
    const ok = await this.rpc<boolean>("evm_revert", [id]);
    if (!ok) throw new Error(`evm_revert ${id} failed`);
  }
  mine = () => this.rpc("evm_mine");
  async latestTs(): Promise<number> {
    return Number((await this.pub.getBlock({ blockTag: "latest" })).timestamp);
  }
  async setNextTimestamp(ts: number): Promise<void> {
    await this.rpc("evm_setNextBlockTimestamp", [ts]);
    await this.mine();
  }
  async warp(seconds: number): Promise<void> {
    await this.rpc("evm_increaseTime", [seconds]);
    await this.mine();
  }
  /** Pin the base fee (empty anvil blocks decay it toward zero; the hurdle needs a real one). */
  async pinBaseFee(wei = 65_426_000n): Promise<void> {
    await this.rpc("anvil_setNextBlockBaseFeePerGas", [`0x${wei.toString(16)}`]);
    await this.mine();
  }
  setStorage = (addr: Address, slot: Hex, value: bigint) =>
    this.rpc("anvil_setStorageAt", [addr, slot, `0x${value.toString(16).padStart(64, "0")}`]);

  /** Set a token balance by storage (USDG: mapping at slot 1; NVDA: the OZ ERC-7201 namespace). */
  async deal(token: Address, account: Address, amount: bigint): Promise<void> {
    const isNvda = token.toLowerCase() === A.NVDA.toLowerCase();
    const slot = isNvda
      ? keccak256(
          encodeAbiParameters(
            [{ type: "address" }, { type: "bytes32" }],
            [account, OZ_ERC20_NAMESPACE],
          ),
        )
      : keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, 1n]));
    await this.setStorage(token, slot, amount);
    const got = await this.balanceOf(token, account);
    if (got !== amount) throw new Error(`deal ${token}: balance ${got} != ${amount}`);
  }

  balanceOf = (token: Address, account: Address) =>
    this.pub.readContract({
      address: token,
      abi: erc20,
      functionName: "balanceOf",
      args: [account],
    });

  async slot0(): Promise<{
    sqrtPriceX96: bigint;
    tick: number;
    observationIndex: number;
    observationCardinality: number;
  }> {
    const r = await this.pub.readContract({
      address: A.POOL_NVDA_USDG,
      abi: pool,
      functionName: "slot0",
    });
    return {
      sqrtPriceX96: r[0],
      tick: Number(r[1]),
      observationIndex: Number(r[2]),
      observationCardinality: Number(r[3]),
    };
  }

  /** Read storage slots through anvil in parallel: anvil fetches cold slots from upstream concurrently. */
  async prefetch(slots: ReadonlyArray<readonly [Address, Hex]>, concurrency = 48): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < slots.length) {
        const [addr, slot] = slots[next++] as readonly [Address, Hex];
        await this.rpc("eth_getStorageAt", [addr, slot, "latest"]).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /**
   * The NVDA/USDG pool state a desk touches within ±radius ticks of `center` (UniswapV3Pool 0.7.6
   * layout: ticks at slot 5 (4 words each), tickBitmap at 6, positions at 7 (4 words each; keys of
   * the NPM's 200/210-tick ranges, the only widths the strategy produces), observations from 8).
   * A non-archive, high-latency upstream otherwise serves these one sequential read at a time.
   */
  async prefetchPool(center: number, radius = 700): Promise<number> {
    const P = A.POOL_NVDA_USDG;
    const slots: Array<readonly [Address, Hex]> = [];
    const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
    const at = (base: Hex, i: number): Hex => word(BigInt(base) + BigInt(i));
    for (let i = 0; i <= 8; i++) slots.push([P, word(BigInt(i))]);
    const lo = Math.floor((center - radius) / 10) * 10;
    const hi = Math.ceil((center + radius) / 10) * 10;
    const words = new Set<number>();
    for (let t = lo; t <= hi; t += 10) {
      const base = keccak256(
        encodeAbiParameters([{ type: "int24" }, { type: "uint256" }], [t, 5n]),
      );
      for (let i = 0; i < 4; i++) slots.push([P, at(base, i)]);
      words.add(Math.floor(t / 10 / 256));
      for (const width of [200, 210]) {
        const key = keccak256(encodePacked(["address", "int24", "int24"], [A.NPM, t, t + width]));
        const pos = keccak256(
          encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [key, 7n]),
        );
        for (let i = 0; i < 4; i++) slots.push([P, at(pos, i)]);
      }
    }
    for (const w of words)
      slots.push([
        P,
        keccak256(encodeAbiParameters([{ type: "int16" }, { type: "uint256" }], [w, 6n])),
      ]);
    const { observationIndex, observationCardinality } = await this.slot0();
    for (let i = 1; i <= 150; i++)
      slots.push([
        P,
        word(8n + BigInt((observationIndex + i) % Math.max(1, observationCardinality))),
      ]);
    await this.prefetch(slots);
    return slots.length;
  }

  async poolMid(): Promise<number> {
    const { sqrtPriceX96 } = await this.slot0();
    const s = Number(sqrtPriceX96) / 2 ** 96;
    return 1e12 / (s * s);
  }

  /** Install MockFeed over the NVDA and USDG Chainlink proxies (once), then set their answers. */
  async setFeeds(code: Hex, nvdaUsd: number, usdgUsd = 1): Promise<void> {
    for (const [feed, px] of [
      [A.CL_NVDA_USD, nvdaUsd],
      [A.CL_USDG_USD, usdgUsd],
    ] as const) {
      const current = await this.pub.getCode({ address: feed });
      if (current?.toLowerCase() !== code.toLowerCase())
        await this.rpc("anvil_setCode", [feed, code]);
      await this.setStorage(feed, `0x${"0".repeat(64)}`, BigInt(Math.round(px * 1e8)));
      await this.setStorage(feed, `0x${"0".repeat(63)}1`, 8n);
    }
  }

  async send(key: Hex, to: Address, data: Hex): Promise<void> {
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({
      account,
      chain: robinhoodChain(4663, this.url),
      transport: http(this.url),
    });
    const hash = await wallet.sendTransaction({ to, data, gas: 5_000_000n });
    let r: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
    try {
      r = await this.pub.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 300_000 });
    } catch (err) {
      await this.assertUpstreamAlive();
      throw err;
    }
    if (r.status !== "success") throw new Error(`tx to ${to} reverted`);
  }

  /**
   * anvil reads untouched state at the FORK BLOCK from upstream. A non-archive upstream (the public
   * Robinhood RPC keeps roughly 10 minutes of state) stops answering once that block ages out, and
   * anvil then stalls on every cold read. Probe a never-touched slot and say so plainly.
   */
  async assertUpstreamAlive(): Promise<void> {
    const slot = keccak256(stringToHex(`deltadesk-probe-${Date.now()}-${Math.random()}`));
    try {
      await this.rpc("eth_getStorageAt", [A.POOL_NVDA_USDG, slot, "latest"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/historical state|missing trie node|not available/i.test(msg)) {
        throw new Error(
          "fork upstream no longer serves the fork block's state (a non-archive FORK_RPC_URL whose state window has passed): rerun with an archive RPC",
          { cause: err },
        );
      }
    }
  }

  /** Move the pool to `target` (±1 tick) with a real swap bounded by its price limit. */
  async movePoolTo(target: number): Promise<number> {
    const { tick } = await this.slot0();
    if (target === tick) return tick;
    const up = target > tick; // NVDA in: token1/token0 rises, the tick rises
    const tokenIn = up ? A.NVDA : A.USDG;
    const tokenOut = up ? A.USDG : A.NVDA;
    const swapper = addressOf(KEYS.swapper);
    const amountIn = up ? 1_000_000n * 10n ** 18n : 500_000_000n * 10n ** 6n;
    await this.deal(tokenIn, swapper, amountIn);
    await this.send(
      KEYS.swapper,
      tokenIn,
      encodeFunctionData({
        abi: erc20,
        functionName: "approve",
        args: [A.SWAP_ROUTER_02, maxUint256],
      }),
    );
    await this.send(
      KEYS.swapper,
      A.SWAP_ROUTER_02,
      encodeFunctionData({
        abi: router,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            fee: 500,
            recipient: swapper,
            amountIn,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: getSqrtRatioAtTick(target),
          },
        ],
      }),
    );
    return (await this.slot0()).tick;
  }

  /**
   * Pull the state a rerange around the current tick touches into anvil's fork cache (the NPM mint
   * path, the pool's tick and bitmap words). A cold fork answers the first such eth_call in tens of
   * seconds, which would age the desk's snapshot past the guard's 3 s rule (correctly blocking it).
   */
  async warm(lane: Address): Promise<void> {
    const { tick } = await this.slot0();
    const c = Math.floor(tick / 10) * 10;
    const ts = await this.latestTs();
    const calldata = createCalldataBuilder(lane);
    const spans: Array<[number, number]> = [
      [c - 100, c + 110],
      [c - 200, c + 200],
      [c + 10, c + 210],
      [c - 200, c],
    ];
    for (const [i, [tickLower, tickUpper]] of spans.entries()) {
      const call = calldata.encode(
        {
          kind: "rerange",
          lane: "A",
          ranges: [{ tickLower, tickUpper, share0Bps: 10_000, share1Bps: 10_000 }],
          expectedTick: tick,
          maxTickDelta: 10,
        },
        {
          decisionId: `0x${(0xfeed0000 + i).toString(16).padStart(64, "0")}`,
          deadline: BigInt(ts + 60),
          regime: 1,
          gatesMask: 0,
          reasonHash: `0x${"0".repeat(64)}`,
        },
      );
      await this.pub
        .call({ account: addressOf(KEYS.operator), to: lane, data: call.data })
        .catch(() => undefined);
    }
  }

  async createLane(p: {
    factory: Address;
    owner: Hex;
    operator: Address;
    salt: bigint;
  }): Promise<Address> {
    const params = {
      owner: addressOf(p.owner),
      operator: p.operator,
      guardian: "0x0000000000000000000000000000000000000000" as Address,
      laneId: 0,
      kind: 1,
      pool: A.POOL_NVDA_USDG,
      caps: DEFAULT_LANE_CAPS,
      salt: `0x${p.salt.toString(16).padStart(64, "0")}` as Hex,
    };
    const lane = (await this.pub.readContract({
      address: p.factory,
      abi: factoryAbi,
      functionName: "predictLane",
      args: [params],
    })) as Address;
    await this.send(
      p.owner,
      p.factory,
      encodeFunctionData({ abi: factoryAbi, functionName: "createLane", args: [params] }),
    );
    return lane.toLowerCase() as Address;
  }

  private forkBlock: bigint | null = null;
  /** The upstream block anvil forked at: lanes are created after it, so their logs start later. */
  async forkBlockNumber(): Promise<bigint> {
    if (this.forkBlock === null) {
      const info = await this.rpc<{ forkConfig?: { forkBlockNumber?: number | string | null } }>(
        "anvil_nodeInfo",
      );
      const n = info.forkConfig?.forkBlockNumber;
      this.forkBlock = n === null || n === undefined ? 0n : BigInt(n);
    }
    return this.forkBlock;
  }

  async laneActions(lane: Address): Promise<LaneActionEvent[]> {
    // Never scan the pre-fork range: anvil forwards it upstream, and free-tier RPCs cap
    // eth_getLogs at a few blocks.
    const fromBlock = (await this.forkBlockNumber()) + 1n;
    const logs = await this.pub.getLogs({ address: lane, fromBlock, toBlock: "latest" });
    return logs
      .filter((l) => (l.topics[0] ?? "").toLowerCase() === LANE_ACTION_TOPIC)
      .map((l) =>
        decodeLaneAction({
          address: l.address as Address,
          topics: l.topics as Hex[],
          data: l.data,
          blockNumber: l.blockNumber ?? 0n,
          transactionHash: (l.transactionHash ?? "0x") as Hex,
          logIndex: l.logIndex ?? 0,
        }),
      );
  }

  /** On-chain facts the property checks after every step. */
  async laneFacts(lane: Address) {
    const read = (functionName: string, args: unknown[] = []) =>
      this.pub.readContract({ address: lane, abi: deskLaneAbi as Abi, functionName, args });
    const ids = (await read("positions")) as readonly bigint[];
    const budgets = (await read("budgets")) as readonly bigint[];
    const caps = (await read("caps")) as { turnoverUsd6PerDay: bigint };
    const nftCount = await this.pub.readContract({
      address: A.NPM,
      abi: npm,
      functionName: "balanceOf",
      args: [lane],
    });
    const owners: Address[] = [];
    for (const id of ids)
      if (id !== 0n)
        owners.push(
          (
            (await this.pub.readContract({
              address: A.NPM,
              abi: npm,
              functionName: "ownerOf",
              args: [id],
            })) as Address
          ).toLowerCase() as Address,
        );
    const allowance = async (token: Address) =>
      this.pub.readContract({
        address: token,
        abi: erc20,
        functionName: "allowance",
        args: [lane, A.NPM],
      });
    return {
      tokenIds: ids.filter((id) => id !== 0n),
      nftCount,
      owners,
      allowanceUsdg: await allowance(A.USDG),
      allowanceNvda: await allowance(A.NVDA),
      turnoverUsedUsd6: caps.turnoverUsd6PerDay - (budgets[0] ?? 0n),
      paused: (await read("paused")) as boolean,
      balances: {
        usdg: await this.balanceOf(A.USDG, lane),
        nvda: await this.balanceOf(A.NVDA, lane),
      },
    };
  }
}

/** The first weekday 16:00 UTC after `fromSec` that is a regular session well clear of reopen windows. */
export function nextSessionTs(fromSec: number): number {
  let day = Math.floor(fromSec / 86_400) + 1;
  for (let i = 0; i < 14; i++, day++) {
    const ts = day * 86_400 + 16 * 3_600;
    const ok = [0, 3_600, 7_200].every((d) => {
      const r = regimeAt(ts + d);
      return r.name === "REGULAR" && !r.reopenWindow;
    });
    if (ok) return ts;
  }
  throw new Error("no regular session found within two weeks");
}

// ---------------------------------------------------------------------------------------------
// Clock and off-chain fakes

/** Wall-clock progression anchored to the chain's latest block (anvil does the same). */
export class ChainClock implements Clock {
  private baseMs = 0;
  private wallMs = Date.now();
  now(): number {
    return this.baseMs + (Date.now() - this.wallMs);
  }
  /** Re-anchor to the chain. Never backwards: anvil mines equal-timestamp blocks, and the gate
   * machine (rightly) never completes a dwell on a clock that steps back. */
  async sync(fork: Fork): Promise<void> {
    await fork.pinBaseFee();
    const chainMs = (await fork.latestTs()) * 1000;
    const wall = Date.now();
    this.baseMs = Math.max(chainMs, this.baseMs + (wall - this.wallMs));
    this.wallMs = wall;
  }
}

export interface OffChain {
  hl: HlFeed & { mid: number };
  rh: RhFeed & { halt: boolean };
  engine: EngineSource;
}

export function offChain(clock: Clock): OffChain {
  const hl = {
    mid: 0,
    start() {},
    async stop() {},
    latest(): HlQuote | null {
      if (!(hl.mid > 0)) return null;
      const now = clock.now();
      return {
        coin: "xyz:NVDA",
        bid: hl.mid - 0.01,
        ask: hl.mid + 0.01,
        mid: hl.mid,
        markPx: hl.mid,
        oraclePx: hl.mid,
        exchangeTimeMs: now,
        receivedAtMs: now,
        source: "ws" as const,
      };
    },
    status: () => ({ ok: hl.mid > 0, ageMs: hl.mid > 0 ? 0 : null, reason: null }),
    onTrade: () => () => {},
  };
  const rh = {
    halt: false,
    async quote(symbol: string): Promise<RhQuote> {
      const now = clock.now();
      return {
        symbol,
        bid: hl.mid - 0.05,
        ask: hl.mid + 0.05,
        mid: hl.mid,
        isTradingHalt: rh.halt,
        generatedAtMs: now,
        receivedAtMs: now,
      };
    },
    async corporateActions(): Promise<CorpActionsState> {
      return {
        pendingForSymbol: false,
        nextEffectiveAtMs: null,
        items: [],
        fetchedAtMs: clock.now(),
      };
    },
  };
  // A generous fee record: the fork scenarios exercise the wiring, not the M1 economics.
  const record: HourRecord = { fees_usd: 5e8, swaps: 1000, edge_1h: 1 };
  const engine: EngineSource = {
    async basis(): Promise<BasisK> {
      return { k: 1, source: "engine", session: null, fetchedAtMs: clock.now() };
    },
    async hourRecord() {
      return record;
    },
    status: () => ({ ok: true, ageMs: 0, reason: null }),
  };
  return { hl, rh, engine };
}

// ---------------------------------------------------------------------------------------------
// The desk under test

export const approveAll: ApprovalGate = {
  async requestApproval() {
    return { approved: true, outcome: "approved", channel: "web" };
  },
  async awaitCancelWindow() {
    return { cancelled: false, channel: null };
  },
};

export interface DeskUnderTest {
  cfg: AppConfig;
  db: DeskDbHandle;
  chain: ChainClient;
  clock: ChainClock;
  off: OffChain;
  signer: TxSigner & { requests: UnsignedTx[] };
  daemon: Daemon;
  deps: DaemonDeps;
  notes: DeskNotification[];
  /** Follow the pool: HL mid = pool mid × (1 + gap), Chainlink NVDA = pool mid × (1 + refNoise). */
  follow(opts?: { gapBps?: number; refNoiseBps?: number; feedCode?: Hex }): Promise<void>;
  /** Sync the clock to the chain, then one tick; returns the lane outcome. */
  tick(): Promise<Awaited<ReturnType<Daemon["runTick"]>>["lanes"][number]["outcome"]>;
}

export async function deskUnderTest(p: {
  fork: Fork;
  lane: Address;
  feedCode: Hex;
  signerKey?: Hex;
  /** Wrap what the operator key signs (the tampered-signer scenario). */
  sign?: (tx: UnsignedTx, base: TxSigner) => Promise<Hex>;
  /** Wrap the executor's chain client (the crash scenario). */
  wrapChain?: (c: ChainClient) => ChainClient;
  dbPath?: string;
  skipPreflight?: boolean;
  deps?: Partial<DaemonDeps>;
}): Promise<DeskUnderTest> {
  const { fork } = p;
  const signerKey = p.signerKey ?? KEYS.operator;
  const cfg = loadConfig({
    CHAIN_ID: "4663",
    RH_RPC_URL: fork.url,
    SIGNER_KIND: "local",
    LOCAL_SIGNER_PRIVATE_KEY: signerKey,
    DRY_RUN: "false",
    DESK_ARM: "1",
    DESK_MODE: "copilot",
  });
  const clock = new ChainClock();
  await clock.sync(fork);
  const db = openDb(p.dbPath ?? ":memory:");
  // Generous timeout: anvil fetches cold fork state from the upstream RPC on first touch.
  const chain = createChainClient({ rpcUrl: fork.url, chainId: 4663, timeoutMs: 600_000 });
  const views = createLaneViews(chain);
  const base = createLocalSigner({ privateKey: signerKey, rpcUrl: fork.url });
  const requests: UnsignedTx[] = [];
  const signer = {
    kind: base.kind,
    address: base.address,
    requests,
    ready: () => base.ready(),
    async signTransaction(tx: UnsignedTx) {
      requests.push(tx);
      return p.sign === undefined ? base.signTransaction(tx) : p.sign(tx, base);
    },
  };
  if (p.skipPreflight !== true) {
    await preflightLane({
      cfg,
      views,
      laneAddress: p.lane,
      blockNumber: await chain.blockNumber(),
      signer: () => signer,
    });
  }
  const id = await views.identity(p.lane, await chain.blockNumber());
  if (db.getDesk(p.lane) === null)
    db.insertDesk({
      laneAddress: p.lane,
      chainId: 4663,
      laneId: id.laneId,
      owner: id.owner,
      operator: id.operator,
      ownerUserId: "fork-owner",
      signerKind: "local",
      mode: "copilot",
      modeNonce: 0,
      status: "active",
      statusDetail: null,
      capsJson: "{}",
      createdAtMs: clock.now(),
      updatedAtMs: clock.now(),
    });
  const off = offChain(clock);
  const notes: DeskNotification[] = [];
  const notifier = { notify: async (n: DeskNotification) => void notes.push(n) };
  const sensor = createSensor({
    chain: createChainReader({ client: chain }),
    hl: off.hl,
    rh: off.rh,
    engine: off.engine,
    clock,
    chainId: 4663,
    signerAddress: signer.address,
  });
  const execChain = p.wrapChain === undefined ? chain : p.wrapChain(chain);
  const executor = rhExecutorFromConfig({
    cfg,
    laneAddress: p.lane,
    db,
    chain: execChain,
    signer,
    clock,
    logger: silentLogger,
    notifier,
    ethUsd: () => 2630,
  });
  const rt: LaneRuntime = { lane: "A", laneAddress: p.lane, sensor, signer, executor };
  const deps: DaemonDeps = {
    config: cfg,
    db,
    lanes: () => [rt],
    decisionUsedAt: async (lane, did) => views.decisionUsedAt(lane, did, await chain.blockNumber()),
    notifier,
    logger: silentLogger,
    clock,
    approvalGate: approveAll,
    hourRecord: (how) => off.engine.hourRecord(how),
    random: () => 0,
    resolver: createAttemptResolver({
      db,
      chain,
      broadcaster: createBroadcaster({ chain, clock }),
      clock,
      logger: silentLogger,
      notifier,
    }),
    ...p.deps,
  };
  const daemon = createDaemon(deps);
  const d: DeskUnderTest = {
    cfg,
    db,
    chain,
    clock,
    off,
    signer,
    daemon,
    deps,
    notes,
    async follow(o = {}) {
      const mid = await fork.poolMid();
      off.hl.mid = mid * (1 + (o.gapBps ?? 0) / 1e4);
      await fork.setFeeds(o.feedCode ?? p.feedCode, mid * (1 + (o.refNoiseBps ?? 0) / 1e4));
    },
    async tick() {
      await clock.sync(fork);
      const r = await d.daemon.runTick();
      const out = r.lanes[0]?.outcome;
      if (out === undefined) throw new Error("no lane ran");
      return out;
    },
  };
  return d;
}

/** Tick until a decision is recorded (gates start active after a restart: 3 clear ticks). */
export async function tickUntilDecision(d: DeskUnderTest, max = 8) {
  for (let i = 0; i < max; i++) {
    const out = await d.tick();
    if (out.kind === "decision") return out;
  }
  throw new Error(`no decision within ${max} ticks`);
}

/** Base setup shared by the fork suites: a funded, empty lane A in a weekday session. */
export async function setupLane(
  fork: Fork,
  env: { factory: Address; feedCode: Hex },
  salt: bigint,
): Promise<Address> {
  const now = await fork.latestTs();
  await fork.setNextTimestamp(nextSessionTs(now));
  await fork.pinBaseFee();
  const mid = await fork.poolMid();
  await fork.setFeeds(env.feedCode, mid);
  const lane = await fork.createLane({
    factory: env.factory,
    owner: KEYS.owner,
    operator: addressOf(KEYS.operator),
    salt,
  });
  // ≈ $25 of each side; the lane's caps allow $60 per rerange.
  await fork.deal(NVDA_USDG_POOL.token0, lane, 25_000_000n);
  await fork.deal(NVDA_USDG_POOL.token1, lane, BigInt(Math.round((25 / mid) * 1e18)));
  await fork.warm(lane);
  return lane;
}

/** Guard violations that only mean "the fork answered slowly" (cold upstream state), never policy. */
function coldForkOnly(d: DeskUnderTest, decisionId: string): boolean {
  const raw = d.db.getDecision(decisionId)?.guardViolationsJson ?? "[]";
  const vs = JSON.parse(raw) as Array<{ rule: string; detail: string }>;
  return (
    vs.length > 0 &&
    vs.some((v) => v.rule === "snapshot-provenance" && / ms old > /.test(v.detail)) &&
    vs.every(
      (v) =>
        (v.rule === "snapshot-provenance" && / ms old > /.test(v.detail)) ||
        (v.rule === "simulation-ok" && /too long|timed? ?out/i.test(v.detail)) ||
        (v.rule === "gas-reserve" && /gas cost unknown/.test(v.detail)),
    )
  );
}

/**
 * Tick until a decision is recorded. A decision the guard blocked ONLY because a cold fork made the
 * snapshot age past 3 s (correct, fail-closed) is retried after the adding hold and a cache warm.
 */
export async function untilDecision(d: DeskUnderTest, fork: Fork, lane: Address, max = 10) {
  for (let i = 0; i < max; i++) {
    const out = await d.tick();
    if (out.kind !== "decision") continue;
    if (out.status === "blocked" && coldForkOnly(d, out.decisionId)) {
      await fork.warp(301);
      await fork.warm(lane);
      continue;
    }
    return out;
  }
  throw new Error(`no decision within ${max} ticks`);
}
