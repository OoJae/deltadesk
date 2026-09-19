"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/brand/Label";
import { LINK, ScrollX, StatusIcon, StatusStamp, type StatusTone } from "@/components/ledger/ui";
import { REGIME_LABEL, bps } from "@/lib/format";
import { addressLink, ago, etTime, short, txLink } from "@/lib/console/format";
import { liveView, nextLiveState } from "@/lib/console/live";
import type { FeedResult, PublicDecision, PublicLane, PublicSignal } from "@/lib/console/types";

const RISK: Record<string, { tone: StatusTone; label: string }> = {
  normal: { tone: "good", label: "Risk-adding allowed" },
  reduce_only: { tone: "warning", label: "Reduce-only" },
  flat: { tone: "critical", label: "Flat (exit)" },
};

const STATUS_TONE: Record<string, StatusTone> = {
  executed: "good", confirmed: "good",
  executing: "warning", sent: "warning", pending: "warning", observed: "warning",
  failed: "critical", blocked: "critical", policy_denied: "critical", critic_rejected: "critical",
};

/** A decision or signal status: reserved status glyph plus the status word. */
function Status({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <StatusIcon tone={STATUS_TONE[status] ?? "neutral"} size="sm" />
      {status.replace("_", " ")}
    </span>
  );
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
      <div className="space-y-4">
        <div className="border border-rule bg-vault-2 px-5 py-5 md:px-7">
          <p className="flex items-center gap-3 text-[1.05rem] font-medium text-paper">
            <StatusIcon tone="neutral" />
            Desk not yet live
          </p>
          <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-paper-dim">{why} The replays below run the same regime machine and gates over historical weekends.</p>
        </div>
        {res.ok && <Health feed={res.feed} now={now} />}
      </div>
    );
  }

  const f = view.feed;
  return (
    <div className="space-y-8">
      {view.stale && (
        <div role="status" className="flex items-start gap-3 border border-rule-strong bg-vault-2 px-5 py-4 text-sm text-paper-dim">
          <StatusIcon tone="warning" className="mt-px" />
          <span>
            <strong className="font-medium text-paper">Desk agent not reachable right now</strong> ({view.stale.error}). Showing its last live answer,{" "}
            <span className="font-mono">{ago(Math.max(0, now - view.stale.lastLiveAtMs))}</span> old; retrying every 10 s.
          </span>
        </div>
      )}
      <Health feed={f} now={now} />
      {/* One lane reads across the full measure; several sit two to a row on the hairline grid. */}
      <div className={`grid gap-px border border-rule bg-rule ${f.lanes.length > 1 ? "md:grid-cols-2" : ""}`}>
        {f.lanes.map((l) => (
          <LaneCard key={l.lane} lane={l} now={now} wide={f.lanes.length === 1} />
        ))}
        {f.lanes.length > 1 && f.lanes.length % 2 === 1 && <div aria-hidden className="hidden bg-vault-2 md:block" />}
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
    <div className="grid gap-5 border-y border-rule py-5 md:grid-cols-12 md:items-center md:gap-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:col-span-5">
        <StatusIcon tone={h.ok ? "good" : "warning"} />
        <strong className="font-medium text-paper">{h.ok ? "Agent healthy" : "Agent degraded"}</strong>
        <span className="font-mono text-[0.78rem] text-paper-dim tabular">· last tick {h.lastTickAgeMs == null ? "never" : `${ago(h.lastTickAgeMs)} ago`}</span>
      </div>
      <div className="text-sm text-paper-dim md:col-span-4">
        <Label className="mr-2">Mode</Label>
        <strong className="font-medium text-paper">{modes || feed.agent.defaultMode || "–"}</strong>
        {feed.agent.defaultMode && <span className="text-paper-mute"> (default {feed.agent.defaultMode})</span>}
      </div>
      <div className="font-mono text-[0.7rem] text-paper-mute tabular md:col-span-3 md:text-right">
        Feed generated {ago(Math.max(0, now - feed.generatedAtMs))} ago · refreshes every 10 s
      </div>
    </div>
  );
}

