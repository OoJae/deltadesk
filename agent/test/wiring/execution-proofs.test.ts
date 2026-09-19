/**
 * WIRING-LEVEL SAFETY PROOFS (2/2): execution, custody and startup.
 *
 * The same assembled daemon as decision-proofs.test.ts, now attacked below the guard: a crash
 * between sign and broadcast, a denying or tampering signer, a node that reports a nonce conflict,
 * a deadline that passes mid-sign, a foreign LaneAction, a revoked delegation, and the startup
 * refusals. Each proof shows its positive path.
 *
 * Numbering follows docs/m2-design-agent.md "Wiring safety proofs".
 */

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { NVDA_USDG_POOL } from "../../src/addresses.js";
import { loadConfig } from "../../src/config.js";
import { createReconcileLoop } from "../../src/daemon.js";
import { createBroadcaster } from "../../src/executor/broadcaster.js";
import type { LaneIdentity } from "../../src/executor/chain.js";
import { createDynamicWebhookHandler, signDynamicPayload } from "../../src/http/dynamic-webhook.js";
import { silentLogger } from "../../src/log.js";
import { createLaneRegistry, operatorSigner, preflightLane } from "../../src/main.js";
import { createLaneActionReconciler } from "../../src/reconcile/lane-actions.js";
import { createAttemptResolver, createStartupReconciler } from "../../src/reconcile/startup.js";
import { DEFAULT_LANE_CAPS } from "../../src/sense/mock.js";
import { createDelegatedSigner } from "../../src/signer/dynamic-delegated.js";
import { signerFromConfig } from "../../src/signer/factory.js";
import { createLocalSigner } from "../../src/signer/local.js";
import { createVault, VAULT_PURPOSE } from "../../src/signer/vault.js";
import {
  ConfigRefusedError,
  type DeskNotification,
  type Hex,
  type HlExchangeClient,
  type HlOrderRequest,
  LANE_ACTION_NAMES,
} from "../../src/types.js";
import { ANVIL_KEY_0, fixedClock, makeTestConfig, memDb, OWNER } from "../helpers/fakes.js";
import {
  ANVIL_KEY_2,
  decisionRow,
  decodeSigned,
  EVIL,
  harness,
  LANE_A,
  LOOPBACK,
  laneActionLog,
  OPERATOR_A,
  T0,
  WiringChain,
} from "../helpers/wiring.js";

const decisionOf = (h: ReturnType<typeof harness>) => h.db.recentDecisions(1)[0];
const quietNotifier = { notify: async (_n: DeskNotification) => {} };

describe("SAFETY PROOF 6: a crash after `signed` rebroadcasts the stored bytes, never re-signs", () => {
  it("a process that dies mid-broadcast is recovered at startup with exactly one transaction", async () => {
    const db = memDb();
    const chain = new WiringChain();
    const clock = fixedClock(T0);
    const h = harness({ db, chain, clock });
    await h.tick();
    clock.advance(5_000);
    await h.tick();
    clock.advance(5_000);

    chain.hangSends = 1; // the node never hears about it: the process dies inside broadcast
    void h.tick();
    await vi.waitFor(() => expect(db.unresolvedAttempts()).toHaveLength(1));
    const stored = db.unresolvedAttempts()[0];
    expect(stored?.status).toBe("signed");
    expect(h.signer.requests).toHaveLength(1);
    expect(chain.sent).toHaveLength(0);

    // Restart: startup reconciliation over the same store and chain, then a fresh daemon.
    const broadcaster = createBroadcaster({ chain, clock });
    const deps = { db, chain, broadcaster, clock, logger: silentLogger, notifier: quietNotifier };
    const report = await createStartupReconciler(deps).run(clock.now());
    expect(report.rebroadcast).toBe(1);
    expect(chain.sent).toEqual([stored?.signedRawTx]);
    expect(h.signer.requests).toHaveLength(1); // never re-signed

    h.restart({ resolver: createAttemptResolver(deps) });
    clock.advance(5_000);
    const out = await h.tick(); // settles the in-flight attempt, then plans nothing new
    expect(out.kind).toBe("hold");
    const exec = db.getExecution(stored?.executionId ?? -1);
    expect(exec?.status).toBe("confirmed");
    expect(db.getDecision(exec?.decisionId ?? "")?.status).toBe("executed");
    expect(chain.sent).toHaveLength(1);
    expect(h.signer.requests).toHaveLength(1);
  });

  it("positive path: without the crash, one signature and one broadcast", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(h.signer.requests).toHaveLength(1);
    expect(h.chain.sent).toHaveLength(1);
  });
});

