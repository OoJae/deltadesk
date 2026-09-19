/**
 * The 4663 write-ahead pipeline, end to end against the in-memory chain and a real local signature:
 * every refusal must happen BEFORE a broadcast, and every broadcast must be of verified, persisted
 * bytes.
 */

import {
  ExecutionRevertedError,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  RpcRequestError,
} from "viem";
import { describe, expect, it } from "vitest";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import { createBroadcaster } from "../../../src/executor/broadcaster.js";
import { createCalldataBuilder } from "../../../src/executor/calldata.js";
import { createFeePolicy } from "../../../src/executor/fees.js";
import { createNonceManager } from "../../../src/executor/nonce.js";
import { createRhExecutor } from "../../../src/executor/rh-executor.js";
import { createSimulator } from "../../../src/executor/simulate.js";
import { silentLogger } from "../../../src/log.js";
import { createAttemptResolver } from "../../../src/reconcile/startup.js";
import {
  type DeskAction,
  type DeskNotification,
  ExecError,
  type Hex,
  riskClassOf,
  type StepRequest,
  type TxSigner,
} from "../../../src/types.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import {
  ANVIL_KEY_1,
  deskRow,
  FakeChain,
  LANE,
  localSigner,
  metaFor,
  OPERATOR_ADDR,
  OTHER_ADDR,
  seedDecision,
  T0,
} from "./_fixtures.js";

const NOW_SEC = Math.floor(T0 / 1000);

function setup(
  opts: { signer?: TxSigner; chain?: FakeChain; maxGasCents?: number; signTimeoutMs?: number } = {},
) {
  const db = memDb();
  db.insertDesk(deskRow());
  const chain = opts.chain ?? new FakeChain();
  const clock = fixedClock(T0);
  const sleep = async (ms: number) => clock.advance(ms);
  const base = opts.signer ?? localSigner();
  const signCalls: Hex[] = [];
  const signer: TxSigner = {
    kind: base.kind,
    address: base.address,
    ready: () => base.ready(),
    signTransaction: async (tx) => {
      const raw = await base.signTransaction(tx);
      signCalls.push(raw);
      return raw;
    },
  };
  const notes: DeskNotification[] = [];
  const notifier = { notify: async (n: DeskNotification) => void notes.push(n) };
  const broadcaster = createBroadcaster({ chain, clock, sleep });
  const executor = createRhExecutor({
    db,
    chain,
    signer,
    calldata: createCalldataBuilder(LANE),
    simulator: createSimulator({ chain }),
    fees: createFeePolicy({ floorWei: 20_000_000n, capWei: 2_000_000_000n }),
    nonces: createNonceManager({ db, chain, chainId: 4663, now: () => clock.now() }),
    broadcaster,
    resolver: createAttemptResolver({
      db,
      chain,
      broadcaster,
      clock,
      logger: silentLogger,
      notifier,
    }),
    clock,
    logger: silentLogger,
    notifier,
    chainId: 4663,
    timing: {
      signTimeoutMs: opts.signTimeoutMs ?? 15_000,
      receiptPollMs: 250,
      receiptTimeoutMs: 15_000,
    },
    maxGasCents: opts.maxGasCents ?? null,
    ethUsd: () => 2_630,
  });
  return { db, chain, clock, notes, executor, signCalls };
}

const RERANGE: DeskAction = {
  kind: "rerange",
  lane: "A",
  ranges: [{ tickLower: -222_400, tickUpper: -222_200, share0Bps: 5_000, share1Bps: 5_000 }],
  expectedTick: -222_277,
  maxTickDelta: 10,
};

function request(
  db: ReturnType<typeof memDb>,
  action: Exclude<DeskAction, { kind: "hold" }> = { kind: "collect", lane: "A" },
  deadlineSec = NOW_SEC + 45,
): StepRequest {
  const ulid = seedDecision(db);
  return {
    decisionId: ulid,
    step: 0,
    lane: "A",
    laneAddress: LANE,
    action,
    meta: metaFor(ulid, 0, deadlineSec),
    riskClass: riskClassOf(action),
    notionalCents: riskClassOf(action) === "adding" ? 5_000 : 0,
  };
}

