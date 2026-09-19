// WCAG 2.x contrast, for documenting (and testing) the palette against its grounds.

function channel(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function parse(color: string): [number, number, number, number] {
  const m = color.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const [r, g, b, a = "1"] = m[1].split(",").map((x) => x.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  const h = color.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** Composites `fg` (hex or rgba) over an opaque `bg` hex. */
export function over(fg: string, bg: string): [number, number, number] {
  const [r, g, b, a] = parse(fg);
  const [R, G, B] = parse(bg);
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
}

export function luminance([r, g, b]: [number, number, number]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio of `fg` on `bg` (fg may be translucent). */
export function contrast(fg: string, bg: string): number {
  const a = luminance(over(fg, bg));
  const b = luminance(over(bg, bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** "AAA" ≥ 7, "AA" ≥ 4.5, "AA large" ≥ 3, else "graphics only" / "decorative". */
export function grade(ratio: number): string {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA large · UI";
  if (ratio >= 1.5) return "Hairline only";
  return "Decorative";
}
