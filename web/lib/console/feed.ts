// Server-side read of desk-agent's public feed (GET {AGENT_API_URL}/public/feed): no key, no JWT, nothing forwarded.
// The agent rate-limits per IP, and this server is one IP for every visitor, so the result is memoised for 5 s.
// The payload is re-picked field by field: only the shapes in ./types reach the page, whatever the agent sent.
import "server-only";
import type { FeedResult, PublicDecision, PublicFeed, PublicLane, PublicSignal } from "./types";

const AGENT = (process.env.AGENT_API_URL ?? "").trim().replace(/\/+$/, "");
const TTL_MS = 5_000;

type J = Record<string, unknown>;
const obj = (v: unknown): J | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.slice(0, max) : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const hex = (v: unknown): string | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? v : null);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 40));

function lane(v: unknown): PublicLane | null {
  const o = obj(v);
  const addr = hex(o?.lane);
  if (!o || !addr) return null;
  const p = obj(o.pool);
  const r = obj(o.regime);
  return {
    lane: addr,
    laneId: n(o.laneId) ?? 0,
    chainId: n(o.chainId) ?? 4663,
    operator: hex(o.operator) ?? "",
    pool: p && hex(p.address) ? { address: hex(p.address) as string, name: typeof p.name === "string" ? p.name.slice(0, 20) : null } : null,
    mode: str(o.mode, 20),
    status: str(o.status, 20),
    regime: r
      ? {
          atMs: n(r.atMs) ?? 0,
          name: str(r.name, 20),
          reopenKind: typeof r.reopenKind === "string" ? r.reopenKind.slice(0, 20) : null,
          activeGates: strs(r.activeGates),
          gatesMask: n(r.gatesMask) ?? 0,
          riskMode: str(r.riskMode, 20),
          poolMid: n(r.poolMid),
          fair: n(r.fair),
          gapBps: n(r.gapBps),
        }
      : null,
  };
}

function decision(v: unknown): PublicDecision | null {
  const o = obj(v);
  if (!o || typeof o.id !== "string") return null;
  return {
    id: str(o.id, 40),
    decisionId: str(o.decisionId, 66),
    lane: hex(o.lane) ?? "",
    kind: str(o.kind, 20),
    kinds: strs(o.kinds),
    status: str(o.status, 30),
    summary: str(o.summary, 300),
    regime: str(o.regime, 20),
    gatesMask: n(o.gatesMask) ?? 0,
    txHashes: arr(o.txHashes).map(hex).filter((x): x is string => x !== null && x.length === 66),
    createdAtMs: n(o.createdAtMs) ?? 0,
    updatedAtMs: n(o.updatedAtMs) ?? 0,
  };
}

function signal(v: unknown): PublicSignal | null {
  const o = obj(v);
  const id = hex(o?.decisionId);
  if (!o || !id) return null;
  const tx = hex(o.txHash);
  return {
    decisionId: id,
    lane: hex(o.lane) ?? "",
    status: str(o.status, 20),
    initial: o.initial === true,
    regime: str(o.regime, 20),
    gates: strs(o.gates),
    gatesMask: n(o.gatesMask) ?? 0,
    reasonHash: hex(o.reasonHash) ?? "",
    preimage: typeof o.preimage === "string" ? o.preimage.slice(0, 4000) : null,
    preimageVerified: typeof o.preimageVerified === "boolean" ? o.preimageVerified : null,
    preimageWithheld: o.preimageWithheld === true,
    txHash: tx && tx.length === 66 ? tx : null,
    atMs: n(o.atMs) ?? 0,
    createdAtMs: n(o.createdAtMs) ?? 0,
  };
}

export function parseFeed(body: unknown): PublicFeed | null {
  const o = obj(body);
  if (!o || o.kind !== "deltadesk-public-feed") return null;
  const agent = obj(o.agent);
  const h = obj(agent?.health);
  const modes: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(agent?.modes) ?? {})) if (n(v) !== null && /^[a-z_]{1,20}$/.test(k)) modes[k] = v as number;
  const lanes = arr(o.lanes).map(lane).filter((x): x is PublicLane => x !== null);
  return {
    generatedAtMs: n(o.generatedAtMs) ?? Date.now(),
    live: o.live === true && lanes.length > 0,
    agent: {
      defaultMode: typeof agent?.defaultMode === "string" ? agent.defaultMode.slice(0, 20) : null,
      modes,
      health: { ok: h?.ok === true, lastTickAgeMs: n(h?.lastTickAgeMs), lockHeld: h?.lockHeld === true, pendingExecutions: n(h?.pendingExecutions) ?? 0 },
    },
    lanes,
    decisions: arr(o.decisions).map(decision).filter((x): x is PublicDecision => x !== null).slice(0, 50),
    signals: arr(o.signals).map(signal).filter((x): x is PublicSignal => x !== null).slice(0, 50),
  };
}

let memo: { at: number; result: Promise<FeedResult> } | null = null;

async function load(): Promise<FeedResult> {
  const fetchedAtMs = Date.now();
  if (!AGENT) return { ok: false, reason: "not_configured", error: "AGENT_API_URL is not set on this deployment", fetchedAtMs };
  try {
    const res = await fetch(`${AGENT}/public/feed`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return { ok: false, reason: "unreachable", error: `HTTP ${res.status}`, fetchedAtMs };
    const feed = parseFeed(await res.json());
    return feed === null ? { ok: false, reason: "invalid", error: "desk-agent did not return a public feed", fetchedAtMs } : { ok: true, feed, fetchedAtMs };
  } catch (e) {
    return { ok: false, reason: "unreachable", error: e instanceof Error && e.name === "TimeoutError" ? "timed out" : "connection failed", fetchedAtMs };
  }
}

/** The public feed, memoised for 5 s per server process. */
export function getPublicFeed(): Promise<FeedResult> {
  const now = Date.now();
  if (memo === null || now - memo.at >= TTL_MS) memo = { at: now, result: load() };
  return memo.result;
}
