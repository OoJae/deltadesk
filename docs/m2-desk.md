# The desk (M2): live record

The M2 live record on Robinhood Chain (4663): deployment, the advisory run, the policy denial, the ~$50 delegated
mint, the owner exit and the regular-session reconciliation re-run. It is a **skeleton** until Phase 5 runs (Mon Sep 21
or later, with the user present). Every field is TBD, and a value is filled in only from a real transaction, log or
command output, never estimated. Transaction hashes link to `https://robinhoodchain.blockscout.com/tx/<hash>`,
addresses to `…/address/<address>`.

| M2 exit criterion | Section | Status |
|---|---|---|
| 3. Deployed and verified on 4663; `desk-agent` through ≥ 1 regular session in advisory + DRY_RUN, no alerts | 1, 2 | TBD |
| 4. One recorded Dynamic policy denial on the Operator wallet | 3 | TBD |
| 5. One live delegated mint of ~$50: matched LaneAction, `reasonHash` preimage, position on the lane's tearsheet | 4 | TBD |
| 6. Owner Exit & withdraw executed live from `/desk` | 5 | TBD |
| M1 carry-over: regular-session reconciliation re-run | 6 | TBD |

## 1 · Contract deployment and Blockscout verification

**Deploy run** (`forge script script/Deploy.s.sol --rpc-url <4663> --broadcast --account <keystore>`)

| Field | Value |
|---|---|
| Date / time (UTC, ET) | TBD |
| Foundry version | TBD |
| Deployer | TBD |
| Admin / pendingAdmin (`DESK_ADMIN`) | TBD / TBD |
| `acceptAdmin` tx (if an admin was proposed) | TBD |
| Record `contracts/deployments/4663.json` (commit) | TBD |
| Total deploy gas / cost (ETH, USD) | TBD |

**Contracts**

| Contract | Address | Deploy tx | Blockscout verification |
|---|---|---|---|
| `ChainlinkFence` | TBD | TBD | TBD |
| `DeskLaneFactory` | TBD | TBD | TBD |
| `DeskLaneV3` implementation (kind 1) | TBD | TBD | TBD |

| Admin call | Tx |
|---|---|
| `setImplementation(1, impl)` (first registration: instant) | TBD |
| `setPoolAllowed(NVDA/USDG 0xd4EB…14a3, 1, true)` | TBD |

- Verification method (`forge verify-contract` or a manual Blockscout upload if Cloudflare blocks the CLI): TBD
- `forge script script/CheckDeployment.s.sol --rpc-url <4663>` output (`CheckDeployment: OK`, fence prices and codes):
  TBD
- `pendingImplementation(1)` at deploy (expected none): TBD

**Lane A**

| Field | Value |
|---|---|
| Vault (owner) | TBD |
| Operator (delegated embedded wallet, or Plan B server wallet) | TBD |
| Guardian (watchdog key) | TBD |
| `predictLane` address | TBD |
| `createLane` tx (sent by the Vault) | TBD |
| Lane address (== prediction) | TBD |
| `LaneCreated` / `LaneListed` logs | TBD / TBD |
| `listed(lane)` / `lanesOf(vault)` | TBD / TBD |
| Caps (expected the M2 defaults) | TBD |
| `CheckDeployment` with `LANE=<lane>` | TBD |
| Lane funding txs (USDG, NVDA; amounts) | TBD |
| Gas top-ups (Vault, Operator) | TBD |

## 2 · `desk-agent` advisory run (advisory + DRY_RUN)

| Field | Value |
|---|---|
| Railway service / deployment id | TBD |
| Image (commit) | TBD |
| Settings (`DESK_MODE=advisory`, `DRY_RUN=true`, `DESK_ARM=0`) | TBD |
| `desk-watchdog` service / deployment id (`WATCHDOG_DRY_RUN`) | TBD |
| Regular session covered (ET date, 09:30–16:00) | TBD |
| Ticks recorded / tick age at close | TBD / TBD |
| Decisions by status (`dry_run`, `advisory`, `blocked`, …) | TBD |
| Gates seen (CLOSED, HALT, CORP-ACTION, STALE-REF, REOPEN-GUARD) | TBD |
| Alerts (agent / watchdog), expected none | TBD / TBD |
| Foreign LaneActions, expected none | TBD |
| `pnpm status` excerpt | TBD |

## 3 · Dynamic policy denial

The Dynamic setup:

