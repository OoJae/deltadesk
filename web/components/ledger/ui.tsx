import type { ReactNode } from "react";
import { Label } from "@/components/brand/Label";

/**
 * Small, server-safe pieces shared by the data pages (Study, Live, Tearsheet, League, Console) and their charts.
 * Everything here is built on the brand kit (components/brand); none of it holds state.
 */

/** Inline text link: paper ink with a hairline underline (serial is never used for links). */
export const LINK = "text-paper underline decoration-rule-strong decoration-1 underline-offset-[0.28em] transition-colors hover:decoration-paper";

/** Page frame for a data page: the shared measure plus generous top and bottom space. */
export const PAGE = "mx-auto w-full max-w-[90rem] px-4 pb-28 pt-12 md:px-8 md:pb-40 md:pt-20";

/** A number inside prose: Plex Mono, tabular, in paper ink. */
export function N({ children, tone = "paper" }: { children: ReactNode; tone?: "paper" | "dim" | "serial" }) {
  const ink = tone === "serial" ? "text-serial" : tone === "dim" ? "text-paper-dim" : "text-paper";
  return <span className={`num whitespace-nowrap text-[0.94em] ${ink}`}>{children}</span>;
}

/**
 * The certificate margin: short facts beside a page header (source, reference, cadence), as a ruled list.
 * On small screens it sits under the header.
 */
export function Marginalia({ items, className }: { items: { k: ReactNode; v: ReactNode }[]; className?: string }) {
  return (
    <dl className={["border-t border-rule text-sm", className].filter(Boolean).join(" ")}>
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-[minmax(5.5rem,auto)_1fr] gap-x-4 border-b border-rule py-2.5">
          <Label as="dt">{it.k}</Label>
          <dd className="text-right text-paper-dim">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Show table" / "Show chart": every chart has a table twin. Mono small caps, underlined on hover. */
export function ViewToggle({ table, onToggle, chart = "Show chart", tableLabel = "Show table" }: { table: boolean; onToggle: () => void; chart?: string; tableLabel?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={table}
      className="label shrink-0 whitespace-nowrap text-paper-mute underline decoration-transparent underline-offset-4 transition-colors hover:text-paper hover:decoration-rule-strong"
    >
      {table ? chart : tableLabel}
    </button>
  );
}

/** A legend key: square swatch (fills), bar (lines) or dot (point marks). */
export function Key({ color, children, shape = "square" }: { color: string; children: ReactNode; shape?: "square" | "line" | "dot" }) {
  const mark =
    shape === "line" ? "h-[2px] w-3.5" : shape === "dot" ? "h-2 w-2 rounded-full" : "h-2.5 w-2.5";
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className={`shrink-0 ${mark}`} style={{ background: color }} />
      <span>{children}</span>
    </span>
  );
}

export type StatusTone = "good" | "warning" | "critical" | "neutral";
const STATUS_COLOR: Record<StatusTone, string> = { good: "var(--good)", warning: "var(--warning)", critical: "var(--critical)", neutral: "var(--axis)" };
const STATUS_ICON: Record<StatusTone, string> = { good: "✓", warning: "!", critical: "✕", neutral: "·" };

/** Status glyph in its reserved colour. Always paired with a text label by the caller. */
export function StatusIcon({ tone, size = "md", className }: { tone: StatusTone; size?: "sm" | "md"; className?: string }) {
  const box = size === "sm" ? "h-4 w-4 text-[0.6rem]" : "h-[1.15rem] w-[1.15rem] text-[0.7rem]";
  return (
    <span
      aria-hidden
      className={["inline-flex shrink-0 items-center justify-center font-mono font-medium leading-none text-vault", box, className].filter(Boolean).join(" ")}
      style={{ background: STATUS_COLOR[tone] }}
    >
      {STATUS_ICON[tone]}
    </span>
  );
}

/** A status stamp: square hairline plate, icon in the reserved status colour, mono label. */
export function StatusStamp({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={["inline-flex items-center gap-2 border border-rule-strong py-1 pl-1 pr-2.5", className].filter(Boolean).join(" ")}>
      <StatusIcon tone={tone} />
      <span className="label text-paper">{children}</span>
    </span>
  );
}

/** Horizontal scroll inside a panel (tables on phones): the page itself never scrolls sideways. */
export function ScrollX({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    // A focusable region so keyboard users can scroll it; named when a label is given.
    <div className={["overflow-x-auto overscroll-x-contain", className].filter(Boolean).join(" ")} tabIndex={0} role={label ? "region" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

/** A quiet message panel for loading, empty and error states. */
export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }) {
  return (
    <div className="flex items-start gap-3 border border-rule bg-vault-2 px-5 py-4 text-sm text-paper-dim">
      {tone !== "neutral" ? <StatusIcon tone={tone} className="mt-[0.1rem]" /> : <span aria-hidden className="mt-2 h-px w-3 shrink-0 bg-rule-strong" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
