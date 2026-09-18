# M0 kill-test: can LPs beat informed flow on tokenized stocks?

*Data through Fri 2026-09-18 ~17:20 ET. Robinhood Chain (4663), every swap since each pool opened. Self-markouts only (the HL-referenced version comes in M1).*

## Answer
**Yes, but barely. The edge is concentrated, and it disappears at the market open.**

In the busiest stock pool on Robinhood Chain, NVDA/USDG:
- **Volume:** $952M across 2.93M swaps since Jul 21.
- **LP fees:** $362.7k earned.
- **Taken back by traders who knew better:** $267.2k, measured against the pool's own price 1 hour later.
- **Net to LPs:** +$95k, which is about **1.0 bp of volume**.

Put in Igor's terms: **for every $80 LPs earned in fees, $59 was picked off.**

## Method
- **Fees are LP fees only.** v3 NVDA/USDG has `feeProtocol = 68`, so 1/4 of the 5 bp fee goes to the protocol. v4 pools use the `fee` field of each Swap event, minus the protocol fee.
- **Picked off** = `s·q·(P_pool(t+h) − p_curve)`, summed over swaps. `p_curve` is the execution price with all fees removed. `P_pool(t+h)` is the pool's own mid h seconds later.
- **Edge** = fees ÷ picked off. Above 1, LPs keep money; below 1, they lose it.
- **Reconciliation passed.** Swap-derived LP fees match the pool's own `feeGrowthGlobal` within 0.27% (USDG side) and 0.0000% (NVDA side), over a live window of 345 swaps (`data/reconcile/`).

## Results (edge at 1 h)

| Pool | Volume | LP fees | Picked off (1 h) | Edge | Net |
|---|---|---|---|---|---|
| NVDA/USDG (v3, 0.05%) | $951.7M | $362.7k | $267.2k | **1.36** | +1.0 bp |
| SPY/USDG (v4, 0.05%) | $87.2M | $43.6k | $13.2k | 3.30 | +3.5 bp |
| TSLA/USDG (v4, 0.30%) | $28.8M | $86.4k | $33.7k | 2.56 | +18.3 bp |
| QQQ/SPY (v4, 0.02%) | $1.2M | $0.2k | $0.3k | 0.77 | too new (live since Sep 17) |

**NVDA by market regime:**

| Regime | Edge (1 h) |
|---|---|
| Regular hours | **1.00**, break-even |
| Extended hours | 1.28 |
| Overnight | 2.14 |
| Weekend dark window | 4.27 |
| Holidays | 3.52 |

**NVDA's worst hours of the week (ET):**

| Hour | Fees | Picked off | Edge |
|---|---|---|---|
| Mon 09:00 | $6.2k | $25.9k | **0.24** |
| Wed 09:00 | $8.8k | $25.6k | 0.35 |
| Wed 17:00 (earnings slot) | $5.5k | $20.1k | 0.28 |
| Fri 11:00 | $6.2k | $17.9k | 0.34 |

**Who takes it:**
- 1,273 router addresses traded NVDA.
- The top 3 took **84% of all picked-off value** while paying **28% of the fees**.
- LPs finished net-negative on **13 of 60 days**. The worst day was **Sep 2: −$18.1k**.

**Reopen windows** (weekday 09:20–09:45, and Sunday 19:50 to Monday 00:20):

| Pool | Edge (1 h) |
|---|---|
| NVDA | **0.89** (LPs lose) |
| TSLA | **0.81** |
| SPY | 2.16 |

**A fixed rule decided in advance, "no liquidity 09:00–10:59 ET on weekdays":**

| Pool | Net with the rule | Edge |
|---|---|---|
| NVDA | $95.3k → $101.2k | 1.36 → 1.55 |
| TSLA | net unchanged | 2.56 → 3.95 |
| SPY | costs $3.2k | — |

The rule helps, but a fixed clock is too blunt. The lever is **dynamic** gap exclusion against a live fair value.

## Caveats (be honest about these in the pitch)
1. **Self-markouts can't see what they don't see.**
   - On weekends the pool is the only onchain price, so its own future mid understates LVR.
   - The 4.27× weekend edge is an **upper bound** until it's re-marked against HL's 24/7 tape (M1: HL 1h/15m candles plus our live 1 s tape).
2. **"Taker" is the router address** (the Swap `sender`). Attribution to the originating wallet (`tx.from`) is M1 (Flow X-ray via HyperSync transactions).
3. **Pool level, not position level.** A tight in-range LP earns and loses more than the pool average. Per-position attribution is M1.
4. **The reconciliation sample is small** (a quiet post-market window). Re-run it over a regular session.

## What it means for DeltaDesk
- The thesis survives the kill-test. LP edge is real but thin, and **almost all the damage is concentrated**: the regular session, especially the opening hour, the earnings evening, and a handful of wallets.
- That is exactly what REOPEN-GUARD, EVENT and gap exclusion are designed to avoid.
- The hedge doesn't fix this, because it removes variance, not LVR. **Deciding when not to quote** is the product.
- **Demo hook:** "LPs in Robinhood Chain's NVDA pool earned $363k and gave $267k of it back. At the Monday open they lose $4 for every $1 earned. Three wallets took 84% of it."

## Next (M1)
1. HL-referenced markouts: candles now, 1 s tape going forward. Recompute the weekend numbers.
2. Resolve `tx.from` for takers and build the Flow X-ray.
3. Position-level attribution: v3 NPM and v4 PositionManager ownership, with per-position fees, LVR and IL.
4. Backtest dynamic gap exclusion against HL fair value vs the fixed open-window rule.

*Reproduce:* `uv run python -m indexer.hs_backfill && uv run python -m markout.study`. Tables are in `data/study/m0/`.
