/**
 * Assertions shared by the fork suites: contract invariants, DB == chain, and "no guard violation
 * was ever executed" (from a recording guard wrapped around the real checkGuard).
 */

import { expect } from "vitest";
import { checkGuard } from "../../src/guard/guard.js";
import type { Address, GuardFn, GuardResult, Hex } from "../../src/types.js";
import { addressOf, type DeskUnderTest, type Fork, KEYS } from "./kit.js";

export interface GuardRecord {
  decisionId: string;
  step: number;
  result: GuardResult;
}

/** The real guard, recording every verdict (plan-time and pre-execution). */
export function recordingGuard(log: GuardRecord[]): GuardFn {
  return (input) => {
    const result = checkGuard(input);
    log.push({ decisionId: input.decisionId, step: input.step, result });
    return result;
  };
}

/** Every execution row (anything that reached an executor) was preceded by a clean `execute`. */
export function assertNoViolationExecuted(d: DeskUnderTest, lane: Address, log: GuardRecord[]) {
  for (const e of d.db.recentExecutions(10_000, lane)) {
    const verdicts = log.filter((g) => g.decisionId === e.decisionId && g.step === e.stepIndex);
    const last = verdicts.at(-1);
    expect(last, `execution ${e.executionId} has no guard verdict`).toBeDefined();
    expect(last?.result.decision).toBe("execute");
    expect(last?.result.violations).toEqual([]);
  }
}

/** On-chain invariants of the lane after any step. */
export async function assertLaneInvariants(fork: Fork, lane: Address) {
  const f = await fork.laneFacts(lane);
  expect(BigInt(f.tokenIds.length)).toBe(f.nftCount); // NFT bookkeeping == NPM.balanceOf
  expect(f.tokenIds.length).toBeLessThanOrEqual(2);
  for (const o of f.owners) expect(o).toBe(lane);
  expect(f.allowanceUsdg).toBe(0n); // approvals reset to 0 in the same tx
  expect(f.allowanceNvda).toBe(0n);
  expect(f.paused).toBe(false); // the agent never pauses in M2
  return f;
}

/** DB == chain: every LaneAction is one of our confirmed executions and vice versa. */
export async function assertDbMatchesChain(fork: Fork, d: DeskUnderTest, lane: Address) {
  const actions = await fork.laneActions(lane);
  const execs = d.db.recentExecutions(10_000, lane).filter((e) => e.venue === "rh");
  const confirmed = execs.filter((e) => e.status === "confirmed");
  expect(actions.length).toBe(confirmed.length);
  const operator = addressOf(KEYS.operator);
  for (const a of actions) {
    const e = confirmed.find((x) => x.onchainId?.toLowerCase() === a.decisionId.toLowerCase());
    expect(e, `LaneAction ${a.decisionId} has no confirmed execution`).toBeDefined();
    expect(e?.txHash?.toLowerCase()).toBe(a.txHash.toLowerCase());
    expect(a.caller).toBe(operator);
    const decision = d.db.getDecision(e?.decisionId ?? "");
    expect(a.reasonHash).toBe(decision?.reasonHash?.toLowerCase());
  }
  for (const e of confirmed) {
    const r = await fork.pub.getTransactionReceipt({ hash: e.txHash as Hex });
    expect(r.status).toBe("success");
  }
  // Fail-closed turnover: the DB never counts less than the lane's bucket spent.
  const facts = await fork.laneFacts(lane);
  const dbCents = d.db.turnoverCentsSince(lane, d.clock.now() - 86_400_000);
  expect(BigInt(dbCents) * 10_000n + 10_000n).toBeGreaterThanOrEqual(facts.turnoverUsedUsd6);
  return actions;
}
