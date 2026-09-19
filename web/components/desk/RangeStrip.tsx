"use client";

import { useEffect, useRef, useState } from "react";
import { LANE_A } from "@/lib/desk/chain";
import { fmtUnits, positionAmounts, tickToPrice } from "@/lib/desk/format";
import type { LaneState } from "@/lib/desk/reads";

// Price axis is USDG per NVDA, increasing to the right (so tick order is reversed: higher tick = lower NVDA price).
// Identity: slot 0 = series-1, slot 1 = series-2 (fixed by slot, never by rank). Band = neutral wash; pool = ink line.
const SLOT_COLOR = ["var(--series-1)", "var(--series-2)"] as const;
const H = { top: 28, row: 34, axis: 26 };

function niceTicks(lo: number, hi: number, n = 5): number[] {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export default function RangeStrip({ s }: { s: LaneState }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const band = s.ref && s.ref.code === 0 ? { lo: tickToPrice(s.ref.tick + s.ref.band), hi: tickToPrice(s.ref.tick - s.ref.band), mid: tickToPrice(s.ref.tick) } : null;
  const pool = s.poolTick != null ? tickToPrice(s.poolTick) : null;
  const rows = s.positions.map((p) => ({ ...p, lo: tickToPrice(p.tickUpper), hi: tickToPrice(p.tickLower) }));

  const xs = [...(band ? [band.lo, band.hi] : []), ...(pool != null ? [pool] : []), ...rows.flatMap((r) => [r.lo, r.hi])];
  if (!xs.length) return <p className="text-[0.9rem] text-paper-dim">No price reference yet: the pool, the fence and the positions are all unavailable.</p>;

  let lo = Math.min(...xs), hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.12, (pool ?? lo) * 0.004);
  lo -= pad;
  hi += pad;
  const nRows = Math.max(rows.length, 1);
  const height = H.top + nRows * H.row + H.axis;
  const left = 8, right = 8;
  const plotW = Math.max(width - left - right, 10);
  const x = (v: number) => left + ((v - lo) / (hi - lo)) * plotW;
  const ticks = niceTicks(lo, hi, width < 420 ? 3 : 5);
  const axisY = H.top + nRows * H.row + 4;
  const hovered = hover != null ? rows[hover] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.78rem] text-paper-dim" aria-hidden>
        {rows.map((r) => (
          <span key={r.slot} className="inline-flex items-center gap-2">
            <span className="h-2 w-4" style={{ background: SLOT_COLOR[r.slot] }} />
            Position slot {r.slot}
          </span>
        ))}
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-4 bg-[var(--div-mid)] ring-1 ring-[var(--axis)]" />
          Placement band (Chainlink ±{s.ref?.band ?? "–"} ticks)
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-3 w-px bg-paper" />
          Pool price
        </span>
      </div>

      <div ref={ref} className="relative w-full">
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label="Position ranges against the pool price and the Chainlink placement band, USDG per NVDA">
            {band && (
              <g>
                <rect x={x(band.lo)} y={H.top - 16} width={Math.max(x(band.hi) - x(band.lo), 1)} height={nRows * H.row + 16} fill="var(--div-mid)" />
                <line x1={x(band.mid)} x2={x(band.mid)} y1={H.top - 16} y2={axisY} stroke="var(--axis)" strokeWidth={1} />
                <text x={x(band.mid)} y={H.top - 20} textAnchor="middle" className="fill-[var(--text-muted)] font-mono text-[10px]">
                  Chainlink {band.mid.toFixed(2)}
                </text>
              </g>
            )}
            <line x1={left} x2={left + plotW} y1={axisY} y2={axisY} stroke="var(--axis)" strokeWidth={1} />
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={axisY} y2={axisY + 4} stroke="var(--axis)" strokeWidth={1} />
                <text x={x(t)} y={axisY + 16} textAnchor="middle" className="tabular fill-[var(--text-muted)] font-mono text-[10px]">
                  {t.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                </text>
              </g>
            ))}
            {rows.map((r, i) => (
              <rect key={r.slot} x={x(r.lo)} y={H.top + i * H.row + 16} width={Math.max(x(r.hi) - x(r.lo), 2)} height={10} fill={SLOT_COLOR[r.slot]} opacity={hover == null || hover === i ? 1 : 0.5} />
            ))}
            {pool != null && (
              <g>
                <line x1={x(pool)} x2={x(pool)} y1={H.top - 8} y2={axisY} stroke="var(--paper)" strokeWidth={1.5} />
                <rect x={x(pool) - 3.5} y={H.top - 11.5} width={7} height={7} transform={`rotate(45 ${x(pool)} ${H.top - 8})`} fill="var(--paper)" stroke="var(--vault-2)" strokeWidth={2} />
              </g>
            )}
            {rows.map((r, i) => {
              const x0 = x(r.lo), x1 = x(r.hi);
              const inRange = s.poolTick != null && s.poolTick >= r.tickLower && s.poolTick < r.tickUpper;
              // Direct label sits above its bar with a surface halo; end-anchored when the bar starts near the right edge.
              const flip = x0 + 120 > left + plotW;
              return (
                <text
                  key={r.slot}
                  x={flip ? Math.min(x1, left + plotW) : Math.max(x0, left)}
                  y={H.top + i * H.row + 11}
                  textAnchor={flip ? "end" : "start"}
                  paintOrder="stroke"
                  stroke="var(--surface-1)"
                  strokeWidth={3}
                  className="fill-[var(--text-secondary)] font-mono text-[11px]"
                >
                  #{r.tokenId.toString()} · {inRange ? "in range" : "out of range"}
                </text>
              );
            })}
            {rows.map((r, i) => (
              <rect
                key={r.slot}
                x={x(r.lo) - 6}
                y={H.top + i * H.row}
                width={Math.max(x(r.hi) - x(r.lo), 2) + 12}
                height={H.row}
                fill="transparent"
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`Slot ${r.slot}: ${r.lo.toFixed(2)} to ${r.hi.toFixed(2)} USDG per NVDA`}
              />
            ))}
          </svg>
        )}
        {hovered && (
          <div className="pointer-events-none absolute right-0 top-0 border border-rule-strong bg-vault px-3 py-2 text-xs">
            <div className="font-mono font-medium tabular text-paper">
              {hovered.lo.toFixed(2)} – {hovered.hi.toFixed(2)}
            </div>
            <div className="text-paper-dim">slot {hovered.slot} · NFT #{hovered.tokenId.toString()}</div>
          </div>
        )}
      </div>

      <PositionsTable s={s} />
    </div>
  );
}

