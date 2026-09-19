import { decodeFunctionData, encodeFunctionResult, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { NVDA_USDG_POOL } from "../../../src/addresses.js";
import { canonicalJson } from "../../../src/canonical.js";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import { deskLaneFactoryAbi } from "../../../src/executor/abi/DeskLaneFactory.js";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { createJwtVerifier } from "../../../src/http/auth.js";
import { createDeskRoutes, type DeskApiDeps, modeMessage } from "../../../src/http/desks.js";
import { silentLogger } from "../../../src/log.js";
import type {
  Address,
  DeskDb,
  DeskNotification,
  Hex,
  LaneCaps,
  LaneOnchainState,
} from "../../../src/types.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import {
  ANVIL_KEY_2,
  FakeChain,
  LANE,
  OPERATOR_ADDR,
  seedDecision,
  T0,
} from "../executor/_fixtures.js";
import { ENV_ID, jwtKit, walletsClaim } from "./_http.js";

const owner = privateKeyToAccount(ANVIL_KEY_2);
const OWNER_ADDR = owner.address.toLowerCase() as Address;
const FACTORY = "0x4444444444444444444444444444444444444444" as Address;
const AGENT_KEY = "agent-key-0123456789abcdefghij";
const CAPS: LaneCaps = {
  maxDeployUsd6: 60_000_000n,
  turnoverUsd6PerDay: 150_000_000n,
  placeBandBps: 100,
  maxTickDelta: 10,
  minWidthTicks: 20,
  maxWidthTicks: 2_000,
  reranges1h: 4,
  reranges24h: 24,
  minRerangeInterval: 300,
  maxDeadlineAhead: 120,
  maxRanges: 2,
};

function laneChain(p: { operator?: Address; pool?: Address; isLane?: boolean } = {}) {
  const chain = new FakeChain();
  chain.callImpl = async (req) => {
    if (req.to.toLowerCase() === FACTORY) {
      decodeFunctionData({ abi: deskLaneFactoryAbi, data: req.data });
      return encodeFunctionResult({
        abi: deskLaneFactoryAbi,
        functionName: "isLane",
        result: p.isLane ?? true,
      });
    }
    const { functionName } = decodeFunctionData({ abi: deskLaneAbi, data: req.data });
    const results: Record<string, unknown> = {
      owner: OWNER_ADDR,
      operator: p.operator ?? OPERATOR_ADDR,
      guardian: "0x0000000000000000000000000000000000000000",
      laneId: 0,
      pool: p.pool ?? NVDA_USDG_POOL.address,
      token0: NVDA_USDG_POOL.token0,
      token1: NVDA_USDG_POOL.token1,
      fence: "0x5555555555555555555555555555555555555555",
      paused: false,
      caps: CAPS,
    };
    return encodeFunctionResult({
      abi: deskLaneAbi,
      functionName: functionName as "owner",
      result: results[functionName] as never,
    });
  };
  return chain;
}

function delegate(db: DeskDb, address: Address, userId = "user-1", walletId = "wallet-op-1") {
  db.upsertDelegation({
    walletId,
    userId,
    accountAddress: address,
    chain: "EVM",
    laneAddress: null,
    status: "active",
    keyShareCt: "v1.a.b.c",
    apiKeyCt: "v1.a.b.c",
    dekWrapped: "v1.a.b.c",
    kekId: "k1",
    createdEventId: `evt-${walletId}`,
    revokedEventId: null,
    createdAtMs: T0,
    updatedAtMs: T0,
    revokedAtMs: null,
  });
}

