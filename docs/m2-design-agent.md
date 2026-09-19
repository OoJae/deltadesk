# M2 design: the desk agent (`agent/`), watchdog and "Start a desk"

This is the build spec. It merges the runtime architect's design with the red-team review and the user's decisions
(Dynamic sandbox, owner = Dynamic embedded **Vault** wallet, first mint of about $50, Alchemy RPC). The contracts are
specified in `docs/m2-design-contracts.md`, with frozen interfaces in `contracts/src/interfaces/`.

**ABI sources.** The agent's ABI comes from the committed snapshots `contracts/abi/I*.json` (the frozen interfaces)
plus `contracts/abi/extras.json` (the implementation-only items: custom errors such as `LaneExists`,
`ImplementationTimelocked` and `ReentrancyGuardReentrantCall`, the factory's `listed`/`LaneListed`/
`pendingImplementation`, the lane's `lastRerangeAt`/`poolParams`, the fence's constants and `config`), never from
`contracts/out`. `agent/scripts/abi-sync.ts` generates `src/executor/abi/*` from them, and `pnpm abi:sync --check`
fails when they are stale. The extras let the agent decode every revert and read the factory's listing; they add no
write surface (owner-only, admin and config functions stay stripped). *(updated after review, Sep 19)*

## Principles
1. **The LLM is never on the execution path.** It can only produce a tighten-only overlay, which is **off by default in
   M2** (identity overlay). The deterministic strategy and a deterministic plan critic decide.
2. **Postures are inverted.**
   - Risk-adding actions need fresh references, every gate clear, and approval (copilot).
   - Risk-reducing actions (`reduce`, `collect`, `exitAll`, `pause`) bypass freshness, regime gates, cost hurdle and
     approval windows. They never bypass the arm flag, dry-run, allowlist, idempotency, simulation or signer binding.
3. **One transaction in flight per signer.**
   - On-chain deadline ≤ 60 s, so "dropped" is final.
   - Robinhood Chain is Arbitrum Orbit with FCFS ordering: priority fee is 0 and tips buy nothing.
4. **The signer is the Operator wallet, never the owner.** `withdraw`, `unpause` and config changes are
   *unrepresentable* in the agent: they are absent from the action union, from the calldata builder and from
   `OPERATOR_SELECTORS`.
5. **Everything is recorded before it is signed** (write-ahead). Crash recovery rebroadcasts stored bytes and never
   re-signs.
6. **Fail closed.** Unknown state blocks risk-adding and alerts. Config refuses to start when unsafe.

## Package
- **Setup:**
  - `agent/` is a standalone pnpm package: Node ≥ 22 (26 locally), `"type": "module"`, run with `tsx`, no build step.
  - Dependencies (pin Dynamic and HL exactly): `@anthropic-ai/sdk`, `@dynamic-labs-wallet/node` and
    `@dynamic-labs-wallet/node-evm` (1.1.14), `@nktkas/hyperliquid` (0.33.3), `hono` + `@hono/node-server`,
    `better-sqlite3`, `jose`, `pino`, `ulid`, `viem`, `zod` (v4), `dotenv`.
  - Dev dependencies: `@biomejs/biome`, `fast-check`, `tsx`, `typescript`, `vitest` 4.1.x, `@types/*`, `pino-pretty`.
  - `pnpm.onlyBuiltDependencies`: `better-sqlite3`, `esbuild` and the Dynamic native package. Copy Ripcord's `.npmrc`.
- **Config files:** copy Ripcord's `tsconfig.json` (NodeNext, strict, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `.js` import suffixes) and `biome.json`.
- **Test configs:**
  - `vitest.config.ts`: `test/{unit,property,wiring}`, `pool: "forks"`.
  - `vitest.fork.config.ts`: `test/fork`, a globalSetup that starts anvil, skipped when `FORK_RPC_URL` or `anvil` is
    missing.
- **Scripts:** `dev`, `test`, `test:fork`, `typecheck`, `lint`, `abi:sync`, `status`, `signer-check`, `desk-exit`,
  `gen-rsa`, `watchdog`.
