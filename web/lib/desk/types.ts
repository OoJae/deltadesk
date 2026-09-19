// Shapes of the desk-agent web API (docs/m2-design-agent.md, "HTTP"; types in agent/src/types.ts). The agent is built in
// parallel, so every nested field is optional and the UI renders whatever is present; the chain is the source of truth
// for controls.

export type DeskMode = "advisory" | "copilot" | "autopilot";
export const MODES: { mode: DeskMode; label: string; note: string; enabled: boolean }[] = [
  { mode: "advisory", label: "Advisory", note: "The agent plans and records, never signs.", enabled: true },
  { mode: "copilot", label: "Copilot", note: "Risk-adding actions wait for your approval; exits run on their own.", enabled: true },
  { mode: "autopilot", label: "Autopilot", note: "Cancel window instead of approval. Arrives in M3.", enabled: false },
];

/** A copilot approval waiting on the owner. */
export type PendingApproval = {
  decisionId: string;
  summary?: string;
  expiresAtMs?: number;
};

/**
 * GET /desks/:lane/status. Mirrors `DeskStatusView` in agent/src/types.ts field for field (bigints arrive as decimal
 * strings); everything below the lane is optional so a partial or older agent still renders.
 */
export type DeskStatus = {
  lane: string;
  owner?: string;
  operator?: string;
  laneId?: number;
  mode?: DeskMode | string;
  /** registered | active | safe_mode | revoked | disabled */
  status?: string;
  /** active | revoked | none */
  delegation?: { status?: string };
  caps?: Record<string, string | number> | null;
  budgets?: Record<string, string> | null;
  positions?: { slot: number; tokenId: string; tickLower: number; tickUpper: number; liquidity: string }[];
  balances?: { token0: string; token1: string } | null;
  lastTick?: {
    atMs?: number;
    regime?: string;
    reopenKind?: string | null;
    /** Names of the gates that are on (CLOSED, HALT, STALE-REF, …). */
    gates?: string[];
    F?: number | null;
    poolMid?: number | null;
    gapBps?: number | null;
    refTick?: number | null;
    band?: number | null;
  } | null;
  lastDecision?: {
    decisionId?: string;
    status?: string;
    createdAtMs?: number;
    summary?: string | null;
  } | null;
  pendingApprovals?: PendingApproval[];
};

/**
 * GET /delegations/:operator: desk-agent's record of the Operator's Dynamic delegation, readable before the desk is
 * registered. "unknown" means no row yet (Dynamic's webhook has not reached the agent).
 */
export type DelegationView = {
  operator: string;
  status: "active" | "revoked" | "unknown";
  walletId: string | null;
  updatedAtMs: number | null;
};

/** Result envelope of every /api/desk/* route handler call made from the browser. */
export type AgentResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };
