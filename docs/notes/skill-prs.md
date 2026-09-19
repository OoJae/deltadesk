# BankrBot/skills PRs (ready to paste)

We prepared three local branches in `../bankr-skills`, a clone of https://github.com/BankrBot/skills. Nothing is
pushed yet. Each branch has one commit, with no attribution lines.

| Branch | Base | Commit | Adds |
|---|---|---|---|
| `deltadesk/lp-truth` | `main` (9b6be8d) | `cb9e673` | the `lp-truth/` skill |
| `deltadesk/hood-stock-lp-ledger` | `add/hood-stock-lp`, the head of Igor's open PR #670 (9657945) | `ffef261` | `ledger` in `hood-stock-lp` |
| `deltadesk/aero-stock-lp-ledger` | `main` (9b6be8d) | `baa311d` | `ledger` in `aero-stock-lp` |

**How we checked them.** The repo has no CI and no linters. Its only published rule is that `catalog.json` must be
valid, with `slug` equal to the folder name. Every catalog on each branch passes that rule. Each skill's own selftest
passes:

| Skill | `node scripts/selftest.mjs` | `--live` (read-only, free) |
|---|---|---|
| lp-truth | 18/18 | 23/23 |
| hood-stock-lp | 60/60 | 124/124 |
| aero-stock-lp | 48/48 | 75/75 |

Before the ledger work, the baselines were 42 checks for hood-stock-lp and 34 for aero-stock-lp.

**To open them** (needs the user's OK; run from `../bankr-skills`, with a fork of BankrBot/skills under your
account):

```bash
gh repo fork BankrBot/skills --remote --remote-name fork   # once
git push fork deltadesk/lp-truth deltadesk/hood-stock-lp-ledger deltadesk/aero-stock-lp-ledger
gh pr create -R BankrBot/skills --base main --head <you>:deltadesk/lp-truth --title "…" --body-file <body>
gh pr create -R BankrBot/skills --base add/hood-stock-lp --head <you>:deltadesk/hood-stock-lp-ledger --title "…" --body-file <body>
gh pr create -R BankrBot/skills --base main --head <you>:deltadesk/aero-stock-lp-ledger --title "…" --body-file <body>
```

The `hood-stock-lp` PR is stacked on #670, so its diff shows only the ledger commit. If #670 merges first, rebase the
branch onto `main` (`git rebase --onto main 9657945 deltadesk/hood-stock-lp-ledger`) and open it against `main`.

**Before opening:**

- The lp-truth `SKILL.md` describes the engine after the Phase 0 fixes: a fair-value gap alone gives CAUTION, never
  BLOCK. It also names the earlier build (`thresholds.source: "provisional"`), which can BLOCK on the gap alone, and
  tells the agent to follow whatever verdict comes back.
- The live `core` API does not have those fixes yet. On 2026-09-19 (checked again at 15:30 UTC) `GET /basis/NVDA`
  returned 404, and the first settled `safe-to-lp` response carried `thresholds.source: "provisional"`.
- So redeploy `core` before the `lp-truth` PR goes up. Then check that `/basis/NVDA` answers 402 and that a
  `safe-to-lp` response shows `thresholds.source` starting with `"unvalidated"`. The README's "Before the trade"
  note about the earlier build can then say it was replaced.

---

## PR 1: `lp-truth`

**Title**

```
Add lp-truth skill: is it safe to LP this stock pool now, and what did my LP really earn?
```

**Body**

````markdown
## What

`lp-truth` is DeltaDesk's LP truth layer for tokenized-stock pools. Your Bankr agent pays for it per call over x402
(USDC on Base, $0.002–$0.05), and failed calls are not charged.

| Service | Price | What the agent gets |
|---|---|---|
| `safe-to-lp?pool=NVDA` | $0.005 | ALLOW / CAUTION / BLOCK for Robinhood Chain NVDA, SPY, TSLA, QQQ/SPY: market regime, the 09:20–09:45 ET open guard, this hour-of-week's historical toxicity, gap to Hyperliquid-derived fair value |
| `fair-value?pool=SPY` | $0.002 | 24/7 fair value (Hyperliquid × a session-calibrated basis) vs the pool mid and Chainlink (frozen on weekends) |
| `pool-toxicity?pool=TSLA` | $0.01 | LP edge (fees ÷ value picked off by informed flow) by regime and hour of week |
| `tearsheet?wallet=0x…&chain=robinhood\|base` | $0.05 | any wallet's LP positions (Uniswap v3/v4 on Robinhood Chain, Aerodrome NVDAc/USDC on Base, staked or not): fees, AERO, informed flow, IL vs holding, gas, net, per $1k, plus the fee reconciliation residual |
| `lp-league?limit=20` | $0.02 | LP wallets ranked by result vs holding per $1k per day |

## Why

