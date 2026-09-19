/**
 * Robinhood reference feed: GET {RH_API_URL}/prices/{symbol} every tick (bid, ask, isTradingHalt)
 * and GET {RH_API_URL}/corporate-actions hourly (the sensor paces it).
 *
 * Corporate actions: an action for the symbol is PENDING unless its status is completed or
 * cancelled (an unknown status counts as pending: fail-closed). Its effective time is 00:00 ET of
 * its processDate (the conservative start of that day); CORP-ACTION (regime/gates.ts) turns on
 * within 24 h of the earliest pending one and stays on until RH marks it completed. A pending action
 * without a date makes nextEffectiveAtMs null, which the gate treats as "now".
 * Responses are validated; a malformed answer throws (the sensor turns it into an unhealthy source).
 */

import { z } from "zod";
import { etToEpochSec } from "../market/calendar.js";
import type { Clock, CorpActionsState, CorporateAction, RhFeed, RhQuote } from "../types.js";

export type { CorpActionsState, CorporateAction, RhFeed, RhQuote } from "../types.js";

const decimal = z.string().regex(/^\d+(\.\d+)?$/);

const PricesSchema = z.looseObject({
  quotes: z
    .array(
      z.looseObject({
        tokenSymbol: z.string().optional(),
        bid: decimal,
        ask: decimal,
        isTradingHalt: z.boolean(),
        generatedAt: z.string().optional(),
      }),
    )
    .min(1),
});

const CorpActionsSchema = z.looseObject({
  corpActions: z.array(
    z.looseObject({
      id: z.string().optional(),
      type: z.string(),
      status: z.string(),
      tokenSymbol: z.string(),
      processDate: z
        .looseObject({ year: z.number().int(), month: z.number().int(), day: z.number().int() })
        .nullish(),
    }),
  ),
});

const DONE_STATUSES: ReadonlySet<string> = new Set([
  "CORPORATE_ACTION_STATUS_COMPLETED",
  "CORPORATE_ACTION_STATUS_CANCELLED",
  "CORPORATE_ACTION_STATUS_CANCELED",
]);

export interface RhFeedOptions {
  apiUrl: string;
  clock: Clock;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createRhFeed(opts: RhFeedOptions): RhFeed {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/$/, "");

  async function getJson(path: string): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) throw new Error(`RH ${path} answered ${res.status}`);
    return res.json();
  }

  return {
    async quote(symbol: string): Promise<RhQuote> {
      const body = PricesSchema.parse(await getJson(`/prices/${encodeURIComponent(symbol)}`));
      const q = body.quotes.find((x) => x.tokenSymbol === undefined || x.tokenSymbol === symbol);
      if (q === undefined) throw new Error(`RH /prices has no ${symbol} quote`);
      const bid = Number(q.bid);
      const ask = Number(q.ask);
      // A halted book may be empty; otherwise a zero or crossed quote is unusable.
      if (!q.isTradingHalt && (!(bid > 0) || ask < bid))
        throw new Error(`RH ${symbol} quote unusable: ${bid}/${ask}`);
      const generated = q.generatedAt === undefined ? Number.NaN : Date.parse(q.generatedAt);
      return {
        symbol,
        bid,
        ask,
        mid: (bid + ask) / 2,
        isTradingHalt: q.isTradingHalt,
        generatedAtMs: Number.isFinite(generated) ? generated : null,
        receivedAtMs: opts.clock.now(),
      };
    },

    async corporateActions(symbol: string): Promise<CorpActionsState> {
      const body = CorpActionsSchema.parse(await getJson("/corporate-actions"));
      const items: CorporateAction[] = body.corpActions
        .filter((c) => c.tokenSymbol === symbol)
        .map((c) => ({
          symbol,
          kind: c.type,
          status: c.status,
          effectiveAtMs:
            c.processDate === null || c.processDate === undefined
              ? null
              : etToEpochSec(c.processDate.year, c.processDate.month, c.processDate.day, 0, 0) *
                1000,
          raw: c,
        }));
      const pending = items.filter((c) => !DONE_STATUSES.has(c.status));
      const dates = pending.map((c) => c.effectiveAtMs);
      return {
        pendingForSymbol: pending.length > 0,
        nextEffectiveAtMs:
          pending.length === 0 || dates.some((d) => d === null)
            ? null
            : Math.min(...(dates as number[])),
        items,
        fetchedAtMs: opts.clock.now(),
      };
    },
  };
}
