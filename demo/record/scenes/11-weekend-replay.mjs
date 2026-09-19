// REPLAY: the Sep 12–13 weekend from the live API (NVDA/USDG, weekend dark window, vs HL 1h);
// then, once {{CONSOLE_URL}} exists, the desk console's replay timeline (control lane vs DeltaDesk).
import { weekendCard } from "../lib/cards.mjs";

const FOCUS = "2026-09-12";
const table = (cfg) => `${cfg.apiUrl}/study/table/hl_ref/by_weekend`;

export async function weekendRows(cfg) {
  const r = await fetch(table(cfg), { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${table(cfg)} → HTTP ${r.status}`);
  const rows = (await r.json()).rows
    .filter((x) => x.pool === "NVDA/USDG" && x.fee_1h > 0)
    .map((x) => ({ weekend: x.weekend, fee: x.fee_1h, picked: x.picked_hl_1h, edge: x.edge_hl_1h }))
    .sort((a, b) => a.weekend.localeCompare(b.weekend));
  // drop a weekend still in progress (it would read as a finished one)
  const cutoff = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
  const done = rows.filter((x) => x.weekend <= cutoff);
  if (!done.some((x) => x.weekend === FOCUS)) throw new Error(`weekend ${FOCUS} missing from ${table(cfg)}`);
  return done;
}

export default {
  urls: (cfg) => [table(cfg), cfg.placeholders.CONSOLE_URL].filter(Boolean),
  overlay: (cfg) => ({
    title: "Weekend gap, Sep 12–13 2026 · replay of recorded data",
    replayNote: "Sep 12–13 2026 · recorded data, not live",
    url: table(cfg).replace(/^https?:\/\//, ""),
  }),
  async run(s) {
    const { page, cfg } = s;
    const rows = await weekendRows(cfg);
    const line = s.ph("REPLAY_SEP12_LINE");
    await s.setContent(weekendCard({ rows, focus: FOCUS, source: `GET ${table(cfg)}`, line }));
    await s.start();
    await s.moveTo("h1", { ms: 1200, dx: 200 });
    await s.until(0.25);
    await s.moveTo("svg rect[stroke-dasharray]", { ms: 1000 });
    const consoleUrl = s.ph("CONSOLE_URL");
    if (consoleUrl) {
      await s.until(0.5);
      await s.goto(consoleUrl, { waitFor: "main", settle: 1000 });
      const el = page.locator("text=/Sep 12|2026-09-12|replay/i").first();
      if (await el.count()) {
        await s.scrollTo(el, { ms: 1000, offset: 180 });
        await s.highlight(el.locator("xpath=.."), { pad: 6 });
      }
    } else {
      await s.until(0.6);
      await s.moveTo(".card", { ms: 900 });
    }
  },
};
