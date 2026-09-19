"""Reconstruct LP positions on the covered pools from raw logs (M1 · module C, step 1).

Position identity
    v3 NPM       one position per NonfungiblePositionManager tokenId. A pool Mint(owner=NPM) is linked to the NPM
                 IncreaseLiquidity that follows it in the same tx (same liquidity), which gives tokenId <-> ticks; a pool
                 Burn(owner=NPM, amount>0) is linked to the NPM DecreaseLiquidity that follows it. Zero-amount NPM burns
                 are fee pokes from NPM.collect().
    v3 direct    owner != NPM: key (owner, tickLower, tickUpper). A key that goes back to zero liquidity and is minted
                 again starts a new lifecycle (#n), so vault re-mints at the same ticks are separate positions.
    v4 POSM      ModifyLiquidity with sender = POSM: tokenId = int(salt).
    v4 direct    other senders: key (sender, tickLower, tickUpper, salt), with lifecycles like v3 direct.

Every liquidity change is placed at the POOL-level log (v3 Mint/Burn, v4 ModifyLiquidity), ordered by
ord = block·1e9 + tx_index·1e5 + log_index, the same key used for swaps, so JIT mint→swap→burn inside one block only
earns the swaps between its mint and burn log indices.

Owners
    NPM / POSM positions: the ERC-721 holder from npm_transfers / posm_transfers. Ownership is resolved at accrual time:
    a transfer while the position is live is a segment boundary, and each segment carries its holder (see segments()).
    A staking / vault contract that holds the NFT is the owner (the depositor behind it is not resolvable from logs).
    Direct positions: the pool-level owner (v3) or ModifyLiquidity sender (v4), usually a vault / ALM contract.
    `operator` = the most frequent tx.from across a position's LP txs (the wallet or bot that actually manages it).

    uv run python -m positions.reconstruct        # prints a summary (the full pipeline is positions.attribute)
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import polars as pl

from markout.pools import DATA, POOLS, USD_QUOTES, Pool

OUT = DATA / "study" / "m1" / "positions"
RAW = DATA / "raw"

# Contracts (Robinhood Chain 4663); same values as indexer/hs_backfill.py and indexer/backfill.py.
NPM = "0x73991a25c818bf1f1128deaab1492d45638de0d3"
POSM = "0x58daec3116aae6d93017baaea7749052e8a04fa7"
POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
ZERO = "0x" + "0" * 40

# Event topics (verified with `cast sig-event`).
T_V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
T_V3_MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"      # Mint(address,address,int24,int24,uint128,uint256,uint256)
T_V3_BURN = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c"      # Burn(address,int24,int24,uint128,uint256,uint256)
T_V3_COLLECT = "0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0"   # Collect(address,address,int24,int24,uint128,uint128)
T_V3_FLASH = "0xbdbdb71d7860376ba52b25a5028beea23581364a40522f6bcfb86bb1f2dca633"     # Flash(address,address,uint256,uint256,uint256,uint256)
T_V3_INIT = "0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95"      # Initialize(uint160,int24)
T_V3_SET_FEE_PROTOCOL = "0x973d8d92bb299f4af6ce49b52a8adb85ae46b9f214c4c4fc06ac77401237b133"
T_NPM_INC = "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f"      # IncreaseLiquidity(uint256,uint128,uint256,uint256)
T_NPM_DEC = "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4"      # DecreaseLiquidity(uint256,uint128,uint256,uint256)
T_NPM_COLLECT = "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01"  # Collect(uint256,address,uint256,uint256)
T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
T_V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
T_V4_MODIFY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"     # ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)
T_V4_INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"

ORD_BLOCK = 10**9
ORD_TX = 10**5
Q96 = 2.0**96

POOL_BY_KEY = {p.key: p for p in POOLS}


@dataclass(frozen=True)
class ChainCfg:
    npm: str             # v3-style NonfungiblePositionManager
    npm_logs: str        # raw source holding the NPM Increase/Decrease/Collect logs of the pool's LP txs
    txs: str             # raw source holding the LP txs (tx_*.parquet: from, gas)
    npm_transfers: str   # raw source holding the NPM Transfer logs
    npm_pool_owners: tuple[str, ...] = ()  # pool-level owners whose Mint/Burn/Collect are NPM-managed (besides the NPM)


CHAINS = {
    "robinhood": ChainCfg(NPM, "lp_txs", "lp_txs", "npm_transfers"),
    # Aerodrome Slipstream NPM (equity pools): NPM logs, Transfers and txs all from the pool's LP / staking txs
    # (base_aero_lp_txs, JOIN_ALL), so NFT moves outside LP txs are not seen.
    # For a STAKED tokenId the NPM mints / burns / collects with the gauge as the pool-level owner (NPM source:
    # addLiquidity recipient = gauge, burn/collect(..., gauge)), so gauge-owned pool events are NPM-managed too.
    "base": ChainCfg("0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53", "base_aero_lp_txs", "base_aero_lp_txs", "base_aero_lp_txs",
                     npm_pool_owners=("0x30d1e5af5ce39863e6f69a1f73ffb0e1ac9771a8",)),
}


# ---------------------------------------------------------------------------------------------------------------- decoding
def words(hexdata: str) -> list[int]:
    b = bytes.fromhex(hexdata[2:])
    return [int.from_bytes(b[i : i + 32], "big") for i in range(0, len(b), 32)]


def signed(x: int, bits: int = 256) -> int:
    """Two's complement. int24 values in topics / ABI words are sign-extended to 256 bits, so bits=256 is right."""
    return x - (1 << bits) if x >= 1 << (bits - 1) else x


