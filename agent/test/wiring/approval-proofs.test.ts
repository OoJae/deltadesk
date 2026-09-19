/**
 * WIRING-LEVEL SAFETY PROOFS: what may change while a decision waits for a human.
 *
 * - The tick never waits for the human: a pending approval leaves the loop sensing, a risk-reducing
 *   plan (HALT → exitAll) withdraws it and runs at once, and a later answer is executed on a later
 *   tick.
 * - An approved rerange is criticised again on the snapshot it signs on: a placement centred on an
 *   F that has since moved never signs.
 * - Autopilot without a cancel window is copilot (never executes risk-adding unasked).
 * - The Meta deadline follows the lane's on-chain maxDeadlineAhead, so an owner who tightens it
 *   does not lock the agent out of its HALT exit.
 * - Safe mode entered while a risk-adding step signs stops its broadcast.
 *
 * Every proof also runs its positive path.
 */

import { describe, expect, it } from "vitest";
import { createApprovalGate } from "../../src/approval/gate.js";
import { DEFAULT_LANE_CAPS } from "../../src/sense/mock.js";
import type { ApprovalAnswer, ApprovalGate, Hex } from "../../src/types.js";
import { fixedClock, memDb } from "../helpers/fakes.js";
import {
  approveAll,
  decodeSigned,
  denyAll,
  harness,
  inRangePosition,
  LANE_A,
  T0,
} from "../helpers/wiring.js";

const flush = () => new Promise<void>((r) => setImmediate(r));

/** A human who answers only when the test says so. */
function deferredGate() {
  const waiting: Array<(a: ApprovalAnswer) => void> = [];
  let calls = 0;
  const gate: ApprovalGate = {
    requestApproval() {
      calls += 1;
      return new Promise((resolve) => waiting.push(resolve));
    },
    async awaitCancelWindow() {
      return { cancelled: false, channel: null };
    },
  };
  return {
    gate,
    calls: () => calls,
    answer(approved: boolean) {
      for (const w of waiting.splice(0)) {
        w(
          approved
            ? { approved: true, outcome: "approved", channel: "web" }
            : { approved: false, outcome: "denied", channel: "web" },
        );
      }
    },
  };
}

/** The real multi-channel gate over the harness DB; it re-polls only when the test wakes it. */
function dbGate(db: ReturnType<typeof memDb>, clock: ReturnType<typeof fixedClock>) {
  const sleepers: Array<() => void> = [];
  const gate = createApprovalGate({
    db,
    clock,
    sleep: () => new Promise<void>((r) => sleepers.push(r)),
  });
  return {
    gate,
    wake: async () => {
      for (const s of sleepers.splice(0)) s();
      await flush();
    },
  };
}

async function untilAwaiting(h: ReturnType<typeof harness>, maxTicks = 8): Promise<string> {
  for (let i = 0; i < maxTicks; i++) {
    const out = await h.tick();
    if (out.kind === "awaiting_approval") return out.decisionId;
    if (out.kind === "decision") throw new Error(`settled without waiting: ${out.status}`);
    h.clock.advance(h.cfg.timing.tickMs);
  }
  throw new Error("no pending decision");
}

