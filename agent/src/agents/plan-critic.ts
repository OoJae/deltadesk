/**
 * The deterministic plan critic (tick step 6). No LLM: it recomputes, from the snapshot alone,
 * everything the final plan (after the overlay) depends on, and REJECTS on the first class of
 * problem it finds while still listing every finding for the evidence trail.
 *
 * For risk-adding reranges it recomputes F's tick, the risk mode, the band placement (bands.ts, the
 * same code the strategy runs) and checks that the plan's ranges CONTAIN the recomputed ones with no
 * larger shares (an approved overlay may only widen and scale down), then independently re-checks
 * alignment, width, the placement fence across the execution window, the side of F of single-sided
 * ranges, balances, caps and rate limits. Reducing actions are checked against what the lane holds.
 * A throw anywhere is a REJECT.
 *
 * Stage "execution" re-runs the same checks on the snapshot an APPROVED plan will actually sign
 * on (an approval can take minutes): F and the pool may each have drifted by up to maxTickDelta,
 * so expectedTick may sit that far from the pool and containment of the recomputed placement is
 * checked up to that drift (snapped to the spacing); anything beyond it, or a changed shape, is a
 * REJECT. "Centre on F, never the pool" then holds at signing time, not only at planning time.
 */

import {
  fencePrices,
  NVDA_USDG_DECIMALS,
  notionalUsd6,
  postUnwindBalances,
  rerangeUpperAmounts,
  riskModeOf,
  stricterRiskMode,
} from "../guard/risk.js";
import { fenceAllowsAcross, planBands, rangeNeeds, shapeOk } from "../strategy/bands.js";
import { livePositions, planMetrics } from "../strategy/lanes.js";
import {
  type DeskAction,
  type PlanCritic,
  type PlanCriticInput,
  type PlanCriticResult,
  riskClassOf,
} from "../types.js";
import { ceilToSpacing, usd6ToCentsFloor } from "../units.js";

export type { PlanCritic, PlanCriticInput, PlanCriticResult } from "../types.js";

/** Relative tolerance when cross-checking the plan's reported metrics against the recomputation. */
const METRIC_TOLERANCE = 1e-9;

