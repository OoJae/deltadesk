#!/usr/bin/env node
// DeltaDesk brand kit generator. Deterministic, dependency-free (Node >= 22.18 for built-in TypeScript stripping).
//
//   node scripts/brand/generate.mjs
//
// Writes every vector mark and pattern to web/public/brand/ (served at /brand/*) and to the repo's brand/ folder,
// plus web/components/brand/seal-data.ts (the Seal component's path data) and web/app/icon.svg.
// All geometry comes from components/brand/geometry.ts; type is outlined from the OFL fonts in ./fonts.
// PNGs (apple-icon, favicon.ico, PNG downloads) are rasterised from these SVGs by ./rasterize.mjs.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as G from "../../components/brand/geometry.ts";
import { loadFont, outlineText, contoursToPath } from "./ttf.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..", "..");
const REPO = join(WEB, "..");
const OUT_PUBLIC = join(WEB, "public", "brand");
const OUT_REPO = join(REPO, "brand");
const font = (f) => loadFont(join(here, "fonts", f));
const BODONI = font("BodoniModa-Mark-600.ttf");
const BODONI_I = font("BodoniModa-Mark-600-Italic.ttf");
const MONO = font("IBMPlexMono-500.ttf");

export const INK = { paper: "#EDE6D6", vault: "#0A0D0C", serial: "#E4472B" };
const TONES = { paper: { ink: INK.paper, ground: INK.vault }, vault: { ink: INK.vault, ground: INK.paper } };

// ------------------------------------------------------------------------------------------------ the full seal
const C = 256;
export const SEAL = {
  rim: [
    { d: G.circlePath(C, C, 252), w: 1.4 },
    { d: G.circlePath(C, C, 246.5), w: 0.5 },
    { d: G.circlePath(C, C, 209), w: 0.6 },
    { d: G.circlePath(C, C, 176), w: 0.9 },
    { d: G.circlePath(C, C, 172.5), w: 0.4 },
  ],
  // The loop chain: three epitrochoids 120° apart weave the outer band (48 loops each).
  band: [0, 1, 2].map((j) => G.loopChain({ cx: C, cy: C, radius: 227.5, loop: 13.2, turns: 49, phase: (j * 2 * Math.PI) / 3, segmentsPerLoop: 6, precision: 1 })),
  // A fine rose-wave lace inside the text ring.
  lace: [0, 1].map((j) => G.roseWave({ cx: C, cy: C, radius: 166.5, amp: 2.6, waves: 90, phase: j * Math.PI, segmentsPerWave: 3, precision: 1 })),
  delta: G.deltaStrokes(G.SEAL_DELTA),
};

// Micro-text: IBM Plex Mono 500 outlined on the seal's text ring, laid out like an engraved corporate seal:
// the top arc reads clockwise, the bottom arc reads upright (counter-clockwise), with star ornaments between.
const MICRO_TOP = "OPEN MARKET-MAKING DESK";
const MICRO_BOTTOM = "ROBINHOOD CHAIN · N° 4663";
const MICRO = `${MICRO_TOP} · ${MICRO_BOTTOM}`;
function arcText(text, { radius, size, tracking, bottom, serialFrom = Infinity }) {
  const s = size / MONO.unitsPerEm;
  const glyphs = [...text].map((ch) => MONO.glyphIndex(ch.codePointAt(0)));
  const adv = glyphs.map((g) => MONO.advance(g) * s + tracking * size);
  const total = adv.reduce((a, b) => a + b, 0) - tracking * size;
  const span = total / radius;
  let plain = "", serial = "";
  let along = 0;
  glyphs.forEach((g, i) => {
    const w = MONO.advance(g) * s;
    const mid = (along + w / 2) / radius - span / 2; // signed angle from the arc's centre, left to right
    const theta = bottom ? Math.PI / 2 - mid : -Math.PI / 2 + mid;
    const out = [Math.cos(theta), Math.sin(theta)];
    // Reading direction (x) and glyph up (y) in screen space.
    const ux = bottom ? [Math.sin(theta), -Math.cos(theta)] : [-Math.sin(theta), Math.cos(theta)];
    const uy = bottom ? [-out[0], -out[1]] : out;
    const ox = C + radius * out[0], oy = C + radius * out[1];
    const d = contoursToPath(
      MONO.contours(g),
      (fx, fy) => {
        const lx = fx * s - w / 2, ly = fy * s;
        return { x: ox + lx * ux[0] + ly * uy[0], y: oy + lx * ux[1] + ly * uy[1] };
      },
      1,
    );
    if (i >= serialFrom) serial += d;
    else plain += d;
    along += adv[i];
  });
  return { plain, serial };
}
function star(cx, cy, r) {
  // A four-point engraver's star, pinched: the ornament between the seal's two legends.
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.28;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return G.polyPath(pts, true, 2);
}
{
  const size = 17.5, tracking = 0.32;
  const capHeight = (MONO.capHeight / MONO.unitsPerEm) * size;
  const rIn = 185.2, rOut = rIn + capHeight;
  const top = arcText(MICRO_TOP, { radius: rIn, size, tracking, bottom: false });
  const bot = arcText(MICRO_BOTTOM, { radius: rOut, size, tracking, bottom: true, serialFrom: MICRO_BOTTOM.indexOf("N°") });
  const mid = (rIn + rOut) / 2;
  SEAL.text = { plain: top.plain + bot.plain + star(C - mid, C, 6.2) + star(C + mid, C, 6.2), serial: bot.serial };
}