def topic_int(t: str) -> int:
    return int(t, 16)


def topic_i24(t: str) -> int:
    return signed(int(t, 16))


def topic_addr(t: str) -> str:
    return "0x" + t[-40:].lower()


def order_key(block: int, tx_index: int, log_index: int) -> int:
    return block * ORD_BLOCK + tx_index * ORD_TX + log_index


def ord_expr() -> pl.Expr:
    return (pl.col("block").cast(pl.Int64) * ORD_BLOCK + pl.col("tx_index").cast(pl.Int64) * ORD_TX
            + pl.col("log_index").cast(pl.Int64)).alias("ord")


def tick_to_sqrtp(tick) -> np.ndarray:
    """sqrt(1.0001^tick) in raw token1/token0 units (float)."""
    return np.power(1.0001, np.asarray(tick, dtype=np.float64) / 2.0)


def amounts_for_liquidity(L, sqrt_lo, sqrt_hi, sqrt_p) -> tuple[np.ndarray, np.ndarray]:
    """Raw token0/token1 amounts held by liquidity L on [sqrt_lo, sqrt_hi) at pool price sqrt_p (vectorized)."""
    L = np.asarray(L, dtype=np.float64)
    a, b, p = (np.asarray(x, dtype=np.float64) for x in (sqrt_lo, sqrt_hi, sqrt_p))
    pc = np.clip(p, a, b)
    amt0 = L * (1.0 / pc - 1.0 / b)
    amt1 = L * (pc - a)
    return amt0, amt1


def _hex_word_float(col: str, word: int) -> pl.Expr:
    """ABI word `word` of a 0x-hex data column as an unsigned float (15-hex-digit chunks stay inside Int64)."""
    start = 2 + 64 * word
    cuts = [(0, 4), (4, 19), (19, 34), (34, 49), (49, 64)]
    expr = pl.lit(0.0)
    for a, b in cuts:
        part = pl.col(col).str.slice(start + a, b - a).str.to_integer(base=16).cast(pl.Float64)
        expr = expr + part * float(16 ** (64 - b))
    return expr


def _hex_word_i24(col: str, word: int) -> pl.Expr:
    last8 = pl.col(col).str.slice(2 + 64 * word + 56, 8).str.to_integer(base=16).cast(pl.Int64)
    return pl.when(last8 >= 2**31).then(last8 - 2**32).otherwise(last8)


# ------------------------------------------------------------------------------------------------------------------ loading
def scan_logs(source: str) -> pl.LazyFrame:
    files = sorted((RAW / source).glob("hs_*.parquet"))
    if not files:
        raise FileNotFoundError(f"no HyperSync logs for {source}")
    return pl.scan_parquet(files)


def load_logs(source: str, *, address: str | None = None, topic0: list[str] | None = None, topic1: str | None = None) -> pl.DataFrame:
    lf = scan_logs(source)
    if address:
        lf = lf.filter(pl.col("address") == address)
    if topic0:
        lf = lf.filter(pl.col("topic0").is_in(topic0))
    if topic1:
        lf = lf.filter(pl.col("topic1") == topic1)
    return lf.with_columns(ord_expr()).collect().sort("ord")


def load_txs(source: str = "lp_txs") -> pl.DataFrame:
    files = sorted((RAW / source).glob("tx_*.parquet"))
    return pl.concat([pl.read_parquet(f) for f in files]).unique("tx_hash")


