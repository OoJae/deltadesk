/**
 * Schema migrations, applied in order inside one transaction each; PRAGMA user_version records the
 * applied version. A database written by NEWER code (user_version above LATEST) is refused rather
 * than silently misread.
 *
 * v1: the Ripcord core, ported to the desk domain (decisions, executions, daemon lock, cooldown
 *     anchors, ticks, param cache, sync cursors).
 * v2: the desk: desks, delegations, webhook events, overlays, tx attempts, nonces, HL orders and
 *     fills, lane actions, approvals, server wallets, plus the write-ahead triggers.
 * v3: delegation_revocations: a Dynamic revoke recorded per event (even for a wallet we never
 *     stored), so a delegation event that is not newer can never (re)activate the wallet.
 *
 * CHECK constraints mirror the TypeScript unions in src/types.ts, so a status, action or risk class
 * outside the contract cannot be stored at all (an executions.action of 'withdraw' is rejected here
 * too, not only by the type system).
 */

import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Addresses are stored as 0x + 40 LOWERCASE hex chars; anything else is rejected. */
const isAddress = (col: string) =>
  `(length(${col}) = 42 AND substr(${col}, 1, 2) = '0x' AND NOT substr(${col}, 3) GLOB '*[^0-9a-f]*')`;
const ADDRESS = (col: string) => `CHECK ${isAddress(col)}`;
const OPT_ADDRESS = (col: string) => `CHECK (${col} IS NULL OR ${isAddress(col)})`;

