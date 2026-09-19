/**
 * WIRING-LEVEL SAFETY PROOFS (1/2): the decision path.
 *
 * Unit tests prove the guard, critic and overlay say "no". These prove the assembled daemon OBEYS
 * them: each drives real ticks of createDaemon (real strategy, regime, critic, overlay, guard and
 * write-ahead executor with a real signature) and asserts the signer spy and the node never saw a
 * transaction. Every proof also runs its positive path, so a block can never be a dead pipeline.
 *
 * Numbering follows docs/m2-design-agent.md "Wiring safety proofs".
 */

import { describe, expect, it } from "vitest";
import { LlmCreditsExhausted, type OverlayProposal, type ReducingAction } from "../../src/types.js";
import {
  approveAll,
  createLlmStub,
  decodeSigned,
  denyAll,
  EVIL,
  harness,
  inRangePosition,
  LANE_A,
} from "../helpers/wiring.js";

const decisionOf = (h: ReturnType<typeof harness>) => h.db.recentDecisions(1)[0];

describe("SAFETY PROOF 1: DESK_ARM=0 → no sign", () => {
  it("an unarmed live desk records the block and never reaches the signer", async () => {
    const h = harness({ armed: false, dryRun: false });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("blocked");
    expect(h.signer.requests).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
    const d = decisionOf(h);
    expect(d?.guardDecision).toBe("blocked");
    expect(d?.guardViolationsJson).toContain("arm-flag");
    expect(h.notes.some((n) => n.title.startsWith("Blocked"))).toBe(true);
  });

  it("a HALT exit does not become an escape hatch around the arm flag", async () => {
    const h = harness({
      armed: false,
      dryRun: false,
      world: { position: inRangePosition(), halt: true },
    });
    const out = await h.tickUntilDecision();
    expect(JSON.parse(decisionOf(h)?.finalPlanJson ?? "{}").actions[0].kind).toBe("exitAll");
    expect(out.status).toBe("blocked");
    expect(decisionOf(h)?.guardViolationsJson).toContain("arm-flag");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("positive path: the same desk armed signs and lands exactly one rerange", async () => {
    const h = harness({ armed: true, dryRun: false });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("executed");
    expect(h.signer.requests).toHaveLength(1);
    expect(h.chain.sent).toHaveLength(1);
    expect(decodeSigned(h.chain.sent[0] as `0x${string}`).functionName).toBe("rerange");
  });
});

describe("SAFETY PROOF 2: DRY_RUN holds fire", () => {
  it("records a dry_run decision with a clean guard trail and signs nothing", async () => {
    const h = harness({ armed: true, dryRun: true });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("dry_run");
    const d = decisionOf(h);
    expect(d?.guardDecision).toBe("dry-run");
    expect(d?.guardViolationsJson).toBe("[]"); // held by DRY_RUN, not by a failure
    expect(d?.reasonHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.signer.requests).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.notes.find((n) => n.kind === "decision")?.dryRun).toBe(true);
  });

  it("holds a risk-reducing exit too, and does not re-propose every tick", async () => {
    const h = harness({ dryRun: true, world: { position: inRangePosition(), halt: true } });
    expect((await h.tickUntilDecision()).status).toBe("dry_run");
    const next = await h.tick();
    expect(next.kind).toBe("hold");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("positive path: DRY_RUN=false executes", async () => {
    const h = harness({ dryRun: false });
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(h.chain.sent).toHaveLength(1);
  });
});

describe("SAFETY PROOF 3: the plan critic's approval is mandatory", () => {
  it("a REJECT stops execution although strategy, caps and the human all say yes", async () => {
    const h = harness({
      deps: {
        planCritic: {
          critique: () => ({ verdict: "REJECT", reason: "placement drifted", findings: [] }),
        },
      },
    });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("critic_rejected");
    expect(decisionOf(h)?.planCriticVerdict).toBe("REJECT");
    expect(decisionOf(h)?.guardViolationsJson).toContain("critic-approval");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("a throwing critic is a REJECT, never a crash past the gate", async () => {
    const h = harness({
      deps: {
        planCritic: {
          critique: () => {
            throw new Error("critic exploded");
          },
        },
      },
    });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("critic_rejected");
    expect(decisionOf(h)?.planCriticReason).toContain("critic exploded");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("positive path: the deterministic critic approves and the step executes", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(decisionOf(h)?.planCriticVerdict).toBe("APPROVE");
  });
});

describe("SAFETY PROOF 4: a loosening overlay is dropped", () => {
  const overlayOn = (cfg: ReturnType<typeof harness>["cfg"]) => ({
    ...cfg,
    llm: { ...cfg.llm, overlayEnabled: true },
    capabilities: { ...cfg.capabilities, llm: true },
  });

  it("an approved overlay that smuggles a second rerange is dropped; the deterministic plan runs", async () => {
    const smuggled = {
      kind: "rerange",
      lane: "A",
      ranges: [{ tickLower: 222000, tickUpper: 222600, share0Bps: 10_000, share1Bps: 10_000 }],
      expectedTick: 222275,
      maxTickDelta: 10,
    } as unknown as ReducingAction;
    const proposal: OverlayProposal = {
      notionalScaleBps: 10_000,
      widenTicks: 0,
      dropActionIndexes: [],
      addReducing: [smuggled],
      rationale: "deploy everything, twice",
    };
    const stub = createLlmStub({ proposal });
    const h = harness({ config: overlayOn, deps: { overlay: stub.overlay } });
    const out = await h.tickUntilDecision();
    expect(stub.plannerCalls()).toBe(1);
    expect(out.status).toBe("executed");
    const d = decisionOf(h);
    const ov = h.db.getOverlay(d?.overlayId ?? "");
    expect(ov?.source).toBe("llm");
    expect(ov?.criticVerdict).toBe("APPROVE");
    expect(ov?.tightenOk).toBe(false);
    expect(ov?.applied).toBe(false);
    // What was signed is exactly the deterministic plan.
    expect(d?.finalPlanJson).toBe(d?.planJson);
    const signed = decodeSigned(h.chain.sent[0] as `0x${string}`);
    const planned = JSON.parse(d?.planJson ?? "{}").actions[0];
    expect((signed.args[1] as unknown[]).length).toBe(planned.ranges.length);
    expect(Number((signed.args[1] as Array<{ share0Bps: number }>)[0]?.share0Bps)).toBe(
      planned.ranges[0].share0Bps,
    );
  });

  it("positive path: a tightening overlay (half the notional) is applied and signed", async () => {
    const proposal: OverlayProposal = {
      notionalScaleBps: 5_000,
      widenTicks: 0,
      dropActionIndexes: [],
      addReducing: [],
      rationale: "halve it",
    };
    const stub = createLlmStub({ proposal });
    const h = harness({ config: overlayOn, deps: { overlay: stub.overlay } });
    expect((await h.tickUntilDecision()).status).toBe("executed");
    const d = decisionOf(h);
    expect(h.db.getOverlay(d?.overlayId ?? "")?.applied).toBe(true);
    const det = JSON.parse(d?.planJson ?? "{}").actions[0].ranges[0];
    const signed = (
      decodeSigned(h.chain.sent[0] as `0x${string}`).args[1] as Array<{
        share0Bps: number;
        share1Bps: number;
      }>
    )[0];
    expect(signed?.share0Bps).toBe(Math.floor(det.share0Bps / 2));
    expect(signed?.share1Bps).toBe(Math.floor(det.share1Bps / 2));
  });
});

describe("SAFETY PROOF 5: an LLM 402 drops the lane to deterministic mode", () => {
  it("the deterministic plan still executes, and the gateway is not called again", async () => {
    const stub = createLlmStub({ plannerError: new LlmCreditsExhausted() });
    const h = harness({
      config: (cfg) => ({
        ...cfg,
        llm: { ...cfg.llm, overlayEnabled: true },
        capabilities: { ...cfg.capabilities, llm: true },
      }),
      deps: { overlay: stub.overlay },
    });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("executed"); // the positive path IS the proof: 402 never blocks the desk
    expect(stub.plannerCalls()).toBe(1);
    expect(h.daemon.laneState(LANE_A)?.brain).toBe("deterministic");
    const ov = h.db.getOverlay(decisionOf(h)?.overlayId ?? "");
    expect(ov?.source).toBe("identity");
    expect(ov?.error).toContain("credits exhausted");
    expect(h.notes.some((n) => n.title.includes("deterministic mode"))).toBe(true);

    // The next rerange (after the interval) is planned without asking the LLM.
    h.clock.advance(301_000);
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(stub.plannerCalls()).toBe(1);
  });
});

describe("SAFETY PROOF 7: STALE-REF blocks rerange, but HALT still runs exitAll", () => {
  it("a stale HL reference keeps the desk reduce-only: no rerange is ever proposed", async () => {
    const h = harness({ world: { hlAgeMs: 120_000 } });
    for (let i = 0; i < 6; i++) {
      const out = await h.tick();
      expect(out.kind).toBe("hold");
      if (out.kind === "hold") expect(out.reason).toContain("reduce-only");
      h.clock.advance(5_000);
    }
    expect(h.daemon.laneState(LANE_A)?.gates.gates["STALE-REF"].active).toBe(true);
    expect(h.db.recentDecisions(5)).toHaveLength(0);
    expect(h.signer.requests).toHaveLength(0);
  });

  it("HALT flattens through the stale reference, without waiting for a (denying) human", async () => {
    const h = harness({
      gate: denyAll,
      world: { hlAgeMs: 120_000, halt: true, position: inRangePosition() },
    });
    const out = await h.tick(); // HALT is immediate; no dwell, no approval for a risk-reducing step
    expect(out.kind).toBe("decision");
    if (out.kind === "decision") expect(out.status).toBe("executed");
    expect(h.chain.sent).toHaveLength(1);
    expect(decodeSigned(h.chain.sent[0] as `0x${string}`).functionName).toBe("exitAll");
    expect(decisionOf(h)?.approvalOutcome).toBe("not_required");
    expect(decisionOf(h)?.riskMode).toBe("flat");
  });

  it("positive path: fresh references let the rerange through", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
  });
});

describe("SAFETY PROOF 8: advisory never signs", () => {
  it("records `advisory`, alerts, and never reaches the signer (not even for an exit)", async () => {
    const h = harness({ mode: "advisory" });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("advisory");
    expect(decisionOf(h)?.approvalOutcome).toBe("advisory");
    expect(h.signer.requests).toHaveLength(0);

    const halt = harness({ mode: "advisory", world: { halt: true, position: inRangePosition() } });
    expect((await halt.tickUntilDecision()).status).toBe("advisory");
    expect(halt.signer.requests).toHaveLength(0);
  });

  it("a lane with no desk row runs in the configured default mode (advisory)", async () => {
    const h = harness({ noDesk: true });
    expect((await h.tickUntilDecision()).status).toBe("advisory");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("positive path: copilot with an approval executes", async () => {
    const h = harness({ mode: "copilot", gate: approveAll });
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(decisionOf(h)?.approvalOutcome).toBe("approved");
  });
});

describe("SAFETY PROOF 9: a copilot denial persists as `declined`", () => {
  it("a denial is recorded, anchors a cooldown, and a restart does not re-ask", async () => {
    const h = harness({ mode: "copilot", gate: denyAll });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("declined");
    expect(decisionOf(h)?.approvalOutcome).toBe("denied");
    expect(h.db.lastCooldownAnchor(LANE_A)).not.toBeNull();
    expect(h.notes.some((n) => n.kind === "approval-request")).toBe(true);
    expect(h.signer.requests).toHaveLength(0);

    // Process restart: fresh daemon, same DB. The veto still holds risk-adding.
    h.restart({ approvalGate: approveAll });
    for (let i = 0; i < 6; i++) {
      const next = await h.tick();
      expect(next.kind).toBe("hold");
      h.clock.advance(5_000);
    }
    expect(h.signer.requests).toHaveLength(0);
  });

  it("silence is no: a timed-out approval is declined", async () => {
    const h = harness({
      gate: {
        async requestApproval() {
          return { approved: false, outcome: "timeout", channel: null };
        },
        async awaitCancelWindow() {
          return { cancelled: false, channel: null };
        },
      },
    });
    expect((await h.tickUntilDecision()).status).toBe("declined");
    expect(decisionOf(h)?.approvalOutcome).toBe("timeout");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("positive path: once the veto cooldown passes, an approval executes", async () => {
    const h = harness({ gate: denyAll });
    expect((await h.tickUntilDecision()).status).toBe("declined");
    h.restart({ approvalGate: approveAll });
    h.clock.advance(15 * 60_000 + 1_000);
    expect((await h.tickUntilDecision()).status).toBe("executed");
  });
});

describe("SAFETY PROOF 11: `to` always comes from config", () => {
  it("every signed transaction targets the configured lane", async () => {
    const h = harness();
    await h.tickUntilDecision();
    expect(h.chain.sentTo()).toEqual([LANE_A]);
  });

  it("a prepared step pointed elsewhere is refused by the guard before any signature", async () => {
    const h = harness();
    const real = h.executor;
    h.restart({
      lanes: () => [
        {
          lane: "A",
          laneAddress: LANE_A,
          sensor: h.deps.lanes()[0]?.sensor as never,
          signer: h.signer,
          executor: {
            venue: "rh",
            async prepare(req) {
              const p = await real.prepare(req);
              return p.call === null ? p : { ...p, call: { ...p.call, to: EVIL } };
            },
            execute: (step) => real.execute(step),
          },
        },
      ],
    });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("blocked");
    expect(decisionOf(h)?.guardViolationsJson).toContain("is not the configured lane");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("a snapshot that claims another lane fails provenance: nothing is signed", async () => {
    const h = harness({ world: { reportedLaneAddress: EVIL } });
    const out = await h.tickUntilDecision();
    expect(out.status).not.toBe("executed");
    expect(decisionOf(h)?.guardViolationsJson).toContain("snapshot-provenance");
    expect(h.signer.requests).toHaveLength(0);
  });
});

describe("SAFETY PROOF 14: one transaction in flight per signer", () => {
  function seedInFlight(h: ReturnType<typeof harness>): number {
    const id = "01K5HZ3N8QW000000000000001";
    h.db.insertDecision({
      decisionId: id,
      laneAddress: LANE_A,
      lane: "A",
      createdAtMs: h.clock.now(),
      updatedAtMs: h.clock.now(),
      regime: "REGULAR",
      regimeCode: 1,
      gatesMask: 0,
      riskMode: "normal",
      snapshotJson: "{}",
      planJson: "{}",
      overlayId: null,
      finalPlanJson: null,
      reasonHash: null,
      reasonPreimage: null,
      planCriticVerdict: null,
      planCriticReason: null,
      guardDecision: null,
      guardViolationsJson: null,
      guardChecksJson: null,
      approvalMode: null,
      approvalOutcome: null,
      approvalChannel: null,
      status: "executing",
      statusDetail: null,
    });
    const execId = h.db.insertExecution({
      decisionId: id,
      stepIndex: 0,
      onchainId: `0x${"ab".repeat(32)}`,
      laneAddress: LANE_A,
      venue: "rh",
      action: "collect",
      riskClass: "reducing",
      notionalCents: 0,
      signerAddress: h.signer.address,
      status: "prepared",
      createdAtMs: h.clock.now(),
      updatedAtMs: h.clock.now(),
    });
    h.db.updateExecution(execId, { status: "simulated", updatedAtMs: h.clock.now() });
    return execId;
  }

  it("a transaction in flight blocks the next step at the guard", async () => {
    const h = harness();
    seedInFlight(h);
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("blocked");
    expect(decisionOf(h)?.guardViolationsJson).toContain("single-in-flight");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("even a guard that always says yes cannot get a second transaction in flight", async () => {
    const h = harness({
      deps: {
        guard: () => ({ decision: "execute", violations: [], checks: [], reason: "rubber stamp" }),
      },
    });
    seedInFlight(h);
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("failed");
    expect(out.detail).toContain("in flight");
    expect(h.signer.requests).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
  });

  it("positive path: once the earlier transaction settles, the next one goes", async () => {
    const h = harness();
    const execId = seedInFlight(h);
    expect((await h.tickUntilDecision()).status).toBe("blocked");
    h.db.updateExecution(execId, {
      status: "failed",
      finalizedAtMs: h.clock.now(),
      updatedAtMs: h.clock.now(),
    });
    h.clock.advance(301_000);
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(h.chain.sent).toHaveLength(1);
  });
});
