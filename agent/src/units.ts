/**
 * Exact integer math shared by strategy, guard and executor: mulDiv, Uniswap v3 TickMath, the
 * LiquidityAmounts / SqrtPriceMath amount formulas, tick ↔ price for the pool's decimals
 * orientation, and the money boundaries (USD floats → integer cents exactly once).
 *
 * Orientation: a v3 pool's raw price is token1 per token0 in BASE UNITS, P = 1.0001^tick. For the
 * NVDA/USDG pool token0 = USDG (6 dec) and token1 = NVDA (18 dec), so the human quote price
 * (USDG per NVDA) is 10^(dec1 − dec0) / P and a HIGHER NVDA price is a LOWER tick.
 */

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const Q192 = 1n << 192n;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// ---------------------------------------------------------------------------------------------
// FullMath

function assertUint(name: string, v: bigint): void {
  if (v < 0n) throw new RangeError(`${name} must be non-negative, got ${v}`);
}

/** floor(a · b / denominator), exact. */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  assertUint("a", a);
  assertUint("b", b);
  if (denominator <= 0n) throw new RangeError("mulDiv: denominator must be > 0");
  return (a * b) / denominator;
}

/** ceil(a · b / denominator), exact. */
export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const q = mulDiv(a, b, denominator);
  return (a * b) % denominator === 0n ? q : q + 1n;
}

/** ceil(a / b). */
export function divRoundingUp(a: bigint, b: bigint): bigint {
  assertUint("a", a);
  if (b <= 0n) throw new RangeError("divRoundingUp: b must be > 0");
  return a / b + (a % b === 0n ? 0n : 1n);
}

// ---------------------------------------------------------------------------------------------
// TickMath (exact port of Uniswap v3 TickMath.sol)

const TICK_FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

