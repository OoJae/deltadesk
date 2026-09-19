/**
 * Fair value F = HL · k and the pool gap, gapBps = 1e4 · ln(F / poolMid) (engine/api/live.py).
 *
 * k (poolMid / HL, absorbing Robinhood's uiMultiplier and any venue basis) is a slow parameter:
 *   1. GET {DELTADESK_API}/basis/NVDA (premium header), cached in memory for the TTL, and the last
 *      good value persisted in param_cache;
 *   2. on failure, the last good value from param_cache while it is younger than maxCacheAgeMs;
 *   3. otherwise the agent's own median of poolMid / HL over the last completed regular session,
 *      from the ticks table (needs enough samples).
 * Anything implausible (non-finite, ≤ 0, outside kBounds) is rejected: better no F than a wrong F,
 * because STALE-REF then blocks risk-adding.
 */

import { z } from "zod";
import type { Address, BasisK, Clock, DeskDb, FairValue, SourceStatus } from "../types.js";
import { sqrtPriceX96ToPrice } from "../units.js";
import { lastCompletedRegularSession } from "./calendar.js";

export function gapBps(F: number, poolMid: number): number {
  if (!(F > 0) || !(poolMid > 0) || !Number.isFinite(F) || !Number.isFinite(poolMid)) {
    throw new RangeError(`gapBps needs positive finite prices, got F=${F} poolMid=${poolMid}`);
  }
  return 1e4 * Math.log(F / poolMid);
}

/** Pool mid, quote per base (USDG per NVDA), from slot0.sqrtPriceX96. */
export function poolMidFromSqrt(sqrtPriceX96: bigint): number {
  return sqrtPriceX96ToPrice(sqrtPriceX96);
}

export function fairValue(hl: number, basis: BasisK, poolMid: number): FairValue {
  if (!(hl > 0) || !Number.isFinite(hl))
    throw new RangeError(`HL price must be positive, got ${hl}`);
  if (!(basis.k > 0) || !Number.isFinite(basis.k))
    throw new RangeError(`k must be positive, got ${basis.k}`);
  const F = hl * basis.k;
  return { F, hl, k: basis.k, kSource: basis.source, poolMid, gapBps: gapBps(F, poolMid) };
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError("median of an empty list");
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const BasisResponseSchema = z.looseObject({
  k: z.number().finite().positive(),
  session: z.string().nullish(),
  source: z.string().nullish(),
});

interface CachedBasis {
  k: number;
  session: string | null;
  engineSource: string | null;
}

export interface BasisSourceOptions {
  apiUrl: string;
  apiKey: string | undefined;
  /** Engine pool name, e.g. "NVDA". */
  pool: string;
  laneAddress: Address;
  db: Pick<DeskDb, "getParam" | "setParam" | "sessionTickSamples">;
  clock: Clock;
  fetchImpl?: typeof fetch;
  ttlMs: number;
  /** How old a cached k may be when the engine is unreachable (k spans weekends: default 4 days). */
  maxCacheAgeMs?: number;
  /** Plausible range for k; outside it the value is rejected. */
  kBounds?: readonly [number, number];
  /** Minimum tick samples for the self-computed fallback. */
  minSelfSamples?: number;
  timeoutMs?: number;
}

export interface BasisSource {
  getK(): Promise<BasisK | null>;
  status(nowMs: number): SourceStatus;
}

export function createBasisSource(opts: BasisSourceOptions): BasisSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxCacheAgeMs = opts.maxCacheAgeMs ?? 4 * 24 * 3_600_000;
  const [kMin, kMax] = opts.kBounds ?? [0.5, 2];
  const minSelfSamples = opts.minSelfSamples ?? 30;
  const cacheKey = `basis:${opts.pool}`;
  let memo: BasisK | null = null;
  let lastError: string | null = null;

  const plausible = (k: number): boolean => Number.isFinite(k) && k >= kMin && k <= kMax;

  async function fetchEngine(nowMs: number): Promise<BasisK> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.apiKey !== undefined) headers["x-deltadesk-key"] = opts.apiKey;
    const res = await fetchImpl(`${opts.apiUrl.replace(/\/$/, "")}/basis/${opts.pool}`, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) throw new Error(`engine /basis answered ${res.status}`);
    const body = BasisResponseSchema.parse(await res.json());
    if (!plausible(body.k)) throw new Error(`engine k=${body.k} outside [${kMin}, ${kMax}]`);
    const cached: CachedBasis = {
      k: body.k,
      session: body.session ?? null,
      engineSource: body.source ?? null,
    };
    opts.db.setParam(cacheKey, JSON.stringify(cached), {
      source: "engine",
      fetchedAtMs: nowMs,
      ttlMs: opts.ttlMs,
    });
    return { k: body.k, source: "engine", session: cached.session, fetchedAtMs: nowMs };
  }

  function fromCache(nowMs: number): BasisK | null {
    const row = opts.db.getParam(cacheKey);
    if (row === null || nowMs - row.fetchedAtMs > maxCacheAgeMs) return null;
    try {
      const v = JSON.parse(row.valueJson) as CachedBasis;
      if (!plausible(v.k)) return null;
      return { k: v.k, source: "cache", session: v.session, fetchedAtMs: row.fetchedAtMs };
    } catch {
      return null;
    }
  }

  function selfComputed(nowMs: number): BasisK | null {
    const session = lastCompletedRegularSession(nowMs / 1000);
    const samples = opts.db.sessionTickSamples(opts.laneAddress, session, "REGULAR");
    const ratios = samples
      .filter((s) => s.poolMid > 0 && s.hlMid > 0)
      .map((s) => s.poolMid / s.hlMid);
    if (ratios.length < minSelfSamples) return null;
    const k = median(ratios);
    return plausible(k) ? { k, source: "self", session, fetchedAtMs: nowMs } : null;
  }

  return {
    async getK() {
      const nowMs = opts.clock.now();
      if (memo !== null && memo.source === "engine" && nowMs - memo.fetchedAtMs < opts.ttlMs)
        return memo;
      try {
        memo = await fetchEngine(nowMs);
        lastError = null;
        return memo;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      memo = fromCache(nowMs) ?? selfComputed(nowMs);
      return memo;
    },
    status(nowMs) {
      if (memo === null) return { ok: false, ageMs: null, reason: lastError ?? "no basis k yet" };
      const ageMs = nowMs - memo.fetchedAtMs;
      return {
        ok: true,
        ageMs,
        reason:
          memo.source === "engine" ? null : `k from ${memo.source}: ${lastError ?? ""}`.trim(),
      };
    },
  };
}
