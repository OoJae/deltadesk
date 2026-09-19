/**
 * The wiring harness: a real createDaemon driven by fakes at the edges only.
 *
 * Real: the strategy, regime machine, plan critic, overlay stage, guard, approval posture logic,
 * the 4663 write-ahead executor (calldata, simulator, fees, nonces, broadcaster, signed-bytes
 * verification), the attempt resolver, the SQLite store and a real secp256k1 signature.
 * Fake: the world (a snapshot built from sense/mock.ts that the test can steer), the chain (an
 * in-memory node that mines instantly), the clock, the human (approval gate) and the notifier.
 */

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedEIP1559,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../../src/config.js";
import {
  createDaemon,
  type Daemon,
  type DaemonDeps,
  type LaneTickOutcome,
} from "../../src/daemon.js";
import { deskLaneAbi } from "../../src/executor/abi/DeskLane.js";
import { createBroadcaster } from "../../src/executor/broadcaster.js";
import { createCalldataBuilder } from "../../src/executor/calldata.js";
import { createFeePolicy } from "../../src/executor/fees.js";
import { createHlExecutor } from "../../src/executor/hl-executor.js";
import { createNonceManager } from "../../src/executor/nonce.js";
import { createRhExecutor } from "../../src/executor/rh-executor.js";
import { createSimulator } from "../../src/executor/simulate.js";
import { createHedgeEngine } from "../../src/hedge/engine.js";
import { poolMidFromSqrt } from "../../src/market/fair-value.js";
import { createAttemptResolver } from "../../src/reconcile/startup.js";
import {
  DEFAULT_LANE_CAPS,
  MOCK_NOW_MS,
  MOCK_POOL_TICK,
  MOCK_SQRT_PRICE_X96,
  mockSnapshot,
} from "../../src/sense/mock.js";
import { createLocalSigner } from "../../src/signer/local.js";
import type { DeskDbHandle } from "../../src/state/db.js";
import type {
  Address,
  ApprovalGate,
  BlockHeader,
  ChainClient,
  ChainTx,
  DecisionRow,
  DeskMode,
  DeskNotification,
  DeskSnapshot,
  DeskStatus,
  Executor,
  Hex,
  HlExchangeClient,
  Lane,
  LaneCaps,
  NpmPosition,
  OverlayCritic,
  OverlayPlanner,
  OverlayProposal,
  RawLog,
  TxReceipt,
  TxSigner,
  UnsignedTx,
} from "../../src/types.js";
import { ANVIL_KEY_0, fixedClock, makeTestConfig, memDb, OWNER, type TestClock } from "./fakes.js";

export const LANE_A: Address = "0x1111111111111111111111111111111111111111";
export const LANE_B: Address = "0x4444444444444444444444444444444444444444";
export const EVIL: Address = "0x6666666666666666666666666666666666666666";
/** anvil account #1 and #2 (loopback only): a stranger key and a would-be attacker key. */
export const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const ANVIL_KEY_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const OPERATOR_A = privateKeyToAccount(ANVIL_KEY_0).address.toLowerCase() as Address;
export const LOOPBACK = "http://127.0.0.1:8545";
export const T0 = MOCK_NOW_MS;

type CallReq = Parameters<ChainClient["call"]>[0];

/** An in-memory node. Every tx it accepts is mined at once (unless told otherwise). */
export class WiringChain implements ChainClient {
  head = 1_000n;
  timestampSec = BigInt(Math.floor(T0 / 1000));
  baseFee: bigint | null = 10_000_000n;
  /** Balances the lane mints from (drives the rerange return values). */
  laneBalances = { token0: 25_000_000n, token1: 112_400_000_000_000_000n };
  /** A queued error is thrown by the next sendRawTransaction. */
  sendErrors: unknown[] = [];
  /** The next N sendRawTransaction calls never return (a process that died mid-broadcast). */
  hangSends = 0;
  /** Revert every eth_call with this error (a policy revert in simulation). */
  callError: unknown = null;
  counts = new Map<string, { pending: number; latest: number }>();
  /** Every raw tx the node accepted. */
  sent: Hex[] = [];
  receipts = new Map<string, TxReceipt>();
  txs = new Map<string, ChainTx>();
  logs: RawLog[] = [];

