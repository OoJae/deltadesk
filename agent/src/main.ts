/**
 * desk-agent entry point (`pnpm dev`; the `desk-agent` Docker service).
 *
 * Boot order. Every step fails closed: a refusal exits non-zero before anything can sign.
 *   1 config (loadConfig refuses unsafe combinations) and the logger
 *   2 the SQLite store (WAL, migrations) and the single-instance daemon lock
 *   3 the RPC's chain id, then startup reconciliation: unsigned executions fail, signed bytes are
 *     rebroadcast (never re-signed; a risk-adding one only while its desk is still active),
 *     decisions stranded in `executing` are resolved, approvals left pending are closed
 *   4 sensors (HL websocket, Robinhood, engine) and the lanes: each configured lane is preflighted
 *     (identity, pool, signer = operator ≠ owner, config caps within the on-chain caps) and
 *     registered as a desk; desks registered later through the web API are preflighted on the
 *     reconcile timer before they are ever ticked
 *   5 the daemon (tick loop)
 *   6 the HTTP server (/health, the Dynamic webhook, the web API)
 *   7 the reconcile timer (LaneAction reconciliation, lane registry refresh, stranded decisions)
 *
 * Signer fallback: without Dynamic credentials the operator is WATCH-ONLY (it refuses to sign),
 * which config only allows while DRY_RUN holds; a raw local key is never downgraded that way.
 */

import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { NVDA_USDG_POOL } from "./addresses.js";
import { createBankrLlm, createCreditsBreaker } from "./agents/llm.js";
import { createOverlayCritic } from "./agents/overlay-critic.js";
import { createOverlayPlanner } from "./agents/overlay-planner.js";
import { createApprovalGate } from "./approval/gate.js";
import { canonicalJson } from "./canonical.js";
import {
  type AppConfig,
  assertConfigWithinOnchainCaps,
  assertRpcChainId,
  assertSignerBinding,
  describeConfig,
  getConfig,
  scrubRpcUrl,
} from "./config.js";
import {
  createDaemon,
  createReconcileLoop,
  type LaneRuntime,
  type ReconcileTask,
} from "./daemon.js";
import { createBroadcaster } from "./executor/broadcaster.js";
import { createCalldataBuilder } from "./executor/calldata.js";
import {
  createChainClient,
  createLaneViews,
  type LaneIdentity,
  type LaneViews,
} from "./executor/chain.js";
import { createHlExecutor, createPaperFillEngine } from "./executor/hl-executor.js";
import { rhExecutorFromConfig } from "./executor/wire.js";
import { createHedgeEngine } from "./hedge/engine.js";
import { createHlExchangeClient, httpTransport } from "./hl/client.js";
import { createJwtVerifier } from "./http/auth.js";
import {
  createDynamicWebhookHandler,
  factoryLaneOwnerProbe,
  rsaKeyLoader,
} from "./http/dynamic-webhook.js";
import { createHttpApp, healthView, startHttpServer } from "./http/server.js";
import { createLogger } from "./log.js";
import {
  createTelegramApi,
  createTelegramListener,
  createTelegramNotifier,
} from "./notify/telegram.js";
import { createLaneActionReconciler } from "./reconcile/lane-actions.js";
import {
  closeOrphanedApprovals,
  createAttemptResolver,
  createStartupReconciler,
} from "./reconcile/startup.js";
import { createChainReader } from "./sense/chain.js";
import { createEngineSource, type EngineSourceHandle } from "./sense/engine.js";
import { createHlFeed } from "./sense/hyperliquid.js";
import { createSensor } from "./sense/index.js";
import {
  createMockSensor,
  MOCK_LANE,
  MOCK_OPERATOR,
  MOCK_OWNER,
  mockChainRead,
} from "./sense/mock.js";
import { createRhFeed } from "./sense/robinhood.js";
import { signerFromConfig, vaultFromConfig } from "./signer/factory.js";
import { lockOwner, openDb } from "./state/db.js";
import {
  type Address,
  type Clock,
  ConfigRefusedError,
  type DeskDb,
  type DeskLogger,
  type DeskRow,
  type DeskSnapshot,
  ExecError,
  type Executor,
  LANE_BY_ID,
  type Lane,
  type LaneCaps,
  type Notifier,
  type PreparedStep,
  type Sensor,
  type SignerKind,
  type StepRequest,
  type TxSigner,
} from "./types.js";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const lower = (a: string): Address => a.toLowerCase() as Address;

