/**
 * WIRING-LEVEL PROOFS: gate signals. Every change of a lane's (regime, active gates) state goes
 * on-chain as ONE delegated signal(Meta), through the same pipeline as every other step:
 * planned → (copilot: approved) → built + simulated → guarded → signed → broadcast → its LaneAction
 * reconciled as OUR OWN (never foreign) and known to the watchdog's cross-check.
 *
 * Real: the daemon, regime machine, strategy, plan critic, guard, write-ahead executor, SQLite,
 * the LaneAction reconciler and the watchdog route. Fake: the world, the chain, the clock, the human.
 */

import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { encodeDecisionId } from "../../src/executor/decision-id.js";
import { buildStatusView } from "../../src/http/desks.js";
import { createWatchdogRoutes, WATCHDOG_KEY_HEADER } from "../../src/http/watchdog-api.js";
import { createLaneActionReconciler } from "../../src/reconcile/lane-actions.js";
import { closeOrphanedApprovals } from "../../src/reconcile/startup.js";
import { hashOfPreimage } from "../../src/regime/signal.js";
import {
  type Address,
  type ApprovalAnswer,
  type ApprovalGate,
  GATE_BITS,
  type Hex,
  LANE_ACTION_NAMES,
  REGIME_CODE,
} from "../../src/types.js";
import {
  approveAll,
  decodeSigned,
  denyAll,
  type Harness,
  harness,
  inRangePosition,
  LANE_A,
  laneActionLog,
  OPERATOR_A,
} from "../helpers/wiring.js";

const SIGNAL = LANE_ACTION_NAMES.indexOf("SIGNAL");
const WATCHDOG_KEY = "w".repeat(40);
const silent = { child: () => silent, debug() {}, info() {}, warn() {}, error() {} };

interface SignalMeta {
  decisionId: Hex;
  deadline: bigint;
  regime: number;
  gatesMask: number;
  reasonHash: Hex;
}

const fns = (h: Harness) => h.chain.sent.map((r) => decodeSigned(r).functionName);

function metaOf(raw: Hex): SignalMeta {
  const d = decodeSigned(raw);
  expect(d.functionName).toBe("signal");
  return d.args[0] as SignalMeta;
}

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

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Tick (advancing the clock) until `n` transactions were accepted by the node. */
async function untilSent(h: Harness, n: number, maxTicks = 40): Promise<void> {
  for (let i = 0; i < maxTicks && h.chain.sent.length < n; i++) {
    await h.tick();
    h.clock.advance(h.cfg.timing.tickMs);
  }
  expect(h.chain.sent.length).toBe(n);
}

/** The node's LaneAction for a signal tx, exactly as the lane logs it (the Meta it carried). */
function emitLaneAction(h: Harness, raw: Hex): { txHash: Hex; meta: SignalMeta } {
  const meta = metaOf(raw);
  const txHash = keccak256(raw);
  const receipt = h.chain.receipts.get(txHash);
  if (receipt === undefined) throw new Error("the node has no receipt for the signal");
  h.chain.logs.push(
    laneActionLog({
      decisionId: meta.decisionId,
      action: SIGNAL,
      caller: OPERATOR_A,
      txHash,
      blockNumber: receipt.blockNumber,
      regime: meta.regime,
      gatesMask: meta.gatesMask,
      reasonHash: meta.reasonHash,
    }),
  );
  return { txHash, meta };
}

