"use client";

import { useState } from "react";
import Heatmap, { type HeatCell } from "@/components/Heatmap";
import RegimeBars, { type RegimeRow } from "@/components/RegimeBars";
import { bps, ratio, usd } from "@/lib/format";

export type PoolStudy = {
  pool: string;
  swaps: number;
  vol: number;
  fees: number;
  picked: number;
  edge: number | null;
  edgeSelf: number | null;
  netBps: number | null;
  reference: "hl" | "self";
  regimes: RegimeRow[];
  heat: HeatCell[];
  heatReference: "hl" | "self";
};

export default function StudyView({ pools }: { pools: PoolStudy[] }) {
  const [sel, setSel] = useState(pools[0]?.pool);
  const p = pools.find((x) => x.pool === sel) ?? pools[0];
  if (!p) return null;
  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {pools.map((x) => (
          <button
            key={x.pool}
            onClick={() => setSel(x.pool)}
            className={`card p-4 text-left transition-colors ${x.pool === sel ? "ring-2 ring-[var(--accent)]" : "hover:bg-surface-2"}`}
          >
            <div className="text-xs text-muted">{x.pool}</div>
            <div className="mt-1 text-2xl font-semibold">{ratio(x.edge)}</div>
            <div className="text-xs text-ink-2">LP edge (fees ÷ picked off, 1h{x.reference === "hl" ? ", vs HL" : ", self"})</div>
            <div className="mt-2 text-xs text-ink-2 tabular">{bps(x.netBps)} net · {usd(x.vol, 0)} vol</div>
          </button>
        ))}
      </section>

      <section className="card space-y-8 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{p.pool}</h2>
          <p className="text-sm text-ink-2 tabular">
            {p.swaps.toLocaleString()} swaps · LP fees {usd(p.fees)} · picked off {usd(p.picked)} (1h
            {p.reference === "hl" ? ", vs Hyperliquid" : ", self-markout"})
          </p>
        </div>
        <RegimeBars rows={p.regimes} horizon="1h" />
        <Heatmap
          cells={p.heat}
          caption={`LP net by hour of the week, ET (1h markout ${p.heatReference === "hl" ? "vs Hyperliquid" : "vs the pool's own later price"})`}
        />
      </section>
    </div>
  );
}
