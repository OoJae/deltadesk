/**
 * SQLite state store (better-sqlite3): the evidence trail, the write-ahead log of every signature,
 * and the source of truth for turnover, idempotency, nonces and cooldowns after a restart.
 *
 * SAFETY INVARIANTS
 * - Write-ahead: an execution row exists (status 'prepared') before anything is signed, and the
 *   signed bytes are persisted together with status 'signed' in ONE transaction before broadcast
 *   (recordSignedAttempt). Triggers make signed rows and signed bytes immutable and append-only.
 * - Turnover is fail-closed: it counts EVERY adding execution with a signature, whatever its status
 *   (a dropped or unknown tx may still land). Blocked, dry-run and advisory decisions never create
 *   execution rows, so they can never inflate it.
 * - Idempotency is a constraint: UNIQUE(decision_id, step_index) and UNIQUE(onchain_id).
 * - Money is integer cents; wei and usd6 are TEXT-encoded bigints. Addresses are stored lowercase.
 * - WAL with synchronous=FULL: a committed write-ahead row survives power loss, not only a crash.
 */

import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Address,
  ApprovalRow,
  DecisionRow,
  DelegationRevocationRow,
  DelegationRow,
  DeskDb,
  DeskRow,
  ExecutionRow,
  ExecutionStatus,
  Hex,
  HlFillRow,
  HlOrderRow,
  LaneActionRow,
  LockAcquisition,
  LockStatus,
  NewExecution,
  NewTxAttempt,
  NonceStateRow,
  OverlayRow,
  ParamCacheRow,
  RegimeName,
  ServerWalletRow,
  SessionTickSample,
  TickRow,
  TxAttemptRow,
  WebhookEventRow,
  WebhookRecordResult,
} from "../types.js";
import { migrate, schemaVersion } from "./migrations.js";

// ---------------------------------------------------------------------------------------------
// Generic row mapping. Each table declares every field's column and storage kind once; inserts,
// patches and reads are derived from that, so a field can't be forgotten in one direction.

/** s: text · n: integer/real · b: 0/1 boolean · big: bigint as decimal TEXT · a: address (lowercased) */
type Kind = "s" | "n" | "b" | "big" | "a";
type ColSpec<R> = { readonly [K in keyof R]-?: readonly [column: string, kind: Kind] };
interface TableSpec<R> {
  readonly name: string;
  readonly cols: ColSpec<R>;
}

function encode(kind: Kind, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  switch (kind) {
    case "b":
      return v ? 1 : 0;
    case "big":
      if (typeof v !== "bigint") throw new TypeError(`db: expected bigint, got ${typeof v}`);
      return v.toString();
    case "a":
      if (typeof v !== "string")
        throw new TypeError(`db: expected address string, got ${typeof v}`);
      return v.toLowerCase();
    default:
      return v;
  }
}

function decode(kind: Kind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "b":
      return v === 1;
    case "big":
      return BigInt(v as string);
    default:
      return v;
  }
}

const lower = (a: string): string => a.toLowerCase();

const DESKS: TableSpec<DeskRow> = {
  name: "desks",
  cols: {
    laneAddress: ["lane", "a"],
    chainId: ["chain_id", "n"],
    laneId: ["lane_id", "n"],
    owner: ["owner", "a"],
    operator: ["operator", "a"],
    ownerUserId: ["owner_user_id", "s"],
    signerKind: ["signer_kind", "s"],
    mode: ["mode", "s"],
    modeNonce: ["mode_nonce", "n"],
    status: ["status", "s"],
    statusDetail: ["status_detail", "s"],
    capsJson: ["caps_json", "s"],
    createdAtMs: ["created_at_ms", "n"],
    updatedAtMs: ["updated_at_ms", "n"],
  },
};

const DELEGATIONS: TableSpec<DelegationRow> = {
  name: "delegations",
  cols: {
    walletId: ["wallet_id", "s"],
    userId: ["user_id", "s"],
    accountAddress: ["account_address", "a"],
    chain: ["chain", "s"],
    laneAddress: ["lane", "a"],
    status: ["status", "s"],
    keyShareCt: ["key_share_ct", "s"],
    apiKeyCt: ["api_key_ct", "s"],
    dekWrapped: ["dek_wrapped", "s"],
    kekId: ["kek_id", "s"],
    createdEventId: ["created_event_id", "s"],
    revokedEventId: ["revoked_event_id", "s"],
    createdAtMs: ["created_at_ms", "n"],
    updatedAtMs: ["updated_at_ms", "n"],
    revokedAtMs: ["revoked_at_ms", "n"],
  },
};

const DELEGATION_REVOCATIONS: TableSpec<DelegationRevocationRow> = {
  name: "delegation_revocations",
  cols: {
    eventId: ["event_id", "s"],
    walletId: ["wallet_id", "s"],
    eventAtMs: ["event_at_ms", "n"],
    recordedAtMs: ["recorded_at_ms", "n"],
  },
};

const WEBHOOK_EVENTS: TableSpec<WebhookEventRow> = {
  name: "webhook_events",
  cols: {
    eventId: ["event_id", "s"],
    eventName: ["event_name", "s"],
    receivedAtMs: ["received_at_ms", "n"],
    processedAtMs: ["processed_at_ms", "n"],
    status: ["status", "s"],
    error: ["error", "s"],
    payloadSha256: ["payload_sha256", "s"],
  },
};

