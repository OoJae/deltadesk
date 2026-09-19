// The live panel's view state (client and server safe). A failed poll after a live answer keeps that answer on screen,
// marked stale, so an agent restart, a slow tick or a shared-IP 429 does not turn a live desk into "not yet live".
// "Desk not yet live" is shown only when no live answer was ever seen, or when the agent itself says it is not live.
import type { FeedResult, PublicFeed } from "./types";

export type LiveState = { latest: FeedResult; lastLive: { feed: PublicFeed; atMs: number } | null };

export type LiveView =
  | { kind: "live"; feed: PublicFeed; stale: { error: string; lastLiveAtMs: number } | null }
  | { kind: "not_live"; result: FeedResult };

/** Folds one poll result into the state. */
export function nextLiveState(r: FeedResult, prev: LiveState | null = null): LiveState {
  if (r.ok) return { latest: r, lastLive: r.feed.live ? { feed: r.feed, atMs: r.fetchedAtMs } : null };
  return { latest: r, lastLive: prev?.lastLive ?? null };
}

export function liveView(s: LiveState): LiveView {
  const r = s.latest;
  if (r.ok) return r.feed.live ? { kind: "live", feed: r.feed, stale: null } : { kind: "not_live", result: r };
  if (s.lastLive !== null) return { kind: "live", feed: s.lastLive.feed, stale: { error: r.error, lastLiveAtMs: s.lastLive.atMs } };
  return { kind: "not_live", result: r };
}