- **Ported from `/Users/oluwademilade/Desktop/Ripcord/src`.** Keep the structure; change the domain.
  - `guard/guard.ts`: the pure fail-closed `checkGuard`. Every rule is evaluated into `checks[]` and `violations[]`,
    money is integer cents, raw 0x addresses are rejected in LLM strings, idempotency and arm flag carry over.
  - `agents/{llm,schemas,prompts}.ts`:
    - `completeWithSchema` (zod + `assertNoAddresses` + retry with feedback)
    - an Anthropic SDK client with `baseURL` set to `https://llm.bankr.bot` and apiKey `bk_…`
    - a 402 → `LlmCreditsExhausted` path into deterministic mode
    - the VERIFIED FIGURES prompt block
  - `state/db.ts` patterns: WAL, write-ahead rows, spend counted fail-closed, daemon lock with heartbeat, startup
    reconcile.
  - `approval/gate.ts`: advisory, copilot and autopilot, plus a file gate. Fix the quirks: store `advisory` and
    `declined` as their own statuses.
  - `notifier/telegram.ts`: never throws; token redacted.
  - `config.ts`: zod env schema, strict safety enums, refuse unsafe config, capabilities fall back to mocks.
  - `createDaemon(deps)` from `index.ts`: dependency-injected, `setTimeout` ticks, graceful stop. Also port its wiring
    "safety proof" test style.
  - Ripcord **never signed a transaction**, so every executor and signer piece is new.

## Layout
```
agent/src/
  main.ts  daemon.ts  config.ts  addresses.ts  types.ts  units.ts  log.ts
  market/calendar.ts fair-value.ts assess.ts        # ports; must match test/fixtures/*.json exactly
  sense/index.ts chain.ts hyperliquid.ts robinhood.ts engine.ts freshness.ts
  regime/machine.ts gates.ts
  strategy/bands.ts hurdle.ts gap.ts(shadow) lanes.ts
  hedge/engine.ts (paper)
  agents/llm.ts schemas.ts prompts.ts overlay-planner.ts overlay-critic.ts plan-critic.ts
  overlay/apply.ts                                  # identity by default; tightenCheck always enforced
  guard/guard.ts risk.ts
  approval/gate.ts
  executor/chain.ts calldata.ts decision-id.ts simulate.ts fees.ts nonce.ts broadcaster.ts errors.ts rh-executor.ts hl-executor.ts
  executor/abi/DeskLane.ts DeskLaneFactory.ts PriceFence.ts  # GENERATED by scripts/abi-sync.ts from contracts/abi (updated after review, Sep 19)
  signer/types.ts local.ts dynamic-delegated.ts dynamic-server.ts vault.ts
  hl/client.ts format.ts
  reconcile/lane-actions.ts startup.ts
  notify/telegram.ts render.ts
  state/db.ts migrations.ts
  http/server.ts dynamic-webhook.ts auth.ts desks.ts
  watchdog/main.ts rules.ts                          # separate process/service with the GUARDIAN key only
```

## Market ports
- **`market/calendar.ts`** ports `engine/markout/calendar.py`: 24/5 sessions rolling at 20:00 ET, holidays and early
  closes, reopen kinds `weekday_open` (09:20–09:45) and `wake` (19:50–20:15 after a closure), and `how`.
  - It **must equal** `test/fixtures/calendar_cases.json` for every case (regime, reopen_kind, how, session_date).
  - Use `Intl.DateTimeFormat` with `America/New_York` for ET; no date libraries.
- **`market/assess.ts`** ports `engine/api/app.py::assess` and must equal `test/fixtures/assess_cases.json`.
- **`market/fair-value.ts`:** `F = HL · k`, `gapBps = 1e4·ln(F/poolMid)`.
  - `k` comes from `GET {DELTADESK_API}/basis/NVDA` (premium header) with a TTL and the last good value stored in
    `param_cache`.
  - Fallback: a self-computed median of `poolMid/HL` over the last completed regular session from the `ticks` table.

## Sense (per tick, per lane)
- The chain read is block-pinned: first `getBlock`, then Multicall3 `0xcA11…CA11` at that block. It reads:
  - pool `slot0` and `liquidity`
  - lane `positions`, `budgets`, `paused`, `closedUntil`, `riskAddingOpen`, `refTick`, `caps`, `operator`
  - NPM `positions(tokenId)` for each slot
  - token balances of the lane
  - Chainlink NVDA and USDG `latestRoundData`
  - the operator's ETH balance
- **HL:** ws `bbo` and `activeAssetCtx` for `xyz:NVDA` (subscription format as in `recorder/tape.mjs`). REST
  `{"type":"allMids","dex":"xyz"}` is the fallback.