async function setup(over: Partial<DeskApiDeps> & { chain?: FakeChain } = {}) {
  const db = memDb();
  const kit = await jwtKit();
  const clock = fixedClock(T0);
  const app = createDeskRoutes({
    db,
    chain: over.chain ?? laneChain(),
    jwt: createJwtVerifier({
      environmentId: ENV_ID,
      jwksUrl: "https://unused.invalid",
      keys: kit.keys,
    }),
    agentApiKey: AGENT_KEY,
    chainId: 4663,
    factoryAddress: FACTORY,
    allowedPools: [NVDA_USDG_POOL.address],
    signerKind: "dynamic-delegated",
    ownOperators: [],
    serverWalletAddress: undefined,
    defaultMode: "advisory",
    cancelWindowMs: 0,
    clock,
    logger: silentLogger,
    ...over,
  });
  const ownerJwt = await kit.token(walletsClaim(owner.address));
  const strangerJwt = await kit.token(walletsClaim("0x7777777777777777777777777777777777777777"), {
    sub: "user-2",
  });
  const call = (
    method: string,
    path: string,
    body?: unknown,
    jwt: string | null = ownerJwt,
    key: string | null = AGENT_KEY,
  ) =>
    app.request(path, {
      method,
      headers: {
        ...(key === null ? {} : { "x-desk-agent-key": key }),
        ...(jwt === null ? {} : { authorization: `Bearer ${jwt}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { db, app, call, clock, kit, ownerJwt, strangerJwt };
}

async function registered() {
  const s = await setup();
  delegate(s.db, OPERATOR_ADDR);
  const r = await s.call("POST", "/desks", { lane: LANE, chainId: 4663 });
  expect(r.status).toBe(201);
  return s;
}

describe("desk API auth", () => {
  it("every route needs the agent key (when configured) and a Dynamic JWT", async () => {
    const s = await setup();
    expect(
      (await s.call("POST", "/desks", { lane: LANE, chainId: 4663 }, s.ownerJwt, null)).status,
    ).toBe(401);
    expect(
      (
        await s.call(
          "POST",
          "/desks",
          { lane: LANE, chainId: 4663 },
          s.ownerJwt,
          "wrong-key-0123456789abcdef",
        )
      ).status,
    ).toBe(401);
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 }, null)).status).toBe(401);
    expect((await s.call("GET", `/desks/${LANE}/status`, undefined, "a.b.c")).status).toBe(401);
    expect((await s.call("GET", "/operator-address", undefined, null, null)).status).toBe(401);
  });
});

describe("POST /desks", () => {
  it("registers a lane owned by the signed-in Vault whose operator the same user delegated", async () => {
    const s = await setup();
    delegate(s.db, OPERATOR_ADDR);
    delegate(s.db, OWNER_ADDR, "user-1", "wallet-vault"); // must be purged: the Vault is never delegated
    const r = await s.call("POST", "/desks", { lane: getAddress(LANE), chainId: 4663 });
    expect(r.status).toBe(201);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      lane: LANE,
      owner: OWNER_ADDR,
      operator: OPERATOR_ADDR,
      mode: "advisory",
      status: "active",
      signerKind: "dynamic-delegated",
    });
    expect(body.caps).toEqual(JSON.parse(canonicalJson(CAPS)));
    expect(s.db.getDelegation("wallet-op-1")?.laneAddress).toBe(LANE);
    expect(s.db.getDelegation("wallet-vault")?.status).toBe("revoked");
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(409);
  });

  it("a purged Vault delegation tells the user to revoke it in Dynamic too", async () => {
    const notes: DeskNotification[] = [];
    const s = await setup({ notifier: { notify: async (n) => void notes.push(n) } });
    delegate(s.db, OPERATOR_ADDR);
    delegate(s.db, OWNER_ADDR, "user-1", "wallet-vault");
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(201);
    expect(s.db.getDelegation("wallet-vault")?.status).toBe("revoked");
    const alert = notes.find((n) => n.severity === "critical");
    expect((alert?.lines ?? []).join(" ")).toMatch(/Revoke the Vault's delegation in Dynamic/);
  });

  it("412 until the operator is delegated; 403 when another user delegated it", async () => {
    const s = await setup();
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(412);
    delegate(s.db, OPERATOR_ADDR, "user-2");
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(403);
    expect(s.db.getDesk(LANE)).toBeNull();
  });

  it("403 when the signed-in wallet is not the lane's owner", async () => {
    const s = await setup();
    delegate(s.db, OPERATOR_ADDR, "user-2");
    expect(
      (await s.call("POST", "/desks", { lane: LANE, chainId: 4663 }, s.strangerJwt)).status,
    ).toBe(403);
  });

  it("400 for a wrong chain, a non-factory lane or a pool that is not allowed", async () => {
    expect((await (await setup()).call("POST", "/desks", { lane: LANE, chainId: 1 })).status).toBe(
      400,
    );
    expect(
      (await (await setup()).call("POST", "/desks", { lane: "0x12", chainId: 4663 })).status,
    ).toBe(400);
    expect(
      (
        await (
          await setup({ chain: laneChain({ isLane: false }) })
        ).call("POST", "/desks", { lane: LANE, chainId: 4663 })
      ).status,
    ).toBe(400);
    const s = await setup({
      chain: laneChain({ pool: "0x6666666666666666666666666666666666666666" }),
    });
    delegate(s.db, OPERATOR_ADDR);
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(400);
    expect((await s.call("POST", "/desks", "{not json")).status).toBe(400);
  });

  it("an RPC outage while reading the lane is 503, not a verdict on the lane", async () => {
    const down = new FakeChain();
    down.callImpl = async () => {
      throw Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    };
    const s = await setup({ chain: down });
    delegate(s.db, OPERATOR_ADDR);
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(503);
  });

  it("Plan B / fork operators need no delegation but must be the agent's own wallet", async () => {
    const s = await setup({ signerKind: "dynamic-server", ownOperators: [OPERATOR_ADDR] });
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(201);
    const t = await setup({
      signerKind: "dynamic-server",
      ownOperators: ["0x8888888888888888888888888888888888888888"],
    });
    expect((await t.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(412);
  });
});

describe("GET /desks/:lane/status", () => {
  it("404 before registration; 403 for anyone but the owner", async () => {
    const s = await setup();
    expect((await s.call("GET", `/desks/${LANE}/status`)).status).toBe(404);
    const r = await registered();
    expect((await r.call("GET", `/desks/${LANE}/status`, undefined, r.strangerJwt)).status).toBe(
      403,
    );
  });

  it("returns the desk view: delegation, caps, live lane state, last tick, pending approvals (bytes32)", async () => {
    const onchain = {
      budgets: {
        turnoverAvailableUsd6: 150_000_000n,
        reranges1hLeft: 4n,
        reranges24hLeft: 24n,
        nextRerangeAt: 0n,
      },
      positionDetails: [
        {
          tokenId: 5n,
          tickLower: -222_400,
          tickUpper: -222_200,
          liquidity: 99n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
          feeGrowthInside0LastX128: 0n,
          feeGrowthInside1LastX128: 0n,
        },
        null,
      ],
      balances: { token0: 1_000_000n, token1: 2n },
    } as unknown as LaneOnchainState;
    const s = await setup({ readLane: async () => onchain });
    delegate(s.db, OPERATOR_ADDR);
    await s.call("POST", "/desks", { lane: LANE, chainId: 4663 });
    s.db.insertTick({
      laneAddress: LANE,
      atMs: T0 - 5_000,
      blockNumber: 1,
      blockTs: 1,
      poolTick: -222_277,
      sqrtPriceX96: 1n,
      poolMid: 222.1,
      hlMid: 222,
      k: 1.0005,
      kSource: "engine",
      fairValue: 222.11,
      gapBps: 0.4,
      refTick: -222_280,
      bandTicks: 100,
      fenceCode: 0,
      regime: "REGULAR",
      reopenKind: null,
      sessionDate: "2026-09-21",
      gatesMask: 0,
      activeGatesJson: '["REOPEN-GUARD"]',
      riskMode: "reduce_only",
      sourcesJson: "{}",
    });
    const decision = seedDecision(s.db, { status: "advisory", statusDetail: "rerange (advisory)" });
    s.db.createApproval({
      decisionId: decision,
      laneAddress: LANE,
      summary: "rerange $50",
      requestedAtMs: T0,
      expiresAtMs: T0 + 120_000,
    });
    const r = await s.call("GET", `/desks/${LANE}/status`);
    expect(r.status).toBe(200);
    const v = (await r.json()) as Record<string, unknown>;
    expect(v).toMatchObject({
      lane: LANE,
      owner: OWNER_ADDR,
      operator: OPERATOR_ADDR,
      mode: "advisory",
      status: "active",
      delegation: { status: "active" },
      budgets: { turnoverAvailableUsd6: "150000000", reranges1hLeft: "4" },
      positions: [
        { slot: 0, tokenId: "5", tickLower: -222_400, tickUpper: -222_200, liquidity: "99" },
      ],
      balances: { token0: "1000000", token1: "2" },
      lastTick: {
        regime: "REGULAR",
        gates: ["REOPEN-GUARD"],
        F: 222.11,
        refTick: -222_280,
        band: 100,
      },
      lastDecision: { decisionId: decision, status: "advisory" },
      pendingApprovals: [
        {
          decisionId: encodeDecisionId(decision, 0),
          summary: "rerange $50",
          expiresAtMs: T0 + 120_000,
        },
      ],
    });
  });
});

describe("POST /desks/:lane/mode (owner-signed EIP-191)", () => {
  const sign = (mode: string, nonce: string) =>
    owner.signMessage({ message: modeMessage(LANE, mode as "copilot", nonce) });

  it("applies a mode signed by the owner over `DeltaDesk mode <lane> <mode> <nonce>`", async () => {
    const s = await registered();
    expect(modeMessage(LANE, "copilot", "1")).toBe(`DeltaDesk mode ${getAddress(LANE)} copilot 1`);
    const nonce = String(T0);
    const r = await s.call("POST", `/desks/${LANE}/mode`, {
      mode: "copilot",
      signature: await sign("copilot", nonce),
      nonce,
    });
    expect(r.status).toBe(200);
    expect(s.db.getDesk(LANE)).toMatchObject({ mode: "copilot", modeNonce: T0 });
  });

  it("refuses replays and stale nonces (409), other signers (403), autopilot without a window (400)", async () => {
    const s = await registered();
    const sig = await sign("copilot", "10");
    expect(
      (
        await s.call("POST", `/desks/${LANE}/mode`, {
          mode: "copilot",
          signature: sig,
          nonce: "10",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await s.call("POST", `/desks/${LANE}/mode`, {
          mode: "copilot",
          signature: sig,
          nonce: "10",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await s.call("POST", `/desks/${LANE}/mode`, {
          mode: "advisory",
          signature: await sign("advisory", "9"),
          nonce: "9",
        })
      ).status,
    ).toBe(409);
    const stranger = privateKeyToAccount(
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    );
    const bad = await stranger.signMessage({ message: modeMessage(LANE, "advisory", "11") });
    expect(
      (
        await s.call("POST", `/desks/${LANE}/mode`, {
          mode: "advisory",
          signature: bad,
          nonce: "11",
        })
      ).status,
    ).toBe(403);
    // A signature over another mode does not authorise this one.
    expect(
      (
        await s.call("POST", `/desks/${LANE}/mode`, {
          mode: "advisory",
          signature: await sign("copilot", "12"),
          nonce: "12",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await s.call("POST", `/desks/${LANE}/mode`, {
          mode: "autopilot",
          signature: await sign("autopilot", "13"),
          nonce: "13",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await s.call("POST", `/desks/${LANE}/mode`, {
          mode: "advisory",
          signature: "0x1234",
          nonce: "14",
        })
      ).status,
    ).toBe(400);
    expect(s.db.getDesk(LANE)?.mode).toBe("copilot");
  });

  it("an owner-signed mode change clears safe mode (the human acknowledgement)", async () => {
    const s = await registered();
    s.db.setDeskStatus(LANE, "safe_mode", "foreign LaneAction", T0);
    await s.call("POST", `/desks/${LANE}/mode`, {
      mode: "advisory",
      signature: await sign("advisory", "20"),
      nonce: "20",
    });
    expect(s.db.getDesk(LANE)?.status).toBe("active");
  });
});

describe("POST /desks/:lane/approve", () => {
  it("answers a pending copilot approval from the web (bytes32 or ULID ids)", async () => {
    const s = await registered();
    const d = seedDecision(s.db);
    s.db.createApproval({
      decisionId: d,
      laneAddress: LANE,
      summary: "x",
      requestedAtMs: T0,
      expiresAtMs: T0 + 60_000,
    });
    const r = await s.call("POST", `/desks/${LANE}/approve`, {
      decisionId: encodeDecisionId(d, 0),
      approve: true,
    });
    expect(r.status).toBe(200);
    expect(s.db.getApproval(d)).toMatchObject({
      status: "approved",
      channel: "web",
      respondedBy: "user-1",
    });
    expect(
      (await s.call("POST", `/desks/${LANE}/approve`, { decisionId: d, approve: false })).status,
    ).toBe(409);
  });

  it("404 for another lane's decision; 409 once expired; 400 for a garbage id", async () => {
    const s = await registered();
    const d = seedDecision(s.db);
    s.db.createApproval({
      decisionId: d,
      laneAddress: "0x9999999999999999999999999999999999999999",
      summary: "x",
      requestedAtMs: T0,
      expiresAtMs: T0 + 60_000,
    });
    expect(
      (await s.call("POST", `/desks/${LANE}/approve`, { decisionId: d, approve: true })).status,
    ).toBe(404);
    const e = seedDecision(s.db);
    s.db.createApproval({
      decisionId: e,
      laneAddress: LANE,
      summary: "x",
      requestedAtMs: T0 - 120_000,
      expiresAtMs: T0 - 1,
    });
    expect(
      (await s.call("POST", `/desks/${LANE}/approve`, { decisionId: e, approve: true })).status,
    ).toBe(409);
    expect(
      (
        await s.call("POST", `/desks/${LANE}/approve`, {
          decisionId: "0x1234" as Hex,
          approve: true,
        })
      ).status,
    ).toBe(400);
  });
});

describe("GET /operator-address", () => {
  it("404 without a Plan B wallet; the checksummed address with one", async () => {
    expect((await (await setup()).call("GET", "/operator-address", undefined, null)).status).toBe(
      404,
    );
    const s = await setup({ serverWalletAddress: OPERATOR_ADDR });
    const r = await s.call("GET", "/operator-address", undefined, null);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ address: getAddress(OPERATOR_ADDR), kind: "dynamic-server" });
  });
});
