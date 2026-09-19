/**
 * GET /public/feed: the desk's public state, for the web console (no auth, cached 5 s, rate-limited
 * per client IP). Whitelisted fields only, built field by field (never a row spread):
 *
 *   lanes      registered lanes: lane + operator address (both public on-chain), pool, desk mode and
 *              status, and the lane's latest regime tick (calendar regime, active gates, risk mode,
 *              pool mid, fair value, gap)
 *   decisions  the last N: kind(s), status, a one-line summary (the plan's rationale, which never
 *              carries planned ticks), the on-chain decisionId, tx hashes, times
 *   signals    the last N gate signals (signal(Meta) LaneActions) with the reasonHash preimage and
 *              whether keccak256(preimage) == reasonHash
 *   agent      default mode, desk modes, health (/health's view)
 *
 * Never: owner (Vault) or any other wallet address, delegation rows, key material, user ids,
 * emails, JWTs, status details or raw plan / snapshot JSON. Any 0x-address in free text that is not
 * a lane or an operator is masked, and a preimage holding one is withheld rather than altered.
 */

import { type Context, Hono } from "hono";
import { keccak256, stringToBytes } from "viem";
import { NVDA_USDG_POOL } from "../addresses.js";
import { encodeDecisionId } from "../executor/decision-id.js";
import type { Address, DecisionRow, DeskDb, DeskRow, GateName, Hex, TickRow } from "../types.js";
import type { HttpAppDeps } from "./server.js";

export type PublicFeedDeps = Pick<HttpAppDeps, "health" | "desks" | "logger">;

export interface PublicFeedOptions {
  /** Response cache (default 5 s). */
  cacheMs?: number;
  /** Requests per client IP per window (default 30 per 60 s). */
  rateLimit?: { max: number; windowMs: number };
  /** Most recent decisions and signals returned (default 20 each). */
  decisions?: number;
  signals?: number;
  /** Bound on the rate limiter's memory (default 10,000 IPs). */
  maxTrackedIps?: number;
  now?: () => number;
}

export interface PublicLane {
  lane: Address;
  laneId: number;
  chainId: number;
  operator: Address;
  pool: { address: Address; name: string | null } | null;
  mode: string;
  status: string;
  regime: {
    atMs: number;
    name: string;
    reopenKind: string | null;
    activeGates: GateName[];
    gatesMask: number;
    riskMode: string;
    poolMid: number | null;
    fair: number | null;
    gapBps: number | null;
  } | null;
}

