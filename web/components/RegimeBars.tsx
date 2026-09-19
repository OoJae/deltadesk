"use client";

import { useState } from "react";
import { Key, ScrollX, ViewToggle } from "@/components/ledger/ui";
import { REGIME_LABEL, bps, ratio, usd } from "@/lib/format";

export type RegimeRow = { regime: string; hl: number | null; self: number | null; edgeHl: number | null; edgeSelf: number | null; fees: number; swaps: number };

const ORDER = ["REGULAR", "EXTENDED", "OVERNIGHT", "WEEKEND_DARK", "HOLIDAY"];
const HL = "var(--series-1)";
const SELF = "var(--axis)";

export default function RegimeBars({ rows, horizon }: { rows: RegimeRow[]; horizon: string }) {
  const [focus, setFocus] = useState<RegimeRow | null>(null);
  const [showTable, setShowTable] = useState(false);
  const data = ORDER.map((r) => rows.find((x) => x.regime === r)).filter(Boolean) as RegimeRow[];
  const max = Math.max(4, ...data.flatMap((d) => [Math.abs(d.hl ?? 0), Math.abs(d.self ?? 0)]));
  // Half the track per side, leaving room for the direct label at the bar end.
  const pct = (v: number | null) => (v == null ? 0 : (Math.abs(v) / max) * 40);

  return (
    <figure className="space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <figcaption className="text-[0.95rem] text-paper">What LPs keep per $ of volume, by market regime ({horizon} markout)</figcaption>
        <ViewToggle table={showTable} onToggle={() => setShowTable((s) => !s)} />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-paper-dim">
        <Key color={HL}>vs Hyperliquid 24/7 price</Key>
        <Key color={SELF}>vs pool&apos;s own later price</Key>
      </div>

      {!showTable ? (
        <div className="space-y-1">
          {data.map((d) => (
            <div
              key={d.regime}
              className="grid grid-cols-[7.5rem_1fr] items-center gap-3 py-1.5 md:grid-cols-[10rem_1fr] md:gap-5"
              onPointerEnter={() => setFocus(d)}
              onPointerLeave={() => setFocus(null)}
            >
              <div className={`text-xs transition-colors md:text-[0.8rem] ${focus?.regime === d.regime ? "text-paper" : "text-paper-dim"}`}>{REGIME_LABEL[d.regime] ?? d.regime}</div>
              <div
                className="relative space-y-[2px] py-1 outline-offset-2"
                tabIndex={0}
                onFocus={() => setFocus(d)}
                onBlur={() => setFocus(null)}
                aria-label={`${d.regime}: ${bps(d.hl)} vs Hyperliquid, ${bps(d.self)} self`}
              >
                <div className="absolute inset-y-[-6px] left-1/2 w-px bg-rule-strong" aria-hidden />
                {[{ v: d.hl, c: HL }, { v: d.self, c: SELF }].map((b, i) => (
                  <div key={i} className="relative h-2">
                    <div
                      className="absolute top-0 h-full"
                      style={{ background: b.c, width: `${pct(b.v)}%`, left: (b.v ?? 0) >= 0 ? "50%" : `${50 - pct(b.v)}%` }}
                    />
                    {i === 0 && b.v != null && (
                      <span
                        className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[0.7rem] text-paper tabular"
                        style={{
                          left: (b.v ?? 0) >= 0 ? `calc(${50 + pct(b.v)}% + 8px)` : undefined,
                          right: (b.v ?? 0) < 0 ? `calc(${50 + pct(b.v)}% + 8px)` : undefined,
                        }}
                      >
                        {bps(b.v)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="hidden grid-cols-[10rem_1fr] gap-5 md:grid" aria-hidden>
            <span />
            <div className="grid grid-cols-2 font-mono text-[0.65rem] text-paper-mute">
              <span className="pr-3 text-right">← informed flow took more</span>
              <span className="pl-3">LPs kept →</span>
            </div>
          </div>
          <div className="min-h-10 pt-3 text-xs leading-relaxed text-paper-dim tabular" aria-live="polite">
            {focus ? (
              <>
                <strong className="font-medium text-paper">{REGIME_LABEL[focus.regime]}</strong>: <span className="font-mono">{bps(focus.hl)}</span> vs Hyperliquid (edge{" "}
                <span className="font-mono">{ratio(focus.edgeHl)}</span>), <span className="font-mono">{bps(focus.self)}</span> self (edge{" "}
                <span className="font-mono">{ratio(focus.edgeSelf)}</span>) · fees <span className="font-mono">{usd(focus.fees)}</span> ·{" "}
                <span className="font-mono">{focus.swaps.toLocaleString()}</span> swaps
              </>
            ) : (
              <span className="text-paper-mute">Right of the line: LPs kept money. Left: informed flow took more than the fees. Hover or focus a row for detail.</span>
            )}
          </div>
        </div>
      ) : (
        <ScrollX label="Regime table">
          <table className="ledger-table min-w-[36rem] text-xs">
            <thead>
              <tr>
                <th>Regime</th><th className="n">Net vs HL</th><th className="n">Edge vs HL</th><th className="n">Net self</th><th className="n">Edge self</th>
                <th className="n">Fees</th><th className="n">Swaps</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.regime}>
                  <td className="text-paper-dim">{REGIME_LABEL[d.regime]}</td><td className="n">{bps(d.hl)}</td><td className="n">{ratio(d.edgeHl)}</td>
                  <td className="n">{bps(d.self)}</td><td className="n">{ratio(d.edgeSelf)}</td><td className="n">{usd(d.fees)}</td><td className="n">{d.swaps.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollX>
      )}
    </figure>
  );
}
