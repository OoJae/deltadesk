# DeltaDesk desk agent (`agent/`)

The runtime that operates DeltaDesk lanes (DeskLane clones) on Robinhood Chain (4663) through a
**delegated Operator wallet** (Dynamic), never the owner's Vault. The build spec is
[`docs/m2-design-agent.md`](../docs/m2-design-agent.md); the contracts it drives are frozen in
[`contracts/src/interfaces/`](../contracts/src/interfaces/).

Standalone pnpm package: Node ≥ 22 (26 locally, 24 in the image), ESM, run with `tsx`, no build step.

```sh
pnpm install
pnpm typecheck && pnpm test        # unit, property and wiring suites (no network)
pnpm test:fork                     # anvil fork e2e; skips unless FORK_RPC_URL is set and anvil + forge exist
pnpm lint                          # biome
pnpm abi:sync [--check]            # regenerate src/executor/abi/* from contracts/abi/*.json
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
   `executing` are settled.
4. **Sensors and lanes:** the HL websocket, Robinhood and the engine; each configured lane is
   preflighted (identity, allowed pool, signer = operator ≠ owner, config caps within the on-chain caps)
   and registered as a desk. A configured lane that fails preflight refuses the boot. Desks registered
   later through the web API are preflighted on the reconcile timer before they are ever ticked.
5. **The daemon** (`createDaemon`, 5 s ticks).
6. **HTTP:** `/health`, `POST /webhooks/dynamic`, the web API (`/desks…`).
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

## Docker (`agent/Dockerfile`)

One image (node:24-bookworm-slim, pnpm, the native addons built in a separate stage), two services:

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
- Telegram: the agent and the watchdog each long-poll their OWN bot. Give the watchdog a separate
  bot (`WATCHDOG_TELEGRAM_BOT_TOKEN`); it refuses the agent's `TELEGRAM_BOT_TOKEN`, because two
  pollers on one bot swallow each other's approve/deny buttons and `/pause`. Without its own bot
  the watchdog still sends alerts, but does not listen for `/pause`.

## Tests

- `test/unit`: calendar and assess against `test/fixtures/*.json` (every case), fair value, units
  (TickMath vectors and the live pool), decisionId codec, ABI selectors, addresses vs
  `Addresses4663.sol`, config refusals and `.env.example`, log redaction, DB constraints and
  triggers, approval postures, Telegram, LLM 402 handling, prompts, and the executor, signer, HTTP,
  reconciler and watchdog modules.
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

### Fork e2e notes

```sh
FORK_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<key> pnpm test:fork   # archive: best
FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com pnpm test:fork              # public: see below
```

Optional: `FORK_BLOCK_NUMBER` (pin; needs an archive RPC), `FORK_ANVIL_PORT` (default: a free port),
`FORK_PROPERTY_RUNS` (default 50), `FORK_PROPERTY_SEED` (default 4663).

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
| Execution, signers, HL, reconciliation, HTTP, watchdog | `executor/*` (except the foundation codecs), `signer/*`, `hl/*`, `reconcile/*`, `http/*`, `watchdog/*`, `scripts/{signer-check,desk-exit,gen-rsa,create-server-wallet}.ts` | builder B2 |
| Entry points, wiring and e2e | `main.ts`, `daemon.ts`, `scripts/status.ts`, `test/{wiring,fork,helpers}/**`, `Dockerfile` | integration |

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
