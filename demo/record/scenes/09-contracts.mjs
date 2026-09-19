// Contracts on Robinhood Chain Blockscout: the factory's verified source, then the user's lane (a clone that the user's
// Vault created through the factory). Needs {{FACTORY_ADDRESS}}, {{LANE_ADDRESS}}.
// Blockscout renders grey skeletons for 10–30 s in headless Chromium, and "main" / headings are visible long before the
// data. So both pages are warmed in a hidden tab, start() waits for real content, and nothing is highlighted unless
// it is visible and inside <main> (the sidebar has its own "Tokens" link).
// The lane's owner and the createLane sender are read over RPC at recording time; the tag shows them only if they match.
import { laneRoles, short, txFrom } from "../lib/chain.mjs";

const addr = (cfg, a, tab = "") => `${cfg.rhExplorer}/address/${a}${tab ? `?tab=${tab}` : ""}`;
const FACTORY_READY = "main >> text=Contract name";
const LANE_READY = 'main >> text="Creator"';

export default {
  requires: ["FACTORY_ADDRESS", "LANE_ADDRESS"],
  urls: (cfg) => [cfg.placeholders.FACTORY_ADDRESS && addr(cfg, cfg.placeholders.FACTORY_ADDRESS, "contract"), cfg.placeholders.LANE_ADDRESS && addr(cfg, cfg.placeholders.LANE_ADDRESS)].filter(Boolean),
  async run(s) {
    const { page, cfg } = s;
    const factory = addr(cfg, s.ph("FACTORY_ADDRESS"), "contract");
    const lane = addr(cfg, s.ph("LANE_ADDRESS"));
    await s.warm(factory, FACTORY_READY);
    await s.warm(lane, LANE_READY);
    const roles = await laneRoles(cfg, s.ph("LANE_ADDRESS")).catch((e) => (s.log(`laneRoles: ${e.message}`), null));

    await s.goto(factory, { waitFor: FACTORY_READY, settle: 900, idle: false, timeout: 90000 });
    const main = page.locator("main");
    const banner = await s.visible(main.getByText(/Contract source code verified/i), { timeout: 20000 });
    if (!banner) throw new Error("the factory page shows no 'Contract source code verified' banner; do not claim Blockscout verification (see demo/README.md)");
    const name = await s.visible(main.getByText("DeskLaneFactory", { exact: true }), { timeout: 5000 });
    await s.start();
    await s.highlight(banner.locator("xpath=.."), { pad: 4 });
    await s.moveTo(banner, { ms: 900 });
    await s.until(0.22);
    await s.clearHighlights();
    if (name) {
      await s.highlightUnion([main.getByText("Contract name", { exact: true }).filter({ visible: true }).first(), name], { pad: 6 });
      await s.moveTo(name, { ms: 700 });
    }
    await s.until(0.42);

    await s.goto(lane, { waitFor: LANE_READY, settle: 300, idle: false, timeout: 90000 });
    const creatorLabel = await s.visible(main.getByText("Creator", { exact: true }), { timeout: 15000 });
    const createTx = await s.visible(main.locator('a[href*="/tx/"]'), { timeout: 15000 });
    const creatorAddr = await s.visible(main.locator(`a[href*="${s.ph("FACTORY_ADDRESS")}" i]`), { timeout: 5000 });
    let tag = null;
    if (createTx && roles) {
      const hash = (await createTx.getAttribute("href"))?.match(/0x[0-9a-fA-F]{64}/)?.[0];
      const tx = hash && (await txFrom(cfg, hash).catch(() => null));
      if (tx && tx.from.toLowerCase() === roles.owner.toLowerCase()) {
        tag = [`Lane A: created by the user's Vault ${short(roles.owner)}`, `createLane tx ${short(hash)} was sent by the lane's owner() (both read over RPC)`];
      } else s.log("createLane sender does not match the lane owner; no tag");
    }
    if (tag) {
      // under the lane's detail rows (their number changes, e.g. once the lane holds tokens), clear of the header
      const lastRow = await s.visible(main.getByText("Last balance update", { exact: true }), { timeout: 3000 });
      const bb = lastRow && (await lastRow.boundingBox());
      const top = bb ? Math.round((bb.y + bb.height) / (cfg.zoom ?? 1.5)) + 26 : 500;
      await s.tag(...tag, { top, left: 277 });
    }
    if (creatorLabel) {
      await s.highlightUnion([creatorLabel, creatorAddr, createTx].filter(Boolean), { pad: 6 });
      await s.moveTo(creatorLabel, { ms: 900, dx: 120 });
    }
  },
};