def price_path(pool: Pool) -> pl.DataFrame:
    """Pool sqrtPrice after every raw swap (dust included) plus the Initialize price: (ord, ts, sqrtp, tick).

    sqrtp is the float sqrt of the raw token1/token0 price (sqrtPriceX96 / 2^96)."""
    lf = scan_logs(pool.source)
    if pool.venue == "v3":
        sw = lf.filter((pl.col("address") == pool.pool_id) & (pl.col("topic0") == T_V3_SWAP))
        init = lf.filter((pl.col("address") == pool.pool_id) & (pl.col("topic0") == T_V3_INIT))
        init_sqrt, init_tick = _hex_word_float("data", 0), _hex_word_i24("data", 1)
    else:
        sw = lf.filter((pl.col("topic0") == T_V4_SWAP) & (pl.col("topic1") == pool.pool_id))
        init = lf.filter((pl.col("topic0") == T_V4_INIT) & (pl.col("topic1") == pool.pool_id))
        init_sqrt, init_tick = _hex_word_float("data", 3), _hex_word_i24("data", 4)
    a = sw.select(ord_expr(), pl.col("ts").cast(pl.Float64), (_hex_word_float("data", 2) / Q96).alias("sqrtp"),
                  _hex_word_i24("data", 4).alias("tick"), _hex_word_float("data", 3).alias("liq_event"))
    b = init.select(ord_expr(), pl.col("ts").cast(pl.Float64), (init_sqrt / Q96).alias("sqrtp"), init_tick.alias("tick"),
                    pl.lit(None, pl.Float64).alias("liq_event"))
    return pl.concat([b, a]).collect().sort("ord")


def exact_swap_liquidity(pool: Pool, ord_: int) -> int:
    """Exact uint128 `liquidity` field of the swap log at `ord_` (for the final-state reconstruction check)."""
    b, rest = divmod(ord_, ORD_BLOCK)
    txi, li = divmod(rest, ORD_TX)
    df = scan_logs(pool.source).filter((pl.col("block") == b) & (pl.col("tx_index") == txi) & (pl.col("log_index") == li)).collect()
    return words(df["data"][0])[3]


def mid_from_sqrtp(pool: Pool, sqrtp) -> np.ndarray:
    """Quote per base (human units) from float sqrt(raw token1/token0)."""
    raw_p = np.asarray(sqrtp, dtype=np.float64) ** 2 * 10.0 ** (pool.dec0 - pool.dec1)
    return raw_p if pool.base_is_0 else 1.0 / raw_p


class UsdPricer:
    """USD per HUMAN token0 / token1 of a pool at a given ord (pool state after the last swap before it).

    USDG / USDC = $1. Stocks: the pool's own mid. QQQ/SPY: SPY valued with the SPY/USDG pool mid at the same timestamp."""

    def __init__(self, pool: Pool, path: pl.DataFrame, spy_path: pl.DataFrame | None = None):
        self.pool = pool
        self.ord = path["ord"].to_numpy()
        self.ts = path["ts"].to_numpy()
        self.sqrtp = path["sqrtp"].to_numpy()
        self.tick = path["tick"].to_numpy()
        self.spy = None
        if pool.quote not in USD_QUOTES:
            spy_pool = POOL_BY_KEY["SPY/USDG"]
            spy_path = spy_path if spy_path is not None else price_path(spy_pool)
            self.spy = (spy_path["ts"].to_numpy(), mid_from_sqrtp(spy_pool, spy_path["sqrtp"].to_numpy()))

    def state_at(self, ords) -> tuple[np.ndarray, np.ndarray]:
        """(sqrtp, tick) of the pool just before each ord (initial state if nothing earlier)."""
        i = np.searchsorted(self.ord, np.asarray(ords, dtype=np.int64), side="left") - 1
        i = np.clip(i, 0, len(self.ord) - 1)
        return self.sqrtp[i], self.tick[i]

    def state_at_ts(self, ts) -> np.ndarray:
        i = np.searchsorted(self.ts, np.asarray(ts, dtype=np.float64), side="right") - 1
        return self.sqrtp[np.clip(i, 0, len(self.ts) - 1)]

    def quote_usd_at_ts(self, ts) -> np.ndarray:
        ts = np.asarray(ts, dtype=np.float64)
        if self.spy is None:
            return np.ones_like(ts)
        t, m = self.spy
        return m[np.clip(np.searchsorted(t, ts, side="right") - 1, 0, len(t) - 1)]

    def usd01(self, sqrtp, ts) -> tuple[np.ndarray, np.ndarray]:
        mid = mid_from_sqrtp(self.pool, sqrtp)
        qu = self.quote_usd_at_ts(ts)
        base_usd = mid * qu
        return (base_usd, qu) if self.pool.base_is_0 else (qu, base_usd)