  count(address: Address) {
    const k = address.toLowerCase();
    let c = this.counts.get(k);
    if (c === undefined) {
      c = { pending: 0, latest: 0 };
      this.counts.set(k, c);
    }
    return c;
  }
  async chainId() {
    return 4663;
  }
  async blockNumber() {
    return this.head;
  }
  async getBlock(tag: "latest" | bigint): Promise<BlockHeader> {
    const n = tag === "latest" ? this.head : tag;
    return {
      number: n,
      timestamp: this.timestampSec,
      hash: keccak256(`0x${n.toString(16).padStart(8, "0")}`),
      baseFeePerGas: this.baseFee,
    };
  }
  async call(req: CallReq): Promise<Hex> {
    if (this.callError !== null) throw this.callError;
    const { functionName, args } = decodeFunctionData({ abi: deskLaneAbi, data: req.data });
    if (functionName !== "rerange") return "0x";
    const ranges = (args as readonly unknown[])[1] as ReadonlyArray<{
      share0Bps: number;
      share1Bps: number;
    }>;
    let s0 = 0n;
    let s1 = 0n;
    for (const r of ranges) {
      s0 += BigInt(r.share0Bps);
      s1 += BigInt(r.share1Bps);
    }
    return encodeFunctionResult({
      abi: deskLaneAbi,
      functionName: "rerange",
      result: [
        ranges.map((_, i) => BigInt(100 + i)),
        ranges.map(() => 1_000_000_000n),
        (this.laneBalances.token0 * s0) / 10_000n,
        (this.laneBalances.token1 * s1) / 10_000n,
      ],
    });
  }
  async estimateGas() {
    return 900_000n;
  }
  async getTransactionCount(address: Address, tag: "pending" | "latest") {
    return this.count(address)[tag];
  }
  async getBalance() {
    return 10n ** 18n;
  }
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    if (this.hangSends > 0) {
      this.hangSends -= 1;
      return new Promise<Hex>(() => {});
    }
    const err = this.sendErrors.shift();
    if (err !== undefined) throw err;
    this.sent.push(raw);
    const hash = keccak256(raw);
    const tx = parseTransaction(raw);
    const from = (
      await recoverTransactionAddress({
        serializedTransaction: raw as TransactionSerializedEIP1559,
      })
    ).toLowerCase() as Address;
    const nonce = tx.nonce ?? 0;
    this.head += 1n;
    const c = this.count(from);
    c.latest = Math.max(c.latest, nonce + 1);
    c.pending = Math.max(c.pending, c.latest);
    this.txs.set(hash, { hash, from, nonce, blockNumber: this.head });
    this.receipts.set(hash, {
      transactionHash: hash,
      status: "success",
      blockNumber: this.head,
      gasUsed: 700_000n,
      effectiveGasPrice: this.baseFee ?? 10_000_000n,
      logs: [],
    });
    return hash;
  }
  async getTransaction(hash: Hex) {
    return this.txs.get(hash) ?? null;
  }
  async getTransactionReceipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
  async getLogs(p: { address: Address; fromBlock: bigint; toBlock: bigint }) {
    return this.logs.filter(
      (l) =>
        l.address.toLowerCase() === p.address.toLowerCase() &&
        l.blockNumber >= p.fromBlock &&
        l.blockNumber <= p.toBlock,
    );
  }
  /** Parsed `to` of every accepted transaction. */
  sentTo(): Address[] {
    return this.sent.map((r) => (parseTransaction(r).to ?? "0x").toLowerCase() as Address);
  }
}

/** A LaneAction log exactly as the lane emits it. */
export function laneActionLog(p: {
  lane?: Address;
  decisionId: Hex;
  action: number;
  caller: Address;
  txHash: Hex;
  blockNumber: bigint;
  logIndex?: number;
  /** The Meta the lane logs (defaults: regime 1, gatesMask 0, a fixed reasonHash). */
  regime?: number;
  gatesMask?: number;
  reasonHash?: Hex;
}): RawLog {
  const topics = encodeEventTopics({
    abi: deskLaneAbi,
    eventName: "LaneAction",
    args: { lane: 0, decisionId: p.decisionId, action: p.action },
  }) as Hex[];
  const data = encodeAbiParameters(
    [
      { type: "int24[]" },
      { type: "uint256" },
      { type: "uint8" },
      { type: "uint16" },
      { type: "bytes32" },
      { type: "address" },
    ],
    [[], 0n, p.regime ?? 1, p.gatesMask ?? 0, p.reasonHash ?? keccak256("0x02"), p.caller],
  );
  return {
    address: (p.lane ?? LANE_A).toLowerCase() as Address,
    topics,
    data,
    blockNumber: p.blockNumber,
    transactionHash: p.txHash,
    logIndex: p.logIndex ?? 0,
  };
}

