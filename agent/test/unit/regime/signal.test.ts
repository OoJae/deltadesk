import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, stringToBytes } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATOR_SELECTORS } from "../../../src/executor/abi/DeskLane.js";
import { createCalldataBuilder } from "../../../src/executor/calldata.js";
import { createDecisionUlidFactory, encodeDecisionId } from "../../../src/executor/decision-id.js";
import { deskHaltedReason } from "../../../src/executor/safe-mode.js";
import { createGateMachine } from "../../../src/regime/machine.js";
import {
  detectGateSignal,
  type GateSignalInput,
  gatesMaskOfNames,
  gatesOfMask,
  gatesSettled,
  hashOfPreimage,
  type SignalState,
  signalKey,
  signalNote,
  signalPreimage,
  watchState,
} from "../../../src/regime/signal.js";
import { gateSignalStatus, openDb } from "../../../src/state/db.js";
import {
  type Address,
  type DecisionRow,
  GATE_BITS,
  GATE_NAMES,
  type GateName,
  type Hex,
  REGIME_CODE,
} from "../../../src/types.js";
import { LANE, memDb, OPERATOR } from "../../helpers/fakes.js";

const T0 = 1_790_000_000_000;
const MIN = 60_000;

const st = (regime: SignalState["regime"], gates: GateName[] = []): SignalState => ({
  regime,
  regimeCode: REGIME_CODE[regime],
  gates: GATE_NAMES.filter((g) => gates.includes(g)),
  gatesMask: gatesMaskOfNames(gates),
});

const OPEN = st("REGULAR");
const WEEKEND = st("WEEKEND_DARK", ["CLOSED"]);
const HALTED = st("REGULAR", ["HALT"]);

function input(over: Partial<GateSignalInput> = {}): GateSignalInput {
  return {
    enabled: true,
    halted: null,
    inFlight: 0,
    state: WEEKEND,
    settled: true,
    watch: { key: signalKey(WEEKEND), sinceMs: T0, settled: true, away: null },
    nowMs: T0 + 2 * MIN,
    lastEmitted: { toKey: signalKey(OPEN), state: OPEN },
    latest: { toKey: signalKey(OPEN), status: "confirmed", createdAtMs: T0 - 10 * MIN },
    signed1h: 0,
    maxPerHour: 6,
    minDwellMs: MIN,
    retryMs: 10 * MIN,
    ...over,
  };
}

const reasonOf = (i: GateSignalInput): string => {
  const r = detectGateSignal(i);
  if (r.emit) throw new Error("expected no signal");
  return r.reason;
};

describe("Meta encoding: regime codes and the gatesMask bits (agent/README.md table)", () => {
  it("the gatesMask bit of every gate and the regime codes are the documented ones", () => {
    expect(GATE_BITS).toEqual({
      CLOSED: 0x01,
      HALT: 0x02,
      "CORP-ACTION": 0x04,
      "STALE-REF": 0x08,
      "REOPEN-GUARD": 0x10,
      "BOUND-PINNED": 0x20,
      "WRAPPER-PREMIUM": 0x40,
      EVENT: 0x80,
    });
    expect(REGIME_CODE).toEqual({
      REGULAR: 1,
      EXTENDED: 2,
      OVERNIGHT: 3,
      WEEKEND_DARK: 4,
      HOLIDAY: 5,
    });
    expect(gatesMaskOfNames(["CLOSED", "STALE-REF"])).toBe(0x09);
    expect(gatesOfMask(0x09)).toEqual(["CLOSED", "STALE-REF"]);
    expect(gatesOfMask(0)).toEqual([]);
    for (const g of GATE_NAMES) expect(gatesOfMask(GATE_BITS[g])).toEqual([g]);
  });

  it("signal(Meta) encodes the announced state and round-trips through the lane ABI", () => {
    const ulid = createDecisionUlidFactory()(T0);
    const b = createCalldataBuilder(LANE);
    const meta = {
      decisionId: encodeDecisionId(ulid, 0),
      deadline: BigInt(T0 / 1000 + 45),
      regime: WEEKEND.regimeCode,
      gatesMask: WEEKEND.gatesMask | GATE_BITS["STALE-REF"],
      reasonHash: keccak256(stringToBytes("x")),
    };
    const call = b.encode({ kind: "signal", lane: "A", note: "gates" }, meta);
    expect(call).toMatchObject({ to: LANE, value: 0n, selector: OPERATOR_SELECTORS.signal });
    const decoded = b.decode(call.data);
    expect(decoded.functionName).toBe("signal");
    expect(decoded.args[0]).toEqual(meta);
    expect(() =>
      b.encode({ kind: "signal", lane: "A", note: "x" }, { ...meta, gatesMask: 1 << 16 }),
    ).toThrow(/gatesMask/);
  });
});