const V1 = `
CREATE TABLE decisions (
  decision_id           TEXT PRIMARY KEY CHECK (length(decision_id) = 26),
  lane                  TEXT NOT NULL ${ADDRESS("lane")},
  lane_letter           TEXT NOT NULL CHECK (lane_letter IN ('A','B','C')),
  created_at_ms         INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL,
  regime                TEXT NOT NULL CHECK (regime IN ('REGULAR','EXTENDED','OVERNIGHT','WEEKEND_DARK','HOLIDAY')),
  regime_code           INTEGER NOT NULL CHECK (regime_code BETWEEN 0 AND 255),
  gates_mask            INTEGER NOT NULL CHECK (gates_mask BETWEEN 0 AND 65535),
  risk_mode             TEXT NOT NULL CHECK (risk_mode IN ('normal','reduce_only','flat')),
  snapshot_json         TEXT NOT NULL,
  plan_json             TEXT NOT NULL,
  overlay_id            TEXT,
  final_plan_json       TEXT,
  reason_hash           TEXT CHECK (reason_hash IS NULL OR length(reason_hash) = 66),
  reason_preimage       TEXT,
  plan_critic_verdict   TEXT CHECK (plan_critic_verdict IN ('APPROVE','REJECT')),
  plan_critic_reason    TEXT,
  guard_decision        TEXT CHECK (guard_decision IN ('execute','dry-run','blocked')),
  guard_violations_json TEXT,
  guard_checks_json     TEXT,
  approval_mode         TEXT CHECK (approval_mode IN ('advisory','copilot','autopilot')),
  approval_outcome      TEXT CHECK (approval_outcome IN ('approved','denied','timeout','cancelled','not_required','advisory')),
  approval_channel      TEXT CHECK (approval_channel IN ('web','telegram','file')),
  status                TEXT NOT NULL CHECK (status IN (
    'observed','critic_rejected','blocked','dry_run','advisory','declined','policy_denied',
    'executing','executed','partially_executed','failed')),
  status_detail         TEXT
);
CREATE INDEX idx_decisions_lane_created ON decisions (lane, created_at_ms DESC);
CREATE INDEX idx_decisions_status ON decisions (status);

CREATE TABLE executions (
  execution_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id     TEXT NOT NULL REFERENCES decisions(decision_id),
  step_index      INTEGER NOT NULL CHECK (step_index BETWEEN 0 AND 255),
  onchain_id      TEXT UNIQUE CHECK (onchain_id IS NULL OR length(onchain_id) = 66),
  lane            TEXT NOT NULL ${ADDRESS("lane")},
  venue           TEXT NOT NULL CHECK (venue IN ('rh','hl')),
  action          TEXT NOT NULL CHECK (action IN ('rerange','reduce','collect','exitAll','pause','signal','hedge')),
  risk_class      TEXT NOT NULL CHECK (risk_class IN ('adding','reducing','neutral')),
  notional_cents  INTEGER NOT NULL CHECK (notional_cents >= 0),
  signer_address  TEXT ${OPT_ADDRESS("signer_address")},
  status          TEXT NOT NULL CHECK (status IN (
    'prepared','simulated','signed','broadcast','confirmed','reverted','failed','declined','dropped','unknown')),
  status_detail   TEXT,
  error_code      TEXT,
  created_at_ms   INTEGER NOT NULL,
  simulated_at_ms INTEGER,
  signed_at_ms    INTEGER,
  broadcast_at_ms INTEGER,
  finalized_at_ms INTEGER,
  updated_at_ms   INTEGER NOT NULL,
  tx_hash         TEXT,
  gas_used        TEXT,
  fee_wei         TEXT,
  fee_usd_cents   INTEGER,
  result_json     TEXT,
  UNIQUE (decision_id, step_index),
  CHECK (venue != 'rh' OR onchain_id IS NOT NULL)
);
CREATE INDEX idx_executions_lane_signed ON executions (lane, signed_at_ms);
CREATE INDEX idx_executions_status ON executions (status);
CREATE INDEX idx_executions_signer_status ON executions (signer_address, status);

-- Single-instance advisory lock. Two daemons on one database each mint their own decision ids, so
-- idempotency cannot see across them: exactly one may hold this. owner_id (not pid) identifies the
-- holder: containers restart with the same pid.
CREATE TABLE daemon_lock (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id       TEXT NOT NULL,
  pid            INTEGER NOT NULL,
  host           TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_ms   INTEGER NOT NULL
);

-- A human veto (copilot denial, autopilot cancel) anchors a per-lane cooldown that survives restarts.
CREATE TABLE cooldown_anchors (
  lane        TEXT PRIMARY KEY ${ADDRESS("lane")},
  anchored_ms INTEGER NOT NULL
);

CREATE TABLE ticks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lane              TEXT NOT NULL ${ADDRESS("lane")},
  at_ms             INTEGER NOT NULL,
  block_number      INTEGER,
  block_ts          INTEGER,
  pool_tick         INTEGER,
  sqrt_price_x96    TEXT,
  pool_mid          REAL,
  hl_mid            REAL,
  k                 REAL,
  k_source          TEXT,
  fair_value        REAL,
  gap_bps           REAL,
  ref_tick          INTEGER,
  band_ticks        INTEGER,
  fence_code        INTEGER,
  regime            TEXT NOT NULL CHECK (regime IN ('REGULAR','EXTENDED','OVERNIGHT','WEEKEND_DARK','HOLIDAY')),
  reopen_kind       TEXT CHECK (reopen_kind IN ('weekday_open','wake')),
  session_date      TEXT NOT NULL,
  gates_mask        INTEGER NOT NULL,
  active_gates_json TEXT NOT NULL,
  risk_mode         TEXT NOT NULL CHECK (risk_mode IN ('normal','reduce_only','flat')),
  sources_json      TEXT NOT NULL
);
CREATE INDEX idx_ticks_lane_at ON ticks (lane, at_ms DESC);
CREATE INDEX idx_ticks_session ON ticks (lane, session_date, regime);

CREATE TABLE param_cache (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL,
  source        TEXT,
  fetched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE sync_cursors (
  name          TEXT PRIMARY KEY,
  block_number  INTEGER NOT NULL CHECK (block_number >= 0),
  updated_at_ms INTEGER NOT NULL
);
`;

