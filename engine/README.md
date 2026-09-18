# DeltaDesk engine

Python (uv, 3.12) engine behind the Truth Study, tearsheets and the LP League.

```
uv run python -m indexer.hs_backfill      # HyperSync backfill / incremental top-up (needs ENVIO_API_TOKEN in ../.env)
uv run python -m indexer.hl_candles       # Hyperliquid trade.xyz candles
uv run python -m markout.study            # pool-level markout study → data/study/m0/
uv run python -m indexer.reconcile snap|check   # swap-derived fees vs pool feeGrowthGlobal
uv run pytest                             # tests
```

## Data contract (inputs every module may read; `data/` lives at the repo root, gitignored)

### `data/raw/<source>/hs_<from>_<to>.parquet`: logs (Robinhood Chain 4663)
`block i64, tx_index i32, log_index i32, tx_hash str, address str (lowercase), topic0..topic3 str|null, data str (0x-hex), ts i64 (unix s, exact)`

| source | contents |
|---|---|
| `v3_nvda_usdg` | every log of the NVDA/USDG v3 pool `0xd4eb…14a3` (Swap, Mint, Burn, Collect, CollectProtocol, Flash) |
| `v4_pools` | PoolManager logs whose `topic1` is one of the covered poolIds (Swap, ModifyLiquidity, Initialize, Donate) |
| `chainlink` | `AnswerUpdated` of the NVDA/SPY/QQQ/TSLA aggregators |
| `lp_txs` | all pool / NPM / PoolManager / POSM logs in any tx that minted, burned, collected or modified liquidity in a covered pool |
| `npm_transfers` | v3 NPM `0x7399…d0d3` ERC-721 `Transfer` |
| `posm_transfers` | v4 POSM `0x58da…7fa7` ERC-721 `Transfer` |

### `data/raw/<source>/tx_<from>_<to>.parquet`: transactions
`block i64, tx_index i32, tx_hash str, from str, to str, gas_used i64, gas_price_wei f64, ts i64`. Sources: `lp_txs`, `swap_txs`.
Gas cost in ETH = `gas_used * gas_price_wei / 1e18` (Arbitrum Orbit: includes the L1 component).

### `data/raw/hl_candles/xyz_<SYM>_<iv>.parquet`: Hyperliquid trade.xyz candles
`t_open_ms, t_close_ms, o, h, l, c, v, n, coin, interval`. HL keeps ~5,000 candles per interval:
1m from Sep 15, 5m from Sep 1, 15m from Jul 28, 1h from Jul 1 (2026). Prices are **per share**.

### `data/tape/<stream>/<UTC-hour>.jsonl`: live 1 s tape (recorder/tape.mjs), from 2026-09-18 20:50 UTC
Every line has `t` (local receive ms). Streams: `hl_bbo {coin, ts, bid{px,sz,n}, ask{…}}`, `hl_ctx {coin, markPx, oraclePx, midPx, impactPxs, funding, openInterest, premium, …}`,
`hl_trades`, `hl_xyz_snapshot {rows[]}` (all 123 markets, 5 s), `rh_quotes {sym, bid, ask, halt, gen, mbUsd, …}` (NVDA/SPY/QQQ 1 s, others 5 s),
`rh_assets` / `rh_corporate_actions` (hourly), `errors`, `meta`.

### `data/study/m0/swaps.parquet`: decoded swaps, one row per swap (output of `markout.study`)
| column | meaning |
|---|---|
| `pool` | `NVDA/USDG`, `SPY/USDG`, `TSLA/USDG`, `QQQ/SPY` (definitions in `markout/pools.py::POOLS`) |
| `block, tx_index, log_index, tx_hash, ts` | position in chain; `ts` exact unix seconds (float) |
| `sender` | msg.sender of the swap (router), last 40 hex chars, **not** the originating wallet (join `swap_txs` for `from`) |
| `s` | +1 taker bought the base asset, −1 sold |
| `q` | base quantity (human units); `quote_amt` = quote paid/received (human units) |
| `p_exec` | quote per base incl. fees; `p_ex` = curve price excl. ALL fees |
| `fee_q` / `proto_q` | LP fee / protocol fee in quote units (v3 NVDA protocol cut = 1/4) |
| `mid_after` | pool mid (quote per base) after the swap |
| `liquidity` | active liquidity after the swap (float) |
| `tick_before`, `tick` | pool tick before/after (raw token1/token0 space, same as position ticks) |
| `quote_usd` | USD per quote unit (1 for USDG pools; SPY pool mid for QQQ/SPY) |
| `vol_usd, fee_usd` | USD volume / LP fee |
| `p_ref_{1m,5m,1h}`, `picked_q_*`, `picked_usd_*`, `valid_*` | **self**-markouts vs the pool's own mid h later; `picked` = `s·q·(P_ref − p_ex)` |
| `regime` | `REGULAR`, `EXTENDED`, `OVERNIGHT`, `WEEKEND_DARK`, `HOLIDAY` (ET calendar) |
| `reopen_window, how, date_et` | reopen flag; hour-of-week (Mon 00 ET = 0); ET date |

Token orientation per pool (`markout/pools.py`): NVDA/USDG v3 token0=USDG(6), token1=NVDA(18);
SPY/USDG and TSLA/USDG v4 currency0=stock(18), currency1=USDG(6); QQQ/SPY v4 currency0=SPY, currency1=QQQ (both 18).
Robinhood tokens represent `uiMultiplier` shares (NVDA 1.000775 since Sep 10). HL prices are per share.

## Modules
- `indexer/`: `hs_backfill.py` (HyperSync), `backfill.py` (public-RPC fallback), `hl_candles.py`, `reconcile.py`
- `markout/`: `pools.py` (decoder), `study.py` (pool-level study)
- M1 (in progress): `markout/hl_ref.py` (HL-referenced markouts), `flow/` (Flow X-ray), `positions/` (position attribution + tearsheet),
  `backtest/` (gap exclusion), `api/` (FastAPI)
