# DeltaDesk: the open market-making desk for tokenized stocks

> *"If I made $80 in fees but lost $50 to informed flow, that would be good to know."* (Igor, Bankr)

Tokenized stocks trade around the clock on AMMs, and the LPs are doing a market maker's job without a market maker's books. DeltaDesk is those books. For every LP position in Robinhood Chain's stock pools it measures:
- fees earned;
- how much informed flow picked off, marked against Hyperliquid's 24/7 price;
- impermanent loss against simply holding;
- gas.

Every figure reconciles to the chain. The same data powers a pre-trade check that tells an LP, or an agent, when providing liquidity is safe.

- **Web:** https://web-production-10951.up.railway.app: Study · Live desk · Tearsheet · League
- **API:** https://core-production-512e.up.railway.app (`/health`, `/fair-value/NVDA`, `/study`)
- **Findings:** [docs/m1-truth-study.md](docs/m1-truth-study.md) (M1) · [docs/m0-killtest.md](docs/m0-killtest.md) (M0)

## What we found

Data: 3.34M swaps and $1.07B of volume in NVDA/USDG (Uniswap v3), SPY/USDG, TSLA/USDG and QQQ/SPY (Uniswap v4), from each pool's launch to Sep 18 2026.

- **NVDA/USDG LPs earned $362.9k in fees; informed flow took back $289.5k** (vs Hyperliquid, 1h). Edge 1.25: LPs keep money, but barely.
- **Regular hours are a losing game** (edge 0.92). The Monday 09:00 ET hour runs at 0.25. Weekends pay (3.50), but self-markouts overstated that by 20% to 2.7×.
- **Three bot operators account for 98.6% of NVDA LPs' net losses to informed flow.** Hyperliquid-arbitrage bots pay 37% of fees and take 67% of all value picked off. Retail and aggregator flow pays LPs.
- **Only 39.8% of NVDA positions beat holding.** The League's best manager earns +$193 per $1k·day. Its worst, the most active re-ranger, gives informed flow $174 for every $52 of fees.
- **Every dollar reconciles:**
  - Attributed fees conserve pool fees exactly.
  - 1,938 fully collected positions match on-chain collects within 1 bp.
  - Golden positions match within 0.0011 bp.
- **On Aerodrome (Base), emissions are what pay LPs.** NVDAc/USDC swap fees cover 0.97× what informed flow takes. 82% of fees go to veAERO voters. Fees kept plus AERO received cover it 1.22×. Every AERO paid out is attributed to a position and reconciles to on-chain claims (4e-8).
- **Honest negative result:** a fair-value gap rule tuned in-sample failed out of sample (−$128). The simple reopen guard was the only rule positive in both periods.

## Product

| Surface | What it does | Access |
|---|---|---|
| **Truth Study** | Pool × regime × hour-of-week fee vs picked-off heatmaps; the Flow X-ray (who takes LP money) | Public web + `/study`, `/study/table/*` |
| **Tearsheet** | Paste a wallet on Robinhood Chain or Base (Aerodrome, staked or unstaked). Returns fees kept, AERO, picked off (vs HL), IL vs HODL, price P&L, gas, net, each per $1k, plus a reconciliation residual | `/tearsheet/{robinhood\|base}/{wallet}` (x402, $0.05) |
| **LP League** | 1,003 LP managers ranked by result vs holding per $1k·day, with strategy fingerprints | `/lp-league` (x402, $0.02) |
| **Safe to LP?** | ALLOW / CAUTION / BLOCK. Checks the pool's gap to HL fair value, the market regime, this hour's historical toxicity and oracle freshness | `/safe-to-lp/{pool}` (x402, $0.005) |
| **Fair value** | HL 24/7 price × a session-calibrated basis, vs the pool mid and Chainlink (frozen on weekends) | `/fair-value/{pool}` (public) |
| **`lp-truth` skill** | Bankr skill that calls the endpoints above over x402 | [skills/lp-truth/](skills/lp-truth/SKILL.md) |

Paid endpoints are Bankr x402 Cloud handlers ([x402/](x402/), [bankr.x402.json](bankr.x402.json)) that proxy to the API with a server key. Invalid input and upstream errors return 4xx/5xx, so callers are never charged for a failed call.

## How it works

```
Robinhood Chain 4663 ─┐  Envio HyperSync   ┌─ decode swaps (v3 + v4, protocol fee removed)
Base 8453 (Aerodrome) ┘  (logs + txs)      ├─ HL-referenced markouts  F = HL · k(prior session)
Hyperliquid trade.xyz ─  candles + 1s tape ┼─ positions: segments × swaps range join → fees, picked off, IL, gas
Robinhood /rhj quotes ─  1s tape           ├─ Flow X-ray: wallet → operator → label
Chainlink (4663)      ─  rounds            └─ gap-exclusion backtest (train Jul 28–Aug 31, test Sep 1–18)
                                                    │
                        FastAPI (Railway, refresh every 10 min) → Next.js web · x402 handlers · Bankr skill
```

