"use client";

import { type PointerEvent, useEffect, useMemo, useState } from "react";
import { REGIME_LABEL, bps, usd } from "@/lib/format";
import { ago, etTime } from "@/lib/console/format";
import type { Replay, ReplayIndex, ReplayRow } from "@/lib/console/types";

const REGIME_COLOR: Record<string, string> = {
  REGULAR: "var(--div-pos-4)",
  EXTENDED: "var(--div-pos-3)",
  OVERNIGHT: "var(--div-pos-2)",
  WEEKEND_DARK: "var(--axis)",
  HOLIDAY: "var(--text-muted)",
};
const IMPLEMENTED = ["CLOSED", "HALT", "CORP-ACTION", "STALE-REF", "REOPEN-GUARD"];

export function ReplayBadge({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border-2 border-[var(--warning)] px-3 py-0.5 text-xs font-bold tracking-wider">
      REPLAY<span className="font-normal tracking-normal text-ink-2">{label ? label.replace(/^REPLAY\s*/, "") : "(historical data, not live)"}</span>
    </span>
  );
}

export default function ReplaysPanel() {
  const [index, setIndex] = useState<ReplayIndex | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, Replay>>({});

  useEffect(() => {
    fetch("/replays/index.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: ReplayIndex) => { setIndex(j); setSel(j.replays[0]?.id ?? null); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "failed"));
  }, []);

  useEffect(() => {
    if (sel === null || cache[sel]) return;
    fetch(`/replays/${encodeURIComponent(sel)}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: Replay) => setCache((c) => ({ ...c, [j.id]: j })))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "failed"));
  }, [sel, cache]);

  if (err && !index) return <div className="card p-5 text-sm text-ink-2">No replays published on this deployment ({err}).</div>;
  if (!index) return <div className="card p-5 text-sm text-ink-2">Loading replays…</div>;
  const r = sel ? cache[sel] : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist">
        {index.replays.map((x) => (
          <button key={x.id} role="tab" aria-selected={sel === x.id} onClick={() => setSel(x.id)}
            className={`rounded-lg border px-3 py-1.5 text-left text-xs ${sel === x.id ? "border-[var(--accent)] bg-surface-2 text-ink" : "border-[var(--ring)] text-ink-2 hover:bg-surface-2"}`}>
            <div className="font-semibold">{x.title.split(":")[0]}</div>
            <div className="text-muted">{x.pool}</div>
          </button>
        ))}
      </div>
      {r ? <ReplayView key={r.id} r={r} /> : <div className="card p-5 text-sm text-ink-2">{err ? `Could not load this replay (${err}).` : "Loading replay…"}</div>}
    </div>
  );
}

function runs<T>(rows: ReplayRow[], key: (r: ReplayRow) => T): { from: number; to: number; v: T }[] {
  const out: { from: number; to: number; v: T }[] = [];
  rows.forEach((r, i) => {
    const v = key(r);
    const last = out[out.length - 1];
    if (last && last.v === v) last.to = i + 1;
    else out.push({ from: i, to: i + 1, v });
  });
  return out;
}

const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });

function ReplayView({ r }: { r: Replay }) {
  const [hover, setHover] = useState<number | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  const rows = r.rows;
  const n = rows.length;
  const W = 1000, GUT = 118, PW = W - GUT - 8;
  const x0 = (i: number) => GUT + (i * PW) / n;
  const xc = (i: number) => GUT + ((i + 0.5) * PW) / n;

  const ticks = useMemo(() => rows.flatMap((row, i) => {
    const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(row.ts * 1000)).map((x) => [x.type, x.value]));
    const hh = Number(p.hour) % 24, mm = Number(p.minute);
    return mm !== 0 ? [] : hh === 0 ? [{ i, label: `${p.weekday} ${p.day}` }] : hh === 12 ? [{ i, label: "" }] : [];
  }), [rows]);

  const gates = IMPLEMENTED.filter((g) => g === "CLOSED" || rows.some((x) => x.activeGates.includes(g)));
  const bands: { label: string; runs: { from: number; to: number; fill: string | null }[] }[] = [
    { label: "Regime", runs: runs(rows, (x) => x.regime).map((u) => ({ ...u, fill: REGIME_COLOR[u.v] ?? "var(--grid)" })) },
    { label: "Risk-adding", runs: runs(rows, (x) => x.riskAddingAllowed).map((u) => ({ ...u, fill: u.v ? "var(--good)" : "var(--critical)" })) },
    ...gates.map((g) => ({ label: g, runs: runs(rows, (x) => x.activeGates.includes(g)).map((u) => ({ ...u, fill: u.v ? (g === "HALT" ? "var(--critical)" : "var(--warning)") : null })) })),
    { label: "Chainlink frozen", runs: runs(rows, (x) => x.chainlink.frozen).map((u) => ({ ...u, fill: u.v ? "var(--text-secondary)" : null })) },
    ...(r.mode === "lane-a" ? [{ label: "Lane in range", runs: runs(rows, (x) => x.lane?.inRange ?? null).map((u) => ({ ...u, fill: u.v === true ? "var(--series-1)" : u.v === false ? "var(--grid)" : null })) }] : []),
  ];
  const BH = 12, BG = 5;
  const bandsH = bands.length * (BH + BG);
  const GT = bandsH + 30, GH = 170;
  const gaps = rows.map((x) => x.gapBps).filter((g): g is number => g !== null);
  const M = Math.max(10, Math.ceil(Math.max(...gaps.map(Math.abs), 0) / 10) * 10);
  const y = (g: number) => GT + GH / 2 - (g / M) * (GH / 2);
  const H = GT + GH + 22;
  const path = rows.map((x, i) => (x.gapBps === null ? null : `${xc(i).toFixed(1)},${y(x.gapBps).toFixed(1)}`)).filter(Boolean).join(" ");
  const closedRuns = runs(rows, (x) => x.regime === "WEEKEND_DARK" || x.regime === "HOLIDAY").filter((u) => u.v);
  const marks = rows.flatMap((x, i) => (x.decision.action === "re-center" || x.decision.action === "exit") && x.gapBps !== null ? [{ i, a: x.decision.action, g: x.gapBps }] : []);
  const h = hover !== null ? rows[hover] : null;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    const i = Math.floor(((vx - GUT) / PW) * n);
    setHover(i >= 0 && i < n ? i : null);
  };
  const lvr = r.lvr;
  const stubs = Object.keys(r.notArmed);

  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">{r.title}</h3>
          <ReplayBadge label={r.label} />
        </div>
        <p className="text-sm text-ink-2">{r.note}</p>
        <ul className="space-y-1.5 text-sm">
          {r.headline.map((t, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--axis)]" aria-hidden />{t}</li>)}
        </ul>
      </div>

      <figure className="card space-y-2 p-4">
        <figcaption className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-ink-2">
          <span>Regime, gates and the pool-vs-fair gap, every {r.rowEveryS / 60} min ({r.window.startEt} → {r.window.endEt})</span>
          <button onClick={() => setShowEvents((s) => !s)} className="text-xs text-muted underline-offset-2 hover:underline">{showEvents ? "Show chart" : "Show events table"}</button>
        </figcaption>
        {!showEvents ? (
          <>
            <div className="-mx-1 overflow-x-auto px-1">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[680px] select-none" role="img" aria-label={`Replay timeline of ${r.title}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
              {bands.map((b, bi) => (
                <g key={b.label}>
                  <text x={GUT - 8} y={bi * (BH + BG) + BH - 2} textAnchor="end" fontSize="10" fill="var(--text-secondary)">{b.label}</text>
                  <rect x={GUT} y={bi * (BH + BG)} width={PW} height={BH} fill="var(--surface-2)" rx="2" />
                  {b.runs.map((u, k) => u.fill && <rect key={k} x={x0(u.from)} y={bi * (BH + BG)} width={Math.max(0.8, x0(u.to) - x0(u.from) - 0.6)} height={BH} fill={u.fill} rx="2" />)}
                </g>
              ))}
              {closedRuns.map((u, k) => <rect key={k} x={x0(u.from)} y={GT} width={x0(u.to) - x0(u.from)} height={GH} fill="var(--surface-2)" />)}
              {[-M, -M / 2, 0, M / 2, M].map((g) => (
                <g key={g}>
                  <line x1={GUT} x2={GUT + PW} y1={y(g)} y2={y(g)} stroke={g === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth="1" />
                  <text x={GUT - 8} y={y(g) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">{g > 0 ? `+${g}` : g} bp</text>
                </g>
              ))}
              <text x={GUT} y={GT - 12} textAnchor="start" fontSize="10" fill="var(--text-secondary)">Gap to fair value (bp)</text>
              <polyline points={path} fill="none" stroke="var(--series-1)" strokeWidth="1.6" strokeLinejoin="round" />
              {marks.map((m) => <circle key={m.i} cx={xc(m.i)} cy={y(m.g)} r="4.5" fill="var(--series-2)" stroke="var(--surface-1)" strokeWidth="2"><title>{m.a}</title></circle>)}
              {ticks.map((t) => (
                <g key={t.i}>
                  <line x1={x0(t.i)} x2={x0(t.i)} y1={GT + GH} y2={GT + GH + (t.label ? 6 : 3)} stroke="var(--axis)" />
                  {t.label && <text x={x0(t.i)} y={H - 4} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{t.label}</text>}
                </g>
              ))}
              {hover !== null && <line x1={xc(hover)} x2={xc(hover)} y1={0} y2={GT + GH} stroke="var(--text-primary)" strokeWidth="1" strokeDasharray="3 3" />}
            </svg>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2">
              {Object.entries(REGIME_COLOR).filter(([k]) => rows.some((x) => x.regime === k)).map(([k, c]) => <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{REGIME_LABEL[k] ?? k}</span>)}
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--warning)" }} />gate active</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--good)" }} />allowed / <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--critical)" }} />blocked</span>
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-3" style={{ background: "var(--series-1)" }} />gap = 1e4·ln(F / pool), + means pool below fair</span>
              {marks.length > 0 && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--series-2)" }} />desk action</span>}
              <span className="text-muted">shaded: market closed · not armed (stubs): {stubs.join(", ")}</span>
            </div>
            <Readout row={h} mode={r.mode} />
          </>
        ) : <EventsTable r={r} />}
      </figure>

      {lvr && (
        <div className="card space-y-2 p-5 text-sm">
          <h3 className="font-semibold">What the closed window cost an always-in-range LP</h3>
          {lvr.derivable && lvr.controlLane && lvr.poolWide ? (
            <>
              <p className="text-ink-2">{lvr.statement}</p>
              <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div><dt className="text-muted">Control lane: picked off</dt><dd className="text-base font-semibold tabular">{usd(lvr.controlLane.pickedOffUsd)} <span className="text-xs font-normal text-muted">per $1k</span></dd></div>
                <div><dt className="text-muted">Control lane: fees</dt><dd className="text-base font-semibold tabular">{usd(lvr.controlLane.feesUsd)}</dd></div>
                <div><dt className="text-muted">Pool-wide picked off (HL 1 h)</dt><dd className="tabular">{usd(lvr.poolWide.pickedOffHl1hUsd)}</dd></div>
                <div><dt className="text-muted">Pool-wide LP fees</dt><dd className="tabular">{usd(lvr.poolWide.lpFeesUsd)}</dd></div>
              </dl>
              <p className="text-xs text-muted">{lvr.controlLane.definition}. Engine outputs: data/study/m1/hl_ref (M1 markouts).</p>
            </>
          ) : <p className="text-ink-2">Not derivable for this window{lvr.reason ? `: ${lvr.reason}` : ""}.</p>}
        </div>
      )}

      <details className="card p-4 text-xs text-ink-2">
        <summary className="cursor-pointer text-sm font-medium text-ink">How this replay was made</summary>
        <div className="mt-2 space-y-2">
          <div><strong className="text-ink">Engine:</strong><ul className="ml-4 list-disc">{r.engine.map((t) => <li key={t}>{t}</li>)}</ul></div>
          <div><strong className="text-ink">Assumptions:</strong><ul className="ml-4 list-disc">{r.assumptions.map((t) => <li key={t}>{t}</li>)}</ul></div>
          <div><strong className="text-ink">Data sources:</strong><ul className="ml-4 list-disc">{r.sources.map((t) => <li key={t}>{t}</li>)}</ul></div>
        </div>
      </details>
    </div>
  );
}

