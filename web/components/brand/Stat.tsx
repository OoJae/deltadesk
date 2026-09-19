import type { ReactNode } from "react";
import { Label } from "./Label";

export type StatProps = {
  /** Mono label above the number ("Volume", "Picked off"). */
  label: ReactNode;
  /** The figure, pre-formatted ("$952M", "52.6"). Rendered in Plex Mono, tabular. */
  value: ReactNode;
  /** Unit set small after the value ("bp", "USDG"). */
  unit?: ReactNode;
  /** One line of context under the number. */
  caption?: ReactNode;
  /** "paper" (default). "serial" only when the number IS the gap / fair-value divergence. */
  tone?: "paper" | "serial";
  /** md 1.75rem · lg 2.75rem · xl clamp(3rem, 6vw, 5.5rem). */
  size?: "md" | "lg" | "xl";
  align?: "left" | "right";
  className?: string;
};

const SIZE = { md: "text-[1.75rem]", lg: "text-[2.75rem]", xl: "text-[clamp(3rem,6vw,5.5rem)]" } as const;

/** A headline number: label, figure, caption. Uses <dl> semantics (the label names the value). */
export function Stat({ label, value, unit, caption, tone = "paper", size = "lg", align = "left", className }: StatProps) {
  return (
    <dl className={["flex flex-col gap-2", align === "right" ? "items-end text-right" : "", className].filter(Boolean).join(" ")}>
      <Label as="dt">{label}</Label>
      <dd className={["font-mono tabular leading-[0.95] tracking-[-0.03em]", SIZE[size], tone === "serial" ? "text-serial" : "text-paper"].join(" ")}>
        {value}
        {unit ? <span className="ml-1.5 align-baseline text-[0.36em] tracking-normal text-paper-dim">{unit}</span> : null}
      </dd>
      {caption ? <dd className="max-w-[32ch] text-sm leading-snug text-paper-dim">{caption}</dd> : null}
    </dl>
  );
}
