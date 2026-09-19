// Shapes the console reads: the desk agent's GET /public/feed, the on-chain LaneAction feed and the replay files.
// Kept here (not imported from agent/) because the web builds on its own.

export type PublicLane = {
  lane: string;
  laneId: number;
  chainId: number;
  operator: string;
  pool: { address: string; name: string | null } | null;
  mode: string;
  status: string;
  regime: {
    atMs: number;
    name: string;
    reopenKind: string | null;
    activeGates: string[];
    gatesMask: number;
    riskMode: string;
    poolMid: number | null;
    fair: number | null;
    gapBps: number | null;
  } | null;
};

export type PublicDecision = {
  id: string;
  decisionId: string;
  lane: string;
  kind: string;
  kinds: string[];
  status: string;
  summary: string;
  regime: string;
  gatesMask: number;
  txHashes: string[];
  createdAtMs: number;
  updatedAtMs: number;
};

export type PublicSignal = {
  decisionId: string;
  lane: string;
  status: string;
  initial: boolean;
  regime: string;
  gates: string[];
  gatesMask: number;
  reasonHash: string;
  preimage: string | null;
  preimageVerified: boolean | null;
  preimageWithheld: boolean;
  txHash: string | null;
  atMs: number;
  createdAtMs: number;
};

export type PublicFeed = {
  generatedAtMs: number;
  live: boolean;
  agent: {
    defaultMode: string | null;
    modes: Record<string, number>;
    health: { ok: boolean; lastTickAgeMs: number | null; lockHeld: boolean; pendingExecutions: number };
  };
  lanes: PublicLane[];
  decisions: PublicDecision[];
  signals: PublicSignal[];
};

/** "not_configured": AGENT_API_URL unset · "unreachable": network / HTTP error · "invalid": not a feed. */
export type FeedResult = { ok: true; feed: PublicFeed; fetchedAtMs: number } | { ok: false; reason: "not_configured" | "unreachable" | "invalid"; error: string; fetchedAtMs: number };

export type OnchainLaneAction = {
  lane: string;
  laneId: number;
  action: number;
  actionName: string;
  decisionId: string;
  regime: number;
  gatesMask: number;
  reasonHash: string;
  refPx: number | null;
  ticks: number[];
  callerRole: "operator" | "other";
  txHash: string;
  blockNumber: number;
  timestamp: number | null;
};

export type LaneActionsResult =
  | { ok: true; lanes: string[]; fromBlock: number; toBlock: number; spanS: number | null; sinceDeploy: boolean; actions: OnchainLaneAction[]; partial: string | null; fetchedAtMs: number }
  | { ok: false; lanes: string[]; error: string; fetchedAtMs: number };

// ---- replays (agent/scripts/replay.ts)

export type ReplayRow = {
  ts: number;
  regime: string;
  reopenKind: string | null;
  activeGates: string[];
  gatesMask: number;
  riskMode: string;
  riskAddingAllowed: boolean;
  poolMid: number | null;
  hl: number | null;
  k: number | null;
  fair: number | null;
  gapBps: number | null;
  chainlink: { price: number | null; ageS: number | null; frozen: boolean };
  fenceCode: number;
  decision: { action: string; reason: string; atTs: number };
  lane: { deployedUsd: number; inRange: boolean | null } | null;
};

export type ReplayEvent = { ts: number; kind: "gate_on" | "gate_off" | "action"; gate?: string; action?: string; reason: string; warmup: boolean };

export type Replay = {
  label: string;
  id: string;
  title: string;
  note: string;
  pool: string;
  mode: "lane-a" | "gates-only";
  window: { startTs: number; endTs: number; startEt: string; endEt: string };
  rowEveryS: number;
  engine: string[];
  sources: string[];
  assumptions: string[];
  notArmed: Record<string, string>;
  summary: Record<string, unknown>;
  headline: string[];
  lvr: null | {
    derivable?: boolean;
    statement?: string;
    closedWindow?: { hours: number };
    poolWide?: { volumeUsd: number; lpFeesUsd: number; pickedOffHl1hUsd: number; lpNetUsd: number };
    controlLane?: { definition: string; pickedOffUsd: number; feesUsd: number; netUsd: number };
    reason?: string;
  };
  events: ReplayEvent[];
  rows: ReplayRow[];
};

export type ReplayIndex = { label: string; replays: { id: string; title: string; pool: string; mode: string; headline: string[] }[] };