describe("the reasonHash preimage", () => {
  it("is canonical JSON {lane, from, to, at, source}, and keccak256 of it is the hash", () => {
    const p = signalPreimage({
      lane: "0xABCDEF0000000000000000000000000000000001" as Address,
      from: OPEN,
      to: WEEKEND,
      atMs: T0,
      source: "transition",
    });
    expect(p.json).toBe(
      `{"at":${T0},"from":{"gates":[],"regime":"REGULAR"},"lane":"0xabcdef0000000000000000000000000000000001","source":"transition","to":{"gates":["CLOSED"],"regime":"WEEKEND_DARK"}}`,
    );
    expect(p.hash).toBe(keccak256(stringToBytes(p.json)));
    expect(hashOfPreimage(p.json)).toBe(p.hash);
    // Round trip: the stored JSON alone reproduces the hash, and any field changes it.
    expect(hashOfPreimage(JSON.stringify(JSON.parse(p.json)))).toBe(p.hash);
    const initial = signalPreimage({
      lane: LANE,
      from: null,
      to: WEEKEND,
      atMs: T0,
      source: "initial",
    });
    expect(JSON.parse(initial.json).from).toBeNull();
    expect(
      signalPreimage({ lane: LANE, from: OPEN, to: WEEKEND, atMs: T0 + 1, source: "transition" })
        .hash,
    ).not.toBe(
      signalPreimage({ lane: LANE, from: OPEN, to: WEEKEND, atMs: T0, source: "transition" }).hash,
    );
  });

  it("the note names the change and never carries an address", () => {
    expect(signalNote(OPEN, WEEKEND)).toBe("gates none → CLOSED · REGULAR → WEEKEND_DARK");
    expect(signalNote(null, HALTED)).toBe("gates HALT · REGULAR (initial)");
    expect(signalNote(WEEKEND, st("WEEKEND_DARK", ["CLOSED", "HALT"]))).toBe(
      "gates CLOSED → CLOSED+HALT · WEEKEND_DARK",
    );
  });
});

