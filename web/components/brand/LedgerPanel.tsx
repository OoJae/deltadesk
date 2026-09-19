import type { ElementType, ReactNode } from "react";
import { Label } from "./Label";
import { Serial } from "./Serial";

export type LedgerPanelProps = {
  children: ReactNode;
  /** Element for the panel. Default "section" (give it a title or aria-label so it is a named region). */
  as?: ElementType;
  /** Mono label in the panel head ("Flow X-ray"). */
  label?: ReactNode;
  /** Panel title (Instrument Sans, title scale). Not Bodoni: display type is for page and section titles only. */
  title?: ReactNode;
  /** Heading level for `title`. Default "h2". */
  titleAs?: "h2" | "h3" | "h4";
  /** N° serial, only where the sequence is true. */
  serial?: string | number;
  /** Controls on the right of the head (filters, a Button). */
  actions?: ReactNode;
  /** A hairline between direct children of the body: the ledger's ruled rows. */
  ruled?: boolean;
  /** "raised" (vault-2 fill, default) or "flat" (transparent, hairline only). */
  tone?: "raised" | "flat";
  /** Body padding. Default true; pass false for edge-to-edge tables. */
  inset?: boolean;
  className?: string;
  bodyClassName?: string;
  "aria-label"?: string;
  id?: string;
};

/**
 * The certificate panel that replaces the rounded `.card`: square, one hairline, optional ruled rows.
 * Tables inside should use the `.ledger-table` class (hairline rows, mono tabular numbers).
 */
export function LedgerPanel({
  children,
  as: Tag = "section",
  label,
  title,
  titleAs: H = "h2",
  serial,
  actions,
  ruled = false,
  tone = "raised",
  inset = true,
  className,
  bodyClassName,
  id,
  ...rest
}: LedgerPanelProps) {
  const hasHead = label != null || title != null || serial != null || actions != null;
  return (
    <Tag
      id={id}
      aria-label={rest["aria-label"]}
      className={["relative border border-rule", tone === "raised" ? "bg-vault-2" : "bg-transparent", className].filter(Boolean).join(" ")}
    >
      {hasHead ? (
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-rule px-5 py-4 md:px-6">
          <div className="min-w-0 space-y-1.5">
            {label != null || serial != null ? (
              <div className="flex items-center gap-3">
                {serial != null ? <Serial n={serial} className="text-[0.72rem]" /> : null}
                {label != null ? <Label>{label}</Label> : null}
              </div>
            ) : null}
            {title != null ? <H className="text-[1.15rem] font-medium leading-snug text-paper md:text-[1.3rem]">{title}</H> : null}
          </div>
          {actions != null ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={[inset ? "px-5 py-5 md:px-6" : "", ruled ? "ledger-ruled" : "", bodyClassName].filter(Boolean).join(" ")}>{children}</div>
    </Tag>
  );
}
