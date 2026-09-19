/**
 * The desk web API (called only through the web's server-side route handlers, app/api/desk/*).
 *
 *   POST /desks                  {lane, chainId}  register a lane that exists on-chain (a DeskLane of
 *                                the configured factory, on an allowed pool), owned by the signed-in
 *                                Vault, whose operator is a wallet the SAME user delegated (or the
 *                                agent's own Plan B / fork operator). 201, or 409 if registered.
 *   GET  /desks/:lane/status     the desk view (owner only). 404 when not registered.
 *   POST /desks/:lane/mode       {mode, signature, nonce}: EIP-191 by the OWNER over
 *                                `DeltaDesk mode <checksummed lane> <mode> <nonce>`; nonce strictly
 *                                increasing. A signed mode change also clears safe mode.
 *   POST /desks/:lane/approve    {decisionId, approve}: copilot answer from the web (bytes32 or ULID).
 *   GET  /desks/:lane/signals/:decisionId  a gate signal and the canonical preimage of its
 *                                reasonHash (bytes32 or ULID), with `verified`: keccak256 of the
 *                                stored preimage equals the hash (owner only). 404 when unknown.
 *   GET  /delegations/:operator  has the delegation webhook for this Operator wallet landed yet?
 *                                {operator (checksummed), status: active | revoked | unknown,
 *                                walletId, updatedAtMs}. Works BEFORE POST /desks: the wizard polls
 *                                it between "delegate the Operator" and registering the lane.
 *   GET  /operator-address       the Plan B server-wallet operator, if configured.
 *
 * Every route needs the shared agent key (when configured); all but /operator-address also need a
 * Dynamic JWT whose verified wallets include the lane's owner (/delegations: the operator itself).
 */

import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAddress, isAddress, isHex, recoverMessageAddress } from "viem";
import { z } from "zod";
import { canonicalJson } from "../canonical.js";
import { deskLaneFactoryAbi } from "../executor/abi/DeskLaneFactory.js";
import { createLaneViews, readContract } from "../executor/chain.js";
import { encodeDecisionId, isUlid, tryDecodeDecisionId } from "../executor/decision-id.js";
import { classifyError } from "../executor/errors.js";
import { gatesOfMask, hashOfPreimage } from "../regime/signal.js";
import type {
  Address,
  ChainClient,
  Clock,
  DelegationRow,
  DeskDb,
  DeskLogger,
  DeskMode,
  DeskRow,
  DeskStatusView,
  GateName,
  GateSignalView,
  JwtVerifier,
  LaneOnchainState,
  Notifier,
  SignerKind,
  VerifiedUser,
} from "../types.js";
import {
  AGENT_KEY_HEADER,
  AuthError,
  bearerToken,
  checkAgentKey,
  requireOwner,
  requireWallet,
} from "./auth.js";

export type { DeskMode, DeskRow, DeskStatusView } from "../types.js";

