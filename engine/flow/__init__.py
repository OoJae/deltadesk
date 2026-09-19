"""Flow X-ray (M1 module B): who takes LP money?

Takers are identified by the originating wallet (tx.from), characterised per taker and per taker x pool,
clustered (HDBSCAN) and given deterministic, feature-explainable labels. Picked-off value (self-markout LVR,
plus HL-referenced markouts when available) is attributed to labels and clusters.

    uv run python -m flow.xray
"""