/** The table twin of the chart: every value is readable without hovering. */
function PositionsTable({ s }: { s: LaneState }) {
  if (!s.positions.length) return <p className="border-t border-rule pt-4 text-[0.9rem] text-paper-dim">No open positions. Idle balances sit in the lane until the agent (or you) places a range.</p>;
  return (
    <div className="-mx-5 overflow-x-auto md:-mx-6">
      <table className="ledger-table min-w-[560px] text-[0.85rem]">
        <thead>
          <tr>
            <th className="pl-5 md:pl-6">Slot</th>
            <th>NFT</th>
            <th>Range (USDG/NVDA)</th>
            <th>Width</th>
            <th>State</th>
            <th className="n">≈ {LANE_A.sym0}</th>
            <th className="n pr-5 md:pr-6">≈ {LANE_A.sym1}</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular text-paper">
          {s.positions.map((p) => {
            const inRange = s.poolTick != null && s.poolTick >= p.tickLower && s.poolTick < p.tickUpper;
            const amt = s.poolTick != null ? positionAmounts(p.liquidity, p.tickLower, p.tickUpper, s.poolTick) : null;
            return (
              <tr key={p.slot}>
                <td className="pl-5 md:pl-6">
                  <span className="mr-2 inline-block h-2 w-2 align-middle" style={{ background: SLOT_COLOR[p.slot] }} aria-hidden />
                  {p.slot}
                </td>
                <td>#{p.tokenId.toString()}</td>
                <td>
                  {tickToPrice(p.tickUpper).toFixed(2)} – {tickToPrice(p.tickLower).toFixed(2)}
                </td>
                <td>{p.tickUpper - p.tickLower} ticks</td>
                <td className="font-sans">{p.liquidity === BigInt(0) ? "empty" : inRange ? "in range" : "out of range"}</td>
                <td className="n">{amt ? fmtUnits(BigInt(Math.floor(amt.a0)), LANE_A.dec0, 2) : "–"}</td>
                <td className="n pr-5 md:pr-6">{amt ? fmtUnits(BigInt(Math.floor(amt.a1)), LANE_A.dec1, 5) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