describe("gate signals: planned → approved → built → signed → broadcast → reconciled", () => {
  it("copilot: the first settled state is announced once, after the owner approves; the LaneAction is ours and known", async () => {
    const d = deferredGate();
    const h = harness({ signals: true, gate: d.gate });

    // Planned: the first tick past the startup hold proposes the initial signal and waits.
    let pending: string | null = null;
    for (let i = 0; i < 8 && pending === null; i++) {
      const out = await h.tick();
      if (out.kind === "awaiting_approval") pending = out.decisionId;
      else h.clock.advance(5_000);
    }
    if (pending === null) throw new Error("no signal awaiting approval");
    const id = pending;
    expect(d.calls()).toBe(1);
    expect(h.signer.requests).toHaveLength(0); // nothing signed before the human says yes
    const ask = h.notes.find((n) => n.kind === "approval-request");
    expect(ask?.title).toBe("Approve: signal: gates none · REGULAR (initial)?");
    expect(h.db.getGateSignal(id)).toMatchObject({ status: "pending", initial: true });

    // Approved → built → signed → broadcast → confirmed, on the next tick.
    d.answer(true);
    await flush();
    h.clock.advance(5_000);
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", decisionId: id, status: "executed" });
    expect(fns(h)).toEqual(["signal"]);
    const raw = h.chain.sent[0] as Hex;
    expect(decodeSigned(raw).to).toBe(LANE_A);

    // The Meta: announced regime code, gatesMask of the active gates, the preimage's hash.
    const g = h.db.getGateSignal(id);
    if (g === null) throw new Error("no gate signal row");
    const meta = metaOf(raw);
    expect(meta.decisionId).toBe(encodeDecisionId(id, 0));
    expect(meta.regime).toBe(REGIME_CODE.REGULAR);
    expect(meta.gatesMask).toBe(0);
    expect(meta.reasonHash).toBe(g.reasonHash);
    expect(hashOfPreimage(g.preimageJson)).toBe(meta.reasonHash);
    expect(JSON.parse(g.preimageJson)).toEqual({
      lane: LANE_A,
      from: null,
      to: { regime: "REGULAR", gates: [] },
      at: g.atMs,
      source: "initial",
    });
    expect(h.db.getDecision(id)).toMatchObject({
      status: "executed",
      approvalMode: "copilot",
      approvalOutcome: "approved",
      reasonHash: g.reasonHash,
      reasonPreimage: g.preimageJson,
    });
    const exec = h.db.getExecutionByStep(id, 0);
    expect(exec).toMatchObject({
      action: "signal",
      riskClass: "neutral",
      notionalCents: 0,
      status: "confirmed",
    });
    expect(h.db.turnoverCentsSince(LANE_A, 0)).toBe(0); // a signal is never turnover
    expect(g.status).toBe("confirmed");

    // Reconciled as our own LaneAction: matched, the desk stays active (no safe mode).
    const { txHash } = emitLaneAction(h, raw);
    const rec = createLaneActionReconciler({
      db: h.db,
      chain: h.chain,
      lanes: () => [LANE_A],
      clock: h.clock,
      logger: silent,
      confirmations: 0,
    });
    const report = await rec.run(h.clock.now());
    expect(report).toMatchObject({ matched: 1, foreign: 0 });
    expect(h.db.laneActionsByMatch("matched", LANE_A)[0]).toMatchObject({
      actionName: "SIGNAL",
      matchedExecutionId: exec?.executionId,
      reasonHash: g.reasonHash,
    });
    expect(h.db.laneActionsByMatch("foreign")).toHaveLength(0);
    expect(h.db.getDesk(LANE_A)?.status).toBe("active");

    // The watchdog's cross-check knows it (by decisionId, and by decisionId + tx).
    const api = createWatchdogRoutes({ db: h.db, key: WATCHDOG_KEY, logger: silent });
    const ask2 = async (q: string) =>
      (
        await api.request(`/lanes/${LANE_A}/actions/${meta.decisionId}${q}`, {
          headers: { [WATCHDOG_KEY_HEADER]: WATCHDOG_KEY },
        })
      ).json();
    expect(await ask2("")).toEqual({ known: true, status: "confirmed" });
    expect(await ask2(`?tx=${txHash}`)).toEqual({ known: true, status: "confirmed" });

    // The owner's status view shows it.
    const desk = h.db.getDesk(LANE_A);
    if (desk === null) throw new Error("no desk");
    expect(buildStatusView(desk, h.db, h.clock.now(), null).lastSignal).toMatchObject({
      decisionId: meta.decisionId,
      status: "confirmed",
      regime: "REGULAR",
      gates: [],
      reasonHash: g.reasonHash,
      txHash,
    });

    // Once: the funded lane's initial mint follows; the unchanged state is never re-announced.
    for (let i = 0; i < 12; i++) {
      d.answer(true);
      await flush();
      await h.tick();
      h.clock.advance(5_000);
    }
    expect(fns(h)).toEqual(["signal", "rerange"]);
    expect(h.db.recentGateSignals(LANE_A, 10)).toHaveLength(1);
  });

  it("DESK_SIGNAL_AUTO=1: copilot sends the signal without asking; risk-adding still asks", async () => {
    const h = harness({ signals: { auto: true }, gate: denyAll });
    const first = await h.tickUntilDecision();
    expect(first.status).toBe("executed");
    expect(h.db.getDecision(first.decisionId)).toMatchObject({
      approvalMode: "copilot",
      approvalOutcome: "not_required",
    });
    expect(h.notes.some((n) => n.kind === "approval-request" && /signal/.test(n.title))).toBe(
      false,
    );
    h.clock.advance(5_000);
    const second = await h.tickUntilDecision();
    expect(second.status).toBe("declined"); // the rerange: denied by the human
    expect(fns(h)).toEqual(["signal"]);
  });

  it("an owner who denies a signal is not asked again for that state; the veto never holds reranges", async () => {
    const h = harness({ signals: true, gate: denyAll, world: { position: inRangePosition() } });
    const first = await h.tickUntilDecision();
    expect(first.status).toBe("declined");
    expect(h.db.getGateSignal(first.decisionId)?.status).toBe("declined");
    expect(h.db.lastCooldownAnchor(LANE_A)).toBeNull();
    for (let i = 0; i < 20; i++) {
      h.clock.advance(60_000);
      const out = await h.tick();
      expect(out.kind).toBe("hold");
    }
    expect(h.db.recentGateSignals(LANE_A, 10)).toHaveLength(1);
    expect(h.chain.sent).toHaveLength(0);
  });
});

