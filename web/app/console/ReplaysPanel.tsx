"use client";

import { type PointerEvent, useEffect, useMemo, useState } from "react";
import { Label } from "@/components/brand/Label";
import { Stat } from "@/components/brand/Stat";
import { Key, Notice, ViewToggle } from "@/components/ledger/ui";
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
    <span className="inline-flex max-w-full items-center gap-2.5 border border-[var(--warning)] py-1 pl-1 pr-3 text-xs">
      <span className="label bg-[var(--warning)] px-1.5 py-0.5 text-vault">Replay</span>
      <span className="min-w-0 text-paper-dim">{label ? label.replace(/^REPLAY\s*/, "") : "(historical data, not live)"}</span>
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

  if (err && !index) return <Notice tone="warning">No replays published on this deployment ({err}).</Notice>;
  if (!index) return <Notice>Loading replays…</Notice>;
  const r = sel ? cache[sel] : undefined;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-px border border-rule bg-rule" role="tablist" aria-label="Replays">
        {index.replays.map((x) => {
          const on = sel === x.id;
          return (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSel(x.id)}
              className={`relative flex min-w-0 flex-1 basis-56 flex-col items-start gap-1.5 px-5 py-4 text-left transition-colors ${on ? "bg-vault-3" : "bg-vault-2 hover:bg-vault-3/60"}`}
            >
              <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] bg-paper transition-opacity ${on ? "opacity-100" : "opacity-0"}`} />
              <span className={`text-[0.9rem] font-medium ${on ? "text-paper" : "text-paper-dim"}`}>{x.title.split(":")[0]}</span>
              <span className="font-mono text-[0.68rem] text-paper-mute">{x.pool}</span>
            </button>
          );
        })}
      </div>
      {r ? <ReplayView key={r.id} r={r} /> : <Notice tone={err ? "warning" : "neutral"}>{err ? `Could not load this replay (${err}).` : "Loading replay…"}</Notice>}
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
  const BH = 9, BG = 7;
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
    <div className="space-y-8">
      <div className="grid gap-8 border-y border-rule py-7 lg:grid-cols-12 lg:gap-x-8">
        <div className="space-y-4 lg:col-span-5">
          <ReplayBadge label={r.label} />
          <h3 className="text-title text-paper">{r.title}</h3>
          <p className="text-sm leading-relaxed text-paper-dim">{r.note}</p>
        </div>
        <ul className="ledger-ruled self-end border-y border-rule text-[0.92rem] leading-relaxed text-paper lg:col-span-6 lg:col-start-7">
          {r.headline.map((t, i) => (
            <li key={i} className="flex gap-3 py-3">
              <span className="mt-[0.7em] h-px w-3 shrink-0 bg-paper-mute" aria-hidden />
              {t}
            </li>
          ))}
        </ul>
      </div>

      <figure className="space-y-4 border border-rule bg-vault-2 px-4 py-5 md:px-7 md:py-7">
        <figcaption className="flex items-baseline justify-between gap-4">
          <span className="text-[0.95rem] text-paper">
            Regime, gates and the pool-vs-fair gap, every {r.rowEveryS / 60} min{" "}
            <span className="font-mono text-[0.78rem] text-paper-dim">
              ({r.window.startEt} → {r.window.endEt})
            </span>
          </span>
          <ViewToggle table={showEvents} onToggle={() => setShowEvents((s) => !s)} tableLabel="Show events table" />
        </figcaption>
        {!showEvents ? (
          <>
            <div className="-mx-1 overflow-x-auto px-1" tabIndex={0} role="region" aria-label="Replay timeline (scrolls sideways on small screens)">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[680px] select-none font-mono" role="img" aria-label={`Replay timeline of ${r.title}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
              {bands.map((b, bi) => (
                <g key={b.label}>
                  <text x={GUT - 10} y={bi * (BH + BG) + BH - 1} textAnchor="end" fontSize="9.5" letterSpacing="0.04em" fill="var(--text-secondary)">{b.label}</text>
                  <rect x={GUT} y={bi * (BH + BG)} width={PW} height={BH} fill="var(--surface-2)" />
                  {b.runs.map((u, k) => u.fill && <rect key={k} x={x0(u.from)} y={bi * (BH + BG)} width={Math.max(0.8, x0(u.to) - x0(u.from) - 0.6)} height={BH} fill={u.fill} />)}
                </g>
              ))}
              {closedRuns.map((u, k) => <rect key={k} x={x0(u.from)} y={GT} width={x0(u.to) - x0(u.from)} height={GH} fill="var(--surface-2)" />)}
              {[-M, -M / 2, 0, M / 2, M].map((g) => (
                <g key={g}>
                  <line x1={GUT} x2={GUT + PW} y1={y(g)} y2={y(g)} stroke={g === 0 ? "var(--rule-strong)" : "var(--rule)"} strokeWidth="1" vectorEffect="non-scaling-stroke" />
                  <text x={GUT - 10} y={y(g) + 3} textAnchor="end" fontSize="9.5" fill="var(--text-muted)">{g > 0 ? `+${g}` : g} bp</text>
                </g>
              ))}
              <text x={GUT} y={GT - 12} textAnchor="start" fontSize="9.5" letterSpacing="0.04em" fill="var(--text-secondary)">Gap to fair value (bp)</text>
              <polyline points={path} fill="none" stroke="var(--serial)" strokeWidth="1.4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              {marks.map((m) => <circle key={m.i} cx={xc(m.i)} cy={y(m.g)} r="4.5" fill="var(--series-2)" stroke="var(--surface-1)" strokeWidth="2"><title>{m.a}</title></circle>)}
              {ticks.map((t) => (
                <g key={t.i}>
                  <line x1={x0(t.i)} x2={x0(t.i)} y1={GT + GH} y2={GT + GH + (t.label ? 6 : 3)} stroke="var(--rule-strong)" />
                  {t.label && <text x={x0(t.i)} y={H - 4} textAnchor="middle" fontSize="9.5" fill="var(--text-muted)">{t.label}</text>}
                </g>
              ))}
              {hover !== null && <line x1={xc(hover)} x2={xc(hover)} y1={0} y2={GT + GH} stroke="var(--paper)" strokeOpacity="0.55" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
            </svg>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-rule pt-4 text-[0.72rem] text-paper-dim">
              {Object.entries(REGIME_COLOR).filter(([k]) => rows.some((x) => x.regime === k)).map(([k, c]) => <Key key={k} color={c}>{REGIME_LABEL[k] ?? k}</Key>)}
              <Key color="var(--warning)">gate active</Key>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className="h-2.5 w-2.5" style={{ background: "var(--good)" }} />allowed /
                <span aria-hidden className="h-2.5 w-2.5" style={{ background: "var(--critical)" }} />blocked
              </span>
              <Key color="var(--serial)" shape="line">gap = 1e4·ln(F / pool), + means pool below fair</Key>
              {marks.length > 0 && <Key color="var(--series-2)" shape="dot">desk action</Key>}
              <span className="text-paper-mute">shaded: market closed · not armed (stubs): {stubs.join(", ")}</span>
            </div>
            <Readout row={h} mode={r.mode} />
          </>
        ) : <EventsTable r={r} />}
      </figure>

      {lvr && (
        <section className="border border-rule bg-vault-2" aria-labelledby={`lvr-${r.id}`}>
          <header className="border-b border-rule px-5 py-4 md:px-7">
            <Label as="p">Closed-window cost</Label>
            <h3 id={`lvr-${r.id}`} className="mt-1 text-[1.15rem] font-medium text-paper">
              What the closed window cost an always-in-range LP
            </h3>
          </header>
          {lvr.derivable && lvr.controlLane && lvr.poolWide ? (
            <>
              <p className="max-w-[80ch] px-5 pt-5 text-[0.95rem] leading-relaxed text-paper-dim md:px-7">{lvr.statement}</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-7 px-5 py-6 md:px-7 lg:grid-cols-4">
                <Stat label="Control lane: picked off" value={usd(lvr.controlLane.pickedOffUsd)} unit="per $1k" size="md" />
                <Stat label="Control lane: fees" value={usd(lvr.controlLane.feesUsd)} size="md" />
                <Stat label="Pool-wide picked off (HL 1 h)" value={usd(lvr.poolWide.pickedOffHl1hUsd)} size="md" />
                <Stat label="Pool-wide LP fees" value={usd(lvr.poolWide.lpFeesUsd)} size="md" />
              </div>
              <p className="border-t border-rule px-5 py-4 text-xs text-paper-mute md:px-7">{lvr.controlLane.definition}. Engine outputs: data/study/m1/hl_ref (M1 markouts).</p>
            </>
          ) : (
            <p className="px-5 py-5 text-sm text-paper-dim md:px-7">Not derivable for this window{lvr.reason ? `: ${lvr.reason}` : ""}.</p>
          )}
        </section>
      )}

      <details className="group border border-rule bg-vault-2 text-xs text-paper-dim">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[0.95rem] font-medium text-paper md:px-7 [&::-webkit-details-marker]:hidden">
          How this replay was made
          <span aria-hidden className="font-mono text-paper-mute transition-transform duration-200 group-open:rotate-45">+</span>
        </summary>
        <div className="grid gap-6 border-t border-rule px-5 py-5 md:grid-cols-3 md:px-7">
          {[
            { k: "Engine", v: r.engine },
            { k: "Assumptions", v: r.assumptions },
            { k: "Data sources", v: r.sources },
          ].map((g) => (
            <div key={g.k} className="space-y-2">
              <Label as="h4">{g.k}</Label>
              <ul className="space-y-1.5 leading-relaxed">
                {g.v.map((t) => (
                  <li key={t} className="flex gap-2">
                    <span aria-hidden className="mt-[0.65em] h-px w-2 shrink-0 bg-paper-mute" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function Readout({ row, mode }: { row: ReplayRow | null; mode: Replay["mode"] }) {
  if (!row) return <p className="min-h-[4.25rem] pt-1 text-xs text-paper-mute">Hover the timeline for the desk&apos;s state and decision at that moment.</p>;
  const cl = row.chainlink;
  return (
    <div className="min-h-[4.25rem] border-l-2 border-paper-mute bg-vault-3 px-3 py-2.5 text-xs text-paper-dim tabular">
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[0.7rem]">
        <strong className="font-medium text-paper">{etTime(row.ts * 1000)}</strong>
        <span>{REGIME_LABEL[row.regime] ?? row.regime}{row.reopenKind && ` (${row.reopenKind.replace("_", " ")})`}</span>
        <span>gates: {row.activeGates.length ? row.activeGates.join(" + ") : "none"}</span>
        <span>risk-adding: <strong className="font-medium text-paper">{row.riskAddingAllowed ? "allowed" : "blocked"}</strong></span>
        <span>pool {row.poolMid?.toFixed(2) ?? "–"} · fair {row.fair?.toFixed(2) ?? "–"} · gap {bps(row.gapBps)}</span>
        <span>Chainlink {cl.price?.toFixed(2) ?? "–"} ({cl.ageS == null ? "–" : `${ago(cl.ageS * 1000)} old`}{cl.frozen ? ", frozen" : ""})</span>
        {mode === "lane-a" && row.lane && <span>lane {row.lane.inRange === null ? "flat" : row.lane.inRange ? "in range" : "out of range"} · ${row.lane.deployedUsd.toFixed(2)} deployed</span>}
      </div>
      <div className="mt-1.5 text-paper-dim"><strong className="font-mono font-medium text-paper">{row.decision.action}</strong>: {row.decision.reason}</div>
    </div>
  );
}

function EventsTable({ r }: { r: Replay }) {
  return (
    <div className="max-h-[28rem] overflow-auto border border-rule" tabIndex={0} role="region" aria-label="Replay events">
      <table className="ledger-table min-w-[36rem] text-xs">
        <thead className="sticky top-0 bg-vault-3"><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Why</th></tr></thead>
        <tbody>
          {r.events.map((e, i) => (
            <tr key={i} className="align-top">
              <td className="whitespace-nowrap font-mono text-paper-dim tabular">{etTime(e.ts * 1000)}{e.warmup && <span className="ml-1 text-paper-mute">(warm-up)</span>}</td>
              <td className="whitespace-nowrap font-mono text-paper">{e.kind === "action" ? e.action : `${e.gate} ${e.kind === "gate_on" ? "on" : "off"}`}</td>
              <td className="text-paper-dim">{e.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
