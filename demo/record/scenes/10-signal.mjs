// The agent's weekend decisions on-chain: the two delegated signal() txs on Robinhood Chain Blockscout (the initial gate
// signal, then the transition when the fair value returned), then the first one's LaneAction log decoded from its
// receipt. Needs {{SIGNAL_TX}}; {{SIGNAL_TX2}} (the second signal, docs/m2-desk.md §3b) is shown when it is filled.
// Blockscout shows these logs as raw topics (the lane implementation's source is on Sourcify, not on Blockscout), so the
// last part renders the first receipt, fetched live over RPC and decoded with the lane ABI (record/lib/chain.mjs), with
// the reasonHash preimage from docs/m2-desk.md §3b re-hashed at recording time.
import { signalCard } from "../lib/cards.mjs";
import { laneActionOf, laneRoles, preimageCheck, short } from "../lib/chain.mjs";

const tx = (cfg, h) => `${cfg.rhExplorer}/tx/${h}`;
const txLabel = (cfg, h) => `${cfg.rhExplorer.replace(/^https?:\/\//, "")}/tx/${h.slice(0, 10)}…${h.slice(-4)}`;
const READY = "main >> text=Interacted with contract";

// Blockscout tx page: wait for the rows, then return the visible Success badge and the From / To rows.
async function txRows(s, ev) {
  const main = s.page.locator("main");
  const ok = await s.visible(main.getByText("Success", { exact: true }), { timeout: 20000 });
  const fromLabel = await s.visible(main.getByText("From", { exact: true }), { timeout: 10000 });
  // the rows' full addresses, not the truncated header links (0x86…3678 called … on 0x7f…d662) above them
  const full = (a) => main.locator(`a[href*="${a}" i]`).filter({ hasText: new RegExp(a.slice(2), "i") });
  const fromAddr = await s.visible(full(ev.from), { timeout: 10000 });
  const toLabel = await s.visible(main.getByText("Interacted with contract", { exact: true }), { timeout: 5000 });
  const toAddr = await s.visible(full(ev.lane), { timeout: 5000 });
  return { ok, fromLabel, fromAddr, toLabel, toAddr };
}

export default {
  requires: ["SIGNAL_TX"],
  urls: (cfg) => [cfg.placeholders.SIGNAL_TX, cfg.placeholders.SIGNAL_TX2].filter(Boolean).map((h) => tx(cfg, h)),
  async run(s) {
    const { page, cfg } = s;
    const h = s.ph("SIGNAL_TX");
    const h2 = s.ph("SIGNAL_TX2");
    const ev = await laneActionOf(cfg, h);
    const ev2 = h2 ? await laneActionOf(cfg, h2) : null;
    const roles = await laneRoles(cfg, ev.lane);
    const check = preimageCheck(ev.reasonHash);
    for (const [hh, e] of [[h, ev], [h2, ev2]]) {
      if (!e) continue;
      if (e.status !== 1) throw new Error(`tx ${hh} did not succeed`);
      if (e.from.toLowerCase() !== roles.operator.toLowerCase()) s.log(`warning: tx ${hh} sender ${e.from} is not the lane's operator ${roles.operator}`);
    }
    const gates = (e) => e.gateNames.join(" + ") || "no gate";

    // Both explorer pages are loaded before the camera rolls: the first visit to a Blockscout tx page takes ~10 s
    // (its own data fetches), a revisit ~2 s and a history move ~1 s. So the scene walks tx1 → tx2 off camera, steps
    // back to tx1, and then moves forward again on camera, where the switch takes about a second instead of ten.
    const bar1 = { title: `Signal 1${h2 ? " of 2" : ""} · ${gates(ev)} · by the delegated Operator ${short(roles.operator)} · recorded ${s.stamp}`, url: txLabel(cfg, h) };
    const bar2 = ev2 && { title: `Signal 2 of 2 · ${gates(ev)} → ${gates(ev2)} · same Operator ${short(roles.operator)} · recorded ${s.stamp}`, url: txLabel(cfg, h2) };
    await s.warm(tx(cfg, h), READY);
    if (h2) await s.warm(tx(cfg, h2), READY);
    await s.goto(tx(cfg, h), { waitFor: READY, settle: 200, idle: false, timeout: 90000, bar: bar1 });
    await txRows(s, ev);
    if (ev2) {
      await s.goto(tx(cfg, h2), { waitFor: READY, settle: 200, idle: false, timeout: 90000, bar: bar2 });
      await txRows(s, ev2);
      const t = Date.now();
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 60000 });
      await page.locator(READY).first().waitFor({ state: "visible", timeout: 60000 });
      await s.bar(bar1);
      s.log(`stepped back to signal 1 in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      await s.wait(400);
    }
    let r = await txRows(s, ev);
    await s.start();
    if (r.ok) {
      await s.highlight(r.ok, { pad: 5 });
      await s.moveTo(r.ok, { ms: 800 });
    }
    await s.until(0.14);
    await s.clearHighlights();
    if (r.fromLabel && r.fromAddr) {
      await s.scrollTo(r.fromLabel, { ms: 900, offset: 300 });
      await s.highlightUnion([r.fromLabel, r.fromAddr, r.toLabel, r.toAddr].filter(Boolean), { pad: 6 });
      await s.moveTo(r.fromAddr, { ms: 800 });
    }
    await s.until(ev2 ? 0.42 : 0.6);

    if (ev2) {
      await s.clearHighlights();
      const t = Date.now();
      await page.goForward({ waitUntil: "domcontentloaded", timeout: 60000 });
      await page.locator(READY).first().waitFor({ state: "visible", timeout: 60000 });
      await s.bar(bar2);
      s.log(`forward to signal 2 in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      r = await txRows(s, ev2);
      if (r.fromLabel && r.fromAddr) {
        await s.scrollTo(r.fromLabel, { ms: 500, offset: 300 });
        await s.highlightUnion([r.ok, r.fromLabel, r.fromAddr, r.toLabel, r.toAddr].filter(Boolean), { pad: 6 });
        await s.moveTo(r.fromAddr, { ms: 800 });
      }
      await s.until(0.72);
    }

    await s.bar({ title: `LaneAction log of signal 1, tx ${short(h)}, decoded from the receipt (Blockscout shows it as raw topics)`, url: `eth_getTransactionReceipt · ${cfg.rhRpc.replace(/^https?:\/\//, "")}` });
    await s.setContent(signalCard({ ev, roles, check, hash: h }));
    await s.wait(400);
    await s.highlight(".row-action", { pad: 2 });
    await s.highlight(".row-gates", { pad: 2 });
    await s.moveTo(".row-gates", { ms: 800, dx: -120 });
    await s.until(0.87);
    await s.clearHighlights();
    if (check) {
      await s.highlight(".row-check", { pad: 4 });
      await s.moveTo(".row-check", { ms: 800, dx: -160 });
    }
  },
};
