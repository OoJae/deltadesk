/**
 * Band placement for lane A v0 and the contract's placement fence (RangeRules.check), mirrored.
 *
 * Orientation: ticks are token1-per-token0 (NVDA per USDG), so a HIGHER NVDA price is a LOWER tick.
 * Token0 (USDG) liquidity sits above the pool tick: bids for NVDA below the market. Token1 (NVDA)
 * liquidity sits below it: asks above the market.
 *
 * Placement (centre on F, never the pool):
 * - |gap| ≤ straddleMaxGapBps and both tokens held: one straddle [fTick − w, fTick + w], snapped
 *   outward to the spacing. The fence allows a straddle only if |tc − refTick| ≤ band; there is no
 *   freedom in the ticks, so an out-of-fence straddle is skipped.
 * - otherwise single-sided on the far side of F, width 2w, starting at F and extending away from
 *   the pool: F above the pool → NVDA asks at prices ≥ F (ticks ≤ fTick); F below the pool → USDG
 *   bids at prices ≤ F (ticks ≥ fTick). When the pool is near F but only one token is held, that
 *   token goes on its own side, still starting at F. The near edge is then pushed further from the
 *   pool if the fence needs it (never inward), so a single-sided range always exists unless the
 *   inventory or the width limits forbid it.
 *
 * The contract checks the fence against slot0.tick at EXECUTION, which may sit anywhere within
 * expectedTick ± maxTickDelta. Every range returned here satisfies the fence, and keeps its shape,
 * for every tick in that window (executionTickMargin).
 */

import type { BandPlacement, BandPlacementInput, BandPlanner, RangeSpec } from "../types.js";
import {
  ceilToSpacing,
  floorToSpacing,
  isAligned,
  MAX_TICK,
  MIN_TICK,
  snapRangeOutward,
} from "../units.js";

export type { BandPlacement, BandPlacementInput, BandPlanner, RangeSpec } from "../types.js";

export interface TickRange {
  tickLower: number;
  tickUpper: number;
}

/**
 * RangeRules.check: never offer either token more than `band` ticks worse than the reference. v3 counts
 * tc == tickLower as in range, so the current bucket holds token1 too: the bid check runs when tl <= tc.
 */
export function fenceAllows(range: TickRange, tc: number, refTick: number, band: number): boolean {
  const { tickLower: tl, tickUpper: tu } = range;
  if (tu > tc && Math.max(tl, tc) < refTick - band) return false;
  if (tl <= tc && Math.min(tu, tc) > refTick + band) return false;
  return true;
}

/** The fence at every execution tick within tc ± margin. */
export function fenceAllowsAcross(
  range: TickRange,
  tc: number,
  margin: number,
  refTick: number,
  band: number,
): boolean {
  for (let t = tc - margin; t <= tc + margin; t++) {
    if (!fenceAllows(range, t, refTick, band)) return false;
  }
  return true;
}

/** RangeRules.shapeOk. */
export function shapeOk(
  range: TickRange,
  spacing: number,
  minWidth: number,
  maxWidth: number,
): boolean {
  const { tickLower: tl, tickUpper: tu } = range;
  if (!Number.isInteger(tl) || !Number.isInteger(tu) || tl >= tu || spacing <= 0) return false;
  if (tl < MIN_TICK || tu > MAX_TICK) return false;
  if (!isAligned(tl, spacing) || !isAligned(tu, spacing)) return false;
  const width = tu - tl;
  return width >= minWidth && width <= maxWidth;
}

/** Which tokens a range holds with the pool at tc (v3: tc's bucket holds both, tickLower == tc included). */
export function rangeNeeds(range: TickRange, tc: number): { token0: boolean; token1: boolean } {
  return { token0: range.tickUpper > tc, token1: range.tickLower <= tc };
}

export interface BandPlacementOptions {
  /** Plan for execution anywhere within poolTick ± this (the rerange's maxTickDelta). */
  executionTickMargin?: number;
}

const fail = (reason: string): BandPlacement => ({ ok: false, reason });

