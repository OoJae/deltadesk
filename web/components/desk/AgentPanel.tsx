"use client";

import { useEffect, useState } from "react";
import { getAddress, type Address } from "viem";
import { Label } from "@/components/brand/Label";
import { REGIME_LABEL, bps } from "@/lib/format";
import { deskApi } from "@/lib/desk/api";
import { ago, short } from "@/lib/desk/format";
import type { EthereumWallet } from "@/lib/desk/tx";
import type { DeskStatus, PendingApproval } from "@/lib/desk/types";
import { useAction, usePoll } from "./hooks";
import ModePicker from "./ModePicker";
import { useDeskStamp } from "./stamp";
import { Aside, Btn, Card, Status, TxLine, type Tone } from "./ui";

type Props = { lane: Address; vault: EthereumWallet | null; jwt: () => string | null; isOwner: boolean };

const DELEGATION_TONE: Record<string, Tone> = { active: "good", delegated: "good", pending: "warning", revoked: "critical", none: "neutral" };

export default function AgentPanel({ lane, vault, jwt, isOwner }: Props) {
  const key = `${lane}:${vault?.address ?? "-"}`;
  const { data, refresh } = usePoll(async () => deskApi<DeskStatus>(`/${getAddress(lane)}/status`, { jwt: jwt() }), 5000, key);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!data)
    return (
      <Card title="Agent" label="desk-agent">
        <p className="label text-paper-mute">Loading agent status…</p>
      </Card>
    );
  if (!data.ok) {
    const hint =
      data.status === 404 ? "This lane is not registered with desk-agent yet." : data.status === 401 || data.status === 403 ? "Sign in with this lane's Vault to see the agent's view." : data.error;
    return (
      <Card title="Agent" label="desk-agent">
        <Status tone={data.status === 503 || data.status === 502 || data.status === 0 ? "warning" : "neutral"}>{hint}</Status>
        <p className="text-[0.82rem] text-paper-mute">The on-chain controls work without the agent.</p>
      </Card>
    );
  }
  const s = data.data;
  const t = s.lastTick;
  const tickAt = t?.atMs ?? null;
  const d = s.lastDecision;
  const approvals = s.pendingApprovals ?? [];

  return (
    <Card title="Agent" label="desk-agent" aside={<Aside>refreshes every 5 s</Aside>} bodyClassName="space-y-6">
      <dl className="grid grid-cols-2 border-y border-rule sm:grid-cols-4">
        {[
          { k: "Mode", v: <span className="capitalize">{s.mode ?? "–"}</span> },
          { k: "Desk status", v: s.status ?? "–" },
          { k: "Delegation", v: s.delegation?.status ? <Status tone={DELEGATION_TONE[s.delegation.status] ?? "neutral"}>{s.delegation.status}</Status> : "–" },
          { k: "Last tick", v: <span className="font-mono tabular">{tickAt ? `${ago((now - tickAt) / 1000)} ago` : "–"}</span> },
        ].map((x, i) => (
          <div key={x.k} className={`min-w-0 space-y-1.5 py-3 ${i % 2 ? "border-l border-rule pl-3 sm:pl-4" : ""} ${i === 2 ? "border-t border-rule sm:border-t-0 sm:border-l sm:pl-4" : ""} ${i === 3 ? "border-t border-rule sm:border-t-0" : ""}`}>
            <Label as="dt">{x.k}</Label>
            <dd className="text-[0.95rem] font-medium text-paper">{x.v}</dd>
          </div>
        ))}
      </dl>

      {t && (
        <div className="space-y-3 border border-rule bg-vault px-4 py-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 text-[0.9rem]">
            <span>
              <span className="text-paper-mute">Regime · </span>
              <strong className="font-medium text-paper">{t.regime ? (REGIME_LABEL[t.regime] ?? t.regime) : "–"}</strong>
              {t.reopenKind && <span className="ml-2 text-paper-dim">({t.reopenKind.replace("_", " ")})</span>}
            </span>
            <span className="font-mono text-[0.85rem] tabular text-paper-dim">
              F {t.F?.toFixed(2) ?? "–"} · pool {t.poolMid?.toFixed(2) ?? "–"} · gap <strong className="font-medium text-serial">{bps(t.gapBps ?? null)}</strong>
            </span>
          </div>
          {!!t.gates?.length && (
            <ul className="flex flex-wrap gap-2" aria-label="Gates">
              {t.gates.map((g) => (
                <li key={g} className="border border-rule-strong bg-vault-2 px-2.5 py-1 text-[0.8rem]">
                  <Status tone="warning">
                    {g} <span className="text-paper-mute">on</span>
                  </Status>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {d && (
        <div className="space-y-1.5 text-[0.9rem]">
          <Label as="p">Last decision</Label>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="font-medium capitalize text-paper">{d.status?.replace(/_/g, " ") ?? "decision"}</strong>
            {d.summary && <span className="text-paper-dim">{d.summary}</span>}
            {d.createdAtMs != null && <span className="font-mono text-[0.78rem] tabular text-paper-mute">{ago((now - d.createdAtMs) / 1000)} ago</span>}
            {d.decisionId && <span className="font-mono text-[0.78rem] text-paper-mute">{short(d.decisionId)}</span>}
          </div>
        </div>
      )}

      <div className="space-y-2.5">
        <Label as="p">Approvals</Label>
        {approvals.length === 0 ? (
          <p className="text-[0.9rem] text-paper-dim">{s.mode === "copilot" ? "Nothing waiting. Risk-adding actions and gate signals appear here; silence means no." : "Approvals appear here in copilot mode."}</p>
        ) : (
          <ul className="space-y-3">
            {approvals.map((a) => (
              <Approval key={a.decisionId} lane={lane} a={a} now={now} jwt={jwt} canAct={isOwner} onDone={refresh} />
            ))}
          </ul>
        )}
      </div>

      {isOwner && (
        <div className="space-y-2.5">
          <Label as="p">Mode</Label>
          <ModePicker lane={lane} current={s.mode ?? null} vault={vault} jwt={jwt} onChanged={refresh} />
        </div>
      )}
    </Card>
  );
}

function Approval({ lane, a, now, jwt, canAct, onDone }: { lane: Address; a: PendingApproval; now: number; jwt: () => string | null; canAct: boolean; onDone: () => void }) {
  const action = useAction();
  const { stamp } = useDeskStamp();
  const left = a.expiresAtMs != null ? Math.max(0, (a.expiresAtMs - now) / 1000) : null;
  const send = (approve: boolean) =>
    action.run(approve ? "Approving…" : "Declining…", async () => {
      const r = await deskApi(`/${getAddress(lane)}/approve`, { method: "POST", body: { decisionId: a.decisionId, approve }, jwt: jwt() });
      if (!r.ok) throw new Error(r.error);
      onDone();
      stamp({
        kind: approve ? "approved" : "recorded",
        title: approve ? "Approval sent to desk-agent" : "Decline sent to desk-agent",
        detail: a.summary ?? undefined,
        serial: a.decisionId,
      });
    });
  return (
    <li className="space-y-3 border border-rule-strong bg-vault px-4 py-3.5 text-[0.9rem]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/* The summary starts with the action kind (e.g. "signal: gates CLOSED…"); a signal moves no funds. */}
        <strong className="font-medium text-paper">{a.summary?.startsWith("signal") ? "Gate signal (on-chain note, moves no funds)" : "Risk-adding action"}</strong>
        <span className="font-mono text-[0.78rem] tabular text-paper-dim">{left != null ? (left > 0 ? `expires in ${Math.ceil(left)} s` : "expired") : ""}</span>
      </div>
      {a.summary && <p className="text-paper-dim">{a.summary}</p>}
      <p className="font-mono text-[0.78rem] text-paper-mute">{short(a.decisionId)}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Btn kind="primary" disabled={!canAct || action.busy || left === 0} onClick={() => send(true)}>
          Approve
        </Btn>
        <Btn disabled={!canAct || action.busy || left === 0} onClick={() => send(false)}>
          Decline
        </Btn>
      </div>
      <TxLine state={action.state} />
    </li>
  );
}
