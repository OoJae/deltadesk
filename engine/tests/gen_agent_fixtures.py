"""Golden fixtures for the TypeScript desk agent: its calendar and assess() ports must match these exactly.

    uv run python -m tests.gen_agent_fixtures      ->  ../agent/test/fixtures/{calendar_cases,assess_cases}.json
"""

from __future__ import annotations

import json
import random
from datetime import datetime
from pathlib import Path

from api.app import GAP_CAUTION, assess
from markout.calendar import (EARLY_CLOSES, ET, HOLIDAYS, OPEN_MIN, REGULAR_CLOSE_MIN, SESSION_ROLL_MIN, WAKE_GUARD,
                              WEEKDAY_OPEN_GUARD, regime_at)

OUT = Path(__file__).resolve().parents[2] / "agent" / "test" / "fixtures"


def _case(t: float) -> dict:
    r = regime_at(t)
    return {"ts": t, "regime": r.name, "reopen_kind": r.reopen_kind, "how": r.how, "session_date": r.session_date.isoformat()}


def calendar_cases() -> list[dict]:
    rng = random.Random(4663)
    ts = [rng.uniform(1.7815e9, 1.83e9) for _ in range(2000)]
    # every boundary +-60 s / +-1 s on interesting days (holidays, early closes, DST switches, ordinary weeks)
    days = sorted({*HOLIDAYS, *EARLY_CLOSES} | {datetime(2026, 3, 8).date(), datetime(2026, 11, 1).date(),
                   datetime(2026, 9, 18).date(), datetime(2026, 9, 20).date(), datetime(2026, 9, 21).date()})
    marks = [0, EXT_MIN := 4 * 60, WEEKDAY_OPEN_GUARD[0], OPEN_MIN, WEEKDAY_OPEN_GUARD[1], 13 * 60, REGULAR_CLOSE_MIN,
             WAKE_GUARD[0], SESSION_ROLL_MIN, WAKE_GUARD[1]]
    for d in days:
        for m in marks:
            base = datetime(d.year, d.month, d.day, tzinfo=ET).timestamp() + m * 60
            ts += [base + s for s in (-60, -1, 0, 1, 60)]
    del EXT_MIN
    return [_case(t) for t in sorted(ts)]


def assess_cases() -> list[dict]:
    """(inputs, verdict, reason levels) across regimes, gaps, toxic hours and oracle ages."""
    rng = random.Random(8056)
    probe = [datetime(2026, 9, 16, 11, tzinfo=ET), datetime(2026, 9, 16, 17, tzinfo=ET), datetime(2026, 9, 16, 22, tzinfo=ET),
             datetime(2026, 9, 19, 12, tzinfo=ET), datetime(2026, 9, 7, 12, tzinfo=ET), datetime(2026, 9, 21, 9, 25, tzinfo=ET),
             datetime(2026, 9, 20, 20, 5, tzinfo=ET)]
    out = []
    for when in probe:
        reg = regime_at(when.timestamp())
        for _ in range(40):
            gap = rng.choice([0.0, 1.0, -3.0, GAP_CAUTION[reg.name] - 0.5, GAP_CAUTION[reg.name] + 0.5, -2 * GAP_CAUTION[reg.name]])
            hour = rng.choice([None, {"edge_1h": 3.0, "picked_1h_usd": 10.0}, {"edge_1h": 0.3, "picked_1h_usd": 50.0},
                               {"edge_1h": 0.8, "picked_1h_usd": 50.0}, {"edge_1h": None, "picked_1h_usd": -40.0}])
            age = rng.choice([None, 60.0, 7 * 3600.0, 27 * 3600.0])
            res = assess(gap, reg, hour, age)
            out.append({"ts": when.timestamp(), "gap_bps": gap, "hour": hour, "chainlink_age_s": age,
                        "verdict": res["verdict"], "levels": [r["level"] for r in res["reasons"]]})
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cal, asx = calendar_cases(), assess_cases()
    (OUT / "calendar_cases.json").write_text(json.dumps({"generated_by": "engine/tests/gen_agent_fixtures.py",
                                                         "holidays": sorted(d.isoformat() for d in HOLIDAYS),
                                                         "early_closes": sorted(d.isoformat() for d in EARLY_CLOSES),
                                                         "cases": cal}, indent=0))
    (OUT / "assess_cases.json").write_text(json.dumps({"gap_caution_bps": GAP_CAUTION, "cases": asx}, indent=0))
    print(f"wrote {len(cal)} calendar and {len(asx)} assess cases to {OUT}")


if __name__ == "__main__":
    main()
