// @vitest-environment happy-dom
// One failed poll (agent restart, the 6 s timeout, a shared-IP 429) must not turn a live desk into "Desk not yet live":
// the last live answer stays on screen with a stale banner. "Desk not yet live" needs no live answer ever seen, or the
// agent itself saying it has no lane.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LivePanel from "@/app/console/LivePanel";
import { liveView, nextLiveState } from "./live";
import type { FeedResult, PublicFeed } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LANE = "0x1111111111111111111111111111111111111111";
const live = (lanes = 1, at = Date.now()): FeedResult => ({
  ok: true,
  fetchedAtMs: at,
  feed: {
    generatedAtMs: at,
    live: lanes > 0,
    agent: { defaultMode: "auto", modes: { auto: 1 }, health: { ok: true, lastTickAgeMs: 2_000, lockHeld: true, pendingExecutions: 0 } },
    lanes: Array.from({ length: lanes }, () => ({
      lane: LANE, laneId: 7, chainId: 4663, operator: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", pool: { address: LANE, name: "NVDA/USDG" },
      mode: "auto", status: "active",
      regime: { atMs: at, name: "WEEKEND_DARK", reopenKind: null, activeGates: ["CLOSED"], gatesMask: 1, riskMode: "reduce_only", poolMid: 180, fair: 180.2, gapBps: -11 },
    })),
    decisions: [],
    signals: [],
  } satisfies PublicFeed,
});
const down = (error = "timed out"): FeedResult => ({ ok: false, reason: "unreachable", error, fetchedAtMs: Date.now() });

let polls: FeedResult[] = [];
const fetchMock = vi.fn(async () => new Response(JSON.stringify(polls.shift() ?? down("no more polls")), { status: 200 }));

async function render(initial: FeedResult) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(<LivePanel initial={initial} />));
  return { text: () => el.textContent ?? "", unmount: () => act(() => root.unmount()) };
}
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  polls = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LivePanel", () => {
  it("keeps a live desk on screen through a failed poll, marked stale, and clears the banner on the next answer", async () => {
    const p = await render(live());
    expect(p.text()).toContain("Lane #7");
    polls = [down("timed out"), live()];
    await poll();
    expect(p.text()).not.toContain("Desk not yet live");
    expect(p.text()).toContain("Lane #7");
    expect(p.text()).toMatch(/Desk agent not reachable right now.*timed out.*last live answer/);
    await poll();
    expect(p.text()).toContain("Lane #7");
    expect(p.text()).not.toContain("not reachable");
    p.unmount();
  });

  it("says 'Desk not yet live' when no live answer was ever seen", async () => {
    const p = await render(down("connection failed"));
    expect(p.text()).toContain("Desk not yet live");
    expect(p.text()).toContain("connection failed");
    p.unmount();
  });
});

describe("live view state", () => {
  it("an agent that answers 'no lane' ends the live view (only a failed poll keeps it)", () => {
    const s = nextLiveState(live(0), nextLiveState(live()));
    expect(liveView(s).kind).toBe("not_live");
    expect(liveView(nextLiveState(down(), nextLiveState(live(1, 5)))).kind).toBe("live");
    expect(liveView(nextLiveState(down(), nextLiveState(live(1, 5))))).toMatchObject({ stale: { error: "timed out", lastLiveAtMs: 5 } });
  });
});
