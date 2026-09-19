"use client";

import { useEffect, useState } from "react";
import { REGIME_LABEL } from "@/lib/format";
import { REGIME_BY_CODE, addressLink, ago, etTime, gatesOfMask, short, txLink } from "@/lib/console/format";
import type { LaneActionsResult } from "@/lib/console/types";

export default function LaneActionsPanel() {
  const [res, setRes] = useState<LaneActionsResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch("/console/api/lane-actions", { cache: "no-store" });
        const j = (await r.json()) as LaneActionsResult;
        if (!stop) { setRes(j); setFailed(null); }
      } catch (e) {
        if (!stop) setFailed(e instanceof Error ? e.message : "request failed");
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  if (res === null) return <div className="card p-5 text-sm text-ink-2">{failed ? `Could not load the on-chain feed (${failed}).` : "Reading LaneAction events from Robinhood Chain…"}</div>;
  if (!res.ok) return <div className="card p-5 text-sm text-ink-2">On-chain feed unavailable: {res.error}. The desk state above does not depend on it.</div>;
  if (res.lanes.length === 0) return <div className="card p-5 text-sm text-ink-2">No lane is registered yet, so there is nothing to read on-chain.</div>;

  return (
    <section className="card overflow-x-auto p-2">
      <p className="px-2 pt-2 text-xs text-muted tabular">
        Blocks {res.fromBlock.toLocaleString()}–{res.toBlock.toLocaleString()}{res.spanS != null && ` (${ago(res.spanS * 1000)})`}
        {res.sinceDeploy ? " · everything since the lane factory's deployment" : " · older blocks still being read"} · {res.lanes.length} lane{res.lanes.length > 1 ? "s" : ""} · public RPC, read-only
        {res.partial && <span> · {res.partial}</span>}
      </p>
      {res.actions.length === 0 ? <p className="p-2 text-sm text-ink-2">{res.sinceDeploy ? "No LaneAction since the lane factory's deployment." : "No LaneAction in the blocks read so far."}</p> : (
        <table className="w-full min-w-[640px] text-xs">
          <thead className="text-muted"><tr><th className="p-2 text-left">Time</th><th className="p-2 text-left">Lane</th><th className="p-2 text-left">Action</th><th className="p-2 text-left">Regime · gates</th><th className="p-2 text-left">By</th><th className="p-2 text-left">Tx</th></tr></thead>
          <tbody>
            {res.actions.map((a) => {
              const regime = REGIME_BY_CODE[a.regime] ?? `code ${a.regime}`;
              const gates = gatesOfMask(a.gatesMask);
              return (
                <tr key={`${a.txHash}-${a.decisionId}`} className="border-t border-grid align-top">
                  <td className="whitespace-nowrap p-2 tabular text-ink-2">{a.timestamp ? etTime(a.timestamp * 1000) : `block ${a.blockNumber.toLocaleString()}`}</td>
                  <td className="p-2"><a className="font-mono hover:underline" href={addressLink(a.lane)} target="_blank" rel="noreferrer">#{a.laneId} {short(a.lane)}</a></td>
                  <td className="p-2 font-medium">{a.actionName}<div className="font-mono text-[10px] text-muted" title={a.decisionId}>{short(a.decisionId, 10, 6)}</div></td>
                  <td className="p-2 text-ink-2">{REGIME_LABEL[regime] ?? regime}<div>{gates.length ? gates.join(" + ") : "no gate"}</div></td>
                  <td className="p-2 text-ink-2">{a.callerRole}</td>
                  <td className="p-2"><a className="font-mono text-[var(--accent)] hover:underline" href={txLink(a.txHash)} target="_blank" rel="noreferrer">{short(a.txHash)}</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
