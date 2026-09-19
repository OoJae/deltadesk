"use client";

import { useState } from "react";
import { Label } from "@/components/brand/Label";
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
    <div className="space-y-10 md:space-y-12">
      {/* Pool selector: four ledger cells on a hairline grid. The chosen one is lifted a step and ruled in paper. */}
      <div className="grid grid-cols-2 gap-px border border-rule bg-rule lg:grid-cols-4" role="group" aria-label="Choose a pool">
        {pools.map((x) => {
          const on = x.pool === sel;
          return (
            <button
              key={x.pool}
              type="button"
              onClick={() => setSel(x.pool)}
              aria-pressed={on}
              className={[
                "group relative flex flex-col items-start gap-3 px-4 py-5 text-left transition-colors duration-200 md:px-6 md:py-7",
                on ? "bg-vault-3" : "bg-vault-2 hover:bg-vault-3/70",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={["absolute inset-x-0 top-0 h-[2px] origin-left bg-paper transition-transform duration-300 ease-out", on ? "scale-x-100" : "scale-x-0"].join(" ")}
              />
              <Label tone={on ? "paper" : "mute"}>{x.pool}</Label>
              <span className="font-mono text-[clamp(1.9rem,3.4vw,3rem)] leading-none tracking-[-0.03em] text-paper tabular">{ratio(x.edge)}</span>
              <span className="text-[0.8rem] leading-snug text-paper-dim">
                LP edge (fees ÷ picked off, 1h{x.reference === "hl" ? ", vs HL" : ", self"})
              </span>
              <span className="font-mono text-[0.72rem] text-paper-mute tabular">
                {bps(x.netBps)} net · {usd(x.vol, 0)} vol
              </span>
            </button>
          );
        })}
      </div>

      <section className="border border-rule bg-vault-2" aria-labelledby="pool-detail-title">
        <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-rule px-5 py-5 md:px-8">
          <div className="space-y-1.5">
            <Label>Pool detail</Label>
            <h3 id="pool-detail-title" className="font-mono text-[1.35rem] leading-none text-paper md:text-[1.6rem]">
              {p.pool}
            </h3>
          </div>
          <p className="max-w-[60ch] font-mono text-[0.78rem] leading-relaxed text-paper-dim tabular">
            {p.swaps.toLocaleString()} swaps · LP fees {usd(p.fees)} · picked off {usd(p.picked)} (1h
            {p.reference === "hl" ? ", vs Hyperliquid" : ", self-markout"})
          </p>
        </header>
        <div className="divide-y divide-rule">
          <div className="px-5 py-7 md:px-8 md:py-9">
            <RegimeBars rows={p.regimes} horizon="1h" />
          </div>
          <div className="px-5 py-7 md:px-8 md:py-9">
            <Heatmap
              cells={p.heat}
              caption={`LP net by hour of the week, ET (1h markout ${p.heatReference === "hl" ? "vs Hyperliquid" : "vs the pool's own later price"})`}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
