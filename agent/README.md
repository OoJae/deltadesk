# DeltaDesk desk agent (`agent/`)

The runtime that operates DeltaDesk lanes (DeskLane clones) on Robinhood Chain (4663) through a
**delegated Operator wallet** (Dynamic), never the owner's Vault. The build spec is
[`docs/m2-design-agent.md`](../docs/m2-design-agent.md); the contracts it drives are frozen in
[`contracts/src/interfaces/`](../contracts/src/interfaces/).

Standalone pnpm package: Node ≥ 22 (26 locally and in the image), ESM, run with `tsx`, no build step.

```sh
pnpm install
pnpm typecheck && pnpm test        # unit, property and wiring suites (no network)
pnpm test:fork                     # anvil fork e2e; skips unless FORK_RPC_URL is set and anvil + forge exist
pnpm lint                          # biome
pnpm abi:sync [--check]            # regenerate src/executor/abi/* from contracts/abi/{I*,extras}.json
```

## Run modes

Every mode is the same binary (`src/main.ts`); the environment decides what it may do. `src/config.ts`
refuses unsafe combinations before anything starts (see `.env.example` for every variable).

| Mode | Settings | What happens |
|---|---|---|
| **Mock demo** | `DESK_SENSE_MOCK=1` (DRY_RUN is forced) | A synthetic lane A (`sense/mock.ts`) ticks through the whole pipeline and records `dry_run` / `advisory` decisions. No chain, no signer (the executor is a stub that never executes). Good for the web status view. |
| **Shadow (default)** | `DRY_RUN=true`, `DESK_MODE=advisory`, a live RPC, `DESK_LANE_A` | Live sensing, block-pinned chain reads and real `eth_call` simulations; every decision is guarded and recorded (`dry_run`), nothing is signed. Without Dynamic credentials the operator is **watch-only** (it refuses to sign). This is the M2 "one regular session in advisory + DRY_RUN" gate. |
| **Copilot, armed** | `DRY_RUN=false`, `DESK_ARM=1`, desk mode `copilot`, Dynamic + vault configured | Risk-reducing steps (HALT → `exitAll`) execute at once; every risk-adding rerange waits for an explicit approve from the web, Telegram or the file gate (`touch $DESK_APPROVAL_DIR/approve-<decisionId>`); silence is declined. The loop keeps ticking while a decision waits: a later tick executes it once approved (re-sensed and re-criticised on that tick's snapshot), and a risk-reducing plan withdraws it. The M2 live mint runs here. Autopilot without `DESK_CANCEL_WINDOW_SEC` runs as copilot. |
| **Fork** | `RH_RPC_URL=http://127.0.0.1:…` (anvil), `SIGNER_KIND=local`, `LOCAL_SIGNER_PRIVATE_KEY` | A raw operator key, allowed only against a loopback RPC. `pnpm test:fork` builds this mode itself. |

The desk's mode lives in the `desks` table (`advisory` by default for a new desk, changed by an
owner-signed `POST /desks/:lane/mode`); `DESK_MODE` is only the default. A desk in `safe_mode` (foreign
LaneAction, nonce conflict, policy denial, tampered signature) runs as advisory until the owner signs a
mode change; a `revoked` desk never executes.

```sh
# mock demo on :8080
DESK_SENSE_MOCK=1 DESK_MODE=copilot pnpm dev

# shadow a live lane (read-only; no key needed)
RH_RPC_URL=https://… DESK_LANE_A=0x… pnpm dev

pnpm status [--lane 0x…] [-n 20]   # desks, lock, last tick, decisions, executions (read-only)
pnpm desk-exit --lane 0x…          # operator exitAll outside the loop (same guard rails)
pnpm signer-check                  # sign-but-never-broadcast check + the policy-denial probe
pnpm watchdog                      # the guardian service (separate process, separate key)
```

## Boot sequence (`src/main.ts`)

1. **Config** (`loadConfig`) and the pino logger (secret fields redacted).
2. **Store and lock:** SQLite (WAL, migrations) and the single-instance daemon lock. A second agent on the
   same DB refuses to start; a crashed one's lock goes stale after 60 s.
