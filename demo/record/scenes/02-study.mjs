// Truth Study, live: headline → hour-of-week heatmap (hover Mon 09:00) → Flow X-ray.
export default {
  urls: (cfg) => [`${cfg.webUrl}/`],
  async run(s) {
    const { page, cfg } = s;
    await s.goto(`${cfg.webUrl}/`, { waitFor: "main header .card" });
    await s.start();
    await s.moveTo("main header .card .text-5xl", { ms: 1400, dx: 60 });
    await s.until(0.12);
    await s.highlight("main header .card");
    await s.until(0.42);
    await s.clearHighlights();
    await s.scrollTo('figcaption:has-text("LP net by hour of the week"), :text("LP net by hour of the week")', { ms: 1700, offset: 70 });
    const mon9 = page.locator('button[aria-label^="Mon 9:00 ET"]');
    await s.moveTo(mon9, { ms: 1000 });
    await s.wait(250);
    await s.highlight(page.locator('[aria-live="polite"]'), { pad: 4 });
    await s.until(0.64);
    await s.clearHighlights();
    await s.scrollTo('p:has-text("Flow X-ray")', { ms: 1600, offset: 70 });
    const h2 = page.locator('section:has(p:has-text("Flow X-ray")) h2').first();
    await s.highlight(h2);
    await s.moveTo(h2, { ms: 900, dx: 180, dy: 10 });
    await s.until(0.86);
    await s.clearHighlights();
    await s.scrollTo('section:has(p:has-text("Flow X-ray")) h2 + p', { ms: 900, offset: 150 });
  },
};
