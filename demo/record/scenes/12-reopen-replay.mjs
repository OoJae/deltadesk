// REPLAY: the reopen after Labor Day (Tue Sep 8 2026), NVDA/USDG, pool-level backtest from the live API:
// R0 (always in) vs R3 (reopen guard).
import { reopenCard } from "../lib/cards.mjs";

const DAY = "2026-09-08";
const table = (cfg) => `${cfg.apiUrl}/study/table/backtest/daily`;

export async function reopenRows(cfg) {
  const r = await fetch(table(cfg), { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${table(cfg)} → HTTP ${r.status}`);
  const rows = (await r.json()).rows.filter((x) => x.pool === "NVDA/USDG" && String(x.date_et).slice(0, 10) === DAY && x.period === "FULL");
  const get = (rule) => {
    const x = rows.find((y) => y.rule === rule);
    if (!x) throw new Error(`rule ${rule} for ${DAY} missing from ${table(cfg)}`);
    return x;
  };
  return { r0: get("R0"), r3: get("R3") };
}

export default {
  urls: (cfg) => [table(cfg)],
  overlay: (cfg) => ({
    title: "REOPEN-GUARD on the Labor Day reopen, Tue Sep 8 2026 · replay of recorded data",
    replayNote: "Tue Sep 8 2026 · recorded data, not live",
    url: table(cfg).replace(/^https?:\/\//, ""),
  }),
  async run(s) {
    const { cfg } = s;
    const { r0, r3 } = await reopenRows(cfg);
    await s.setContent(reopenCard({ date: "Tue 2026-09-08", r0, r3, source: `GET ${table(cfg)} (NVDA/USDG, rules R0 and R3)` }));
    await s.start();
    await s.moveTo(".card:nth-of-type(1) .neg, .card .neg", { ms: 1200 });
    await s.until(0.35);
    await s.moveTo(".card .pos", { ms: 1000 });
    await s.until(0.7);
    await s.moveTo(".src", { ms: 900, dx: -200 });
  },
};
