#!/usr/bin/env node
// Deterministic formatter for lp-truth responses: `node scripts/report.mjs <service> < response.json`.
// Prints the short report the agent relays nearly verbatim. Zero dependencies.
import { readFileSync } from "node:fs";

const service = process.argv[2];
const r = JSON.parse(readFileSync(0, "utf8"));
const bp = (x) => `${x >= 0 ? "+" : ""}${Number(x).toFixed(1)} bp`;
const usd = (x) => `${x < 0 ? "−" : "+"}$${Math.abs(Number(x)).toFixed(2)}`;
const pct = (x) => (x == null ? "–" : `${(100 * x).toFixed(0)}%`);
const out = [];

if (r.error) {
  out.push(`Couldn't get ${service}: ${r.error}. You were not charged.`);
} else if (service === "safe-to-lp") {
  const top = r.reasons?.find((x) => x.level === r.verdict) ?? r.reasons?.[0];
  out.push(`${r.verdict} — ${r.pool}: ${top?.reason ?? "no issues"}.`);
  out.push(`Pool ${r.pool_mid.toFixed(4)} vs fair ${r.fair_value.toFixed(4)} (${bp(r.gap_bps)}), regime ${r.regime}.`);
  if (r.verdict !== "ALLOW" && r.next_regime_change) {
    const at = new Date(r.next_regime_change.at * 1000).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit" });
    out.push(`Conditions change ${at} ET (${r.next_regime_change.reopen_window ? "reopen window starts" : r.next_regime_change.regime}).`);
  }
} else if (service === "fair-value") {
  out.push(`${r.pool}: fair ${r.fair_value.toFixed(4)} (Hyperliquid ${r.hl_price} × ${r.basis_k.toFixed(5)}), pool ${r.pool_mid.toFixed(4)} (${bp(r.gap_bps)}).`);
  if (r.chainlink) out.push(`Chainlink ${r.chainlink.price.toFixed(2)}, last updated ${(r.chainlink.age_s / 3600).toFixed(1)} h ago${r.chainlink.age_s > 3600 ? " (frozen while the market is closed)" : ""}.`);
} else if (service === "pool-toxicity") {
  const worst = (r.worst_hours_of_week ?? []).slice(0, 3).map((h) => {
    const d = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Math.floor(h.how / 24)];
    return `${d} ${String(h.how % 24).padStart(2, "0")}:00 ET (edge ${h.edge_1h.toFixed(2)})`;
  });
  out.push(`${r.pool} worst hours for LPs: ${worst.join(", ")}.`);
  if (r.current_hour?.edge_1h != null) out.push(`This hour historically: edge ${r.current_hour.edge_1h.toFixed(2)} (fees ÷ value picked off).`);
} else if (service === "tearsheet") {
  const s = r.summary;
  if (!s) {
    out.push(`No LP positions found for ${r.owner} on ${r.chain ?? "robinhood"}.`);
  } else {
    const a = s.aerodrome;
    out.push(`Result vs simply holding the tokens: ${usd(s.vs_hodl_usd)} (${usd(s.per_1k_per_day.vs_hodl)} per $1k per day), ${s.n_positions} position${s.n_positions === 1 ? "" : "s"}${s.n_open ? ` (${s.n_open} open)` : ""}.`);
    out.push(`Fees ${usd(s.fees_usd)}${a ? `, AERO ${usd(a.aero_usd)}` : ""}, impermanent loss vs holding ${usd(s.il_usd)} (informed flow picked off ${usd(s.lvr_hl_1h_usd).slice(1)} within 1h), gas ${usd(-s.gas_usd)}. Net including stock price moves ${usd(s.net_usd)}.`);
    const e = a ? a.edge_hl_1h_incl_aero : s.edge_hl_1h;
    if (e != null) out.push(`LP edge ${e.toFixed(2)}${a ? " incl. AERO" : ""} (fees ÷ value picked off; above 1 = earned more than informed flow took).`);
    if (a) out.push(`Staked ${pct(a.staked_share)} of the time: ${usd(a.fees_to_voters_usd).slice(1)} of fees went to veAERO voters${a.aero_forfeited > 0 ? `, ${a.aero_forfeited.toFixed(1)} AERO forfeited by withdrawing within 5 minutes of staking` : ""}.`);
    if (s.residual?.reconciled_positions) out.push(`${s.residual.reconciled_positions} closed positions reconcile to on-chain collected fees within ${s.residual.max_abs_residual_bp.toFixed(4)} bp.`);
  }
} else if (service === "lp-league") {
  (r.rows ?? []).slice(0, 5).forEach((row) =>
    out.push(`${row.rank}. ${String(row.manager).slice(0, 10)}…  ${usd(row.vs_hodl_per_1k_day)} per $1k·day vs holding, edge ${row.edge_hl != null ? row.edge_hl.toFixed(2) : "–"}, ${row.positions} positions (${row.pools})`));
} else {
  out.push(`unknown service ${service}`);
  process.exitCode = 2;
}
console.log(out.join("\n"));
