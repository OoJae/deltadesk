// REPLAY: the landing (/) at its native 1920x1080 layout. The hero (headline + the engraved relief of the NVDA/USDG
// pool's real Sep 11–14 2026 liquidity), then a slow scroll through the five pinned acts, N° 01 → N° 05, so each act's
// panel holds on screen while the relief plays that act's hours. The relief is scroll-driven (no gsap, no timers), so
// the pace here is the pace of the animation.
// The page is not zoomed (the relief fits itself to the viewport and the headline), the chrome keeps the usual 1.5.
// The REPLAY badge sits in the nav's empty middle: its usual top-right corner is where the relief's readout lives.

const url = (cfg) => `${cfg.webUrl}/`;

// Beat plan in seconds at the design length; scaled to the beat's real duration.
const DESIGN = 26;
const PLAN = {
  heroHold: 3.6, // headline rises, relief at rest
  toAct: 1.0, // eased move from one act's end to the next act's pinned panel
  first: 1.15, // hero → act 1 (a longer move)
  holds: [2.55, 2.6, 4.0, 3.2, 4.0], // per act: panel pinned, relief playing (linear scroll)
};

export default {
  urls: (cfg) => [url(cfg), `${cfg.webUrl}/relief/weekend-2026-09-11.json`],
  overlay: (cfg) => ({
    pageZoom: 1,
    cursor: false,
    title: "The weekend of Sep 11–14 2026, NVDA/USDG on Robinhood Chain · the landing's replay of recorded on-chain data",
    replayNote: "Sep 11–14 2026 · recorded data, not live",
    replayInline: true,
    replayCss: "top:3px;left:300px;right:auto",
    url: url(cfg).replace(/^https?:\/\//, ""),
  }),
  async run(s) {
    const { page, cfg } = s;
    await s.goto(url(cfg), { waitFor: "#hero-title", settle: 300 });
    // The relief mounts after three.js and the replay data load; without WebGL the static poster stays, which is not
    // this beat, so fail (the runner retries once).
    await page.locator('.relief-canvas[data-ready="true"]').waitFor({ state: "attached", timeout: 45000 });
    await page.evaluate(() => document.fonts?.ready);
    await s.wait(1200); // the canvas fades in (1.2 s) and the hero fit settles after the fonts

    // Geometry of the five acts, in page px: when each act's panel pins (sticky) and when it starts to leave.
    const acts = await page.evaluate(() =>
      [...document.querySelectorAll(".book-act")].map((li) => {
        const panel = li.querySelector(".book-panel");
        const art = panel.querySelector("article");
        const r = li.getBoundingClientRect();
        const top = r.top + scrollY;
        const pin = parseFloat(getComputedStyle(panel).top) || 0;
        const padB = parseFloat(getComputedStyle(li).paddingBottom) || 0;
        const h = art.getBoundingClientRect().height;
        return { top, pinFrom: Math.round(top - pin), pinTo: Math.round(top + r.height - padB - pin - h) };
      }),
    );
    if (acts.length !== 5) throw new Error(`expected 5 acts on the landing, found ${acts.length}`);
    s.log(`acts pinned at ${acts.map((a) => `${a.pinFrom}–${a.pinTo}`).join(", ")}`);

    // Replay the hero's own entrance (the headline rising line by line) from its first frame.
    const hero = ["dd-hero-rise", "dd-hero-fade"];
    await page.evaluate((names) => {
      window.scrollTo(0, 0);
      for (const a of document.getAnimations()) if (names.includes(a.animationName)) { a.pause(); a.currentTime = 0; }
    }, hero);
    await s.wait(150);
    await s.start();
    await page.evaluate((names) => {
      for (const a of document.getAnimations()) if (names.includes(a.animationName)) a.play();
    }, hero);

    const k = s.duration / DESIGN;
    let t = PLAN.heroHold;
    await s.until((t * k) / s.duration);
    for (let i = 0; i < acts.length; i++) {
      const move = i === 0 ? PLAN.first : PLAN.toAct;
      await s.scrollTo(acts[i].pinFrom, { ms: move * k * 1000, ease: "inout" });
      t += move;
      await s.until((t * k) / s.duration);
      // Hold: the panel stays pinned while the relief plays the act's hours at an even pace. Stop short of the
      // panel's release so it never starts to slide out during the hold.
      const hold = PLAN.holds[i];
      const to = acts[i].pinTo - 24;
      await s.scrollTo(to, { ms: hold * k * 1000 * 0.97, ease: "linear" });
      t += hold;
      await s.until((t * k) / s.duration);
    }
    // N° 05 stays on screen to the end of the beat.
  },
};
