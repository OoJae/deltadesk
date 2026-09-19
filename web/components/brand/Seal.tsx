import type { CSSProperties } from "react";
import { DeltaMark } from "./DeltaMark";
import { SEAL_BAND, SEAL_DELTA_STROKES, SEAL_LACE, SEAL_MICROTEXT, SEAL_RIM, SEAL_SERIAL, SEAL_TEXT, SEAL_VIEWBOX } from "./seal-data";

export type SealProps = {
  /** "full": the Delta Seal (guilloché band, micro-text, 9-stroke Δ). "compact": the nav mark (see DeltaMark). */
  variant?: "full" | "compact";
  /** Rendered size in px. Default 240 (full) / 32 (compact). */
  size?: number;
  /** Ink. "paper" for the vault (default), "vault" for paper grounds. The serial number is always serial red. */
  tone?: "paper" | "vault";
  /** Engrave the seal in on mount: rings turn in, then the Δ strokes land one by one. Off under reduced motion. */
  draw?: boolean;
  /** Accessible name. Without it the seal is decorative (aria-hidden). */
  title?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * The Delta Seal. Server-safe (no hooks); the draw-on is pure CSS (globals.css: .dd-seal-draw).
 * The full seal inlines ~60 KB of path data: use it where it is the subject (hero, brand book, OG), not in chrome.
 * In client components prefer <DeltaMark>, which never pulls the full seal into the bundle.
 */
export function Seal({ variant = "full", size, tone = "paper", draw = false, title, className, style }: SealProps) {
  const color = tone === "paper" ? "var(--paper)" : "var(--vault)";
  if (variant === "compact") {
    return <DeltaMark variant="seal" size={size ?? 32} title={title} className={className} style={{ color, ...style }} />;
  }
  const px = size ?? 240;
  const a11y = title ? { role: "img" as const, "aria-label": title } : { "aria-hidden": true as const };
  // Hairlines are drawn in screen pixels (non-scaling), so the engraving reads at any size.
  const k = px < 160 ? 0.8 : px < 360 ? 1 : 1.15;
  const layer = (i: number): CSSProperties => ({ ["--i" as string]: i });
  return (
    <svg
      width={px}
      height={px}
      viewBox={`0 0 ${SEAL_VIEWBOX} ${SEAL_VIEWBOX}`}
      className={[draw ? "dd-seal-draw" : "", className].filter(Boolean).join(" ")}
      style={{ color, overflow: "visible", ...style }}
      {...a11y}
    >
      {title ? <desc>{SEAL_MICROTEXT}</desc> : null}
      <g fill="none" stroke="currentColor">
        <g className="dd-seal-layer" style={layer(0)}>
          {SEAL_RIM.map((r, i) => (
            <path key={i} d={r.d} strokeWidth={(r.w > 1 ? 1.2 : r.w > 0.7 ? 0.9 : 0.55) * k} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        <g className="dd-seal-layer" style={layer(1)} strokeOpacity={0.85}>
          {SEAL_BAND.map((d, i) => (
            <path key={i} d={d} strokeWidth={0.6 * k} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        <g className="dd-seal-layer" style={layer(3)} strokeOpacity={0.7}>
          {SEAL_LACE.map((d, i) => (
            <path key={i} d={d} strokeWidth={0.5 * k} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        <g strokeLinejoin="miter" strokeMiterlimit={8}>
          {SEAL_DELTA_STROKES.map((d, i) => (
            <path key={i} className="dd-seal-stroke" style={layer(i)} d={d} strokeWidth={(i === 0 ? 1.15 : 0.8) * k} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      </g>
      <g className="dd-seal-layer" style={layer(2)}>
        <path d={SEAL_TEXT} fill="currentColor" />
        <path d={SEAL_SERIAL} fill="var(--serial)" />
      </g>
    </svg>
  );
}
