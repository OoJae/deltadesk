/**
 * Slow parameters from the DeltaDesk engine API.
 *
 * - basis k: market/fair-value.ts createBasisSource (GET /basis/{pool} with the premium header, a
 *   TTL, the last good value in param_cache, and the self-computed session median as a fallback).
 * - hour-of-week record: GET /pool-toxicity/{pool} (premium), whose `current_hour` carries the
 *   record for the engine's current hour of week. It is accepted only when its `how` equals the one
 *   asked for (an hour boundary between the two clocks returns the cached value instead), memoised
 *   per hour of week for an hour, and persisted in param_cache so an engine outage falls back to
 *   the last good record (a historical statistic: it ages slowly).
 */

import { z } from "zod";
import {
  type BasisSource,
  type BasisSourceOptions,
  createBasisSource,
} from "../market/fair-value.js";
import type { EngineSource, HourRecord } from "../types.js";

export type { BasisK, EngineSource, HourRecord } from "../types.js";

const HourRecordSchema = z.looseObject({
  how: z.number().int(),
  edge_1h: z.number().nullish(),
  picked_1h_usd: z.number().nullish(),
  fees_usd: z.number().nullish(),
  swaps: z.number().nullish(),
  lp_net_bps_1h: z.number().nullish(),
  reference: z.string().nullish(),
});

const ToxicitySchema = z.looseObject({ current_hour: HourRecordSchema });

export interface EngineSourceOptions extends BasisSourceOptions {
  /** How long an hour-of-week record is reused before refetching (default 1 h). */
  hourTtlMs?: number;
  /** How long the persisted record stays usable when the engine is down (default 14 days). */
  hourCacheTtlMs?: number;
}

export interface EngineSourceHandle extends EngineSource {
  readonly basisSource: BasisSource;
}

function toRecord(r: z.infer<typeof HourRecordSchema>): HourRecord | null {
  if (r.fees_usd === null || r.fees_usd === undefined) return null;
  const out: HourRecord = { fees_usd: r.fees_usd };
  if (r.edge_1h !== undefined) out.edge_1h = r.edge_1h;
  if (r.picked_1h_usd !== undefined) out.picked_1h_usd = r.picked_1h_usd;
  if (r.swaps !== undefined) out.swaps = r.swaps;
  if (r.lp_net_bps_1h !== undefined) out.lp_net_bps_1h = r.lp_net_bps_1h;
  if (r.reference !== undefined && r.reference !== null) out.reference = r.reference;
  return out;
}

export function createEngineSource(opts: EngineSourceOptions): EngineSourceHandle {
  const basisSource = createBasisSource(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hourTtlMs = opts.hourTtlMs ?? 3_600_000;
  const hourCacheTtlMs = opts.hourCacheTtlMs ?? 14 * 24 * 3_600_000;
  const memo = new Map<number, { record: HourRecord | null; atMs: number }>();
  const cacheKey = (how: number) => `how:${opts.pool}:${how}`;

  function fromCache(how: number, nowMs: number): HourRecord | null {
    const row = opts.db.getParam(cacheKey(how));
    if (row === null || nowMs - row.fetchedAtMs > hourCacheTtlMs) return null;
    try {
      return JSON.parse(row.valueJson) as HourRecord;
    } catch {
      return null;
    }
  }

  return {
    basisSource,
    basis: () => basisSource.getK(),
    status: (nowMs) => basisSource.status(nowMs),
    async hourRecord(how: number): Promise<HourRecord | null> {
      const nowMs = opts.clock.now();
      const hit = memo.get(how);
      if (hit !== undefined && nowMs - hit.atMs < hourTtlMs) return hit.record;
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (opts.apiKey !== undefined) headers["x-deltadesk-key"] = opts.apiKey;
        const res = await fetchImpl(
          `${opts.apiUrl.replace(/\/$/, "")}/pool-toxicity/${opts.pool}`,
          {
            headers,
            signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
          },
        );
        if (!res.ok) throw new Error(`engine /pool-toxicity answered ${res.status}`);
        const body = ToxicitySchema.parse(await res.json());
        if (body.current_hour.how !== how) return fromCache(how, nowMs);
        const record = toRecord(body.current_hour);
        memo.set(how, { record, atMs: nowMs });
        if (record !== null) {
          opts.db.setParam(cacheKey(how), JSON.stringify(record), {
            source: "engine",
            fetchedAtMs: nowMs,
            ttlMs: hourCacheTtlMs,
          });
        }
        return record;
      } catch {
        return fromCache(how, nowMs);
      }
    },
  };
}