describe("gate signals: one per actual transition", () => {
  it("a restart neither re-emits nor misses; the next change is announced after the dwell, chained to the last", async () => {
    const h = harness({ signals: { auto: true }, world: { position: inRangePosition() } });
    await untilSent(h, 1);
    const first = h.db.recentGateSignals(LANE_A, 1)[0];
    expect(first).toMatchObject({ status: "confirmed", gatesMask: 0 });

    // Restart: the startup hold passes, the state is the one on-chain: nothing is sent.
    h.restart();
    for (let i = 0; i < 20; i++) {
      await h.tick();
      h.clock.advance(5_000);
    }
    expect(h.chain.sent).toHaveLength(1);

    // STALE-REF turns on: held for the 60 s dwell, then announced once.
    h.world.hlAgeMs = 60_000;
    await h.tick();
    const changedAt = h.clock.now();
    for (let i = 0; i < 10; i++) {
      h.clock.advance(5_000);
      await h.tick();
    }
    expect(h.chain.sent).toHaveLength(1); // 50 s < 60 s
    await untilSent(h, 2, 6);
    const meta = metaOf(h.chain.sent[1] as Hex);
    expect(meta.regime).toBe(REGIME_CODE.REGULAR);
    expect(meta.gatesMask).toBe(GATE_BITS["STALE-REF"]);
    const g = h.db.recentGateSignals(LANE_A, 1)[0];
    expect(g).toMatchObject({ initial: false, fromKey: "1:0", toKey: "1:8", atMs: changedAt });
    expect(JSON.parse(g?.preimageJson ?? "{}")).toMatchObject({
      from: { regime: "REGULAR", gates: [] },
      to: { regime: "REGULAR", gates: ["STALE-REF"] },
      at: changedAt,
      source: "transition",
    });
    expect(meta.reasonHash).toBe(g?.reasonHash);
  });

  it("a signal orphaned by a crash (never signed) does not block the lane: it is retried later", async () => {
    const d = deferredGate();
    const h = harness({ signals: true, gate: d.gate, world: { position: inRangePosition() } });
    let pending: string | null = null;
    for (let i = 0; i < 8 && pending === null; i++) {
      const out = await h.tick();
      if (out.kind === "awaiting_approval") pending = out.decisionId;
      else h.clock.advance(5_000);
    }
    if (pending === null) throw new Error("no pending signal");
    h.restart({ approvalGate: approveAll }); // the process died while the owner was deciding
    // Startup (main.ts): what the dead process was deciding is settled, never left "pending".
    closeOrphanedApprovals({ db: h.db, logger: silent }, h.clock.now());
    expect(h.db.getGateSignal(pending)?.status).toBe("not_sent");
    for (let i = 0; i < 12; i++) {
      h.clock.advance(5_000);
      await h.tick();
    }
    expect(h.chain.sent).toHaveLength(0); // 10 min retry window
    h.clock.advance(10 * 60_000);
    await untilSent(h, 1, 4);
    expect(h.db.recentGateSignals(LANE_A, 5).map((g) => g.status)).toEqual([
      "confirmed",
      "not_sent", // the orphan: settled at startup
    ]);
    const desk = h.db.getDesk(LANE_A);
    if (desk === null) throw new Error("no desk");
    expect(buildStatusView(desk, h.db, h.clock.now(), null).lastSignal?.status).toBe("confirmed");
  });

  it("a state that flaps shorter than the dwell is never announced", async () => {
    const h = harness({ signals: { auto: true }, world: { position: inRangePosition() } });
    await untilSent(h, 1);
    for (let round = 0; round < 3; round++) {
      h.world.hlAgeMs = 60_000; // STALE-REF on (immediately)
      for (let i = 0; i < 3; i++) {
        await h.tick();
        h.clock.advance(5_000);
      }
      h.world.hlAgeMs = 0; // off after the machine's 3 clear ticks
      for (let i = 0; i < 6; i++) {
        await h.tick();
        h.clock.advance(5_000);
      }
    }
    for (let i = 0; i < 20; i++) {
      await h.tick();
      h.clock.advance(5_000);
    }
    expect(h.chain.sent).toHaveLength(1);
    expect(h.db.recentGateSignals(LANE_A, 10)).toHaveLength(1);
  });

  it("at most DESK_SIGNAL_MAX_PER_HOUR signed per lane per rolling hour; the latest state goes next", async () => {
    const h = harness({
      signals: { auto: true, maxPerHour: 2, minDwellMs: 0 },
      world: { position: inRangePosition() },
    });
    await untilSent(h, 1); // initial
    h.world.hlAgeMs = 60_000;
    await untilSent(h, 2, 4); // STALE-REF on
    h.world.hlAgeMs = 0;
    for (let i = 0; i < 12; i++) {
      await h.tick();
      h.clock.advance(5_000);
    }
    expect(h.chain.sent).toHaveLength(2); // cleared, but the hour's budget is spent
    h.clock.advance(60 * 60_000);
    await untilSent(h, 3, 4);
    const meta = metaOf(h.chain.sent[2] as Hex);
    expect(meta.gatesMask).toBe(0);
  });
});

