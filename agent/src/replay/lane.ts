/**
 * The replay's simulated lane A: token balances and up to two v3 positions, moved only by the
 * actions the real strategy plans (rerange → unwind everything, then mint the planned ranges from
 * their shares of the post-unwind balances; exitAll → unwind everything). Fees are not accrued (at
 * ~$50 they are cents); on-chain budgets are modeled from the lane's own rerange history under the
 * M2 default caps. The swaps of other traders move the pool price, never this lane's liquidity
 * (a $50 lane is ~1e-5 of the active liquidity).
 */

import { DEFAULT_LANE_CAPS } from "../sense/mock.js";
import type { AgentRerangeState, LaneBudgets, LaneCaps, NpmPosition, RangeSpec } from "../types.js";
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  toFloat,
} from "../units.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface SimLane {
  positions: NpmPosition[];
  balance0: bigint;
  balance1: bigint;
  reranges: { atMs: number; notionalCents: number }[];
  nextTokenId: bigint;
}

/** A funded, empty lane: half USDG (token0, 6 dec), half NVDA (token1, 18 dec) at `mid`. */
export function newSimLane(usd: number, mid: number): SimLane {
  return {
    positions: [],
    balance0: BigInt(Math.round((usd / 2) * 1e6)),
    balance1: BigInt(Math.round((usd / 2 / mid) * 1e6)) * 10n ** 12n,
    reranges: [],
    nextTokenId: 1n,
  };
}

export function positionAmounts(
  lane: SimLane,
  sqrtP: bigint,
): { amount0: bigint; amount1: bigint } {
  let amount0 = 0n;
  let amount1 = 0n;
  for (const p of lane.positions) {
    const a = getAmountsForLiquidity(
      sqrtP,
      getSqrtRatioAtTick(p.tickLower),
      getSqrtRatioAtTick(p.tickUpper),
      p.liquidity,
    );
    amount0 += a.amount0;
    amount1 += a.amount1;
  }
  return { amount0, amount1 };
}

function unwound(lane: SimLane, sqrtP: bigint): SimLane {
  const a = positionAmounts(lane, sqrtP);
  return {
    ...lane,
    positions: [],
    balance0: lane.balance0 + a.amount0,
    balance1: lane.balance1 + a.amount1,
  };
}

export function applyExitAll(lane: SimLane, sqrtP: bigint): SimLane {
  return unwound(lane, sqrtP);
}

export function applyRerange(
  lane: SimLane,
  ranges: readonly RangeSpec[],
  sqrtP: bigint,
  nowMs: number,
  notionalCents: number,
): SimLane {
  const u = unwound(lane, sqrtP);
  let b0 = u.balance0;
  let b1 = u.balance1;
  let id = u.nextTokenId;
  const positions: NpmPosition[] = [];
  for (const r of ranges) {
    const want0 = (u.balance0 * BigInt(r.share0Bps)) / 10_000n;
    const want1 = (u.balance1 * BigInt(r.share1Bps)) / 10_000n;
    const sa = getSqrtRatioAtTick(r.tickLower);
    const sb = getSqrtRatioAtTick(r.tickUpper);
    const liquidity = getLiquidityForAmounts(sqrtP, sa, sb, want0, want1);
    if (liquidity === 0n) continue;
    const used = getAmountsForLiquidity(sqrtP, sa, sb, liquidity);
    b0 -= used.amount0;
    b1 -= used.amount1;
    positions.push({
      tokenId: id,
      tickLower: r.tickLower,
      tickUpper: r.tickUpper,
      liquidity,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
    });
    id += 1n;
  }
  return {
    positions,
    balance0: b0,
    balance1: b1,
    reranges: [...lane.reranges, { atMs: nowMs, notionalCents }],
    nextTokenId: id,
  };
}

/** The lane's slots as ChainRead.lane reports them. */
export function laneSlots(lane: SimLane): {
  positions: readonly [bigint, bigint];
  positionDetails: readonly [NpmPosition | null, NpmPosition | null];
} {
  const p0 = lane.positions[0] ?? null;
  const p1 = lane.positions[1] ?? null;
  return { positions: [p0?.tokenId ?? 0n, p1?.tokenId ?? 0n], positionDetails: [p0, p1] };
}

/** On-chain budgets under the caps, from the lane's own rerange history (TokenBucket modeled as a rolling window). */
export function budgetsAt(
  lane: SimLane,
  nowMs: number,
  caps: LaneCaps = DEFAULT_LANE_CAPS,
): LaneBudgets {
  const in1h = lane.reranges.filter((r) => nowMs - r.atMs < HOUR_MS).length;
  const day = lane.reranges.filter((r) => nowMs - r.atMs < DAY_MS);
  const spentUsd6 = day.reduce((a, r) => a + BigInt(r.notionalCents) * 10_000n, 0n);
  const last = lane.reranges.at(-1);
  const left = caps.turnoverUsd6PerDay - spentUsd6;
  return {
    turnoverAvailableUsd6: left > 0n ? left : 0n,
    reranges1hLeft: BigInt(Math.max(0, caps.reranges1h - in1h)),
    reranges24hLeft: BigInt(Math.max(0, caps.reranges24h - day.length)),
    nextRerangeAt:
      last === undefined ? 0n : BigInt(Math.floor(last.atMs / 1000) + caps.minRerangeInterval),
  };
}

/** The agent's own rerange limits (config defaults: 4/h, 24/day, 300 s apart). */
export function agentRerangeAt(lane: SimLane, nowMs: number): AgentRerangeState {
  return {
    lastRerangeAtMs: lane.reranges.at(-1)?.atMs ?? null,
    count1h: lane.reranges.filter((r) => nowMs - r.atMs < HOUR_MS).length,
    count24h: lane.reranges.filter((r) => nowMs - r.atMs < DAY_MS).length,
    maxPerHour: 4,
    maxPerDay: 24,
    minIntervalMs: 300_000,
  };
}

/** Lane value at the pool mid (USDG = $1): idle balances + positions. */
export function laneValueUsd(lane: SimLane, sqrtP: bigint, mid: number): number {
  const a = positionAmounts(lane, sqrtP);
  return toFloat(lane.balance0 + a.amount0, 6) + toFloat(lane.balance1 + a.amount1, 18) * mid;
}

/** Deployed value in positions (USD) and whether any funded position is in range at `tick`. */
export function positionState(
  lane: SimLane,
  sqrtP: bigint,
  tick: number,
  mid: number,
): { deployedUsd: number; inRange: boolean | null } {
  if (lane.positions.length === 0) return { deployedUsd: 0, inRange: null };
  const a = positionAmounts(lane, sqrtP);
  return {
    deployedUsd: toFloat(a.amount0, 6) + toFloat(a.amount1, 18) * mid,
    inRange: lane.positions.some((p) => tick >= p.tickLower && tick < p.tickUpper),
  };
}