# ----------------------------------------------------------------------------------------------------------- reconstruction
@dataclass
class PoolPositions:
    pool: Pool
    positions: pl.DataFrame            # one row per position
    events: pl.DataFrame               # liquidity changes (inc / dec), pool-log order
    collects: pl.DataFrame             # v3 realized: NPM Collect per tokenId, pool Collect per direct key (raw amounts)
    transfers: pl.DataFrame            # NFT transfers of the positions' tokenIds (owner timeline)
    touches: pl.DataFrame              # (pos_id, tx_hash): every tx that touched the position (gas attribution)
    diag: dict = field(default_factory=dict)


def _lifecycle_ids(keys: list[tuple], dls: list[int], prefix: str) -> tuple[list[str], dict]:
    """Assign lifecycle ids to direct positions: a key that returns to zero liquidity and is re-minted starts #n+1."""
    live: dict[tuple, int] = {}
    n: dict[tuple, int] = {}
    out = []
    for k, dl in zip(keys, dls):
        cur = live.get(k, 0)
        if dl > 0 and cur == 0:
            n[k] = n.get(k, 0) + 1
        live[k] = cur + dl
        out.append(f"{prefix}:{':'.join(str(x) for x in k)}#{max(n.get(k, 1), 1)}")
    return out, live


def reconstruct_v3(pool: Pool) -> PoolPositions:
    cfg = CHAINS[pool.chain]
    npm = cfg.npm
    npm_owned = {npm, *cfg.npm_pool_owners}
    plog = load_logs(pool.source, address=pool.pool_id, topic0=[T_V3_MINT, T_V3_BURN, T_V3_COLLECT])
    nlog = load_logs(cfg.npm_logs, address=npm, topic0=[T_NPM_INC, T_NPM_DEC, T_NPM_COLLECT])
    allev = pl.concat([plog, nlog], how="diagonal_relaxed").sort("ord")
    cols = ["ord", "block", "tx_index", "log_index", "tx_hash", "ts", "address", "topic0", "topic1", "topic2", "topic3", "data"]

    ev_rows: list[dict] = []          # liquidity changes
    col_rows: list[dict] = []         # realized flows (collect / principal)
    npm_collect: list[dict] = []
    token_ticks: dict[int, tuple[int, int]] = {}
    pend_mint: dict | None = None
    pend_burn: dict | None = None
    cur_tx = None
    n_npm_mint = n_npm_burn = linked_mint = linked_burn = n_pokes = 0
    direct_keys: list[tuple] = []
    direct_idx: list[int] = []

    for r in allev.select(cols).iter_rows(named=True):
        if r["tx_hash"] != cur_tx:
            cur_tx, pend_mint, pend_burn = r["tx_hash"], None, None
        base = {k: r[k] for k in ("ord", "block", "tx_index", "log_index", "tx_hash", "ts")}
        t0 = r["topic0"]
        if r["address"] == pool.pool_id:
            owner = topic_addr(r["topic1"])
            lo, hi = topic_i24(r["topic2"]), topic_i24(r["topic3"])
            w = words(r["data"])
            if t0 == T_V3_MINT:
                rec = {**base, "etype": "inc", "lower": lo, "upper": hi, "dL": w[1], "amount0": w[2], "amount1": w[3], "pool_owner": owner}
                if owner in npm_owned:
                    n_npm_mint += 1
                    pend_mint = rec
                else:
                    direct_keys.append((owner, lo, hi)); direct_idx.append(len(ev_rows)); ev_rows.append(rec)
            elif t0 == T_V3_BURN:
                rec = {**base, "etype": "dec", "lower": lo, "upper": hi, "dL": w[0], "amount0": w[1], "amount1": w[2], "pool_owner": owner}
                if owner in npm_owned:
                    if w[0] > 0:
                        n_npm_burn += 1
                        pend_burn = rec
                    else:
                        n_pokes += 1
                elif w[0] > 0 or w[1] > 0 or w[2] > 0:
                    direct_keys.append((owner, lo, hi)); direct_idx.append(len(ev_rows)); ev_rows.append(rec)
                else:
                    col_rows.append({**base, "kind": "poke", "key": (owner, lo, hi), "amount0": 0, "amount1": 0})
            elif t0 == T_V3_COLLECT and owner not in npm_owned:
                col_rows.append({**base, "kind": "collect", "key": (owner, lo, hi), "amount0": w[1], "amount1": w[2]})
        else:  # NPM
            tid = topic_int(r["topic1"])
            w = words(r["data"])
            if t0 == T_NPM_INC:
                if pend_mint is not None and pend_mint["dL"] == w[0]:
                    tk = (pend_mint["lower"], pend_mint["upper"])
                    if token_ticks.setdefault(tid, tk) != tk:
                        raise ValueError(f"tokenId {tid}: ticks changed {token_ticks[tid]} -> {tk}")
                    ev_rows.append({**pend_mint, "token_id": tid, "npm_ord": r["ord"]})
                    linked_mint += 1
                    pend_mint = None
            elif t0 == T_NPM_DEC:
                if (pend_burn is not None and pend_burn["dL"] == w[0] and tid in token_ticks
                        and token_ticks[tid] == (pend_burn["lower"], pend_burn["upper"])):
                    ev_rows.append({**pend_burn, "token_id": tid, "npm_ord": r["ord"]})
                    linked_burn += 1
                    pend_burn = None
            elif t0 == T_NPM_COLLECT:
                npm_collect.append({**base, "token_id": tid, "amount0": w[1], "amount1": w[2]})

    # position ids
    for i, rec in enumerate(ev_rows):
        if "token_id" in rec:
            rec["pos_id"] = f"{pool.key}:npm:{rec['token_id']}"
            rec["kind"] = "v3_npm"
            rec["owner_key"] = npm
    lids, _ = _lifecycle_ids(direct_keys, [(1 if ev_rows[i]["etype"] == "inc" else -1) * ev_rows[i]["dL"] for i in direct_idx], f"{pool.key}:v3")
    key_life: dict[tuple, list[tuple[int, str]]] = {}
    for i, lid, k in zip(direct_idx, lids, direct_keys):
        ev_rows[i]["pos_id"] = lid
        ev_rows[i]["kind"] = "v3_direct"
        ev_rows[i]["owner_key"] = k[0]
        ev_rows[i]["token_id"] = None
        key_life.setdefault(k, []).append((ev_rows[i]["ord"], lid))

    # realized flows: NPM collects by tokenId; direct collects by key -> lifecycle live (or last closed) at that time
    realized = []
    for c in npm_collect:
        if c["token_id"] in token_ticks:
            realized.append({**{k: c[k] for k in ("ord", "block", "tx_hash", "ts")}, "pos_id": f"{pool.key}:npm:{c['token_id']}",
                             "kind": "collect", "amount0": float(c["amount0"]), "amount1": float(c["amount1"])})
    orphan_direct = 0
    for c in col_rows:
        life = key_life.get(c["key"])
        prior = [lid for o, lid in (life or []) if o < c["ord"]]
        if not prior:
            orphan_direct += 1
            continue
        realized.append({**{k: c[k] for k in ("ord", "block", "tx_hash", "ts")}, "pos_id": prior[-1], "kind": c["kind"],
                         "amount0": float(c["amount0"]), "amount1": float(c["amount1"])})

    events = _events_frame(pool, ev_rows)
    collects = pl.DataFrame(realized, schema={"ord": pl.Int64, "block": pl.Int64, "tx_hash": pl.Utf8, "ts": pl.Int64, "pos_id": pl.Utf8,
                                              "kind": pl.Utf8, "amount0": pl.Float64, "amount1": pl.Float64}, orient="row")
    transfers = _nft_transfers(cfg.npm_transfers, npm, pool, {tid: f"{pool.key}:npm:{tid}" for tid in token_ticks})
    diag = {"npm_pool_mints": n_npm_mint, "npm_mints_linked": linked_mint, "npm_pool_burns_nonzero": n_npm_burn,
            "npm_burns_linked": linked_burn, "npm_poke_burns": n_pokes, "npm_tokenids": len(token_ticks),
            "direct_collects_without_position": orphan_direct}
    touches = pl.concat([events.select("pos_id", "tx_hash"), collects.select("pos_id", "tx_hash")]).unique()
    return _finish(pool, events, collects, transfers, touches, diag)