describe("the transition detector", () => {
  it("announces a change once it held for the dwell, chained to the last emitted state", () => {
    const r = detectGateSignal(input());
    expect(r).toEqual({
      emit: true,
      initial: false,
      from: OPEN,
      to: WEEKEND,
      atMs: T0,
      source: "transition",
    });
  });

  it("the first state of a lane goes at once (no dwell); nothing while the startup hold lasts", () => {
    const first = input({ lastEmitted: null, latest: null, nowMs: T0 });
    expect(detectGateSignal(first)).toMatchObject({ emit: true, initial: true, from: null });
    expect(reasonOf({ ...first, settled: false })).toMatch(/startup hold/);
  });

  it("only the very first planned signal skips the dwell: a denied or lost first one does not", () => {
    // The lane's first signal (OPEN) was denied an hour ago; nothing is on-chain yet.
    for (const status of ["declined", "failed", "not_sent"] as const) {
      const after = input({
        lastEmitted: null,
        latest: { toKey: signalKey(OPEN), status, createdAtMs: T0 - 60 * MIN },
        nowMs: T0 + 5_000, // WEEKEND held 5 s
      });
      expect(reasonOf(after)).toMatch(/held 5 s < 60 s dwell/);
      // Once it held the dwell it goes, still as the lane's initial announcement (from null).
      expect(detectGateSignal({ ...after, nowMs: T0 + MIN })).toMatchObject({
        emit: true,
        initial: true,
        from: null,
        source: "initial",
      });
    }
  });

  it("flapping: a state younger than the dwell is not announced", () => {
    expect(reasonOf(input({ nowMs: T0 + 59_000 }))).toMatch(/held 59 s < 60 s dwell/);
    expect(detectGateSignal(input({ nowMs: T0 + MIN })).emit).toBe(true);
  });

  it("a state already on-chain is never re-announced (the restart case)", () => {
    expect(reasonOf(input({ lastEmitted: { toKey: signalKey(WEEKEND), state: WEEKEND } }))).toMatch(
      /already on-chain/,
    );
  });

  it("rate limit: at most maxPerHour signed signals per rolling hour", () => {
    expect(reasonOf(input({ signed1h: 6 }))).toMatch(/rate limit/);
    expect(detectGateSignal(input({ signed1h: 5 })).emit).toBe(true);
    expect(reasonOf(input({ maxPerHour: 0 }))).toMatch(/rate limit/);
  });

  it("one per transition: denied or signed-but-lost is final for that state; unsigned retries later", () => {
    const latest = (status: "declined" | "failed" | "not_sent", createdAtMs = T0 + MIN) => ({
      toKey: signalKey(WEEKEND),
      status,
      createdAtMs,
    });
    expect(reasonOf(input({ latest: latest("declined"), nowMs: T0 + 99 * MIN }))).toMatch(
      /declined/,
    );
    expect(reasonOf(input({ latest: latest("failed"), nowMs: T0 + 99 * MIN }))).toMatch(
      /did not land/,
    );
    expect(reasonOf(input({ latest: latest("not_sent"), nowMs: T0 + 2 * MIN }))).toMatch(
      /retry in 540 s/,
    );
    expect(detectGateSignal(input({ latest: latest("not_sent"), nowMs: T0 + 11 * MIN })).emit).toBe(
      true,
    );
    // A denied OTHER state does not block this one.
    expect(
      detectGateSignal(input({ latest: { ...latest("declined"), toKey: signalKey(HALTED) } })).emit,
    ).toBe(true);
  });

  it("a state left (held elsewhere for the dwell) and re-entered is asked afresh; a flap is not", () => {
    // WEEKEND's signal was planned (then denied / reverted / not sent) 2 h ago. Since, the lane
    // held OPEN for the dwell (it ended at T0) and entered WEEKEND again at T0.
    const planned = T0 - 120 * MIN;
    const back = { key: signalKey(WEEKEND), sinceMs: T0, settled: true };
    for (const status of ["declined", "failed", "not_sent"] as const) {
      const again = input({
        watch: { ...back, away: { key: signalKey(OPEN), endMs: T0 } },
        latest: { toKey: signalKey(WEEKEND), status, createdAtMs: planned },
      });
      expect(detectGateSignal(again)).toMatchObject({ emit: true, from: OPEN, atMs: T0 });
      // Still flap-protected: the new run must hold the dwell.
      expect(reasonOf({ ...again, nowMs: T0 + 30_000 })).toMatch(/dwell/);
      // The last state really held was WEEKEND itself (the excursion was a flap): same run.
      const flap = { ...again, watch: { ...back, away: { key: signalKey(WEEKEND), endMs: T0 } } };
      // A state this process only FOUND at startup (nothing held and left since): same run, a
      // restart never re-asks it.
      const found = { ...again, watch: { ...back, away: null } };
      // Held elsewhere, but before the signal was planned: same run.
      const before = {
        ...again,
        watch: { ...back, away: { key: signalKey(OPEN), endMs: planned - 1 } },
      };
      for (const same of [flap, found, before]) {
        // An unsent one is still retried once its window passed (here it has).
        expect(detectGateSignal({ ...same, nowMs: T0 + 5 * MIN }).emit).toBe(status === "not_sent");
      }
    }
  });

  it("never interleaves: a pending or in-flight signal, or any tx in flight, waits", () => {
    expect(
      reasonOf(input({ latest: { toKey: signalKey(HALTED), status: "pending", createdAtMs: T0 } })),
    ).toMatch(/pending/);
    expect(
      reasonOf(input({ latest: { toKey: signalKey(HALTED), status: "sent", createdAtMs: T0 } })),
    ).toMatch(/in flight/);
    expect(reasonOf(input({ inFlight: 1 }))).toMatch(/in flight/);
  });

  it("off, or a halted desk: nothing", () => {
    expect(reasonOf(input({ enabled: false }))).toMatch(/DESK_SIGNAL_GATES=0/);
    expect(reasonOf(input({ halted: "desk is revoked" }))).toMatch(/revoked/);
  });

  it("watchState keeps the start of an unbroken state and restarts it on any change", () => {
    const w0 = watchState(null, OPEN, T0, true, MIN);
    expect(w0).toEqual({ key: signalKey(OPEN), sinceMs: T0, settled: true, away: null });
    expect(watchState(w0, OPEN, T0 + MIN, true, MIN)).toBe(w0);
    // OPEN held for the dwell, then left: it becomes the state the lane was really away in.
    const w1 = watchState(w0, WEEKEND, T0 + MIN, true, MIN);
    expect(w1).toEqual({
      key: signalKey(WEEKEND),
      sinceMs: T0 + MIN,
      settled: true,
      away: { key: signalKey(OPEN), endMs: T0 + MIN },
    });
    // A flap (HALTED for 5 s) does not replace it.
    const w2 = watchState(w1, HALTED, T0 + 2 * MIN, true, MIN);
    expect(w2.away).toEqual({ key: signalKey(WEEKEND), endMs: T0 + 2 * MIN });
    const w3 = watchState(w2, WEEKEND, T0 + 2 * MIN + 5_000, true, MIN);
    expect(w3.away).toEqual({ key: signalKey(WEEKEND), endMs: T0 + 2 * MIN });
  });

  it("watchState: the startup hold is never a state the lane was away in", () => {
    const hold = watchState(null, HALTED, T0, false, MIN); // startup posture
    const found = watchState(hold, OPEN, T0 + 10 * MIN, true, MIN);
    expect(found).toMatchObject({ sinceMs: T0 + 10 * MIN, away: null });
    // The hold's key may equal the real state's: it only becomes settled, same run.
    const same = watchState(hold, HALTED, T0 + MIN, true, MIN);
    expect(same).toMatchObject({ sinceMs: T0, settled: true, away: null });
  });

  it("the gate machine's startup hold is not a settled state", () => {
    const m = createGateMachine();
    const s0 = m.initial(T0);
    expect(gatesSettled(s0)).toBe(false);
    let s = s0;
    for (let i = 1; i <= 3; i++) {
      s = m.step(
        s,
        GATE_NAMES.map((gate) => ({ gate, triggered: false, reason: "clear" })),
        T0 + i * 5_000,
      ).next;
    }
    expect(gatesSettled(s)).toBe(true);
    // A gate that is really triggered replaces the startup reason at once: settled.
    const held = m.step(
      s0,
      GATE_NAMES.map((gate) => ({ gate, triggered: true, reason: "real" })),
      T0 + 5_000,
    ).next;
    expect(gatesSettled(held)).toBe(true);
  });
});

