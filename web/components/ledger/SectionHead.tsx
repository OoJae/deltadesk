import type { ReactNode } from "react";
import { Label } from "@/components/brand/Label";
import { Reveal } from "@/components/brand/Reveal";

export type SectionHeadProps = {
  /** Mono label above the title. */
  label: ReactNode;
  /** Section title in Bodoni Moda (section titles only), one phrase in italic. */
  title: string;
  /** A phrase inside `title` set in italic. Must appear verbatim. */
  italic?: string;
  /** id for the h2, so the <section> can be aria-labelledby it. */
  id?: string;
  /** Statement and context under the title (paper-dim, max 62ch). */
  lede?: ReactNode;
  /** Right-hand margin (cols 9–12 on large screens): a badge, a note, marginalia. */
  aside?: ReactNode;
};

/**
 * A data page's section opener: mono label, a Bodoni h2 one step below the page title, lede, and an optional margin
 * note on the 12-column grid. The title's lines rise once as they reach the viewport (instant under reduced motion).
 */
export function SectionHead({ label, title, italic, id, lede, aside }: SectionHeadProps) {
  return (
    <header className="grid gap-8 lg:grid-cols-12 lg:gap-x-8">
      <div className="space-y-5 lg:col-span-8">
        <Label as="p">{label}</Label>
        <Reveal as="h2" id={id} className="max-w-[22ch] font-display text-[clamp(2rem,3.6vw,3.5rem)] leading-[1] tracking-[-0.02em] text-balance text-paper">
          {italicize(title, italic)}
        </Reveal>
        {lede != null ? <div className="max-w-[62ch] space-y-3 text-body text-paper-dim">{lede}</div> : null}
      </div>
      {aside != null ? <div className="lg:col-span-4 lg:col-start-9 lg:self-end">{aside}</div> : null}
    </header>
  );
}

/** A data page section: hairline on top, generous space above (less for the first section after the page header). */
export function DataSection({ id, labelledBy, children, className, first }: { id?: string; labelledBy?: string; children: ReactNode; className?: string; first?: boolean }) {
  const space = first ? "mt-16 md:mt-24" : "mt-24 md:mt-32";
  return (
    <section id={id} aria-labelledby={labelledBy} className={[space, "scroll-mt-24 border-t border-rule pt-10 md:pt-14", className].filter(Boolean).join(" ")}>
      {children}
    </section>
  );
}

export function italicize(title: string, italic?: string): ReactNode {
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