describe("a pending approval never stalls the loop", () => {
  it("the loop keeps sensing while the human decides; nothing is signed meanwhile", async () => {
    const d = deferredGate();
    const h = harness({ gate: d.gate });
    const id = await untilAwaiting(h);
    const ticksBefore = h.db.lastTick(LANE_A)?.atMs ?? 0;
    for (let i = 0; i < 4; i++) {
      h.clock.advance(5_000);
      const out = await h.tick();
      expect(out).toMatchObject({ kind: "awaiting_approval", decisionId: id });
    }
    expect(h.db.lastTick(LANE_A)?.atMs).toBe(ticksBefore + 20_000); // /health stays fresh
    expect(d.calls()).toBe(1); // asked once, not once per tick
    expect(h.signer.requests).toHaveLength(0);
    expect(h.db.getDecision(id)).toMatchObject({ status: "observed", approvalMode: "copilot" });
  });

  it("HALT preempts the pending rerange: exitAll runs in the same tick, the request is withdrawn", async () => {
    const db = memDb();
    const clock = fixedClock(T0);
    const g = dbGate(db, clock);
    const h = harness({ db, clock, gate: g.gate });
    const id = await untilAwaiting(h);
    expect(db.getApproval(id)?.status).toBe("pending");

    // The lane now holds a position (e.g. one the owner placed) and trading halts.
    h.world.position = inRangePosition();
    h.world.halt = true;
    h.clock.advance(5_000);
    const out = await h.tick();
    expect(out.kind).toBe("decision");
    if (out.kind === "decision") expect(out.status).toBe("executed");
    expect(h.chain.sent).toHaveLength(1);
    expect(decodeSigned(h.chain.sent[0] as Hex).functionName).toBe("exitAll");

    expect(db.getDecision(id)).toMatchObject({ status: "declined", approvalOutcome: "cancelled" });
    expect(db.getDecision(id)?.statusDetail).toContain("withdrawn before approval");
    expect(db.getApproval(id)?.status).toBe("cancelled");
    // A late approve can no longer apply, and the gate's late answer is ignored.
    expect(db.respondApproval(id, true, "web", "user-1", clock.now())).toBe(false);
    await g.wake();
    expect(db.lastCooldownAnchor(LANE_A)).toBeNull(); // a withdrawal is not a human veto
    h.clock.advance(5_000);
    await h.tick();
    expect(h.chain.sent.map((r) => decodeSigned(r).functionName)).not.toContain("rerange");
  });

  it("positive path: an approve given later executes on a later tick (real DB gate)", async () => {
    const db = memDb();
    const clock = fixedClock(T0);
    const g = dbGate(db, clock);
    const h = harness({ db, clock, gate: g.gate });
    const id = await untilAwaiting(h);
    expect(db.respondApproval(id, true, "web", "user-1", clock.now())).toBe(true);
    await g.wake();
    h.clock.advance(5_000);
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", decisionId: id, status: "executed" });
    expect(db.getDecision(id)).toMatchObject({
      approvalOutcome: "approved",
      approvalChannel: "web",
    });
    expect(decodeSigned(h.chain.sent[0] as Hex).functionName).toBe("rerange");
  });

  it("a denial given later is recorded as declined and anchors the veto cooldown", async () => {
    const d = deferredGate();
    const h = harness({ gate: d.gate });
    const id = await untilAwaiting(h);
    d.answer(false);
    await flush();
    h.clock.advance(5_000);
    expect(await h.tick()).toMatchObject({ kind: "decision", decisionId: id, status: "declined" });
    expect(h.db.lastCooldownAnchor(LANE_A)).not.toBeNull();
    expect(h.signer.requests).toHaveLength(0);
  });

  it("a gate that never answers times out on the daemon's own clock (silence is no)", async () => {
    const d = deferredGate();
    const h = harness({ gate: d.gate });
    const id = await untilAwaiting(h);
    h.clock.advance(h.cfg.timing.approvalWindowMs + 3 * h.cfg.timing.tickMs);
    expect(await h.tick()).toMatchObject({ kind: "decision", decisionId: id, status: "declined" });
    expect(h.db.getDecision(id)?.approvalOutcome).toBe("timeout");
    expect(h.db.lastCooldownAnchor(LANE_A)).not.toBeNull();
    d.answer(true); // too late: ignored
    await flush();
    h.clock.advance(5_000);
    await h.tick();
    expect(h.signer.requests).toHaveLength(0);
  });

  it("stop() withdraws a pending decision so no channel can approve it afterwards", async () => {
    const db = memDb();
    const clock = fixedClock(T0);
    const g = dbGate(db, clock);
    const h = harness({ db, clock, gate: g.gate });
    const id = await untilAwaiting(h);
    await h.daemon.stop();
    expect(db.getApproval(id)?.status).toBe("cancelled");
    expect(db.getDecision(id)?.status).toBe("declined");
  });
});