LP fees on stock pools look great until you subtract what informed traders take back.

- **NVDA/USDG on Robinhood Chain** (every swap, launch to Sep 18): LPs earned $362.9k in fees, and flow that knew
  where the price was going took back $289.5k, marked against Hyperliquid 1h later.
- **The worst hour.** In the Monday 09:00 ET hour, informed flow takes about $4 for every $1 of fees.
- **Aerodrome NVDAc/USDC.** Swap fees cover 0.97× of informed flow; AERO emissions are what make it pay (1.22×).

This is the question Igor asked: *"If I made $80 in fees but lost $50 to informed flow, that would be good to know."*
The skill answers it before capital goes in (`safe-to-lp`) and after (`tearsheet`).

## How the skill behaves

- **It runs before `hood-stock-lp` adds liquidity.**
  - BLOCK stops the add; removal is always allowed.
  - CAUTION asks for one explicit yes.
  - ALLOW adds no question.
- **It is conservative about what it knows.**
  - The fair-value gap threshold is labelled unvalidated and yields CAUTION only.
  - BLOCK comes from the open guard (the one rule that held out of sample) and from hours where informed flow took
    more than 2× the fees.
- **It makes no yield or APR claims.** Edges are historical. Weekend figures are HL-referenced.
- **It never loops paid calls.** At most one `safe-to-lp` per pool per decision, cached for 60 s.
- **It never invents a verdict when an endpoint errors.**

## Files

- `SKILL.md`, `catalog.json`, `logo.svg`
- `scripts/report.mjs`: a deterministic, zero-dependency formatter for every response.
- `scripts/lib/endpoints.mjs`: the base URL, pools and prices.
- `scripts/selftest.mjs`:
  - 18 offline formatter checks;
  - `--live`: each of the 5 endpoints must answer 402 at its documented price (23 checks; free, nothing is paid).

## Data and method

The data comes from DeltaDesk's open study:

- every swap in these pools from launch, decoded from chain logs (3.34M swaps, $1.07B of volume);
- every position rebuilt: 17,124 on Robinhood Chain and 46,598 on Aerodrome;
- fees reconciled to on-chain collects: golden positions within 0.0011 bp;
- AERO attributed to positions equals AERO distributed, exactly. For the 467 wallets with nothing still staked,
  computed AERO matches on-chain claims plus penalties within 4e-8.

Web: https://web-production-10951.up.railway.app · Repo: https://github.com/OoJae/deltadesk

First settled call (safe-to-lp, $0.005 USDC; a self-test from the DeltaDesk wallet, so payer and payee are the same):
https://basescan.org/tx/0x309ddc0cbc51eccddf649fa001a25ecdc049179e402bc6dad91e798c8c8e6708

Informational analytics, not investment advice.
````

---

## PR 2: `hood-stock-lp` ledger (stacked on #670)

**Title**

```
hood-stock-lp: ledger — fees vs informed flow vs IL, per $1k (DeltaDesk, x402)
```

**Body**

````markdown
Stacked on #670 (@igoryuzo's `hood-stock-lp`). This PR adds one command and changes none of the entry, manage or
exit flows.

## What

`ledger` answers *"I made $80 in fees, how much did informed flow take back?"* for the skill's own positions:

```
node scripts/ledger.mjs url    --wallet 0x…                 # the DeltaDesk tearsheet URL (x402, $0.05)
node scripts/ledger.mjs report --wallet 0x… --in saved.json  # the ledger
```

Real output, for a closed NVDA position from DeltaDesk's golden reconciliation set (wallet elided):

```
Ledger for 0x…… on Robinhood Chain (Uniswap): 1 position, result vs simply holding +$3,198.75.
Fees +$3,210.01 against informed flow −$1,069.15 (edge 3.00); impermanent loss vs holding −$10.77, gas −$0.49.
Per $1k of capital per day: fees +$12.01, informed flow −$4.00, result vs holding +$11.97.
NVDA #286074 closed: fees +$3,210.01, informed flow −$1,069.15 (edge 3.00), vs holding +$3,198.75. Per $1k deployed: +$35.92 vs holding.
1 closed position reconciles to on-chain collected fees within 0.0007 bp.
```

## Design

- **No keys, no paid call inside the script.**
  - Phase 1 prints the URL.
  - The agent pays with Bankr's x402 capability (`bankr x402 call '<url>' --max-payment 0.05`). A failed call is not
    charged.
  - Phase 2 formats the saved JSON.
  - The script never signs, never builds calldata and never moves money, so the skill's confirmation rules are
    untouched.
- **It fails closed.** The script refuses a response that belongs to another wallet or another chain, an error body,
  or non-JSON, and tells the agent to relay the detail once and stop.
