// Display helpers for the desk (addresses, token amounts, ticks <-> prices). Display-only floats; never used to sign.
import { formatUnits } from "viem";
import { LANE_A } from "./chain";

export const short = (a: string | null | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "–");
export const isZeroAddr = (a: string | null | undefined) => !a || /^0x0{40}$/i.test(a);

export function fmtUnits(x: bigint | null | undefined, decimals: number, maxFrac = 4): string {
  if (x == null) return "–";
  const n = Number(formatUnits(x, decimals));
  if (n === 0) return "0";
  if (Math.abs(n) < 10 ** -maxFrac) return `<${(10 ** -maxFrac).toFixed(maxFrac)}`;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export const fmtEth = (wei: bigint | null | undefined) => (wei == null ? "–" : `${fmtUnits(wei, 18, 5)} ETH`);

export function fmtUsd(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "–";
  return x.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/** Pool tick -> USDG per NVDA. Raw price is token1 (NVDA wei) per token0 (USDG micro-units) = 1.0001^tick. */
export const tickToPrice = (tick: number) => 10 ** (LANE_A.dec1 - LANE_A.dec0) / 1.0001 ** tick;

/** Token amounts (raw units, float) held by `liquidity` in [tl, tu) at pool tick tc. Uniswap v3 whitepaper eq. 6.29/6.30. */
export function positionAmounts(liquidity: bigint, tl: number, tu: number, tc: number): { a0: number; a1: number } {
  const L = Number(liquidity);
  const s = (t: number) => Math.sqrt(1.0001 ** t);
  const sl = s(tl), su = s(tu), sc = s(Math.min(Math.max(tc, tl), tu));
  return { a0: L * (1 / sc - 1 / su), a1: L * (sc - sl) };
}

export function ago(sec: number): string {
  const s = Math.max(0, sec);
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** Accepts unix seconds, unix ms or an ISO string; returns unix ms or null. */
export function toMs(t: number | string | null | undefined): number | null {
  if (t == null || t === "") return null;
  if (typeof t === "number") return t > 1e12 ? t : t * 1000;
  const n = Number(t);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : null;
}