const revert = (data: Hex) =>
  new ExecutionRevertedError({
    cause: new RpcRequestError({
      body: {},
      error: { code: 3, message: "execution reverted", data },
      url: "http://127.0.0.1:8545",
    }),
    message: "execution reverted",
  });

describe("rh executor: the happy path", () => {
  it("prepare simulates from the signer; execute writes ahead, signs, verifies, persists, broadcasts, confirms", async () => {
    const chain = new FakeChain();
    chain.callImpl = async () =>
      encodeFunctionResult({
        abi: deskLaneAbi,
        functionName: "rerange",
        result: [[11n], [5_000n], 25_000_000n, 10n ** 17n],
      });
    chain.count(OPERATOR_ADDR).pending = 3;
    const { db, executor, signCalls } = setup({ chain });
    const req = request(db, RERANGE);

    const prepared = await executor.prepare(req);
    expect(prepared.venue).toBe("rh");
    expect(prepared.call?.to).toBe(LANE);
    expect(prepared.simulation?.ok).toBe(true);
    expect(prepared.simulation?.from).toBe(OPERATOR_ADDR);
    expect(prepared.simulation?.rerange?.tokenIds).toEqual([11n]);
    expect(db.executionsForDecision(req.decisionId)).toHaveLength(0); // prepare writes nothing

    const out = await executor.execute(prepared);
    expect(out.status).toBe("confirmed");
    expect(out.error).toBeNull();
    const exec = db.getExecution(out.executionId);
    expect(exec).toMatchObject({
      status: "confirmed",
      signerAddress: OPERATOR_ADDR,
      notionalCents: 5_000,
    });
    expect(exec?.gasUsed).toBe(300_000n);
    expect(exec?.feeWei).toBe(300_000n * 10_000_000n);
    expect(exec?.feeUsdCents).toBe(1);

    const [attempt] = db.attemptsForExecution(out.executionId);
    expect(attempt?.signedRawTx).toBe(chain.sent[0]);
    expect(attempt?.signedRawTx).toBe(signCalls[0]);
    expect(attempt?.txHash).toBe(keccak256(chain.sent[0] as Hex));
    expect(attempt?.status).toBe("confirmed");
    expect(attempt?.nonce).toBe(3);
    const tx = parseTransaction(chain.sent[0] as Hex);
    expect(tx.to?.toLowerCase()).toBe(LANE);
    expect(tx.maxPriorityFeePerGas ?? 0n).toBe(0n);
    expect(tx.maxFeePerGas).toBe(20_000_000n);
    expect(tx.gas).toBe(500_000n);
    expect(db.getNonceState(OPERATOR_ADDR)?.lastNonce).toBe(3);
    expect(db.turnoverCentsSince(LANE, 0)).toBe(5_000);
  });

  it("the execution row exists (simulated) before sign() is called", async () => {
    const holder: { db?: ReturnType<typeof memDb>; decision?: string } = {};
    let checked = false;
    const inner = localSigner();
    const spy: TxSigner = {
      ...inner,
      signTransaction: async (tx) => {
        const rows = holder.db?.executionsForDecision(holder.decision as string) ?? [];
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("simulated");
        checked = true;
        return inner.signTransaction(tx);
      },
    };
    const { db, executor } = setup({ signer: spy });
    holder.db = db;
    const req = request(db);
    holder.decision = req.decisionId;
    expect((await executor.execute(await executor.prepare(req))).status).toBe("confirmed");
    expect(checked).toBe(true);
  });
});