function checkRerange(
  input: PlanCriticInput,
  action: Extract<DeskAction, { kind: "rerange" }>,
  problems: string[],
  findings: string[],
): void {
  const { snapshot, params } = input;
  const chain = snapshot.chain;
  if (chain === null) {
    problems.push("rerange without a chain read");
    return;
  }
  const lane = chain.lane;
  if (action.ranges.length === 0) {
    findings.push("rerange: unwind-and-hold (risk-reducing)");
    return;
  }
  const metrics = planMetrics(snapshot);
  const fv = snapshot.fairValue;
  if (fv === null || metrics.fTick === null) {
    problems.push("adding rerange without a fair value");
    return;
  }
  if (lane.paused) problems.push("lane is paused");
  if (!lane.riskAddingOpen.open)
    problems.push(`lane closed to risk-adding (code ${lane.riskAddingOpen.code})`);
  if (lane.refTick.code !== 0)
    problems.push(`fence reference unusable (code ${lane.refTick.code})`);

  const atExecution = input.stage === "execution";
  const tc = chain.pool.tick;
  const maxDelta = Math.min(params.maxTickDelta, lane.caps.maxTickDelta);
  if (atExecution) {
    if (!(Math.abs(action.expectedTick - tc) <= Math.min(action.maxTickDelta, maxDelta)))
      problems.push(
        `pool tick ${tc} drifted beyond expectedTick ${action.expectedTick} ± ${action.maxTickDelta}`,
      );
  } else if (action.expectedTick !== tc) {
    problems.push(`expectedTick ${action.expectedTick} ≠ pool tick ${tc}`);
  }
  if (
    !(
      Number.isInteger(action.maxTickDelta) &&
      action.maxTickDelta >= 0 &&
      action.maxTickDelta <= maxDelta
    )
  ) {
    problems.push(`maxTickDelta ${action.maxTickDelta} outside [0, ${maxDelta}]`);
  }
  if (action.ranges.length > lane.caps.maxRanges)
    problems.push(`${action.ranges.length} ranges > maxRanges ${lane.caps.maxRanges}`);

  const ref = lane.refTick.tick;
  const band = lane.refTick.bandTicks;
  let share0 = 0;
  let share1 = 0;
  const seen = new Set<string>();
  for (const r of action.ranges) {
    const label = `[${r.tickLower}, ${r.tickUpper})`;
    if (!shapeOk(r, params.tickSpacing, lane.caps.minWidthTicks, lane.caps.maxWidthTicks)) {
      problems.push(`${label} breaks spacing/bounds/width`);
    }
    if (seen.has(label)) problems.push(`${label} duplicated`);
    seen.add(label);
    if (!fenceAllowsAcross(r, tc, action.maxTickDelta, ref, band)) {
      problems.push(
        `${label} outside the placement fence (ref ${ref} ± ${band}) at some tick in ${tc} ± ${action.maxTickDelta}`,
      );
    }
    for (const s of [r.share0Bps, r.share1Bps]) {
      if (!Number.isInteger(s) || s < 0 || s > 10_000)
        problems.push(`${label} share ${s} not in 0..10000`);
    }
    share0 += r.share0Bps;
    share1 += r.share1Bps;
    // Single-sided ranges must sit beyond F, never between the pool and F.
    const needs = rangeNeeds(r, tc);
    if (needs.token1 && !needs.token0 && r.tickUpper > metrics.fTick + params.tickSpacing) {
      problems.push(
        `${label} offers NVDA below fair value (upper ${r.tickUpper} > F tick ${metrics.fTick})`,
      );
    }
    if (needs.token0 && !needs.token1 && r.tickLower < metrics.fTick - params.tickSpacing) {
      problems.push(
        `${label} bids for NVDA above fair value (lower ${r.tickLower} < F tick ${metrics.fTick})`,
      );
    }
  }
  if (share0 > 10_000 || share1 > 10_000) problems.push("shares sum above 10000");
  if (share0 === 0 && share1 === 0) problems.push("rerange deploys nothing (all shares 0)");

  const balances = postUnwindBalances(chain);
  if (share0 > 0 && balances.balance0 === 0n)
    problems.push("token0 share with no token0 inventory");
  if (share1 > 0 && balances.balance1 === 0n)
    problems.push("token1 share with no token1 inventory");

  // Recompute the deterministic placement: the plan must contain it (widen-only, shares ≤).
  const placement = planBands({
    poolTick: tc,
    fTick: metrics.fTick,
    gapBps: fv.gapBps,
    refTick: ref,
    bandTicks: band,
    tickSpacing: params.tickSpacing,
    halfWidthTicks: params.halfWidthTicks,
    straddleMaxGapBps: params.straddleMaxGapBps,
    minWidthTicks: lane.caps.minWidthTicks,
    maxWidthTicks: lane.caps.maxWidthTicks,
    balance0: balances.balance0,
    balance1: balances.balance1,
    executionTickMargin: maxDelta,
  });
  if (!placement.ok) {
    problems.push(`recomputed placement impossible: ${placement.reason}`);
  } else {
    // At execution, tolerate the drift the tick guard tolerates, snapped to the spacing.
    const slack = atExecution ? ceilToSpacing(maxDelta, params.tickSpacing) : 0;
    findings.push(
      `recomputed placement ${placement.shape}${atExecution ? ` (execution, ±${slack} ticks)` : ""}`,
    );
    for (const r of action.ranges) {
      const covers = placement.ranges.some(
        (p) =>
          r.tickLower <= p.tickLower + slack &&
          r.tickUpper >= p.tickUpper - slack &&
          r.share0Bps <= p.share0Bps &&
          r.share1Bps <= p.share1Bps,
      );
      if (!covers)
        problems.push(`[${r.tickLower}, ${r.tickUpper}) does not contain the recomputed placement`);
    }
  }

  // Caps and budgets.
  const prices = fencePrices(chain);
  if (prices === null) {
    problems.push("fence prices unknown: cannot value the rerange");
  } else {
    const usd6 = notionalUsd6(
      rerangeUpperAmounts(action.ranges, balances),
      prices,
      NVDA_USDG_DECIMALS,
    );
    if (usd6 > lane.caps.maxDeployUsd6) {
      problems.push(
        `notional $${usd6ToCentsFloor(usd6) / 100} > maxDeploy $${usd6ToCentsFloor(lane.caps.maxDeployUsd6) / 100}`,
      );
    }
    if (usd6 > lane.budgets.turnoverAvailableUsd6)
      problems.push("notional exceeds the turnover bucket");
    findings.push(`upper-bound notional $${(usd6ToCentsFloor(usd6) / 100).toFixed(2)}`);
  }
  const nowSec = BigInt(Math.floor(input.nowMs / 1000));
  if (lane.budgets.nextRerangeAt > nowSec) problems.push("contract rerange interval not elapsed");
  if (lane.budgets.reranges1hLeft < 1n || lane.budgets.reranges24hLeft < 1n)
    problems.push("contract rerange budget exhausted");

  // The plan's reported metrics must be the snapshot's (plan-time only: at execution they are, by
  // construction, those of the earlier snapshot; the containment above bounds the drift instead).
  if (atExecution) return;
  const m = input.plan.metrics;
  if (
    m.poolTick !== metrics.poolTick ||
    m.fTick !== metrics.fTick ||
    m.refTick !== metrics.refTick
  ) {
    problems.push("plan metrics do not match the snapshot");
  }
  if (m.F === null || Math.abs(m.F - fv.F) > METRIC_TOLERANCE * fv.F)
    problems.push("plan F does not match the snapshot");
}

