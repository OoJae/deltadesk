/**
 * desk-watchdog (a separate service): holds ONLY the guardian key. Every 30 s, per lane, it reads the
 * lane at a pinned block and the agent's /health, evaluates rules.ts, and when a rule fires it
 * pauses the lane (then exitAll when needed). It can never unpause: the guardian role cannot, and
 * this module has no code path for it. Telegram can ask for a pause, never for anything else, on
 * the watchdog's own bot (WATCHDOG_TELEGRAM_BOT_TOKEN): never on the agent's, whose approval
 * buttons a second getUpdates poller would swallow.
 *
 * Signals it derives on its own (no trust in the agent):
 * - NAV: idle balances + position amounts (at slot0) valued at the lane's fence prices, against a
 *   baseline re-valued at today's prices (the market-explained part); the baseline rolls hourly and
 *   resets after an owner withdrawal.
 * - Revert streak: Δ operator nonce − Δ successful operator LaneActions.
 * - Foreign action: a LaneAction by the operator key whose decisionId is not an agent id.
 * - Dead-man: a calendar boundary (open, close, roll, reopen guard) within ±WATCHDOG_DEADMAN_MIN.
 *
 * Its own Meta.decisionIds use the agent's layout, so the agent sees the watchdog's pause/exit as a
 * foreign LaneAction and drops to safe mode, as intended.
 */

import { pathToFileURL } from "node:url";
import { erc20Abi, keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDRESSES_4663 } from "../addresses.js";
import { loadWatchdogConfig, type WatchdogConfig } from "../config.js";
import { npmAbi, uniswapV3PoolAbi } from "../executor/abi/external.js";
import { priceFenceAbi } from "../executor/abi/PriceFence.js";
import { createBroadcaster } from "../executor/broadcaster.js";
import { createCalldataBuilder } from "../executor/calldata.js";
import { createChainClient, createLaneViews, readContract } from "../executor/chain.js";
import {
  createDecisionUlidFactory,
  encodeDecisionId,
  tryDecodeDecisionId,
} from "../executor/decision-id.js";
import { createFeePolicy, gasLimitFor } from "../executor/fees.js";
import { createSimulator } from "../executor/simulate.js";
import { createLogger } from "../log.js";
import { regimeAt } from "../market/calendar.js";
import {
  createTelegramApi,
  createTelegramListener,
  createTelegramNotifier,
} from "../notify/telegram.js";
import { decodeLaneAction, LANE_ACTION_TOPIC } from "../reconcile/lane-actions.js";
import { verifySignedTx } from "../signer/types.js";
import type {
  Address,
  ChainClient,
  Clock,
  DeskLogger,
  HealthView,
  Hex,
  LaneBudgets,
  Notifier,
  Sleep,
  UnsignedTx,
  WatchdogInput,
  WatchdogVerdict,
} from "../types.js";
import { LANE_ACTION_NAMES } from "../types.js";
import { getAmountsForLiquidity, getSqrtRatioAtTick, valueUsd6 } from "../units.js";
import { evaluateWatchdog, plannedActions } from "./rules.js";

export type { WatchdogThresholds, WatchdogVerdict } from "../types.js";

const BASELINE_ROLL_MS = 3_600_000;
/** Guardian fees: the executor's policy with fixed bounds (0.02 gwei floor, 2 gwei cap). */
const GUARDIAN_FEE_FLOOR_WEI = 20_000_000n;
const GUARDIAN_FEE_CAP_WEI = 2_000_000_000n;
const PAUSE_ACTION = LANE_ACTION_NAMES.indexOf("PAUSE");
const OWNER_EXITS = new Set([
  LANE_ACTION_NAMES.indexOf("WITHDRAW"),
  LANE_ACTION_NAMES.indexOf("WITHDRAW_POSITION"),
]);

export interface GuardianSigner {
  address: Address;
  signTransaction(tx: UnsignedTx): Promise<Hex>;
}

export function guardianFromKey(privateKey: Hex): GuardianSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address.toLowerCase() as Address,
    signTransaction: (tx) =>
      account.signTransaction({
        type: "eip1559",
        chainId: tx.chainId,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        nonce: tx.nonce,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      }),
  };
}

