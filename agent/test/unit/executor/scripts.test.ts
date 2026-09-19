/** scripts/signer-check.ts and scripts/desk-exit.ts against the in-memory chain. */

import { decodeFunctionData, encodeFunctionResult, parseTransaction } from "viem";
import { describe, expect, it } from "vitest";
import { runDeskExit } from "../../../scripts/desk-exit.js";
import { runSignerCheck } from "../../../scripts/signer-check.js";
import { loadConfig } from "../../../src/config.js";
import { deskLaneAbi, OPERATOR_SELECTORS } from "../../../src/executor/abi/DeskLane.js";
import { rhExecutorFromConfig } from "../../../src/executor/wire.js";
import { silentLogger } from "../../../src/log.js";
import { ConfigRefusedError, type TxSigner } from "../../../src/types.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import {
  ANVIL_KEY_0,
  FakeChain,
  LANE,
  LOOPBACK,
  localSigner,
  OPERATOR_ADDR,
  OWNER,
  T0,
} from "./_fixtures.js";

function laneChain() {
  const chain = new FakeChain();
  chain.callImpl = async (req) => {
    if (req.to.toLowerCase() !== LANE) return "0x";
    const { functionName } = decodeFunctionData({ abi: deskLaneAbi, data: req.data });
    const views: Record<string, unknown> = {
      owner: OWNER,
      operator: OPERATOR_ADDR,
      guardian: "0x0000000000000000000000000000000000000000",
      laneId: 0,
      pool: LANE,
      token0: LANE,
      token1: LANE,
      fence: LANE,
      paused: false,
      decisionUsedAt: 0n,
    };
    if (!(functionName in views)) return "0x"; // the mutating call being simulated
    return encodeFunctionResult({
      abi: deskLaneAbi,
      functionName: functionName as "owner",
      result: views[functionName] as never,
    });
  };
  return chain;
}

const checkDeps = (chain: FakeChain, signer: TxSigner) => ({
  chain,
  signer,
  lane: LANE,
  chainId: 4663,
  feeFloorWei: 20_000_000n,
  feeCapWei: 2_000_000_000n,
  signTimeoutMs: 5_000,
  nowMs: T0,
});

describe("scripts/signer-check", () => {
  it("signs and verifies a lane signal() and never broadcasts anything", async () => {
    const chain = laneChain();
    const r = await runSignerCheck(checkDeps(chain, localSigner()));
    expect(r.laneTx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.laneTx.simulated).toBe(true);
    expect(r).toMatchObject({
      owner: OWNER,
      operator: OPERATOR_ADDR,
      signer: { kind: "local", address: OPERATOR_ADDR },
    });
    // A raw key has no policy: the probe is SIGNED, which the script reports as not enforced (exit 2).
    expect(r.denial.outcome).toBe("signed");
    expect(chain.sent).toHaveLength(0);
  });

  it("records a Dynamic policy denial of the operator's USDG.transfer", async () => {
    const inner = localSigner();
    const policy: TxSigner = {
      ...inner,
      signTransaction: async (tx) => {
        if (tx.to.toLowerCase() !== LANE)
          throw Object.assign(new Error("Transaction denied by policy"), { status: 403 });
        return inner.signTransaction(tx);
      },
    };
    const chain = laneChain();
    const r = await runSignerCheck(checkDeps(chain, policy));
    expect(r.denial).toMatchObject({ outcome: "denied", code: "SIGNER_DENIED" });
    expect(chain.sent).toHaveLength(0);
  });

  it("can sign the denial probe for another chain (Dynamic policies do not support 4663)", async () => {
    const seen: number[] = [];
    const inner = localSigner();
    const policy: TxSigner = {
      ...inner,
      signTransaction: async (tx) => {
        seen.push(tx.chainId);
        if (tx.chainId === 8453)
          throw Object.assign(new Error("Transaction denied by policy"), { status: 403 });
        return inner.signTransaction(tx);
      },
    };
    const chain = laneChain();
    const usdcBase = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
    const r = await runSignerCheck({
      ...checkDeps(chain, policy),
      denialChainId: 8453,
      denialToken: usdcBase,
    });
    expect(seen).toEqual([4663, 8453]);
    expect(r.denial).toMatchObject({
      chainId: 8453,
      token: usdcBase,
      outcome: "denied",
      code: "SIGNER_DENIED",
    });
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses the wrong chain, and a signer that is not the operator", async () => {
    const wrong = laneChain();
    wrong.chainIdValue = 1;
    await expect(runSignerCheck(checkDeps(wrong, localSigner()))).rejects.toThrow(/chain/);
    const notOperator = { ...localSigner(), address: OWNER };
    await expect(runSignerCheck(checkDeps(laneChain(), notOperator))).rejects.toBeInstanceOf(
      ConfigRefusedError,
    );
  });
});

