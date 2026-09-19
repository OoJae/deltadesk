import type { CSSProperties, ElementType, ReactNode } from "react";

export type LabelProps = {
  children: ReactNode;
  /** Element to render. Default "span". Use "p", "dt", "h2"… where the semantics call for it. */
  as?: ElementType;
  /** Ink: "mute" (default, 5.7:1), "dim" (7.6:1), "paper", or "serial" (only for the gap / fair value). */
  tone?: "mute" | "dim" | "paper" | "serial";
  className?: string;
  style?: CSSProperties;
  id?: string;
};

const TONE = { mute: "text-paper-mute", dim: "text-paper-dim", paper: "text-paper", serial: "text-serial" } as const;

/** Mono small caps: IBM Plex Mono .72rem, +0.08em, uppercase. The ledger's column heading. */
export function Label({ children, as: Tag = "span", tone = "mute", className, style, id }: LabelProps) {
  return (
    <Tag id={id} className={["label", TONE[tone], className].filter(Boolean).join(" ")} style={style}>
      {children}
    </Tag>
  );
}
