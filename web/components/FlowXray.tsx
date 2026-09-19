"use client";

import { useState } from "react";
import { Key, ScrollX, ViewToggle } from "@/components/ledger/ui";
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
const FEES = "var(--series-1)";
const PICKED = "var(--series-2)";
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
    <figure className="space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <figcaption className="text-[0.95rem] text-paper">
          Share of LP fees paid vs share of value picked off, by type of trader (all pools, vs Hyperliquid 1h)
        </figcaption>
        <ViewToggle table={showTable} onToggle={() => setShowTable((s) => !s)} />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-paper-dim">
        <Key color={FEES}>LP fees paid</Key>
        <Key color={PICKED}>Value picked off (gross)</Key>
      </div>

      {!showTable ? (
        <div>
          <div className="divide-y divide-rule border-y border-rule">
            {data.map((d) => (
              <div
                key={d.label}
                className={`grid grid-cols-1 gap-2 py-3.5 transition-colors md:grid-cols-[15rem_1fr] md:items-center md:gap-6 ${focus?.label === d.label ? "bg-vault-3/60" : ""}`}
                onPointerEnter={() => setFocus(d)}
                onPointerLeave={() => setFocus(null)}
              >
                <div className="flex items-baseline justify-between gap-3 text-[0.82rem] leading-snug text-paper md:block">
                  <span className="md:block">{NAMES[d.label]?.[0] ?? d.label}</span>
                  <span className="whitespace-nowrap font-mono text-[0.68rem] text-paper-mute tabular md:mt-0.5 md:block">{d.takers.toLocaleString()} wallets</span>
                </div>
                <div
                  className="space-y-[5px] pr-16 outline-offset-4"
                  tabIndex={0}
                  onFocus={() => setFocus(d)}
                  onBlur={() => setFocus(null)}
                  aria-label={`${d.label}: ${pct(d.feeShare)} of fees, ${pct(d.pickedShare)} of value picked off`}
                >
                  {[{ v: d.feeShare, c: FEES }, { v: d.pickedShare, c: PICKED }].map((b, i) => (
                    <div key={i} className="relative h-[9px]">
                      <div className="absolute left-0 top-0 h-full min-w-px" style={{ background: b.c, width: w(b.v) }} />
                      <span
                        className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[0.66rem] leading-none text-paper tabular"
                        style={{ left: `calc(${w(b.v)} + 8px)` }}
                      >
                        {pct(b.v)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="min-h-12 pt-4 text-xs leading-relaxed text-paper-dim" aria-live="polite">
            {focus ? (
              <>
                <strong className="font-medium text-paper">{NAMES[focus.label]?.[0] ?? focus.label}</strong> ({NAMES[focus.label]?.[1]}): paid{" "}
                <span className="font-mono">{usd(focus.fees)}</span> in fees, {describe(focus)}
              </>
            ) : (
              <span className="text-paper-mute">
                A trader type whose green bar is longer than its blue one takes more from LPs than it pays them. Hover or focus a row for its totals.
              </span>
            )}
          </div>
        </div>
      ) : (
        <ScrollX label="Trader type table">
          <table className="ledger-table min-w-[44rem] text-xs">
            <thead>
              <tr>
                <th>Trader type</th><th className="n">Wallets</th><th className="n">Fees paid</th><th className="n">Share of fees</th>
                <th className="n">Share picked off</th><th className="n">Net picked off</th><th className="n">Edge</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td className="text-paper">{NAMES[d.label]?.[0] ?? d.label}</td><td className="n">{d.takers.toLocaleString()}</td><td className="n">{usd(d.fees)}</td>
                  <td className="n">{pct(d.feeShare)}</td><td className="n">{pct(d.pickedShare)}</td><td className="n">{usd(d.pickedNet)}</td><td className="n">{ratio(d.edge)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollX>
      )}
    </figure>
  );
}
