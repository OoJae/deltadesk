import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/state/db.js";
import { LATEST_SCHEMA_VERSION } from "../../src/state/migrations.js";
import type {
  Address,
  DecisionRow,
  DeskDb,
  Hex,
  NewExecution,
  NewTxAttempt,
  TickRow,
} from "../../src/types.js";
import { LANE, memDb, OPERATOR, OWNER } from "../helpers/fakes.js";

const T0 = 1_758_470_400_000;
const ULID_A = "01K5HZ3N8QW0000000000000AA";
const ULID_B = "01K5HZ3N8QW0000000000000BB";
const onchain = (ulid: string, step: number): Hex =>
  `0x${ulid.toLowerCase().padEnd(32, "0").slice(0, 32)}01${step.toString(16).padStart(2, "0")}${"0".repeat(28)}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

function decision(id: string, partial: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: id,
    laneAddress: LANE,
    lane: "A",
    createdAtMs: T0,
    updatedAtMs: T0,
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
    ...partial,
  };
}

function execution(
  decisionId: string,
  step: number,
  partial: Partial<NewExecution> = {},
): NewExecution {
  return {
    decisionId,
    stepIndex: step,
    onchainId: onchain(decisionId, step),
    laneAddress: LANE,
    venue: "rh",
    action: "rerange",
    riskClass: "adding",
    notionalCents: 5000,
    signerAddress: OPERATOR,
    status: "prepared",
    createdAtMs: T0,
    updatedAtMs: T0,
    ...partial,
  };
}

function attempt(
  executionId: number,
  n: number,
  partial: Partial<NewTxAttempt> = {},
): NewTxAttempt {
  return {
    executionId,
    attempt: n,
    signerKind: "local",
    fromAddress: OPERATOR,
    toAddress: LANE,
    calldataHash: hash(99),
    nonce: 7,
    gasLimit: 1_000_000n,
    maxFeePerGas: 200_000_000n,
    maxPriorityFeePerGas: 0n,
    deadlineSec: 1_758_470_445,
    signedRawTx: "0x02f8deadbeef",
    txHash: hash(n),
    simJson: null,
    createdAtMs: T0,
    ...partial,
  };
}

function seedSigned(
  db: DeskDb,
  id: string,
  step: number,
  signedAt: number,
  partial: Partial<NewExecution> = {},
): number {
  const execId = db.insertExecution(execution(id, step, partial));
  db.recordSignedAttempt(attempt(execId, 1, { txHash: hash(1000 + execId) }), signedAt);
  return execId;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("schema", () => {
  it("migrates a fresh database to v5 with WAL on a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-db-"));
    dirs.push(dir);
    const db = openDb(join(dir, "nested", "desk.sqlite"));
    expect(db.schemaVersion()).toBe(5);
    expect(LATEST_SCHEMA_VERSION).toBe(5);
    expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("upgrades v1 → v5 without losing rows, and refuses a newer schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-db-"));
    dirs.push(dir);
    const path = join(dir, "desk.sqlite");
    const v1 = openDb(path, { migrateTo: 1 });
    expect(v1.schemaVersion()).toBe(1);
    v1.insertDecision(decision(ULID_A));
    v1.close();
    const v5 = openDb(path);
    expect(v5.schemaVersion()).toBe(5);
    expect(v5.getDecision(ULID_A)?.status).toBe("executing");
    v5.close();
    const raw = new Database(path);
    raw.pragma("user_version = 6");
    raw.close();
    expect(() => openDb(path)).toThrow(/newer than this code/);
  });
});

describe("constraints", () => {
  it("rejects statuses, actions and risk classes outside the contract", () => {
    const db = memDb();
    expect(() => db.insertDecision(decision(ULID_A, { status: "withdrawn" as never }))).toThrow(
      /CHECK/,
    );
    db.insertDecision(decision(ULID_A));
    expect(() => db.insertExecution(execution(ULID_A, 0, { action: "withdraw" as never }))).toThrow(
      /CHECK/,
    );
    expect(() => db.insertExecution(execution(ULID_A, 0, { riskClass: "yolo" as never }))).toThrow(
      /CHECK/,
    );
    expect(() => db.insertExecution(execution(ULID_A, 0, { status: "signed" }))).toThrow(
      /written ahead as 'prepared'/,
    );
    expect(() =>
      db.insertExecution(execution(ULID_A, 0, { venue: "rh", onchainId: null })),
    ).toThrow(/CHECK/);
  });

  it("enforces idempotency: one execution per (decision, step) and per on-chain id", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A));
    db.insertExecution(execution(ULID_A, 0));
    expect(() => db.insertExecution(execution(ULID_A, 0))).toThrow(/UNIQUE/);
    expect(() =>
      db.insertExecution(execution(ULID_A, 1, { onchainId: onchain(ULID_A, 0) })),
    ).toThrow(/UNIQUE/);
    expect(db.hasExecutionStep(ULID_A, 0)).toBe(true);
    expect(db.hasExecutionStep(ULID_A, 1)).toBe(false);
    expect(() => db.insertExecution(execution(ULID_B, 0))).toThrow(/FOREIGN KEY/);
  });

  it("stores addresses lowercase and rejects malformed ones", () => {
    const db = memDb();
    db.insertDecision(
      decision(ULID_A, { laneAddress: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" }),
    );
    expect(db.getDecision(ULID_A)?.laneAddress).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(db.recentDecisions(5, "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD")).toHaveLength(1);
    expect(() => db.insertDecision(decision(ULID_B, { laneAddress: "0x12" as Address }))).toThrow(
      /CHECK/,
    );
  });

  it("refuses a desk whose operator is its owner", () => {
    const db = memDb();
    const desk = {
      laneAddress: LANE,
      chainId: 4663,
      laneId: 0,
      owner: OWNER,
      operator: OWNER,
      ownerUserId: null,
      signerKind: "dynamic-delegated" as const,
      mode: "advisory" as const,
      modeNonce: 0,
      status: "registered" as const,
      statusDetail: null,
      capsJson: "{}",
      createdAtMs: T0,
      updatedAtMs: T0,
    };
    expect(() => db.insertDesk(desk)).toThrow(/CHECK/);
    db.insertDesk({ ...desk, operator: OPERATOR });
    expect(db.getDesk(LANE)?.operator).toBe(OPERATOR);
    expect(db.setDeskMode(LANE, "copilot", 1, T0 + 1)).toBe(true);
    expect(db.setDeskMode(LANE, "autopilot", 1, T0 + 2)).toBe(false); // replayed nonce
    expect(db.setDeskMode(LANE, "advisory", 0, T0 + 3)).toBe(false);
    expect(db.getDesk(LANE)).toMatchObject({ mode: "copilot", modeNonce: 1 });
    db.setDeskStatus(LANE, "safe_mode", "foreign LaneAction", T0 + 4);
    expect(db.getDesk(LANE)).toMatchObject({
      status: "safe_mode",
      statusDetail: "foreign LaneAction",
    });
    expect(db.listDesks()).toHaveLength(1);
  });
});

describe("write-ahead signing", () => {
  it("records the signed bytes and marks the execution signed in one transaction", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A));
    const id = db.insertExecution(execution(ULID_A, 0));
    expect(db.inFlightCount(OPERATOR)).toBe(1);
    const attemptId = db.recordSignedAttempt(attempt(id, 1), T0 + 10);
    expect(attemptId).toBeGreaterThan(0);
    expect(db.getExecution(id)).toMatchObject({
      status: "signed",
      signedAtMs: T0 + 10,
      txHash: hash(1),
    });
    expect(db.getAttemptByHash(hash(1))).toMatchObject({
      status: "signed",
      nonce: 7,
      gasLimit: 1_000_000n,
    });
    db.markAttemptBroadcast(hash(1), T0 + 20);
    db.markAttemptBroadcast(hash(1), T0 + 30);
    expect(db.getAttemptByHash(hash(1))).toMatchObject({
      status: "broadcast",
      broadcastCount: 2,
      broadcastAtMs: T0 + 20,
    });
    expect(db.getExecution(id)?.status).toBe("broadcast");
    expect(db.unresolvedAttempts()).toHaveLength(1);
  });

  it("rolls back both halves when the attempt cannot be stored", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A));
    const first = db.insertExecution(execution(ULID_A, 0));
    const second = db.insertExecution(execution(ULID_A, 1));
    db.recordSignedAttempt(attempt(first, 1), T0);
    expect(() => db.recordSignedAttempt(attempt(second, 1), T0)).toThrow(/UNIQUE/); // same tx hash
    expect(db.getExecution(second)).toMatchObject({ status: "prepared", signedAtMs: null });
  });

  it("refuses a signature for a finished execution or from another signer", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A));
    const id = db.insertExecution(execution(ULID_A, 0));
    expect(() =>
      db.recordSignedAttempt(
        attempt(id, 1, { fromAddress: "0x9999999999999999999999999999999999999999" }),
        T0,
      ),
    ).toThrow(/differs from execution signer/);
    db.updateExecution(id, { status: "failed", updatedAtMs: T0 });
    expect(() => db.recordSignedAttempt(attempt(id, 1), T0)).toThrow(
      /refusing to record a new signature/,
    );
  });

  it("makes signed executions and signed bytes immutable and append-only", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A));
    const id = seedSigned(db, ULID_A, 0, T0);
    expect(() => db.updateExecution(id, { signedAtMs: null })).toThrow(/immutable/);
    expect(() => db.updateExecution(id, { notionalCents: 1 })).toThrow(/immutable/);
    expect(() => db.updateExecution(id, { riskClass: "reducing" })).toThrow(/immutable/);
    db.updateExecution(id, { status: "confirmed", finalizedAtMs: T0 + 5, updatedAtMs: T0 + 5 });
    expect(() => db.sqlite.prepare("DELETE FROM executions").run()).toThrow(/append-only/);
    expect(() => db.sqlite.prepare("DELETE FROM decisions").run()).toThrow(/append-only/);
    const h = hash(1000 + id);
    expect(() =>
      db.sqlite.prepare("UPDATE tx_attempts SET signed_raw_tx = '0x00' WHERE tx_hash = ?").run(h),
    ).toThrow(/immutable/);
    expect(() =>
      db.sqlite.prepare("UPDATE tx_attempts SET nonce = 8 WHERE tx_hash = ?").run(h),
    ).toThrow(/immutable/);
    expect(() => db.updateTxAttempt(h, { signedRawTx: "0x00" } as never)).toThrow(/immutable/);
    db.updateTxAttempt(h, {
      status: "confirmed",
      gasUsed: 812_345n,
      blockNumber: 99,
      updatedAtMs: T0 + 5,
    });
    expect(db.getAttemptByHash(h)).toMatchObject({ status: "confirmed", gasUsed: 812_345n });
    expect(() => db.sqlite.prepare("DELETE FROM tx_attempts").run()).toThrow(/append-only/);
  });

  it("finds attempts regardless of hash case", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A));
    const id = db.insertExecution(execution(ULID_A, 0));
    const upper = `0x${"AB".repeat(32)}` as Hex;
    db.recordSignedAttempt(attempt(id, 1, { txHash: upper }), T0);
    expect(db.getAttemptByHash(`0x${"ab".repeat(32)}`)).not.toBeNull();
    expect(
      db.getExecutionByOnchainId(onchain(ULID_A, 0).toUpperCase().replace("0X", "0x") as Hex)
        ?.executionId,
    ).toBe(id);
  });
});

describe("turnover and rates (fail-closed)", () => {
  it("counts every ADDING execution with a signature, whatever its status", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A));
    const dropped = seedSigned(db, ULID_A, 0, T0, { notionalCents: 1000 });
    db.updateExecution(dropped, { status: "dropped", updatedAtMs: T0 });
    const reverted = seedSigned(db, ULID_A, 1, T0 + 1, { notionalCents: 2000 });
    db.updateExecution(reverted, { status: "reverted", updatedAtMs: T0 });
    seedSigned(db, ULID_A, 2, T0 + 2, {
      notionalCents: 3000,
      riskClass: "reducing",
      action: "exitAll",
    });
    db.insertExecution(execution(ULID_A, 3, { notionalCents: 4000 })); // prepared: never signed
    expect(db.turnoverCentsSince(LANE, T0)).toBe(3000);
    expect(db.turnoverCentsSince(LANE, T0 + 1)).toBe(2000);
    expect(db.countSignedAddingReranges(LANE, T0)).toBe(2);
    expect(db.lastSignedAddingRerangeAt(LANE)).toBe(T0 + 1);
    expect(db.inFlightCount(OPERATOR)).toBe(2); // the reducing one is 'signed', the last one 'prepared'
    expect(db.pendingExecutionsCount()).toBe(2);
  });
});

describe("crash recovery", () => {
  it("fails unsigned rows and resolves stranded decisions from their executions", () => {
    const db = memDb();
    const ids = [
      "01K5HZ3N8QW00000000000000A",
      "01K5HZ3N8QW00000000000000B",
      "01K5HZ3N8QW00000000000000C",
      "01K5HZ3N8QW00000000000000D",
      "01K5HZ3N8QW00000000000000E",
    ];
    for (const id of ids) db.insertDecision(decision(id));
    // A: all confirmed → executed
    const a = seedSigned(db, ids[0] as string, 0, T0);
    db.updateExecution(a, { status: "confirmed", updatedAtMs: T0 });
    // B: one confirmed, one failed → partially_executed
    const b0 = seedSigned(db, ids[1] as string, 0, T0);
    db.updateExecution(b0, { status: "confirmed", updatedAtMs: T0 });
    db.insertExecution(execution(ids[1] as string, 1)); // prepared, crash before sign
    // C: crashed after sign (broadcast) → stays executing for the reconciler
    const c = seedSigned(db, ids[2] as string, 0, T0);
    db.markAttemptBroadcast(hash(1000 + c), T0);
    // D: no executions at all → failed
    // E: reverted → failed
    const e = seedSigned(db, ids[4] as string, 0, T0);
    db.updateExecution(e, { status: "reverted", updatedAtMs: T0 });

    expect(db.failUnsignedExecutions("crashed before sign", T0 + 1)).toBe(1);
    expect(db.reconcileOrphanedDecisions(T0 + 2)).toBe(4);
    expect(db.getDecision(ids[0] as string)?.status).toBe("executed");
    expect(db.getDecision(ids[1] as string)?.status).toBe("partially_executed");
    expect(db.getDecision(ids[2] as string)?.status).toBe("executing");
    expect(db.getDecision(ids[3] as string)?.status).toBe("failed");
    expect(db.getDecision(ids[4] as string)?.status).toBe("failed");
    expect(db.decisionsByStatus(["executing"]).map((d) => d.decisionId)).toEqual([ids[2]]);
    expect(db.decisionsByStatus([])).toEqual([]);
    expect(db.recentExecutions(2).map((x) => x.executionId)).toEqual([e, c]);
    expect(db.recentExecutions(10, LANE)).toHaveLength(5);
    expect(db.executionsByStatus(["broadcast"])).toHaveLength(1);
  });
});

describe("nonces", () => {
  it("advance monotonically and reset explicitly", () => {
    const db = memDb();
    expect(db.getNonceState(OPERATOR)).toBeNull();
    expect(db.advanceNonce(OPERATOR, 4663, 5, T0)).toBe(5);
    expect(db.advanceNonce(OPERATOR, 4663, 3, T0 + 1)).toBe(5);
    expect(
      db.advanceNonce(OPERATOR.toUpperCase().replace("0X", "0x") as Address, 4663, 6, T0 + 2),
    ).toBe(6);
    db.resetNonce(OPERATOR, 4663, 4, T0 + 3);
    expect(db.getNonceState(OPERATOR)?.lastNonce).toBe(4);
  });
});

describe("approvals", () => {
  it("answer only while pending and before expiry; the first answer wins", () => {
    const db = memDb();
    db.createApproval({
      decisionId: ULID_A,
      laneAddress: LANE,
      summary: "rerange $50",
      requestedAtMs: T0,
      expiresAtMs: T0 + 120_000,
    });
    db.createApproval({
      decisionId: ULID_A,
      laneAddress: LANE,
      summary: "dup",
      requestedAtMs: T0,
      expiresAtMs: T0 + 1,
    });
    expect(db.getApproval(ULID_A)?.summary).toBe("rerange $50");
    expect(db.pendingApprovals(LANE, T0 + 1)).toHaveLength(1);
    expect(db.respondApproval(ULID_A, true, "web", "0xowner", T0 + 10)).toBe(true);
    expect(db.respondApproval(ULID_A, false, "telegram", "bob", T0 + 11)).toBe(false);
    expect(db.getApproval(ULID_A)).toMatchObject({
      status: "approved",
      channel: "web",
      respondedBy: "0xowner",
    });

    db.createApproval({
      decisionId: ULID_B,
      laneAddress: LANE,
      summary: "late",
      requestedAtMs: T0,
      expiresAtMs: T0 + 100,
    });
    expect(db.respondApproval(ULID_B, true, "web", null, T0 + 100)).toBe(false); // expired
    expect(db.closeApproval(ULID_B, "expired", T0 + 101, "no answer")).toMatchObject({
      status: "expired",
      closeReason: "no answer",
    });
    expect(db.pendingApprovals(LANE, T0 + 1)).toHaveLength(0);
  });

  it("v3 → v4 keeps approval rows (close_reason starts null)", () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-db-"));
    dirs.push(dir);
    const path = join(dir, "desk.sqlite");
    const v3 = openDb(path, { migrateTo: 3 });
    v3.sqlite
      .prepare(
        "INSERT INTO approvals (decision_id, lane, summary, requested_at_ms, expires_at_ms, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      )
      .run(ULID_A, LANE, "rerange", T0, T0 + 120_000);
    v3.close();
    const v4 = openDb(path);
    expect(v4.getApproval(ULID_A)).toMatchObject({ status: "pending", closeReason: null });
    v4.close();
  });

  it("closeOrphanedApprovals: every pending row closes with a reason; its decision is declined", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A, { status: "observed", statusDetail: "awaiting approval" }));
    db.insertDecision(decision(ULID_B, { status: "observed", statusDetail: "awaiting approval" }));
    const ULID_C = "01K5HZ3N8QW0000000000000CC";
    db.insertDecision(decision(ULID_C, { status: "executing" }));
    for (const [id, expires] of [
      [ULID_A, T0 + 120_000], // still inside its window at the restart
      [ULID_B, T0 + 100], // already past it
      [ULID_C, T0 + 120_000],
    ] as const)
      db.createApproval({
        decisionId: id,
        laneAddress: LANE,
        summary: "rerange $50",
        requestedAtMs: T0,
        expiresAtMs: expires,
      });
    expect(db.respondApproval(ULID_C, true, "web", "0xowner", T0 + 1)).toBe(true); // answered
    const closed = db.closeOrphanedApprovals("restart", T0 + 1_000);
    expect(closed.map((a) => [a.decisionId, a.status, a.closeReason])).toEqual([
      [ULID_A, "cancelled", "restart"],
      [ULID_B, "expired", "restart"],
    ]);
    expect(db.getApproval(ULID_C)?.status).toBe("approved"); // an answered row is left alone
    expect(db.getDecision(ULID_A)).toMatchObject({
      status: "declined",
      approvalOutcome: "cancelled",
      statusDetail: "approval closed at startup: restart",
    });
    expect(db.getDecision(ULID_B)).toMatchObject({
      status: "declined",
      approvalOutcome: "timeout",
    });
    expect(db.getDecision(ULID_C)?.status).toBe("executing");
    // Nothing can answer them afterwards, inside the old window or not.
    expect(db.respondApproval(ULID_A, true, "web", "0xowner", T0 + 2_000)).toBe(false);
    expect(db.pendingApprovals(LANE, T0 + 2_000)).toEqual([]);
    expect(db.closeOrphanedApprovals("restart", T0 + 3_000)).toEqual([]);
  });

  it("closeOrphanedApprovals: a decision the dead process left observed with no open approval fails", () => {
    const db = memDb();
    const ULID_D = "01K5HZ3N8QW0000000000000DD"; // crashed while building: no approval row
    const ULID_E = "01K5HZ3N8QW0000000000000EE"; // answered, then the process died before settling
    const ULID_F = "01K5HZ3N8QW0000000000000FF"; // settled before: untouched
    db.insertDecision(decision(ULID_D, { status: "observed" }));
    db.insertDecision(decision(ULID_E, { status: "observed", statusDetail: "awaiting approval" }));
    db.insertDecision(decision(ULID_F, { status: "dry_run" }));
    db.createApproval({
      decisionId: ULID_E,
      laneAddress: LANE,
      summary: "signal",
      requestedAtMs: T0,
      expiresAtMs: T0 + 120_000,
    });
    expect(db.respondApproval(ULID_E, true, "web", "0xowner", T0 + 1)).toBe(true);
    expect(db.closeOrphanedApprovals("restart", T0 + 1_000)).toEqual([]);
    for (const id of [ULID_D, ULID_E]) {
      expect(db.getDecision(id)).toMatchObject({
        status: "failed",
        statusDetail:
          "the agent restarted before this decision settled; nothing was signed (restart)",
      });
    }
    expect(db.getDecision(ULID_F)?.status).toBe("dry_run");
  });
});

describe("webhook events and delegations", () => {
  it("dedupes on eventId but lets an unfinished event be processed again", () => {
    const db = memDb();
    const ev = {
      eventId: "evt_1",
      eventName: "wallet.delegation.created",
      receivedAtMs: T0,
      payloadSha256: "ab",
    };
    expect(db.recordWebhookEvent(ev)).toBe("new");
    expect(db.recordWebhookEvent(ev)).toBe("retry"); // never finished (e.g. we answered 5xx)
    db.finishWebhookEvent("evt_1", "failed", "db locked", T0 + 1);
    expect(db.recordWebhookEvent(ev)).toBe("retry");
    db.finishWebhookEvent("evt_1", "processed", null, T0 + 2);
    expect(db.recordWebhookEvent(ev)).toBe("duplicate");
    expect(db.getWebhookEvent("evt_1")?.status).toBe("processed");
  });

  it("stores delegated credentials sealed, nulls them on revoke, and re-activates", () => {
    const db = memDb();
    const row = {
      walletId: "w1",
      userId: "u1",
      accountAddress: OPERATOR,
      chain: "EVM",
      laneAddress: null,
      status: "active" as const,
      keyShareCt: "v1:ct1",
      apiKeyCt: "v1:ct2",
      dekWrapped: "v1:dek",
      kekId: "k1",
      createdEventId: "evt_created_1",
      revokedEventId: null,
      createdAtMs: T0,
      updatedAtMs: T0,
      revokedAtMs: null,
    };
    expect(() => db.upsertDelegation({ ...row, keyShareCt: null })).toThrow(/CHECK/);
    db.upsertDelegation(row);
    db.bindDelegationLane("w1", LANE, T0 + 1);
    expect(
      db.getActiveDelegationByAddress(OPERATOR.toUpperCase().replace("0X", "0x") as Address)
        ?.laneAddress,
    ).toBe(LANE);
    expect(db.revokeDelegation("w1", "evt_revoked_1", T0 + 2)).toBe(true);
    expect(db.revokeDelegation("w1", "evt_revoked_2", T0 + 3)).toBe(false);
    expect(db.getDelegation("w1")).toMatchObject({
      status: "revoked",
      keyShareCt: null,
      apiKeyCt: null,
      dekWrapped: null,
      revokedEventId: "evt_revoked_1",
    });
    expect(db.getActiveDelegationByAddress(OPERATOR)).toBeNull();
    db.upsertDelegation({
      ...row,
      createdEventId: "evt_created_2",
      keyShareCt: "v1:ct3",
      updatedAtMs: T0 + 4,
    });
    expect(db.getDelegation("w1")).toMatchObject({
      status: "active",
      keyShareCt: "v1:ct3",
      laneAddress: LANE,
      revokedEventId: null,
    });
    expect(db.listDelegationsByUser("u1")).toHaveLength(1);
  });

  it("revocations are recorded per event (idempotent, append-only); the latest event time wins", () => {
    const db = memDb();
    expect(db.latestDelegationRevocationAt("w-unknown")).toBeNull();
    db.recordDelegationRevocation({
      eventId: "evt_r1",
      walletId: "w-unknown",
      eventAtMs: T0 + 10,
      recordedAtMs: T0 + 11,
    });
    db.recordDelegationRevocation({
      eventId: "evt_r1",
      walletId: "w-unknown",
      eventAtMs: T0 + 99,
      recordedAtMs: T0 + 12,
    }); // a redelivery changes nothing
    expect(db.latestDelegationRevocationAt("w-unknown")).toBe(T0 + 10);
    db.recordDelegationRevocation({
      eventId: "evt_r2",
      walletId: "w-unknown",
      eventAtMs: T0 + 50,
      recordedAtMs: T0 + 51,
    });
    expect(db.latestDelegationRevocationAt("w-unknown")).toBe(T0 + 50);
    expect(() => db.sqlite.prepare("DELETE FROM delegation_revocations").run()).toThrow(
      /append-only/,
    );
  });

  it("purges active delegations never bound to a lane after the TTL, and only those", () => {
    const db = memDb();
    const base = {
      userId: "u1",
      chain: "EVM",
      status: "active" as const,
      keyShareCt: "v1:ct1",
      apiKeyCt: "v1:ct2",
      dekWrapped: "v1:dek",
      kekId: "k1",
      revokedEventId: null,
      updatedAtMs: T0,
      revokedAtMs: null,
    };
    db.upsertDelegation({
      ...base,
      walletId: "w-old",
      accountAddress: OWNER,
      laneAddress: null,
      createdEventId: "e1",
      createdAtMs: T0,
    });
    db.upsertDelegation({
      ...base,
      walletId: "w-bound",
      accountAddress: OPERATOR,
      laneAddress: LANE,
      createdEventId: "e2",
      createdAtMs: T0,
    });
    db.upsertDelegation({
      ...base,
      walletId: "w-new",
      accountAddress: "0x7777777777777777777777777777777777777777",
      laneAddress: null,
      createdEventId: "e3",
      createdAtMs: T0 + 5_000,
    });
    const purged = db.purgeUnboundDelegations(T0 + 1_000, T0 + 2_000);
    expect(purged.map((d) => d.walletId)).toEqual(["w-old"]);
    expect(db.getDelegation("w-old")).toMatchObject({ status: "revoked", keyShareCt: null });
    expect(db.getDelegation("w-bound")?.status).toBe("active");
    expect(db.getDelegation("w-new")?.status).toBe("active");
  });
});

describe("ticks, overlays, lane actions, HL, cursors, cache, cooldowns, server wallets", () => {
  const tick = (atMs: number, partial: Partial<TickRow> = {}): Omit<TickRow, "id"> => ({
    laneAddress: LANE,
    atMs,
    blockNumber: 1,
    blockTs: Math.floor(atMs / 1000),
    poolTick: 222_277,
    sqrtPriceX96: 5312783984510461862243962879021140n,
    poolMid: 222.4,
    hlMid: 220.1,
    k: 1.01,
    kSource: "engine",
    fairValue: 222.3,
    gapBps: -4.5,
    refTick: 222_280,
    bandTicks: 100,
    fenceCode: 0,
    regime: "REGULAR",
    reopenKind: null,
    sessionDate: "2026-09-21",
    gatesMask: 0,
    activeGatesJson: "[]",
    riskMode: "normal",
    sourcesJson: "{}",
    ...partial,
  });

  it("ticks: last tick, session samples, pruning", () => {
    const db = memDb();
    db.insertTick(tick(T0));
    db.insertTick(tick(T0 + 5_000, { hlMid: null }));
    db.insertTick(tick(T0 + 10_000, { regime: "EXTENDED" }));
    expect(db.lastTick(LANE)?.atMs).toBe(T0 + 10_000);
    expect(db.lastTick(LANE)?.sqrtPriceX96).toBe(5312783984510461862243962879021140n);
    expect(db.sessionTickSamples(LANE, "2026-09-21")).toEqual([
      { atMs: T0, poolMid: 222.4, hlMid: 220.1 },
    ]);
    expect(db.pruneTicks(T0 + 5_000)).toBe(1);
  });

  it("overlays: an applied overlay must have passed the tighten check", () => {
    const db = memDb();
    const base = {
      overlayId: "ov1",
      decisionId: ULID_A,
      laneAddress: LANE,
      createdAtMs: T0,
      source: "llm" as const,
      proposalJson: "{}",
      criticVerdict: "APPROVE" as const,
      criticReason: "tighter",
      tightenOk: false,
      tightenDetail: "loosens notional",
      applied: true,
      raw: "{}",
      error: null,
    };
    expect(() => db.insertOverlay(base)).toThrow(/CHECK/);
    db.insertOverlay({ ...base, applied: false });
    expect(db.getOverlay("ov1")).toMatchObject({ tightenOk: false, applied: false });
  });

  it("lane actions: dedupe on (tx, log index) and record matches", () => {
    const db = memDb();
    db.insertDecision(decision(ULID_A));
    const execId = seedSigned(db, ULID_A, 0, T0);
    const la = {
      txHash: hash(5),
      logIndex: 3,
      laneAddress: LANE,
      blockNumber: 100,
      blockTs: 1_758_470_400,
      decisionId: onchain(ULID_A, 0),
      action: 0,
      actionName: "RERANGE",
      ticksJson: "[222170,222380]",
      refPxE18: 222_390_000_000_000_000_000n,
      regime: 1,
      gatesMask: 0,
      reasonHash: hash(6),
      caller: OPERATOR,
      matchedExecutionId: null,
      matchStatus: "pending" as const,
      seenAtMs: T0,
      matchedAtMs: null,
    };
    expect(db.insertLaneAction(la)).toBe(true);
    expect(db.insertLaneAction(la)).toBe(false);
    expect(() => db.setLaneActionMatch(hash(5), 3, "matched", null, T0)).toThrow(/CHECK/);
    db.setLaneActionMatch(hash(5), 3, "matched", execId, T0 + 1);
    expect(db.recentLaneActions(LANE, 5)[0]).toMatchObject({
      matchStatus: "matched",
      matchedExecutionId: execId,
      refPxE18: 222_390_000_000_000_000_000n,
    });
    expect(db.laneActionsByMatch("pending")).toHaveLength(0);
  });

  it("HL: orders and deduped fills", () => {
    const db = memDb();
    const cloid = "0x0123456789abcdef0123456789abcdef" as Hex;
    db.insertHlOrder({
      cloid,
      decisionId: null,
      stepIndex: null,
      executionId: null,
      laneAddress: null,
      coin: "xyz:NVDA",
      asset: 110002,
      isBuy: false,
      sz: "0.1",
      px: "222.5",
      tif: "Alo",
      reduceOnly: false,
      mode: "paper",
      status: "open",
      oid: null,
      filledSz: "0",
      avgPx: null,
      createdAtMs: T0,
      updatedAtMs: T0,
      responseJson: null,
    });
    const fill = {
      cloid,
      tid: "t1",
      coin: "xyz:NVDA",
      px: "222.5",
      sz: "0.1",
      side: "A" as const,
      feeUsd: null,
      timeMs: T0,
      paper: true,
      rawJson: null,
    };
    expect(db.insertHlFill(fill)).toBe(true);
    expect(db.insertHlFill(fill)).toBe(false);
    expect(db.openHlOrders("paper")).toHaveLength(1);
    db.updateHlOrder(cloid, {
      status: "filled",
      filledSz: "0.1",
      avgPx: "222.5",
      updatedAtMs: T0 + 1,
    });
    expect(db.openHlOrders("paper")).toHaveLength(0);
    expect(db.getHlOrder(cloid)?.isBuy).toBe(false);
    expect(db.hlFillsForOrder(cloid)).toHaveLength(1);
    expect(db.hlFillsByCoin("xyz:NVDA", true)).toHaveLength(1);
    expect(db.hlFillsByCoin("xyz:NVDA", false)).toHaveLength(0);
  });

  it("cursors and cooldown anchors never move backward; the param cache upserts", () => {
    const db = memDb();
    db.setCursor("lane-actions:A", 100, T0);
    db.setCursor("lane-actions:A", 90, T0);
    expect(db.getCursor("lane-actions:A")).toBe(100);
    expect(db.getCursor("missing")).toBeNull();
    db.recordCooldownAnchor(LANE, T0 + 100);
    db.recordCooldownAnchor(LANE, T0);
    expect(db.lastCooldownAnchor(LANE)).toBe(T0 + 100);
    db.setParam("basis:NVDA", '{"k":1}', { source: "engine", fetchedAtMs: T0, ttlMs: 600_000 });
    db.setParam("basis:NVDA", '{"k":2}', { source: "engine", fetchedAtMs: T0 + 1, ttlMs: 600_000 });
    expect(db.getParam("basis:NVDA")).toMatchObject({
      valueJson: '{"k":2}',
      expiresAtMs: T0 + 600_001,
    });
  });

  it("server wallets upsert by address", () => {
    const db = memDb();
    const row = {
      address: OPERATOR,
      walletId: "sw1",
      keySharesCt: "ct",
      dekWrapped: "dek",
      kekId: "k1",
      createdAtMs: T0,
      updatedAtMs: T0,
    };
    db.upsertServerWallet(row);
    db.upsertServerWallet({ ...row, keySharesCt: "ct2", updatedAtMs: T0 + 1 });
    expect(db.getServerWallet(OPERATOR)).toMatchObject({ keySharesCt: "ct2", createdAtMs: T0 });
  });
});

describe("single-instance lock", () => {
  const a = { ownerId: "host:1:aaaa", pid: 1, host: "host" };
  const b = { ownerId: "host:1:bbbb", pid: 1, host: "host" }; // same pid, another container

  it("refuses a live holder, is re-entrant, and takes over a stale one", () => {
    const db = memDb();
    expect(db.acquireDaemonLock(a, T0, 60_000)).toEqual({ acquired: true });
    expect(db.acquireDaemonLock(b, T0 + 1_000, 60_000)).toMatchObject({
      acquired: false,
      holderOwner: a.ownerId,
    });
    expect(db.acquireDaemonLock(a, T0 + 2_000, 60_000)).toEqual({ acquired: true });
    expect(db.refreshDaemonLock(b.ownerId, T0 + 3_000)).toBe(false);
    expect(db.refreshDaemonLock(a.ownerId, T0 + 3_000)).toBe(true);
    expect(db.acquireDaemonLock(b, T0 + 63_001, 60_000)).toEqual({
      acquired: true,
      tookOverStaleOwner: a.ownerId,
    });
    db.releaseDaemonLock(a.ownerId); // not the holder: no-op
    expect(db.lockStatus()?.ownerId).toBe(b.ownerId);
    db.releaseDaemonLock(b.ownerId);
    expect(db.lockStatus()).toBeNull();
  });
});