def reconstruct_v4(pool: Pool) -> PoolPositions:
    mlog = load_logs(pool.source, topic0=[T_V4_MODIFY], topic1=pool.pool_id)
    rows, keys, idx, pokes = [], [], [], []
    for r in mlog.select(["ord", "block", "tx_index", "log_index", "tx_hash", "ts", "topic2", "data"]).iter_rows(named=True):
        sender = topic_addr(r["topic2"])
        w = words(r["data"])
        lo, hi, dl, salt = signed(w[0]), signed(w[1]), signed(w[2]), w[3]
        base = {k: r[k] for k in ("ord", "block", "tx_index", "log_index", "tx_hash", "ts")}
        if sender == POSM:
            pid, kind, tid = f"{pool.key}:posm:{salt}", "v4_posm", salt
        else:
            pid, kind, tid = None, "v4_direct", None
        if dl == 0:
            pokes.append({**base, "sender": sender, "lower": lo, "upper": hi, "salt": salt, "pos_id": pid})
            continue
        rec = {**base, "etype": "inc" if dl > 0 else "dec", "lower": lo, "upper": hi, "dL": abs(dl), "amount0": None, "amount1": None,
               "pool_owner": sender, "owner_key": sender, "kind": kind, "token_id": tid, "pos_id": pid, "salt": salt}
        if pid is None:
            keys.append((sender, lo, hi, f"{salt:x}")); idx.append(len(rows))
        rows.append(rec)
    lids, _ = _lifecycle_ids(keys, [(1 if rows[i]["etype"] == "inc" else -1) * rows[i]["dL"] for i in idx], f"{pool.key}:v4")
    key_life: dict[tuple, list[tuple[int, str]]] = {}
    for i, lid, k in zip(idx, lids, keys):
        rows[i]["pos_id"] = lid
        key_life.setdefault(k, []).append((rows[i]["ord"], lid))
    touch_rows = []
    for p in pokes:  # zero-delta modify = fee collection; attribute its gas to the position it touched
        if p["pos_id"] is None:
            life = key_life.get((p["sender"], p["lower"], p["upper"], f"{p['salt']:x}"))
            prior = [lid for o, lid in (life or []) if o < p["ord"]]
            p["pos_id"] = prior[-1] if prior else None
        if p["pos_id"] is not None:
            touch_rows.append({"pos_id": p["pos_id"], "tx_hash": p["tx_hash"]})

    # v4 events carry no token amounts: compute them from liquidityDelta at the pool price just before the event
    path = price_path(pool)
    pr = UsdPricer(pool, path)
    ords = np.array([r["ord"] for r in rows], dtype=np.int64)
    sq, _ = pr.state_at(ords)
    lo = tick_to_sqrtp([r["lower"] for r in rows])
    hi = tick_to_sqrtp([r["upper"] for r in rows])
    a0, a1 = amounts_for_liquidity([float(r["dL"]) for r in rows], lo, hi, sq)
    for r, x0, x1 in zip(rows, a0, a1):
        r["amount0"], r["amount1"] = float(x0), float(x1)

    events = _events_frame(pool, rows)
    posm_ids = {r["token_id"]: r["pos_id"] for r in rows if r["kind"] == "v4_posm"}
    transfers = _nft_transfers("posm_transfers", POSM, pool, posm_ids)
    collects = pl.DataFrame(schema={"ord": pl.Int64, "block": pl.Int64, "tx_hash": pl.Utf8, "ts": pl.Int64, "pos_id": pl.Utf8,
                                    "kind": pl.Utf8, "amount0": pl.Float64, "amount1": pl.Float64})
    touches = pl.concat([events.select("pos_id", "tx_hash"),
                         pl.DataFrame(touch_rows, schema={"pos_id": pl.Utf8, "tx_hash": pl.Utf8})]).unique()
    diag = {"modify_events": mlog.height, "zero_delta_pokes": len(pokes), "posm_tokenids": len(posm_ids)}
    return _finish(pool, events, collects, transfers, touches, diag)


