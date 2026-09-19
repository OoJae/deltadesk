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
| Date / time (UTC, ET) | 2026-09-19 14:43 UTC (10:43 ET), deployedAt 1789829035 |
| Foundry version | `forge Version: 1.8.3-Homebrew` |
| Deployer | [`0x6C9f…b6E0`](https://robinhoodchain.blockscout.com/address/0x6C9f2ca64d9491ec76863924e400Aa6f5A74b6E0) (encrypted Foundry keystore) |
| Admin / pendingAdmin (`DESK_ADMIN`) | the deployer (keystore EOA; Safe in M4) / none |
| `acceptAdmin` tx (if an admin was proposed) | n/a (no admin proposed) |
| Record `contracts/deployments/4663.json` (commit) | `c7ff6ad` |
| Total deploy gas / cost (ETH, USD) | 8,736,640 gas / 0.000543 ETH (≈ $1.43 at $2,640) |

**Contracts**

| Contract | Address | Deploy tx | Blockscout verification |
|---|---|---|---|
| `ChainlinkFence` | [`0xc82Cc6A466b7fE32e822A7dA59E7D9d7b726C1ea`](https://robinhoodchain.blockscout.com/address/0xc82Cc6A466b7fE32e822A7dA59E7D9d7b726C1ea) | [`0x4c19158c…`](https://robinhoodchain.blockscout.com/tx/0x4c19158c380cc68c68924f5a00ab6adf83225368d0ffb304dbbe2de2bee795d8) | Sourcify full match (creation + runtime) |
| `DeskLaneFactory` | [`0x6968B97974aF2ba51537e751c043d5ba48d663B3`](https://robinhoodchain.blockscout.com/address/0x6968B97974aF2ba51537e751c043d5ba48d663B3) | [`0x1886c453…`](https://robinhoodchain.blockscout.com/tx/0x1886c4536a9ccbfcd42200f35b3c0ba850eb7a3a7892446fb1bca358f8f9ef19) | Sourcify full match (creation + runtime) |
| `DeskLaneV3` implementation (kind 1) | [`0xBf5f4880B2f569656E913d225bcF4810Dcc4EDD9`](https://robinhoodchain.blockscout.com/address/0xBf5f4880B2f569656E913d225bcF4810Dcc4EDD9) | [`0x11cdc4b5…`](https://robinhoodchain.blockscout.com/tx/0x11cdc4b59b513514e89989782d754bbc27740802ea8a7a0905f5fd1ffe3379c6) | Sourcify full match (creation + runtime) |

| Admin call | Tx |
|---|---|
| `setImplementation(1, impl)` (first registration: instant) | [`0x9af83fe9…`](https://robinhoodchain.blockscout.com/tx/0x9af83fe9fe0243431296cf70944eea670e9d6ad33e0ed69f3074a186c531549e) |
| `setPoolAllowed(NVDA/USDG 0xd4EB…14a3, 1, true)` | [`0x141db5c9…`](https://robinhoodchain.blockscout.com/tx/0x141db5c9d38862132cc2d1b1c5f7958e1f23747097ef18aa21b07541cabfd5f8) |

- Verification method: `forge verify-contract --verifier sourcify --chain 4663` (Blockscout's API sits behind a Cloudflare challenge; Blockscout reads Sourcify). Jobs `b5561886…`, `90141445…`, `0e503b4f…`: all `match` for creation and runtime bytecode.
- `forge script script/CheckDeployment.s.sol --rpc-url <4663>` output (`CheckDeployment: OK`, fence prices and codes):
  `CheckDeployment: OK`; fence USDG 0.99995090 code 0; NVDA 222.44729849 code 5 (market closed: Saturday).
- `pendingImplementation(1)` at deploy (expected none): none (first registration is instant).

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
