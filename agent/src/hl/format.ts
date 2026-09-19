/**
 * Hyperliquid tick and lot formatting, plus exact decimal-string arithmetic for paper fills.
 *
 * Prices: at most 5 significant figures and at most (6 − szDecimals) decimals for perps (HIP-3
 * `xyz:` perps follow the perp rule); integer prices are always allowed. Sizes: truncated to
 * szDecimals. The SDK's formatPrice / formatSize (@nktkas/hyperliquid/utils, round-down) are the
 * reference; `formatPassivePx` rounds AWAY from the touch so a post-only (ALO) order never crosses
 * because of rounding: buys down, sells up.
 */

import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import type { HlAssetMeta, HlFormatter } from "../types.js";

export type { HlAssetMeta, HlFormatter } from "../types.js";

export const hlFormatter: HlFormatter = {
  formatPx: (px, meta) => formatPrice(px, meta.szDecimals, "perp"),
  formatSz: (sz, meta) => formatSize(sz, meta.szDecimals),
};

// ---------------------------------------------------------------------------------------------
// Exact decimals (scale 1e18) for paper fills: sizes and prices are strings end to end.

const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

export function decToScaled(s: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (m === null) throw new RangeError(`not a decimal: "${s}"`);
  const frac = (m[3] ?? "").slice(0, SCALE).padEnd(SCALE, "0");
  const v = BigInt(m[2] ?? "0") * ONE + BigInt(frac || "0");
  return m[1] === "-" ? -v : v;
}

export function scaledToDec(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / ONE;
  const frac = (a % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function decMin(a: string, b: string): string {
  return decToScaled(a) <= decToScaled(b) ? a : b;
}

export function decAdd(a: string, b: string): string {
  return scaledToDec(decToScaled(a) + decToScaled(b));
}

export function decSub(a: string, b: string): string {
  return scaledToDec(decToScaled(a) - decToScaled(b));
}

export function decCmp(a: string, b: string): -1 | 0 | 1 {
  const x = decToScaled(a);
  const y = decToScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Size-weighted average price after adding (px, sz) to (avgPx, filledSz); rounded down at 1e-18. */
export function decVwap(avgPx: string | null, filledSz: string, px: string, sz: string): string {
  const f = decToScaled(filledSz);
  const s = decToScaled(sz);
  if (f + s === 0n) return px;
  const prev = avgPx === null ? 0n : decToScaled(avgPx) * f;
  return scaledToDec((prev + decToScaled(px) * s) / (f + s));
}

/**
 * A post-only price: the SDK rule, then nudged one price increment away from the touch if the
 * SDK's round-down moved a SELL toward the market.
 */
export function formatPassivePx(px: number, meta: HlAssetMeta, isBuy: boolean): string {
  const down = formatPrice(px, meta.szDecimals, "perp");
  if (isBuy || decToScaled(down) >= decToScaled(px.toString())) return down;
  // The smallest step at this magnitude under both rules (5 sig figs, 6 − szDecimals decimals).
  const maxDecimals = Math.max(6 - meta.szDecimals, 0);
  const intDigits = Math.max(Math.floor(Math.log10(Math.abs(px))) + 1, 1);
  const sigDecimals = Math.max(5 - intDigits, 0);
  const decimals = Math.min(maxDecimals, sigDecimals);
  const step = decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
  return formatPrice(decAdd(down, step), meta.szDecimals, "perp");
}
