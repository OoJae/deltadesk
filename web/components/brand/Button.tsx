import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

type Common = {
  /** "primary": serial fill, vault ink (the one CTA per view). "ghost": hairline. "link": underlined text. */
  variant?: "primary" | "ghost" | "link";
  /** sm 36px · md 44px (default) · lg 56px. `link` ignores size. */
  size?: "sm" | "md" | "lg";
  /** Trailing glyph, e.g. "→" or "↗". Hidden from screen readers. */
  trailing?: ReactNode;
  className?: string;
  children: ReactNode;
};

export type ButtonAsLinkProps = Common &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children"> & {
    /** Internal paths render next/link; http(s) and mailto render <a> (external opens a new tab). */
    href: string;
    /** next/link prefetch. The /desk link MUST pass prefetch={false} (wallet SDK stays lazy). */
    prefetch?: ComponentProps<typeof Link>["prefetch"];
    /** next/link view-transition types, e.g. ["nav-forward"]. */
    transitionTypes?: string[];
  };

export type ButtonAsButtonProps = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & { href?: undefined };

export type ButtonProps = ButtonAsLinkProps | ButtonAsButtonProps;

const SIZE = {
  sm: "h-9 px-3.5 text-[0.82rem]",
  md: "h-11 px-5 text-[0.92rem]",
  lg: "h-14 px-7 text-[1rem]",
} as const;

export function buttonClass(variant: Common["variant"] = "primary", size: Common["size"] = "md", className?: string) {
  const base = "dd-btn font-medium tracking-[0.005em]";
  const v = variant === "primary" ? "dd-btn--primary" : variant === "ghost" ? "dd-btn--ghost" : "dd-btn--link";
  return [base, v, variant === "link" ? "" : SIZE[size], className].filter(Boolean).join(" ");
}

/**
 * The brand button. Press: scale .97 plus a guilloché sheen sweep (0.3 s); focus: 2px serial ring.
 * Works as <button>, <Link> (internal href) or <a> (external href). Server-safe (no hooks).
 */
export function Button(props: ButtonProps) {
  const { variant = "primary", size = "md", trailing, className, children } = props;
  const cls = buttonClass(variant, size, className);
  const inner = (
    <>
      <span>{children}</span>
      {trailing != null ? (
        <span aria-hidden="true" className="font-mono text-[0.95em] leading-none">
          {trailing}
        </span>
      ) : null}
    </>
  );
  if (props.href !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { href, prefetch, transitionTypes, variant: _v, size: _s, trailing: _t, className: _c, children: _ch, ...rest } = props;
    const external = /^(https?:|mailto:)/.test(href);
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" {...rest} className={cls}>
          {inner}
        </a>
      );
    }
    return (
      <Link href={href} prefetch={prefetch} transitionTypes={transitionTypes} {...rest} className={cls}>
        {inner}
      </Link>
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { variant: _v, size: _s, trailing: _t, className: _c, children: _ch, type, ...rest } = props;
  return (
    <button type={type ?? "button"} {...rest} className={cls}>
      {inner}
    </button>
  );
}