// Stroke weights in the exported files are tuned for display at roughly 200–600 px (the component draws
// non-scaling hairlines instead, so it reads at any size).
const SEAL_WEIGHT = 1.6;
function sealSvg(tone) {
  return svg(512, 512, [sealInner(TONES[tone].ink)]);
}

// ------------------------------------------------------------------------------------------------ compact marks
export const COMPACT = {
  delta: G.deltaStrokes(G.COMPACT_DELTA),
  ring: G.circlePath(16, 16, 15.2, 3),
};
function deltaSvg(tone) {
  const { ink } = TONES[tone];
  return svg(32, 32, [`<g fill="none" stroke="${ink}" stroke-width="1.15" stroke-linejoin="miter" stroke-miterlimit="10">`, ...COMPACT.delta.map((d) => `<path d="${d}"/>`), `</g>`]);
}
// The compact seal: the 3-stroke Δ inside one engraved ring. Drawn on a 40-unit box so the ring has air.
const CS = { box: 40, ring: G.circlePath(20, 20, 19.1, 3), ring2: G.circlePath(20, 20, 17.3, 3) };
const COMPACT_SEAL_DELTA = G.deltaStrokes({ ...G.COMPACT_DELTA, apex: [20, 8.6], left: [9.4, 27.6], right: [30.6, 27.6], step: { left: 0, right: 2.35, base: 2.05 } });
export const COMPACT_SEAL = { ring: CS.ring, ring2: CS.ring2, delta: COMPACT_SEAL_DELTA };
function compactSealSvg(tone) {
  const { ink } = TONES[tone];
  return svg(40, 40, [
    `<g fill="none" stroke="${ink}">`,
    `<path d="${CS.ring}" stroke-width="1"/>`,
    `<path d="${CS.ring2}" stroke-width="0.5"/>`,
    ...COMPACT_SEAL_DELTA.map((d) => `<path d="${d}" stroke-width="1.05" stroke-linejoin="miter" stroke-miterlimit="10"/>`),
    `</g>`,
  ]);
}

// Favicon: a solid Didone Δ (hairline left, heavy right and base) on the vault, with the serial dot.
const FAV_DELTA = G.deltaSolid({ apex: [16, 3.6], left: [3.2, 27.4], right: [28.8, 27.4], weight: { left: 1.9, right: 5, base: 4.2 }, precision: 3 });
function faviconSvg() {
  return svg(32, 32, [`<rect width="32" height="32" rx="7" fill="${INK.vault}"/>`, `<path d="${FAV_DELTA}" fill="${INK.paper}" fill-rule="evenodd"/>`]);
}

// App icon: the seal's Δ and band on the vault, no micro-text (it would be noise at 180 px).
function appIconSvg() {
  const s = 512;
  return svg(s, s, [
    `<rect width="${s}" height="${s}" fill="${INK.vault}"/>`,
    `<g transform="translate(256 256) scale(0.9) translate(-256 -256)" fill="none" stroke="${INK.paper}">`,
    `<g stroke-opacity="0.9">`,
    ...SEAL.band.map((d) => `<path d="${d}" stroke-width="1.9"/>`),
    `</g>`,
    `<path d="${G.circlePath(C, C, 205)}" stroke-width="3"/>`,
    `<path d="${G.circlePath(C, C, 250)}" stroke-width="3"/>`,
    ...G.deltaStrokes({ ...G.SEAL_DELTA, apex: [256, 100], left: [114, 346], right: [398, 346], strokes: 5, step: { left: 3, right: 10, base: 8.4 }, amp: 0.26, waves: 5 }).map(
      (d, i) => `<path d="${d}" stroke-width="${i === 0 ? 5 : 3.6}" stroke-linejoin="miter" stroke-miterlimit="8"/>`,
    ),
    `</g>`,
  ]);
}