/** The nearest calendar boundary (regime or reopen-window change) within ±windowMs, if any. */
export function nearestScheduledAction(nowMs: number, windowMs: number): number | null {
  const stepMs = 60_000;
  const key = (ms: number) => {
    const r = regimeAt(ms / 1000);
    return `${r.name}|${r.reopenKind ?? ""}`;
  };
  let best: number | null = null;
  const start = Math.floor((nowMs - windowMs) / stepMs) * stepMs;
  let prev = key(start - stepMs);
  for (let t = start; t <= nowMs + windowMs; t += stepMs) {
    const k = key(t);
    if (k !== prev && (best === null || Math.abs(t - nowMs) < Math.abs(best - nowMs))) best = t;
    prev = k;
  }
  return best;
}

interface LaneMemory {
  cursor: bigint | null;
  operatorNonce: number | null;
  revertStreak: number;
  baseline: { amount0: bigint; amount1: bigint; navUsd: number; atMs: number } | null;
  lastAlertKey: string;
}

export interface LaneReading {
  blockNumber: bigint;
  paused: boolean;
  owner: Address;
  operator: Address;
  guardian: Address;
  hasPositions: boolean;
  budgets: LaneBudgets;
  operatorEthWei: bigint;
  amount0: bigint;
  amount1: bigint;
  navUsd: number | null;
  /** Prices (1e18 USD per whole token) and decimals, for re-valuing the baseline. */
  p0: bigint;
  p1: bigint;
  dec0: number;
  dec1: number;
}

export interface WatchdogDeps {
  cfg: WatchdogConfig;
  chain: ChainClient;
  guardian: GuardianSigner | null;
  fetchHealth: () => Promise<HealthView | null>;
  clock: Clock;
  logger: DeskLogger;
  notifier: Notifier;
  sleep?: Sleep;
  scheduledActionAt?: (nowMs: number) => number | null;
  /** Lane reads (tests inject); default reads the chain. */
  readLane?: (lane: Address, blockNumber: bigint) => Promise<LaneReading>;
}

export interface LaneReport {
  lane: Address;
  verdict: WatchdogVerdict;
  actions: Array<{
    kind: "pause" | "exitAll";
    txHash: Hex | null;
    dryRun: boolean;
    error: string | null;
  }>;
}

export function createChainLaneReader(
  chain: ChainClient,
): (lane: Address, blockNumber: bigint) => Promise<LaneReading> {
  const views = createLaneViews(chain);
  const decimals = new Map<string, number>();
  const decimalsOf = async (token: Address, blockNumber: bigint) => {
    let d = decimals.get(token);
    if (d === undefined) {
      d = Number(
        await readContract(chain, {
          address: token,
          abi: erc20Abi,
          functionName: "decimals",
          blockNumber,
        }),
      );
      decimals.set(token, d);
    }
    return d;
  };
  return async (lane, blockNumber) => {
    const id = await views.identity(lane, blockNumber);
    const [budgets, positions, slot0, bal0, bal1, dec0, dec1, px0, px1, operatorEthWei] =
      await Promise.all([
        views.budgets(lane, blockNumber),
        views.positions(lane, blockNumber),
        readContract(chain, {
          address: id.pool,
          abi: uniswapV3PoolAbi,
          functionName: "slot0",
          blockNumber,
        }),
        readContract(chain, {
          address: id.token0,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [lane],
          blockNumber,
        }),
        readContract(chain, {
          address: id.token1,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [lane],
          blockNumber,
        }),
        decimalsOf(id.token0, blockNumber),
        decimalsOf(id.token1, blockNumber),
        readContract(chain, {
          address: id.fence,
          abi: priceFenceAbi,
          functionName: "usdPrice",
          args: [id.token0],
          blockNumber,
        }),
        readContract(chain, {
          address: id.fence,
          abi: priceFenceAbi,
          functionName: "usdPrice",
          args: [id.token1],
          blockNumber,
        }),
        chain.getBalance(id.operator, blockNumber),
      ]);
    const sqrtP = slot0[0];
    let amount0 = bal0;
    let amount1 = bal1;
    let hasPositions = false;
    for (const tokenId of positions) {
      if (tokenId === 0n) continue;
      hasPositions = true;
      const p = await readContract(chain, {
        address: ADDRESSES_4663.NPM,
        abi: npmAbi,
        functionName: "positions",
        args: [tokenId],
        blockNumber,
      });
      const [, , , , , tickLower, tickUpper, liquidity, , , owed0, owed1] = p;
      const a = getAmountsForLiquidity(
        sqrtP,
        getSqrtRatioAtTick(tickLower),
        getSqrtRatioAtTick(tickUpper),
        liquidity,
      );
      amount0 += a.amount0 + owed0;
      amount1 += a.amount1 + owed1;
    }
    const [p0, , code0] = px0;
    const [p1, , code1] = px1;
    const navUsd =
      code0 === 0 && code1 === 0
        ? Number(valueUsd6(amount0, dec0, p0, false) + valueUsd6(amount1, dec1, p1, false)) / 1e6
        : null;
    return {
      blockNumber,
      paused: id.paused,
      owner: id.owner,
      operator: id.operator,
      guardian: id.guardian,
      hasPositions,
      budgets,
      operatorEthWei,
      amount0,
      amount1,
      navUsd,
      p0,
      p1,
      dec0,
      dec1,
    };
  };
}

