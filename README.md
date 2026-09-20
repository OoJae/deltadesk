# DeltaDesk: the open market-making desk for tokenized stocks

> *"If I made $80 in fees but lost $50 to informed flow, that would be good to know."* (Igor, Bankr)

Tokenized stocks trade around the clock on AMMs. The people providing liquidity (LPs) in those pools are doing a
market maker's job without a market maker's books. DeltaDesk keeps those books.

For every LP position in Robinhood Chain's NVDA, SPY, TSLA and QQQ/SPY pools and Aerodrome's NVDA pool on Base, it
measures:

- the fees earned;
- the value informed flow picked off, marked against Hyperliquid's 24/7 price;
- impermanent loss against simply holding;
- gas.

Every figure reconciles to the chain.

On top of those books sit two things. The first is a pre-trade check that tells an LP, or an agent, when providing
liquidity is safe. The second is a desk: an agent runs a user's LP lane through a delegated Dynamic wallet, inside a
contract that can only ever pay its owner. Hayden Adams calls *"can automated strategies perform well enough?"* the
question for AMMs taking over equities market making. DeltaDesk measures the answer in public, position by position.

## Live now

| What | Where |
|---|---|
| Web app: landing, Truth Study, Live desk, Tearsheet, League | https://web-production-10951.up.railway.app ([/study](https://web-production-10951.up.railway.app/study), [/live](https://web-production-10951.up.railway.app/live), [/tearsheet](https://web-production-10951.up.railway.app/tearsheet), [/league](https://web-production-10951.up.railway.app/league)) |
| Desk console: the agent's decisions, gate signals with their `reasonHash` preimages, and the lane's on-chain actions. Public, no wallet, no sign-in | [/console](https://web-production-10951.up.railway.app/console) |
| The user's lane, read straight off the chain in the app. Public, no wallet: lane value, balances, operator gas, caps and the owner controls | [/desk/0x7f8968734E613f509991D3392074CF7f1e4bd662](https://web-production-10951.up.railway.app/desk/0x7f8968734E613f509991D3392074CF7f1e4bd662) |
| API | [https://core-production-512e.up.railway.app/docs](https://core-production-512e.up.railway.app/docs) (Swagger) · [/health](https://core-production-512e.up.railway.app/health) · [/fair-value/NVDA](https://core-production-512e.up.railway.app/fair-value/NVDA) · [/study](https://core-production-512e.up.railway.app/study) |
| Paid endpoints (x402 on Bankr, USDC on Base) | `https://x402.bankr.bot/0xd8d5b9389721258bcdfa7ac1306af6330e5634cd/<service>`: `safe-to-lp`, `fair-value`, `pool-toxicity`, `tearsheet`, `lp-league` |
| First settled x402 call (a self-test from our own Bankr wallet) | `safe-to-lp?pool=NVDA`, $0.005 USDC, settled on Base in [`0x309ddc0c…6708`](https://basescan.org/tx/0x309ddc0cbc51eccddf649fa001a25ecdc049179e402bc6dad91e798c8c8e6708) (2026-09-19 06:20 UTC). Payer and payee are both DeltaDesk's wallet `0xd8d5…34cd`: it proves the x402 path settles end to end, not outside demand |
| Bankr skill | [`skills/lp-truth/`](skills/lp-truth/SKILL.md). PRs to BankrBot/skills: `lp-truth` https://github.com/BankrBot/skills/pull/729, `hood-stock-lp ledger` https://github.com/BankrBot/skills/pull/730, `aero-stock-lp ledger` https://github.com/BankrBot/skills/pull/731 |
| Desk contracts on Robinhood Chain (4663), deployed 2026-09-19 14:43 UTC. All three source-verified on **Sourcify**, full match, creation + runtime (verify with `forge verify-contract --verifier sourcify`); Blockscout mirrors Sourcify and today shows the banner on two of the three, so the Sourcify link is the one that proves it for each | `DeskLaneFactory` [`0x6968B97974aF2ba51537e751c043d5ba48d663B3`](https://robinhoodchain.blockscout.com/address/0x6968B97974aF2ba51537e751c043d5ba48d663B3) ([Sourcify](https://repo.sourcify.dev/4663/0x6968B97974aF2ba51537e751c043d5ba48d663B3)) · `ChainlinkFence` [`0xc82Cc6A466b7fE32e822A7dA59E7D9d7b726C1ea`](https://robinhoodchain.blockscout.com/address/0xc82Cc6A466b7fE32e822A7dA59E7D9d7b726C1ea) ([Sourcify](https://repo.sourcify.dev/4663/0xc82Cc6A466b7fE32e822A7dA59E7D9d7b726C1ea) — Blockscout has not picked this one up) · `DeskLaneV3` implementation [`0xBf5f4880B2f569656E913d225bcF4810Dcc4EDD9`](https://robinhoodchain.blockscout.com/address/0xBf5f4880B2f569656E913d225bcF4810Dcc4EDD9) ([Sourcify](https://repo.sourcify.dev/4663/0xBf5f4880B2f569656E913d225bcF4810Dcc4EDD9)) ([`contracts/deployments/4663.json`](contracts/deployments/4663.json)) |
| The user's lane (lane A, NVDA/USDG) | [`0x7f8968734E613f509991D3392074CF7f1e4bd662`](https://robinhoodchain.blockscout.com/address/0x7f8968734E613f509991D3392074CF7f1e4bd662), created by the user's Vault in [`0x0e104b50…a158`](https://robinhoodchain.blockscout.com/tx/0x0e104b50393b85a91509cd18a583f4c340f3a56430f14d6349c42efe6e34a158) and funded in [`0xb752721c…26e8`](https://robinhoodchain.blockscout.com/tx/0xb752721c10d72aa7a6f0a4e7a1a58cbe6b47f3cb68a021e871013c6980d826e8) (25.8 USDG) and a bounded USDG→NVDA swap straight into the lane, [`0x15d6667e…906c`](https://robinhoodchain.blockscout.com/tx/0x15d6667e38b7da82ab66c4c41d57f39f6743e56ba0e739cbe2fc80a64e53906c) (0.1123 NVDA); ≈ $50.75 in total |
| The agent's on-chain decision | A delegated `signal()` `LaneAction` for the weekend gate: [`0xddbc1b92…7375`](https://robinhoodchain.blockscout.com/tx/0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375) (weekend: market closed) and [`0xbe80e98b…3223`](https://robinhoodchain.blockscout.com/tx/0xbe80e98beb80f8f87275b01568fd451fe4ceea35881fe74c106e2826ed083223) (fair value restored), each with a `reasonHash` whose preimage is recorded |
| Dynamic policy denial of a staged malicious transfer request (the call a prompt injection would try), sent straight to the delegated signer | Dynamic's policy API refuses Robinhood Chain (`Unsupported chainIds for EVM: 4663`), so on 4663 the lane contract and the agent's ABI are the fence. On Base, an environment rule (allowlist = the lane address) made Dynamic's co-signer refuse the delegated Operator's staged USDC transfer (the session was dropped after 61.6 s, nothing signed), while the same key signed an allowed destination in 2.3 s: [docs/m2-desk.md §3](docs/m2-desk.md) |
| Start a desk / desk agent | https://web-production-10951.up.railway.app/desk · https://desk-agent-production-71b1.up.railway.app/health |
| Sign-in environment | Sign-in uses Dynamic's **sandbox** environment, so their widget shows a Sandbox badge. Only the sign-in environment is a sandbox. The Vault and the Operator are real embedded wallets, the delegation is real, and every transaction above is real and landed on Robinhood Chain 4663 — the lane, its funding and the agent's `signal()` calls are all linked here and readable on the explorer |
| Demo video | https://youtu.be/pjpZgsKzxQY |

Every 4663 on-chain value above — the deployment, the lane, its funding and the agent's decisions — is recorded, with
its explorer link, in [`docs/m2-desk.md`](docs/m2-desk.md).

## What we found

**Data.** 3.41M swaps and $1.09B of volume, from each pool's launch to 2026-09-20:

- NVDA/USDG on Uniswap v3;
- SPY/USDG, TSLA/USDG and QQQ/SPY on Uniswap v4.

**Findings**, read off the live [Study](https://web-production-10951.up.railway.app/study) on 2026-09-20. The pipeline
recomputes every 10 minutes and never stops, so the live page's totals run a little ahead of the numbers below and its
ratios drift by a hundredth or two.

- **NVDA/USDG LPs earned $371.8k in fees; informed flow took back $289.1k** (vs Hyperliquid, 1h). Edge 1.29: LPs keep
  money, but barely.
- **Regular hours are a losing game** (edge 0.92). The Monday 09:00 ET hour runs at 0.25.
- **Weekends pay** (edge 3.97), but self-markouts overstated that edge: by 24% at 1h and 2.6× at 5m.
- **Three bot operators account for 98.4% of NVDA LPs' net losses to informed flow.**
  - Hyperliquid-arbitrage bots pay 37% of fees and take 66% of the positive value picked off.
  - Retail and aggregator flow pays LPs.
- **Only 39.8% of NVDA positions beat holding.**
  - The League's best manager earns +$193 per $1k·day.
  - Its worst, the most active re-ranger, gives informed flow $174 for every $52 of fees.
- **Every dollar reconciles:**
  - Attributed fees conserve pool fees exactly.
  - 1,938 fully collected (NFT-burned) positions of $1k or more match on-chain collects within 1 bp.
  - Golden positions match within 0.0011 bp.
- **On Aerodrome (Base), emissions are what pay LPs.**
  - NVDAc/USDC swap fees cover 0.98× what informed flow takes.
  - 83% of fees go to veAERO voters.
  - Fees kept plus AERO received cover it 1.25×.
  - AERO attributed to positions equals AERO distributed, exactly. For the 467 wallets with nothing still staked,
    computed AERO matches on-chain claims plus penalties within 4e-8.
- **Honest negative result:** a fair-value gap rule tuned in-sample failed out of sample (−$128). The simple reopen
  guard was the only rule positive in both periods.

Full write-ups: [docs/m1-truth-study.md](docs/m1-truth-study.md) (M1) · [docs/m0-killtest.md](docs/m0-killtest.md) (M0).

## How it answers Igor's question

**Pool level.** In NVDA/USDG, for every $80 of fees, about $62 was picked off by informed flow at 1h. Most of it went
to three operators.

**Position level.** The tearsheet splits any wallet's LP positions into:

- fees kept, plus AERO on Aerodrome;
- value picked off by informed flow (Hyperliquid-referenced 1h markout);
- impermanent loss vs holding, stock price P&L and gas;
- net, per position and per $1k;
- a reconciliation residual against on-chain collected fees.

Two positions from the M1 golden set:

| Position (Aerodrome NVDAc/USDC) | Fees | AERO | Informed flow (1h) | vs holding |
|---|---|---|---|---|
| `npm:5677798`, unstaked, 7.8 days | kept $927.61 (90% of a $1,030.68 fee share) | none | $4,454 | **−$25.5k** |
| `npm:5131951`, staked | $465 fee share, all to veAERO voters | 1,869 AERO ($917) | $42 | **+$899** |

**Inside Igor's own skills.** A `ledger` command is proposed as PRs to Bankr's `hood-stock-lp` (stacked on Igor's
open PR #670, where that skill lives today) and `aero-stock-lp`
([`docs/notes/skill-prs.md`](docs/notes/skill-prs.md)). Once merged, Bankr users get the same breakdown in chat. It
costs $0.05 over x402, and a failed call is not charged.

**Before the trade.** `safe-to-lp` turns the same history into ALLOW / CAUTION / BLOCK
([`assess`](engine/api/app.py#L128)):

- **BLOCK:** the reopen guard (09:20–09:45 ET, the one rule positive out of sample), and hours where informed flow
  historically took more than twice the fees.
- **CAUTION:** closed-market weekends and holidays, the evening session wake, losing hours, a dead Chainlink feed, and a
  fair-value gap. The gap threshold is unvalidated (the gap rule failed out of sample), so a gap alone never blocks.

## Product

| Surface | What it does | Access |
|---|---|---|
| **Truth Study** | Pool × regime × hour-of-week fee vs picked-off heatmaps; the Flow X-ray (who takes LP money) | Public web + `/study`, `/study/table/*` |
| **Tearsheet** | Paste a wallet on Robinhood Chain or Base (Aerodrome, staked or unstaked). Returns fees kept, AERO, picked off (vs HL), IL vs HODL, price P&L, gas and net, each per $1k, plus a reconciliation residual | `/tearsheet/{robinhood\|base}/{wallet}` (x402, $0.05) |
| **LP League** | 1,018 LP managers ranked by result vs holding per $1k·day, with strategy fingerprints | `/lp-league` (x402, $0.02) |
| **Safe to LP?** | ALLOW / CAUTION / BLOCK from the market regime, the open guard, this hour's historical toxicity, the gap to HL fair value and oracle health | `/safe-to-lp/{pool}` (x402, $0.005) |
| **Fair value** | HL 24/7 price × a session-calibrated basis, vs the pool mid and Chainlink (frozen on weekends) | `/fair-value/{pool}` (public) |
| **`lp-truth` skill** | Bankr skill that calls the endpoints above over x402 | [skills/lp-truth/](skills/lp-truth/SKILL.md) |
| **`ledger` in Bankr's LP skills** | Fees vs informed flow vs IL, per $1k, inside `hood-stock-lp` and `aero-stock-lp` | Proposed as PRs to BankrBot/skills, see [docs/notes/skill-prs.md](docs/notes/skill-prs.md) |
| **The desk** | Per-user lane contracts on 4663 run by a delegated agent; Start a desk; owner controls; guardian watchdog | [/desk](https://web-production-10951.up.railway.app/desk) (Start a desk), [contracts/](contracts/), [agent/](agent/README.md), `web/app/desk/` |

Paid endpoints are Bankr x402 Cloud handlers ([x402/](x402/), [bankr.x402.json](bankr.x402.json)) that proxy to the
API with a server key. Invalid input and upstream errors return 4xx/5xx, so callers are never charged for a failed
call.

## The desk

### Custody: Vault ≠ Operator

- **Two Dynamic embedded wallets per user, both created in "Start a desk".**
  - The **Vault** owns the lane and is never delegated. It receives every withdrawal: apart from the lane's own NPM
    positions, value can leave the lane only to the Vault.
  - The **Operator** is delegated to DeltaDesk through Dynamic Delegated Access and holds only gas.
- **Why two wallets.** Dynamic policies filter chain, address and value, not function selectors. An agent delegated
  on the owner's own wallet could call every owner-only function. So the factory refuses `operator ∈ {0, owner}`.
- **The Dynamic policy on the Operator:**
  - chain 4663;
  - allowlist = the lane address, predicted before deployment;
  - value 0;
  - `blockExport`.
- **The contract's hard limit.** Even a fully compromised Operator can only call the lane's operator functions, and
  the lane can pay only its owner.
- **The guardian** is a third, separate key held by the watchdog service. It can pause, reduce or flatten positions
  (`reduce`, `exitAll`) and extend a closure, and nothing else.

### What the lane enforces on-chain

These rules live in `DeskLaneV3`, built on `DeskLaneCore`.

**Roles.**

- **Owner only:** `withdraw`, `withdrawAll`, `withdrawPosition` (the NFT escape hatch), `unpause`, operator changes,
  cap changes and `setGuardian`.
  - A new operator and looser caps wait 24 h.
  - Revoking the operator and tightening caps are instant.
  - `setGuardian` is instant on purpose: the guardian can only reduce risk.
- **Operator or owner:**
  - `rerange` (unwind, then mint up to 2 ranges from the lane's own inventory, never a swap);
  - `reduce`, `collect`, `exitAll`, `pause`;
  - `signal`, an event-only decision log.

**Checks on every call.**

- Every operator action carries a `decisionId`, spent once, and a deadline no more than 120 s ahead.
- **Placement fence.** Ranges must sit on the correct side of a Chainlink reference tick, within 100 bp. Decimals are
  read live, because the feed changed from 18 to 8 decimals on Jun 23.
- **Tick guard.** At execution, `slot0` must be within 10 ticks of the tick the agent planned against.

**When risk-adding is refused.**

- the lane is paused;
- the stock closed window, Sat 00:00 → Mon 01:00 UTC;
- the owner's or guardian's `closedUntil` flag is set;
- Chainlink `oraclePaused` is set;
- the feed is dead: older than 26 h, an answer ≤ 0, or a future timestamp;
- a stock-split multiplier change takes effect within 2 h.

**Caps for lane A.**

- $60 per rerange and $150 of turnover per day;
- at most 4 reranges per hour and 24 per day;
- at least 5 minutes between reranges.

**What the lane never does.** Approvals go to the NPM only, for exact amounts, and are reset to 0 in the same call.
There is no `receive`, no `onERC721Received` and no generic `execute`.

### Test evidence ([`contracts/reports/`](contracts/reports/))

- **Local suite** (real Uniswap v3 factory + NPM artifacts, mock tokens and feeds):
  - 177 tests pass.
  - The invariant campaign ran 1,000 runs × depth 100 (100,000 handler calls). An evil operator and an attacker
    acted after every step. Violations of I1–I14: all 0.
  - Negative tests N1–N11 pass.
  - A mutation check shows every seeded bug is killed.
- **Fork suites against the Robinhood Chain archive**, at pinned Fri and Sat blocks:
  - 5 suites, 23 tests, all passing.
  - `ForkFiftyReranges`: 50 of 50 reranges on the real NVDA/USDG pool.
  - Fork invariants: 50 runs × depth 20, with I1–I14 at 0.
- **The invariants include:**
  - I1: funds leave only to the owner or into the lane's own NPM mints.
  - I2: the owner can always exit, whatever the oracle says.
  - I7: loss is bounded under an evil operator plus an attacker.
  - I10: the placement fence holds at every mint.
  - I11: no risk-adding while closed or paused.
- **Engine:** 133 pytest tests pass.
- **Agent:** unit, property and wiring suites, including 22 `createDaemon` safety proofs. The fork e2e pins the real
  Saturday block with live Chainlink feeds, and there the agent signs nothing that adds risk. See
  [agent/README.md](agent/README.md).

### The agent (`agent/`)

**The tick** (every 5 s, per lane): sense → regime and gates → deterministic strategy → plan critic → build and
simulate → guard → approval → execute → record.

**The guard** evaluates 25 rules, all of them, fail-closed. Among them:

- **allowlist:** `to` = this lane, and the selector is an operator function;
- **signer binding:** signer = on-chain operator ≠ owner;
- idempotency, caps, turnover, the regime gate, the cost hurdle and simulation.

**The executor** writes the attempt row first. It signs through the Dynamic delegated signer, then verifies that the
parsed raw transaction equals the request and that the signature recovers to the Operator. Only then does it persist
the bytes and broadcast. After a crash it rebroadcasts the stored bytes and never re-signs.

**The LLM is never on the execution path.** Its overlay can only tighten a plan, and it is off in M2. The
`withdraw*` and admin functions cannot be expressed in the agent's action type at all.

**The watchdog** holds the guardian key only. It cross-checks every operator `LaneAction` with the agent, and pauses
on a foreign action, a value drop the market doesn't explain, a revert streak, low operator gas or a missing
heartbeat.

**Honest economics.** A typical rerange costs about **$0.107** of gas: 653,487 gas, measured on an anvil fork of 4663
against the real pool and NPM, at the live 4663 base fee of 0.0618 gwei. The cost hurdle is stricter than that. It
budgets 1.2M gas at 2× the base fee (≈ $0.392) and asks the expected fees to clear 2× that budget, ≈ $0.783. Against
the pool's real hour-of-week fee record, that makes a rerange worth it above these lane sizes:

| Hour of the week | Break-even lane size |
|---|---|
| Typical (median to mean hour), hurdle as implemented | ≈ $26–37k |
| Best hour, hurdle as implemented | ≈ $4.3k |
| Best hour, if the hurdle priced the measured gas at the base fee | ≈ $1.2k |

So a ~$50 lane can't afford to rerange at any hour of the week. It mints once and keeps its first 200-tick range
(about 2% of price wide; the width is fixed, it does not grow for small lanes) until an exit. The numbers are in
[agent/README.md, "Economics at M2 size"](agent/README.md#economics-at-m2-size).

## Architecture

```
Robinhood Chain 4663 ─┐  Envio HyperSync   ┌─ decode swaps (v3 + v4, protocol fee removed)
Base 8453 (Aerodrome) ┘  (logs + txs)      ├─ HL-referenced markouts  F = HL · k(prior session)
Hyperliquid trade.xyz ─  candles + 1s tape ┼─ positions: segments × swaps range join → fees, picked off, IL, gas
Robinhood /rhj quotes ─  1s tape           ├─ Flow X-ray: wallet → operator → label
Chainlink (4663)      ─  rounds            └─ gap-exclusion backtest (train Jul 28–Aug 31, test Sep 1–18)
                                                    │
                        FastAPI (Railway, refresh every 10 min) → Next.js web · x402 handlers · Bankr skills
                                                    │ slow parameters (basis k, hour-of-week record)
                                                    ▼
desk-agent (Railway): sense → regime/gates → strategy → critic → guard → approval → executor
      │ Dynamic delegated signer (Operator wallet)                         ▲ copilot approvals (web / Telegram)
      ▼                                                                   │
DeskLaneFactory ── DeskLaneV3 clone per lane (owner = Vault) ── Uniswap v3 NPM ── NVDA/USDG pool
      ▲ ChainlinkFence (placement fence, closed window)          desk-watchdog (guardian key: pause / exit)
```

## Status and roadmap

**Built and live:** the truth layer (M0–M1):

- data, attribution, Study, Tearsheet, League and API;
- the web app;
- 5 x402 endpoints, with a settled call on Base (our own self-test);
- the `lp-truth` skill;
- Aerodrome tearsheets, staked and unstaked.

**Built and tested:** the desk code (M2):

- contracts with local and fork campaigns;
- the agent with guard, executor, Dynamic signer, webhook and watchdog;
- the Start a desk wizard and owner controls.

**This weekend (Sat Sep 19 – Sun Sep 20), inside the closed window.** The desk refuses to add risk on weekends by
design, and the contract enforces it: the closed window runs Sat 00:00 → Mon 01:00 UTC. So the weekend's on-chain
evidence is:

- the contracts, deployed and verified (done, Sep 19 14:43 UTC; addresses above);
- the user's lane, created by their Vault and funded;
- the Dynamic-delegated Operator;
- the agent's first on-chain decision, a delegated `signal()` for the weekend gate;
- a recorded Dynamic policy denial.

**Next, posted as updates:**

- **Mon Sep 21, regular session:** the first live delegated mint (~$50, copilot) with its matched `LaneAction`,
  then an owner Exit & withdraw from `/desk`, and the M1 regular-session reconciliation re-run.
- **M3, lanes and a live weekend:**
  - lane B hedged on Hyperliquid;
  - lane C on QQQ/SPY (Uniswap v4);
  - the BOUND-PINNED and wrapper-premium gates;
  - a fully automated weekend, Sep 25–28.
- **M5, the $DESK treasury:**
  - $DESK launched through Bankr, paired with SPY on Robinhood Chain;
  - its fees fund an auditable house lane and the desk's inference.
  - Stock-quoted launches are refused while the feed is stale, so the launch waits for a weekday.

## Tracks

- **Bankr grand prize, plus the onchain-equities bonus.**
  - A product for everyone who LPs tokenized stocks, Bankr's own LP skills included.
  - x402 Cloud endpoints with a settled call (our own self-test), and the `lp-truth` skill.
  - `ledger` proposed as PRs to Igor's `hood-stock-lp` and `aero-stock-lp`, with credit.
  - Bankr LLM Gateway as the agent's LLM endpoint (its tighten-only overlay ships off in M2).
  - $DESK via Bankr next.
- **Uniswap.**
  - v3 and v4 pools on Robinhood Chain, read end to end: `Swap`, `Mint`/`Burn`/`Collect`, NPM and POSM events,
    `feeGrowthGlobal`, StateView.
  - `DeskLaneV3` mints and manages v3 NPM positions.
  - Developer feedback in [FEEDBACK.md](FEEDBACK.md). Code pointers below.
- **Dynamic.**
  - Delegated Access on a separate Operator embedded wallet, with the user keeping the Vault.
  - The agent's decision becomes a transaction on 4663: [`0xddbc1b92…7375`](https://robinhoodchain.blockscout.com/tx/0xddbc1b92b20332ddee6e2ec587e27246021c42b2b51444e848fab7e0d4fe7375) (weekend: market closed) and [`0xbe80e98b…3223`](https://robinhoodchain.blockscout.com/tx/0xbe80e98beb80f8f87275b01568fd451fe4ceea35881fe74c106e2826ed083223) (fair value restored), each with a `reasonHash` whose preimage is recorded.
  - A policy denial on camera, of a staged malicious transfer request: Dynamic's policy API refuses Robinhood Chain (`Unsupported chainIds for EVM: 4663`), so on 4663 the lane contract and the agent's ABI are the fence. On Base, an environment rule (allowlist = the lane address) made Dynamic's co-signer refuse the delegated Operator's staged USDC transfer (the session was dropped after 61.6 s, nothing signed), while the same key signed an allowed destination in 2.3 s: [docs/m2-desk.md §3](docs/m2-desk.md).
  - SDK call pointers are below.

## Code pointers

| What | Where |
|---|---|
| **Contracts** | |
| Lane rerange: unwind, fence, mint from inventory | [`DeskLaneV3.rerange`](contracts/src/DeskLaneV3.sol#L55) |
| Execution-time tick guard (`slot0` vs the planned tick) | [`DeskLaneV3._placement`](contracts/src/DeskLaneV3.sol#L150) |
| Placement fence rule | [`RangeRules.check`](contracts/src/libraries/RangeRules.sol#L28) |
| NPM mint with exact approvals reset to 0 | [`DeskLaneV3._mintRange`](contracts/src/DeskLaneV3.sol#L232) |
| Exit that tolerates a paused token | [`DeskLaneV3.exitAll`](contracts/src/DeskLaneV3.sol#L123) |
| decisionId spent once, deadline window | [`DeskLaneCore._spend`](contracts/src/DeskLaneCore.sol#L415) |
| Risk-adding admission (closedUntil, fence codes, rate buckets) | [`DeskLaneCore._admitRiskAdding`](contracts/src/DeskLaneCore.sol#L427) |
| Event-only agent decision (the weekend `LaneAction`) | [`DeskLaneCore.signal`](contracts/src/DeskLaneCore.sol#L115) |
| Owner-only payouts | [`DeskLaneCore.withdraw`](contracts/src/DeskLaneCore.sol#L159) |
| Oracle status codes (feed dead, oraclePaused, corporate action, closed) | [`ChainlinkFence.status`](contracts/src/ChainlinkFence.sol#L67) |
| Closed window, Sat 00:00 → Mon 01:00 UTC | [`ChainlinkFence.isClosedWindow`](contracts/src/ChainlinkFence.sol#L91) |
| Lane creation: v3 `getPool` check, operator ≠ owner, caps ≤ ceilings, CREATE2 salt over every param | [`DeskLaneFactory.createLane`](contracts/src/DeskLaneFactory.sol#L78) |
| Invariants I1–I14 and the attacker handler | [`contracts/test/invariant/`](contracts/test/invariant/) |
| **Agent** | |
| The guard (25 rules, fail-closed) | [`checkGuard`](agent/src/guard/guard.ts#L83) |
| Guard: allowlist (lane + operator selectors only) | [`guard allowlist`](agent/src/guard/guard.ts#L157) |
| Guard: signer binding (signer = operator ≠ owner) | [`guard signer-binding`](agent/src/guard/guard.ts#L576) |
| Executor: sign → verify → persist, then broadcast | [`signVerifyPersist`](agent/src/executor/rh-executor.ts#L168) |
| Signed tx verification (parsed == request, recovers to the Operator) | [`verifySignedTx`](agent/src/signer/types.ts#L46) |
| Dynamic delegated signer (`delegatedSignTransaction`) | [`createDelegatedSigner`](agent/src/signer/dynamic-delegated.ts#L73) |
| Dynamic SDK wiring (`createDelegatedEvmWalletClient`) | [`createDynamicDelegatedSigner`](agent/src/signer/dynamic-delegated.ts#L146) |
| Webhook: HMAC check of `x-dynamic-signature-256` | [`verifyDynamicSignature`](agent/src/http/dynamic-webhook.ts#L60) |
| Webhook: `decryptDelegatedWebhookData` (RSA), vault sealing, Vault refused | [`webhook decrypt`](agent/src/http/dynamic-webhook.ts#L294) |
| Regime and gate machine | [`createGateMachine`](agent/src/regime/machine.ts#L69) |
| Session calendar (agent port, fixture-exact with the engine) | [`regimeAt`](agent/src/market/calendar.ts#L174) |
| Cost hurdle (2× gas + expected cost) | [`costHurdle`](agent/src/strategy/hurdle.ts#L19) |
| Copilot / advisory approvals | [`decideApproval`](agent/src/approval/gate.ts#L186) |
| reasonHash preimage (canonical JSON) | [`reasonHashOf`](agent/src/canonical.ts#L71) |
| Watchdog actions (pause / flatten) | [`plannedActions`](agent/src/watchdog/rules.ts#L149) |
| **Engine and API** | |
| Swap decoder (v3 pool-side, v4 swapper-side) | [`decode_swaps`](engine/markout/pools.py#L99) |
| LP share after the v3 `feeProtocol` / v4 protocol fee | [`pools.py fee split`](engine/markout/pools.py#L177) |
| Market calendar and regimes | [`regime_at`](engine/markout/calendar.py#L60) |
| Fair value: basis `k` calibrated on the last completed session (no look-ahead) | [`calibrate_k`](engine/markout/hl_ref.py#L235), [`k_at`](engine/markout/hl_ref.py#L258) |
| HL-referenced markouts | [`mark_swaps`](engine/markout/hl_ref.py#L284) |
| Position attribution: feeGrowth sweep, per-step shares `ℓ/L`, split across tick crossings (double-double) | [`sweep`](engine/positions/attribute.py#L146) |
| NPM tokenId ↔ ticks via same-tx events; v4 POSM salt = tokenId | [`reconstruct_v3 linkage`](engine/positions/reconstruct.py#L338), [`reconstruct_v4`](engine/positions/reconstruct.py#L397) |
| HyperSync `JOIN_ALL` over LP transactions | [`SPECS["lp_txs"]`](engine/indexer/hs_backfill.py#L79) |
| Fee reconciliation vs `feeGrowthGlobal` (0.27% / exact, over a 345-swap live window) | [engine/indexer/reconcile.py](engine/indexer/reconcile.py) |
| Tearsheet and its reconciliation residual | [`tearsheet`](engine/positions/tearsheet.py#L86) |
| Flow X-ray labels (deterministic rules) | [`rule_exprs`](engine/flow/labels.py#L64) |
| Gap-exclusion backtest | [`gap_exclusion.run`](engine/backtest/gap_exclusion.py#L477) |
| LP League score | [`league.build`](engine/league/build.py#L27) |
| Aerodrome: pool study; staked/unstaked fees, AERO reward sweep, penalties | [engine/aero/study.py](engine/aero/study.py), [engine/aero/positions.py](engine/aero/positions.py) |
| `/safe-to-lp` decision function | [`assess`](engine/api/app.py#L128) |
| v3 `slot0` / v4 `StateView.getSlot0` pool mids | [`pool_mid`](engine/api/live.py#L90) |
| 1-second tape recorder (HL bbo/ctx/trades, Robinhood quotes, corporate actions) | [recorder/tape.mjs](recorder/tape.mjs) |
| Refresh pipeline | [engine/pipeline/refresh.py](engine/pipeline/refresh.py) |
| **x402 and skills** | |
| x402 tearsheet handler (errors pass through, so no charge) | [`x402 tearsheet`](x402/tearsheet/index.ts#L10) |
| x402 safe-to-lp handler | [`x402 safe-to-lp`](x402/safe-to-lp/index.ts#L11) |
| `lp-truth` formatter | [skills/lp-truth/scripts/report.mjs](skills/lp-truth/scripts/report.mjs) |

Uniswap surfaces used:

- the v3 pool: `Swap`, `Mint`, `Burn`, `Collect`, `Flash`, `SetFeeProtocol`, `slot0`, `feeGrowthGlobal`;
- the v3 factory's `getPool`;
- NonfungiblePositionManager: `mint`, `decreaseLiquidity`, `collect`, `burn`, `IncreaseLiquidity`,
  `DecreaseLiquidity`, `Collect`, `Transfer`;
- the v4 PoolManager: `Swap`, `ModifyLiquidity`;
- PositionManager: `Transfer`, with salt = tokenId;
- StateView `getSlot0`;
- SwapRouter02, in the fork tests.

## Run it

```bash
cp .env.example .env              # ENVIO_API_TOKEN=…  (DELTADESK_API_KEY optional: gates premium routes)
node recorder/tape.mjs &          # optional: 1-second tape
cd engine && uv sync
uv run python -m indexer.hs_backfill && uv run python -m indexer.hl_candles
uv run python -m markout.study && uv run python -m markout.hl_ref
uv run python -m positions.attribute && uv run python -m league.build
uv run python -m flow.xray && uv run python -m backtest.gap_exclusion
uv run python -m aero.study && uv run python -m aero.positions        # Base / Aerodrome
uv run python -m pytest tests -q  # 133 tests (32 of them need the pipeline output above; they skip without it)
uv run uvicorn api.app:app --port 8787
cd ../web && npm i && DELTADESK_API=http://127.0.0.1:8787 npm run dev
```

Or run everything in one container. This runs the recorder, the refresh loop and the API together:

```bash
docker build -t deltadesk .
docker run -p 8787:8787 -e ENVIO_API_TOKEN=… -v $PWD/data:/app/data deltadesk
```

The desk:

- `cd contracts && ./setup.sh && forge test` (177 tests; `setup.sh` fetches the pinned `lib/` and `node_modules/`,
  which are not committed), and `FOUNDRY_PROFILE=fork forge test` with an archive RPC;
- `cd agent && pnpm install && pnpm typecheck && pnpm test`.

Run modes and the Docker targets for `desk-agent` and `desk-watchdog` are in [agent/README.md](agent/README.md).

MIT ([LICENSE](LICENSE), [NOTICE](NOTICE)). Informational analytics, not investment advice.
