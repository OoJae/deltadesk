"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/brand/Label";
import { LINK, Notice, ScrollX } from "@/components/ledger/ui";
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

  if (res === null) return <Notice tone={failed ? "warning" : "neutral"}>{failed ? `Could not load the on-chain feed (${failed}).` : "Reading LaneAction events from Robinhood Chain…"}</Notice>;
  if (!res.ok) return <Notice tone="warning">On-chain feed unavailable: {res.error}. The desk state above does not depend on it.</Notice>;
  if (res.lanes.length === 0) return <Notice>No lane is registered yet, so there is nothing to read on-chain.</Notice>;

  return (
    <section className="border border-rule bg-vault-2" aria-label="LaneAction events">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-rule px-5 py-4 md:px-7">
        <Label as="p">
          {res.actions.length.toLocaleString()} LaneAction event{res.actions.length === 1 ? "" : "s"} · {res.lanes.length} lane{res.lanes.length > 1 ? "s" : ""}
        </Label>
        <p className="font-mono text-[0.7rem] leading-relaxed text-paper-mute tabular">
          Blocks {res.fromBlock.toLocaleString()}–{res.toBlock.toLocaleString()}
          {res.spanS != null && ` (${ago(res.spanS * 1000)})`}
          {res.sinceDeploy ? " · everything since the lane factory's deployment" : " · older blocks still being read"} · public RPC, read-only
          {res.partial && <span> · {res.partial}</span>}
        </p>
      </header>
      {res.actions.length === 0 ? (
        <p className="px-5 py-5 text-sm text-paper-dim md:px-7">
          {res.sinceDeploy ? "No LaneAction since the lane factory's deployment." : "No LaneAction in the blocks read so far."}
        </p>
      ) : (
        <ScrollX label="LaneAction events">
          <table className="ledger-table min-w-[52rem] text-xs">
            <thead>
              <tr>
                <th scope="col" className="pl-5 md:pl-7">Time</th>
                <th scope="col">Lane</th>
                <th scope="col">Action</th>
                <th scope="col">Regime · gates</th>
                <th scope="col">By</th>
                <th scope="col" className="pr-5 md:pr-7">Tx</th>
              </tr>
            </thead>
            <tbody>
              {res.actions.map((a) => {
                const regime = REGIME_BY_CODE[a.regime] ?? `code ${a.regime}`;
                const gates = gatesOfMask(a.gatesMask);
                return (
                  <tr key={`${a.txHash}-${a.decisionId}`} className="align-top">
                    <td className="whitespace-nowrap pl-5 font-mono text-paper-dim tabular md:pl-7">
                      {a.timestamp ? etTime(a.timestamp * 1000) : `block ${a.blockNumber.toLocaleString()}`}
                    </td>
                    <td>
                      <a className={`${LINK} whitespace-nowrap font-mono`} href={addressLink(a.lane)} target="_blank" rel="noreferrer">
                        #{a.laneId} {short(a.lane)}
                      </a>
                    </td>
                    <td>
                      <span className="font-mono text-paper">{a.actionName}</span>
                      <div className="mt-1 font-mono text-[0.65rem] text-paper-mute" title={a.decisionId}>
                        {short(a.decisionId, 10, 6)}
                      </div>
                    </td>
                    <td className="text-paper-dim">
                      {REGIME_LABEL[regime] ?? regime}
                      <div className="mt-0.5 font-mono">{gates.length ? gates.join(" + ") : "no gate"}</div>
                    </td>
                    <td className="text-paper-dim">{a.callerRole}</td>
                    <td className="pr-5 md:pr-7">
                      <a className={`${LINK} whitespace-nowrap font-mono`} href={txLink(a.txHash)} target="_blank" rel="noreferrer">
                        {short(a.txHash)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollX>
      )}
    </section>
  );
}
