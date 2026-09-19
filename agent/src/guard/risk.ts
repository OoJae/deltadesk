/**
 * Risk model: the risk mode the active gates imply, and the fence-valued notional of an action in
 * integer cents.
 *
 * Notional is valued exactly as the contract values a rerange (DeskLaneV3 step 9):
 *   usd6 = amount · priceE18 / (10^decimals · 1e12), rounded UP (a spend never shrinks by rounding),
 * with priceE18 the fence's usdPrice, i.e. the Chainlink answer scaled to 1e18 with its live decimals.
 * Before simulation the amounts are an UPPER bound: the rerange's shares of the post-unwind balances
 * (idle tokens + every position's amounts at the current price + tokens owed). After simulation they
 * are the amounts the eth_call returned. Anything unknown (no chain read, a dead feed) makes an adding
 * action's notional NaN, which fails every cap comparison downstream (fail-closed).
 */

import { NVDA_USDG_POOL } from "../addresses.js";
import {
  type ChainlinkRound,
  type ChainRead,
  type DeskAction,
  type DeskSnapshot,
  GATE_EFFECT,
  GATE_IMPLEMENTED,
  type GateName,
  type RangeSpec,
  type RiskMode,
  type RiskModel,
  riskClassOf,
  type SimulationResult,
} from "../types.js";
import {
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  usd6ToCentsCeil,
  usdToCents,
  valueUsd6,
} from "../units.js";

export interface TokenDecimals {
  dec0: number;
  dec1: number;
}

export const NVDA_USDG_DECIMALS: TokenDecimals = {
  dec0: NVDA_USDG_POOL.dec0,
  dec1: NVDA_USDG_POOL.dec1,
};

const BPS = 10_000n;

/** flat beats reduce_only beats normal. Stub gates (implemented: false) force nothing. */
export function riskModeOf(activeGates: readonly GateName[]): RiskMode {
  let mode: RiskMode = "normal";
  for (const gate of activeGates) {
    if (!GATE_IMPLEMENTED[gate]) continue;
    const effect = GATE_EFFECT[gate];
    if (effect === "flat") return "flat";
    if (effect === "reduce_only") mode = "reduce_only";
  }
  return mode;
}

/** The stricter of two risk modes. */
export function stricterRiskMode(a: RiskMode, b: RiskMode): RiskMode {
  const rank: Record<RiskMode, number> = { normal: 0, reduce_only: 1, flat: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/** IPriceFence.usdPrice from a Chainlink round: answer · 1e18 / 10^decimals; null if unusable. */
export function fencePriceE18(round: ChainlinkRound | null | undefined): bigint | null {
  if (round === null || round === undefined) return null;
  if (round.answer <= 0n || !Number.isInteger(round.decimals) || round.decimals < 0) return null;
  return (round.answer * 10n ** 18n) / 10n ** BigInt(round.decimals);
}

/** Fence prices of token0 (USDG) and token1 (NVDA) for lane A's pool; null when either is unusable. */
export function fencePrices(chain: ChainRead | null): { p0: bigint; p1: bigint } | null {
  if (chain === null) return null;
  const p0 = fencePriceE18(chain.chainlink.usdg);
  const p1 = fencePriceE18(chain.chainlink.nvda);
  return p0 === null || p1 === null ? null : { p0, p1 };
}

/** Token amounts held by the lane's live positions at the current pool price, fees owed included. */
export function positionAmounts(chain: ChainRead): { amount0: bigint; amount1: bigint } {
  let amount0 = 0n;
  let amount1 = 0n;
  for (const p of chain.lane.positionDetails) {
    if (p === null) continue;
    if (p.liquidity > 0n) {
      const a = getAmountsForLiquidity(
        chain.pool.sqrtPriceX96,
        getSqrtRatioAtTick(p.tickLower),
        getSqrtRatioAtTick(p.tickUpper),
        p.liquidity,
      );
      amount0 += a.amount0;
      amount1 += a.amount1;
    }
    amount0 += p.tokensOwed0;
    amount1 += p.tokensOwed1;
  }
  return { amount0, amount1 };
}

/** What a rerange will mint from: idle balances plus everything the unwind releases. */
export function postUnwindBalances(chain: ChainRead): { balance0: bigint; balance1: bigint } {
  const pos = positionAmounts(chain);
  return {
    balance0: chain.lane.balances.token0 + pos.amount0,
    balance1: chain.lane.balances.token1 + pos.amount1,
  };
}

/** Upper bound of the amounts a rerange can mint: Σ shares of the post-unwind balances. */
export function rerangeUpperAmounts(
  ranges: readonly RangeSpec[],
  balances: { balance0: bigint; balance1: bigint },
): { amount0: bigint; amount1: bigint } {
  let share0 = 0n;
  let share1 = 0n;
  for (const r of ranges) {
    share0 += BigInt(r.share0Bps);
    share1 += BigInt(r.share1Bps);
  }
  return {
    amount0: (balances.balance0 * share0) / BPS,
    amount1: (balances.balance1 * share1) / BPS,
  };
}

/** The contract's notional of minted amounts (usd6, rounded up per token). */
export function notionalUsd6(
  amounts: { amount0: bigint; amount1: bigint },
  prices: { p0: bigint; p1: bigint },
  decimals: TokenDecimals = NVDA_USDG_DECIMALS,
): bigint {
  return (
    valueUsd6(amounts.amount0, decimals.dec0, prices.p0, true) +
    valueUsd6(amounts.amount1, decimals.dec1, prices.p1, true)
  );
}

/** Adding notional of a hedge order, cents (paper in M2). NaN when the order does not parse. */
export function hedgeNotionalCents(sz: string, px: string): number {
  const s = Number(sz);
  const p = Number(px);
  if (!Number.isFinite(s) || !Number.isFinite(p) || s < 0 || p < 0) return Number.NaN;
  return usdToCents(s * p);
}

export interface RiskModelOptions {
  decimals?: TokenDecimals;
}

export function createRiskModel(opts: RiskModelOptions = {}): RiskModel {
  const decimals = opts.decimals ?? NVDA_USDG_DECIMALS;
  return {
    riskMode: riskModeOf,
    notionalCents(action: DeskAction, snapshot: DeskSnapshot, simulation: SimulationResult | null) {
      if (riskClassOf(action) !== "adding") return 0;
      if (action.kind === "hedge") return hedgeNotionalCents(action.sz, action.px);
      if (action.kind !== "rerange") return Number.NaN;
      const prices = fencePrices(snapshot.chain);
      if (prices === null || snapshot.chain === null) return Number.NaN;
      const sim = simulation?.ok === true ? simulation.rerange : null;
      const amounts =
        sim !== null && sim !== undefined
          ? { amount0: sim.amount0Used, amount1: sim.amount1Used }
          : rerangeUpperAmounts(action.ranges, postUnwindBalances(snapshot.chain));
      return usd6ToCentsCeil(notionalUsd6(amounts, prices, decimals));
    },
  };
}

export const riskModel: RiskModel = createRiskModel();