def _events_frame(pool: Pool, rows: list[dict]) -> pl.DataFrame:
    df = pl.DataFrame(
        [{"pool": pool.key, "pos_id": r["pos_id"], "kind": r["kind"], "token_id": r.get("token_id"), "owner_key": r["owner_key"],
          "lower": r["lower"], "upper": r["upper"], "ord": r["ord"], "block": r["block"], "tx_index": r["tx_index"],
          "log_index": r["log_index"], "tx_hash": r["tx_hash"], "ts": r["ts"], "etype": r["etype"], "dL_exact": str(r["dL"]),
          "dL": float(r["dL"]), "amount0": float(r["amount0"]), "amount1": float(r["amount1"])} for r in rows],
        schema={"pool": pl.Utf8, "pos_id": pl.Utf8, "kind": pl.Utf8, "token_id": pl.Utf8, "owner_key": pl.Utf8, "lower": pl.Int64,
                "upper": pl.Int64, "ord": pl.Int64, "block": pl.Int64, "tx_index": pl.Int64, "log_index": pl.Int64, "tx_hash": pl.Utf8,
                "ts": pl.Int64, "etype": pl.Utf8, "dL_exact": pl.Utf8, "dL": pl.Float64, "amount0": pl.Float64, "amount1": pl.Float64},
        orient="row",
    ) if rows else None
    if df is None:
        raise ValueError(f"{pool.key}: no liquidity events")
    # exact running liquidity per position (python ints: uint128 overflows int64)
    run: dict[str, int] = {}
    after = []
    for pid, et, d in df.select("pos_id", "etype", "dL_exact").iter_rows():
        run[pid] = run.get(pid, 0) + (int(d) if et == "inc" else -int(d))
        if run[pid] < 0:
            raise ValueError(f"{pid}: negative liquidity")
        after.append(str(run[pid]))
    return df.with_columns(pl.Series("L_after_exact", after), pl.Series("L_after", [float(x) for x in after])).sort("ord")


