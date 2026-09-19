// The user's desk, live: lane A's page on the web app (/desk/<lane>), read straight from the lane contract every 5 s, so
// it needs no sign-in to view: the certificate (roles, what the lane holds, the fence's risk state), then the owner
// controls (signed only by the Vault; without the Vault signed in they stay locked, and the page says so).
// Then the public desk console (/console): the agent's public feed with the lane in copilot, the agent's health, and the
// decision log with today's two executed gate signals.
// The lane page's own agent panel (mode, delegation) needs the Vault's sign-in, so it is not shown here.
// Needs {{LANE_ADDRESS}}.

const lanePage = (cfg, lane) => `${cfg.webUrl}/desk/${lane}`;
const consolePage = (cfg) => `${cfg.webUrl}/console`;

export default {
  requires: ["LANE_ADDRESS"],
  urls: (cfg) => [cfg.placeholders.LANE_ADDRESS && lanePage(cfg, cfg.placeholders.LANE_ADDRESS), consolePage(cfg)].filter(Boolean),
  async run(s) {
    const { page, cfg } = s;
    const lane = s.ph("LANE_ADDRESS");
    await s.warm(consolePage(cfg), "#decision-log");

    // The certificate ("Lane A") replaces its loading frame ("Lane") once the first chain read lands.
    await s.goto(lanePage(cfg, lane), { waitFor: 'main section[aria-label="Lane A"]', settle: 600 });
    await page.locator('main section[aria-label="Lane A"] dd', { hasText: /^\$\d/ }).first().waitFor({ timeout: 30000 });
    const sec = page.locator('main section[aria-label="Lane A"]');
    await s.scrollTo(sec, { ms: 10, offset: 84 }); // clear of the sticky site nav
    await s.wait(400);
    await s.start();

    // Address, the fence's risk pill and the three roles.
    const roles = sec.locator("dl").first();
    const head = sec.locator("p", { hasText: lane.slice(0, 10) }).first();
    const pill = sec.getByText(/Risk-adding/).first();
    await s.highlightUnion([head, pill, roles], { pad: 8 });
    await s.moveTo(head, { ms: 1000, dx: 120 });
    await s.until(0.16);
    await s.clearHighlights();
    // What the lane holds (Chainlink-valued).
    const figures = sec.locator("dl").nth(1);
    await s.highlight(figures, { pad: 6 });
    await s.moveTo(figures.locator("dd").first(), { ms: 800 });
    await s.until(0.28);
    await s.clearHighlights();
    // Owner controls: signed by the Vault in the browser, independent of the agent (and locked without it).
    const owner = page.locator('aside[aria-label="Owner controls"]');
    await s.scrollTo(owner, { ms: 1000, offset: 70 });
    await s.highlight(owner.locator(":scope > div > *").first(), { pad: 4 });
    await s.moveTo(owner.getByText("Sign in with this lane").first(), { ms: 800, dx: 60 });
    await s.until(0.4);
    await s.clearHighlights();

    // The public console: the desk agent's own feed (no wallet, no sign-in).
    await s.goto(consolePage(cfg), {
      waitFor: "#decision-log", settle: 200, idle: false,
      bar: { title: `Desk console · the desk agent's public feed · recorded ${s.stamp}`, url: consolePage(cfg).replace(/^https?:\/\//, "") },
    });
    const live = page.locator('section[aria-labelledby="console-live"]');
    const health = live.getByText(/Agent (healthy|degraded)/).first();
    await health.waitFor({ timeout: 20000 });
    await s.scrollTo(health, { ms: 10, offset: 150 });
    s.log(`console ready at ${s.elapsed().toFixed(1)}s`);
    const healthRow = health.locator("xpath=ancestor::div[contains(@class,'grid')][1]");
    const laneCard = live.locator("article", { hasText: "Lane #" }).first();
    const opLine = laneCard.getByText(/operator/).first();
    await s.highlight(healthRow, { pad: 6 });
    await s.moveTo(live.getByText("Mode", { exact: true }).first(), { ms: 800, dx: 120 });
    await s.until(0.58);
    await s.clearHighlights();
    await s.highlightUnion([laneCard.locator("h3").first(), opLine], { pad: 8 });
    await s.moveTo(opLine, { ms: 700, dx: 60 });
    await s.until(0.74);
    await s.clearHighlights();
    // Decision log: both of today's gate signals, executed, with their txs.
    const log = page.locator('section[aria-labelledby="decision-log"]');
    await s.scrollTo(log, { ms: 900, offset: 110 });
    const rows = log.locator("tbody tr");
    const n = Math.min(2, await rows.count());
    if (n) {
      await s.highlightUnion([...Array(n).keys()].map((i) => rows.nth(i)), { pad: 4 });
      await s.moveTo(rows.nth(0).locator("a").first(), { ms: 800 });
    }
  },
};
