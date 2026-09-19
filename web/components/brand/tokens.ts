// Brand tokens for code that cannot read CSS variables (canvas, WebGL shaders, next/og images, SVG data URIs).
// Mirrors app/globals.css; if you change one, change the other.

export const INK = {
  vault: "#0A0D0C",
  vault2: "#131816",
  vault3: "#1B211E",
  paper: "#EDE6D6",
  paperDim: "#A7A293",
  paperMute: "#8F8A7C",
  serial: "#E4472B",
  /** Hairline: paper at 14% (use with alpha, or `rule` below where a solid is needed). */
  ruleAlpha: 0.14,
  rule: "#2A2B28",
} as const;

/** Chart slots on the vault (dataviz dark steps). Serial is reserved for fair value / the gap. */
export const SERIES = ["#3987E5", "#199E70", "#C98500"] as const;

/** Linear-space RGB (0–1) for shaders. */
export function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

export const MOTION = {
  /** cubic-bezier(0.16, 1, 0.3, 1). GSAP equivalent: "expo.out". */
  easeOut: [0.16, 1, 0.3, 1] as const,
  /** cubic-bezier(0.65, 0, 0.35, 1). GSAP equivalent: "sine.inOut"-ish; use CustomEase for exact. */
  easeInOut: [0.65, 0, 0.35, 1] as const,
  gsapEaseOut: "expo.out",
  gsapEaseInOut: "power3.inOut",
  micro: 0.24,
  reveal: 0.8,
  page: 1.2,
  stagger: 0.08,
} as const;

/** The chain id is the certificate's true serial. */
export const CHAIN_SERIAL = "4663";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