describe("gate signals: risk-reducing first, and halted desks sign nothing", () => {
  it("HALT: exitAll runs at once without asking; the HALT state is announced afterwards", async () => {
    const d = deferredGate();
    const h = harness({ signals: true, gate: d.gate, world: { position: inRangePosition() } });
    // The initial signal waits for the owner…
    let pending: string | null = null;
    for (let i = 0; i < 8 && pending === null; i++) {
      const out = await h.tick();
      if (out.kind === "awaiting_approval") pending = out.decisionId;
      else h.clock.advance(5_000);
    }
    if (pending === null) throw new Error("no pending signal");
    // …when trading halts: the exit preempts it in the same tick.
    h.world.halt = true;
    h.clock.advance(5_000);
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", status: "executed" });
    expect(fns(h)).toEqual(["exitAll"]);
    expect(h.db.getDecision(pending)).toMatchObject({
      status: "declined",
      approvalOutcome: "cancelled",
    });
    expect(h.db.getGateSignal(pending)?.status).toBe("not_sent");
    expect(h.db.lastCooldownAnchor(LANE_A)).toBeNull();

    // Flat and empty: the lane's first state on-chain is the HALT one (initial, from null; once
    // a first signal was planned, even a withdrawn one, the next state holds the dwell).
    h.world.position = null;
    let asked: string | null = null;
    for (let i = 0; i < 20 && asked === null; i++) {
      h.clock.advance(5_000);
      const o = await h.tick();
      if (o.kind === "awaiting_approval") asked = o.decisionId;
    }
    if (asked === null) throw new Error("the HALT state was not proposed");
    d.answer(true);
    await flush();
    h.clock.advance(5_000);
    await h.tick();
    expect(fns(h)).toEqual(["exitAll", "signal"]);
    const meta = metaOf(h.chain.sent[1] as Hex);
    expect(meta.gatesMask).toBe(GATE_BITS.HALT);
    expect(h.db.getDecision(asked)?.riskMode).toBe("flat");
  });

  for (const status of ["safe_mode", "revoked"] as const) {
    it(`a ${status} desk plans and signs no signal`, async () => {
      const h = harness({ signals: { auto: true }, deskStatus: status });
      for (let i = 0; i < 12; i++) {
        await h.tick();
        h.clock.advance(5_000);
      }
      expect(h.signer.requests).toHaveLength(0);
      expect(h.db.recentGateSignals(LANE_A, 5)).toHaveLength(0);
    });
  }

  it("a paused lane or an advisory desk plans no signal", async () => {
    for (const h of [
      harness({ signals: { auto: true }, world: { paused: true, position: inRangePosition() } }),
      harness({
        signals: { auto: true },
        mode: "advisory",
        world: { position: inRangePosition() },
      }),
    ]) {
      for (let i = 0; i < 12; i++) {
        await h.tick();
        h.clock.advance(5_000);
      }
      expect(h.signer.requests).toHaveLength(0);
      expect(h.db.recentGateSignals(LANE_A, 5)).toHaveLength(0);
    }
  });

  it("DRY_RUN and an unarmed 4663 hold fire; an unsigned signal is retried later, not every tick", async () => {
    const dry = harness({ signals: { auto: true }, dryRun: true });
    const d1 = await dry.tickUntilDecision();
    expect(d1.status).toBe("dry_run");
    expect(dry.db.getGateSignal(d1.decisionId)?.status).toBe("not_sent");
    for (let i = 0; i < 24; i++) {
      dry.clock.advance(5_000);
      await dry.tick();
    }
    expect(dry.db.recentGateSignals(LANE_A, 5)).toHaveLength(1); // 2 min: no retry yet
    dry.clock.advance(10 * 60_000);
    await dry.tick();
    expect(dry.db.recentGateSignals(LANE_A, 5)).toHaveLength(2);
    expect(dry.signer.requests).toHaveLength(0);

    const unarmed = harness({ signals: { auto: true }, armed: false });
    const d2 = await unarmed.tickUntilDecision();
    expect(d2.status).toBe("blocked");
    expect(unarmed.db.getDecision(d2.decisionId)?.guardViolationsJson).toContain("arm-flag");
    expect(unarmed.signer.requests).toHaveLength(0);
  });

  it("a desk that goes to safe mode after approval never signs the signal (executor re-check)", async () => {
    const d = deferredGate();
    const h = harness({ signals: true, gate: d.gate, world: { position: inRangePosition() } });
    let pending: string | null = null;
    for (let i = 0; i < 8 && pending === null; i++) {
      const out = await h.tick();
      if (out.kind === "awaiting_approval") pending = out.decisionId;
      else h.clock.advance(5_000);
    }
    if (pending === null) throw new Error("no pending signal");
    h.db.setDeskStatus(LANE_A as Address, "safe_mode", "test", h.clock.now());
    d.answer(true);
    await flush();
    h.clock.advance(5_000);
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", status: "blocked" });
    expect(h.signer.requests).toHaveLength(0);
    expect(h.db.getGateSignal(pending)?.status).toBe("not_sent");
  });
});

