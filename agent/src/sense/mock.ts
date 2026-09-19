/**
 * A synthetic, internally consistent snapshot of lane A (DESK_SENSE_MOCK=1, and the fixture the
 * strategy, critic and guard tests build on). Figures are the live NVDA/USDG pool on 2026-09-19:
 * tick 222275, mid ≈ $222.43, active liquidity ≈ $4.2 M within ±100 ticks. Config refuses a mock
 * sensor next to a live signer, so nothing here can move real money.
 */

import { regimeAt } from "../market/calendar.js";
import { fairValue, poolMidFromSqrt } from "../market/fair-value.js";
import type {
  Address,
  ChainlinkRound,
  ChainRead,
  Clock,
  DeskSnapshot,
  Lane,
  LaneCaps,
  Sensor,
  SourceName,
  SourceStatus,
} from "../types.js";
import { priceToTick } from "../units.js";

export const MOCK_LANE: Address = "0x1111111111111111111111111111111111111111";
export const MOCK_OWNER: Address = "0x2222222222222222222222222222222222222222";
export const MOCK_OPERATOR: Address = "0x3333333333333333333333333333333333333333";

/** The M2 default caps (docs/m2-design-contracts.md). */
export const DEFAULT_LANE_CAPS: LaneCaps = {
  maxDeployUsd6: 60_000_000n,
  turnoverUsd6PerDay: 150_000_000n,
  placeBandBps: 100,
  maxTickDelta: 10,
  minWidthTicks: 20,
  maxWidthTicks: 2000,
  reranges1h: 4,
  reranges24h: 24,
  minRerangeInterval: 300,
  maxDeadlineAhead: 120,
  maxRanges: 2,
};

export const MOCK_SQRT_PRICE_X96 = 5312359905924111789169988187832333n;
export const MOCK_POOL_TICK = 222275;
export const MOCK_POOL_LIQUIDITY = 28490635125232108064n;

export function chainlinkRound(price: number, decimals = 8, updatedAt = 0n): ChainlinkRound {
  const answer = BigInt(Math.round(price * 10 ** decimals));
  return { roundId: 1n, answer, decimals, updatedAt, price: Number(answer) / 10 ** decimals };
}

export interface MockChainOptions {
  nowSec?: number;
  tick?: number;
  sqrtPriceX96?: bigint;
  nvdaUsd?: number;
  balances?: { token0: bigint; token1: bigint };
}

export function mockChainRead(o: MockChainOptions = {}): ChainRead {
  const nowSec = BigInt(o.nowSec ?? 1_789_999_200);
  const nvda = o.nvdaUsd ?? 222.42;
  // refTick for USDG $1 / NVDA $nvda: the tick of the fence price (both feeds 8 decimals).
  const refTick = priceToTick(nvda);
  return {
    blockNumber: 1_000_000n,
    blockTimestamp: nowSec,
    blockHash: `0x${"ab".repeat(32)}`,
    baseFeePerGas: 66_400_000n,
    pool: {
      sqrtPriceX96: o.sqrtPriceX96 ?? MOCK_SQRT_PRICE_X96,
      tick: o.tick ?? MOCK_POOL_TICK,
      liquidity: MOCK_POOL_LIQUIDITY,
      unlocked: true,
    },
    lane: {
      laneAddress: MOCK_LANE,
      laneId: 0,
      owner: MOCK_OWNER,
      operator: MOCK_OPERATOR,
      guardian: "0x0000000000000000000000000000000000000000",
      paused: false,
      closedUntil: 0n,
      riskAddingOpen: { open: true, code: 0 },
      refTick: { tick: refTick, bandTicks: 100, code: 0 },
      caps: { ...DEFAULT_LANE_CAPS },
      budgets: {
        turnoverAvailableUsd6: DEFAULT_LANE_CAPS.turnoverUsd6PerDay,
        reranges1hLeft: 4n,
        reranges24hLeft: 24n,
        nextRerangeAt: 0n,
      },
      positions: [0n, 0n],
      positionDetails: [null, null],
      // ≈ $25 USDG + ≈ $25 of NVDA
      balances: o.balances ?? { token0: 25_000_000n, token1: 112_400_000_000_000_000n },
    },
    chainlink: {
      nvda: chainlinkRound(nvda, 8, nowSec - 600n),
      usdg: chainlinkRound(1, 8, nowSec - 3_600n),
      eth: chainlinkRound(2630, 8, nowSec - 60n),
    },
    stockToken: {
      oraclePaused: false,
      uiMultiplier: 10n ** 18n,
      newUiMultiplier: 10n ** 18n,
      effectiveAt: 0n,
    },
    operatorEthWei: 5_000_000_000_000_000n,
  };
}