describe("SAFETY PROOF 10: a signer policy denial → `policy_denied` plus safe mode", () => {
  it("records policy_denied, puts the desk in safe mode, and the next decision is advisory", async () => {
    const h = harness({
      sign: async () => {
        throw Object.assign(new Error("Transaction denied by policy"), { status: 403 });
      },
    });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("policy_denied");
    expect(h.db.getDesk(LANE_A)?.status).toBe("safe_mode");
    expect(h.chain.sent).toHaveLength(0);
    expect(h.notes.some((n) => n.severity === "critical" && n.title.includes("POLICY"))).toBe(true);

    h.clock.advance(301_000);
    const next = await h.tickUntilDecision();
    expect(next.status).toBe("advisory");
    expect(next.detail).toContain("safe mode");
    expect(h.signer.requests).toHaveLength(1); // only the denied attempt
  });

  it("positive path: an allowing policy signs and lands", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(h.db.getDesk(LANE_A)?.status).toBe("active");
  });
});

describe("SAFETY PROOF 12: a tampered signer never reaches the node", () => {
  it("bytes that sign a different transaction are rejected before broadcast", async () => {
    const h = harness({
      sign: (tx, base) => base.signTransaction({ ...tx, to: EVIL }),
    });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("failed");
    expect(h.chain.sent).toHaveLength(0);
    expect(h.db.recentExecutions(1)[0]?.errorCode).toBe("SIGNER_MISMATCH");
    expect(h.db.getDesk(LANE_A)?.status).toBe("safe_mode");
  });

  it("a signature by another key claiming to be the operator is rejected before broadcast", async () => {
    const intruder = createLocalSigner({ privateKey: ANVIL_KEY_2, rpcUrl: LOOPBACK });
    const h = harness({ sign: (tx) => intruder.signTransaction(tx) });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("failed");
    expect(h.chain.sent).toHaveLength(0);
    expect(h.db.recentExecutions(1)[0]?.statusDetail).toContain("recovered");
  });

  it("positive path: honest bytes are broadcast", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(h.chain.sent).toHaveLength(1);
  });
});

describe("SAFETY PROOF 13: a foreign LaneAction → safe mode", () => {
  it("our own LaneAction matches; the owner acting directly puts the desk in safe mode (advisory)", async () => {
    const h = harness();
    const reconciler = createLaneActionReconciler({
      db: h.db,
      chain: h.chain,
      lanes: () => [LANE_A],
      clock: h.clock,
      logger: silentLogger,
      notifier: quietNotifier,
      confirmations: 0,
    });
    expect((await h.tickUntilDecision()).status).toBe("executed");
    const exec = h.db.recentExecutions(1)[0];
    h.chain.logs.push(
      laneActionLog({
        decisionId: exec?.onchainId as Hex,
        action: LANE_ACTION_NAMES.indexOf("RERANGE"),
        caller: OPERATOR_A,
        txHash: exec?.txHash as Hex,
        blockNumber: h.chain.head,
      }),
    );
    const mine = await reconciler.run(h.clock.now());
    expect(mine).toMatchObject({ matched: 1, foreign: 0 });
    expect(h.db.getDesk(LANE_A)?.status).toBe("active");

    // The owner pauses from the explorer: not ours.
    h.chain.head += 1n;
    h.chain.logs.push(
      laneActionLog({
        decisionId: `0x${"00".repeat(32)}`,
        action: LANE_ACTION_NAMES.indexOf("PAUSE"),
        caller: OWNER,
        txHash: `0x${"cd".repeat(32)}`,
        blockNumber: h.chain.head,
      }),
    );
    // Wired as the tick's "reconcile if due": the same tick sees it and runs advisory.
    h.restart({
      reconcile: createReconcileLoop({
        tasks: [{ name: "lane-actions", run: (now) => reconciler.run(now) }],
        intervalMs: 30_000,
        clock: h.clock,
        logger: silentLogger,
      }),
    });
    h.clock.advance(301_000);
    const out = await h.tickUntilDecision();
    expect(h.db.getDesk(LANE_A)?.status).toBe("safe_mode");
    expect(h.db.laneActionsByMatch("foreign")).toHaveLength(1);
    expect(out.status).toBe("advisory");
    expect(h.chain.sent).toHaveLength(1); // only the first, matched rerange
  });
});

