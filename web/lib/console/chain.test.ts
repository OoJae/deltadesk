// The console's on-chain LaneAction feed reads from the lane factory's deployment block (4663 makes ~10 blocks/s, so the
// old fixed 50k-block look-back covered ~84 min and lost the initial mint and the weekend's CLOSED signal), keeps what it
// read, and never says "no lane is registered" because the desk agent did not answer.
import { describe, expect, it, vi } from "vitest";
import type { FeedResult, PublicFeed } from "./types";

vi.mock("server-only", () => ({}));

const { createLaneActionsReader, DEPLOY_BLOCK, MAX_RANGES_PER_LOAD, RANGE_BLOCKS } = await import("./chain");
type RawLaneAction = import("./chain").RawLaneAction;

const LANE = "0x1111111111111111111111111111111111111111";
const OP = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const b = (n: number) => DEPLOY_BLOCK + BigInt(n);

const feedOk = (lanes = [LANE]): FeedResult => ({
  ok: true,
  fetchedAtMs: 1,
  feed: {
    generatedAtMs: 1,
    live: lanes.length > 0,
    agent: { defaultMode: "auto", modes: {}, health: { ok: true, lastTickAgeMs: 1, lockHeld: true, pendingExecutions: 0 } },
    lanes: lanes.map((lane) => ({ lane, laneId: 1, chainId: 4663, operator: OP, pool: null, mode: "auto", status: "active", regime: null })),
    decisions: [],
    signals: [],
  } satisfies PublicFeed,
});
const feedDown: FeedResult = { ok: false, reason: "unreachable", error: "HTTP 429", fetchedAtMs: 1 };

function action(block: bigint, name: string, caller = OP): RawLaneAction {
  return {
    lane: LANE, laneId: 1, action: name === "SIGNAL" ? 8 : 0, actionName: name, decisionId: `0x${block.toString(16).padStart(64, "0")}`,
    regime: 4, gatesMask: 1, reasonHash: `0x${"00".repeat(32)}`, refPx: null, ticks: [], caller,
    txHash: `0x${block.toString(16).padStart(64, "a")}`, blockNumber: Number(block), logIndex: 0,
  };
}

function fakeChain(head: bigint, actions: RawLaneAction[], refuse: (from: bigint, to: bigint) => boolean = () => false) {
  const chain = {
    head,
    actions,
    refuse,
    calls: [] as [bigint, bigint][],
    feed: feedOk() as FeedResult,
  };
  const read = createLaneActionsReader({
    headBlock: async () => chain.head,
    blockTime: async (n) => 1_789_829_035 + Number(n - DEPLOY_BLOCK) / 10,
    feed: async () => chain.feed,
    laneActions: async (lanes, from, to) => {
      chain.calls.push([from, to]);
      if (chain.refuse(from, to)) throw new Error("range refused");
      return chain.actions.filter((a) => BigInt(a.blockNumber) >= from && BigInt(a.blockNumber) <= to && lanes.includes(a.lane.toLowerCase() as never));
    },
  });
  return { chain, read };
}

