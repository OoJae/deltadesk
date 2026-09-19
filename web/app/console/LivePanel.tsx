"use client";

import { useEffect, useState } from "react";
import { REGIME_LABEL, bps } from "@/lib/format";
import { addressLink, ago, etTime, short, txLink } from "@/lib/console/format";
import { liveView, nextLiveState } from "@/lib/console/live";
import type { FeedResult, PublicDecision, PublicLane, PublicSignal } from "@/lib/console/types";

const RISK = {
  normal: { color: "var(--good)", icon: "✓", label: "Risk-adding allowed" },
  reduce_only: { color: "var(--warning)", icon: "!", label: "Reduce-only" },
  flat: { color: "var(--critical)", icon: "✕", label: "Flat (exit)" },
} as const;

const STATUS_TONE: Record<string, string> = {
  executed: "var(--good)", confirmed: "var(--good)",
  executing: "var(--warning)", sent: "var(--warning)", pending: "var(--warning)", observed: "var(--warning)",
  failed: "var(--critical)", blocked: "var(--critical)", policy_denied: "var(--critical)", critic_rejected: "var(--critical)",
};

function Dot({ tone }: { tone?: string }) {
  return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone ?? "var(--axis)" }} aria-hidden />;
}

export default function LivePanel({ initial }: { initial: FeedResult }) {
  const [state, setState] = useState(() => nextLiveState(initial));
  const [now, setNow] = useState(initial.fetchedAtMs);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch("/console/api/feed", { cache: "no-store" });
        const j = (await r.json()) as FeedResult;
        if (!stop) setState((s) => nextLiveState(j, s));
      } catch {
        // keep the last good view; the header shows its age
      }
    };
    const a = setInterval(load, 10_000);
    const b = setInterval(() => setNow(Date.now()), 1_000);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, []);

  const view = liveView(state);
  if (view.kind === "not_live") {
    const res = view.result;
    const why = !res.ok
      ? res.reason === "not_configured" ? "This deployment is not connected to a desk agent yet." : `The desk agent is not reachable right now (${res.error}).`
      : "The agent is up, but no lane is registered yet.";
    return (
      <div className="card space-y-2 p-5 text-sm">
        <div className="flex items-center gap-2 font-semibold"><span className="h-2 w-2 rounded-full bg-[var(--axis)]" aria-hidden />Desk not yet live</div>
        <p className="text-ink-2">{why} The replays below run the same regime machine and gates over historical weekends.</p>
        {res.ok && <Health feed={res.feed} now={now} />}
      </div>
    );
  }

  const f = view.feed;
  return (
    <div className="space-y-4">
      {view.stale && (
        <div role="status" className="card flex items-start gap-2 p-3 text-sm">
          <Dot tone="var(--warning)" />
          <span>
            <strong>Desk agent not reachable right now</strong> ({view.stale.error}). Showing its last live answer, {ago(Math.max(0, now - view.stale.lastLiveAtMs))} old; retrying every 10 s.
          </span>
        </div>
      )}
      <Health feed={f} now={now} />
      <div className="grid gap-4 md:grid-cols-2">
        {f.lanes.map((l) => <LaneCard key={l.lane} lane={l} now={now} />)}
      </div>
      <Decisions rows={f.decisions} />
      <Signals rows={f.signals} />
    </div>
  );
}

function Health({ feed, now }: { feed: { agent: { defaultMode: string | null; modes: Record<string, number>; health: { ok: boolean; lastTickAgeMs: number | null } }; generatedAtMs: number }; now: number }) {
  const h = feed.agent.health;
  const modes = Object.entries(feed.agent.modes).map(([m, c]) => `${c} ${m}`).join(" · ");
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full text-xs text-black" style={{ background: h.ok ? "var(--good)" : "var(--warning)" }} aria-hidden>{h.ok ? "✓" : "!"}</span>
        <strong>{h.ok ? "Agent healthy" : "Agent degraded"}</strong>
        <span className="text-ink-2 tabular">· last tick {h.lastTickAgeMs == null ? "never" : `${ago(h.lastTickAgeMs)} ago`}</span>
      </div>
      <div className="text-ink-2">
        Mode: <strong className="text-ink">{modes || feed.agent.defaultMode || "–"}</strong>
        {feed.agent.defaultMode && <span className="text-muted"> (default {feed.agent.defaultMode})</span>}
      </div>
      <div className="w-full text-xs text-muted tabular">Feed generated {ago(Math.max(0, now - feed.generatedAtMs))} ago · refreshes every 10 s</div>
    </div>
  );
}

