# The Truth Study (M1): can LPs beat informed flow on tokenized stocks?

*Robinhood Chain (4663), Uniswap v3 NVDA/USDG and v4 SPY/USDG, TSLA/USDG, QQQ/SPY. Every swap from each pool's launch to 2026‑09‑18 (3.34M swaps, $1.07B volume). Fair value comes from Hyperliquid trade.xyz 24/7 prices, scaled by a basis calibrated on each prior regular session. Four modules, each adversarially reviewed; 121 tests.*

## The answer in five lines

1. **LPs keep money, but barely.** In NVDA/USDG, LPs earned **$362.9k** in fees and informed flow took back **$289.5k** (against Hyperliquid, 1h). Edge is **1.25**, about +0.8 bp of volume. For every $80 of fees, about **$64** was picked off.
2. **Regular market hours are a losing game** when marked against Hyperliquid: edge **0.92** at 1h, 0.99 at 5m. The Monday 09:00 ET hour runs at **0.25**; the 09:20–09:45 open at 0.56. The weekend dark window stays profitable (edge **3.50**), but the M0 self-markout overstated it by about 20% at 1h and 2.7× at 5m.
3. **Three operators are the whole problem.** HL-arbitrage bots (887 wallets behind 136 operators) take **66% of all positive picked-off value** while paying 37% of fees; their edge against HL is 0.47. Grouped by operator, **the top 3 take 98.6% of NVDA's net picked-off.** Retail (126,618 wallets) and aggregator flow (32k wallets) *pay* LPs: they lose on price as well as paying fees.
4. **Every dollar reconciles.** Fee attribution to 17,124 positions conserves pool fees exactly (0.0000%), and reconstructed liquidity matches the Swap events on 100% of swaps. Golden positions match on-chain collected fees within **0.0001–0.0011 bp**, and so does every fully collected position ≥ $1k (1,938 of them).
5. **A clever rule didn't beat a simple one out of sample.** Pulling liquidity when the pool strays from HL fair value (thresholds fitted on Jul 28–Aug 31) returned **−$128** on NVDA over Sep 1–18. The **reopen guard** (stepping out 09:20–09:45 and Sunday 19:50–20:15) was the only rule positive in both periods: +$6.9k in train, +$7.8k in test, giving up 7% of fees. Nothing is statistically solid yet; two bad days dominate.

## 1 · HL-referenced markouts (`markout/hl_ref.py`)

- **Method.** `picked_hl(h) = s·q·(F(t+h) − p_ex)`, with `F = HL · k`. `k` is the median pool/HL ratio over the most recent **completed** regular session: no look-ahead, and it absorbs the uiMultiplier and the ETF-vs-index scale.
- **Reference data.** Finest available: live 1 s tape > 1m (from Sep 15) > 5m (Sep 1) > 15m (Jul 28) > 1h.
- **Comparisons are like-for-like.** Self and HL are always compared on the same swaps.

| NVDA/USDG edge (fees ÷ picked) | self | vs HL |
|---|---|---|
| All, 1h | 1.36 | **1.26** |
| All, 5m (Sep 1+) | 2.02 | **1.37** |
| All, 1m (Sep 15+) | 1.62 | **0.90** |
| Regular hours, 1h | 1.00 | **0.92** |
| Weekend dark, 1h | 4.27 | **3.50** |
| Weekend dark, 5m | 8.21 | **3.04** |

- **Short horizons.** Self-markouts understate adverse selection, because the pool *follows* Hyperliquid.
- **Weekends are lumpy.** The Sep 12–13 weekend alone is 72% of weekend picked-off at 1h (edge 1.04 that weekend). The other seven weekends together run at 9.77.
- **Informed-flow indicator** (share of swaps trading toward fair value, 1m-or-finer reference):

| Pool | Regime | Share toward fair value |
|---|---|---|
| NVDA | Extended hours | 55% (63% by volume) |
| NVDA | Overnight | 56% (71% by volume) |
| TSLA | Regular | 76% (88% by volume) |
| SPY | Regular | 72% |

## 2 · Flow X-ray: who takes LP money (`flow/`)

- **Coverage.** 100% of 3,344,479 swaps are joined to their originating wallet (`tx.from`): 161,210 wallets.
- **Labels.** Deterministic, with thresholds in `flow/labels.py`. HL-arb and informed-bot are judged per *operator*, i.e. the wallet fleet behind a private router.