describe("on-chain LaneAction feed", () => {
  it("reads from the factory deployment, not a fixed look-back: the initial mint hours ago is listed", async () => {
    const head = b(300_000); // ~8 h of 4663 blocks
    const { chain, read } = fakeChain(head, [action(b(43), "RERANGE"), action(head - BigInt(10), "SIGNAL", "0x9999999999999999999999999999999999999999")]);
    const r = await read();
    if (!r.ok) throw new Error(r.error);
    expect(r.actions.map((a) => a.actionName)).toEqual(["SIGNAL", "RERANGE"]); // newest first
    expect(r.actions.map((a) => a.callerRole)).toEqual(["other", "operator"]);
    expect(r.actions[1]).not.toHaveProperty("caller"); // no caller address leaves the server
    expect(r.fromBlock).toBe(Number(DEPLOY_BLOCK));
    expect(r.toBlock).toBe(Number(head));
    expect(r.sinceDeploy).toBe(true);
    expect(r.partial).toBeNull();
    expect(r.spanS).toBe(30_000);
    expect(Math.min(...chain.calls.map(([from]) => Number(from)))).toBe(Number(DEPLOY_BLOCK));
    for (const [from, to] of chain.calls) expect(to - from + BigInt(1) <= RANGE_BLOCKS).toBe(true);
  });

  it("keeps what it read: a refresh fetches only the new blocks", async () => {
    const head = b(120_000);
    const { chain, read } = fakeChain(head, [action(b(43), "RERANGE")]);
    await read();
    chain.calls.length = 0;
    chain.head = head + BigInt(900);
    chain.actions.push(action(head + BigInt(5), "SIGNAL"));
    const r = await read();
    if (!r.ok) throw new Error(r.error);
    expect(chain.calls).toEqual([[head + BigInt(1), head + BigInt(900)]]);
    expect(r.actions.map((a) => a.actionName)).toEqual(["SIGNAL", "RERANGE"]);
  });

  it("reads at most MAX_RANGES_PER_LOAD ranges per refresh, newest first, and says the rest is still being read", async () => {
    const ranges = MAX_RANGES_PER_LOAD + 5;
    const head = DEPLOY_BLOCK + RANGE_BLOCKS * BigInt(ranges) - BigInt(1);
    const { chain, read } = fakeChain(head, [action(b(43), "RERANGE"), action(head, "SIGNAL")]);
    const first = await read();
    if (!first.ok) throw new Error(first.error);
    expect(chain.calls).toHaveLength(MAX_RANGES_PER_LOAD);
    expect(first.actions.map((a) => a.actionName)).toEqual(["SIGNAL"]);
    expect(first.sinceDeploy).toBe(false);
    expect(first.partial).toMatch(/older blocks are still being read/);
    const second = await read();
    if (!second.ok) throw new Error(second.error);
    expect(second.sinceDeploy).toBe(true);
    expect(second.actions.map((a) => a.actionName)).toEqual(["SIGNAL", "RERANGE"]);
  });

  it("retries a refused range in 10k pieces, and stops at a range that still fails (read again next refresh)", async () => {
    const head = b(200_000);
    let down = true;
    const { chain, read } = fakeChain(head, [action(b(43), "RERANGE")], (from, to) => to - from >= BigInt(10_000) || (down && from <= b(43)));
    const first = await read();
    if (!first.ok) throw new Error(first.error);
    expect(chain.calls.some(([from, to]) => to - from + BigInt(1) === BigInt(10_000))).toBe(true);
    expect(first.sinceDeploy).toBe(false);
    expect(first.fromBlock).toBeGreaterThan(Number(b(43)));
    expect(first.partial).toMatch(/RPC refused blocks/);
    down = false;
    const second = await read();
    if (!second.ok) throw new Error(second.error);
    expect(second.sinceDeploy).toBe(true);
    expect(second.actions.map((a) => a.actionName)).toEqual(["RERANGE"]);
  });

  it("with the desk agent down and no earlier answer, says the feed is unavailable, never 'no lane is registered'", async () => {
    const { chain, read } = fakeChain(b(1_000), []);
    chain.feed = feedDown;
    const r = await read();
    expect(r).toMatchObject({ ok: false, lanes: [], error: expect.stringMatching(/lane list is unavailable/) });
    expect(chain.calls).toHaveLength(0);
  });

  it("with the desk agent down after an answer, keeps reading its last lane list and says so", async () => {
    const { chain, read } = fakeChain(b(1_000), [action(b(500), "SIGNAL")]);
    await read();
    chain.feed = feedDown;
    const r = await read();
    if (!r.ok) throw new Error(r.error);
    expect(r.lanes).toEqual([LANE]);
    expect(r.actions.map((a) => a.actionName)).toEqual(["SIGNAL"]);
    expect(r.partial).toMatch(/desk agent not reachable/);
  });

  it("an agent that answers with no lane is the only source of 'no lane'", async () => {
    const { chain, read } = fakeChain(b(1_000), []);
    chain.feed = feedOk([]);
    expect(await read()).toMatchObject({ ok: true, lanes: [], actions: [] });
  });
});