describe("SAFETY PROOF 15: a nonce conflict → safe mode", () => {
  it("our nonce consumed by a transaction that is not ours stops the desk", async () => {
    const h = harness();
    h.chain.sendErrors.push(new Error("nonce too low"));
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("failed");
    expect(h.db.recentExecutions(1)[0]?.errorCode).toBe("NONCE_CONFLICT");
    expect(h.db.getDesk(LANE_A)?.status).toBe("safe_mode");
    expect(h.chain.sent).toHaveLength(0);

    h.clock.advance(301_000);
    expect((await h.tickUntilDecision()).status).toBe("advisory");
    expect(h.signer.requests).toHaveLength(1);
  });

  it("positive path: a clean nonce lands", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
  });
});

describe("SAFETY PROOF 16: a passed deadline → no broadcast", () => {
  it("bytes signed after the Meta deadline are persisted but never sent", async () => {
    const clock = fixedClock(T0);
    const h = harness({
      clock,
      sign: async (tx, base) => {
        clock.advance(50_000); // a slow signer: past the 45 s deadline
        return base.signTransaction(tx);
      },
    });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("failed");
    const exec = h.db.recentExecutions(1)[0];
    expect(exec?.status).toBe("dropped");
    expect(exec?.errorCode).toBe("DEADLINE_PASSED");
    expect(h.db.attemptsForExecution(exec?.executionId ?? -1)[0]?.broadcastCount).toBe(0);
    expect(h.chain.sent).toHaveLength(0);
  });

  it("positive path: a prompt signer broadcasts within the deadline", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
    const exec = h.db.recentExecutions(1)[0];
    expect(h.db.attemptsForExecution(exec?.executionId ?? -1)[0]?.broadcastCount).toBe(1);
  });
});

describe("SAFETY PROOF 17: the execution row exists before sign()", () => {
  it("the signer is only ever called with a write-ahead row in place", async () => {
    const db = memDb();
    const seen: Array<{ status: string; signed: number | null; decision: string | undefined }> = [];
    const h = harness({
      db,
      sign: (tx, base) => {
        for (const e of db.executionsByStatus(["prepared", "simulated"])) {
          seen.push({
            status: e.status,
            signed: e.signedAtMs,
            decision: db.getDecision(e.decisionId)?.status,
          });
        }
        return base.signTransaction(tx);
      },
    });
    expect((await h.tickUntilDecision()).status).toBe("executed"); // positive path
    expect(seen).toEqual([{ status: "simulated", signed: null, decision: "executing" }]);
    expect(db.recentExecutions(1)[0]?.signedAtMs).not.toBeNull();
  });

  it("a decision that cannot be recorded never reaches the signer", async () => {
    const db = memDb();
    const fixed = "01K5HZ3N8QW000000000000009";
    db.insertDecision(decisionRow(fixed, T0));
    const h = harness({ db, deps: { newDecisionId: () => fixed } });
    const outs = [];
    for (let i = 0; i < 4; i++) {
      outs.push(await h.tick());
      h.clock.advance(5_000);
    }
    expect(outs.some((o) => o.kind === "skipped" && o.reason.includes("crashed"))).toBe(true);
    expect(h.signer.requests).toHaveLength(0);
  });
});