/** A delegation no desk registration has bound after this long is purged (the wizard takes minutes). */
const UNBOUND_DELEGATION_TTL_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------------------------
// Signers

/**
 * The operator's address without the power to sign: DRY_RUN runs without Dynamic credentials.
 * Every signTransaction refuses (the guard's dry-run rule means it is never reached anyway).
 */
export function watchOnlySigner(address: Address, kind: SignerKind): TxSigner {
  const reason = "watch-only operator (DRY_RUN without signer credentials)";
  return {
    kind,
    address: lower(address),
    async signTransaction() {
      throw new ExecError("SIGNER_UNAVAILABLE", reason);
    },
    async ready() {
      return { ready: false, reason };
    },
  };
}

/** The lane operator's signer; watch-only when DRY_RUN holds and Dynamic is not configured. */
export function operatorSigner(
  cfg: AppConfig,
  db: Pick<DeskDb, "getActiveDelegationByAddress" | "getServerWallet">,
  operator: Address,
  logger?: Pick<DeskLogger, "warn">,
): TxSigner {
  try {
    return signerFromConfig(cfg, db, operator);
  } catch (err) {
    // A raw key is never quietly downgraded: local-signer refusals always stop the boot.
    if (err instanceof ConfigRefusedError && cfg.safety.dryRun && cfg.signer.kind !== "local") {
      logger?.warn(
        { operator, reason: err.message },
        "signer not configured: watch-only operator (DRY_RUN)",
      );
      return watchOnlySigner(operator, cfg.signer.kind);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Lane preflight

export interface PreflightResult {
  identity: LaneIdentity;
  caps: LaneCaps;
  lane: Lane;
}

/**
 * The startup refusals for one lane: it must trade the allowed pool, the signer must be its
 * operator and never its owner, and the agent's own caps must sit inside the lane's on-chain caps.
 */
export async function preflightLane(p: {
  cfg: AppConfig;
  views: Pick<LaneViews, "identity" | "caps">;
  laneAddress: Address;
  blockNumber: bigint;
  signer: (identity: LaneIdentity) => TxSigner;
  allowedPools?: readonly Address[];
}): Promise<PreflightResult & { signer: TxSigner }> {
  const identity = await p.views.identity(p.laneAddress, p.blockNumber);
  const caps = await p.views.caps(p.laneAddress, p.blockNumber);
  const pools = (p.allowedPools ?? [NVDA_USDG_POOL.address]).map(lower);
  if (!pools.includes(lower(identity.pool))) {
    throw new ConfigRefusedError(
      `lane ${p.laneAddress} trades pool ${identity.pool}, which is not allowed`,
    );
  }
  const lane = LANE_BY_ID[identity.laneId];
  if (lane === undefined)
    throw new ConfigRefusedError(`lane ${p.laneAddress} has unknown laneId ${identity.laneId}`);
  const signer = p.signer(identity);
  assertSignerBinding(signer.address, identity);
  assertConfigWithinOnchainCaps(p.cfg, caps);
  return { identity, caps, lane, signer };
}

/** Insert a configured lane's desk row on first boot (the web API registers the others). */
function ensureDesk(
  db: DeskDb,
  cfg: AppConfig,
  laneAddress: Address,
  pre: PreflightResult,
  signerKind: SignerKind,
  nowMs: number,
): DeskRow {
  const existing = db.getDesk(laneAddress);
  if (existing !== null) return existing;
  const row: DeskRow = {
    laneAddress: lower(laneAddress),
    chainId: cfg.chainId,
    laneId: pre.identity.laneId,
    owner: pre.identity.owner,
    operator: pre.identity.operator,
    ownerUserId: null,
    signerKind,
    mode: cfg.safety.defaultMode,
    modeNonce: 0,
    status: "active",
    statusDetail: null,
    capsJson: canonicalJson(pre.caps),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  db.insertDesk(row);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Lane registry: the daemon's lanes() (sync) over runtimes built asynchronously

export interface LaneRegistry {
  lanes(): LaneRuntime[];
  /** Build runtimes for desks not seen yet; a failing desk is retried later, never ticked. */
  refresh(): Promise<void>;
  addresses(): Address[];
}

export function createLaneRegistry(p: {
  db: DeskDb;
  build: (laneAddress: Address) => Promise<LaneRuntime>;
  logger: DeskLogger;
  notifier: Notifier;
  clock: Clock;
  retryMs?: number;
}): LaneRegistry & { add(rt: LaneRuntime): void } {
  const runtimes = new Map<string, LaneRuntime>();
  const failures = new Map<string, number>();
  const retryMs = p.retryMs ?? 5 * 60_000;
  return {
    lanes: () => [...runtimes.values()],
    addresses: () => [...runtimes.keys()] as Address[],
    add(rt) {
      runtimes.set(lower(rt.laneAddress), rt);
    },
    async refresh() {
      for (const desk of p.db.listDesks()) {
        const key = lower(desk.laneAddress);
        if (runtimes.has(key) || desk.status === "disabled") continue;
        const failedAt = failures.get(key);
        if (failedAt !== undefined && p.clock.now() - failedAt < retryMs) continue;
        try {
          runtimes.set(key, await p.build(key));
          failures.delete(key);
          p.logger.info({ lane: key }, "desk lane added to the loop");
        } catch (err) {
          failures.set(key, p.clock.now());
          p.logger.error({ lane: key, error: errText(err) }, "desk lane failed preflight");
          await p.notifier.notify({
            kind: "alert",
            severity: "warn",
            lane: null,
            laneAddress: key,
            title: "Registered desk not started (preflight refused)",
            lines: [errText(err)],
          });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// DESK_SENSE_MOCK=1: a synthetic lane that can plan but never execute (config pins DRY_RUN)

function mockExecutor(laneAddress: Address, signer: Address): Executor {
  const calldata = createCalldataBuilder(laneAddress);
  const balances = mockChainRead().lane.balances;
  return {
    venue: "rh",
    async prepare(req: StepRequest): Promise<PreparedStep> {
      if (req.action.kind === "hedge") throw new Error("mock executor: no HL steps");
      const call = calldata.encode(req.action, req.meta);
      let rerange = null;
      if (req.action.kind === "rerange" && req.action.ranges.length > 0) {
        let s0 = 0n;
        let s1 = 0n;
        for (const r of req.action.ranges) {
          s0 += BigInt(r.share0Bps);
          s1 += BigInt(r.share1Bps);
        }
        rerange = {
          tokenIds: req.action.ranges.map((_, i) => BigInt(i + 1)),
          liquidities: req.action.ranges.map(() => 1n),
          amount0Used: (balances.token0 * s0) / 10_000n,
          amount1Used: (balances.token1 * s1) / 10_000n,
        };
      }
      return {
        ...req,
        venue: "rh",
        call,
        hlOrder: null,
        simulation: {
          ok: true,
          blockNumber: 1_000_000n,
          latestBlockNumber: 1_000_000n,
          from: signer,
          returnData: "0x",
          rerange,
          error: null,
          gasEstimate: 900_000n,
        },
      };
    },
    async execute() {
      throw new ExecError("SIM_POLICY", "the mock executor never executes (DESK_SENSE_MOCK=1)");
    },
  };
}

// ---------------------------------------------------------------------------------------------
// main

const systemClock: Clock = { now: () => Date.now() };

export async function main(): Promise<void> {
  const cfg = await getConfig();
  const logger = createLogger({
    level: cfg.logLevel,
    service: "desk-agent",
    pretty: process.stdout.isTTY === true,
  });
  logger.info({}, `desk-agent starting: ${describeConfig(cfg).join(" · ")}`);
  const clock = systemClock;

  // 2. Store and lock.
  const db = openDb(cfg.paths.dbPath);
  const owner = lockOwner();
  const lock = db.acquireDaemonLock(owner, clock.now(), cfg.timing.lockStaleMs);
  if (!lock.acquired) {
    db.close();
    throw new ConfigRefusedError(
      `another desk-agent (${lock.holderOwner ?? "?"}) holds the daemon lock (heartbeat ${Math.round((lock.heartbeatAgeMs ?? 0) / 1000)} s ago). Two daemons on one DB could act twice.`,
    );
  }
  if (lock.tookOverStaleOwner !== undefined)
    logger.warn({ previous: lock.tookOverStaleOwner }, "took over a stale daemon lock");
  if (cfg.timing.cancelWindowMs <= 0) {
    for (const d of db.listDesks().filter((k) => k.mode === "autopilot")) {
      logger.warn(
        { lane: d.laneAddress },
        "desk mode autopilot without DESK_CANCEL_WINDOW_SEC: it runs as copilot (explicit approve)",
      );
    }
  }

  const cleanups: Array<() => Promise<void> | void> = [];
  const shutdownAll = async () => {
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch (err) {
        logger.warn({ error: errText(err) }, "shutdown step failed");
      }
    }
    db.releaseDaemonLock(owner.ownerId);
    db.close();
  };

  try {
    const notifier = createTelegramNotifier(
      {
        botToken: cfg.telegram.botToken,
        chatId: cfg.telegram.chatId,
        explorerUrl: cfg.explorerUrl,
      },
      logger,
    );
    const chain = createChainClient({
      rpcUrl: cfg.rpcUrl,
      fallbackUrl: cfg.rpcFallbackUrl,
      chainId: cfg.chainId,
    });
    const views = createLaneViews(chain);
    let lastEthUsd: number | null = null;
    const ethUsd = () => lastEthUsd;
    const track = (sensor: Sensor): Sensor => ({
      async read(lane, laneAddress) {
        const snap: DeskSnapshot = await sensor.read(lane, laneAddress);
        if (snap.ethUsd !== null) lastEthUsd = snap.ethUsd;
        return snap;
      },
    });
    const broadcaster = createBroadcaster({ chain, clock });
    const resolverDeps = { db, chain, broadcaster, clock, logger, notifier, ethUsd };

    // 3. Chain identity and startup reconciliation, before anything can act.
    const live = !cfg.safety.senseMock;
    if (live) {
      assertRpcChainId(cfg, await chain.chainId());
      await createStartupReconciler(resolverDeps).run(clock.now());
    } else {
      // No chain to reconcile, but a pending approval's waiter still died with the last process.
      closeOrphanedApprovals({ db, logger }, clock.now());
    }

    // 4. Sensors and lanes.
    const hlFeed = live
      ? createHlFeed({ wsUrl: cfg.hl.wsUrl, infoUrl: cfg.hl.infoUrl, clock, logger })
      : null;
    hlFeed?.start();
    if (hlFeed !== null) cleanups.push(() => hlFeed.stop());
    const rhFeed = createRhFeed({ apiUrl: cfg.rh.apiUrl, clock });
    const chainReader = createChainReader({ client: chain });
    const engines = new Map<string, EngineSourceHandle>();
    const engineFor = (laneAddress: Address): EngineSourceHandle => {
      let e = engines.get(lower(laneAddress));
      if (e === undefined) {
        e = createEngineSource({
          apiUrl: cfg.engine.apiUrl,
          apiKey: cfg.engine.apiKey,
          pool: "NVDA",
          laneAddress,
          db,
          clock,
          ttlMs: cfg.engine.basisTtlMs,
        });
        engines.set(lower(laneAddress), e);
      }
      return e;
    };
    const localOperator =
      cfg.signer.localPrivateKey === undefined
        ? null
        : lower(privateKeyToAccount(cfg.signer.localPrivateKey).address);

    async function buildLive(laneAddress: Address): Promise<LaneRuntime> {
      const block = await chain.blockNumber();
      const pre = await preflightLane({
        cfg,
        views,
        laneAddress,
        blockNumber: block,
        signer: (id) => operatorSigner(cfg, db, id.operator, logger),
      });
      ensureDesk(db, cfg, laneAddress, pre, pre.signer.kind, clock.now());
      if (hlFeed === null) throw new Error("live lanes need the HL feed");
      const sensor = createSensor({
        chain: chainReader,
        hl: hlFeed,
        rh: rhFeed,
        engine: engineFor(laneAddress),
        clock,
        chainId: cfg.chainId,
        signerAddress: pre.signer.address,
        logger,
      });
      return {
        lane: pre.lane,
        laneAddress: lower(laneAddress),
        sensor: track(sensor),
        signer: pre.signer,
        executor: rhExecutorFromConfig({
          cfg,
          laneAddress: lower(laneAddress),
          db,
          chain,
          signer: pre.signer,
          clock,
          logger,
          notifier,
          ethUsd,
        }),
      };
    }

    async function buildMock(laneAddress: Address): Promise<LaneRuntime> {
      const desk = db.getDesk(laneAddress);
      const lane = LANE_BY_ID[desk?.laneId ?? 0] ?? "A";
      if (desk === null) {
        db.insertDesk({
          laneAddress: lower(laneAddress),
          chainId: cfg.chainId,
          laneId: 0,
          owner: MOCK_OWNER,
          operator: MOCK_OPERATOR,
          ownerUserId: null,
          signerKind: cfg.signer.kind,
          mode: cfg.safety.defaultMode,
          modeNonce: 0,
          status: "active",
          statusDetail: null,
          capsJson: "{}",
          createdAtMs: clock.now(),
          updatedAtMs: clock.now(),
        });
      }
      return {
        lane,
        laneAddress: lower(laneAddress),
        sensor: track(createMockSensor(clock, { signerAddress: MOCK_OPERATOR })),
        signer: watchOnlySigner(MOCK_OPERATOR, cfg.signer.kind),
        executor: mockExecutor(lower(laneAddress), MOCK_OPERATOR),
      };
    }

    const build = live ? buildLive : buildMock;
    const registry = createLaneRegistry({ db, build, logger, notifier, clock });
    const configured = [cfg.lanes.A, cfg.lanes.B].filter((a): a is Address => a !== undefined);
    if (!live && configured.length === 0) configured.push(MOCK_LANE);
    for (const laneAddress of configured) {
      // A configured lane that fails preflight refuses the boot (it is the operator's intent).
      registry.add(await build(lower(laneAddress)));
    }
    await registry.refresh();
    if (registry.lanes().length === 0)
      logger.warn({}, "no lanes yet: waiting for a desk registration (POST /desks)");

    // Lane B's paper hedge.
    const hlExecutor = createHlExecutor({
      db,
      mode: cfg.hl.mode,
      armed: cfg.hl.armed,
      exchange:
        cfg.hl.mode === "live" && cfg.hl.armed
          ? createHlExchangeClient({
              mode: cfg.hl.mode,
              armed: cfg.hl.armed,
              agentPrivateKey: cfg.hl.agentPrivateKey,
              transport: httpTransport(cfg.hl.infoUrl),
            })
          : null,
      quote: () => hlFeed?.latest() ?? null,
      clock,
      logger,
    });
    if (hlFeed !== null && cfg.hl.mode === "paper") {
      const paper = createPaperFillEngine({ db, clock, logger });
      const detach = paper.attach(hlFeed);
      const expiry = setInterval(() => paper.expire(clock.now()), 1_000);
      expiry.unref();
      cleanups.push(() => {
        detach();
        clearInterval(expiry);
      });
    }

    // The human: web and Telegram answers land in the approvals table; the file gate is local.
    const approvalGate = createApprovalGate({
      db,
      dir: cfg.paths.approvalDir,
      clock,
      onPrompt: (req, files) =>
        logger.warn(
          { decisionId: req.decisionId, approveFile: files?.approve ?? null },
          `AWAITING APPROVAL: ${req.summary}`,
        ),
    });
    if (cfg.telegram.botToken !== undefined && cfg.telegram.chatId !== undefined) {
      const listener = createTelegramListener({
        api: createTelegramApi(cfg.telegram.botToken, cfg.telegram.chatId, logger),
        chatId: cfg.telegram.chatId,
        respond: (decisionId, approve, channel, by) =>
          db.respondApproval(decisionId, approve, channel, by, clock.now()),
        logger,
      });
      listener.start();
      cleanups.push(() => listener.stop());
    }

    // The LLM overlay (off in M2 unless DESK_OVERLAY=1 and a Bankr key).
    let overlay:
      | {
          planner: ReturnType<typeof createOverlayPlanner>;
          critic: ReturnType<typeof createOverlayCritic>;
        }
      | undefined;
    if (cfg.capabilities.llm && cfg.llm.apiKey !== undefined) {
      const llm = createCreditsBreaker(
        createBankrLlm({ apiKey: cfg.llm.apiKey, baseURL: cfg.llm.baseURL, model: cfg.llm.model }),
        { clock },
      );
      overlay = { planner: createOverlayPlanner(llm), critic: createOverlayCritic(llm) };
    }

    // 5. The daemon, 7. the reconcile loop (created first: the tick runs it when due).
    const tasks: ReconcileTask[] = [{ name: "lane-registry", run: () => registry.refresh() }];
    if (live) {
      const reconciler = createLaneActionReconciler({
        db,
        chain,
        lanes: () => registry.addresses(),
        clock,
        logger,
        notifier,
        confirmations: cfg.timing.reconcileConfirmations,
      });
      tasks.unshift({ name: "lane-actions", run: (now) => reconciler.run(now) });
    }
    tasks.push({
      name: "stranded-decisions",
      run: async (now) => db.reconcileOrphanedDecisions(now),
    });
    tasks.push({
      name: "unbound-delegations",
      run: async (now) => {
        // Credentials for a wallet no desk ever registered (a delegated Vault whose lane was never
        // registered, an abandoned wizard) are not kept.
        for (const d of db.purgeUnboundDelegations(now - UNBOUND_DELEGATION_TTL_MS, now)) {
          logger.warn({ wallet: d.accountAddress }, "expired an unbound delegation");
          await notifier.notify({
            kind: "alert",
            severity: "warn",
            lane: null,
            laneAddress: null,
            title: "Unregistered delegation expired: credentials deleted",
            lines: [
              `wallet ${d.accountAddress} was never bound to a registered desk`,
              "If it is a Vault (lane owner), revoke its delegation in Dynamic.",
            ],
          });
        }
      },
    });
    const reconcile = createReconcileLoop({
      tasks,
      intervalMs: cfg.timing.reconcileMs,
      clock,
      logger,
    });
    const shared = engineFor(configured[0] ?? MOCK_LANE);
    let exiting = false;
    const daemon = createDaemon({
      config: cfg,
      db,
      lanes: () => registry.lanes(),
      decisionUsedAt: async (lane, id) => views.decisionUsedAt(lane, id, await chain.blockNumber()),
      notifier,
      logger,
      clock,
      ...(overlay === undefined ? {} : { overlay }),
      approvalGate,
      hourRecord: live ? (how) => shared.hourRecord(how) : async () => null,
      hedge: createHedgeEngine(),
      hlExecutor,
      resolver: live ? createAttemptResolver(resolverDeps) : null,
      reconcile,
      lock: {
        ownerId: owner.ownerId,
        onLost: () => {
          if (!exiting) {
            exiting = true;
            void shutdownAll().finally(() => process.exit(1));
          }
        },
      },
    });
    cleanups.push(() => daemon.stop());
    daemon.start();

    // 6. HTTP.
    const vault = vaultFromConfig(cfg);
    const webhook =
      cfg.capabilities.webhook && cfg.dynamic.webhookSecret !== undefined && vault !== null
        ? createDynamicWebhookHandler({
            db,
            secret: cfg.dynamic.webhookSecret,
            environmentId: cfg.dynamic.environmentId,
            rsaPrivateKeyPem: rsaKeyLoader(cfg.dynamic),
            vault,
            isLaneOwner:
              cfg.factoryAddress === undefined || !live
                ? undefined
                : factoryLaneOwnerProbe(chain, cfg.factoryAddress),
            clock,
            logger,
            notifier,
          })
        : null;
    if (webhook !== null && cfg.factoryAddress === undefined)
      logger.warn(
        {},
        "DESK_FACTORY_ADDRESS is unset: the webhook can only refuse OWNER wallets of registered desks",
      );
    if (cfg.http.agentApiKey === undefined)
      logger.warn(
        {},
        "DESK_AGENT_API_KEY is unset: the web API accepts calls without the shared key",
      );
    const jwt =
      cfg.dynamic.environmentId !== undefined && cfg.dynamic.jwksUrl !== undefined
        ? createJwtVerifier({
            environmentId: cfg.dynamic.environmentId,
            jwksUrl: cfg.dynamic.jwksUrl,
          })
        : null;
    const app = createHttpApp({
      health: () =>
        healthView({
          db,
          clock,
          extraLanes: configured,
          staleTickMs: Math.max(3 * cfg.timing.tickMs, 60_000),
          lockStaleMs: cfg.timing.lockStaleMs,
        }),
      webhook,
      desks: {
        db,
        chain,
        jwt,
        agentApiKey: cfg.http.agentApiKey,
        chainId: cfg.chainId,
        factoryAddress: cfg.factoryAddress,
        allowedPools: [NVDA_USDG_POOL.address],
        signerKind: cfg.signer.kind,
        ownOperators: [localOperator, cfg.signer.serverWalletAddress]
          .filter((a): a is Address => a !== null && a !== undefined)
          .map(lower),
        serverWalletAddress: cfg.signer.serverWalletAddress,
        defaultMode: cfg.safety.defaultMode,
        cancelWindowMs: cfg.timing.cancelWindowMs,
        readLane: live
          ? (laneAddress, operator) =>
              chainReader.read(laneAddress, operator).then(
                (r) => r.lane,
                () => null,
              )
          : undefined,
        clock,
        logger,
        notifier,
      },
      watchdog: { db, key: cfg.http.watchdogKey, logger },
      logger,
    });
    if (cfg.http.watchdogKey === undefined)
      logger.warn(
        {},
        "WATCHDOG_AGENT_KEY is unset: the watchdog cannot cross-check operator LaneActions (it alerts on each)",
      );
    const server = await startHttpServer(app, { port: cfg.http.port, host: cfg.http.host });
    cleanups.push(() => server.close());
    logger.info({ port: server.port }, "http server listening");

    // 7. The reconcile timer.
    reconcile.start();
    cleanups.push(() => reconcile.stop());

    let signals = 0;
    const shutdown = (sig: string) => {
      signals += 1;
      if (signals > 1) process.exit(1);
      logger.info({}, `${sig}: finishing the in-flight tick, then exiting`);
      exiting = true;
      void shutdownAll().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    await shutdownAll();
    throw err;
  }
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(async (err: unknown) => {
    // RPC URLs carry the provider key in their path: scrub before printing.
    const cfg = await getConfig().catch(() => null);
    const text = errText(err);
    console.error(cfg === null ? text : scrubRpcUrl(text, cfg.rpcUrl));
    process.exit(1);
  });
}
