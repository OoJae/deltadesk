/**
 * GET /lanes/:lane/actions/:decisionId: the watchdog's cross-check. Only its own shared key
 * (constant-time), never the web's; `known` needs a SIGNED attempt of that lane's execution.
 */

import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { createHttpApp } from "../../../src/http/server.js";
import { checkAction, WATCHDOG_KEY_HEADER } from "../../../src/http/watchdog-api.js";
import { silentLogger } from "../../../src/log.js";
import type { Address, DeskDb } from "../../../src/types.js";
import { memDb } from "../../helpers/fakes.js";
import { LANE, seedSignedExecution, T0, testUlid } from "../executor/_fixtures.js";

const KEY = "watchdog-key-0123456789abcdef0123456789";
const OTHER_LANE = "0x9999999999999999999999999999999999999999" as Address;

/** `key: null` = WATCHDOG_AGENT_KEY unset. */
function app(db: DeskDb, key: string | null = KEY) {
  return createHttpApp({
    health: () => ({ ok: true, lastTickAgeMs: 0, lockHeld: true, pendingExecutions: 0, nowMs: 0 }),
    webhook: null,
    desks: null,
    watchdog: { db, key: key ?? undefined, logger: silentLogger },
    logger: silentLogger,
  });
}

const get = (a: ReturnType<typeof app>, path: string, key: string | null = KEY) =>
  a.request(path, { headers: key === null ? {} : { [WATCHDOG_KEY_HEADER]: key } });

describe("GET /lanes/:lane/actions/:decisionId auth", () => {
  it("refuses without the configured key (503), a missing or wrong key (401)", async () => {
    const db = memDb();
    const s = await seedSignedExecution(db);
    const path = `/lanes/${LANE}/actions/${s.onchainId}`;
    expect((await get(app(db, null), path)).status).toBe(503);
    expect((await get(app(db), path, null)).status).toBe(401);
    expect((await get(app(db), path, `${KEY}x`)).status).toBe(401);
    expect((await get(app(db), path, KEY.slice(0, -1))).status).toBe(401);
    // The web's key header does not open it.
    const web = await app(db).request(path, { headers: { "x-desk-agent-key": KEY } });
    expect(web.status).toBe(401);
    expect((await get(app(db), path)).status).toBe(200);
  });

  it("the route is not mounted at all without a watchdog config", async () => {
    const bare = createHttpApp({
      health: () => ({
        ok: true,
        lastTickAgeMs: 0,
        lockHeld: true,
        pendingExecutions: 0,
        nowMs: 0,
      }),
      webhook: null,
      desks: null,
      logger: silentLogger,
    });
    expect((await get(bare, `/lanes/${LANE}/actions/${keccak256("0x01")}`)).status).toBe(503);
  });

  it("400 for a malformed lane, decisionId or tx", async () => {
    const a = app(memDb());
    const id = keccak256("0x01");
    expect((await get(a, `/lanes/0x12/actions/${id}`)).status).toBe(400);
    expect((await get(a, `/lanes/${LANE}/actions/0x1234`)).status).toBe(400);
    expect((await get(a, `/lanes/${LANE}/actions/${id}?tx=0xabc`)).status).toBe(400);
  });
});

describe("known = a signed tx_attempt of that lane's execution", () => {
  it("known with its status; the tx hash, when given, must be one of its attempts", async () => {
    const db = memDb();
    const s = await seedSignedExecution(db, { riskClass: "adding" });
    const a = app(db);
    const r = await get(
      a,
      `/lanes/${LANE.toUpperCase().replace("0X", "0x")}/actions/${s.onchainId}`,
    );
    expect(await r.json()).toEqual({ known: true, status: "signed" });
    expect(
      await (await get(a, `/lanes/${LANE}/actions/${s.onchainId}?tx=${s.txHash}`)).json(),
    ).toEqual({ known: true, status: "signed" });
    expect(
      await (await get(a, `/lanes/${LANE}/actions/${s.onchainId}?tx=${keccak256("0x77")}`)).json(),
    ).toEqual({ known: false });
  });

  it("unknown: a forged agent-layout id, another lane's execution, an execution never signed", async () => {
    const db = memDb();
    const s = await seedSignedExecution(db);
    expect(checkAction(db, LANE, encodeDecisionId(testUlid(), 0))).toEqual({ known: false });
    expect(checkAction(db, OTHER_LANE, s.onchainId)).toEqual({ known: false });
    // A decision the agent planned but never signed (declined, advisory, failed before signing).
    const unsigned = testUlid();
    const planned = db.getDecision(s.decisionId);
    if (planned === null) throw new Error("seeded decision missing");
    db.insertDecision({ ...planned, decisionId: unsigned });
    db.insertExecution({
      decisionId: unsigned,
      stepIndex: 0,
      onchainId: encodeDecisionId(unsigned, 0),
      laneAddress: LANE,
      venue: "rh",
      action: "rerange",
      riskClass: "adding",
      notionalCents: 5_000,
      signerAddress: null,
      status: "prepared",
      createdAtMs: T0,
      updatedAtMs: T0,
    });
    expect(checkAction(db, LANE, encodeDecisionId(unsigned, 0))).toEqual({ known: false });
    expect(checkAction(db, LANE, s.onchainId)).toEqual({ known: true, status: "signed" });
  });
});
