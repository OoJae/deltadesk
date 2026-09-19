// The Engraved Book, static: the NVDA/USDG pool's real liquidity through the Sep 11–14 2026 weekend, drawn as
// engraved ridgelines (one per 30-minute frame, Fri 16:00 ET at the back, Mon 09:45 ET at the front), with the pool
// price (paper) and fair value (serial) traced over it. Same JSON, same height rule as the WebGL relief.
// Used as the poster before the canvas is ready, for no-WebGL, and under reduced motion.
//
//   node scripts/relief-svg.mjs   (from web/)  →  public/relief/weekend-2026-09-11.svg
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../public/relief/weekend-2026-09-11.json");
const OUT = join(here, "../public/relief/weekend-2026-09-11.svg");
const d = JSON.parse(readFileSync(SRC, "utf8"));

const PAPER = "#EDE6D6";
const SERIAL = "#E4472B";
const VAULT = "#0A0D0C";
const W = 1200;
const H = 860;
const F = d.frames.length;
// Bucket window: the weekend's whole price path ± 450 ticks (relief/data.ts bucketWindow).
let lo = Infinity;
let hi = -Infinity;
for (const f of d.frames) {
  lo = Math.min(lo, f.poolTick, f.fairTick);
  hi = Math.max(hi, f.poolTick, f.fairTick);
}
const B0 = Math.max(0, Math.floor((lo - 450 - d.grid.tick0) / d.bucketTicks));
const B1 = Math.min(d.grid.n - 1, Math.ceil((hi + 450 - d.grid.tick0) / d.bucketTicks));
const n = B1 - B0 + 1;

// Height rule shared with the WebGL engine (relief/data.ts heightOf): sqrt compression against the 99th percentile.
const all = d.liq.flat().sort((a, b) => a - b);
const qRef = all[Math.floor(all.length * 0.99)];
const heightOf = (q) => Math.sqrt(Math.min(q / qRef, 1.45));

const LEFT = 40;
const WIDTH = W - 80;
const TOP = 250;
const DEPTH = 560;
const HMAX = 190;
const cx = LEFT + WIDTH / 2;
const row = (f) => {
  const t = f / (F - 1);
  const s = 0.56 + 0.44 * t;
  const y0 = TOP + DEPTH * (t * (0.72 + 0.28 * t));
  return { s, y0 };
};
// Higher tick = lower NVDA price, so price rises to the right: bucket 0 (lowest tick) is at the right edge.
const xOf = (i, s) => cx + (LEFT + WIDTH * (1 - i / (n - 1)) - cx) * s;
const f1 = (v) => Math.round(v).toString();

const rows = [];
for (let f = 0; f < F; f += 3) rows.push(f);
if (rows[rows.length - 1] !== F - 1) rows.push(F - 1);

let paths = "";
for (const f of rows) {
  const { s, y0 } = row(f);
  const q = d.liq[f].slice(B0, B1 + 1);
  let p = `M${f1(xOf(n - 1, s))} ${f1(y0)}`;
  for (let i = n - 1; i >= 0; i--) p += `L${f1(xOf(i, s))} ${f1(y0 - HMAX * s * heightOf(q[i]))}`;
  p += `L${f1(xOf(0, s))} ${f1(y0)}Z`;
  const closed = d.frames[f].regime === "WEEKEND_DARK" ? 0.5 : 0.62;
  paths += `<path d="${p}" fill="${VAULT}" stroke="${PAPER}" stroke-opacity="${closed}"/>`;
}

// Pool price and fair value traced on each ridge's crest (front-most last so it reads on top).
const bucketAt = (tick) => (tick - d.grid.tick0) / d.bucketTicks - B0;
const crest = (f, tick) => {
  const { s, y0 } = row(f);
  const b = Math.max(0, Math.min(n - 1, bucketAt(tick)));
  const q = d.liq[f][B0 + Math.round(b)];
  return [xOf(b, s), y0 - HMAX * s * heightOf(q) - 3 * s];
};
const trace = (key) => rows.map((f, k) => { const [x, y] = crest(f, d.frames[f][key]); return `${k ? "L" : "M"}${f1(x)} ${f1(y)}`; }).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${d.label}">
<title>${d.label}</title>
<desc>Active liquidity per 10-tick bucket, one engraved ridge per 30 minutes from ${d.frames[0].et} to ${d.frames[F - 1].et} ET (back to front). Paper line: pool price. Red line: fair value.</desc>
<g fill="none" stroke-width="0.8" stroke-linejoin="round" vector-effect="non-scaling-stroke">${paths}</g>
<path d="${trace("poolTick")}" fill="none" stroke="${PAPER}" stroke-width="1.4" stroke-opacity="0.9"/>
<path d="${trace("fairTick")}" fill="none" stroke="${SERIAL}" stroke-width="1.4"/>
</svg>
`;
writeFileSync(OUT, svg);
console.log(`${OUT}: ${rows.length} ridges × ${n} buckets, ${(svg.length / 1024).toFixed(0)} KB (qRef ${qRef})`);