function checkAction(
  input: PlanCriticInput,
  action: DeskAction,
  problems: string[],
  findings: string[],
): void {
  const { snapshot, plan } = input;
  if (action.lane !== plan.lane)
    problems.push(`${action.kind} targets lane ${action.lane}, plan is lane ${plan.lane}`);
  const chain = snapshot.chain;
  const live = chain === null ? [] : livePositions(chain);
  switch (action.kind) {
    case "hold":
      problems.push("hold is not executable");
      return;
    case "rerange":
      checkRerange(input, action, problems, findings);
      return;
    case "reduce": {
      const p = live.find((x) => x.slot === action.slot);
      if (p === undefined || p.detail === null)
        problems.push(`reduce: slot ${action.slot} holds no known position`);
      else if (!(action.liquidity > 0n && action.liquidity <= p.detail.liquidity)) {
        problems.push(`reduce: liquidity ${action.liquidity} not in (0, ${p.detail.liquidity}]`);
      }
      return;
    }
    case "collect":
    case "exitAll":
      if (chain === null) findings.push(`${action.kind}: no chain read; allowed (risk-reducing)`);
      else if (live.length === 0) problems.push(`${action.kind}: the lane holds no position`);
      return;
    case "pause":
      findings.push("pause: always allowed");
      return;
    case "signal":
      if (action.note.length === 0 || action.note.length > 280)
        problems.push("signal note empty or too long");
      return;
    case "hedge": {
      if (plan.lane !== "B") problems.push("hedge outside lane B");
      const sz = Number(action.sz);
      const px = Number(action.px);
      if (!(Number.isFinite(sz) && sz > 0 && Number.isFinite(px) && px > 0))
        problems.push("hedge size/price invalid");
      return;
    }
    default: {
      const unreachable: never = action;
      problems.push(`unknown action ${JSON.stringify(unreachable)}`);
    }
  }
}

export function critiquePlan(input: PlanCriticInput): PlanCriticResult {
  const problems: string[] = [];
  const findings: string[] = [];
  const { snapshot, regime, plan } = input;

  if (plan.lane !== snapshot.lane)
    problems.push(`plan lane ${plan.lane} ≠ snapshot lane ${snapshot.lane}`);
  if (plan.laneAddress.toLowerCase() !== snapshot.laneAddress.toLowerCase())
    problems.push("plan lane address ≠ snapshot");
  const mode = stricterRiskMode(regime.riskMode, riskModeOf(regime.activeGates));
  if (plan.riskMode !== mode) problems.push(`plan risk mode ${plan.riskMode} ≠ recomputed ${mode}`);

  const executable = plan.actions.filter((a) => a.kind !== "hold");
  if (executable.length === 0) problems.push("plan has no executable action");
  const adding = plan.actions.filter((a) => riskClassOf(a) === "adding");
  if (adding.length > 0 && mode !== "normal")
    problems.push(`risk-adding in ${mode} mode (${regime.activeGates.join(", ")})`);
  // A gate signal moves nothing: it may announce a flat (HALT) state too.
  if (
    mode === "flat" &&
    executable.some((a) => a.kind !== "exitAll" && a.kind !== "pause" && a.kind !== "signal")
  ) {
    problems.push("flat mode allows only exitAll / pause / signal");
  }
  if (adding.length > 0) {
    for (const src of ["chain", "hl", "k"] as const) {
      if (regime.freshness[src] !== "FRESH")
        problems.push(`risk-adding with ${src} ${regime.freshness[src]}`);
    }
  }
  for (const a of plan.actions) checkAction(input, a, problems, findings);
  if (!(Number.isInteger(plan.notionalCents) && plan.notionalCents >= 0))
    problems.push("plan notional is not integer cents");

  findings.unshift(...problems.map((p) => `REJECT: ${p}`));
  if (problems.length > 0) {
    return { verdict: "REJECT", reason: problems[0] as string, findings };
  }
  return {
    verdict: "APPROVE",
    reason: `${executable.map((a) => a.kind).join(", ")} recomputed and consistent`,
    findings,
  };
}

export function createPlanCritic(): PlanCritic {
  return {
    critique(input) {
      try {
        return critiquePlan(input);
      } catch (err) {
        const reason = `plan critic threw: ${err instanceof Error ? err.message : String(err)} (fail-closed)`;
        return { verdict: "REJECT", reason, findings: [`REJECT: ${reason}`] };
      }
    },
  };
}

export const planCritic: PlanCritic = createPlanCritic();
