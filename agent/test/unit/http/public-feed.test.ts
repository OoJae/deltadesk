/**
 * GET /public/feed: whitelisted public state only (lanes, regime, decisions, gate signals, mode,
 * health), cached 5 s, rate-limited per client IP, and served by createHttpApp without any key.
 */

import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { NVDA_USDG_POOL } from "../../../src/addresses.js";
import { canonicalJson } from "../../../src/canonical.js";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import type { DeskApiDeps } from "../../../src/http/desks.js";
import { createPublicFeedRoutes, type PublicFeed } from "../../../src/http/public-feed.js";
import { createHttpApp } from "../../../src/http/server.js";
import { silentLogger } from "../../../src/log.js";
import type { DeskDb, HealthView, TickRow } from "../../../src/types.js";
import { memDb } from "../../helpers/fakes.js";
import {
  decisionRow,
  deskRow,
  LANE,
  OPERATOR_ADDR,
  seedSignedExecution,
  T0,
  testUlid,
} from "../executor/_fixtures.js";

const OWNER = "0x2222222222222222222222222222222222222222";
const health = (): HealthView => ({
  ok: true,
  lastTickAgeMs: 4_000,
  lockHeld: true,
  pendingExecutions: 0,
  nowMs: T0,
});

function tick(): Omit<TickRow, "id"> {
  return {
    laneAddress: LANE,
    atMs: T0 - 4_000,
    blockNumber: 1,
    blockTs: Math.floor(T0 / 1000),
    poolTick: 222_275,
    sqrtPriceX96: 1n,
    poolMid: 222.43,
    hlMid: 222.4,
    k: 1.0001,
    kSource: "engine",
    fairValue: 222.42,
    gapBps: -0.4,
    refTick: 222_270,
    bandTicks: 100,
    fenceCode: 5,
    regime: "WEEKEND_DARK",
    reopenKind: null,
    sessionDate: "2026-09-21",
    gatesMask: 1,
    activeGatesJson: '["CLOSED"]',
    riskMode: "reduce_only",
    sourcesJson: '{"chain":{"ok":true}}',
  };
}

function signal(db: DeskDb, preimage: Record<string, unknown>, atMs: number) {
  const id = testUlid();
  db.insertDecision(
    decisionRow(id, {
      status: "dry_run",
      createdAtMs: atMs,
      planJson: canonicalJson({
        actions: [{ kind: "signal", lane: "A", note: "gates none → CLOSED · WEEKEND_DARK" }],
        rationale: ["gate signal"],
      }),
    }),
  );
  const json = canonicalJson(preimage);
  db.insertGateSignal({
    decisionId: id,
    laneAddress: LANE,
    onchainId: encodeDecisionId(id, 0),
    initial: false,
    fromKey: "3:0",
    toKey: "4:1",
    toRegime: "WEEKEND_DARK",
    regimeCode: 4,
    gatesMask: 1,
    gatesJson: '["CLOSED"]',
    atMs,
    reasonHash: keccak256(stringToBytes(json)),
    preimageJson: json,
    createdAtMs: atMs,
  });
  return id;
}

async function seeded() {
  const db = memDb();
  db.insertDesk(deskRow({ ownerUserId: "user-secret-id", statusDetail: "detail with sk_live_x" }));
  db.insertTick(tick());
  db.upsertDelegation({
    walletId: "wallet-1",
    userId: "user-secret-id",
    accountAddress: OPERATOR_ADDR,
    chain: "EVM",
    laneAddress: LANE,
    status: "active",
    keyShareCt: "SECRET-KEYSHARE-CIPHERTEXT",
    apiKeyCt: "SECRET-APIKEY-CIPHERTEXT",
    dekWrapped: "SECRET-DEK",
    kekId: "kek-1",
    createdEventId: "evt-1",
    revokedEventId: null,
    createdAtMs: T0,
    updatedAtMs: T0,
    revokedAtMs: null,
  });
  const rerange = testUlid();
  db.insertDecision(
    decisionRow(rerange, {
      status: "advisory",
      createdAtMs: T0 - 1_000,
      statusDetail: "internal: rpc https://rpc.example/v2/SECRETKEY failed",
      snapshotJson: canonicalJson({ owner: OWNER }),
      planJson: canonicalJson({
        actions: [
          {
            kind: "rerange",
            lane: "A",
            ranges: [{ tickLower: 222_170, tickUpper: 222_370, share0Bps: 5000, share1Bps: 5000 }],
          },
        ],
        rationale: [
          "trigger: initial_mint",
          `placement: straddle centred on F for owner ${OWNER} via https://rpc.example/v2/SECRETKEY`,
        ],
      }),
    }),
  );
  const signed = await seedSignedExecution(db);
  const open = signal(
    db,
    {
      lane: LANE,
      from: null,
      to: { regime: "WEEKEND_DARK", gates: ["CLOSED"] },
      at: T0,
      source: "initial",
    },
    T0 + 1,
  );
  signal(db, { lane: LANE, owner: OWNER, to: "x", at: T0 }, T0 + 2);
  return { db, rerange, signed, open };
}