function Readout({ row, mode }: { row: ReplayRow | null; mode: Replay["mode"] }) {
  if (!row) return <p className="min-h-[3.5rem] text-xs text-muted">Hover the timeline for the desk&apos;s state and decision at that moment.</p>;
  const cl = row.chainlink;
  return (
    <div className="min-h-[3.5rem] rounded-lg bg-surface-2 p-2 text-xs tabular">
      <div className="flex flex-wrap gap-x-4">
        <strong>{etTime(row.ts * 1000)}</strong>
        <span>{REGIME_LABEL[row.regime] ?? row.regime}{row.reopenKind && ` (${row.reopenKind.replace("_", " ")})`}</span>
        <span>gates: {row.activeGates.length ? row.activeGates.join(" + ") : "none"}</span>
        <span>risk-adding: <strong>{row.riskAddingAllowed ? "allowed" : "blocked"}</strong></span>
        <span>pool {row.poolMid?.toFixed(2) ?? "–"} · fair {row.fair?.toFixed(2) ?? "–"} · gap {bps(row.gapBps)}</span>
        <span>Chainlink {cl.price?.toFixed(2) ?? "–"} ({cl.ageS == null ? "–" : `${ago(cl.ageS * 1000)} old`}{cl.frozen ? ", frozen" : ""})</span>
        {mode === "lane-a" && row.lane && <span>lane {row.lane.inRange === null ? "flat" : row.lane.inRange ? "in range" : "out of range"} · ${row.lane.deployedUsd.toFixed(2)} deployed</span>}
      </div>
      <div className="mt-1 text-ink-2"><strong className="text-ink">{row.decision.action}</strong>: {row.decision.reason}</div>
    </div>
  );
}

function EventsTable({ r }: { r: Replay }) {
  return (
    <div className="max-h-[28rem] overflow-auto">
      <table className="w-full min-w-[560px] text-xs">
        <thead className="sticky top-0 bg-surface-1 text-muted"><tr><th className="p-2 text-left">Time</th><th className="p-2 text-left">Event</th><th className="p-2 text-left">Why</th></tr></thead>
        <tbody>
          {r.events.map((e, i) => (
            <tr key={i} className="border-t border-grid align-top">
              <td className="whitespace-nowrap p-2 tabular text-ink-2">{etTime(e.ts * 1000)}{e.warmup && <span className="ml-1 text-muted">(warm-up)</span>}</td>
              <td className="whitespace-nowrap p-2 font-medium">{e.kind === "action" ? e.action : `${e.gate} ${e.kind === "gate_on" ? "on" : "off"}`}</td>
              <td className="p-2 text-ink-2">{e.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
