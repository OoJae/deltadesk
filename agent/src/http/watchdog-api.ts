/**
 * The watchdog's cross-check of operator LaneActions (the watchdog is a separate service that
 * holds only the guardian key):
 *
 *   GET /lanes/:lane/actions/:decisionId[?tx=0x…]  → 200 {known: boolean, status?: string}
 *
 * `known` is true only when this agent's DB holds an execution of that lane with that on-chain
 * decisionId (bytes32) AND at least one signed tx_attempt for it; with `tx`, one of those attempts
 * must be that transaction. Every signature is persisted before its broadcast (write-ahead), so a
 * LaneAction the agent produced is always known by the time it is mined. A stolen operator key can
 * forge the ULID layout of a decisionId, never a row in this DB: known=false is what the watchdog
 * pauses on. `status` is the execution's status when known.
 *
 * Authentication: a dedicated shared secret in `x-watchdog-key` (WATCHDOG_AGENT_KEY, ≥ 32 chars,
 * never the web's DESK_AGENT_API_KEY), compared in constant time. Without the key configured the
 * route answers 503: it never runs unauthenticated. No JWT: the watchdog is not a user.
 */

import { type Context, Hono } from "hono";
import { isAddress } from "viem";
import type { Address, DeskDb, DeskLogger, Hex } from "../types.js";
import { safeEqual } from "./auth.js";

export const WATCHDOG_KEY_HEADER = "x-watchdog-key";
/** The shortest WATCHDOG_AGENT_KEY config accepts. */
export const WATCHDOG_KEY_MIN_LENGTH = 32;

export interface WatchdogApiDeps {
  db: Pick<DeskDb, "getExecutionByOnchainId" | "attemptsForExecution">;
  /** WATCHDOG_AGENT_KEY; undefined: the route refuses every call (503). */
  key: string | undefined;
  logger: DeskLogger;
}

export interface ActionCheck {
  known: boolean;
  status?: string;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/** Did this agent sign a transaction for `decisionId` on `lane` (and, given, is `txHash` one)? */
export function checkAction(
  db: WatchdogApiDeps["db"],
  lane: Address,
  decisionId: Hex,
  txHash?: Hex,
): ActionCheck {
  const exec = db.getExecutionByOnchainId(decisionId.toLowerCase() as Hex);
  if (exec === null || exec.laneAddress.toLowerCase() !== lane.toLowerCase())
    return { known: false };
  const attempts = db.attemptsForExecution(exec.executionId);
  const signed =
    txHash === undefined
      ? attempts.length > 0
      : attempts.some((a) => a.txHash.toLowerCase() === txHash.toLowerCase());
  return signed ? { known: true, status: exec.status } : { known: false };
}

export function createWatchdogRoutes(deps: WatchdogApiDeps): Hono {
  const app = new Hono();

  app.use("/lanes/*", async (c, next) => {
    if (deps.key === undefined)
      return c.json({ error: "watchdog API not configured (WATCHDOG_AGENT_KEY)" }, 503);
    const presented = c.req.header(WATCHDOG_KEY_HEADER);
    if (presented === undefined || !safeEqual(deps.key, presented))
      return c.json({ error: "missing or invalid watchdog key" }, 401);
    await next();
  });

  const bad = (c: Context, error: string) => c.json({ error }, 400);

  app.get("/lanes/:lane/actions/:decisionId", (c) => {
    const lane = c.req.param("lane") ?? "";
    const decisionId = c.req.param("decisionId") ?? "";
    const tx = c.req.query("tx");
    if (!isAddress(lane, { strict: false })) return bad(c, "lane must be an address");
    if (!BYTES32_RE.test(decisionId)) return bad(c, "decisionId must be bytes32 hex");
    if (tx !== undefined && !BYTES32_RE.test(tx)) return bad(c, "tx must be a transaction hash");
    const r = checkAction(deps.db, lane as Address, decisionId as Hex, tx as Hex | undefined);
    if (!r.known)
      deps.logger.warn(
        { lane, decisionId, tx: tx ?? null },
        "watchdog asked about an unknown action",
      );
    return c.json(r);
  });

  return app;
}
