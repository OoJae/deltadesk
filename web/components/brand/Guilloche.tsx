import type { CSSProperties, ReactNode } from "react";
import { dividerTileSvg, hatchTileSvg, rosettePaths, securityBorderSvg, svgDataUri } from "./geometry";
import { INK } from "./tokens";

type Tone = "paper" | "vault" | "serial";
const COLOR: Record<Tone, string> = { paper: INK.paper, vault: INK.vault, serial: INK.serial };

type Base = {
  /** Ink. Default "paper". "serial" only where the engraving marks the accent (rare). */
  tone?: Tone;
  /** Ink opacity, 0–1. Defaults per variant (rosette .5, border .55, divider .5, hatch .35). */
  opacity?: number;
  className?: string;
  style?: CSSProperties;
};

export type GuillocheProps =
  | (Base & {
      variant: "rosette";
      /** px, square. Default 320. */
      size?: number;
      /** Spirograph: R (lobes), r (revolutions, coprime with R), pen reach d. Defaults 60 / 23 / 40. */
      petals?: number;
      turns?: number;
      reach?: number;
      /** Nested copies at 0.62× scale. Default 2. */
      layers?: number;
      /** Hairline width in px (non-scaling). Default 0.5. */
      strokeWidth?: number;
    })
  | (Base & {
      variant: "border";
      /**
       * The security border as an overlay: renders an absolutely positioned frame, so place it inside a
       * `relative` container (it covers inset-0 unless you pass other inset classes).
       */
      width?: number;
      children?: ReactNode;
    })
  | (Base & {
      variant: "divider";
      /** A small rosette knot at the centre of the rule. */
      ornament?: boolean;
    })
  | (Base & {
      variant: "hatch";
      /** Line spacing in px. Default 6. */
      gap?: number;
      /** 45 (default) or 135 for the mirror; 0/90 for ledger ruling. */
      angle?: 45 | 135 | 0 | 90;
      children?: ReactNode;
    });

/**
 * The engraving kit. All four variants are mathematically generated (components/brand/geometry.ts):
 * rosette = hypotrochoid spirograph; border = woven sine band + corner rosettes as a 9-slice border-image;
 * divider = three phase-shifted sines; hatch = engraver's tint. Decorative: always aria-hidden.
 */
export function Guilloche(props: GuillocheProps) {
  const color = COLOR[props.tone ?? "paper"];
  switch (props.variant) {
    case "rosette": {
      const { size = 320, petals, turns, reach, layers = 2, strokeWidth = 0.5, opacity = 0.5, className, style } = props;
      const paths = rosettePaths({ size, petals, turns, reach, layers });
      return (
        <svg aria-hidden="true" width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className} style={style}>
          <g fill="none" stroke={color} strokeOpacity={opacity} strokeWidth={strokeWidth}>
            {paths.map((d, i) => (
              <path key={i} d={d} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        </svg>
      );
    }
    case "border": {
      const { width = 16, opacity = 0.55, className, style, children } = props;
      return (
        <div
          aria-hidden="true"
          className={["pointer-events-none absolute", className ?? "inset-0"].join(" ")}
          style={{
            borderStyle: "solid",
            borderColor: "transparent",
            borderWidth: width,
            borderImageSource: svgDataUri(securityBorderSvg({ color, opacity })),
            borderImageSlice: 24,
            borderImageRepeat: "round",
            ...style,
          }}
        >
          {children}
        </div>
      );
    }
    case "divider": {
      const { ornament = false, opacity = 0.5, className, style } = props;
      const bg = svgDataUri(dividerTileSvg({ color, opacity }));
      return (
        <div aria-hidden="true" className={["relative flex h-3 items-center", className].filter(Boolean).join(" ")} style={style}>
          <div className="h-3 flex-1" style={{ backgroundImage: bg, backgroundRepeat: "repeat-x", backgroundSize: "16px 12px" }} />
          {ornament ? (
            <>
              <svg width="28" height="28" viewBox="0 0 28 28" className="mx-2 shrink-0">
                <g fill="none" stroke={color} strokeOpacity={Math.min(1, opacity + 0.3)} strokeWidth={0.7}>
                  {rosettePaths({ size: 28, petals: 12, turns: 5, reach: 7, layers: 1 }).map((d, i) => (
                    <path key={i} d={d} />
                  ))}
                </g>
              </svg>
              <div className="h-3 flex-1" style={{ backgroundImage: bg, backgroundRepeat: "repeat-x", backgroundSize: "16px 12px" }} />
            </>
          ) : null}
        </div>
      );
    }
    case "hatch": {
      const { gap = 6, angle = 45, opacity = 0.35, className, style, children } = props;
      return (
        <div
          aria-hidden={children ? undefined : true}
          className={className}
          style={{ backgroundImage: svgDataUri(hatchTileSvg({ color, gap, angle, opacity })), backgroundSize: `${gap}px ${gap}px`, ...style }}
        >
          {children}
        </div>
      );
    }
  }
}
