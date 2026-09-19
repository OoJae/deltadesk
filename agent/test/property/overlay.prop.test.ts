import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { overlayApplier, resolveOverlay, tightenCheck } from "../../src/overlay/apply.js";
import type { DeskAction, DeskPlan, OverlayProposal, ReducingAction } from "../../src/types.js";
import { riskClassOf } from "../../src/types.js";
import { validAddingStep } from "../unit/guard/fixture.js";

/**
 * An oracle independent of tightenCheck: is `final` no looser than `det`? (single-rerange plans)
 */
function noLooser(det: DeskPlan, final: DeskPlan): boolean {
  const share = (x: number) => Number.isInteger(x) && x >= 0 && x <= 10_000;
  if (!Number.isInteger(final.notionalCents) || final.notionalCents < 0) return false;
  if (final.notionalCents > det.notionalCents) return false;
  if (final.lane !== det.lane || final.riskMode !== det.riskMode) return false;
  const dr = det.actions.find((a) => a.kind === "rerange") as Extract<
    DeskAction,
    { kind: "rerange" }
  >;
  for (const a of final.actions) {
    if (a.lane !== det.lane) return false;
    if (riskClassOf(a) !== "adding") {
      if (!["reduce", "collect", "exitAll", "pause", "hold"].includes(a.kind)) return false;
      continue;
    }
    if (a.kind !== "rerange") return false;
    if (a.expectedTick !== dr.expectedTick || a.maxTickDelta > dr.maxTickDelta) return false;
    for (const r of a.ranges) {
      if (!share(r.share0Bps) || !share(r.share1Bps)) return false;
      const covered = dr.ranges.some(
        (d) =>
          r.tickLower <= d.tickLower &&
          r.tickUpper >= d.tickUpper &&
          r.share0Bps <= d.share0Bps &&
          r.share1Bps <= d.share1Bps,
      );
      if (!covered) return false;
    }
  }
  return true;
}

const laneArb = fc.constantFrom("A", "A", "A", "B" as const);
const reducingArb: fc.Arbitrary<ReducingAction> = fc.oneof(
  fc.record({ kind: fc.constant("collect" as const), lane: laneArb }),
  fc.record({ kind: fc.constant("exitAll" as const), lane: laneArb }),
  fc.record({ kind: fc.constant("pause" as const), lane: laneArb }),
  fc.record({
    kind: fc.constant("reduce" as const),
    lane: laneArb,
    slot: fc.constantFrom(0 as const, 1 as const),
    liquidity: fc.bigInt({ min: 1n, max: 10n ** 20n }),
  }),
);

/** Proposals the schema accepts. */
const schemaProposal: fc.Arbitrary<OverlayProposal> = fc.record({
  notionalScaleBps: fc.integer({ min: 0, max: 10_000 }),
  widenTicks: fc.integer({ min: 0, max: 2_000 }),
  dropActionIndexes: fc.uniqueArray(fc.integer({ min: 0, max: 15 }), { maxLength: 4 }),
  addReducing: fc.array(reducingArb, { maxLength: 4 }),
  rationale: fc.constant("prop"),
});

/** Anything, including proposals that bypassed the schema. */
const hostileProposal: fc.Arbitrary<OverlayProposal> = fc.record({
  notionalScaleBps: fc.integer({ min: -5_000, max: 30_000 }),
  widenTicks: fc.integer({ min: -500, max: 2_000 }),
  dropActionIndexes: fc.array(fc.integer({ min: -2, max: 4 }), { maxLength: 4 }),
  addReducing: fc.array(reducingArb, { maxLength: 4 }),
  rationale: fc.constant("hostile"),
});

describe("overlay properties", () => {
  const { snapshot, regime, plan } = validAddingStep();
  const ctx = { snapshot, regime, plan };
  const approve = {
    async critique() {
      return { verdict: { verdict: "APPROVE" as const, reason: "ok" }, raw: null };
    },
  };

  it("tighten-only holds for ANY overlay: the stage's final plan is never looser than the deterministic plan", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(schemaProposal, hostileProposal), async (proposal) => {
        const out = await resolveOverlay(
          {
            enabled: true,
            planner: {
              async propose() {
                return { proposal, raw: null };
              },
            },
            critic: approve,
          },
          ctx,
        );
        expect(noLooser(plan, out.finalPlan)).toBe(true);
        if (!out.record.applied) expect(out.finalPlan).toBe(plan);
      }),
      { numRuns: 600 },
    );
  });

  it("apply() of a lane-A, schema-valid proposal that keeps every original reducing action always passes the tighten-check", () => {
    fc.assert(
      fc.property(schemaProposal, (proposal) => {
        const p = { ...proposal, addReducing: proposal.addReducing.filter((a) => a.lane === "A") };
        const out = overlayApplier.apply(plan, p);
        const t = tightenCheck(plan, out);
        expect(t.violations).toEqual([]);
        expect(noLooser(plan, out)).toBe(true);
      }),
      { numRuns: 600 },
    );
  });

  it("tightenCheck rejects any loosening of a rerange", () => {
    const rr = plan.actions[0] as Extract<DeskAction, { kind: "rerange" }>;
    const r0 = rr.ranges[0];
    if (r0 === undefined) throw new Error("range");
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: -100, max: 100 }),
        (dl, du, extra0, extra1, dNotional) => {
          const cand: DeskPlan = {
            ...plan,
            notionalCents: plan.notionalCents + dNotional,
            actions: [
              {
                ...rr,
                ranges: [
                  {
                    ...r0,
                    tickLower: r0.tickLower + dl,
                    tickUpper: r0.tickUpper + du,
                    share0Bps: Math.min(10_000, r0.share0Bps) + extra0 - 100,
                    share1Bps: r0.share1Bps + extra1 - 100,
                  },
                ],
              },
            ],
          };
          expect(tightenCheck(plan, cand).ok).toBe(noLooser(plan, cand));
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