/** Tick `n` times, advancing the clock one tick after each. */
async function run(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await h.tick();
    h.clock.advance(h.cfg.timing.tickMs);
  }
}

/** Tick until a decision is awaiting the owner; its id. */
async function untilAsked(h: Harness, maxTicks = 40): Promise<string> {
  for (let i = 0; i < maxTicks; i++) {
    const out = await h.tick();
    if (out.kind === "awaiting_approval") return out.decisionId;
    h.clock.advance(h.cfg.timing.tickMs);
  }
  throw new Error(`no approval asked within ${maxTicks} ticks`);
}

/** A human who answers each ask from a script (true = approve, false = deny). */
function scriptedGate(script: boolean[]) {
  let calls = 0;
  const gate: ApprovalGate = {
    async requestApproval(): Promise<ApprovalAnswer> {
      const yes = script[calls] ?? false;
      calls += 1;
      return yes
        ? { approved: true, outcome: "approved", channel: "web" }
        : { approved: false, outcome: "denied", channel: "web" };
    },
    async awaitCancelWindow() {
      return { cancelled: false, channel: null };
    },
  };
  return { gate, calls: () => calls };
}

const masks = (h: Harness) => h.chain.sent.map((r) => metaOf(r).gatesMask);

describe("gate signals: late answers, mode switches and re-entries", () => {
  it("an approval that comes after its state ended is not sent: no stale state, no corrective signal", async () => {
    const d = deferredGate();
    const h = harness({ signals: true, gate: d.gate, world: { position: inRangePosition() } });
    await untilAsked(h);
    d.answer(true);
    await flush();
    await run(h, 1);
    expect(masks(h)).toEqual([0]);

    // STALE-REF on: announced after the dwell, the owner is asked…
    h.world.hlAgeMs = 60_000;
    const stale = await untilAsked(h, 30);
    // …but the gate clears (back to the state on-chain) before the owner answers yes.
    h.world.hlAgeMs = 0;
    await run(h, 10);
    d.answer(true);
    await flush();
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", decisionId: stale, status: "blocked" });
    expect(h.db.getDecision(stale)?.statusDetail).toMatch(/gate state changed since the signal/);
    expect(h.db.getGateSignal(stale)?.status).toBe("not_sent");
    // Nothing more to say: the chain already shows the current state.
    for (let i = 0; i < 30; i++) {
      d.answer(true);
      await flush();
      await run(h, 1);
    }
    expect(masks(h)).toEqual([0]);
    expect(d.calls()).toBe(2);
  });

  it("an owner who switches the desk to advisory while a signal waits: the approval signs nothing", async () => {
    const d = deferredGate();
    const h = harness({ signals: true, gate: d.gate, world: { position: inRangePosition() } });
    const asked = await untilAsked(h);
    h.db.updateDesk(LANE_A, { mode: "advisory" });
    d.answer(true);
    await flush();
    h.clock.advance(5_000);
    const out = await h.tick();
    expect(out).toMatchObject({ kind: "decision", decisionId: asked, status: "advisory" });
    expect(h.signer.requests).toHaveLength(0);
    expect(h.db.getGateSignal(asked)?.status).toBe("not_sent");
  });

  it("a denied state the lane leaves for the dwell and re-enters is asked again; a flap back is not", async () => {
    const g = scriptedGate([true, false, true]);
    const h = harness({ signals: true, gate: g.gate, world: { position: inRangePosition() } });
    await run(h, 10);
    expect(masks(h)).toEqual([0]); // initial: approved
    expect(g.calls()).toBe(1);

    h.world.hlAgeMs = 60_000; // STALE-REF on, held: asked, DENIED
    await run(h, 20);
    expect(g.calls()).toBe(2);

    // A flap: STALE-REF clears for a few seconds and comes back. Not a new transition.
    h.world.hlAgeMs = 0;
    for (let i = 0; i < 6 && h.daemon.laneState(LANE_A)?.gates.gates["STALE-REF"]?.active; i++)
      await run(h, 1);
    expect(h.daemon.laneState(LANE_A)?.gates.gates["STALE-REF"]?.active).toBe(false);
    h.world.hlAgeMs = 60_000;
    await run(h, 40);
    expect(g.calls()).toBe(2);

    // Back in the on-chain state for 10 minutes, then a real re-entry into STALE-REF.
    h.world.hlAgeMs = 0;
    await run(h, 120);
    expect(g.calls()).toBe(2);
    h.world.hlAgeMs = 60_000;
    await run(h, 20);
    expect(g.calls()).toBe(3);
    expect(masks(h)).toEqual([0, GATE_BITS["STALE-REF"]]);
    expect(h.db.recentGateSignals(LANE_A, 5).map((s) => `${s.toKey}:${s.status}`)).toEqual([
      "1:8:confirmed",
      "1:8:declined",
      "1:0:confirmed",
    ]);
  });

  it("a signal that reverted: its state is not re-sent, but a later re-entry into it is announced", async () => {
    const h = harness({ signals: { auto: true }, world: { position: inRangePosition() } });
    let revertNext = false;
    const send = h.chain.sendRawTransaction.bind(h.chain);
    h.chain.sendRawTransaction = async (raw: Hex) => {
      const hash = await send(raw);
      const r = h.chain.receipts.get(hash);
      if (revertNext && r !== undefined) h.chain.receipts.set(hash, { ...r, status: "reverted" });
      revertNext = false;
      return hash;
    };
    await untilSent(h, 1);
    revertNext = true;
    h.world.hlAgeMs = 60_000; // STALE-REF on: its signal reverts
    await untilSent(h, 2, 20);
    expect(h.db.recentGateSignals(LANE_A, 1)[0]?.status).toBe("failed");
    await run(h, 60); // still STALE-REF: one per transition
    expect(h.chain.sent).toHaveLength(2);
    h.world.hlAgeMs = 0; // back to the on-chain state for 10 minutes
    await run(h, 120);
    h.world.hlAgeMs = 60_000; // a new STALE-REF episode
    await untilSent(h, 3, 20);
    expect(masks(h)).toEqual([0, GATE_BITS["STALE-REF"], GATE_BITS["STALE-REF"]]);
  });

  it("after a denied first signal, a state shorter than the dwell is never proposed", async () => {
    const g = scriptedGate([false, false]);
    const h = harness({ signals: true, gate: g.gate, world: { position: inRangePosition() } });
    await run(h, 10);
    expect(g.calls()).toBe(1); // the initial state (no dwell), denied
    await run(h, 12); // hold it a minute: the next change is measured against the dwell
    h.world.hlAgeMs = 60_000; // STALE-REF on for ~15 s, then off (the machine's clear dwell)
    await run(h, 3);
    h.world.hlAgeMs = 0;
    await run(h, 20);
    expect(g.calls()).toBe(1);
    h.world.hlAgeMs = 60_000; // held past the dwell: proposed, still as the lane's initial one
    await run(h, 20);
    expect(g.calls()).toBe(2);
    expect(h.db.recentGateSignals(LANE_A, 1)[0]).toMatchObject({
      toKey: "1:8",
      initial: true,
      fromKey: null,
      status: "declined",
    });
    expect(h.chain.sent).toHaveLength(0);
  });
});
