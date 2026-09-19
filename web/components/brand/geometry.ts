// DeltaDesk engraving geometry: the maths behind every guilloché, border and Δ in the kit.
//
// Pure functions, no imports, erasable TypeScript only: the same file runs in React (server or client) and in
// `node scripts/brand/generate.mjs` (Node's built-in type stripping), so the SVG downloads and the components are
// drawn from one source. Everything is deterministic: same inputs, same path strings.

export type Pt = [number, number];

/** Rounds for SVG output: fixed precision, no "-0". */
export function num(n: number, precision = 2): string {
  const k = 10 ** precision;
  const v = Math.round(n * k) / k;
  return Object.is(v, -0) ? "0" : String(v);
}

/**
 * Samples a parametric curve f(t) over [t0, t1] as `segments` cubic Béziers (Hermite tangents by central difference).
 * Smooth curves stay smooth with far fewer points than a polyline. Output uses relative commands measured from the
 * previous *rounded* point, so rounding never drifts. With `continued`, the leading moveto is omitted (for joining
 * pieces into one path).
 */
export function curvePath(f: (t: number) => Pt, t0: number, t1: number, segments: number, closed: boolean, precision = 2, continued = false): string {
  const h = (t1 - t0) / segments;
  const eps = h * 1e-3;
  const k = 10 ** precision;
  const round = (n: number) => Math.round(n * k) / k;
  const d = (t: number): Pt => {
    const a = f(t - eps), b = f(t + eps);
    return [(b[0] - a[0]) / (2 * eps), (b[1] - a[1]) / (2 * eps)];
  };
  const p0 = f(t0);
  let cx = round(p0[0]), cy = round(p0[1]);
  let out = continued ? "" : `M${num(cx, precision)} ${num(cy, precision)}`;
  for (let i = 0; i < segments; i++) {
    const ta = t0 + i * h, tb = ta + h;
    const a = f(ta), b = f(tb), da = d(ta), db = d(tb);
    const c1: Pt = [a[0] + (da[0] * h) / 3, a[1] + (da[1] * h) / 3];
    const c2: Pt = [b[0] - (db[0] * h) / 3, b[1] - (db[1] * h) / 3];
    const ex = round(b[0]), ey = round(b[1]);
    out += `c${rel(c1[0] - cx, precision)} ${rel(c1[1] - cy, precision)} ${rel(c2[0] - cx, precision)} ${rel(c2[1] - cy, precision)} ${rel(ex - cx, precision)} ${rel(ey - cy, precision)}`;
    cx = ex;
    cy = ey;
  }
  return closed ? out + "z" : out;
}

/** Compact number for relative path commands: fixed precision, no leading zero, no "-0". */
function rel(n: number, precision: number): string {
  const s = num(n, precision);
  return s.replace(/^(-?)0\./, "$1.");
}

export function polyPath(pts: Pt[], closed: boolean, precision = 2): string {
  return pts.map((p, i) => `${i ? "L" : "M"}${num(p[0], precision)} ${num(p[1], precision)}`).join("") + (closed ? "Z" : "");
}

export function circlePath(cx: number, cy: number, r: number, precision = 2): string {
  const c = (n: number) => num(n, precision);
  return `M${c(cx - r)} ${c(cy)}A${c(r)} ${c(r)} 0 1 0 ${c(cx + r)} ${c(cy)}A${c(r)} ${c(r)} 0 1 0 ${c(cx - r)} ${c(cy)}Z`;
}

// ---------------------------------------------------------------------------------------------------------------
// Rosettes

/**
 * Loop-chain guilloché (a prolate epitrochoid): a point on a small wheel of radius `loop` spinning `turns` times
 * while its centre travels once round a circle of radius `radius`. With loop·turns > radius the point draws loops;
 * `turns - 1` of them close round the ring. Phase-shifted copies interlace into the classic banknote band.
 */
export function loopChain(o: { cx: number; cy: number; radius: number; loop: number; turns: number; phase?: number; segmentsPerLoop?: number; precision?: number }): string {
  const { cx, cy, radius, loop, turns, phase = 0, segmentsPerLoop = 8, precision = 1 } = o;
  const f = (t: number): Pt => [cx + radius * Math.cos(t) + loop * Math.cos(turns * t + phase), cy + radius * Math.sin(t) + loop * Math.sin(turns * t + phase)];
  return curvePath(f, 0, Math.PI * 2, Math.abs(turns - 1) * segmentsPerLoop, true, precision);
}