describe("rh executor: refusals before any broadcast", () => {
  it("a signer returning bytes signed by ANOTHER key → SIGNER_MISMATCH, nothing stored or sent, safe mode", async () => {
    const wrong = localSigner(ANVIL_KEY_1);
    const tampered: TxSigner = {
      kind: "local",
      address: OPERATOR_ADDR,
      ready: wrong.ready,
      signTransaction: (tx) => wrong.signTransaction(tx),
    };
    const { db, chain, executor, notes } = setup({ signer: tampered });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("SIGNER_MISMATCH");
    expect(db.attemptsForExecution(out.executionId)).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
    expect(db.getDesk(LANE)?.status).toBe("safe_mode");
    expect(notes.some((n) => n.kind === "safe-mode" && n.severity === "critical")).toBe(true);
  });

  it("a signer that signs a DIFFERENT transaction (to / data / fee) → SIGNER_MISMATCH, nothing sent", async () => {
    for (const mutate of [
      (tx: Parameters<TxSigner["signTransaction"]>[0]) => ({ ...tx, to: OTHER_ADDR }),
      (tx: Parameters<TxSigner["signTransaction"]>[0]) => ({ ...tx, data: `${tx.data}00` as Hex }),
      (tx: Parameters<TxSigner["signTransaction"]>[0]) => ({
        ...tx,
        maxFeePerGas: tx.maxFeePerGas * 10n,
      }),
      (tx: Parameters<TxSigner["signTransaction"]>[0]) => ({ ...tx, value: 1n }),
    ]) {
      const inner = localSigner();
      const evil: TxSigner = {
        ...inner,
        signTransaction: (tx) => inner.signTransaction(mutate(tx)),
      };
      const { db, chain, executor } = setup({ signer: evil });
      const out = await executor.execute(await executor.prepare(request(db)));
      expect(out.error?.code).toBe("SIGNER_MISMATCH");
      expect(chain.sent).toHaveLength(0);
      expect(db.attemptsForExecution(out.executionId)).toHaveLength(0);
    }
  });

  it("a passed deadline → no broadcast (signed bytes kept, execution dropped)", async () => {
    const { db, chain, executor } = setup();
    const out = await executor.execute(
      await executor.prepare(request(db, { kind: "collect", lane: "A" }, NOW_SEC + 1)),
    );
    expect(out.status).toBe("dropped");
    expect(out.error?.code).toBe("DEADLINE_PASSED");
    expect(chain.sent).toHaveLength(0);
    expect(db.attemptsForExecution(out.executionId)[0]?.status).toBe("dropped");
  });

  it("single in flight: another execution in flight for this signer refuses the step (no row)", async () => {
    const { db, executor } = setup();
    const other = seedDecision(db);
    db.insertExecution({
      decisionId: other,
      stepIndex: 0,
      onchainId: `0x${"ab".repeat(32)}`,
      laneAddress: LANE,
      venue: "rh",
      action: "collect",
      riskClass: "reducing",
      notionalCents: 0,
      signerAddress: OPERATOR_ADDR,
      status: "prepared",
      createdAtMs: T0,
      updatedAtMs: T0,
    });
    const req = request(db);
    await expect(executor.execute(await executor.prepare(req))).rejects.toMatchObject({
      code: "SIM_TRANSIENT",
    });
    expect(db.executionsForDecision(req.decisionId)).toHaveLength(0);
  });

  it("idempotency: the same step never executes twice", async () => {
    const { db, chain, executor } = setup();
    const prepared = await executor.prepare(request(db));
    await executor.execute(prepared);
    await expect(executor.execute(prepared)).rejects.toMatchObject({ code: "SIM_DECISION_USED" });
    expect(chain.sent).toHaveLength(1);
  });

  it("a failing re-simulation fails the step before signing", async () => {
    const chain = new FakeChain();
    let n = 0;
    chain.callImpl = async () => {
      n += 1;
      if (n === 1) return "0x";
      throw revert(encodeErrorResult({ abi: deskLaneAbi, errorName: "IsPaused" }));
    };
    const { db, executor, signCalls } = setup({ chain });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("SIM_POLICY");
    expect(signCalls).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses a step whose initial simulation failed (no row)", async () => {
    const chain = new FakeChain();
    chain.callImpl = async () => {
      throw revert(encodeErrorResult({ abi: deskLaneAbi, errorName: "TooSoon", args: [1n] }));
    };
    const { db, executor } = setup({ chain });
    const req = request(db);
    await expect(executor.execute(await executor.prepare(req))).rejects.toBeInstanceOf(ExecError);
    expect(db.executionsForDecision(req.decisionId)).toHaveLength(0);
  });

  it("`to` always comes from config: a foreign lane or a tampered prepared call is refused", async () => {
    const { db, chain, executor } = setup();
    await expect(executor.prepare({ ...request(db), laneAddress: OTHER_ADDR })).rejects.toThrow(
      /configured lane/,
    );
    const prepared = await executor.prepare(request(db));
    const call = prepared.call as NonNullable<typeof prepared.call>;
    await expect(
      executor.execute({ ...prepared, call: { ...call, to: OTHER_ADDR } }),
    ).rejects.toThrow(/differs/);
    await expect(
      executor.execute({ ...prepared, call: { ...call, data: `${call.data}ff` as Hex } }),
    ).rejects.toThrow(/differs/);
    expect(chain.sent).toHaveLength(0);
    expect(db.executionsForDecision(prepared.decisionId)).toHaveLength(0);
  });

  it("refuses a Meta whose decisionId is not this step's, and a wrong risk class", async () => {
    const { db, executor } = setup();
    const req = request(db);
    await expect(executor.prepare({ ...req, step: 1 })).rejects.toThrow(/Meta.decisionId/);
    await expect(executor.prepare({ ...req, riskClass: "adding" })).rejects.toThrow(/risk class/);
  });

  it("gas above the cap → GAS_CAP (top-up alert), nothing signed", async () => {
    const { db, executor, signCalls, notes } = setup({ maxGasCents: 1 });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.error?.code).toBe("GAS_CAP");
    expect(signCalls).toHaveLength(0);
    expect(notes.some((n) => n.kind === "alert")).toBe(true);
  });
});

