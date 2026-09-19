/**
 * Prompt construction for the overlay planner and the overlay critic (skeleton; the overlay is off
 * in M2 and turns on in M3).
 *
 * Rules for every string here:
 *  1. No secrets and no addresses: prompts are built from snapshot, regime and plan figures only.
 *  2. The model is NOT the calculator. The VERIFIED FIGURES block carries every number the
 *     deterministic strategy computed; the model may only tighten (scale down, widen, drop adding
 *     actions, add reducing actions), and a deterministic tighten-check enforces it regardless.
 */

import type { DeskAction, DeskPlan, OverlayProposal, RegimeState } from "../types.js";

export interface BuiltPrompt {
  system: string;
  user: string;
}

/** The figures the deterministic pipeline computed, rendered for a model. */
export interface VerifiedFigures {
  lane: string;
  regime: string;
  reopenKind: string | null;
  riskMode: string;
  activeGates: string[];
  fairValue: number | null;
  poolMid: number | null;
  gapBps: number | null;
  poolTick: number | null;
  fairValueTick: number | null;
  refTick: number | null;
  bandTicks: number | null;
  planNotionalUsd: number;
}

const fmt = (v: number | null, digits: number): string =>
  v === null ? "unknown" : v.toFixed(digits);

export function renderVerifiedFigures(f: VerifiedFigures): string {
  return [
    "VERIFIED FIGURES (deterministically computed; authoritative, do not re-derive)",
    `lane: ${f.lane}`,
    `regime: ${f.regime}${f.reopenKind === null ? "" : ` (reopen window: ${f.reopenKind})`}`,
    `risk mode: ${f.riskMode}`,
    `active gates: ${f.activeGates.length === 0 ? "none" : f.activeGates.join(", ")}`,
    `fair value F (USDG per NVDA): ${fmt(f.fairValue, 4)}`,
    `pool mid (USDG per NVDA): ${fmt(f.poolMid, 4)}`,
    `gap 1e4·ln(F/pool): ${fmt(f.gapBps, 1)} bp`,
    `pool tick: ${f.poolTick ?? "unknown"} · F tick: ${f.fairValueTick ?? "unknown"}`,
    `fence reference tick: ${f.refTick ?? "unknown"} ± ${f.bandTicks ?? "unknown"} ticks`,
    `planned adding notional: $${f.planNotionalUsd.toFixed(2)}`,
  ].join("\n");
}

export function figuresFrom(plan: DeskPlan, regime: RegimeState): VerifiedFigures {
  return {
    lane: plan.lane,
    regime: regime.calendar.name,
    reopenKind: regime.calendar.reopenKind,
    riskMode: regime.riskMode,
    activeGates: [...regime.activeGates],
    fairValue: plan.metrics.F,
    poolMid: plan.metrics.poolMid,
    gapBps: plan.metrics.gapBps,
    poolTick: plan.metrics.poolTick,
    fairValueTick: plan.metrics.fTick,
    refTick: plan.metrics.refTick,
    bandTicks: plan.metrics.bandTicks,
    planNotionalUsd: plan.notionalCents / 100,
  };
}

/** One line per action; no addresses (the lane is named by its letter). */
export function renderAction(a: DeskAction, index: number): string {
  switch (a.kind) {
    case "rerange":
      return a.ranges.length === 0
        ? `${index}. rerange: unwind all and hold`
        : `${index}. rerange: ${a.ranges
            .map(
              (r) =>
                `[${r.tickLower}, ${r.tickUpper}) share0 ${r.share0Bps} bp share1 ${r.share1Bps} bp`,
            )
            .join("; ")} (expected tick ${a.expectedTick} ± ${a.maxTickDelta})`;
    case "reduce":
      return `${index}. reduce slot ${a.slot} by ${a.liquidity} liquidity`;
    case "hedge":
      return `${index}. hedge (paper): ${a.isBuy ? "buy" : "sell"} ${a.sz} ${a.coin} @ ${a.px} ${a.tif}${a.reduceOnly ? " reduce-only" : ""}`;
    case "signal":
      return `${index}. signal: ${a.note}`;
    case "hold":
      return `${index}. hold: ${a.reason}`;
    default:
      return `${index}. ${a.kind}`;
  }
}

export function renderPlan(plan: DeskPlan): string {
  return [
    "DETERMINISTIC PLAN",
    ...plan.actions.map(renderAction),
    "",
    "rationale:",
    ...plan.rationale.map((r) => `- ${r}`),
  ].join("\n");
}

export const OVERLAY_PLANNER_SYSTEM = `You are the overlay planner for DeltaDesk, a market-making desk that provides Uniswap v3 liquidity for a tokenized stock.

A deterministic strategy has already produced a plan. You may only make it SAFER. Allowed edits:
- scale the adding notional down (notionalScaleBps from 0 to 10000; 10000 = unchanged);
- widen ranges outward (widenTicks >= 0);
- drop adding actions (dropActionIndexes);
- add risk-reducing actions (reduce, collect, exitAll, pause).
You can never add risk, move ranges inward, raise notional, or name any address. A deterministic check
rejects any overlay that loosens the plan, and the plan then runs without you.

Respond with ONLY a JSON object, no prose and no markdown fences:
{"notionalScaleBps": <int>, "widenTicks": <int>, "dropActionIndexes": [<int>...], "addReducing": [...], "rationale": "<one short sentence>"}`;

export function buildOverlayPlannerPrompt(plan: DeskPlan, regime: RegimeState): BuiltPrompt {
  return {
    system: OVERLAY_PLANNER_SYSTEM,
    user: [
      renderVerifiedFigures(figuresFrom(plan, regime)),
      "",
      renderPlan(plan),
      "",
      "Propose the overlay now.",
    ].join("\n"),
  };
}

export const OVERLAY_CRITIC_SYSTEM = `You are the overlay critic for DeltaDesk. A separate planner proposed an overlay on a deterministic liquidity plan, and nothing is applied without your approval.

APPROVE only if the overlay strictly tightens the plan (less or equal notional, wider or equal ranges, only reducing actions added) AND its rationale is consistent with the VERIFIED FIGURES. Otherwise REJECT and name the deciding figure. When in doubt, REJECT: the deterministic plan then runs unchanged.

Never output an address or any 0x-prefixed hex string.

Respond with ONLY a JSON object, no prose and no markdown fences:
{"verdict": "APPROVE"|"REJECT", "reason": "<one short sentence>"}`;

export function buildOverlayCriticPrompt(
  plan: DeskPlan,
  regime: RegimeState,
  proposal: OverlayProposal,
): BuiltPrompt {
  const overlay = [
    "PROPOSED OVERLAY (untrusted)",
    `notionalScaleBps: ${proposal.notionalScaleBps}`,
    `widenTicks: ${proposal.widenTicks}`,
    `dropActionIndexes: ${proposal.dropActionIndexes.join(", ") || "none"}`,
    `addReducing: ${proposal.addReducing.map((a, i) => renderAction(a, i)).join(" | ") || "none"}`,
    `planner rationale: ${proposal.rationale}`,
  ].join("\n");
  return {
    system: OVERLAY_CRITIC_SYSTEM,
    user: [
      renderVerifiedFigures(figuresFrom(plan, regime)),
      "",
      renderPlan(plan),
      "",
      overlay,
      "",
      "Return your verdict.",
    ].join("\n"),
  };
}