/** The world the fake sensor reports. Tests mutate it between ticks. */
export interface World {
  lane: Lane;
  laneAddress: Address;
  /** What the snapshot CLAIMS the lane is (provenance tampering); default laneAddress. */
  reportedLaneAddress: Address | null;
  owner: Address;
  operator: Address;
  caps: LaneCaps;
  halt: boolean;
  /** Age of the HL quote; above 10 s it is not FRESH (STALE-REF). */
  hlAgeMs: number;
  /** A funded position in slot 0 (null: the lane is empty). */
  position: NpmPosition | null;
  decisionUsedAt: bigint;
  /** Throw from sensor.read (a blind tick). */
  sensorError: Error | null;
  /** F relative to the pool mid, in bp (HL moves, the pool stays put); default 0. */
  fShiftBps: number;
  /** The lane's paused() flag (the owner or guardian halted it); default false. */
  paused?: boolean;
}

export function inRangePosition(tokenId = 42n): NpmPosition {
  const lower = Math.floor(MOCK_POOL_TICK / 10) * 10 - 100;
  return {
    tokenId,
    tickLower: lower,
    tickUpper: lower + 200,
    liquidity: 1_000_000_000_000_000n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
  };
}

export const MOCK_POOL_MID = poolMidFromSqrt(MOCK_SQRT_PRICE_X96);

export function snapshotOf(world: World, nowMs: number): DeskSnapshot {
  const base = mockSnapshot({
    nowMs,
    lane: world.lane,
    signerAddress: world.operator,
    hlMid: MOCK_POOL_MID * Math.exp((world.fShiftBps ?? 0) / 1e4),
  });
  const chain = base.chain;
  if (chain === null || base.rh === null) throw new Error("mock snapshot without chain / rh");
  const reported = world.reportedLaneAddress ?? world.laneAddress;
  return {
    ...base,
    laneAddress: reported,
    chain: {
      ...chain,
      lane: {
        ...chain.lane,
        laneAddress: reported,
        paused: world.paused ?? false,
        owner: world.owner,
        operator: world.operator,
        caps: { ...world.caps },
        budgets: { ...chain.lane.budgets, turnoverAvailableUsd6: world.caps.turnoverUsd6PerDay },
        positions: [world.position?.tokenId ?? 0n, 0n],
        positionDetails: [world.position, null],
      },
    },
    rh: { ...base.rh, isTradingHalt: world.halt },
    sources: { ...base.sources, hl: { ok: true, ageMs: world.hlAgeMs, reason: null } },
  };
}

/** A signer that records every request, optionally rewriting what it signs. */
export interface SpySigner extends TxSigner {
  requests: UnsignedTx[];
  raws: Hex[];
}

export function spySigner(
  base: TxSigner,
  sign?: (tx: UnsignedTx, base: TxSigner) => Promise<Hex>,
  ready?: () => Promise<{ ready: boolean; reason: string | null }>,
): SpySigner {
  const s: SpySigner = {
    kind: base.kind,
    address: base.address,
    requests: [],
    raws: [],
    ready: ready ?? (() => base.ready()),
    async signTransaction(tx) {
      s.requests.push(tx);
      const raw = await (sign === undefined ? base.signTransaction(tx) : sign(tx, base));
      s.raws.push(raw);
      return raw;
    },
  };
  return s;
}

export const approveAll: ApprovalGate = {
  async requestApproval() {
    return { approved: true, outcome: "approved", channel: "web" };
  },
  async awaitCancelWindow() {
    return { cancelled: false, channel: null };
  },
};

export const denyAll: ApprovalGate = {
  async requestApproval() {
    return { approved: false, outcome: "denied", channel: "telegram" };
  },
  async awaitCancelWindow() {
    return { cancelled: true, channel: "telegram" };
  },
};

