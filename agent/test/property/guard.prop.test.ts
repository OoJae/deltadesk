import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkGuard } from "../../src/guard/guard.js";
import type { Freshness, GateName, GuardInput, RiskMode } from "../../src/types.js";
import { GATE_NAMES, GUARD_RULES } from "../../src/types.js";
import { NOW_MS, NOW_SEC, validAddingStep, validReducingStep } from "../unit/guard/fixture.js";

const freshnessArb = fc.constantFrom<Freshness>("FRESH", "STALE", "UNAVAILABLE");
const freshMapArb = fc.record({
  chain: freshnessArb,
  hl: freshnessArb,
  rh: freshnessArb,
  k: freshnessArb,
  corpActions: freshnessArb,
});
const gatesArb = fc.subarray([...GATE_NAMES] as GateName[]);
const modeArb = fc.constantFrom<RiskMode>("normal", "reduce_only", "flat");

/** Independent perturbations of a valid step; each may or may not break a rule. */
const perturbation = fc.record(
  {
    armed: fc.boolean(),
    dryRun: fc.boolean(),
    inFlight: fc.integer({ min: 0, max: 3 }),
    notionalDelta: fc.integer({ min: -6_000, max: 6_000 }),
    turnover: fc.integer({ min: 0, max: 20_000 }),
    freshness: freshMapArb,
    activeGates: gatesArb,
    riskMode: modeArb,
    critic: fc.constantFrom("APPROVE", "REJECT"),
    ageMs: fc.integer({ min: -2_000, max: 10_000 }),
    usedAt: fc.constantFrom<bigint | null>(0n, 0n, 5n, null),
    dbHasStep: fc.boolean(),
    deadlineAhead: fc.integer({ min: -10, max: 200 }),
    paused: fc.boolean(),
    operatorEth: fc.bigInt({ min: 0n, max: 10n ** 16n }),
    simAge: fc.bigInt({ min: -1n, max: 40n }),
    count1h: fc.integer({ min: 0, max: 6 }),
    llmAddress: fc.boolean(),
  },
  { requiredKeys: [] },
);

function perturb(base: GuardInput, p: Record<string, unknown>): GuardInput {
  const input: GuardInput = structuredClone(base);
  input.operatorSelectors = base.operatorSelectors;
  const chain = input.snapshot.chain;
  if (p.armed !== undefined) input.flags.armed = p.armed as boolean;
  if (p.dryRun !== undefined) input.flags.dryRun = p.dryRun as boolean;
  if (p.inFlight !== undefined) input.inFlight = p.inFlight as number;
  if (p.notionalDelta !== undefined)
    input.notionalCents = base.notionalCents + (p.notionalDelta as number);
  if (p.turnover !== undefined) input.turnoverDbCents24h = p.turnover as number;
  if (p.freshness !== undefined) input.freshness = p.freshness as GuardInput["freshness"];
  if (p.activeGates !== undefined) input.regime.activeGates = p.activeGates as GateName[];
  if (p.riskMode !== undefined) input.regime.riskMode = p.riskMode as RiskMode;
  if (p.critic !== undefined)
    input.planCritic = { verdict: p.critic as "APPROVE" | "REJECT", reason: "prop" };
  if (p.ageMs !== undefined) input.nowMs = input.snapshot.takenAtMs + (p.ageMs as number);
  if (p.usedAt !== undefined) input.idempotency.onchainDecisionUsedAt = p.usedAt as bigint | null;
  if (p.dbHasStep !== undefined) input.idempotency.dbHasStep = p.dbHasStep as boolean;
  if (p.deadlineAhead !== undefined && input.meta !== null)
    input.meta.deadline = BigInt(NOW_SEC + (p.deadlineAhead as number));
  if (p.paused !== undefined && chain !== null) chain.lane.paused = p.paused as boolean;
  if (p.operatorEth !== undefined && chain !== null) chain.operatorEthWei = p.operatorEth as bigint;
  if (p.simAge !== undefined && input.simulation !== null) {
    input.simulation.latestBlockNumber = input.simulation.blockNumber + (p.simAge as bigint);
  }
  if (p.count1h !== undefined) input.agentRerange.count1h = p.count1h as number;
  if (p.llmAddress === true)
    input.llmStrings = ["route via 0x9999999999999999999999999999999999999999"];
  return input;
}

