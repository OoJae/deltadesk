// "Start a desk" on the web app: Vault (owner, the only place money can go) vs the delegated Operator (fenced by caps).
// Needs {{DESK_URL}} (the /desk page). Shows the explainer and the wizard's steps; signs nothing.
export default {
  requires: ["DESK_URL"],
  urls: (cfg) => [cfg.placeholders.DESK_URL].filter(Boolean),
  async run(s) {
    const { page } = s;
    const has = async (loc) => (await loc.count()) > 0;
    await s.goto(s.ph("DESK_URL"), { waitFor: "main h1", settle: 900 });
    await s.start();
    const h1 = page.locator("main h1").first();
    await s.moveTo(h1, { ms: 1000, dx: 160 });
    const intro = page.locator("main h1 + p, main header p").filter({ hasText: /Vault/ }).first();
    if (await has(intro)) await s.highlight(intro, { pad: 6 });
    await s.until(0.4);
    await s.clearHighlights();
    const opStep = page.locator("main").getByText("Create the Operator wallet").first();
    const opRow = page.locator("main").getByText("Operator (agent)").first();
    if (await has(opStep)) {
      await s.highlight(opStep, { pad: 10 });
      await s.moveTo(opStep, { ms: 800 });
    }
    if (await has(opRow)) await s.highlight(opRow.locator("xpath=.."), { pad: 5 });
    await s.until(0.62);
    await s.clearHighlights();
    const delegate = page.locator("main").getByText("Delegate the Operator").first();
    if (await has(delegate)) {
      await s.scrollTo(delegate, { ms: 1000, offset: 330 });
      await s.highlight(delegate, { pad: 10 });
      await s.moveTo(delegate, { ms: 700 });
    }
    await s.until(0.8);
    await s.clearHighlights();
    const fence = page.locator("main").getByText(/only place value can leave/).first();
    if (await has(fence)) {
      await s.highlight(fence, { pad: 6 });
      await s.moveTo(fence, { ms: 700 });
    }
  },
};
