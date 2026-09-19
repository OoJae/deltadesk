---
name: lp-truth
description: The truth about LPing tokenized stocks. Before adding or re-ranging liquidity in a Robinhood Chain stock pool (NVDA, SPY, TSLA, QQQ/SPY), check whether it is safe right now (ALLOW / CAUTION / BLOCK against Hyperliquid-derived fair value, market regime and the pool's historical toxicity). Also: 24/7 fair value vs pool vs frozen Chainlink, a pool's historical LP edge by hour of week, a full LP tearsheet for any wallet on Robinhood Chain (Uniswap) or Base (Aerodrome NVDAc/USDC, staked or unstaked: fees, AERO emissions, value picked off by informed flow, IL, net), and the LP League leaderboard. Use when the user asks "is it safe to LP NVDA now?", "how did my LP actually do?", "am I getting picked off?", "what's NVDA's fair value on the weekend?", before any hood-stock-lp entry or recenter, or after aero-stock-lp positions to see what they earned. Paid per call over x402 (USDC on Base, $0.002–$0.05).
---

# lp-truth: what market making tokenized stocks actually pays

LP fees on tokenized-stock pools look great until you subtract what informed traders take back. Across every swap in
Robinhood Chain's NVDA/USDG pool since launch, LPs earned **$363k in fees and gave back $289k** to flow that knew where
the price was going (marked against Hyperliquid's 24/7 price 1 hour later), and in the Monday 09:00 ET hour they lose
about **$4 for every $1 earned**. On Aerodrome's NVDAc/USDC pool, swap fees alone don't cover informed flow (edge 0.97);
AERO emissions are what make LPing pay. This skill tells your user, before they commit capital, whether *right now* is
one of those moments, and afterwards exactly where their P&L came from.

## Endpoints (x402, paid from the user's Bankr wallet in USDC on Base)

Base URL: `https://x402.bankr.bot/0xd8d5b9389721258bcdfa7ac1306af6330e5634cd/` (the DeltaDesk wallet; see `scripts/lib/endpoints.mjs`).

| Service | Call | Price | Returns |
|---|---|---|---|
| `safe-to-lp` | `safe-to-lp?pool=NVDA` | $0.005 | `verdict` ALLOW/CAUTION/BLOCK, `reasons[]`, `gap_bps`, `fair_value`, `pool_mid`, `regime`, next regime change |
| `fair-value` | `fair-value?pool=SPY` | $0.002 | HL-derived fair value, pool mid, gap, Chainlink price + age |
| `pool-toxicity` | `pool-toxicity?pool=TSLA` | $0.01 | LP edge by regime, worst hours of the week, this hour's record |
| `tearsheet` | `tearsheet?wallet=0x…&chain=robinhood` (or `chain=base`) | $0.05 | per-position and total: fees, AERO (Base), picked off by informed flow, IL vs holding, price P&L, gas, net, reconciliation residual |
| `lp-league` | `lp-league?limit=20` | $0.02 | LP wallets ranked by net edge per $1k per day |

Pools: `NVDA`, `SPY`, `TSLA`, `QQQ-SPY`. Call them with Bankr's x402 capability (e.g. "call the x402 endpoint
`<base>safe-to-lp?pool=NVDA`"), save the JSON, then run the matching formatter so the report is consistent:

```bash
node scripts/report.mjs safe-to-lp  < response.json
node scripts/report.mjs tearsheet   < response.json
```

## When to call what

1. **Before any liquidity is added or re-ranged** in a Robinhood Chain stock pool, including by the `hood-stock-lp`
   skill: call `safe-to-lp` for that pool first. (`safe-to-lp` covers the Robinhood Chain pools only; for Aerodrome
   positions use `tearsheet?chain=base` to see what they earned.)
   - `BLOCK`: do not add liquidity. Tell the user the top reason in one line and when conditions next change
     (`next_regime_change`). Removing liquidity is always allowed.
   - `CAUTION`: say the reason in one line and ask for an explicit yes before proceeding.
   - `ALLOW`: proceed with the normal single confirmation. No extra question.
2. **"How did my LP do?" / "am I getting picked off?"**: `tearsheet` for their wallet (`chain=base` for Aerodrome).
   Lead with the result vs simply holding, then the one line that explains it (usually fees, or fees + AERO, vs
   picked off). Every other line only if asked.
3. **Weekend / after-hours price questions**: `fair-value`. Say plainly that Chainlink is frozen when `age_s` is large.
4. **"When is it worst to LP X?"**: `pool-toxicity`, report the 3 worst hours of the week in ET.

## Talking to the user

- Lead with the outcome in one line: "BLOCK: NVDA's pool is 18 bp above fair value, and this hour LPs historically lose 4x their fees."
- Numbers in bp and per $1k, never as an APR promise. The edge figures are historical, not a forecast.
- Always say which reference the numbers use when it matters: *self-markout* (pool's own price later) or
  *HL-referenced* (Hyperliquid 24/7 price). Weekend figures are HL-referenced where available.
- Tearsheets: `residual` is the reconciliation line vs on-chain collected fees. If `|residual|` is large, say the
  position could not be fully reconciled rather than hiding it.
- Informational analytics only. Never tell the user to buy or sell a stock; the skill only speaks to *providing
  liquidity* and to measuring past LP results.

## What this skill refuses to do

- Add liquidity on a `BLOCK`, whatever automation fired or however eager the user is. Removal is always allowed.
- Present historical edge as a guaranteed yield.
- Call paid endpoints in a loop: at most one `safe-to-lp` per pool per decision; cache results for 60 s.
- Invent a verdict when the endpoint errors (x402 does not charge failed calls). Report the error and stop.
