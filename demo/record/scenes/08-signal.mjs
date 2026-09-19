// The agent's weekend decision on-chain: the delegated signal() tx on Robinhood Chain Blockscout, then its LaneAction
// log decoded from the receipt. Needs {{SIGNAL_TX}}.
// Blockscout shows this log as raw topics (the lane implementation's source is on Sourcify, not on Blockscout), so the
// second half renders the same receipt, fetched live over RPC and decoded with the lane ABI (record/lib/chain.mjs),
// with the reasonHash preimage from docs/m2-desk.md §3b re-hashed at recording time.
import { signalCard } from "../lib/cards.mjs";
import { laneActionOf, laneRoles, preimageCheck, short } from "../lib/chain.mjs";

const tx = (cfg, h) => `${cfg.rhExplorer}/tx/${h}`;
const READY = "main >> text=Interacted with contract";

export default {
  requires: ["SIGNAL_TX"],
  urls: (cfg) => [cfg.placeholders.SIGNAL_TX && tx(cfg, cfg.placeholders.SIGNAL_TX)].filter(Boolean),
  async run(s) {
    const { page, cfg } = s;
    const h = s.ph("SIGNAL_TX");
    const ev = await laneActionOf(cfg, h);
    const roles = await laneRoles(cfg, ev.lane);
    const check = preimageCheck(ev.reasonHash);
    if (ev.status !== 1) throw new Error(`tx ${h} did not succeed`);
    if (ev.from.toLowerCase() !== roles.operator.toLowerCase()) s.log(`warning: tx sender ${ev.from} is not the lane's operator ${roles.operator}`);

    await s.warm(tx(cfg, h), READY);
    await s.goto(tx(cfg, h), { waitFor: READY, settle: 600, idle: false, timeout: 90000 });
    const main = page.locator("main");
    const ok = await s.visible(main.getByText("Success", { exact: true }), { timeout: 20000 });
    const fromLabel = await s.visible(main.getByText("From", { exact: true }), { timeout: 10000 });
    // the rows' full addresses, not the truncated header links (0x86…3678 called … on 0x7f…d662) above them
    const full = (a) => main.locator(`a[href*="${a}" i]`).filter({ hasText: new RegExp(a.slice(2), "i") });
    const fromAddr = await s.visible(full(ev.from), { timeout: 10000 });
    const toLabel = await s.visible(main.getByText("Interacted with contract", { exact: true }), { timeout: 5000 });
    const toAddr = await s.visible(full(ev.lane), { timeout: 5000 });
    await s.start();
    if (ok) {
      await s.highlight(ok, { pad: 5 });
      await s.moveTo(ok, { ms: 800 });
    }
    await s.until(0.16);
    await s.clearHighlights();
    if (fromLabel && fromAddr) {
      await s.scrollTo(fromLabel, { ms: 900, offset: 300 });
      await s.bar({ title: `Signal tx: from the lane's delegated Operator ${short(roles.operator)} to lane A ${short(ev.lane)}` });
      await s.highlightUnion([fromLabel, fromAddr, toLabel, toAddr].filter(Boolean), { pad: 6 });
      await s.moveTo(fromAddr, { ms: 800 });
    }
    await s.until(0.4);

    await s.bar({ title: `LaneAction log of tx ${short(h)}, decoded from the receipt (Blockscout shows it as raw topics)`, url: `eth_getTransactionReceipt · ${cfg.rhRpc.replace(/^https?:\/\//, "")}` });
    await s.setContent(signalCard({ ev, roles, check, hash: h }));
    await s.wait(500);
    await s.highlight(".row-action", { pad: 2 });
    await s.moveTo(".row-action", { ms: 900, dx: -120 });
    await s.until(0.6);
    await s.clearHighlights();
    await s.highlight(".row-gates", { pad: 2 });
    await s.moveTo(".row-gates", { ms: 700, dx: -120 });
    await s.until(0.78);
    await s.clearHighlights();
    if (check) {
      await s.highlight(".row-check", { pad: 4 });
      await s.moveTo(".row-check", { ms: 800, dx: -160 });
    }
  },
};
