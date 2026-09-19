"""Backfill Robinhood Chain (4663) data from Envio HyperSync with exact block timestamps.

Each source is one streaming query (possibly several log selections), written as
    data/raw/<source>/hs_<from>_<to>.parquet   logs  (block, tx_index, log_index, tx_hash, address, topic0-3, data, ts)
    data/raw/<source>/tx_<from>_<to>.parquet   txs   (block, tx_index, tx_hash, from, to, gas_used, gas_price_wei, ts)
Re-running extends every source from the last block already on disk.

Sources:
  v3_nvda_usdg, v4_pools, chainlink   pool / oracle logs (see indexer/backfill.py SOURCES)
  lp_txs          every log (pool, NPM, PoolManager, POSM) in any tx that mints/burns/collects in a covered pool,
                  plus those txs' sender + gas. Links NPM tokenIds and POSM salts to position ticks.
  npm_transfers   v3 NonfungiblePositionManager ERC-721 Transfers (position owner timelines)
  posm_transfers  v4 PositionManager ERC-721 Transfers
  swap_txs        sender (tx.from) + gas of every swap tx in covered pools (Flow X-ray)
  base_*          Base (8453) Aerodrome Slipstream NVDAc/USDC: pool, gauge, LP txs, NPM transfers, swap senders, AERO/USDC price

    uv run python -m indexer.hs_backfill [source ...]
Requires ENVIO_API_TOKEN in deltadesk/.env.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import hypersync
import polars as pl
from hypersync import (BlockField, ClientConfig, FieldSelection, HexOutput, JoinMode, LogField, LogSelection, Query,
                       StreamConfig, TransactionField)

from indexer.backfill import POOL_MANAGER, SOURCES

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
URLS = {"4663": "https://4663.hypersync.xyz", "8453": "https://8453.hypersync.xyz"}
URL = URLS["4663"]

NVDA_POOL = SOURCES["v3_nvda_usdg"]["address"]
V4_POOL_IDS = SOURCES["v4_pools"]["topics"][1]
NPM = "0x73991a25c818bf1f1128deaab1492d45638de0d3"
POSM = "0x58daec3116aae6d93017baaea7749052e8a04fa7"

T_V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
T_V3_MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"
T_V3_BURN = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c"
T_V3_COLLECT = "0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0"
T_V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
T_V4_MODIFY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"
T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


@dataclass
class Spec:
    selections: list[tuple[list[str], list[list[str]]]]  # (addresses, topics per position; [] = any)
    join: JoinMode = JoinMode.DEFAULT
    logs: bool = True
    txs: bool = False
    keep_log_addresses: list[str] | None = None  # drop unrelated logs pulled in by JOIN_ALL
    log_fields: list | None = None  # override (e.g. just enough to join txs)
    chunk_blocks: int | None = None  # split into per-chunk files so a stalled stream only loses one chunk
    chain: str = "4663"  # "4663" Robinhood Chain, "8453" Base
    start_block: int = 0


def _norm_topics(topics) -> list[list[str]]:
    return [[] if t is None else (t if isinstance(t, list) else [t]) for t in (topics or [])]


SPECS: dict[str, Spec] = {
    name: Spec([(src["address"] if isinstance(src["address"], list) else [src["address"]], _norm_topics(src["topics"]))])
    for name, src in SOURCES.items()
}
SPECS["lp_txs"] = Spec(
    selections=[([NVDA_POOL], [[T_V3_MINT, T_V3_BURN, T_V3_COLLECT]]), ([POOL_MANAGER], [[T_V4_MODIFY], V4_POOL_IDS])],
    join=JoinMode.JOIN_ALL,
    txs=True,
    keep_log_addresses=[NVDA_POOL, NPM, POOL_MANAGER, POSM],
)
SPECS["npm_transfers"] = Spec([([NPM], [[T_TRANSFER]])])
SPECS["posm_transfers"] = Spec([([POSM], [[T_TRANSFER]])])
SPECS["swap_txs"] = Spec(
    selections=[([NVDA_POOL], [[T_V3_SWAP]]), ([POOL_MANAGER], [[T_V4_SWAP], V4_POOL_IDS])],
    logs=False,
    txs=True,
    log_fields=[LogField.BLOCK_NUMBER, LogField.TRANSACTION_HASH],
    chunk_blocks=250_000,  # HyperSync joined streams slow down super-linearly with range size
)

# ---- Base (8453): Aerodrome Slipstream NVDAc/USDC (M1.3, read-only) ----
AERO_NVDA_POOL = "0x853f5f1b92b16714fe6cda67caad0856b83c7ab9"
AERO_NVDA_GAUGE = "0x30d1e5af5ce39863e6f69a1f73ffb0e1ac9771a8"
AERO_NPM_EQUITY = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53"
AERO_USDC_POOL = "0xccd9cc53b63662088c738b8bc06e9078fb8d9ad4"  # AERO/USDC CL200, for valuing AERO emissions
T_GAUGE_DEPOSIT = "0x1c8ab8c7f45390d58f58f1d655213a82cca5d12179761a87c16f098813b8f211"   # Deposit(address,uint256,uint128)
T_GAUGE_WITHDRAW = "0x8903a5b5d08a841e7f68438387f1da20c84dea756379ed37e633ff3854b99b84"  # Withdraw(address,uint256,uint128)
BASE_START = 49_200_000  # just before the NVDAc pool's first log (49,273,475, Aug 24 2026)

SPECS["base_aero_nvda"] = Spec([([AERO_NVDA_POOL], [])], chain="8453", start_block=BASE_START)
SPECS["base_aero_gauge"] = Spec([([AERO_NVDA_GAUGE], [])], chain="8453", start_block=BASE_START)
SPECS["base_aero_lp_txs"] = Spec(
    selections=[([AERO_NVDA_POOL], [[T_V3_MINT, T_V3_BURN, T_V3_COLLECT]]), ([AERO_NVDA_GAUGE], [[T_GAUGE_DEPOSIT, T_GAUGE_WITHDRAW]])],
    join=JoinMode.JOIN_ALL, txs=True, keep_log_addresses=[AERO_NVDA_POOL, AERO_NVDA_GAUGE, AERO_NPM_EQUITY],
    chain="8453", start_block=BASE_START, chunk_blocks=250_000,
)
SPECS["base_npm_transfers"] = Spec([([AERO_NPM_EQUITY], [[T_TRANSFER]])], chain="8453", start_block=BASE_START, chunk_blocks=250_000)
SPECS["base_aero_swap_txs"] = Spec(
    selections=[([AERO_NVDA_POOL], [[T_V3_SWAP]])], logs=False, txs=True,
    log_fields=[LogField.BLOCK_NUMBER, LogField.TRANSACTION_HASH], chain="8453", start_block=BASE_START, chunk_blocks=250_000,
)
SPECS["base_aero_usdc"] = Spec([([AERO_USDC_POOL], [[T_V3_SWAP]])], chain="8453", start_block=BASE_START, chunk_blocks=250_000)

LOG_FIELDS = [LogField.BLOCK_NUMBER, LogField.TRANSACTION_INDEX, LogField.LOG_INDEX, LogField.TRANSACTION_HASH,
              LogField.ADDRESS, LogField.TOPIC0, LogField.TOPIC1, LogField.TOPIC2, LogField.TOPIC3, LogField.DATA]
TX_FIELDS = [TransactionField.BLOCK_NUMBER, TransactionField.TRANSACTION_INDEX, TransactionField.HASH, TransactionField.FROM,
             TransactionField.TO, TransactionField.GAS_USED, TransactionField.EFFECTIVE_GAS_PRICE]


def token() -> str:
    if os.environ.get("ENVIO_API_TOKEN"):
        return os.environ["ENVIO_API_TOKEN"]
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("ENVIO_API_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("ENVIO_API_TOKEN missing (deltadesk/.env)")


def last_block_on_disk(source: str) -> int:
    ends = [int(f.stem.split("_")[-1]) for pat in ("hs_*.parquet", "tx_*.parquet") for f in (RAW / source).glob(pat)]
    return max(ends) if ends else -1


def _int(df: pl.DataFrame, col: str) -> pl.Expr:
    """HyperSync hex output returns quantities as 0x-strings; decode them (or cast if already numeric)."""
    c = pl.col(col)
    return c.str.slice(2).str.to_integer(base=16, strict=False) if df.schema[col] == pl.Utf8 else c.cast(pl.Int64)


async def fetch(client: hypersync.HypersyncClient, name: str, spec: Spec, to_block: int) -> None:
    start = max(last_block_on_disk(name) + 1, spec.start_block)
    if start >= to_block:
        print(f"{name}: up to date")
        return
    if spec.chunk_blocks:
        for lo in range(start, to_block, spec.chunk_blocks):
            hi = min(lo + spec.chunk_blocks, to_block)
            for attempt in range(4):  # a stalled stream costs one chunk, not the run
                try:
                    # generous: the client sleeps through HyperSync rate-limit windows (30 req/min per token)
                    await asyncio.wait_for(fetch_range(client, name, spec, lo, hi), timeout=900)
                    break
                except asyncio.TimeoutError:
                    print(f"{name}: chunk {lo}..{hi} timed out (attempt {attempt + 1}); retrying", flush=True)
            else:
                raise RuntimeError(f"{name}: chunk {lo}..{hi} failed after retries")
    else:
        await fetch_range(client, name, spec, start, to_block)


async def fetch_range(client: hypersync.HypersyncClient, name: str, spec: Spec, start: int, to_block: int) -> None:
    query = Query(
        from_block=start,
        to_block=to_block,
        logs=[LogSelection(address=a, topics=t or None) for a, t in spec.selections],
        field_selection=FieldSelection(
            log=spec.log_fields or LOG_FIELDS,
            block=[BlockField.NUMBER, BlockField.TIMESTAMP],
            transaction=TX_FIELDS if spec.txs else None,
        ),
        join_mode=spec.join,
    )
    t0 = time.time()
    tmp = Path(tempfile.mkdtemp(prefix=f"hs_{name}_"))
    try:
        await client.collect_parquet(str(tmp), query, StreamConfig(hex_output=HexOutput.PREFIXED))
        read = lambda f: pl.read_parquet(tmp / f) if (tmp / f).exists() else None  # noqa: E731
        logs, blocks, txs = read("logs.parquet"), read("blocks.parquet"), read("transactions.parquet")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if blocks is None:  # nothing matched in this range (e.g. Chainlink feeds are silent on weekends)
        print(f"{name}: no new data [{start}..{to_block - 1}]")
        return
    out_dir = RAW / name
    out_dir.mkdir(parents=True, exist_ok=True)
    blocks = blocks.select(_int(blocks, "number").alias("block"), _int(blocks, "timestamp").alias("ts")).unique("block")
    summary = []

    if spec.logs and logs is not None:
        df = logs.select(
            _int(logs, "block_number").alias("block"),
            _int(logs, "transaction_index").cast(pl.Int32).alias("tx_index"),
            _int(logs, "log_index").cast(pl.Int32).alias("log_index"),
            pl.col("transaction_hash").alias("tx_hash"),
            pl.col("address").str.to_lowercase().alias("address"),
            *[pl.col(f"topic{i}") for i in range(4)],
            pl.col("data"),
        )
        if spec.keep_log_addresses:
            df = df.filter(pl.col("address").is_in([a.lower() for a in spec.keep_log_addresses]))
        df = df.join(blocks, on="block", how="left").sort(["block", "tx_index", "log_index"])
        df.write_parquet(out_dir / f"hs_{start:010d}_{to_block - 1:010d}.parquet")
        for f in out_dir.glob("0*.parquet"):  # RPC-era segments (no exact ts) are superseded
            f.unlink()
        summary.append(f"{df.height:,} logs (missing ts {df['ts'].null_count()})")

    if spec.txs and txs is not None:
        tdf = txs.select(
            _int(txs, "block_number").alias("block"),
            _int(txs, "transaction_index").cast(pl.Int32).alias("tx_index"),
            pl.col("hash").alias("tx_hash"),
            pl.col("from").str.to_lowercase().alias("from"),
            pl.col("to").str.to_lowercase().alias("to"),
            _int(txs, "gas_used").alias("gas_used"),
            # gas prices exceed Int64 only in pathological cases; keep wei as float for cost math
            pl.col("effective_gas_price").str.slice(2).str.to_integer(base=16, strict=False).cast(pl.Float64).alias("gas_price_wei"),
        ).unique("tx_hash").join(blocks, on="block", how="left").sort(["block", "tx_index"])
        tdf.write_parquet(out_dir / f"tx_{start:010d}_{to_block - 1:010d}.parquet")
        summary.append(f"{tdf.height:,} txs")

    print(f"{name}: {', '.join(summary) or 'no data'} [{start}..{to_block - 1}] in {time.time() - t0:.0f}s", flush=True)


async def main():
    wanted = sys.argv[1:] or list(SPECS)
    clients, heights, failed = {}, {}, []
    for name in wanted:
        try:
            await _one(name, clients, heights)
        except Exception as e:  # one stuck source must not block the others; the pipeline still sees a failure
            print(f"{name}: FAILED {type(e).__name__}: {str(e)[:300]}", flush=True)
            failed.append(name)
    if failed:
        raise SystemExit(f"failed sources: {', '.join(failed)}")


async def _one(name: str, clients: dict, heights: dict) -> None:
    chain = SPECS[name].chain
    if chain not in clients:
        # The token is rate limited (30 req/min) and may be shared (server + laptop): back off past the 60 s window
        # instead of burning retries on 429s the client could not predict.
        clients[chain] = hypersync.HypersyncClient(ClientConfig(url=URLS[chain], api_token=token(), http_req_timeout_millis=120_000,
                                                                max_num_retries=12, retry_ceiling_ms=65_000))
        heights[chain] = await clients[chain].get_height()
        print(f"hypersync {chain} height {heights[chain]}", flush=True)
    await fetch(clients[chain], name, SPECS[name], heights[chain])


if __name__ == "__main__":
    asyncio.run(main())