describe("SAFETY PROOF 18: a local signer with a remote RPC is refused", () => {
  const remote = "https://rpc.mainnet.chain.robinhood.com";

  it("config, the signer factory and the signer itself each refuse it", () => {
    expect(() =>
      loadConfig({
        SIGNER_KIND: "local",
        LOCAL_SIGNER_PRIVATE_KEY: ANVIL_KEY_0,
        RH_RPC_URL: remote,
      }),
    ).toThrow(ConfigRefusedError);
    // Even with config bypassed, and even under DRY_RUN, a raw key never signs for a remote chain.
    const base = makeTestConfig();
    const cfg = {
      ...base,
      rpcUrl: remote,
      signer: { ...base.signer, kind: "local" as const, localPrivateKey: ANVIL_KEY_0 as Hex },
    };
    expect(() => signerFromConfig(cfg, memDb(), OPERATOR_A)).toThrow(ConfigRefusedError);
    expect(() => operatorSigner(cfg, memDb(), OPERATOR_A)).toThrow(ConfigRefusedError);
    expect(() => createLocalSigner({ privateKey: ANVIL_KEY_0, rpcUrl: remote })).toThrow(
      ConfigRefusedError,
    );
  });

  it("positive path: a loopback RPC (anvil) accepts the local operator key", () => {
    const cfg = loadConfig({
      CHAIN_ID: "4663",
      SIGNER_KIND: "local",
      LOCAL_SIGNER_PRIVATE_KEY: ANVIL_KEY_0,
      RH_RPC_URL: "http://127.0.0.1:8546",
    });
    expect(operatorSigner(cfg, memDb(), OPERATOR_A).address).toBe(OPERATOR_A);
  });
});

describe("SAFETY PROOF 19: HL paper never calls the exchange", () => {
  function exchangeSpy() {
    const calls: HlOrderRequest[] = [];
    const client: HlExchangeClient = {
      async placeOrder(order) {
        calls.push(order);
        return {
          cloid: order.cloid,
          status: "open",
          oid: 1,
          filledSz: "0",
          avgPx: null,
          error: null,
        };
      },
      async cancelByCloid() {},
    };
    return { client, calls };
  }

  it("lane B's paper hedge rests on the tape and the exchange client is never touched", async () => {
    const spy = exchangeSpy();
    const h = harness({ lane: "B", hl: { mode: "paper", armed: false, exchange: spy.client } });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("executed");
    const plan = JSON.parse(decisionOf(h)?.finalPlanJson ?? "{}");
    expect(plan.actions[0].kind).toBe("hedge");
    expect(spy.calls).toHaveLength(0);
    const orders = h.db.openHlOrders("paper");
    expect(orders).toHaveLength(1);
    expect(orders[0]?.mode).toBe("paper");
    expect(h.signer.requests).toHaveLength(0); // and no chain transaction either
  });

  it("positive path: the live path (HL_MODE=live, HL_ARM=1, DESK_ARM=1) does reach the exchange", async () => {
    const spy = exchangeSpy();
    const h = harness({ lane: "B", hl: { mode: "live", armed: true, exchange: spy.client } });
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.tif).toBe("Alo");
  });
});