- **RH:** `https://api.robinhood.com/rhj/prices/NVDA` (bid, ask, `isTradingHalt`) and `/rhj/corporate-actions`
  (hourly).
- Each source has `SourceStatus {ok, ageMs, reason}`. `freshness.ts` maps ages to FRESH, STALE or UNAVAILABLE per
  source and regime.

## Regime and gates (M2)
Pure machine: a gate turns on immediately and turns off only after its dwell (for example 3 fresh ticks). Each
transition is logged and notified.

**On-chain `signal()` emission of gate changes is deferred to M3.** In M2 no gate change is written on-chain: the
strategy never plans a `signal`, which stays in the operator surface (and the `DeskAction` union) only so that
`pnpm signer-check` has a neutral, event-only transaction to sign. The M3 weekend run needs every gate change
on-chain, so M3 must emit one `signal()` per transition (with its gas budgeted against the operator reserve) before any
weekend risk is taken. *(updated after review, Sep 19)*

| Gate | Trigger | Effect |
|---|---|---|
| CLOSED | calendar WEEKEND_DARK or HOLIDAY, or lane `riskAddingOpen()` false | reduce-only (mirrors the contract) |
| HALT | RH `isTradingHalt` (2 min clear to re-arm) | flat → `exitAll` |
| CORP-ACTION | a pending corporate action for NVDA, or uiMultiplier `effectiveAt` within 24 h | reduce-only |
| STALE-REF | a source lane A needs (pool, HL, k) is stale or unavailable | reduce-only (risk-adding blocked) |
| REOPEN-GUARD | `weekday_open` (validated) or `wake` (safety-only) | reduce-only |
| BOUND-PINNED, WRAPPER-PREMIUM, EVENT | stubs, `implemented:false` | shown as "not armed" |

## Strategy, lane A v0 (deterministic)
- **Centre:** F, never the pool.
- **Placement:**
  - If `|poolMid − F| ≤ 25 bp`: one straddle, `[F − w, F + w]` snapped outward to spacing 10, with w = 100 ticks.
  - Otherwise: single-sided on the far side of F using the balanced inventory. The contract fence also applies
    (band 100 bp around the Chainlink ref), so compute ranges that satisfy both, and skip if impossible.
- **Rerange trigger:** all three conditions must hold.
  1. Either the pool tick has left the inner 60% of the range for 2 consecutive ticks, or a position is out of range,
     or the lane is empty with funded balances (this is the initial mint).
  2. `now ≥ nextRerangeAt` (from `budgets`) and the hourly and daily budgets are > 0.
  3. Benefit ≥ 2× cost, where `cost = gasUsd` (simulated gas × maxFee × ETH/USD from HL or Chainlink ETH/USD
     `0x78F3…d3A9`), and benefit = the hour-of-week fee rate × active notional × 1 h × P(out of range without a
     rerange).
- Add 0–20 s jitter to scheduled reranges; never publish ticks ahead of time.
- **Lanes B and C:** hold. Lane B's hedge engine computes Δ, H* and τ and emits *paper* hedge actions only.

**Economics caveat at M2 size.** At about $50 of notional the cost hurdle (benefit ≥ 2× gas) is essentially never met
by an ordinary rerange: an hour of fees on $50 is worth far less than a rerange's gas. The initial mint (the lane is
empty with funded balances) is the one rerange that waives the hurdle, so in M2 it is the only realistic rerange.
After it the lane mostly holds, and an out-of-range position simply stays out of range until an exit or a manual
decision. That is expected: M2 proves the delegated execution path and the owner exit, not profitability. The numbers:
a full rerange costs about $0.1–0.9 of gas (`docs/m2-design-contracts.md`, Gas; the strategy's note in
`strategy/lanes.ts` uses ~$0.4), so the 2× hurdle asks for $0.2–1.8 of expected fees from the next hour. On $50 that
is 0.4–3.6% of the notional per hour (about 3,500–31,500% a year), before the P(out of range) factor, which only
lowers the benefit. *(updated after review, Sep 19)*