function exitSetup(env: Record<string, string>) {
  const cfg = loadConfig({
    RH_RPC_URL: LOOPBACK,
    SIGNER_KIND: "local",
    LOCAL_SIGNER_PRIVATE_KEY: ANVIL_KEY_0,
    ...env,
  });
  const db = memDb();
  const chain = laneChain();
  const clock = fixedClock(T0);
  const signer = localSigner();
  const executor = rhExecutorFromConfig({
    cfg,
    laneAddress: LANE,
    db,
    chain,
    signer,
    clock,
    logger: silentLogger,
    sleep: async (ms) => clock.advance(ms),
  });
  const run = (over: { armed?: boolean } = {}) =>
    runDeskExit({
      db,
      chain,
      executor,
      signer,
      lane: LANE,
      chainId: 4663,
      armed: over.armed ?? cfg.safety.armed,
      dryRun: cfg.safety.dryRun,
      deadlineSec: cfg.timing.deadlineSec,
      clock,
    });
  return { db, chain, run };
}

describe("scripts/desk-exit", () => {
  it("DRY_RUN (the default): simulates, records a dry_run decision, signs nothing", async () => {
    const s = exitSetup({});
    const r = await s.run();
    expect(r.status).toBe("dry_run");
    expect(r.checks.filter((c) => !c.passed).map((c) => c.rule)).toEqual(["arm-flag", "dry-run"]);
    expect(s.db.getDecision(r.decisionId)).toMatchObject({
      status: "dry_run",
      guardDecision: "dry-run",
      riskMode: "flat",
    });
    expect(s.db.executionsForDecision(r.decisionId)).toHaveLength(0);
    expect(s.chain.sent).toHaveLength(0);
  });

  it("armed and live: one exitAll through the write-ahead executor, decision executed", async () => {
    const s = exitSetup({ DRY_RUN: "false", DESK_ARM: "1" });
    const r = await s.run();
    expect(r.status).toBe("executed");
    expect(r.outcome?.status).toBe("confirmed");
    expect(s.chain.sent).toHaveLength(1);
    const tx = parseTransaction(s.chain.sent[0] as `0x${string}`);
    expect(tx.to?.toLowerCase()).toBe(LANE);
    expect(tx.data?.slice(0, 10)).toBe(OPERATOR_SELECTORS.exitAll);
    const d = s.db.getDecision(r.decisionId);
    expect(d?.reasonHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d?.reasonPreimage).toContain("desk-exit");
  });

  it("live but not armed → blocked (the arm flag is never bypassed)", async () => {
    // Config itself refuses DRY_RUN=false without DESK_ARM=1 on 4663; the script re-checks it.
    const s = exitSetup({ DRY_RUN: "false", DESK_ARM: "1" });
    const r = await s.run({ armed: false });
    expect(r.status).toBe("blocked");
    expect(r.checks.find((c) => c.rule === "arm-flag")?.passed).toBe(false);
    expect(s.chain.sent).toHaveLength(0);
  });

  it("a risk-reducing exit is still blocked by a failed simulation", async () => {
    const s = exitSetup({ DRY_RUN: "false", DESK_ARM: "1" });
    const inner = s.chain.callImpl;
    s.chain.callImpl = async (req) => {
      if (req.data.startsWith(OPERATOR_SELECTORS.exitAll))
        throw Object.assign(new Error("execution reverted"), { data: "0x1234567890" });
      return inner(req);
    };
    const r = await s.run();
    expect(r.status).toBe("blocked");
    expect(r.checks.find((c) => c.rule === "simulation-ok")?.passed).toBe(false);
    expect(s.chain.sent).toHaveLength(0);
  });
});
