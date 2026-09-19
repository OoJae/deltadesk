"""M1 · module C: position-level LP truth (reconstruction, fee/LVR attribution, valuation, reconciliation, tearsheets).

    uv run python -m positions.attribute             # build data/study/m1/positions/*
    uv run python -m positions.tearsheet 0xOWNER     # one wallet's tearsheet

Outputs (data/study/m1/positions/): positions.parquet, segments.parquet, attribution.parquet (position × regime),
owners.parquet, golden.json, reconciliation.md, diagnostics.json.
"""