## Types (core)
```ts
type Lane = "A" | "B" | "C";
type RiskClass = "adding" | "reducing";
interface RangeSpec { tickLower: number; tickUpper: number; share0Bps: number; share1Bps: number }
type DeskAction =
  | { kind: "hold"; lane: Lane; reason: string }
  | { kind: "rerange"; lane: Lane; ranges: RangeSpec[]; expectedTick: number; maxTickDelta: number }   // adding (empty ranges = unwind-and-hold: reducing)
  | { kind: "reduce"; lane: Lane; slot: 0 | 1; liquidity: bigint }                                     // reducing
  | { kind: "collect"; lane: Lane }                                                                    // reducing
  | { kind: "exitAll"; lane: Lane }                                                                    // reducing
  | { kind: "pause"; lane: Lane }                                                                      // reducing
  | { kind: "signal"; lane: Lane; note: string }                                                       // neutral
  | { kind: "hedge"; lane: "B"; coin: "xyz:NVDA"; asset: 110002; isBuy: boolean; sz: string; px: string; tif: "Alo"|"Ioc"; reduceOnly: boolean }  // paper in M2
// NO withdraw / unpause / setCaps / setOperator: unrepresentable.
interface Meta { decisionId: `0x${string}`; deadline: bigint; regime: number; gatesMask: number; reasonHash: `0x${string}` }
```
`decisionId` is `bytes32 = ULID (16 bytes) ‖ 0x01 (version) ‖ step (uint8) ‖ 14 zero bytes`. It is reversible and
time-sortable; use the ULID `monotonicFactory`.

## Guard (pure; every rule evaluated; cents)
**Ported rules:**
1. `action-none`
2. `critic-approval`: the plan critic says APPROVE, and the overlay is the identity or LLM-approved.
3. `allowlist`: `to` is this lane; the selector is in `OPERATOR_SELECTORS`; no raw addresses in LLM strings.
4. `amount-positive`
5. `max-action-usd`: at most the config cap, which must itself be ≤ the on-chain cap.
6. `daily-turnover`: fail-closed, `Σ notional WHERE signed_at IS NOT NULL` plus this action; the max of the DB and
   on-chain figures. Adding only.
7. `idempotency`: DB `UNIQUE(decision_id, step)` and on-chain `decisionUsedAt == 0`.
8. `arm-flag`: `DESK_ARM=1` is required on 4663.
9. `snapshot-provenance`: lane, chainId and signer match; snapshot age ≤ 3 s.

**New rules:**
10. `ref-freshness`: blocks adding only.
11. `gas-reserve`
12. `lane-solvency`
13. `regime-gate`
14. `rerange-rate`: the stricter of the agent's and the contract's limits.
15. `cost-hurdle`: ≥ 2×; non-safety actions only.
16. `tick-validity`: spacing 10, bounds, width.
17. `fence-precheck`: the lane's `refTick()` and band; the same rule as the contract.
18. `overlay-tighten-only`: final plan ≤ deterministic plan in notional and density, a subset of its adding actions,
    and only reducing actions added.
19. `simulation-ok`: `eth_call` at a block no more than 20 blocks old.
20. `signer-binding`: signer address == on-chain `operator()`.
21. `lane-not-paused`: adding only.
22. `single-in-flight`
23. `deadline-sane`: `now + 5 ≤ deadline ≤ now + 60`.
24. `hl-order`: paper, or live with arm.
25. `dry-run`: always last.

## Executor (4663) pipeline, per step
1. Insert the `executions` row as `prepared`.
2. Encode calldata; `to` is always from config.
3. First `eth_call` from the signer at a pinned block to learn the return values. The real call then uses the same
   parameters, since mins are 0 on-chain and the fences protect us; re-simulate.
4. `estimateGas × 1.25`, which includes Orbit's L1 component. `maxFeePerGas = max(2 × baseFee, floor)`, priority 0.
5. Nonce: `pending = getTransactionCount(pending)` and `dbNext = nonce_state + 1`. If `dbNext > pending` and the last
   attempt is unconfirmed, reconcile first.
6. Sign with a 15 s timeout.
7. **Verify** the signed bytes: `parseTransaction(raw)` must equal the request field by field, and
   `recoverTransactionAddress(raw)` must equal the signer's address.
8. Persist the `tx_attempts` row (raw bytes, hash) together with execution status `signed`, in one SQLite transaction.
9. Broadcast only if the deadline hasn't passed.
10. Wait for the receipt: poll every 250 ms, 15 s timeout. Success → `confirmed`; revert → decode the reason by
    `eth_call` at block − 1; timeout → `unknown`.
11. Record gas, fee and USD.

Multi-step decisions run strictly in order, and each step re-simulates.

**Stuck or unknown transactions:** check `getTransactionCount(latest)`.
- Above our nonce: look up our hash. If it isn't ours → `NONCE_CONFLICT` → safe mode.
- Equal: rebroadcast the same bytes once. After the deadline the attempt is marked `dropped`, which is final.

