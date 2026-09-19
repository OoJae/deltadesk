"""Copy raw HyperSync parquet from the DeltaDesk server to this machine.

The HyperSync token is rate limited and the server's pipeline usually holds its whole budget, so a dev machine pulls the
server's files instead of re-fetching (GET /admin/raw/{source}[/{file}], premium key from .env).

    uv run python -m indexer.sync_raw base_npm base_aero_txs            # download files missing locally
    uv run python -m indexer.sync_raw base_aero_nvda --mirror           # also delete local files the server doesn't have

Files are block ranges (hs_<from>_<to>.parquet, tx_<from>_<to>.parquet); local and server files with different
boundaries would overlap and double-count, so without --mirror a source whose local files are not all on the server is
skipped.
"""

from __future__ import annotations

import argparse
import os

import httpx

from indexer.hs_backfill import RAW, ROOT

SERVER = os.environ.get("DELTADESK_SERVER", "https://core-production-512e.up.railway.app")


def api_key() -> str:
    if os.environ.get("DELTADESK_API_KEY"):
        return os.environ["DELTADESK_API_KEY"]
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("DELTADESK_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("DELTADESK_API_KEY missing (deltadesk/.env)")


def sync(source: str, mirror: bool, c: httpx.Client) -> None:
    r = c.get(f"{SERVER}/admin/raw/{source}")
    if r.status_code == 404:
        print(f"{source}: not on the server")
        return
    r.raise_for_status()
    remote = {f["name"]: f["bytes"] for f in r.json()}
    d = RAW / source
    local = {p.name: p.stat().st_size for p in d.glob("*.parquet")} if d.exists() else {}
    extra = sorted(set(local) - set(remote))
    if extra and not mirror:
        print(f"{source}: SKIPPED, {len(extra)} local file(s) not on the server (e.g. {extra[0]}); rerun with --mirror to replace them")
        return
    d.mkdir(parents=True, exist_ok=True)
    got = 0
    for name, size in sorted(remote.items()):
        if local.get(name) == size:
            continue
        tmp = d / f".{name}.part"
        with c.stream("GET", f"{SERVER}/admin/raw/{source}/{name}") as resp:
            resp.raise_for_status()
            with tmp.open("wb") as fh:
                for chunk in resp.iter_bytes(1 << 20):
                    fh.write(chunk)
        tmp.rename(d / name)
        got += 1
    for name in extra:
        (d / name).unlink()
    print(f"{source}: {got} downloaded, {len(remote) - got} up to date, {len(extra)} local-only removed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+")
    ap.add_argument("--mirror", action="store_true")
    a = ap.parse_args()
    with httpx.Client(headers={"x-deltadesk-key": api_key()}, timeout=120, follow_redirects=True) as c:
        for s in a.sources:
            sync(s, a.mirror, c)


if __name__ == "__main__":
    main()