/**
 * Rose-wave ring: r(θ) = radius + amp·sin(waves·θ + phase). A family of these with phases spread over one wave
 * gives the woven lattice of a certificate border; `waves` must be an integer for the curve to close.
 */
export function roseWave(o: { cx: number; cy: number; radius: number; amp: number; waves: number; phase?: number; segmentsPerWave?: number; precision?: number }): string {
  const { cx, cy, radius, amp, waves, phase = 0, segmentsPerWave = 4, precision = 1 } = o;
  const f = (t: number): Pt => {
    const r = radius + amp * Math.sin(waves * t + phase);
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  };
  return curvePath(f, 0, Math.PI * 2, waves * segmentsPerWave, true, precision);
}

/**
 * Hypotrochoid rosette (the spirograph flower at the centre of a share certificate):
 * x = (R−r)cos t + d·cos((R−r)/r·t), closed after r/gcd(R, r) turns. `petals` = R/gcd.
 */
export function hypotrochoid(o: { cx: number; cy: number; R: number; r: number; d: number; rotate?: number; segments?: number; precision?: number }): string {
  const { cx, cy, R, r, d, rotate = 0, segments, precision = 1 } = o;
  const g = gcd(Math.round(R), Math.round(r));
  const turns = Math.round(r) / g;
  const k = (R - r) / r;
  const f = (t: number): Pt => {
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    const c = Math.cos(rotate), s = Math.sin(rotate);
    return [cx + x * c - y * s, cy + x * s + y * c];
  };
  const petals = Math.round(R) / g;
  return curvePath(f, 0, Math.PI * 2 * turns, segments ?? petals * turns * 6, true, precision);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * A spirograph rosette, the flower at the heart of a share certificate: a hypotrochoid with R = `petals` and
 * r = `turns` (coprime, so the pen draws `petals` lobes over `turns` revolutions) and pen reach `reach`.
 * Each extra layer is the same curve at 0.62× scale, turned half a lobe, so the layers weave.
 */
export function rosettePaths(o: { size: number; petals?: number; turns?: number; reach?: number; layers?: number; precision?: number }): string[] {
  const { size, petals = 60, turns = 23, reach = 40, layers = 1, precision = 1 } = o;
  const c = size / 2;
  const out: string[] = [];
  for (let i = 0; i < layers; i++) {
    const scale = ((c * 0.98) / (petals - turns + reach)) * 0.62 ** i;
    out.push(hypotrochoid({ cx: c, cy: c, R: petals * scale, r: turns * scale, d: reach * scale, rotate: (i * Math.PI) / petals, segments: petals * 8, precision }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The Δ

type Line = { p: Pt; n: Pt }; // point on the line + unit inward normal

function intersect(a: Line, b: Line): Pt {
  // Lines: n·x = n·p. Solve the 2×2 system.
  const c1 = a.n[0] * a.p[0] + a.n[1] * a.p[1];
  const c2 = b.n[0] * b.p[0] + b.n[1] * b.p[1];
  const det = a.n[0] * b.n[1] - a.n[1] * b.n[0];
  return [(c1 * b.n[1] - a.n[1] * c2) / det, (a.n[0] * c2 - c1 * b.n[0]) / det];
}

export type DeltaSpec = {
  /** Apex, bottom-left, bottom-right of the outer stroke. */
  apex: Pt;
  left: Pt;
  right: Pt;
  /** Number of nested strokes (9 for the seal, 3 for the compact mark). */
  strokes: number;
  /**
   * Inset per stroke on each side, in user units. The Didone logic of the mark: the left side is a hairline
   * (strokes bunch up), the right side and base are the heavy strokes (strokes spread out), drawn as engraving.
   */
  step: { left: number; right: number; base: number };
  /** Guilloché modulation: waves per side and amplitude as a fraction of that side's step. 0 = straight engraving. */
  waves?: number;
  amp?: number;
  precision?: number;
};

/** The nested Δ strokes, outermost first. Each is a closed path; modulation tapers to zero at the corners. */
export function deltaStrokes(s: DeltaSpec): string[] {
  const { apex, left, right, strokes, step, waves = 0, amp = 0, precision = 2 } = s;
  const centroid: Pt = [(apex[0] + left[0] + right[0]) / 3, (apex[1] + left[1] + right[1]) / 3];
  const lineThrough = (a: Pt, b: Pt): Line => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    let n: Pt = [-dy / len, dx / len];
    if ((centroid[0] - a[0]) * n[0] + (centroid[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]];
    return { p: a, n };
  };
  const L = lineThrough(apex, left), B = lineThrough(left, right), Rt = lineThrough(right, apex);
  const shift = (l: Line, d: number): Line => ({ p: [l.p[0] + l.n[0] * d, l.p[1] + l.n[1] * d], n: l.n });
  const out: string[] = [];
  for (let k = 0; k < strokes; k++) {
    const l = shift(L, step.left * k), b = shift(B, step.base * k), r = shift(Rt, step.right * k);
    const A = intersect(l, r), BL = intersect(l, b), BR = intersect(b, r);
    if (!waves || !amp) {
      out.push(polyPath([A, BL, BR], true, precision));
      continue;
    }
    // Walk each side; offset along its inward normal by a tapered sine whose phase advances per stroke. Each side is
    // its own run of cubics (tangents taken on the side's own line), so the three corners stay sharp.
    const sides: [Pt, Pt, Line, number][] = [
      [A, BL, l, step.left],
      [BL, BR, b, step.base],
      [BR, A, r, step.right],
    ];
    let d = "";
    sides.forEach(([p, q, line, st], si) => {
      const f = (u: number): Pt => {
        const uc = Math.min(1, Math.max(0, u));
        const taper = Math.sin(Math.PI * uc) ** 1.5;
        const off = amp * st * taper * Math.sin(2 * Math.PI * waves * u + (k * Math.PI * 2) / 3);
        return [p[0] + (q[0] - p[0]) * u + line.n[0] * off, p[1] + (q[1] - p[1]) * u + line.n[1] * off];
      };
      d += curvePath(f, 0, 1, waves * 3, false, precision, si > 0);
    });
    out.push(d + "z");
  }
  return out;
}

/** The mark's canonical triangles, in a 32-unit box (compact) and inside the 512-unit seal. */
export const COMPACT_DELTA: DeltaSpec = {
  apex: [16, 4.2],
  left: [3.2, 27.2],
  right: [28.8, 27.2],
  strokes: 3,
  step: { left: 0, right: 2.9, base: 2.5 },
  precision: 3,
};

export const SEAL_DELTA: DeltaSpec = {
  apex: [256, 124],
  left: [137, 331],
  right: [375, 331],
  strokes: 9,
  step: { left: 0.9, right: 3.7, base: 3.1 },
  waves: 7,
  amp: 0.3,
  precision: 1,
};

/** Solid Didone Δ for favicons: outer triangle minus the inner one (even-odd), heavy right and base. */
export function deltaSolid(o: { apex: Pt; left: Pt; right: Pt; weight: { left: number; right: number; base: number }; precision?: number }): string {
  const [outer, inner] = deltaStrokes({ apex: o.apex, left: o.left, right: o.right, strokes: 2, step: o.weight, precision: o.precision ?? 2 });
  return outer + inner;
}

// ---------------------------------------------------------------------------------------------------------------
// Bands, borders, dividers, hatching (tileable)

/** Woven wave band across a tile: `lines` sines phase-spread over one period. Tiles seamlessly along x. */
export function waveBand(o: { width: number; y: number; amp: number; period: number; lines?: number; precision?: number }): string[] {
  const { width, y, amp, period, lines = 3, precision = 2 } = o;
  const out: string[] = [];
  const cycles = Math.round(width / period);
  for (let j = 0; j < lines; j++) {
    const ph = (j * 2 * Math.PI) / lines;
    const f = (t: number): Pt => [t, y + amp * Math.sin((2 * Math.PI * t) / period + ph)];
    out.push(curvePath(f, 0, cycles * period, cycles * 4, false, precision));
  }
  return out;
}

/**
 * A 9-slice security-border tile for CSS `border-image`: corner rosettes, woven edges between two hairlines.
 * `slice` is the border thickness; the tile is (2·slice + middle) square and its middle tiles with `round`.
 */
export function securityBorderSvg(o: { color: string; slice?: number; middle?: number; opacity?: number }): string {
  const { color, slice = 24, middle = 72, opacity = 1 } = o;
  const size = slice * 2 + middle;
  const m = slice / 2; // band centre line
  const period = 12;
  const parts: string[] = [];
  const stroke = `fill="none" stroke="${color}" stroke-opacity="${opacity}"`;
  // Two hairlines framing the band, inset from the tile edge.
  const inset = 3, inner = slice - 3;
  parts.push(`<rect x="${inset}" y="${inset}" width="${size - 2 * inset}" height="${size - 2 * inset}" ${stroke} stroke-width="0.8"/>`);
  parts.push(`<rect x="${inner}" y="${inner}" width="${size - 2 * inner}" height="${size - 2 * inner}" ${stroke} stroke-width="0.5"/>`);
  // Woven edges: horizontal on top/bottom, vertical on left/right, only across the middle (corners hold rosettes).
  const amp = (inner - inset) / 2 - 2.2;
  for (const edge of ["top", "bottom", "left", "right"] as const) {
    for (let j = 0; j < 3; j++) {
      const ph = (j * 2 * Math.PI) / 3;
      const f = (t: number): Pt => {
        const w = m + amp * Math.sin((2 * Math.PI * t) / period + ph);
        const along = slice + t;
        if (edge === "top") return [along, w];
        if (edge === "bottom") return [along, size - w];
        if (edge === "left") return [w, along];
        return [size - w, along];
      };
      parts.push(`<path d="${curvePath(f, 0, middle, (middle / period) * 4, false, 1)}" ${stroke} stroke-width="0.6"/>`);
    }
  }
  // Corner rosettes: small 8-lobed hypotrochoids.
  for (const [cx, cy] of [[m, m], [size - m, m], [m, size - m], [size - m, size - m]] as Pt[]) {
    parts.push(`<path d="${hypotrochoid({ cx, cy, R: 8, r: 1, d: 2.2, segments: 64, precision: 1 })}" ${stroke} stroke-width="0.5"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${num(amp + 1.6)}" ${stroke} stroke-width="0.5"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${parts.join("")}</svg>`;
}

/** A horizontal divider tile (period-wide) with a woven band; tiles along x with no seam. */
export function dividerTileSvg(o: { color: string; period?: number; height?: number; lines?: number; opacity?: number }): string {
  const { color, period = 16, height = 12, lines = 3, opacity = 1 } = o;
  const paths = waveBand({ width: period, y: height / 2, amp: height / 2 - 1.2, period, lines })
    .map((d) => `<path d="${d}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="0.6"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${period}" height="${height}" viewBox="0 0 ${period} ${height}">${paths}</svg>`;
}

/** Engraving tint: parallel hairlines at `angle` degrees, `gap` apart. Square, seamless tile. */
export function hatchTileSvg(o: { color: string; gap?: number; angle?: 45 | 135 | 0 | 90; width?: number; opacity?: number }): string {
  const { color, gap = 6, angle = 45, width = 0.6, opacity = 1 } = o;
  const s = gap;
  let lines: string;
  if (angle === 0) lines = `<path d="M0 ${s / 2}H${s}"/>`;
  else if (angle === 90) lines = `<path d="M${s / 2} 0V${s}"/>`;
  else if (angle === 45) lines = `<path d="M${-s / 2} ${s / 2}L${s / 2} ${-s / 2}M0 ${s}L${s} 0M${s / 2} ${s * 1.5}L${s * 1.5} ${s / 2}"/>`;
  else lines = `<path d="M${-s / 2} ${s / 2}L${s / 2} ${s * 1.5}M0 0L${s} ${s}M${s / 2} ${-s / 2}L${s * 1.5} ${s / 2}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${width}">${lines}</g></svg>`;
}

/**
 * Minimal-escape data URI for CSS `url()`: attribute quotes become single quotes and only the characters that
 * break a data URI (%, #, <, >, ") are encoded, which keeps generated tiles far smaller than encodeURIComponent.
 */
export function svgDataUri(svg: string): string {
  const body = svg
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
  return `url("data:image/svg+xml,${body}")`;
}
