"use client";

import { useEffect, useState } from "react";
import { getAddress, type Address } from "viem";
import { REGIME_LABEL, bps } from "@/lib/format";
import { deskApi } from "@/lib/desk/api";
import { ago, short } from "@/lib/desk/format";
import type { EthereumWallet } from "@/lib/desk/tx";
import type { DeskStatus, PendingApproval } from "@/lib/desk/types";
import { useAction, usePoll } from "./hooks";
import ModePicker from "./ModePicker";
import { Btn, Card, Status, TxLine, type Tone } from "./ui";

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

  if (!data) return <Card title="Agent">Loading agent status…</Card>;
  if (!data.ok) {
    const hint =
      data.status === 404 ? "This lane is not registered with desk-agent yet." : data.status === 401 || data.status === 403 ? "Sign in with this lane's Vault to see the agent's view." : data.error;
    return (
      <Card title="Agent">
        <Status tone={data.status === 503 || data.status === 502 || data.status === 0 ? "warning" : "neutral"}>{hint}</Status>
        <p className="text-xs text-muted">The on-chain controls work without the agent.</p>
      </Card>
    );
  }
  const s = data.data;
  const t = s.lastTick;
  const tickAt = t?.atMs ?? null;
  const d = s.lastDecision;
  const approvals = s.pendingApprovals ?? [];

  return (
    <Card title="Agent" aside={<span className="text-xs text-muted">desk-agent · refreshes every 5 s</span>}>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Mode</dt>
          <dd className="font-semibold capitalize">{s.mode ?? "–"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Desk status</dt>
          <dd className="font-semibold">{s.status ?? "–"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Delegation</dt>
          <dd>{s.delegation?.status ? <Status tone={DELEGATION_TONE[s.delegation.status] ?? "neutral"}>{s.delegation.status}</Status> : "–"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Last tick</dt>
          <dd className="tabular">{tickAt ? `${ago((now - tickAt) / 1000)} ago` : "–"}</dd>
        </div>
      </dl>

      {t && (
        <div className="space-y-3 rounded-lg bg-surface-2 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span>
              <span className="text-muted">Regime · </span>
              <strong>{t.regime ? (REGIME_LABEL[t.regime] ?? t.regime) : "–"}</strong>
              {t.reopenKind && <span className="ml-2 text-ink-2">({t.reopenKind.replace("_", " ")})</span>}
            </span>
            <span className="tabular text-ink-2">
              F {t.F?.toFixed(2) ?? "–"} · pool {t.poolMid?.toFixed(2) ?? "–"} · gap <strong className="text-ink">{bps(t.gapBps ?? null)}</strong>
            </span>
          </div>
          {!!t.gates?.length && (
            <ul className="flex flex-wrap gap-2" aria-label="Gates">
              {t.gates.map((g) => (
                <li key={g} className="rounded-full border border-[var(--ring)] bg-surface-1 px-2.5 py-1 text-xs">
                  <Status tone="warning">
                    {g} <span className="text-muted">on</span>
                  </Status>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {d && (
        <div className="text-sm">
          <div className="text-xs text-muted">Last decision</div>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <strong className="capitalize">{d.status?.replace(/_/g, " ") ?? "decision"}</strong>
            {d.summary && <span className="text-ink-2">{d.summary}</span>}
            {d.createdAtMs != null && <span className="tabular text-xs text-muted">{ago((now - d.createdAtMs) / 1000)} ago</span>}
            {d.decisionId && <span className="font-mono text-xs text-muted">{short(d.decisionId)}</span>}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm font-semibold">Approvals</div>
        {approvals.length === 0 ? (
          <p className="text-sm text-ink-2">{s.mode === "copilot" ? "Nothing waiting. Risk-adding actions and gate signals appear here; silence means no." : "Approvals appear here in copilot mode."}</p>
        ) : (
          <ul className="space-y-2">
            {approvals.map((a) => (
              <Approval key={a.decisionId} lane={lane} a={a} now={now} jwt={jwt} canAct={isOwner} onDone={refresh} />
            ))}
          </ul>
        )}
      </div>

      {isOwner && (
        <div className="space-y-2">
          <div className="text-sm font-semibold">Mode</div>
          <ModePicker lane={lane} current={s.mode ?? null} vault={vault} jwt={jwt} onChanged={refresh} />
        </div>
      )}
    </Card>
  );
}

function Approval({ lane, a, now, jwt, canAct, onDone }: { lane: Address; a: PendingApproval; now: number; jwt: () => string | null; canAct: boolean; onDone: () => void }) {
  const action = useAction();
  const left = a.expiresAtMs != null ? Math.max(0, (a.expiresAtMs - now) / 1000) : null;
  const send = (approve: boolean) =>
    action.run(approve ? "Approving…" : "Declining…", async () => {
      const r = await deskApi(`/${getAddress(lane)}/approve`, { method: "POST", body: { decisionId: a.decisionId, approve }, jwt: jwt() });
      if (!r.ok) throw new Error(r.error);
      onDone();
    });
  return (
    <li className="space-y-2 rounded-lg border border-[var(--ring)] p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/* The summary starts with the action kind (e.g. "signal: gates CLOSED…"); a signal moves no funds. */}
        <strong>{a.summary?.startsWith("signal") ? "Gate signal (on-chain note, moves no funds)" : "Risk-adding action"}</strong>
        <span className="tabular text-xs text-ink-2">{left != null ? (left > 0 ? `expires in ${Math.ceil(left)} s` : "expired") : ""}</span>
      </div>
      {a.summary && <p className="text-ink-2">{a.summary}</p>}
      <p className="font-mono text-xs text-muted">{short(a.decisionId)}</p>
      <div className="flex gap-2">
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