describe("an approved rerange is criticised again on the snapshot it signs on", () => {
  /** A human who takes 60 s to approve, while HL (so F) moves by `bps` and the pool stays put. */
  function slowApprover(h: () => ReturnType<typeof harness>, bps: number): ApprovalGate {
    return {
      async requestApproval() {
        h().clock.advance(60_000);
        h().world.fShiftBps = bps;
        return { approved: true, outcome: "approved", channel: "web" };
      },
      async awaitCancelWindow() {
        return { cancelled: false, channel: null };
      },
    };
  }

  it("F moved 80 bp during the approval: the straddle centred on the old F never signs", async () => {
    let h: ReturnType<typeof harness> | null = null;
    h = harness({ gate: slowApprover(() => h as ReturnType<typeof harness>, 80) });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("blocked");
    expect(out.detail).toContain("critic-approval");
    expect(out.detail).toContain("at execution");
    expect(h.signer.requests).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
  });

  it("same, when the approve arrives on a later tick", async () => {
    const d = deferredGate();
    const h = harness({ gate: d.gate });
    const id = await untilAwaiting(h);
    h.world.fShiftBps = 80;
    d.answer(true);
    await flush();
    h.clock.advance(5_000);
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", decisionId: id, status: "blocked" });
    if (out.kind === "decision") expect(out.detail).toContain("does not contain the recomputed");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("positive path: F drift within maxTickDelta (8 bp) still signs the approved placement", async () => {
    let h: ReturnType<typeof harness> | null = null;
    h = harness({ gate: slowApprover(() => h as ReturnType<typeof harness>, 8) });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("executed");
    expect(h.chain.sent).toHaveLength(1);
  });

  it("positive path: an unmoved market after a 60 s approval signs", async () => {
    let h: ReturnType<typeof harness> | null = null;
    h = harness({ gate: slowApprover(() => h as ReturnType<typeof harness>, 0) });
    expect((await h.tickUntilDecision()).status).toBe("executed");
  });
});

describe("autopilot without a cancel window is copilot", () => {
  function counting(gate: ApprovalGate) {
    let asked = 0;
    let windows = 0;
    return {
      calls: () => ({ asked, windows }),
      gate: {
        requestApproval: (r) => {
          asked += 1;
          return gate.requestApproval(r);
        },
        awaitCancelWindow: (r) => {
          windows += 1;
          return gate.awaitCancelWindow(r);
        },
      } satisfies ApprovalGate,
    };
  }

  it("a desk row left in autopilot with DESK_CANCEL_WINDOW_SEC=0 asks, and a denial holds", async () => {
    const c = counting(denyAll);
    const h = harness({ mode: "autopilot", gate: c.gate });
    expect(h.cfg.timing.cancelWindowMs).toBe(0);
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("declined");
    expect(c.calls()).toEqual({ asked: 1, windows: 0 });
    expect(h.db.recentDecisions(1)[0]?.approvalMode).toBe("copilot");
    expect(h.signer.requests).toHaveLength(0);
    expect(h.notes.some((n) => n.title.includes("runs as copilot"))).toBe(true);
  });

  it("positive path: an explicit approve executes it", async () => {
    const c = counting(approveAll);
    const h = harness({ mode: "autopilot", gate: c.gate });
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(c.calls().asked).toBe(1);
  });

  it("positive path: with a cancel window, autopilot keeps its semantics (silence proceeds)", async () => {
    const c = counting(approveAll);
    const h = harness({
      mode: "autopilot",
      gate: c.gate,
      config: (cfg) => ({ ...cfg, timing: { ...cfg.timing, cancelWindowMs: 30_000 } }),
    });
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(c.calls()).toEqual({ asked: 0, windows: 1 });
    expect(h.db.recentDecisions(1)[0]?.approvalMode).toBe("autopilot");
  });
});

describe("the deadline follows the lane's on-chain maxDeadlineAhead", () => {
  it("an owner who tightened it to 30 s still gets the HALT exit (deadline ≤ now + 30)", async () => {
    const h = harness({
      gate: denyAll,
      world: {
        caps: { ...DEFAULT_LANE_CAPS, maxDeadlineAhead: 30 },
        halt: true,
        position: inRangePosition(),
      },
    });
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", status: "executed" });
    const signed = decodeSigned(h.chain.sent[0] as Hex);
    expect(signed.functionName).toBe("exitAll");
    const meta = signed.args[0] as { deadline: bigint };
    expect(meta.deadline).toBeLessThanOrEqual(BigInt(Math.floor(h.clock.now() / 1000) + 30));
  });

  it("a cap with no valid window blocks and raises a critical alert (not silently)", async () => {
    const h = harness({
      world: {
        caps: { ...DEFAULT_LANE_CAPS, maxDeadlineAhead: 3 },
        halt: true,
        position: inRangePosition(),
      },
    });
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", status: "blocked" });
    expect(h.db.recentDecisions(1)[0]?.guardViolationsJson).toContain("deadline-sane");
    expect(
      h.notes.some((n) => n.severity === "critical" && n.title.includes("no valid deadline")),
    ).toBe(true);
    expect(h.signer.requests).toHaveLength(0);
  });

  it("positive path: the default caps keep DESK_DEADLINE_SEC (45 s)", async () => {
    const h = harness({ world: { halt: true, position: inRangePosition() } });
    await h.tick();
    const meta = decodeSigned(h.chain.sent[0] as Hex).args[0] as { deadline: bigint };
    expect(meta.deadline).toBe(BigInt(Math.floor(h.clock.now() / 1000) + 45));
  });
});

describe("safe mode that lands while a risk-adding step signs stops its broadcast", () => {
  it("the rerange is dropped unsent (DESK_HALTED) and the decision does not report success", async () => {
    let h: ReturnType<typeof harness> | null = null;
    h = harness({
      sign: async (tx, base) => {
        h?.db.setDeskStatus(LANE_A, "safe_mode", "foreign LaneAction", T0);
        return base.signTransaction(tx);
      },
    });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("failed");
    expect(out.detail).toContain("DESK_HALTED");
    expect(h.signer.requests).toHaveLength(1);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.db.recentExecutions(1)[0]).toMatchObject({
      status: "dropped",
      errorCode: "DESK_HALTED",
    });
  });

  it("positive path: an undisturbed signature is broadcast", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(h.chain.sent).toHaveLength(1);
  });
});
