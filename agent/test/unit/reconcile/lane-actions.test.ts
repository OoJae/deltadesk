import { describe, expect, it } from "vitest";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { silentLogger } from "../../../src/log.js";
import {
  createLaneActionReconciler,
  cursorName,
  decodeLaneAction,
} from "../../../src/reconcile/lane-actions.js";
import {
  type DeskDb,
  type DeskNotification,
  type Hex,
  LANE_ACTION_NAMES,
} from "../../../src/types.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import {
  deskRow,
  FakeChain,
  LANE,
  laneActionLog,
  OPERATOR_ADDR,
  OWNER,
  seedDecision,
  T0,
} from "../executor/_fixtures.js";

const act = (name: (typeof LANE_ACTION_NAMES)[number]) => LANE_ACTION_NAMES.indexOf(name);
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

function seedExecution(
  db: DeskDb,
  action: "collect" | "pause" = "collect",
  status: "confirmed" | "unknown" = "confirmed",
) {
  const decisionId = seedDecision(db);
  const onchainId = encodeDecisionId(decisionId, 0);
  const executionId = db.insertExecution({
    decisionId,
    stepIndex: 0,
    onchainId,
    laneAddress: LANE,
    venue: "rh",
    action,
    riskClass: "reducing",
    notionalCents: 0,
    signerAddress: OPERATOR_ADDR,
    status: "prepared",
    createdAtMs: T0,
    updatedAtMs: T0,
  });
  const txHash = h(1000 + executionId);
  db.recordSignedAttempt(
    {
      executionId,
      attempt: 1,
      signerKind: "local",
      fromAddress: OPERATOR_ADDR,
      toAddress: LANE,
      calldataHash: h(1),
      nonce: executionId,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 0n,
      deadlineSec: 1,
      signedRawTx: "0x02",
      txHash,
      simJson: null,
      createdAtMs: T0,
    },
    T0,
  );
  db.updateExecution(executionId, { status, updatedAtMs: T0 });
  return { decisionId, onchainId, executionId, txHash };
}

function setup() {
  const db = memDb();
  db.insertDesk(deskRow());
  const chain = new FakeChain();
  chain.head = 5_000n;
  const notes: DeskNotification[] = [];
  const reconciler = createLaneActionReconciler({
    db,
    chain,
    lanes: () => [LANE],
    clock: fixedClock(T0),
    logger: silentLogger,
    notifier: { notify: async (n) => void notes.push(n) },
    startBlock: () => 4_000n,
    chunkBlocks: 300n,
  });
  return { db, chain, notes, reconciler };
}

describe("LaneAction reconciliation", () => {
  it("decodes the event the lane emits", () => {
    const log = laneActionLog({
      decisionId: h(7),
      action: act("EXIT_ALL"),
      caller: OPERATOR_ADDR,
      txHash: h(8),
      blockNumber: 10n,
      ticks: [-222_400, -222_200],
    });
    expect(decodeLaneAction(log)).toMatchObject({
      decisionId: h(7),
      action: 3,
      caller: OPERATOR_ADDR,
      ticks: [-222_400, -222_200],
      laneAddress: LANE,
    });
  });

  it("matches our executions by decisionId (and pause by tx hash); reads only up to latest − 20", async () => {
    const { db, chain, reconciler } = setup();
    const a = seedExecution(db);
    const p = seedExecution(db, "pause");
    chain.logs.push(
      laneActionLog({
        decisionId: a.onchainId,
        action: act("COLLECT"),
        caller: OPERATOR_ADDR,
        txHash: a.txHash,
        blockNumber: 4_500n,
      }),
      laneActionLog({
        decisionId: `0x${"0".repeat(64)}`,
        action: act("PAUSE"),
        caller: OPERATOR_ADDR,
        txHash: p.txHash,
        blockNumber: 4_600n,
      }),
      laneActionLog({
        decisionId: a.onchainId,
        action: act("COLLECT"),
        caller: OPERATOR_ADDR,
        txHash: h(99),
        blockNumber: 4_990n,
      }),
    );
    const r = await reconciler.run(T0);
    expect(r).toMatchObject({ matched: 2, foreign: 0, toBlock: 4_980n });
    expect(db.getCursor(cursorName(LANE))).toBe(4_980);
    expect(
      db
        .laneActionsByMatch("matched")
        .map((x) => x.matchedExecutionId)
        .sort(),
    ).toEqual([a.executionId, p.executionId].sort());
    expect(Math.max(...chain.getLogsCalls.map((c) => Number(c.toBlock)))).toBe(4_980);
    expect(chain.getLogsCalls.every((c) => c.toBlock - c.fromBlock < 300n)).toBe(true);
    expect(db.getDesk(LANE)?.status).toBe("active");
  });

  it("a foreign LaneAction (owner acting directly, unknown id) → safe mode + alert", async () => {
    const { db, chain, notes, reconciler } = setup();
    chain.logs.push(
      laneActionLog({
        decisionId: h(12345),
        action: act("EXIT_ALL"),
        caller: OWNER,
        txHash: h(77),
        blockNumber: 4_100n,
      }),
    );
    const r = await reconciler.run(T0);
    expect(r.foreign).toBe(1);
    expect(db.getDesk(LANE)?.status).toBe("safe_mode");
    expect(db.laneActionsByMatch("foreign")).toHaveLength(1);
    expect(notes.some((n) => n.kind === "safe-mode")).toBe(true);
  });

  it("our decisionId used by a different caller is foreign too", async () => {
    const { db, chain, reconciler } = setup();
    const a = seedExecution(db);
    chain.logs.push(
      laneActionLog({
        decisionId: a.onchainId,
        action: act("COLLECT"),
        caller: OWNER,
        txHash: h(55),
        blockNumber: 4_200n,
      }),
    );
    expect((await reconciler.run(T0)).foreign).toBe(1);
    expect(db.getDesk(LANE)?.status).toBe("safe_mode");
  });

  it("an `unknown` execution proven by its log becomes confirmed", async () => {
    const { db, chain, reconciler } = setup();
    const a = seedExecution(db, "collect", "unknown");
    chain.logs.push(
      laneActionLog({
        decisionId: a.onchainId,
        action: act("COLLECT"),
        caller: OPERATOR_ADDR,
        txHash: a.txHash,
        blockNumber: 4_300n,
      }),
    );
    await reconciler.run(T0);
    expect(db.getExecution(a.executionId)?.status).toBe("confirmed");
    expect(db.getAttemptByHash(a.txHash)?.status).toBe("confirmed");
  });

  it("is idempotent: the cursor advances and a replay inserts nothing twice", async () => {
    const { db, chain, reconciler } = setup();
    const a = seedExecution(db);
    chain.logs.push(
      laneActionLog({
        decisionId: a.onchainId,
        action: act("COLLECT"),
        caller: OPERATOR_ADDR,
        txHash: a.txHash,
        blockNumber: 4_500n,
      }),
    );
    await reconciler.run(T0);
    db.sqlite.prepare("UPDATE sync_cursors SET block_number = 4000").run();
    await reconciler.run(T0);
    expect(db.recentLaneActions(LANE, 10)).toHaveLength(1);
    chain.head = 5_100n;
    await reconciler.run(T0);
    expect(db.getCursor(cursorName(LANE))).toBe(5_080);
  });
});