const TICKS: TableSpec<TickRow> = {
  name: "ticks",
  cols: {
    id: ["id", "n"],
    laneAddress: ["lane", "a"],
    atMs: ["at_ms", "n"],
    blockNumber: ["block_number", "n"],
    blockTs: ["block_ts", "n"],
    poolTick: ["pool_tick", "n"],
    sqrtPriceX96: ["sqrt_price_x96", "big"],
    poolMid: ["pool_mid", "n"],
    hlMid: ["hl_mid", "n"],
    k: ["k", "n"],
    kSource: ["k_source", "s"],
    fairValue: ["fair_value", "n"],
    gapBps: ["gap_bps", "n"],
    refTick: ["ref_tick", "n"],
    bandTicks: ["band_ticks", "n"],
    fenceCode: ["fence_code", "n"],
    regime: ["regime", "s"],
    reopenKind: ["reopen_kind", "s"],
    sessionDate: ["session_date", "s"],
    gatesMask: ["gates_mask", "n"],
    activeGatesJson: ["active_gates_json", "s"],
    riskMode: ["risk_mode", "s"],
    sourcesJson: ["sources_json", "s"],
  },
};

const OVERLAYS: TableSpec<OverlayRow> = {
  name: "overlays",
  cols: {
    overlayId: ["overlay_id", "s"],
    decisionId: ["decision_id", "s"],
    laneAddress: ["lane", "a"],
    createdAtMs: ["created_at_ms", "n"],
    source: ["source", "s"],
    proposalJson: ["proposal_json", "s"],
    criticVerdict: ["critic_verdict", "s"],
    criticReason: ["critic_reason", "s"],
    tightenOk: ["tighten_ok", "b"],
    tightenDetail: ["tighten_detail", "s"],
    applied: ["applied", "b"],
    raw: ["raw", "s"],
    error: ["error", "s"],
  },
};

const DECISIONS: TableSpec<DecisionRow> = {
  name: "decisions",
  cols: {
    decisionId: ["decision_id", "s"],
    laneAddress: ["lane", "a"],
    lane: ["lane_letter", "s"],
    createdAtMs: ["created_at_ms", "n"],
    updatedAtMs: ["updated_at_ms", "n"],
    regime: ["regime", "s"],
    regimeCode: ["regime_code", "n"],
    gatesMask: ["gates_mask", "n"],
    riskMode: ["risk_mode", "s"],
    snapshotJson: ["snapshot_json", "s"],
    planJson: ["plan_json", "s"],
    overlayId: ["overlay_id", "s"],
    finalPlanJson: ["final_plan_json", "s"],
    reasonHash: ["reason_hash", "s"],
    reasonPreimage: ["reason_preimage", "s"],
    planCriticVerdict: ["plan_critic_verdict", "s"],
    planCriticReason: ["plan_critic_reason", "s"],
    guardDecision: ["guard_decision", "s"],
    guardViolationsJson: ["guard_violations_json", "s"],
    guardChecksJson: ["guard_checks_json", "s"],
    approvalMode: ["approval_mode", "s"],
    approvalOutcome: ["approval_outcome", "s"],
    approvalChannel: ["approval_channel", "s"],
    status: ["status", "s"],
    statusDetail: ["status_detail", "s"],
  },
};

const EXECUTIONS: TableSpec<ExecutionRow> = {
  name: "executions",
  cols: {
    executionId: ["execution_id", "n"],
    decisionId: ["decision_id", "s"],
    stepIndex: ["step_index", "n"],
    onchainId: ["onchain_id", "a"],
    laneAddress: ["lane", "a"],
    venue: ["venue", "s"],
    action: ["action", "s"],
    riskClass: ["risk_class", "s"],
    notionalCents: ["notional_cents", "n"],
    signerAddress: ["signer_address", "a"],
    status: ["status", "s"],
    statusDetail: ["status_detail", "s"],
    errorCode: ["error_code", "s"],
    createdAtMs: ["created_at_ms", "n"],
    simulatedAtMs: ["simulated_at_ms", "n"],
    signedAtMs: ["signed_at_ms", "n"],
    broadcastAtMs: ["broadcast_at_ms", "n"],
    finalizedAtMs: ["finalized_at_ms", "n"],
    updatedAtMs: ["updated_at_ms", "n"],
    txHash: ["tx_hash", "a"],
    gasUsed: ["gas_used", "big"],
    feeWei: ["fee_wei", "big"],
    feeUsdCents: ["fee_usd_cents", "n"],
    resultJson: ["result_json", "s"],
  },
};

const TX_ATTEMPTS: TableSpec<TxAttemptRow> = {
  name: "tx_attempts",
  cols: {
    attemptId: ["attempt_id", "n"],
    executionId: ["execution_id", "n"],
    attempt: ["attempt", "n"],
    signerKind: ["signer_kind", "s"],
    fromAddress: ["from_address", "a"],
    toAddress: ["to_address", "a"],
    calldataHash: ["calldata_hash", "a"],
    nonce: ["nonce", "n"],
    gasLimit: ["gas_limit", "big"],
    maxFeePerGas: ["max_fee", "big"],
    maxPriorityFeePerGas: ["max_priority_fee", "big"],
    deadlineSec: ["deadline_sec", "n"],
    signedRawTx: ["signed_raw_tx", "s"],
    txHash: ["tx_hash", "a"],
    status: ["status", "s"],
    broadcastCount: ["broadcast_count", "n"],
    blockNumber: ["block_number", "n"],
    gasUsed: ["gas_used", "big"],
    feeWei: ["fee_wei", "big"],
    receiptJson: ["receipt_json", "s"],
    simJson: ["sim_json", "s"],
    createdAtMs: ["created_at_ms", "n"],
    broadcastAtMs: ["broadcast_at_ms", "n"],
    updatedAtMs: ["updated_at_ms", "n"],
  },
};

const NONCE_STATE: TableSpec<NonceStateRow> = {
  name: "nonce_state",
  cols: {
    signerAddress: ["signer_address", "a"],
    chainId: ["chain_id", "n"],
    lastNonce: ["last_nonce", "n"],
    updatedAtMs: ["updated_at_ms", "n"],
  },
};

