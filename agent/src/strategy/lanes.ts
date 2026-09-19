/**
 * Lane strategy v0 (deterministic). Lane A reranges around fair value F; lanes B and C hold in M2
 * (lane B's paper hedge lives in hedge/engine.ts).
 *
 * Lane A, by risk mode:
 *   flat         → exitAll if the lane holds any position (HALT), else hold
 *   reduce_only  → hold (positions stay; nothing is added)
 *   normal       → rerange when ALL of:
 *     1. a trigger: the pool tick has left the inner 60% of a position's range for 2 consecutive
 *        ticks (outside_inner), or a position is out of range / empty (out_of_range), or the lane
 *        is empty with funded balances (initial_mint);
 *     2. rate limits: now ≥ budgets.nextRerangeAt, the on-chain 1 h / 24 h buckets and the agent's
 *        own limits all have room, and the turnover bucket covers the minimum deploy;
 *     3. the cost hurdle: benefit ≥ multiple × gas cost (strategy/hurdle.ts);
 *   and the new placement actually differs from the live one (hysteresis: an edge moved by more
 *   than the outer band of the range), then a 0–20 s jitter before the rerange is proposed.
 *
 * Sizing: shares of the post-unwind balances, scaled down so the fence-valued notional (the
 * contract's formula) fits min(on-chain maxDeploy, turnover left, config max action) minus a margin.
 *
 * DEVIATION (reported): the hurdle is waived for the initial mint by default. With a ~$50 position
 * a 1 h fee benefit is cents while a rerange costs ~$0.4 of gas, so the literal rule would never let
 * the first mint happen; the owner funding the lane is the decision to pay that one-time cost. The
 * hurdle is still computed and recorded, and it governs every rerange after that.
 *
 * State carried across ticks is returned in `carry` (outside-inner streak, jitter schedule); the
 * daemon writes it back into LaneState. Hold rationales never contain planned ticks: ticks are not
 * published ahead of execution.
 */

import {
  fencePrices,
  NVDA_USDG_DECIMALS,
  notionalUsd6,
  postUnwindBalances,
  rerangeUpperAmounts,
  type TokenDecimals,
} from "../guard/risk.js";
import type {
  ChainRead,
  DeskAction,
  DeskPlan,
  DeskSnapshot,
  HurdleResult,
  NpmPosition,
  PlanMetrics,
  RangeSpec,
  RerangeTrigger,
  Strategy,
  StrategyContext,
  StrategyParams,
} from "../types.js";
import {
  centsToUsd6,
  floorToSpacing,
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  priceToTick,
  toFloat,
  usd6ToCentsCeil,
} from "../units.js";
import { planBands } from "./bands.js";
import { costHurdle, feeRatePerHour, pOutOfRangeWithin } from "./hurdle.js";

export type { DeskPlan, Strategy, StrategyContext, StrategyParams } from "../types.js";

export interface LaneStrategyOptions {
  /** The config cap per action (guard limit), cents: the plan never exceeds it. */
  maxActionCents?: number;
  /** Below this fence-valued notional a placement is not worth a transaction (default $5). */
  minDeployCents?: number;
  /** Random-walk σ of the pool tick per √hour for P(out of range) (default 60 ticks ≈ 0.6 %). */
  sigmaTicksPerHour?: number;
  /** Weeks of data behind the engine's hour-of-week fee totals (default 9: M1 spans ~8.6 weeks). */
  hourRecordWeeks?: number;
  /** Apply the cost hurdle to the initial mint too (default false; see the module note). */
  hurdleOnInitialMint?: boolean;
  /** Headroom kept under the notional caps for price moves and rounding (default 200 bp). */
  capMarginBps?: number;
  decimals?: TokenDecimals;
}

export interface LaneCarry {
  /** Consecutive ticks (this one included) the pool sat outside a position's inner band. */
  outsideInnerTicks: number;
  /** Jittered earliest time the pending rerange may be proposed; null when none is pending. */
  rerangeNotBeforeMs: number | null;
}

export interface LanePlan extends DeskPlan {
  carry: LaneCarry;
}

