"use client";

import { useState } from "react";
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

export default function Heatmap({ cells, caption }: { cells: HeatCell[]; caption: string }) {
  const [hover, setHover] = useState<HeatCell | null>(null);
  const [showTable, setShowTable] = useState(false);
  const byHow = new Map(cells.map((c) => [c.how, c]));
  const worst = [...cells].filter((c) => c.value != null).sort((a, b) => (a.value ?? 0) - (b.value ?? 0)).slice(0, 5);

  return (
    <figure className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <figcaption className="text-sm text-ink-2">{caption}</figcaption>
        <button onClick={() => setShowTable((s) => !s)} className="text-xs text-muted underline-offset-2 hover:underline">
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {!showTable ? (
        <div className="relative">
          <div className="grid gap-[2px]" style={{ gridTemplateColumns: "2.5rem repeat(24, minmax(0, 1fr))" }}>
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="text-center text-[10px] text-muted tabular">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</div>
            ))}
            {DAYS.map((d, di) => (
              <Row key={d} day={d} di={di} byHow={byHow} onHover={setHover} />
            ))}
          </div>
          <div className="mt-2 flex h-9 items-center text-xs text-ink-2" aria-live="polite">
            {hover ? (
              <span className="tabular">
                <strong className="text-ink">{bps(hover.value)}</strong> of volume to LPs · {DAYS[Math.floor(hover.how / 24)]}{" "}
                {String(hover.how % 24).padStart(2, "0")}:00 ET · fees {usd(hover.fees)} · picked off {usd(hover.picked)} · edge {ratio(hover.edge)} ·{" "}
                {hover.swaps.toLocaleString()} swaps
              </span>
            ) : (
              <span className="text-muted">Hover or focus a cell. Blue = LPs kept money, red = informed flow took more than the fees.</span>
            )}
          </div>
          <Legend />
        </div>
      ) : (
        <div className="max-h-80 overflow-auto rounded-lg border border-[var(--ring)]">
          <table className="w-full text-xs tabular">
            <thead className="sticky top-0 bg-surface-2 text-muted">
              <tr><th className="p-2 text-left">Hour (ET)</th><th className="p-2 text-right">LP net</th><th className="p-2 text-right">Fees</th><th className="p-2 text-right">Picked off</th><th className="p-2 text-right">Edge</th><th className="p-2 text-right">Swaps</th></tr>
            </thead>
            <tbody>
              {cells.map((c) => (
                <tr key={c.how} className="border-t border-grid">
                  <td className="p-2">{DAYS[Math.floor(c.how / 24)]} {String(c.how % 24).padStart(2, "0")}:00</td>
                  <td className="p-2 text-right">{bps(c.value)}</td><td className="p-2 text-right">{usd(c.fees)}</td>
                  <td className="p-2 text-right">{usd(c.picked)}</td><td className="p-2 text-right">{ratio(c.edge)}</td><td className="p-2 text-right">{c.swaps.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {worst.length > 0 && (
        <p className="text-xs text-ink-2">
          Worst hours for LPs:{" "}
          {worst.map((c, i) => (
            <span key={c.how} className="tabular">
              {i > 0 && " · "}
              {DAYS[Math.floor(c.how / 24)]} {String(c.how % 24).padStart(2, "0")}:00 ({bps(c.value)}, edge {ratio(c.edge)})
            </span>
          ))}
        </p>
      )}
    </figure>
  );
}

function Row({ day, di, byHow, onHover }: { day: string; di: number; byHow: Map<number, HeatCell>; onHover: (c: HeatCell | null) => void }) {
  return (
    <>
      <div className="flex items-center text-[11px] text-muted">{day}</div>
      {Array.from({ length: 24 }, (_, h) => {
        const how = di * 24 + h;
        const c = byHow.get(how);
        return (
          <button
            key={how}
            aria-label={c ? `${day} ${h}:00 ET: ${bps(c.value)}` : `${day} ${h}:00 ET: no trades`}
            className="aspect-square rounded-[3px] outline-none transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{ background: fill(c?.value ?? null) }}
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
    <div className="flex items-center gap-2 text-[10px] text-muted">
      <span>LP net, bp of volume</span>
      <div className="flex gap-[2px]">
        {items.map((it) => (
          <div key={it.l} className="flex flex-col items-center gap-1">
            <div className="h-3 w-7 rounded-[2px]" style={{ background: fill(it.v) }} />
            <span className="tabular">{it.l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