describe("SAFETY PROOF 20: a revoked delegation → no sign", () => {
  const secret = "whsec-test-0123456789abcdef";

  function delegated(clock = fixedClock(T0)) {
    const db = memDb();
    const vault = createVault({ kekB64: Buffer.alloc(32, 7).toString("base64"), kekId: "k1" });
    const sealed = vault.sealRow(
      {
        [VAULT_PURPOSE.keyShare]: Buffer.from(JSON.stringify({ share: "opaque" })),
        [VAULT_PURPOSE.apiKey]: Buffer.from("wallet-api-key"),
      },
      { walletId: "wallet-1", address: OPERATOR_A },
    );
    db.upsertDelegation({
      walletId: "wallet-1",
      userId: "user-1",
      accountAddress: OPERATOR_A,
      chain: "EVM",
      laneAddress: LANE_A,
      status: "active",
      keyShareCt: sealed.ciphertexts[VAULT_PURPOSE.keyShare] ?? null,
      apiKeyCt: sealed.ciphertexts[VAULT_PURPOSE.apiKey] ?? null,
      dekWrapped: sealed.dekWrapped,
      kekId: sealed.kekId,
      createdEventId: "evt-created-1",
      revokedEventId: null,
      createdAtMs: T0,
      updatedAtMs: T0,
      revokedAtMs: null,
    });
    const operatorKey = privateKeyToAccount(ANVIL_KEY_0);
    const mpcCalls: string[] = [];
    const signer = createDelegatedSigner({
      address: OPERATOR_A,
      db,
      vault,
      client: async () => ({ chainName: "EVM" }),
      sign: async (_client, args) => {
        mpcCalls.push(args.walletApiKey);
        return operatorKey.signTransaction(args.transaction);
      },
    });
    const webhook = createDynamicWebhookHandler({
      db,
      secret,
      environmentId: undefined,
      rsaPrivateKeyPem: () => "unused for revocations",
      vault,
      clock,
      logger: silentLogger,
    });
    return { db, signer, webhook, mpcCalls, clock };
  }

  async function revoke(webhook: ReturnType<typeof delegated>["webhook"]) {
    const raw = Buffer.from(
      JSON.stringify({
        eventId: "evt-revoked-1",
        eventName: "wallet.delegation.revoked",
        data: { walletId: "wallet-1" },
      }),
    );
    return webhook.handle(new Uint8Array(raw), {
      "x-dynamic-signature-256": signDynamicPayload(raw, secret),
    });
  }

  it("after Dynamic's revocation webhook the desk is revoked and nothing is signed", async () => {
    const d = delegated();
    const h = harness({ db: d.db, clock: d.clock, signer: d.signer });
    const res = await revoke(d.webhook);
    expect(res.status).toBe(200);
    expect(d.db.getDesk(LANE_A)?.status).toBe("revoked");
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("blocked");
    expect(out.detail).toContain("revoked");
    expect(d.mpcCalls).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
  });

  it("a stale desk row cannot bring it back: the delegated signer is not ready, so no sign", async () => {
    const d = delegated();
    const h = harness({ db: d.db, clock: d.clock, signer: d.signer });
    await revoke(d.webhook);
    d.db.setDeskStatus(LANE_A, "active", "stale row", T0); // as if the revocation were missed
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("blocked");
    expect(out.detail).toContain("signer not ready");
    expect(d.mpcCalls).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
  });

  it("positive path: an active delegation signs through the vault and lands", async () => {
    const d = delegated();
    const h = harness({ db: d.db, clock: d.clock, signer: d.signer });
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(d.mpcCalls).toEqual(["wallet-api-key"]);
    expect(h.chain.sent).toHaveLength(1);
  });
});

function identity(over: Partial<LaneIdentity> = {}): LaneIdentity {
  return {
    owner: OWNER,
    operator: OPERATOR_A,
    guardian: "0x0000000000000000000000000000000000000000",
    laneId: 0,
    pool: NVDA_USDG_POOL.address.toLowerCase() as LaneIdentity["pool"],
    token0: NVDA_USDG_POOL.token0.toLowerCase() as LaneIdentity["token0"],
    token1: NVDA_USDG_POOL.token1.toLowerCase() as LaneIdentity["token1"],
    fence: "0x0000000000000000000000000000000000000001",
    paused: false,
    ...over,
  };
}

const localOperator = () => createLocalSigner({ privateKey: ANVIL_KEY_0, rpcUrl: LOOPBACK });

