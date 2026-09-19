// LP League (live) → click the configured wallet → its tearsheet: summary, then the reconciliation line.
export default {
  urls: (cfg) => [`${cfg.webUrl}/league`, `${cfg.webUrl}/tearsheet?wallet=${cfg.tearsheetWallet}&as=${cfg.tearsheetRole}`],
  async run(s) {
    const { page, cfg } = s;
    await s.goto(`${cfg.webUrl}/league`, { waitFor: "table tbody tr" });
    await s.start();
    const link = page.locator(`a[href*="${cfg.tearsheetWallet}"]`).first();
    const row = page.locator("table tbody tr", { has: link }).first();
    const hasLink = (await link.count()) > 0;
    if (hasLink) await row.scrollIntoViewIfNeeded();
    await s.moveTo(hasLink ? row.locator("td").nth(3) : "table tbody tr", { ms: 1100 });
    if (hasLink) await s.highlight(row, { pad: 3 });
    await s.until(0.24);
    await s.clearHighlights();
    const ready = 'text=Result vs simply holding the tokens';
    if (hasLink) {
      await s.click(link, { ms: 700 });
      await page.waitForURL(/\/tearsheet/, { timeout: 60000 });
      await page.locator(ready).first().waitFor({ timeout: 60000 });
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await s.syncCursor();
    } else {
      await s.goto(`${cfg.webUrl}/tearsheet?wallet=${cfg.tearsheetWallet}&as=${cfg.tearsheetRole}`, { waitFor: ready });
    }
    await s.scrollTo("main section.card", { ms: 1100, offset: 64 });
    const big = page.locator("main section.card .text-5xl").first();
    await s.highlight(big, { pad: 6 });
    await s.moveTo(big, { ms: 800, dx: 40 });
    await s.until(0.5);
    await s.clearHighlights();
    const rows = page.locator("main section.card table tbody tr");
    await s.highlight(rows.nth(0), { pad: 2 });
    await s.highlight(rows.nth(1), { pad: 2 });
    await s.moveTo(rows.nth(1), { ms: 700 });
    await s.until(0.74);
    await s.clearHighlights();
    const rec = page.locator('.card:has(h2:text-is("Reconciliation"))').first();
    await s.scrollTo(rec, { ms: 1000, offset: 200 });
    await s.highlight(rec.locator("p").first(), { pad: 6 });
    await s.moveTo(rec.locator("p").first(), { ms: 700 });
  },
};
