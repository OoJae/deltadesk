/**
 * Sense: one DeskSnapshot per lane per tick.
 *
 * The chain read (block-pinned), the RH quote, the basis k and (when due, hourly) the corporate
 * actions are fetched concurrently; the HL quote is the feed's latest. Each source reports a
 * SourceStatus; a failed source is null in the snapshot (never a stale value dressed as current)
 * except the hourly corporate-actions state, which keeps its last good value and its fetch time.
 * F = HL · k and the gap come from market/fair-value.ts when HL, k and the pool are all present.
 *
 * takenAtMs is the clock BEFORE the reads start: the snapshot is dated by its oldest possible
 * datum, so the guard's age rule (≤ 3 s) errs on the strict side. Never throws.
 */

import { regimeAt } from "../market/calendar.js";
import { fairValue, poolMidFromSqrt } from "../market/fair-value.js";
import type {
  Address,
  BasisK,
  ChainRead,
  ChainReader,
  Clock,
  CorpActionsState,
  DeskLogger,
  DeskSnapshot,
  EngineSource,
  FairValue,
  HlFeed,
  Lane,
  RhFeed,
  RhQuote,
  Sensor,
  SourceStatus,
} from "../types.js";

export type { DeskSnapshot, Sensor, SourceName, SourceStatus } from "../types.js";

export interface SensorDeps {
  chain: ChainReader;
  hl: HlFeed;
  rh: RhFeed;
  engine: EngineSource;
  clock: Clock;
  chainId: number;
  /** The operator the agent signs as (provenance; eth_call `from`; its ETH balance). */
  signerAddress: Address;
  symbol?: string;
  corpActionsIntervalMs?: number;
  /** Retry delay after a failed corporate-actions fetch (default 5 min). */
  corpActionsRetryMs?: number;
  logger?: DeskLogger;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createSensor(deps: SensorDeps): Sensor {
  const symbol = deps.symbol ?? "NVDA";
  const caEveryMs = deps.corpActionsIntervalMs ?? 3_600_000;
  const caRetryMs = deps.corpActionsRetryMs ?? 300_000;
  const lastChainOk = new Map<Address, number>();
  let lastRhOkMs: number | null = null;
  let corp: CorpActionsState | null = null;
  let corpOk = false;
  let corpError: string | null = null;
  let corpNextAtMs = 0;

  async function settle<T>(
    p: () => Promise<T>,
  ): Promise<{ value: T | null; error: string | null }> {
    try {
      return { value: await p(), error: null };
    } catch (err) {
      return { value: null, error: errText(err) };
    }
  }

  return {
    async read(lane: Lane, laneAddress: Address): Promise<DeskSnapshot> {
      const startMs = deps.clock.now();
      const corpDue = startMs >= corpNextAtMs;
      const [chainR, rhR, kR, caR] = await Promise.all([
        settle<ChainRead>(() => deps.chain.read(laneAddress, deps.signerAddress)),
        settle<RhQuote>(() => deps.rh.quote(symbol)),
        settle<BasisK | null>(() => deps.engine.basis()),
        corpDue
          ? settle<CorpActionsState>(() => deps.rh.corporateActions(symbol))
          : Promise.resolve(null),
      ]);
      const nowMs = deps.clock.now();

      const key = laneAddress.toLowerCase() as Address;
      if (chainR.value !== null) lastChainOk.set(key, nowMs);
      const chainOkAt = lastChainOk.get(key) ?? null;
      const chainStatus: SourceStatus = {
        ok: chainR.value !== null,
        ageMs: chainOkAt === null ? null : nowMs - chainOkAt,
        reason: chainR.error,
      };

      const rh = rhR.value;
      if (rh !== null) lastRhOkMs = rh.receivedAtMs;
      const rhStatus: SourceStatus = {
        ok: rh !== null,
        ageMs: lastRhOkMs === null ? null : nowMs - lastRhOkMs,
        reason: rhR.error,
      };

      if (caR !== null) {
        if (caR.value !== null) {
          corp = caR.value;
          corpOk = true;
          corpError = null;
          corpNextAtMs = startMs + caEveryMs;
        } else {
          corpOk = false;
          corpError = caR.error;
          corpNextAtMs = startMs + caRetryMs;
        }
      }
      const corpStatus: SourceStatus = {
        ok: corpOk,
        ageMs: corp === null ? null : nowMs - corp.fetchedAtMs,
        reason: corpError,
      };

      const hl = deps.hl.latest();
      const k = kR.value;
      const chain = chainR.value;
      let fv: FairValue | null = null;
      if (hl !== null && k !== null && chain !== null) {
        try {
          fv = fairValue(hl.mid, k, poolMidFromSqrt(chain.pool.sqrtPriceX96));
        } catch (err) {
          deps.logger?.warn({ err: errText(err) }, "fair value unavailable");
        }
      }
      const ethRound = chain?.chainlink.eth ?? null;
      const ethUsd =
        ethRound !== null && ethRound.answer > 0n && Number.isFinite(ethRound.price)
          ? ethRound.price
          : null;

      const kStatus = deps.engine.status(nowMs);
      return {
        lane,
        laneAddress,
        chainId: deps.chainId,
        signerAddress: deps.signerAddress,
        takenAtMs: startMs,
        calendar: regimeAt(startMs / 1000),
        chain,
        hl,
        rh,
        k,
        corpActions: corp,
        fairValue: fv,
        ethUsd,
        sources: {
          chain: chainStatus,
          hl: deps.hl.status(nowMs),
          rh: rhStatus,
          k: kR.error === null ? kStatus : { ...kStatus, ok: false, reason: kR.error },
          corpActions: corpStatus,
        },
      };
    },
  };
}
