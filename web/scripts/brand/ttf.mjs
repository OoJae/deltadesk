// A small TrueType reader, just enough to outline brand type into SVG paths with no dependencies:
// cmap (format 4/12), hmtx, loca/glyf (simple + composite glyphs) and GPOS pair kerning (formats 1 and 2).
// The fonts are static instances fetched from Google Fonts (SIL OFL); see ./fonts/README.md.
import { readFileSync } from "node:fs";

export function loadFont(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o);
  const i16 = (o) => dv.getInt16(o);
  const u32 = (o) => dv.getUint32(o);
  const tables = {};
  const numTables = u16(4);
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3]);
    tables[tag] = { offset: u32(r + 8), length: u32(r + 12) };
  }
  const head = tables.head.offset;
  const unitsPerEm = u16(head + 18);
  const locFormat = i16(head + 50);
  const numHMetrics = u16(tables.hhea.offset + 34);
  const ascender = i16(tables.hhea.offset + 4);
  const descender = i16(tables.hhea.offset + 6);
  const capHeight = tables["OS/2"] && u16(tables["OS/2"].offset) >= 2 ? i16(tables["OS/2"].offset + 88) : ascender * 0.7;

  const advance = (g) => u16(tables.hmtx.offset + 4 * Math.min(g, numHMetrics - 1));

  // cmap: prefer the full-repertoire format 12 subtable, fall back to BMP format 4.
  const cmapOff = tables.cmap.offset;
  let sub12 = null, sub4 = null;
  for (let i = 0; i < u16(cmapOff + 2); i++) {
    const r = cmapOff + 4 + i * 8;
    const pid = u16(r), eid = u16(r + 2), off = cmapOff + u32(r + 4);
    const fmt = u16(off);
    if (fmt === 12 && pid === 3 && eid === 10) sub12 = off;
    if (fmt === 4 && pid === 3 && (eid === 1 || eid === 0)) sub4 = off;
  }
  const glyphIndex = (cp) => {
    if (sub12 != null) {
      const n = u32(sub12 + 12);
      for (let i = 0; i < n; i++) {
        const g = sub12 + 16 + i * 12;
        const s = u32(g), e = u32(g + 4);
        if (cp >= s && cp <= e) return u32(g + 8) + (cp - s);
      }
      return 0;
    }
    const segX2 = u16(sub4 + 6);
    const ends = sub4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = u16(ends + i * 2), start = u16(starts + i * 2);
      if (cp < start || cp > end) continue;
      const ro = u16(ranges + i * 2);
      if (ro === 0) return (cp + i16(deltas + i * 2)) & 0xffff;
      const gi = u16(ranges + i * 2 + ro + (cp - start) * 2);
      return gi === 0 ? 0 : (gi + i16(deltas + i * 2)) & 0xffff;
    }
    return 0;
  };

  const glyphOffset = (g) =>
    locFormat === 0
      ? [u16(tables.loca.offset + g * 2) * 2, u16(tables.loca.offset + g * 2 + 2) * 2]
      : [u32(tables.loca.offset + g * 4), u32(tables.loca.offset + g * 4 + 4)];

  // Returns contours as arrays of {x, y, on} in font units (y up).
  const contours = (g, depth = 0) => {
    const [a, b] = glyphOffset(g);
    if (a === b || depth > 8) return [];
    const o = tables.glyf.offset + a;
    const n = i16(o);
    if (n >= 0) {
      const endPts = [];
      for (let i = 0; i < n; i++) endPts.push(u16(o + 10 + i * 2));
      const count = n ? endPts[n - 1] + 1 : 0;
      let p = o + 10 + n * 2;
      p += 2 + u16(p);
      const flags = [];
      while (flags.length < count) {
        const f = buf[p++];
        flags.push(f);
        if (f & 8) for (let r = buf[p++]; r > 0; r--) flags.push(f);
      }
      const xs = [], ys = [];
      let v = 0;
      for (const f of flags) {
        if (f & 2) { const d = buf[p++]; v += f & 16 ? d : -d; }
        else if (!(f & 16)) { v += i16(p); p += 2; }
        xs.push(v);
      }
      v = 0;
      for (const f of flags) {
        if (f & 4) { const d = buf[p++]; v += f & 32 ? d : -d; }
        else if (!(f & 32)) { v += i16(p); p += 2; }
        ys.push(v);
      }
      const out = [];
      let s = 0;
      for (const e of endPts) {
        const c = [];
        for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
        out.push(c);
        s = e + 1;
      }
      return out;
    }
    // Composite glyph.
    const out = [];
    let p = o + 10;
    for (;;) {
      const flags = u16(p), gi = u16(p + 2);
      p += 4;
      let dx, dy;
      if (flags & 1) { dx = i16(p); dy = i16(p + 2); p += 4; }
      else { dx = dv.getInt8(p); dy = dv.getInt8(p + 1); p += 2; }
      let m = [1, 0, 0, 1];
      const f2 = (q) => i16(q) / 16384;
      if (flags & 8) { const s = f2(p); m = [s, 0, 0, s]; p += 2; }
      else if (flags & 0x40) { m = [f2(p), 0, 0, f2(p + 2)]; p += 4; }
      else if (flags & 0x80) { m = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)]; p += 8; }
      if (!(flags & 2)) { dx = 0; dy = 0; } // point-matched components are not used by these fonts
      for (const c of contours(gi, depth + 1))
        out.push(c.map((pt) => ({ x: m[0] * pt.x + m[2] * pt.y + dx, y: m[1] * pt.x + m[3] * pt.y + dy, on: pt.on })));
      if (!(flags & 0x20)) break;
    }
    return out;
  };

  // ---- GPOS pair kerning (the 'kern' feature), formats 1 and 2, through extension lookups.
  const pairSubtables = [];
  if (tables.GPOS) {
    const G = tables.GPOS.offset;
    const featureList = G + u16(G + 6), lookupList = G + u16(G + 8);
    const lookupIdx = new Set();
    for (let i = 0; i < u16(featureList); i++) {
      const r = featureList + 2 + i * 6;
      const tag = String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3]);
      if (tag !== "kern") continue;
      const f = featureList + u16(r + 4);
      for (let j = 0; j < u16(f + 2); j++) lookupIdx.add(u16(f + 4 + j * 2));
    }
    for (const li of lookupIdx) {
      const L = lookupList + u16(lookupList + 2 + li * 2);
      const lookupType = u16(L);
      for (let s = 0; s < u16(L + 4); s++) {
        let st = L + u16(L + 6 + s * 2);
        let type = lookupType;
        if (type === 9) { type = u16(st + 2); st = st + u32(st + 4); }
        if (type === 2) pairSubtables.push(st);
      }
    }
  }
  const coverageIndex = (off, g) => {
    const fmt = u16(off);
    if (fmt === 1) {
      for (let i = 0; i < u16(off + 2); i++) if (u16(off + 4 + i * 2) === g) return i;
      return -1;
    }
    for (let i = 0; i < u16(off + 2); i++) {
      const r = off + 4 + i * 6;
      if (g >= u16(r) && g <= u16(r + 2)) return u16(r + 4) + g - u16(r);
    }
    return -1;
  };
  const classOf = (off, g) => {
    const fmt = u16(off);
    if (fmt === 1) {
      const start = u16(off + 2), n = u16(off + 4);
      return g >= start && g < start + n ? u16(off + 6 + (g - start) * 2) : 0;
    }
    for (let i = 0; i < u16(off + 2); i++) {
      const r = off + 4 + i * 6;
      if (g >= u16(r) && g <= u16(r + 2)) return u16(r + 4);
    }
    return 0;
  };
  const bits = (v) => { let c = 0; for (; v; v >>= 1) c += v & 1; return c; };
  const kern = (left, right) => {
    for (const st of pairSubtables) {
      const fmt = u16(st), cov = st + u16(st + 2), vf1 = u16(st + 4), vf2 = u16(st + 6);
      const ci = coverageIndex(cov, left);
      if (ci < 0) continue;
      const size1 = bits(vf1) * 2, size2 = bits(vf2) * 2;
      const xAdvOff = bits(vf1 & 3) * 2;
      if (!(vf1 & 4)) continue;
      if (fmt === 1) {
        const ps = st + u16(st + 10 + ci * 2);
        const n = u16(ps);
        for (let i = 0; i < n; i++) {
          const r = ps + 2 + i * (2 + size1 + size2);
          if (u16(r) === right) return i16(r + 2 + xAdvOff);
        }
      } else if (fmt === 2) {
        const c1 = classOf(st + u16(st + 8), left), c2 = classOf(st + u16(st + 10), right);
        const n2 = u16(st + 14);
        const r = st + 16 + (c1 * n2 + c2) * (size1 + size2);
        const v = i16(r + xAdvOff);
        if (v) return v;
      }
    }
    return 0;
  };

  return { unitsPerEm, ascender, descender, capHeight, glyphIndex, advance, contours, kern };
}

