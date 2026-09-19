/**
 * The overlay: the LLM's only way to touch a plan, and only to TIGHTEN it. Identity by default (M2).
 *
 * apply() performs the proposal literally; tightenCheck() then decides, independently, whether the
 * result is tighter than the deterministic plan. It is ALWAYS enforced: resolveOverlay() drops any
 * overlay that fails it and runs the deterministic plan unchanged.
 *
 * Tighter means, versus the deterministic plan:
 *  - adding actions are a subsequence of its adding actions (none added, some may be dropped);
 *  - each kept rerange has at most as many ranges, each range CONTAINS its original (wider or equal,
 *    so less dense) and has shares ≤ the original; expectedTick equal, maxTickDelta ≤ the original;
 *  - each kept hedge is the same order with a size ≤ the original;
 *  - total adding notional ≤ the original;
 *  - every reducing action of the original is still there; new actions may only be reducing;
 *  - lane, lane address and risk mode are unchanged.
 */

import { ulid } from "ulid";
import { canonicalJson } from "../canonical.js";
import type {
  CriticVerdict,
  DeskAction,
  DeskPlan,
  OverlayApplier,
  OverlayContext,
  OverlayCritic,
  OverlayPlanner,
  OverlayProposal,
  OverlayRecord,
  RangeSpec,
  ReducingAction,
  TightenCheckResult,
} from "../types.js";
import { LlmCreditsExhausted, riskClassOf } from "../types.js";
import { ceilToSpacing, floorToSpacing } from "../units.js";

export type {
  OverlayApplier,
  OverlayProposal,
  OverlayRecord,
  TightenCheckResult,
} from "../types.js";

export const IDENTITY_PROPOSAL: OverlayProposal = {
  notionalScaleBps: 10_000,
  widenTicks: 0,
  dropActionIndexes: [],
  addReducing: [],
  rationale: "identity overlay",
};

export interface OverlayApplierOptions {
  tickSpacing?: number;
}

const isReducingKind = (a: DeskAction): a is ReducingAction =>
  a.kind === "reduce" || a.kind === "collect" || a.kind === "exitAll" || a.kind === "pause";

/** Clamp a proposal's numeric edits to the tighten-only domain (the schema should already have). */
function clampScale(scaleBps: number): number {
  return Number.isFinite(scaleBps) ? Math.min(10_000, Math.max(0, Math.floor(scaleBps))) : 0;
}

function scaleShare(bps: number, scaleBps: number): number {
  return Math.floor((bps * clampScale(scaleBps)) / 10_000);
}

const validShare = (s: number): boolean => Number.isInteger(s) && s >= 0 && s <= 10_000;

function widenRange(
  r: RangeSpec,
  widen: number,
  poolTick: number | null,
  spacing: number,
): RangeSpec {
  if (widen <= 0) return { ...r };
  // Keep single-sided ranges single-sided: widen only the edge away from the pool.
  const below = poolTick !== null && r.tickUpper <= poolTick;
  const above = poolTick !== null && r.tickLower >= poolTick;
  return {
    ...r,
    tickLower: above ? r.tickLower : floorToSpacing(r.tickLower - widen, spacing),
    tickUpper: below ? r.tickUpper : ceilToSpacing(r.tickUpper + widen, spacing),
  };
}

function sameAction(a: DeskAction, b: DeskAction): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function rerangeTighter(
  det: Extract<DeskAction, { kind: "rerange" }>,
  fin: Extract<DeskAction, { kind: "rerange" }>,
): string | null {
  if (fin.lane !== det.lane) return "rerange lane changed";
  if (fin.expectedTick !== det.expectedTick) return "rerange expectedTick changed";
  if (!(fin.maxTickDelta <= det.maxTickDelta)) return "rerange maxTickDelta loosened";
  if (fin.ranges.length > det.ranges.length) return "rerange gained ranges";
  const used = new Set<number>();
  for (const r of fin.ranges) {
    if (!validShare(r.share0Bps) || !validShare(r.share1Bps)) {
      return `range [${r.tickLower}, ${r.tickUpper}) has shares outside 0..10000`;
    }
    if (!Number.isInteger(r.tickLower) || !Number.isInteger(r.tickUpper))
      return "non-integer ticks";
    const i = det.ranges.findIndex(
      (d, k) =>
        !used.has(k) &&
        r.tickLower <= d.tickLower &&
        r.tickUpper >= d.tickUpper &&
        r.share0Bps <= d.share0Bps &&
        r.share1Bps <= d.share1Bps,
    );
    if (i < 0) {
      return `range [${r.tickLower}, ${r.tickUpper}) is not a widening of an original range with shares ≤ the original`;
    }
    used.add(i);
  }
  return null;
}

