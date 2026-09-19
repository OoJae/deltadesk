#!/usr/bin/env python3
"""Summarise an invariant campaign for contracts/reports.

Inputs: the per-run JSON lines DeskInvariantBase appends to DESK_INVARIANT_LOG, and (optionally) the text output of
`forge test` for the same campaign (for the per-selector calls/reverts table and the PASS/FAIL lines).

    python3 reports/summarize.py reports/<runs>.jsonl [forge-output.txt] [summary.json] > reports/<summary>.txt
"""
import json
import subprocess
import sys

ACTIONS = (
    "honest.rerange honest.reducing evil.rerange evil.call evil.rawCalldata attacker.swap attacker.donate "
    "attacker.sendNft attacker.npmDirect attacker.increaseLanePosition attacker.spoofCallback attacker.laneCall "
    "owner.withdraw owner.withdrawAll owner.withdrawPosition owner.pause owner.unpause owner.tightenCaps "
    "owner.loosenCaps owner.applyCaps owner.cancelCaps owner.operator owner.guardian owner.closedUntil owner.deposit "
    "owner.rerange guardian.reducing guardian.closedUntil guardian.forbidden env.warp env.movePrice "
    "env.chainlinkStockStep env.chainlinkQuoteStep env.feedAge env.feedDecimals env.feedRevert env.feedBroken "
    "env.oraclePaused env.corporateAction env.feedHeal env.tokenPause"
).split()
INVARIANTS = [f"I{i}" for i in range(1, 15)]


def error_names():
    """Map 4-byte error selectors to names from the compiled artifacts (best effort)."""
    names = {"0x00000000": "(no data: unknown selector / bad ABI)", "0x08c379a0": "Error(string)"}
    for art in (
        "out/DeskLaneV3.sol/DeskLaneV3.json",
        "out/MockToken.sol/MockToken.json",
        "out/ReentrancyGuardTransient.sol/ReentrancyGuardTransient.json",
        "out/SafeERC20.sol/SafeERC20.json",
    ):
        try:
            abi = json.load(open(art))["abi"]
        except OSError:
            continue
        for item in abi:
            if item["type"] != "error":
                continue
            sig = item["name"] + "(" + ",".join(i["type"] for i in item["inputs"]) + ")"
            sel = subprocess.run(["cast", "sig", sig], capture_output=True, text=True).stdout.strip()
            if sel:
                names[sel] = item["name"]
    return names


def main():
    rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
    forge = open(sys.argv[2]).read() if len(sys.argv) > 2 else ""
    json_out = sys.argv[3] if len(sys.argv) > 3 else None
    n = len(rows)
    total = lambda key: [sum(r[key][i] for r in rows) for i in range(len(ACTIONS))]
    calls, ok, rev = total("calls"), total("laneOk"), total("laneReverts")
    out = []
    out.append(f"runs logged: {n}")
    out.append(f"handler actions: {sum(calls)}   lane calls: ok {sum(ok)}, reverted {sum(rev)}")
    viol = [sum(r["violations"][i] for r in rows) for i in range(14)]
    out.append("violations: " + ", ".join(f"{INVARIANTS[i]}={viol[i]}" for i in range(14)))
    out.append("")
    out.append(f"{'inner action':32s} {'calls':>8s} {'lane ok':>8s} {'lane rev':>8s}")
    for i, name in enumerate(ACTIONS):
        out.append(f"{name:32s} {calls[i]:8d} {ok[i]:8d} {rev[i]:8d}")
    out.append("")
    names = error_names()
    agg = {}
    for r in rows:
        for sel, cnt in r["revertsBy"].items():
            agg[sel] = agg.get(sel, 0) + cnt
    out.append("lane reverts by error:")
    for sel, cnt in sorted(agg.items(), key=lambda kv: -kv[1]):
        out.append(f"  {names.get(sel, sel):32s} {sel} {cnt}")
    out.append("")
    for key in ("riskReranges", "mints", "priceSteps", "corpSteps", "donations", "foreignNfts", "decisionIds"):
        vals = [r[key] for r in rows]
        out.append(f"{key:18s} total {sum(vals):8d}   max/run {max(vals):6d}   runs with >0: {sum(v > 0 for v in vals)}")
    turn = [r["turnoverUsd6"] for r in rows]
    out.append(f"turnover minted (fence-valued): total ${sum(turn) / 1e6:,.2f}, max/run ${max(turn) / 1e6:,.2f}")
    out.append(f"max exitAll gas at the end of a run: {max(r['maxExitGas'] for r in rows):,}")
    out.append(
        "I7 tightness: max per-mint worst-case loss / (band x notional) = "
        f"{max(r['maxMintDevBps'] for r in rows) / 100:.2f}%"
    )
    out.append(
        "I7 tightness: max fence-valued loss / I7 allowance at any point of a run = "
        f"{max(r['maxLossOfBudgetBps'] for r in rows) / 100:.2f}%"
    )
    pnl = [r["pnlUsd6"] for r in rows]
    out.append(f"fence-valued P&L at run end: min {min(pnl) / 1e6:.6f} USD, max {max(pnl) / 1e6:.6f} USD")
    if json_out:
        summary = {
            "runsLogged": n,
            "violations": dict(zip(INVARIANTS, viol)),
            "actions": {name: {"calls": calls[i], "laneOk": ok[i], "laneReverts": rev[i]} for i, name in enumerate(ACTIONS)},
            "laneRevertsByError": {names.get(sel, sel): cnt for sel, cnt in sorted(agg.items(), key=lambda kv: -kv[1])},
            "totals": {
                key: sum(r[key] for r in rows)
                for key in ("riskReranges", "mints", "priceSteps", "corpSteps", "donations", "foreignNfts", "decisionIds")
            },
            "turnoverUsd6": sum(turn),
            "maxExitGasAtRunEnd": max(r["maxExitGas"] for r in rows),
            "maxMintDevOfBandBps": max(r["maxMintDevBps"] for r in rows),
            "maxLossOfI7AllowanceBps": max(r["maxLossOfBudgetBps"] for r in rows),
            "pnlUsd6AtRunEnd": {"min": min(pnl), "max": max(pnl)},
        }
        with open(json_out, "w") as fh:
            json.dump(summary, fh, indent=1)
    if forge:
        out.append("")
        out.append("forge output (invariant results and per-selector metrics):")
        keep = False
        for line in forge.splitlines():
            if "invariants:" in line or "invariant_" in line or line.startswith(("|", "╭", "╰", "+")) or "runs:" in line:
                keep = True
                out.append("  " + line)
            elif keep and line.strip() == "":
                keep = False
            elif "Suite result" in line or "tests passed" in line:
                out.append("  " + line)
    print("\n".join(out))


if __name__ == "__main__":
    main()