/** TrueType quadratic contours -> SVG path data, after mapping each point through `map` (font units in, user space out). */
export function contoursToPath(contours, map, precision = 2) {
  const f = (n) => {
    const v = Math.round(n * 10 ** precision) / 10 ** precision;
    return (Object.is(v, -0) ? 0 : v).toString();
  };
  let d = "";
  for (const c of contours) {
    if (c.length === 0) continue;
    const pts = c.map((p) => ({ ...map(p.x, p.y), on: p.on }));
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
    const firstOn = pts.findIndex((p) => p.on);
    const start = firstOn >= 0 ? pts[firstOn] : mid(pts[pts.length - 1], pts[0]);
    const seq = firstOn >= 0 ? [...pts.slice(firstOn + 1), ...pts.slice(0, firstOn)] : pts;
    d += `M${f(start.x)} ${f(start.y)}`;
    let ctrl = null;
    for (const p of seq) {
      if (p.on) {
        d += ctrl ? `Q${f(ctrl.x)} ${f(ctrl.y)} ${f(p.x)} ${f(p.y)}` : `L${f(p.x)} ${f(p.y)}`;
        ctrl = null;
      } else {
        if (ctrl) { const m = mid(ctrl, p); d += `Q${f(ctrl.x)} ${f(ctrl.y)} ${f(m.x)} ${f(m.y)}`; }
        ctrl = p;
      }
    }
    if (ctrl) d += `Q${f(ctrl.x)} ${f(ctrl.y)} ${f(start.x)} ${f(start.y)}`;
    d += "Z";
  }
  return d;
}

/**
 * Lays out `text` in `font` at `size` px from (x, baselineY), applying GPOS kerning and extra `tracking` (in em).
 * Returns the path data and the advance width.
 */
export function outlineText(font, text, { x = 0, y = 0, size, tracking = 0, precision = 2 }) {
  const s = size / font.unitsPerEm;
  let pen = 0;
  let d = "";
  let prev = null;
  for (const ch of text) {
    const g = font.glyphIndex(ch.codePointAt(0));
    if (prev != null) pen += font.kern(prev, g);
    const ox = pen;
    d += contoursToPath(font.contours(g), (fx, fy) => ({ x: x + (ox + fx) * s, y: y - fy * s }), precision);
    pen += font.advance(g) + tracking * font.unitsPerEm;
    prev = g;
  }
  return { d, width: (pen - tracking * font.unitsPerEm) * s };
}
