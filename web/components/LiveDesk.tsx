"use client";

import { useEffect, useState } from "react";
import { REGIME_LABEL, bps } from "@/lib/format";

type Reason = { level: string; reason: string };
type PoolLive = {
  pool: string;
  error: string | null;
  fair: null | { fair_value: number; pool_mid: number; gap_bps: number; hl_price: number; basis_k: number; hl_ref: string | string[]; chainlink: null | { price: number; age_s: number } };
  safe: null | { verdict: "ALLOW" | "CAUTION" | "BLOCK"; reasons: Reason[]; regime: string; reopen_window: boolean; next_regime_change: null | { at: number; regime: string }; thresholds: { block_bps: number; caution_bps: number } };
};

const STATUS = {
  ALLOW: { color: "var(--good)", icon: "✓", label: "Allow" },
  CAUTION: { color: "var(--warning)", icon: "!", label: "Caution" },
  BLOCK: { color: "var(--critical)", icon: "✕", label: "Block" },
} as const;

function ago(s: number) {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
function until(atSec: number, now: number) {
  const s = Math.max(0, atSec - now / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}

export default function LiveDesk() {
  const [data, setData] = useState<{ at: number; pools: PoolLive[] } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch("/api/live", { cache: "no-store" });
        const j = await r.json();
        if (!stop) { setData(j); setErr(null); }
      } catch (e) {
        if (!stop) setErr(e instanceof Error ? e.message : "failed");
      }
    };
    load();
    const a = setInterval(load, 5000), b = setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, []);

  if (!data) return <div className="text-sm text-muted">{err ? `Live data unavailable: ${err}` : "Loading live desk…"}</div>;
  const regime = data.pools.find((p) => p.safe)?.safe;

  return (
    <div className={`space-y-4 transition-opacity ${err ? "opacity-60" : ""}`}>
      {regime && (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
          <div><span className="text-muted">Market regime · </span><strong>{REGIME_LABEL[regime.regime] ?? regime.regime}</strong>{regime.reopen_window && <span className="ml-2 text-ink-2">(reopen window)</span>}</div>
          {regime.next_regime_change && (
            <div className="tabular text-ink-2">next: {REGIME_LABEL[regime.next_regime_change.regime] ?? regime.next_regime_change.regime} in <strong className="text-ink">{until(regime.next_regime_change.at, now)}</strong></div>
          )}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {data.pools.map((p) => <PoolCard key={p.pool} p={p} />)}
      </div>
      <p className="text-xs text-muted tabular">Updated {new Date(data.at).toLocaleTimeString()} · refreshes every 5 s · fair value = Hyperliquid trade.xyz price × basis calibrated on the last regular session.</p>
    </div>
  );
}

function PoolCard({ p }: { p: PoolLive }) {
  if (!p.fair || !p.safe) return <div className="card p-5 text-sm text-ink-2">{p.pool}: {p.error ?? "unavailable"}</div>;
  const st = STATUS[p.safe.verdict];
  const gap = p.fair.gap_bps, lim = p.safe.thresholds.block_bps;
  const w = Math.min(Math.abs(gap) / lim, 1) * 50;
  const cl = p.fair.chainlink;
  return (
    <div className="card space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted">{p.pool}</div>
          <div className="mt-1 text-2xl font-semibold tabular">{p.fair.pool_mid.toFixed(p.fair.pool_mid < 10 ? 5 : 2)}</div>
          <div className="text-xs text-ink-2">pool mid</div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-[var(--ring)] px-3 py-1 text-sm font-semibold">
          <span className="flex h-5 w-5 items-center justify-center rounded-full text-xs text-black" style={{ background: st.color }} aria-hidden>{st.icon}</span>
          {st.label}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-ink-2 tabular"><span>gap to fair value</span><strong className="text-ink">{bps(gap)}</strong></div>
        <div className="relative h-2 rounded-full bg-surface-2">
          <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--axis)]" />
          <div className="absolute inset-y-0 rounded-full" style={{ background: st.color, width: `${w}%`, left: gap >= 0 ? "50%" : `${50 - w}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-muted tabular"><span>−{lim} bp</span><span>block limit</span><span>+{lim} bp</span></div>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-muted">Fair (HL)</dt><dd className="tabular">{p.fair.fair_value.toFixed(p.fair.fair_value < 10 ? 5 : 2)}</dd></div>
        <div><dt className="text-muted">Chainlink</dt><dd className="tabular">{cl ? cl.price.toFixed(2) : "–"}</dd></div>
        <div><dt className="text-muted">Oracle age</dt><dd className="tabular">{cl ? <>{ago(cl.age_s)}{cl.age_s > 3600 && <span className="ml-1 rounded bg-surface-2 px-1 text-[10px] text-ink-2">frozen</span>}</> : "–"}</dd></div>
      </dl>

      <ul className="space-y-1 text-xs text-ink-2">
        {p.safe.reasons.slice(0, 3).map((r, i) => (
          <li key={i} className="flex gap-2"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS[r.level as keyof typeof STATUS]?.color ?? "var(--axis)" }} />{r.reason}</li>
        ))}
      </ul>
    </div>
  );
}