- **Coverage is explicit.**
  - DeltaDesk covers this skill's NVDA (v3), SPY and TSLA (v4) markets today.
  - Positions the state file holds in other markets are named as "not in the ledger yet".
  - So are fresh positions DeltaDesk hasn't rebuilt yet (it rebuilds about hourly).
- **It is honest about "informed flow".**
  - Informed flow is a markout: value picked off, marked against Hyperliquid 1h after each swap.
  - It explains the result, and the report says it is not an extra cost on top of it.
  - Flow that lost on price prints as a gain.
- **`--hedge hl`** (adding the Hyperliquid hedge leg: hedge P&L, funding) is documented as coming. The script refuses
  it with a clear message today.

## Files

- `scripts/ledger.mjs` is the CLI.
- `scripts/lib/ledger.mjs` holds pure functions: URL, parse, totals, per $1k, report lines.
- `scripts/lib/ledger-coverage.mjs` maps DeltaDesk pool keys to this skill's markets. Selftest asserts that the pool
  ids equal `markets.mjs`.
- `SKILL.md` gets two command rows and §8 "Ledger".
- `catalog.json` gets one setup line.
- `selftest.mjs`:
  - adds 18 offline ledger checks and 2 read-only live checks (the endpoint answers 402 at $0.05 USDC on Base);
  - `selftest.mjs`: 60/60; `--live`: 124/124.

Credit: @igoryuzo's `hood-stock-lp`. The ledger is built on DeltaDesk's LP truth layer
(https://web-production-10951.up.railway.app, https://github.com/OoJae/deltadesk). Informational analytics, not investment advice.
````

---

## PR 3: `aero-stock-lp` ledger

**Title**

```
aero-stock-lp: ledger — fees + AERO vs informed flow vs IL, per $1k (DeltaDesk, x402)
```

**Body**

````markdown
This PR adds one read-only command to @igoryuzo's `aero-stock-lp`. The entry, manage, route and exit flows are
unchanged.

## What

`ledger` answers *"I made $80 in fees, how much did informed flow take back?"* for the skill's Aerodrome positions,
staked or unstaked:

```
node scripts/ledger.mjs url    --wallet 0x…                 # the DeltaDesk tearsheet URL, chain=base (x402, $0.05)
node scripts/ledger.mjs report --wallet 0x… --in saved.json  # the ledger
```

Real output for a public NVDAc/USDC LP wallet (address elided). Of its 5 positions, 99% of the time was staked:

```
Ledger for 0x…… on Aerodrome (Base): 5 positions, result vs simply holding +$1,260.78.
Fees +$73.80 + AERO +$1,350.41 against informed flow −$179.01 (edge 7.96 incl. AERO); impermanent loss vs holding −$162.63, gas −$0.80.
Per $1k of capital per day: fees +$0.44, AERO +$8.05, informed flow −$1.07, result vs holding +$7.52.
NVDA #5221623 closed: fees +$39.59, AERO +$12.43, informed flow −$17.84 (edge 2.92 incl. AERO), vs holding +$51.93. Per $1k deployed: +$1.15 vs holding.
…
$758.39 of the fee share went to veAERO voters (all fees earned while staked, which is paid in AERO instead, plus the pool's cut of unstaked fees).
5 closed positions reconcile to on-chain collected fees within 0.0000 bp.
```

The route decision (§4, staked vs unstaked) can now be checked after the fact. The ledger shows fees kept, AERO
received and the share that went to voters for each position.

## Design

- **No keys, no paid call inside the script.** The agent pays with Bankr's x402 capability, and a failed call is not
  charged. The script never signs and never moves money, so the single-confirmation contract does not apply to it.
- **It fails closed** on a response for another wallet or chain, an error body, or non-JSON.
- **Coverage is explicit.** DeltaDesk covers NVDA (NVDAc/USDC) today. Held AAPL, GOOGL, META and AERO positions are
  named as not covered yet. Positions opened in the last hour may not be rebuilt yet.
- **The AERO data reconciles.** AERO attributed to positions equals AERO distributed, exactly. For the 467 wallets
  with nothing still staked, computed AERO matches on-chain claims plus penalties within 4e-8. Fees are reconciled to
  collects.

## Files

- `scripts/ledger.mjs`, `scripts/lib/ledger.mjs` and `scripts/lib/ledger-coverage.mjs`. Selftest asserts the pool
  equals `markets.mjs`.
- `SKILL.md` gets two command rows and §10 "Ledger".
- `catalog.json` gets one setup line.
- `selftest.mjs`:
  - adds 14 offline ledger checks and 2 read-only live checks;
  - `selftest.mjs`: 48/48; `--live`: 75/75.

Credit: @igoryuzo's `aero-stock-lp`. The ledger is built on DeltaDesk's LP truth layer
(https://web-production-10951.up.railway.app, https://github.com/OoJae/deltadesk). Informational analytics, not investment advice.
````
