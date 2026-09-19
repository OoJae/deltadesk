import type { CSSProperties, ElementType } from "react";

export type WordmarkProps = {
  /** Font size (any CSS length, or px as a number). Default 1.25rem. */
  size?: string | number;
  /** "paper" (default) on the vault, "vault" on paper grounds. */
  tone?: "paper" | "vault";
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
};

/**
 * "Delta*Desk*": Bodoni Moda 600, "Desk" in italic. Live text (crisp, selectable, optical sizing automatic).
 * For a file, use /brand/wordmark-paper.svg (outlined).
 */
export function Wordmark({ size = "1.25rem", tone = "paper", as: Tag = "span", className, style }: WordmarkProps) {
  return (
    <Tag
      className={["font-display whitespace-nowrap leading-none", className].filter(Boolean).join(" ")}
      style={{ fontSize: size, fontWeight: 600, letterSpacing: "-0.012em", color: tone === "paper" ? "var(--paper)" : "var(--vault)", ...style }}
    >
      Delta<em className="italic" style={{ marginLeft: "0.02em" }}>Desk</em>
    </Tag>
  );
}