3. **Chain and startup reconciliation:** the RPC's chain id must be the configured one. Executions that
   never got a signature become `failed`; every stored signed transaction is resolved from the chain and,
   if still pending, **rebroadcast from its stored bytes, never re-signed**; decisions stranded in
   `executing` are settled. Two crash windows are closed here: stored **risk-adding** bytes whose desk
   left `active` while the process was down (safe mode, a revocation; the executor's own `DESK_HALTED`
   probe) are never (re)sent, and never finalized early either: a zero broadcast count cannot prove the
   bytes never left (a crash between the send and its record, or an `RPC_UNAVAILABLE` send, leaves it at
   zero), so the attempt is held until it lands or its deadline passes (`DEADLINE_PASSED`, at most
   `DESK_DEADLINE_SEC` later; its nonce stays taken until then). And approvals left `pending` are closed
   (`cancelled`, or `expired` past their window, with a `close_reason`): their waiter died with the
   process, so no channel can answer them later.
4. **Sensors and lanes:** the HL websocket, Robinhood and the engine; each configured lane is
   preflighted (identity, allowed pool, signer = operator ≠ owner, config caps within the on-chain caps)
   and registered as a desk. A configured lane that fails preflight refuses the boot. Desks registered
   later through the web API are preflighted on the reconcile timer before they are ever ticked.
5. **The daemon** (`createDaemon`, 5 s ticks).
6. **HTTP:** `/health`, `POST /webhooks/dynamic`, the web API (`/desks…`, `GET /delegations/:operator`,
   `/operator-address`) and the watchdog's cross-check (`GET /lanes/:lane/actions/:decisionId`).
7. **The reconcile timer** (30 s): LaneAction reconciliation, the lane registry, stranded decisions.

SIGINT / SIGTERM: finish the in-flight tick (20 s grace), stop the timers, close HTTP, release the lock.

## The tick (`src/daemon.ts`)

Per lane: heartbeat and "reconcile if due", settle this signer's in-flight attempts → **sense** (one
block-pinned snapshot, a `ticks` row) → **regime** (freshness, gate triggers, the dwell machine, risk
mode) → **strategy** (a lone `hold` ends the tick, no decision row) → **overlay** (identity in M2) →
**plan critic** → **build and simulate** every step → **guard** every step (the decision row, its
`reason_hash` and preimage) → **approval** → **execute** in order → notify, record.

Before each step executes it is re-prepared with its final Meta (fresh deadline, committed reason hash),
re-simulated and **guarded again**; a risk-adding step whose snapshot aged past 3 s (an approval window)
is re-sensed first. Nothing reaches an executor without an `execute` verdict for that exact step, and the
executor still re-checks idempotency and single-in-flight atomically with its write-ahead row. A
decision that did not execute holds its risk class for a while (the lane's minimum rerange interval for
adding, 30 s for reducing), so a blocked or dry-run plan is not re-proposed every 5 s; a human veto
anchors a 15 min cooldown in the DB that survives restarts. Lane B's paper hedge runs only while the
lane otherwise holds, never beside a resting paper order, and only reduces its position outside `normal`.

## Safety model (enforced where noted)

- **The LLM is never on the execution path.** It can only propose a tighten-only overlay, off in M2
  (`OverlayProposalSchema`, `assertNoAddresses`; the overlay tighten-check always runs).
- **Unrepresentable owner powers.** `withdraw*`, `unpause`, `setCaps`, operator/guardian changes and
  `setClosedUntil` are absent from `DeskAction` (`src/types.ts`), from the generated ABI and from
  `OPERATOR_SELECTORS` (`src/executor/abi/DeskLane.ts`, `test/unit/abi.test.ts`); the DB rejects them
  as execution actions.
- **Fail-closed config** (`src/config.ts`): strict enums, half-armed refusal on 4663, a local key only
  with a loopback RPC, no mock sensor with a live signer, Dynamic credentials + vault KEK required
  when live; startup hooks `assertConfigWithinOnchainCaps`, `assertSignerBinding` (signer is the
  operator and never the owner) and `assertRpcChainId`, run by `preflightLane` in `src/main.ts`.
