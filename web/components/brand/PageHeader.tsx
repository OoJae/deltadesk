import { ViewTransition, type ReactNode } from "react";
import { Label } from "./Label";
import { Serial } from "./Serial";

export type PageHeaderProps = {
  /** The page title, in Bodoni Moda. */
  title: string;
  /** A word or phrase inside `title` to set in italic ("its books"). Must appear verbatim in `title`. */
  italic?: string;
  /** Mono label above the title ("The Truth Study · Robinhood Chain"). */
  label?: ReactNode;
  /** N° serial, right of the label. Only where the sequence is true. */
  serial?: string | number;
  /** One or two sentences under the title, from the user's side. */
  lede?: ReactNode;
  /** Buttons or a form under the lede. */
  actions?: ReactNode;
  /** "section" (default, clamp 2.25–5rem) or "hero" (clamp 3–9.5rem). */
  size?: "section" | "hero";
  /** Heading element. Default "h1" (one per page). */
  as?: "h1" | "h2";
  /**
   * View-transition name for the title, so it morphs between pages. Default "page-title" for h1, none for h2.
   * Names must be unique on a page: pass false if a second h1-sized header shares the page.
   */
  transitionName?: string | false;
  className?: string;
  children?: ReactNode;
};

/** Page opener: label + serial, Bodoni title with an optional italic word, lede, actions. */
export function PageHeader({ title, italic, label, serial, lede, actions, size = "section", as: H = "h1", transitionName, className, children }: PageHeaderProps) {
  const name = transitionName === undefined ? (H === "h1" ? "page-title" : false) : transitionName;
  const heading = (
    <H className={["font-display text-balance text-paper", size === "hero" ? "text-hero" : "text-section", "max-w-[18ch]"].join(" ")}>
      {renderTitle(title, italic)}
    </H>
  );
  return (
    <header className={["space-y-6 md:space-y-8", className].filter(Boolean).join(" ")}>
      {label != null || serial != null ? (
        <div className="flex items-center gap-4">
          {serial != null ? <Serial n={serial} className="text-[0.78rem]" /> : null}
          {label != null ? <Label as="p">{label}</Label> : null}
        </div>
      ) : null}
      {name ? (
        <ViewTransition name={name} share="title-morph" default="none">
          {heading}
        </ViewTransition>
      ) : (
        heading
      )}
      {lede != null ? <div className="max-w-[62ch] text-body text-paper-dim">{lede}</div> : null}
      {actions != null ? <div className="flex flex-wrap items-center gap-3 pt-1">{actions}</div> : null}
      {children}
    </header>
  );
}

function renderTitle(title: string, italic?: string): ReactNode {
  if (!italic) return title;
  const i = title.indexOf(italic);
  if (i < 0) return title;
  return (
    <>
      {title.slice(0, i)}
      <em className="italic">{italic}</em>
      {title.slice(i + italic.length)}
    </>
  );
}