const V2 = `
CREATE TABLE desks (
  lane          TEXT PRIMARY KEY ${ADDRESS("lane")},
  chain_id      INTEGER NOT NULL DEFAULT 4663,
  lane_id       INTEGER NOT NULL CHECK (lane_id BETWEEN 0 AND 2),
  owner         TEXT NOT NULL ${ADDRESS("owner")},
  operator      TEXT NOT NULL ${ADDRESS("operator")},
  owner_user_id TEXT,
  signer_kind   TEXT NOT NULL CHECK (signer_kind IN ('local','dynamic-delegated','dynamic-server')),
  mode          TEXT NOT NULL DEFAULT 'advisory' CHECK (mode IN ('advisory','copilot','autopilot')),
  mode_nonce    INTEGER NOT NULL DEFAULT 0 CHECK (mode_nonce >= 0),
  status        TEXT NOT NULL CHECK (status IN ('registered','active','safe_mode','revoked','disabled')),
  status_detail TEXT,
  caps_json     TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (owner != operator)
);

CREATE TABLE delegations (
  wallet_id        TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  account_address  TEXT NOT NULL ${ADDRESS("account_address")},
  chain            TEXT NOT NULL DEFAULT 'EVM',
  lane             TEXT ${OPT_ADDRESS("lane")},
  status           TEXT NOT NULL CHECK (status IN ('active','revoked')),
  key_share_ct     TEXT,
  api_key_ct       TEXT,
  dek_wrapped      TEXT,
  kek_id           TEXT,
  created_event_id TEXT NOT NULL UNIQUE,
  revoked_event_id TEXT UNIQUE,
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL,
  revoked_at_ms    INTEGER,
  CHECK (status != 'active' OR (key_share_ct IS NOT NULL AND api_key_ct IS NOT NULL
                                AND dek_wrapped IS NOT NULL AND kek_id IS NOT NULL)),
  CHECK (status != 'revoked' OR (key_share_ct IS NULL AND api_key_ct IS NULL AND dek_wrapped IS NULL))
);
CREATE INDEX idx_delegations_address ON delegations (account_address, status);
CREATE INDEX idx_delegations_user ON delegations (user_id);

CREATE TABLE webhook_events (
  event_id        TEXT PRIMARY KEY,
  event_name      TEXT NOT NULL,
  received_at_ms  INTEGER NOT NULL,
  processed_at_ms INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('received','processed','ignored','failed')),
  error           TEXT,
  payload_sha256  TEXT NOT NULL
);

CREATE TABLE overlays (
  overlay_id     TEXT PRIMARY KEY,
  decision_id    TEXT,
  lane           TEXT NOT NULL ${ADDRESS("lane")},
  created_at_ms  INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('identity','llm')),
  proposal_json  TEXT,
  critic_verdict TEXT CHECK (critic_verdict IN ('APPROVE','REJECT')),
  critic_reason  TEXT,
  tighten_ok     INTEGER NOT NULL CHECK (tighten_ok IN (0,1)),
  tighten_detail TEXT,
  applied        INTEGER NOT NULL CHECK (applied IN (0,1)),
  raw            TEXT,
  error          TEXT,
  CHECK (applied = 0 OR tighten_ok = 1)
);

CREATE TABLE tx_attempts (
  attempt_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id     INTEGER NOT NULL REFERENCES executions(execution_id),
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  signer_kind      TEXT NOT NULL CHECK (signer_kind IN ('local','dynamic-delegated','dynamic-server')),
  from_address     TEXT NOT NULL ${ADDRESS("from_address")},
  to_address       TEXT NOT NULL ${ADDRESS("to_address")},
  calldata_hash    TEXT NOT NULL,
  nonce            INTEGER NOT NULL CHECK (nonce >= 0),
  gas_limit        TEXT NOT NULL,
  max_fee          TEXT NOT NULL,
  max_priority_fee TEXT NOT NULL,
  deadline_sec     INTEGER NOT NULL,
  signed_raw_tx    TEXT NOT NULL,
  tx_hash          TEXT NOT NULL UNIQUE CHECK (length(tx_hash) = 66),
  status           TEXT NOT NULL CHECK (status IN ('signed','broadcast','confirmed','reverted','dropped','replaced','unknown')),
  broadcast_count  INTEGER NOT NULL DEFAULT 0,
  block_number     INTEGER,
  gas_used         TEXT,
  fee_wei          TEXT,
  receipt_json     TEXT,
  sim_json         TEXT,
  created_at_ms    INTEGER NOT NULL,
  broadcast_at_ms  INTEGER,
  updated_at_ms    INTEGER NOT NULL,
  UNIQUE (execution_id, attempt)
);
CREATE INDEX idx_tx_attempts_status ON tx_attempts (status);

CREATE TABLE nonce_state (
  signer_address TEXT PRIMARY KEY ${ADDRESS("signer_address")},
  chain_id       INTEGER NOT NULL,
  last_nonce     INTEGER NOT NULL CHECK (last_nonce >= -1),
  updated_at_ms  INTEGER NOT NULL
);

CREATE TABLE hl_orders (
  cloid         TEXT PRIMARY KEY,
  decision_id   TEXT,
  step_index    INTEGER,
  execution_id  INTEGER REFERENCES executions(execution_id),
  lane          TEXT ${OPT_ADDRESS("lane")},
  coin          TEXT NOT NULL,
  asset         INTEGER NOT NULL,
  is_buy        INTEGER NOT NULL CHECK (is_buy IN (0,1)),
  sz            TEXT NOT NULL,
  px            TEXT NOT NULL,
  tif           TEXT NOT NULL CHECK (tif IN ('Alo','Ioc')),
  reduce_only   INTEGER NOT NULL CHECK (reduce_only IN (0,1)),
  mode          TEXT NOT NULL CHECK (mode IN ('paper','live')),
  status        TEXT NOT NULL CHECK (status IN ('open','filled','partially_filled','canceled','rejected')),
  oid           INTEGER,
  filled_sz     TEXT NOT NULL DEFAULT '0',
  avg_px        TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  response_json TEXT
);
CREATE INDEX idx_hl_orders_mode_status ON hl_orders (mode, status);

CREATE TABLE hl_fills (
  fill_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  cloid    TEXT NOT NULL REFERENCES hl_orders(cloid),
  tid      TEXT NOT NULL,
  coin     TEXT NOT NULL,
  px       TEXT NOT NULL,
  sz       TEXT NOT NULL,
  side     TEXT NOT NULL CHECK (side IN ('B','A')),
  fee_usd  TEXT,
  time_ms  INTEGER NOT NULL,
  paper    INTEGER NOT NULL CHECK (paper IN (0,1)),
  raw_json TEXT,
  UNIQUE (cloid, tid)
);

CREATE TABLE lane_actions (
  tx_hash              TEXT NOT NULL,
  log_index            INTEGER NOT NULL,
  lane                 TEXT NOT NULL ${ADDRESS("lane")},
  block_number         INTEGER NOT NULL,
  block_ts             INTEGER,
  decision_id          TEXT NOT NULL,
  action               INTEGER NOT NULL,
  action_name          TEXT NOT NULL,
  ticks_json           TEXT NOT NULL,
  ref_px_e18           TEXT NOT NULL,
  regime               INTEGER NOT NULL,
  gates_mask           INTEGER NOT NULL,
  reason_hash          TEXT NOT NULL,
  caller               TEXT NOT NULL ${ADDRESS("caller")},
  matched_execution_id INTEGER REFERENCES executions(execution_id),
  match_status         TEXT NOT NULL CHECK (match_status IN ('matched','foreign','pending')),
  seen_at_ms           INTEGER NOT NULL,
  matched_at_ms        INTEGER,
  PRIMARY KEY (tx_hash, log_index),
  CHECK (match_status != 'matched' OR matched_execution_id IS NOT NULL)
);
CREATE INDEX idx_lane_actions_match ON lane_actions (match_status, lane);

CREATE TABLE approvals (
  decision_id     TEXT PRIMARY KEY,
  lane            TEXT NOT NULL ${ADDRESS("lane")},
  summary         TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  expires_at_ms   INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','cancelled')),
  channel         TEXT CHECK (channel IN ('web','telegram','file')),
  responded_at_ms INTEGER,
  responded_by    TEXT
);
CREATE INDEX idx_approvals_lane_status ON approvals (lane, status);

CREATE TABLE server_wallets (
  address        TEXT PRIMARY KEY ${ADDRESS("address")},
  wallet_id      TEXT NOT NULL UNIQUE,
  key_shares_ct  TEXT NOT NULL,
  dek_wrapped    TEXT NOT NULL,
  kek_id         TEXT NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);

-- Write-ahead evidence is append-only. Turnover counts every execution WITH a signature, so a
-- signature can never be un-recorded and its notional never shrunk after the fact.
CREATE TRIGGER executions_no_delete BEFORE DELETE ON executions
BEGIN SELECT RAISE(ABORT, 'executions are append-only'); END;

CREATE TRIGGER executions_signed_immutable BEFORE UPDATE OF signed_at_ms, notional_cents, risk_class ON executions
WHEN OLD.signed_at_ms IS NOT NULL AND (
  NEW.signed_at_ms IS NOT OLD.signed_at_ms OR NEW.notional_cents != OLD.notional_cents OR NEW.risk_class != OLD.risk_class)
BEGIN SELECT RAISE(ABORT, 'signed executions are immutable (signed_at_ms, notional_cents, risk_class)'); END;

-- Crash recovery rebroadcasts the stored bytes and never re-signs: the signed bytes are immutable.
CREATE TRIGGER tx_attempts_no_delete BEFORE DELETE ON tx_attempts
BEGIN SELECT RAISE(ABORT, 'tx_attempts are append-only'); END;

CREATE TRIGGER tx_attempts_bytes_immutable BEFORE UPDATE OF signed_raw_tx, tx_hash, nonce, from_address, to_address ON tx_attempts
WHEN NEW.signed_raw_tx IS NOT OLD.signed_raw_tx OR NEW.tx_hash IS NOT OLD.tx_hash OR NEW.nonce IS NOT OLD.nonce
  OR NEW.from_address IS NOT OLD.from_address OR NEW.to_address IS NOT OLD.to_address
BEGIN SELECT RAISE(ABORT, 'signed attempts are immutable'); END;

CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
`;

const V3 = `
CREATE TABLE delegation_revocations (
  event_id        TEXT PRIMARY KEY,
  wallet_id       TEXT NOT NULL,
  event_at_ms     INTEGER NOT NULL,
  recorded_at_ms  INTEGER NOT NULL
);
CREATE INDEX idx_delegation_revocations_wallet ON delegation_revocations (wallet_id, event_at_ms);

CREATE TRIGGER delegation_revocations_no_delete BEFORE DELETE ON delegation_revocations
BEGIN SELECT RAISE(ABORT, 'delegation revocations are append-only'); END;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "core", sql: V1 },
  { version: 2, name: "desk", sql: V2 },
  { version: 3, name: "delegation-revocations", sql: V3 },
];

export const LATEST_SCHEMA_VERSION = 3;

export function schemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/** Apply every migration above the current user_version, each in its own transaction. */
export function migrate(db: Database.Database, upTo: number = LATEST_SCHEMA_VERSION): number {
  const current = schemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `database schema v${current} is newer than this code (v${LATEST_SCHEMA_VERSION}); refusing to open it`,
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current || m.version > upTo) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return schemaVersion(db);
}
