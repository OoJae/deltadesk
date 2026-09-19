// Share card renderer for app/opengraph-image.tsx and app/twitter-image.tsx (next/og, Node runtime).
// Fonts are the static OFL instances in scripts/brand/fonts; the seal is the generated /brand/seal-paper.svg.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { curvePath, hypotrochoid } from "./geometry";
import { INK } from "./tokens";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_ALT = "DeltaDesk. Market making stocks was a closed club. We published its books. N° 4663, Robinhood Chain.";

const font = (f: string) => readFile(join(process.cwd(), "scripts", "brand", "fonts", f));

/** The certificate frame: two hairlines with three woven sines between them, rosettes at the corners. */
function frameSvg(w: number, h: number) {
  const inset = 26, band = 16, period = 12, amp = band / 2 - 2.4;
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  const m = band / 2;
  const parts: string[] = [];
  const stroke = `fill="none" stroke="${INK.paper}"`;
  parts.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" ${stroke} stroke-opacity=".6" stroke-width="1"/>`);
  parts.push(`<rect x="${x0 + band}" y="${y0 + band}" width="${x1 - x0 - 2 * band}" height="${y1 - y0 - 2 * band}" ${stroke} stroke-opacity=".45" stroke-width=".7"/>`);
  const runs: [number, number, number, number, "h" | "v"][] = [
    [x0 + band, y0 + m, x1 - band, y0 + m, "h"],
    [x0 + band, y1 - m, x1 - band, y1 - m, "h"],
    [x0 + m, y0 + band, x0 + m, y1 - band, "v"],
    [x1 - m, y0 + band, x1 - m, y1 - band, "v"],
  ];
  for (const [ax, ay, bx, by, dir] of runs) {
    const len = dir === "h" ? bx - ax : by - ay;
    const cycles = Math.round(len / period);
    const p = len / cycles;
    for (let j = 0; j < 3; j++) {
      const ph = (j * 2 * Math.PI) / 3;
      const f = (t: number): [number, number] => {
        const o = amp * Math.sin((2 * Math.PI * t) / p + ph);
        return dir === "h" ? [ax + t, ay + o] : [ax + o, ay + t];
      };
      parts.push(`<path d="${curvePath(f, 0, len, cycles * 4, false, 1)}" ${stroke} stroke-opacity=".42" stroke-width=".8"/>`);
    }
  }
  for (const [cx, cy] of [
    [x0 + m, y0 + m],
    [x1 - m, y0 + m],
    [x0 + m, y1 - m],
    [x1 - m, y1 - m],
  ]) {
    parts.push(`<path d="${hypotrochoid({ cx, cy, R: 6, r: 1, d: 1.9, segments: 72, precision: 2 })}" ${stroke} stroke-opacity=".6" stroke-width=".7"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`;
}

const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export async function renderShareCard() {
  const [display, displayItalic, mono, body, seal] = await Promise.all([
    font("BodoniModa-Display-500.ttf"),
    font("BodoniModa-Display-500-Italic.ttf"),
    font("IBMPlexMono-500.ttf"),
    font("InstrumentSans-500.ttf"),
    readFile(join(process.cwd(), "public", "brand", "seal-paper.svg"), "utf8"),
  ]);
  const { width, height } = OG_SIZE;
  return new ImageResponse(
    (
      <div style={{ width, height, display: "flex", position: "relative", background: INK.vault, color: INK.paper, fontFamily: "Instrument Sans" }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={dataUri(frameSvg(width, height))} width={width} height={height} style={{ position: "absolute", left: 0, top: 0 }} />
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={dataUri(seal)} width={372} height={372} style={{ position: "absolute", right: 84, top: 129 }} />
        <div style={{ position: "absolute", left: 94, top: 86, bottom: 86, width: 660, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <div style={{ display: "flex", fontFamily: "Bodoni Moda", fontSize: 30, letterSpacing: "-0.01em", color: INK.paper }}>
              <span>Delta</span>
              <span style={{ fontStyle: "italic" }}>Desk</span>
            </div>
            <div style={{ display: "flex", marginLeft: 20, fontFamily: "Plex Mono", fontSize: 13.5, letterSpacing: "0.14em", color: INK.paperDim }}>
              THE OPEN MARKET-MAKING DESK FOR TOKENIZED STOCKS
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontFamily: "Bodoni Moda", fontSize: 62, lineHeight: 1.02, letterSpacing: "-0.02em", color: INK.paper }}>
            <div style={{ display: "flex" }}>Market making stocks</div>
            <div style={{ display: "flex" }}>was a closed club.</div>
            <div style={{ display: "flex" }}>
              <span>W</span>
              <span style={{ marginLeft: -5 }}>e published its&nbsp;</span>
              <span style={{ fontStyle: "italic" }}>books.</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", fontFamily: "Plex Mono", fontSize: 16, letterSpacing: "0.1em", color: INK.paperDim }}>
            <span style={{ color: INK.serial, marginRight: 16 }}>N° 4663</span>
            <span>ROBINHOOD CHAIN · NVDA · SPY · TSLA · QQQ</span>
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Bodoni Moda", data: display, weight: 500, style: "normal" },
        { name: "Bodoni Moda", data: displayItalic, weight: 500, style: "italic" },
        { name: "Plex Mono", data: mono, weight: 500, style: "normal" },
        { name: "Instrument Sans", data: body, weight: 500, style: "normal" },
      ],
    },
  );
}
