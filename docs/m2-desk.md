# The desk (M2): live record

The M2 live record on Robinhood Chain (4663): deployment, the advisory run, the policy denial, the ~$50 delegated
mint, the owner exit and the regular-session reconciliation re-run. **Sections 1, 3, 3b and 3c are complete and every
value in them is from a real transaction, log or command output, never estimated. Sections 2, 4, 5 and 6 run in a
regular session on Mon Sep 21, with the user present, and are marked TBD until then** — the desk refuses to add risk
inside the closed window (Sat 00:00 → Mon 01:00 UTC) and the contract enforces that, so nothing there could have been
run on Saturday. Transaction hashes link to `https://robinhoodchain.blockscout.com/tx/<hash>`, addresses to
`…/address/<address>`.

| M2 exit criterion | Section | Status |
|---|---|---|
| 3. Deployed and verified on 4663; `desk-agent` through ≥ 1 regular session in advisory + DRY_RUN, no alerts | 1, 2 | **Deployment and verification done** (§1, Sat Sep 19 14:43 UTC); the regular-session advisory run is Mon Sep 21 (§2) |
| 4. One recorded Dynamic policy denial on the Operator wallet | 3 | **Done** (§3, Sat Sep 19 15:10–15:40 UTC) |
| 5. One live delegated mint of ~$50: matched LaneAction, `reasonHash` preimage, position on the lane's tearsheet | 4 | TBD (Mon Sep 21) |
| 6. Owner Exit & withdraw executed live from `/desk` | 5 | TBD (Mon Sep 21) |
| M1 carry-over: regular-session reconciliation re-run | 6 | TBD (Mon Sep 21) |

Beyond the exit criteria, two things already happened on-chain and are recorded below: the lane was created and funded
by its owner (§1, §3c) and the agent made its first delegated on-chain decisions (§3b).

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

**Lane A** (created 2026-09-19 15:10:44 UTC through the `/desk` wizard; every value below is read from the chain)

