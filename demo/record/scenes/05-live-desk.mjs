// Live desk: Saturday, weekend dark window, Chainlink frozen, pools and Hyperliquid still trading.
export default {
  urls: (cfg) => [`${cfg.webUrl}/live`],
  async run(s) {
    const { page, cfg } = s;
    await s.goto(`${cfg.webUrl}/live`, { waitFor: "text=Market regime" });
    await s.wait(1200); // first poll of the live feed
    await s.start();
    const regime = page.locator(".card", { hasText: "Market regime" }).first();
    await s.highlight(regime, { pad: 4 });
    await s.moveTo(regime, { ms: 1100, dx: -200 });
    await s.until(0.3);
    await s.clearHighlights();
    const nvda = page.locator(".card", { hasText: "NVDA/USDG" }).first();
    const age = nvda.locator("text=Oracle age").first();
    await s.moveTo(age, { ms: 900, dy: 12 });
    await s.highlight(age.locator("xpath=.."), { pad: 6 });
    await s.until(0.58);
    await s.clearHighlights();
    const note = nvda.locator("text=US market closed").first();
    await s.highlight(note, { pad: 5 });
    await s.moveTo(note, { ms: 800 });
    await s.until(0.8);
    await s.clearHighlights();
    await s.highlight(page.locator(".card", { hasText: "gap to fair value" }).first().locator("text=gap to fair value").locator("xpath=.."), { pad: 5 });
  },
};