// ------------------------------------------------------------------------------------------------ wordmark + lockups
// "Delta" roman + "Desk" italic, Bodoni Moda 600 (opsz 36), outlined. Cap height = `size` × capHeight/UPM.
function wordmarkPath(size, x = 0, baseline = 0) {
  const a = outlineText(BODONI, "Delta", { x, y: baseline, size, tracking: -0.01 });
  const gap = size * 0.02; // the italic's own sidebearing already opens the join; a hair more reads as one word
  const b = outlineText(BODONI_I, "Desk", { x: x + a.width + gap, y: baseline, size, tracking: -0.005 });
  return { d: a.d + b.d, width: a.width + gap + b.width };
}
const capH = (size) => (size * BODONI.capHeight) / BODONI.unitsPerEm;
const descender = (size) => (size * 0.23);

function wordmarkSvg(tone) {
  const size = 100;
  const pad = 2;
  const w = wordmarkPath(size, pad, pad + capH(size) + size * 0.02);
  const width = Math.ceil(w.width + pad * 2), height = Math.ceil(pad * 2 + capH(size) + size * 0.02 + descender(size) * 0.1);
  return svg(width, height, [`<path d="${w.d}" fill="${TONES[tone].ink}"/>`]);
}

function lockupHorizontalSvg(tone) {
  const { ink } = TONES[tone];
  const size = 100;
  const cap = capH(size);
  const markH = cap * 1.72; // the compact seal stands a little taller than the caps, centred on them
  const scale = markH / 40;
  const gap = markH * 0.36;
  const top = 4;
  const baseline = top + markH / 2 + cap / 2;
  const w = wordmarkPath(size, 4 + markH + gap, baseline);
  const width = Math.ceil(4 + markH + gap + w.width + 4), height = Math.ceil(markH + top * 2);
  return svg(width, height, [
    `<g transform="translate(4 ${top}) scale(${G.num(scale, 4)})" fill="none" stroke="${ink}">`,
    `<path d="${CS.ring}" stroke-width="1"/><path d="${CS.ring2}" stroke-width="0.5"/>`,
    ...COMPACT_SEAL_DELTA.map((d) => `<path d="${d}" stroke-width="1.05" stroke-linejoin="miter" stroke-miterlimit="10"/>`),
    `</g>`,
    `<path d="${w.d}" fill="${ink}"/>`,
  ]);
}

function lockupStackedSvg(tone) {
  const { ink } = TONES[tone];
  const width = 640;
  const sealSize = 360;
  const size = 104;
  const w = wordmarkPath(size);
  const tag = outlineText(MONO, "THE OPEN MARKET-MAKING DESK FOR TOKENIZED STOCKS", { size: 13.5, tracking: 0.14 });
  const sealTop = 24, wordBase = sealTop + sealSize + 56 + capH(size), tagBase = wordBase + 52;
  const s = sealSize / 512;
  const wx = (width - w.width) / 2, tx = (width - tag.width) / 2;
  const word = wordmarkPath(size, wx, wordBase);
  const tagD = outlineText(MONO, "THE OPEN MARKET-MAKING DESK FOR TOKENIZED STOCKS", { x: tx, y: tagBase, size: 13.5, tracking: 0.14 });
  return svg(width, Math.ceil(tagBase + 28), [
    `<g transform="translate(${(width - sealSize) / 2} ${sealTop}) scale(${G.num(s, 5)})">`,
    sealInner(ink),
    `</g>`,
    `<path d="${word.d}" fill="${ink}"/>`,
    `<path d="${tagD.d}" fill="${ink}" fill-opacity="0.72"/>`,
  ]);
}
function sealInner(ink, k = SEAL_WEIGHT) {
  const w = (n) => G.num(n * k, 2);
  return [
    `<g fill="none" stroke="${ink}">`,
    ...SEAL.rim.map((r) => `<path d="${r.d}" stroke-width="${w(r.w)}"/>`),
    `<g stroke-opacity="0.9">`,
    ...SEAL.band.map((d) => `<path d="${d}" stroke-width="${w(0.55)}"/>`),
    `</g><g stroke-opacity="0.75">`,
    ...SEAL.lace.map((d) => `<path d="${d}" stroke-width="${w(0.45)}"/>`),
    `</g>`,
    ...SEAL.delta.map((d, i) => `<path d="${d}" stroke-width="${w(i === 0 ? 1.1 : 0.8)}" stroke-linejoin="miter" stroke-miterlimit="8"/>`),
    `</g>`,
    `<path d="${SEAL.text.plain}" fill="${ink}"/>`,
    `<path d="${SEAL.text.serial}" fill="${INK.serial}"/>`,
  ].join("");
}