export interface HarnessOptions {
  armed?: boolean;
  dryRun?: boolean;
  mode?: DeskMode;
  deskStatus?: DeskStatus;
  /** No desks row: the daemon falls back to DESK_MODE (advisory). */
  noDesk?: boolean;
  gate?: ApprovalGate;
  /** Wrap what the operator key signs (tampering, delays, denials). */
  sign?: (tx: UnsignedTx, base: TxSigner) => Promise<Hex>;
  signerReady?: () => Promise<{ ready: boolean; reason: string | null }>;
  /** A different signer entirely (the delegated signer proof). */
  signer?: TxSigner;
  /** Wire the attempt resolver into the tick (settles in-flight attempts before planning). */
  resolver?: boolean;
  lane?: Lane;
  hl?: { mode: "paper" | "live"; armed: boolean; exchange?: HlExchangeClient };
  world?: Partial<World>;
  config?: (cfg: AppConfig) => AppConfig;
  deps?: Partial<DaemonDeps>;
  db?: DeskDbHandle;
  clock?: TestClock;
  chain?: WiringChain;
  /**
   * Gate signals (DESK_SIGNAL_GATES). Off by default here so the other proofs keep their exact
   * transaction sequences; true (or a partial config) turns them on.
   */
  signals?: boolean | Partial<AppConfig["signal"]>;
}

export interface Harness {
  cfg: AppConfig;
  db: DeskDbHandle;
  chain: WiringChain;
  clock: TestClock;
  world: World;
  signer: SpySigner;
  executor: Executor;
  notes: DeskNotification[];
  deps: DaemonDeps;
  daemon: Daemon;
  /** One tick; the lane's outcome. */
  tick(): Promise<LaneTickOutcome>;
  /** Tick (advancing the clock one tick each time) until a decision settles (not while awaiting). */
  tickUntilDecision(maxTicks?: number): Promise<Extract<LaneTickOutcome, { kind: "decision" }>>;
  /** A fresh daemon over the same DB, chain and world (a process restart). */
  restart(overrides?: Partial<DaemonDeps>): Daemon;
}

export function harness(o: HarnessOptions = {}): Harness {
  const lane = o.lane ?? "A";
  const laneAddress = lane === "B" ? LANE_B : LANE_A;
  const clock = o.clock ?? fixedClock(T0);
  const db = o.db ?? memDb();
  const chain = o.chain ?? new WiringChain();
  const base = makeTestConfig();
  let cfg: AppConfig = {
    ...base,
    safety: { ...base.safety, armed: o.armed ?? true, dryRun: o.dryRun ?? false },
    hl: { ...base.hl, mode: o.hl?.mode ?? "paper", armed: o.hl?.armed ?? false },
    signal: {
      ...base.signal,
      enabled: o.signals !== undefined && o.signals !== false,
      ...(typeof o.signals === "object" ? o.signals : {}),
    },
  };
  if (o.config !== undefined) cfg = o.config(cfg);
  const baseSigner = o.signer ?? createLocalSigner({ privateKey: ANVIL_KEY_0, rpcUrl: LOOPBACK });
  const signer = spySigner(baseSigner, o.sign, o.signerReady);
  const world: World = {
    lane,
    laneAddress,
    reportedLaneAddress: null,
    owner: OWNER,
    operator: signer.address,
    caps: { ...DEFAULT_LANE_CAPS },
    halt: false,
    hlAgeMs: 0,
    position: null,
    decisionUsedAt: 0n,
    sensorError: null,
    fShiftBps: 0,
    ...o.world,
  };
  if (!o.noDesk && db.getDesk(laneAddress) === null) {
    db.insertDesk({
      laneAddress,
      chainId: 4663,
      laneId: lane === "B" ? 1 : 0,
      owner: world.owner,
      operator: world.operator,
      ownerUserId: "user-1",
      signerKind: signer.kind,
      mode: o.mode ?? "copilot",
      modeNonce: 0,
      status: o.deskStatus ?? "active",
      statusDetail: null,
      capsJson: "{}",
      createdAtMs: T0,
      updatedAtMs: T0,
    });
  }
  const notes: DeskNotification[] = [];
  const notifier = { notify: async (n: DeskNotification) => void notes.push(n) };
  const logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const sleep = async (ms: number) => clock.advance(ms);
  const broadcaster = createBroadcaster({ chain, clock, sleep });
  const resolver = createAttemptResolver({ db, chain, broadcaster, clock, logger, notifier });
  const executor = createRhExecutor({
    db,
    chain,
    signer,
    calldata: createCalldataBuilder(laneAddress),
    simulator: createSimulator({ chain }),
    fees: createFeePolicy({ floorWei: cfg.limits.feeFloorWei, capWei: cfg.limits.maxFeePerGasWei }),
    nonces: createNonceManager({ db, chain, chainId: 4663, now: () => clock.now() }),
    broadcaster,
    resolver,
    clock,
    logger,
    notifier,
    chainId: 4663,
    timing: { signTimeoutMs: 15_000, receiptPollMs: 250, receiptTimeoutMs: 15_000 },
    maxGasCents: cfg.limits.maxGasCents,
    ethUsd: () => 2630,
  });
  const sensor = {
    async read(_lane: Lane, _address: Address) {
      if (world.sensorError !== null) throw world.sensorError;
      return snapshotOf(world, clock.now());
    },
  };
  const hlExecutor =
    o.hl === undefined
      ? null
      : createHlExecutor({
          db,
          mode: o.hl.mode,
          armed: o.hl.armed,
          exchange: o.hl.exchange ?? null,
          quote: () => snapshotOf(world, clock.now()).hl,
          clock,
          logger,
        });
  const deps: DaemonDeps = {
    config: cfg,
    db,
    lanes: () => [{ lane, laneAddress, sensor, signer, executor }],
    decisionUsedAt: async () => world.decisionUsedAt,
    notifier,
    logger,
    clock,
    approvalGate: o.gate ?? approveAll,
    random: () => 0,
    hedge: o.hl === undefined ? null : createHedgeEngine(),
    hlExecutor,
    resolver: o.resolver === true ? resolver : null,
    ...o.deps,
  };
  const h: Harness = {
    cfg,
    db,
    chain,
    clock,
    world,
    signer,
    executor,
    notes,
    deps,
    daemon: createDaemon(deps),
    async tick() {
      const r = await h.daemon.runTick();
      const out = r.lanes[0]?.outcome;
      if (out === undefined) throw new Error("no lane ran");
      return out;
    },
    async tickUntilDecision(maxTicks = 8) {
      for (let i = 0; i < maxTicks; i++) {
        const out = await h.tick();
        if (out.kind === "decision") return out;
        clock.advance(cfg.timing.tickMs);
      }
      throw new Error(`no decision within ${maxTicks} ticks`);
    },
    restart(overrides = {}) {
      h.daemon = createDaemon({ ...deps, ...overrides });
      return h.daemon;
    },
  };
  return h;
}

