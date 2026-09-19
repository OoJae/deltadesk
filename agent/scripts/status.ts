// `pnpm status [--lane 0x…] [-n 10]`: the desk as the local DB sees it. Read-only: desks, the daemon
// lock, each lane's last tick, recent decisions and executions, pending approvals and any foreign
// LaneAction. It never touches the chain or a signer, and prints no secrets.

import { pathToFileURL } from "node:url";
import { getConfig } from "../src/config.js";
import { openDb } from "../src/state/db.js";
import type { Address, DeskDb } from "../src/types.js";

const fmtTime = (ms: number | null): string =>
  ms === null ? "-" : new Date(ms).toISOString().replace("T", " ").slice(0, 19);

function fmtAge(ms: number | null, nowMs: number): string {
  if (ms === null) return "never";
  const s = Math.round((nowMs - ms) / 1000);
  return s < 120
    ? `${s}s ago`
    : s < 7200
      ? `${Math.round(s / 60)}m ago`
      : `${Math.round(s / 3600)}h ago`;
}

const pad = (s: string, w: number): string =>
  s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);

export function renderStatus(
  db: DeskDb,
  opts: { lane?: Address; n: number; nowMs: number },
): string[] {
  const out: string[] = [];
  const { nowMs } = opts;
  const lock = db.lockStatus();
  out.push(
    lock === null
      ? "daemon lock: free (no desk-agent running on this DB)"
      : `daemon lock: ${lock.ownerId} (pid ${lock.pid}), heartbeat ${fmtAge(lock.heartbeatMs, nowMs)}`,
  );
  out.push(`pending executions: ${db.pendingExecutionsCount()}`);

  const desks = db
    .listDesks()
    .filter((d) => opts.lane === undefined || d.laneAddress === opts.lane.toLowerCase());
  if (desks.length === 0) out.push("\nno desks registered");
  for (const d of desks) {
    out.push("");
    out.push(`desk ${d.laneAddress} (lane id ${d.laneId})`);
    out.push(
      `  mode ${d.mode} · status ${d.status}${d.statusDetail ? ` (${d.statusDetail})` : ""} · signer ${d.signerKind}`,
    );
    out.push(`  owner ${d.owner} · operator ${d.operator}`);
    const t = db.lastTick(d.laneAddress);
    if (t === null) out.push("  last tick: never");
    else {
      const gates = JSON.parse(t.activeGatesJson) as string[];
      out.push(
        `  last tick ${fmtAge(t.atMs, nowMs)}: ${t.regime}${t.reopenKind ? `/${t.reopenKind}` : ""} · risk ${t.riskMode} · gates ${gates.length === 0 ? "none" : gates.join(",")}`,
      );
      out.push(
        `  pool tick ${t.poolTick ?? "?"} mid ${t.poolMid?.toFixed(4) ?? "?"} · F ${t.fairValue?.toFixed(4) ?? "?"} (gap ${t.gapBps?.toFixed(1) ?? "?"} bp) · ref ${t.refTick ?? "?"} ± ${t.bandTicks ?? "?"} · fence code ${t.fenceCode ?? "?"}`,
      );
    }
    const pending = db.pendingApprovals(d.laneAddress, nowMs);
    for (const a of pending)
      out.push(`  AWAITING APPROVAL ${a.decisionId} until ${fmtTime(a.expiresAtMs)}: ${a.summary}`);
    const foreign = db.laneActionsByMatch("foreign", d.laneAddress);
    for (const f of foreign)
      out.push(`  FOREIGN ${f.actionName} by ${f.caller} in ${f.txHash} (block ${f.blockNumber})`);
    const turnover = db.turnoverCentsSince(d.laneAddress, nowMs - 86_400_000);
    out.push(`  signed turnover (24 h): $${(turnover / 100).toFixed(2)}`);
  }

  const lane = opts.lane?.toLowerCase() as Address | undefined;
  const decisions = db.recentDecisions(opts.n, lane);
  out.push("");
  out.push(decisions.length === 0 ? "no decisions yet" : "recent decisions:");
  for (const d of decisions) {
    let kinds = "?";
    try {
      const plan = JSON.parse(d.finalPlanJson ?? d.planJson) as {
        actions?: Array<{ kind: string }>;
      };
      kinds = (plan.actions ?? []).map((a) => a.kind).join("+") || "?";
    } catch {
      /* evidence column unreadable: show the row anyway */
    }
    out.push(
      `  ${fmtTime(d.createdAtMs)} ${d.decisionId} ${pad(d.status, 18)} ${pad(kinds, 10)} guard ${d.guardDecision ?? "-"}${d.statusDetail ? ` · ${d.statusDetail.slice(0, 90)}` : ""}`,
    );
  }

  const execs = db.recentExecutions(opts.n, lane);
  out.push("");
  out.push(execs.length === 0 ? "no executions yet" : "recent executions:");
  for (const e of execs) {
    out.push(
      `  ${fmtTime(e.createdAtMs)} #${e.executionId} ${pad(e.action, 8)} ${pad(e.status, 10)} $${(e.notionalCents / 100).toFixed(2)}${e.txHash ? ` tx ${e.txHash}` : ""}${e.errorCode ? ` ${e.errorCode}` : ""}`,
    );
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const cfg = await getConfig();
  const laneIdx = argv.indexOf("--lane");
  const nIdx = argv.indexOf("-n");
  const lane = laneIdx >= 0 ? (argv[laneIdx + 1] as Address | undefined) : undefined;
  const n = nIdx >= 0 ? Number(argv[nIdx + 1] ?? 10) : 10;
  const db = openDb(cfg.paths.dbPath);
  try {
    console.log(
      `DeltaDesk desk-agent · chain ${cfg.chainId} · DRY_RUN ${cfg.safety.dryRun ? "ON" : "off"} · DESK_ARM ${cfg.safety.armed ? "1" : "0"} · db ${cfg.paths.dbPath}`,
    );
    for (const line of renderStatus(db, {
      ...(lane === undefined ? {} : { lane }),
      n: Number.isInteger(n) && n > 0 ? n : 10,
      nowMs: Date.now(),
    }))
      console.log(line);
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