def _nft_transfers(source: str, address: str, pool: Pool, ids: dict[int, str]) -> pl.DataFrame:
    schema = {"pos_id": pl.Utf8, "ord": pl.Int64, "block": pl.Int64, "tx_index": pl.Int64, "ts": pl.Int64, "from": pl.Utf8, "to": pl.Utf8}
    if not ids:
        return pl.DataFrame(schema=schema)
    hexids = {"0x" + format(t, "064x"): pid for t, pid in ids.items()}
    lf = scan_logs(source).filter((pl.col("address") == address) & (pl.col("topic0") == T_TRANSFER) & pl.col("topic3").is_in(list(hexids)))
    df = lf.with_columns(ord_expr()).collect()
    return df.select(
        pl.col("topic3").replace_strict(hexids).alias("pos_id"), "ord", "block", pl.col("tx_index").cast(pl.Int64), pl.col("ts").cast(pl.Int64),
        ("0x" + pl.col("topic1").str.slice(26)).alias("from"), ("0x" + pl.col("topic2").str.slice(26)).alias("to"),
    ).sort("ord")


def _finish(pool: Pool, events: pl.DataFrame, collects: pl.DataFrame, transfers: pl.DataFrame, touches: pl.DataFrame, diag: dict) -> PoolPositions:
    txs = load_txs(CHAINS[pool.chain].txs).select("tx_hash", "from")
    op = (touches.join(txs, on="tx_hash", how="left").group_by("pos_id", "from").len()
          .sort(["pos_id", "len", "from"], descending=[False, True, False]).group_by("pos_id").first()
          .select("pos_id", pl.col("from").alias("operator")))
    first_holder = transfers.filter(pl.col("from") == ZERO).group_by("pos_id").agg(pl.col("to").first().alias("minted_to"))
    last_holder = transfers.group_by("pos_id").agg(pl.col("to").filter(pl.col("to") != ZERO).last().alias("holder_last"),
                                                  (pl.col("to") == ZERO).any().alias("nft_burned"),
                                                  ((pl.col("from") != ZERO) & (pl.col("to") != ZERO)).sum().alias("n_transfers"))
    pos = (
        events.group_by("pos_id").agg(
            pl.col("pool").first(), pl.col("kind").first(), pl.col("token_id").first(), pl.col("owner_key").first(),
            pl.col("lower").first(), pl.col("upper").first(),
            pl.col("ord").min().alias("ord_open"), pl.col("ord").max().alias("ord_last"),
            pl.col("block").min().alias("block_open"), pl.col("block").max().alias("block_last"),
            pl.col("ts").min().alias("ts_open"), pl.col("ts").max().alias("ts_last"),
            (pl.col("etype") == "inc").sum().alias("n_inc"), (pl.col("etype") == "dec").sum().alias("n_dec"),
            pl.col("L_after_exact").last().alias("L_end_exact"), pl.col("L_after").last().alias("L_end"),
            pl.col("L_after").max().alias("L_max"),
        )
        .join(op, on="pos_id", how="left").join(first_holder, on="pos_id", how="left").join(last_holder, on="pos_id", how="left")
        .with_columns(
            (pl.col("upper") - pl.col("lower")).alias("width_ticks"),
            (pl.col("L_end_exact") == "0").alias("closed"),
            pl.col("nft_burned").fill_null(False), pl.col("n_transfers").fill_null(0),
            # owner: NFT holder (last) for NPM/POSM, pool-level owner / sender for direct positions
            pl.when(pl.col("kind").is_in(["v3_npm", "v4_posm"])).then(pl.coalesce("holder_last", "minted_to", "operator"))
            .otherwise(pl.col("owner_key")).alias("owner"),
        )
        .sort("ord_open")
    )
    return PoolPositions(pool, pos, events, collects, transfers, touches, diag)


