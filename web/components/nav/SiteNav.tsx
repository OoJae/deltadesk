"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/brand/Button";
import { DeltaMark } from "@/components/brand/DeltaMark";
import { Guilloche } from "@/components/brand/Guilloche";
import { Wordmark } from "@/components/brand/Wordmark";
import { DESK_LINK, NAV_LINKS } from "./links";

function useIsActive() {
  const pathname = usePathname() ?? "/";
  return (href: string) => pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Site header: compact seal + wordmark, primary links, the one CTA. Below lg the links fold into a full-screen
 * certificate sheet (focus trapped, Esc closes, focus returns to the toggle).
 * The header is the fixed reference during page transitions (view-transition-name: site-nav) and the seal stamps
 * each new page (site-seal); see globals.css.
 */
export function SiteNav() {
  const isActive = useIsActive();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    toggle.current?.focus();
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-vault" style={{ viewTransitionName: "site-nav" }}>
      <div className="mx-auto flex h-16 w-full max-w-[90rem] items-center gap-4 px-4 md:px-8">
        <Link href="/" className="-m-1 flex shrink-0 items-center gap-3 p-1" aria-label="DeltaDesk, home">
          <span className="block text-paper" style={{ viewTransitionName: "site-seal" }}>
            <DeltaMark variant="seal" size={32} />
          </span>
          <Wordmark size="1.42rem" />
        </Link>

        <nav aria-label="Primary" className="ml-auto hidden lg:block">
          <ul className="flex items-center">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={isActive(l.href) ? "page" : undefined}
                  className="relative block px-3 py-2 text-[0.9rem] text-paper-dim transition-colors duration-200 after:absolute after:inset-x-3 after:bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-300 after:ease-out hover:text-paper hover:after:scale-x-100 aria-[current=page]:text-paper aria-[current=page]:after:scale-x-100"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-3">
          <Button href={DESK_LINK.href} prefetch={false} size="sm" trailing="→" className="hidden sm:inline-flex">
            {DESK_LINK.label}
          </Button>
          <button
            ref={toggle}
            type="button"
            className="flex h-9 items-center gap-2.5 px-2 text-paper lg:hidden"
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={() => setOpen(true)}
          >
            <span className="label text-paper">Menu</span>
            <span aria-hidden="true" className="flex w-5 flex-col gap-[5px]">
              <span className="h-px w-full bg-paper" />
              <span className="h-px w-3/4 self-end bg-paper" />
            </span>
          </button>
        </div>
      </div>
      {open ? <MenuSheet onClose={close} isActive={isActive} /> : null}
    </header>
  );
}

function MenuSheet({ onClose, isActive }: { onClose: () => void; isActive: (href: string) => boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = "hidden";
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      html.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      id="site-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Site menu"
      data-lenis-prevent=""
      className="dd-sheet-enter fixed inset-0 z-[70] flex flex-col overflow-y-auto bg-vault"
    >
      <Guilloche variant="border" width={12} opacity={0.5} className="inset-2" />
      <div className="relative flex h-16 shrink-0 items-center justify-between px-6">
        <Link href="/" onClick={onClose} className="flex items-center gap-3" aria-label="DeltaDesk, home">
          <DeltaMark variant="seal" size={30} className="text-paper" />
          <Wordmark size="1.25rem" />
        </Link>
        <button type="button" onClick={onClose} className="flex h-9 items-center gap-2 px-2 text-paper">
          <span className="label text-paper">Close</span>
          <span aria-hidden="true" className="font-mono text-[1.1rem] leading-none">
            ×
          </span>
        </button>
      </div>

      <nav aria-label="Primary" className="relative px-6 pt-4">
        <ul className="border-t border-rule">
          {NAV_LINKS.map((l, i) => (
            <li key={l.href} className="dd-sheet-row border-b border-rule" style={{ ["--i" as string]: i }}>
              <Link href={l.href} onClick={onClose} aria-current={isActive(l.href) ? "page" : undefined} className="group flex items-end justify-between gap-4 py-4">
                <span className="min-w-0">
                  <span className="block text-[1.85rem] leading-[1.05] font-medium tracking-[-0.01em] text-paper group-aria-[current=page]:underline group-aria-[current=page]:decoration-1 group-aria-[current=page]:underline-offset-[6px]">
                    {l.label}
                  </span>
                  <span className="mt-1 block text-[0.85rem] text-paper-dim">{l.note}</span>
                </span>
                <span className="shrink-0 pb-1 font-mono text-[0.72rem] text-paper-mute">{l.href}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="relative mt-auto space-y-5 px-6 pt-10 pb-10">
        <Button href={DESK_LINK.href} prefetch={false} size="lg" trailing="→" className="w-full" onClick={onClose}>
          {DESK_LINK.label}
        </Button>
        <p className="label leading-relaxed text-paper-mute">
          <span className="text-serial">N°&nbsp;4663</span> · Robinhood Chain · Informational analytics, not investment advice
        </p>
      </div>
    </div>,
    document.body,
  );
}