describe("rh executor: signer outcomes", () => {
  const throwing = (errs: unknown[]): TxSigner => {
    const inner = localSigner();
    return {
      ...inner,
      signTransaction: async (tx) => {
        const e = errs.shift();
        if (e !== undefined) throw e;
        return inner.signTransaction(tx);
      },
    };
  };

  it("a Dynamic policy denial → failed SIGNER_DENIED, desk safe mode, nothing sent", async () => {
    const denial = Object.assign(new Error("Forbidden"), { status: 403 });
    const { db, chain, executor } = setup({ signer: throwing([denial]) });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("SIGNER_DENIED");
    expect(db.getDesk(LANE)?.status).toBe("safe_mode");
    expect(chain.sent).toHaveLength(0);
  });

  it("a revoked delegation → SIGNER_REVOKED, desk revoked, no sign", async () => {
    const { db, chain, executor } = setup({
      signer: throwing([new ExecError("SIGNER_REVOKED", "no active delegation")]),
    });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.error?.code).toBe("SIGNER_REVOKED");
    expect(db.getDesk(LANE)?.status).toBe("revoked");
    expect(chain.sent).toHaveLength(0);
  });

  it("SIGNER_UNAVAILABLE retries exactly once", async () => {
    const once = setup({ signer: throwing([new Error("relay closed")]) });
    expect(
      (await once.executor.execute(await once.executor.prepare(request(once.db)))).status,
    ).toBe("confirmed");
    const twice = setup({
      signer: throwing([new Error("relay closed"), new Error("relay closed")]),
    });
    const out = await twice.executor.execute(await twice.executor.prepare(request(twice.db)));
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("SIGNER_UNAVAILABLE");
  });

  it("a signer that never answers times out (15 s rule), retried once, then fails", async () => {
    const inner = localSigner();
    let calls = 0;
    const hang: TxSigner = {
      ...inner,
      signTransaction: () => {
        calls += 1;
        return new Promise<Hex>(() => {});
      },
    };
    const { db, executor } = setup({ signer: hang, signTimeoutMs: 5 });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.error?.code).toBe("SIGNER_UNAVAILABLE");
    expect(calls).toBe(2);
  });
});

