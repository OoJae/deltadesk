/**
 * Approval postures are asymmetric on purpose:
 *   copilot   silence means NO (fail-closed), recorded as 'declined';
 *   autopilot silence means GO (fail-open);
 *   advisory  never executes, recorded as 'advisory';
 * and risk-reducing steps never wait for a human.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApprovalGate,
  createFileApprovalGate,
  decideApproval,
  effectiveMode,
  noopApprovalGate,
} from "../../src/approval/gate.js";
import type { ApprovalGate, ApprovalRequest } from "../../src/types.js";
import { fixedClock, LANE, memDb } from "../helpers/fakes.js";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "desk-approval-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ULID = "01K5HZ3N8QW0000000000000AA";
const req = (decisionId = ULID, windowMs = 3_000): ApprovalRequest => ({
  decisionId,
  laneAddress: LANE,
  summary: "rerange $50 around F",
  windowMs,
});
const instant = async () => {};

describe("noopApprovalGate", () => {
  it("denies copilot and does not block autopilot", async () => {
    expect((await noopApprovalGate.requestApproval(req())).approved).toBe(false);
    expect((await noopApprovalGate.awaitCancelWindow(req())).cancelled).toBe(false);
  });
});

describe("file channel", () => {
  it("times out to not-approved", async () => {
    const gate = createFileApprovalGate({ dir: tempDir(), sleep: instant, pollMs: 1_000 });
    expect(await gate.requestApproval(req())).toEqual({
      approved: false,
      outcome: "timeout",
      channel: null,
    });
  });

  it("approves on the approve file and consumes it", async () => {
    const dir = tempDir();
    const gate = createFileApprovalGate({ dir, sleep: instant });
    writeFileSync(join(dir, `approve-${ULID}`), "");
    expect(await gate.requestApproval(req())).toEqual({
      approved: true,
      outcome: "approved",
      channel: "file",
    });
    expect(existsSync(join(dir, `approve-${ULID}`))).toBe(false);
    expect((await gate.requestApproval(req())).approved).toBe(false);
  });

  it("cancel beats approve, and both files are consumed", async () => {
    const dir = tempDir();
    const gate = createFileApprovalGate({ dir, sleep: instant });
    writeFileSync(join(dir, `approve-${ULID}`), "");
    writeFileSync(join(dir, `cancel-${ULID}`), "");
    expect(await gate.requestApproval(req())).toMatchObject({ approved: false, outcome: "denied" });
    expect(existsSync(join(dir, `approve-${ULID}`))).toBe(false);
  });

  it("cancel window: silence proceeds, a cancel stops it", async () => {
    const dir = tempDir();
    const gate = createFileApprovalGate({ dir, sleep: instant });
    expect((await gate.awaitCancelWindow(req())).cancelled).toBe(false);
    writeFileSync(join(dir, `cancel-${ULID}`), "");
    expect(await gate.awaitCancelWindow(req())).toEqual({ cancelled: true, channel: "file" });
  });
});

describe("db channel (web and Telegram answers)", () => {
  it("creates the pending approval, then honours an answer that arrives while waiting", async () => {
    const db = memDb();
    const clock = fixedClock();
    let polls = 0;
    const gate = createApprovalGate({
      db,
      clock,
      pollMs: 1_000,
      sleep: async (ms) => {
        clock.advance(ms);
        polls += 1;
        if (polls === 2) db.respondApproval(ULID, true, "telegram", "alice", clock.now());
      },
    });
    const answer = await gate.requestApproval(req(ULID, 60_000));
    expect(answer).toEqual({ approved: true, outcome: "approved", channel: "telegram" });
    expect(db.getApproval(ULID)?.status).toBe("approved");
  });

  it("expires the row when nobody answers", async () => {
    const db = memDb();
    const clock = fixedClock();
    const gate = createApprovalGate({ db, clock, sleep: async (ms) => clock.advance(ms) });
    expect((await gate.requestApproval(req(ULID, 5_000))).outcome).toBe("timeout");
    expect(db.getApproval(ULID)?.status).toBe("expired");
  });

  it("a web denial is a denial", async () => {
    const db = memDb();
    const clock = fixedClock();
    const gate = createApprovalGate({
      db,
      clock,
      sleep: async (ms) => {
        clock.advance(ms);
        db.respondApproval(ULID, false, "web", "0xowner", clock.now());
      },
    });
    expect(await gate.requestApproval(req(ULID, 5_000))).toEqual({
      approved: false,
      outcome: "denied",
      channel: "web",
    });
  });

  it("announces the request once", async () => {
    const prompts: string[] = [];
    const gate = createApprovalGate({
      dir: tempDir(),
      sleep: instant,
      onPrompt: (r) => prompts.push(r.decisionId),
    });
    await gate.requestApproval(req());
    expect(prompts).toEqual([ULID]);
  });
});

describe("decideApproval", () => {
  const approving: ApprovalGate = {
    requestApproval: async () => ({ approved: true, outcome: "approved", channel: "web" }),
    awaitCancelWindow: async () => ({ cancelled: false, channel: null }),
  };
  const silent: ApprovalGate = {
    requestApproval: async () => ({ approved: false, outcome: "timeout", channel: null }),
    awaitCancelWindow: async () => ({ cancelled: false, channel: null }),
  };
  const cancelling: ApprovalGate = {
    requestApproval: async () => ({ approved: false, outcome: "denied", channel: "telegram" }),
    awaitCancelWindow: async () => ({ cancelled: true, channel: "telegram" }),
  };

  it("advisory never executes, not even risk-reducing steps (proof 8)", async () => {
    for (const riskClass of ["adding", "reducing", "neutral"] as const) {
      const d = await decideApproval({
        mode: "advisory",
        riskClass,
        gate: approving,
        request: req(),
      });
      expect(d).toMatchObject({ execute: false, outcome: "advisory", status: "advisory" });
    }
  });

  it("copilot: adding needs an explicit approve; silence is declined and anchors a cooldown (proof 9)", async () => {
    let vetoes = 0;
    const onVeto = () => {
      vetoes += 1;
    };
    expect(
      await decideApproval({
        mode: "copilot",
        riskClass: "adding",
        gate: approving,
        request: req(),
        onVeto,
      }),
    ).toMatchObject({
      execute: true,
      outcome: "approved",
    });
    expect(
      await decideApproval({
        mode: "copilot",
        riskClass: "adding",
        gate: silent,
        request: req(),
        onVeto,
      }),
    ).toMatchObject({
      execute: false,
      outcome: "timeout",
      status: "declined",
    });
    expect(
      await decideApproval({
        mode: "copilot",
        riskClass: "adding",
        gate: cancelling,
        request: req(),
        onVeto,
      }),
    ).toMatchObject({
      execute: false,
      outcome: "denied",
      status: "declined",
    });
    expect(vetoes).toBe(2);
  });

  it("copilot: risk-reducing steps auto-execute without asking", async () => {
    const d = await decideApproval({
      mode: "copilot",
      riskClass: "reducing",
      gate: silent,
      request: req(),
    });
    expect(d).toMatchObject({ execute: true, outcome: "not_required", status: null });
  });

  it("autopilot without a cancel window is copilot: it asks, and silence is declined", async () => {
    let asked = 0;
    let windows = 0;
    const counting: ApprovalGate = {
      requestApproval: async (r) => {
        asked += 1;
        return silent.requestApproval(r);
      },
      awaitCancelWindow: async (r) => {
        windows += 1;
        return silent.awaitCancelWindow(r);
      },
    };
    for (const cancelWindowMs of [undefined, 0, -1]) {
      expect(
        await decideApproval({
          mode: "autopilot",
          riskClass: "adding",
          gate: counting,
          request: req(),
          ...(cancelWindowMs === undefined ? {} : { cancelWindowMs }),
        }),
      ).toMatchObject({ execute: false, outcome: "timeout", status: "declined" });
    }
    expect({ asked, windows }).toEqual({ asked: 3, windows: 0 });
    expect(effectiveMode("autopilot", 0)).toBe("copilot");
    expect(effectiveMode("autopilot", 10_000)).toBe("autopilot");
    expect(effectiveMode("advisory", 0)).toBe("advisory");
    // Positive path: an explicit approve executes it.
    expect(
      await decideApproval({
        mode: "autopilot",
        riskClass: "adding",
        gate: approving,
        request: req(),
      }),
    ).toMatchObject({ execute: true, outcome: "approved" });
  });

  it("autopilot: proceeds unless cancelled inside the window", async () => {
    let vetoed = false;
    expect(
      await decideApproval({
        mode: "autopilot",
        riskClass: "adding",
        gate: silent,
        request: req(),
        cancelWindowMs: 10_000,
      }),
    ).toMatchObject({
      execute: true,
    });
    expect(
      await decideApproval({
        mode: "autopilot",
        riskClass: "adding",
        gate: cancelling,
        request: req(),
        cancelWindowMs: 10_000,
        onVeto: () => {
          vetoed = true;
        },
      }),
    ).toMatchObject({ execute: false, outcome: "cancelled", status: "declined" });
    expect(vetoed).toBe(true);
  });
});
