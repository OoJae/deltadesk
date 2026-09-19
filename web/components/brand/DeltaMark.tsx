import type { CSSProperties } from "react";
import { MARK_DELTA, MARK_DELTA_VIEWBOX, MARK_FAVICON, MARK_SEAL_DELTA, MARK_SEAL_RING, MARK_SEAL_RING_INNER, MARK_SEAL_VIEWBOX } from "./mark-data";

export type DeltaMarkProps = {
  /**
   * "seal": the compact seal (3-stroke Δ in an engraved ring), the nav and footer mark.
   * "delta": the bare 3-stroke Δ.
   * "solid": the filled Didone Δ used for the favicon; for 16–20 px where strokes would blur.
   */
  variant?: "seal" | "delta" | "solid";
  /** Rendered size in px (square). Default 32. The strokes are tuned to stay crisp from 20 px up. */
  size?: number;
  /** Accessible name. Without it the mark is decorative (aria-hidden). */
  title?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * The compact DeltaDesk mark. Tiny and dependency-free, so it is safe in client bundles (the nav uses it).
 * Ink is `currentColor`: set it with text-paper / text-vault.
 */
export function DeltaMark({ variant = "seal", size = 32, title, className, style }: DeltaMarkProps) {
  const a11y = title ? { role: "img" as const, "aria-label": title } : { "aria-hidden": true as const };
  // Stroke weight in rendered px, independent of size: engraving stays a hairline, never a marker line.
  const w = size < 26 ? 1 : size < 40 ? 1.1 : 1.25;
  if (variant === "solid") {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={className} style={style} {...a11y}>
        <path d={MARK_FAVICON} fill="currentColor" fillRule="evenodd" />
      </svg>
    );
  }
  if (variant === "delta") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${MARK_DELTA_VIEWBOX} ${MARK_DELTA_VIEWBOX}`} className={className} style={style} {...a11y}>
        <g fill="none" stroke="currentColor" strokeWidth={w} strokeLinejoin="miter" strokeMiterlimit={10}>
          {MARK_DELTA.map((d, i) => (
            <path key={i} d={d} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${MARK_SEAL_VIEWBOX} ${MARK_SEAL_VIEWBOX}`} className={className} style={style} {...a11y}>
      <g fill="none" stroke="currentColor" strokeLinejoin="miter" strokeMiterlimit={10}>
        <path d={MARK_SEAL_RING} strokeWidth={w * 0.9} vectorEffect="non-scaling-stroke" />
        <path d={MARK_SEAL_RING_INNER} strokeWidth={0.5} strokeOpacity={0.7} vectorEffect="non-scaling-stroke" />
        {MARK_SEAL_DELTA.map((d, i) => (
          <path key={i} d={d} strokeWidth={w} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  );
}
