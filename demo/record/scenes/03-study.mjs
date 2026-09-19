// Truth Study, live: page title → the headline account → hour-of-week heatmap (hover Mon 09:00) → Flow X-ray.
// The Study lives at /study (/ is the landing). Selectors are the pages' stable data-demo hooks, not styling classes.
export default {
  urls: (cfg) => [`${cfg.webUrl}/study`],
  async run(s) {
    const { page, cfg } = s;
    await s.goto(`${cfg.webUrl}/study`, { waitFor: '[data-demo="study-headline"]' });
    await s.start();
    await s.moveTo("main h1", { ms: 1100, dx: 80 });
    await s.until(0.08);
    const headline = page.locator('[data-demo="study-headline"]');
    await s.scrollTo(headline, { ms: 1300, offset: 88 }); // clear of the sticky site nav
    await s.moveTo('[data-demo="study-picked"]', { ms: 1000, dx: 60 });
    await s.highlight(headline);
    await s.until(0.42);
    await s.clearHighlights();
    await s.scrollTo('figcaption:has-text("LP net by hour of the week")', { ms: 1700, offset: 70 });
    const mon9 = page.locator('button[aria-label^="Mon 9:00 ET"]');
    await s.moveTo(mon9, { ms: 1000 });
    await s.wait(250);
    // The heatmap's own readout: the site-wide stamp announcer is an earlier [aria-live] on every page.
    await s.highlight('[data-demo="heatmap-readout"]', { pad: 4 });
    await s.until(0.64);
    await s.clearHighlights();
    await s.scrollTo('section[aria-labelledby="study-flow"]', { ms: 1600, offset: 40 });
    const h2 = page.locator("#study-flow");
    await s.highlight(h2);
    await s.moveTo(h2, { ms: 900, dx: 180, dy: 10 });
    await s.until(0.86);
    await s.clearHighlights();
    const top3 = page.locator('[data-demo="flow-top3"]');
    if ((await top3.count()) > 0) {
      await s.scrollTo(top3, { ms: 900, offset: 150 });
      await s.highlight(top3, { pad: 6 });
    } else {
      await s.scrollTo('[data-demo="flow-xray"]', { ms: 900, offset: 150 });
    }
  },
};