// ------------------------------------------------------------------------------------------------ patterns
function rosetteSvg(tone) {
  const size = 400;
  return svg(size, size, [`<g fill="none" stroke="${TONES[tone].ink}" stroke-width="0.5">`, ...G.rosettePaths({ size, layers: 2 }).map((d) => `<path d="${d}"/>`), `</g>`]);
}

// ------------------------------------------------------------------------------------------------ output
function svg(w, h, parts) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>\n`;
}

const files = {};
for (const tone of ["paper", "vault"]) {
  files[`seal-${tone}.svg`] = sealSvg(tone);
  files[`seal-compact-${tone}.svg`] = compactSealSvg(tone);
  files[`delta-${tone}.svg`] = deltaSvg(tone);
  files[`wordmark-${tone}.svg`] = wordmarkSvg(tone);
  files[`lockup-horizontal-${tone}.svg`] = lockupHorizontalSvg(tone);
  files[`lockup-stacked-${tone}.svg`] = lockupStackedSvg(tone);
  files[`rosette-${tone}.svg`] = rosetteSvg(tone);
}
files["favicon.svg"] = faviconSvg();
files["app-icon.svg"] = appIconSvg();
files["pattern-security-border.svg"] = G.securityBorderSvg({ color: INK.paper, opacity: 0.55 }) + "\n";
files["pattern-divider.svg"] = G.dividerTileSvg({ color: INK.paper, opacity: 0.55 }) + "\n";
files["pattern-hatch.svg"] = G.hatchTileSvg({ color: INK.paper, gap: 6, opacity: 0.4 }) + "\n";

mkdirSync(OUT_PUBLIC, { recursive: true });
mkdirSync(OUT_REPO, { recursive: true });
for (const [name, body] of Object.entries(files)) {
  writeFileSync(join(OUT_PUBLIC, name), body);
  writeFileSync(join(OUT_REPO, name), body);
}
writeFileSync(join(WEB, "app", "icon.svg"), files["favicon.svg"]);

// The Seal component's data (generated; do not edit by hand).
const data = `// GENERATED by web/scripts/brand/generate.mjs. Do not edit: change geometry.ts or the generator and re-run it.
// Path data for <Seal>. The micro-text is IBM Plex Mono 500 outlined on a circle, so it renders without the font.

export const SEAL_VIEWBOX = 512;
export const SEAL_RIM: { d: string; w: number }[] = ${JSON.stringify(SEAL.rim)};
export const SEAL_BAND: string[] = ${JSON.stringify(SEAL.band)};
export const SEAL_LACE: string[] = ${JSON.stringify(SEAL.lace)};
export const SEAL_DELTA_STROKES: string[] = ${JSON.stringify(SEAL.delta)};
export const SEAL_TEXT: string = ${JSON.stringify(SEAL.text.plain)};
export const SEAL_SERIAL: string = ${JSON.stringify(SEAL.text.serial)};
export const SEAL_MICROTEXT = ${JSON.stringify(MICRO)};
`;
writeFileSync(join(WEB, "components", "brand", "seal-data.ts"), data);

// Compact mark data is tiny and lives in a separate module so client bundles (the nav) never pull the full seal.
const markData = `// GENERATED by web/scripts/brand/generate.mjs. Do not edit: change geometry.ts or the generator and re-run it.
// Path data for <DeltaMark> (the compact seal and the bare 3-stroke Δ).

export const MARK_SEAL_VIEWBOX = 40;
export const MARK_SEAL_RING: string = ${JSON.stringify(CS.ring)};
export const MARK_SEAL_RING_INNER: string = ${JSON.stringify(CS.ring2)};
export const MARK_SEAL_DELTA: string[] = ${JSON.stringify(COMPACT_SEAL_DELTA)};
export const MARK_DELTA_VIEWBOX = 32;
export const MARK_DELTA: string[] = ${JSON.stringify(COMPACT.delta)};
export const MARK_FAVICON: string = ${JSON.stringify(FAV_DELTA)};
`;
writeFileSync(join(WEB, "components", "brand", "mark-data.ts"), markData);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + " KB";
console.log(Object.entries(files).map(([n, b]) => `  ${n.padEnd(34)} ${kb(b)}`).join("\n"));
console.log(`  seal-data.ts ${kb(data)} · mark-data.ts ${kb(markData)}`);
