#!/usr/bin/env node
// Rasterises the generated SVGs into the PNG/ICO files the web needs, with a headless Chromium (Playwright).
// Run after generate.mjs:
//
//   PLAYWRIGHT=/path/to/node_modules/playwright node scripts/brand/rasterize.mjs
//
// Playwright is a dev-time tool only (default: the repo's demo/node_modules/playwright); nothing ships with it.
// Outputs: app/apple-icon.png (180), app/favicon.ico (16/32/48), public/brand/png/*.png, and copies to ../brand/png.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..", "..");
const REPO = join(WEB, "..");
const PW = process.env.PLAYWRIGHT ?? join(REPO, "demo", "node_modules", "playwright");
const { chromium } = await import(pathToFileURL(join(PW, "index.mjs")).href);

const svg = (name) => readFileSync(join(WEB, "public", "brand", name), "utf8");
const browser = await chromium.launch();

async function render(markup, size, { background = "transparent", pad = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const inner = markup.replace(/<svg /, `<svg style="position:absolute;left:${pad}px;top:${pad}px;width:${size - 2 * pad}px;height:${size - 2 * pad}px" `);
  await page.setContent(`<html><body style="margin:0;background:${background}">${inner}</body></html>`);
  const png = await page.screenshot({ omitBackground: background === "transparent", clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}

const out = {};
out["app-icon-512.png"] = await render(svg("app-icon.svg"), 512);
out["apple-icon-180.png"] = await render(svg("app-icon.svg"), 180);
out["seal-paper-1024.png"] = await render(svg("seal-paper.svg"), 1024);
out["seal-vault-1024.png"] = await render(svg("seal-vault.svg"), 1024);
out["favicon-16.png"] = await render(svg("favicon.svg"), 16);
out["favicon-32.png"] = await render(svg("favicon.svg"), 32);
out["favicon-48.png"] = await render(svg("favicon.svg"), 48);
await browser.close();

for (const dir of [join(WEB, "public", "brand", "png"), join(REPO, "brand", "png")]) {
  mkdirSync(dir, { recursive: true });
  for (const [name, buf] of Object.entries(out)) writeFileSync(join(dir, name), buf);
}
writeFileSync(join(WEB, "app", "apple-icon.png"), out["apple-icon-180.png"]);

// favicon.ico: an ICO directory wrapping the three PNGs (PNG-in-ICO, supported everywhere that matters).
const pngs = [16, 32, 48].map((s) => ({ s, buf: out[`favicon-${s}.png`] }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const entries = pngs.map(({ s, buf }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0);
  e.writeUInt8(s === 256 ? 0 : s, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += buf.length;
  return e;
});
writeFileSync(join(WEB, "app", "favicon.ico"), Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]));
console.log(Object.keys(out).map((n) => `  png/${n}`).join("\n") + "\n  app/apple-icon.png\n  app/favicon.ico");
