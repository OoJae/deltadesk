/**
 * Lane B hedge engine (PAPER in M2: the actions it emits go to the paper executor, never to HL).
 *
 *   Δ   lane delta in NVDA: every position's NVDA at the current pool price + owed NVDA + idle NVDA
 *   H*  target hedge position on the HL perp: −hedgeRatio × Δ (short the NVDA the lane holds)
 *   τ   rebalance tolerance: max(tauFraction × |Δ|, minTradeUsd / mid)
 *
 * A hedge order is emitted only when |H* − position| > τ: a maker (ALO) order at the touch, sized
 * to reach H*, reduce-only when it shrinks the hedge without flipping it. No HL quote, no order.
 */

import { NVDA_USDG_DECIMALS, positionAmounts, type TokenDecimals } from "../guard/risk.js";
import {
  type ChainRead,
  type HedgeAction,
  type HedgeEngine,
  type HedgeState,
  HL_NVDA_ASSET,
  HL_NVDA_COIN,
} from "../types.js";
import { toFloat } from "../units.js";

export type { HedgeAction, HedgeContext, HedgeEngine, HedgeState } from "../types.js";

export interface HedgeEngineOptions {
  /** Fraction of Δ to hedge (default 1). */
  hedgeRatio?: number;
  /** τ as a fraction of |Δ| (default 0.1). */
  tauFraction?: number;
  /** Never trade less than this notional (default $10). */
  minTradeUsd?: number;
  /** HL size decimals for xyz:NVDA (default 3). */
  szDecimals?: number;
  decimals?: TokenDecimals;
}

/** HL price format: 5 significant figures, at most 6 − szDecimals decimals, no trailing zeros. */
export function formatHlPx(px: number, szDecimals: number): string {
  if (!(Number.isFinite(px) && px > 0)) return "0";
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Number(px.toPrecision(5));
  return trimZeros(sig.toFixed(maxDecimals));
}

/** HL size format: floored to szDecimals (never rounds a size up). */
export function formatHlSz(sz: number, szDecimals: number): string {
  if (!(Number.isFinite(sz) && sz > 0)) return "0";
  const f = 10 ** szDecimals;
  return trimZeros((Math.floor(sz * f + 1e-9) / f).toFixed(szDecimals));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** The lane's NVDA exposure (token1), whole tokens. */
export function laneDeltaNvda(
  chain: ChainRead,
  decimals: TokenDecimals = NVDA_USDG_DECIMALS,
): number {
  const pos = positionAmounts(chain);
  return toFloat(pos.amount1 + chain.lane.balances.token1, decimals.dec1);
}

export function createHedgeEngine(opts: HedgeEngineOptions = {}): HedgeEngine {
  const ratio = opts.hedgeRatio ?? 1;
  const tauFraction = opts.tauFraction ?? 0.1;
  const minTradeUsd = opts.minTradeUsd ?? 10;
  const szDecimals = opts.szDecimals ?? 3;
  const decimals = opts.decimals ?? NVDA_USDG_DECIMALS;

  return {
    step({ snapshot, paperPosition, nowMs }) {
      const position = Number.isFinite(paperPosition) ? paperPosition : 0;
      const chain = snapshot.chain;
      const hl = snapshot.hl;
      const delta = chain === null ? 0 : laneDeltaNvda(chain, decimals);
      const target = -ratio * delta;
      const mid = hl !== null && hl.mid > 0 ? hl.mid : null;
      const tau = Math.max(tauFraction * Math.abs(delta), mid === null ? 0 : minTradeUsd / mid);
      const state: HedgeState = { delta, target, tau, position, atMs: nowMs };

      if (snapshot.lane !== "B" || chain === null || hl === null || mid === null) {
        return { state, actions: [] };
      }
      const diff = target - position;
      if (Math.abs(diff) <= tau) return { state, actions: [] };

      const isBuy = diff > 0;
      const sz = formatHlSz(Math.abs(diff), szDecimals);
      const px = formatHlPx(isBuy ? hl.bid : hl.ask, szDecimals);
      if (Number(sz) <= 0 || Number(px) <= 0) return { state, actions: [] };
      // Shrinking an existing hedge toward zero without crossing it.
      const reduceOnly =
        position !== 0 &&
        Math.sign(diff) === -Math.sign(position) &&
        Math.abs(diff) <= Math.abs(position);
      const action: HedgeAction = {
        kind: "hedge",
        lane: "B",
        coin: HL_NVDA_COIN,
        asset: HL_NVDA_ASSET,
        isBuy,
        sz,
        px,
        tif: "Alo",
        reduceOnly,
      };
      return { state, actions: [action] };
    },
  };
}

export const hedgeEngine: HedgeEngine = createHedgeEngine();