function feedApp(db: DeskDb, opts: Parameters<typeof createPublicFeedRoutes>[1] = {}) {
  const desks = {
    db,
    allowedPools: [NVDA_USDG_POOL.address],
    defaultMode: "advisory",
  } as unknown as DeskApiDeps;
  return createPublicFeedRoutes({ health, desks, logger: silentLogger }, opts);
}

const get = (
  app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> },
  ip = "203.0.113.7",
) => app.request("/public/feed", { headers: { "x-forwarded-for": ip } });

describe("GET /public/feed: shape", () => {
  it("lists lanes with regime and gates, decisions, gate signals, modes and health", async () => {
    const { db, rerange, signed, open } = await seeded();
    const r = await get(feedApp(db));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=5");
    const f = (await r.json()) as PublicFeed;
    expect(f).toMatchObject({ kind: "deltadesk-public-feed", version: 1, live: true });
    expect(f.agent).toEqual({
      defaultMode: "advisory",
      modes: { copilot: 1 },
      health: { ok: true, lastTickAgeMs: 4_000, lockHeld: true, pendingExecutions: 0 },
    });
    expect(f.lanes).toHaveLength(1);
    expect(f.lanes[0]).toMatchObject({
      lane: LANE,
      operator: OPERATOR_ADDR,
      mode: "copilot",
      status: "active",
      pool: { name: "NVDA/USDG" },
      regime: {
        name: "WEEKEND_DARK",
        activeGates: ["CLOSED"],
        riskMode: "reduce_only",
        gapBps: -0.4,
      },
    });

    const d = f.decisions.find((x) => x.id === rerange);
    expect(d).toMatchObject({
      kind: "rerange",
      status: "advisory",
      decisionId: encodeDecisionId(rerange, 0),
    });
    expect(d?.summary).toMatch(/^trigger: initial_mint; placement: straddle centred on F/);
    const s = f.decisions.find((x) => x.id === signed.decisionId);
    expect(s?.txHashes).toEqual([signed.txHash]);

    expect(f.signals).toHaveLength(2);
    const sig = f.signals.find((x) => x.decisionId === encodeDecisionId(open, 0));
    expect(sig).toMatchObject({
      lane: LANE,
      regime: "WEEKEND_DARK",
      gates: ["CLOSED"],
      gatesMask: 1,
      preimageVerified: true,
      preimageWithheld: false,
      status: "not_sent",
    });
    expect(sig?.preimage).toContain('"source":"initial"');
    expect(keccak256(stringToBytes(sig?.preimage ?? ""))).toBe(sig?.reasonHash);
  });

  it("says the desk is not live when no lane is registered, and when the desk API is absent", async () => {
    const empty = (await (await get(feedApp(memDb()))).json()) as PublicFeed;
    expect(empty).toMatchObject({ live: false, lanes: [], decisions: [], signals: [] });
    const app = createHttpApp({ health, webhook: null, desks: null, logger: silentLogger });
    const r = await app.request("/public/feed");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ live: false, agent: { defaultMode: null } });
  });
});

describe("GET /public/feed: nothing sensitive", () => {
  it("never carries the owner, user ids, key material, status details, raw JSON or URLs", async () => {
    const { db } = await seeded();
    const text = await (await get(feedApp(db))).text();
    for (const secret of [
      OWNER,
      "user-secret-id",
      "SECRET",
      "sk_live",
      "https://",
      "ownerUserId",
      "keyShare",
      "apiKey",
      "dekWrapped",
      "walletId",
      "statusDetail",
      "snapshotJson",
      "planJson",
      "capsJson",
      "tickLower",
      "authorization",
      "jwt",
      "@",
    ]) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("withholds a preimage that names a non-public address instead of altering it", async () => {
    const { db } = await seeded();
    const f = (await (await get(feedApp(db))).json()) as PublicFeed;
    const withheld = f.signals.find((x) => x.preimageWithheld);
    expect(withheld).toMatchObject({ preimage: null, preimageVerified: null });
    expect(withheld?.reasonHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("GET /public/feed: cache and rate limit", () => {
  it("caches the feed for 5 s", async () => {
    const { db } = await seeded();
    let now = T0;
    const app = feedApp(db, { now: () => now });
    const a = (await (await get(app)).json()) as PublicFeed;
    db.insertDecision(decisionRow(testUlid(), { status: "dry_run", createdAtMs: T0 + 10 }));
    now += 4_999;
    const b = (await (await get(app)).json()) as PublicFeed;
    expect(b.generatedAtMs).toBe(a.generatedAtMs);
    expect(b.decisions).toHaveLength(a.decisions.length);
    now += 1;
    const c = (await (await get(app)).json()) as PublicFeed;
    expect(c.generatedAtMs).toBe(T0 + 5_000);
    expect(c.decisions).toHaveLength(a.decisions.length + 1);
  });

  it("limits each client IP (rightmost X-Forwarded-For hop) and resets after the window", async () => {
    let now = T0;
    const app = feedApp(memDb(), { now: () => now, rateLimit: { max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++)
      expect((await get(app, `10.0.0.${i}, 198.51.100.1`)).status).toBe(200);
    const limited = await get(app, "spoofed, 198.51.100.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: "rate limited" });
    expect((await get(app, "198.51.100.2")).status).toBe(200); // another client
    now += 60_000;
    expect((await get(app, "198.51.100.1")).status).toBe(200);
  });
});