export function assertTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick ${tick} is not an integer in [${MIN_TICK}, ${MAX_TICK}]`);
  }
}

/** sqrt(1.0001^tick) · 2^96, rounded up exactly as TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick: number): bigint {
  assertTick(tick);
  const absTick = Math.abs(tick);
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
  for (const [bit, factor] of TICK_FACTORS) {
    if ((absTick & bit) !== 0) ratio = (ratio * factor) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** The greatest tick whose sqrt ratio is ≤ sqrtPriceX96 (TickMath.getTickAtSqrtRatio). */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new RangeError(`sqrtPriceX96 ${sqrtPriceX96} out of [MIN_SQRT_RATIO, MAX_SQRT_RATIO)`);
  }
  const ratio = sqrtPriceX96 << 32n;
  const msb = BigInt(ratio.toString(2).length - 1);
  let r = msb >= 128n ? ratio >> (msb - 127n) : ratio << (127n - msb);
  let log2 = (msb - 128n) << 64n;
  for (let i = 63n; i >= 50n; i--) {
    r = (r * r) >> 127n;
    const f = r >> 128n;
    log2 |= f << i;
    r >>= f;
  }
  const logSqrt10001 = log2 * 255738958999603826347141n;
  const tickLow = Number((logSqrt10001 - 3402992956809132418596140100660247210n) >> 128n);
  const tickHigh = Number((logSqrt10001 + 291339464771989622907027621153398088495n) >> 128n);
  if (tickLow === tickHigh) return tickLow;
  return getSqrtRatioAtTick(tickHigh) <= sqrtPriceX96 ? tickHigh : tickLow;
}

// ---------------------------------------------------------------------------------------------
// Tick spacing and ranges

export function floorToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

export function ceilToSpacing(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

export function isAligned(tick: number, spacing: number): boolean {
  return Number.isInteger(tick) && tick % spacing === 0;
}

/** Snap [lower, upper] OUTWARD to the spacing grid (never narrows a range). */
export function snapRangeOutward(lower: number, upper: number, spacing: number): [number, number] {
  return [floorToSpacing(lower, spacing), ceilToSpacing(upper, spacing)];
}

/** The contract's rule: bandTicks = caps.placeBandBps (1 bp ≈ 1 tick, rounded up). */
export function bpsToTicksCeil(bps: number): number {
  return Math.ceil(bps);
}

/** Exact-real tick distance of a price ratio: ln(r) / ln(1.0001). */
export function priceRatioToTicks(ratio: number): number {
  return Math.log(ratio) / Math.log(1.0001);
}

// ---------------------------------------------------------------------------------------------
// Prices for a decimals orientation (floats: display, strategy and fair-value math only)

export interface PoolOrientation {
  dec0: number;
  dec1: number;
  /** false for NVDA/USDG: the base asset (NVDA) is token1. */
  baseIsToken0: boolean;
}

export const NVDA_USDG_ORIENTATION: PoolOrientation = { dec0: 6, dec1: 18, baseIsToken0: false };

/** Human token1-per-token0 from a raw (base-unit) price. */
function human1Per0(raw: number, o: PoolOrientation): number {
  return raw * 10 ** (o.dec0 - o.dec1);
}

/** Quote per base (USDG per NVDA for the default orientation) at a tick. */
export function tickToPrice(tick: number, o: PoolOrientation = NVDA_USDG_ORIENTATION): number {
  const h = human1Per0(1.0001 ** tick, o);
  return o.baseIsToken0 ? h : 1 / h;
}

/** Raw price P (token1 per token0, base units) for a quote-per-base price. */
function rawFromPrice(price: number, o: PoolOrientation): number {
  if (!(price > 0) || !Number.isFinite(price))
    throw new RangeError(`price must be positive, got ${price}`);
  const h = o.baseIsToken0 ? price : 1 / price;
  return h / 10 ** (o.dec0 - o.dec1);
}

/** The greatest tick t with 1.0001^t ≤ P(price). */
export function priceToTick(price: number, o: PoolOrientation = NVDA_USDG_ORIENTATION): number {
  const raw = rawFromPrice(price, o);
  let t = Math.floor(Math.log(raw) / Math.log(1.0001));
  // Float log can land one tick off at an exact boundary; settle it against the power.
  if (1.0001 ** (t + 1) <= raw) t += 1;
  else if (1.0001 ** t > raw) t -= 1;
  return Math.max(MIN_TICK, Math.min(MAX_TICK, t));
}

/** Quote per base from sqrtPriceX96 (the engine's mid_from_sqrt). */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  o: PoolOrientation = NVDA_USDG_ORIENTATION,
): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const h = human1Per0(s * s, o);
  return o.baseIsToken0 ? h : 1 / h;
}

export function priceToSqrtPriceX96(
  price: number,
  o: PoolOrientation = NVDA_USDG_ORIENTATION,
): bigint {
  const raw = rawFromPrice(price, o);
  return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
}

// ---------------------------------------------------------------------------------------------
// Liquidity amounts (LiquidityAmounts.sol and SqrtPriceMath.sol)

function sortRatios(a: bigint, b: bigint): [bigint, bigint] {
  return a > b ? [b, a] : [a, b];
}

function toUint128(x: bigint): bigint {
  if (x > MAX_UINT128) throw new RangeError("liquidity overflows uint128");
  return x;
}

export function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [lo, hi] = sortRatios(sqrtA, sqrtB);
  if (lo === hi) return 0n;
  const intermediate = mulDiv(lo, hi, Q96);
  return toUint128(mulDiv(amount0, intermediate, hi - lo));
}

export function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [lo, hi] = sortRatios(sqrtA, sqrtB);
  if (lo === hi) return 0n;
  return toUint128(mulDiv(amount1, Q96, hi - lo));
}

/** The max liquidity that amount0 and amount1 can mint in [sqrtA, sqrtB] at price sqrtP. */
export function getLiquidityForAmounts(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const [lo, hi] = sortRatios(sqrtA, sqrtB);
  if (sqrtP <= lo) return getLiquidityForAmount0(lo, hi, amount0);
  if (sqrtP < hi) {
    const l0 = getLiquidityForAmount0(sqrtP, hi, amount0);
    const l1 = getLiquidityForAmount1(lo, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(lo, hi, amount1);
}

/** SqrtPriceMath.getAmount0Delta. */
export function getAmount0Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] = sortRatios(sqrtA, sqrtB);
  if (lo === 0n) throw new RangeError("sqrt ratio must be > 0");
  const numerator1 = liquidity << 96n;
  const numerator2 = hi - lo;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, hi), lo)
    : mulDiv(numerator1, numerator2, hi) / lo;
}

/** SqrtPriceMath.getAmount1Delta. */
export function getAmount1Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] = sortRatios(sqrtA, sqrtB);
  return roundUp ? mulDivRoundingUp(liquidity, hi - lo, Q96) : mulDiv(liquidity, hi - lo, Q96);
}

/** Token amounts a position of `liquidity` in [sqrtA, sqrtB] holds at sqrtP (rounded down). */
export function getAmountsForLiquidity(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const [lo, hi] = sortRatios(sqrtA, sqrtB);
  if (sqrtP <= lo) return { amount0: getAmount0Delta(lo, hi, liquidity, false), amount1: 0n };
  if (sqrtP < hi) {
    return {
      amount0: getAmount0Delta(sqrtP, hi, liquidity, false),
      amount1: getAmount1Delta(lo, sqrtP, liquidity, false),
    };
  }
  return { amount0: 0n, amount1: getAmount1Delta(lo, hi, liquidity, false) };
}

// ---------------------------------------------------------------------------------------------
// Money and units

/** USD float → integer cents, exactly once, at the boundary. Non-finite amounts throw. */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd)) throw new RangeError(`usdToCents: non-finite amount ${usd}`);
  return Math.round(usd * 100);
}

export function centsToUsd(cents: number): number {
  return cents / 100;
}

/** usd6 (on-chain) → cents, rounded down: use for CAPS (a cap never grows by rounding). */
export function usd6ToCentsFloor(usd6: bigint): number {
  assertUint("usd6", usd6);
  return Number(usd6 / 10_000n);
}

/** usd6 (on-chain) → cents, rounded up: use for SPEND (a spend never shrinks by rounding). */
export function usd6ToCentsCeil(usd6: bigint): number {
  assertUint("usd6", usd6);
  return Number(divRoundingUp(usd6, 10_000n));
}

export function centsToUsd6(cents: number): bigint {
  if (!Number.isInteger(cents) || cents < 0)
    throw new RangeError(`cents must be a non-negative integer, got ${cents}`);
  return BigInt(cents) * 10_000n;
}

/**
 * The contract's notional formula: usd6 = amount · priceE18 / (10^decimals · 1e12), with priceE18 the
 * USD price of one whole token at 1e18 (IPriceFence.usdPrice).
 */
export function valueUsd6(
  amount: bigint,
  decimals: number,
  priceE18: bigint,
  roundUp: boolean,
): bigint {
  const denominator = 10n ** BigInt(decimals) * 10n ** 12n;
  return roundUp
    ? mulDivRoundingUp(amount, priceE18, denominator)
    : mulDiv(amount, priceE18, denominator);
}

/**
 * Exact decimal string → base units ("0.001", 18 → 10^15). No floats: config values like a gas
 * reserve in ETH are parsed with this.
 */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (m === null) throw new RangeError(`parseUnits: "${value}" is not a non-negative decimal`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals)
    throw new RangeError(`parseUnits: "${value}" has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units → decimal string, trailing zeros trimmed (display only). */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Base units → float (display and strategy only; never for money comparisons). */
export function toFloat(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}

/** Gas cost in USD for display and the cost hurdle. */
export function gasCostUsd(gasUnits: bigint, maxFeePerGas: bigint, ethUsd: number): number {
  return toFloat(gasUnits * maxFeePerGas, 18) * ethUsd;
}
