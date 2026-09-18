"""Backfill raw pool logs + block-timestamp anchors from Robinhood Chain (4663) over public RPC.

Resumable: work is split into fixed 1M-block segments; each finished segment is one Parquet file under
data/raw/<source>/, so a restart skips everything already on disk. Inside a segment the getLogs window
adapts to the RPC's result caps.

    uv run python -m indexer.backfill            # all sources + timestamp anchors
    uv run python -m indexer.backfill --only ts  # just the timestamp anchors
"""

from __future__ import annotations

import argparse
import itertools
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx
import polars as pl

DATA = Path(__file__).resolve().parents[2] / "data" / "raw"

RPCS = [
    "https://rpc.mainnet.chain.robinhood.com",
    "https://robinhood-rpc.publicnode.com",
]

SEGMENT = 1_000_000
TS_ANCHOR_EVERY = 1_000  # blocks (~100 s at ~100 ms blocks)

POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"

# Pool-level sources for the M0 kill-test. v3 pools are filtered by address; v4 pools by PoolManager + poolId (topic1).
SOURCES = {
    "v3_nvda_usdg": {"address": "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3", "topics": None},
    "v4_pools": {
        "address": POOL_MANAGER,
        "topics": [
            None,
            [
                "0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907",  # SPY/USDG 0.05%
                "0x8493982435e4273028008cd181c84c0d6a548f96792fdb5acddcbb6a8c82d305",  # QQQ/SPY 0.02%
                "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e",  # TSLA/USDG 0.3%
            ],
        ],
    },
    # Chainlink OCR aggregators (Robinhood Chain): AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)
    "chainlink": {
        "address": [
            "0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2",  # NVDA / USD
            "0x78BCB218fA04B9b3a278eBc865Ed320BF8DEFBAc",  # SPY / USD
            "0x25e996ce8b3529885D429241156e83e7b7744049",  # QQQ / USD
            "0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1",  # TSLA / USD
        ],
        "topics": ["0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f"],
    },
}

_rpc_cycle = itertools.cycle(RPCS)
_rpc_lock = threading.Lock()
_client = httpx.Client(timeout=60, http2=False, headers={"User-Agent": "deltadesk-indexer/0.1"})


def rpc(method: str, params: list, retries: int = 6):
    last = None
    for attempt in range(retries):
        with _rpc_lock:
            url = next(_rpc_cycle)
        try:
            r = _client.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            j = r.json()
            if "error" in j:
                last = RuntimeError(f"{url}: {j['error']}")
                msg = str(j["error"]).lower()
                rate_limited = r.status_code == 429 or "too many requests" in msg or "rate" in msg
                if not rate_limited and any(s in msg for s in ("range", "too many", "limit", "exceed", "size")):
                    raise last  # result-size / block-range cap: caller shrinks the window
            else:
                return j["result"]
        except (httpx.HTTPError, ValueError) as e:
            last = e
        time.sleep(min(2**attempt * 0.5, 15))
    raise RuntimeError(f"rpc {method} failed: {last}")


def rpc_batch(calls: list[tuple[str, list]], retries: int = 8):
    """JSON-RPC batch (<=100 calls per request), rotating RPCs with backoff on 429s."""
    payload = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p} for i, (m, p) in enumerate(calls)]
    for attempt in range(retries):
        with _rpc_lock:
            url = next(_rpc_cycle)
        try:
            r = _client.post(url, json=payload)
            if r.status_code == 200:
                j = r.json()
                if isinstance(j, list) and all("result" in x for x in j):
                    return [x["result"] for x in sorted(j, key=lambda x: x["id"])]
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(min(2**attempt * 0.5, 20))
    return [rpc(m, p) for m, p in calls]


def head_block() -> int:
    return int(rpc("eth_blockNumber", []), 16)


def logs_window(src: dict, lo: int, hi: int) -> list[dict]:
    flt = {"address": src["address"], "fromBlock": hex(lo), "toBlock": hex(hi)}
    if src["topics"]:
        flt["topics"] = src["topics"]
    return rpc("eth_getLogs", [flt], retries=8)