export interface PublicDecision {
  id: string;
  decisionId: string;
  lane: Address;
  kind: string;
  kinds: string[];
  status: string;
  summary: string;
  regime: string;
  gatesMask: number;
  txHashes: Hex[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PublicSignal {
  decisionId: Hex;
  lane: Address;
  status: string;
  initial: boolean;
  regime: string;
  gates: string[];
  gatesMask: number;
  reasonHash: Hex;
  preimage: string | null;
  preimageVerified: boolean | null;
  preimageWithheld: boolean;
  txHash: Hex | null;
  atMs: number;
  createdAtMs: number;
}

export interface PublicFeed {
  kind: "deltadesk-public-feed";
  version: 1;
  generatedAtMs: number;
  live: boolean;
  agent: {
    defaultMode: string | null;
    modes: Record<string, number>;
    health: {
      ok: boolean;
      lastTickAgeMs: number | null;
      lockHeld: boolean;
      pendingExecutions: number;
    };
  };
  lanes: PublicLane[];
  decisions: PublicDecision[];
  signals: PublicSignal[];
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const lower = (a: string) => a.toLowerCase();

function num(x: number | null | undefined): number | null {
  return x === null || x === undefined || !Number.isFinite(x) ? null : x;
}

/** Free text made public: URLs dropped, foreign addresses masked, one line, bounded. */
export function publicText(s: string, allowed: ReadonlySet<string>, max = 240): string {
  const t = s
    .replace(URL_RE, "[url]")
    .replace(ADDRESS_RE, (a) => (allowed.has(lower(a)) ? a : "0x…"))
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A preimage is published verbatim or not at all (masking would break its hash). */
export function preimageIsPublic(json: string, allowed: ReadonlySet<string>): boolean {
  return [...json.matchAll(ADDRESS_RE)].every((m) => allowed.has(lower(m[0])));
}

function parseActions(json: string | null): {
  kinds: string[];
  notes: string[];
  rationale: string[];
} {
  if (json === null) return { kinds: [], notes: [], rationale: [] };
  try {
    const plan = JSON.parse(json) as { actions?: unknown; rationale?: unknown };
    const actions = Array.isArray(plan.actions) ? (plan.actions as Record<string, unknown>[]) : [];
    const rationale = Array.isArray(plan.rationale)
      ? plan.rationale.filter((r): r is string => typeof r === "string")
      : [];
    return {
      kinds: actions.map((a) => (typeof a.kind === "string" ? a.kind : "unknown")),
      notes: actions.flatMap((a) =>
        a.kind === "signal" && typeof a.note === "string" ? [a.note] : [],
      ),
      rationale,
    };
  } catch {
    return { kinds: [], notes: [], rationale: [] };
  }
}

function onchainId(ulid: string): string {
  try {
    return encodeDecisionId(ulid, 0);
  } catch {
    return ulid;
  }
}

function laneView(d: DeskRow, tick: TickRow | null, pools: readonly Address[]): PublicLane {
  const pool = pools.length === 1 ? (pools[0] as Address) : null;
  let gates: GateName[] = [];
  if (tick !== null) {
    try {
      const g = JSON.parse(tick.activeGatesJson) as unknown;
      if (Array.isArray(g)) gates = g.filter((x): x is GateName => typeof x === "string");
    } catch {
      gates = [];
    }
  }
  return {
    lane: d.laneAddress,
    laneId: d.laneId,
    chainId: d.chainId,
    operator: d.operator,
    pool:
      pool === null
        ? null
        : {
            address: pool,
            name: lower(pool) === lower(NVDA_USDG_POOL.address) ? "NVDA/USDG" : null,
          },
    mode: d.mode,
    status: d.status,
    regime:
      tick === null
        ? null
        : {
            atMs: tick.atMs,
            name: tick.regime,
            reopenKind: tick.reopenKind,
            activeGates: gates,
            gatesMask: tick.gatesMask,
            riskMode: tick.riskMode,
            poolMid: num(tick.poolMid),
            fair: num(tick.fairValue),
            gapBps: num(tick.gapBps),
          },
  };
}

function decisionView(
  r: DecisionRow,
  db: Pick<DeskDb, "executionsForDecision">,
  allowed: ReadonlySet<string>,
): PublicDecision {
  const plan = parseActions(r.finalPlanJson ?? r.planJson);
  const text = plan.notes.length > 0 ? plan.notes : plan.rationale;
  const kinds = plan.kinds.length > 0 ? plan.kinds : ["unknown"];
  const txHashes = db
    .executionsForDecision(r.decisionId)
    .flatMap((e) => (e.txHash === null ? [] : [e.txHash]));
  return {
    id: r.decisionId,
    decisionId: onchainId(r.decisionId),
    lane: r.laneAddress,
    kind: kinds.find((k) => k !== "hold") ?? (kinds[0] as string),
    kinds,
    status: r.status,
    summary: publicText(text.join("; ") || kinds.join(", "), allowed),
    regime: r.regime,
    gatesMask: r.gatesMask,
    txHashes,
    createdAtMs: r.createdAtMs,
    updatedAtMs: r.updatedAtMs,
  };
}

export function buildPublicFeed(deps: PublicFeedDeps, opts: PublicFeedOptions = {}): PublicFeed {
  const now = opts.now ?? Date.now;
  const h = deps.health();
  const health = {
    ok: h.ok,
    lastTickAgeMs: h.lastTickAgeMs,
    lockHeld: h.lockHeld,
    pendingExecutions: h.pendingExecutions,
  };
  const api = deps.desks;
  if (api === null) {
    return {
      kind: "deltadesk-public-feed",
      version: 1,
      generatedAtMs: now(),
      live: false,
      agent: { defaultMode: null, modes: {}, health },
      lanes: [],
      decisions: [],
      signals: [],
    };
  }
  const db = api.db;
  const desks = db.listDesks();
  const allowed = new Set<string>();
  for (const d of desks) {
    allowed.add(lower(d.laneAddress));
    allowed.add(lower(d.operator));
  }
  const modes: Record<string, number> = {};
  for (const d of desks) modes[d.mode] = (modes[d.mode] ?? 0) + 1;

  const lanes = desks.map((d) => laneView(d, db.lastTick(d.laneAddress), api.allowedPools));
  const known = new Set(desks.map((d) => lower(d.laneAddress)));
  const decisions = db
    .recentDecisions(opts.decisions ?? 20)
    .filter((r) => known.has(lower(r.laneAddress)))
    .map((r) => decisionView(r, db, allowed));

  const signals: PublicSignal[] =
    typeof db.recentGateSignals !== "function"
      ? []
      : desks
          .flatMap((d) => db.recentGateSignals(d.laneAddress, opts.signals ?? 20))
          .sort((a, b) => b.createdAtMs - a.createdAtMs)
          .slice(0, opts.signals ?? 20)
          .map((s) => {
            const open = preimageIsPublic(s.preimageJson, allowed);
            let gates: string[] = [];
            try {
              const g = JSON.parse(s.gatesJson) as unknown;
              if (Array.isArray(g)) gates = g.filter((x): x is string => typeof x === "string");
            } catch {
              gates = [];
            }
            return {
              decisionId: s.onchainId,
              lane: s.laneAddress,
              status: s.status,
              initial: s.initial,
              regime: s.toRegime,
              gates,
              gatesMask: s.gatesMask,
              reasonHash: s.reasonHash,
              preimage: open ? s.preimageJson : null,
              preimageVerified: open
                ? lower(keccak256(stringToBytes(s.preimageJson))) === lower(s.reasonHash)
                : null,
              preimageWithheld: !open,
              txHash: s.txHash,
              atMs: s.atMs,
              createdAtMs: s.createdAtMs,
            };
          });

  return {
    kind: "deltadesk-public-feed",
    version: 1,
    generatedAtMs: now(),
    live: desks.length > 0,
    agent: { defaultMode: api.defaultMode, modes, health },
    lanes,
    decisions,
    signals,
  };
}

const PRIVATE_IP =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::ffff:127\.|f[cd][0-9a-f]{2}:)/i;

/**
 * The client IP: the socket peer when it is public (a direct client), otherwise the RIGHTMOST
 * X-Forwarded-For entry, the one our own proxy (Railway's edge) appended; a client cannot move it.
 */
export function clientIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = env?.incoming?.socket?.remoteAddress;
  if (peer !== undefined && !PRIVATE_IP.test(peer)) return peer;
  const xff = c.req.header("x-forwarded-for");
  const hop = xff
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .at(-1);
  return (hop ?? peer ?? "unknown").slice(0, 64);
}

export function createPublicFeedRoutes(deps: PublicFeedDeps, opts: PublicFeedOptions = {}): Hono {
  const app = new Hono();
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 5_000;
  const { max, windowMs } = opts.rateLimit ?? { max: 30, windowMs: 60_000 };
  const maxIps = opts.maxTrackedIps ?? 10_000;
  const hits = new Map<string, { windowStart: number; count: number }>();
  let cached: { atMs: number; body: string } | null = null;

  app.get("/public/feed", (c) => {
    const t = now();
    const ip = clientIp(c);
    let h = hits.get(ip);
    if (h === undefined || t - h.windowStart >= windowMs) {
      if (h === undefined && hits.size >= maxIps) {
        for (const [k, v] of hits) if (t - v.windowStart >= windowMs) hits.delete(k);
        if (hits.size >= maxIps) hits.clear();
      }
      h = { windowStart: t, count: 0 };
      hits.set(ip, h);
    }
    h.count += 1;
    if (h.count > max) {
      const retry = Math.max(1, Math.ceil((h.windowStart + windowMs - t) / 1000));
      c.header("retry-after", String(retry));
      return c.json({ error: "rate limited" }, 429);
    }

    if (cached === null || t - cached.atMs >= cacheMs) {
      try {
        cached = { atMs: t, body: JSON.stringify(buildPublicFeed(deps, { ...opts, now })) };
      } catch (err) {
        deps.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "public feed failed",
        );
        return c.json({ error: "feed unavailable" }, 503);
      }
    }
    c.header("cache-control", `public, max-age=${Math.ceil(cacheMs / 1000)}`);
    c.header("access-control-allow-origin", "*");
    c.header("content-type", "application/json; charset=utf-8");
    return c.body(cached.body, 200);
  });

  return app;
}
