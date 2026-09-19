// Live desk: Saturday, weekend dark window, Chainlink frozen, pools and Hyperliquid still trading.
// Selectors are the page's stable data-demo hooks, not styling classes.
export default {
  urls: (cfg) => [`${cfg.webUrl}/live`],
  async run(s) {
    const { page, cfg } = s;
    await s.goto(`${cfg.webUrl}/live`, { waitFor: '[data-demo="live-regime"]' });
    await s.wait(1200); // first poll of the live feed
    const regime = page.locator('[data-demo="live-regime"]');
    await s.scrollTo(regime, { ms: 400, offset: 72 }); // clear of the sticky site nav
    await s.start();
    await s.highlight(regime, { pad: 4 });
    await s.moveTo(regime, { ms: 1100, dx: -200 });
    await s.until(0.3);
    await s.clearHighlights();
    const nvda = page.locator('[data-demo="live-pool"][data-pool="NVDA/USDG"]');
    const age = nvda.locator('[data-demo="live-oracle-age"]');
    await s.moveTo(age, { ms: 900, dy: 12 });
    await s.highlight(age, { pad: 6 });
    await s.until(0.58);
    await s.clearHighlights();
    // The weekend reason ("US market closed: …"); outside the dark window, the pool's reasons as they stand.
    const closed = nvda.locator('[data-demo="live-reasons"] li', { hasText: "US market closed" }).first();
    const note = (await closed.count()) > 0 ? closed : nvda.locator('[data-demo="live-reasons"]');
    await s.highlight(note, { pad: 5 });
    await s.moveTo(note, { ms: 800 });
    await s.until(0.8);
    await s.clearHighlights();
    await s.highlight(nvda.locator('[data-demo="live-gap"]'), { pad: 5 });
  },
};