**Error taxonomy:**

| Error | Outcome |
|---|---|
| `SIM_POLICY` (contract custom errors) | failed, no retry |
| `SIM_TRANSIENT` | next tick |
| `SIM_DECISION_USED` | reconcile |
| `GAS_CAP`, `INSUFFICIENT_GAS` | top-up alert |
| `SIGNER_UNAVAILABLE` | 1 retry |
| `SIGNER_DENIED` | **`policy_denied`**: safe mode and alert (the Dynamic policy demo) |
| `SIGNER_REVOKED` | desk `revoked` |
| `SIGNER_MISMATCH` | critical |
| `FEE_CAP_TOO_LOW` | re-sign at the same nonce, ≤ 2 times |
| `NONCE_TOO_LOW` | look up by hash |
| `RPC_UNAVAILABLE`, `RECEIPT_TIMEOUT` | `unknown` → reconciler |
| `REVERTED` | decode and alert |
| `NONCE_CONFLICT` | safe mode |

Classify with viem's `err.walk()`.

## Signers (`TxSigner`: kind, address, `signTransaction(tx) → Hex`, `ready()`)
- **`local`:** viem `privateKeyToAccount`. Config refuses it unless the RPC host is loopback (fork and anvil only).
- **`dynamic-delegated`:**
  - `createDelegatedEvmWalletClient({environmentId, apiKey})`, then
    `delegatedSignTransaction(client, {walletId, walletApiKey, keyShare, transaction})`, which returns raw hex.
  - Credentials come from the vault, keyed by the **Operator** wallet address. **This is the M2 target.**
- **`dynamic-server`** (Plan B): `DynamicEvmWalletClient`, `authenticateApiToken`,
  `signTransaction({walletMetadata, transaction, externalServerKeyShares})`. `scripts/create-server-wallet.ts` makes
  a 2-of-2 wallet.
  - **Persist the full `walletMetadata`** that `createWalletAccount` returns (it carries
    `externalServerKeySharesBackupInfo`, `shareSetId` and `derivationPath`), sealed or stored next to the key shares.
    Spike S1 showed that the SDK refuses to sign with caller-supplied shares when the metadata is rebuilt from the
    `walletId` alone: "walletMetadata.externalServerKeySharesBackupInfo is required to verify the password when
    signing with caller-supplied externalServerKeyShares". With the full metadata the sandbox signed a chain-4663
    transaction that recovers to the wallet, including after a JSON round trip of the metadata and shares
    (`docs/m2-spike-s1.md`). *(updated after review, Sep 19)*
- MPC signatures are randomised: signing the same request twice gives two different valid transactions (different
  hashes). This is one more reason crash recovery rebroadcasts the stored bytes and never re-signs.
  *(updated after review, Sep 19)*
- **Vault:** AES-256-GCM envelope encryption. A random DEK per row, wrapped by a KEK (`DESK_VAULT_KEK_B64` plus
  `kek_id`). AAD is `walletId|address|purpose`. Plaintext exists only during a sign and is never logged; pino redact
  paths are enforced by a test.

## HTTP (Hono) in `desk-agent`
- **`POST /webhooks/dynamic`:**
  - raw body, limited to 64 KB;
  - HMAC-SHA256 check against `x-dynamic-signature-256`, which may carry a `sha256=` prefix; compare in constant time;
  - dedupe on `eventId`;
  - `wallet.delegation.created`: `decryptDelegatedWebhookData` with our RSA private key (`scripts/gen-rsa.ts`), then
    store in the vault and bind to the lane whose `operator` equals the wallet address;
  - `wallet.delegation.revoked`: null the ciphertexts and set the desk to `revoked`;
  - return 5xx on DB failure so Dynamic retries.
  - A wallet that owns a lane is never stored. The on-chain check reads `factory.lanesOf(wallet)`, which now lists
    only lanes the owner sent `createLane` for itself (the wizard always sends it from the Vault). A lane someone else
    deployed naming the wallet as owner is not listed. For such a lane the protection is the registered-desk check
    (once the desk is registered) and, always, the signer binding: a delegated wallet only ever signs for a lane whose
    `operator()` it is, and `operator != owner` on-chain. *(updated after review, Sep 19)*
  - The exact field names of the `wallet.delegation.created` payload are still unconfirmed (Spike S1, open). Also
    keep `shareSetId` if the payload carries it: `delegatedSignTransaction` accepts it (optional; without it Dynamic
    resolves the share set by `walletId`). *(updated after review, Sep 19)*