| Field | Value |
|---|---|
| Vault (owner) | [`0x397634DfbE552eBA34eFF652fe4ca0B05794B85A`](https://robinhoodchain.blockscout.com/address/0x397634DfbE552eBA34eFF652fe4ca0B05794B85A) (Dynamic embedded wallet, never delegated) |
| Operator (delegated embedded wallet) | [`0x86629b04811741860E211c84003E3B143d6E3678`](https://robinhoodchain.blockscout.com/address/0x86629b04811741860E211c84003E3B143d6E3678) (embedded, not the Plan B server wallet) |
| Guardian (watchdog key) | [`0x01BFF09B19F7eedcdD33ba0Da1bA8f191707d89f`](https://robinhoodchain.blockscout.com/address/0x01BFF09B19F7eedcdD33ba0Da1bA8f191707d89f) |
| `predictLane` address | `0x7f8968734E613f509991D3392074CF7f1e4bd662` — the wizard predicts it before the lane exists (CREATE2 salt over every param) and the Dynamic policy allowlist is written against the prediction (§3); the lane deployed at exactly that address |
| `createLane` tx (sent by the Vault) | [`0x0e104b50…a158`](https://robinhoodchain.blockscout.com/tx/0x0e104b50393b85a91509cd18a583f4c340f3a56430f14d6349c42efe6e34a158) — block 67,179,062, status 1, 433,413 gas, from the Vault to the factory `0x6968…63B3`, selector `0x141880c9`, value 0, 5 logs |
| Lane address (== prediction) | [`0x7f8968734E613f509991D3392074CF7f1e4bd662`](https://robinhoodchain.blockscout.com/address/0x7f8968734E613f509991D3392074CF7f1e4bd662) |
| `LaneCreated` / `LaneListed` logs | Both in the `createLane` receipt, emitted by the factory: `LaneCreated(owner = Vault, lane = 0x7f89…d662, …)` with kind 1 and pool `0xd4EB…14a3`, then `LaneListed(owner = Vault, lane = 0x7f89…d662)` |
| `listed(lane)` / `lanesOf(vault)` | `true` / `[0x7f8968734E613f509991D3392074CF7f1e4bd662]` (§3) |
| Caps (the M2 defaults) | From the lane's own creation log: `maxDeployUsd6` 60,000,000 = **$60** per rerange, `maxTurnoverUsd6PerDay` 150,000,000 = **$150**/day; 4 reranges per hour, 24 per day, ≥ 5 min apart |
| `CheckDeployment` with `LANE=<lane>` | Mon Sep 21, with §4 |
| Lane funding txs (USDG, NVDA; amounts) | USDG: [`0xb752721c…26e8`](https://robinhoodchain.blockscout.com/tx/0xb752721c10d72aa7a6f0a4e7a1a58cbe6b47f3cb68a021e871013c6980d826e8) — block 67,223,194, status 1, 74,286 gas, 2026-09-19 16:24:49 UTC, a USDG `transferFrom` of **25.796085 USDG** from `0xf70d…dbef` to the lane (the owner's funding route; the lane's USDG balance reads 25.796085 today). NVDA: the bounded USDG→NVDA swap straight into the lane, [`0x15d6667e…906c`](https://robinhoodchain.blockscout.com/tx/0x15d6667e38b7da82ab66c4c41d57f39f6743e56ba0e739cbe2fc80a64e53906c) — **0.112258293 NVDA** (§3c). ≈ $50.75 in total |
| Gas top-ups (Vault, Operator) | Sent before creation; the live balances are on [`/desk/0x7f8968734E613f509991D3392074CF7f1e4bd662`](https://web-production-10951.up.railway.app/desk/0x7f8968734E613f509991D3392074CF7f1e4bd662), which reads them from the chain without a wallet |

## 2 · `desk-agent` advisory run (advisory + DRY_RUN)

Runs Mon Sep 21, the first regular session after the deployment: Saturday and Sunday are inside the closed window, so
there is no regular session to run it in. The agent is live and ticking now — its decisions and gate signals are public
at [/console](https://web-production-10951.up.railway.app/console) — but the row below is only filled from a completed
regular session.

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

## 3 · Dynamic delegation and policy denial (recorded 2026-09-19, 15:10–15:40 UTC)

**Lane A**: `0x7f8968734E613f509991D3392074CF7f1e4bd662` · Vault (owner) `0x397634DfbE552eBA34eFF652fe4ca0B05794B85A` ·
Operator (delegated) `0x86629b04811741860E211c84003E3B143d6E3678` · Guardian `0x01BFF09B19F7eedcdD33ba0Da1bA8f191707d89f`.
Created by the Vault through the `/desk` wizard; on-chain checks: `listed(lane) = true`, `lanesOf(vault) = [lane]`,
owner/operator/guardian as above, `paused = false`, `riskAddingOpen() = (false, 5)` (Saturday: market closed).

**Delegation (Operator only).** Dynamic shows the Operator delegated and the Vault not delegated. Two integration bugs
surfaced on the first real delivery and were fixed the same hour: Dynamic's envelope carries `"userId": null` (the agent's
schema accepted absent but not null, so every delivery got 400; `205fee6`), and the documented payload's `publicKey` is the
address (handled, plus public-key derivation for other formats; `3457c19`). The failed message
(`eventId 3953471a…`) was then redelivered through Dynamic's API (`POST …/webhooks/{id}/messages/{messageId}/redeliver`)
and processed; the wizard reads "Operator delegated and confirmed by desk-agent; Vault not delegated" and
`POST /desks` registered the desk (mode advisory).

**Signer check** (`pnpm signer-check --lane <lane>` inside the `desk-agent` service; nothing is ever broadcast):
the delegated Operator signed a lane `signal()` on chain 4663 and the bytes verified (parse == request, recover ==
operator): `0x057c22b9…a15c`, then `0x7974117b…0330`.

**Policy findings (Spike S1 question 5).**

| Probe (same delegated Operator key) | Result |
|---|---|
| Wallet-level policy layer on the Operator: chain `[4663]`, allowlist `[lane]`, `maxPerCall 0` (accepted by the API, rule `9dc3bf75…`) | **not enforced**: the operator's `USDG.transfer(owner, 1)` on 4663 was signed (wallet/signer layers are early access) |
| Environment-wide rule for chain 4663 | **refused by Dynamic's API**: `Unsupported chainIds for EVM: 4663` |
| Environment rule on Base 8453, allowlist `[lane address]` (rule `39d8c2f6…`): transfer of Base USDC `0x8335…2913` to the Vault (the staged prompt injection) | **DENIED**: Dynamic's co-signer never signed; the MPC session was dropped after 61.6 s (`WebSocket protocol error: Connection reset without closing handshake`) |
| Control: Base 8453, destination = the allowlisted address | signed in 2.3 s |
| Control: chain 4663, `USDG.transfer` | signed in 2.0 s |

So Dynamic's policy engine does enforce for the delegated Operator, on the chains it supports; on Robinhood Chain the
enforcing fences are DeltaDesk's own: the lane contract (the Operator can never withdraw, approve, transfer or change
settings: invariants I1/I8 on local and fork campaigns, `contracts/reports/`) and the agent's ABI, which cannot even
encode a transfer. Feedback for Dynamic: support chain 4663 in policies, and surface a denial as a policy error rather than
a dropped signing session.

## 3b · The agent's first live on-chain decision (Sat 2026-09-19 15:45 UTC)

With the desk switched to **copilot** (mode message signed by the Vault) and desk-agent armed (`DESK_ARM=1`,
`DRY_RUN=false`, `DESK_SIGNAL_AUTO=0`), the agent proposed its first gate signal, the owner approved it on `/desk/<lane>`,
and the delegated Operator signed it through Dynamic and broadcast it:

| Field | Value |
|---|---|
| Tx | [`0xddbc1b92…7375`](https://robinhoodchain.blockscout.com/tx/0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375), block 67,199,987, status 1, 58,856 gas |
| From → to | Operator `0x8662…3678` → lane `0x7f89…d662`, `signal(Meta)` (selector `0xb34b20a9`), value 0 |
| `LaneAction` | action 8 (SIGNAL), decisionId `0x01a0ba57…` (ULID `01M2X5FXVVWKW3THGG1W9A5WZX`), regime 4 (WEEKEND_DARK), gatesMask `0b1001` (CLOSED + STALE-REF), caller = Operator |
| `reasonHash` | `0x90023d03e9b399a0b945fee8cee1eae0069a3aeb4088cb27eee85b192a4a7314` |
| Preimage (agent DB `gate_signals`) | `{"at":1789832630302,"from":null,"lane":"0x7f8968734e613f509991d3392074cf7f1e4bd662","source":"initial","to":{"gates":["CLOSED","STALE-REF"],"regime":"WEEKEND_DARK"}}` |
| Check | `cast keccak '<preimage>'` = the on-chain `reasonHash` |

A second transition followed at 15:51 UTC when the engine's new `/basis` endpoint went live and the fair value returned
(STALE-REF cleared; F 222.287 vs pool 222.491, gap −9.2 bp): gates `CLOSED+STALE-REF → CLOSED`, approved and signed the same
way, tx [`0xbe80e98b…3223`](https://robinhoodchain.blockscout.com/tx/0xbe80e98beb80f8f87275b01568fd451fe4ceea35881fe74c106e2826ed083223)
(decision `01M2X5TAYMSFFC7KN2F3JDX82G`).

The agent reconciled the LaneAction as its own (decision `executed`, execution `confirmed`); the watchdog's cross-check route
knows the decisionId. Every later regime or gate change on this lane is announced the same way (≤ 6 per hour, 60 s dwell).

## 3c · Funding lane A (Sat 2026-09-19)

The owner sent 25 USDG directly to the lane (balance read on-chain: 25.796085 USDG) and 24.990977 USDG to the deployer
wallet for conversion, because the M2 lane deliberately cannot swap. The deployer swapped it on the NVDA/USDG 0.05% pool
through SwapRouter02 `0xCaf6…5cb2` with the **lane as recipient** and a 0.5% minimum-output bound (QuoterV2 quote
0.112257515 NVDA; min 0.111696227):

| Step | Tx |
|---|---|
| `USDG.approve(SwapRouter02, 24.990977)` (exact amount; allowance back to 0 after the swap) | [`0x31f67a99…9606`](https://robinhoodchain.blockscout.com/tx/0x31f67a994ced553ff2e0821d04152cb4e6198f534ee92a318566bb9331859606) |
| `exactInputSingle(USDG→NVDA, fee 500, recipient = lane)`: 0.112258293 NVDA out, 158,911 gas | [`0x15d6667e…906c`](https://robinhoodchain.blockscout.com/tx/0x15d6667e38b7da82ab66c4c41d57f39f6743e56ba0e739cbe2fc80a64e53906c) |

Lane A now holds **25.796085 USDG + 0.112258293 NVDA** (≈ $50.75 at F = 222.29); the deployer holds no USDG. Cost of the
conversion ≈ 0.14% (0.05% pool fee plus the pool's ~9 bp weekend premium to fair). Nothing is placed before Monday: the
fence keeps risk-adding closed until Mon 01:00 UTC, and the first mint waits for the owner's copilot approval.

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

Runs Mon Sep 21, straight after §4: the exit has to have something to exit.

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

The M1 fee reconciliation (`engine/indexer/reconcile.py`) re-run over a regular session, the same day. Runs
Mon Sep 21; the M1 result it re-checks is in [docs/m1-truth-study.md](m1-truth-study.md).

| Field | Value |
|---|---|
| Session (ET date) and block range | TBD |
| Command | TBD |
| Result: USDG side / NVDA side | TBD / TBD |
| PASS / FAIL vs the M1 tolerance | TBD |
| Notes | TBD |
