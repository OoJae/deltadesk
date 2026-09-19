// LP League (live) → click the configured wallet → its tearsheet: summary, then the reconciliation line.
// Selectors are the pages' stable data-demo hooks, not styling classes.
export default {
  urls: (cfg) => [`${cfg.webUrl}/league`, `${cfg.webUrl}/tearsheet?wallet=${cfg.tearsheetWallet}&as=${cfg.tearsheetRole}`],
  async run(s) {
    const { page, cfg } = s;
    await s.goto(`${cfg.webUrl}/league`, { waitFor: '[data-demo="league-table"] tbody tr' });
    await s.start();
    const hasWallet = page.locator(`a[href*="${cfg.tearsheetWallet}"]`);
    // The wallet's card on the podium ("The top of the table"); if it is not in the top three, its row in the full table.
    const card = page.locator('[data-demo="league-top"] li').filter({ has: hasWallet }).first();
    const row = page.locator('[data-demo="league-table"] tbody tr').filter({ has: hasWallet }).first();
    const onPodium = (await card.count()) > 0;
    const target = onPodium ? card : (await row.count()) > 0 ? row : null;
    if (target) {
      await s.scrollTo(target, { ms: 1000, offset: 150 });
      await s.moveTo(onPodium ? card.locator('[data-demo="league-result"]') : row.locator("td").nth(3), { ms: 1100 });
      await s.highlight(target, { pad: 3 });
    } else {
      await s.moveTo('[data-demo="league-table"] tbody tr', { ms: 1100 });
    }
    await s.until(0.24);
    await s.clearHighlights();
    const ready = '[data-demo="ts-statement"]';
    if (target) {
      await s.click(target.locator(`a[href*="${cfg.tearsheetWallet}"]`).first(), { ms: 700 });
      await page.waitForURL(/\/tearsheet/, { timeout: 60000 });
      await page.locator(ready).first().waitFor({ timeout: 60000 });
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await s.syncCursor();
    } else {
      await s.goto(`${cfg.webUrl}/tearsheet?wallet=${cfg.tearsheetWallet}&as=${cfg.tearsheetRole}`, { waitFor: ready });
    }
    await s.scrollTo(ready, { ms: 1100, offset: 88 }); // clear of the sticky site nav
    const big = page.locator('[data-demo="ts-result"]').first();
    await s.highlight(big, { pad: 6 });
    await s.moveTo(big, { ms: 800, dx: 40 });
    await s.until(0.5);
    await s.clearHighlights();
    const rows = page.locator(`${ready} table tbody tr`);
    await s.highlight(rows.nth(0), { pad: 2 });
    await s.highlight(rows.nth(1), { pad: 2 });
    await s.moveTo(rows.nth(1), { ms: 700 });
    await s.until(0.74);
    await s.clearHighlights();
    const rec = page.locator("#ts-reconciliation");
    const line = rec.locator('[data-demo="ts-reconciled"]').first();
    await s.scrollTo(rec, { ms: 1000, offset: 200 });
    await s.highlight(line, { pad: 6 });
    await s.moveTo(line, { ms: 700 });
  },
};
