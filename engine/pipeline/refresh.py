"""One refresh pass of the DeltaDesk data pipeline (run every ~10 min by scripts/start.sh on the server).

    uv run python -m pipeline.refresh [--full]

Steps (each isolated: a failure is logged and the next step still runs):
  1. HyperSync incremental backfill of every source (indexer.hs_backfill)
  2. Hyperliquid candles, at most hourly (indexer.hl_candles)
  3. Pool-level markout study (markout.study)
  4. M1 modules, when installed: HL re-mark, positions/tearsheets, Flow X-ray, gap-exclusion backtest
     (heavy ones hourly unless --full)
A lock file prevents overlapping passes.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
DATA = ENGINE.parent / "data"
STATE = DATA / "pipeline_state.json"
LOCK = DATA / "pipeline.lock"

STEPS = [
    # (name, [module, *args], min interval seconds). Core sources first so the study, tearsheets and League exist
    # within ~15 min of a fresh deploy; the heavy sources (swap senders, Base) follow and feed the Flow X-ray.
    ("hyper_sync", ["indexer.hs_backfill", "v3_nvda_usdg", "v4_pools", "chainlink", "lp_txs", "npm_transfers", "posm_transfers"], 0),
    ("hl_candles", ["indexer.hl_candles"], 3600),
    ("study_m0", ["markout.study"], 0),
    ("hl_ref", ["markout.hl_ref"], 0),
    ("positions", ["positions.attribute"], 3600),
    ("league", ["league.build"], 3600),
    # Base first (small ranges), then the long Robinhood swap-sender backfill. base_npm_transfers is left out: a
    # Transfer-topic scan on Base is slow, and owners come from the mint tx (base_aero_lp_txs) plus gauge events.
    ("hyper_sync_heavy", ["indexer.hs_backfill", "base_aero_nvda", "base_aero_gauge", "base_aero_usdc", "base_aero_lp_txs",
                          "base_aero_swap_txs", "swap_txs"], 1800),
    ("aero_study", ["aero.study"], 3600),          # Base: NVDAc/USDC pool study, emissions, voter fee split
    ("aero_positions", ["aero.positions"], 3600),  # Base: staked / unstaked tearsheets
    ("flow", ["flow.xray"], 3600),
    ("backtest", ["backtest.gap_exclusion"], 6 * 3600),
]


def installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except ModuleNotFoundError:
        return False


def main():
    full = "--full" in sys.argv
    DATA.mkdir(parents=True, exist_ok=True)
    if LOCK.exists() and time.time() - LOCK.stat().st_mtime < 3 * 3600:
        print("refresh already running; skipping")
        return
    LOCK.write_text(str(os.getpid()))
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    try:
        for name, cmd, every in STEPS:
            module = cmd[0]
            last = state.get(name, {}).get("ok_at", 0)
            if not installed(module):
                continue
            if not full and time.time() - last < every:
                continue
            t0 = time.time()
            r = subprocess.run([sys.executable, "-m", *cmd], cwd=ENGINE, capture_output=True, text=True, timeout=4 * 3600)
            ok = r.returncode == 0
            tail = (r.stdout + r.stderr)[-1500:]
            if r.returncode < 0:  # killed by a signal: on the server this is almost always the OOM killer (SIGKILL)
                tail += f"\n[killed by signal {-r.returncode}{' (likely out of memory)' if r.returncode == -9 else ''}]"
            state[name] = {"ok_at": time.time() if ok else last, "ran_at": time.time(), "ok": ok, "rc": r.returncode,
                           "secs": round(time.time() - t0, 1), "tail": tail}
            print(f"{name}: {'ok' if ok else 'FAILED'} in {state[name]['secs']}s", flush=True)
            STATE.write_text(json.dumps(state, indent=1))
    finally:
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