function LaneCard({ lane, now, wide = false }: { lane: PublicLane; now: number; wide?: boolean }) {
  const r = lane.regime;
  const risk = r ? RISK[r.riskMode] : undefined;
  return (
    <article className={`grid gap-6 bg-vault-2 px-5 py-6 md:px-7 md:py-7 ${wide ? "lg:grid-cols-3 lg:gap-x-10" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <Label as="h3" tone="paper">
            Lane #{lane.laneId} · {lane.pool?.name ?? "pool"}
          </Label>
          <a className={`${LINK} block font-mono text-[0.95rem]`} href={addressLink(lane.lane)} target="_blank" rel="noreferrer">
            {short(lane.lane, 8, 6)}
          </a>
          <div className="text-xs text-paper-dim">
            operator{" "}
            <a className={`${LINK} font-mono`} href={addressLink(lane.operator)} target="_blank" rel="noreferrer">
              {short(lane.operator)}
            </a>{" "}
            · {lane.mode} · {lane.status}
          </div>
        </div>
        {risk && <StatusStamp tone={risk.tone}>{risk.label}</StatusStamp>}
      </div>
      {r ? (
        <>
          <div className={`space-y-3 ${wide ? "lg:border-l lg:border-rule lg:pl-10" : ""}`}>
            <p className="text-[1.05rem] text-paper">
              <Label className="mr-2 align-middle">Regime</Label>
              {REGIME_LABEL[r.name] ?? r.name}
              {r.reopenKind && <span className="text-paper-dim"> ({r.reopenKind.replace("_", " ")} window)</span>}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {r.activeGates.length === 0 ? (
                <span className="label border border-rule px-2 py-1 text-paper-mute">no gate active</span>
              ) : (
                r.activeGates.map((g) => (
                  <span key={g} className="label border border-rule-strong px-2 py-1 text-paper">
                    {g}
                  </span>
                ))
              )}
            </div>
          </div>
          <div className={`space-y-4 ${wide ? "lg:border-l lg:border-rule lg:pl-10" : ""}`}>
          <dl className={`grid grid-cols-3 gap-4 border-t border-rule pt-5 ${wide ? "lg:border-t-0 lg:pt-0" : ""}`}>
            <div className="space-y-1">
              <Label as="dt">Pool mid</Label>
              <dd className="font-mono text-sm text-paper tabular">{r.poolMid?.toFixed(2) ?? "–"}</dd>
            </div>
            <div className="space-y-1">
              <Label as="dt">Fair (HL·k)</Label>
              <dd className="font-mono text-sm text-paper tabular">{r.fair?.toFixed(2) ?? "–"}</dd>
            </div>
            <div className="space-y-1">
              <Label as="dt">Gap</Label>
              <dd className="font-mono text-sm text-serial tabular">{bps(r.gapBps)}</dd>
            </div>
          </dl>
          <div className="font-mono text-[0.7rem] text-paper-mute tabular">tick {ago(Math.max(0, now - r.atMs))} ago</div>
          </div>
        </>
      ) : (
        <p className="text-sm text-paper-dim">No tick recorded for this lane yet.</p>
      )}
    </article>
  );
}

function Decisions({ rows }: { rows: PublicDecision[] }) {
  return (
    <section className="border border-rule bg-vault-2" aria-labelledby="decision-log">
      <header className="border-b border-rule px-5 py-4 md:px-7">
        <Label as="p">What the desk decided</Label>
        <h3 id="decision-log" className="mt-1 text-[1.15rem] font-medium text-paper">
          Decision log
        </h3>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-5 text-sm text-paper-dim md:px-7">No decision yet: the lane only holds (a lone hold writes no decision).</p>
      ) : (
        <ScrollX label="Decision log">
          <table className="ledger-table min-w-[48rem] text-xs">
            <thead>
              <tr>
                <th scope="col" className="pl-5 md:pl-7">Time</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Summary</th>
                <th scope="col" className="pr-5 md:pr-7">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="align-top">
                  <td className="whitespace-nowrap pl-5 font-mono text-paper-dim tabular md:pl-7">{etTime(d.createdAtMs)}</td>
                  <td className="font-mono text-paper">{d.kind}</td>
                  <td className="text-paper-dim">
                    <Status status={d.status} />
                  </td>
                  <td className="text-paper-dim">
                    {d.summary}
                    <div className="mt-1 font-mono text-[0.65rem] text-paper-mute" title={d.decisionId}>
                      {short(d.decisionId, 10, 6)}
                    </div>
                  </td>
                  <td className="pr-5 md:pr-7">
                    {d.txHashes.length === 0 ? (
                      <span className="text-paper-mute">–</span>
                    ) : (
                      d.txHashes.map((h) => (
                        <a key={h} className={`${LINK} block whitespace-nowrap font-mono`} href={txLink(h)} target="_blank" rel="noreferrer">
                          {short(h)}
                        </a>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollX>
      )}
    </section>
  );
}

function Signals({ rows }: { rows: PublicSignal[] }) {
  return (
    <section className="border border-rule bg-vault-2" aria-labelledby="gate-signals">
      <header className="space-y-2 border-b border-rule px-5 py-4 md:px-7">
        <Label as="p">What the desk announced on-chain</Label>
        <h3 id="gate-signals" className="text-[1.15rem] font-medium text-paper">
          Gate signals
        </h3>
        <p className="max-w-[80ch] text-xs leading-relaxed text-paper-dim">
          Each regime or gate change the desk announces on-chain as a <code className="font-mono text-paper">signal(Meta)</code> LaneAction. The preimage is
          published so anyone can recompute <code className="font-mono text-paper">keccak256(preimage) = reasonHash</code>.
        </p>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-5 text-sm text-paper-dim md:px-7">No gate signal yet.</p>
      ) : (
        <ScrollX label="Gate signals">
          <table className="ledger-table min-w-[52rem] text-xs">
            <thead>
              <tr>
                <th scope="col" className="pl-5 md:pl-7">Since</th>
                <th scope="col">Announced state</th>
                <th scope="col">Status</th>
                <th scope="col">reasonHash / preimage</th>
                <th scope="col" className="pr-5 md:pr-7">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.decisionId} className="align-top">
                  <td className="whitespace-nowrap pl-5 font-mono text-paper-dim tabular md:pl-7">{etTime(s.atMs)}</td>
                  <td>
                    <strong className="font-medium text-paper">{REGIME_LABEL[s.regime] ?? s.regime}</strong>
                    <div className="mt-0.5 font-mono text-paper-dim">
                      {s.gates.length ? s.gates.join(" + ") : "no gate"}
                      {s.initial && " · initial"}
                    </div>
                  </td>
                  <td className="text-paper-dim">
                    <Status status={s.status} />
                  </td>
                  <td>
                    <div className="font-mono text-[0.68rem] text-paper" title={s.reasonHash}>
                      {short(s.reasonHash, 10, 8)}
                    </div>
                    {s.preimage ? (
                      <details className="group mt-1.5">
                        <summary className="cursor-pointer text-paper-dim marker:text-paper-mute hover:text-paper">
                          preimage {s.preimageVerified ? "· hash verified ✓" : "· hash mismatch ✕"}
                        </summary>
                        <pre className="mt-2 max-w-[28rem] whitespace-pre-wrap break-all border border-rule bg-vault p-3 font-mono text-[0.65rem] leading-relaxed text-paper-dim">
                          {s.preimage}
                        </pre>
                      </details>
                    ) : (
                      <div className="mt-1 text-paper-mute">{s.preimageWithheld ? "preimage withheld (names a non-public address)" : "no preimage"}</div>
                    )}
                  </td>
                  <td className="pr-5 md:pr-7">
                    {s.txHash ? (
                      <a className={`${LINK} whitespace-nowrap font-mono`} href={txLink(s.txHash)} target="_blank" rel="noreferrer">
                        {short(s.txHash)}
                      </a>
                    ) : (
                      <span className="text-paper-mute">–</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollX>
      )}
    </section>
  );
}