## Code map

| What | Where |
|---|---|
| Swap decoder: signs (v3 is pool-side, v4 swapper-side), LP share after the v3 `feeProtocol` / v4 protocol fee | [engine/markout/pools.py:78](engine/markout/pools.py#L78), fee split at [:121](engine/markout/pools.py#L121) |
| Fee reconciliation vs `feeGrowthGlobal` (0.27% / exact) | [engine/indexer/reconcile.py](engine/indexer/reconcile.py) |
| HyperSync backfill: specs, chunking, rate-limit handling | [engine/indexer/hs_backfill.py](engine/indexer/hs_backfill.py) |
| 1-second tape recorder (HL bbo/ctx/trades, Robinhood quotes, corporate actions) | [recorder/tape.mjs](recorder/tape.mjs) |
| Fair value: basis `k` calibrated on the last completed session (no look-ahead) | [engine/markout/hl_ref.py:235](engine/markout/hl_ref.py#L235), [:258](engine/markout/hl_ref.py#L258) |
| Position attribution: per-step fee and markout shares `ℓ/L`, split across tick crossings | [engine/positions/attribute.py:126](engine/positions/attribute.py#L126) |
| Tearsheet and its reconciliation residual | [engine/positions/tearsheet.py:86](engine/positions/tearsheet.py#L86) |
| Flow X-ray labels (deterministic rules) | [engine/flow/labels.py:64](engine/flow/labels.py#L64) |
| Gap-exclusion backtest | [engine/backtest/gap_exclusion.py:477](engine/backtest/gap_exclusion.py#L477) |
| LP League score | [engine/league/build.py:29](engine/league/build.py#L29) |
| Aerodrome: pool study (voter fee split, emission schedule) | [engine/aero/study.py](engine/aero/study.py) |
| Aerodrome: staked/unstaked fees, AERO reward sweep, penalties | [engine/aero/positions.py](engine/aero/positions.py) |
| Precision-safe feeGrowth sweep (double-double) | [engine/positions/attribute.py](engine/positions/attribute.py) (`two_sum_rows`, `sweep`) |
| `/safe-to-lp` decision function | [engine/api/app.py:99](engine/api/app.py#L99) |
| Market calendar, including reopen windows | [engine/api/live.py:75](engine/api/live.py#L75) |
| Refresh pipeline | [engine/pipeline/refresh.py](engine/pipeline/refresh.py) |

Uniswap surfaces used: the v3 pool (`Swap`, `Mint`, `Burn`, `Collect`, `Flash`, `SetFeeProtocol`, `slot0`, `feeGrowthGlobal`); NonfungiblePositionManager (`IncreaseLiquidity`, `DecreaseLiquidity`, `Collect`, `Transfer`); v4 PoolManager (`Swap`, `ModifyLiquidity`); PositionManager (`Transfer`, salt = tokenId); StateView `getSlot0`.

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
uv run python -m pytest tests -q  # 131 tests
uv run uvicorn api.app:app --port 8787
cd ../web && npm i && DELTADESK_API=http://127.0.0.1:8787 npm run dev
```

Or `docker build -t deltadesk . && docker run -p 8787:8787 -e ENVIO_API_TOKEN=… -v $PWD/data:/app/data deltadesk`. This runs the recorder, the refresh loop and the API in one container.

## Status

- **Built (M0–M1):** the truth layer above: data, attribution, Study, Tearsheet, League, API, web, x402 handlers, skill.
- **Live:**
  - Aerodrome (Base) tearsheets for staked and unstaked positions (fees kept, AERO, penalties, voter share).
  - x402 endpoints on Bankr: `https://x402.bankr.bot/0xd8d5b9389721258bcdfa7ac1306af6330e5634cd/<service>`.
    First paid call (`safe-to-lp?pool=NVDA`, $0.005 USDC) settled on Base in tx
    [`0x309ddc0c…6708`](https://basescan.org/tx/0x309ddc0cbc51eccddf649fa001a25ecdc049179e402bc6dad91e798c8c8e6708)
    (2026-09-19 06:20 UTC).
- **Next:** the desk itself.
  - A DeskAccount contract that can only pay its owner.
  - A delegated agent executor.
  - Reopen-guard and toxic-hour gates, with fair-value gaps recalibrated on the live 1s tape.
  - A QQQ/SPY correlated-pair lane.

Informational analytics, not investment advice.
