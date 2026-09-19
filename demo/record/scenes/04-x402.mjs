// The same tearsheet as a paid x402 endpoint (live 402 terms), then the first x402 call that settled on Base.
// That call is NOT a tearsheet call: it is a $0.005 safe-to-lp self-test from our own Bankr wallet (README.md
// "Live now"), so the explorer half is relabelled on screen (cfg.paidCallLabel) and the narration says so.
import { x402View } from "../lib/cards.mjs";

const x402Url = (cfg) => `${cfg.x402Base}/tearsheet?wallet=${cfg.tearsheetWallet}&chain=robinhood`;
const txUrl = (cfg) => `${cfg.baseExplorer}/tx/${cfg.paidCallTx}`;

export default {
  urls: (cfg) => [x402Url(cfg), txUrl(cfg)],
  async run(s) {
    const { page, cfg } = s;
    await s.warm(txUrl(cfg), "text=Tokens transferred");
    const res = await page.goto(x402Url(cfg), { waitUntil: "load", timeout: 60000 });
    const status = res.status();
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`x402 endpoint did not return JSON (HTTP ${status}): ${text.slice(0, 120)}`);
    }
    if (status !== 402) s.log(`warning: expected HTTP 402, got ${status}`);
    // Same URL, same live response; re-rendered so it is legible at 1080p.
    await s.setContent(x402View({ url: x402Url(cfg), status, body }));
    await s.start();
    await s.moveTo("table tr:first-child td:last-child", { ms: 1200 });
    await s.highlight("table tr:first-child", { pad: 4 });
    await s.until(0.26);
    await s.clearHighlights();
    await s.highlight("table tr:last-child", { pad: 4 });
    await s.until(0.4);
    const tNav = Date.now();
    const lbl = cfg.paidCallLabel ?? {};
    await s.goto(txUrl(cfg), {
      waitFor: "text=Transaction details",
      settle: 300,
      idle: false,
      bar: lbl.title ? { title: lbl.title, url: txUrl(cfg).replace(/^https?:\/\//, "") } : undefined,
      tag: lbl.tag ? { text: lbl.tag, sub: lbl.sub } : undefined,
    });
    await page.locator("text=Success").first().waitFor({ state: "visible", timeout: 45000 });
    await page.locator("text=Tokens transferred").first().waitFor({ state: "visible", timeout: 45000 });
    s.log(`explorer ready in ${((Date.now() - tNav) / 1000).toFixed(1)}s`);
    await s.stable(page.locator("text=Tokens transferred").first(), { ms: 800, timeout: 8000 });
    await s.highlight('text=Success', { pad: 6 });
    await s.moveTo("text=Success", { ms: 700 });
    await s.until(0.66);
    await s.clearHighlights();
    const tokens = page.locator("text=Tokens transferred").first();
    await s.scrollTo(tokens, { ms: 1100, offset: 330 });
    const usdc = page.locator("a, span, div").filter({ hasText: /^USDC$/ });
    await s.stable(tokens, { ms: 500, timeout: 4000 });
    await s.highlightUnion([tokens, usdc.first(), usdc.nth(1)], { pad: 8 });
    await s.moveTo(usdc.first(), { ms: 700, dx: -120 });
  },
};