describe("SAFETY PROOF 21: a config cap above the on-chain cap refuses to start", () => {
  it("preflight refuses DESK_MAX_ACTION_USD=60 against a $50 on-chain maxDeploy", async () => {
    const cfg = makeTestConfig();
    await expect(
      preflightLane({
        cfg,
        views: {
          identity: async () => identity(),
          caps: async () => ({ ...DEFAULT_LANE_CAPS, maxDeployUsd6: 50_000_000n }),
        },
        laneAddress: LANE_A,
        blockNumber: 1n,
        signer: () => localOperator(),
      }),
    ).rejects.toThrow(/maxDeployUsd6/);
  });

  it("a desk registered later that fails preflight is never ticked (and the owner is told)", async () => {
    const db = memDb();
    const notes: DeskNotification[] = [];
    db.insertDesk({
      laneAddress: LANE_A,
      chainId: 4663,
      laneId: 0,
      owner: OWNER,
      operator: OPERATOR_A,
      ownerUserId: "u",
      signerKind: "local",
      mode: "copilot",
      modeNonce: 0,
      status: "active",
      statusDetail: null,
      capsJson: "{}",
      createdAtMs: T0,
      updatedAtMs: T0,
    });
    const registry = createLaneRegistry({
      db,
      build: async () => {
        throw new ConfigRefusedError("config caps exceed the lane's on-chain caps");
      },
      logger: silentLogger,
      notifier: { notify: async (n) => void notes.push(n) },
      clock: fixedClock(T0),
    });
    await registry.refresh();
    expect(registry.lanes()).toHaveLength(0);
    expect(notes[0]?.title).toContain("preflight refused");
  });

  it("positive path: the default M2 caps pass and the lane is admitted", async () => {
    const r = await preflightLane({
      cfg: makeTestConfig(),
      views: { identity: async () => identity(), caps: async () => ({ ...DEFAULT_LANE_CAPS }) },
      laneAddress: LANE_A,
      blockNumber: 1n,
      signer: () => localOperator(),
    });
    expect(r.lane).toBe("A");
    expect(r.signer.address).toBe(OPERATOR_A);
  });
});

describe("SAFETY PROOF 22: the signer is never the owner", () => {
  it("preflight refuses a lane whose owner is the signing key", async () => {
    await expect(
      preflightLane({
        cfg: makeTestConfig(),
        views: {
          identity: async () => identity({ owner: OPERATOR_A }),
          caps: async () => ({ ...DEFAULT_LANE_CAPS }),
        },
        laneAddress: LANE_A,
        blockNumber: 1n,
        signer: () => localOperator(),
      }),
    ).rejects.toThrow(/OWNER/);
  });

  it("the store will not even register such a desk", () => {
    const db = memDb();
    expect(() =>
      db.insertDesk({
        laneAddress: LANE_A,
        chainId: 4663,
        laneId: 0,
        owner: OPERATOR_A,
        operator: OPERATOR_A,
        ownerUserId: null,
        signerKind: "local",
        mode: "copilot",
        modeNonce: 0,
        status: "active",
        statusDetail: null,
        capsJson: "{}",
        createdAtMs: T0,
        updatedAtMs: T0,
      }),
    ).toThrow();
  });

  it("at runtime, a snapshot whose owner is the signer is blocked by signer binding", async () => {
    const h = harness({ noDesk: true, world: { owner: OPERATOR_A } });
    const out = await h.tickUntilDecision();
    expect(out.status).toBe("blocked");
    expect(decisionOf(h)?.guardViolationsJson).toContain("signer is the lane OWNER");
    expect(h.signer.requests).toHaveLength(0);
  });

  it("positive path: an operator distinct from the owner signs", async () => {
    const h = harness();
    expect((await h.tickUntilDecision()).status).toBe("executed");
    expect(decodeSigned(h.chain.sent[0] as Hex).to).toBe(LANE_A);
  });
});