- **Web API.** Auth is a Dynamic JWT verified with jose against the environment JWKS. The verified wallet must be the
  lane's owner (the Vault).
  - `POST /desks` `{lane, chainId}` registers a lane that exists on-chain and whose operator is a wallet the same user
    delegated. Returns the desk record.
  - `GET /desks/:lane/status` returns:
    `{lane, owner, operator, laneId, mode, status, delegation:{status}, caps, budgets, positions[], balances, lastTick:{regime, reopenKind, gates[], F, poolMid, gapBps, refTick, band}, lastDecision, pendingApprovals[]}`.
  - `POST /desks/:lane/mode` `{mode, signature, nonce}`: an owner-signed EIP-191 message
    `DeltaDesk mode <checksummed lane> <mode> <nonce>`. `nonce` is a decimal string (a positive integer), strictly
    increasing per lane; a replayed or out-of-order nonce is 409. A signed mode change also clears safe mode.
    *(updated after review, Sep 19)*
  - `POST /desks/:lane/approve` `{decisionId, approve}`: copilot approval from the web, alongside Telegram and the file
    gate.
  - `GET /delegations/:operator` returns `{operator, status: active | revoked | unknown, walletId, updatedAtMs}`:
    desk-agent's record of the Operator's Dynamic delegation, readable **before** the desk is registered (the wizard
    polls it at step 6). `unknown` means no row: the webhook has not landed yet, or it was refused (for example for a
    lane owner). The JWT's verified wallets must include the operator, and a row delegated by another user is 403.
    Only these fields are returned, never key material or ciphertexts. *(updated after review, Sep 19)*
  - `GET /operator-address`: the Plan B server-wallet operator, if configured (agent key only, no JWT).
    *(updated after review, Sep 19)*
- **`GET /lanes/:lane/actions/:decisionId[?tx=0x…]`** → `{known: boolean, status?}` (the watchdog cross-check,
  `http/watchdog-api.ts`). *(updated after review, Sep 19)*
  - `known` is true only when the DB holds an execution of that lane under that on-chain decisionId **and** at least
    one signed `tx_attempt` for it (with `tx`, one of the attempts must be that transaction).
  - Signatures are persisted before broadcast, so every LaneAction the agent produced is known by the time it is
    mined. A stolen operator key can forge the decisionId's ULID layout, but never a row in this DB, so `known: false`
    is what the watchdog pauses on.
  - Auth is the `x-watchdog-key` header: `WATCHDOG_AGENT_KEY`, at least 32 characters, compared in constant time.
    Config refuses a value equal to the web's `DESK_AGENT_API_KEY`, so the web can never vouch for an action. There
    is no JWT, and without the key configured the route answers 503.
- **`GET /health`:** last tick age, lock held, pending executions.

## Database schema v2 (SQLite, WAL, `PRAGMA user_version = 2`)
**Tables:**
- `desks(lane PK, chain_id = 4663, owner, operator, lane_id, signer_kind, mode, status, caps_json, created_at_ms)`
- `delegations(wallet_id PK, user_id, account_address, lane, key_share_ct, api_key_ct, dek_wrapped, kek_id, created_event_id UNIQUE, revoked_event_id, …)`
- `webhook_events(event_id PK, …)`
- `ticks(…)`, pruned after 14 days
- `overlays(…)`
- `decisions(decision_id PK, lane, regime, gates_mask, risk_mode, snapshot_json, plan_json, overlay_id, final_plan_json, reason_hash, plan_critic_*, guard_*, approval_mode, approval_outcome, status CHECK IN (observed, critic_rejected, blocked, dry_run, advisory, declined, policy_denied, executing, executed, partially_executed, failed), status_detail)`
- `executions(… UNIQUE(decision_id, step_index), venue, action, risk_class, notional_cents, onchain_id, status CHECK IN (prepared, simulated, signed, broadcast, confirmed, reverted, failed, declined, dropped, unknown), timestamps)`
- `tx_attempts(execution_id, attempt, signer_kind, from, to, calldata_hash, nonce, gas_limit, max_fee, signed_raw_tx, tx_hash UNIQUE, status, block, gas_used, fee_wei, receipt_json, sim_json)`
- `nonce_state`, `hl_orders`, `hl_fills`
- `lane_actions(tx_hash, log_index PK, …, matched_execution_id, match_status CHECK IN (matched, foreign, pending))`
- `sync_cursors`, `param_cache`, `cooldown_anchors`, `daemon_lock`

