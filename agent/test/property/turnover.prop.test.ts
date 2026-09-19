/**
 * Property: the turnover the guard sees is never below Σ notional of adding executions that got a
 * signature, whatever happened to them afterwards (dropped, reverted, unknown, …).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ExecutionStatus, Hex } from "../../src/types.js";
import { LANE, memDb, OPERATOR } from "../helpers/fakes.js";

const T0 = 1_758_470_400_000;
const AFTER_SIGN: ExecutionStatus[] = [
  "signed",
  "broadcast",
  "confirmed",
  "reverted",
  "failed",
  "dropped",
  "unknown",
];

describe("turnover (fail-closed)", () => {
  it("turnover counted ≥ Σ notional of signed adding executions", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            notional: fc.integer({ min: 0, max: 10_000 }),
            adding: fc.boolean(),
            signed: fc.boolean(),
            finalStatus: fc.constantFrom(...AFTER_SIGN),
            ageMs: fc.integer({ min: 0, max: 48 * 3_600_000 }),
          }),
          { maxLength: 30 },
        ),
        (steps) => {
          const db = memDb();
          const decisionId = "01K5HZ3N8QW0000000000000AA";
          db.insertDecision({
            decisionId,
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
          });
          const now = T0 + 48 * 3_600_000;
          const since = now - 24 * 3_600_000;
          let expected = 0;
          steps.forEach((s, i) => {
            const onchainId =
              `0x${i.toString(16).padStart(32, "0")}01${i.toString(16).padStart(2, "0")}${"0".repeat(28)}` as Hex;
            const id = db.insertExecution({
              decisionId,
              stepIndex: i,
              onchainId,
              laneAddress: LANE,
              venue: "rh",
              action: s.adding ? "rerange" : "exitAll",
              riskClass: s.adding ? "adding" : "reducing",
              notionalCents: s.notional,
              signerAddress: OPERATOR,
              status: "prepared",
              createdAtMs: T0,
              updatedAtMs: T0,
            });
            if (!s.signed) return;
            const signedAt = now - s.ageMs;
            db.recordSignedAttempt(
              {
                executionId: id,
                attempt: 1,
                signerKind: "local",
                fromAddress: OPERATOR,
                toAddress: LANE,
                calldataHash: `0x${"00".repeat(32)}`,
                nonce: i,
                gasLimit: 1n,
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 0n,
                deadlineSec: 0,
                signedRawTx: "0x02",
                txHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
                simJson: null,
                createdAtMs: signedAt,
              },
              signedAt,
            );
            db.updateExecution(id, { status: s.finalStatus, updatedAtMs: now });
            if (s.adding && signedAt >= since) expected += s.notional;
          });
          expect(db.turnoverCentsSince(LANE, since)).toBeGreaterThanOrEqual(expected);
          expect(db.turnoverCentsSince(LANE, since)).toBe(expected);
          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});