describe("rh executor: broadcast and receipt outcomes", () => {
  it("FEE_CAP_TOO_LOW → re-sign at the SAME nonce with a higher fee (old attempt replaced)", async () => {
    const chain = new FakeChain();
    chain.sendErrors.push(
      new RpcRequestError({
        body: {},
        error: { code: -32000, message: "max fee per gas less than block base fee" },
        url: "x",
      }),
    );
    const { db, executor, signCalls } = setup({ chain });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.status).toBe("confirmed");
    const attempts = db.attemptsForExecution(out.executionId);
    expect(attempts.map((a) => a.status)).toEqual(["replaced", "confirmed"]);
    expect(attempts[0]?.nonce).toBe(attempts[1]?.nonce);
    expect(
      (attempts[1]?.maxFeePerGas ?? 0n) >= ((attempts[0]?.maxFeePerGas ?? 0n) * 125n) / 100n,
    ).toBe(true);
    expect(signCalls).toHaveLength(2);
  });

  it("NONCE_TOO_LOW for our own (already known) tx → carry on to the receipt", async () => {
    const chain = new FakeChain();
    const accept = chain.sendRawTransaction.bind(chain);
    let first = true;
    chain.sendRawTransaction = async (raw) => {
      const h = await accept(raw);
      if (first) {
        first = false;
        throw new RpcRequestError({
          body: {},
          error: { code: -32000, message: "nonce too low" },
          url: "x",
        });
      }
      return h;
    };
    const { db, executor } = setup({ chain });
    expect((await executor.execute(await executor.prepare(request(db)))).status).toBe("confirmed");
  });

  it("NONCE_TOO_LOW when the nonce went to someone else → NONCE_CONFLICT, dropped, safe mode", async () => {
    const chain = new FakeChain();
    chain.sendErrors.push(
      new RpcRequestError({
        body: {},
        error: { code: -32000, message: "nonce too low" },
        url: "x",
      }),
    );
    const { db, executor } = setup({ chain });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.status).toBe("dropped");
    expect(out.error?.code).toBe("NONCE_CONFLICT");
    expect(db.getDesk(LANE)?.status).toBe("safe_mode");
  });

  it("an RPC failure on broadcast leaves the execution unknown (never re-signed)", async () => {
    const chain = new FakeChain();
    chain.sendErrors.push(Object.assign(new Error("connect"), { code: "ECONNRESET" }));
    const { db, executor, signCalls } = setup({ chain });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.status).toBe("unknown");
    expect(signCalls).toHaveLength(1);
    expect(db.attemptsForExecution(out.executionId)[0]?.status).toBe("unknown");
  });

  it("a receipt timeout → unknown, then the resolver rebroadcasts the SAME bytes once", async () => {
    const chain = new FakeChain();
    chain.autoMine = false;
    chain.mempoolKeeps = false; // the node forgets the tx
    const { db, executor, signCalls } = setup({ chain });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]).toBe(chain.sent[0]);
    expect(signCalls).toHaveLength(1);
    const [a] = db.attemptsForExecution(out.executionId);
    expect(a?.broadcastCount).toBe(2);
    expect(out.status).toBe("broadcast");
  });

  it("a reverted tx is recorded with its decoded reason (eth_call at block − 1)", async () => {
    const chain = new FakeChain();
    chain.mineStatus = "reverted";
    let n = 0;
    chain.callImpl = async (req) => {
      n += 1;
      if (n <= 2) return "0x";
      expect(req.blockNumber).toBe(chain.head - 1n);
      throw revert(encodeErrorResult({ abi: deskLaneAbi, errorName: "MarketClosed", args: [5] }));
    };
    const { db, executor, notes } = setup({ chain });
    const out = await executor.execute(await executor.prepare(request(db)));
    expect(out.status).toBe("reverted");
    expect(out.error?.code).toBe("REVERTED");
    expect(db.getExecution(out.executionId)?.statusDetail).toMatch(/MarketClosed/);
    expect(notes.some((x) => x.title.startsWith("Reverted"))).toBe(true);
  });
});

