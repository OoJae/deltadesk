// The relief's data contract: web/public/relief/weekend-2026-09-11.json, written by engine/export_relief.py.
// Pure (no DOM, no three): shared by the WebGL engine, the stage's HUD and scripts/relief-svg.mjs's rules.

export const RELIEF_URL = "/relief/weekend-2026-09-11.json";
export const RELIEF_SVG = "/relief/weekend-2026-09-11.svg";

export type ReliefFrame = {
  ts: number;
  /** "Sat 04:00" (ET). */
  et: string;
  poolTick: number;
  poolMid: number;
  fair: number;
  fairTick: number;
  /** ln(fair / pool) in bp: negative = fair value below the pool price. */
  gapBps: number;
  regime: string;
  gates: string[];
  /** 1 = risk-adding allowed by the lane's gates. */
  risk: 0 | 1;
  /** ChainlinkFence code: 0 OK, 2 FEED_DEAD, 5 MARKET_CLOSED. */
  fence: number;
  clFrozen: 0 | 1;
  laneIn: 0 | 1 | null;
  laneUsd: number;
};

export type ReliefData = {
  label: string;
  title: string;
  pool: string;
  poolAddress: string;
  chainId: number;
  grid: { tick0: number; n: number; halfWindow: number };
  bucketTicks: number;
  lScale: number;
  frames: ReliefFrame[];
  /** [frame][bucket] liquidity quantised 0..9999 of the peak bucket. */
  liq: number[][];
  lane: { lower: number; upper: number; placedTs: number; placedFair: number; fairTick: number; halfWidth: number; usd: number; closedInRangeShare: number; note: string };
  /** [frameIndex, tickBefore, tickAfter, pickedCents]: the strongest informed swaps per frame (closed window). */
  flow: [number, number, number, number][];
  /** [pickedCents, lpFeeCents] pool-wide per frame (closed window). */
  flowFrame: [number, number][];
  /** Running totals (cents) for the $1k always-in-range control lane. */
  control: { pickedCents: number[]; feeCents: number[] };
  summary: { gap: { maxAbsBps: number; maxAbsAt: string; closedMaxAbsBps: number; closedMaxAbsAt: string } };
};

/** World units of the relief (engine.ts): x across the price window, z per frame, y at the height reference. */
export const WORLD = { width: 12, dz: 0.1, height: 2.4 };
/** Blade height, × WORLD.height. */
export const BLADE = 0.75;

export const FENCE: Record<number, string> = { 0: "OK", 2: "FEED_DEAD", 5: "MARKET_CLOSED" };

/** 99th percentile of every bucket, the height reference (sqrt compression, capped at 1.45×): relief-svg.mjs uses the same rule. */
export function heightRef(d: ReliefData): number {
  const all = d.liq.flat().sort((a, b) => a - b);
  return all[Math.floor(all.length * 0.99)] || 1;
}
export const heightOf = (q: number, ref: number) => Math.sqrt(Math.min(q / ref, 1.45));

/** The bucket window drawn: the weekend's whole price path ± 450 ticks (the grid holds ± 600 around every frame). */
export function bucketWindow(d: ReliefData, margin = 450): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of d.frames) {
    lo = Math.min(lo, f.poolTick, f.fairTick);
    hi = Math.max(hi, f.poolTick, f.fairTick);
  }
  const b0 = Math.max(0, Math.floor((lo - margin - d.grid.tick0) / d.bucketTicks));
  const b1 = Math.min(d.grid.n - 1, Math.ceil((hi + margin - d.grid.tick0) / d.bucketTicks));
  return [b0, b1];
}

/** Linear interpolation of a frame field at a fractional frame. */
export function frameAt<K extends "poolTick" | "fairTick" | "gapBps" | "poolMid" | "fair">(d: ReliefData, f: number, key: K): number {
  const n = d.frames.length;
  const x = Math.max(0, Math.min(n - 1, f));
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  const t = x - i;
  return d.frames[i][key] * (1 - t) + d.frames[j][key] * t;
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