const fresh: SourceStatus = { ok: true, ageMs: 0, reason: null };

export interface MockSnapshotOptions extends MockChainOptions {
  nowMs?: number;
  lane?: Lane;
  /** HL mid; F = hl · k. Default: the pool mid (gap 0). */
  hlMid?: number;
  k?: number;
  chain?: ChainRead | null;
  signerAddress?: Address;
  chainId?: number;
}

/** Default instant: Mon 2026-09-21 14:00 UTC (10:00 ET, regular session). */
export const MOCK_NOW_MS = Date.UTC(2026, 8, 21, 14, 0, 0);

export function mockSnapshot(o: MockSnapshotOptions = {}): DeskSnapshot {
  const nowMs = o.nowMs ?? MOCK_NOW_MS;
  const chain =
    o.chain === undefined ? mockChainRead({ nowSec: Math.floor(nowMs / 1000), ...o }) : o.chain;
  const poolMid = chain === null ? 222.4253 : poolMidFromSqrt(chain.pool.sqrtPriceX96);
  const k = o.k ?? 1;
  const hlMid = o.hlMid ?? poolMid / k;
  const basis = { k, source: "engine" as const, session: "2026-09-18", fetchedAtMs: nowMs };
  const sources = {} as Record<SourceName, SourceStatus>;
  for (const s of ["chain", "hl", "rh", "k", "corpActions"] as const) sources[s] = { ...fresh };
  return {
    lane: o.lane ?? "A",
    laneAddress: chain?.lane.laneAddress ?? MOCK_LANE,
    chainId: o.chainId ?? 4663,
    signerAddress: o.signerAddress ?? MOCK_OPERATOR,
    takenAtMs: nowMs,
    calendar: regimeAt(nowMs / 1000),
    chain,
    hl: {
      coin: "xyz:NVDA",
      bid: hlMid - 0.01,
      ask: hlMid + 0.01,
      mid: hlMid,
      markPx: hlMid,
      oraclePx: hlMid,
      exchangeTimeMs: nowMs,
      receivedAtMs: nowMs,
      source: "ws",
    },
    rh: {
      symbol: "NVDA",
      bid: poolMid - 0.1,
      ask: poolMid + 0.1,
      mid: poolMid,
      isTradingHalt: false,
      generatedAtMs: nowMs,
      receivedAtMs: nowMs,
    },
    k: basis,
    corpActions: {
      pendingForSymbol: false,
      nextEffectiveAtMs: null,
      items: [],
      fetchedAtMs: nowMs,
    },
    fairValue: chain === null ? null : fairValue(hlMid, basis, poolMid),
    ethUsd: 2630,
    sources,
  };
}

/** DESK_SENSE_MOCK=1: every read is the synthetic snapshot at the clock's time. */
export function createMockSensor(
  clock: Clock,
  opts: Omit<MockSnapshotOptions, "nowMs" | "lane"> = {},
): Sensor {
  return {
    async read(lane, laneAddress) {
      const snap = mockSnapshot({ ...opts, nowMs: clock.now(), lane });
      return {
        ...snap,
        laneAddress,
        chain:
          snap.chain === null ? null : { ...snap.chain, lane: { ...snap.chain.lane, laneAddress } },
      };
    },
  };
}