describe("gate_signals in the DB: status, restart persistence, immutability", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ids = createDecisionUlidFactory();

  function decisionRow(id: string, at: number, over: Partial<DecisionRow> = {}): DecisionRow {
    return {
      decisionId: id,
      laneAddress: LANE,
      lane: "A",
      createdAtMs: at,
      updatedAtMs: at,
      regime: "WEEKEND_DARK",
      regimeCode: 4,
      gatesMask: 1,
      riskMode: "reduce_only",
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
      status: "observed",
      statusDetail: null,
      ...over,
    };
  }

  function plant(
    db: ReturnType<typeof memDb>,
    at: number,
    to: SignalState,
    from: SignalState | null,
  ) {
    const id = ids(at);
    const pre = signalPreimage({
      lane: LANE,
      from,
      to,
      atMs: at,
      source: from === null ? "initial" : "transition",
    });
    db.insertDecision(decisionRow(id, at));
    db.insertGateSignal({
      decisionId: id,
      laneAddress: LANE,
      onchainId: encodeDecisionId(id, 0),
      initial: from === null,
      fromKey: from === null ? null : signalKey(from),
      toKey: signalKey(to),
      toRegime: to.regime,
      regimeCode: to.regimeCode,
      gatesMask: to.gatesMask,
      gatesJson: JSON.stringify(to.gates),
      atMs: at,
      reasonHash: pre.hash,
      preimageJson: pre.json,
      createdAtMs: at,
    });
    return id;
  }

  function sign(
    db: ReturnType<typeof memDb>,
    id: string,
    at: number,
    status: "confirmed" | "unknown" | "reverted",
  ) {
    const executionId = db.insertExecution({
      decisionId: id,
      stepIndex: 0,
      onchainId: encodeDecisionId(id, 0),
      laneAddress: LANE,
      venue: "rh",
      action: "signal",
      riskClass: "neutral",
      notionalCents: 0,
      signerAddress: OPERATOR,
      status: "prepared",
      createdAtMs: at,
      updatedAtMs: at,
    });
    const txHash = keccak256(stringToBytes(id)) as Hex;
    db.recordSignedAttempt(
      {
        executionId,
        attempt: 1,
        signerKind: "local",
        fromAddress: OPERATOR,
        toAddress: LANE,
        calldataHash: txHash,
        nonce: 0,
        gasLimit: 100_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 0n,
        deadlineSec: at / 1000 + 45,
        signedRawTx: "0x02",
        txHash,
        simJson: null,
        createdAtMs: at,
      },
      at,
    );
    db.updateExecution(executionId, { status, txHash, updatedAtMs: at });
  }

  it("derives each status from its decision and execution", () => {
    expect(gateSignalStatus("observed", null, null, null)).toBe("pending");
    expect(gateSignalStatus("executing", null, "simulated", null)).toBe("pending");
    expect(gateSignalStatus("executing", null, "signed", 1)).toBe("sent");
    expect(gateSignalStatus("executing", null, "unknown", 1)).toBe("sent");
    expect(gateSignalStatus("executed", null, "confirmed", 1)).toBe("confirmed");
    expect(gateSignalStatus("failed", null, "reverted", 1)).toBe("failed");
    expect(gateSignalStatus("failed", null, "dropped", 1)).toBe("failed");
    expect(gateSignalStatus("failed", null, "dropped", 1, 0)).toBe("not_sent"); // never left
    // Broadcast, then expired unmined (the resolver's DEADLINE_PASSED): it never reached the chain.
    expect(gateSignalStatus("failed", null, "dropped", 1, 1, "DEADLINE_PASSED")).toBe("not_sent");
    expect(gateSignalStatus("failed", null, "dropped", 1, 1, "NONCE_CONFLICT")).toBe("failed");
    expect(gateSignalStatus("failed", null, "reverted", 1, 0)).toBe("failed");
    expect(gateSignalStatus("declined", "denied", null, null)).toBe("declined");
    expect(gateSignalStatus("declined", "timeout", null, null)).toBe("not_sent");
    expect(gateSignalStatus("dry_run", null, null, null)).toBe("not_sent");
    expect(gateSignalStatus("blocked", null, null, null)).toBe("not_sent");
    expect(gateSignalStatus("failed", null, "failed", null)).toBe("not_sent");
  });

  it("the last EMITTED signal survives a restart; the hourly count reads signed signal() rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-signal-"));
    dirs.push(dir);
    const path = join(dir, "desk.sqlite");
    const db = openDb(path);
    const a = plant(db, T0, OPEN, null);
    sign(db, a, T0, "confirmed");
    const b = plant(db, T0 + 10 * MIN, WEEKEND, OPEN);
    sign(db, b, T0 + 10 * MIN, "reverted"); // signed, never recorded on-chain
    const c = plant(db, T0 + 20 * MIN, HALTED, OPEN);
    db.updateDecision(c, { status: "dry_run", updatedAtMs: T0 + 20 * MIN });
    db.close();

    const again = openDb(path);
    expect(again.lastEmittedGateSignal(LANE)).toMatchObject({
      decisionId: a,
      status: "confirmed",
      toKey: signalKey(OPEN),
    });
    expect(again.recentGateSignals(LANE, 5).map((g) => [g.decisionId, g.status])).toEqual([
      [c, "not_sent"],
      [b, "failed"],
      [a, "confirmed"],
    ]);
    expect(again.countSignedSignals(LANE, T0)).toBe(2);
    expect(again.countSignedSignals(LANE, T0 + 5 * MIN)).toBe(1);
    const g = again.getGateSignal(b);
    expect(g?.onchainId).toBe(encodeDecisionId(b, 0));
    expect(hashOfPreimage(g?.preimageJson ?? "")).toBe(g?.reasonHash);
    again.close();
  });

  it("a signal broadcast but expired unmined (DEADLINE_PASSED) reads not_sent; a consumed nonce stays failed", () => {
    const db = memDb();
    const drop = (at: number, errorCode: "DEADLINE_PASSED" | "NONCE_CONFLICT") => {
      const id = plant(db, at, WEEKEND, OPEN);
      sign(db, id, at, "unknown");
      const exec = db.getExecutionByStep(id, 0);
      if (exec === null) throw new Error("no execution");
      db.markAttemptBroadcast(keccak256(stringToBytes(id)) as Hex, at + 1);
      db.updateExecution(exec.executionId, {
        status: "dropped",
        errorCode,
        finalizedAtMs: at + 2,
        updatedAtMs: at + 2,
      });
      return id;
    };
    const expired = drop(T0, "DEADLINE_PASSED");
    const conflict = drop(T0 + MIN, "NONCE_CONFLICT");
    expect(db.getGateSignal(expired)?.status).toBe("not_sent");
    expect(db.getGateSignal(conflict)?.status).toBe("failed");
    expect(db.lastEmittedGateSignal(LANE)).toBeNull();
  });

  it("rows are append-only and immutable: the preimage proves an on-chain hash", () => {
    const db = memDb();
    const id = plant(db, T0, OPEN, null);
    expect(() =>
      db.sqlite
        .prepare("UPDATE gate_signals SET preimage_json = '{}' WHERE decision_id = ?")
        .run(id),
    ).toThrow(/immutable/);
    expect(() =>
      db.sqlite.prepare("DELETE FROM gate_signals WHERE decision_id = ?").run(id),
    ).toThrow(/append-only/);
  });
});

describe("the executor's desk probe", () => {
  it("a halted desk sends no signal (neutral), but a risk-reducing step still goes", () => {
    for (const status of ["safe_mode", "revoked", "disabled"] as const) {
      expect(deskHaltedReason(() => status, LANE, "neutral")).toBe(`desk is ${status}`);
      expect(deskHaltedReason(() => status, LANE, "reducing")).toBeNull();
    }
    expect(deskHaltedReason(() => null, LANE, "neutral")).toMatch(/no desk row/);
    expect(deskHaltedReason(() => "active", LANE, "neutral")).toBeNull();
  });
});
