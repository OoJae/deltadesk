#!/usr/bin/env python3
"""Write abi/extras.json: the implementation-only ABI items (errors, events, views, admin functions) that the frozen
interface snapshot in abi/I*.json does not carry, so the agent and the web can decode every revert and read the
factory's listing and implementation-timelock state. Run after `forge build`:

    python3 scripts/abi-extras.py            # write abi/extras.json
    python3 scripts/abi-extras.py --check    # exit 1 if abi/extras.json is out of date
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAIRS = {"lane": ("DeskLaneV3", "IDeskLane"), "factory": ("DeskLaneFactory", "IDeskLaneFactory"),
         "fence": ("ChainlinkFence", "IPriceFence")}


def key(x):
    return (x["type"], x.get("name"), tuple(i["type"] for i in x.get("inputs", [])))


def build() -> dict:
    out = {"generated_by": "contracts/scripts/abi-extras.py"}
    for name, (impl, iface) in PAIRS.items():
        frozen = {key(x) for x in json.loads((ROOT / "abi" / f"{iface}.json").read_text())}
        full = json.loads((ROOT / "out" / f"{impl}.sol" / f"{impl}.json").read_text())["abi"]
        out[name] = [x for x in full if x["type"] in ("function", "error", "event") and key(x) not in frozen]
    return out


if __name__ == "__main__":
    text = json.dumps(build(), indent=1) + "\n"
    dest = ROOT / "abi" / "extras.json"
    if "--check" in sys.argv:
        ok = dest.exists() and dest.read_text() == text
        print("abi/extras.json up to date" if ok else "abi/extras.json is stale: run scripts/abi-extras.py")
        sys.exit(0 if ok else 1)
    dest.write_text(text)
    print(f"wrote {dest.relative_to(ROOT)}")