const HL_ORDERS: TableSpec<HlOrderRow> = {
  name: "hl_orders",
  cols: {
    cloid: ["cloid", "a"],
    decisionId: ["decision_id", "s"],
    stepIndex: ["step_index", "n"],
    executionId: ["execution_id", "n"],
    laneAddress: ["lane", "a"],
    coin: ["coin", "s"],
    asset: ["asset", "n"],
    isBuy: ["is_buy", "b"],
    sz: ["sz", "s"],
    px: ["px", "s"],
    tif: ["tif", "s"],
    reduceOnly: ["reduce_only", "b"],
    mode: ["mode", "s"],
    status: ["status", "s"],
    oid: ["oid", "n"],
    filledSz: ["filled_sz", "s"],
    avgPx: ["avg_px", "s"],
    createdAtMs: ["created_at_ms", "n"],
    updatedAtMs: ["updated_at_ms", "n"],
    responseJson: ["response_json", "s"],
  },
};

const HL_FILLS: TableSpec<HlFillRow> = {
  name: "hl_fills",
  cols: {
    fillId: ["fill_id", "n"],
    cloid: ["cloid", "a"],
    tid: ["tid", "s"],
    coin: ["coin", "s"],
    px: ["px", "s"],
    sz: ["sz", "s"],
    side: ["side", "s"],
    feeUsd: ["fee_usd", "s"],
    timeMs: ["time_ms", "n"],
    paper: ["paper", "b"],
    rawJson: ["raw_json", "s"],
  },
};

const LANE_ACTIONS: TableSpec<LaneActionRow> = {
  name: "lane_actions",
  cols: {
    txHash: ["tx_hash", "a"],
    logIndex: ["log_index", "n"],
    laneAddress: ["lane", "a"],
    blockNumber: ["block_number", "n"],
    blockTs: ["block_ts", "n"],
    decisionId: ["decision_id", "a"],
    action: ["action", "n"],
    actionName: ["action_name", "s"],
    ticksJson: ["ticks_json", "s"],
    refPxE18: ["ref_px_e18", "big"],
    regime: ["regime", "n"],
    gatesMask: ["gates_mask", "n"],
    reasonHash: ["reason_hash", "a"],
    caller: ["caller", "a"],
    matchedExecutionId: ["matched_execution_id", "n"],
    matchStatus: ["match_status", "s"],
    seenAtMs: ["seen_at_ms", "n"],
    matchedAtMs: ["matched_at_ms", "n"],
  },
};

const APPROVALS: TableSpec<ApprovalRow> = {
  name: "approvals",
  cols: {
    decisionId: ["decision_id", "s"],
    laneAddress: ["lane", "a"],
    summary: ["summary", "s"],
    requestedAtMs: ["requested_at_ms", "n"],
    expiresAtMs: ["expires_at_ms", "n"],
    status: ["status", "s"],
    channel: ["channel", "s"],
    respondedAtMs: ["responded_at_ms", "n"],
    respondedBy: ["responded_by", "s"],
  },
};

const PARAM_CACHE: TableSpec<ParamCacheRow> = {
  name: "param_cache",
  cols: {
    key: ["key", "s"],
    valueJson: ["value_json", "s"],
    source: ["source", "s"],
    fetchedAtMs: ["fetched_at_ms", "n"],
    expiresAtMs: ["expires_at_ms", "n"],
  },
};

const SERVER_WALLETS: TableSpec<ServerWalletRow> = {
  name: "server_wallets",
  cols: {
    address: ["address", "a"],
    walletId: ["wallet_id", "s"],
    keySharesCt: ["key_shares_ct", "s"],
    dekWrapped: ["dek_wrapped", "s"],
    kekId: ["kek_id", "s"],
    createdAtMs: ["created_at_ms", "n"],
    updatedAtMs: ["updated_at_ms", "n"],
  },
};

const IN_FLIGHT: readonly ExecutionStatus[] = [
  "prepared",
  "simulated",
  "signed",
  "broadcast",
  "unknown",
];
const SIGNABLE: readonly ExecutionStatus[] = ["prepared", "simulated", "signed", "broadcast"];
const sqlList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(",");

// ---------------------------------------------------------------------------------------------

export type DeskDbHandle = DeskDb & {
  /** The underlying connection, for tests and one-off maintenance only. */
  readonly sqlite: Database.Database;
};

export interface OpenDbOptions {
  /** Stop migrating at this version (tests of the upgrade path). */
  migrateTo?: number;
}

