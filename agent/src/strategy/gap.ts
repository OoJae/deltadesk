/**
 * The gap rule, in SHADOW only. It failed out of sample in M1, so it never drives execution: it is
 * computed and recorded so the 1 s tape can recalibrate it (M3). The threshold is the same regime
 * table assess() uses for its (unvalidated) CAUTION.
 */

import { GAP_CAUTION_BPS } from "../market/assess.js";
import type { GapShadowFn, GapShadowInput, GapSignal } from "../types.js";

export type { GapShadowFn, GapShadowInput, GapSignal } from "../types.js";

export const gapShadow = ((input: GapShadowInput): GapSignal => {
  const thresholdBps = GAP_CAUTION_BPS[input.regime];
  if (!Number.isFinite(input.gapBps)) {
    return {
      gapBps: 0,
      thresholdBps,
      wouldAct: false,
      mode: "shadow",
      detail: "no gap (non-finite)",
    };
  }
  const wouldAct = Math.abs(input.gapBps) > thresholdBps;
  return {
    gapBps: input.gapBps,
    thresholdBps,
    wouldAct,
    mode: "shadow",
    detail: `gap ${input.gapBps >= 0 ? "+" : ""}${input.gapBps.toFixed(1)} bp vs ${thresholdBps} bp in ${input.regime}: ${
      wouldAct ? "the gap rule would act" : "the gap rule would hold"
    } (shadow only, unvalidated)`,
  };
}) satisfies GapShadowFn;