describe("rh executor: the desk may stop while a step signs (safe mode, revocation)", () => {
  const rerangeChain = () => {
    const chain = new FakeChain();
    chain.callImpl = async () =>
      encodeFunctionResult({
        abi: deskLaneAbi,
        functionName: "rerange",
        result: [[11n], [5_000n], 25_000_000n, 10n ** 17n],
      });
    return chain;
  };
  /** A signer during whose signature the reconciler puts the desk in safe mode. */
  function haltingSigner(onSign: () => void): TxSigner {
    const base = localSigner();
    return {
      kind: base.kind,
      address: base.address,
      ready: () => base.ready(),
      signTransaction: async (tx) => {
        onSign();
        return base.signTransaction(tx);
      },
    };
  }

  it("risk-adding: safe mode entered mid-sign → dropped DESK_HALTED, the signed bytes never sent", async () => {
    let db: ReturnType<typeof memDb> | null = null;
    const signer = haltingSigner(() =>
      db?.setDeskStatus(LANE, "safe_mode", "foreign LaneAction", T0),
    );
    const s = setup({ chain: rerangeChain(), signer });
    db = s.db;
    const out = await s.executor.execute(await s.executor.prepare(request(s.db, RERANGE)));
    expect(out.status).toBe("dropped");
    expect(out.error?.code).toBe("DESK_HALTED");
    expect(s.signCalls).toHaveLength(1);
    expect(s.chain.sent).toHaveLength(0);
    expect(s.db.attemptsForExecution(out.executionId).map((a) => a.status)).toEqual(["dropped"]);
    // Nothing in flight: the next step may proceed once the desk is active again.
    expect(s.db.inFlightCount(OPERATOR_ADDR)).toBe(0);
  });

  it("risk-adding on a desk already revoked → DESK_HALTED before anything is signed", async () => {
    const s = setup({ chain: rerangeChain() });
    const prepared = await s.executor.prepare(request(s.db, RERANGE));
    s.db.setDeskStatus(LANE, "revoked", "Dynamic delegation revoked", T0);
    const out = await s.executor.execute(prepared);
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("DESK_HALTED");
    expect(s.signCalls).toHaveLength(0);
    expect(s.chain.sent).toHaveLength(0);
  });

  it("FEE_CAP_TOO_LOW after the desk stopped → no re-sign, nothing sent", async () => {
    const chain = rerangeChain();
    const s0: { db: ReturnType<typeof memDb> | null } = { db: null };
    chain.sendRawTransaction = async () => {
      s0.db?.setDeskStatus(LANE, "safe_mode", "NONCE_CONFLICT elsewhere", T0);
      throw new RpcRequestError({
        body: {},
        error: { code: -32000, message: "max fee per gas less than block base fee" },
        url: "x",
      });
    };
    const s = setup({ chain });
    s0.db = s.db;
    const out = await s.executor.execute(await s.executor.prepare(request(s.db, RERANGE)));
    expect(out.status).toBe("dropped");
    expect(out.error?.code).toBe("DESK_HALTED");
    expect(s.signCalls).toHaveLength(1); // never re-signed
  });

  it("risk-reducing steps still go out (the human's desk-exit must flatten a desk in safe mode)", async () => {
    let db: ReturnType<typeof memDb> | null = null;
    const signer = haltingSigner(() =>
      db?.setDeskStatus(LANE, "safe_mode", "foreign LaneAction", T0),
    );
    const s = setup({ signer });
    db = s.db;
    const out = await s.executor.execute(
      await s.executor.prepare(request(s.db, { kind: "exitAll", lane: "A" })),
    );
    expect(out.status).toBe("confirmed");
    expect(s.chain.sent).toHaveLength(1);
  });

  it("positive path: an active desk signs and sends the same rerange", async () => {
    const s = setup({ chain: rerangeChain() });
    const out = await s.executor.execute(await s.executor.prepare(request(s.db, RERANGE)));
    expect(out.status).toBe("confirmed");
    expect(s.chain.sent).toHaveLength(1);
  });
});