export function openDb(path: string, opts: OpenDbOptions = {}): DeskDbHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // :memory: cannot WAL; journal mode is best-effort there.
  }
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, opts.migrateTo);

  const stmts = new Map<string, Database.Statement>();
  const prep = (sql: string): Database.Statement => {
    let s = stmts.get(sql);
    if (s === undefined) {
      s = db.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  };

  function fromRaw<R>(t: TableSpec<R>, raw: unknown): R {
    const r = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(t.cols) as (keyof R & string)[]) {
      const [col, kind] = t.cols[key];
      out[key] = decode(kind, r[col]);
    }
    return out as R;
  }

  function one<R>(t: TableSpec<R>, sql: string, ...params: unknown[]): R | null {
    const raw = prep(sql).get(...params);
    return raw === undefined ? null : fromRaw(t, raw);
  }

  function all<R>(t: TableSpec<R>, sql: string, ...params: unknown[]): R[] {
    return prep(sql)
      .all(...params)
      .map((raw) => fromRaw(t, raw));
  }

  function insertRow<R>(t: TableSpec<R>, row: Partial<R>, conflict = ""): Database.RunResult {
    const cols: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(t.cols) as (keyof R & string)[]) {
      const v = row[key];
      if (v === undefined) continue;
      const [col, kind] = t.cols[key];
      cols.push(col);
      params.push(encode(kind, v));
    }
    const sql = `INSERT INTO ${t.name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${conflict}`;
    return prep(sql).run(...params);
  }

  function updateRow<R>(
    t: TableSpec<R>,
    where: { col: string; value: unknown }[],
    patch: NoInfer<Partial<R>>,
    immutable: NoInfer<readonly (keyof R)[]>,
  ): number {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, v] of Object.entries(patch) as [keyof R & string, unknown][]) {
      if (v === undefined) continue;
      if (immutable.includes(key)) throw new Error(`db: ${t.name}.${key} is immutable`);
      const spec = t.cols[key];
      if (spec === undefined) throw new Error(`db: unknown ${t.name} field "${key}"`);
      sets.push(`${spec[0]} = ?`);
      params.push(encode(spec[1], v));
    }
    if (sets.length === 0) return 0;
    const clause = where.map((w) => `${w.col} = ?`).join(" AND ");
    const sql = `UPDATE ${t.name} SET ${sets.join(", ")} WHERE ${clause}`;
    return prep(sql).run(...params, ...where.map((w) => w.value)).changes;
  }

  const tx = <T>(fn: () => T): T => db.transaction(fn)();

  // -------------------------------------------------------------------------------------------

  const handle: DeskDbHandle = {
    sqlite: db,

    transaction: tx,

    schemaVersion: () => schemaVersion(db),

    // desks ---------------------------------------------------------------------------------
    insertDesk(row) {
      insertRow(DESKS, row);
    },
    getDesk(laneAddress) {
      return one(DESKS, "SELECT * FROM desks WHERE lane = ?", lower(laneAddress));
    },
    listDesks() {
      return all(DESKS, "SELECT * FROM desks ORDER BY created_at_ms");
    },
    updateDesk(laneAddress, patch) {
      updateRow(DESKS, [{ col: "lane", value: lower(laneAddress) }], patch, [
        "laneAddress",
        "createdAtMs",
      ]);
    },
    setDeskMode(laneAddress, mode, nonce, nowMs) {
      return (
        prep(
          "UPDATE desks SET mode = ?, mode_nonce = ?, updated_at_ms = ? WHERE lane = ? AND mode_nonce < ?",
        ).run(mode, nonce, nowMs, lower(laneAddress), nonce).changes > 0
      );
    },
    setDeskStatus(laneAddress, status, detail, nowMs) {
      prep("UPDATE desks SET status = ?, status_detail = ?, updated_at_ms = ? WHERE lane = ?").run(
        status,
        detail,
        nowMs,
        lower(laneAddress),
      );
    },

    // delegations ---------------------------------------------------------------------------
    upsertDelegation(row) {
      tx(() => {
        const existing = handle.getDelegation(row.walletId);
        if (existing === null) {
          insertRow(DELEGATIONS, row);
          return;
        }
        updateRow(
          DELEGATIONS,
          [{ col: "wallet_id", value: row.walletId }],
          {
            userId: row.userId,
            accountAddress: row.accountAddress,
            chain: row.chain,
            laneAddress: row.laneAddress ?? existing.laneAddress ?? undefined,
            status: row.status,
            keyShareCt: row.keyShareCt,
            apiKeyCt: row.apiKeyCt,
            dekWrapped: row.dekWrapped,
            kekId: row.kekId,
            createdEventId: row.createdEventId,
            updatedAtMs: row.updatedAtMs,
          },
          [],
        );
        // Re-activation after a revoke clears the revocation marker.
        prep(
          "UPDATE delegations SET revoked_event_id = NULL, revoked_at_ms = NULL WHERE wallet_id = ? AND status = 'active'",
        ).run(row.walletId);
      });
    },
    getDelegation(walletId) {
      return one(DELEGATIONS, "SELECT * FROM delegations WHERE wallet_id = ?", walletId);
    },
    getActiveDelegationByAddress(address) {
      return one(
        DELEGATIONS,
        "SELECT * FROM delegations WHERE account_address = ? AND status = 'active' ORDER BY updated_at_ms DESC LIMIT 1",
        lower(address),
      );
    },
    listDelegationsByUser(userId) {
      return all(
        DELEGATIONS,
        "SELECT * FROM delegations WHERE user_id = ? ORDER BY created_at_ms",
        userId,
      );
    },
    bindDelegationLane(walletId, laneAddress, nowMs) {
      prep("UPDATE delegations SET lane = ?, updated_at_ms = ? WHERE wallet_id = ?").run(
        lower(laneAddress),
        nowMs,
        walletId,
      );
    },
    revokeDelegation(walletId, revokedEventId, nowMs) {
      return (
        prep(
          `UPDATE delegations SET status = 'revoked', key_share_ct = NULL, api_key_ct = NULL, dek_wrapped = NULL,
             revoked_event_id = ?, revoked_at_ms = ?, updated_at_ms = ?
           WHERE wallet_id = ? AND status = 'active'`,
        ).run(revokedEventId, nowMs, nowMs, walletId).changes > 0
      );
    },
    recordDelegationRevocation(row) {
      insertRow(DELEGATION_REVOCATIONS, row, " ON CONFLICT(event_id) DO NOTHING");
    },
    latestDelegationRevocationAt(walletId) {
      const r = prep(
        "SELECT MAX(event_at_ms) AS at FROM delegation_revocations WHERE wallet_id = ?",
      ).get(walletId) as { at: number | null } | undefined;
      return r?.at ?? null;
    },
    purgeUnboundDelegations(beforeMs, nowMs) {
      return tx(() => {
        const stale = all(
          DELEGATIONS,
          "SELECT * FROM delegations WHERE status = 'active' AND lane IS NULL AND created_at_ms < ?",
          beforeMs,
        );
        for (const d of stale) {
          handle.revokeDelegation(d.walletId, `local-expiry:${d.walletId}:${nowMs}`, nowMs);
        }
        return stale;
      });
    },

    // webhook events ------------------------------------------------------------------------
    recordWebhookEvent(row): WebhookRecordResult {
      return tx(() => {
        const existing = handle.getWebhookEvent(row.eventId);
        if (existing === null) {
          insertRow(WEBHOOK_EVENTS, {
            ...row,
            status: "received",
            processedAtMs: null,
            error: null,
          });
          return "new";
        }
        if (existing.status === "processed" || existing.status === "ignored") return "duplicate";
        // Seen but never finished (we answered 5xx, or crashed mid-way): process it again.
        prep("UPDATE webhook_events SET status = 'received', error = NULL WHERE event_id = ?").run(
          row.eventId,
        );
        return "retry";
      });
    },
    finishWebhookEvent(eventId, status, error, nowMs) {
      prep(
        "UPDATE webhook_events SET status = ?, error = ?, processed_at_ms = ? WHERE event_id = ?",
      ).run(status, error, nowMs, eventId);
    },
    getWebhookEvent(eventId) {
      return one(WEBHOOK_EVENTS, "SELECT * FROM webhook_events WHERE event_id = ?", eventId);
    },

    // ticks ---------------------------------------------------------------------------------
    insertTick(row) {
      return Number(insertRow(TICKS, row).lastInsertRowid);
    },
    lastTick(laneAddress) {
      return one(
        TICKS,
        "SELECT * FROM ticks WHERE lane = ? ORDER BY at_ms DESC, id DESC LIMIT 1",
        lower(laneAddress),
      );
    },
    sessionTickSamples(
      laneAddress,
      sessionDate,
      regime: RegimeName = "REGULAR",
    ): SessionTickSample[] {
      return (
        prep(
          `SELECT at_ms, pool_mid, hl_mid FROM ticks
           WHERE lane = ? AND session_date = ? AND regime = ? AND pool_mid IS NOT NULL AND hl_mid IS NOT NULL
           ORDER BY at_ms`,
        ).all(lower(laneAddress), sessionDate, regime) as {
          at_ms: number;
          pool_mid: number;
          hl_mid: number;
        }[]
      ).map((r) => ({ atMs: r.at_ms, poolMid: r.pool_mid, hlMid: r.hl_mid }));
    },
    pruneTicks(beforeMs) {
      return prep("DELETE FROM ticks WHERE at_ms < ?").run(beforeMs).changes;
    },

    // overlays ------------------------------------------------------------------------------
    insertOverlay(row) {
      insertRow(OVERLAYS, row);
    },
    getOverlay(overlayId) {
      return one(OVERLAYS, "SELECT * FROM overlays WHERE overlay_id = ?", overlayId);
    },

    // decisions -----------------------------------------------------------------------------
    insertDecision(row) {
      insertRow(DECISIONS, row);
    },
    updateDecision(decisionId, patch) {
      updateRow(DECISIONS, [{ col: "decision_id", value: decisionId }], patch, [
        "decisionId",
        "createdAtMs",
      ]);
    },
    getDecision(decisionId) {
      return one(DECISIONS, "SELECT * FROM decisions WHERE decision_id = ?", decisionId);
    },
    decisionsByStatus(statuses) {
      if (statuses.length === 0) return [];
      return all(
        DECISIONS,
        `SELECT * FROM decisions WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at_ms, decision_id`,
        ...statuses,
      );
    },
    recentDecisions(n, laneAddress) {
      return laneAddress === undefined
        ? all(
            DECISIONS,
            "SELECT * FROM decisions ORDER BY created_at_ms DESC, decision_id DESC LIMIT ?",
            n,
          )
        : all(
            DECISIONS,
            "SELECT * FROM decisions WHERE lane = ? ORDER BY created_at_ms DESC, decision_id DESC LIMIT ?",
            lower(laneAddress),
            n,
          );
    },
    reconcileOrphanedDecisions(nowMs) {
      return tx(() => {
        let changed = 0;
        const stuck = prep(
          "SELECT decision_id FROM decisions WHERE status = 'executing'",
        ).all() as {
          decision_id: string;
        }[];
        for (const { decision_id } of stuck) {
          const execs = handle.executionsForDecision(decision_id);
          if (execs.some((e) => IN_FLIGHT.includes(e.status))) continue; // the reconciler resolves these
          const confirmed = execs.filter((e) => e.status === "confirmed").length;
          const status =
            execs.length === 0
              ? "failed"
              : confirmed === execs.length
                ? "executed"
                : confirmed > 0
                  ? "partially_executed"
                  : "failed";
          handle.updateDecision(decision_id, {
            status,
            statusDetail: "reconciled at startup from execution rows",
            updatedAtMs: nowMs,
          });
          changed += 1;
        }
        return changed;
      });
    },

    // executions ----------------------------------------------------------------------------
    insertExecution(row: NewExecution) {
      if (row.status !== "prepared") {
        throw new Error(`db: executions are written ahead as 'prepared', got '${row.status}'`);
      }
      return Number(insertRow(EXECUTIONS, row as Partial<ExecutionRow>).lastInsertRowid);
    },
    getExecution(executionId) {
      return one(EXECUTIONS, "SELECT * FROM executions WHERE execution_id = ?", executionId);
    },
    getExecutionByStep(decisionId, stepIndex) {
      return one(
        EXECUTIONS,
        "SELECT * FROM executions WHERE decision_id = ? AND step_index = ?",
        decisionId,
        stepIndex,
      );
    },
    getExecutionByOnchainId(onchainId) {
      return one(EXECUTIONS, "SELECT * FROM executions WHERE onchain_id = ?", lower(onchainId));
    },
    hasExecutionStep(decisionId, stepIndex) {
      return (
        prep("SELECT 1 FROM executions WHERE decision_id = ? AND step_index = ? LIMIT 1").get(
          decisionId,
          stepIndex,
        ) !== undefined
      );
    },
    executionsForDecision(decisionId) {
      return all(
        EXECUTIONS,
        "SELECT * FROM executions WHERE decision_id = ? ORDER BY step_index",
        decisionId,
      );
    },
    executionsByStatus(statuses) {
      if (statuses.length === 0) return [];
      return all(
        EXECUTIONS,
        `SELECT * FROM executions WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY execution_id`,
        ...statuses,
      );
    },
    updateExecution(executionId, patch) {
      updateRow(EXECUTIONS, [{ col: "execution_id", value: executionId }], patch, [
        "executionId",
        "decisionId",
        "stepIndex",
        "createdAtMs",
      ]);
    },
    failUnsignedExecutions(detail, nowMs) {
      return prep(
        `UPDATE executions SET status = 'failed', status_detail = ?, finalized_at_ms = ?, updated_at_ms = ?
         WHERE status IN ('prepared','simulated') AND signed_at_ms IS NULL`,
      ).run(detail, nowMs, nowMs).changes;
    },
    turnoverCentsSince(laneAddress, sinceMs) {
      const r = prep(
        `SELECT COALESCE(SUM(notional_cents), 0) AS total FROM executions
         WHERE lane = ? AND risk_class = 'adding' AND signed_at_ms IS NOT NULL AND signed_at_ms >= ?`,
      ).get(lower(laneAddress), sinceMs) as { total: number };
      return r.total;
    },
    countSignedAddingReranges(laneAddress, sinceMs) {
      const r = prep(
        `SELECT COUNT(*) AS n FROM executions
         WHERE lane = ? AND action = 'rerange' AND risk_class = 'adding' AND signed_at_ms IS NOT NULL AND signed_at_ms >= ?`,
      ).get(lower(laneAddress), sinceMs) as { n: number };
      return r.n;
    },
    lastSignedAddingRerangeAt(laneAddress) {
      const r = prep(
        `SELECT MAX(signed_at_ms) AS latest FROM executions
         WHERE lane = ? AND action = 'rerange' AND risk_class = 'adding' AND signed_at_ms IS NOT NULL`,
      ).get(lower(laneAddress)) as { latest: number | null };
      return r.latest;
    },
    inFlightCount(signerAddress) {
      const r = prep(
        `SELECT COUNT(*) AS n FROM executions WHERE signer_address = ? AND status IN (${sqlList(IN_FLIGHT)})`,
      ).get(lower(signerAddress)) as { n: number };
      return r.n;
    },
    recentExecutions(n, laneAddress) {
      return laneAddress === undefined
        ? all(EXECUTIONS, "SELECT * FROM executions ORDER BY execution_id DESC LIMIT ?", n)
        : all(
            EXECUTIONS,
            "SELECT * FROM executions WHERE lane = ? ORDER BY execution_id DESC LIMIT ?",
            lower(laneAddress),
            n,
          );
    },
    pendingExecutionsCount() {
      const r = prep(
        `SELECT COUNT(*) AS n FROM executions WHERE status IN (${sqlList(IN_FLIGHT)})`,
      ).get() as {
        n: number;
      };
      return r.n;
    },

    // tx attempts ---------------------------------------------------------------------------
    recordSignedAttempt(attempt: NewTxAttempt, nowMs) {
      return tx(() => {
        const exec = handle.getExecution(attempt.executionId);
        if (exec === null)
          throw new Error(`db: no execution ${attempt.executionId} for a signed attempt`);
        if (!SIGNABLE.includes(exec.status)) {
          throw new Error(
            `db: execution ${exec.executionId} is '${exec.status}'; refusing to record a new signature`,
          );
        }
        if (exec.signerAddress !== null && exec.signerAddress !== lower(attempt.fromAddress)) {
          throw new Error(
            `db: attempt signer ${attempt.fromAddress} differs from execution signer ${exec.signerAddress}`,
          );
        }
        const id = Number(
          insertRow(TX_ATTEMPTS, {
            ...attempt,
            status: "signed",
            broadcastCount: 0,
            updatedAtMs: nowMs,
          }).lastInsertRowid,
        );
        prep(
          `UPDATE executions SET status = 'signed', signed_at_ms = COALESCE(signed_at_ms, ?), tx_hash = ?,
             signer_address = COALESCE(signer_address, ?), updated_at_ms = ?
           WHERE execution_id = ?`,
        ).run(nowMs, lower(attempt.txHash), lower(attempt.fromAddress), nowMs, attempt.executionId);
        return id;
      });
    },
    getAttemptByHash(txHash) {
      return one(TX_ATTEMPTS, "SELECT * FROM tx_attempts WHERE tx_hash = ?", lower(txHash));
    },
    attemptsForExecution(executionId) {
      return all(
        TX_ATTEMPTS,
        "SELECT * FROM tx_attempts WHERE execution_id = ? ORDER BY attempt",
        executionId,
      );
    },
    latestAttempt(executionId) {
      return one(
        TX_ATTEMPTS,
        "SELECT * FROM tx_attempts WHERE execution_id = ? ORDER BY attempt DESC LIMIT 1",
        executionId,
      );
    },
    unresolvedAttempts() {
      return all(
        TX_ATTEMPTS,
        "SELECT * FROM tx_attempts WHERE status IN ('signed','broadcast','unknown') ORDER BY attempt_id",
      );
    },
    updateTxAttempt(txHash, patch) {
      updateRow(TX_ATTEMPTS, [{ col: "tx_hash", value: lower(txHash) }], patch, [
        "attemptId",
        "executionId",
        "attempt",
        "signedRawTx",
        "txHash",
        "nonce",
        "createdAtMs",
      ]);
    },
    markAttemptBroadcast(txHash, nowMs) {
      tx(() => {
        const a = handle.getAttemptByHash(txHash);
        if (a === null) throw new Error(`db: no attempt ${txHash} to mark broadcast`);
        prep(
          `UPDATE tx_attempts SET status = CASE WHEN status IN ('signed','unknown') THEN 'broadcast' ELSE status END,
             broadcast_count = broadcast_count + 1, broadcast_at_ms = COALESCE(broadcast_at_ms, ?), updated_at_ms = ?
           WHERE tx_hash = ?`,
        ).run(nowMs, nowMs, lower(txHash));
        prep(
          `UPDATE executions SET status = 'broadcast', broadcast_at_ms = COALESCE(broadcast_at_ms, ?), updated_at_ms = ?
           WHERE execution_id = ? AND status IN ('signed','unknown')`,
        ).run(nowMs, nowMs, a.executionId);
      });
    },

    // nonces --------------------------------------------------------------------------------
    getNonceState(signerAddress) {
      return one(
        NONCE_STATE,
        "SELECT * FROM nonce_state WHERE signer_address = ?",
        lower(signerAddress),
      );
    },
    advanceNonce(signerAddress, chainId, nonce, nowMs) {
      return tx(() => {
        prep(
          `INSERT INTO nonce_state (signer_address, chain_id, last_nonce, updated_at_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT(signer_address) DO UPDATE SET last_nonce = MAX(last_nonce, excluded.last_nonce),
             chain_id = excluded.chain_id, updated_at_ms = excluded.updated_at_ms`,
        ).run(lower(signerAddress), chainId, nonce, nowMs);
        return (handle.getNonceState(signerAddress) as NonceStateRow).lastNonce;
      });
    },
    resetNonce(signerAddress, chainId, nonce, nowMs) {
      prep(
        `INSERT INTO nonce_state (signer_address, chain_id, last_nonce, updated_at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(signer_address) DO UPDATE SET last_nonce = excluded.last_nonce,
           chain_id = excluded.chain_id, updated_at_ms = excluded.updated_at_ms`,
      ).run(lower(signerAddress), chainId, nonce, nowMs);
    },

    // hyperliquid ---------------------------------------------------------------------------
    insertHlOrder(row) {
      insertRow(HL_ORDERS, row);
    },
    updateHlOrder(cloid, patch) {
      updateRow(HL_ORDERS, [{ col: "cloid", value: lower(cloid) }], patch, [
        "cloid",
        "createdAtMs",
      ]);
    },
    getHlOrder(cloid) {
      return one(HL_ORDERS, "SELECT * FROM hl_orders WHERE cloid = ?", lower(cloid));
    },
    openHlOrders(mode) {
      return all(
        HL_ORDERS,
        "SELECT * FROM hl_orders WHERE mode = ? AND status IN ('open','partially_filled') ORDER BY created_at_ms",
        mode,
      );
    },
    insertHlFill(row) {
      return (
        insertRow(HL_FILLS, row as Partial<HlFillRow>, " ON CONFLICT(cloid, tid) DO NOTHING")
          .changes > 0
      );
    },
    hlFillsByCoin(coin, paper) {
      return all(
        HL_FILLS,
        "SELECT * FROM hl_fills WHERE coin = ? AND paper = ? ORDER BY time_ms, fill_id",
        coin,
        paper ? 1 : 0,
      );
    },
    hlFillsForOrder(cloid) {
      return all(
        HL_FILLS,
        "SELECT * FROM hl_fills WHERE cloid = ? ORDER BY time_ms, fill_id",
        lower(cloid),
      );
    },

    // lane actions --------------------------------------------------------------------------
    insertLaneAction(row) {
      return (
        insertRow(LANE_ACTIONS, row, " ON CONFLICT(tx_hash, log_index) DO NOTHING").changes > 0
      );
    },
    setLaneActionMatch(txHash, logIndex, match, executionId, nowMs) {
      prep(
        `UPDATE lane_actions SET match_status = ?, matched_execution_id = ?,
           matched_at_ms = CASE WHEN ? = 'matched' THEN ? ELSE matched_at_ms END
         WHERE tx_hash = ? AND log_index = ?`,
      ).run(match, executionId, match, nowMs, lower(txHash), logIndex);
    },
    laneActionsByMatch(match, laneAddress) {
      return laneAddress === undefined
        ? all(
            LANE_ACTIONS,
            "SELECT * FROM lane_actions WHERE match_status = ? ORDER BY block_number, log_index",
            match,
          )
        : all(
            LANE_ACTIONS,
            "SELECT * FROM lane_actions WHERE match_status = ? AND lane = ? ORDER BY block_number, log_index",
            match,
            lower(laneAddress),
          );
    },
    recentLaneActions(laneAddress, n) {
      return all(
        LANE_ACTIONS,
        "SELECT * FROM lane_actions WHERE lane = ? ORDER BY block_number DESC, log_index DESC LIMIT ?",
        lower(laneAddress),
        n,
      );
    },

    // approvals -----------------------------------------------------------------------------
    createApproval(row) {
      insertRow(
        APPROVALS,
        { ...row, status: "pending", channel: null, respondedAtMs: null, respondedBy: null },
        " ON CONFLICT(decision_id) DO NOTHING",
      );
    },
    getApproval(decisionId) {
      return one(APPROVALS, "SELECT * FROM approvals WHERE decision_id = ?", decisionId);
    },
    respondApproval(decisionId, approved, channel, respondedBy, nowMs) {
      return (
        prep(
          `UPDATE approvals SET status = ?, channel = ?, responded_at_ms = ?, responded_by = ?
           WHERE decision_id = ? AND status = 'pending' AND expires_at_ms > ?`,
        ).run(approved ? "approved" : "denied", channel, nowMs, respondedBy, decisionId, nowMs)
          .changes > 0
      );
    },
    closeApproval(decisionId, status, nowMs) {
      prep(
        "UPDATE approvals SET status = ?, responded_at_ms = ? WHERE decision_id = ? AND status = 'pending'",
      ).run(status, nowMs, decisionId);
      return handle.getApproval(decisionId);
    },
    pendingApprovals(laneAddress, nowMs) {
      return all(
        APPROVALS,
        "SELECT * FROM approvals WHERE lane = ? AND status = 'pending' AND expires_at_ms > ? ORDER BY requested_at_ms",
        lower(laneAddress),
        nowMs,
      );
    },

    // param cache, cursors, cooldowns -------------------------------------------------------
    getParam(key) {
      return one(PARAM_CACHE, "SELECT * FROM param_cache WHERE key = ?", key);
    },
    setParam(key, valueJson, o) {
      prep(
        `INSERT INTO param_cache (key, value_json, source, fetched_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, source = excluded.source,
           fetched_at_ms = excluded.fetched_at_ms, expires_at_ms = excluded.expires_at_ms`,
      ).run(key, valueJson, o.source, o.fetchedAtMs, o.fetchedAtMs + o.ttlMs);
    },
    getCursor(name) {
      const r = prep("SELECT block_number FROM sync_cursors WHERE name = ?").get(name) as
        | { block_number: number }
        | undefined;
      return r?.block_number ?? null;
    },
    setCursor(name, blockNumber, nowMs) {
      prep(
        `INSERT INTO sync_cursors (name, block_number, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET block_number = MAX(block_number, excluded.block_number),
           updated_at_ms = excluded.updated_at_ms`,
      ).run(name, blockNumber, nowMs);
    },
    recordCooldownAnchor(laneAddress, atMs) {
      prep(
        `INSERT INTO cooldown_anchors (lane, anchored_ms) VALUES (?, ?)
         ON CONFLICT(lane) DO UPDATE SET anchored_ms = MAX(anchored_ms, excluded.anchored_ms)`,
      ).run(lower(laneAddress), atMs);
    },
    lastCooldownAnchor(laneAddress) {
      const r = prep("SELECT anchored_ms FROM cooldown_anchors WHERE lane = ?").get(
        lower(laneAddress),
      ) as { anchored_ms: number } | undefined;
      return r?.anchored_ms ?? null;
    },

    // server wallets ------------------------------------------------------------------------
    upsertServerWallet(row) {
      insertRow(
        SERVER_WALLETS,
        row,
        ` ON CONFLICT(address) DO UPDATE SET wallet_id = excluded.wallet_id, key_shares_ct = excluded.key_shares_ct,
            dek_wrapped = excluded.dek_wrapped, kek_id = excluded.kek_id, updated_at_ms = excluded.updated_at_ms`,
      );
    },
    getServerWallet(address) {
      return one(SERVER_WALLETS, "SELECT * FROM server_wallets WHERE address = ?", lower(address));
    },

    // single-instance lock ------------------------------------------------------------------
    acquireDaemonLock(owner, nowMs, staleMs): LockAcquisition {
      return tx(() => {
        const row = prep("SELECT owner_id, heartbeat_ms FROM daemon_lock WHERE id = 1").get() as
          | { owner_id: string; heartbeat_ms: number }
          | undefined;
        if (row === undefined) {
          prep(
            "INSERT INTO daemon_lock (id, owner_id, pid, host, acquired_at_ms, heartbeat_ms) VALUES (1, ?, ?, ?, ?, ?)",
          ).run(owner.ownerId, owner.pid, owner.host, nowMs, nowMs);
          return { acquired: true };
        }
        if (row.owner_id === owner.ownerId) {
          prep("UPDATE daemon_lock SET heartbeat_ms = ? WHERE id = 1").run(nowMs);
          return { acquired: true };
        }
        const heartbeatAgeMs = nowMs - row.heartbeat_ms;
        if (heartbeatAgeMs > staleMs) {
          prep(
            "UPDATE daemon_lock SET owner_id = ?, pid = ?, host = ?, acquired_at_ms = ?, heartbeat_ms = ? WHERE id = 1",
          ).run(owner.ownerId, owner.pid, owner.host, nowMs, nowMs);
          return { acquired: true, tookOverStaleOwner: row.owner_id };
        }
        return { acquired: false, holderOwner: row.owner_id, heartbeatAgeMs };
      });
    },
    refreshDaemonLock(ownerId, nowMs) {
      return (
        prep("UPDATE daemon_lock SET heartbeat_ms = ? WHERE id = 1 AND owner_id = ?").run(
          nowMs,
          ownerId,
        ).changes > 0
      );
    },
    releaseDaemonLock(ownerId) {
      prep("DELETE FROM daemon_lock WHERE id = 1 AND owner_id = ?").run(ownerId);
    },
    lockStatus(): LockStatus | null {
      const r = prep(
        "SELECT owner_id, pid, host, acquired_at_ms, heartbeat_ms FROM daemon_lock WHERE id = 1",
      ).get() as
        | {
            owner_id: string;
            pid: number;
            host: string;
            acquired_at_ms: number;
            heartbeat_ms: number;
          }
        | undefined;
      return r === undefined
        ? null
        : {
            ownerId: r.owner_id,
            pid: r.pid,
            host: r.host,
            acquiredAtMs: r.acquired_at_ms,
            heartbeatMs: r.heartbeat_ms,
          };
    },

    close() {
      db.close();
    },
  };
  return handle;
}

/** A process-unique lock owner id (containers restart with the same pid, so pid alone is not enough). */
export function lockOwner(pid: number = process.pid): {
  ownerId: string;
  pid: number;
  host: string;
} {
  const host = hostname();
  const nonce = Math.random().toString(36).slice(2, 10);
  return { ownerId: `${host}:${pid}:${nonce}`, pid, host };
}

/** Normalise an address or hash for comparison with stored values. */
export function normaliseHex<T extends Address | Hex>(v: T): T {
  return v.toLowerCase() as T;
}
