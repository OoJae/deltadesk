// Server-side, read-only LaneAction feed for the registered lanes, straight from Robinhood Chain (4663) via the public RPC.
// Lanes come from the agent's public feed (never from the request); when the agent does not answer, its last lane list
// is used, and with none the feed says it is unavailable (it never claims "no lane"). History is read from the
// DeskLaneFactory's deployment block: 4663 makes ~10 blocks/s, so a fixed look-back would cover minutes, not the
// weekend. Read ranges are immutable, so they are kept per server process and only new (and not yet read older)
// blocks are fetched on each refresh, up to MAX_RANGES_PER_LOAD ranges. The result is memoised for 15 s.
// Callers are shown as a role ("operator" / "other"), never as an address.
import "server-only";
import { createPublicClient, getAbiItem, http, type Address } from "viem";
import { deskLaneAbi } from "@/lib/desk/abi/DeskLane";
import { getPublicFeed } from "./feed";
import { LANE_ACTION_NAMES } from "./format";
import type { FeedResult, LaneActionsResult, OnchainLaneAction } from "./types";

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
/** DeskLaneFactory's deployment block on 4663 (contracts/broadcast/Deploy.s.sol/4663/run-latest.json): no lane is older. */
export const DEPLOY_BLOCK = BigInt(67_163_464);
/** Blocks per eth_getLogs (about 84 min of 4663); a refused range is retried as CHUNK_BLOCKS pieces. */
export const RANGE_BLOCKS = BigInt(50_000);
const CHUNK_BLOCKS = BigInt(10_000);
/** Ranges read per refresh (~2M blocks, ~55 h); anything left is read on the next refresh. */
export const MAX_RANGES_PER_LOAD = 40;
const PARALLEL = 8;
const ONE = BigInt(1);
const ZERO = BigInt(0);
const MAX_ACTIONS = 60;
const TTL_MS = 15_000;

/** One decoded LaneAction log, before the caller is reduced to a role. */
export type RawLaneAction = Omit<OnchainLaneAction, "callerRole" | "timestamp"> & { caller: string; logIndex: number };

export type LaneActionsDeps = {
  headBlock: () => Promise<bigint>;
  laneActions: (lanes: Address[], fromBlock: bigint, toBlock: bigint) => Promise<RawLaneAction[]>;
  blockTime: (block: bigint) => Promise<number>;
  feed: () => Promise<FeedResult>;
};

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** A contiguous block interval [lo, hi] already read, with every LaneAction in it (lo > hi: nothing read yet). */
type Scan = { key: string; lo: bigint; hi: bigint; actions: RawLaneAction[] };

export function createLaneActionsReader(deps: LaneActionsDeps): () => Promise<LaneActionsResult> {
  let known: { lane: string; operator: string }[] | null = null;
  let scan: Scan | null = null;
  let stamps = new Map<bigint, number>();

  async function readRange(lanes: Address[], from: bigint, to: bigint): Promise<RawLaneAction[]> {
    try {
      return await deps.laneActions(lanes, from, to);
    } catch {
      const parts: Promise<RawLaneAction[]>[] = [];
      for (let a = from; a <= to; a += CHUNK_BLOCKS) parts.push(deps.laneActions(lanes, a, min(a + CHUNK_BLOCKS - ONE, to)));
      return (await Promise.all(parts)).flat();
    }
  }

  /** Extends the scan up to `head` first, then down to DEPLOY_BLOCK; stops at the first refused range. */
  async function fill(s: Scan, lanes: Address[], head: bigint): Promise<string | null> {
    let budget = MAX_RANGES_PER_LOAD;
    for (;;) {
      const forward = s.hi < head;
      if (!forward && s.lo <= DEPLOY_BLOCK) return null;
      if (budget <= 0) return forward ? "newer blocks are still being read" : "older blocks are still being read";
      const ranges: [bigint, bigint][] = [];
      const n = Math.min(PARALLEL, budget);
      if (forward) for (let a = s.hi + ONE; a <= head && ranges.length < n; a += RANGE_BLOCKS) ranges.push([a, min(a + RANGE_BLOCKS - ONE, head)]);
      else for (let b = s.lo - ONE; b >= DEPLOY_BLOCK && ranges.length < n; b -= RANGE_BLOCKS) ranges.push([max(b - RANGE_BLOCKS + ONE, DEPLOY_BLOCK), b]);
      budget -= ranges.length;
      const parts = await Promise.allSettled(ranges.map(([a, b]) => readRange(lanes, a, b)));
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const [a, b] = ranges[i];
        if (p.status === "rejected") return `the RPC refused blocks ${a.toLocaleString()}–${b.toLocaleString()}; retried on the next refresh`;
        s.actions.push(...p.value);
        if (forward) s.hi = b;
        else s.lo = a;
      }
    }
  }

  return async function load(): Promise<LaneActionsResult> {
    const fetchedAtMs = Date.now();
    const feed = await deps.feed();
    if (feed.ok) known = feed.feed.lanes.map((l) => ({ lane: l.lane.toLowerCase(), operator: l.operator.toLowerCase() }));
    if (known === null) return { ok: false, lanes: [], error: "the lane list is unavailable (desk agent not reachable)", fetchedAtMs };
    const laneAddrs = known.map((l) => l.lane);
    if (laneAddrs.length === 0) return { ok: true, lanes: [], fromBlock: 0, toBlock: 0, spanS: null, sinceDeploy: false, actions: [], partial: null, fetchedAtMs };
    const operators = new Set(known.map((l) => l.operator));
    try {
      const head = await deps.headBlock();
      const key = [...laneAddrs].sort().join(",");
      if (scan === null || scan.key !== key) scan = { key, lo: head + ONE, hi: head, actions: [] };
      const s = scan;
      const gap = await fill(s, laneAddrs as Address[], head);
      if (s.lo > s.hi) return { ok: false, lanes: laneAddrs, error: `could not read Robinhood Chain (${gap ?? "no block range"})`, fetchedAtMs };
      const recent = [...s.actions].sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex).slice(0, MAX_ACTIONS);
      const needed = [...new Set([s.lo, s.hi, ...recent.map((a) => BigInt(a.blockNumber))])];
      const prev = stamps;
      stamps = new Map();
      await Promise.allSettled(
        needed.map(async (b) => {
          const cached = prev.get(b);
          stamps.set(b, cached ?? (await deps.blockTime(b)));
        }),
      );
      const first = stamps.get(s.lo);
      const last = stamps.get(s.hi);
      const partial = [feed.ok ? null : "desk agent not reachable: lanes from its last answer", gap].filter((x) => x !== null).join(" · ");
      return {
        ok: true,
        lanes: laneAddrs,
        fromBlock: Number(s.lo),
        toBlock: Number(s.hi),
        spanS: first !== undefined && last !== undefined ? last - first : null,
        sinceDeploy: s.lo <= DEPLOY_BLOCK,
        actions: recent.map(({ caller, ...a }) => ({
          ...a,
          callerRole: operators.has(caller.toLowerCase()) ? "operator" : "other",
          timestamp: stamps.get(BigInt(a.blockNumber)) ?? null,
        })),
        partial: partial || null,
        fetchedAtMs,
      };
    } catch (e) {
      return { ok: false, lanes: laneAddrs, error: `could not read Robinhood Chain (${e instanceof Error ? e.name : "error"})`, fetchedAtMs };
    }
  };
}

function viemDeps(): LaneActionsDeps {
  const client = createPublicClient({ transport: http(RPC_URL, { timeout: 10_000, retryCount: 1 }) });
  const event = getAbiItem({ abi: deskLaneAbi, name: "LaneAction" });
  return {
    headBlock: () => client.getBlockNumber(),
    blockTime: async (blockNumber) => Number((await client.getBlock({ blockNumber })).timestamp),
    laneActions: async (address, fromBlock, toBlock) => {
      const logs = await client.getLogs({ address, event, fromBlock, toBlock, strict: true });
      return logs.map((l) => {
        const a = l.args;
        return {
          lane: l.address,
          laneId: Number(a.lane),
          action: Number(a.action),
          actionName: LANE_ACTION_NAMES[Number(a.action)] ?? `ACTION_${a.action}`,
          decisionId: a.decisionId,
          regime: Number(a.regime),
          gatesMask: Number(a.gatesMask),
          reasonHash: a.reasonHash,
          refPx: a.refPxE18 > ZERO ? Number(a.refPxE18) / 1e18 : null,
          ticks: a.ticks.map(Number),
          caller: a.caller,
          txHash: l.transactionHash,
          blockNumber: Number(l.blockNumber),
          logIndex: l.logIndex,
        };
      });
    },
    feed: getPublicFeed,
  };
}

const read = createLaneActionsReader(viemDeps());
let memo: { at: number; result: Promise<LaneActionsResult> } | null = null;
let inflight = false;

/** The LaneAction feed, memoised 15 s per server process; one read at a time (the scan state is shared). */
export function getLaneActions(): Promise<LaneActionsResult> {
  const now = Date.now();
  if (memo !== null && (inflight || now - memo.at < TTL_MS)) return memo.result;
  inflight = true;
  const result = read().finally(() => {
    inflight = false;
  });
  memo = { at: now, result };
  return result;
}
