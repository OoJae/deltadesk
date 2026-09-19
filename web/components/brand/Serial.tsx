import type { CSSProperties } from "react";

export type SerialProps = {
  /** The number. Use only where the sequence is TRUE: the weekend's acts in time order, the chain id (4663). */
  n: string | number;
  /** Zero-pad to this many digits (N° 01). */
  pad?: number;
  /** "serial" red (default) or "dim" when a serial sits inside a muted context. */
  tone?: "serial" | "dim";
  className?: string;
  style?: CSSProperties;
};

/** A certificate serial: "N° 4663" in IBM Plex Mono. Screen readers hear "Number 4663". */
export function Serial({ n, pad, tone = "serial", className, style }: SerialProps) {
  const value = pad ? String(n).padStart(pad, "0") : String(n);
  return (
    <span
      className={["font-mono tabular whitespace-nowrap", tone === "serial" ? "text-serial" : "text-paper-dim", className].filter(Boolean).join(" ")}
      style={{ letterSpacing: "0.04em", ...style }}
    >
      <span aria-hidden="true">N°&nbsp;</span>
      <span className="sr-only">Number </span>
      {value}
    </span>
  );
}