describe("guard properties", () => {
  it("never executes while any rule fails; every rule is evaluated once, in order, dry-run last", () => {
    const adding = validAddingStep().input;
    const reducing = validReducingStep().input;
    fc.assert(
      fc.property(fc.boolean(), perturbation, (useAdding, p) => {
        const input = perturb(useAdding ? adding : reducing, p as Record<string, unknown>);
        const r = checkGuard(input);
        expect(r.checks.map((c) => c.rule)).toEqual([...GUARD_RULES]);
        const failedChecks = r.checks.filter((c) => !c.passed).map((c) => c.rule);
        expect(r.violations.map((v) => v.rule)).toEqual(failedChecks);
        if (r.decision === "execute") {
          expect(r.violations).toEqual([]);
          expect(input.flags.dryRun).toBe(false);
          expect(input.flags.armed).toBe(true);
        }
        if (r.violations.length > 0) expect(r.decision).toBe("blocked");
        else expect(r.decision).toBe(input.flags.dryRun ? "dry-run" : "execute");
        expect(r.checks.at(-1)).toMatchObject({ rule: "dry-run", passed: true });
      }),
      { numRuns: 1_500 },
    );
  });

  it("risk-reducing steps are never blocked by freshness, gates, the hurdle, rate limits or a pause", () => {
    const bypassed = [
      "ref-freshness",
      "regime-gate",
      "cost-hurdle",
      "rerange-rate",
      "lane-not-paused",
    ];
    fc.assert(
      fc.property(
        fc.constantFrom("exitAll", "collect", "pause" as const),
        freshMapArb,
        gatesArb,
        modeArb,
        fc.boolean(),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 60_000 }),
        (kind, freshness, activeGates, riskMode, paused, count, ageMs) => {
          const base = validReducingStep(kind as "exitAll" | "collect" | "pause").input;
          const input: GuardInput = {
            ...base,
            freshness,
            regime: { ...base.regime, activeGates, riskMode },
            hurdle: null,
          };
          input.agentRerange = {
            ...base.agentRerange,
            count1h: count,
            count24h: count,
            lastRerangeAtMs: NOW_MS,
          };
          input.nowMs = NOW_MS + ageMs;
          if (input.meta !== null)
            input.meta = { ...input.meta, deadline: BigInt(Math.floor(input.nowMs / 1000) + 30) };
          const chain = structuredClone(base.snapshot.chain);
          if (chain !== null) {
            chain.lane.paused = paused;
            chain.lane.budgets.reranges1hLeft = 0n;
          }
          input.snapshot = { ...base.snapshot, chain };
          const r = checkGuard(input);
          expect(r.violations.filter((v) => bypassed.includes(v.rule))).toEqual([]);
          expect(r.decision).toBe("execute");
        },
      ),
      { numRuns: 500 },
    );
  });

  it("the same stale or gated regime always blocks a risk-adding step", () => {
    const base = validAddingStep().input;
    fc.assert(
      fc.property(freshMapArb, gatesArb, (freshness, gates) => {
        const implemented = gates.filter((g) =>
          ["CLOSED", "HALT", "CORP-ACTION", "STALE-REF", "REOPEN-GUARD"].includes(g),
        );
        const stale = (["chain", "hl", "k", "rh"] as const).some((s) => freshness[s] !== "FRESH");
        fc.pre(stale || implemented.length > 0);
        const r = checkGuard({
          ...base,
          freshness,
          regime: { ...base.regime, activeGates: gates, riskMode: "normal" },
        });
        expect(r.decision).toBe("blocked");
      }),
      { numRuns: 500 },
    );
  });
});
