import { randomBytes } from "node:crypto";
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
import {
  createDynamicWebhookHandler,
  factoryLaneOwnerProbe,
  signDynamicPayload,
} from "../../../src/http/dynamic-webhook.js";
import { silentLogger } from "../../../src/log.js";
import { signalPreimage } from "../../../src/regime/signal.js";
import { createVault } from "../../../src/signer/vault.js";
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

function laneChain(
  p: {
    operator?: Address;
    pool?: Address;
    isLane?: boolean;
    /** factory.lanesOf(wallet): only lanes the wallet sent createLane for itself (listed). */
    lanesOf?: (wallet: Address) => Address[];
  } = {},
) {
  const chain = new FakeChain();
  chain.callImpl = async (req) => {
    if (req.to.toLowerCase() === FACTORY) {
      const { functionName, args } = decodeFunctionData({
        abi: deskLaneFactoryAbi,
        data: req.data,
      });
      const arg = String(args?.[0] ?? "").toLowerCase() as Address;
      if (functionName === "lanesOf")
        return encodeFunctionResult({
          abi: deskLaneFactoryAbi,
          functionName,
          result: p.lanesOf?.(arg) ?? [],
        });
      if (functionName === "listed") {
        const all = [OWNER_ADDR, OPERATOR_ADDR].flatMap((w) => p.lanesOf?.(w) ?? []);
        return encodeFunctionResult({
          abi: deskLaneFactoryAbi,
          functionName,
          result: all.map((a) => a.toLowerCase()).includes(arg),
        });
      }
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

describe("a Vault whose only lane is UNLISTED (deployed for it by a third party)", () => {
  const WEBHOOK_SECRET = "whsec_test_0123456789abcdef";
  const sealed = { alg: "HYBRID-RSA-AES-256", iv: "aQ", ct: "Yw", tag: "dA", ek: "ZQ" };

  /** The real webhook handler, owner probe on the same fake factory; decryption faked. */
  function webhookOn(db: DeskDb, chain: FakeChain) {
    const handler = createDynamicWebhookHandler({
      db,
      secret: WEBHOOK_SECRET,
      environmentId: ENV_ID,
      rsaPrivateKeyPem: () => "unused",
      vault: createVault({ kekB64: randomBytes(32).toString("base64"), kekId: "k1" }),
      decrypt: () => ({ decryptedDelegatedShare: { s: 1 } as never, decryptedWalletApiKey: "k" }),
      isLaneOwner: factoryLaneOwnerProbe(chain, FACTORY),
      clock: fixedClock(T0),
      logger: silentLogger,
    });
    return (walletId: string, address: Address) => {
      const raw = Buffer.from(
        JSON.stringify({
          eventId: `evt-${walletId}`,
          eventName: "wallet.delegation.created",
          environmentId: ENV_ID,
          timestamp: new Date(T0).toISOString(),
          data: {
            walletId,
            userId: "user-1",
            publicKey: address,
            encryptedDelegatedShare: sealed,
            encryptedWalletApiKey: sealed,
          },
        }),
      );
      return handler.handle(raw, {
        "x-dynamic-signature-256": signDynamicPayload(raw, WEBHOOK_SECRET),
      });
    };
  }

  it("the probe says not-owner, the webhook stores it, and POST /desks purges it", async () => {
    const chain = laneChain({ lanesOf: () => [] }); // the lane names OWNER but is not listed
    const probe = factoryLaneOwnerProbe(chain, FACTORY);
    expect(await probe(OWNER_ADDR)).toBe(false);
    const s = await setup({ chain });
    const post = webhookOn(s.db, chain);
    expect((await post("wallet-vault", OWNER_ADDR)).body).toMatchObject({ ok: true });
    expect(s.db.getDelegation("wallet-vault")?.status).toBe("active"); // not caught by the probe
    delegate(s.db, OPERATOR_ADDR);
    expect((await s.call("POST", "/desks", { lane: LANE, chainId: 4663 })).status).toBe(201);
    expect(s.db.getDelegation("wallet-vault")?.status).toBe("revoked"); // caught at registration
    expect(s.db.getDelegation("wallet-vault")?.keyShareCt).toBeNull();
    expect(s.db.getDelegation("wallet-op-1")?.status).toBe("active");
  });

  it("never registered: the 24 h unbound purge revokes it", async () => {
    const chain = laneChain({ lanesOf: () => [] });
    const db = memDb();
    await webhookOn(db, chain)("wallet-vault", OWNER_ADDR);
    expect(db.purgeUnboundDelegations(T0, T0 + 1)).toEqual([]); // not 24 h old yet
    const purged = db.purgeUnboundDelegations(T0 + 1, T0 + 24 * 3_600_000 + 1);
    expect(purged.map((d) => d.walletId)).toEqual(["wallet-vault"]);
    expect(db.getDelegation("wallet-vault")?.status).toBe("revoked");
  });

  it("contrast: once the Vault confirms (listed), the webhook refuses its delegation outright", async () => {
    const chain = laneChain({ lanesOf: (w) => (w === OWNER_ADDR ? [LANE] : []) });
    const db = memDb();
    const r = await webhookOn(db, chain)("wallet-vault", OWNER_ADDR);
    expect(r.body).toMatchObject({ ignored: "wallet is a lane owner" });
    expect(db.getDelegation("wallet-vault")).toBeNull();
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

describe("GET /desks/:lane/signals/:decisionId (a gate signal and its reasonHash preimage)", () => {
  it("owner only; by bytes32 or ULID; the preimage hashes to the reasonHash; 404 when unknown", async () => {
    const s = await registered();
    const id = seedDecision(s.db, { laneAddress: LANE });
    const pre = signalPreimage({
      lane: LANE,
      from: null,
      to: { regime: "WEEKEND_DARK", regimeCode: 4, gates: ["CLOSED"], gatesMask: 1 },
      atMs: T0,
      source: "initial",
    });
    s.db.insertGateSignal({
      decisionId: id,
      laneAddress: LANE,
      onchainId: encodeDecisionId(id, 0),
      initial: true,
      fromKey: null,
      toKey: "4:1",
      toRegime: "WEEKEND_DARK",
      regimeCode: 4,
      gatesMask: 1,
      gatesJson: '["CLOSED"]',
      atMs: T0,
      reasonHash: pre.hash,
      preimageJson: pre.json,
      createdAtMs: T0,
    });
    for (const key of [encodeDecisionId(id, 0), id]) {
      const r = await s.call("GET", `/desks/${LANE}/signals/${key}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        decisionId: encodeDecisionId(id, 0),
        decisionUlid: id,
        status: "pending",
        regime: "WEEKEND_DARK",
        regimeCode: 4,
        gates: ["CLOSED"],
        gatesMask: 1,
        reasonHash: pre.hash,
        preimageJson: pre.json,
        verified: true,
        preimage: { lane: LANE.toLowerCase(), from: null, source: "initial" },
      });
    }
    const status = (await (await s.call("GET", `/desks/${LANE}/status`)).json()) as {
      lastSignal: Record<string, unknown>;
    };
    expect(status.lastSignal).toMatchObject({
      decisionId: encodeDecisionId(id, 0),
      status: "pending",
    });
    expect(
      (await s.call("GET", `/desks/${LANE}/signals/${id}`, undefined, s.strangerJwt)).status,
    ).toBe(403);
    expect((await s.call("GET", `/desks/${LANE}/signals/${seedDecision(s.db)}`)).status).toBe(404);
    expect((await s.call("GET", `/desks/${LANE}/signals/nope`)).status).toBe(400);
    expect(
      (await s.call("GET", `/desks/${LANE}/signals/${id}`, undefined, s.ownerJwt, null)).status,
    ).toBe(401);
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

describe("GET /delegations/:operator (the wizard's poll, before POST /desks)", () => {
  const LEAK = ["v1.a.b.c", "keyShareCt", "apiKeyCt", "dekWrapped", "kekId", "userId"];
  const operatorJwt = (s: Awaited<ReturnType<typeof setup>>, sub = "user-1") =>
    s.kit.token(walletsClaim(owner.address, getAddress(OPERATOR_ADDR)), { sub });

  it("needs the agent key and a Dynamic JWT holding the operator wallet", async () => {
    const s = await setup();
    const path = `/delegations/${OPERATOR_ADDR}`;
    const jwt = await operatorJwt(s);
    expect((await s.call("GET", path, undefined, jwt, null)).status).toBe(401);
    expect((await s.call("GET", path, undefined, jwt, "wrong-key-0123456789abcdef")).status).toBe(
      401,
    );
    expect((await s.call("GET", path, undefined, null)).status).toBe(401);
    expect((await s.call("GET", path, undefined, "a.b.c")).status).toBe(401);
    // The Vault's JWT without the operator among its wallets, and a stranger's.
    expect((await s.call("GET", path, undefined, s.ownerJwt)).status).toBe(403);
    expect((await s.call("GET", path, undefined, s.strangerJwt)).status).toBe(403);
    // The operator's JWT, but the stored delegation belongs to another user.
    delegate(s.db, OPERATOR_ADDR, "user-2");
    expect((await s.call("GET", path, undefined, jwt)).status).toBe(403);
    // Positive path: the right user.
    expect((await s.call("GET", path, undefined, await operatorJwt(s, "user-2"))).status).toBe(200);
    expect((await s.call("GET", "/delegations/0x1234", undefined, jwt)).status).toBe(400);
    const noAuth = await setup({ jwt: null });
    expect((await noAuth.call("GET", path, undefined, jwt)).status).toBe(503);
  });

  it("unknown before the webhook lands, for an operator no desk registered yet", async () => {
    const s = await setup();
    expect(s.db.listDesks()).toEqual([]);
    const r = await s.call("GET", `/delegations/${OPERATOR_ADDR}`, undefined, await operatorJwt(s));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      operator: getAddress(OPERATOR_ADDR),
      status: "unknown",
      walletId: null,
      updatedAtMs: null,
    });
  });

  it("active once delegated; any case in, checksummed out; never key material", async () => {
    const s = await setup();
    delegate(s.db, OPERATOR_ADDR);
    const jwt = await operatorJwt(s);
    for (const form of [
      OPERATOR_ADDR,
      getAddress(OPERATOR_ADDR),
      OPERATOR_ADDR.toUpperCase().replace("0X", "0x"),
    ]) {
      const r = await s.call("GET", `/delegations/${form}`, undefined, jwt);
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({
        operator: getAddress(OPERATOR_ADDR),
        status: "active",
        walletId: "wallet-op-1",
        updatedAtMs: T0,
      });
      expect(Object.keys(JSON.parse(text)).sort()).toEqual([
        "operator",
        "status",
        "updatedAtMs",
        "walletId",
      ]);
      for (const needle of LEAK) expect(text).not.toContain(needle);
    }
  });

  it("revoked after a Dynamic revoke (sticky: an older created event cannot bring it back)", async () => {
    const s = await setup();
    delegate(s.db, OPERATOR_ADDR);
    // What the webhook does on wallet.delegation.revoked: record the revoke per event, then revoke.
    s.db.recordDelegationRevocation({
      eventId: "evt-revoke-1",
      walletId: "wallet-op-1",
      eventAtMs: T0 + 1_000,
      recordedAtMs: T0 + 1_000,
    });
    expect(s.db.revokeDelegation("wallet-op-1", "evt-revoke-1", T0 + 1_000)).toBe(true);
    const jwt = await operatorJwt(s);
    const r = await s.call("GET", `/delegations/${OPERATOR_ADDR}`, undefined, jwt);
    expect(await r.json()).toEqual({
      operator: getAddress(OPERATOR_ADDR),
      status: "revoked",
      walletId: "wallet-op-1",
      updatedAtMs: T0 + 1_000,
    });
    expect(s.db.latestDelegationRevocationAt("wallet-op-1")).toBe(T0 + 1_000);
    // A re-delegation (a new wallet row) shows active again: the active row wins.
    delegate(s.db, OPERATOR_ADDR, "user-1", "wallet-op-2");
    const again = (await (
      await s.call("GET", `/delegations/${OPERATOR_ADDR}`, undefined, jwt)
    ).json()) as { status: string; walletId: string };
    expect(again).toMatchObject({ status: "active", walletId: "wallet-op-2" });
  });

  it("the desk API off (no DYNAMIC_ENVIRONMENT_ID / key): 503 from the server shell", async () => {
    const { createHttpApp } = await import("../../../src/http/server.js");
    const app = createHttpApp({
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
    expect((await app.request(`/delegations/${OPERATOR_ADDR}`)).status).toBe(503);
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