function validInput(i: BandPlacementInput, margin: number): string | null {
  const ints: Array<[string, number]> = [
    ["poolTick", i.poolTick],
    ["fTick", i.fTick],
    ["refTick", i.refTick],
    ["bandTicks", i.bandTicks],
    ["tickSpacing", i.tickSpacing],
    ["halfWidthTicks", i.halfWidthTicks],
    ["minWidthTicks", i.minWidthTicks],
    ["maxWidthTicks", i.maxWidthTicks],
    ["executionTickMargin", margin],
  ];
  for (const [name, v] of ints) {
    if (!Number.isInteger(v)) return `${name} must be an integer, got ${v}`;
  }
  if (!Number.isFinite(i.gapBps)) return `gapBps must be finite, got ${i.gapBps}`;
  if (i.tickSpacing <= 0 || i.halfWidthTicks <= 0 || i.bandTicks < 0 || margin < 0) {
    return "spacing and half-width must be > 0; band and margin ≥ 0";
  }
  if (i.balance0 < 0n || i.balance1 < 0n) return "negative balance";
  return null;
}

export const planBands = ((input: BandPlacementInput & BandPlacementOptions): BandPlacement => {
  const m = input.executionTickMargin ?? 0;
  const invalid = validInput(input, m);
  if (invalid !== null) return fail(`invalid placement input: ${invalid}`);

  const { poolTick: tc, fTick, refTick, bandTicks: band, tickSpacing: spacing } = input;
  const w = input.halfWidthTicks;
  const has0 = input.balance0 > 0n;
  const has1 = input.balance1 > 0n;
  if (!has0 && !has1) return fail("no inventory: both balances are zero");

  const check = (r: RangeSpec, shape: string): string | null => {
    if (!shapeOk(r, spacing, input.minWidthTicks, input.maxWidthTicks)) {
      return `${shape} [${r.tickLower}, ${r.tickUpper}) breaks the shape rules (spacing ${spacing}, width ${input.minWidthTicks}-${input.maxWidthTicks})`;
    }
    if (!fenceAllowsAcross(r, tc, m, refTick, band)) {
      return `${shape} [${r.tickLower}, ${r.tickUpper}) is outside the placement fence (ref ${refTick} ± ${band}, pool ${tc} ± ${m})`;
    }
    return null;
  };

  const nearF = Math.abs(input.gapBps) <= input.straddleMaxGapBps;
  if (nearF && has0 && has1) {
    const [tl, tu] = snapRangeOutward(fTick - w, fTick + w, spacing);
    const r: RangeSpec = { tickLower: tl, tickUpper: tu, share0Bps: 10_000, share1Bps: 10_000 };
    if (!(tl < tc - m && tu > tc + m)) {
      return fail(`the pool (${tc} ± ${m}) is not inside the straddle [${tl}, ${tu})`);
    }
    const bad = check(r, "straddle");
    return bad === null ? { ok: true, shape: "straddle", ranges: [r] } : fail(bad);
  }

  // Single-sided: F above the pool (fTick < tc) puts NVDA asks beyond F; F below puts USDG bids.
  const side: "token0" | "token1" = nearF
    ? has0
      ? "token0"
      : "token1"
    : fTick < tc
      ? "token1"
      : "token0";
  const width = ceilToSpacing(2 * w, spacing);
  let r: RangeSpec;
  if (side === "token1") {
    if (!has1) return fail("F is above the pool but the lane holds no NVDA (token1) for asks");
    let tu = floorToSpacing(Math.min(fTick, tc - m), spacing);
    tu = Math.min(tu, floorToSpacing(refTick + band, spacing));
    r = { tickLower: tu - width, tickUpper: tu, share0Bps: 0, share1Bps: 10_000 };
  } else {
    if (!has0) return fail("F is below the pool but the lane holds no USDG (token0) for bids");
    // Strictly above every execution tick: a range starting AT the pool tick also holds token1 (and a
    // token0-only mint there would get zero liquidity).
    let tl = ceilToSpacing(Math.max(fTick, tc + m + 1), spacing);
    tl = Math.max(tl, ceilToSpacing(refTick - band, spacing));
    r = { tickLower: tl, tickUpper: tl + width, share0Bps: 10_000, share1Bps: 0 };
  }
  const shape = side === "token0" ? "single_sided_token0" : "single_sided_token1";
  const needs = rangeNeeds(r, side === "token0" ? tc + m : tc - m);
  if (needs.token0 !== (side === "token0") || needs.token1 !== (side === "token1")) {
    return fail(`${shape} [${r.tickLower}, ${r.tickUpper}) would not stay single-sided`);
  }
  const bad = check(r, shape);
  return bad === null ? { ok: true, shape, ranges: [r] } : fail(bad);
}) satisfies BandPlanner;