export interface LaneStrategy extends Strategy {
  plan(ctx: StrategyContext): LanePlan;
}

export interface LivePosition {
  slot: 0 | 1;
  tokenId: bigint;
  detail: NpmPosition | null;
}

/** Slots holding a position NFT (tokenId ≠ 0), with their NPM details when the read had them. */
export function livePositions(chain: ChainRead): LivePosition[] {
  const out: LivePosition[] = [];
  for (const slot of [0, 1] as const) {
    const tokenId = chain.lane.positions[slot];
    if (tokenId !== 0n) out.push({ slot, tokenId, detail: chain.lane.positionDetails[slot] });
  }
  return out;
}

/** The inner band of a range: its middle `innerFraction` of the width. */
export function innerBounds(
  range: { tickLower: number; tickUpper: number },
  innerFraction: number,
): [number, number] {
  const width = range.tickUpper - range.tickLower;
  const edge = (width * (1 - innerFraction)) / 2;
  return [range.tickLower + edge, range.tickUpper - edge];
}

export function isOutsideInner(
  tick: number,
  range: { tickLower: number; tickUpper: number },
  innerFraction: number,
): boolean {
  const [lo, hi] = innerBounds(range, innerFraction);
  return tick < lo || tick > hi;
}

/**
 * The outside-inner streak after this tick: prev + 1 while the pool is outside the inner band of
 * any funded position, else 0. The daemon stores it in LaneState.outsideInnerTicks.
 */
export function outsideInnerStreak(
  prev: number,
  chain: ChainRead | null,
  params: StrategyParams,
): number {
  if (chain === null) return 0;
  const funded = livePositions(chain).filter((p) => p.detail !== null && p.detail.liquidity > 0n);
  if (funded.length === 0) return 0;
  const tick = chain.pool.tick;
  const outside = funded.some((p) =>
    isOutsideInner(tick, p.detail as NpmPosition, params.innerFraction),
  );
  return outside ? Math.max(0, prev) + 1 : 0;
}

/** Plan metrics from a snapshot (display, prompts and the plan critic's cross-check). */
export function planMetrics(snapshot: DeskSnapshot): PlanMetrics {
  const fv = snapshot.fairValue;
  const chain = snapshot.chain;
  const ref = chain?.lane.refTick;
  // Codes 3-6 still carry a sound tick (the contract computes it); 1, 2, 7 do not.
  const refUsable = ref !== undefined && ![1, 2, 7].includes(ref.code);
  return {
    F: fv?.F ?? null,
    poolMid: fv?.poolMid ?? null,
    gapBps: fv?.gapBps ?? null,
    poolTick: chain?.pool.tick ?? null,
    fTick: fv !== null && fv.F > 0 && Number.isFinite(fv.F) ? priceToTick(fv.F) : null,
    refTick: refUsable ? ref.tick : null,
    bandTicks: ref !== undefined ? ref.bandTicks : null,
  };
}

/** Hysteresis tolerance: the outer band of a range, snapped to the spacing (≥ one spacing). */
export function placementTolerance(width: number, params: StrategyParams): number {
  const band = (width * (1 - params.innerFraction)) / 2;
  return Math.max(params.tickSpacing, floorToSpacing(band, params.tickSpacing));
}

/** True when every planned range has a funded live position within the tolerance on both edges. */
export function samePlacement(
  ranges: readonly RangeSpec[],
  live: readonly LivePosition[],
  params: StrategyParams,
): boolean {
  const funded = live.filter((p) => p.detail !== null && p.detail.liquidity > 0n);
  if (funded.length !== ranges.length || ranges.length === 0) return false;
  return ranges.every((r) => {
    const tol = placementTolerance(r.tickUpper - r.tickLower, params);
    return funded.some((p) => {
      const d = p.detail as NpmPosition;
      return (
        Math.abs(d.tickLower - r.tickLower) <= tol && Math.abs(d.tickUpper - r.tickUpper) <= tol
      );
    });
  });
}