**Rules:**
- Turnover is fail-closed: it counts every execution with a signature.
- `reason_hash` = keccak256 of the canonical JSON of `{finalPlan, guardChecks, snapshotDigest}`; the preimage is stored.
- **LaneAction reconciliation** (every 30 s): `getLogs` from `cursor + 1` to `latest − 20`, matched by `decisionId`. A
  foreign event (the owner acting directly is also foreign) → safe mode (advisory) and an alert.
  Calls without a Meta (`pause`, `unpause`, `setClosedUntil`, the owner's config calls and withdrawals) emit
  `LaneAction` with `decisionId = 0`, so the agent's own `pause()` is matched by transaction hash; a match also
  requires the operator as caller. *(updated after review, Sep 19)*

## Approval modes (M2: copilot)
- **advisory:** never executes; recorded as `advisory`.
- **copilot:** risk-adding needs an explicit approve (web, Telegram or file) within the window; silence means no, and
  the decision is recorded as `declined`. Risk-reducing auto-executes.
- **Approval never blocks the loop.** *(updated after review, Sep 19)*
  - At most one decision per lane waits for an answer (`DESK_APPROVAL_WINDOW_SEC`, default 120 s). The 5 s ticks go
    on sensing and recording meanwhile.
  - An approve is picked up by the next tick. That tick executes the decision on its own fresh snapshot: every step is
    re-simulated and guarded again, and a risk-adding step whose snapshot is older than 3 s is re-sensed first.
  - A risk-reducing plan (HALT → `exitAll`, reduce-only) never waits behind a human. It withdraws the pending request
    (`declined`, "withdrawn before approval") and runs at once.
  - No answer within the window: the request is withdrawn as `declined` and a veto cooldown is anchored, the same as
    an explicit deny.
- **autopilot:** a cancel window (M3).
- A veto anchors a per-lane cooldown that survives restarts.

## Tick loop (5 s per lane)
1. Heartbeat; reconcile if due.
2. Sense, then insert a `ticks` row.
3. Regime and gates, then `riskMode ∈ {normal, reduce_only, flat}`.
4. Strategy → a `DeskPlan`. `hold` ends the tick with no decision row.
5. Overlay: identity in M2.
6. Plan critic: deterministic, recomputes everything.
7. Build and simulate.
8. Guard.
9. Approval (non-blocking: a waiting decision is settled by a later tick; see Approval modes).
   *(updated after review, Sep 19)*
10. Execute.
11. Notify.
12. Record.

Keep the loop wiring dependency-injected, like Ripcord's `createDaemon`.

## Watchdog (`agent/src/watchdog`, a separate Railway service with the GUARDIAN key only)
Every 30 s it reads the lane and the agent's `/health`. It **pauses** (then `exitAll` if needed) on:
- an unexplained NAV drop > X% versus the fence price;
- rerange count at or near the cap;
- 3 reverts in a row;
- a foreign LaneAction: one by the operator key that `desk-agent` did not produce. The watchdog cross-checks each
  decisionId and tx hash with `GET /lanes/:lane/actions/:decisionId?tx=…` (`x-watchdog-key`, its
  `WATCHDOG_AGENT_KEY`) rather than trusting the id's layout alone. `known: false` → pause. An unreachable agent leaves
  the action unverified, and the watchdog asks again on its next pass. *(updated after review, Sep 19)*
- operator ETH below the reserve;
- a missing agent heartbeat within 15 min around a scheduled action (dead-man).

Telegram can ask it to pause, never to unpause. **The watchdog has its own Telegram bot**
(`WATCHDOG_TELEGRAM_BOT_TOKEN`). Its config refuses the agent's `TELEGRAM_BOT_TOKEN`: two `getUpdates` pollers on one
bot swallow each other's updates, so the agent's approve/deny buttons or the watchdog's `/pause` would be lost. Without
its own bot the watchdog still sends alerts but does not listen for `/pause`. *(updated after review, Sep 19)*

## Web: "Start a desk" (`web/app/desk/*`)
- **Before writing any code,** read `web/AGENTS.md` and the relevant guides in `web/node_modules/next/dist/docs/`
  (Next 16 has breaking changes).
- The Dynamic React SDK (`@dynamic-labs/sdk-react-core`, `@dynamic-labs/ethereum`) loads **only under `/desk`**, as a
  client-side provider with `overrides.evmNetworks` for chain 4663. The environment ID comes from
  `NEXT_PUBLIC_DYNAMIC_ENV_ID`.

**Wizard:**
1. Sign in by email. The embedded wallet is the Vault.
2. Create a second embedded wallet, the Operator. If the SDK or environment doesn't allow two, fall back: fetch Plan B's
   server-wallet operator address from `desk-agent` (`GET /operator-address`).
3. The user tops up ETH on 4663: about 0.002 for the Vault and about 0.005 for the Operator. Poll balances.
4. `predictLane(params)` → show the lane address with instructions to add it to the Dynamic policy allowlist. The
   prediction holds only while the kind's implementation is unchanged, so also read `pendingImplementation(1)`. While
   a replacement is pending (it can apply 24 h after it was proposed), block the prediction and `createLane` (fail
   closed, including when the read fails) until the replacement is applied or cancelled, then predict again. Step 5
   re-reads `pendingImplementation(1)` and the prediction before sending. *(updated after review, Sep 19)*
5. The Vault calls `factory.createLane(params)` with default caps. It must be the Vault that sends it: only a
   `createLane` sent by the owner lists the lane in `lanesOf(owner)` (`LaneListed`). If someone already deployed the
   same params, the Vault's call returns that lane and lists it. *(updated after review, Sep 19)*
6. Delegate the **Operator wallet only** (`useWalletDelegation` / `initDelegationProcess`). Poll
   `desk-agent GET /delegations/:operator` until the delegation is `active` (the desk is not registered yet).
   *(updated after review, Sep 19)*
7. Fund the lane directly (USDG and NVDA transfers from anywhere to the lane address). Show live balances.
8. `POST /desks`, then pick a mode (advisory by default).

**Always visible on `/desk/[lane]`,** signed by the Vault directly on-chain and independent of `desk-agent`:
Pause · Exit all · Withdraw all to Vault · Withdraw position NFT · Revoke agent (`revokeOperator` + Dynamic revoke).
Web → agent calls go through Next route handlers in `app/api/desk/*`; the agent key stays server-side.

## Tests
- **Unit:** calendar and assess (fixtures exact); fair value; tick, price and liquidity math; decisionId codec;
  calldata round-trip; error classifier; vault tamper; webhook HMAC; DB constraints; approval; notifier; config
  refusals.
- **Property (fast-check):**
  - the Guard never executes while any rule fails;
  - tighten-only holds for any overlay;
  - risk-reducing actions are never blocked by freshness or regime;
  - the strategy output is aligned, inside the fence and inside balances;
  - the gate machine respects its dwell;
  - turnover counted ≥ Σ executions with a signature.
- **Wiring safety proofs** (drive `createDaemon` with fakes). Each proof also shows the positive path fires.
  1. `DESK_ARM=0` → no sign.
  2. DRY_RUN holds.
  3. Critic REJECT or a throwing critic → no sign.
  4. A loosening overlay is dropped.
  5. LLM 402 → deterministic mode.
  6. A crash after `signed` → rebroadcast, never re-sign.
  7. STALE-REF blocks `rerange`, but HALT still runs `exitAll`.
  8. Advisory never signs and is recorded as `advisory`.
  9. A copilot denial persists as `declined`.
  10. A policy denial → `policy_denied` plus safe mode.
  11. `to` always comes from config.
  12. A tampered signer → no broadcast.
  13. A foreign LaneAction → safe mode.
  14. Single in flight.
  15. A nonce conflict → safe mode.
  16. A passed deadline → no broadcast.
  17. The execution row exists before `sign()`.
  18. A local signer with a remote RPC is refused.
  19. HL paper never calls the exchange.
  20. A revoked delegation → no sign.
  21. Config cap above the on-chain cap → refuse to start.
  22. The signer is never the owner.
- **Fork e2e** (`test/fork`):
  - Setup: anvil `--fork-url $FORK_RPC_URL --fork-block-number N`; deploy with `contracts/script/Deploy.s.sol`; fund
    by impersonating holders or `deal`; the operator is an anvil key.
  - Scenarios: the initial mint; a price move leading to a rerange; HALT → exitAll; **a 50-run fast-check property**
    over price paths; crash recovery; the wrong signer.
