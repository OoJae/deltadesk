// Renders stills with Playwright: PENDING / missing-recording cards for beats without a usable scene video, and
// transparent caption PNGs (one per cue) for the burned-in caption option.
//   out/cards/<id>.png   out/captions/<n>.png + out/captions/blank.png
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { OUT, loadConfig } from "./beats.mjs";
import { captionStrip, missingCard, pendingCard } from "../record/lib/cards.mjs";

const cfg = loadConfig();
const zoom = cfg.zoom ?? 1.5;
const tl = JSON.parse(readFileSync(join(OUT, "timeline.json"), "utf8"));
const cues = JSON.parse(readFileSync(join(OUT, "cues.json"), "utf8"));
const wantCaptions = !process.argv.includes("--no-captions");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const still = `body{zoom:${zoom}} .fade{opacity:1!important;animation:none!important;transform:none!important}`;

mkdirSync(join(OUT, "cards"), { recursive: true });
for (const b of tl.beats) {
  const video = join(OUT, "scenes", `${b.id}.webm`);
  const png = join(OUT, "cards", `${b.id}.png`);
  rmSync(png, { force: true });
  if (!b.pending && existsSync(video)) continue;
  const beat = { ...b, num: b.id.slice(0, 2), surface: "", requires: b.missing };
  const src = readFileSync(join(OUT, "beats.json"), "utf8");
  beat.surface = JSON.parse(src).find((x) => x.id === b.id)?.surface ?? "";
  await page.setContent(b.pending ? pendingCard(beat, cfg) : missingCard(beat), { waitUntil: "networkidle" });
  await page.addStyleTag({ content: still });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: png });
  console.log(`card  ${b.id} (${b.pending ? `pending: ${b.missing.join(", ")}` : "no recording"})`);
}

if (wantCaptions) {
  const dir = join(OUT, "captions");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1920, height: 210 });
  await page.setContent(`<html><body style="margin:0;background:transparent"></body></html>`);
  await page.screenshot({ path: join(dir, "blank.png"), omitBackground: true });
  for (let i = 0; i < cues.length; i++) {
    await page.setContent(captionStrip(cues[i].text), { waitUntil: "networkidle" });
    await page.addStyleTag({ content: `body{zoom:${zoom}}` });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(dir, `${String(i + 1).padStart(3, "0")}.png`), omitBackground: true });
  }
  console.log(`${cues.length} caption strips → out/captions/`);
}
await browser.close();