export function createWatchdog(deps: WatchdogDeps) {
  const { cfg, chain, logger, clock } = deps;
  const memory = new Map<Address, LaneMemory>();
  const pauseRequests = new Set<string>();
  const nextUlid = createDecisionUlidFactory();
  const readLane = deps.readLane ?? createChainLaneReader(chain);
  const scheduledAt =
    deps.scheduledActionAt ?? ((now) => nearestScheduledAction(now, cfg.thresholds.deadManMs));
  const simulator = createSimulator({ chain });
  const broadcaster = createBroadcaster({
    chain,
    clock,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const fees = createFeePolicy({ floorWei: GUARDIAN_FEE_FLOOR_WEI, capWei: GUARDIAN_FEE_CAP_WEI });

  function mem(lane: Address): LaneMemory {
    let m = memory.get(lane);
    if (m === undefined) {
      m = { cursor: null, operatorNonce: null, revertStreak: 0, baseline: null, lastAlertKey: "" };
      memory.set(lane, m);
    }
    return m;
  }

  async function sendGuardianTx(lane: Address, kind: "pause" | "exitAll", reason: string) {
    const now = clock.now();
    const meta = {
      decisionId: encodeDecisionId(nextUlid(now), 0),
      deadline: BigInt(Math.floor(now / 1000) + 60),
      regime: 0,
      gatesMask: 0,
      reasonHash: keccak256(stringToBytes(`watchdog:${kind}:${reason}`)),
    };
    const call = createCalldataBuilder(lane).encode({ kind, lane: "A" }, meta);
    const from = deps.guardian?.address;
    if (cfg.dryRun || !cfg.armed || deps.guardian === null || from === undefined) {
      logger.warn({ lane, kind, reason }, "watchdog DRY-RUN: would send");
      return { kind, txHash: null, dryRun: true, error: null };
    }
    const block = await chain.getBlock("latest");
    const sim = await simulator.simulate(call, from, block.number);
    if (!sim.ok || sim.gasEstimate === null) {
      return {
        kind,
        txHash: null,
        dryRun: false,
        error: `simulation failed: ${sim.error?.message ?? "no gas estimate"}`,
      };
    }
    const fee = fees.quote(block);
    const tx: UnsignedTx = {
      type: "eip1559",
      chainId: cfg.chainId,
      to: call.to,
      data: call.data,
      value: 0n,
      nonce: await chain.getTransactionCount(from, "pending"),
      gas: gasLimitFor(sim.gasEstimate),
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: 0n,
    };
    const raw = await deps.guardian.signTransaction(tx);
    const { hash } = await verifySignedTx(raw, tx, from);
    await broadcaster.broadcast(raw);
    const r = await broadcaster.waitForReceipt(hash, { pollMs: 250, timeoutMs: 15_000 });
    return {
      kind,
      txHash: hash,
      dryRun: false,
      error: r.kind === "confirmed" ? null : `guardian ${kind} ${r.kind}`,
    };
  }

  async function runLane(
    lane: Address,
    block: bigint,
    health: HealthView | null,
  ): Promise<LaneReport> {
    const m = mem(lane);
    const now = clock.now();
    const reading = await readLane(lane, block);

    // LaneActions since the last look: foreign operator actions, successes, owner withdrawals.
    let foreign = 0;
    let operatorSuccesses = 0;
    let ownerWithdrew = false;
    if (m.cursor !== null && block > m.cursor) {
      const logs = await chain.getLogs({
        address: lane,
        fromBlock: m.cursor + 1n,
        toBlock: block,
        topics: [LANE_ACTION_TOPIC],
      });
      for (const log of logs) {
        const ev = decodeLaneAction(log);
        if (ev.caller === reading.operator) {
          operatorSuccesses += 1;
          if (ev.action !== PAUSE_ACTION && tryDecodeDecisionId(ev.decisionId) === null)
            foreign += 1;
        }
        if (ev.caller === reading.owner && OWNER_EXITS.has(ev.action)) ownerWithdrew = true;
      }
    }
    m.cursor = block;

    const nonce = await chain.getTransactionCount(reading.operator, "latest");
    if (m.operatorNonce !== null && nonce > m.operatorNonce) {
      const reverts = Math.max(0, nonce - m.operatorNonce - operatorSuccesses);
      m.revertStreak = operatorSuccesses > 0 ? reverts : m.revertStreak + reverts;
    }
    m.operatorNonce = nonce;

    if (
      reading.navUsd !== null &&
      (m.baseline === null || ownerWithdrew || now - m.baseline.atMs >= BASELINE_ROLL_MS)
    ) {
      m.baseline = {
        amount0: reading.amount0,
        amount1: reading.amount1,
        navUsd: reading.navUsd,
        atMs: now,
      };
    }
    const baselineNow =
      m.baseline === null || reading.navUsd === null
        ? null
        : Number(
            valueUsd6(m.baseline.amount0, reading.dec0, reading.p0, false) +
              valueUsd6(m.baseline.amount1, reading.dec1, reading.p1, false),
          ) / 1e6;

    const input: WatchdogInput = {
      nowMs: now,
      laneAddress: lane,
      paused: reading.paused,
      hasPositions: reading.hasPositions,
      navUsd: reading.navUsd,
      navBaselineUsd: m.baseline?.navUsd ?? null,
      navMarketMoveUsd:
        baselineNow === null || m.baseline === null ? null : baselineNow - m.baseline.navUsd,
      budgets: reading.budgets,
      consecutiveReverts: m.revertStreak,
      foreignActions: foreign,
      operatorEthWei: reading.operatorEthWei,
      agentHealth: health,
      scheduledActionAtMs: scheduledAt(now),
      telegramPauseRequested: pauseRequests.has(lane) || pauseRequests.has("*"),
    };
    const verdict = evaluateWatchdog(input, cfg.thresholds);
    const report: LaneReport = { lane, verdict, actions: [] };
    if (verdict.action === "none") {
      m.lastAlertKey = "";
      return report;
    }
    pauseRequests.delete(lane);
    const reason = verdict.triggers.map((t) => t.trigger).join(",");
    const notGuardian = deps.guardian !== null && reading.guardian !== deps.guardian.address;
    for (const kind of plannedActions(verdict, reading)) {
      if (notGuardian) {
        report.actions.push({
          kind,
          txHash: null,
          dryRun: cfg.dryRun,
          error: `watchdog key is not the lane's guardian (${reading.guardian})`,
        });
        continue;
      }
      try {
        report.actions.push(await sendGuardianTx(lane, kind, reason));
      } catch (err) {
        report.actions.push({
          kind,
          txHash: null,
          dryRun: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const alertKey = `${verdict.action}|${reason}|${report.actions.map((a) => a.kind).join(",")}`;
    if (alertKey !== m.lastAlertKey) {
      m.lastAlertKey = alertKey;
      await deps.notifier.notify({
        kind: "watchdog",
        severity: "critical",
        lane: null,
        laneAddress: lane,
        title: `Watchdog: ${verdict.action.replaceAll("_", " ")}${cfg.dryRun ? " (DRY RUN)" : ""}`,
        lines: [
          ...verdict.triggers.map((t) => `${t.trigger}: ${t.detail}`),
          ...report.actions.map(
            (a) => `${a.kind}: ${a.txHash ?? (a.dryRun ? "dry run" : (a.error ?? "not sent"))}`,
          ),
        ],
        dryRun: cfg.dryRun,
      });
    }
    return report;
  }

  let timer: NodeJS.Timeout | null = null;
  let stopping = false;

  const watchdog = {
    requestPause(lane: Address | "*") {
      pauseRequests.add(lane === "*" ? "*" : (lane.toLowerCase() as Address));
    },
    async runOnce(): Promise<LaneReport[]> {
      const block = await chain.blockNumber();
      const health = await deps.fetchHealth().catch(() => null);
      const out: LaneReport[] = [];
      for (const lane of cfg.lanes.map((l) => l.toLowerCase() as Address)) {
        try {
          out.push(await runLane(lane, block, health));
        } catch (err) {
          logger.warn(
            { lane, error: err instanceof Error ? err.message : String(err) },
            "watchdog lane read failed",
          );
        }
      }
      pauseRequests.delete("*");
      return out;
    },
    start() {
      const loop = async () => {
        if (stopping) return;
        try {
          await watchdog.runOnce();
        } catch (err) {
          logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            "watchdog tick failed",
          );
        }
        if (!stopping) timer = setTimeout(loop, cfg.intervalMs);
      };
      void loop();
    },
    stop() {
      stopping = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
  return watchdog;
}

export function createHealthFetcher(
  agentUrl: string | undefined,
  timeoutMs = 5_000,
): () => Promise<HealthView | null> {
  return async () => {
    if (agentUrl === undefined) return null;
    try {
      const res = await fetch(`${agentUrl.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()) as HealthView;
    } catch {
      return null;
    }
  };
}

async function main(): Promise<void> {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ quiet: true });
  const cfg = loadWatchdogConfig(process.env);
  const logger = createLogger({ level: cfg.logLevel, service: "desk-watchdog" });
  if (cfg.lanes.length === 0) throw new Error("the watchdog needs DESK_LANE_A and/or DESK_LANE_B");
  const chain = createChainClient({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId });
  const rpcChainId = await chain.chainId();
  if (rpcChainId !== cfg.chainId)
    throw new Error(`RPC reports chain ${rpcChainId}, config says ${cfg.chainId}`);
  const guardian =
    cfg.guardianPrivateKey === undefined ? null : guardianFromKey(cfg.guardianPrivateKey);
  const notifier = createTelegramNotifier(
    { botToken: cfg.telegram.botToken, chatId: cfg.telegram.chatId, explorerUrl: cfg.explorerUrl },
    logger,
  );
  const clock = { now: () => Date.now() };
  const watchdog = createWatchdog({
    cfg,
    chain,
    guardian,
    fetchHealth: createHealthFetcher(cfg.agentUrl),
    clock,
    logger,
    notifier,
  });
  let listener: ReturnType<typeof createTelegramListener> | null = null;
  // Only on the watchdog's OWN bot: polling the agent's bot would swallow its approve/deny buttons.
  if (
    cfg.telegram.listen &&
    cfg.telegram.botToken !== undefined &&
    cfg.telegram.chatId !== undefined
  ) {
    listener = createTelegramListener({
      api: createTelegramApi(cfg.telegram.botToken, cfg.telegram.chatId, logger),
      chatId: cfg.telegram.chatId,
      logger,
      onCommand: async (text) => {
        const m = /^\/pause(?:\s+(0x[0-9a-fA-F]{40}))?\s*$/.exec(text.trim());
        if (m !== null) {
          watchdog.requestPause((m[1]?.toLowerCase() as Address | undefined) ?? "*");
          return `Pause requested for ${m[1] ?? "every lane"}; it runs on the next watchdog tick.`;
        }
        if (/^\/unpause\b/.test(text.trim())) {
          return "The watchdog can never unpause. The owner unpauses from /desk.";
        }
        return null;
      },
    });
    listener.start();
  } else if (cfg.telegram.botToken !== undefined) {
    logger.warn(
      {},
      "Telegram /pause is off: set WATCHDOG_TELEGRAM_BOT_TOKEN to the watchdog's own bot (alerts still go out)",
    );
  }
  logger.info(
    { lanes: cfg.lanes, guardian: guardian?.address ?? null, dryRun: cfg.dryRun, armed: cfg.armed },
    "desk-watchdog started",
  );
  watchdog.start();
  const shutdown = async () => {
    watchdog.stop();
    await listener?.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