function LaneCard({ lane, now }: { lane: PublicLane; now: number }) {
  const r = lane.regime;
  const risk = r ? RISK[r.riskMode as keyof typeof RISK] : undefined;
  return (
    <div className="card space-y-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted">Lane #{lane.laneId} · {lane.pool?.name ?? "pool"}</div>
          <a className="font-mono text-sm text-[var(--accent)] hover:underline" href={addressLink(lane.lane)} target="_blank" rel="noreferrer">{short(lane.lane, 8, 6)}</a>
          <div className="text-xs text-ink-2">operator <a className="font-mono hover:underline" href={addressLink(lane.operator)} target="_blank" rel="noreferrer">{short(lane.operator)}</a> · {lane.mode} · {lane.status}</div>
        </div>
        {risk && (
          <div className="flex items-center gap-2 rounded-full border border-[var(--ring)] px-3 py-1 text-xs font-semibold">
            <span className="flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-black" style={{ background: risk.color }} aria-hidden>{risk.icon}</span>
            {risk.label}
          </div>
        )}
      </div>
      {r ? (
        <>
          <div className="text-sm"><span className="text-muted">Regime · </span><strong>{REGIME_LABEL[r.name] ?? r.name}</strong>{r.reopenKind && <span className="text-ink-2"> ({r.reopenKind.replace("_", " ")} window)</span>}</div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {r.activeGates.length === 0 ? <span className="rounded bg-surface-2 px-2 py-0.5 text-ink-2">no gate active</span> : r.activeGates.map((g) => <span key={g} className="rounded border border-[var(--ring)] px-2 py-0.5 font-medium">{g}</span>)}
          </div>
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div><dt className="text-muted">Pool mid</dt><dd className="tabular">{r.poolMid?.toFixed(2) ?? "–"}</dd></div>
            <div><dt className="text-muted">Fair (HL·k)</dt><dd className="tabular">{r.fair?.toFixed(2) ?? "–"}</dd></div>
            <div><dt className="text-muted">Gap</dt><dd className="tabular">{bps(r.gapBps)}</dd></div>
          </dl>
          <div className="text-xs text-muted tabular">tick {ago(Math.max(0, now - r.atMs))} ago</div>
        </>
      ) : <p className="text-sm text-ink-2">No tick recorded for this lane yet.</p>}
    </div>
  );
}

function Decisions({ rows }: { rows: PublicDecision[] }) {
  return (
    <section className="card overflow-x-auto p-2">
      <h3 className="px-2 pt-2 text-sm font-semibold">Decision log</h3>
      {rows.length === 0 ? <p className="p-2 text-sm text-ink-2">No decision yet: the lane only holds (a lone hold writes no decision).</p> : (
        <table className="w-full min-w-[640px] text-xs">
          <thead className="text-muted"><tr><th className="p-2 text-left">Time</th><th className="p-2 text-left">Kind</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Summary</th><th className="p-2 text-left">Tx</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-t border-grid align-top">
                <td className="whitespace-nowrap p-2 tabular text-ink-2">{etTime(d.createdAtMs)}</td>
                <td className="p-2 font-medium">{d.kind}</td>
                <td className="p-2"><span className="flex gap-1.5"><Dot tone={STATUS_TONE[d.status]} />{d.status.replace("_", " ")}</span></td>
                <td className="p-2 text-ink-2">{d.summary}<div className="font-mono text-[10px] text-muted" title={d.decisionId}>{short(d.decisionId, 10, 6)}</div></td>
                <td className="p-2">{d.txHashes.length === 0 ? <span className="text-muted">–</span> : d.txHashes.map((h) => <a key={h} className="block font-mono text-[var(--accent)] hover:underline" href={txLink(h)} target="_blank" rel="noreferrer">{short(h)}</a>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Signals({ rows }: { rows: PublicSignal[] }) {
  return (
    <section className="card overflow-x-auto p-2">
      <h3 className="px-2 pt-2 text-sm font-semibold">Gate signals</h3>
      <p className="px-2 text-xs text-muted">Each regime or gate change the desk announces on-chain as a <code>signal(Meta)</code> LaneAction. The preimage is published so anyone can recompute <code>keccak256(preimage) = reasonHash</code>.</p>
      {rows.length === 0 ? <p className="p-2 text-sm text-ink-2">No gate signal yet.</p> : (
        <table className="w-full min-w-[640px] text-xs">
          <thead className="text-muted"><tr><th className="p-2 text-left">Since</th><th className="p-2 text-left">Announced state</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">reasonHash / preimage</th><th className="p-2 text-left">Tx</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.decisionId} className="border-t border-grid align-top">
                <td className="whitespace-nowrap p-2 tabular text-ink-2">{etTime(s.atMs)}</td>
                <td className="p-2"><strong>{REGIME_LABEL[s.regime] ?? s.regime}</strong><div className="text-ink-2">{s.gates.length ? s.gates.join(" + ") : "no gate"}{s.initial && " · initial"}</div></td>
                <td className="p-2"><span className="flex gap-1.5"><Dot tone={STATUS_TONE[s.status]} />{s.status.replace("_", " ")}</span></td>
                <td className="p-2">
                  <div className="font-mono text-[10px]" title={s.reasonHash}>{short(s.reasonHash, 10, 8)}</div>
                  {s.preimage ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-ink-2">preimage {s.preimageVerified ? "· hash verified ✓" : "· hash mismatch ✕"}</summary>
                      <pre className="mt-1 max-w-[28rem] whitespace-pre-wrap break-all rounded bg-surface-2 p-2 font-mono text-[10px]">{s.preimage}</pre>
                    </details>
                  ) : <div className="text-muted">{s.preimageWithheld ? "preimage withheld (names a non-public address)" : "no preimage"}</div>}
                </td>
                <td className="p-2">{s.txHash ? <a className="font-mono text-[var(--accent)] hover:underline" href={txLink(s.txHash)} target="_blank" rel="noreferrer">{short(s.txHash)}</a> : <span className="text-muted">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