function hedgeTighter(
  det: Extract<DeskAction, { kind: "hedge" }>,
  fin: Extract<DeskAction, { kind: "hedge" }>,
): string | null {
  const { sz: dSz, ...dRest } = det;
  const { sz: fSz, ...fRest } = fin;
  if (canonicalJson(dRest) !== canonicalJson(fRest)) return "hedge order changed beyond its size";
  const d = Number(dSz);
  const f = Number(fSz);
  if (!(Number.isFinite(d) && Number.isFinite(f) && f > 0 && f <= d)) return "hedge size grew";
  return null;
}

export function tightenCheck(deterministic: DeskPlan, final: DeskPlan): TightenCheckResult {
  const violations: string[] = [];
  if (final.lane !== deterministic.lane) violations.push("lane changed");
  if (final.laneAddress.toLowerCase() !== deterministic.laneAddress.toLowerCase()) {
    violations.push("lane address changed");
  }
  if (final.riskMode !== deterministic.riskMode) violations.push("risk mode changed");
  if (
    !(
      Number.isInteger(final.notionalCents) &&
      final.notionalCents >= 0 &&
      final.notionalCents <= deterministic.notionalCents
    )
  ) {
    violations.push(
      `notional ${final.notionalCents} > deterministic ${deterministic.notionalCents} cents`,
    );
  }

  const detAdding = deterministic.actions.filter((a) => riskClassOf(a) === "adding");
  const finAdding = final.actions.filter((a) => riskClassOf(a) === "adding");
  let cursor = 0;
  for (const fa of finAdding) {
    let matched = false;
    while (cursor < detAdding.length) {
      const da = detAdding[cursor++] as DeskAction;
      if (da.kind === "rerange" && fa.kind === "rerange") {
        const why = rerangeTighter(da, fa);
        if (why === null) {
          matched = true;
          break;
        }
      } else if (da.kind === "hedge" && fa.kind === "hedge") {
        if (hedgeTighter(da, fa) === null) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) violations.push(`adding action ${fa.kind} is not a tightened original`);
  }

  // Non-adding actions: originals must survive; additions must be risk-reducing.
  const remaining = final.actions.filter((a) => riskClassOf(a) !== "adding");
  for (const da of deterministic.actions) {
    if (riskClassOf(da) === "adding" || da.kind === "hold") continue;
    const i = remaining.findIndex((fa) => sameAction(fa, da));
    if (i < 0) violations.push(`${da.kind} from the deterministic plan was removed`);
    else remaining.splice(i, 1);
  }
  for (const fa of remaining) {
    if (fa.kind === "hold") continue;
    if (!isReducingKind(fa)) violations.push(`added ${fa.kind} is not a risk-reducing action`);
    else if (fa.lane !== deterministic.lane)
      violations.push(`added ${fa.kind} targets lane ${fa.lane}`);
  }
  return { ok: violations.length === 0, violations };
}

export function createOverlayApplier(opts: OverlayApplierOptions = {}): OverlayApplier {
  const spacing = opts.tickSpacing ?? 10;
  return {
    apply(plan, proposal) {
      const drop = new Set(proposal.dropActionIndexes);
      const exiting = proposal.addReducing.some((a) => a.kind === "exitAll" || a.kind === "pause");
      const kept: DeskAction[] = [];
      plan.actions.forEach((a, i) => {
        if (a.kind === "hold") return;
        if (drop.has(i)) return;
        // Pausing or exiting makes every adding action moot.
        if (exiting && riskClassOf(a) === "adding") return;
        if (a.kind === "rerange" && a.ranges.length > 0) {
          kept.push({
            ...a,
            ranges: a.ranges.map((r) => {
              const widen = Number.isFinite(proposal.widenTicks)
                ? Math.max(0, Math.floor(proposal.widenTicks))
                : 0;
              const w = widenRange(r, widen, plan.metrics.poolTick, spacing);
              return {
                ...w,
                share0Bps: scaleShare(w.share0Bps, proposal.notionalScaleBps),
                share1Bps: scaleShare(w.share1Bps, proposal.notionalScaleBps),
              };
            }),
          });
          return;
        }
        kept.push(a);
      });
      const actions: DeskAction[] = [...proposal.addReducing.map((a) => ({ ...a })), ...kept];
      const addingLeft = actions.some((a) => riskClassOf(a) === "adding");
      const notionalCents = addingLeft
        ? Math.floor((plan.notionalCents * clampScale(proposal.notionalScaleBps)) / 10_000)
        : 0;
      return {
        ...plan,
        actions:
          actions.length > 0
            ? actions
            : [{ kind: "hold", lane: plan.lane, reason: "overlay dropped every action" }],
        rationale: [...plan.rationale, `overlay: ${proposal.rationale}`],
        notionalCents,
      };
    },
    tightenCheck,
  };
}

export const overlayApplier: OverlayApplier = createOverlayApplier();

// ---------------------------------------------------------------------------------------------
// The overlay stage (tick step 5)

export interface OverlayStageDeps {
  /** false in M2: the identity overlay, no LLM call. */
  enabled: boolean;
  planner: OverlayPlanner | null;
  critic: OverlayCritic | null;
  applier?: OverlayApplier;
  newId?: () => string;
}

export interface OverlayOutcome {
  record: OverlayRecord;
  finalPlan: DeskPlan;
  /** The LLM answered 402: the daemon switches the lane to deterministic mode. */
  creditsExhausted: boolean;
  /** Every LLM-produced string that reached the final plan (the guard scans them for addresses). */
  llmStrings: string[];
}

export function identityOverlay(
  plan: DeskPlan,
  id: string,
  error: string | null = null,
  raw: string | null = null,
): OverlayOutcome {
  return {
    record: {
      overlayId: id,
      source: "identity",
      proposal: null,
      critic: null,
      tighten: { ok: true, violations: [] },
      applied: false,
      raw,
      error,
    },
    finalPlan: plan,
    creditsExhausted: false,
    llmStrings: [],
  };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run the overlay for one plan. Never throws. Failure modes all end in the deterministic plan:
 * planner error → identity; critic error or REJECT → not applied; tighten-check failure → dropped.
 */
export async function resolveOverlay(
  deps: OverlayStageDeps,
  ctx: OverlayContext,
): Promise<OverlayOutcome> {
  const newId = deps.newId ?? (() => ulid());
  const applier = deps.applier ?? overlayApplier;
  const plan = ctx.plan;
  const id = newId();
  if (!deps.enabled || deps.planner === null || deps.critic === null)
    return identityOverlay(plan, id);
  if (!plan.actions.some((a) => riskClassOf(a) === "adding")) return identityOverlay(plan, id);

  let proposal: OverlayProposal;
  let raw: string | null;
  try {
    ({ proposal, raw } = await deps.planner.propose(ctx));
  } catch (err) {
    const out = identityOverlay(plan, id, `planner: ${errorText(err)}`);
    return { ...out, creditsExhausted: err instanceof LlmCreditsExhausted };
  }

  let critic: CriticVerdict;
  let creditsExhausted = false;
  try {
    critic = (await deps.critic.critique(ctx, proposal)).verdict;
  } catch (err) {
    creditsExhausted = err instanceof LlmCreditsExhausted;
    critic = { verdict: "REJECT", reason: `critic failed: ${errorText(err)} (fail-closed)` };
  }

  const base: Omit<OverlayRecord, "tighten" | "applied" | "error"> = {
    overlayId: id,
    source: "llm",
    proposal,
    critic,
    raw,
  };
  if (critic.verdict !== "APPROVE") {
    return {
      record: { ...base, tighten: { ok: true, violations: [] }, applied: false, error: null },
      finalPlan: plan,
      creditsExhausted,
      llmStrings: [],
    };
  }

  let candidate: DeskPlan;
  try {
    candidate = applier.apply(plan, proposal);
  } catch (err) {
    return {
      record: {
        ...base,
        tighten: { ok: false, violations: [`apply failed: ${errorText(err)}`] },
        applied: false,
        error: errorText(err),
      },
      finalPlan: plan,
      creditsExhausted,
      llmStrings: [],
    };
  }
  // Always enforced, whatever the critic said.
  const tighten = tightenCheck(plan, candidate);
  if (!tighten.ok) {
    return {
      record: { ...base, tighten, applied: false, error: null },
      finalPlan: plan,
      creditsExhausted,
      llmStrings: [],
    };
  }
  return {
    record: { ...base, tighten, applied: true, error: null },
    finalPlan: candidate,
    creditsExhausted,
    llmStrings: [proposal.rationale, critic.reason],
  };
}
