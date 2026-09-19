"use client";

import { useState } from "react";
import { ViewToggle } from "@/components/ledger/ui";
import { DAYS, bps, ratio, usd } from "@/lib/format";

export type HeatCell = { how: number; value: number | null; fees: number; picked: number; edge: number | null; swaps: number };

// Diverging, stepped: 4 steps per arm + neutral midpoint. Thresholds in bp of volume.
const STEPS = [0.5, 2, 5, 10];
function fill(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "var(--surface-2)";
  const a = Math.abs(v);
  if (a < STEPS[0]) return "var(--div-mid)";
  const i = a >= STEPS[3] ? 4 : a >= STEPS[2] ? 3 : a >= STEPS[1] ? 2 : 1;
  return v > 0 ? `var(--div-pos-${i})` : `var(--div-neg-${i})`;
}
const hh = (h: number) => String(h).padStart(2, "0");

export default function Heatmap({ cells, caption }: { cells: HeatCell[]; caption: string }) {
  const [hover, setHover] = useState<HeatCell | null>(null);
  const [showTable, setShowTable] = useState(false);
  const byHow = new Map(cells.map((c) => [c.how, c]));
  const worst = [...cells].filter((c) => c.value != null).sort((a, b) => (a.value ?? 0) - (b.value ?? 0)).slice(0, 5);

  return (
    <figure className="space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <figcaption className="text-[0.95rem] text-paper">{caption}</figcaption>
        <ViewToggle table={showTable} onToggle={() => setShowTable((s) => !s)} />
      </div>

      {!showTable ? (
        <div className="relative">
          <div className="grid gap-px md:gap-[2px]" style={{ gridTemplateColumns: "2rem repeat(24, minmax(0, 1fr))" }}>
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="pb-1 text-center font-mono text-[0.62rem] text-paper-mute tabular">
                {h % 3 === 0 ? hh(h) : ""}
              </div>
            ))}
            {DAYS.map((d, di) => (
              <Row key={d} day={d} di={di} byHow={byHow} hover={hover} onHover={setHover} />
            ))}
          </div>
          <div data-demo="heatmap-readout" className="mt-4 min-h-10 text-xs leading-relaxed text-paper-dim" aria-live="polite">
            {hover ? (
              <span className="tabular">
                <strong className="font-mono font-medium text-paper">{bps(hover.value)}</strong> of volume to LPs ·{" "}
                <span className="font-mono">
                  {DAYS[Math.floor(hover.how / 24)]} {hh(hover.how % 24)}:00 ET
                </span>{" "}
                · fees <span className="font-mono">{usd(hover.fees)}</span> · picked off <span className="font-mono">{usd(hover.picked)}</span> · edge{" "}
                <span className="font-mono">{ratio(hover.edge)}</span> · <span className="font-mono">{hover.swaps.toLocaleString()}</span> swaps
              </span>
            ) : (
              <span className="text-paper-mute">Hover or focus a cell. Blue = LPs kept money, red = informed flow took more than the fees.</span>
            )}
          </div>
          <Legend />
        </div>
      ) : (
        <div className="max-h-80 overflow-auto border border-rule" tabIndex={0} role="region" aria-label="Hour-of-week table">
          <table className="ledger-table min-w-[34rem] text-xs">
            <thead className="sticky top-0 bg-vault-3">
              <tr>
                <th>Hour (ET)</th><th className="n">LP net</th><th className="n">Fees</th><th className="n">Picked off</th><th className="n">Edge</th><th className="n">Swaps</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((c) => (
                <tr key={c.how}>
                  <td className="font-mono text-paper-dim">
                    {DAYS[Math.floor(c.how / 24)]} {hh(c.how % 24)}:00
                  </td>
                  <td className="n">{bps(c.value)}</td><td className="n">{usd(c.fees)}</td>
                  <td className="n">{usd(c.picked)}</td><td className="n">{ratio(c.edge)}</td><td className="n">{c.swaps.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {worst.length > 0 && (
        <div className="border-t border-rule pt-4 text-xs leading-relaxed text-paper-dim">
          <span className="label mr-3 text-paper-mute">Worst hours for LPs</span>
          {worst.map((c, i) => (
            <span key={c.how} className="font-mono tabular">
              {i > 0 && <span className="text-paper-mute"> · </span>}
              {DAYS[Math.floor(c.how / 24)]} {hh(c.how % 24)}:00 ({bps(c.value)}, edge {ratio(c.edge)})
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}

function Row({ day, di, byHow, hover, onHover }: { day: string; di: number; byHow: Map<number, HeatCell>; hover: HeatCell | null; onHover: (c: HeatCell | null) => void }) {
  return (
    <>
      <div className="flex items-center font-mono text-[0.65rem] text-paper-mute">{day}</div>
      {Array.from({ length: 24 }, (_, h) => {
        const how = di * 24 + h;
        const c = byHow.get(how);
        const on = hover != null && hover.how === how;
        return (
          <button
            key={how}
            type="button"
            aria-label={c ? `${day} ${h}:00 ET: ${bps(c.value)}` : `${day} ${h}:00 ET: no trades`}
            className="h-4 sm:h-6 lg:h-7 focus-visible:relative focus-visible:z-10 focus-visible:outline-offset-1"
            style={{ background: fill(c?.value ?? null), boxShadow: on ? "inset 0 0 0 1.5px var(--paper)" : undefined }}
            onPointerEnter={() => c && onHover(c)}
            onFocus={() => c && onHover(c)}
            onPointerLeave={() => onHover(null)}
            onBlur={() => onHover(null)}
          />
        );
      })}
    </>
  );
}

function Legend() {
  const items = [
    { v: -12, l: "≤ −10" }, { v: -6, l: "−5" }, { v: -3, l: "−2" }, { v: -1, l: "−0.5" },
    { v: 0, l: "0" }, { v: 1, l: "+0.5" }, { v: 3, l: "+2" }, { v: 6, l: "+5" }, { v: 12, l: "≥ +10" },
  ];
  return (
    <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2 text-[0.65rem] text-paper-mute">
      <span className="label pb-[1.1rem]">LP net, bp of volume</span>
      <div className="flex gap-[2px]">
        {items.map((it) => (
          <div key={it.l} className="flex flex-col items-center gap-1.5">
            <div className="h-2.5 w-7 md:w-9" style={{ background: fill(it.v) }} />
            <span className="font-mono tabular">{it.l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