def reconstruct(pool: Pool) -> PoolPositions:
    return reconstruct_v3(pool) if pool.venue == "v3" else reconstruct_v4(pool)


def owner_timeline(pp: PoolPositions) -> pl.DataFrame:
    """(pos_id, ord, holder): NFT holder from each (non-burn) transfer log on, at log level."""
    return pp.transfers.filter(pl.col("to") != ZERO).select("pos_id", "ord", pl.col("to").alias("holder")).sort(["pos_id", "ord"])


def segments(pp: PoolPositions) -> pl.DataFrame:
    """Constant-liquidity segments per position, split at liquidity changes and at live NFT transfers.

    Each row: pos_id, seg (0..), start ord/ts, end ord/ts (null = still open at the data end), L (float), holder at start.
    The sweep in positions.attribute uses the start/end ords as the fee-growth snapshot points."""
    ev = pp.events.select("pos_id", "ord", "ts", "L_after", pl.lit("liq").alias("src"))
    first_last = pp.positions.select("pos_id", "ord_open", "ord_last", "closed")
    tr = (pp.transfers.filter((pl.col("from") != ZERO) & (pl.col("to") != ZERO))
          .join(first_last, on="pos_id").filter((pl.col("ord") > pl.col("ord_open")) & (~pl.col("closed") | (pl.col("ord") < pl.col("ord_last"))))
          .select("pos_id", "ord", "ts", pl.lit(None, pl.Float64).alias("L_after"), pl.lit("owner").alias("src")))
    b = pl.concat([ev, tr]).sort(["pos_id", "ord"]).with_columns(pl.col("L_after").forward_fill().over("pos_id"))
    b = b.with_columns(
        pl.col("ord").shift(-1).over("pos_id").alias("end_ord"), pl.col("ts").shift(-1).over("pos_id").alias("end_ts"),
    ).filter(pl.col("L_after") > 0).rename({"ord": "start_ord", "ts": "start_ts", "L_after": "L"})
    # holder at segment start: latest transfer log at or before it. The NFT-mint Transfer is emitted after the pool Mint
    # log in the same tx, so a first segment with no earlier transfer takes the minted-to holder.
    tl = owner_timeline(pp)
    if tl.height:
        b = b.sort("start_ord").join_asof(tl.rename({"ord": "start_ord"}).sort("start_ord"), on="start_ord", by="pos_id",
                                          strategy="backward", check_sortedness=False)
        first = tl.group_by("pos_id").agg(pl.col("holder").sort_by("ord").first().alias("_first"))
        b = b.join(first, on="pos_id", how="left").with_columns(pl.coalesce("holder", "_first").alias("holder")).drop("_first")
    else:
        b = b.with_columns(pl.lit(None, pl.Utf8).alias("holder"))
    b = b.join(pp.positions.select("pos_id", "owner_key", "kind"), on="pos_id").with_columns(
        pl.when(pl.col("kind").is_in(["v3_npm", "v4_posm"]) & pl.col("holder").is_not_null()).then(pl.col("holder"))
        .otherwise(pl.col("owner_key")).alias("seg_owner")
    ).drop("owner_key", "kind", "holder")
    return b.sort(["pos_id", "start_ord"]).with_columns(pl.int_range(pl.len()).over("pos_id").alias("seg")).select(
        "pos_id", "seg", "start_ord", "start_ts", "end_ord", "end_ts", "L", "seg_owner", "src")


def main():
    for pool in POOLS:
        pp = reconstruct(pool)
        p = pp.positions
        print(f"{pool.key}: {p.height:,} positions ({p['closed'].sum():,} closed), {pp.events.height:,} liquidity events, "
              f"{pp.transfers.height:,} NFT transfers; kinds {dict(p.group_by('kind').len().iter_rows())}")
        print("   diag:", pp.diag)


if __name__ == "__main__":
    main()