/** Decode the calldata of a signed transaction. */
export function decodeSigned(raw: Hex): {
  to: Address;
  functionName: string;
  args: readonly unknown[];
} {
  const tx = parseTransaction(raw);
  const { functionName, args } = decodeFunctionData({ abi: deskLaneAbi, data: tx.data ?? "0x" });
  return {
    to: (tx.to ?? "0x").toLowerCase() as Address,
    functionName,
    args: (args ?? []) as readonly unknown[],
  };
}

/** A scripted LLM overlay: a planner that proposes (or throws) and a critic that approves. */
export function createLlmStub(o: {
  proposal?: OverlayProposal;
  plannerError?: Error;
  criticVerdict?: "APPROVE" | "REJECT";
}) {
  let planned = 0;
  let critiqued = 0;
  const planner: OverlayPlanner = {
    async propose() {
      planned += 1;
      if (o.plannerError !== undefined) throw o.plannerError;
      if (o.proposal === undefined) throw new Error("stub planner: no proposal scripted");
      return { proposal: o.proposal, raw: null };
    },
  };
  const critic: OverlayCritic = {
    async critique() {
      critiqued += 1;
      return {
        verdict: { verdict: o.criticVerdict ?? "APPROVE", reason: "stub critic" },
        raw: null,
      };
    },
  };
  return {
    overlay: { planner, critic },
    plannerCalls: () => planned,
    criticCalls: () => critiqued,
  };
}

/** A bare decision row (seeding the store the way a crashed earlier process would have). */
export function decisionRow(decisionId: string, nowMs: number): DecisionRow {
  return {
    decisionId,
    laneAddress: LANE_A,
    lane: "A",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    regime: "REGULAR",
    regimeCode: 1,
    gatesMask: 0,
    riskMode: "normal",
    snapshotJson: "{}",
    planJson: "{}",
    overlayId: null,
    finalPlanJson: null,
    reasonHash: null,
    reasonPreimage: null,
    planCriticVerdict: null,
    planCriticReason: null,
    guardDecision: null,
    guardViolationsJson: null,
    guardChecksJson: null,
    approvalMode: null,
    approvalOutcome: null,
    approvalChannel: null,
    status: "executing",
    statusDetail: null,
  };
}