export interface DeskApiDeps {
  db: DeskDb;
  chain: Pick<ChainClient, "call" | "blockNumber">;
  jwt: JwtVerifier | null;
  agentApiKey: string | undefined;
  chainId: number;
  factoryAddress: Address | undefined;
  /** Pools a lane may use (M2: NVDA/USDG). */
  allowedPools: readonly Address[];
  signerKind: SignerKind;
  /** Operators the agent holds itself (Plan B server wallet, fork key): no delegation needed. */
  ownOperators: readonly Address[];
  serverWalletAddress: Address | undefined;
  defaultMode: DeskMode;
  cancelWindowMs: number;
  /** Live lane state for the status view (the sensor's chain read); null on failure. */
  readLane?:
    | ((laneAddress: Address, operator: Address) => Promise<LaneOnchainState | null>)
    | undefined;
  clock: Clock;
  logger: DeskLogger;
  /** Alerts (a purged Vault delegation must also be revoked in Dynamic by the user). */
  notifier?: Notifier | undefined;
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

const lower = (a: string): Address => a.toLowerCase() as Address;

/** An RPC outage is 503 (retry later); anything else reading a lane means it is not one (400). */
function chainReadFailed(what: string) {
  return (err: unknown): never => {
    if (classifyError(err).code === "RPC_UNAVAILABLE")
      throw new HttpError(503, `could not reach the chain to read ${what}; retry`);
    throw new HttpError(400, `could not read ${what} on-chain (not a DeskLane?)`);
  };
}

export function modeMessage(lane: Address, mode: DeskMode, nonce: string): string {
  return `DeltaDesk mode ${getAddress(lane)} ${mode} ${nonce}`;
}

export function deskJson(d: DeskRow): Record<string, unknown> {
  return {
    lane: d.laneAddress,
    chainId: d.chainId,
    laneId: d.laneId,
    owner: d.owner,
    operator: d.operator,
    signerKind: d.signerKind,
    mode: d.mode,
    status: d.status,
    statusDetail: d.statusDetail,
    caps: JSON.parse(d.capsJson) as unknown,
    createdAtMs: d.createdAtMs,
  };
}

export type DelegationState = "active" | "revoked" | "unknown";

/** GET /delegations/:operator. Whitelisted fields only: never key material or ciphertexts. */
export interface DelegationStatusView {
  operator: string;
  status: DelegationState;
  walletId: string | null;
  updatedAtMs: number | null;
}

/**
 * The delegation state of an Operator wallet. "unknown": no row yet (the webhook has not landed,
 * or it was refused, e.g. for a lane owner). "revoked": a Dynamic revoke (recorded sticky per
 * event, so an older created event can never re-activate the row) or a local purge.
 */
export function delegationView(operator: Address, row: DelegationRow | null): DelegationStatusView {
  return {
    operator: getAddress(operator),
    status: row === null ? "unknown" : row.status,
    walletId: row?.walletId ?? null,
    updatedAtMs: row?.updatedAtMs ?? null,
  };
}

const RegisterSchema = z.object({ lane: z.string(), chainId: z.number().int() });
const ModeSchema = z.object({
  mode: z.enum(["advisory", "copilot", "autopilot"]),
  signature: z.string().refine((s) => isHex(s) && s.length <= 1000, "signature must be hex"),
  nonce: z.string().regex(/^\d{1,20}$/),
});
const ApproveSchema = z.object({ decisionId: z.string().max(80), approve: z.boolean() });

/** GET /desks/:lane/signals/:decisionId: a gate signal with its reasonHash preimage. */
export function signalJson(g: GateSignalView): Record<string, unknown> {
  return {
    decisionId: g.onchainId,
    decisionUlid: g.decisionId,
    lane: g.laneAddress,
    status: g.status,
    decisionStatus: g.decisionStatus,
    initial: g.initial,
    regime: g.toRegime,
    regimeCode: g.regimeCode,
    gates: gatesOfMask(g.gatesMask),
    gatesMask: g.gatesMask,
    atMs: g.atMs,
    reasonHash: g.reasonHash,
    preimage: JSON.parse(g.preimageJson) as unknown,
    /** The exact bytes that were hashed (UTF-8): recompute keccak256 over this string. */
    preimageJson: g.preimageJson,
    verified: hashOfPreimage(g.preimageJson).toLowerCase() === g.reasonHash.toLowerCase(),
    txHash: g.txHash,
    createdAtMs: g.createdAtMs,
  };
}

export function buildStatusView(
  d: DeskRow,
  db: DeskDb,
  nowMs: number,
  onchain: LaneOnchainState | null,
): DeskStatusView {
  const active = db.getActiveDelegationByAddress(d.operator);
  const tick = db.lastTick(d.laneAddress);
  const decision = db.recentDecisions(1, d.laneAddress)[0];
  const lastSignal = db.recentGateSignals(d.laneAddress, 1)[0];
  return {
    lane: d.laneAddress,
    owner: d.owner,
    operator: d.operator,
    laneId: d.laneId,
    mode: d.mode,
    status: d.status,
    delegation: {
      status: active !== null ? "active" : d.status === "revoked" ? "revoked" : "none",
    },
    caps: JSON.parse(d.capsJson) as Record<string, string | number>,
    budgets:
      onchain === null
        ? null
        : {
            turnoverAvailableUsd6: onchain.budgets.turnoverAvailableUsd6.toString(),
            reranges1hLeft: onchain.budgets.reranges1hLeft.toString(),
            reranges24hLeft: onchain.budgets.reranges24hLeft.toString(),
            nextRerangeAt: onchain.budgets.nextRerangeAt.toString(),
          },
    positions:
      onchain === null
        ? []
        : onchain.positionDetails.flatMap((p, slot) =>
            p === null
              ? []
              : [
                  {
                    slot,
                    tokenId: p.tokenId.toString(),
                    tickLower: p.tickLower,
                    tickUpper: p.tickUpper,
                    liquidity: p.liquidity.toString(),
                  },
                ],
          ),
    balances:
      onchain === null
        ? null
        : {
            token0: onchain.balances.token0.toString(),
            token1: onchain.balances.token1.toString(),
          },
    lastTick:
      tick === null
        ? null
        : {
            atMs: tick.atMs,
            regime: tick.regime,
            reopenKind: tick.reopenKind,
            gates: JSON.parse(tick.activeGatesJson) as GateName[],
            F: tick.fairValue,
            poolMid: tick.poolMid,
            gapBps: tick.gapBps,
            refTick: tick.refTick,
            band: tick.bandTicks,
          },
    lastDecision:
      decision === undefined
        ? null
        : {
            decisionId: decision.decisionId,
            status: decision.status,
            createdAtMs: decision.createdAtMs,
            summary: decision.statusDetail,
          },
    // bytes32 ids (step 0): the web's approve route validates a bytes32 decisionId.
    pendingApprovals: db.pendingApprovals(d.laneAddress, nowMs).map((a) => ({
      decisionId: encodeDecisionId(a.decisionId, 0),
      summary: a.summary,
      expiresAtMs: a.expiresAtMs,
    })),
    lastSignal:
      lastSignal === undefined
        ? null
        : {
            decisionId: lastSignal.onchainId,
            status: lastSignal.status,
            regime: lastSignal.toRegime,
            gates: gatesOfMask(lastSignal.gatesMask),
            gatesMask: lastSignal.gatesMask,
            reasonHash: lastSignal.reasonHash,
            txHash: lastSignal.txHash,
            createdAtMs: lastSignal.createdAtMs,
          },
  };
}

export function createDeskRoutes(deps: DeskApiDeps): Hono {
  const { db, logger } = deps;
  const app = new Hono();
  const views = createLaneViews(deps.chain);

  // Scoped to this API's paths: mounted at "/", a "*" middleware would also cover /health and
  // the webhook.
  for (const path of ["/desks", "/desks/*", "/delegations/*", "/operator-address"]) {
    app.use(
      path,
      bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "body too large" }, 413) }),
    );
    app.use(path, async (c, next) => {
      checkAgentKey(deps.agentApiKey, c.req.header(AGENT_KEY_HEADER));
      await next();
    });
  }

  async function user(c: Context): Promise<VerifiedUser> {
    if (deps.jwt === null)
      throw new HttpError(503, "web auth is not configured (DYNAMIC_ENVIRONMENT_ID)");
    return deps.jwt.verify(bearerToken(c.req.header("authorization")));
  }

  async function jsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HttpError(400, "body must be JSON");
    }
    const r = schema.safeParse(raw);
    if (!r.success)
      throw new HttpError(
        400,
        r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    return r.data;
  }

  function laneParam(c: Context): Address {
    const raw = c.req.param("lane") ?? "";
    if (!isAddress(raw, { strict: false })) throw new HttpError(400, "lane must be an address");
    return lower(raw);
  }

  function ownedDesk(u: VerifiedUser, lane: Address): DeskRow {
    const d = db.getDesk(lane);
    if (d === null) throw new HttpError(404, "desk not registered");
    requireOwner(u, d.owner);
    return d;
  }

  app.post("/desks", async (c) => {
    const body = await jsonBody(c, RegisterSchema);
    if (body.chainId !== deps.chainId) throw new HttpError(400, `chainId must be ${deps.chainId}`);
    if (!isAddress(body.lane, { strict: false }))
      throw new HttpError(400, "lane must be an address");
    const lane = lower(body.lane);
    const u = await user(c);
    const existing = db.getDesk(lane);
    if (existing !== null) {
      requireOwner(u, existing.owner);
      return c.json({ error: "desk already registered", desk: deskJson(existing) }, 409);
    }

    const block = await deps.chain.blockNumber();
    if (deps.factoryAddress !== undefined) {
      const isLane = await readContract(deps.chain, {
        address: deps.factoryAddress,
        abi: deskLaneFactoryAbi,
        functionName: "isLane",
        args: [lane],
        blockNumber: block,
      }).catch(chainReadFailed("the factory"));
      if (isLane !== true)
        throw new HttpError(400, "not a lane of the configured DeskLane factory");
    }
    const id = await views.identity(lane, block).catch(chainReadFailed("the lane"));
    if (!deps.allowedPools.map(lower).includes(id.pool))
      throw new HttpError(400, `lane pool ${id.pool} is not allowed`);
    requireOwner(u, id.owner);
    if (id.operator === id.owner) throw new HttpError(400, "the operator is the owner");

    let delegationWalletId: string | null = null;
    if (deps.signerKind === "dynamic-delegated") {
      const del = db.getActiveDelegationByAddress(id.operator);
      if (del === null)
        throw new HttpError(412, `operator ${id.operator} has no active delegation yet`);
      if (del.userId !== u.userId)
        throw new HttpError(403, "the operator was delegated by another user");
      delegationWalletId = del.walletId;
    } else if (!deps.ownOperators.map(lower).includes(id.operator)) {
      throw new HttpError(
        412,
        `the lane's operator ${id.operator} is not this agent's ${deps.signerKind} wallet`,
      );
    }

    const now = deps.clock.now();
    const caps = await views.caps(lane, block);
    const ownerDelegation = db.getActiveDelegationByAddress(id.owner);
    db.transaction(() => {
      if (ownerDelegation !== null) {
        // The Vault must never be delegated: drop our copy of its credentials.
        db.revokeDelegation(
          ownerDelegation.walletId,
          `local-purge:${ownerDelegation.walletId}:${now}`,
          now,
        );
      }
      db.insertDesk({
        laneAddress: lane,
        chainId: deps.chainId,
        laneId: id.laneId,
        owner: id.owner,
        operator: id.operator,
        ownerUserId: u.userId,
        signerKind: deps.signerKind,
        mode: deps.defaultMode,
        modeNonce: 0,
        status: "active",
        statusDetail: null,
        capsJson: canonicalJson(caps),
        createdAtMs: now,
        updatedAtMs: now,
      });
      if (delegationWalletId !== null) db.bindDelegationLane(delegationWalletId, lane, now);
    });
    if (ownerDelegation !== null) {
      logger.warn({ lane, owner: id.owner }, "purged a delegation of the lane OWNER");
      await deps.notifier
        ?.notify({
          kind: "alert",
          severity: "critical",
          lane: null,
          laneAddress: lane,
          title: "The lane OWNER (Vault) was delegated: our copy of its credentials was deleted",
          lines: [
            `owner ${id.owner}`,
            "Revoke the Vault's delegation in Dynamic: it is still delegated on Dynamic's side.",
          ],
        })
        .catch(() => {});
    }
    logger.info({ lane, owner: id.owner, operator: id.operator }, "desk registered");
    return c.json(deskJson(db.getDesk(lane) as DeskRow), 201);
  });

  app.get("/desks/:lane/status", async (c) => {
    const lane = laneParam(c);
    const u = await user(c);
    const d = ownedDesk(u, lane);
    let onchain: LaneOnchainState | null = null;
    if (deps.readLane !== undefined) {
      onchain = await deps.readLane(d.laneAddress, d.operator).catch((err: unknown) => {
        logger.warn(
          { lane, error: err instanceof Error ? err.message : String(err) },
          "status: lane read failed",
        );
        return null;
      });
    }
    return c.json(buildStatusView(d, db, deps.clock.now(), onchain));
  });

  app.post("/desks/:lane/mode", async (c) => {
    const lane = laneParam(c);
    const body = await jsonBody(c, ModeSchema);
    const u = await user(c);
    const d = ownedDesk(u, lane);
    const nonce = Number(body.nonce);
    if (!Number.isSafeInteger(nonce) || nonce <= 0)
      throw new HttpError(400, "nonce must be a positive safe integer");
    if (body.mode === "autopilot" && deps.cancelWindowMs <= 0) {
      throw new HttpError(400, "autopilot needs a cancel window (DESK_CANCEL_WINDOW_SEC > 0)");
    }
    let signer: Address;
    try {
      signer = lower(
        await recoverMessageAddress({
          message: modeMessage(lane, body.mode, body.nonce),
          signature: body.signature as `0x${string}`,
        }),
      );
    } catch {
      throw new HttpError(400, "signature is malformed");
    }
    if (signer !== d.owner)
      throw new HttpError(403, "the mode change is not signed by the lane owner");
    const now = deps.clock.now();
    if (!db.setDeskMode(lane, body.mode, nonce, now))
      throw new HttpError(409, "stale nonce (replayed or out of order)");
    if (d.status === "safe_mode")
      db.setDeskStatus(lane, "active", "safe mode cleared by an owner-signed mode change", now);
    logger.info({ lane, mode: body.mode, nonce }, "desk mode changed by the owner");
    const after = db.getDesk(lane) as DeskRow;
    return c.json({ lane, mode: after.mode, nonce: body.nonce, status: after.status });
  });

  app.post("/desks/:lane/approve", async (c) => {
    const lane = laneParam(c);
    const body = await jsonBody(c, ApproveSchema);
    const ulid = isUlid(body.decisionId)
      ? body.decisionId
      : isHex(body.decisionId)
        ? (tryDecodeDecisionId(body.decisionId)?.ulid ?? null)
        : null;
    if (ulid === null)
      throw new HttpError(400, "decisionId must be a ULID or a DeltaDesk bytes32 id");
    const u = await user(c);
    ownedDesk(u, lane);
    const row = db.getApproval(ulid);
    if (row === null || row.laneAddress !== lane)
      throw new HttpError(404, "no such approval for this lane");
    if (!db.respondApproval(ulid, body.approve, "web", u.userId, deps.clock.now())) {
      throw new HttpError(409, "this decision is no longer pending");
    }
    logger.info({ lane, decisionId: ulid, approve: body.approve }, "web approval answer");
    return c.json({ decisionId: ulid, approved: body.approve });
  });

  app.get("/desks/:lane/signals/:decisionId", async (c) => {
    const lane = laneParam(c);
    const raw = c.req.param("decisionId") ?? "";
    const ulid = isUlid(raw) ? raw : isHex(raw) ? (tryDecodeDecisionId(raw)?.ulid ?? null) : null;
    if (ulid === null)
      throw new HttpError(400, "decisionId must be a ULID or a DeltaDesk bytes32 id");
    const u = await user(c);
    ownedDesk(u, lane);
    const g = db.getGateSignal(ulid);
    if (g === null || g.laneAddress !== lane)
      throw new HttpError(404, "no such gate signal for this lane");
    return c.json(signalJson(g));
  });

  app.get("/delegations/:operator", async (c) => {
    const raw = c.req.param("operator") ?? "";
    if (!isAddress(raw, { strict: false })) throw new HttpError(400, "operator must be an address");
    const operator = lower(raw);
    const u = await user(c);
    // The same binding as POST /desks, before any desk exists: the caller must hold the operator
    // wallet, and a delegation row (if any) must be this user's.
    requireWallet(
      u,
      operator,
      "the signed-in user's verified wallets do not include this operator",
    );
    const row = db.getActiveDelegationByAddress(operator) ?? db.latestDelegationByAddress(operator);
    if (row !== null && row.userId !== u.userId)
      throw new HttpError(403, "the operator was delegated by another user");
    return c.json(delegationView(operator, row));
  });

  app.get("/operator-address", (c) => {
    if (deps.serverWalletAddress === undefined) {
      return c.json({ error: "no server-wallet operator is configured" }, 404);
    }
    return c.json({ address: getAddress(deps.serverWalletAddress), kind: "dynamic-server" });
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "desk api error");
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