| Label | Wallets | Fee share | Share of positive picked-off (vs HL, 1h) | Net picked-off (vs HL, 1h) | Edge vs HL 1h |
|---|---|---|---|---|---|
| HL-arb | 887 | 37.0% | **66.6%** | +$392.3k | **0.47** |
| Informed bot | 819 | 2.6% | 3.7% | +$23.4k | 0.55 |
| JIT-LP | 4 | 0.1% | 0.2% | +$1.2k | 0.50 |
| Bot / other | 596 | 6.2% | 1.8% | −$34.2k | LPs gain on price |
| Aggregator / shared router | 32,286 | 38.8% | 16.0% | −$41.0k | LPs gain on price |
| Retail | 126,618 | 15.1% | 11.7% | −$5.7k | LPs gain on price |

- **The top three operators** take $91–100k each of 1h picked-off (NVDA/USDG top-3 by operator: 98.6% of net, 52.6% of positive picked-off):
  - router `0x520e…a7aa`: 20 wallets, $90M volume, 1m HL lead 0.64 (z 23);
  - router `0xf7f7…bb78`: 1 wallet, $126M volume, 1m HL lead 0.74;
  - router `0x1e8e…b492`: 300 wallets.
- **Strict JIT liquidity is absent** on these pools. 98.3% of positive picked-off value is labeled; the target was 90%.

## 3 · Positions, tearsheets, LP League (`positions/`, `league/`)

- **Coverage.** 17,124 positions, including 16,785/16,785 NPM mints linked to tokenIds, plus POSM and direct owners. These form 31,218 constant-liquidity segments.
- **Attribution.** Fees and markouts are attributed the Uniswap way: pro rata among liquidity in range at the swap's path, and crossing swaps are split along the path.

| Pool | Fees | Picked HL 1h | IL | vs HODL | Net |
|---|---|---|---|---|---|
| NVDA/USDG | $362.9k | $289.5k | −$234.9k | **+$117.9k** | +$186.2k |
| TSLA/USDG | $86.4k | $32.4k | −$45.0k | +$40.4k | +$31.5k |
| SPY/USDG | $43.6k | $13.9k | −$18.4k | +$24.4k | +$16.6k |

- **Only 39.8% of NVDA positions beat holding.**
- **Tight ranges earn the best edge.** Ranges of 50 ticks or less hold 1.7% of notional-time at edge 1.71 vs HL; 201–1,000-tick ranges hold 41% at 1.11.
- **LP League.** 1,003 qualifying managers, grouped by the wallet sending the LP transactions and ranked by LP result vs holding per $1k·day.
  - **#1** runs 0.2% NVDA/TSLA ranges: +$193/$1k·day, edge 2.45.
  - **Last** is the most active re-ranger (893 positions, 690 re-ranges/day): −$51/$1k·day, with informed flow taking **$174 for every $52 of fees** (edge 0.30).
- **Reconciliation** (v3; v4 settles fees inside `modifyLiquidity` with no fee event):

| Group | Positions | Result |
|---|---|---|
| Golden set | 4 | residual 0.0001–0.0011 bp |
| NFT burned, ≥ $1k | 1,938 | 100% under 1 bp; $0.17 residual on $56.7k of fees |

## 4 · Gap-exclusion backtest (`backtest/`)

| NVDA, TEST Sep 1–18 (out of sample) | fees kept | Δ net vs always-in |
|---|---|---|
| R1 fixed 09:00–10:59 ET | 79% | +$13.0k (all from Sep 2; −$10.4k on the other 17 days) |
| R2 gap vs HL fair value (φ fitted on train) | 98% | **−$128** |
| R3 reopen guard | 92.5% | **+$7.6k** (also positive in train) |
| R2 on train-quality 15m reference | – | +$8.4k |

- **Why R2 failed.** φ fitted on 15-minute-stale gaps is too wide for fresh 1–5-minute gaps: the rule was out for 9.6% of train swaps but only 0.7% of test swaps.
- **What this means for the desk.** Ship the reopen guard and historical-toxicity gates now. Recalibrate the fair-value gap on the live 1 s tape as it accumulates, which started Sep 18. The day-block bootstrap 95% CI on R1's test gain is [−$36k, +$78k]: no rule is statistically proven yet.

## Caveats

- **Pool-level backtest counterfactual:** it assumes an LP's absence doesn't change prices or flow.
- **Weekend references:** HL's weekend price is its own internal price, and 1m HL history (Sep 15+) contains no weekend yet.
- **SPY edges** vs HL are sensitive to the basis (SPY vs the S&P index).
- **Gas** is priced at a flagged $4,000/ETH constant.
- **Informational analytics, not investment advice.**

*Reproduce:* `cd engine && uv run python -m indexer.hs_backfill && uv run python -m markout.study && uv run python -m markout.hl_ref && uv run python -m positions.attribute && uv run python -m league.build && uv run python -m flow.xray && uv run python -m backtest.gap_exclusion`. Module reports live under `data/study/m1/*/`.