def fetch_segment(name: str, src: dict, seg_lo: int, seg_hi: int) -> int:
    out = DATA / name / f"{seg_lo:010d}_{seg_hi:010d}.parquet"
    if out.exists():
        return -1
    rows, lo, step = [], seg_lo, 100_000
    while lo <= seg_hi:
        hi = min(lo + step - 1, seg_hi)
        try:
            logs = logs_window(src, lo, hi)
        except RuntimeError:
            if step <= 500:
                raise
            step //= 2
            continue
        for lg in logs:
            t = lg["topics"] + [None] * (4 - len(lg["topics"]))
            rows.append(
                {
                    "block": int(lg["blockNumber"], 16),
                    "tx_index": int(lg["transactionIndex"], 16),
                    "log_index": int(lg["logIndex"], 16),
                    "tx_hash": lg["transactionHash"],
                    "address": lg["address"].lower(),
                    "topic0": t[0],
                    "topic1": t[1],
                    "topic2": t[2],
                    "topic3": t[3],
                    "data": lg["data"],
                }
            )
        lo = hi + 1
        if len(logs) < 2_000:
            step = min(step * 2, 400_000)
        elif len(logs) > 7_000:
            step = max(step // 2, 500)
    out.parent.mkdir(parents=True, exist_ok=True)
    schema = {k: pl.Utf8 for k in ("tx_hash", "address", "topic0", "topic1", "topic2", "topic3", "data")}
    schema.update({"block": pl.Int64, "tx_index": pl.Int32, "log_index": pl.Int32})
    tmp = out.with_suffix(".tmp")
    pl.DataFrame(rows, schema=schema).write_parquet(tmp)
    tmp.rename(out)
    return len(rows)


def fetch_ts_segment(seg_lo: int, seg_hi: int) -> int:
    out = DATA / "block_ts" / f"{seg_lo:010d}_{seg_hi:010d}.parquet"
    if out.exists():
        return -1
    blocks = list(range(seg_lo, seg_hi + 1, TS_ANCHOR_EVERY)) + [seg_hi]
    rows = []
    for i in range(0, len(blocks), 100):
        chunk = blocks[i : i + 100]
        res = rpc_batch([("eth_getBlockByNumber", [hex(b), False]) for b in chunk])
        rows += [{"block": b, "ts": int(r["timestamp"], 16)} for b, r in zip(chunk, res) if r]
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    pl.DataFrame(rows, schema={"block": pl.Int64, "ts": pl.Int64}).unique("block").sort("block").write_parquet(tmp)
    tmp.rename(out)
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["ts", *SOURCES.keys()], default=None)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--start", type=int, default=0)
    args = ap.parse_args()

    head = head_block() - 20  # stay a few blocks behind head
    last_full = (head // SEGMENT) * SEGMENT  # the open segment is refreshed by the live indexer later
    segs = [(s, s + SEGMENT - 1) for s in range(args.start, last_full, SEGMENT)]
    print(f"head={head} segments={len(segs)} ({segs[0][0]}..{segs[-1][1]})", flush=True)

    jobs = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        if args.only in (None, "ts"):
            jobs += [ex.submit(fetch_ts_segment, lo, hi) for lo, hi in segs]
        for name, src in SOURCES.items():
            if args.only in (None, name):
                jobs += [ex.submit(fetch_segment, name, src, lo, hi) for lo, hi in segs]
        done, t0 = 0, time.time()
        for f in as_completed(jobs):
            done += 1
            try:
                n = f.result()
            except Exception as e:  # noqa: BLE001 — report and keep going; rerun resumes
                print(f"segment failed: {e}", flush=True)
                continue
            if done % 10 == 0 or done == len(jobs):
                print(f"{done}/{len(jobs)} segments ({time.time()-t0:.0f}s), last n={n}", flush=True)


if __name__ == "__main__":
    main()
