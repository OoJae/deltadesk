#!/usr/bin/env node
// Deterministic formatter for lp-truth responses: `node scripts/report.mjs <service> < response.json`.
// Prints the short report the agent relays nearly verbatim. Zero dependencies.
import { readFileSync } from "node:fs";

const service = process.argv[2];
const r = JSON.parse(readFileSync(0, "utf8"));
const bp = (x) => `${x >= 0 ? "+" : ""}${Number(x).toFixed(1)} bp`;
const usd = (x) => `${x < 0 ? "−" : "+"}$${Math.abs(Number(x)).toFixed(2)}`;
const out = [];

if (r.error) {
  out.push(`Couldn't get ${service}: ${r.error}. You were not charged.`);
} else if (service === "safe-to-lp") {
  const top = r.reasons?.find((x) => x.level === r.verdict) ?? r.reasons?.[0];
  out.push(`${r.verdict} — ${r.pool}: ${top?.reason ?? "no issues"}.`);
  out.push(`Pool ${r.pool_mid.toFixed(4)} vs fair ${r.fair_value.toFixed(4)} (${bp(r.gap_bps)}), regime ${r.regime}.`);
  if (r.verdict !== "ALLOW" && r.next_regime_change) {
    const at = new Date(r.next_regime_change.at * 1000).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit" });
    out.push(`Conditions change ${at} ET (${r.next_regime_change.regime}).`);
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
  const t = r.totals ?? r.total ?? {};
  const k = t.per_1k_day ?? t;
  out.push(`Net ${usd(k.net ?? t.net_usd ?? 0)}${t.per_1k_day ? " per $1k/day" : ""}.`);
  out.push(`Fees ${usd(k.fees ?? t.fees_usd ?? 0)}, picked off ${usd(-(k.lvr ?? t.lvr_usd ?? 0))}, IL vs holding ${usd(k.il ?? t.il_usd ?? 0)}, gas ${usd(-(k.gas ?? t.gas_usd ?? 0))}.`);
  if (t.residual_bps != null) out.push(`Reconciled to on-chain fees within ${Math.abs(t.residual_bps).toFixed(1)} bp.`);
} else if (service === "lp-league") {
  (r.rows ?? []).slice(0, 5).forEach((row, i) => out.push(`${i + 1}. ${row.owner?.slice(0, 10)}…  ${usd(row.net_per_1k_day ?? 0)} per $1k/day, edge ${(row.edge ?? 0).toFixed(2)}`));
} else {
  out.push(`unknown service ${service}`);
  process.exitCode = 2;
}
console.log(out.join("\n"));