- Delegated Access on, with prompt on sign-in OFF and requires-delegation OFF;
- the webhook URL and secret, and the RSA public key from `pnpm gen-rsa`;
- the policy: chain `[4663]`, allowlist `[lane]`, value 0, `blockExport`, set on the address the wizard predicted,
  before `createLane` and the delegation (`docs/m2-spike-s1.md`, Phase 4).

The Vault sends `createLane` before any delegation, so the webhook refuses a later Vault delegation and stores no
`delegations` row: `GET /delegations/<vault>` reads `unknown` whether or not the Vault was delegated. The evidence that
only the Operator was delegated is the created-event count and Dynamic's own view of the Vault.

| Field | Value |
|---|---|
| Delegation webhook received (`eventId`, time) | TBD |
| `wallet.delegation.created` rows in `webhook_events`, by status (expected exactly 1, `processed`, the Operator's; a Vault delegation adds an `ignored` one) | TBD |
| "A lane OWNER wallet was delegated" alerts (expected none) | TBD |
| Vault's delegation state in the Dynamic dashboard (expected not delegated) | TBD |
| `GET /delegations/<operator>` → `active` | TBD |
| `GET /delegations/<vault>` → `unknown` (supporting evidence only) | TBD |
| `pnpm signer-check --lane <lane>`: lane `signal()` signed, never broadcast (hash) | TBD |
| Staged `USDG.transfer(owner, 1)` outcome (`SIGNER_DENIED` expected) | TBD |
| Denial as Dynamic reported it (code / message, secrets redacted) | TBD |
| Record under `agent/data/signer-check/` | TBD |
| `signer-check` exit code (0 = signed + denial recorded) | TBD |

## 4 · The live mint (~$50, copilot)

Run in a regular session, 10:00–15:30 ET, outside 09:20–09:45, with the desk in copilot and armed (`DRY_RUN=false`,
`DESK_ARM=1`).

| Field | Value |
|---|---|
| Date / time (ET) | TBD |
| Lane balances before (USDG, NVDA) | TBD |
| decisionId (bytes32) / ULID | TBD / TBD |
| Plan: ranges `[tl, tu]`, shares, `expectedTick`, `maxTickDelta` | TBD |
| Fence at execution: `refTick`, band, `refPxE18` | TBD |
| F (HL × k), pool mid, gap (bp) | TBD |
| Guard verdict (all checks) | TBD |
| Approval (channel, who, time to answer) | TBD |
| Rerange tx | TBD |
| Block / gas used / fee (ETH, USD) | TBD |
| `PositionMinted`: slot, tokenId, liquidity, amount0, amount1 | TBD |
| Notional (usd6, fence-valued) vs `maxDeployUsd6` | TBD |
| `LaneAction(RERANGE)`: ticks, `refPxE18`, regime, `gatesMask`, `reasonHash`, caller | TBD |
| Reconciler match (`lane_actions.match_status = matched`, execution id) | TBD |
| `reasonHash` preimage (canonical JSON, stored in `decisions`) | TBD |
| `keccak256(preimage) == reasonHash` check (command and result) | TBD |
| Position on the lane's own tearsheet (link) | TBD |

## 5 · Owner exit and withdraw (from `/desk`, signed by the Vault)

| Field | Value |
|---|---|
| Date / time (ET) | TBD |
| `exitAll` tx (Vault) | TBD |
| `PositionClosed` (slot, tokenId, amount0, amount1) / any `CollectFailed` | TBD |
| `withdrawAll` tx (Vault) | TBD |
| `Withdrawn` (USDG, NVDA amounts) | TBD |
| `withdrawPosition` tx, if an NFT was stuck | TBD |
| Vault balances after (USDG, NVDA) | TBD |
| Round trip vs the funded amounts (fees earned, gas, price P&L) | TBD |
| Agent reaction (foreign LaneAction → safe mode, alert) | TBD |
| Revoke agent (`revokeOperator` tx + Dynamic revoke), if done | TBD |

## 6 · Regular-session reconciliation re-run (M1 carry-over)

The M1 fee reconciliation (`engine/indexer/reconcile.py`) re-run over a regular session, the same day.

| Field | Value |
|---|---|
| Session (ET date) and block range | TBD |
| Command | TBD |
| Result: USDG side / NVDA side | TBD / TBD |
| PASS / FAIL vs the M1 tolerance | TBD |
| Notes | TBD |
