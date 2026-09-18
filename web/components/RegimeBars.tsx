"use client";

import { useState } from "react";
import { REGIME_LABEL, bps, ratio, usd } from "@/lib/format";

export type RegimeRow = { regime: string; hl: number | null; self: number | null; edgeHl: number | null; edgeSelf: number | null; fees: number; swaps: number };

const ORDER = ["REGULAR", "EXTENDED", "OVERNIGHT", "WEEKEND_DARK", "HOLIDAY"];

export default function RegimeBars({ rows, horizon }: { rows: RegimeRow[]; horizon: string }) {
  const [focus, setFocus] = useState<RegimeRow | null>(null);
  const [showTable, setShowTable] = useState(false);
  const data = ORDER.map((r) => rows.find((x) => x.regime === r)).filter(Boolean) as RegimeRow[];
  const max = Math.max(4, ...data.flatMap((d) => [Math.abs(d.hl ?? 0), Math.abs(d.self ?? 0)]));
  const pct = (v: number | null) => (v == null ? 0 : (Math.abs(v) / max) * 50);

  return (
    <figure className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <figcaption className="text-sm text-ink-2">What LPs keep per $ of volume, by market regime ({horizon} markout)</figcaption>
        <button onClick={() => setShowTable((s) => !s)} className="text-xs text-muted underline-offset-2 hover:underline">{showTable ? "Show chart" : "Show table"}</button>
      </div>
      <div className="flex gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--series-1)" }} />vs Hyperliquid 24/7 price</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--axis)" }} />vs pool&apos;s own later price</span>
      </div>

      {!showTable ? (
        <div className="space-y-3">
          {data.map((d) => (
            <div key={d.regime} className="grid grid-cols-[9.5rem_1fr] items-center gap-3" onPointerEnter={() => setFocus(d)} onPointerLeave={() => setFocus(null)}>
              <div className="text-xs text-ink-2">{REGIME_LABEL[d.regime] ?? d.regime}</div>
              <div className="relative space-y-[2px]" tabIndex={0} onFocus={() => setFocus(d)} onBlur={() => setFocus(null)} aria-label={`${d.regime}: ${bps(d.hl)} vs Hyperliquid, ${bps(d.self)} self`}>
                <div className="absolute inset-y-[-4px] left-1/2 w-px bg-[var(--axis)]" />
                {[{ v: d.hl, c: "var(--series-1)" }, { v: d.self, c: "var(--axis)" }].map((b, i) => (
                  <div key={i} className="relative h-[10px]">
                    <div
                      className="absolute top-0 h-full"
                      style={{
                        background: b.c,
                        width: `${pct(b.v)}%`,
                        left: (b.v ?? 0) >= 0 ? "50%" : `${50 - pct(b.v)}%`,
                        borderRadius: (b.v ?? 0) >= 0 ? "0 4px 4px 0" : "4px 0 0 4px",
                      }}
                    />
                    {i === 0 && b.v != null && (
                      <span className="absolute top-[-3px] text-[11px] text-ink tabular" style={{ left: (b.v ?? 0) >= 0 ? `calc(${50 + pct(b.v)}% + 6px)` : undefined, right: (b.v ?? 0) < 0 ? `calc(${50 + pct(b.v)}% + 6px)` : undefined }}>
                        {bps(b.v)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="h-5 text-xs text-ink-2 tabular">
            {focus ? (
              <>
                <strong className="text-ink">{REGIME_LABEL[focus.regime]}</strong>: {bps(focus.hl)} vs Hyperliquid (edge {ratio(focus.edgeHl)}), {bps(focus.self)} self (edge {ratio(focus.edgeSelf)}) · fees {usd(focus.fees)} · {focus.swaps.toLocaleString()} swaps
              </>
            ) : (
              <span className="text-muted">Right of the line: LPs kept money. Left: informed flow took more than the fees.</span>
            )}
          </div>
        </div>
      ) : (
        <table className="w-full text-xs tabular">
          <thead className="text-muted"><tr><th className="p-2 text-left">Regime</th><th className="p-2 text-right">Net vs HL</th><th className="p-2 text-right">Edge vs HL</th><th className="p-2 text-right">Net self</th><th className="p-2 text-right">Edge self</th><th className="p-2 text-right">Fees</th><th className="p-2 text-right">Swaps</th></tr></thead>
          <tbody>{data.map((d) => (
            <tr key={d.regime} className="border-t border-grid"><td className="p-2">{REGIME_LABEL[d.regime]}</td><td className="p-2 text-right">{bps(d.hl)}</td><td className="p-2 text-right">{ratio(d.edgeHl)}</td><td className="p-2 text-right">{bps(d.self)}</td><td className="p-2 text-right">{ratio(d.edgeSelf)}</td><td className="p-2 text-right">{usd(d.fees)}</td><td className="p-2 text-right">{d.swaps.toLocaleString()}</td></tr>
          ))}</tbody>
        </table>
      )}
    </figure>
  );
}