- **Write-ahead state** (`src/state/`): an execution row exists (`prepared`) before signing; the
  signed bytes and status `signed` are stored in one transaction before broadcast; triggers make
  signed rows and signed bytes immutable and append-only; turnover counts every signed adding
  execution whatever happened next; idempotency is `UNIQUE(decision_id, step_index)`.
- **Posture inversion.** Risk-reducing steps bypass freshness, gates, the hurdle and approval
  windows (`decideApproval`), never the arm flag, dry-run, allowlist, idempotency, simulation or
  signer binding (the guard).
- **Secrets.** pino redacts every secret-bearing field name (`src/log.ts`, enforced by
  `test/unit/log.test.ts`); RPC URLs are scrubbed (`redactRpcUrl`, `scrubRpcUrl`).
- **Every revert decodes by name.** `abi:sync` adds the implementation-only items of
  `contracts/abi/extras.json` (custom errors such as `ReentrancyGuardReentrantCall`,
  `SafeERC20FailedOperation`, the factory's `LaneExists` / `ImplementationTimelocked`, and the
  factory's `listed` / `LaneListed` / `pendingImplementation` read side) without making any admin
  function encodable (`applyImplementation` is classified forbidden like `setImplementation`);
  `executor/errors.ts` names the contract and gives a plain reason, and every one of them stays
  `SIM_POLICY` (failed, never retried). An undecodable revert is still `SIM_POLICY`.

## Web API (`src/http/desks.ts`)

Called only by the web's server-side route handlers (`web/app/api/desk/*`): the shared
`x-desk-agent-key` plus a Dynamic JWT whose verified wallets bind the caller.

| Route | Who | What |
|---|---|---|
| `POST /desks` | the lane's owner (Vault) | register a lane (its operator delegated by the same user); purges our copy of the Vault's own delegation |
| `GET /desks/:lane/status` | owner | the desk view |
| `POST /desks/:lane/mode`, `POST /desks/:lane/approve` | owner | owner-signed mode change; copilot answer |
| `GET /delegations/:operator` | the JWT must hold the operator wallet (a stored row must be this user's) | `{operator (checksummed), status: active \| revoked \| unknown, walletId, updatedAtMs}`; `unknown` until the webhook lands. Works before `POST /desks`: the wizard polls it after delegating. Never key material |
| `GET /operator-address` | agent key only | the Plan B server-wallet operator |

The webhook's owner probe (`factoryLaneOwnerProbe`) refuses to store a wallet the factory LISTS as a
lane owner (`lanesOf` + `listed`: only lanes whose `createLane` the owner sent itself). A lane a third
party deployed naming the wallet as owner is not listed, so it does not count (a stranger cannot get
an Operator's delegation refused that way); if that wallet is a Vault after all, `POST /desks` purges
its delegation when the lane registers, and the 24 h unbound-delegation purge catches it otherwise.

## Docker (`agent/Dockerfile`)

One image (node:26-bookworm-slim, glibc 2.36; pnpm; the native addons installed in a separate stage),
two services:

```sh
docker build -t deltadesk-agent agent/                         # desk-agent (default target)
docker build --target watchdog -t deltadesk-watchdog agent/
docker run --env-file agent/.env -v desk-data:/data -p 8080:8080 deltadesk-agent
docker run --env-file watchdog.env deltadesk-watchdog          # GUARDIAN key only
```

- The default image picks the service from `DESK_SERVICE` (`desk-agent` | `watchdog`), so Railway can
  run both services from one build with a different variable each.
- `desk-agent` needs a persistent volume at `/data` (`DESK_DB_PATH=/data/desk.sqlite`). The container
  runs as `node`; on Railway, whose volumes mount as root, set `RAILWAY_RUN_UID=0`.
- `/health` is the healthcheck (always 200; `ok` is false until the loop ticks and holds the lock).
- The watchdog refuses to start if the operator's secrets are in its environment.
- **Native addons** (`scripts/native-check.mjs`, run in the deps stage and again in the runtime image,
  so a build fails rather than a boot): it loads AND exercises better-sqlite3 (a query) and the Dynamic
  MPC addon (`@dynamic-labs-wallet/node` + `node-evm`; the addon's `initKeygen`, offline), then lists the
  `.node` files the process mapped. Never alpine/musl: the MPC addon ships glibc builds only.
  Spike S1 ("does the Linux glibc native addon work?"), answered on 2026-09-19 with
  `docker build --platform linux/amd64` and `docker run --rm --platform linux/amd64 deltadesk-agent node scripts/native-check.mjs`
  (exit 0, node v26.9.0, linux/x64; emulated here on Apple Silicon, Railway runs linux/amd64 natively):
  - `@dynamic-labs-wallet/node/internal/node/native/libmpc_executor_linux_x86_64_nodejs.node`
    (Neon/Rust; needs glibc ≥ 2.14 and libgcc_s, links libc/libm/libdl/librt/libpthread only)
  - `better-sqlite3/prebuilds/linux-x64.node` (needs glibc ≥ 2.34, libstdc++ GLIBCXX_3.4.29)
  - the agent's own lazy loader (`loadNodeSdk`, `loadNodeEvmSdk` in `src/signer/dynamic-sdk.ts`)
    resolves `decryptDelegatedWebhookData`, `DynamicEvmWalletClient` and `createDelegatedEvmWalletClient`.
- **Watchdog ↔ agent key.** The watchdog cross-checks every operator LaneAction with the agent
  (`GET /lanes/:lane/actions/:decisionId?tx=…`, header `x-watchdog-key`). Set the SAME
  `WATCHDOG_AGENT_KEY` (≥ 32 chars, e.g. `openssl rand -hex 32`, never `DESK_AGENT_API_KEY`) on both
  services. The agent answers `{known, status?}`: known only when its DB holds a signed tx_attempt of
  that lane's execution with that decisionId (and that tx). Without the key the agent's route answers
  503; the watchdog refuses to start with `WATCHDOG_AGENT_URL` but no key, and a live watchdog
  (`WATCHDOG_DRY_RUN=false`) refuses to start without `WATCHDOG_AGENT_URL` (a dry run without it
  logs a warning at startup). Verdicts:
  - decisionId not in the agent's layout → foreign (first filter, as before; the layout is public,
    so a stolen operator key can forge it, hence the check);
  - `known: false` → foreign → **guardian pause + critical alert** (a false positive only costs
    liveness: a pause is risk-reducing, the owner unpauses);
  - agent unreachable / 5xx / refused → **critical alert, no pause**, re-asked every tick until it
    answers, however many pile up (past 256 waiting per lane, further ones are only counted);
  - escalation: an action still unverified after `WATCHDOG_UNVERIFIED_MIN` (default 15) **while the
    agent is down** (no `/health`, or a heartbeat older than 2 min / lock not held) → **guardian
    pause**, once per action (after the lane is paused, the owner's unpause stands). An alive agent
    that refuses (a key mismatch) never escalates: the refusal stays a critical alert to fix, and a
    live agent still reconciles its own LaneActions (safe mode on a foreign one).
  - A detection is never lost: a tick reads the chain before it consumes a log, and a foreign action
    (or a Telegram `/pause`) stays pending, its pause re-sent every tick, until the lane is seen
    paused or the guardian pause lands. A fresh watchdog (start or restart) looks back 3,000 blocks
    (≈ 5 min) on its first tick; the waiting set is in memory, so a restart forgets older ones.
- Telegram: the agent and the watchdog each long-poll their OWN bot. Give the watchdog a separate
  bot (`WATCHDOG_TELEGRAM_BOT_TOKEN`); it refuses the agent's `TELEGRAM_BOT_TOKEN`, because two
  pollers on one bot swallow each other's approve/deny buttons and `/pause`. Without its own bot
  the watchdog still sends alerts, but does not listen for `/pause`.

## Tests

- `test/unit`: calendar and assess against `test/fixtures/*.json` (every case), fair value, units
  (TickMath vectors and the live pool), decisionId codec, ABI selectors, addresses vs
  `Addresses4663.sol`, config refusals and `.env.example`, log redaction, DB constraints and
  triggers, approval postures, Telegram, LLM 402 handling, prompts, and the executor, signer, HTTP,
  reconciler and watchdog modules; `strategy/economics.test.ts` runs the cost hurdle on the engine's
  real hour-of-week record (see "Economics at M2 size").
- `test/property`: the guard never executes while a rule fails; tighten-only for any overlay;
  risk-reducing never blocked by freshness or gates; strategy output aligned and inside the fence;
  the gate dwell; TickMath and liquidity round trips; turnover ≥ Σ signed adding notional.
- `test/wiring`: the 22 `createDaemon` **safety proofs** of the spec, each with its positive path
  (`decision-proofs.test.ts`: arm flag, DRY_RUN, critic, loosening overlay, LLM 402, STALE-REF vs HALT,
  advisory, copilot denial, `to` from config, single in flight; `execution-proofs.test.ts`: crash after
  `signed`, policy denial, tampered signer, foreign LaneAction, nonce conflict, passed deadline,
  write-ahead row before sign, local key + remote RPC, HL paper, revoked delegation, caps above the
  on-chain caps, signer ≠ owner). They drive the real strategy, regime, critic, guard, write-ahead
  executor and a real signature against an in-memory chain (`test/helpers/wiring.ts`).
- `test/fork`: anvil e2e against contracts deployed with `contracts/script/Deploy.s.sol` (from a
  temporary copy of `contracts/`, so nothing is written there): initial mint; price move → rerange;
  HALT → exitAll; crash between sign and broadcast → exactly one LaneAction; wrong or tampered signer →
  no broadcast; and a **50-run fast-check property** over price paths and timing (evm_snapshot /
  evm_revert per run) asserting that no guard violation is ever executed, the lane's on-chain
  invariants hold and the DB equals the chain.
- `test/fork/weekend.test.ts`: the pinned **Saturday block** (`FORK_BLOCK_SATURDAY`, default
  66,851,211 = Sat 2026-09-19 06:00 UTC) with the **real Chainlink feeds** (no MockFeed, no warp): the
  fence reports `MARKET_CLOSED` (5) for NVDA; the agent refuses every risk-adding step at every layer
  (regime CLOSED → reduce-only; the strategy with the regime forced open: "lane closed to risk-adding
  (code 5)"; a rerange simulated through the executor: `MarketClosed(5)` decoded by name) and signs
  nothing for it, while a trading halt still flattens a live position with `exitAll` (the position is
  planted: an NPM position minted to the lane and recorded in its slot, since a Saturday block cannot
  mint). A second case measures rerange gas (it warps to Monday with the MockFeed, after reverting).
  Passed on 2026-09-19 against the Alchemy archive (2 tests, 99.6 s).

### Fork e2e notes

```sh
FORK_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<key> pnpm test:fork   # archive: best
FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com pnpm test:fork              # public: see below
```

Optional: `FORK_BLOCK_NUMBER` (pin; needs an archive RPC), `FORK_ANVIL_PORT` (default: a free port),
`FORK_PROPERTY_RUNS` (default 50), `FORK_PROPERTY_SEED` (default 4663), `FORK_BLOCK_SATURDAY` (the
weekend suite's block), `FORK_ANVIL_CUPS` (anvil `--compute-units-per-second`, with a 2 s 429 backoff,
for a key another campaign shares; default: no local rate limit).

```sh
# the weekend suite alone, on one anvil pinned at the Saturday block (no second fork, no prefetch)
FORK_BLOCK_NUMBER=66851211 FORK_PREFETCH_RADIUS=0 FORK_ANVIL_CUPS=150 pnpm test:fork test/fork/weekend.test.ts
```

- The deploy uses legacy transactions at a fixed price: on a fork pinned in the past, forge's EIP-1559
  estimate asks `eth_feeHistory` over pre-fork blocks, which Alchemy's 4663 endpoint refuses
  ("metadata is not found").

- The pool price is moved by real swaps through SwapRouter02 with a price limit (a swapper funded by
  storage writes), so tick crossings and fee growth stay consistent.
- Chainlink NVDA/USD and USDG/USD are replaced by an always-fresh `MockFeed` (`anvil_setCode`): the
  chain is warped to a weekday regular session, and the real rounds are frozen over weekends and dead
  after 26 h. Off-chain references (HL, RH, the engine) are fakes that follow the pool.
- anvil runs with `--hardfork cancun` (the contracts' `evm_version`); the default hardfork writes an
  EIP-2935 block-hash slot per mined block, a fresh upstream read per block.
- anvil reads every untouched storage slot **at the fork block** from the upstream, one at a time.
  The global setup reports the upstream's latency and archive status first, prefetches the pool state
  the suites touch in parallel (`FORK_PREFETCH_RADIUS`, default 500 ticks; 0 disables), and the kit
  pre-warms the rerange path. A decision the guard blocks purely because a cold read aged its snapshot
  past 3 s (correct, fail-closed behaviour) is retried; nothing else is.
- **Use an archive RPC for the full suite.** Measured on 2026-09-19, the public RPC answers in
  1.3–1.9 s per request and serves only about 8–16 minutes of history: once the fork block ages out,
  every cold read fails and the fork stalls (the kit then fails with "fork upstream no longer serves
  the fork block's state"). On it, the scenario suite (`test/fork/e2e.test.ts`, 5 scenarios + smoke)
  passes in about 4 minutes, but the 50-run property cannot finish: two attempts completed 7 and 1
  runs, every invariant holding, before the window closed.

## Layout and ownership

| Area | Files | Owner |
|---|---|---|
| Contracts between modules | `types.ts` (all shared types and interfaces), `config.ts`, `log.ts`, `state/{db,migrations}.ts` | foundation (read-only) |
| Math and codecs | `units.ts`, `canonical.ts`, `addresses.ts`, `executor/decision-id.ts`, `executor/abi/*` (generated + `external.ts`) | foundation |
| Market ports | `market/{calendar,assess,fair-value}.ts` (fixture-exact) | foundation |
| Approval, notify, LLM | `approval/gate.ts`, `notify/{telegram,render}.ts`, `agents/{llm,schemas,prompts}.ts` | foundation |
| Sense, regime, strategy, hedge, overlay, critics, guard | `sense/*`, `regime/*`, `strategy/*`, `hedge/engine.ts`, `overlay/apply.ts`, `agents/{overlay-planner,overlay-critic,plan-critic}.ts`, `guard/{guard,risk}.ts` | builder B1 |
| Execution, signers, HL, reconciliation, HTTP, watchdog | `executor/*` (except the foundation codecs), `signer/*`, `hl/*`, `reconcile/*`, `http/*` (`watchdog-api.ts` included), `watchdog/*`, `scripts/{signer-check,desk-exit,gen-rsa,create-server-wallet}.ts` | builder B2 |
| Entry points, wiring and e2e | `main.ts`, `daemon.ts`, `scripts/{status.ts,native-check.mjs}`, `test/{wiring,fork,helpers}/**` (`test/fork/anvil.ts` launches a fork), `Dockerfile`, `.dockerignore` | integration |

## Conventions

- `Lane` is the lane letter (`"A" | "B" | "C"`); the lane contract is always `laneAddress`.
- Money: integer cents (`*Cents`) in the agent, usd6 bigints on chain; convert with
  `usd6ToCentsFloor` for caps and `usd6ToCentsCeil` for spend. USD floats become cents once
  (`usdToCents`).
- Prices: raw v3 price is token1 per token0 in base units; for NVDA/USDG (USDG token0, 6 dec; NVDA
  token1, 18 dec) a higher NVDA price is a lower tick (`units.ts`).
- decisionId (bytes32) = ULID ‖ `0x01` ‖ step ‖ 14 zero bytes (`executor/decision-id.ts`); inject a
  `createDecisionUlidFactory()` per daemon.
- `*_json` columns are written with `canonicalJson`; `reasonHashOf` produces `Meta.reasonHash` and
  its stored preimage.
- Time limits use timestamps, never `block.number` (Orbit's is an L1 estimate).

## Economics at M2 size

What the 2x cost hurdle (`strategy/hurdle.ts`, unchanged) does to a ~$50 lane, with measured inputs
(2026-09-19 13:19–13:24 UTC). `test/unit/strategy/economics.test.ts` runs the real strategy and guard
on these inputs and recomputes the hurdle's figures.

**Cost of a rerange on 4663**

| Input | Value | Source |
|---|---|---|
| Gas, typical rerange (unwind 1 + mint 1) | **653,487** (`eth_estimateGas` 782,857; the executor's limit ×1.25 = 978,572) | fork kit on an anvil fork of 4663 at block 67,115,529, real pool/NPM/tokens, `receipt.gasUsed`; a second rerange 625,999, the initial mint 648,603. `test/fork/weekend.test.ts` repeats the measurement and asserts it stays under the strategy's 1.2 M budget (it passed on the Saturday-block fork) |
| L1 data component | **0** | NodeInterface `gasEstimateL1Component(rerange calldata, 420 bytes)` → 0 gas; ArbGasInfo `getL1BaseFeeEstimate` 0, `perL1CalldataByte` 0 (the agent's estimator uses `eth_estimateGas`, which would include it) |
| Base fee | **0.061824 gwei** (61,824,000 wei; `eth_gasPrice` 0.061998 gwei) | block 67,112,851, public RPC; ArbOS floor 0.02 + congestion 0.041824 |
| ETH/USD | **$2,639.89** | Chainlink ETH/USD `0x78F3…d3A9` on 4663 (round of 09:32 UTC) |

- What a typical rerange actually costs: 653,487 × 0.061824 gwei ≈ 4.04e-5 ETH ≈ **$0.107** (priority
  fee 0; Orbit charges the base fee).
- What the hurdle charges it: `rerangeGasUnits` 1.2 M × `maxFeePerGas` (2 × base fee) × ETH/USD ≈
  **$0.392**, so a rerange must promise **≥ $0.783** of fees.

**Benefit** (the engine's real hour-of-week record: `test/fixtures/nvda_hour_records.json`, the 168
`hour_record()` rows for NVDA/USDG over 8.49 weeks, divided by the strategy's 9 weeks; active pool
liquidity ≈ $4.11 M over the placement's 200-tick span at L = 27.71e18): fees per $ of in-range
notional per hour are **0.42 bp** at the median hour, 0.58 bp on average, **3.59 bp** at the best hour
of the week (hour-of-week 81: Thursday 09:00–10:00 ET). A typical rerange fires when the pool has just left the
inner 60 % band, 40 ticks from the edge: P(out of range within 1 h) ≈ **0.505** (σ 60 ticks/√h).

| At the M2 size (~$50.16 deployed) | Benefit | vs 2 × $0.392 |
|---|---|---|
| typical, median hour | $0.0011 | 0.14 % of the bar |
| typical, best hour | $0.0091 | 1.2 % |
| out of range, best hour | $0.0179 | 2.3 % (the best case of the week: 0.046x the cost) |

So the hurdle-waived initial mint executes, and **no later rerange of a $50 lane clears the hurdle at
any hour of the week, out of range included**: the first placement stays until an exit (a HALT, the
owner, `pnpm desk-exit`) or a far larger lane. **Break-even notional** (the lane size at which a
rerange clears 2x):

| Rerange | Median hour | Mean hour | Best hour |
|---|---|---|---|
| typical (P(out) 0.505), hurdle as implemented | **≈ $36,700** | ≈ $26,600 | **≈ $4,300** |
| out of range (P(out) 1), hurdle as implemented | ≈ $18,600 | – | **≈ $2,200** |
| typical, if the hurdle priced the measured gas at the base fee | ≈ $10,000 | – | ≈ $1,180 |

The fork kit's fake record (`fees_usd = 5e8`) clears the hurdle on purpose: the fork scenarios exercise
the wiring, not these economics.
