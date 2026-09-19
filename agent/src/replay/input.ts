/**
 * Replay input: what engine/replay_export.py writes to data/replay/input/<id>.json, one row per
 * minute (warm-up hour included). Every price is as of the row time with no look-ahead: the pool
 * mid is the latest swap's mid_after, HL the latest CLOSED candle (stamped at its end), k the last
 * completed regular session's, Chainlink the latest AnswerUpdated.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

export const REPLAY_LABEL = "REPLAY (historical data, not live)";

const finite = z.number().finite();

export const ReplayInputRowSchema = z.object({
  ts: z.number().int(),
  poolMid: finite.positive().nullable(),
  poolTick: z.number().int().nullable(),
  poolLiquidity: finite.nonnegative().nullable(),
  lastSwapTs: finite.nullable(),
  hl: finite.positive().nullable(),
  hlResS: finite.positive().nullable(),
  hlPointTs: finite.nullable(),
  k: finite.positive().nullable(),
  kSession: z.string().nullable(),
  kLookahead: z.boolean(),
  chainlinkPrice: finite.positive().nullable(),
  chainlinkUpdatedAt: z.number().int().nullable(),
});
export type ReplayInputRow = z.infer<typeof ReplayInputRowSchema>;

export const ReplayInputSchema = z.object({
  label: z.literal(REPLAY_LABEL),
  kind: z.literal("deltadesk-replay-input"),
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  title: z.string(),
  note: z.string(),
  pool: z.string(),
  hlCoin: z.string(),
  window: z.object({
    startTs: z.number().int(),
    endTs: z.number().int(),
    startUtc: z.string(),
    endUtc: z.string(),
  }),
  cadenceS: z.number().int().positive(),
  warmupS: z.number().int().nonnegative(),
  sources: z.array(z.string()),
  coverage: z.record(z.string(), z.unknown()),
  /** The closed-window LVR the export computed (engine output, passed through verbatim). */
  lvr: z.record(z.string(), z.unknown()).nullable(),
  rows: z.array(ReplayInputRowSchema).min(2),
});
export type ReplayInput = z.infer<typeof ReplayInputSchema>;

export function parseReplayInput(json: unknown): ReplayInput {
  const input = ReplayInputSchema.parse(json);
  const { rows, cadenceS } = input;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i] as ReplayInputRow).ts - (rows[i - 1] as ReplayInputRow).ts !== cadenceS) {
      throw new Error(
        `replay input ${input.id}: rows are not on a ${cadenceS} s grid at index ${i}`,
      );
    }
  }
  if (
    input.window.startTs < (rows[0] as ReplayInputRow).ts ||
    input.window.endTs <= input.window.startTs
  ) {
    throw new Error(`replay input ${input.id}: window outside the rows`);
  }
  return input;
}

export function loadReplayInput(path: string): ReplayInput {
  return parseReplayInput(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