/** Value (USD, float) of the pool's active liquidity spread over [tl, tu) at the current price. */
export function activeLiquidityUsd(
  chain: ChainRead,
  range: { tickLower: number; tickUpper: number },
  decimals: TokenDecimals = NVDA_USDG_DECIMALS,
): number | null {
  const usdg = chain.chainlink.usdg?.price ?? null;
  const nvda = chain.chainlink.nvda?.price ?? null;
  if (usdg === null || nvda === null || !(usdg > 0) || !(nvda > 0)) return null;
  if (chain.pool.liquidity <= 0n) return null;
  const a = getAmountsForLiquidity(
    chain.pool.sqrtPriceX96,
    getSqrtRatioAtTick(range.tickLower),
    getSqrtRatioAtTick(range.tickUpper),
    chain.pool.liquidity,
  );
  const usd = toFloat(a.amount0, decimals.dec0) * usdg + toFloat(a.amount1, decimals.dec1) * nvda;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

interface Sized {
  ranges: RangeSpec[];
  notionalCents: number;
}

/** Scale shares so the fence-valued notional fits the cap (floor per share). */
export function sizeToCap(
  ranges: readonly RangeSpec[],
  balances: { balance0: bigint; balance1: bigint },
  prices: { p0: bigint; p1: bigint },
  capUsd6: bigint,
  decimals: TokenDecimals = NVDA_USDG_DECIMALS,
): Sized {
  const full = notionalUsd6(rerangeUpperAmounts(ranges, balances), prices, decimals);
  let out = ranges.map((r) => ({ ...r }));
  if (full > capUsd6 && full > 0n) {
    const cap = capUsd6 < 0n ? 0n : capUsd6;
    out = ranges.map((r) => ({
      ...r,
      share0Bps: Number((BigInt(r.share0Bps) * cap) / full),
      share1Bps: Number((BigInt(r.share1Bps) * cap) / full),
    }));
  }
  const usd6 = notionalUsd6(rerangeUpperAmounts(out, balances), prices, decimals);
  return { ranges: out, notionalCents: usd6ToCentsCeil(usd6) };
}

export function createLaneStrategy(opts: LaneStrategyOptions = {}): LaneStrategy {
  const minDeployCents = opts.minDeployCents ?? 500;
  const sigma = opts.sigmaTicksPerHour ?? 60;
  const weeks = opts.hourRecordWeeks ?? 9;
  const hurdleOnInitialMint = opts.hurdleOnInitialMint ?? false;
  const marginBps = BigInt(opts.capMarginBps ?? 200);
  const decimals = opts.decimals ?? NVDA_USDG_DECIMALS;

  function plan(ctx: StrategyContext): LanePlan {
    const { snapshot, regime, params, nowMs } = ctx;
    const metrics = planMetrics(snapshot);
    const rationale: string[] = [];
    let carry: LaneCarry = { outsideInnerTicks: 0, rerangeNotBeforeMs: null };
    let trigger: RerangeTrigger | null = null;
    let hurdle: HurdleResult | null = null;

    const result = (actions: DeskAction[], notionalCents = 0): LanePlan => ({
      lane: ctx.lane,
      laneAddress: snapshot.laneAddress,
      createdAtMs: nowMs,
      riskMode: regime.riskMode,
      actions,
      rationale,
      trigger,
      hurdle,
      metrics,
      notionalCents,
      carry,
    });
    const hold = (reason: string): LanePlan => {
      rationale.push(reason);
      return result([{ kind: "hold", lane: ctx.lane, reason }]);
    };

    if (ctx.lane !== "A") return hold(`lane ${ctx.lane} holds in M2 (lane B hedges on paper only)`);
    const chain = snapshot.chain;
    if (chain === null) return hold("no chain read this tick");
    carry = {
      outsideInnerTicks: outsideInnerStreak(ctx.laneState.outsideInnerTicks, chain, params),
      rerangeNotBeforeMs: null,
    };
    const live = livePositions(chain);

    if (regime.riskMode === "flat") {
      if (live.length === 0)
        return hold(`flat (${regime.activeGates.join(", ")}): nothing to exit`);
      rationale.push(`flat (${regime.activeGates.join(", ")}): exit every position`);
      return result([{ kind: "exitAll", lane: "A" }]);
    }
    if (regime.riskMode === "reduce_only") {
      return hold(`reduce-only (${regime.activeGates.join(", ") || "gates"}): positions held`);
    }

    // ---- normal: trigger
    if (live.some((p) => p.detail === null)) return hold("position details unknown this tick");
    const funded = live.filter((p) => (p.detail as NpmPosition).liquidity > 0n);
    const prices = fencePrices(chain);
    if (prices === null) return hold("fence prices unknown (Chainlink round unusable)");
    const balances = postUnwindBalances(chain);
    const tick = chain.pool.tick;

    if (funded.length === 0) {
      const all = notionalUsd6(
        { amount0: balances.balance0, amount1: balances.balance1 },
        prices,
        decimals,
      );
      if (usd6ToCentsCeil(all) < minDeployCents) return hold("lane empty and not funded");
      trigger = live.length === 0 ? "initial_mint" : "out_of_range";
    } else if (
      live.length !== funded.length ||
      funded.some((p) => {
        const d = p.detail as NpmPosition;
        return tick < d.tickLower || tick >= d.tickUpper;
      })
    ) {
      trigger = "out_of_range";
    } else if (carry.outsideInnerTicks >= params.outsideTicksToTrigger) {
      trigger = "outside_inner";
    } else {
      return hold(
        carry.outsideInnerTicks > 0
          ? `pool outside the inner band ${carry.outsideInnerTicks}/${params.outsideTicksToTrigger} tick(s)`
          : "in range",
      );
    }
    rationale.push(`trigger: ${trigger}`);

    // ---- rate limits (contract and agent) and lane state
    const lane = chain.lane;
    const nowSec = BigInt(Math.floor(nowMs / 1000));
    if (lane.paused) return hold("lane paused");
    if (!lane.riskAddingOpen.open)
      return hold(`lane closed to risk-adding (code ${lane.riskAddingOpen.code})`);
    if (lane.refTick.code !== 0)
      return hold(`fence reference unusable (code ${lane.refTick.code})`);
    if (lane.budgets.nextRerangeAt > nowSec) return hold("contract rerange interval not elapsed");
    if (lane.budgets.reranges1hLeft < 1n || lane.budgets.reranges24hLeft < 1n) {
      return hold("contract rerange budget exhausted");
    }
    const ar = ctx.agentRerange;
    if (ar.lastRerangeAtMs !== null && nowMs - ar.lastRerangeAtMs < ar.minIntervalMs) {
      return hold("agent rerange interval not elapsed");
    }
    if (ar.count1h >= ar.maxPerHour || ar.count24h >= ar.maxPerDay) {
      return hold("agent rerange budget exhausted");
    }

    // ---- placement
    const fv = snapshot.fairValue;
    if (fv === null || metrics.fTick === null) return hold("no fair value");
    const maxTickDelta = Math.min(params.maxTickDelta, lane.caps.maxTickDelta);
    const placement = planBands({
      poolTick: tick,
      fTick: metrics.fTick,
      gapBps: fv.gapBps,
      refTick: lane.refTick.tick,
      bandTicks: lane.refTick.bandTicks,
      tickSpacing: params.tickSpacing,
      halfWidthTicks: params.halfWidthTicks,
      straddleMaxGapBps: params.straddleMaxGapBps,
      minWidthTicks: lane.caps.minWidthTicks,
      maxWidthTicks: lane.caps.maxWidthTicks,
      balance0: balances.balance0,
      balance1: balances.balance1,
      executionTickMargin: maxTickDelta,
    });
    if (!placement.ok) return hold(`no placement: ${placement.reason}`);
    if (placement.ranges.length > lane.caps.maxRanges) return hold("placement exceeds maxRanges");
    if (samePlacement(placement.ranges, live, params))
      return hold("placement unchanged (within hysteresis)");
    rationale.push(`placement: ${placement.shape} centred on F (gap ${fv.gapBps.toFixed(1)} bp)`);

    // ---- sizing under the caps
    let capUsd6 = lane.caps.maxDeployUsd6;
    if (lane.budgets.turnoverAvailableUsd6 < capUsd6) capUsd6 = lane.budgets.turnoverAvailableUsd6;
    if (opts.maxActionCents !== undefined) {
      const cfg = centsToUsd6(Math.max(0, Math.floor(opts.maxActionCents)));
      if (cfg < capUsd6) capUsd6 = cfg;
    }
    capUsd6 = (capUsd6 * (10_000n - marginBps)) / 10_000n;
    const sized = sizeToCap(placement.ranges, balances, prices, capUsd6, decimals);
    if (sized.notionalCents < minDeployCents) {
      return hold(`deployable notional below the $${(minDeployCents / 100).toFixed(2)} minimum`);
    }

    // ---- cost hurdle
    const gas =
      ctx.gasQuote ??
      (chain.baseFeePerGas !== null && chain.baseFeePerGas > 0n && snapshot.ethUsd !== null
        ? {
            gasUnits: params.rerangeGasUnits,
            maxFeePerGas: 2n * chain.baseFeePerGas,
            ethUsd: snapshot.ethUsd,
          }
        : null);
    const span = {
      tickLower: Math.min(...sized.ranges.map((r) => r.tickLower)),
      tickUpper: Math.max(...sized.ranges.map((r) => r.tickUpper)),
    };
    const liquidityUsd = activeLiquidityUsd(chain, span, decimals);
    const rate = feeRatePerHour(ctx.hourRecord, liquidityUsd ?? Number.NaN, weeks);
    let pOut = 1;
    if (trigger === "outside_inner") {
      const distance = Math.min(
        ...funded.map((p) => {
          const d = p.detail as NpmPosition;
          return Math.min(tick - d.tickLower, d.tickUpper - tick);
        }),
      );
      pOut = pOutOfRangeWithin(distance, sigma, 1);
    }
    hurdle =
      gas === null || rate === null
        ? {
            costUsd: 0,
            benefitUsd: 0,
            multiple: 0,
            passes: false,
            detail:
              gas === null
                ? "no gas quote (base fee or ETH/USD unknown)"
                : "no fee rate (hour record or pool liquidity unknown)",
          }
        : costHurdle({
            gasUnits: gas.gasUnits,
            maxFeePerGas: gas.maxFeePerGas,
            ethUsd: gas.ethUsd,
            feeRatePerHour: rate,
            activeNotionalUsd: sized.notionalCents / 100,
            pOutOfRange: pOut,
            multiple: params.hurdleMultiple,
          });
    if (!hurdle.passes) {
      if (trigger !== "initial_mint" || hurdleOnInitialMint)
        return hold(`cost hurdle: ${hurdle.detail}`);
      rationale.push(`cost hurdle waived for the initial mint (${hurdle.detail})`);
    } else {
      rationale.push(`cost hurdle: ${hurdle.detail}`);
    }

    // ---- jitter: never propose at a predictable instant
    const notBefore = ctx.laneState.rerangeNotBeforeMs;
    if (notBefore === null) {
      const at =
        nowMs + Math.floor(Math.max(0, Math.min(0.999999, ctx.random())) * params.jitterMaxMs);
      if (at > nowMs) {
        carry = { ...carry, rerangeNotBeforeMs: at };
        return hold(`rerange scheduled in ${Math.ceil((at - nowMs) / 1000)} s (jitter)`);
      }
    } else if (nowMs < notBefore) {
      carry = { ...carry, rerangeNotBeforeMs: notBefore };
      return hold(`rerange scheduled in ${Math.ceil((notBefore - nowMs) / 1000)} s (jitter)`);
    }

    return result(
      [{ kind: "rerange", lane: "A", ranges: sized.ranges, expectedTick: tick, maxTickDelta }],
      sized.notionalCents,
    );
  }

  return { plan };
}

export const laneStrategy: LaneStrategy = createLaneStrategy();
