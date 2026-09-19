"use client";

import { useState } from "react";
import { ratio, usd } from "@/lib/format";

export type FlowRow = { label: string; takers: number; feeShare: number; pickedShare: number; fees: number; pickedNet: number; edge: number | null };

const NAMES: Record<string, [string, string]> = {
  "HL-arb": ["Hyperliquid arbitrage bots", "trade the pool toward Hyperliquid's price, which moves first"],
  "informed-bot": ["Other informed bots", "consistently profitable within 5 minutes, no Hyperliquid signal"],
  "JIT-LP": ["Just-in-time LPs", "add liquidity around their own swap in one block"],
  "bot/other": ["Other bots", "frequent traders without a consistent edge"],
  aggregator: ["Aggregators & app routers", "flow routed through shared contracts"],
  retail: ["Retail wallets", "occasional traders"],
};
const ORDER = ["HL-arb", "informed-bot", "JIT-LP", "bot/other", "aggregator", "retail"];
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function FlowXray({ rows }: { rows: FlowRow[] }) {
  const [focus, setFocus] = useState<FlowRow | null>(null);
  const [showTable, setShowTable] = useState(false);
  const data = ORDER.map((l) => rows.find((r) => r.label === l)).filter(Boolean) as FlowRow[];
  const max = Math.max(0.4, ...data.flatMap((d) => [d.feeShare, d.pickedShare]));
  const w = (v: number) => `${(Math.max(v, 0) / max) * 100}%`;
  const describe = (d: FlowRow) =>
    d.pickedNet >= 0 ? `took ${usd(d.pickedNet)} net from LPs (edge ${ratio(d.edge)})` : `lost ${usd(-d.pickedNet)} to LPs on price, on top of fees`;

  return (
    <figure className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <figcaption className="text-sm text-ink-2">Share of LP fees paid vs share of value picked off, by type of trader (all pools, vs Hyperliquid 1h)</figcaption>
        <button onClick={() => setShowTable((s) => !s)} className="text-xs text-muted underline-offset-2 hover:underline">{showTable ? "Show chart" : "Show table"}</button>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--series-1)" }} />LP fees paid</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--series-2)" }} />Value picked off (gross)</span>
      </div>

      {!showTable ? (
        <div className="space-y-3">
          {data.map((d) => (
            <div
              key={d.label}
              className="grid grid-cols-1 gap-1 md:grid-cols-[13rem_1fr] md:items-center md:gap-3"
              onPointerEnter={() => setFocus(d)}
              onPointerLeave={() => setFocus(null)}
            >
              <div className="text-xs text-ink-2">
                {NAMES[d.label]?.[0] ?? d.label} <span className="text-muted tabular">· {d.takers.toLocaleString()} wallets</span>
              </div>
              <div className="space-y-[2px] pr-14" tabIndex={0} onFocus={() => setFocus(d)} onBlur={() => setFocus(null)}
                aria-label={`${d.label}: ${pct(d.feeShare)} of fees, ${pct(d.pickedShare)} of value picked off`}>
                {[{ v: d.feeShare, c: "var(--series-1)" }, { v: d.pickedShare, c: "var(--series-2)" }].map((b, i) => (
                  <div key={i} className="relative h-[10px]">
                    <div className="absolute left-0 top-0 h-full rounded-r-[4px]" style={{ background: b.c, width: w(b.v) }} />
                    <span className="absolute top-[-3px] text-[11px] text-ink tabular" style={{ left: `calc(${w(b.v)} + 6px)` }}>{pct(b.v)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="min-h-5 text-xs text-ink-2 tabular">
            {focus ? (
              <><strong className="text-ink">{NAMES[focus.label]?.[0] ?? focus.label}</strong> ({NAMES[focus.label]?.[1]}): paid {usd(focus.fees)} in fees, {describe(focus)}</>
            ) : (
              <span className="text-muted">A trader type whose orange bar is longer than its blue one takes more from LPs than it pays them.</span>
            )}
          </div>
        </div>
      ) : (
        <table className="w-full text-xs tabular">
          <thead className="text-muted">
            <tr><th className="p-2 text-left">Trader type</th><th className="p-2 text-right">Wallets</th><th className="p-2 text-right">Fees paid</th><th className="p-2 text-right">Share of fees</th><th className="p-2 text-right">Share picked off</th><th className="p-2 text-right">Net picked off</th><th className="p-2 text-right">Edge</th></tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label} className="border-t border-grid">
                <td className="p-2">{NAMES[d.label]?.[0] ?? d.label}</td><td className="p-2 text-right">{d.takers.toLocaleString()}</td><td className="p-2 text-right">{usd(d.fees)}</td>
                <td className="p-2 text-right">{pct(d.feeShare)}</td><td className="p-2 text-right">{pct(d.pickedShare)}</td><td className="p-2 text-right">{usd(d.pickedNet)}</td><td className="p-2 text-right">{ratio(d.edge)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}
